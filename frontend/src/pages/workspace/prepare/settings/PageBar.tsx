// Page chips above a settings list: click jumps to the page's first group, the chip of the page in view is
// highlighted while scrolling, and a dot marks pages with changes.
import { Ellipsis } from 'lucide-react'
import { Tip } from '../bits'
import { PAGE_ICONS } from './icons'

export default function PageBar({
  pages,
  active,
  onPick,
  label,
  changed,
}: {
  pages: string[]
  active: string | null
  onPick: (page: string) => void
  label: (page: string) => string
  changed: (page: string) => boolean
}) {
  return (
    <div className="flex gap-0.5 overflow-x-auto rounded-lg [scrollbar-width:none]" role="tablist">
      {pages.map((p) => {
        const Icon = PAGE_ICONS[p] ?? Ellipsis
        const on = p === active
        return (
          <Tip key={p} label={label(p)} side="bottom">
            <button
              type="button"
              role="tab"
              aria-selected={on}
              aria-label={label(p)}
              onClick={() => onPick(p)}
              className={`relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition-colors ${on ? 'bg-accent-500/12 text-accent-600 dark:text-accent-400' : 'text-muted hover:bg-surface-2 hover:text-fg'}`}
            >
              <Icon size={14} />
              {on && <span className="whitespace-nowrap">{label(p)}</span>}
              {changed(p) && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-accent-500" />}
            </button>
          </Tip>
        )
      })}
    </div>
  )
}
