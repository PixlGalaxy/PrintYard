import type { PipeUpdate } from '../slicing/progress.js';

/** What a slicing engine needs for one job (one plate). */
export interface EngineSliceRequest {
  /** Per-job working directory (temp files, HOME, TMPDIR, log). */
  jobDir: string;
  /** 3MF project (one plate). */
  projectFile: string;
  /** Where `plate_1.gcode` is written. */
  outDir: string;
  timeoutMs: number;
  /** Kill the engine above this resident size (bytes); 0 = no watchdog. */
  maxRssBytes: number;
  signal: AbortSignal;
  /** The engine process is running (its silent loading phase starts now). */
  onStarted?(): void;
  /** One engine progress line (`--pipe`): raw `total_percent` 0..100 and the engine's message. */
  onProgress(update: PipeUpdate): void;
}

export interface EngineSliceResult {
  gcodePath: string;
  /** Peak resident set size seen by the watchdog (bytes), when measured. */
  peakRssBytes?: number;
  warnings: string[];
}

/** Engine-agnostic interface (Creality Print CLI today; OrcaSlicer later). */
export interface SlicerEngine {
  readonly id: 'creality' | 'orca' | 'fake';
  /** Full engine version, e.g. "7.3.1.6378". */
  readonly version: string;
  /** Install root (extracted AppImage), or null for the fake engine. */
  readonly root: string | null;
  slice(req: EngineSliceRequest): Promise<EngineSliceResult>;
}

/** A slicing failure with an i18n code (`slice.*`). */
export class EngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** "7.3.1.6378" → "7.3.1" (what the 3MF version check compares). */
export function shortVersion(v: string): string {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : '7.3.1';
}
