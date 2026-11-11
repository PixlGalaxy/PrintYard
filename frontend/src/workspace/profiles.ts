// Printer/process/filament presets for the workspace: the profile bundle (with option metadata) and
// resolved (flattened) preset values, cached per session.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { api } from '../api'
import type { PresetSummary, PrinterModel, ProfileBundle, ResolvedPreset, SceneDoc } from '../types'
import { workspace } from './store'

const bundles = new Map<string, Promise<ProfileBundle>>()
const presets = new Map<string, Promise<ResolvedPreset>>()
const resolved = new Map<string, ResolvedPreset>()

// User profiles (custom filaments, process profiles) change at runtime: CRUD calls invalidate() so bundles and custom
// presets reload.
let version = 0
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}
/** Bumps after user profiles changed; bundles and `custom:` presets are fetched again. */
export const useProfilesVersion = () => useSyncExternalStore(subscribe, () => version)

export function invalidateCustomFilaments() {
  bundles.clear()
  for (const key of [...presets.keys()]) {
    if (key.includes('|filament|custom:') || key.includes('|process|custom:')) {
      presets.delete(key)
      resolved.delete(key)
    }
  }
  version++
  for (const l of listeners) l()
}

export function loadBundle(model: PrinterModel, lang: string) {
  const key = `${model}|${lang}`
  let p = bundles.get(key)
  if (!p) {
    p = api.profiles(model, lang)
    p.catch(() => bundles.delete(key))
    bundles.set(key, p)
  }
  return p
}

export function loadPreset(model: PrinterModel, kind: PresetSummary['kind'], id: string) {
  const key = `${model}|${kind}|${id}`
  let p = presets.get(key)
  if (!p) {
    p = api.preset(model, kind, id).then((r) => {
      resolved.set(key, r)
      return r
    })
    p.catch(() => presets.delete(key))
    presets.set(key, p)
  }
  return p
}

export function useBundle(model: PrinterModel, lang: string) {
  const [state, setState] = useState<{ key: string; bundle: ProfileBundle | null; error: unknown }>({ key: '', bundle: null, error: null })
  const key = `${model}|${lang}`
  const [attempt, setAttempt] = useState(0)
  const v = useProfilesVersion()
  useEffect(() => {
    let alive = true
    loadBundle(model, lang).then(
      (bundle) => alive && setState({ key, bundle, error: null }),
      (error) => alive && setState({ key, bundle: null, error }),
    )
    return () => {
      alive = false
    }
  }, [model, lang, key, attempt, v])
  // Keep showing the previous language's bundle while the new one loads
  return { bundle: state.bundle, error: state.key === key ? state.error : null, retry: () => setAttempt((a) => a + 1) }
}

export function usePreset(model: PrinterModel, kind: PresetSummary['kind'], id: string | undefined): ResolvedPreset | null {
  const v = useProfilesVersion()
  const key = id ? `${model}|${kind}|${id}|${v}` : ''
  const [value, setValue] = useState<ResolvedPreset | null>(() => (id ? (resolved.get(`${model}|${kind}|${id}`) ?? null) : null))
  const [forKey, setForKey] = useState(key)
  if (forKey !== key) {
    setForKey(key)
    setValue(id ? (resolved.get(`${model}|${kind}|${id}`) ?? null) : null)
  }
  useEffect(() => {
    if (!id) return
    let alive = true
    loadPreset(model, kind, id).then(
      (r) => alive && setValue(r),
      () => undefined,
    )
    return () => {
      alive = false
    }
  }, [model, kind, id, v])
  return value
}

/** The user's "always used" presets (Profiles tab): process and slot-1 filament of new projects. */
export interface PresetDefaults {
  process?: string | null
  filament?: string | null
}

/** A user profile the scene uses that is gone (deleted or no longer shared) and the system preset used instead. */
export interface MissingPreset {
  kind: 'process' | 'filament'
  name: string
  fallback: string
}

// Parent + name of every user profile seen in a bundle, so a scene whose profile disappears falls back to its parent.
const PARENTS_KEY = 'sd:ws:profileParents'
type Parents = Record<string, { name: string; inherits: string }>
function readParents(): Parents {
  try {
    return (JSON.parse(localStorage.getItem(PARENTS_KEY) ?? '{}') as Parents) ?? {}
  } catch {
    return {}
  }
}
function rememberParents(bundle: ProfileBundle): Parents {
  const parents = readParents()
  let changed = false
  for (const p of [...bundle.process, ...bundle.filament]) {
    if (!p.custom || !p.inherits) continue
    const key = `${p.kind}|${p.id}`
    if (parents[key]?.inherits !== p.inherits || parents[key]?.name !== p.name) {
      parents[key] = { name: p.name, inherits: p.inherits }
      changed = true
    }
  }
  if (changed) {
    try {
      localStorage.setItem(PARENTS_KEY, JSON.stringify(parents))
    } catch {
      /* storage blocked: the bundle default is used instead */
    }
  }
  return parents
}

/**
 * Fills presets the scene doesn't have yet (new scene: the user's defaults, else the bundle's) and replaces presets
 * that no longer exist. A user profile that is gone falls back to its system parent and is reported. Not an undo step.
 */
export function applyBundleDefaults(bundle: ProfileBundle, defaults: PresetDefaults = {}): MissingPreset[] {
  const parents = rememberParents(bundle)
  const missing: MissingPreset[] = []
  const has = (list: PresetSummary[], id: string | null | undefined): id is string => !!id && list.some((p) => p.id === id)
  const bundleDefault = (list: PresetSummary[]) => (list.find((p) => p.isDefault && !p.custom) ?? list[0])?.id
  const replace = (kind: 'process' | 'filament', list: PresetSummary[], current: string, fallback: string | undefined) => {
    const parent = parents[`${kind}|${current}`]
    const to = parent && has(list, parent.inherits) ? parent.inherits : fallback
    if (to && current.startsWith('custom:')) missing.push({ kind, name: parent?.name ?? current, fallback: to })
    return to ?? current
  }
  const defProcess = has(bundle.process, defaults.process) ? defaults.process : bundleDefault(bundle.process)
  const defFilamentId = has(bundle.filament, defaults.filament) ? defaults.filament : bundleDefault(bundle.filament)
  const defFilament = bundle.filament.find((p) => p.id === defFilamentId)
  workspace.update(
    (d): SceneDoc => {
      missing.length = 0
      const machinePresetId = has(bundle.machine, d.machinePresetId) ? d.machinePresetId : (bundleDefault(bundle.machine) ?? d.machinePresetId)
      const processPresetId = has(bundle.process, d.processPresetId)
        ? d.processPresetId
        : d.processPresetId
          ? replace('process', bundle.process, d.processPresetId, defProcess)
          : (defProcess ?? d.processPresetId)
      const filaments = d.filaments.length
        ? d.filaments.map((f) => (has(bundle.filament, f.presetId) || !defFilament ? f : { ...f, presetId: replace('filament', bundle.filament, f.presetId, defFilament.id) }))
        : defFilament
          ? [{ slot: 1, presetId: defFilament.id, color: defFilament.color ?? '#7DD3FC' }]
          : []
      const changed =
        machinePresetId !== d.machinePresetId ||
        processPresetId !== d.processPresetId ||
        filaments.length !== d.filaments.length ||
        filaments.some((f, i) => f !== d.filaments[i])
      return changed ? { ...d, machinePresetId, processPresetId, filaments, printerModel: bundle.printerModel } : d
    },
    { history: false, dirty: false },
  )
  return missing
}

export type PresetGroup = 'system' | 'mine' | 'shared'
const GROUP_LABEL = { system: 'profiles.group.system', mine: 'profiles.group.mine', shared: 'profiles.group.shared' } as const

/** Preset list split as Prepare shows it: system presets / my profiles / shared by others (empty groups left out). */
export function groupPresets(list: PresetSummary[], userId: number | undefined) {
  const groupOf = (p: PresetSummary): PresetGroup => (!p.custom ? 'system' : p.ownerId === userId ? 'mine' : 'shared')
  return (['system', 'mine', 'shared'] as const)
    .map((group) => ({ group, label: GROUP_LABEL[group], presets: list.filter((p) => groupOf(p) === group) }))
    .filter((g) => g.presets.length > 0)
}

/** "0.20mm Standard @Creality K2 SE 0.4 nozzle" → "0.20mm Standard" */
export const shortPresetName = (name: string) => name.replace(/\s*@.*$/, '')
