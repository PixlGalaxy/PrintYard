// Grouped list of setting rows with sticky group headers (icon, name, modified count). Groups keep the order of
// the option list (the bundle is in Creality's UI order). Each page's first group carries `data-page` so a page
// bar can scroll to it and follow the scroll position.
import type { ReactNode } from 'react'
import type { OptionDef } from '../../../../types'
import { groupOptions } from '../../../../workspace/settings/values'
import { groupIcon } from './icons'
import OptionRow, { type RowProps } from './OptionRow'

export interface OptionListProps {
  options: OptionDef[]
  row: (def: OptionDef) => Omit<RowProps, 'def'>
  /** page label shown in front of the group name (search results across pages) */
  pagePrefix?: (page: string) => string | undefined
  /** custom body for a group (e.g. the bed temperature table); return null to use rows */
  renderGroup?: (page: string, group: string, opts: OptionDef[]) => ReactNode | null
  /** header background (must be opaque: headers are sticky) */
  headerCls?: string
}

export default function OptionList({ options, row, pagePrefix, renderGroup, headerCls = 'bg-surface' }: OptionListProps) {
  const seenPages = new Set<string>()
  return (
    <>
      {groupOptions(options).map(({ page, group, opts }) => {
        const Icon = groupIcon(page, group)
        const firstOfPage = !seenPages.has(page)
        seenPages.add(page)
        const rows = opts.map((o) => ({ o, p: row(o) }))
        const modified = rows.filter((r) => r.p.changed).length
        const prefix = pagePrefix?.(page)
        const custom = renderGroup?.(page, group, opts)
        return (
          <section key={`${page}/${group}`} data-page={firstOfPage ? page : undefined} className="scroll-mt-1">
            <h3 className={`sticky top-0 z-10 -mx-1 flex items-center gap-2 border-b border-line/70 px-1 pt-2.5 pb-1.5 text-[11px] font-semibold tracking-wide text-muted ${headerCls}`}>
              <span className="flex size-5 items-center justify-center rounded-md bg-accent-500/10 text-accent-500">
                <Icon size={12} />
              </span>
              <span className="min-w-0 flex-1 truncate">
                {prefix && <span className="font-normal text-muted/80">{prefix} · </span>}
                {group}
              </span>
              {modified > 0 && <span className="rounded-full bg-accent-500/12 px-1.5 text-[10px] font-semibold text-accent-600 tabular-nums dark:text-accent-300">{modified}</span>}
            </h3>
            {custom ?? (
              <div className="divide-y divide-line/50">
                {rows.map(({ o, p }) => (
                  <OptionRow key={o.key} def={o} {...p} />
                ))}
              </div>
            )}
          </section>
        )
      })}
    </>
  )
}
