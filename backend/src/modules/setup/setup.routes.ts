import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { SETTING_DEFS, validatePatch } from '../../db/settings.js';
import { conflict, forbidden } from '../../errors.js';
import { memoryStatus } from '../../lib/memory.js';
import { hostNetworkLikely } from '../../lib/network.js';
import { logger } from '../../logger.js';
import { parse } from '../../middleware/index.js';
import { PREPARE_LEVELS, type SetupStatus, type SetupStatusPublic } from '../../types.js';
import { startSession } from '../auth/auth.routes.js';
import { hashPassword, passwordSchema } from '../auth/password.js';
import { assertPrinterHostAllowed, printerCreateSchema, probeBodySchema, runProbe } from '../printers/printers.service.js';
import { isLanSetupRequest } from './lan-guard.js';
import { withEffectiveAppearance } from '../account/appearance.js';

export const usernameSchema = z
  .string()
  .trim()
  .min(3, 'Username must be at least 3 characters')
  .max(32, 'Username must be at most 32 characters')
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Letters, digits, dot, dash and underscore only');

export const optionalEmailSchema = z.preprocess(
  (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? null : v),
  z.email().max(254).nullable(),
);

const setupCompleteSchema = z.object({
  language: z.enum(['en', 'es']),
  admin: z.object({
    username: usernameSchema,
    email: optionalEmailSchema,
    password: passwordSchema,
  }),
  printer: printerCreateSchema.pick({ name: true, model: true, host: true, staticIp: true, mac: true }).nullable().optional(),
  exposure: z
    .object({
      mode: z.enum(['none', 'cloudflare', 'nginx', 'other']),
      publicUrl: z.string().nullable().optional(),
      trustedProxies: z.array(z.string()).optional(),
    })
    .default({ mode: 'none' }),
  engine: z
    .object({ selected: z.enum(['creality', 'orca']), autoUpdate: z.boolean() })
    .default({ selected: 'creality', autoUpdate: true }),
  /** Optional so older clients still complete setup. */
  workspace: z.object({ defaultLevel: z.enum(PREPARE_LEVELS) }).default({ defaultLevel: 'basic' }),
});

export function getSetupStatus(ctx: AppContext, lanAllowed: boolean): SetupStatus {
  const mem = memoryStatus();
  return {
    setupComplete: ctx.users.adminExists(),
    lanAllowed,
    memoryLimitBytes: mem.limitBytes,
    memoryOk: mem.ok,
    hostNetworkLikely: hostNetworkLikely(),
  };
}

export function setupRoutes(ctx: AppContext): Router {
  const router = Router();

  /** Setup writes are LAN-only and only until the first admin exists. */
  const setupGuard: RequestHandler = (req, _res, next) => {
    if (!isLanSetupRequest(req)) {
      logger.setup.warn(`Setup request refused (not LAN): socket ${req.socket.remoteAddress}, host ${req.headers.host}`);
      return next(forbidden('setup.not_lan', 'Setup can only be completed from the local network'));
    }
    if (ctx.users.adminExists()) return next(conflict('setup.already_complete', 'Setup is already complete'));
    next();
  };

  /** Full details only before setup (the wizard needs them) or for admins; afterwards anonymous callers get the flag. */
  router.get('/status', (req, res) => {
    if (ctx.users.adminExists() && req.session?.user.role !== 'admin') {
      const body: SetupStatusPublic = { setupComplete: true };
      res.json(body);
      return;
    }
    res.json(getSetupStatus(ctx, isLanSetupRequest(req)));
  });

  router.post('/test-printer', setupGuard, async (req, res) => {
    res.json(await runProbe(ctx, parse(probeBodySchema, req.body)));
  });

  router.post('/complete', setupGuard, async (req, res) => {
    const body = parse(setupCompleteSchema, req.body);
    // Validate settings exactly like PATCH /admin/settings would (throws validation.failed on bad values).
    const settingUpdates = validatePatch(
      {
        'app.defaultLanguage': body.language,
        'admin.email': body.admin.email,
        'exposure.mode': body.exposure.mode,
        ...(body.exposure.publicUrl !== undefined && { 'exposure.publicUrl': body.exposure.publicUrl }),
        ...(body.exposure.trustedProxies !== undefined && { 'exposure.trustedProxies': body.exposure.trustedProxies }),
        'engine.selected': body.engine.selected,
        'engine.autoUpdate': body.engine.autoUpdate,
        'workspace.defaultLevel': body.workspace.defaultLevel,
      },
      SETTING_DEFS,
    );
    if (body.printer) await assertPrinterHostAllowed(body.printer.host);
    const passwordHash = await hashPassword(body.admin.password);

    // Synchronous transaction: the "no admin yet" re-check and the inserts cannot interleave with another request.
    const { userId, printerId } = ctx.db.transaction(() => {
      if (ctx.users.adminExists()) throw conflict('setup.already_complete', 'Setup is already complete');
      const userId = ctx.users.create({
        username: body.admin.username,
        email: body.admin.email,
        passwordHash,
        role: 'admin',
        language: body.language,
      });
      const printerId = body.printer
        ? ctx.printers.create({
            name: body.printer.name,
            model: body.printer.model,
            host: body.printer.host,
            staticIp: body.printer.staticIp,
            mac: body.printer.mac ?? null,
          }).id
        : null;
      ctx.settings.writeValidated(settingUpdates);
      return { userId, printerId };
    })();
    ctx.settings.invalidate();

    ctx.users.touchLogin(userId);
    startSession(ctx, req, res, userId);
    ctx.audit.log('setup.complete', { userId, username: body.admin.username, ip: req.clientIp }, null, {
      printerId,
      exposure: body.exposure.mode,
      engine: body.engine.selected,
    });
    logger.setup.info(`Setup complete: admin "${body.admin.username}" created from ${req.clientIp}`);
    res.json({ user: withEffectiveAppearance(ctx, ctx.users.getUser(userId)) });
  });

  return router;
}
