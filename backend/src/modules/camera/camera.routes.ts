import { Router } from 'express';
import type { AppContext } from '../../context.js';
import { idParam } from '../../middleware/index.js';

/** Mounted on /api/printers/:id/camera (requireAuth): the printer camera, proxied (the printer's ports have no auth). */
export function cameraRoutes(ctx: AppContext): Router {
  const router = Router({ mergeParams: true });

  router.get('/snapshot', async (req, res) => {
    const jpeg = await ctx.camera.snapshot(idParam(req));
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(jpeg);
  });

  router.get('/stream', async (req, res) => {
    await ctx.camera.stream(idParam(req), res);
  });

  return router;
}
