import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export interface MenuItem {
  key: string
  icon: ReactNode
  label: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}

/** Floating menu at a point, clamped to the viewport (WebinCloud's FileContextMenu pattern). */
export default function FileMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ x: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), y: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) })
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [x, y])

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
        const i = btns.indexOf(document.activeElement as HTMLButtonElement)
        btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.focus()
      }
    }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-50 w-60 overflow-hidden rounded-xl border border-line bg-surface py-1.5 shadow-xl shadow-black/10 animate-[pop-in_.12s_ease-out]"
    >
      {items.map((it) =>
        it.key.startsWith('sep') ? (
          <span key={it.key} className="my-1.5 block h-px bg-line" />
        ) : (
          <button
            key={it.key}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              it.onClick()
              onClose()
            }}
            className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm transition-colors focus-visible:outline-none disabled:opacity-40 ${
              it.danger
                ? 'text-rose-600 hover:bg-rose-50 focus-visible:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10 dark:focus-visible:bg-rose-500/10'
                : 'hover:bg-surface-2 focus-visible:bg-surface-2'
            }`}
          >
            {it.icon}
            {it.label}
          </button>
        ),
      )}
    </div>
  )
}
