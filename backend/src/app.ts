import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import type { AppContext } from './context.js';
import {
  apiNotFound,
  csrf,
  errorHandler,
  ipBan,
  loadSession,
  requestContext,
  requestLogger,
  requireAdmin,
  requireAuth,
  securityHeaders,
} from './middleware/index.js';
import { pendingPrintCap } from './middleware/pending-cap.js';
import { accountRoutes } from './modules/account/account.routes.js';
import { accountAvatarRoutes, adminAvatarRoutes, avatarsRoutes } from './modules/avatars/avatars.routes.js';
import { adminRoutes } from './modules/admin/admin.routes.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { printingRoutes } from './modules/printing/printing.routes.js';
import { setupRoutes } from './modules/setup/setup.routes.js';
import { publicRoutes } from './modules/system/public.routes.js';
import { usageRoutes } from './modules/usage/usage.routes.js';
import { engineRoutes } from './modules/engine/engine.routes.js';
import { filesRoutes } from './modules/files/files.routes.js';
import { profilesRoutes } from './modules/profiles/profiles.routes.js';
import { filamentPresetsRoutes } from './modules/filament-presets/filament-presets.routes.js';
import { projectsRoutes } from './modules/projects/projects.routes.js';
import { slicingRoutes } from './modules/slicing/slicing.routes.js';
import { accountNotificationRoutes, adminNotificationRoutes } from './modules/notifications/notifications.routes.js';

export function createApp(ctx: AppContext): Express {
  const app = express();
  app.disable('x-powered-by');
  // We resolve client IPs ourselves from exposure.mode (lib/client-ip.ts); Express must not trust any header.
  app.set('trust proxy', false);
  app.set('etag', false);

  app.use(requestContext(ctx));
  app.use(securityHeaders);

  const api = express.Router();
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  api.use(requestLogger());
  api.use(ipBan(ctx));
  // Scenes + base64 thumbnails (B1) may exceed 1 MB; body-parser skips already-parsed bodies.
  api.use(['/slice', '/projects'], express.json({ limit: '4mb' }));
  api.use(express.json({ limit: '1mb' }));
  api.use(cookieParser());
  api.use(csrf);
  api.use(loadSession(ctx));

  api.use(publicRoutes(ctx));
  api.use('/setup', setupRoutes(ctx));
  api.use('/auth', authRoutes(ctx));
  api.use('/account/notifications', requireAuth, accountNotificationRoutes(ctx)); // Phase 4
  api.use('/account/avatar', requireAuth, accountAvatarRoutes(ctx)); // AVATARS
  api.use('/account', requireAuth, accountRoutes(ctx));
  api.use('/avatars', requireAuth, avatarsRoutes(ctx)); // AVATARS
  api.use('/admin/notifications', requireAdmin, adminNotificationRoutes(ctx)); // Phase 4
  api.use('/admin/engine', requireAdmin, engineRoutes(ctx)); // B1
  api.use('/admin/users/:id/avatar', requireAdmin, adminAvatarRoutes(ctx)); // AVATARS
  api.use('/admin', requireAdmin, adminRoutes(ctx));
  api.use('/usage', requireAuth, usageRoutes(ctx));
  api.use('/files', requireAuth, filesRoutes(ctx)); // B1
  api.use('/projects', requireAuth, projectsRoutes(ctx)); // B1
  api.use('/profiles', requireAuth, profilesRoutes(ctx)); // B1
  api.use('/filament-presets', requireAuth, filamentPresetsRoutes(ctx)); // FILAMENTS
  api.use('/slice', requireAuth, slicingRoutes(ctx)); // B1
  api.post('/prints', pendingPrintCap(ctx)); // review 3A #3: cap open approval requests per user
  api.use(printingRoutes(ctx)); // /printers/:id/*, /prints/* (B2; auth enforced inside)
  api.use(apiNotFound);
  api.use(errorHandler);

  app.use('/api', api);

  // Production: the built frontend lives in backend/public; unknown non-API GETs fall back to index.html.
  const indexHtml = join(ctx.config.publicDir, 'index.html');
  if (existsSync(indexHtml)) {
    app.use(
      express.static(ctx.config.publicDir, {
        index: false,
        setHeaders(res, path) {
          if (/[\\/]assets[\\/]/.test(path)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          else res.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );
    app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  }

  app.use((_req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });
  app.use(errorHandler);
  return app;
}
