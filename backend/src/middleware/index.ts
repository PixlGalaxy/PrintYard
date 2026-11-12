import type { NextFunction, Request, RequestHandler, Response } from 'express';
import helmet from 'helmet';
import type { ZodType } from 'zod';
import type { AppContext } from '../context.js';
import { AppError, forbidden, unauthorized, validationFailed } from '../errors.js';
import { hasForwardingHeaders, isHttpsRequest, resolveClientIp } from '../lib/client-ip.js';
import { normalizeIp } from '../lib/ip.js';
import { logger } from '../logger.js';
import { isSameOrigin } from '../realtime/hub.js';
import { SESSION_COOKIE } from '../modules/auth/sessions.service.js';
import { SettingsValidationError } from '../db/settings.js';

/** Resolves req.clientIp / req.isHttps once per request from the current exposure settings. */
export function requestContext(ctx: AppContext): RequestHandler {
  return (req, _res, next) => {
    const exposure = ctx.exposure();
    if (exposure.mode === 'none' && !ctx.flags.proxyHeadersSeen && hasForwardingHeaders(req.headers)) {
      ctx.flags.proxyHeadersSeen = true;
      logger.warn('Forwarding headers (X-Forwarded-For etc.) received while exposure.mode is "none": if PrintYard is behind a proxy or tunnel, set the exposure mode in Admin → Settings');
    }
    req.clientIp = resolveClientIp(req, exposure, exposure.matcher);
    req.clientIpForwarded = req.clientIp !== (normalizeIp(req.socket.remoteAddress) ?? '');
    req.isHttps = isHttpsRequest(req, exposure, exposure.matcher);
    next();
  };
}

export function ipBan(ctx: AppContext): RequestHandler {
  return (req, _res, next) => {
    if (ctx.bans.isBanned(req.clientIp)) return next(forbidden('auth.ip_banned', 'Access from this address is blocked'));
    next();
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function hasBody(req: Request): boolean {
  const len = req.headers['content-length'];
  if (req.headers['transfer-encoding'] !== undefined) return true;
  return len !== undefined && len !== '0';
}

/**
 * CSRF (contract §Auth): mutating requests need Sec-Fetch-Site ∈ {same-origin, none} (or absent) and a JSON body.
 * A body-less request (logout, DELETE) may omit Content-Type; if it sends one, it must still be JSON.
 * Cross-site forms can never produce application/json without a CORS preflight, which we never grant.
 */
export function csrf(ctx: AppContext): RequestHandler {
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      return next(forbidden('auth.csrf', 'Cross-site request refused'));
    }
    const type = req.headers['content-type'];
    const isJson = typeof type === 'string' && /^application\/json\s*(;|$)/i.test(type);
    if (isJson) return next();
    if (type === undefined && !hasBody(req)) {
      // A body-less write is a "simple" request any page can send (fetch no-cors). Browsers without
      // Sec-Fetch-Site (Safari < 16.4) still send Origin on every POST/PUT/PATCH/DELETE: a foreign one is refused.
      // No Origin at all = not a browser (scripts, tools): nothing to forge, allowed as before.
      if (site === undefined && req.headers.origin !== undefined && !isSameOrigin(req, ctx.settings.get('exposure.publicUrl'))) {
        return next(forbidden('auth.csrf', 'Cross-site request refused'));
      }
      return next();
    }
    if (typeof type === 'string' && isBinaryUpload(req, type) && provesSameOrigin(req)) return next();
    next(new AppError(415, 'auth.csrf', 'Content-Type must be application/json'));
  };
}

/**
 * The only non-JSON writes: file uploads (multipart) and client-rendered thumbnails (image/png). Multipart is a
 * "simple" CORS type a cross-site form could send, so these also need positive same-origin proof (below), on top of
 * the SameSite=Lax session cookie.
 */
const BINARY_UPLOADS: { method: string; path: RegExp; type: RegExp }[] = [
  { method: 'POST', path: /^\/files\/?$/, type: /^multipart\/form-data\s*;/i },
  { method: 'PUT', path: /^\/files\/\d{1,15}\/thumbnail\/?$/, type: /^image\/png\s*(;|$)/i },
  { method: 'PUT', path: /^\/account\/avatar\/?$/, type: /^image\/(png|jpeg|webp|gif)\s*(;|$)/i },
];

function isBinaryUpload(req: Request, type: string): boolean {
  return BINARY_UPLOADS.some((u) => u.method === req.method && u.path.test(req.path) && u.type.test(type));
}

/** `Sec-Fetch-Site: same-origin`, or an `Origin` whose host equals `Host` (browsers send Origin on every POST/PUT). */
function provesSameOrigin(req: Request): boolean {
  if (req.headers['sec-fetch-site'] === 'same-origin') return true;
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === 'null') return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** Helmet with a CSP that fits the built SPA (no inline scripts; theme bootstrap lives in /theme.js). */
export const securityHeaders: RequestHandler = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      workerSrc: ["'self'", 'blob:'],
      manifestSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'same-origin' },
  // Only honoured over HTTPS (i.e. behind a TLS proxy); harmless on plain-HTTP LAN.
  strictTransportSecurity: { maxAge: 180 * 24 * 3600, includeSubDomains: false },
  xFrameOptions: { action: 'deny' },
});

export function loadSession(ctx: AppContext): RequestHandler {
  return (req, _res, next) => {
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    const session = ctx.sessions.resolve(token, req.clientIp);
    if (session) req.session = session;
    next();
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.session) return next(unauthorized());
  next();
};

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.session) return next(unauthorized());
  if (req.session.user.role !== 'admin') return next(forbidden());
  next();
};

/** Parses with zod or throws `validation.failed` with the issues as details. */
export function parse<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw validationFailed(
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
    );
  }
  return result.data;
}

/** Positive integer route param or 404. */
export function idParam(req: Request, name = 'id'): number {
  const raw = req.params[name];
  const n = typeof raw === 'string' && /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new AppError(404, 'common.not_found', 'Not found');
  return n;
}

export function requestLogger(): RequestHandler {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const line = `${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${ms.toFixed(1)}ms ${req.clientIp ?? ''}`;
      if (res.statusCode >= 500) logger.http.error(line);
      else if (res.statusCode >= 400) logger.http.info(line);
      else logger.http.debug(line);
    });
    next();
  };
}

const BODY_PARSER_TYPES = new Set([
  'entity.parse.failed',
  'entity.too.large',
  'encoding.unsupported',
  'charset.unsupported',
  'request.aborted',
  'request.size.invalid',
  'entity.verify.failed',
]);

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (err instanceof AppError) {
    if (err.headers) for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
    res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details !== undefined && { details: err.details }) },
    });
    return;
  }
  if (err instanceof SettingsValidationError) {
    res.status(400).json({ error: { code: 'validation.failed', message: 'Invalid settings', details: err.issues } });
    return;
  }
  const e = err as { type?: unknown; status?: unknown };
  if (typeof e.type === 'string' && BODY_PARSER_TYPES.has(e.type)) {
    const tooLarge = e.status === 413;
    res.status(tooLarge ? 413 : 400).json({
      error: {
        code: tooLarge ? 'common.payload_too_large' : 'validation.failed',
        message: tooLarge ? 'Request body too large' : 'Malformed request body',
      },
    });
    return;
  }
  logger.error(`Unhandled error on ${req.method} ${req.originalUrl.split('?')[0]}`, err);
  res.status(500).json({ error: { code: 'common.internal', message: 'Internal server error' } });
}

export const apiNotFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'common.not_found', message: 'Not found' } });
};
