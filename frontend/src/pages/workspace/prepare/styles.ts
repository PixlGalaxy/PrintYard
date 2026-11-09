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

