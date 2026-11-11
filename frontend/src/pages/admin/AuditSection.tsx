import { RefreshCw, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { adminApi } from '../../api'
import Avatar from '../../components/Avatar'
import { tdCls, thCls } from '../../components/styles'
import { Button, Chip, Empty, ErrorState, Loading } from '../../components/ui'
import { useToast } from '../../context/ToastContext'
import { timeAgo } from '../../format'
import { useLoader } from '../../hooks'
import { useI18n } from '../../i18n/I18nContext'
import { Panel } from './shared'

const PAGE = 100

const firstPage = async () => {
  const { items } = await adminApi.audit(PAGE)
  return { items, more: items.length === PAGE }
}

const ACTION_TONE = (action: string) =>
  /fail|delete|ban/i.test(action)
    ? 'text-red-600 dark:text-red-400'
    : /login|logout/i.test(action)
      ? 'text-sky-600 dark:text-sky-400'
      : 'text-fg'

function formatMeta(meta: unknown): string {
  if (meta == null || meta === '') return ''
  if (typeof meta === 'string') {
    try {
      return formatMeta(JSON.parse(meta))
    } catch {
      return meta
    }
  }
  if (typeof meta === 'object') {
    return Object.entries(meta as Record<string, unknown>)
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join(' ')
  }
  return String(meta)
}

export default function AuditSection() {
  const { t, formatDate } = useI18n()
  const { onError } = useToast()
  const { data, error, reload, setData } = useLoader(firstPage)
  const items = data?.items ?? null
  const more = data?.more ?? false
  const [loadingMore, setLoadingMore] = useState(false)
  const load = reload

  async function loadMore() {
    if (!items?.length) return
    setLoadingMore(true)
    try {
      const before = items[items.length - 1].id
      const { items: next } = await adminApi.audit(PAGE, before)
      setData({ items: [...items, ...next], more: next.length === PAGE })
    } catch (err) {
      onError(err)
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <Panel
      flush
      title={t('audit.title')}
      description={t('audit.desc')}
      icon={<ShieldCheck size={18} />}
      actions={
        <Button size="xs" icon={<RefreshCw size={12} />} onClick={() => void load()}>
          {t('common.refresh')}
        </Button>
      }
    >
      {error && !items ? (
        <ErrorState error={error} onRetry={() => void load()} />
      ) : !items ? (
        <Loading />
      ) : items.length === 0 ? (
        <Empty icon={<ShieldCheck size={20} />}>{t('audit.empty')}</Empty>
      ) : (
        <>
          <div className="relative overflow-x-auto px-4 sm:px-5">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th className={`${thCls} pt-3`}>{t('audit.when')}</th>
                  <th className={`${thCls} pt-3`}>{t('audit.user')}</th>
                  <th className={`${thCls} pt-3`}>{t('audit.action')}</th>
                  <th className={`${thCls} pt-3`}>{t('audit.target')}</th>
                  <th className={`${thCls} pt-3`}>{t('audit.ip')}</th>
                  <th className={`${thCls} pt-3`}>{t('audit.details')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((e) => {
                  const meta = formatMeta(e.meta)
                  return (
                    <tr key={e.id}>
                      <td className={`${tdCls} text-muted`} title={formatDate(e.createdAt)}>
                        {timeAgo(t, e.createdAt)}
                      </td>
                      <td className={tdCls}>
                        {e.username ? (
                          <span className="flex items-center gap-2">
                            <Avatar user={{ id: e.userId, username: e.username }} size={20} />
                            {e.username}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className={`${tdCls} font-mono text-xs font-medium ${ACTION_TONE(e.action)}`}>{e.action}</td>
                      <td className={`${tdCls} text-xs`}>{e.target ?? '—'}</td>
                      <td className={tdCls}>{e.ip ? <Chip>{e.ip.replace(/^::ffff:/, '')}</Chip> : '—'}</td>
                      <td className={`${tdCls} max-w-80 truncate font-mono text-xs text-muted`} title={meta}>
                        {meta || '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="flex justify-center border-t border-line px-4 py-3">
            {more ? (
              <Button size="sm" loading={loadingMore} onClick={() => void loadMore()}>
                {t('common.loadMore')}
              </Button>
            ) : (
              <p className="text-xs text-muted">{t('audit.end')}</p>
            )}
          </div>
        </>
      )}
    </Panel>
  )
}
