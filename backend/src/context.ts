import { join } from 'node:path';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { SettingsService } from './db/settings.js';
import { trustedProxyMatcher } from './lib/client-ip.js';
import type { IpMatcher } from './lib/ip.js';
import { AuditService } from './modules/audit/audit.service.js';
import { DEFAULT_LOGIN_GUARD, IpBansService, LoginGuard, type LoginGuardOptions } from './modules/auth/login-guard.js';
import { SessionsService } from './modules/auth/sessions.service.js';
import { PrintersService } from './modules/printers/printers.service.js';
import { UsersService } from './modules/users/users.service.js';
import { AvatarsService } from './modules/avatars/avatars.service.js';
import type { ExposureMode } from './types.js';
import type { ProbeFn } from './printers/drivers/registry.js';
import { probePrinter } from './printers/drivers/registry.js';
import { createHub, type RealtimeHub } from './realtime/index.js';
import { PrinterManager, type PrinterManagerOptions } from './printers/manager.js';
import { sqlFileSource, type PrintFileSource } from './modules/printing/files-source.js';
import { PrintingService } from './modules/printing/printing.service.js';
import { PrinterRetentionService } from './modules/printing/printer-retention.js';
import { LiveViewService } from './modules/printing/live-view.js';
import { JobInfoService } from './modules/printing/job-info.js';
import { EtaService } from './modules/printing/eta.js';
import { PrinterControlService } from './modules/printing/control.js';
import { TempHistoryService } from './modules/printing/temp-history.js';
import { EngineManager } from './modules/engine/engine.service.js';
import { FilesService } from './modules/files/files.service.js';
import { ProfilesService } from './modules/profiles/profiles.service.js';
import { FilamentPresetsService } from './modules/filament-presets/filament-presets.service.js';
import { ProjectsService } from './modules/projects/projects.service.js';
import { SlicingService } from './modules/slicing/slicing.service.js';
import {
  createNotifications,
  type NotificationService,
  type NotificationSources,
  type NotificationsOptions,
} from './modules/notifications/index.js';

export interface AppContext {
  config: Config;
  db: Db;
  settings: SettingsService;
  users: UsersService;
  /** AVATARS: profile pictures in `<appdata>/avatars/<userId>.webp`. */
  avatars: AvatarsService;
  sessions: SessionsService;
  audit: AuditService;
  bans: IpBansService;
  loginGuard: LoginGuard;
  printers: PrintersService;
  /** Realtime WebSocket hub (`/api/ws`). Publish with `ctx.hub.publish(topic, data, filter)`; see realtime/hub.ts. */
  hub: RealtimeHub;
  /** One live connection per printer (started by server.ts, not in tests unless asked). */
  printerManager: PrinterManager;
  /** Print requests, limits, approvals, control, usage. */
  printing: PrintingService;
  /** Printer-side retention of the files SliceDock uploaded (settings printers.retention.*). */
  printerRetention: PrinterRetentionService;
  /** Library files as printing sees them (B1's `files` table). */
  printFiles: PrintFileSource;
  /** Current job G-code (cached) + preview image. */
  liveView: LiveViewService;
  /** Job objects (exclude object) and the last job kept until the bed is cleared. */
  jobInfo: JobInfoService;
  /** `PrinterStatus.estimate` (phase + remaining time that survives heating/leveling). */
  eta: EtaService;
  /** Motion/temperature/fan controls + exclude object (server-built G-code, audited). */
  printerControl: PrinterControlService;
  tempHistory: TempHistoryService;
  /** B1: file library (models, projects, G-code), retention, thumbnails. */
  files: FilesService;
  /** B1: official printer profiles (installed engine's, else the bundled snapshot). */
  profiles: ProfilesService;
  /** B1: SliceDock projects (3MF + scene sidecar). */
  projects: ProjectsService;
  /** FILAMENTS: custom filament presets (`custom:<id>` in scenes), merged into the profile bundle. */
  filamentPresets: FilamentPresetsService;
  /** B1: slicing engine install/update/rollback. */
  engine: EngineManager;
  /** B1: slicing job queue (one at a time). */
  slicing: SlicingService;
  /** Phase 4: notification dispatcher (admin channels + Web Push). */
  notifications: NotificationService;
  /** Phase 4: event adapters feeding the dispatcher (stopped on shutdown). */
  notificationSources: NotificationSources;
  /** Injected so tests never touch the network. */
  probe: ProbeFn;
  /** Current exposure config + compiled trusted-proxy matcher (rebuilt when settings change). */
  exposure(): { mode: ExposureMode; trustedProxies: readonly string[]; matcher: IpMatcher };
  /** Runtime warnings for the admin UI (`GET /api/admin/system`). */
  flags: {
    /** Forwarding headers arrived while `exposure.mode` is "none": a proxy is probably in front of us. */
    proxyHeadersSeen: boolean;
  };
  startedAt: number;
}

export interface ContextOptions {
  loginGuard?: LoginGuardOptions;
  probe?: ProbeFn;
  printFiles?: PrintFileSource;
  /** B1: fake slicing engine (default: SLICEDOCK_FAKE_ENGINE=1) and a fetch stub for the engine manager. */
  engine?: { fake?: boolean; fetchImpl?: typeof fetch };
  printerManager?: Partial<Omit<PrinterManagerOptions, 'printers' | 'hub'>>;
  /** Phase 4: fetch / web-push stubs and timings for notification tests. */
  notifications?: NotificationsOptions;
}

export function createContext(config: Config, db: Db, opts: ContextOptions = {}): AppContext {
  const settings = new SettingsService(db);
  const bans = new IpBansService(db);

  let exposureCache: ReturnType<AppContext['exposure']> | null = null;
  const flags = { proxyHeadersSeen: false };
  settings.onChange((keys) => {
    if (keys.some((k) => k.startsWith('exposure.'))) exposureCache = null;
    if (keys.includes('exposure.mode')) flags.proxyHeadersSeen = false;
  });

  const sessions = new SessionsService(db, () => ({
    sessionHours: settings.get('security.sessionHours'),
    idleMinutes: settings.get('security.idleMinutes'),
  }));
  const ctx: AppContext = {
    config,
    db,
    settings,
    users: new UsersService(db),
    avatars: new AvatarsService(db, join(config.appdataRoot, 'avatars')),
    sessions,
    audit: new AuditService(db),
    bans,
    loginGuard: new LoginGuard(bans, opts.loginGuard ?? DEFAULT_LOGIN_GUARD),
    printers: new PrintersService(db),
    hub: null as unknown as RealtimeHub,
    printerManager: null as unknown as PrinterManager,
    printing: null as unknown as PrintingService,
    printerRetention: null as unknown as PrinterRetentionService,
    printFiles: null as unknown as PrintFileSource,
    liveView: null as unknown as LiveViewService,
    jobInfo: null as unknown as JobInfoService,
    eta: null as unknown as EtaService,
    printerControl: null as unknown as PrinterControlService,
    tempHistory: null as unknown as TempHistoryService,
    files: null as unknown as FilesService,
    profiles: null as unknown as ProfilesService,
    projects: null as unknown as ProjectsService,
    filamentPresets: null as unknown as FilamentPresetsService,
    engine: null as unknown as EngineManager,
    slicing: null as unknown as SlicingService,
    notifications: null as unknown as NotificationService,
    notificationSources: null as unknown as NotificationSources,
    probe: opts.probe ?? probePrinter,
    exposure() {
      if (!exposureCache) {
        const trustedProxies = settings.get('exposure.trustedProxies');
        exposureCache = {
          mode: settings.get('exposure.mode'),
          trustedProxies,
          matcher: trustedProxyMatcher(trustedProxies),
        };
      }
      return exposureCache;
    },
    flags,
    startedAt: Date.now(),
  };
  ctx.hub = createHub(ctx, {
    // Push the current status right after a browser subscribes to a printer.
    onSubscribe: (_client, ids, send) => {
      for (const id of ids) {
        if (ctx.printers.find(id)) send('printer.status', ctx.printerManager.status(id));
      }
    },
  });
  ctx.printerManager = new PrinterManager({
    printers: ctx.printers,
    hub: ctx.hub,
    simulateAll: process.env.SLICEDOCK_SIM_PRINTER === '1',
    ...opts.printerManager,
  });
  ctx.printFiles = opts.printFiles ?? sqlFileSource(db, config.dataRoot);
  ctx.printerRetention = new PrinterRetentionService({ db, settings, audit: ctx.audit, manager: ctx.printerManager });
  ctx.printing = new PrintingService({
    db,
    users: ctx.users,
    printers: ctx.printers,
    settings,
    audit: ctx.audit,
    hub: ctx.hub,
    manager: ctx.printerManager,
    files: ctx.printFiles,
    retention: ctx.printerRetention,
  });
  ctx.printing.attach();
  ctx.liveView = new LiveViewService({
    manager: ctx.printerManager,
    printing: ctx.printing,
    files: ctx.printFiles,
    cacheDir: join(config.appdataRoot, 'cache', 'gcode'),
    lastJobSource: (id) => ctx.jobInfo.lastJob(id)?.source ?? null,
  });
  ctx.jobInfo = new JobInfoService({
    manager: ctx.printerManager,
    printers: ctx.printers,
    tracked: (id) => ctx.printing.currentLibraryFile(id),
    gcodePath: async (id) => (await ctx.liveView.currentGcode(id, { id: 0, role: 'admin' })).path,
  });
  ctx.jobInfo.attach();
  ctx.eta = new EtaService({
    manager: ctx.printerManager,
    tracked: (id) => {
      const cur = ctx.printing.currentLibraryFile(id);
      if (!cur) return null;
      const row = db.prepare('SELECT seconds, calibrate FROM prints WHERE id = ?').get(cur.printId) as
        | { seconds: number | null; calibrate: number }
        | undefined;
      return row ? { slicerSeconds: row.seconds, calibrate: row.calibrate === 1 } : null;
    },
    gcodePath: async (id) => (await ctx.liveView.currentGcode(id, { id: 0, role: 'admin' })).path,
  });
  ctx.eta.attach();
  ctx.printerControl = new PrinterControlService({
    manager: ctx.printerManager,
    printers: ctx.printers,
    users: ctx.users,
    audit: ctx.audit,
    currentOwner: (id) => ctx.printing.currentOwner(id),
  });
  ctx.printerControl.attach();
  ctx.tempHistory = new TempHistoryService({ manager: ctx.printerManager, printers: ctx.printers });

  // ---- B1: files, profiles, projects, engine, slicing ----
  ctx.files = new FilesService(db, config.dataRoot, config.appdataRoot, settings, ctx.audit);
  ctx.engine = new EngineManager({
    appdataRoot: config.appdataRoot,
    settings,
    audit: ctx.audit,
    publish: (p) => ctx.hub.publish('engine.progress', p, (c) => c.role === 'admin'),
    fake: opts.engine?.fake ?? process.env.SLICEDOCK_FAKE_ENGINE === '1',
    ...(opts.engine?.fetchImpl && { fetchImpl: opts.engine.fetchImpl }),
  });
  ctx.profiles = new ProfilesService(() => ctx.engine.profileSource());
  ctx.filamentPresets = new FilamentPresetsService(db, ctx.profiles, ctx.audit);
  ctx.profiles.setCustomFilaments(ctx.filamentPresets);
  ctx.projects = new ProjectsService(ctx.files, ctx.profiles, () => ctx.engine.appVersion());
  ctx.slicing = new SlicingService({
    appdataRoot: config.appdataRoot,
    settings,
    engine: ctx.engine,
    files: ctx.files,
    profiles: ctx.profiles,
    projects: ctx.projects,
    publish: (userId, job) => ctx.hub.publish('slice.job', job, (c) => c.userId === userId),
  });

  // ---- Phase 4: notifications (admin channels + Web Push); listens to hub/audit/printer events ----
  const notify = createNotifications(ctx, opts.notifications);
  ctx.notifications = notify.service;
  ctx.notificationSources = notify.sources;
  return ctx;
}
