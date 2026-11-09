// Tiny UI store shared by the shell's project bar, the Prepare tab and its hotkeys (which dialog is open).
import { useSyncExternalStore } from 'react'

export interface PrepareUi {
  library: 'model' | 'project' | null
  help: boolean
  saveAs: boolean
  newConfirm: boolean
}

let ui: PrepareUi = { library: null, help: false, saveAs: false, newConfirm: false }
const listeners = new Set<() => void>()

export function setUi(patch: Partial<PrepareUi>) {
  ui = { ...ui, ...patch }
  for (const l of listeners) l()
}

export function usePrepareUi() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
    () => ui,
  )
}
