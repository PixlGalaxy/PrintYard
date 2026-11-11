import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { idParam, parse } from '../../middleware/index.js';
import { processCreateSchema, processPatchSchema } from './process-profiles.service.js';

const actorOf = (req: Request) => ({ userId: req.session!.user.id, username: req.session!.user.username, ip: req.clientIp });
const viewerOf = (req: Request) => {
  const u = req.session!.user;
  return { id: u.id, username: u.username, role: u.role };
};
const listQuery = z.object({ scope: z.enum(['usable', 'mine', 'shared', 'everyone']).default('usable') });
const shareBody = z.object({ scope: z.enum(['private', 'shared']).default('shared') });

/** Mounted at /api/process-profiles behind requireAuth. Profiles appear in scenes/bundles as `custom:<id>`. */
export function processProfilesRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const { scope } = parse(listQuery, req.query);
    res.json(ctx.processProfiles.list(viewerOf(req), scope));
  });

  router.get('/:id', (req, res) => {
    res.json(ctx.processProfiles.get(viewerOf(req), idParam(req)));
  });

  router.post('/', (req, res) => {
    const body = parse(processCreateSchema, req.body);
    res.status(201).json(ctx.processProfiles.create(viewerOf(req), body, actorOf(req)));
  });

  router.patch('/:id', (req, res) => {
    const body = parse(processPatchSchema, req.body);
    res.json(ctx.processProfiles.update(viewerOf(req), idParam(req), body, actorOf(req)));
  });

  router.delete('/:id', (req, res) => {
    ctx.processProfiles.delete(viewerOf(req), idParam(req), actorOf(req));
    res.status(204).end();
  });

  // Owner or admin: `{scope: 'shared'}` makes it visible to every user, `{scope: 'private'}` takes it back.
  router.post('/:id/share', (req, res) => {
    const { scope } = parse(shareBody, req.body ?? {});
    res.json(ctx.processProfiles.setScope(viewerOf(req), idParam(req), scope, actorOf(req)));
  });

  return router;
}
