import { CircleAlert, CircleCheck, ChevronDown, Eye, LoaderCircle, Slice, X } from 'lucide-react'
import { useRef, useState, useSyncExternalStore } from 'react'
import { ApiError } from '../../../api'
import { useI18n } from '../../../i18n/I18nContext'
import { isTranslationKey, type TranslationKey } from '../../../i18n/translations'
import type { SceneDoc, SliceJob } from '../../../types'
import { meshes } from '../../../workspace/meshes'
import { outsideObjects } from '../../../workspace/ops'
import { runProgress, slicing, useSlicing } from '../../../workspace/slicing'
import { useWs } from '../../../workspace/store'
import { floatCls, menuCls, menuItemCls, useDismiss } from './styles'

/** Why a plate can't be sliced right now (i18n key), or null. */
function blocker(doc: SceneDoc, plate: number): TranslationKey | null {
  const objs = doc.objects.filter((o) => o.plate === plate)
  if (!doc.processPresetId || !doc.filaments.length) return 'slice.block.presets'
  if (!objs.length) return 'slice.block.empty'
  if (objs.some((o) => o.fileId <= 0)) return 'slice.block.uploading'
  if (objs.some((o) => !meshes.info(o.fileId))) return 'slice.block.loading'
  if (outsideObjects(doc, plate).length) return 'slice.block.outside'
  return null
}

const STATE_KEYS: Record<SliceJob['state'], TranslationKey> = {
  queued: 'slice.state.queued',
  preparing: 'slice.state.preparing',
  slicing: 'slice.state.slicing',
  postprocessing: 'slice.state.postprocessing',
  done: 'slice.state.done',
  failed: 'slice.state.failed',
  cancelled: 'slice.state.cancelled',
}

export default function SliceControls({ onOpenPreview }: { onOpenPreview: (fileId: number) => void }) {
  const { t, errorMessage } = useI18n()
  const doc = useWs((s) => s.doc)
  const active = useWs((s) => s.activePlate)
  useSyncExternalStore(meshes.subscribe, () => meshes.version)
  const run = useSlicing()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, open, () => setOpen(false))

  const block = blocker(doc, active)
  const slicablePlates = doc.plates.map((_, i) => i).filter((i) => doc.objects.some((o) => o.plate === i))
  const allBlock = slicablePlates.length ? slicablePlates.map((i) => blocker(doc, i)).find(Boolean) ?? null : 'slice.block.empty'
  const busy = !!run && !run.finished

  const start = (plates: number[]) => {
    setOpen(false)
    void slicing.start(doc, plates)
  }

  // A failed job's `error` is the backend error code (e.g. projects.build_timeout): translate it when known
  const jobError = (code: string | undefined) => {
    const key = `errors.${code}`
    return code ? (isTranslationKey(key) ? t(key) : code) : t(STATE_KEYS.failed)
  }
  const runError = run?.error
  // Stage of the plate being sliced right now (B1 `SliceJob.stage`)
  const stage = run && !run.finished ? run.plates.map((p) => run.jobs[p]).find((j) => j && !['done', 'failed', 'cancelled'].includes(j.state))?.stage : undefined
  const engineMissing = runError instanceof ApiError && runError.code === 'engine.not_installed'

  return (
    <div className="flex flex-col items-end gap-2">
      {run && (
        <div className={`${floatCls} w-80 p-3.5 animate-[pop-in_.18s_ease-out]`} role="status" aria-live="polite">
          <div className="flex items-center gap-2">
            {run.error || run.plates.some((p) => run.jobs[p]?.state === 'failed') ? (
              <CircleAlert size={16} className="shrink-0 text-red-500" />
            ) : run.finished ? (
              <CircleCheck size={16} className="shrink-0 text-emerald-500" />
            ) : (
              <LoaderCircle size={16} className="shrink-0 animate-spin text-accent-500" />
            )}
            <p className="min-w-0 flex-1 truncate text-[13px] font-semibold">
              {run.error ? t('slice.failedTitle') : run.finished ? t('slice.doneTitle') : t('slice.runningTitle', { n: run.plates.length })}
            </p>
            {run.finished ? (
              <button type="button" aria-label={t('common.dismiss')} onClick={() => slicing.dismiss()} className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg">
                <X size={14} />
              </button>
            ) : (
              <button type="button" onClick={() => void slicing.cancel()} className="rounded-md px-2 py-0.5 text-xs font-medium text-muted hover:bg-red-500/10 hover:text-red-500">
                {t('common.cancel')}
              </button>
            )}
          </div>
          {run.error ? (
            <p className="mt-2 text-xs text-red-600 dark:text-red-400">{engineMissing ? t('slice.engineMissing') : errorMessage(run.error)}</p>
          ) : (
            <>
              {!run.finished && (
                <>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2">
                    <div className="h-full rounded-full bg-accent-500 transition-[width] duration-700 ease-out" style={{ width: `${Math.max(3, runProgress(run))}%` }} />
                  </div>
                  {stage && (
                    <p key={stage} className="mt-1.5 truncate text-[11px] text-muted animate-[fade-in_.2s_ease-out]">
                      {t(`slice.stage.${stage}`)}
                    </p>
                  )}
                </>
              )}
              <ul className="mt-2.5 space-y-1.5">
                {run.plates.map((p) => {
                  const job = run.jobs[p]
                  return (
                    <li key={p} className="flex items-center gap-2 text-xs">
                      <span className="w-16 shrink-0 text-muted">{t('workspace.plate.name', { n: p + 1 })}</span>
                      <span className="min-w-0 flex-1 truncate">
                        {job ? (job.state === 'failed' ? jobError(job.error) : `${t(STATE_KEYS[job.state])}${job.state === 'slicing' ? ` · ${Math.round(job.progress)} %` : ''}`) : t('slice.state.sending')}
                        {job?.message && job.state !== 'done' && job.state !== 'failed' && <span className="text-muted"> · {job.message}</span>}
                      </span>
                      {job?.state === 'done' && job.result && (
                        <button
                          type="button"
                          onClick={() => onOpenPreview(job.result!.fileId)}
                          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-accent-600 hover:bg-accent-500/10 dark:text-accent-400"
                        >
                          <Eye size={13} />
                          {t('slice.preview')}
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </div>
      )}

      <div ref={ref} className="relative flex">
        <button
          type="button"
          disabled={!!block || busy}
          title={block ? t(block) : undefined}
          onClick={() => start([active])}
          className="inline-flex h-11 items-center gap-2 rounded-l-2xl bg-accent-600 pr-4 pl-4 text-sm font-semibold text-white shadow-lg shadow-accent-600/30 transition-all hover:bg-accent-500 active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-accent-600/50 disabled:shadow-none"
        >
          {busy ? <LoaderCircle size={17} className="animate-spin" /> : <Slice size={17} />}
          {t('slice.plate', { n: active + 1 })}
        </button>
        <button
          type="button"
          aria-label={t('slice.more')}
          aria-expanded={open}
          disabled={busy}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex h-11 w-9 items-center justify-center rounded-r-2xl border-l border-white/20 bg-accent-600 text-white shadow-lg shadow-accent-600/30 hover:bg-accent-500 disabled:bg-accent-600/50 disabled:shadow-none"
        >
          <ChevronDown size={16} />
        </button>
        {open && (
          <div className={`${menuCls} right-0 bottom-full mb-2 w-60`}>
            <button type="button" className={menuItemCls} disabled={!!block} onClick={() => start([active])}>
              <Slice size={15} className="text-accent-500" />
              <span className="flex-1">{t('slice.plate', { n: active + 1 })}</span>
            </button>
            <button type="button" className={menuItemCls} disabled={!!allBlock || slicablePlates.length < 1} onClick={() => start(slicablePlates)}>
              <Slice size={15} className="text-violet-500" />
              <span className="flex-1">{t('slice.all')}</span>
              <span className="text-xs text-muted tabular-nums">{slicablePlates.length}</span>
            </button>
          </div>
        )}
      </div>
      {block && !run && <p className="max-w-64 text-right text-[11px] text-muted">{t(block)}</p>}
    </div>
  )
}
