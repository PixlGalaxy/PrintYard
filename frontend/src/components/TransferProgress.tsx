// Shared bits for "Uploading <file>" rows: a thin progress bar (determinate, or indeterminate while the server is
// processing) and the "42% · 3.1 MB/s · 12s left" line. Used by the Prepare Objects list, the Files page, the
// upload tray, the print dialog and <PrinterUploadProgress/>.
import { formatDuration } from '../gcode/format'
import { useI18n } from '../i18n/I18nContext'
import { formatBytes } from '../validation'

export function ProgressBar({
  value,
  indeterminate = false,
  tone = 'sky',
  className = '',
  label,
}: {
  /** 0..1 */
  value: number
  indeterminate?: boolean
  tone?: 'sky' | 'accent' | 'red'
  className?: string
  /** Accessible name (the visible text usually sits next to the bar). */
  label?: string
}) {
  const color = tone === 'red' ? 'bg-red-500' : tone === 'accent' ? 'bg-accent-500' : 'bg-sky-500'
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100)
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(!indeterminate && { 'aria-valuenow': pct })}
      className={`h-1 overflow-hidden rounded-full bg-surface-2 ring-1 ring-line/50 ring-inset ${className}`}
    >
      {indeterminate ? (
        <div className={`h-full w-2/5 rounded-full ${color} animate-[sd-indeterminate_1.1s_ease-in-out_infinite]`} />
      ) : (
        <div className={`h-full rounded-full ${color} transition-[width] duration-300`} style={{ width: `${pct}%` }} />
      )}
    </div>
  )
}

/** "42% · 3.1 MB/s · 12s left" (speed/ETA only when known). */
export function TransferStats({ fraction, total, speed, etaSec, className = '' }: { fraction: number; total?: number; speed?: number; etaSec?: number | null; className?: string }) {
  const { t } = useI18n()
  const parts = [`${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`]
  if (total) parts.push(formatBytes(total))
  if (speed) parts.push(`${formatBytes(speed)}/s`)
  if (etaSec != null && etaSec > 0.5) parts.push(t('upload.eta', { time: formatDuration(etaSec) }))
  return <p className={`font-mono text-[11px] text-muted tabular-nums ${className}`}>{parts.join(' · ')}</p>
}
