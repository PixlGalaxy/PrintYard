import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { AppError, rateLimited } from '../../errors.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { cleanUserText } from '../../lib/sanitize.js';
import { logger } from '../../logger.js';
import { parse } from '../../middleware/index.js';
import { toUser } from '../users/users.service.js';
import { withEffectiveAppearance } from '../account/appearance.js';
import { verifyAgainstDummy, verifyPassword } from './password.js';
import { SESSION_COOKIE } from './sessions.service.js';

export function setSessionCookie(req: Request, res: Response, token: string, expiresAt: number): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: req.isHttps,
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(req: Request, res: Response): void {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', path: '/', secure: req.isHttps });
}

/** Starts a session for `userId` and sets the cookie. */
export function startSession(ctx: AppContext, req: Request, res: Response, userId: number): void {
  const { token, expiresAt } = ctx.sessions.create(userId, req.clientIp || null, req.get('user-agent') ?? null);
  setSessionCookie(req, res, token, expiresAt);
}

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});

const invalidCredentials = () => new AppError(401, 'auth.invalid_credentials', 'Invalid username or password');

export function authRoutes(ctx: AppContext): Router {
  const router = Router();

  router.post('/login', async (req, res) => {
    const { username, password } = parse(loginSchema, req.body);
    const ip = req.clientIp;

    const shownName = cleanUserText(username, 64);

    // Reserve the attempt synchronously, before any await, so parallel requests cannot all pass the check.
    const attempt = ctx.loginGuard.begin(ip, username, req.clientIpForwarded);
    if (!attempt.allowed) {
      logger.auth.warn(`Login rate-limited for "${shownName}" from ${ip}`);
      throw rateLimited(attempt.retryAfter);
    }
    if (attempt.delayMs > 0) await sleep(attempt.delayMs);

    const row = ctx.users.findRowByUsername(username);
    const valid = row ? await verifyPassword(row.password_hash, password) : (await verifyAgainstDummy(password), false);

    if (!row || !valid) {
      const banned = attempt.failed();
      ctx.audit.log('auth.login_failed', { username: shownName, ip, userId: row?.id ?? null }, shownName);
      if (banned) ctx.audit.log('ip.banned', { ip }, ip, { reason: 'login brute force' });
      logger.auth.info(`Failed login for "${shownName}" from ${ip}`);
      throw invalidCredentials();
    }
    attempt.succeeded();
    if (row.is_active !== 1) {
      ctx.audit.log('auth.login_failed', { userId: row.id, username: row.username, ip }, row.username, {
        reason: 'inactive',
      });
      throw new AppError(403, 'auth.account_disabled', 'This account is disabled');
    }

    ctx.users.touchLogin(row.id);
    startSession(ctx, req, res, row.id);
    ctx.audit.log('auth.login', { userId: row.id, username: row.username, ip });
    logger.auth.info(`"${row.username}" signed in from ${ip}`);
    res.json({ user: withEffectiveAppearance(ctx, ctx.users.getUser(row.id)) });
  });

  router.post('/logout', (req, res) => {
    const s = req.session;
    if (s) {
      ctx.sessions.revoke(s.id);
      ctx.hub.disconnectSession(s.id);
      ctx.audit.log('auth.logout', { userId: s.user.id, username: s.user.username, ip: req.clientIp });
      logger.auth.info(`"${s.user.username}" signed out`);
    }
    clearSessionCookie(req, res);
    res.status(204).end();
  });

  router.get('/me', (req, res) => {
    if (!req.session) throw new AppError(401, 'auth.unauthorized', 'Authentication required');
    res.json({ user: withEffectiveAppearance(ctx, toUser(req.session.user)) });
  });

  return router;
}
