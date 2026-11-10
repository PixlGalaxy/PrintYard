/**
 * Slice progress: turns the engine's `--pipe` lines into a smooth, monotonic 0–100 with a stable stage id.
 *
 * What Creality Print 7.3.1 actually writes to the pipe (captured, see test/fixtures/engine-pipe-heavy.jsonl):
 * one JSON object per line, `{message, plate_count, plate_index, plate_percent, total_percent}` (or `warning`
 * instead of `message`), sometimes two lines in one write. Cadence on a 2M-triangle sphere with tree supports
 * (12.2 s total): "Start to load files" 1 % at 0.1 s, then **nothing for 10 s** while the 3MF mesh is parsed,
 * "Prepare slicing" 3 %, then every slicing stage (7 → 75 %) within ~1 s, "Generating G-code" 75 % followed by
 * ~0.8 s of silent export, "Slicing finished" 93 %, "All done" 100 %. The raw numbers therefore sit at 1 % for most
 * of the job and then jump; the proportional bands and time-based creep below fill the silent phases.
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

/**
 * Overall layout. The engine part (build → load → slicing stages → G-code export) shares 0–93 in proportion to each
 * phase's expected duration (measured on the 7.3.1 AppImage), so the bar moves at roughly constant speed: on a
 * 2M-triangle job loading gets ~5–74 because it is ~85 % of the wall time, and the burst of stages that follows in
 * ~1 s fills the rest. Post-processing (thumbnails, scan, save) is 94–99, done is 100.
 */
export const ENGINE_END = 93;
export const POST_BAND = [94, 99] as const;

export type Phase = 'build' | 'load' | 'stages' | 'export';
const PHASES: Phase[] = ['build', 'load', 'stages', 'export'];
/** Smallest share (points) a phase gets, so a short phase still visibly moves. */
const MIN_WIDTH: Record<Phase, number> = { build: 2, load: 6, stages: 5, export: 3 };
/** Share of the later phases' minimum widths a slow phase may borrow while it overruns its estimate. */
const BORROW = 0.4;

const ENGINE_START = 3;
const ENGINE_GCODE = 75;

/** Ease-out shape inside the nominal band: 90 % of it at the expected time, slope never zero. */
const EASE_K = 1.5;
const EASE_AT_EXPECTED = 0.9;
const EASE_NORM = 1 - Math.exp(-EASE_K);
/** Slope at the expected time, as a fraction of the band per expected duration (continuous into the tail). */
const EASE_END_SLOPE = (EASE_AT_EXPECTED * EASE_K * Math.exp(-EASE_K)) / EASE_NORM;

export interface ProgressSnapshot {
  /** 0–100 with one decimal (the bar width moves smoothly; labels round it). */
  progress: number;
  stage: SliceStage;
  message?: string;
}

export interface ProgressOptions {
  /** Supports enabled (`enable_support`): the slicing stages take ~1.5× longer. */
  supports?: boolean;
}

/** Expected durations (ms) of each phase. */
export function expectedDurations(triangles: number, sourceBytes: number, supports = false): Record<Phase, number> {
  return {
    build: ProgressModel.expectedBuildMs(sourceBytes),
    load: ProgressModel.expectedLoadMs(triangles),
    stages: ProgressModel.expectedStagesMs(triangles, supports),
    export: ProgressModel.expectedExportMs(triangles),
  };
}

/** Splits [from, ENGINE_END] over `phases` in proportion to their expected durations (each ≥ its minimum width). */
export function planBands(phases: Phase[], durations: Record<Phase, number>, from: number): Partial<Record<Phase, [number, number]>> {
  const span = Math.max(0, ENGINE_END - from);
  const mins = phases.reduce((n, p) => n + MIN_WIDTH[p], 0);
  const scale = mins > span ? span / mins : 1;
  const extra = Math.max(0, span - mins * scale);
  const total = phases.reduce((n, p) => n + Math.max(1, durations[p]), 0);
  const out: Partial<Record<Phase, [number, number]>> = {};
  let at = from;
  for (const p of phases) {
    const w = MIN_WIDTH[p] * scale + (extra * Math.max(1, durations[p])) / total;
    out[p] = [at, Math.min(ENGINE_END, at + w)];
    at += w;
  }
  return out;
}

/**
 * Time-aware progress for one job. Call `engine()` for each pipe update and `tick()` periodically. While the engine
 * is silent, progress eases out toward the end of the current phase's band (~90 % at the expected duration) and then
 * keeps creeping slowly into a soft cap (borrowing from later phases, which are re-planned from wherever the bar is
 * when they start) instead of freezing. Always monotonic.
 */
export class ProgressModel {
  private value = 0;
  private stage: SliceStage = 'building';
  private message: string | undefined;
  private phase: Phase | 'post' | null = null;
  private sourceBytes = 0;
  private readonly supports: boolean;
  /** Nominal band end, soft cap, and where/when the current creep started. */
  private bandEnd = 0;
  private cap = 0;
  private startValue = 0;
  private startAt: number;
  private expectedMs = 1000;
  private stagesBand: [number, number] | null = null;
  private exportBand: [number, number] | null = null;

  constructor(
    private triangles: number,
    now = Date.now(),
    opts: ProgressOptions = {},
  ) {
    this.startAt = now;
    this.supports = opts.supports ?? false;
  }

  /** Expected engine load time: ~0.8 s + 4.5 s per million triangles (measured on the 7.3.1 AppImage). */
  static expectedLoadMs(triangles: number): number {
    return 800 + triangles * 0.0045;
  }

  /** Expected slicing stages (3 → 75 %): ~0.15 s + 0.25 s per million triangles, ×1.5 with supports (measured). */
  static expectedStagesMs(triangles: number, supports = false): number {
    return (150 + triangles * 0.00025) * (supports ? 1.5 : 1);
  }

  /** Expected G-code export time after "Generating G-code": ~0.4 s + 0.2 s per million triangles. */
  static expectedExportMs(triangles: number): number {
    return 400 + triangles * 0.0002;
  }

  /** Expected 3MF build time from the source model bytes (~0.3 s per MB: mesh parse + XML write; measured). */
  static expectedBuildMs(sourceBytes: number): number {
    return 300 + sourceBytes * 0.0003;
  }

  /** Triangle guess before the build reports the real count (binary STL ≈ 50 bytes per triangle). */
  private trianglesOrGuess(): number {
    return this.triangles > 0 ? this.triangles : this.sourceBytes / 50;
  }

  private durations(): Record<Phase, number> {
    return expectedDurations(this.trianglesOrGuess(), this.sourceBytes, this.supports);
  }

  /** Soft cap for phase `p`: the end of the engine range minus most of the later phases' minimum widths. */
  private static capFor(p: Phase): number {
    const later = PHASES.slice(PHASES.indexOf(p) + 1);
    return ENGINE_END - later.reduce((n, q) => n + MIN_WIDTH[q] * (1 - BORROW), 0);
  }

  /** Starts phase `p`: re-plans `p` and the later phases from the current value. */
  private startPhase(p: Phase, now: number): [number, number] {
    const rest = PHASES.slice(PHASES.indexOf(p));
    const plan = planBands(rest, this.durations(), p === 'build' ? 0 : this.value);
    const band = plan[p]!;
    this.phase = p;
    this.creep(band[1], ProgressModel.capFor(p), this.durations()[p], now);
    if (p === 'stages') this.stagesBand = band;
    if (p === 'export') this.exportBand = band;
    return band;
  }

  private creep(bandEnd: number, cap: number, expectedMs: number, now: number, floor = 0): void {
    this.value = Math.max(this.value, Math.min(floor, bandEnd));
    this.startValue = this.value;
    this.bandEnd = Math.max(this.value, bandEnd);
    this.cap = Math.max(this.bandEnd, cap);
    this.expectedMs = Math.max(200, expectedMs);
    this.startAt = now;
  }

  /** Known once the project is built (drives the expected load/stage/export durations). */
  setTriangles(n: number): void {
    this.triangles = Math.max(0, n);
  }

  building(now = Date.now(), message = 'Building the project', sourceBytes = 0): void {
    this.stage = 'building';
    this.message = message;
    this.sourceBytes = Math.max(0, sourceBytes);
    this.startPhase('build', now);
  }

  /** The engine process was started (idempotent: a second call does not restart the loading creep). */
  engineStarted(now = Date.now()): void {
    if (this.phase === 'load') return;
    this.tick(now);
    this.stage = 'loading';
    this.message = 'Loading the project';
    this.startPhase('load', now);
  }

  engine(u: PipeUpdate, now = Date.now()): void {
    const t = u.totalPercent;
    if (t < ENGINE_START) {
      // still loading: keep creeping inside the loading band
      if (this.phase !== 'load') this.engineStarted(now);
      if (u.message) this.message = u.message;
      return;
    }
    if (u.message) this.message = u.message;
    this.tick(now); // bank the creep so far before re-anchoring
    if (t < ENGINE_GCODE) {
      this.stage = stageFromMessage(u.message ?? '', t);
      if (this.phase !== 'stages') this.startPhase('stages', now);
      const [a, b] = this.stagesBand!;
      const v = a + ((t - ENGINE_START) / (ENGINE_GCODE - ENGINE_START)) * (b - a);
      const left = ProgressModel.expectedStagesMs(this.trianglesOrGuess(), this.supports) * ((ENGINE_GCODE - t) / (ENGINE_GCODE - ENGINE_START));
      this.creep(b, ProgressModel.capFor('stages'), left, now, v);
      return;
    }
    this.stage = 'gcode';
    if (this.phase !== 'export') this.startPhase('export', now);
    const [a, b] = this.exportBand!;
    const tt = Math.min(t, 100);
    const v = a + ((tt - ENGINE_GCODE) / (100 - ENGINE_GCODE)) * (b - a);
    const left = ProgressModel.expectedExportMs(this.trianglesOrGuess()) * ((100 - tt) / (100 - ENGINE_GCODE));
    this.creep(b, ENGINE_END, left, now, v);
  }

  postprocessing(stage: 'thumbnails' | 'saving', message: string, now = Date.now()): void {
    this.tick(now);
    this.stage = stage;
    this.message = message;
    this.phase = 'post';
    const [a, b] = POST_BAND;
    const [s, e] = stage === 'thumbnails' ? [a, b - 2] : [b - 2, b];
    this.creep(e, e, 500, now, s);
  }

  done(): void {
    this.stage = 'done';
    this.value = 100;
  }

  /** Raw creep value at `now`. */
  private creepAt(now: number): number {
    const x = Math.max(0, now - this.startAt) / this.expectedMs;
    const s = this.startValue;
    const band = Math.max(0, this.bandEnd - s);
    if (x <= 1) return s + band * EASE_AT_EXPECTED * ((1 - Math.exp(-EASE_K * x)) / EASE_NORM);
    // Past the estimate: continue from 90 % of the band into the soft cap with a slowly decaying speed
    // (1 − 1/√(1+r·y)) whose initial slope matches the ease-out, so the bar never brakes hard or freezes.
    const p1 = s + band * EASE_AT_EXPECTED;
    const room = this.cap - p1;
    if (room <= 0) return p1;
    const slope = Math.max(EASE_END_SLOPE * band, 0.5);
    const r = (2 * slope) / room;
    return p1 + room * (1 - 1 / Math.sqrt(1 + r * (x - 1)));
  }

  /** Current value with creep applied (monotonic, never beyond the current soft cap). */
  tick(now = Date.now()): ProgressSnapshot {
    if (this.stage !== 'done' && this.phase !== null) {
      this.value = Math.max(this.value, Math.min(this.cap - 0.05, this.creepAt(now)));
    }
    return { progress: Math.floor(this.value * 10) / 10, stage: this.stage, ...(this.message && { message: this.message }) };
  }
}
