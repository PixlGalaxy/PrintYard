/**
 * Slice progress: turns the engine's `--pipe` lines into a smooth, monotonic 0–100 with a stable stage id.
 *
 * What Creality Print 7.3.1 actually writes to the pipe (captured, see test/fixtures/engine-pipe-heavy.jsonl):
 * one JSON object per line, `{message, plate_count, plate_index, plate_percent, total_percent}` (or `warning`
 * instead of `message`), sometimes two lines in one write. Cadence on a 2M-triangle sphere with tree supports
 * (12.2 s total): "Start to load files" 1 % at 0.1 s, then **nothing for 10 s** while the 3MF mesh is parsed,
 * "Prepare slicing" 3 %, then every slicing stage (7 → 75 %) within ~1 s, "Generating G-code" 75 % followed by
 * ~0.8 s of silent export, "Slicing finished" 93 %, "All done" 100 %. The raw numbers therefore sit at 1 % for most
 * of the job and then jump; the bands and time-based creep below fill the silent phases.
 */

export type SliceStage =
  | 'queued'
  | 'building' // SliceDock writes the 3MF
  | 'loading' // engine loads the project and presets (silent)
  | 'slicing' // mesh slicing
  | 'walls'
  | 'infill'
  | 'supports'
  | 'toolpath' // overhang detection, toolpath optimisation
  | 'gcode' // G-code generation + export (partly silent)
  | 'thumbnails' // SliceDock post-processing
  | 'saving'
  | 'done';

export interface PipeUpdate {
  totalPercent: number;
  platePercent: number | null;
  message?: string;
  warning?: string;
}

/** One pipe line → update, or null for anything that is not an engine progress object. */
export function parsePipeLine(line: string): PipeUpdate | null {
  const s = line.trim();
  if (!s.startsWith('{')) return null;
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    if (typeof o.total_percent !== 'number' || !Number.isFinite(o.total_percent)) return null;
    const u: PipeUpdate = {
      totalPercent: Math.max(0, Math.min(100, o.total_percent)),
      platePercent: typeof o.plate_percent === 'number' ? o.plate_percent : null,
    };
    if (typeof o.message === 'string' && o.message) u.message = o.message.slice(0, 200);
    if (typeof o.warning === 'string' && o.warning) u.warning = o.warning.slice(0, 500);
    return u;
  } catch {
    return null;
  }
}

/** Engine message → stage. */
export function stageFromMessage(message: string, totalPercent: number): SliceStage {
  const m = message.toLowerCase();
  if (/load files|prepare slicing/.test(m)) return 'loading';
  if (/support/.test(m)) return 'supports';
  if (/wall|perimeter/.test(m)) return 'walls';
  if (/infill/.test(m)) return 'infill';
  if (/overhang|toolpath|optimi[sz]/.test(m)) return 'toolpath';
  if (/g-?code|export/.test(m)) return 'gcode';
  if (/finished|all done/.test(m)) return 'gcode';
  if (/slicing|mesh/.test(m)) return 'slicing';
  return totalPercent < 4 ? 'loading' : totalPercent >= 75 ? 'gcode' : 'slicing';
}

/** Overall bands. Engine percentages 3 → 75 map linearly onto "slicing"; 75 → 100 onto "gcode". */
export const BANDS = {
  building: [0, 5],
  loading: [5, 35],
  engine: [35, 85],
  gcode: [85, 93],
  postprocessing: [94, 99],
} as const;

const ENGINE_START = 3;
const ENGINE_GCODE = 75;

export interface ProgressSnapshot {
  progress: number;
  stage: SliceStage;
  message?: string;
}

/**
 * Time-aware progress for one job. Call `engine()` for each pipe update and `tick()` periodically; while the
 * engine is silent, progress creeps toward the end of the current band (never past it), using an expected duration
 * estimated from the triangle count.
 */
export class ProgressModel {
  private value = 0;
  private stage: SliceStage = 'building';
  private message: string | undefined;
  /** Band the creep may move inside, and when/where it started. */
  private band: readonly [number, number] = BANDS.building;
  private bandStartValue = 0;
  private bandStartAt: number;
  private expectedMs = 1000;

  constructor(
    private triangles: number,
    now = Date.now(),
  ) {
    this.bandStartAt = now;
  }

  /** Expected engine load time: ~0.8 s + 4.5 s per million triangles (measured on the 7.3.1 AppImage). */
  static expectedLoadMs(triangles: number): number {
    return 800 + triangles * 0.0045;
  }

  /** Expected G-code export time after "Generating G-code": ~0.4 s + 0.2 s per million triangles. */
  static expectedExportMs(triangles: number): number {
    return 400 + triangles * 0.0002;
  }

  private enter(band: readonly [number, number], expectedMs: number, now: number, floor?: number): void {
    this.band = band;
    this.expectedMs = Math.max(200, expectedMs);
    this.value = Math.max(this.value, floor ?? band[0]);
    this.bandStartValue = this.value;
    this.bandStartAt = now;
  }

  /** Known once the project is built (drives the expected load/export durations). */
  setTriangles(n: number): void {
    this.triangles = Math.max(0, n);
  }

  /** Expected 3MF build time from the source model bytes (~0.3 s per MB: mesh parse + XML write; measured). */
  static expectedBuildMs(sourceBytes: number): number {
    return 300 + sourceBytes * 0.0003;
  }

  building(now = Date.now(), message = 'Building the project', sourceBytes = 0): void {
    this.stage = 'building';
    this.message = message;
    this.enter(BANDS.building, ProgressModel.expectedBuildMs(sourceBytes), now);
  }

  /** The engine process was started. */
  engineStarted(now = Date.now()): void {
    this.stage = 'loading';
    this.message = 'Loading the project';
    this.enter(BANDS.loading, ProgressModel.expectedLoadMs(this.triangles), now);
  }

  engine(u: PipeUpdate, now = Date.now()): void {
    if (u.message) this.message = u.message;
    const t = u.totalPercent;
    if (t < ENGINE_START) {
      // still loading: keep creeping inside the loading band
      if (this.stage !== 'loading') this.engineStarted(now);
      if (u.message) this.message = u.message;
      return;
    }
    if (u.message) this.stage = stageFromMessage(u.message, t);
    if (t < ENGINE_GCODE) {
      const [a, b] = BANDS.engine;
      const v = a + ((t - ENGINE_START) / (ENGINE_GCODE - ENGINE_START)) * (b - a);
      // Creep toward the next ~10 engine points while the stage runs.
      const next = Math.min(b, v + 8);
      this.enter([a, next], 1500, now, v);
      if (!u.message) this.stage = stageFromMessage('', t);
      return;
    }
    const [a, b] = BANDS.gcode;
    const v = a + ((Math.min(t, 100) - ENGINE_GCODE) / (100 - ENGINE_GCODE)) * (b - a);
    this.stage = 'gcode';
    this.enter([a, b], ProgressModel.expectedExportMs(this.triangles), now, v);
  }

  postprocessing(stage: 'thumbnails' | 'saving', message: string, now = Date.now()): void {
    this.stage = stage;
    this.message = message;
    const [a, b] = BANDS.postprocessing;
    this.enter(stage === 'thumbnails' ? [a, b - 2] : [b - 2, b], 500, now);
  }

  done(): void {
    this.stage = 'done';
    this.value = 100;
  }

  /** Current value with creep applied (monotonic, never beyond the current band's end minus a margin). */
  tick(now = Date.now()): ProgressSnapshot {
    if (this.stage !== 'done') {
      const [, end] = this.band;
      const span = Math.max(0, end - 0.5 - this.bandStartValue);
      // ~90 % of the band after the expected time, asymptotic afterwards.
      const f = 1 - Math.exp((-2.3 * Math.max(0, now - this.bandStartAt)) / this.expectedMs);
      this.value = Math.max(this.value, Math.min(end - 0.5, this.bandStartValue + span * f));
    }
    return { progress: Math.floor(this.value), stage: this.stage, ...(this.message && { message: this.message }) };
  }
}
