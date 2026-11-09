// Accent colours of the active skin for code that can't use CSS (three.js, SVG gradients): read from the computed
// `--accent-*` custom properties on <html> and re-read whenever ThemeContext changes the skin or the mode.
import { useSyncExternalStore } from 'react'

export type AccentShade = 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900
export type AccentPalette = Record<AccentShade, string>

const FALLBACK: AccentPalette = {
  50: '#f0f9ff', 100: '#e0f2fe', 200: '#bae6fd', 300: '#7dd3fc', 400: '#38bdf8',
  500: '#0ea5e9', 600: '#0284c7', 700: '#0369a1', 800: '#075985', 900: '#0c4a6e',
}
const SHADES = Object.keys(FALLBACK).map(Number) as AccentShade[]

function read(): AccentPalette {
  if (typeof document === 'undefined') return FALLBACK
  const cs = getComputedStyle(document.documentElement)
  const out = { ...FALLBACK }
  for (const s of SHADES) out[s] = cs.getPropertyValue(`--accent-${s}`).trim() || FALLBACK[s]
  return out
}

let current: AccentPalette = FALLBACK
let key = ''
const listeners = new Set<() => void>()
let observer: MutationObserver | null = null

function refresh() {
  const next = read()
  const k = SHADES.map((s) => next[s]).join()
  if (k === key) return
  key = k
  current = next
  for (const l of listeners) l()
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  if (!observer && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(refresh)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-skin', 'class', 'style'] })
    refresh()
  }
  return () => {
    listeners.delete(cb)
    if (!listeners.size && observer) {
      observer.disconnect()
      observer = null
    }
  }
}

function snapshot() {
  if (!key) refresh()
  return current
}

/** The skin's accent scale as hex strings; re-renders on skin/mode change. */
export function useAccent(): AccentPalette {
  return useSyncExternalStore(subscribe, snapshot, () => FALLBACK)
}

/** One-off read (e.g. outside React). */
export const accentNow = (shade: AccentShade = 500) => read()[shade]
