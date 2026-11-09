import express, { Router, type NextFunction, type Request, type Response } from 'express';
import type { AppContext } from '../../context.js';
import { AppError, badRequest } from '../../errors.js';
import { idParam } from '../../middleware/index.js';
import { logger } from '../../logger.js';
import { withEffectiveAppearance } from '../account/appearance.js';
import { MAX_AVATAR_BYTES, processAvatar, tooLarge } from './avatars.service.js';

/** Raw image body (image/png|jpeg|webp|gif); the real format is sniffed from the bytes later. */
const rawImage = express.raw({ type: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], limit: MAX_AVATAR_BYTES });
function readImage(req: Request, res: Response, next: NextFunction): void {
  rawImage(req, res, (err?: unknown) => {
    if ((err as { status?: number } | undefined)?.status === 413) return next(tooLarge());
    next(err);
  });
}

const actorOf = (req: Request) => ({ userId: req.session!.user.id, username: req.session!.user.username, ip: req.clientIp });

/** `/api/avatars` (requireAuth): any signed-in user may see any avatar (navbar, prints, admin lists). */
export function avatarsRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ avatars: ctx.avatars.directory() });
  });

  router.get('/:userId', async (req, res) => {
    const { data, etag } = await ctx.avatars.read(idParam(req, 'userId'));
    // URLs carry ?v=<updatedAt>; the ETag covers clients that request without it.
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('ETag', etag);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.type('image/webp').send(data);
  });

  return router;
}

/** `/api/account/avatar` (requireAuth). */
export function accountAvatarRoutes(ctx: AppContext): Router {
  const router = Router();

  router.put('/', readImage, async (req, res) => {
    const me = req.session!.user;
    // A JSON (or any non-image) body never reaches express.raw.
    if (!Buffer.isBuffer(req.body)) throw new AppError(415, 'avatar.invalid_image', 'Upload a PNG, JPEG, WebP or GIF image');
    if (req.body.length === 0) throw badRequest('avatar.no_file', 'No image received');
    ctx.avatars.checkRate(me.id);
    const webp = await processAvatar(req.body);
    await ctx.avatars.save(me.id, webp);
    ctx.audit.log('account.avatar', actorOf(req), me.id, { bytes: webp.length });
    res.json({ user: withEffectiveAppearance(ctx, ctx.users.getUser(me.id)) });
  });

  router.delete('/', (req, res) => {
    const me = req.session!.user;
    if (ctx.avatars.remove(me.id)) ctx.audit.log('account.avatar_remove', actorOf(req), me.id, {});
    res.json({ user: withEffectiveAppearance(ctx, ctx.users.getUser(me.id)) });
  });

  return router;
}

/** `/api/admin/users/:id/avatar` (requireAdmin): moderation. */
export function adminAvatarRoutes(ctx: AppContext): Router {
  const router = Router({ mergeParams: true });

  router.delete('/', (req, res) => {
    const id = idParam(req);
    const target = ctx.users.getUser(id);
    if (ctx.avatars.remove(id)) {
      ctx.audit.log('user.avatar_remove', actorOf(req), target.username, { id });
      logger.auth.info(`Avatar of "${target.username}" removed by "${req.session!.user.username}"`);
    }
    res.json(ctx.users.getAdminUser(id));
  });

  return router;
}
