// Printer/process/filament presets for the workspace: the profile bundle (with option metadata) and
// resolved (flattened) preset values, cached per session.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { api } from '../api'
import type { PresetSummary, PrinterModel, ProfileBundle, ResolvedPreset, SceneDoc } from '../types'
import { workspace } from './store'

const bundles = new Map<string, Promise<ProfileBundle>>()
const presets = new Map<string, Promise<ResolvedPreset>>()
const resolved = new Map<string, ResolvedPreset>()

// Custom filament presets change at runtime: CRUD calls invalidate() so bundles and custom presets reload.
let version = 0
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}
/** Bumps after custom filament presets changed; bundles and `custom:` presets are fetched again. */
export const useProfilesVersion = () => useSyncExternalStore(subscribe, () => version)

export function invalidateCustomFilaments() {
  bundles.clear()
  for (const key of [...presets.keys()]) {
    if (key.includes('|filament|custom:')) {
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

/** Fills presets the scene doesn't have yet (new scene, or a preset that no longer exists). Not an undo step. */
export function applyBundleDefaults(bundle: ProfileBundle) {
  const pick = (list: PresetSummary[], current: string) =>
    list.some((p) => p.id === current) ? current : (list.find((p) => p.isDefault) ?? list[0])?.id ?? current
  const defFilament = bundle.filament.find((p) => p.isDefault) ?? bundle.filament[0]
  workspace.update(
    (d): SceneDoc => {
      const machinePresetId = pick(bundle.machine, d.machinePresetId)
      const processPresetId = pick(bundle.process, d.processPresetId)
      const filaments = d.filaments.length
        ? d.filaments.map((f) => (bundle.filament.some((p) => p.id === f.presetId) || !defFilament ? f : { ...f, presetId: defFilament.id }))
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
}

/** "0.20mm Standard @Creality K2 SE 0.4 nozzle" → "0.20mm Standard" */
export const shortPresetName = (name: string) => name.replace(/\s*@.*$/, '')
