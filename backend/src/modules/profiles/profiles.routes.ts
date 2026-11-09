import { Router } from 'express';
import type { AppContext } from '../../context.js';
import { notFound } from '../../errors.js';
import type { PresetKind, PrinterModel } from '../../types.js';
import { parseLang } from './i18n.js';
import { PRINTER_MODELS } from './profiles.service.js';

function modelParam(raw: unknown): PrinterModel {
  if (typeof raw !== 'string' || !Object.hasOwn(PRINTER_MODELS, raw)) throw notFound();
  return raw as PrinterModel;
}

/** Mounted at /api/profiles behind requireAuth. Preset ids are their names (URL-encode them). */
export function profilesRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/:printerModel', (req, res) => {
    // The bundle includes the viewer's custom filament presets, which change at any time.
    res.setHeader('Cache-Control', 'private, no-cache');
    const u = req.session!.user;
    // ?lang=en|es, else the user's language: option texts come from Creality Print's own catalogs.
    const lang = parseLang(req.query.lang, u.language === 'es' ? 'es' : 'en');
    res.json(ctx.profiles.bundle(modelParam(req.params.printerModel), { id: u.id, role: u.role }, lang));
  });

  router.get('/:printerModel/preset/:kind/:id', (req, res) => {
    const kind = req.params.kind;
    if (kind !== 'machine' && kind !== 'process' && kind !== 'filament') throw notFound();
    const u = req.session!.user;
    res.json(ctx.profiles.resolved(modelParam(req.params.printerModel), kind as PresetKind, String(req.params.id), { id: u.id, role: u.role }));
  });

  return router;
}
