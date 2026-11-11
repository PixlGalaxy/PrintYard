// Filaments loaded in the printer (PrinterStatus.cfs) → scene filament slots / presets.
import type { CfsSlot, PresetSummary } from '../types'
import { shortPresetName } from './profiles'

/** "1A" for box 1 slot 1 (Creality's CFS naming); the external spool holder is "Ext". */
export const cfsName = (c: { box: number; slot: number }) => (c.box === 0 ? 'Ext' : `${c.box}${'ABCD'[c.slot - 1] ?? c.slot}`)

/** "External spool" / "CFS 1·A" (translated via the `t` passed in). */
export function spoolLabel(c: { box: number; slot: number }, t: (k: 'workspace.filament.external' | 'workspace.filament.cfsSlot', v?: Record<string, string | number>) => string) {
  return c.box === 0 ? t('workspace.filament.external') : t('workspace.filament.cfsSlot', { box: c.box, slot: 'ABCD'[c.slot - 1] ?? c.slot })
}

/** Slots with a spool in them (external first, then CFS boxes in order). */
export const loadedSpools = (cfs: CfsSlot[] | null | undefined) => (cfs ?? []).filter((c) => !!c.material)

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * Best preset for a loaded spool: same Creality material name ("Hyper PLA" → "Hyper PLA @…"), else the Generic
 * preset of its type (the printer's `type`, or a type suffix of the name: "Generic PLA-CF" → PLA-CF).
 */
export function presetForSpool(list: PresetSummary[], spool: { material: string | null; name?: string | null; vendor?: string | null; type?: string | null }): PresetSummary | undefined {
  const name = spool.name?.trim() || spool.material
  if (!name) return undefined
  const m = norm(name)
  // System presets first: a user's custom preset with the same name should not silently win
  const exact =
    list.find((p) => !p.custom && norm(shortPresetName(p.name)) === m) ??
    (spool.vendor ? list.find((p) => !p.custom && norm(shortPresetName(p.name)) === norm(`${spool.vendor} ${name}`)) : undefined) ??
    list.find((p) => norm(shortPresetName(p.name)) === m)
  if (exact) return exact
  const types = [...new Set(list.map((p) => p.filamentType).filter((x): x is string => !!x))]
  const reported = spool.type ? types.find((ft) => norm(ft) === norm(spool.type!)) : undefined
  // Longest suffix first so "PLA-CF" wins over "PLA"
  const fromName = types
    .sort((a, b) => b.length - a.length)
    .find((ft) => {
      const f = norm(ft)
      return m === f || m.endsWith(` ${f}`) || m.endsWith(`-${f}`)
    })
  const type = fromName ?? reported
  if (!type) return undefined
  const ofType = list.filter((p) => p.filamentType === type)
  return ofType.find((p) => /^generic/i.test(p.name)) ?? ofType[0]
}

/** The printer's own name for the spool ("Generic PLA"), falling back to the material/type. */
export const spoolName = (c: CfsSlot) => c.name?.trim() || c.material || c.type || ''

/** Changes when what the printer has saved for that spool changes (name, colour, temperatures, PA). */
export const spoolFingerprint = (c: CfsSlot) => [spoolName(c), c.vendor ?? '', c.color ?? '', c.minTemp ?? '', c.maxTemp ?? '', c.pressureAdvance ?? ''].join('|')

const firstNum = (v: string | undefined) => {
  const n = v == null ? NaN : parseFloat(String(v).split(',')[0]!)
  return Number.isFinite(n) ? n : null
}
const fmt = (n: number) => String(Math.round(n * 10000) / 10000)

/**
 * The printer's saved values as filament overrides on top of `values` (the matched preset):
 * nozzle temperatures clamped into [minTemp, maxTemp] and the pressure advance, only for keys the bundle allows
 * and only where they differ from the preset.
 */
export function printerOverrides(spool: CfsSlot, values: Record<string, string>, allowed: Set<string>): Record<string, string> {
  const out: Record<string, string> = {}
  const { minTemp: lo, maxTemp: hi } = spool
  if (lo != null && hi != null && lo <= hi) {
    // the printer's range replaces the profile's (Min/Max in the filament settings), printing temps stay inside it
    if (allowed.has('nozzle_temperature_range_low')) out.nozzle_temperature_range_low = fmt(lo)
    if (allowed.has('nozzle_temperature_range_high')) out.nozzle_temperature_range_high = fmt(hi)
    for (const key of ['nozzle_temperature', 'nozzle_temperature_initial_layer']) {
      const v = firstNum(values[key])
      if (v != null && allowed.has(key)) out[key] = fmt(Math.min(hi, Math.max(lo, v)))
    }
  }
  if (spool.pressureAdvance != null && allowed.has('pressure_advance')) {
    out.pressure_advance = fmt(spool.pressureAdvance)
    if (allowed.has('enable_pressure_advance')) out.enable_pressure_advance = '1'
  }
  // Only what really differs from the preset (a value equal to the preset's is not an override)
  return Object.fromEntries(Object.entries(out).filter(([k, v]) => firstNum(values[k]) !== firstNum(v)))
}

/** Keys `printerOverrides` may write (cleared when the slot stops following the printer). */
export const PRINTER_KEYS = ['nozzle_temperature_range_low', 'nozzle_temperature_range_high', 'nozzle_temperature', 'nozzle_temperature_initial_layer', 'pressure_advance', 'enable_pressure_advance']

/** Does this scene slot still carry the printer's values for that spool? (drives the "From printer" badge) */
export function followsSpool(slot: { color: string; overrides?: Record<string, string> }, spool: CfsSlot): boolean {
  if (spool.color && slot.color.toLowerCase() !== spool.color.toLowerCase()) return false
  const o = slot.overrides ?? {}
  if (spool.pressureAdvance != null && 'pressure_advance' in o && firstNum(o.pressure_advance) !== Math.round(spool.pressureAdvance * 10000) / 10000) return false
  for (const key of ['nozzle_temperature', 'nozzle_temperature_initial_layer']) {
    const v = firstNum(o[key])
    if (v != null && spool.minTemp != null && spool.maxTemp != null && (v < spool.minTemp || v > spool.maxTemp)) return false
  }
  return true
}
