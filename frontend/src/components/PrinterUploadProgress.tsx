// "Sending to printer: <file>" card with progress bar, % · size · ETA, then "File sent. Starting the print…".
// Renders nothing while no upload to that printer is in flight. Used by the print dialog; PRINTER-MAIN mounts it in
// the Printer tab: <PrinterUploadProgress printerId={id} />.
import { LoaderCircle, Send } from 'lucide-react'
import { useI18n } from '../i18n/I18nContext'
import { usePrintUploads, type PrintUploadEntry } from '../realtime/printUploads'
import { ProgressBar, TransferStats } from './TransferProgress'

export default function PrinterUploadProgress({ printerId, printId, className = '' }: { printerId: number | null; printId?: number | null; className?: string }) {
  const list = usePrintUploads(printerId).filter((e) => printId == null || e.printId === printId)
  if (!list.length) return null
  return (
    <div className={`space-y-2 ${className}`} aria-live="polite">
      {list.map((e) => (
        <PrinterUploadCard key={e.printId} entry={e} />
      ))}
    </div>
  )
}

export function PrinterUploadCard({ entry: e }: { entry: PrintUploadEntry }) {
  const { t } = useI18n()
  const starting = e.phase === 'starting'
  const preparing = !starting && e.totalBytes === 0
  const label = t('upload.toPrinter.file', { name: e.fileName })
  return (
    <div data-printer-upload={e.printId} className="rounded-xl border border-sky-500/30 bg-sky-500/[0.06] px-3.5 py-3">
      <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
        {starting ? <LoaderCircle size={15} className="shrink-0 animate-spin text-sky-500" /> : <Send size={15} className="shrink-0 text-sky-500" />}
        <span className="truncate" title={label}>
          {label}
        </span>
      </p>
      <ProgressBar className="mt-2" value={e.percent / 100} indeterminate={starting || preparing} label={label} />
      {starting ? (
        <p className="mt-1 text-[11px] text-muted">{t('upload.toPrinter.starting')}</p>
      ) : preparing ? (
        <p className="mt-1 text-[11px] text-muted">{t('upload.toPrinter.preparing')}</p>
      ) : (
        <TransferStats className="mt-1" fraction={e.percent / 100} total={e.totalBytes} etaSec={e.etaSec} />
      )}
    </div>
  )
}
