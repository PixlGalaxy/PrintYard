import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { AppError } from '../../errors.js';
import { parse } from '../../middleware/index.js';
import { IMPORT_LIMITS } from './creality.js';

const actorOf = (req: Request) => ({ userId: req.session!.user.id, username: req.session!.user.username, ip: req.clientIp });
const viewerOf = (req: Request) => {
  const u = req.session!.user;
  return { id: u.id, username: u.username, role: u.role };
};

/** The file travels as base64 inside JSON (CSRF stays "JSON only"); the decoded size is checked again. */
const importBody = z.object({
  fileName: z.string().min(1).max(255),
  data: z
    .string()
    .max(Math.ceil((IMPORT_LIMITS.maxFileBytes * 4) / 3) + 8)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'Invalid base64'),
});

const exportBody = z.object({
  kind: z.enum(['process', 'filament']),
  ids: z.array(z.number().int().positive()).min(1).max(200),
  format: z.enum(['zip', 'creality_filament']).default('zip'),
});

/** Mounted at /api/profile-files behind requireAuth (PROFILES: Creality Print preset import/export). */
export function profileFilesRoutes(ctx: AppContext): Router {
  const router = Router();

  router.post('/import', async (req, res) => {
    const body = (req.body ?? {}) as { data?: unknown };
    if (typeof body.data === 'string' && body.data.length > Math.ceil((IMPORT_LIMITS.maxFileBytes * 4) / 3) + 8) {
      throw new AppError(413, 'profile_files.too_large', `The file is larger than ${IMPORT_LIMITS.maxFileBytes / 1048576} MB`);
    }
    const { fileName, data } = parse(importBody, req.body);
    res.json(await ctx.profileFiles.importFile(viewerOf(req), fileName, Buffer.from(data, 'base64'), actorOf(req)));
  });

  router.post('/export', (req, res) => {
    const body = parse(exportBody, req.body);
    res.json(ctx.profileFiles.exportFiles(viewerOf(req), body, actorOf(req)));
  });

  return router;
}
