import { statSync } from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { logBuffer, LOG_BUFFER_CAPACITY } from '../../log-buffer.js';
import { memoryStatus } from '../../lib/memory.js';
import { logger } from '../../logger.js';
import { badRequest } from '../../errors.js';
import { idParam, parse } from '../../middleware/index.js';
import { hashPassword, passwordSchema } from '../auth/password.js';
import {
  assertPrinterHostAllowed,
  printerCreateSchema,
  printerUpdateSchema,
  probeBodySchema,
  runProbe,
} from '../printers/printers.service.js';
import { optionalEmailSchema, usernameSchema } from '../setup/setup.routes.js';
import { TOPICS } from '../../realtime/index.js';
import { appearanceDefaults } from '../account/appearance.js';

const createUserSchema = z.object({
  username: usernameSchema,
  email: optionalEmailSchema.optional(),
  password: passwordSchema,
  role: z.enum(['admin', 'user']),
  language: z.enum(['en', 'es']).optional(),
});

const updateUserSchema = z
  .object({
    email: optionalEmailSchema.optional(),
    role: z.enum(['admin', 'user']).optional(),
    isActive: z.boolean().optional(),
    language: z.enum(['en', 'es']).optional(),
    canPrintUploadedGcode: z.boolean().optional(),
    canControlPrinter: z.boolean().optional(),
  })
  .strict();

const deleteFilesSchema = z.enum(['delete', 'transfer']);

const positiveOrNull = z.number().positive().max(1_000_000).nullable();

const limitsSchema = z.object({
  enabled: z.boolean(),
  maxGramsPerPrint: positiveOrNull,
  maxGramsPerMonth: positiveOrNull,
  maxHoursPerPrint: positiveOrNull,
  requiresApproval: z.boolean(),
});

const resetPasswordSchema = z.object({ newPassword: passwordSchema });

const intQuery = (def: number, max: number) =>
  z.preprocess(
    (v) => (v === undefined || v === '' ? undefined : Number(v)),
    z.number().int().min(1).max(max).default(def),
  );

const logsQuery = z.object({ limit: intQuery(500, LOG_BUFFER_CAPACITY) });
const auditQuery = z.object({
  limit: intQuery(200, 1000),
  before: z.preprocess((v) => (v === undefined || v === '' ? undefined : Number(v)), z.number().int().min(1).optional()),
});

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Mounted behind requireAdmin. */
export function adminRoutes(ctx: AppContext): Router {
  const router = Router();
  const actor = (req: Express.Request) => ({
    userId: req.session!.user.id,
    username: req.session!.user.username,
    ip: req.clientIp,
  });

  // ---- users ----
  router.get('/users', (_req, res) => {
    res.json(ctx.users.listAdminUsers());
  });

  router.post('/users', async (req, res) => {
    const body = parse(createUserSchema, req.body);
    const passwordHash = await hashPassword(body.password);
    const id = ctx.db.transaction(() =>
      ctx.users.create({
        username: body.username,
        email: body.email ?? null,
        passwordHash,
        role: body.role,
        language: body.language ?? ctx.settings.get('app.defaultLanguage'),
      }),
    )();
    ctx.audit.log('user.create', actor(req), body.username, { id, role: body.role });
    logger.auth.info(`User "${body.username}" (${body.role}) created by "${req.session!.user.username}"`);
    res.status(201).json(ctx.users.getAdminUser(id));
  });

  router.patch('/users/:id', (req, res) => {
    const id = idParam(req);
    const patch = parse(updateUserSchema, req.body ?? {});
    const before = ctx.users.getAdminUser(id);
    ctx.users.adminUpdate(req.session!.user.id, id, patch);
    const updated = ctx.users.getAdminUser(id);
    // Role change or deactivation: live sockets must not keep the old rights (they reconnect if still allowed).
    if (before.role !== updated.role || (before.isActive && !updated.isActive)) ctx.hub.disconnectUser(id);
    ctx.audit.log('user.update', actor(req), updated.username, { id, ...patch });
    res.json(updated);
  });

  // `?files=delete` removes the user's library (disk + rows); `?files=transfer` gives it to the acting admin.
  router.delete('/users/:id', async (req, res) => {
    const id = idParam(req);
    const me = req.session!.user;
    const target = ctx.users.assertDeletable(me.id, id);
    const mode = deleteFilesSchema.safeParse(req.query.files);
    if (!mode.success) {
      throw badRequest('users.files_option_required', 'Choose what happens to the user\'s files: ?files=delete or ?files=transfer');
    }
    const cancelled = ctx.printing.closeRequestsOf(id);
    const files =
      mode.data === 'transfer'
        ? await ctx.files.transferAllOf(id, target.username, { id: me.id })
        : await ctx.files.deleteAllOf(id);
    ctx.filamentPresets.handOver(id, target.username, me.id, mode.data);
    ctx.processProfiles.handOver(id, target.username, me.id, mode.data);
    const removed = ctx.users.delete(me.id, id);
    ctx.avatars.deleteFile(id);
    ctx.hub.disconnectUser(id);
    ctx.audit.log('user.delete', actor(req), removed.username, { id, files: mode.data, fileCount: files, cancelledRequests: cancelled });
    logger.auth.info(`User "${removed.username}" deleted by "${me.username}" (files: ${mode.data}, ${files})`);
    res.status(204).end();
  });

  router.put('/users/:id/limits', (req, res) => {
    const id = idParam(req);
    const limits = parse(limitsSchema, req.body);
    ctx.users.setLimits(id, limits);
    const updated = ctx.users.getAdminUser(id);
    ctx.audit.log('user.limits', actor(req), updated.username, { id, ...limits });
    res.json(updated);
  });

  router.post('/users/:id/password', async (req, res) => {
    const id = idParam(req);
    const { newPassword } = parse(resetPasswordSchema, req.body);
    const target = ctx.users.getUser(id);
    ctx.users.setPasswordHash(id, await hashPassword(newPassword));
    // Resetting your own password from here keeps the session you are using.
    const keep = id === req.session!.user.id ? req.session!.id : undefined;
    const revoked = ctx.sessions.revokeAllForUser(id, keep);
    ctx.hub.disconnectUser(id, keep);
    ctx.audit.log('user.password_reset', actor(req), target.username, { id, revokedSessions: revoked });
    res.status(204).end();
  });

  // ---- settings ----
  router.get('/settings', (_req, res) => {
    res.json(ctx.settings.getAllMasked());
  });

  router.patch('/settings', (req, res) => {
    const changed = ctx.settings.patch(req.body);
    if (changed.length > 0) {
      ctx.audit.log('settings.update', actor(req), null, { keys: changed });
      logger.info(`Settings changed by "${req.session!.user.username}": ${changed.join(', ')}`);
      // Users following the default re-skin live
      if (changed.some((k) => k.startsWith('appearance.'))) {
        ctx.hub.publish(TOPICS.appearanceDefaults, appearanceDefaults(ctx));
      }
    }
    res.json(ctx.settings.getAllMasked());
  });

  // ---- printers ----
  router.get('/printers', (_req, res) => {
    res.json(ctx.printers.list());
  });

  router.post('/printers/test', async (req, res) => {
    res.json(await runProbe(ctx, parse(probeBodySchema, req.body)));
  });

  router.post('/printers', async (req, res) => {
    const body = parse(printerCreateSchema, req.body);
    await assertPrinterHostAllowed(body.host);
    const printer = ctx.printers.create(body);
    ctx.audit.log('printer.create', actor(req), printer.name, { id: printer.id, host: printer.host });
    res.status(201).json(printer);
  });

  router.patch('/printers/:id', async (req, res) => {
    const id = idParam(req);
    const patch = parse(printerUpdateSchema, req.body ?? {});
    if (patch.host !== undefined) await assertPrinterHostAllowed(patch.host);
    const printer = ctx.printers.update(id, patch);
    ctx.audit.log('printer.update', actor(req), printer.name, { id, fields: Object.keys(patch) });
    res.json(printer);
  });

  router.delete('/printers/:id', (req, res) => {
    const id = idParam(req);
    const removed = ctx.printers.delete(id);
    ctx.audit.log('printer.delete', actor(req), removed.name, { id });
    res.status(204).end();
  });

  // ---- system / logs / audit ----
  router.get('/system', (_req, res) => {
    const mem = process.memoryUsage();
    const limit = memoryStatus();
    const db = ctx.config.dbPath;
    res.json({
      version: ctx.config.version,
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, limitBytes: limit.limitBytes, ok: limit.ok },
      appdataRoot: ctx.config.appdataRoot,
      dataRoot: ctx.config.dataRoot,
      dbSizeBytes: fileSize(db) + fileSize(`${db}-wal`),
      engine: { selected: ctx.settings.get('engine.selected'), installedVersion: ctx.engine.status().installed?.version ?? null },
      proxyHeadersSeen: ctx.flags.proxyHeadersSeen,
    });
  });

  router.get('/logs', (req, res) => {
    const { limit } = parse(logsQuery, req.query);
    res.json({ lines: logBuffer.tail(limit) });
  });

  router.get('/audit', (req, res) => {
    const { limit, before } = parse(auditQuery, req.query);
    res.json({ items: ctx.audit.list(limit, before) });
  });

  return router;
}
