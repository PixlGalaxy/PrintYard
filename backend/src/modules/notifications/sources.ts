// Adapters from internal signals to notification events. Nothing here changes the observed modules: it listens to
// realtime publishes (print.update, approval.pending), the audit log (approve/reject/refused/engine) and the
// printer manager's status stream (pause, errors, offline).
import type { Db } from '../../db/client.js';
import type { SettingsService } from '../../db/settings.js';
import { logger } from '../../logger.js';
import { isActiveState } from '../../printers/k2se/protocol.js';
import type { PrinterManager } from '../../printers/manager.js';
import { TOPICS } from '../../realtime/index.js';
import type { RealtimeHub } from '../../realtime/hub.js';
import type { PrinterStatus, PrintJob, PrintRequestState } from '../../types.js';
import type { AuditService } from '../audit/audit.service.js';
import type { NotifyEventData } from './events.js';
import type { NotificationService } from './notifications.service.js';

const log = logger.channel('notify');

export const OFFLINE_AFTER_MS = 5 * 60_000;
export const ENGINE_POLL_MS = 30 * 60_000;
const NOTIFIED_ENGINE_KEY = 'engine.updateAvailableNotified';

export interface EngineView {
  updateAvailable(): boolean;
  latestVersion(): string | null;
}

export interface SourceDeps {
  db: Db;
  settings: SettingsService;
  hub: RealtimeHub;
  audit: AuditService;
  manager: PrinterManager;
  printerName: (id: number) => string | null;
  engine?: EngineView;
  offlineAfterMs?: number;
}

interface PrintRow {
  id: number;
  user_id: number | null;
  username: string | null;
  printer_id: number;
  file_name: string;
  grams: number | null;
  seconds: number | null;
  state: PrintRequestState;
  reason: string | null;
  started_at: number | null;
  ended_at: number | null;
}

const IGNORED_CANCEL_REASONS = new Set(['withdrawn', 'user_deleted']);

export class NotificationSources {
  private readonly lastState = new Map<number, PrintRequestState>();
  private readonly offlineTimers = new Map<number, NodeJS.Timeout>();
  private readonly unsubscribe: (() => void)[] = [];
  private engineTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly svc: NotificationService,
    private readonly d: SourceDeps,
  ) {}

  attach(): void {
    if (this.unsubscribe.length) return;
    this.unsubscribe.push(
      this.d.hub.tap((topic, data) => this.guard(() => this.onPublish(topic, data))),
      this.d.audit.onLog((action, actor, target, meta) => this.guard(() => this.onAudit(action, actor.userId ?? null, actor.username ?? null, target, meta))),
      this.d.manager.onStatus((s, prev) => this.guard(() => this.onStatus(s, prev))),
    );
  }

  /** Periodic engine "update available" check (server only). */
  startEnginePoll(intervalMs = ENGINE_POLL_MS): void {
    if (this.engineTimer || !this.d.engine) return;
    this.engineTimer = setInterval(() => this.guard(() => this.checkEngine()), intervalMs);
    this.engineTimer.unref();
  }

  stop(): void {
    for (const u of this.unsubscribe.splice(0)) u();
    for (const t of this.offlineTimers.values()) clearTimeout(t);
    this.offlineTimers.clear();
    if (this.engineTimer) clearInterval(this.engineTimer);
    this.engineTimer = null;
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      log.error('Notification source failed', err);
    }
  }

  private printData(job: Pick<PrintJob, 'id' | 'userId' | 'username' | 'printerId' | 'fileName' | 'grams'>, extra: NotifyEventData = {}): NotifyEventData {
    return {
      printId: job.id,
      userId: job.userId,
      username: job.username,
      printerId: job.printerId,
      printerName: this.d.printerName(job.printerId),
      fileName: job.fileName,
      grams: job.grams,
      ...extra,
    };
  }

  private row(id: number): PrintRow | undefined {
    return this.d.db
      .prepare('SELECT p.*, COALESCE(u.username, p.username) AS username FROM prints p LEFT JOIN users u ON u.id = p.user_id WHERE p.id = ?')
      .get(id) as PrintRow | undefined;
  }

  private rowJob(r: PrintRow): Pick<PrintJob, 'id' | 'userId' | 'username' | 'printerId' | 'fileName' | 'grams'> {
    return { id: r.id, userId: r.user_id, username: r.username ?? '', printerId: r.printer_id, fileName: r.file_name, grams: r.grams };
  }

  // ------------------------------------------------------------------ realtime publishes

  private onPublish(topic: string, data: unknown): void {
    if (topic === TOPICS.approvalPending) {
      const job = data as PrintJob;
      this.svc.emit('approval.requested', this.printData(job, { durationSec: job.seconds }));
      return;
    }
    if (topic !== TOPICS.printUpdate) return;
    const job = data as PrintJob;
    const prev = this.lastState.get(job.id);
    this.lastState.set(job.id, job.state);
    if (this.lastState.size > 500) this.lastState.delete(this.lastState.keys().next().value!);
    if (prev === job.state) return;

    const elapsed = job.startedAt && job.endedAt ? Math.max(0, (job.endedAt - job.startedAt) / 1000) : null;
    switch (job.state) {
      case 'printing':
        this.svc.emit('print.started', this.printData(job, { durationSec: job.seconds }));
        break;
      case 'done':
        this.svc.emit('print.finished', this.printData(job, { durationSec: elapsed }));
        break;
      case 'failed':
        this.svc.emit('print.failed', this.printData(job, { durationSec: elapsed, reason: job.reason ?? null }));
        break;
      case 'cancelled':
        if (job.startedAt === null || IGNORED_CANCEL_REASONS.has(job.reason ?? '')) break;
        this.svc.emit('print.cancelled', this.printData(job, { durationSec: elapsed, reason: job.reason ?? null }));
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------------ audit log

  private onAudit(action: string, userId: number | null, _username: string | null, target: string | number | null, meta: unknown): void {
    const m = (meta ?? {}) as Record<string, unknown>;
    switch (action) {
      case 'print.approve':
      case 'print.reject': {
        const id = typeof m.printId === 'number' ? m.printId : null;
        const r = id === null ? undefined : this.row(id);
        if (!r) return;
        this.svc.emit(
          action === 'print.approve' ? 'approval.approved' : 'approval.rejected',
          this.printData(this.rowJob(r), { durationSec: r.seconds, reason: action === 'print.reject' ? ((m.reason as string | null) ?? null) : null }),
        );
        return;
      }
      case 'print.refused': {
        const code = typeof m.code === 'string' ? m.code : null;
        if (!code?.startsWith('prints.limit') || userId === null) return;
        const printerId = typeof m.printerId === 'number' ? m.printerId : null;
        this.svc.emit('limit.blocked', {
          userId,
          code,
          fileName: target === null ? null : String(target),
          printerId,
          printerName: printerId === null ? null : this.d.printerName(printerId),
        });
        return;
      }
      case 'engine.update':
        this.svc.emit('engine.updated', { version: target === null ? null : String(target), auto: m.auto === true });
        return;
      case 'engine.update_failed':
        this.svc.emit('engine.update_failed', { version: target === null ? null : String(target), error: typeof m.error === 'string' ? m.error : null });
        return;
      case 'engine.check':
        this.checkEngine();
        return;
      default:
        return;
    }
  }

  /** One "update available" per version; skipped while auto-update is on (an updated/failed event follows). */
  checkEngine(): void {
    const engine = this.d.engine;
    if (!engine || !engine.updateAvailable()) return;
    const version = engine.latestVersion();
    if (!version || this.svc.state(NOTIFIED_ENGINE_KEY) === version) return;
    if (this.d.settings.get('engine.autoUpdate')) return;
    this.svc.setState(NOTIFIED_ENGINE_KEY, version);
    this.svc.emit('engine.update_available', { version });
  }

  // ------------------------------------------------------------------ printer status

  private currentPrint(printerId: number): PrintRow | undefined {
    return this.d.db
      .prepare(
        `SELECT p.*, COALESCE(u.username, p.username) AS username FROM prints p LEFT JOIN users u ON u.id = p.user_id
         WHERE p.printer_id = ? AND p.state = 'printing' ORDER BY p.id DESC LIMIT 1`,
      )
      .get(printerId) as PrintRow | undefined;
  }

  private onStatus(s: PrinterStatus, prev: PrinterStatus | null): void {
    const id = s.printerId;

    if (s.online) {
      const t = this.offlineTimers.get(id);
      if (t) {
        clearTimeout(t);
        this.offlineTimers.delete(id);
      }
    } else if (prev?.online && (isActiveState(prev.state) || this.currentPrint(id)) && !this.offlineTimers.has(id)) {
      const t = setTimeout(() => {
        this.offlineTimers.delete(id);
        this.guard(() => {
          if (this.d.manager.status(id).online) return;
          const r = this.currentPrint(id);
          this.svc.emit('printer.offline', {
            printerId: id,
            printerName: this.d.printerName(id),
            printId: r?.id ?? null,
            fileName: r?.file_name ?? prev.fileName,
          });
        });
      }, this.d.offlineAfterMs ?? OFFLINE_AFTER_MS);
      t.unref();
      this.offlineTimers.set(id, t);
    }
    if (!s.online) return;

    if (s.state === 'paused' && prev?.state !== 'paused') {
      const r = this.currentPrint(id);
      this.svc.emit(
        'print.paused',
        r ? this.printData(this.rowJob(r)) : { printerId: id, printerName: this.d.printerName(id), fileName: s.fileName, userId: null },
      );
    }

    if (s.errorCode !== null && s.errorCode !== prev?.errorCode) {
      const r = this.currentPrint(id);
      this.svc.emit('printer.error', {
        printerId: id,
        printerName: this.d.printerName(id),
        code: s.errorCode,
        printId: r?.id ?? null,
        userId: r?.user_id ?? null,
        fileName: r?.file_name ?? s.fileName,
      });
    }
  }
}
