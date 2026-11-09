import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { idParam, parse } from '../../middleware/index.js';
import type { SceneDoc } from '../../types.js';
import { sceneSchema } from './scene.js';

const bodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  scene: sceneSchema,
  thumbnailPng: z.string().max(800_000).optional(),
});

const actorOf = (req: Request) => ({ userId: req.session!.user.id, username: req.session!.user.username, ip: req.clientIp });

/** Mounted at /api/projects behind requireAuth (the JSON parser allows 1 MB; scenes are small). */
export function projectsRoutes(ctx: AppContext): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const body = parse(bodySchema, req.body);
    const u = req.session!.user;
    const file = await ctx.projects.create({ id: u.id, username: u.username, role: u.role }, { ...body, scene: body.scene as SceneDoc }, actorOf(req));
    res.status(201).json(file);
  });

  router.put('/:id', async (req, res) => {
    const body = parse(bodySchema, req.body);
    const u = req.session!.user;
    res.json(await ctx.projects.update({ id: u.id, role: u.role }, idParam(req), { ...body, scene: body.scene as SceneDoc }, actorOf(req)));
  });

  router.get('/:id', async (req, res) => {
    const u = req.session!.user;
    res.json(await ctx.projects.get({ id: u.id, role: u.role }, idParam(req)));
  });

  return router;
}
