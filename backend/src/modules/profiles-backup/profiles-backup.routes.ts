import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { parse } from '../../middleware/index.js';

const printerQuery = z.object({ printerId: z.coerce.number().int().positive() });
const restoreBody = z.object({ printerId: z.number().int().positive() }).strict();

const actorOf = (req: Request) => ({ userId: req.session!.user.id, username: req.session!.user.username, ip: req.clientIp });
const adminOf = (req: Request) => ({ id: req.session!.user.id, role: req.session!.user.role, username: req.session!.user.username });

/** Mounted at /api/admin/profiles-backup behind requireAdmin (backup of user profiles on the printer). */
export function profilesBackupRoutes(ctx: AppContext): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(ctx.profilesBackup.status());
  });
  router.post('/run', async (req, res) => {
    res.json(await ctx.profilesBackup.backupNow(actorOf(req)));
  });
  router.get('/preview', async (req, res) => {
    const { printerId } = parse(printerQuery, req.query);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await ctx.profilesBackup.preview(printerId, adminOf(req)));
  });
  router.post('/restore', async (req, res) => {
    const { printerId } = parse(restoreBody, req.body);
    res.json(await ctx.profilesBackup.restore(printerId, adminOf(req), actorOf(req)));
  });
  return router;
}
