import { CircleCheck, Clock, Hourglass, PackageCheck, Scale, Send, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react'
import { PrinterLayers } from '../../../components/printerIcons'
import { useEffect, useState, type ReactNode } from 'react'
import { api, ApiError } from '../../../api'
import GcodeFindings from '../../../components/GcodeFindings'
import Modal from '../../../components/Modal'
import { selectCls } from '../../../components/styles'
import { Badge, Button, Callout, Meter, Toggle } from '../../../components/ui'
import { PrinterUploadCard } from '../../../components/PrinterUploadProgress'
import { usePrintUploads, type PrintUploadEntry } from '../../../realtime/printUploads'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import { formatDuration } from '../../../gcode/format'
import { useI18n } from '../../../i18n/I18nContext'
import { usePrinterStatus } from '../../../realtime'
import type { DangerousGcodeDetails, PrintJob, Printer, UsageSummary } from '../../../types'
import { timeAgo } from '../../../format'
import { limitProblems } from './limits'
import { useReadOnly } from '../../../readOnly'

export interface PrintTarget {
  fileId: number
  fileName: string
  grams: number | null
  seconds: number | null
  /**
   * Files → On the printer: print this file that is already on the printer (downloaded + checked by the server,
   * then started in place). `fileId` is ignored and the printer is fixed.
   */
  printerFile?: { printerId: number; name: string }
}

/**
 * "Calibrate before printing": the user's last choice (per user, localStorage) wins while the admin default
 * (`config.printing.calibrateByDefault`) stays the one it was chosen against; a changed default resets it.
 */
const calibrateKey = (userId: number | undefined) => `sd:print:calibrate:${userId ?? 0}`

function initialCalibrate(userId: number | undefined, def: boolean): boolean {
  try {
    const raw = localStorage.getItem(calibrateKey(userId))
    if (!raw) return def
    const v = JSON.parse(raw) as { value?: unknown; def?: unknown }
    return typeof v.value === 'boolean' && v.def === def ? v.value : def
  } catch {
    return def
  }
}

function rememberCalibrate(userId: number | undefined, value: boolean, def: boolean) {
  try {
    localStorage.setItem(calibrateKey(userId), JSON.stringify({ value, def }))
  } catch {
    // storage unavailable: the default applies next time
  }
}

interface BedInfo {
  fileName: string | null
  endedAt: number | null
}

export default function PrintDialog({
  target,
  usage,
  onClose,
  onDone,
}: {
  target: PrintTarget
  usage: UsageSummary | null
  onClose: () => void
  onDone: (job: PrintJob) => void
}) {
  const { t, errorMessage, formatNumber } = useI18n()
  const { toast } = useToast()
  const [printers, setPrinters] = useState<Printer[] | null>(null)
  const [printerId, setPrinterId] = useState<number | null>(target.printerFile?.printerId ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [bedServer, setBedServer] = useState<BedInfo | null>(null)
  const [bedConfirmed, setBedConfirmed] = useState(false)
  const status = usePrinterStatus(printerId)
  const readOnly = useReadOnly()
  const { user, config } = useAuth()
  const isAdmin = user?.role === 'admin'
  const calibrateDefault = config?.printing?.calibrateByDefault ?? false
  const [calibrate, setCalibrate] = useState(() => initialCalibrate(user?.id, calibrateDefault))
  // Live "Sending to printer" progress of this file while the request is running (WS print.upload)
  const live = usePrintUploads(printerId).find((e) => e.fileName === target.fileName)
  // The entry disappears when the print starts (print.update printing) a moment before the request returns: keep
  // showing it as "starting" instead of falling back to "Preparing…"
  const [lastSending, setLastSending] = useState<PrintUploadEntry | null>(null)
  if (live && live !== lastSending) setLastSending(live)
  const sending = live ?? (busy && lastSending ? { ...lastSending, percent: 100, phase: 'starting' as const } : undefined)
  /** Dangerous-command scan findings returned by the server (admins may override after confirming). */
  const [danger, setDanger] = useState<DangerousGcodeDetails | null>(null)
  const [dangerAck, setDangerAck] = useState(false)

  useEffect(() => {
    api.printers().then(
      (list) => {
        setPrinters(list)
        setPrinterId((cur) => cur ?? target.printerFile?.printerId ?? list[0]?.id ?? null)
      },
      (err: unknown) => setError(err),
    )
  }, [target.printerFile?.printerId])

  const problems = limitProblems(usage, target.grams, target.seconds)
  const needsApproval = !!usage?.limits.enabled && usage.limits.requiresApproval
  const busyPrinter = status && ['printing', 'paused', 'pausing', 'resuming', 'stopping'].includes(status.state)
  const offline = status && !status.online
  const bedOccupied = !needsApproval && (bedServer !== null || status?.bedClear === false)
  const cost = usage?.costPerKg != null && target.grams != null ? (target.grams / 1000) * usage.costPerKg : null
  const money = (v: number) => formatNumber(v, { style: 'currency', currency: usage?.currency || 'USD' })

  async function send(allowDangerous = false) {
    if (printerId == null) return
    setBusy(true)
    setLastSending(null)
    setError(null)
    try {
      rememberCalibrate(user?.id, calibrate, calibrateDefault)
      const job = target.printerFile
        ? (await api.printPrinterFile(target.printerFile.printerId, target.printerFile.name, { confirmBedClear: bedOccupied && bedConfirmed, allowDangerous, calibrate })).job
        : await api.createPrint(printerId, target.fileId, bedOccupied && bedConfirmed, allowDangerous, calibrate)
      if (job.state === 'pending') toast('info', t('prints.sentForApproval'))
      else toast('success', t('prints.started', { name: target.fileName }))
      onDone(job)
      onClose()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'prints.bed_not_cleared') {
        const d = (err.details ?? {}) as { fileName?: string; endedAt?: number }
        setBedServer({ fileName: d.fileName ?? null, endedAt: d.endedAt ?? null })
        setBedConfirmed(false)
      } else if (err instanceof ApiError && err.code === 'prints.dangerous_gcode') {
        setDanger((err.details ?? { total: 0, findings: [] }) as DangerousGcodeDetails)
        setDangerAck(false)
      } else setError(err)
    } finally {
      setBusy(false)
    }
  }

  const blocked = readOnly || problems.length > 0 || printerId == null || (!needsApproval && (busyPrinter || offline)) || (bedOccupied && !bedConfirmed)

  return (
    <Modal
      title={t('prints.dialogTitle')}
      subtitle={target.fileName}
      icon={<PrinterLayers size={18} />}
      onClose={onClose}
      dismissable={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          {danger && isAdmin ? (
            <Button variant="danger" icon={<ShieldAlert size={14} />} loading={busy} disabled={blocked || !dangerAck} onClick={() => void send(true)}>
              {t('gcodeScan.printAnyway')}
            </Button>
          ) : (
            <Button variant="primary" icon={needsApproval ? <Send size={14} /> : <PrinterLayers size={14} />} loading={busy} disabled={blocked || danger !== null} onClick={() => void send()}>
              {t(needsApproval ? 'prints.requestApproval' : 'prints.startPrint')}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2">
          <Stat icon={<Clock size={15} />} label={t('preview.stat.time')} value={formatDuration(target.seconds)} />
          <Stat icon={<Scale size={15} />} label={t('preview.stat.filament')} value={target.grams != null ? `${formatNumber(target.grams, { maximumFractionDigits: 1 })} g` : '—'} />
          <Stat icon={<PackageCheck size={15} />} label={t('preview.stat.cost')} value={cost != null ? money(cost) : '—'} />
        </div>

        {busy && target.printerFile && <p className="text-xs text-muted">{t('printerFiles.checking')}</p>}
        {busy && !needsApproval && !target.printerFile && (
          <div className="space-y-1.5">
            <PrinterUploadCard
              entry={
                sending ?? { printId: 0, printerId: printerId ?? 0, fileName: target.fileName, sentBytes: 0, totalBytes: 0, percent: 0, etaSec: null, phase: 'uploading' }
              }
            />
            <p className="text-[11px] text-muted">{t('upload.toPrinter.hint')}</p>
          </div>
        )}

        {printers && printers.length > 1 && !target.printerFile && (
          <div className="space-y-1.5">
            <label htmlFor="print-printer" className="text-sm font-medium">
              {t('prints.printer')}
            </label>
            <select id="print-printer" className={selectCls} value={printerId ?? ''} onChange={(e) => setPrinterId(Number(e.target.value))}>
              {printers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {printers && printers.length === 0 && <Callout tone="warning">{t('prints.noPrinters')}</Callout>}

        {status && (
          <div className="flex items-center gap-3 rounded-xl border border-line bg-surface-2/50 px-3.5 py-2.5 text-sm">
            <span className={`size-2.5 rounded-full ${status.online ? (busyPrinter ? 'bg-amber-500' : 'bg-emerald-500') : 'bg-zinc-400'}`} />
            <span className="font-medium">{printers?.find((p) => p.id === printerId)?.name}</span>
            <span className="ml-auto">
              <Badge tone={!status.online ? 'zinc' : busyPrinter ? 'amber' : 'emerald'}>{t(`printerTab.state.${status.state}`)}</Badge>
            </span>
          </div>
        )}
        {!needsApproval && offline && <Callout tone="error">{t('errors.prints.printer_offline')}</Callout>}
        {!needsApproval && busyPrinter && <Callout tone="warning">{t('errors.prints.printer_busy')}</Callout>}

        {bedOccupied && (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3.5">
            <p className="flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-200">
              <TriangleAlert size={16} />
              {t('prints.bedQuestion')}
            </p>
            <p className="mt-1 text-[13px] text-amber-800/90 dark:text-amber-200/90">
              {bedServer?.fileName
                ? t('prints.bedPrevious', { name: bedServer.fileName, when: timeAgo(t, bedServer.endedAt) })
                : t('prints.bedHint')}
            </p>
            <label className="mt-2.5 flex cursor-pointer items-center gap-2.5 text-sm font-medium">
              <input type="checkbox" className="size-4 accent-amber-500" checked={bedConfirmed} onChange={(e) => setBedConfirmed(e.target.checked)} />
              {t('prints.bedConfirm')}
            </label>
          </div>
        )}

        <div className="flex items-start gap-3 rounded-xl border border-line px-3.5 py-3">
          <div className="min-w-0 flex-1">
            <label htmlFor="print-calibrate" className="text-sm font-medium">
              {t('prints.calibrate')}
            </label>
            <p className="mt-0.5 text-xs text-muted">{t('prints.calibrateHint')}</p>
          </div>
          <Toggle id="print-calibrate" checked={calibrate} onChange={setCalibrate} label={t('prints.calibrate')} disabled={busy} />
        </div>

        {usage?.limits.enabled && <UsageBlock usage={usage} grams={target.grams} seconds={target.seconds} />}

        {problems.map((p) => (
          <Callout key={p.key} tone="error" title={t(`prints.limit.${p.key}`)}>
            {t(`prints.limitDesc.${p.key}`, { limit: formatNumber(p.limit) })}
          </Callout>
        ))}
        {needsApproval && problems.length === 0 && (
          <Callout tone="info" title={t('prints.approvalTitle')}>
            {t('prints.approvalDesc')}
          </Callout>
        )}
        {danger && (
          <>
            <GcodeFindings details={danger} />
            {isAdmin ? (
              <div className="rounded-xl border border-red-500/40 p-3.5">
                <p className="text-[13px] font-medium text-red-700 dark:text-red-300">{t('gcodeScan.overrideWarning')}</p>
                <label className="mt-2.5 flex cursor-pointer items-center gap-2.5 text-sm font-medium">
                  <input type="checkbox" className="size-4 accent-red-500" checked={dangerAck} onChange={(e) => setDangerAck(e.target.checked)} />
                  {t('gcodeScan.overrideConfirm')}
                </label>
              </div>
            ) : (
              <Callout tone="info">{t('gcodeScan.userHint')}</Callout>
            )}
          </>
        )}
        {readOnly && <Callout tone="warning">{t('readOnly.tooltip')}</Callout>}
        {error != null && <Callout tone="error">{errorMessage(error)}</Callout>}
      </div>
    </Modal>
  )
}

function Stat({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2/50 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[11px] text-muted">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 font-semibold tabular-nums">{value}</div>
    </div>
  )
}

/** Monthly usage vs limit, and this print vs the per-print limit. */
export function UsageBlock({ usage, grams, seconds }: { usage: UsageSummary; grams: number | null; seconds?: number | null }) {
  const { t, formatNumber } = useI18n()
  const l = usage.limits
  const g = (v: number) => `${formatNumber(v, { maximumFractionDigits: 0 })} g`
  return (
    <div className="space-y-3 rounded-xl border border-line p-3.5">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck size={15} className="text-sky-500" />
        {t('prints.yourLimits')}
      </p>
      {l.maxGramsPerMonth != null && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs">
            <span className="text-muted">{t('prints.monthUsage')}</span>
            <span className="font-mono tabular-nums">
              {g(usage.monthGrams)}
              {grams != null && <span className="text-sky-600 dark:text-sky-400"> + {g(grams)}</span>} / {g(l.maxGramsPerMonth)}
            </span>
          </div>
          <Meter value={((usage.monthGrams + (grams ?? 0)) / l.maxGramsPerMonth) * 100} />
        </div>
      )}
      <ul className="grid gap-1.5 text-xs sm:grid-cols-2">
        {l.maxGramsPerPrint != null && (
          <LimitRow ok={grams == null || grams <= l.maxGramsPerPrint} label={t('prints.perPrint')} value={g(l.maxGramsPerPrint)} />
        )}
        {l.maxHoursPerPrint != null && <LimitRow ok={seconds == null || seconds / 3600 <= l.maxHoursPerPrint} label={t('prints.maxHours')} value={`${formatNumber(l.maxHoursPerPrint)} h`} />}
        {l.requiresApproval && (
          <li className="flex items-center gap-1.5 text-muted">
            <Hourglass size={13} className="text-amber-500" />
            {t('prints.needsApproval')}
          </li>
        )}
      </ul>
    </div>
  )
}

function LimitRow({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <li className="flex items-center gap-1.5">
      {ok ? <CircleCheck size={13} className="text-emerald-500" /> : <TriangleAlert size={13} className="text-red-500" />}
      <span className="text-muted">{label}</span>
      <span className="ml-auto font-mono tabular-nums">{value}</span>
    </li>
  )
}
