import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { parse } from '../../middleware/index.js';

const query = z.object({
  printerId: z.coerce.number().int().positive().optional(),
  refresh: z.enum(['1', 'true', '0', 'false']).optional(),
});

/** Mounted at /api/printer-materials behind requireAuth: the printer's own filament list (read-only). */
export function printerMaterialsRoutes(ctx: AppContext): Router {
  const router = Router();
  router.get('/', async (req, res) => {
    const q = parse(query, req.query);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await ctx.printerMaterials.list({ id: req.session!.user.id }, q.printerId, q.refresh === '1' || q.refresh === 'true'));
  });
  return router;
}
