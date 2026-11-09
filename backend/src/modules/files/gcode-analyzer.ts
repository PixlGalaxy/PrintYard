import { createReadStream } from 'node:fs';
import { setImmediate as yieldToLoop } from 'node:timers/promises';

/**
 * Server-side usage estimate of a G-code file computed from the moves themselves (never from comments), so the
 * per-user limits cannot be bypassed with a forged `; filament used [g] = 1` line (security review finding #1).
 *
 * The parser follows Klipper's tokenizer (`klippy/gcode.py`): the line is upper-cased, everything after `;` is a
 * comment, an optional `N<line>` prefix is skipped and parameters are split on letters (`G1X10E5` works). Moves use
 * Klipper semantics: E is relative when `G91` or `M83` is active, `G92` re-bases positions without moving.
 *
 * Extension point: `hooks` receive every parsed command (G/M codes and Klipper extended commands such as
 * `SET_HEATER_TEMPERATURE`). A later dangerous-command scanner (finding #3) plugs in here; a hook may throw to abort.
 */

export interface GcodeCommand {
  /** 1-based line number */
  line: number;
  /** `G1`, `M104`, `T0`, `SET_HEATER_TEMPERATURE`, … (upper case) */
  name: string;
  /** Classic commands: letter → raw value (`{ X: '10', E: '0.5' }`). Extended commands: KEY → value from `KEY=value`. */
  params: Record<string, string>;
  /** The line without its comment, upper-cased. */
  raw: string;
}

export type GcodeHook = (cmd: GcodeCommand) => void;

export interface AnalyzeOptions {
  /** g/cm³ (default 1.24, PLA) */
  filamentDensity?: number;
  /** mm (default 1.75) */
  filamentDiameter?: number;
  hooks?: GcodeHook[];
  signal?: AbortSignal;
}

export interface GcodeAnalysis {
  /** Filament per tool (T0…), grams. */
  grams: number[];
  /** Filament per tool, mm. */
  mm: number[];
  totalGrams: number;
  seconds: number;
  layers: number;
  lines: number;
}

/** Physical caps so absurd feedrates (`F999999`) cannot shrink the time estimate (K2 SE: 600 mm/s, Z ~20 mm/s). */
const MAX_XY_MM_S = 600;
const MAX_Z_MM_S = 20;
const MAX_E_MM_S = 60;
const DEFAULT_F_MM_MIN = 1500;
/** Accelerations and corner slowdowns make real prints slower than distance / feedrate. */
const TIME_FACTOR = 1.1;
/** A retraction longer than this is not "filament pushed back later": the excess counts as consumed. */
const MAX_RETRACT_CREDIT_MM = 20;
const HEAT_WAIT_S = 60;
const HOME_S = 15;
const MAX_TOOLS = 64;

const ARGS_RE = /([A-Z_]+|[A-Z*])/;

/** Klipper-like tokenizer. Returns null for blank/comment-only lines. */
export function parseGcodeLine(rawLine: string, lineNo: number): GcodeCommand | null {
  let line = rawLine;
  const c = line.indexOf(';');
  if (c >= 0) line = line.slice(0, c);
  line = line.trim().toUpperCase();
  if (!line) return null;
  const parts = line.split(ARGS_RE);
  let i = 1;
  if (parts[1] === 'N' && parts.length >= 5) i = 3; // line number prefix
  if (parts.length < i + 2) return null;
  const head = parts[i]!;
  const rest = parts[i + 1]!.trim();
  // Extended (Klipper) command: a multi-letter word, parameters as KEY=VALUE.
  if (head.length > 1 || (rest !== '' && !/^[-+]?[0-9.]/.test(rest))) {
    // Klipper's command name is `parts[1] + parts[2].strip()`: `SAVE_CONFIG*23` dispatches SAVE_CONFIG.
    const name = head + rest;
    const params: Record<string, string> = {};
    const argStart = line.indexOf(head) + head.length;
    for (const m of line.slice(argStart).matchAll(/([A-Z0-9_]+)\s*=\s*("[^"]*"|\S+)/g)) params[m[1]!] = m[2]!;
    return { line: lineNo, name, params, raw: line };
  }
  const name = head + rest;
  const params: Record<string, string> = {};
  for (let k = i + 2; k + 1 < parts.length; k += 2) params[parts[k]!] = parts[k + 1]!.trim();
  return { line: lineNo, name, params, raw: line };
}

export class GcodeAnalyzer {
  private readonly area: number;
  private readonly density: number;
  private readonly hooks: GcodeHook[];
  private lineNo = 0;
  // state
  private absCoord = true;
  private absExtrude = true;
  private pos = { x: 0, y: 0, z: 0, e: 0 };
  private feed = DEFAULT_F_MM_MIN;
  private speedFactor = 1;
  /** M221 extrusion multiplier (S percent). */
  private flowFactor = 1;
  private tool = 0;
  private retractCredit = 0;
  private readonly toolMm: number[] = [0];
  private seconds = 0;
  private layers = 0;
  private lastLayerZ = -Infinity;

  constructor(opts: AnalyzeOptions = {}) {
    const d = opts.filamentDiameter && opts.filamentDiameter > 0 ? opts.filamentDiameter : 1.75;
    this.area = Math.PI * (d / 2) ** 2;
    this.density = opts.filamentDensity && opts.filamentDensity > 0 ? opts.filamentDensity : 1.24;
    this.hooks = opts.hooks ?? [];
  }

  pushLine(raw: string): void {
    this.lineNo++;
    const cmd = parseGcodeLine(raw, this.lineNo);
    if (!cmd) return;
    for (const h of this.hooks) h(cmd);
    this.apply(cmd);
  }

  private num(v: string | undefined): number | null {
    if (v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  private apply(cmd: GcodeCommand): void {
    const p = cmd.params;
    switch (cmd.name) {
      case 'G0':
      case 'G1':
      case 'G2':
      case 'G3':
        return this.move(cmd.name, p);
      case 'G4': {
        const ms = this.num(p.P);
        const s = this.num(p.S);
        this.seconds += Math.max(0, ms !== null ? ms / 1000 : (s ?? 0));
        return;
      }
      case 'G28':
        this.seconds += HOME_S;
        return;
      case 'G90':
        this.absCoord = true;
        return;
      case 'G91':
        this.absCoord = false;
        return;
      case 'M82':
        this.absExtrude = true;
        return;
      case 'M83':
        this.absExtrude = false;
        return;
      case 'G92': {
        for (const axis of ['X', 'Y', 'Z', 'E'] as const) {
          const v = this.num(p[axis]);
          if (v !== null) this.pos[axis.toLowerCase() as 'x' | 'y' | 'z' | 'e'] = v;
        }
        if (!('X' in p || 'Y' in p || 'Z' in p || 'E' in p)) this.pos = { x: 0, y: 0, z: 0, e: 0 };
        return;
      }
      case 'M220': {
        const s = this.num(p.S);
        // Slower speed factors make the print longer; faster ones are capped by MAX_*_MM_S anyway.
        if (s !== null && s > 0) this.speedFactor = s / 100;
        return;
      }
      case 'M221': {
        const s = this.num(p.S);
        if (s !== null && s >= 0) this.flowFactor = s / 100;
        return;
      }
      case 'M109':
      case 'M190':
        this.seconds += HEAT_WAIT_S;
        return;
      default:
        if (/^T\d+$/.test(cmd.name)) {
          this.tool = Math.min(MAX_TOOLS - 1, Number(cmd.name.slice(1)));
          while (this.toolMm.length <= this.tool) this.toolMm.push(0);
        }
    }
  }

  private move(name: string, p: Record<string, string>): void {
    const rel = !this.absCoord;
    const eRel = !this.absCoord || !this.absExtrude;
    const f = this.num(p.F);
    if (f !== null && f > 0) this.feed = f;
    const next = { ...this.pos };
    for (const axis of ['X', 'Y', 'Z'] as const) {
      const v = this.num(p[axis]);
      if (v === null) continue;
      const k = axis.toLowerCase() as 'x' | 'y' | 'z';
      next[k] = rel ? this.pos[k] + v : v;
    }
    const ev = this.num(p.E);
    let de = 0;
    if (ev !== null) {
      next.e = eRel ? this.pos.e + ev : ev;
      de = next.e - this.pos.e;
    }
    const dx = next.x - this.pos.x;
    const dy = next.y - this.pos.y;
    const dz = next.z - this.pos.z;
    let xy = Math.hypot(dx, dy);
    if (name === 'G2' || name === 'G3') {
      // Arc length from the centre offset (I/J); falls back to the chord.
      const i = this.num(p.I) ?? 0;
      const j = this.num(p.J) ?? 0;
      const r = Math.hypot(i, j);
      if (r > 0) {
        const cx = this.pos.x + i;
        const cy = this.pos.y + j;
        let a = Math.atan2(next.y - cy, next.x - cx) - Math.atan2(this.pos.y - cy, this.pos.x - cx);
        if (name === 'G2' && a >= 0) a -= 2 * Math.PI;
        if (name === 'G3' && a <= 0) a += 2 * Math.PI;
        xy = Math.abs(a) * r;
      }
    }
    const v = (this.feed / 60) * this.speedFactor;
    let t = 0;
    if (xy > 0) t = Math.hypot(xy, dz) / Math.min(v, MAX_XY_MM_S);
    else if (dz !== 0) t = Math.abs(dz) / Math.min(v, MAX_Z_MM_S);
    else if (de !== 0) t = Math.abs(de) / Math.min(v, MAX_E_MM_S);
    if (Number.isFinite(t)) this.seconds += t;
    if (de > 0) {
      const credited = Math.min(this.retractCredit, de);
      this.retractCredit -= credited;
      this.toolMm[this.tool] = (this.toolMm[this.tool] ?? 0) + (de - credited) * this.flowFactor;
      if (next.z > this.lastLayerZ + 1e-4) {
        this.layers++;
        this.lastLayerZ = next.z;
      }
    } else if (de < 0) {
      this.retractCredit = Math.min(MAX_RETRACT_CREDIT_MM, this.retractCredit - de);
    }
    this.pos = next;
  }

  finish(): GcodeAnalysis {
    const mm = this.toolMm.map((v) => Math.round(v * 100) / 100);
    const grams = this.toolMm.map((v) => Math.round(((v * this.area * this.density) / 1000) * 100) / 100);
    // Trailing unused tools are dropped (T0 is always present).
    while (mm.length > 1 && mm[mm.length - 1] === 0) {
      mm.pop();
      grams.pop();
    }
    return {
      grams,
      mm,
      totalGrams: Math.round(grams.reduce((a, b) => a + b, 0) * 100) / 100,
      seconds: Math.round(this.seconds * TIME_FACTOR),
      layers: this.layers,
      lines: this.lineNo,
    };
  }
}

/** Streams `path` through a GcodeAnalyzer, yielding to the event loop between chunks. */
export async function analyzeGcodeFile(path: string, opts: AnalyzeOptions = {}): Promise<GcodeAnalysis> {
  const a = new GcodeAnalyzer(opts);
  let carry = '';
  for await (const chunk of createReadStream(path, { encoding: 'latin1', highWaterMark: 256 * 1024 })) {
    if (opts.signal?.aborted) throw new Error('G-code analysis aborted');
    const text = carry + (chunk as string);
    const lines = text.split('\n');
    carry = lines.pop() ?? '';
    for (const l of lines) a.pushLine(l);
    await yieldToLoop();
  }
  if (carry) a.pushLine(carry);
  return a.finish();
}
