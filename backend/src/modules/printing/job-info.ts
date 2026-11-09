import { logger } from '../../logger.js';
import { isActiveState } from '../../printers/k2se/protocol.js';
import { parseExcludeObject } from '../../printers/k2se/moonraker.js';
import type { PrinterManager } from '../../printers/manager.js';
import type { CurrentJobFile } from '../../printers/drivers/types.js';
import type { JobObject, LastJob, LastJobResult, PrinterState, PrinterStatus } from '../../types.js';
import type { PrintersService } from '../printers/printers.service.js';
import { mergeObjects, readObjectDefinitions, type GcodeObjectDef } from './job-objects.js';

/** Where the last job's G-code can be found again (kept server-side, never published). */
export interface LastJobSource {
  file: CurrentJobFile | null;
  library: { fileId: number; userId: number | null } | null;
}

interface StoredLastJob {
  job: LastJob;
  source: LastJobSource;
}

interface Snapshot {
  status: PrinterStatus;
  source: LastJobSource;
  printId: number | null;
}

export interface JobInfoDeps {
  manager: PrinterManager;
  printers: PrintersService;
  /** Library file + print behind the job SliceDock is tracking on the printer. */
  tracked: (printerId: number) => { fileId: number; printerFileName: string | null; userId: number | null; printId: number } | null;
  /** Local path of the current job's G-code (library file or cached printer download). */
  gcodePath: (printerId: number) => Promise<string>;
}

const ENDED: PrinterState[] = ['complete', 'aborted', 'failed', 'error', 'idle'];

/**
 * Job-level extras on `PrinterStatus`:
 * - `job.objects`: `EXCLUDE_OBJECT_DEFINE` objects of the current G-code (parsed once per job, in the background,
 *   only when Klipper reports objects) merged with Moonraker's live `exclude_object` status;
 * - `lastJob`: the job that ended on the bed, persisted (printers.last_job) until the bed is confirmed clear.
 */
export class JobInfoService {
  private readonly defs = new Map<number, { key: string; defs: GcodeObjectDef[] | null }>();
  private readonly parsing = new Set<string>();
  private readonly active = new Map<number, Snapshot>();
  private readonly lastCache = new Map<number, StoredLastJob | null>();
  /** Per printer + job: object name → byte offset when it was first seen excluded. */
  private readonly excludedAt = new Map<number, { key: string; at: Map<string, number | null> }>();
  /** Latest background parse (tests await it). */
  lastParse: Promise<unknown> | null = null;

  constructor(private readonly d: JobInfoDeps) {}

  attach(): void {
    this.d.manager.addExtender((s, printer) => this.extend(s, printer.bedClear));
    this.d.manager.onStatus((s, prev) => this.onStatus(s, prev));
  }

  /** Objects of the current job, as published (empty when none). */
  objects(printerId: number): JobObject[] {
    return this.d.manager.status(printerId).job?.objects ?? [];
  }

  lastJob(printerId: number): StoredLastJob | null {
    if (!this.lastCache.has(printerId)) {
      let v: StoredLastJob | null = null;
      try {
        const raw = this.d.printers.getLastJob(printerId);
        v = raw ? (JSON.parse(raw) as StoredLastJob) : null;
      } catch {
        v = null;
      }
      this.lastCache.set(printerId, v);
    }
    return this.lastCache.get(printerId) ?? null;
  }

  /** Bed cleared (or printer edited): forget the cached copy (the DB column was already reset). */
  forgetLastJob(printerId: number): void {
    this.lastCache.delete(printerId);
  }

  private extend(s: PrinterStatus, bedClear: boolean): Partial<PrinterStatus> {
    const out: Partial<PrinterStatus> = {};
    if (s.job) {
      const driver = this.d.manager.hasDriver(s.printerId) ? this.d.manager.driver(s.printerId) : null;
      const eo = driver?.excludeObjectStatus() ?? null;
      const live = parseExcludeObject(eo);
      const excluded = Array.isArray(eo?.excluded_objects) ? (eo.excluded_objects as unknown[]).filter((n): n is string => typeof n === 'string') : [];
      const current = typeof eo?.current_object === 'string' ? eo.current_object : null;
      const key = jobKey(s);
      const cached = this.defs.get(s.printerId);
      const defs = cached?.key === key ? cached.defs : null;
      if (live.length > 0 && cached?.key !== key) this.parseInBackground(s.printerId, key);
      let seen = this.excludedAt.get(s.printerId);
      if (seen?.key !== key) this.excludedAt.set(s.printerId, (seen = { key, at: new Map() }));
      const objects = mergeObjects(defs, live, excluded, current).map((o) => {
        const k = o.name.toUpperCase();
        if (o.excluded && !seen.at.has(k)) seen.at.set(k, s.job!.filePosition);
        return o.excluded ? { ...o, excludedAt: seen.at.get(k) ?? null } : o;
      });
      out.job = { ...s.job, objects };
    }
    this.lastCache.delete(s.printerId); // re-read: bed-cleared resets the column from another service
    const last = bedClear ? null : this.lastJob(s.printerId);
    out.lastJob = last && !s.job ? last.job : null;
    return out;
  }

  private parseInBackground(printerId: number, key: string): void {
    const id = `${printerId}|${key}`;
    if (this.parsing.has(id)) return;
    this.parsing.add(id);
    this.lastParse = (async () => {
      let defs: GcodeObjectDef[] | null = null;
      try {
        defs = await readObjectDefinitions(await this.d.gcodePath(printerId));
      } catch (err) {
        logger.printer.debug(`printer #${printerId}: object definitions unavailable (${(err as Error).message})`);
      }
      this.defs.set(printerId, { key, defs });
      this.d.manager.republish(printerId);
    })().finally(() => this.parsing.delete(id));
  }

  private onStatus(raw: PrinterStatus, _prev: PrinterStatus | null): void {
    const id = raw.printerId;
    if (!raw.online) return;
    if (isActiveState(raw.state) && raw.job) {
      const driver = this.d.manager.driver(id);
      const tracked = this.d.tracked(id);
      // The decorated status carries the merged objects (excluded flags) we want to keep at the end.
      const decorated = this.d.manager.status(id);
      this.active.set(id, {
        status: decorated,
        source: {
          file: driver.currentJobFile(),
          library: tracked && tracked.printerFileName === raw.job.fileName ? { fileId: tracked.fileId, userId: tracked.userId } : null,
        },
        // Kept while still tracked (the printing service forgets it when the job ends).
        printId: tracked?.printId ?? null,
      });
      return;
    }
    const snap = this.active.get(id);
    if (!snap || !ENDED.includes(raw.state)) return;
    this.active.delete(id);
    const last = snap.status;
    const job = last.job!;
    const result: LastJobResult =
      raw.state === 'complete' || (raw.state === 'idle' && (last.progress ?? 0) >= 99)
        ? 'done'
        : raw.state === 'failed' || raw.state === 'error'
          ? 'failed'
          : 'cancelled';
    const done = result === 'done';
    const totalLayers = raw.totalLayers ?? last.totalLayers ?? job.layerCount;
    const stored: StoredLastJob = {
      job: {
        ...job,
        filePosition: done ? (job.fileSize ?? job.filePosition) : job.filePosition,
        layer: done ? (totalLayers ?? job.layer) : (last.layer ?? job.layer),
        layerCount: job.layerCount ?? totalLayers,
        objects: job.objects.map((o) => ({ ...o, current: false })),
        endedAt: Date.now(),
        result,
        progress: done ? 100 : last.progress,
        elapsedSec: (raw.state === 'complete' ? raw.elapsedSec : null) ?? last.elapsedSec,
        totalLayers,
        printId: snap.printId,
      },
      source: snap.source,
    };
    this.d.printers.setLastJob(id, JSON.stringify(stored));
    this.lastCache.set(id, stored);
    this.defs.delete(id);
  }
}

function jobKey(s: PrinterStatus): string {
  return `${s.job?.fileName ?? ''}|${s.job?.fileSize ?? ''}`;
}
