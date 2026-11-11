import { ChevronDown, CircleAlert, CircleCheck, Clock, RotateCcw, UploadCloud, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { IconButton } from '../../../components/ui'
import { useI18n } from '../../../i18n/I18nContext'
import { formatBytes } from '../../../validation'
import { useUploads } from './UploadContext'
import { ProgressBar, TransferStats } from '../../../components/TransferProgress'
import { etaOf } from '../../../components/transferEta'

/** A run that ended without errors disappears by itself after this long. */
const LINGER_MS = 12_000

/** Bottom-right card with the upload queue (collapsible list, totals, per-file progress/cancel/retry). */
export default function UploadTray() {
  const { t } = useI18n()
  const { items, running, cancel, retry, clear } = useUploads()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const shown = items.length > 0

  // Publish the tray's footprint (height + its 1rem offset) as --sd-tray-h so docked UI (Slice button, Preview
  // footer) can sit above it instead of being covered.
  useLayoutEffect(() => {
    const root = document.documentElement
    const el = box.current
    if (!shown || !el) {
      root.style.setProperty('--sd-tray-h', '0px')
      return
    }
    const set = () => root.style.setProperty('--sd-tray-h', `${Math.ceil(el.getBoundingClientRect().height) + 16}px`)
    set()
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => {
      ro.disconnect()
      root.style.setProperty('--sd-tray-h', '0px')
    }
  }, [shown])

  const done = items.filter((i) => i.status === 'done').length
  const failed = items.filter((i) => i.status === 'error').length
  const left = items.filter((i) => i.status === 'queued' || i.status === 'uploading').length
  const finishedClean = !running && items.length > 0 && failed === 0

  useEffect(() => {
    if (!finishedClean || open) return
    const timer = setTimeout(clear, LINGER_MS)
    return () => clearTimeout(timer)
  }, [finishedClean, open, clear])

  if (items.length === 0) return null

  const total = items.reduce((s, i) => s + i.file.size, 0) || 1
  const doneBytes = items.reduce((s, i) => s + (i.status === 'done' ? i.file.size : i.status === 'uploading' ? i.file.size * i.progress : 0), 0)
  const failedBytes = items.reduce((s, i) => s + (i.status === 'error' ? i.file.size : 0), 0)

  // While running, name the file in flight ("Uploading part.stl" / "Processing part.stl…") so it is clear at a glance
  const inFlight = items.filter((i) => i.status === 'uploading')
  const current = inFlight.find((i) => i.progress < 1) ?? inFlight[0] ?? items.find((i) => i.status === 'queued')
  const title = running
    ? left > 1
      ? t('upload.uploadingCount', { n: left })
      : current?.status === 'uploading' && current.progress >= 1
        ? t('upload.processingFile', { name: current.file.name })
        : current
          ? t('upload.uploadingFile', { name: current.file.name })
          : t('library.upload.uploading')
    : failed > 0
      ? t('library.upload.errors')
      : t('library.upload.done')

  return (
    <div
      ref={box}
      role="region"
      aria-label={t('library.upload.title')}
      className="fixed right-4 bottom-4 z-40 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-line bg-surface shadow-xl shadow-black/10 animate-[toast-in_.2s_ease-out]"
    >
      <div className="flex items-start gap-3 p-3.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-start gap-3 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-sky-500"
        >
          {finishedClean ? (
            <CircleCheck size={20} className="mt-0.5 shrink-0 text-emerald-500" />
          ) : failed > 0 && !running ? (
            <CircleAlert size={20} className="mt-0.5 shrink-0 text-red-500" />
          ) : (
            <UploadCloud size={20} className="mt-0.5 shrink-0 text-sky-500" />
          )}
          <div className="min-w-0 flex-1">
            <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium" title={title}>
              <span className="truncate">{title}</span>
              <ChevronDown size={14} className={`shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs font-medium">
              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <CircleCheck size={12} /> {t('library.upload.countDone', { n: done })}
              </span>
              {failed > 0 && (
                <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
                  <CircleAlert size={12} /> {t('library.upload.countFailed', { n: failed })}
                </span>
              )}
              {left > 0 && (
                <span className="inline-flex items-center gap-1 text-sky-600 dark:text-sky-400">
                  <Clock size={12} /> {t('library.upload.countLeft', { n: left })}
                </span>
              )}
            </div>
            <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-surface-2 ring-1 ring-line/60 ring-inset">
              <div className="h-full bg-sky-500 transition-[width] duration-300" style={{ width: `${(doneBytes / total) * 100}%` }} />
              <div className="h-full bg-red-500 transition-[width]" style={{ width: `${(failedBytes / total) * 100}%` }} />
            </div>
            {running && !open && current?.status === 'uploading' && current.progress < 1 && (
              <TransferStats className="mt-1" fraction={current.progress} total={current.file.size} speed={current.speed} etaSec={etaOf(current.file.size, current.progress * current.file.size, current.speed)} />
            )}
          </div>
        </button>
        {running ? (
          <IconButton label={t('library.upload.cancelAll')} tone="danger" onClick={() => cancel()}>
            <X size={16} />
          </IconButton>
        ) : (
          <IconButton label={t('common.close')} onClick={clear}>
            <X size={16} />
          </IconButton>
        )}
      </div>

      {open && (
        <ul className="max-h-72 divide-y divide-line overflow-auto border-t border-line">
          {items.map((it) => (
            <li key={it.id} className="flex items-center gap-3 px-3.5 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm" title={it.file.name}>
                  {it.file.name}
                </p>
                {it.status === 'uploading' ? (
                  <>
                    <ProgressBar className="mt-1" value={it.progress} indeterminate={it.progress >= 1} label={it.file.name} />
                    {it.progress >= 1 ? (
                      <p className="mt-0.5 text-[11px] text-muted">{t('upload.processing')}</p>
                    ) : (
                      <TransferStats className="mt-0.5" fraction={it.progress} total={it.file.size} speed={it.speed} etaSec={etaOf(it.file.size, it.progress * it.file.size, it.speed)} />
                    )}
                  </>
                ) : (
                  <p className={`text-xs ${it.status === 'error' ? 'text-red-600 dark:text-red-400' : 'text-muted'}`}>
                    {it.status === 'error' ? it.error : `${t(`library.upload.status.${it.status}`)} · ${formatBytes(it.file.size)}`}
                  </p>
                )}
              </div>
              {(it.status === 'uploading' || it.status === 'queued') && (
                <IconButton label={t('common.cancel')} tone="danger" onClick={() => cancel(it.id)}>
                  <X size={14} />
                </IconButton>
              )}
              {(it.status === 'error' || it.status === 'cancelled') && it.error !== undefined && it.status === 'error' && (
                <IconButton label={t('common.retry')} onClick={() => retry(it.id)}>
                  <RotateCcw size={14} />
                </IconButton>
              )}
              {it.status === 'cancelled' && (
                <IconButton label={t('common.retry')} onClick={() => retry(it.id)}>
                  <RotateCcw size={14} />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
