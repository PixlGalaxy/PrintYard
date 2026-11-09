import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { notFound } from '../../errors.js';
import { parse } from '../../middleware/index.js';
import type { SceneDoc } from '../../types.js';
import { sceneSchema } from '../projects/scene.js';

// Two PNGs (≤ 512 KB each, base64) plus the scene fit in the API's 1 MB JSON limit only for small thumbnails;
// the route installs its own 4 MB parser (see app.ts).
const thumb = z.string().max(720_000);
const bodySchema = z.object({
  scene: sceneSchema,
  plate: z.number().int().min(0).max(63),
  thumbnails: z.object({ small: thumb.optional(), large: thumb.optional() }).optional(),
  name: z.string().max(120).optional(),
});

const userOf = (req: Request) => {
  const u = req.session!.user;
  return { id: u.id, username: u.username, role: u.role };
};

function jobId(req: Request): string {
  const id = req.params.id;
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw notFound();
  return id;
}

/** Mounted at /api/slice behind requireAuth. */
export function slicingRoutes(ctx: AppContext): Router {
  const router = Router();

  router.post('/', (req, res) => {
    const body = parse(bodySchema, req.body);
    const job = ctx.slicing.submit(userOf(req), { ...body, scene: body.scene as SceneDoc }, req.clientIp);
    res.status(202).json(job);
  });

  router.get('/:id', (req, res) => {
    res.json(ctx.slicing.get(userOf(req), jobId(req)));
  });

  router.delete('/:id', (req, res) => {
    res.json(ctx.slicing.cancel(userOf(req), jobId(req)));
  });

  return router;
}
