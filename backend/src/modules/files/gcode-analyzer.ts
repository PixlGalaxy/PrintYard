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
  /**
   * Classic commands: letter → raw value (`{ X: '10', E: '0.5' }`). Extended commands: KEY (upper case) → value,
   * exactly as Klipper's `_get_extended_params` builds it (shlex-split, quotes removed, value case kept).
   * Duplicate keys: the last one wins, like Klipper.
   */
  params: Record<string, string>;
  /** The line without its comment, upper-cased. */
  raw: string;
  /** Keys given more than once (Klipper silently keeps the last one). */
  duplicates?: string[];
  /**
   * Set when Klipper would refuse the line ("Malformed command": unbalanced quotes, an argument without `=`, …) or
   * when it is longer than `MAX_LINE_CHARS`. The parameters are then a best effort and must not be trusted.
   */
  malformed?: string;
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
/**
 * Longest line kept (characters). Longer lines are cut here and reported as malformed unless the kept part already
 * contains the `;` comment start (the rest is then a comment Klipper ignores too). Keeps the streaming linear.
 */
export const MAX_LINE_CHARS = 64 * 1024;

const ARGS_RE = /([A-Z_]+|[A-Z*])/;
/** Klipper `extended_r` up to the arguments: `^\s*(?:N[0-9]+\s*)?(?P<cmd>[a-zA-Z_][a-zA-Z0-9_]+)(?:\s+|$)`. */
const EXTENDED_HEAD_RE = /^\s*(?:N[0-9]+\s*)?([a-zA-Z_][a-zA-Z0-9_]+)(?:\s+|$)/;
const SHLEX_WS = ' \t\r\n';

/**
 * Python `shlex.split(s)` (posix, no comments, whitespace split): quotes may start mid-token, `'…'` is literal,
 * `"…"` honours `\\` and `\"` only, a backslash outside quotes escapes the next character. Returns null where shlex
 * raises ValueError (no closing quotation / no escaped character).
 */
export function shlexSplit(s: string): string[] | null {
  const tokens: string[] = [];
  let cur: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (SHLEX_WS.includes(c)) {
      if (cur !== null) tokens.push(cur);
      cur = null;
    } else if (c === '\\') {
      if (i + 1 >= s.length) return null;
      cur = (cur ?? '') + s[++i];
    } else if (c === "'") {
      const close = s.indexOf("'", i + 1);
      if (close < 0) return null;
      cur = (cur ?? '') + s.slice(i + 1, close);
      i = close;
    } else if (c === '"') {
      let tok: string = cur ?? '';
      let j = i + 1;
      for (;;) {
        if (j >= s.length) return null;
        const d = s[j]!;
        if (d === '"') break;
        if (d === '\\') {
          if (j + 1 >= s.length) return null;
          const n = s[j + 1]!;
          tok += n === '"' || n === '\\' ? n : `\\${n}`;
          j += 2;
          continue;
        }
        tok += d;
        j++;
      }
      cur = tok;
      i = j;
    } else cur = (cur ?? '') + c;
  }
  if (cur !== null) tokens.push(cur);
  return tokens;
}

/**
 * Klipper `_get_extended_params` on the original line (case kept, comment included): the arguments stop at the
 * first `#`, `*` or `;`, are shlex-split and each token is split on its first `=`; keys upper-cased, last one wins.
 */
function extendedParams(origLine: string): { params: Record<string, string>; duplicates: string[]; malformed?: string } {
  const params: Record<string, string> = {};
  const duplicates: string[] = [];
  const m = EXTENDED_HEAD_RE.exec(origLine);
  if (!m) return { params, duplicates, malformed: 'malformed command' };
  const rest = origLine.slice(m[0].length);
  const stop = rest.search(/[#*;]/);
  const tokens = shlexSplit((stop >= 0 ? rest.slice(0, stop) : rest).trimEnd());
  if (!tokens) return { params, duplicates, malformed: 'unbalanced quotes' };
  let malformed: string | undefined;
  for (const t of tokens) {
    const eq = t.indexOf('=');
    if (eq < 0) {
      malformed ??= `argument without "=": ${t.slice(0, 40)}`;
      continue;
    }
    const k = t.slice(0, eq).toUpperCase();
    if (k in params && !duplicates.includes(k)) duplicates.push(k);
    params[k] = t.slice(eq + 1);
  }
  return { params, duplicates, ...(malformed !== undefined && { malformed }) };
}

/** Klipper-like tokenizer (`klippy/gcode.py`). Returns null for blank/comment-only lines. */
export function parseGcodeLine(rawLine: string, lineNo: number): GcodeCommand | null {
  const orig = rawLine.trim();
  let line = orig;
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
  // Klipper's command name is `parts[1] + parts[2].strip()`: `SAVE_CONFIG*23` dispatches SAVE_CONFIG.
  const name = head + rest;
  // Extended (Klipper) command: a multi-letter word, parameters as KEY=VALUE.
  if (head.length > 1 || (rest !== '' && !/^[-+]?[0-9.]/.test(rest))) {
    const e = extendedParams(orig);
    return {
      line: lineNo,
      name,
      params: e.params,
      raw: line,
      ...(e.duplicates.length > 0 && { duplicates: e.duplicates }),
      ...(e.malformed !== undefined && { malformed: e.malformed }),
    };
  }
  // Traditional: `{ parts[i]: parts[i+1].strip() for i in range(1, numparts, 2) }`, the last one wins.
  const params: Record<string, string> = {};
  const duplicates: string[] = [];
  for (let k = i + 2; k + 1 < parts.length; k += 2) {
    const key = parts[k]!;
    if (key in params && !duplicates.includes(key)) duplicates.push(key);
    params[key] = parts[k + 1]!.trim();
  }
  return { line: lineNo, name, params, raw: line, ...(duplicates.length > 0 && { duplicates }) };
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

  /** `truncated`: the line was longer than `MAX_LINE_CHARS` and `raw` is only its first part. */
  pushLine(raw: string, truncated = false): void {
    this.lineNo++;
    if (truncated && !raw.includes(';')) {
      // The command part does not end inside the kept prefix: Klipper would read parameters we never saw.
      const cmd = parseGcodeLine(raw, this.lineNo);
      const tooLong: GcodeCommand = {
        line: this.lineNo,
        name: cmd?.name ?? '',
        params: cmd?.params ?? {},
        raw: (cmd?.raw ?? raw.trim().toUpperCase()).slice(0, 120),
        malformed: `line longer than ${MAX_LINE_CHARS} characters`,
      };
      for (const h of this.hooks) h(tooLong);
      if (cmd) this.apply(cmd);
      return;
    }
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

/**
 * Streams `path` through a GcodeAnalyzer, yielding to the event loop between chunks. Linear in the file size: each
 * chunk is searched for `\n` once and a pending line never grows past `MAX_LINE_CHARS` (the excess is dropped and the
 * line reported as truncated), so a huge file without newlines costs a single pass.
 */
export async function analyzeGcodeFile(path: string, opts: AnalyzeOptions = {}): Promise<GcodeAnalysis> {
  const a = new GcodeAnalyzer(opts);
  let carry = '';
  let truncated = false;
  const append = (piece: string) => {
    if (truncated) return;
    const room = MAX_LINE_CHARS - carry.length;
    if (piece.length > room) {
      carry += piece.slice(0, room);
      truncated = true;
    } else carry += piece;
  };
  for await (const chunk of createReadStream(path, { encoding: 'latin1', highWaterMark: 256 * 1024 })) {
    if (opts.signal?.aborted) throw new Error('G-code analysis aborted');
    const text = chunk as string;
    let pos = 0;
    for (let nl = text.indexOf('\n'); nl >= 0; nl = text.indexOf('\n', pos)) {
      if (carry === '' && !truncated) {
        if (nl - pos > MAX_LINE_CHARS) a.pushLine(text.slice(pos, pos + MAX_LINE_CHARS), true);
        else a.pushLine(text.slice(pos, nl));
      } else {
        append(text.slice(pos, nl));
        a.pushLine(carry, truncated);
        carry = '';
        truncated = false;
      }
      pos = nl + 1;
    }
    if (pos < text.length) append(text.slice(pos));
    await yieldToLoop();
  }
  if (carry || truncated) a.pushLine(carry, truncated);
  return a.finish();
}
