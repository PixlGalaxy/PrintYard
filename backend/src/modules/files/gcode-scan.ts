import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resourcesDir } from '../../lib/resources.js';
import type { GcodeScan, GcodeScanFinding, GcodeScanReason } from '../../types.js';
import { analyzeGcodeFile, type GcodeCommand, type GcodeHook } from './gcode-analyzer.js';

/**
 * Dangerous-command scanner for G-code PrintYard did not slice (security review finding #3). Plugs into the
 * analyzer's `hooks`, so it sees exactly the commands Klipper would run (same tokenizer, comments stripped).
 *
 * Policy: an allowlist. Everything Creality Print's own K2 SE output uses (start/end macros, EXCLUDE_OBJECT_*,
 * SET_VELOCITY_LIMIT, M73/M117, fans, temperatures within the profile maxima, …) passes; known-dangerous
 * commands get a specific reason; any other G/M code or Klipper macro is `unknown_command` (macros can do anything).
 */

/** Bump when the rules change: stored scans with another version are recomputed before printing. */
export const SCAN_VERSION = 2;
/** Findings kept in `meta.gcode.scan` (the total is counted separately). */
const MAX_STORED_FINDINGS = 50;

export interface ScanLimits {
  /** °C: highest `nozzle_temperature_range_high` among the K2 SE filament profiles (default 300). */
  nozzle: number;
  /** °C (default 110). */
  bed: number;
  /** °C (default 60). */
  chamber: number;
  /** mm/s: `machine_max_speed_x/y` (default 800). */
  velocity: number;
  /** mm/s²: `machine_max_acceleration_x/y/travel` (default 20000). */
  accel: number;
  /** mm/s: square corner velocity cap (`machine_max_jerk_x/y`, default 20). */
  squareCornerVelocity: number;
  /** % : highest `M220 S` speed factor (default 200). */
  speedFactor: number;
  /** % : highest `M221 S` extrusion factor (default 150). */
  flowFactor: number;
}

export const DEFAULT_SCAN_LIMITS: ScanLimits = {
  nozzle: 300,
  bed: 110,
  chamber: 60,
  velocity: 800,
  accel: 20000,
  squareCornerVelocity: 20,
  speedFactor: 200,
  flowFactor: 150,
};

/** Named dangerous commands → reason. */
const DANGEROUS: Record<string, GcodeScanReason> = {
  SAVE_CONFIG: 'config_write',
  SAVE_VARIABLE: 'config_write',
  M500: 'config_write',
  M501: 'config_write',
  M502: 'config_write',
  RUN_SHELL_COMMAND: 'shell_command',
  FIRMWARE_RESTART: 'firmware_restart',
  RESTART: 'firmware_restart',
  M997: 'firmware_update',
  M112: 'emergency_stop',
  SET_KINEMATIC_POSITION: 'kinematics',
  SET_STEPPER_ENABLE: 'kinematics',
  FORCE_MOVE: 'kinematics',
};

/**
 * Commands that may appear (derived from Creality Print 7.x K2 SE output: machine start/end/pause/layer-change
 * G-code in resources/profiles/creality + a real sliced sample). Temperature/motion ones are range-checked below.
 */
const ALLOWED = new Set<string>([
  // motion / modes
  'G0', 'G1', 'G2', 'G3', 'G4', 'G10', 'G11', 'G17', 'G21', 'G28', 'G90', 'G91', 'G92',
  'M82', 'M83', 'M84', 'M18', 'M400',
  // progress / messages
  'M73', 'M117', 'M118', 'M105',
  // fans
  'M106', 'M107',
  // temperatures (range-checked)
  'M104', 'M109', 'M140', 'M190', 'M141', 'M191',
  // motion limits / factors (range-checked)
  'M201', 'M203', 'M204', 'M205', 'M220', 'M221',
  // SD pause/resume
  'M24', 'M25',
  // Klipper / Creality macros used by Creality Print for the K2 SE
  'START_PRINT', 'END_PRINT', 'PAUSE', 'RESUME', 'CANCEL_PRINT',
  'EXCLUDE_OBJECT_DEFINE', 'EXCLUDE_OBJECT_START', 'EXCLUDE_OBJECT_END', 'EXCLUDE_OBJECT',
  'SET_PRESSURE_ADVANCE', 'SET_VELOCITY_LIMIT', 'SET_PRINT_STATS_INFO', 'SET_HEATER_TEMPERATURE', 'TEMPERATURE_WAIT',
]);

/**
 * Plain decimal numbers only. Python's `float()` (Klipper `get_float`) also takes `nan`, `inf`, `1_000` and non-ASCII
 * digits, and NaN passes every `maxval` check there, so anything that is not a plain number is `invalid_value`.
 */
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const num = (v: string | undefined): number | null => {
  if (v === undefined || v === '') return null;
  const t = v.trim();
  if (!DECIMAL.test(t)) return NaN;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};

/** Commands whose parameters are range-checked: ambiguous or malformed parameters there are findings. */
const CHECKED = new Set([
  'M104', 'M109', 'M140', 'M190', 'M141', 'M191', 'M201', 'M203', 'M204', 'M220', 'M221',
  'START_PRINT', 'SET_HEATER_TEMPERATURE', 'SET_VELOCITY_LIMIT', 'TEMPERATURE_WAIT',
]);

let cachedLimits: ScanLimits | null = null;

/** Limits from the bundled K2 SE profiles (machine + filament), falling back to `DEFAULT_SCAN_LIMITS`. */
export function k2seScanLimits(): ScanLimits {
  if (cachedLimits) return cachedLimits;
  const limits = { ...DEFAULT_SCAN_LIMITS };
  const first = (v: unknown): number | null => {
    const x = Array.isArray(v) ? v[0] : v;
    const n = Number(x);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  try {
    const dir = join(resourcesDir(), 'profiles', 'creality');
    const machine = JSON.parse(readFileSync(join(dir, 'machine', 'Creality K2 SE 0.4 nozzle.json'), 'utf8')) as Record<string, unknown>;
    const v = Math.max(first(machine.machine_max_speed_x) ?? 0, first(machine.machine_max_speed_y) ?? 0);
    if (v > 0) limits.velocity = v;
    const a = Math.max(first(machine.machine_max_acceleration_x) ?? 0, first(machine.machine_max_acceleration_y) ?? 0, first(machine.machine_max_acceleration_travel) ?? 0);
    if (a > 0) limits.accel = a;
    const j = Math.max(first(machine.machine_max_jerk_x) ?? 0, first(machine.machine_max_jerk_y) ?? 0);
    if (j > 0) limits.squareCornerVelocity = j;
    const bed = first(machine.bed_temperature_max ?? machine.max_bed_temperature);
    if (bed) limits.bed = bed;
    let nozzle = 0;
    for (const f of readdirSync(join(dir, 'filament'))) {
      if (!f.includes('K2 SE')) continue;
      const fil = JSON.parse(readFileSync(join(dir, 'filament', f), 'utf8')) as Record<string, unknown>;
      nozzle = Math.max(nozzle, first(fil.nozzle_temperature_range_high) ?? 0);
    }
    if (nozzle > 0) limits.nozzle = Math.min(nozzle, DEFAULT_SCAN_LIMITS.nozzle);
  } catch {
    /* bundled snapshot missing: defaults */
  }
  cachedLimits = limits;
  return limits;
}

export class GcodeScanner {
  private readonly findings: GcodeScanFinding[] = [];
  private total = 0;

  constructor(private readonly limits: ScanLimits = k2seScanLimits()) {}

  readonly hook: GcodeHook = (cmd) => this.check(cmd);

  private add(cmd: GcodeCommand, reason: GcodeScanReason, detail?: string): void {
    this.total++;
    if (this.findings.length < MAX_STORED_FINDINGS) {
      this.findings.push({ line: cmd.line, command: cmd.raw.slice(0, 120), reason, ...(detail !== undefined && { detail }) });
    }
  }

  /** Flags a temperature parameter above `max` (or not a number). */
  private temp(cmd: GcodeCommand, key: string, max: number): void {
    const t = num(cmd.params[key]);
    if (t === null) return;
    if (Number.isNaN(t)) this.add(cmd, 'invalid_value', `${key}=${cmd.params[key]}`);
    else if (t > max) this.add(cmd, 'temperature_too_high', `${key}=${t} > ${max}`);
  }

  private motion(cmd: GcodeCommand, key: string, max: number): void {
    const v = num(cmd.params[key]);
    if (v === null) return;
    if (Number.isNaN(v)) this.add(cmd, 'invalid_value', `${key}=${cmd.params[key]}`);
    else if (v > max) this.add(cmd, 'motion_limit', `${key}=${v} > ${max}`);
  }

  private check(cmd: GcodeCommand): void {
    const name = cmd.name;
    const L = this.limits;
    const danger = DANGEROUS[name];
    if (danger) return this.add(cmd, danger);
    // Over-long lines (parameters past the cut were never seen) and lines Klipper refuses with "Malformed command".
    if (cmd.malformed !== undefined) return this.add(cmd, 'malformed_command', cmd.malformed);
    if (/^T\d{1,2}$/.test(name)) return;
    if (!ALLOWED.has(name)) return this.add(cmd, 'unknown_command');
    // Klipper keeps the last value (checked below); a repeated key on a checked command is suspicious in itself.
    if (CHECKED.has(name) && cmd.duplicates?.length) this.add(cmd, 'duplicate_parameter', cmd.duplicates.slice(0, 5).join(', '));
    switch (name) {
      case 'M104':
      case 'M109':
        return this.temp(cmd, 'S', L.nozzle);
      case 'M140':
      case 'M190':
        return this.temp(cmd, 'S', L.bed);
      case 'M141':
      case 'M191':
        return this.temp(cmd, 'S', L.chamber);
      case 'START_PRINT':
        this.temp(cmd, 'EXTRUDER_TEMP', L.nozzle);
        this.temp(cmd, 'BED_TEMP', L.bed);
        this.temp(cmd, 'CHAMBER_TEMP', L.chamber);
        return;
      case 'SET_HEATER_TEMPERATURE': {
        const heater = (cmd.params.HEATER ?? '').toUpperCase();
        const max = heater.startsWith('EXTRUDER') ? L.nozzle : heater === 'HEATER_BED' ? L.bed : heater.includes('CHAMBER') ? L.chamber : null;
        if (max === null) return this.add(cmd, 'unknown_heater', heater || undefined);
        return this.temp(cmd, 'TARGET', max);
      }
      case 'SET_VELOCITY_LIMIT':
        this.motion(cmd, 'VELOCITY', L.velocity);
        this.motion(cmd, 'ACCEL', L.accel);
        this.motion(cmd, 'ACCEL_TO_DECEL', L.accel);
        this.motion(cmd, 'MINIMUM_CRUISE_RATIO', 1);
        this.motion(cmd, 'SQUARE_CORNER_VELOCITY', L.squareCornerVelocity);
        return;
      case 'M204':
        for (const k of ['S', 'P', 'T']) this.motion(cmd, k, L.accel);
        return;
      case 'M201':
        for (const k of ['X', 'Y']) this.motion(cmd, k, L.accel);
        return;
      case 'M203':
        for (const k of ['X', 'Y']) this.motion(cmd, k, L.velocity);
        return;
      case 'M220':
        return this.motion(cmd, 'S', L.speedFactor);
      case 'M221': {
        const v = num(cmd.params.S);
        if (v === null) return;
        if (Number.isNaN(v)) return this.add(cmd, 'invalid_value', `S=${cmd.params.S}`);
        if (v > L.flowFactor) return this.add(cmd, 'flow_limit', `S=${v} > ${L.flowFactor}`);
        return;
      }
      default:
        return;
    }
  }

  result(): GcodeScan {
    return {
      ok: this.total === 0,
      findings: this.findings,
      total: this.total,
      version: SCAN_VERSION,
      limits: { nozzle: this.limits.nozzle, bed: this.limits.bed },
    };
  }
}

/** Scans a whole file (streaming). */
export async function scanGcodeFile(path: string, limits?: ScanLimits): Promise<GcodeScan> {
  const s = new GcodeScanner(limits);
  await analyzeGcodeFile(path, { hooks: [s.hook] });
  return s.result();
}
