import { Router, type Request } from 'express';
import type { AppContext } from '../../context.js';

const actorOf = (req: Request) => ({ userId: req.session!.user.id, username: req.session!.user.username, ip: req.clientIp });

/** Mounted at /api/admin/engine behind requireAdmin. */
export function engineRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(ctx.engine.status());
  });

  router.post('/check', async (req, res) => {
    res.json(await ctx.engine.check(actorOf(req)));
  });

  /** Starts the update in the background (202); follow WS `engine.progress` or poll GET. */
  router.post('/update', (req, res) => {
    res.status(202).json(ctx.engine.startUpdate(actorOf(req)));
  });

  router.post('/rollback', async (req, res) => {
    res.json(await ctx.engine.rollback(actorOf(req)));
  });

  return router;
}
