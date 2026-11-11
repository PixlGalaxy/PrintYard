import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { notFound } from '../../errors.js';
import { idParam, parse, requireAdmin, requireAuth } from '../../middleware/index.js';
import { assertWritable } from '../../printers/read-only.js';
import type { Actor } from './types.js';
import { controlSchema, excludeSchema } from './control.js';
import { TEMP_HISTORY } from './temp-history.js';

/** Read-only mode: refuse printer-affecting routes with 423 before doing anything (the driver also refuses). */
const writable: RequestHandler = (_req, _res, next) => {
  assertWritable();
  next();
};

const startSchema = z.object({
  printerId: z.number().int().positive(),
  fileId: z.number().int().positive(),
  confirmBedClear: z.boolean().optional(),
  /** Admins only (ignored otherwise): print despite dangerous-command scan findings (audited). */
  allowDangerous: z.boolean().optional(),
  /** "Print calibration" (Creality `enableSelfTest`); default: setting `printing.calibrateByDefault`. */
  calibrate: z.boolean().optional(),
});

const approveSchema = z
  .object({
    confirmBedClear: z.boolean().optional(),
    force: z.boolean().optional(),
    allowDangerous: z.boolean().optional(),
    /** Override the requester's calibration choice. */
    calibrate: z.boolean().optional(),
  })
  .strict();
const rejectSchema = z.object({ reason: z.string().trim().max(500).optional().nullable() });

const listQuery = z.object({
  scope: z.enum(['mine', 'all']).default('mine'),
  printerId: z.preprocess((v) => (v === undefined || v === '' ? undefined : Number(v)), z.number().int().positive().optional()),
  limit: z.preprocess((v) => (v === undefined || v === '' ? undefined : Number(v)), z.number().int().min(1).max(500).default(200)),
});

export function actorOf(req: Request): Actor {
  const u = req.session!.user;
  return { id: u.id, username: u.username, role: u.role, ip: req.clientIp };
}

/** Mounted on /api (requireAuth applied to its own prefixes): /printers/:id/{status,pause,resume,cancel,bed-cleared} and /prints/*. */
export function printingRoutes(ctx: AppContext): Router {
  const router = Router();
  router.use(['/printers', '/prints'], requireAuth);

  // ---- live printer ----
  router.get('/printers/:id/status', (req, res) => {
    res.json(ctx.printerManager.status(idParam(req)));
  });

  // Temperature history (sampled every 2 s, last 60 min kept in memory).
  const tempsQuery = z.object({
    minutes: z.preprocess((v) => (v === undefined || v === '' ? undefined : Number(v)), z.number().int().min(1).max(60).default(30)),
  });
  router.get('/printers/:id/temps', (req, res) => {
    const id = idParam(req);
    ctx.printers.get(id);
    const { minutes } = parse(tempsQuery, req.query);
    res.json({ intervalMs: TEMP_HISTORY.intervalMs, samples: ctx.tempHistory.history(id, minutes) });
  });

  for (const action of ['pause', 'resume', 'cancel'] as const) {
    router.post(`/printers/:id/${action}`, writable, async (req, res) => {
      res.json(await ctx.printing.control(actorOf(req), idParam(req), action));
    });
  }

  // Motion/temperature/fan controls: typed commands only, the server builds the G-code (never raw G-code).
  router.post('/printers/:id/control', writable, async (req, res) => {
    const body = parse(controlSchema, req.body);
    res.json(await ctx.printerControl.control(actorOf(req), idParam(req), body));
  });

  router.post('/printers/:id/exclude-object', writable, async (req, res) => {
    const body = parse(excludeSchema, req.body);
    res.json(await ctx.printerControl.excludeObject(actorOf(req), idParam(req), body.name));
  });

  // Live view: the G-code being printed (library copy or cached download) and the printer's preview image.
  router.get('/printers/:id/current-gcode', async (req, res) => {
    const u = req.session!.user;
    const viewer = { id: u.id, role: u.role };
    const last = req.query.last === '1' || req.query.last === 'true';
    const g = last ? await ctx.liveView.lastGcode(idParam(req), viewer) : await ctx.liveView.currentGcode(idParam(req), viewer);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(g.fileName)}`);
    res.setHeader('X-PrintYard-Source', g.source);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.sendFile(g.path, { dotfiles: 'allow', headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  });

  router.get('/printers/:id/current-thumbnail', async (req, res) => {
    const png = await ctx.liveView.currentThumbnail(idParam(req));
    if (!png) throw notFound();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=10');
    res.send(png);
  });

  router.post('/printers/:id/bed-cleared', writable, (req, res) => {
    res.json(ctx.printing.markBedCleared(actorOf(req), idParam(req)));
  });

  // ---- prints ----
  router.post('/prints', writable, async (req, res) => {
    const body = parse(startSchema, req.body);
    const { status, job } = await ctx.printing.startPrint(actorOf(req), {
      printerId: body.printerId,
      fileId: body.fileId,
      source: 'web',
      ...(body.confirmBedClear !== undefined && { confirmBedClear: body.confirmBedClear }),
      ...(body.allowDangerous !== undefined && { allowDangerous: body.allowDangerous }),
      ...(body.calibrate !== undefined && { calibrate: body.calibrate }),
    });
    res.status(status).json(job);
  });

  router.get('/prints', (req, res) => {
    const q = parse(listQuery, req.query);
    res.json(ctx.printing.list(actorOf(req), q.scope, { printerId: q.printerId, limit: q.limit }));
  });

  router.get('/prints/pending', requireAdmin, (_req, res) => {
    res.json(ctx.printing.pending());
  });

  router.get('/prints/:id', (req, res) => {
    res.json(ctx.printing.get(actorOf(req), idParam(req)));
  });

  router.post('/prints/:id/approve', requireAdmin, writable, async (req, res) => {
    const body = parse(approveSchema, req.body ?? {});
    res.json(await ctx.printing.approve(actorOf(req), idParam(req), body));
  });

  router.post('/prints/:id/reject', requireAdmin, (req, res) => {
    const body = parse(rejectSchema, req.body ?? {});
    res.json(ctx.printing.reject(actorOf(req), idParam(req), body.reason ?? null));
  });

  router.delete('/prints/:id', (req, res) => {
    res.json(ctx.printing.cancelPending(actorOf(req), idParam(req)));
  });

  return router;
}
