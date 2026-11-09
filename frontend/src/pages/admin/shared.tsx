import type { ReactNode } from 'react'
import Card from '../../components/Card'
import { iconBadgeCls } from '../../components/styles'

/** Section card. `flush` drops the inner padding (tables, log viewers). */
export function Panel({
  title,
  icon,
  description,
  actions,
  children,
  flush,
}: {
  title: ReactNode
  icon?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  flush?: boolean
}) {
  if (!flush) {
    return (
      <Card title={title} icon={icon} description={description} actions={actions}>
        {children}
      </Card>
    )
  }
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-4 sm:px-5">
        {icon && <div className={iconBadgeCls}>{icon}</div>}
        <div className="min-w-40 flex-1">
          <h2 className="font-semibold">{title}</h2>
          {description && <p className="text-xs text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  )
}
