import type { AppContext } from '../../context.js';
import { NotificationService, type NotificationServiceOptions } from './notifications.service.js';
import { NotificationSources } from './sources.js';

export { NotificationService } from './notifications.service.js';
export { NotificationSources } from './sources.js';
export { adminNotificationRoutes, accountNotificationRoutes } from './notifications.routes.js';

export interface NotificationsOptions extends Partial<Pick<NotificationServiceOptions, 'fetchImpl' | 'lookup' | 'sendPush' | 'retryDelaysMs' | 'dedupeMs'>> {
  offlineAfterMs?: number;
}

/** Builds the dispatcher and hooks its sources. Called by createContext once the printing/engine services exist. */
export function createNotifications(ctx: AppContext, opts: NotificationsOptions = {}): { service: NotificationService; sources: NotificationSources } {
  const service = new NotificationService({
    db: ctx.db,
    settings: ctx.settings,
    appdataRoot: ctx.config.appdataRoot,
    ...(opts.fetchImpl && { fetchImpl: opts.fetchImpl }),
    ...(opts.lookup && { lookup: opts.lookup }),
    ...(opts.sendPush && { sendPush: opts.sendPush }),
    ...(opts.retryDelaysMs && { retryDelaysMs: opts.retryDelaysMs }),
    ...(opts.dedupeMs !== undefined && { dedupeMs: opts.dedupeMs }),
  });
  const sources = new NotificationSources(service, {
    db: ctx.db,
    settings: ctx.settings,
    hub: ctx.hub,
    audit: ctx.audit,
    manager: ctx.printerManager,
    printerName: (id) => ctx.printers.find(id)?.name ?? null,
    engine: {
      updateAvailable: () => ctx.engine.updateAvailable(),
      latestVersion: () => ctx.engine.status().latest?.version ?? null,
    },
    ...(opts.offlineAfterMs !== undefined && { offlineAfterMs: opts.offlineAfterMs }),
  });
  sources.attach();
  return { service, sources };
}
