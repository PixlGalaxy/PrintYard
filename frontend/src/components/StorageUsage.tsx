import { HardDrive } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { useI18n } from '../i18n/I18nContext'
import { formatBytes } from '../validation'
import { Meter } from './ui'

/**
 * Storage used by the signed-in user's files vs their quota (`GET /api/usage/me`). `refreshKey` re-fetches (e.g.
 * after uploads or deletes). Renders nothing until loaded or when the server does not report storage.
 */
export default function StorageUsage({ refreshKey, compact = false }: { refreshKey?: unknown; compact?: boolean }) {
  const { t } = useI18n()
  const [usage, setUsage] = useState<{ used: number; quota: number | null } | null>(null)

  useEffect(() => {
    let alive = true
    api.usage().then(
      (u) => alive && typeof u.storageBytes === 'number' && setUsage({ used: u.storageBytes, quota: u.storageQuotaBytes ?? null }),
      () => undefined,
    )
    return () => {
      alive = false
    }
  }, [refreshKey])

  if (!usage) return null
  const pct = usage.quota ? (usage.used / usage.quota) * 100 : 0
  const label = usage.quota
    ? t('storage.used', { used: formatBytes(usage.used), quota: formatBytes(usage.quota) })
    : t('storage.unlimited', { used: formatBytes(usage.used) })
  return (
    <div className={compact ? 'space-y-1.5' : 'space-y-1.5 rounded-2xl border border-line bg-surface px-4 py-3 shadow-sm'}>
      <div className="flex items-center gap-2 text-sm">
        <HardDrive size={16} className="text-accent-500" />
        <span className="font-medium">{t('storage.title')}</span>
        <span className="ml-auto font-mono text-xs text-muted tabular-nums">{label}</span>
      </div>
      {usage.quota != null && <Meter value={pct} />}
      {usage.quota != null && pct >= 90 && <p className="text-xs text-amber-600 dark:text-amber-400">{t('storage.almostFull')}</p>}
    </div>
  )
}
