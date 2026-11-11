// User profiles (custom filament presets and process profiles, `custom:<id>` in scenes): list hooks and permission
// helpers.
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { FilamentPreset, PresetSummary, ProcessProfile, User } from '../types'
import { useProfilesVersion } from './profiles'

export const CUSTOM_PREFIX = 'custom:'
export const isCustomPresetId = (id: string) => id.startsWith(CUSTOM_PREFIX)
export const customRowId = (id: string) => (isCustomPresetId(id) ? Number(id.slice(CUSTOM_PREFIX.length)) || null : null)

/** Profiles are personal: the owner (or an admin) edits, renames, deletes and shares them; others duplicate */
export const canEditPreset = (p: Pick<PresetSummary, 'custom' | 'ownerId' | 'scope'> | null | undefined, user: User | null | undefined) =>
  !!p?.custom && !!user && (user.role === 'admin' || p.ownerId === user.id)

/** Presets of a list scope; reloads whenever custom presets change (invalidateCustomFilaments). */
export function useFilamentPresets(scope: 'usable' | 'mine' | 'shared' | 'everyone', enabled = true) {
  const v = useProfilesVersion()
  const [state, setState] = useState<{ data: FilamentPreset[] | null; error: unknown }>({ data: null, error: null })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    api.filamentPresets(scope).then(
      (data) => alive && setState({ data, error: null }),
      (error) => alive && setState((s) => ({ data: s.data, error })),
    )
    return () => {
      alive = false
    }
  }, [scope, enabled, v, attempt])
  const retry = useCallback(() => setAttempt((a) => a + 1), [])
  return { ...state, retry }
}

/** Process profiles of a list scope; reloads whenever profiles change (invalidateCustomFilaments). */
export function useProcessProfiles(scope: 'usable' | 'mine' | 'shared' | 'everyone', enabled = true) {
  const v = useProfilesVersion()
  const [state, setState] = useState<{ data: ProcessProfile[] | null; error: unknown }>({ data: null, error: null })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    api.processProfiles(scope).then(
      (data) => alive && setState({ data, error: null }),
      (error) => alive && setState((s) => ({ data: s.data, error })),
    )
    return () => {
      alive = false
    }
  }, [scope, enabled, v, attempt])
  const retry = useCallback(() => setAttempt((a) => a + 1), [])
  return { ...state, retry }
}

/** "Silk PLA" → "Silk PLA copy" (the server refuses duplicate names per owner) */
export const copyName = (name: string, suffix: string) => `${name} ${suffix}`.slice(0, 100)
