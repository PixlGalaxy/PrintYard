import type { Db } from '../../db/client.js';
import type { SettingsService } from '../../db/settings.js';
import { AppError } from '../../errors.js';
import { logger } from '../../logger.js';
import { basename, isActiveState, safePrinterFileName } from '../../printers/k2se/protocol.js';
import type { PrinterManager } from '../../printers/manager.js';
import { isReadOnly } from '../../printers/read-only.js';
import type { AuditService } from '../audit/audit.service.js';

interface UploadRow {
  id: number;
  printer_id: number;
  remote_name: string;
  remote_path: string;
  print_id: number | null;
  uploaded_at: number;
}

export interface PrinterRetentionDeps {
  db: Db;
  settings: SettingsService;
  audit: AuditService;
  manager: PrinterManager;
}

export interface PrinterRetentionResult {
  /** Printer paths removed from the printer. */
  deleted: string[];
  /** Over the limit but kept this time (in use, pending print, delete not confirmed, error). */
  kept: { path: string; reason: string }[];
  /** Why nothing ran: `disabled`, `read_only`, `no_driver`, `no_file_list`. */
  skipped?: string;
}

const SYSTEM_ACTOR = { userId: null, username: 'system', ip: null };

/**
 * Printer-side file retention. SliceDock records every file it uploads (`printer_uploads`); after a successful
 * upload it deletes the oldest of *those* beyond `printers.retention.keep` (Creality WS `deleteprt:<path>`).
 * Never touched: files SliceDock did not upload, the file being printed/paused, and files of pending/approved/
 * printing SliceDock prints on that printer. No-op in read-only mode.
 */
export class PrinterRetentionService {
  private readonly chains = new Map<number, Promise<unknown>>();

  constructor(private readonly d: PrinterRetentionDeps) {}

  /** Records an upload. An older active upload with the same name was overwritten on the printer: mark it replaced. */
  recordUpload(printerId: number, remotePath: string, printId: number | null, size: number | null): void {
    const remoteName = basename(remotePath) ?? remotePath;
    const now = Date.now();
    this.d.db.transaction(() => {
      this.d.db
        .prepare(
          `UPDATE printer_uploads SET deleted_at = ?, delete_reason = 'replaced'
           WHERE printer_id = ? AND remote_name = ? AND deleted_at IS NULL`,
        )
        .run(now, printerId, remoteName);
      this.d.db
        .prepare(
          `INSERT INTO printer_uploads (printer_id, remote_name, remote_path, print_id, size, uploaded_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(printerId, remoteName, remotePath, printId, size, now);
    })();
  }

  /** Runs retention for one printer (serialised per printer). Never throws. */
  run(printerId: number): Promise<PrinterRetentionResult> {
    const prev = this.chains.get(printerId) ?? Promise.resolve();
    const next = prev.then(() => this.runNow(printerId)).catch((err: unknown) => {
      logger.printer.warn(`printer #${printerId}: file retention failed`, err);
      return { deleted: [], kept: [], skipped: 'error' } satisfies PrinterRetentionResult;
    });
    this.chains.set(printerId, next);
    void next.finally(() => {
      if (this.chains.get(printerId) === next) this.chains.delete(printerId);
    });
    return next;
  }

  /** Active (still on the printer, as far as SliceDock knows) uploads, newest first. */
  activeUploads(printerId: number): UploadRow[] {
    return this.d.db
      .prepare(
        `SELECT id, printer_id, remote_name, remote_path, print_id, uploaded_at FROM printer_uploads
         WHERE printer_id = ? AND deleted_at IS NULL ORDER BY uploaded_at DESC, id DESC`,
      )
      .all(printerId) as UploadRow[];
  }

  private async runNow(printerId: number): Promise<PrinterRetentionResult> {
    const result: PrinterRetentionResult = { deleted: [], kept: [] };
    if (!this.d.settings.get('printers.retention.enabled')) return { ...result, skipped: 'disabled' };
    const keep = this.d.settings.get('printers.retention.keep');
    const excess = this.activeUploads(printerId).slice(keep).reverse(); // oldest first
    if (excess.length === 0) return result;
    if (isReadOnly()) {
      logger.printer.info(`printer #${printerId}: read-only mode, file retention skipped (${excess.length} over the limit)`);
      return { ...result, skipped: 'read_only' };
    }
    if (!this.d.manager.hasDriver(printerId)) return { ...result, skipped: 'no_driver' };
    const driver = this.d.manager.driver(printerId);
    const list = await driver.listFiles();
    if (!list) return { ...result, skipped: 'no_file_list' };
    const onPrinter = new Set(list.map((f) => f.path));
    const protectedNames = this.protectedNames(printerId);

    for (const row of excess) {
      if (protectedNames.has(row.remote_name)) {
        result.kept.push({ path: row.remote_path, reason: 'in_use' });
        continue;
      }
      if (!onPrinter.has(row.remote_path)) {
        // Already gone (deleted on the touchscreen or by Creality Print): just forget it.
        this.markDeleted(row.id, 'missing');
        continue;
      }
      try {
        const gone = await driver.deleteFile(row.remote_path);
        if (!gone) {
          result.kept.push({ path: row.remote_path, reason: 'not_confirmed' });
          continue;
        }
        this.markDeleted(row.id, 'retention');
        result.deleted.push(row.remote_path);
        this.d.audit.log('printer.file_retention', SYSTEM_ACTOR, row.remote_name, {
          printerId,
          path: row.remote_path,
          printId: row.print_id,
          keep,
        });
      } catch (err) {
        const code = err instanceof AppError ? err.code : 'error';
        result.kept.push({ path: row.remote_path, reason: code });
        logger.printer.warn(`printer #${printerId}: could not delete ${row.remote_path} (${code})`);
        if (code === 'printers.read_only' || code === 'prints.printer_offline') break;
      }
    }
    if (result.deleted.length > 0) logger.printer.info(`printer #${printerId}: retention removed ${result.deleted.length} file(s)`);
    return result;
  }

  /** Printer-side names that must stay: the active job's file and files of open SliceDock prints. */
  private protectedNames(printerId: number): Set<string> {
    const names = new Set<string>();
    const status = this.d.manager.status(printerId);
    if (isActiveState(status.state)) {
      if (status.fileName) names.add(status.fileName);
      const current = this.d.manager.driver(printerId).currentJobFile();
      if (current) names.add(current.fileName);
    }
    const open = this.d.db
      .prepare(`SELECT file_name, printer_path FROM prints WHERE printer_id = ? AND state IN ('pending','approved','printing')`)
      .all(printerId) as { file_name: string; printer_path: string | null }[];
    for (const p of open) {
      const n = basename(p.printer_path);
      if (n) names.add(n);
      names.add(safePrinterFileName(p.file_name));
    }
    return names;
  }

  private markDeleted(id: number, reason: string): void {
    this.d.db.prepare('UPDATE printer_uploads SET deleted_at = ?, delete_reason = ? WHERE id = ?').run(Date.now(), reason, id);
  }
}
