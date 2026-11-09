import { rm } from 'node:fs/promises';
import type { Db } from '../../db/client.js';
import { AppError, forbidden, notFound } from '../../errors.js';
import { logger } from '../../logger.js';
import type { PrinterFileInfo } from '../../printers/drivers/types.js';
import { gcodesRelativePath } from '../../printers/k2se/moonraker.js';
import type { PrinterManager } from '../../printers/manager.js';
import { assertWritable } from '../../printers/read-only.js';
import type { LibraryFile, PrinterStoredFile, PrintJob } from '../../types.js';
import type { AuditService } from '../audit/audit.service.js';
import { cleanName, hashFile, type FilesService } from '../files/files.service.js';
import type { PrinterRetentionService, ManualDeleteResult } from '../printing/printer-retention.js';
import { printerOffline, untrustedGcode, type PrintingService } from '../printing/printing.service.js';
import type { Actor } from '../printing/types.js';
import type { PrintersService } from '../printers/printers.service.js';
import type { UsersService } from '../users/users.service.js';

/** Largest printer file SliceDock downloads (import / print from the printer). */
export const MAX_PRINTER_FILE_BYTES = 200 * 1024 * 1024;
const LIST_TTL_MS = 10_000;
const THUMB_TTL_MS = 10 * 60_000;
const THUMB_MISS_TTL_MS = 60_000;
const THUMB_MAX_BYTES = 1024 * 1024;
const THUMB_CACHE_BYTES = 32 * 1024 * 1024;

/** g/cm³ by material (first one of the file); PLA when unknown. */
const DENSITY: Record<string, number> = { PLA: 1.24, PETG: 1.27, ABS: 1.04, ASA: 1.07, TPU: 1.21, PA: 1.14, PC: 1.2, HIPS: 1.04, PVA: 1.23 };

export interface PrinterFilesDeps {
  db: Db;
  manager: PrinterManager;
  printers: PrintersService;
  files: FilesService;
  printing: PrintingService;
  retention: PrinterRetentionService;
  users: UsersService;
  audit: AuditService;
  /** List cache lifetime (tests). */
  listTtlMs?: number;
}

export interface PrintFromPrinterInput {
  name: string;
  calibrate?: boolean;
  confirmBedClear?: boolean;
  allowDangerous?: boolean;
}

/** Rough grams from a filament length (1.75 mm filament). */
export function gramsFromLength(mm: number | null, material: string | undefined): number | null {
  if (mm === null || !(mm > 0)) return null;
  const density = DENSITY[(material ?? 'PLA').toUpperCase().split(/[\s-]/)[0] ?? 'PLA'] ?? DENSITY.PLA!;
  const areaMm2 = Math.PI * 0.875 * 0.875;
  return Math.round(((mm * areaMm2) / 1000) * density * 10) / 10;
}

const auditActor = (a: Actor) => ({ userId: a.id, username: a.username, ip: a.ip ?? null });

/**
 * Files → On the printer (like Creality Print's "Local files"): the printer's own G-code list (Creality WS
 * `reqGcodeFile`), thumbnails (`:80/downloads/humbnail/<n>.png`, proxied), import into the library, print an
 * existing printer file (downloaded + scanned + limits, then started in place) and manual delete.
 */
export class PrinterFilesService {
  private readonly lists = new Map<number, { at: number; files: PrinterFileInfo[] }>();
  private readonly inflight = new Map<number, Promise<PrinterFileInfo[]>>();
  private readonly thumbs = new Map<string, { at: number; png: Buffer | null }>();
  private thumbBytes = 0;

  constructor(private readonly d: PrinterFilesDeps) {}

  /** `GET /api/printers/:id/files` (cached ~10 s; `refresh` asks the printer again). */
  async list(printerId: number, refresh = false): Promise<PrinterStoredFile[]> {
    this.d.printers.get(printerId);
    const files = await this.rawList(printerId, refresh);
    const uploads = this.uploadsOf(printerId);
    const protectedNames = this.d.retention.protectedNames(printerId);
    return files
      .filter((f) => /\.gcode$/i.test(f.name))
      .map((f) => {
        const d = f.details;
        const up = uploads.get(f.path);
        const createdAt = d?.createdAt ?? null;
        return {
          name: f.name,
          path: f.path,
          size: f.size,
          createdAt,
          layerHeight: d?.layerHeight ?? null,
          filamentMm: d?.filamentMm ?? null,
          filamentGrams: gramsFromLength(d?.filamentMm ?? null, d?.materials[0]),
          estimatedSec: d?.estimatedSec ?? null,
          materials: d?.materials ?? [],
          colors: d?.colors ?? [],
          software: d?.software ?? null,
          thumbnailUrl: d?.thumbnail
            ? `/api/printers/${printerId}/files/thumbnail?name=${encodeURIComponent(f.name)}&v=${createdAt ?? f.size ?? 0}`
            : null,
          uploadedBySliceDock: !!up,
          libraryFileId: up?.fileId ?? null,
          inUse: protectedNames.has(f.name),
        };
      });
  }

  /** `GET /api/printers/:id/files/thumbnail?name=` → PNG (null = none). */
  async thumbnail(printerId: number, name: string): Promise<Buffer | null> {
    this.d.printers.get(printerId);
    const entry = await this.resolve(printerId, name);
    const thumb = entry.details?.thumbnail;
    const driver = this.d.manager.driver(printerId);
    if (!thumb || !driver.fetchFileThumbnail) return null;
    const key = `${printerId}\u0000${entry.path}\u0000${entry.size ?? ''}\u0000${entry.details?.createdAt ?? ''}`;
    const hit = this.thumbs.get(key);
    if (hit && Date.now() - hit.at < (hit.png ? THUMB_TTL_MS : THUMB_MISS_TTL_MS)) {
      // LRU: re-insert as the newest entry.
      this.thumbs.delete(key);
      this.thumbs.set(key, hit);
      return hit.png;
    }
    const png = await driver.fetchFileThumbnail(thumb, THUMB_MAX_BYTES);
    this.putThumb(key, png);
    return png;
  }

  /** `POST /api/printers/:id/files/import`: download → scan + analyse → the user's library (uploaded G-code, untrusted). */
  async importFile(actor: Actor, printerId: number, name: string): Promise<LibraryFile> {
    this.d.printers.get(printerId);
    const entry = await this.resolve(printerId, name);
    const dl = await this.download(printerId, entry);
    const file = await this.d.files.addUpload(
      { id: actor.id, username: actor.username },
      { tmpPath: dl.tmpPath, name: cleanName(entry.name) || 'printer.gcode', visibility: 'private', sha256: dl.sha256, size: dl.size },
      auditActor(actor),
    );
    this.d.audit.log('printer.file_import', auditActor(actor), entry.name, { printerId, path: entry.path, size: dl.size, fileId: file.id });
    return file;
  }

  /**
   * `POST /api/printers/:id/files/print`: same rules as printing an uploaded G-code (download + scan + limits,
   * `can_print_uploaded_gcode` for non-admins, bed cleared, approvals), then the printer's own file is started in
   * place (no re-upload). The downloaded content becomes (or reuses, by sha256) a library file for history,
   * approvals and the live view.
   */
  async print(actor: Actor, printerId: number, input: PrintFromPrinterInput): Promise<{ status: 201 | 202; job: PrintJob; fileId: number; imported: boolean }> {
    assertWritable();
    const printer = this.d.printers.get(printerId);
    if (!this.d.manager.status(printerId).online) throw printerOffline();
    const entry = await this.resolve(printerId, input.name);
    const isAdmin = actor.role === 'admin';
    const mayUpload = isAdmin || this.d.users.canPrintUploadedGcode(actor.id);
    const linked = this.uploadsOf(printerId).get(entry.path)?.fileId ?? null;
    const refuse = (): never => {
      const err = untrustedGcode();
      this.d.audit.log('print.refused', auditActor(actor), entry.name, { code: err.code, printerId: printer.id, printerFile: entry.path });
      throw err;
    };
    // Without the permission only a SliceDock upload of a readable library file can qualify (sha256 checked below).
    if (!mayUpload && linked === null) refuse();
    const dl = await this.download(printerId, entry);
    let fileId: number | null = null;
    let imported = false;
    try {
      fileId = this.reusableFile(actor, dl.sha256, linked);
      if (fileId === null && !mayUpload) refuse();
    } catch (err) {
      await rm(dl.tmpPath, { force: true });
      throw err;
    }
    if (fileId !== null) {
      await rm(dl.tmpPath, { force: true });
    } else {
      const file = await this.d.files.addUpload(
        { id: actor.id, username: actor.username },
        { tmpPath: dl.tmpPath, name: cleanName(entry.name) || 'printer.gcode', visibility: 'private', sha256: dl.sha256, size: dl.size },
        auditActor(actor),
      );
      this.d.audit.log('printer.file_import', auditActor(actor), entry.name, { printerId, path: entry.path, size: dl.size, fileId: file.id, forPrint: true });
      fileId = file.id;
      imported = true;
    }
    this.invalidate(printerId);
    const { status, job } = await this.d.printing.startPrint(actor, {
      printerId,
      fileId,
      source: 'web',
      printerFile: { path: entry.path },
      ...(input.confirmBedClear !== undefined && { confirmBedClear: input.confirmBedClear }),
      ...(input.allowDangerous !== undefined && { allowDangerous: input.allowDangerous }),
      ...(input.calibrate !== undefined && { calibrate: input.calibrate }),
    });
    return { status, job, fileId, imported };
  }

  /** `DELETE /api/printers/:id/files`: admin or `can_control_printer`; foreign files allowed (explicit action). */
  async remove(actor: Actor, printerId: number, names: string[]): Promise<ManualDeleteResult[]> {
    assertWritable();
    const printer = this.d.printers.get(printerId);
    if (actor.role !== 'admin' && !this.d.users.canControlPrinter(actor.id)) {
      throw forbidden('printers.control_forbidden', 'You are not allowed to manage files on the printer');
    }
    const results = await this.d.retention.deleteManual(printerId, names, auditActor(actor));
    this.invalidate(printerId);
    const deleted = results.filter((r) => r.result === 'deleted').length;
    logger.printer.info(`printer #${printerId} (${printer.name}): "${actor.username}" deleted ${deleted}/${names.length} file(s)`);
    return results;
  }

  invalidate(printerId: number): void {
    this.lists.delete(printerId);
  }

  // ---------------------------------------------------------------- internals

  private async rawList(printerId: number, refresh: boolean): Promise<PrinterFileInfo[]> {
    const hit = this.lists.get(printerId);
    if (!refresh && hit && Date.now() - hit.at < (this.d.listTtlMs ?? LIST_TTL_MS)) return hit.files;
    if (!this.d.manager.hasDriver(printerId) || !this.d.manager.status(printerId).online) throw printerOffline();
    const running = this.inflight.get(printerId);
    if (running) return running;
    const p = (async () => {
      const files = await this.d.manager.driver(printerId).listFiles();
      if (!files) throw new AppError(502, 'printers.files_unavailable', 'The printer did not report its file list');
      this.lists.set(printerId, { at: Date.now(), files });
      return files;
    })();
    this.inflight.set(printerId, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(printerId);
    }
  }

  /**
   * The printer's own entry for `name` (exact match in its list; asks again once when not in the cached list).
   * The path used afterwards always comes from the printer, never from the client.
   */
  private async resolve(printerId: number, name: string): Promise<PrinterFileInfo> {
    if (typeof name !== 'string' || name.length === 0 || name.length > 255 || /[/\\\x00-\x1f]/.test(name)) throw notFound();
    const find = (list: PrinterFileInfo[]) =>
      list.find((f) => f.name === name && f.path.endsWith(`/${name}`) && gcodesRelativePath(f.path) !== null && /\.gcode$/i.test(f.name));
    let entry = find(await this.rawList(printerId, false));
    if (!entry) entry = find(await this.rawList(printerId, true));
    if (!entry) throw new AppError(404, 'printers.file_not_found', 'The file is not on the printer');
    return entry;
  }

  /** Streams the printer's copy (Moonraker `server/files/gcodes/<name>`) into a library temp file + sha256. */
  private async download(printerId: number, entry: PrinterFileInfo): Promise<{ tmpPath: string; sha256: string; size: number }> {
    const cap = Math.min(MAX_PRINTER_FILE_BYTES, this.d.files.maxUploadBytes());
    const tooLarge = () => new AppError(413, 'files.too_large', `Files are limited to ${Math.floor(cap / 1024 / 1024)} MB`, { maxMb: Math.floor(cap / 1024 / 1024) });
    if (entry.size !== null && entry.size > cap) throw tooLarge();
    const rel = gcodesRelativePath(entry.path);
    if (!rel) throw notFound();
    const tmpPath = await this.d.files.tempPath('gcode');
    try {
      await this.d.manager.driver(printerId).downloadGcode(rel, tmpPath, cap);
      const { sha256, size } = await hashFile(tmpPath);
      if (entry.size !== null && size !== entry.size) {
        throw new AppError(409, 'prints.file_changed', 'The file on the printer changed while it was downloaded');
      }
      return { tmpPath, sha256, size };
    } catch (err) {
      await rm(tmpPath, { force: true });
      if (err instanceof AppError && err.code === 'printers.gcode_too_large') throw tooLarge();
      throw err;
    }
  }

  /**
   * A library file the actor may print whose content is exactly the downloaded bytes: the library file SliceDock
   * uploaded it from (if readable), else one of the actor's own G-code files with the same sha256 (trusted first).
   */
  private reusableFile(actor: Actor, sha256: string, linked: number | null): number | null {
    if (linked !== null) {
      const row = this.d.db.prepare(`SELECT id, owner_id, visibility, sha256 FROM files WHERE id = ? AND kind = 'gcode'`).get(linked) as
        | { id: number; owner_id: number; visibility: string; sha256: string | null }
        | undefined;
      if (row && row.sha256 === sha256 && (row.owner_id === actor.id || row.visibility === 'shared' || actor.role === 'admin')) return row.id;
    }
    const own = this.d.db
      .prepare(
        `SELECT id FROM files WHERE owner_id = ? AND kind = 'gcode' AND sha256 = ?
         ORDER BY CASE WHEN json_extract(meta, '$.trusted') = 1 THEN 0 ELSE 1 END, id DESC LIMIT 1`,
      )
      .get(actor.id, sha256) as { id: number } | undefined;
    return own?.id ?? null;
  }

  /** Active SliceDock uploads on the printer: printer path → library file (null when it is gone). */
  private uploadsOf(printerId: number): Map<string, { fileId: number | null }> {
    const rows = this.d.db
      .prepare(
        `SELECT u.remote_path, f.id AS file_id FROM printer_uploads u
         LEFT JOIN prints p ON p.id = u.print_id LEFT JOIN files f ON f.id = p.file_id
         WHERE u.printer_id = ? AND u.deleted_at IS NULL ORDER BY u.id`,
      )
      .all(printerId) as { remote_path: string; file_id: number | null }[];
    return new Map(rows.map((r) => [r.remote_path, { fileId: r.file_id }]));
  }

  private putThumb(key: string, png: Buffer | null): void {
    const old = this.thumbs.get(key);
    if (old?.png) this.thumbBytes -= old.png.length;
    this.thumbs.delete(key);
    this.thumbs.set(key, { at: Date.now(), png });
    if (png) this.thumbBytes += png.length;
    for (const [k, v] of this.thumbs) {
      if (this.thumbBytes <= THUMB_CACHE_BYTES && this.thumbs.size <= 500) break;
      this.thumbs.delete(k);
      if (v.png) this.thumbBytes -= v.png.length;
    }
  }
}
