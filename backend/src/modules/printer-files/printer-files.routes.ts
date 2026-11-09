import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { notFound } from '../../errors.js';
import { idParam, parse } from '../../middleware/index.js';
import { pendingPrintCap } from '../../middleware/pending-cap.js';
import { assertWritable } from '../../printers/read-only.js';
import { actorOf } from '../printing/printing.routes.js';

const writable: RequestHandler = (_req, _res, next) => {
  assertWritable();
  next();
};

const fileName = z.string().min(1).max(255);
const nameQuery = z.object({ name: fileName });
const listQuery = z.object({ refresh: z.enum(['1', 'true', '0', 'false']).optional() });
const importSchema = z.object({ name: fileName }).strict();
const printSchema = z
  .object({
    name: fileName,
    calibrate: z.boolean().optional(),
    confirmBedClear: z.boolean().optional(),
    /** Admins only (ignored otherwise): print despite scan findings (audited). */
    allowDangerous: z.boolean().optional(),
  })
  .strict();
const deleteSchema = z.object({ names: z.array(fileName).min(1).max(200) }).strict();

/** Mounted on /api/printers/:id/files (requireAuth): the printer's own G-code files (Files → On the printer). */
export function printerFilesRoutes(ctx: AppContext): Router {
  const router = Router({ mergeParams: true });

  router.get('/', async (req, res) => {
    const q = parse(listQuery, req.query);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await ctx.printerFiles.list(idParam(req), q.refresh === '1' || q.refresh === 'true'));
  });

  router.get('/thumbnail', async (req, res) => {
    const { name } = parse(nameQuery, req.query);
    const png = await ctx.printerFiles.thumbnail(idParam(req), name);
    if (!png) throw notFound();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.send(png);
  });

  router.post('/import', async (req, res) => {
    const body = parse(importSchema, req.body);
    res.status(201).json(await ctx.printerFiles.importFile(actorOf(req), idParam(req), body.name));
  });

  router.post('/print', writable, pendingPrintCap(ctx), async (req, res) => {
    const body = parse(printSchema, req.body);
    const { status, job, fileId, imported } = await ctx.printerFiles.print(actorOf(req), idParam(req), {
      name: body.name,
      ...(body.calibrate !== undefined && { calibrate: body.calibrate }),
      ...(body.confirmBedClear !== undefined && { confirmBedClear: body.confirmBedClear }),
      ...(body.allowDangerous !== undefined && { allowDangerous: body.allowDangerous }),
    });
    res.status(status).json({ job, fileId, imported });
  });

  router.delete('/', writable, async (req, res) => {
    const body = parse(deleteSchema, req.body);
    res.json({ results: await ctx.printerFiles.remove(actorOf(req), idParam(req), body.names) });
  });

  return router;
}
