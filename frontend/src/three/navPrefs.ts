import type { Nav3dPrefs } from '../types'

/** The signed-in user's 3D navigation prefs, readable outside React (no three.js import: safe for the main bundle). */
let current: Nav3dPrefs | null = null
const listeners = new Set<(p: Nav3dPrefs | null) => void>()

export function setNavPrefs(p: Nav3dPrefs | null | undefined) {
  const next = p ?? null
  if (JSON.stringify(next) === JSON.stringify(current)) return
  current = next
  for (const l of listeners) l(current)
}

export const getNavPrefs = () => current

export function onNavPrefs(cb: (p: Nav3dPrefs | null) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

