import { Router } from 'express';
import type { AppContext } from '../../context.js';
import { requireAuth } from '../../middleware/index.js';
import { listPrinterModels } from '../../printers/drivers/registry.js';
import { isReadOnly } from '../../printers/read-only.js';
import { LANGUAGES, type AppConfig } from '../../types.js';
import { appearanceDefaults } from '../account/appearance.js';

/** Unauthenticated endpoints (+ the logged-in printer list). */
export function publicRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ ok: true, version: ctx.config.version });
  });

  router.get('/config', (_req, res) => {
    const body: AppConfig = {
      appName: 'PrintYard',
      version: ctx.config.version,
      setupComplete: ctx.users.adminExists(),
      readOnly: isReadOnly(),
      files: {
        retentionEnabled: ctx.settings.get('files.retention.enabled'),
        retentionKeep: ctx.settings.get('files.retention.keep'),
      },
      printing: { calibrateByDefault: ctx.settings.get('printing.calibrateByDefault') },
      languages: LANGUAGES,
      defaultLanguage: ctx.settings.get('app.defaultLanguage'),
      appearance: appearanceDefaults(ctx),
      workspace: { defaultLevel: ctx.settings.get('workspace.defaultLevel') },
    };
    res.json(body);
  });

  router.get('/printer-models', (_req, res) => {
    res.json(listPrinterModels());
  });

  router.get('/printers', requireAuth, (_req, res) => {
    res.json(ctx.printers.list());
  });

  return router;
}
