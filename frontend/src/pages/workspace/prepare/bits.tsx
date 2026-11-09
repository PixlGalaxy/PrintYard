// Small building blocks of the Prepare tab: tooltip, keycap, popover, floating card, tool button.
import type { ReactNode } from 'react'

const SIDES = {
  bottom: 'top-full left-1/2 mt-2 -translate-x-1/2',
  top: 'bottom-full left-1/2 mb-2 -translate-x-1/2',
  left: 'right-full top-1/2 mr-2 -translate-y-1/2',
  right: 'left-full top-1/2 ml-2 -translate-y-1/2',
}

/** Hover/focus tooltip with an optional hotkey. Purely CSS, so it never re-renders the 3D view. */
export function Tip({
  label,
  hotkey,
  side = 'bottom',
  children,
  className = '',
}: {
  label: ReactNode
  hotkey?: string
  side?: keyof typeof SIDES
  children: ReactNode
  className?: string
}) {
  return (
    <span className={`group/tip relative inline-flex ${className}`}>
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute z-50 flex items-center gap-2 rounded-lg border border-line bg-surface px-2 py-1 text-xs font-medium whitespace-nowrap text-fg opacity-0 shadow-lg shadow-black/10 transition-opacity duration-150 group-hover/tip:opacity-100 group-hover/tip:delay-300 group-has-[:focus-visible]/tip:opacity-100 ${SIDES[side]}`}
      >
        {label}
        {hotkey && <Kbd>{hotkey}</Kbd>}
      </span>
    </span>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-line bg-surface-2 px-1 font-mono text-[10px] font-medium text-muted shadow-[inset_0_-1px_0] shadow-line">
      {children}
    </kbd>
  )
}

/** Square toolbar button. */
export function ToolButton({
  label,
  hotkey,
  active,
  disabled,
  onClick,
  children,
  side,
  badge,
}: {
  label: string
  hotkey?: string
  active?: boolean
  disabled?: boolean
  onClick?: () => void
  children: ReactNode
  side?: keyof typeof SIDES
  badge?: ReactNode
}) {
  return (
    <Tip label={label} hotkey={hotkey} side={side}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
        className={`relative inline-flex size-8 items-center justify-center rounded-xl transition-all duration-150 focus-visible:outline-2 focus-visible:outline-accent-500 disabled:pointer-events-none disabled:opacity-35 ${
          active
            ? 'bg-accent-500 text-white shadow-sm shadow-accent-500/30'
            : 'text-muted hover:bg-surface-2 hover:text-fg active:scale-95'
        }`}
      >
        {children}
        {badge}
      </button>
    </Tip>
  )
}

export function Divider() {
  return <span aria-hidden className="mx-0.5 h-6 w-px shrink-0 bg-line" />
}

/** Collapsible panel section with a title row. */
export function Section({
  title,
  icon,
  actions,
  children,
  className = '',
}: {
  title: ReactNode
  icon?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`border-b border-line px-3.5 py-3 ${className}`}>
      <div className="mb-2.5 flex min-h-7 items-center gap-2">
        {icon && <span className="flex size-6 items-center justify-center rounded-lg bg-accent-500/10 text-accent-500">{icon}</span>}
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  )
}
