// Files page: uploads still in flight (global queue) shown in place, before the stored files, as a card (grid) or
// a table row (list) with "Uploading <name>" + progress bar + % · speed · ETA, "Processing…" once all bytes are
// sent, or the error with retry/remove. Finished uploads disappear here and show up as real files after the reload.
import { CircleAlert, FileUp, LoaderCircle, RotateCcw, X } from 'lucide-react'
import { IconButton } from '../../components/ui'
import { ProgressBar, TransferStats } from '../../components/TransferProgress'
import { etaOf } from '../../components/transferEta'
import { useI18n } from '../../i18n/I18nContext'
import { formatBytes } from '../../validation'
import { useUploads, type UploadItem } from './uploads/UploadContext'

function useLabel(it: UploadItem) {
  const { t } = useI18n()
  const processing = it.status === 'done' || (it.status === 'uploading' && it.progress >= 1)
  const label =
    it.status === 'error'
      ? t('upload.failedFile', { name: it.file.name })
      : processing
        ? t('upload.processingFile', { name: it.file.name })
        : it.status === 'queued'
          ? t('upload.waitingFile', { name: it.file.name })
          : t('upload.uploadingFile', { name: it.file.name })
  return { label, processing }
}

function Actions({ it }: { it: UploadItem }) {
  const { t } = useI18n()
  const { cancel, retry } = useUploads()
  return it.status === 'error' ? (
    <IconButton label={t('common.retry')} onClick={() => retry(it.id)}>
      <RotateCcw size={14} />
    </IconButton>
  ) : (
    <IconButton label={t('common.cancel')} tone="danger" onClick={() => cancel(it.id)}>
      <X size={14} />
    </IconButton>
  )
}

function Progress({ it, processing }: { it: UploadItem; processing: boolean }) {
  const { t } = useI18n()
  if (it.status === 'error') return <p className="mt-1 truncate text-xs text-red-600 dark:text-red-400" title={it.error}>{it.error}</p>
  return (
    <>
      <ProgressBar className="mt-1.5" value={it.progress} indeterminate={processing || it.status === 'queued'} label={it.file.name} />
      {processing ? (
        <p className="mt-0.5 text-[11px] text-muted">{t('upload.processing')}</p>
      ) : it.status === 'queued' ? (
        <p className="mt-0.5 text-[11px] text-muted">{t('library.upload.status.queued')} · {formatBytes(it.file.size)}</p>
      ) : (
        <TransferStats className="mt-0.5" fraction={it.progress} total={it.file.size} speed={it.speed} etaSec={etaOf(it.file.size, it.progress * it.file.size, it.speed)} />
      )}
    </>
  )
}

function Icon({ it, processing, size }: { it: UploadItem; processing: boolean; size: number }) {
  if (it.status === 'error') return <CircleAlert size={size} className="text-red-500" />
  if (processing) return <LoaderCircle size={size} className="animate-spin text-sky-500" />
  return <FileUp size={size} className="text-sky-500" />
}

export function PendingUploadCard({ it }: { it: UploadItem }) {
  const { label, processing } = useLabel(it)
  return (
    <li
      data-pending-upload={it.id}
      className={`relative overflow-hidden rounded-2xl border bg-surface shadow-sm ${it.status === 'error' ? 'border-red-500/40' : 'border-sky-500/40'}`}
    >
      <div className="flex aspect-square w-full items-center justify-center border-b border-line bg-surface-2/60">
        <Icon it={it} processing={processing} size={36} />
      </div>
      <div className="p-3">
        <p className="truncate text-sm font-medium" title={label}>
          {label}
        </p>
        <Progress it={it} processing={processing} />
      </div>
      <div className="absolute top-2 right-2 rounded-lg bg-surface/90 shadow">
        <Actions it={it} />
      </div>
    </li>
  )
}

export function PendingUploadRow({ it, columns }: { it: UploadItem; columns: number }) {
  const { label, processing } = useLabel(it)
  return (
    <tr data-pending-upload={it.id} className="bg-sky-500/[0.04]">
      <td className="py-2 pl-3">
        <Icon it={it} processing={processing} size={16} />
      </td>
      <td className="max-w-0 py-2 pr-4" colSpan={Math.max(1, columns - 2)}>
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2/60">
            <FileUp size={16} className="text-muted" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium" title={label}>
              {label}
            </p>
            <div className="max-w-md">
              <Progress it={it} processing={processing} />
            </div>
          </div>
        </div>
      </td>
      <td className="py-2 pr-2">
        <Actions it={it} />
      </td>
    </tr>
  )
}
