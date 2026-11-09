import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { readdir, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '../../errors.js';
import { logger } from '../../logger.js';
import type { PrinterManager } from '../../printers/manager.js';
import type { PrintFileSource } from './files-source.js';
import type { PrintingService } from './printing.service.js';
import type { CurrentJobFile } from '../../printers/drivers/types.js';
import type { LastJobSource } from './job-info.js';

export interface LiveViewOptions {
  manager: PrinterManager;
  /** Where the last job's G-code lives (job-info service); null when the bed is clear / nothing ended. */
  lastJobSource?: (printerId: number) => LastJobSource | null;
  printing: Pick<PrintingService, 'currentLibraryFile'>;
  files: PrintFileSource;
  /** `/appdata/cache/gcode` */
  cacheDir: string;
  maxEntries?: number;
  maxBytes?: number;
  thumbnailTtlMs?: number;
}

export interface CurrentGcode {
  path: string;
  fileName: string;
  size: number;
  source: 'library' | 'printer';
}

const noJob = () => new AppError(404, 'printers.no_current_job', 'Nothing is printing right now');
const forbiddenJob = () =>
  new AppError(403, 'printers.forbidden_job', "This print comes from another user's private file; only its owner and admins can see the G-code");

export interface LiveViewer {
  id: number;
  role: 'admin' | 'user';
}

/**
 * Live view of what is printing: the current job's G-code (from SliceDock's own library when the job came from
 * here, else downloaded once from Moonraker and cached) and the printer's current preview image. Read-only.
 */
export class LiveViewService {
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly thumbs = new Map<number, { at: number; key: string; png: Buffer | null }>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(private readonly o: LiveViewOptions) {
    this.maxEntries = o.maxEntries ?? 2;
    this.maxBytes = o.maxBytes ?? 200 * 1024 * 1024;
  }

  /**
   * Access (finding #8): a job SliceDock started from a private file is visible to the print's owner, the file's
   * owner and admins only (others: 403 `printers.forbidden_job`; they still get status + thumbnail). Shared files
   * and prints started outside SliceDock (touchscreen, other slicers) are visible to every signed-in user.
   */
  async currentGcode(printerId: number, viewer: LiveViewer): Promise<CurrentGcode> {
    const status = this.o.manager.status(printerId); // 404 for unknown printers
    if (!status.online) throw new AppError(409, 'prints.printer_offline', 'The printer is offline');
    const driver = this.o.manager.driver(printerId);
    const job = driver.currentJobFile();
    if (!job) throw noJob();
    const lib = this.o.printing.currentLibraryFile(printerId);
    const library = lib && lib.printerFileName === job.fileName ? { fileId: lib.fileId, userId: lib.userId } : null;
    return this.resolve(printerId, viewer, job, library, status.online);
  }

  /**
   * `?last=1`: the G-code of the job that ended on the bed (kept until the bed is cleared). Same access rules as
   * the current job. Served from the library or the cache; downloaded again from the printer only when needed.
   */
  async lastGcode(printerId: number, viewer: LiveViewer): Promise<CurrentGcode> {
    const status = this.o.manager.status(printerId);
    const src = status.bedClear ? null : (this.o.lastJobSource?.(printerId) ?? null);
    if (!src?.file && !src?.library) throw new AppError(404, 'printers.no_last_job', 'No finished print is waiting on the bed');
    return this.resolve(printerId, viewer, src.file, src.library, status.online);
  }

  private async resolve(
    printerId: number,
    viewer: LiveViewer,
    job: CurrentJobFile | null,
    library: { fileId: number; userId: number | null } | null,
    online: boolean,
  ): Promise<CurrentGcode> {
    if (library) {
      const f = this.o.files.get(library.fileId);
      const allowed =
        viewer.role === 'admin' || viewer.id === library.userId || (!!f && (f.ownerId === viewer.id || f.visibility === 'shared'));
      // Also covers the printer-copy fallback below when the library file is gone (treated as private).
      if (!allowed) throw forbiddenJob();
      if (f && existsSync(f.path)) return { path: f.path, fileName: f.name, size: statSync(f.path).size, source: 'library' };
    }
    if (!job) throw noJob();

    if (job.size !== null && job.size > this.maxBytes) {
      throw new AppError(413, 'printers.gcode_too_large', 'The current G-code is too large to preview');
    }
    const key = createHash('sha256').update(job.uuid ?? `${job.relPath}|${job.size ?? '?'}`).digest('hex').slice(0, 32);
    const path = join(this.o.cacheDir, `${key}.gcode`);
    if (existsSync(path)) {
      const now = new Date();
      await utimes(path, now, now).catch(() => undefined); // LRU by mtime
      return { path, fileName: job.fileName, size: statSync(path).size, source: 'printer' };
    }
    if (!online) throw new AppError(409, 'prints.printer_offline', 'The printer is offline');
    const driver = this.o.manager.driver(printerId);
    let p = this.inflight.get(key);
    if (!p) {
      p = (async () => {
        mkdirSync(this.o.cacheDir, { recursive: true });
        const bytes = await driver.downloadGcode(job.relPath, path, this.maxBytes);
        logger.printer.info(`printer #${printerId}: cached current G-code ${job.fileName} (${bytes} bytes)`);
        await this.evict(path);
        return path;
      })().finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    await p;
    return { path, fileName: job.fileName, size: statSync(path).size, source: 'printer' };
  }

  /** Keeps the newest `maxEntries` cached files (by mtime); `keep` is never removed. */
  async evict(keep?: string): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(this.o.cacheDir)).filter((n) => n.endsWith('.gcode'));
    } catch {
      return;
    }
    const entries = await Promise.all(
      names.map(async (n) => {
        const full = join(this.o.cacheDir, n);
        try {
          return { full, mtime: (await stat(full)).mtimeMs };
        } catch {
          return null;
        }
      }),
    );
    const sorted = entries
      .filter((e): e is { full: string; mtime: number } => e !== null)
      .sort((a, b) => (a.full === keep ? -1 : b.full === keep ? 1 : b.mtime - a.mtime));
    for (const e of sorted.slice(this.maxEntries)) await rm(e.full, { force: true });
  }

  async currentThumbnail(printerId: number): Promise<Buffer | null> {
    const status = this.o.manager.status(printerId);
    if (!status.online) return null;
    const key = status.fileName ?? '';
    const hit = this.thumbs.get(printerId);
    if (hit && hit.key === key && Date.now() - hit.at < (this.o.thumbnailTtlMs ?? 10_000)) return hit.png;
    const png = await this.o.manager.driver(printerId).fetchThumbnail();
    this.thumbs.set(printerId, { at: Date.now(), key, png });
    return png;
  }
}
