import type { Db } from '../../db/client.js';
import type { SettingsService } from '../../db/settings.js';
import { AppError, forbidden, notFound } from '../../errors.js';
import { logger } from '../../logger.js';
import { isActiveState, isReadyForPrint, printerUploadName, basename } from '../../printers/k2se/protocol.js';
import { randomBytes } from 'node:crypto';
import type { PrinterManager } from '../../printers/manager.js';
import { assertWritable } from '../../printers/read-only.js';
import { forAdmins, forUserAndAdmins, TOPICS } from '../../realtime/index.js';
import type { RealtimeHub } from '../../realtime/hub.js';
import type { GcodeScan, PrinterStatus, PrintJob, PrintRequestState, PrintUploadProgress, UsageSummary, UserLimits } from '../../types.js';
import type { AuditService } from '../audit/audit.service.js';
import { hashFile } from '../files/files.service.js';
import type { PrintersService } from '../printers/printers.service.js';
import type { UsersService } from '../users/users.service.js';
import { scanOf, type PrintableFile, type PrintFileSource } from './files-source.js';
import type { PrinterRetentionService } from './printer-retention.js';
import { costFor, evaluateLimits, monthRange, type PrintEstimate } from './limits.js';
import { UploadEstimator } from './upload-progress.js';
import type { Actor, StartPrintInput } from './types.js';

interface PrintRow {
  id: number;
  user_id: number | null;
  username: string | null;
  printer_id: number;
  file_id: number;
  file_name: string;
  file_sha256: string | null;
  file_size: number | null;
  file_owner_id: number | null;
  printer_path: string | null;
  grams: number | null;
  seconds: number | null;
  cost_estimate: number | null;
  actual_grams: number | null;
  state: PrintRequestState;
  reason: string | null;
  source: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  calibrate?: number;
  /** Existing printer file to start instead of uploading (Files → On the printer). */
  printer_file?: string | null;
}

interface Tracking {
  jobId: number;
  userId: number | null;
  expectName: string | null;
  startedAt: number;
  seenActive: boolean;
  lastProgress: number | null;
  cancelledBy: string | null;
  /** A terminal state seen after the job was active: finalised only once it stayed for `terminalStableMs`. */
  pendingEnd?: { since: number; timer: NodeJS.Timeout | null } | null;
}

/** Klipper `print_stats.state` values that agree with each PrintYard end state. */
const MOON_AGREES: Record<'done' | 'failed' | 'cancelled', ReadonlySet<string>> = {
  done: new Set(['complete', 'standby']),
  failed: new Set(['error', 'cancelled', 'standby']),
  cancelled: new Set(['cancelled', 'standby', 'complete', 'error']),
};

export interface PrintingDeps {
  db: Db;
  users: UsersService;
  printers: PrintersService;
  settings: SettingsService;
  audit: AuditService;
  hub: RealtimeHub;
  manager: PrinterManager;
  files: PrintFileSource;
  /** Printer-side retention of PrintYard uploads (optional in unit tests). */
  retention?: PrinterRetentionService;
  /** A started job that never shows up as active on the printer is failed after this long. */
  startGraceMs?: number;
  /** Minimum gap between `print.upload` frames (default 250 ms = 4/s). */
  uploadProgressMs?: number;
  /**
   * A terminal printer state (idle/aborted/complete/failed) must stay this long, with Moonraker agreeing, before the
   * print is finalised (the K2 SE reports transient states while pausing/resuming). Default 5 s.
   */
  terminalStableMs?: number;
}

// The alias comes after p.* so it wins: the live username, else the snapshot kept after the user was deleted.
const SELECT = `SELECT p.*, COALESCE(u.username, p.username) AS username FROM prints p LEFT JOIN users u ON u.id = p.user_id`;

export const printerBusy = () => new AppError(409, 'prints.printer_busy', 'The printer is busy');
export const printerOffline = () => new AppError(409, 'prints.printer_offline', 'The printer is offline');
const invalidState = (message: string) => new AppError(409, 'prints.invalid_state', message);
export const fileChanged = () =>
  new AppError(409, 'prints.file_changed', 'The file changed or was removed after the print was requested');
export const untrustedGcode = () =>
  new AppError(403, 'prints.untrusted_gcode', 'Only G-code sliced in PrintYard can be printed (ask an admin for the permission)');
/** `details.findings`: the first 20 (`details.total` = all). */
export const dangerousGcode = (scan: GcodeScan) =>
  new AppError(403, 'prints.dangerous_gcode', 'The G-code contains commands PrintYard does not allow', {
    total: scan.total,
    findings: scan.findings.slice(0, 20),
    limits: scan.limits,
  });

/** Print requests, limits, approvals, dispatch (upload + start), completion tracking and the bed-cleared rule. */
export class PrintingService {
  private readonly tracking = new Map<number, Tracking>();
  /** Printer id → owner (user id, null = none) of the job being uploaded/started there. */
  private readonly dispatching = new Map<number, number | null>();
  /** Print ids whose G-code is being sent to the printer right now (reported as state `uploading`). */
  private readonly uploading = new Set<number>();
  private attached = false;
  /** Latest background printer-retention run (tests await it). */
  lastRetention: Promise<unknown> | null = null;

  constructor(private readonly d: PrintingDeps) {}

  /** Hooks the printer manager: current-print decoration and completion tracking. Restores running jobs. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    const running = this.d.db.prepare(`${SELECT} WHERE p.state = 'printing'`).all() as PrintRow[];
    for (const r of running) {
      this.tracking.set(r.printer_id, {
        jobId: r.id,
        userId: r.user_id,
        expectName: basename(r.printer_path),
        startedAt: r.started_at ?? r.created_at,
        seenActive: true,
        lastProgress: null,
        cancelledBy: null,
      });
    }
    this.d.manager.setDecorator((printerId) => ({ currentPrintId: this.tracking.get(printerId)?.jobId ?? null }));
    this.d.manager.onStatus((s, prev) => this.onStatus(s, prev));
  }

  // ---------------------------------------------------------------- requests

  /**
   * `POST /api/prints` (source web) and the future MCP tool (source mcp). Returns 201 + printing job when sent to
   * the printer, 202 + pending job when it needs an admin's approval.
   */
  async startPrint(actor: Actor, input: StartPrintInput): Promise<{ status: 201 | 202; job: PrintJob }> {
    assertWritable();
    const printer = this.d.printers.get(input.printerId);
    const first = this.readableFile(actor, input.fileId);
    const isAdmin = actor.role === 'admin';
    // Uploaded-G-code policy (finding #3): without the permission only PrintYard-sliced files (sha256 verified below).
    const mayUpload = isAdmin || this.d.users.canPrintUploadedGcode(actor.id);
    const refuse = (err: AppError): never => {
      this.d.audit.log('print.refused', auditActor(actor), first.name, { code: err.code, printerId: printer.id, fileId: first.id });
      throw err;
    };
    if (!mayUpload && first.trusted !== true) refuse(untrustedGcode());
    // Async part first (estimate + content hash + scan), then check + insert synchronously so parallel requests of
    // the same user cannot both pass the monthly check (pending/approved rows count toward it).
    const gcode = this.d.files.estimate ? await this.d.files.estimate(first) : first.gcode;
    const content = await this.contentOf(first);
    let allowedDangerous: GcodeScan | null = null;
    if (!isTrustedContent(first, content.sha256)) {
      if (!mayUpload) refuse(untrustedGcode());
      const scan = await scanOf(this.d.files, gcode ? { ...first, gcode } : first);
      if (!scan.ok) {
        if (!isAdmin || input.allowDangerous !== true || input.source !== 'web') refuse(dangerousGcode(scan));
        allowedDangerous = scan;
      }
    }
    const file = this.readableFile(actor, input.fileId);
    if (file.path !== first.path || (file.sha256 && file.sha256 !== content.sha256)) throw fileChanged();
    const estimate = estimateOf(gcode);
    const limits = this.limitsOf(actor.id);
    const decision = evaluateLimits(limits, estimate, this.committedMonthGrams(actor.id), isAdmin);
    if (!decision.ok) {
      this.d.audit.log('print.refused', auditActor(actor), file.name, { code: decision.error.code, printerId: printer.id, fileId: file.id });
      throw decision.error;
    }
    const cost = costFor(estimate.grams, this.d.settings.get('limits.costPerKg'));
    const calibrate = input.calibrate ?? this.d.settings.get('printing.calibrateByDefault');

    const printerFile = input.printerFile?.path ?? null;
    if (decision.needsApproval) {
      const job = this.insert(actor, printer.id, file, content, estimate, cost, 'pending', input.source, decision.approvalReason ?? null, calibrate, printerFile);
      if (allowedDangerous) this.auditDangerous(actor, file.name, job.id, allowedDangerous);
      this.d.audit.log('print.request', auditActor(actor), file.name, { printId: job.id, printerId: printer.id, reason: decision.approvalReason });
      this.d.hub.publish(TOPICS.approvalPending, job, forAdmins);
      this.d.hub.publish(TOPICS.printUpdate, job, forUserAndAdmins(job.userId));
      return { status: 202, job };
    }

    this.assertPrinterReady(printer.id);
    this.ensureBedClear(actor, printer.id, input.source === 'web' && input.confirmBedClear === true);
    const job = this.insert(actor, printer.id, file, content, estimate, cost, 'approved', input.source, null, calibrate, printerFile);
    if (allowedDangerous) this.auditDangerous(actor, file.name, job.id, allowedDangerous);
    this.d.audit.log('print.start', auditActor(actor), file.name, { printId: job.id, printerId: printer.id, source: input.source });
    return { status: 201, job: await this.dispatch(job.id, file) };
  }

  /**
   * Admin approval: re-verifies the file (same id, owner, sha256, still readable by the requester) and the
   * requester's limits, then sends the job to the printer. A changed/removed file fails the request
   * (`prints.file_changed`). A limit that is now exceeded keeps it pending unless `force: true` (audited).
   * Offline/busy/bed-occupied keeps it pending (error thrown).
   */
  async approve(
    admin: Actor,
    id: number,
    opts: { confirmBedClear?: boolean; force?: boolean; allowDangerous?: boolean; calibrate?: boolean } = {},
  ): Promise<PrintJob> {
    assertWritable();
    const row = this.row(id);
    if (row.state !== 'pending') throw invalidState('Only pending prints can be approved');
    const file = await this.verifySnapshot(row);
    if (!file) {
      if (this.row(id).state === 'pending') this.finishRow(id, 'failed', 'file_changed');
      throw fileChanged();
    }
    // Same uploaded-G-code policy as the request (the permission may have been revoked meanwhile); stays pending.
    let allowedDangerous: GcodeScan | null = null;
    if (!isTrustedContent(file, row.file_sha256)) {
      if (row.user_id === null || !this.d.users.canPrintUploadedGcode(row.user_id)) throw untrustedGcode();
      const scan = await scanOf(this.d.files, file);
      if (!scan.ok) {
        if (opts.allowDangerous !== true) throw dangerousGcode(scan);
        allowedDangerous = scan;
      }
    }
    if (this.row(id).state !== 'pending') throw invalidState('Only pending prints can be approved');
    let forced = false;
    if (row.user_id !== null) {
      const requester = this.d.users.getAdminUser(row.user_id);
      const decision = evaluateLimits(
        requester.limits,
        { grams: row.grams, seconds: row.seconds },
        this.committedMonthGrams(row.user_id, Date.now(), id),
        requester.role === 'admin',
      );
      if (!decision.ok) {
        if (opts.force !== true) throw decision.error;
        forced = true;
        this.d.audit.log('print.force_approve', auditActor(admin), row.file_name, {
          printId: id,
          userId: row.user_id,
          code: decision.error.code,
          details: decision.error.details ?? null,
        });
      }
    }
    this.assertPrinterReady(row.printer_id);
    this.ensureBedClear(admin, row.printer_id, opts.confirmBedClear === true);
    const now = Date.now();
    const res = this.d.db
      .prepare(`UPDATE prints SET state = 'approved', decided_by = ?, decided_at = ?, forced = ?, calibrate = COALESCE(?, calibrate) WHERE id = ? AND state = 'pending'`)
      .run(admin.id, now, forced ? 1 : 0, opts.calibrate === undefined ? null : opts.calibrate ? 1 : 0, id);
    if (res.changes === 0) throw invalidState('Only pending prints can be approved');
    if (allowedDangerous) this.auditDangerous(admin, row.file_name, id, allowedDangerous);
    this.d.audit.log('print.approve', auditActor(admin), row.file_name, { printId: id, userId: row.user_id, ...(forced && { forced: true }) });
    return this.dispatch(id, file);
  }

  reject(admin: Actor, id: number, reason: string | null): PrintJob {
    const row = this.row(id);
    if (row.state !== 'pending') throw invalidState('Only pending prints can be rejected');
    this.d.db
      .prepare(`UPDATE prints SET state = 'rejected', reason = ?, decided_by = ?, decided_at = ?, ended_at = ? WHERE id = ?`)
      .run(reason, admin.id, Date.now(), Date.now(), id);
    this.d.audit.log('print.reject', auditActor(admin), row.file_name, { printId: id, userId: row.user_id, reason });
    return this.publishJob(id);
  }

  /** `DELETE /api/prints/:id`: the owner (or an admin) withdraws a pending request. */
  cancelPending(actor: Actor, id: number): PrintJob {
    const row = this.row(id);
    if (row.user_id !== actor.id && actor.role !== 'admin') throw notFound();
    if (row.state !== 'pending') throw invalidState('Only pending prints can be withdrawn');
    this.d.db.prepare(`UPDATE prints SET state = 'cancelled', reason = 'withdrawn', ended_at = ? WHERE id = ?`).run(Date.now(), id);
    this.d.audit.log('print.withdraw', auditActor(actor), row.file_name, { printId: id });
    return this.publishJob(id);
  }

  /**
   * Before a user is deleted: their pending requests (waiting for approval) are cancelled with reason
   * `user_deleted`. A print already on the printer keeps running and is tracked as before.
   */
  closeRequestsOf(userId: number): number {
    const ids = (
      this.d.db.prepare(`SELECT id FROM prints WHERE user_id = ? AND state = 'pending'`).all(userId) as { id: number }[]
    ).map((r) => r.id);
    if (ids.length === 0) return 0;
    const now = Date.now();
    const stmt = this.d.db.prepare(`UPDATE prints SET state = 'cancelled', reason = 'user_deleted', ended_at = ? WHERE id = ? AND state = 'pending'`);
    for (const id of ids) stmt.run(now, id);
    for (const id of ids) this.publishJob(id);
    return ids.length;
  }

  // ---------------------------------------------------------------- control

  /** Pause/resume/cancel: admins always; users only for the print they own. */
  async control(actor: Actor, printerId: number, action: 'pause' | 'resume' | 'cancel'): Promise<PrinterStatus> {
    assertWritable();
    this.d.printers.get(printerId);
    const t = this.tracking.get(printerId);
    if (actor.role !== 'admin' && (!t || t.userId !== actor.id)) {
      throw forbidden('prints.not_owner', 'Only the owner of the current print or an admin can do this');
    }
    const status = this.d.manager.status(printerId);
    if (!status.online) throw printerOffline();
    if (action === 'pause' && status.state !== 'printing') throw invalidState('The printer is not printing');
    if (action === 'resume' && status.state !== 'paused') throw invalidState('The printer is not paused');
    if (action === 'cancel' && !isActiveState(status.state)) throw invalidState('Nothing is printing');
    const driver = this.d.manager.driver(printerId);
    if (action === 'pause') await driver.pause();
    else if (action === 'resume') await driver.resume();
    else {
      if (t) t.cancelledBy = actor.username;
      await driver.cancel();
    }
    this.d.audit.log(`print.${action}`, auditActor(actor), String(printerId), { printerId, printId: t?.jobId ?? null });
    logger.printer.info(`printer #${printerId}: ${action} by "${actor.username}"`);
    return this.d.manager.status(printerId);
  }

  /** `POST /api/printers/:id/bed-cleared`. */
  markBedCleared(actor: Actor, printerId: number): PrinterStatus {
    assertWritable();
    const p = this.d.printers.get(printerId);
    this.d.printers.markBedCleared(printerId);
    this.d.audit.log('printer.bed_cleared', auditActor(actor), p.name, { printerId, lastPrintId: p.lastPrintId });
    this.d.manager.republish(printerId);
    return this.d.manager.status(printerId);
  }

  // ---------------------------------------------------------------- queries

  /** The library file behind the print PrintYard is tracking on this printer (printer-side name → file id). */
  currentLibraryFile(printerId: number): { fileId: number; printerFileName: string | null; userId: number | null; printId: number } | null {
    const t = this.tracking.get(printerId);
    if (!t) return null;
    const row = this.d.db.prepare('SELECT file_id, printer_path, user_id FROM prints WHERE id = ?').get(t.jobId) as
      | { file_id: number; printer_path: string | null; user_id: number | null }
      | undefined;
    return row ? { fileId: row.file_id, printerFileName: basename(row.printer_path), userId: row.user_id, printId: t.jobId } : null;
  }

  /** While a job is being uploaded/started on the printer: its owner (null = none); undefined when nothing is. */
  dispatchOwner(printerId: number): number | null | undefined {
    return this.dispatching.has(printerId) ? (this.dispatching.get(printerId) ?? null) : undefined;
  }

  /** Owner of the print PrintYard is tracking on the printer (null: none, or started elsewhere). */
  currentOwner(printerId: number): number | null {
    return this.tracking.get(printerId)?.userId ?? null;
  }

  list(actor: Actor, scope: 'mine' | 'all', opts: { printerId?: number | undefined; limit?: number } = {}): PrintJob[] {
    if (scope === 'all' && actor.role !== 'admin') throw forbidden();
    const where: string[] = [];
    const args: unknown[] = [];
    if (scope === 'mine') {
      where.push('p.user_id = ?');
      args.push(actor.id);
    }
    if (opts.printerId) {
      where.push('p.printer_id = ?');
      args.push(opts.printerId);
    }
    const sql = `${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY p.id DESC LIMIT ?`;
    return (this.d.db.prepare(sql).all(...args, opts.limit ?? 200) as PrintRow[]).map(toJob);
  }

  pending(): PrintJob[] {
    return (this.d.db.prepare(`${SELECT} WHERE p.state = 'pending' ORDER BY p.id`).all() as PrintRow[]).map((r) => this.toJob(r));
  }

  get(actor: Actor, id: number): PrintJob {
    const row = this.row(id);
    if (row.user_id !== actor.id && actor.role !== 'admin') throw notFound();
    return this.toJob(row);
  }

  /**
   * Grams this calendar month (server TZ) by start time: printing jobs at their estimate, done jobs at their
   * actual (else estimated) grams, and failed/cancelled jobs that had started at the grams they consumed.
   */
  monthGrams(userId: number, now = Date.now()): number {
    const { start, end } = monthRange(now);
    const r = this.d.db
      .prepare(
        `SELECT COALESCE(SUM(CASE
           WHEN state = 'printing' THEN COALESCE(grams, 0)
           WHEN state = 'done' THEN COALESCE(actual_grams, grams, 0)
           WHEN state IN ('failed', 'cancelled') THEN COALESCE(actual_grams, 0)
           ELSE 0 END), 0) AS g
         FROM prints WHERE user_id = ? AND started_at IS NOT NULL AND started_at >= ? AND started_at < ?`,
      )
      .get(userId, start, end) as { g: number };
    return Math.round(r.g * 100) / 100;
  }

  /**
   * What the monthly limit is checked against: `monthGrams` plus requests created this month that are still
   * pending or approved-but-not-started (finding #9). `excludeId` leaves out the request being approved.
   */
  committedMonthGrams(userId: number, now = Date.now(), excludeId?: number): number {
    const { start, end } = monthRange(now);
    const r = this.d.db
      .prepare(
        `SELECT COALESCE(SUM(COALESCE(grams, 0)), 0) AS g FROM prints
         WHERE user_id = ? AND state IN ('pending', 'approved') AND started_at IS NULL AND created_at >= ? AND created_at < ? AND id != ?`,
      )
      .get(userId, start, end, excludeId ?? -1) as { g: number };
    return Math.round((this.monthGrams(userId, now) + r.g) * 100) / 100;
  }

  usage(userId: number, now = Date.now()): UsageSummary {
    const monthGrams = this.monthGrams(userId, now);
    const costPerKg = this.d.settings.get('limits.costPerKg');
    return {
      monthGrams,
      committedGrams: this.committedMonthGrams(userId, now),
      monthCost: costFor(monthGrams, costPerKg),
      limits: this.limitsOf(userId),
      costPerKg,
      currency: this.d.settings.get('limits.currency'),
    };
  }

  usageAll(now = Date.now()): (UsageSummary & { userId: number; username: string })[] {
    return this.d.users.listAdminUsers().map((u) => ({ userId: u.id, username: u.username, ...this.usage(u.id, now) }));
  }

  // ---------------------------------------------------------------- internals

  /** An admin printed (or approved) G-code the scanner flagged. */
  private auditDangerous(actor: Actor, fileName: string, printId: number, scan: GcodeScan): void {
    this.d.audit.log('print.allow_dangerous', auditActor(actor), fileName, {
      printId,
      total: scan.total,
      findings: scan.findings.slice(0, 20).map((f) => ({ line: f.line, command: f.command, reason: f.reason })),
    });
    logger.printer.warn(`print #${printId}: "${actor.username}" overrode ${scan.total} G-code scan finding(s) for "${fileName}"`);
  }

  private limitsOf(userId: number): UserLimits {
    return this.d.users.getAdminUser(userId).limits;
  }

  private readableFile(actor: Actor, fileId: number): PrintableFile {
    const file = this.d.files.get(fileId);
    if (!file) throw notFound();
    if (file.ownerId !== actor.id && file.visibility !== 'shared' && actor.role !== 'admin') throw notFound();
    if (file.kind !== 'gcode') throw new AppError(400, 'prints.not_gcode', 'Only G-code files can be printed');
    return file;
  }

  /** sha256 + size of the file on disk (a missing file → 404). */
  private async contentOf(file: PrintableFile): Promise<{ sha256: string; size: number }> {
    try {
      return await hashFile(file.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw notFound();
      throw err;
    }
  }

  /**
   * The file of a pending request if it is still exactly the one requested: same id and owner, the stored and the
   * on-disk sha256 equal the snapshot, still G-code and still readable by the requester. Null otherwise.
   */
  private async verifySnapshot(row: PrintRow): Promise<PrintableFile | null> {
    if (!row.file_sha256) return null; // legacy request without a snapshot: cannot be verified
    const file = this.d.files.get(row.file_id);
    if (!file || file.kind !== 'gcode' || file.ownerId !== row.file_owner_id) return null;
    if (file.sha256 && file.sha256 !== row.file_sha256) return null;
    if (row.user_id !== null && file.ownerId !== row.user_id && file.visibility !== 'shared') {
      const role = this.d.users.findRowById(row.user_id)?.role;
      if (role !== 'admin') return null;
    }
    let disk: { sha256: string; size: number };
    try {
      disk = await hashFile(file.path);
    } catch {
      return null;
    }
    if (disk.sha256 !== row.file_sha256) return null;
    // Re-read after the await: the row must not have changed meanwhile.
    const again = this.d.files.get(row.file_id);
    if (!again || again.path !== file.path || again.ownerId !== file.ownerId) return null;
    return again;
  }

  private assertPrinterReady(printerId: number): void {
    const status = this.d.manager.status(printerId);
    if (!status.online) throw printerOffline();
    if (this.dispatching.has(printerId) || this.tracking.has(printerId) || !isReadyForPrint(status)) throw printerBusy();
  }

  /**
   * Bed-cleared rule: after a print ended the bed may hold the previous part. Web callers confirm in a dialog
   * (`confirmBedClear: true` → cleared + audited); MCP callers can never confirm here.
   */
  private ensureBedClear(actor: Actor, printerId: number, confirmed: boolean): void {
    const p = this.d.printers.get(printerId);
    if (p.bedClear) return;
    if (confirmed) {
      this.d.printers.markBedCleared(printerId);
      this.d.audit.log('printer.bed_cleared', auditActor(actor), p.name, { printerId, lastPrintId: p.lastPrintId, viaPrint: true });
      this.d.manager.republish(printerId);
      return;
    }
    const last = p.lastPrintId ? (this.d.db.prepare('SELECT file_name, ended_at FROM prints WHERE id = ?').get(p.lastPrintId) as { file_name: string; ended_at: number | null } | undefined) : undefined;
    throw new AppError(409, 'prints.bed_not_cleared', 'Remove the previous print from the bed first', {
      lastPrintId: p.lastPrintId,
      endedAt: last?.ended_at ?? p.bedOccupiedSince,
      fileName: last?.file_name ?? null,
    });
  }

  private insert(
    actor: Actor,
    printerId: number,
    file: PrintableFile,
    content: { sha256: string; size: number },
    est: PrintEstimate,
    cost: number | null,
    state: PrintRequestState,
    source: string,
    reason: string | null,
    calibrate = false,
    printerFile: string | null = null,
  ): PrintJob {
    const r = this.d.db
      .prepare(
        `INSERT INTO prints (user_id, username, printer_id, file_id, file_name, file_sha256, file_size, file_owner_id, grams, seconds,
           cost_estimate, state, reason, source, created_at, calibrate, printer_file)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(actor.id, actor.username, printerId, file.id, file.name, content.sha256, content.size, file.ownerId, est.grams, est.seconds,
        cost, state, reason, source, Date.now(), calibrate ? 1 : 0, printerFile);
    return this.toJob(this.row(Number(r.lastInsertRowid)));
  }

  /** Upload + start. On failure the job is marked failed and the error rethrown. */
  private async dispatch(jobId: number, file: PrintableFile): Promise<PrintJob> {
    const row = this.row(jobId);
    const printerId = row.printer_id;
    if (this.dispatching.has(printerId)) throw printerBusy();
    this.dispatching.set(printerId, row.user_id);
    let uploaded = false;
    try {
      const driver = this.d.manager.driver(printerId);
      // Unique per print and never an existing printer file (no overwrite of touchscreen/other uploads).
      const existing = await driver.listFiles();
      if (!existing) throw new AppError(502, 'prints.upload_failed', 'The printer did not report its file list');
      if (row.printer_file) return await this.startExisting(jobId, row, existing);
      const taken = new Set(existing.map((f) => f.name));
      let name = printerUploadName(file.name, jobId);
      while (taken.has(name)) name = printerUploadName(file.name, jobId, randomBytes(3).toString('hex'));
      this.uploading.add(jobId);
      this.publishJob(jobId);
      const { path, size } = await driver.uploadFile(name, file.path, this.uploadReporter(jobId, printerId, file.name, row.user_id));
      uploaded = true;
      this.uploading.delete(jobId);
      this.d.retention?.recordUpload(printerId, path, jobId, size ?? null);
      await driver.startPrint(path, { calibrate: this.row(jobId).calibrate === 1 });
      const now = Date.now();
      this.d.db
        .prepare(`UPDATE prints SET state = 'printing', printer_path = ?, started_at = ?, reason = NULL WHERE id = ?`)
        .run(path, now, jobId);
      this.tracking.set(printerId, {
        jobId,
        userId: row.user_id,
        expectName: name,
        startedAt: now,
        seenActive: false,
        lastProgress: null,
        cancelledBy: null,
      });
      logger.printer.info(`printer #${printerId}: print #${jobId} started (${name})`);
      const job = this.publishJob(jobId);
      this.d.manager.republish(printerId);
      return job;
    } catch (err) {
      this.uploading.delete(jobId);
      const code = err instanceof AppError ? err.code : 'prints.upload_failed';
      this.finishRow(jobId, 'failed', code);
      logger.printer.warn(`printer #${printerId}: print #${jobId} could not start`, err);
      if (err instanceof AppError) throw err;
      throw new AppError(502, 'prints.upload_failed', 'Upload to the printer failed');
    } finally {
      this.dispatching.delete(printerId);
      // After a successful upload, trim older PrintYard uploads on that printer (background, never throws).
      if (uploaded && this.d.retention) this.lastRetention = this.d.retention.run(printerId);
    }
  }

  /**
   * Files → On the printer: start the printer's own file (no upload, no retention record: PrintYard did not put it
   * there). The printer must still list the exact path with the size of the content that was scanned and hashed.
   */
  private async startExisting(jobId: number, row: PrintRow, list: { name: string; path: string; size: number | null }[]): Promise<PrintJob> {
    const printerId = row.printer_id;
    const path = row.printer_file!;
    const entry = list.find((f) => f.path === path);
    if (!entry || (entry.size !== null && row.file_size !== null && entry.size !== row.file_size)) {
      throw new AppError(409, 'prints.file_changed', 'The file on the printer changed or was removed after the print was requested');
    }
    await this.d.manager.driver(printerId).startPrint(path, { calibrate: this.row(jobId).calibrate === 1 });
    const now = Date.now();
    this.d.db.prepare(`UPDATE prints SET state = 'printing', printer_path = ?, started_at = ?, reason = NULL WHERE id = ?`).run(path, now, jobId);
    this.tracking.set(printerId, {
      jobId,
      userId: row.user_id,
      expectName: entry.name,
      startedAt: now,
      seenActive: false,
      lastProgress: null,
      cancelledBy: null,
    });
    logger.printer.info(`printer #${printerId}: print #${jobId} started from the printer's file ${entry.name}`);
    const job = this.publishJob(jobId);
    this.d.manager.republish(printerId);
    return job;
  }

  private onStatus(s: PrinterStatus, prev: PrinterStatus | null): void {
    let t = this.tracking.get(s.printerId);
    if (!t) {
      this.heal(s);
      t = this.tracking.get(s.printerId);
    }
    if (!t) {
      // A print started elsewhere (touchscreen) just ended: the bed may be occupied too.
      if (prev && isActiveState(prev.state) && s.online && (s.state === 'complete' || s.state === 'aborted' || s.state === 'failed')) {
        this.d.printers.markBedOccupied(s.printerId, null);
      }
      return;
    }
    if (!s.online) return; // wait: the printer may come back mid-print
    const ours = t.expectName === null || s.fileName === null || s.fileName === t.expectName;
    if (isActiveState(s.state) && ours) {
      t.seenActive = true;
      if (s.progress !== null) t.lastProgress = s.progress;
      // A later printing/paused state revives the same print (transient pause/resume frames).
      this.clearPendingEnd(t);
      return;
    }
    if (!t.seenActive) {
      if (Date.now() - t.startedAt > (this.d.startGraceMs ?? 3 * 60_000)) this.finish(s.printerId, t, 'failed', 'printer_did_not_start', 0);
      return;
    }
    if (!this.endOf(s, t)) return;
    // Terminal-looking state: finalise only once it is stable (and Moonraker agrees), see `settleEnd`.
    if (!t.pendingEnd) {
      t.pendingEnd = { since: Date.now(), timer: null };
      this.scheduleEndCheck(s.printerId, t);
    }
  }

  /** What the current state would finalise the tracked print as (null: not a terminal state). */
  private endOf(s: PrinterStatus, t: Tracking): { state: 'done' | 'failed' | 'cancelled'; reason: string | null; progress: number } | null {
    const progress = s.progress ?? t.lastProgress ?? 0;
    const cancelled = t.cancelledBy ? `cancelled_by:${t.cancelledBy}` : 'cancelled_on_printer';
    if (isActiveState(s.state)) return { state: 'cancelled', reason: 'replaced_on_printer', progress: t.lastProgress ?? 0 };
    switch (s.state) {
      case 'complete':
        return { state: 'done', reason: null, progress: 100 };
      case 'aborted':
        return { state: 'cancelled', reason: cancelled, progress };
      case 'failed':
      case 'error':
        return { state: 'failed', reason: s.errorCode ? `printer_error:${s.errorCode}` : 'printer_failed', progress };
      case 'idle':
        return progress >= 99 ? { state: 'done', reason: null, progress: 100 } : { state: 'cancelled', reason: cancelled, progress };
      default:
        return null;
    }
  }

  private scheduleEndCheck(printerId: number, t: Tracking): void {
    if (!t.pendingEnd) return;
    if (t.pendingEnd.timer) clearTimeout(t.pendingEnd.timer);
    const stable = this.d.terminalStableMs ?? 5000;
    const wait = Math.max(20, t.pendingEnd.since + stable - Date.now());
    t.pendingEnd.timer = setTimeout(() => this.settleEnd(printerId, t), wait);
    t.pendingEnd.timer.unref?.();
  }

  private clearPendingEnd(t: Tracking): void {
    if (t.pendingEnd?.timer) clearTimeout(t.pendingEnd.timer);
    t.pendingEnd = null;
  }

  /** The terminal state stayed `terminalStableMs`: finalise if it still holds and Moonraker agrees, else wait more. */
  private settleEnd(printerId: number, t: Tracking): void {
    try {
      if (this.tracking.get(printerId) !== t || !t.pendingEnd) return;
      t.pendingEnd.timer = null;
      const s = this.d.manager.status(printerId);
      if (!s.online) return this.scheduleEndCheck(printerId, t); // keep waiting while offline
      const end = this.endOf(s, t);
      const ours = t.expectName === null || s.fileName === null || s.fileName === t.expectName;
      if (!end || (isActiveState(s.state) && ours)) return this.clearPendingEnd(t);
      // Another file running (replaced on the printer): Klipper reports *that* job as printing, which never
      // "agrees" with an end; waiting for it kept the old owner in control of the new job for up to 10 min.
      const replaced = isActiveState(s.state) && !ours;
      const moon = !replaced && this.d.manager.hasDriver(printerId) ? (this.d.manager.driver(printerId).jobState?.() ?? null) : null;
      if (moon !== null && !MOON_AGREES[end.state].has(moon)) {
        // Klipper still says printing/paused: not over. Re-check later (gives up waiting after 10 min).
        if (Date.now() - t.pendingEnd.since < 10 * 60_000) {
          t.pendingEnd.since = Date.now() - (this.d.terminalStableMs ?? 5000) + 1000;
          return this.scheduleEndCheck(printerId, t);
        }
      }
      this.clearPendingEnd(t);
      this.finish(printerId, t, end.state, end.reason, end.progress);
    } catch (err) {
      logger.printer.warn(`printer #${printerId}: completion check failed`, err);
    }
  }

  /**
   * Heal: a print finalised as cancelled/failed whose job is evidently still running on the printer (same file,
   * elapsed time covering the time since we started it) is put back to printing and tracked again.
   */
  private heal(s: PrinterStatus): void {
    if (!s.online || !isActiveState(s.state) || !s.fileName) return;
    const row = this.d.db
      .prepare(
        `${SELECT} WHERE p.printer_id = ? AND p.state IN ('cancelled','failed') AND p.started_at IS NOT NULL AND p.ended_at > ?
         ORDER BY p.ended_at DESC LIMIT 1`,
      )
      .get(s.printerId, Date.now() - 30 * 60_000) as PrintRow | undefined;
    if (!row || basename(row.printer_path) !== s.fileName) return;
    if (row.reason && row.reason.startsWith('cancelled_by:')) return; // cancelled from PrintYard: really cancelled
    const sinceStart = (Date.now() - row.started_at!) / 1000;
    if (s.elapsedSec === null || s.elapsedSec < sinceStart - 120) return; // a new job of the same file
    this.d.db.prepare(`UPDATE prints SET state = 'printing', reason = NULL, actual_grams = NULL, ended_at = NULL WHERE id = ?`).run(row.id);
    this.tracking.set(s.printerId, {
      jobId: row.id,
      userId: row.user_id,
      expectName: s.fileName,
      startedAt: row.started_at!,
      seenActive: true,
      lastProgress: s.progress,
      cancelledBy: null,
    });
    this.d.printers.markBedCleared(s.printerId);
    logger.printer.warn(`printer #${s.printerId}: print #${row.id} is still running on the printer, restored to printing`);
    this.d.audit.log('print.restored', { userId: null, username: 'system', ip: null }, String(row.id), { printId: row.id, printerId: s.printerId, was: row.state, reason: row.reason });
    this.publishJob(row.id);
    this.d.manager.republish(s.printerId);
  }

  private finish(printerId: number, t: Tracking, state: 'done' | 'failed' | 'cancelled', reason: string | null, progress: number): void {
    this.clearPendingEnd(t);
    this.tracking.delete(printerId);
    const row = this.row(t.jobId);
    const actual = row.grams === null ? null : state === 'done' ? row.grams : Math.round(row.grams * Math.max(0, Math.min(100, progress))) / 100;
    this.finishRow(t.jobId, state, reason, actual);
    this.d.printers.markBedOccupied(printerId, t.jobId);
    logger.printer.info(`printer #${printerId}: print #${t.jobId} ${state}${reason ? ` (${reason})` : ''}`);
  }

  private finishRow(id: number, state: PrintRequestState, reason: string | null, actualGrams: number | null = null): void {
    this.d.db
      .prepare('UPDATE prints SET state = ?, reason = ?, actual_grams = ?, ended_at = ? WHERE id = ?')
      .run(state, reason, actualGrams, Date.now(), id);
    this.publishJob(id);
  }

  /**
   * Progress callback for `uploadFile`: publishes `print.upload` to the owner + admins at most every 250 ms (4/s),
   * plus the first frame and the final 100 % one (sent once the printer answered; until then at most 99 %).
   * Percent/ETA come from `UploadEstimator` (corrects for bytes still sitting in socket buffers).
   */
  private uploadReporter(printId: number, printerId: number, fileName: string, userId: number | null) {
    const minGapMs = this.d.uploadProgressMs ?? 250;
    const est = new UploadEstimator();
    let lastAt = 0;
    let sentFinal = false;
    let first = true;
    return (sentBytes: number, totalBytes: number, done: boolean): void => {
      const now = Date.now();
      const { percent, etaSec } = est.sample(sentBytes, totalBytes, done, now);
      if (sentFinal) return;
      if (!first && !done && now - lastAt < minGapMs) return;
      first = false;
      lastAt = now;
      sentFinal = done;
      const msg: PrintUploadProgress = { printId, printerId, fileName, sentBytes: done ? totalBytes : sentBytes, totalBytes, percent, etaSec };
      this.d.hub.publish(TOPICS.printUpload, msg, forUserAndAdmins(userId));
    };
  }

  /** Row → API job; `approved` rows being sent to the printer are reported as `uploading`. */
  private toJob(r: PrintRow): PrintJob {
    const job = toJob(r);
    if (job.state === 'approved' && this.uploading.has(job.id)) job.state = 'uploading';
    return job;
  }

  private publishJob(id: number): PrintJob {
    const job = this.toJob(this.row(id));
    this.d.hub.publish(TOPICS.printUpdate, job, forUserAndAdmins(job.userId));
    return job;
  }

  private row(id: number): PrintRow {
    const r = this.d.db.prepare(`${SELECT} WHERE p.id = ?`).get(id) as PrintRow | undefined;
    if (!r) throw notFound();
    return r;
  }
}

/** Sliced by PrintYard and the content is still exactly what was sliced (recorded sha256 = this sha256). */
function isTrustedContent(file: PrintableFile, sha256: string | null): boolean {
  return file.trusted === true && !!file.sha256 && !!sha256 && file.sha256 === sha256;
}

function estimateOf(g: PrintableFile['gcode']): PrintEstimate {
  const grams =
    g?.filamentGrams && g.filamentGrams.length > 0 ? g.filamentGrams.reduce((a, b) => a + Math.max(0, Number(b) || 0), 0) : null;
  const seconds = typeof g?.printSeconds === 'number' && Number.isFinite(g.printSeconds) ? g.printSeconds : null;
  return { grams: grams !== null && grams > 0 ? Math.round(grams * 100) / 100 : null, seconds };
}

function toJob(r: PrintRow): PrintJob {
  return {
    id: r.id,
    userId: r.user_id,
    username: r.username ?? '',
    printerId: r.printer_id,
    fileId: r.file_id,
    fileName: r.file_name,
    grams: r.state === 'done' || r.state === 'failed' || r.state === 'cancelled' ? (r.actual_grams ?? r.grams) : r.grams,
    seconds: r.seconds,
    costEstimate: r.cost_estimate,
    state: r.state,
    createdAt: r.created_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    ...(r.reason !== null && { reason: r.reason }),
    calibrate: r.calibrate === 1,
  };
}

const auditActor = (a: Actor) => ({ userId: a.id, username: a.username, ip: a.ip ?? null });
