import { isAbsolute, join, resolve } from 'node:path';
import type { Db } from '../../db/client.js';
import type { GcodeScan } from '../../types.js';
import { computeGcodeSummary } from '../files/gcode.js';
import { SCAN_VERSION, scanGcodeFile } from '../files/gcode-scan.js';
import type { GcodeSummaryLike } from './types.js';

/** What printing needs to know about a library file (B1 owns the `files` table and storage). */
export interface PrintableFile {
  id: number;
  ownerId: number;
  kind: string;
  visibility: 'private' | 'shared';
  name: string;
  /** Absolute path on disk. */
  path: string;
  gcode: GcodeSummaryLike | null;
  /** sha256 recorded when the file was added (null/absent: unknown). */
  sha256?: string | null;
  size?: number;
  /** Sliced by SliceDock (meta.trusted): its slicer summary may be used for limits. */
  trusted?: boolean;
}

export interface PrintFileSource {
  get(fileId: number): PrintableFile | null;
  /**
   * The usage estimate limits may rely on: the stored summary when it is server-trusted (sliced by SliceDock, or
   * computed from the moves at upload), else computed now from the file (legacy rows) and persisted. Sources
   * without it (unit-test stubs) use `file.gcode` as is.
   */
  estimate?(file: PrintableFile): Promise<GcodeSummaryLike | null>;
  /**
   * Dangerous-command scan of a G-code file: the stored `meta.gcode.scan` when it has the current rules version,
   * else scanned now and persisted. Sources without it (unit-test stubs) scan `file.path` directly.
   */
  scan?(file: PrintableFile): Promise<GcodeScan>;
}

/** The stored scan when it is current, else a fresh scan of the file on disk. */
export async function scanOf(source: PrintFileSource, file: PrintableFile): Promise<GcodeScan> {
  if (source.scan) return source.scan(file);
  const stored = file.gcode?.scan;
  return stored && stored.version === SCAN_VERSION ? stored : scanGcodeFile(file.path);
}

/** True when `g` may be used for limits as is. */
export function isTrustedEstimate(g: GcodeSummaryLike | null | undefined, trusted: boolean | undefined): boolean {
  return !!g && (g.estimateSource === 'computed' || (g.estimateSource === 'slicer' && trusted === true));
}

const PATH_COLUMNS = ['abs_path', 'storage_path', 'stored_path', 'path', 'rel_path', 'disk_path', 'stored_name', 'filename'];
const OWNER_COLUMNS = ['owner_id', 'user_id'];
const NAME_COLUMNS = ['name', 'original_name', 'display_name'];

/**
 * Reads B1's `files` table (migration 0002). Column names are detected once with PRAGMA table_info so this keeps
 * working while the schema settles; relative paths resolve against the data root. Returns null when the table or
 * the row is missing.
 */
export function sqlFileSource(db: Db, dataRoot: string): PrintFileSource {
  let cols: Set<string> | null = null;
  const columns = () => {
    if (cols && cols.size > 0) return cols;
    cols = new Set((db.prepare("SELECT name FROM pragma_table_info('files')").all() as { name: string }[]).map((r) => r.name));
    return cols;
  };
  const pick = (c: Set<string>, list: string[]) => list.find((n) => c.has(n));
  return {
    get(fileId) {
      const c = columns();
      if (c.size === 0) return null;
      const row = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as Record<string, unknown> | undefined;
      if (!row) return null;
      const pathCol = pick(c, PATH_COLUMNS);
      const ownerCol = pick(c, OWNER_COLUMNS);
      const nameCol = pick(c, NAME_COLUMNS);
      if (!pathCol || !ownerCol || !nameCol) return null;
      let path = String(row[pathCol] ?? '');
      if (!path) return null;
      if (!isAbsolute(path)) path = resolve(join(dataRoot, path));
      let meta: Record<string, unknown> = {};
      try {
        const m = typeof row.meta === 'string' ? (JSON.parse(row.meta) as unknown) : row.meta;
        if (m && typeof m === 'object') meta = m as Record<string, unknown>;
      } catch {
        /* no meta */
      }
      const gcode = (meta.gcode ?? null) as GcodeSummaryLike | null;
      return {
        sha256: typeof row.sha256 === 'string' ? row.sha256 : null,
        size: Number(row.size ?? 0),
        trusted: meta.trusted === true,
        id: Number(row.id),
        ownerId: Number(row[ownerCol]),
        kind: String(row.kind ?? ''),
        visibility: row.visibility === 'shared' ? 'shared' : 'private',
        name: String(row[nameCol]),
        path,
        gcode,
      };
    },
    async estimate(file) {
      if (isTrustedEstimate(file.gcode, file.trusted)) return file.gcode;
      if (file.kind !== 'gcode') return null;
      const computed = await computeGcodeSummary(file.path);
      try {
        db.prepare("UPDATE files SET meta = json_set(meta, '$.gcode', json(?)) WHERE id = ?").run(JSON.stringify(computed), file.id);
      } catch {
        /* keep going with the computed value */
      }
      return computed;
    },
    async scan(file) {
      const stored = file.gcode?.scan;
      if (stored && stored.version === SCAN_VERSION) return stored;
      const scan = await scanGcodeFile(file.path);
      try {
        db.prepare("UPDATE files SET meta = json_set(meta, '$.gcode.scan', json(?)) WHERE id = ? AND json_type(meta, '$.gcode') = 'object'").run(
          JSON.stringify(scan),
          file.id,
        );
      } catch {
        /* keep going with the fresh scan */
      }
      return scan;
    },
  };
}
