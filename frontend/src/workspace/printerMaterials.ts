// The printer's own filament list (WS `retMaterials`, read by the server). Only loaded when the user turned
// "Show printer filaments" on (User.showPrinterFilaments): while it is off nothing is requested at all.
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import type { PrinterMaterial, PrinterMaterialsView } from '../types'
import type { PresetDraft } from '../pages/workspace/prepare/FilamentPresetDialog'

/** Shared between the Profiles tab and the Prepare picker (the server caches too; this avoids refetching per mount) */
let cache: { at: number; view: PrinterMaterialsView } | null = null
const FRESH_MS = 60_000

export function usePrinterMaterials() {
  const { user } = useAuth()
  const enabled = !!user?.showPrinterFilaments
  const [view, setView] = useState<PrinterMaterialsView | null>(enabled ? (cache?.view ?? null) : null)
  const [error, setError] = useState<unknown>(null)
  const [refreshing, setRefreshing] = useState(false)

  const fetchView = useCallback(
    (refresh: boolean) =>
      api.printerMaterials(undefined, refresh).then(
        (v) => {
          cache = { at: Date.now(), view: v }
          setView(v)
          setError(null)
        },
        (err: unknown) => setError(err),
      ),
    [],
  )

  // Fetch when the list is turned on or the shared copy is stale
  useEffect(() => {
    if (!enabled) {
      cache = null
      return
    }
    if (cache && Date.now() - cache.at < FRESH_MS) return
    void fetchView(false)
  }, [enabled, fetchView])

  const refresh = async () => {
    setRefreshing(true)
    await fetchView(true)
    setRefreshing(false)
  }
  const loading = refreshing || (enabled && view === null && error == null)
  return { enabled, view: enabled ? view : null, materials: enabled ? (view?.materials ?? []) : [], error, loading, refresh }
}

/** "Duplicate as my filament": the create dialog prefilled with the printer's values (the server screens them again) */
export function draftFromMaterial(m: PrinterMaterial, name: string): PresetDraft | null {
  if (!m.systemPresetId) return null
  return {
    basePresetId: m.systemPresetId,
    name,
    values: m.values,
    filamentType: m.type || null,
    color: m.color,
    vendor: m.brand || null,
  }
}
