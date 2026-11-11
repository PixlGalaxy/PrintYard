import { Download, RefreshCw, ScrollText, Search } from 'lucide-react'
import { useCallback, useState } from 'react'
import { adminApi, isUnauthorized } from '../../api'
import { inputCls, selectCls } from '../../components/styles'
import { Button, ErrorState, Loading, Toggle } from '../../components/ui'
import { useToast } from '../../context/ToastContext'
import { usePolling } from '../../hooks'
import { useI18n } from '../../i18n/I18nContext'
import type { LogLevel, LogLine } from '../../types'
import { Panel } from './shared'

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']
const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

const LEVEL_STYLE: Record<LogLevel, string> = {
  debug: 'text-zinc-400',
  info: 'text-zinc-200',
  warn: 'text-amber-300',
  error: 'text-red-300',
}

const pad = (n: number) => String(n).padStart(2, '0')
const formatTime = (ts: number | string) => {
  const d = new Date(ts)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export default function LogsSection() {
  const { t } = useI18n()
  const { onError } = useToast()
  const [lines, setLines] = useState<LogLine[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [minLevel, setMinLevel] = useState<LogLevel | ''>('')
  const [query, setQuery] = useState('')
  const [auto, setAuto] = useState(true)

  const load = useCallback(async () => {
    try {
      const { lines: next } = await adminApi.logs(500)
      // The API returns oldest first; show newest first
      setLines([...next].reverse())
      setError(null)
    } catch (err) {
      if (isUnauthorized(err)) onError(err)
      setError(err)
    }
  }, [onError])
  usePolling(load, auto ? 3000 : 0)

  const q = query.trim().toLowerCase()
  const shown = (lines ?? []).filter(
    (l) =>
      (!minLevel || LEVEL_RANK[l.level] >= LEVEL_RANK[minLevel]) &&
      (!q || l.msg.toLowerCase().includes(q) || l.channel.toLowerCase().includes(q)),
  )

  function download() {
    const text = [...shown]
      .reverse()
      .map((l) => `${new Date(l.ts).toISOString()} [${l.channel}] ${l.level.toUpperCase().padEnd(5)} ${l.msg}`)
      .join('\n')
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `slicedock-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.log`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Panel
      flush
      title={t('logs.title')}
      icon={<ScrollText size={18} />}
      description={t('logs.desc')}
      actions={
        <label className="flex items-center gap-2 text-xs font-medium text-muted">
          <Toggle checked={auto} onChange={setAuto} label={t('logs.autoRefresh')} />
          {t('logs.autoRefresh')}
        </label>
      }
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <select
          aria-label={t('logs.allLevels')}
          className={`${selectCls} h-8! w-36! text-xs`}
          value={minLevel}
          onChange={(e) => setMinLevel(e.target.value as LogLevel | '')}
        >
          <option value="">{t('logs.allLevels')}</option>
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {t(`logs.level.${l}`)}
            </option>
          ))}
        </select>
        <div className="relative w-full sm:w-56">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
          <input
            aria-label={t('logs.search')}
            placeholder={t('logs.search')}
            className={`${inputCls} h-8! pl-8! text-xs`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="ml-auto flex gap-2">
          <Button size="xs" icon={<RefreshCw size={12} />} onClick={() => void load()}>
            {t('common.refresh')}
          </Button>
          <Button size="xs" icon={<Download size={12} />} onClick={download} disabled={!shown.length}>
            {t('common.download')}
          </Button>
        </div>
      </div>

      <div className="max-h-[65dvh] min-h-64 overflow-auto bg-[#0b0e14] py-2 font-mono text-[12px] leading-[1.55]">
        {error && !lines ? (
          <div className="text-zinc-300">
            <ErrorState error={error} onRetry={() => void load()} />
          </div>
        ) : !lines ? (
          <Loading />
        ) : shown.length === 0 ? (
          <p className="px-4 py-6 text-zinc-500">{lines.length ? t('logs.emptyFiltered') : t('logs.empty')}</p>
        ) : (
          shown.map((l, i) => (
            <div key={`${l.ts}-${i}`} className="flex gap-3 px-4 py-0.5 hover:bg-white/[0.03] max-sm:flex-wrap max-sm:gap-y-0.5 max-sm:py-1.5">
              <span className="shrink-0 text-zinc-500 select-none" title={new Date(l.ts).toISOString()}>
                {formatTime(l.ts)}
              </span>
              <span className="h-fit w-16 shrink-0 truncate rounded bg-sky-500/20 px-1 text-center text-[10px] font-semibold text-sky-300 uppercase">
                {l.channel}
              </span>
              <span className={`w-10 shrink-0 font-semibold uppercase ${LEVEL_STYLE[l.level] ?? 'text-zinc-200'}`}>{l.level}</span>
              <span className={`min-w-0 flex-1 break-all whitespace-pre-wrap max-sm:basis-full ${LEVEL_STYLE[l.level] ?? 'text-zinc-200'}`}>
                {l.msg}
              </span>
            </div>
          ))
        )}
      </div>
    </Panel>
  )
}
