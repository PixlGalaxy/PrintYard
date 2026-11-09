import type { RequestHandler } from 'express';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';

/** Open approval requests one (non-admin) user may have at a time (phase 3 review A #3). */
export const MAX_PENDING_PER_USER = 3;

/**
 * `POST /api/prints` guard, mounted before the printing routes: a user who already has `MAX_PENDING_PER_USER`
 * requests waiting for an admin cannot add more (each one notifies every admin). 409 `prints.too_many_pending`.
 * Unauthenticated requests pass through so the printing routes answer 401 as usual.
 */
export function pendingPrintCap(ctx: Pick<AppContext, 'db'>): RequestHandler {
  return (req, _res, next) => {
    const u = req.session?.user;
    if (!u || u.role === 'admin') return next();
    const n = (ctx.db.prepare("SELECT COUNT(*) AS n FROM prints WHERE user_id = ? AND state = 'pending'").get(u.id) as { n: number }).n;
    if (n >= MAX_PENDING_PER_USER) {
      return next(
        new AppError(409, 'prints.too_many_pending', `You already have ${n} print requests waiting for approval`, { max: MAX_PENDING_PER_USER, pending: n }),
      );
    }
    next();
  };
}
