import type { Db } from '../../db/client.js';
import type { SettingsService } from '../../db/settings.js';
import { AppError } from '../../errors.js';
import { logger } from '../../logger.js';
import { basename, isActiveState, printerUploadName, safePrinterFileName } from '../../printers/k2se/protocol.js';
import type { PrinterManager } from '../../printers/manager.js';
import { isReadOnly } from '../../printers/read-only.js';
import type { AuditService } from '../audit/audit.service.js';

interface UploadRow {
  id: number;
  printer_id: number;
  remote_name: string;
  remote_path: string;
  print_id: number | null;
  size: number | null;
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

/** A printer-side copy PrintYard uploaded for a library file (one `printer_uploads` row). */
export interface PrinterCopy {
  uploadId: number;
  printerId: number;
  printerName: string;
  /** File name on the printer. */
  name: string;
  path: string;
  printId: number | null;
}

/**
 * Outcome per copy: `deleted`; `missing` (already gone, record dropped); skipped: `in_use` (printing/paused/open
 * print), `unverified` (name/size/upload id do not match what PrintYard recorded), `offline` (printer not connected:
 * not queued, the record stays and printer retention removes it later), `read_only`, `not_confirmed`, or an error code.
 */
export interface PrinterCopyResult extends PrinterCopy {
  result: 'deleted' | 'missing' | 'skipped';
  reason?: string;
}

/** Files → On the printer delete outcome per name (`skipped` reasons: in_use, offline, read_only, not_confirmed, error code). */
export interface ManualDeleteResult {
  name: string;
  result: 'deleted' | 'missing' | 'skipped';
  reason?: string;
}

/**
 * Printer-side file retention. PrintYard records every file it uploads (`printer_uploads`); after a successful
 * upload it deletes the oldest of *those* beyond `printers.retention.keep` (Creality WS `deleteprt:<path>`).
 * Never touched: files PrintYard did not upload, the file being printed/paused, and files of pending/approved/
 * printing PrintYard prints on that printer. No-op in read-only mode.
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
    return this.serial(printerId, () => this.runNow(printerId), (err) => {
      logger.printer.warn(`printer #${printerId}: file retention failed`, err);
      return { deleted: [], kept: [], skipped: 'error' } satisfies PrinterRetentionResult;
    });
  }

  private serial<T>(printerId: number, fn: () => Promise<T>, onError: (err: unknown) => T): Promise<T> {
    const prev = this.chains.get(printerId) ?? Promise.resolve();
    const next = prev.then(fn).catch(onError);
    this.chains.set(printerId, next);
    void next.finally(() => {
      if (this.chains.get(printerId) === next) this.chains.delete(printerId);
    });
    return next;
  }

  /** Printer copies PrintYard uploaded for these library files (still on the printer as far as it knows). */
  copiesOfFiles(fileIds: number[]): Map<number, PrinterCopy[]> {
    const out = new Map<number, PrinterCopy[]>();
    const stmt = this.d.db.prepare(
      `SELECT u.id, u.printer_id, u.remote_name, u.remote_path, u.print_id, COALESCE(pr.name, 'Printer') AS printer_name
       FROM printer_uploads u JOIN prints p ON p.id = u.print_id LEFT JOIN printers pr ON pr.id = u.printer_id
       WHERE p.file_id = ? AND u.deleted_at IS NULL ORDER BY u.id`,
    );
    for (const id of fileIds) {
      const rows = stmt.all(id) as { id: number; printer_id: number; remote_name: string; remote_path: string; print_id: number | null; printer_name: string }[];
      out.set(
        id,
        rows.map((r) => ({ uploadId: r.id, printerId: r.printer_id, printerName: r.printer_name, name: r.remote_name, path: r.remote_path, printId: r.print_id })),
      );
    }
    return out;
  }

  /**
   * Deletes printer copies of deleted library files with the same verified path as retention (exact name + size +
   * upload id, never the active/open job's file). Serialised per printer with retention. Never throws.
   */
  async deleteCopies(copies: PrinterCopy[], actor: { userId: number | null; username: string; ip: string | null }): Promise<PrinterCopyResult[]> {
    const byPrinter = new Map<number, PrinterCopy[]>();
    for (const c of copies) byPrinter.set(c.printerId, [...(byPrinter.get(c.printerId) ?? []), c]);
    const results = await Promise.all(
      [...byPrinter].map(([printerId, list]) =>
        this.serial(
          printerId,
          () => this.deleteCopiesNow(printerId, list, actor),
          (err) => {
            logger.printer.warn(`printer #${printerId}: deleting library copies failed`, err);
            return list.map((c) => ({ ...c, result: 'skipped' as const, reason: 'error' }));
          },
        ),
      ),
    );
    return results.flat();
  }

  private async deleteCopiesNow(
    printerId: number,
    list: PrinterCopy[],
    actor: { userId: number | null; username: string; ip: string | null },
  ): Promise<PrinterCopyResult[]> {
    const skip = (reason: string) => list.map((c) => ({ ...c, result: 'skipped' as const, reason }));
    if (isReadOnly()) return skip('read_only');
    if (!this.d.manager.hasDriver(printerId) || !this.d.manager.status(printerId).online) return skip('offline');
    const driver = this.d.manager.driver(printerId);
    const files = await driver.listFiles();
    if (!files) return skip('offline');
    const onPrinter = new Map(files.map((f) => [f.path, f]));
    const protectedNames = this.protectedNames(printerId);
    const rows = new Map(this.activeUploads(printerId).map((r) => [r.id, r]));
    const out: PrinterCopyResult[] = [];
    for (const c of list) {
      const row = rows.get(c.uploadId);
      if (!row) {
        out.push({ ...c, result: 'missing' });
        continue;
      }
      const r = await this.verifiedDelete(printerId, driver, row, onPrinter, protectedNames, 'library_delete');
      if (r.ok) {
        this.d.audit.log('printer.file_delete', actor, row.remote_name, { printerId, path: row.remote_path, printId: row.print_id, viaLibrary: true });
        out.push({ ...c, result: 'deleted' });
      } else if (r.reason === 'missing') out.push({ ...c, result: 'missing' });
      else out.push({ ...c, result: 'skipped', reason: r.reason });
    }
    return out;
  }

  /**
   * Files → On the printer → Delete (an explicit user action, so files PrintYard did not upload are allowed too).
   * Each name must be in the printer's own fresh list (its path comes from there, never from the client); never
   * the printing/paused file or a file of a pending/approved/printing print. Serialised with retention per printer.
   * Matching `printer_uploads` rows are marked deleted. Never throws for a single file (per-name result).
   */
  async deleteManual(
    printerId: number,
    names: string[],
    actor: { userId: number | null; username: string; ip: string | null },
  ): Promise<ManualDeleteResult[]> {
    return this.serial(
      printerId,
      () => this.deleteManualNow(printerId, names, actor),
      (err) => {
        logger.printer.warn(`printer #${printerId}: deleting printer files failed`, err);
        return names.map((name) => ({ name, result: 'skipped' as const, reason: 'error' }));
      },
    );
  }

  private async deleteManualNow(
    printerId: number,
    names: string[],
    actor: { userId: number | null; username: string; ip: string | null },
  ): Promise<ManualDeleteResult[]> {
    const skip = (reason: string) => names.map((name) => ({ name, result: 'skipped' as const, reason }));
    if (isReadOnly()) return skip('read_only');
    if (!this.d.manager.hasDriver(printerId) || !this.d.manager.status(printerId).online) return skip('offline');
    const driver = this.d.manager.driver(printerId);
    const list = await driver.listFiles();
    if (!list) return skip('offline');
    const byName = new Map(list.map((f) => [f.name, f]));
    const protectedNames = this.protectedNames(printerId);
    const uploads = this.activeUploads(printerId);
    const out: ManualDeleteResult[] = [];
    for (const name of [...new Set(names)]) {
      const entry = byName.get(name);
      if (!entry) {
        out.push({ name, result: 'missing' });
        continue;
      }
      if (protectedNames.has(name)) {
        out.push({ name, result: 'skipped', reason: 'in_use' });
        continue;
      }
      const upload = uploads.find((u) => u.remote_path === entry.path);
      try {
        const gone = await driver.deleteFile(entry.path);
        if (!gone) {
          out.push({ name, result: 'skipped', reason: 'not_confirmed' });
          continue;
        }
        if (upload) this.markDeleted(upload.id, 'manual');
        this.d.audit.log('printer.file_delete', actor, name, {
          printerId,
          path: entry.path,
          size: entry.size,
          manual: true,
          uploadedByPrintYard: !!upload,
          printId: upload?.print_id ?? null,
        });
        out.push({ name, result: 'deleted' });
      } catch (err) {
        const code = err instanceof AppError ? err.code : 'error';
        logger.printer.warn(`printer #${printerId}: could not delete ${entry.path} (${code})`);
        out.push({ name, result: 'skipped', reason: code === 'printers.file_in_use' ? 'in_use' : code });
      }
    }
    return out;
  }

  /**
   * The one delete path for printer files: never a protected name (active job / open prints), never a file whose
   * name, size or upload id differ from PrintYard's record; confirmed by the printer's file list.
   */
  private async verifiedDelete(
    printerId: number,
    driver: ReturnType<PrinterManager['driver']>,
    row: UploadRow,
    onPrinter: Map<string, { name: string; size: number | null }>,
    protectedNames: Set<string>,
    reason: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (protectedNames.has(row.remote_name)) return { ok: false, reason: 'in_use' };
    const entry = onPrinter.get(row.remote_path);
    if (!entry) {
      // Already gone (deleted on the touchscreen or by Creality Print): just forget it.
      this.markDeleted(row.id, 'missing');
      return { ok: false, reason: 'missing' };
    }
    // Only the exact file PrintYard uploaded: same name, the recorded size, and (for print uploads) the print id
    // in the name. Anything else (overwritten on the touchscreen, legacy record without a size) is left alone.
    const idOk = row.print_id === null || row.remote_name.includes(`_p${row.print_id}`);
    if (entry.name !== row.remote_name || row.size === null || entry.size !== row.size || !idOk) {
      logger.printer.info(`printer #${printerId}: not deleting ${row.remote_path} (recorded ${row.size ?? '?'} bytes, printer lists ${entry.size ?? '?'})`);
      return { ok: false, reason: 'unverified' };
    }
    try {
      const gone = await driver.deleteFile(row.remote_path);
      if (!gone) return { ok: false, reason: 'not_confirmed' };
      this.markDeleted(row.id, reason);
      return { ok: true };
    } catch (err) {
      const code = err instanceof AppError ? err.code : 'error';
      logger.printer.warn(`printer #${printerId}: could not delete ${row.remote_path} (${code})`);
      return { ok: false, reason: code };
    }
  }

  /** Active (still on the printer, as far as PrintYard knows) uploads, newest first. */
  activeUploads(printerId: number): UploadRow[] {
    return this.d.db
      .prepare(
        `SELECT id, printer_id, remote_name, remote_path, print_id, size, uploaded_at FROM printer_uploads
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
    const onPrinter = new Map(list.map((f) => [f.path, f]));
    const protectedNames = this.protectedNames(printerId);

    for (const row of excess) {
      const r = await this.verifiedDelete(printerId, driver, row, onPrinter, protectedNames, 'retention');
      if (r.ok) {
        result.deleted.push(row.remote_path);
        this.d.audit.log('printer.file_retention', SYSTEM_ACTOR, row.remote_name, { printerId, path: row.remote_path, printId: row.print_id, keep });
        continue;
      }
      if (r.reason === 'missing') continue;
      result.kept.push({ path: row.remote_path, reason: r.reason });
      if (r.reason === 'printers.read_only' || r.reason === 'prints.printer_offline') break;
    }
    if (result.deleted.length > 0) logger.printer.info(`printer #${printerId}: retention removed ${result.deleted.length} file(s)`);
    return result;
  }

  /** Printer-side names that must stay: the active job's file and files of open PrintYard prints. */
  protectedNames(printerId: number): Set<string> {
    const names = new Set<string>();
    const status = this.d.manager.status(printerId);
    if (isActiveState(status.state)) {
      if (status.fileName) names.add(status.fileName);
      const current = this.d.manager.driver(printerId).currentJobFile();
      if (current) names.add(current.fileName);
    }
    const open = this.d.db
      .prepare(`SELECT id, file_name, printer_path, printer_file FROM prints WHERE printer_id = ? AND state IN ('pending','approved','printing')`)
      .all(printerId) as { id: number; file_name: string; printer_path: string | null; printer_file: string | null }[];
    for (const p of open) {
      const n = basename(p.printer_path);
      if (n) names.add(n);
      const existing = basename(p.printer_file);
      if (existing) names.add(existing);
      names.add(safePrinterFileName(p.file_name));
      names.add(printerUploadName(p.file_name, p.id));
    }
    return names;
  }

  private markDeleted(id: number, reason: string): void {
    this.d.db.prepare('UPDATE printer_uploads SET deleted_at = ?, delete_reason = ? WHERE id = ?').run(Date.now(), reason, id);
  }
}
