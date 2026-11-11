// Shared class strings and hooks of the Prepare tab (kept out of component files for fast refresh)
import { useEffect, useRef, type RefObject } from 'react'

export const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'

/** Floating glass card used for overlays on the 3D view. */
export const floatCls = 'rounded-2xl border border-line/80 bg-surface/90 shadow-lg shadow-black/[0.06] backdrop-blur-md dark:shadow-black/30'

export const menuCls = 'absolute z-40 min-w-48 rounded-xl border border-line bg-surface p-1.5 shadow-xl shadow-black/10 animate-[pop-in_.12s_ease-out] dark:shadow-black/40'

export const menuItemCls =
  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40'

/** Closes on outside click or Escape. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  const closeRef = useRef(close)
  useEffect(() => {
    closeRef.current = close
  }, [close])
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeRef.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeRef.current()
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, ref])
}


/**
 * Per-tool colours (toolbar): the icon is tinted at rest and the button fills with the colour while active, so a
 * tool change is visible at a glance. Full class strings so Tailwind keeps them.
 */
export const TONES = {
  sky: { idle: 'text-sky-600 dark:text-sky-400 hover:bg-sky-500/10', active: 'bg-sky-500 text-white shadow-sm shadow-sky-500/30' },
  violet: { idle: 'text-violet-600 dark:text-violet-400 hover:bg-violet-500/10', active: 'bg-violet-500 text-white shadow-sm shadow-violet-500/30' },
  blue: { idle: 'text-blue-600 dark:text-blue-400 hover:bg-blue-500/10', active: 'bg-blue-500 text-white shadow-sm shadow-blue-500/30' },
  emerald: { idle: 'text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10', active: 'bg-emerald-500 text-white shadow-sm shadow-emerald-500/30' },
  amber: { idle: 'text-amber-600 dark:text-amber-400 hover:bg-amber-500/10', active: 'bg-amber-500 text-white shadow-sm shadow-amber-500/30' },
  fuchsia: { idle: 'text-fuchsia-600 dark:text-fuchsia-400 hover:bg-fuchsia-500/10', active: 'bg-fuchsia-500 text-white shadow-sm shadow-fuchsia-500/30' },
  teal: { idle: 'text-teal-600 dark:text-teal-400 hover:bg-teal-500/10', active: 'bg-teal-500 text-white shadow-sm shadow-teal-500/30' },
  orange: { idle: 'text-orange-600 dark:text-orange-400 hover:bg-orange-500/10', active: 'bg-orange-500 text-white shadow-sm shadow-orange-500/30' },
  indigo: { idle: 'text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/10', active: 'bg-indigo-500 text-white shadow-sm shadow-indigo-500/30' },
  cyan: { idle: 'text-cyan-600 dark:text-cyan-400 hover:bg-cyan-500/10', active: 'bg-cyan-500 text-white shadow-sm shadow-cyan-500/30' },
  lime: { idle: 'text-lime-600 dark:text-lime-400 hover:bg-lime-500/10', active: 'bg-lime-500 text-white shadow-sm shadow-lime-500/30' },
  pink: { idle: 'text-pink-600 dark:text-pink-400 hover:bg-pink-500/10', active: 'bg-pink-500 text-white shadow-sm shadow-pink-500/30' },
  red: { idle: 'text-red-600 dark:text-red-400 hover:bg-red-500/10', active: 'bg-red-500 text-white shadow-sm shadow-red-500/30' },
} as const
export type Tone = keyof typeof TONES
