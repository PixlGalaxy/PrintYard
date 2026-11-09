import { AppError } from '../../errors.js';
import { CONTROL_CHARS } from '../../lib/sanitize.js';
import type { OptionDef } from '../../types.js';
import { k2seScanLimits } from '../files/gcode-scan.js';

/**
 * Typed bounds for engine option values (process / per-object / filament slot overrides and custom filament
 * presets). Phase 3 review A #2: sliced G-code used to be trusted without a scan while any value reached the engine,
 * so `nozzle_temperature_initial_layer: 999` became `M104 S999`. Every numeric value is now checked against its
 * type plus hard safety caps that match the dangerous-command scanner (so SliceDock's own output always passes it).
 */

export interface SafetyCaps {
  /** °C: scanner nozzle limit (highest K2 SE filament `nozzle_temperature_range_high`, ≤ 300). */
  nozzle: number;
  /** °C: K2 SE bed maximum (100) and never above the scanner limit. */
  bed: number;
  /** °C */
  chamber: number;
  /** mm/s: `machine_max_speed_x/y`. */
  velocity: number;
  /** mm/s²: `machine_max_acceleration_*`. */
  accel: number;
  /** mm/s: `machine_max_jerk_x/y` (emitted as SQUARE_CORNER_VELOCITY). */
  jerk: number;
  /** mm/s: extruder moves (`machine_max_speed_e`). */
  eSpeed: number;
  /** mm³/s */
  volumetric: number;
}

const K2SE_BED_MAX = 100;
const K2SE_E_SPEED_MAX = 100;
const MAX_VOLUMETRIC = 50;

let cachedCaps: SafetyCaps | null = null;
export function safetyCaps(): SafetyCaps {
  if (cachedCaps) return cachedCaps;
  const l = k2seScanLimits();
  cachedCaps = {
    nozzle: l.nozzle,
    bed: Math.min(K2SE_BED_MAX, l.bed),
    chamber: l.chamber,
    velocity: l.velocity,
    accel: l.accel,
    jerk: l.squareCornerVelocity,
    eSpeed: K2SE_E_SPEED_MAX,
    volumetric: MAX_VOLUMETRIC,
  };
  return cachedCaps;
}

export interface Bounds {
  min: number;
  max: number;
  /** Highest value when written as a percentage (`50%`), for "mm/s or %" style options. */
  percentMax: number;
  /** True for safety-relevant keys: arrays and free values are always checked. */
  critical: boolean;
}

const E_SPEED_KEY = /retraction_speed|retract_speed|deretraction_speed|loading_speed|unloading_speed|cooling_(initial|final)_speed|ramming/;
const FLOW_KEY = /flow_ratio$|^bridge_flow$|^internal_bridge_flow$/;

/** Bounds of one option (numeric options only; other types are checked by kind). */
export function optionBounds(def: Pick<OptionDef, 'key' | 'type' | 'unit' | 'min' | 'max'>, caps: SafetyCaps = safetyCaps()): Bounds {
  const k = def.key;
  const unit = def.unit ?? '';
  const b = (min: number, max: number, percentMax = 1000, critical = true): Bounds => ({ min, max, percentMax, critical });
  if (unit.includes('∆°C') || /temperature_delta$/.test(k)) return b(-caps.nozzle, 10, 0);
  if (unit.includes('°C') || /(^|_)temp(erature)?(_|$)/.test(k)) {
    if (/plate_temp|bed_temp/.test(k)) return b(0, caps.bed, 0);
    if (/chamber/.test(k)) return b(0, caps.chamber, 0);
    return b(0, caps.nozzle, 0);
  }
  if (/fan/.test(k) && (unit === '%' || /speed$/.test(k))) return b(-1, 100, 100);
  if (/jerk/.test(k)) return b(0, caps.jerk, 100);
  if (unit.startsWith('mm/s²')) return b(0, caps.accel, 200);
  if (unit.startsWith('mm³/s') && !unit.startsWith('mm³/s²')) return b(0, caps.volumetric, 0);
  if (unit.startsWith('mm/s') && E_SPEED_KEY.test(k)) return b(0, caps.eSpeed, 200);
  if (unit.startsWith('mm/s')) return b(0, caps.velocity, 200);
  if (FLOW_KEY.test(k)) return b(k === 'filament_flow_ratio' ? 0.01 : 0, 2, 200);
  if (k === 'filament_diameter') return b(1, 3, 0);
  if (k === 'filament_density') return b(0.3, 10, 0);
  if (k === 'pressure_advance') return b(0, 2, 0);
  if (k === 'filament_cost') return b(0, 1_000_000, 0, false);
  if (def.type === 'percent') return b(def.min ?? 0, 1000, 1000, false);
  return b(-100_000, 100_000, 1000, false);
}

const NUMBER = /^-?(\d+(\.\d*)?|\.\d+)$/;

export interface ValueIssue {
  key: string;
  reason: string;
}

/** Checks one number (optionally `N%`). Returns the failure reason or null. */
function checkNumber(raw: string, bounds: Bounds, allowPercent: boolean, integer: boolean): string | null {
  const v = raw.trim();
  const pct = v.endsWith('%');
  if (pct && !allowPercent) return 'number';
  const s = pct ? v.slice(0, -1) : v;
  if (!NUMBER.test(s)) return 'number';
  if (integer && !pct && !/^-?\d+$/.test(s)) return 'integer';
  const n = Number(s);
  const min = pct ? 0 : bounds.min;
  const max = pct ? bounds.percentMax : bounds.max;
  if (!Number.isFinite(n) || n < min || n > max) return `range ${min}..${max}${pct ? '%' : ''}`;
  return null;
}

/**
 * Validates one value against its option definition. `nil` is accepted on the filament "Setting Overrides" page
 * (use the printer's value). Returns the failure reason or null. Never transforms.
 */
export function checkOptionValue(def: OptionDef, rawValue: string, caps: SafetyCaps = safetyCaps()): string | null {
  const v = rawValue.replace(CONTROL_CHARS, ' ').trim();
  if (v === 'nil' && def.page === 'Setting Overrides') return null;
  const unit = def.unit ?? '';
  const bounds = optionBounds(def, caps);
  switch (def.type) {
    case 'bool':
      return v === '0' || v === '1' ? null : 'bool';
    case 'int':
    case 'float':
      return checkNumber(v, bounds, unit.includes('%') && unit !== '%', def.type === 'int');
    case 'percent':
    case 'floatOrPercent':
      return checkNumber(v, bounds, true, false);
    case 'enum':
      return def.enumValues?.length && !def.enumValues.some((e) => e.value === v) ? 'enum' : null;
    case 'array': {
      // Per-extruder lists (`travel_speed = 500,500`): every entry is checked when the option has a unit or is
      // safety relevant; unit-less lists of strings/bools keep their free form.
      if (!unit && !bounds.critical) return null;
      for (const part of v.split(',')) {
        const r = checkNumber(part, bounds, unit.includes('%') || bounds.percentMax > 0, false);
        if (r) return r;
      }
      return null;
    }
    default:
      if (def.key === 'default_filament_colour' && v !== '' && !/^#[0-9a-fA-F]{6}$/.test(v)) return 'color';
      // Written into the G-code header / config block: keep the separators of `"a";"b"` lists out.
      if (/^filament_(type|vendor)$/.test(def.key) && /[;"\\]/.test(v)) return 'text';
      return null;
  }
}

/**
 * Validates a set of overrides against `defs`; unknown keys and bad values are both reported as
 * `slice.invalid_override` (400) with `details: { keys, issues }`.
 */
export function assertOptionValues(values: Record<string, string>, defs: Map<string, OptionDef>, where: string): void {
  const issues: ValueIssue[] = [];
  for (const [key, value] of Object.entries(values)) {
    const def = defs.get(key);
    if (!def) continue; // unknown keys are reported by the key allowlist
    const reason = checkOptionValue(def, value);
    if (reason) issues.push({ key, reason });
  }
  if (issues.length > 0) {
    throw new AppError(400, 'slice.invalid_override', `Invalid setting value in ${where}`, {
      keys: issues.slice(0, 20).map((i) => i.key),
      issues: issues.slice(0, 20),
    });
  }
}
