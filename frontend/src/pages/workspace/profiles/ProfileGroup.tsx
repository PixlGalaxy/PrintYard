import type { ReactNode } from 'react'

/** A titled list group of the Profiles tab (sticky header with a count, optional action on the right). */
export default function Group({ title, count, action, children }: { title: string; count: number; action?: ReactNode; children: ReactNode }) {
  return (
    <div role="group" aria-label={title}>
      <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-line/70 bg-surface/95 px-3 pt-2.5 pb-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase backdrop-blur">
        {title}
        <span className="rounded-full bg-surface-2 px-1.5 text-[10px] font-semibold tabular-nums">{count}</span>
        {action}
      </div>
      <ul className="divide-y divide-line/60">{children}</ul>
    </div>
  )
}
