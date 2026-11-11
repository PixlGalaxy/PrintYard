import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppError, notFound, rateLimited } from '../../errors.js';
import { logger } from '../../logger.js';
import { parse } from '../../middleware/index.js';
import { hashPassword, passwordSchema, verifyPassword } from '../auth/password.js';
import { optionalEmailSchema } from '../setup/setup.routes.js';
import { PREPARE_LEVELS, SKINS } from '../../types.js';
import { withEffectiveAppearance } from './appearance.js';
import { nav3dSchema } from './nav3d.js';

const profileSchema = z
  .object({
    email: optionalEmailSchema.optional(),
    language: z.enum(['en', 'es']).optional(),
    /** @deprecated use themeMode */
    theme: z.enum(['system', 'light', 'dark']).optional(),
    /** null = use the admin default */
    themeMode: z.enum(['system', 'light', 'dark']).nullable().optional(),
    skin: z.enum(SKINS).nullable().optional(),
    /** null = PrintYard defaults */
    nav3d: nav3dSchema.nullable().optional(),
    /** Prepare tab settings level; null = use the admin default */
    prepareLevel: z.enum(PREPARE_LEVELS).nullable().optional(),
    /** "Always used" process / filament preset (system name or `custom:<n>`); null = bundle default */
    defaultProcessPreset: z.string().min(1).max(200).nullable().optional(),
    defaultFilamentPreset: z.string().min(1).max(200).nullable().optional(),
    /** List the printer's own filaments in the Profiles tab and the Prepare picker */
    showPrinterFilaments: z.boolean().optional(),
  })
  .strict();

const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
});

/** Mounted behind requireAuth. */
export function accountRoutes(ctx: AppContext): Router {
  const router = Router();

  router.patch('/', (req, res) => {
    const s = req.session!;
    const { theme, ...patch } = parse(profileSchema, req.body ?? {});
    if (patch.themeMode === undefined && theme !== undefined) patch.themeMode = theme;
    // A default must be a preset this user can use right now (a private profile of someone else is a 404).
    const viewer = { id: s.user.id, role: s.user.role };
    if (patch.defaultProcessPreset) ctx.profiles.process('creality-k2se', patch.defaultProcessPreset, viewer);
    if (patch.defaultFilamentPreset) ctx.profiles.filament('creality-k2se', patch.defaultFilamentPreset, viewer);
    ctx.users.updateProfile(s.user.id, patch);
    ctx.audit.log('account.update', { userId: s.user.id, username: s.user.username, ip: req.clientIp }, s.user.id, {
      fields: Object.keys(patch),
    });
    res.json({ user: withEffectiveAppearance(ctx, ctx.users.getUser(s.user.id)) });
  });

  router.post('/password', async (req, res) => {
    const s = req.session!;
    const { currentPassword, newPassword } = parse(passwordChangeSchema, req.body);
    // A stolen session must not become an unlimited oracle for the password: same budget as failed logins.
    const attempt = ctx.loginGuard.begin(req.clientIp, s.user.username);
    if (!attempt.allowed) throw rateLimited(attempt.retryAfter);
    if (attempt.delayMs > 0) await sleep(attempt.delayMs);
    const row = ctx.users.findRowById(s.user.id)!;
    if (!(await verifyPassword(row.password_hash, currentPassword))) {
      const banned = attempt.failed();
      ctx.audit.log('account.password_failed', { userId: s.user.id, username: s.user.username, ip: req.clientIp }, s.user.id);
      if (banned) ctx.audit.log('ip.banned', { ip: req.clientIp }, req.clientIp, { reason: 'password change brute force' });
      throw new AppError(400, 'auth.invalid_current_password', 'Current password is incorrect');
    }
    attempt.succeeded();
    ctx.users.setPasswordHash(s.user.id, await hashPassword(newPassword));
    const revoked = ctx.sessions.revokeAllForUser(s.user.id, s.id);
    ctx.hub.disconnectUser(s.user.id, s.id);
    ctx.audit.log('account.password', { userId: s.user.id, username: s.user.username, ip: req.clientIp }, s.user.id, {
      revokedSessions: revoked,
    });
    logger.auth.info(`"${s.user.username}" changed their password (${revoked} other sessions revoked)`);
    res.status(204).end();
  });

  router.get('/sessions', (req, res) => {
    const s = req.session!;
    res.json({ sessions: ctx.sessions.listForUser(s.user.id, s.id) });
  });

  router.delete('/sessions/:id', (req, res) => {
    const s = req.session!;
    const id = String(req.params.id ?? '');
    const revoked = /^[0-9a-f]{32}$/.test(id) ? ctx.sessions.revokeByPublicId(s.user.id, id) : null;
    if (!revoked) throw notFound();
    ctx.hub.disconnectSession(revoked);
    res.status(204).end();
  });

  return router;
}
