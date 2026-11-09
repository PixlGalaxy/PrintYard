import { Clock, Cpu, Database, FolderTree, HardDrive, MemoryStick, Server, Tag } from 'lucide-react'
import { useCallback, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { adminApi, isUnauthorized } from '../../api'
import { Callout, Chip, ErrorState, Loading, Meter, StatTile } from '../../components/ui'
import { useToast } from '../../context/ToastContext'
import { usePolling } from '../../hooks'
import { useI18n } from '../../i18n/I18nContext'
import type { AdminSystem } from '../../types'
import { formatBytes, formatDuration } from '../../validation'
import { Panel } from './shared'

export default function DashboardSection() {
  const { t } = useI18n()
  const { onError } = useToast()
  const [data, setData] = useState<AdminSystem | null>(null)
  const [error, setError] = useState<unknown>(null)

  const load = useCallback(async () => {
    try {
      setData(await adminApi.system())
      setError(null)
    } catch (err) {
      if (isUnauthorized(err)) onError(err)
      setError(err)
    }
  }, [onError])
  usePolling(load, 10_000)

  if (error && !data) return <ErrorState error={error} onRetry={() => void load()} />
  if (!data) return <Loading />

  const { memory } = data
  const memPct = memory.limitBytes ? (memory.rss / memory.limitBytes) * 100 : null

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile icon={<Tag size={18} />} tone="text-sky-500 bg-sky-500/10" value={data.version} label={t('system.version')} />
        <StatTile icon={<Clock size={18} />} tone="text-emerald-500 bg-emerald-500/10" value={formatDuration(data.uptimeSec)} label={t('system.uptime')} />
        <StatTile
          icon={<MemoryStick size={18} />}
          tone={memory.ok ? 'text-violet-500 bg-violet-500/10' : 'text-amber-500 bg-amber-500/10'}
          value={formatBytes(memory.rss)}
          label={t('system.memory')}
          highlight={!memory.ok}
        />
        <StatTile icon={<Database size={18} />} tone="text-zinc-500 bg-zinc-500/10" value={formatBytes(data.dbSizeBytes)} label={t('system.db')} />
      </div>

      {!memory.ok && <Callout tone="warning" title={t('setup.memoryWarningTitle')}>{t('system.memoryLow', { limit: formatBytes(memory.limitBytes) })}</Callout>}

      {data.proxyHeadersSeen && (
        <Callout tone="warning" title={t('system.proxyTitle')}>
          {t('system.proxyDesc')}{' '}
          <Link to="/admin?section=settings" className="font-semibold underline underline-offset-2">
            {t('system.proxyAction')}
          </Link>
        </Callout>
      )}

      <Panel title={t('system.title')} description={t('system.desc')} icon={<Server size={18} />}>
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">{t('system.memoryLimit')}</span>
            <span className="font-mono text-xs text-muted">
              {formatBytes(memory.rss)} / {memory.limitBytes ? formatBytes(memory.limitBytes) : t('system.memoryUnlimited')}
            </span>
          </div>
          {memPct !== null && <Meter value={memPct} />}
        </div>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Row icon={<MemoryStick size={14} />} label={t('system.heap')} value={formatBytes(memory.heapUsed)} />
          <Row icon={<Server size={14} />} label={t('system.node')} value={data.node} />
          <Row
            icon={<Cpu size={14} />}
            label={t('system.engine')}
            value={`${t(data.engine.selected === 'orca' ? 'engine.orca' : 'engine.creality')} · ${data.engine.installedVersion ?? '—'}`}
          />
        </dl>
      </Panel>

      <Panel title={t('system.paths')} icon={<FolderTree size={18} />}>
        <dl className="space-y-3 text-sm">
          <Row icon={<HardDrive size={14} />} label={t('system.appdata')} value={<Chip className="text-fg">{data.appdataRoot}</Chip>} />
          <Row icon={<HardDrive size={14} />} label={t('system.data')} value={<Chip className="text-fg">{data.dataRoot}</Chip>} />
        </dl>
      </Panel>
    </div>
  )
}

function Row({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="flex items-center gap-2 text-muted">
        {icon}
        {label}
      </dt>
      <dd className="min-w-0 truncate text-right">{value}</dd>
    </div>
  )
}
