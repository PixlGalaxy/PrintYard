import { Activity, Network, Plus } from 'lucide-react'
import { PrinterLayers, PrinterModelIcon } from '../components/printerIcons'
import { Link } from 'react-router'
import { api } from '../api'
import PageHeader from '../components/PageHeader'
import { Badge, Chip, Empty, ErrorState, Loading } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useLoader } from '../hooks'
import { printerModelName, timeAgo } from '../format'
import { useI18n } from '../i18n/I18nContext'
import type { Printer } from '../types'

export default function DashboardPage() {
  const { user } = useAuth()
  const { t } = useI18n()
  const { data: printers, error, reload: load } = useLoader(api.printers)

  const isAdmin = user?.role === 'admin'

  return (
    <div className="space-y-5">
      <PageHeader title={t('dashboard.welcome', { name: user?.username ?? '' })} subtitle={t('dashboard.subtitle')} />

      {error ? (
        <div className="rounded-2xl border border-line bg-surface shadow-sm">
          <ErrorState error={error} onRetry={() => void load()} />
        </div>
      ) : !printers ? (
        <Loading />
      ) : printers.length === 0 ? (
        <div className="rounded-2xl border border-line bg-surface shadow-sm">
          <Empty
            icon={<PrinterLayers size={20} />}
            action={
              isAdmin ? (
                <Link
                  to="/admin?section=printers"
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-sky-600 px-3 text-sm font-medium text-white shadow-sm shadow-sky-600/25 hover:bg-sky-500"
                >
                  <Plus size={14} />
                  {t('dashboard.addPrinter')}
                </Link>
              ) : undefined
            }
          >
            {t('dashboard.noPrinters')} {!isAdmin && t('dashboard.askAdmin')}
          </Empty>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {printers.map((p) => (
            <PrinterCard key={p.id} printer={p} />
          ))}
        </div>
      )}
    </div>
  )
}

function PrinterCard({ printer }: { printer: Printer }) {
  const { t } = useI18n()
  return (
    <article className="flex flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-sm animate-[pop-in_.2s_ease-out]">
      <div className="flex items-center gap-3 border-b border-line px-4 py-4 sm:px-5">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-sky-500/10 text-sky-500">
          <PrinterModelIcon size={20} kinematics={printer.kinematics} model={printer.model} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold">{printer.name}</h2>
          <p className="truncate text-xs text-muted">{printerModelName(printer.model)}</p>
        </div>
        <Badge tone={printer.staticIp ? 'sky' : 'violet'}>{t(printer.staticIp ? 'printer.static' : 'printer.dynamic')}</Badge>
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Network size={14} className="text-muted" aria-hidden />
          <span className="font-mono text-xs">{printer.host}</span>
          {printer.mac && <Chip>{printer.mac}</Chip>}
        </div>
        <p className="text-xs text-muted">
          {t('printer.lastSeen')}: {timeAgo(t, printer.lastSeenAt)}
        </p>
        {/* Placeholder for live status (Phase 2) */}
        <div className="mt-auto flex items-center gap-2.5 rounded-xl border border-dashed border-line bg-surface-2/60 px-3.5 py-3 text-xs text-muted">
          <Activity size={16} className="shrink-0 text-sky-500" />
          {t('printer.liveSoon')}
        </div>
      </div>
    </article>
  )
}
