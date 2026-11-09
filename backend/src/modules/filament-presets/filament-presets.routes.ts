import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { idParam, parse } from '../../middleware/index.js';
import { createSchema, patchSchema } from './filament-presets.service.js';

const actorOf = (req: Request) => ({ userId: req.session!.user.id, username: req.session!.user.username, ip: req.clientIp });
const viewerOf = (req: Request) => {
  const u = req.session!.user;
  return { id: u.id, username: u.username, role: u.role };
};
const listQuery = z.object({ scope: z.enum(['usable', 'mine', 'shared', 'everyone']).default('usable') });
const shareBody = z.object({ scope: z.enum(['private', 'shared']).default('shared') });

/** Mounted at /api/filament-presets behind requireAuth. Custom filaments appear in scenes as `custom:<id>`. */
export function filamentPresetsRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const { scope } = parse(listQuery, req.query);
    res.json(ctx.filamentPresets.list(viewerOf(req), scope));
  });

  router.get('/:id', (req, res) => {
    res.json(ctx.filamentPresets.get(viewerOf(req), idParam(req)));
  });

  router.post('/', (req, res) => {
    const body = parse(createSchema, req.body);
    res.status(201).json(ctx.filamentPresets.create(viewerOf(req), body, actorOf(req)));
  });

  router.patch('/:id', (req, res) => {
    const body = parse(patchSchema, req.body);
    res.json(ctx.filamentPresets.update(viewerOf(req), idParam(req), body, actorOf(req)));
  });

  router.delete('/:id', (req, res) => {
    ctx.filamentPresets.delete(viewerOf(req), idParam(req), actorOf(req));
    res.status(204).end();
  });

  // Admins only (checked in the service): `{scope: 'shared'}` makes it global, `{scope: 'private'}` takes it back.
  router.post('/:id/share', (req, res) => {
    const { scope } = parse(shareBody, req.body ?? {});
    res.json(ctx.filamentPresets.setScope(viewerOf(req), idParam(req), scope, actorOf(req)));
  });

  return router;
}
