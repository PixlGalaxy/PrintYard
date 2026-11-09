import { Router } from 'express';
import type { AppContext } from '../../context.js';
import { requireAdmin } from '../../middleware/index.js';

/** Mounted on /api/usage behind requireAuth. */
export function usageRoutes(ctx: AppContext): Router {
  const router = Router();

  /** `UsageSummary` for the signed-in user (month = calendar month in the server time zone). */
  router.get('/me', (req, res) => {
    const id = req.session!.user.id;
    res.json({ ...ctx.printing.usage(id), storageBytes: ctx.files.storageUsed(id), storageQuotaBytes: ctx.files.storageQuota(id) });
  });

  /** Admin: `(UsageSummary & { userId, username })[]` for every user. */
  router.get('/users', requireAdmin, (_req, res) => {
    res.json(ctx.printing.usageAll());
  });

  return router;
}
