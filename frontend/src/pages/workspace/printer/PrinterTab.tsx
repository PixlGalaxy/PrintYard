// Printer tab (layout "option 2"), full width and full height (no page scroll at ≥ 1280 px):
// - main area (~70 %): the live 3D view, with floating glass cards top-left (progress ring + state, layer x/y,
//   "finishes at HH:MM" + remaining) and a small "Bed occupied" pill under them; objects chips + legend
//   bottom-left and the view cube top-right (inside LiveView);
// - right panel (~30 %) with tabs: Main (Repetier-style manual control, preheat, light, speed/flow/fan/temperature
//   sliders) · Temperatures (time-series chart) · History · Camera. Main is always selected when the page opens;
// - bottom status strip (full width): file + thumbnail + source, elapsed, remaining, ETA, nozzle/bed, fan,
//   filament, light toggle, pause/resume + cancel (with confirms) and the read-only / permission tooltips.
// While idle (no job, bed clear) no status card floats over the 3D: the view itself says nothing is printing.
// Below 1280 px: 3D on top, then the strip, then the tabbed panel.
import {
  Ban,
  Camera,
  CircleCheck,
  CirclePause,
  CirclePlay,
  Clock,
  Fan,
  FileCode2,
  Hand,
  History,
  Hourglass,
  LoaderCircle,
  SlidersHorizontal,
  Thermometer,
  TriangleAlert,
  UserRound,
  WifiOff,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../../../api'
import Modal from '../../../components/Modal'
import { selectCls } from '../../../components/styles'
import { Badge, Button, Callout, Empty, Loading } from '../../../components/ui'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import { timeAgo } from '../../../format'
import { formatDuration } from '../../../gcode/format'
import { useI18n } from '../../../i18n/I18nContext'
import { usePrinterStatus, useRealtimeMessage, useRealtimeState } from '../../../realtime'
import type { CfsSlot, LastJob, LibraryFile, PrintJob, Printer, PrinterState, TempSample } from '../../../types'
import { useReadOnly } from '../../../readOnly'
import { BedIcon, LightIcon, NozzleIcon, PrinterLayers, PrinterModelIcon } from '../../../components/printerIcons'
import { Segmented } from '../../../components/ui'
import JogPanel from './JogPanel'
import LiveView from './LiveView'
import PrinterUploadProgress from '../../../components/PrinterUploadProgress'
import { PrintStateBadge } from './PrintStateBadge'
import TempChart, { SeriesKey } from './TempChart'

const ACTIVE: PrinterState[] = ['printing', 'paused', 'pausing', 'stopping']
const STATE_TONE: Record<PrinterState, 'sky' | 'emerald' | 'amber' | 'red' | 'zinc' | 'violet'> = {
  offline: 'zinc',
  idle: 'emerald',
  printing: 'sky',
  paused: 'amber',
  pausing: 'amber',
  stopping: 'red',
  complete: 'emerald',
  failed: 'red',
  aborted: 'zinc',
  error: 'red',
}
const RESULT_STATE: Record<LastJob['result'], PrinterState> = { done: 'complete', cancelled: 'aborted', failed: 'failed' }
const TABS = ['main', 'temps', 'history', 'camera'] as const
type Tab = (typeof TABS)[number]
const TAB_ICON: Record<Tab, ReactNode> = {
  main: <SlidersHorizontal size={14} className="text-sky-500" />,
  temps: <Thermometer size={14} className="text-rose-500" />,
  history: <History size={14} />,
  camera: <Camera size={14} />,
}
const WINDOWS = ['10', '30', '60'] as const
/** Server-side history: a sample every 2 s, 60 min kept */
const TEMP_STEP_MS = 2000
const TEMP_KEEP_MS = 60 * 60_000

type Command = 'pause' | 'resume' | 'cancel'

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const glass = 'rounded-2xl border border-line/80 bg-surface/80 shadow-lg shadow-black/5 backdrop-blur-md'

export default function PrinterTab() {
  const { t } = useI18n()
  const [printers, setPrinters] = useState<Printer[] | null>(null)
  const [printerId, setPrinterId] = useState<number | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    api.printers().then(
      (list) => {
        setPrinters(list)
        setPrinterId((cur) => cur ?? list[0]?.id ?? null)
      },
      setError,
    )
  }, [])

  if (error) return <Callout tone="error">{String(error)}</Callout>
  if (!printers) return <Loading />
  if (!printers.length)
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Empty icon={<PrinterLayers size={20} />}>{t('printerTab.none')}</Empty>
      </div>
    )
  const printer = printers.find((p) => p.id === printerId) ?? printers[0]
  const picker =
    printers.length > 1 ? (
      <select id="printer-pick" aria-label={t('prints.printer')} className={`${selectCls} h-8! w-full!`} value={printer.id} onChange={(e) => setPrinterId(Number(e.target.value))}>
        {printers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    ) : null
  return <PrinterLive key={printer.id} printer={printer} picker={picker} />
}

function PrinterLive({ printer, picker }: { printer: Printer; picker: ReactNode }) {
  const { t, formatNumber } = useI18n()
  const { user } = useAuth()
  const { toast, onError } = useToast()
  const status = usePrinterStatus(printer.id)
  const socket = useRealtimeState()
  const isAdmin = user?.role === 'admin'
  const [prints, setPrints] = useState<PrintJob[]>([])
  const [files, setFiles] = useState<LibraryFile[]>([])
  const [confirm, setConfirm] = useState<Command | null>(null)
  const [confirmBed, setConfirmBed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [lightBusy, setLightBusy] = useState(false)
  const [temps, setTemps] = useState<TempSample[]>([])
  // Main is always the tab shown when the page opens (not remembered)
  const [activeTab, setTab] = useState<Tab>('main')
  const [win, setWin] = useState<(typeof WINDOWS)[number]>('30')

  const loadPrints = useCallback(() => {
    api.prints(isAdmin ? 'all' : 'mine').then((list) => setPrints(list.filter((p) => p.printerId === printer.id)), () => undefined)
  }, [isAdmin, printer.id])
  useEffect(() => {
    loadPrints()
    Promise.all([api.files('private', 'gcode'), api.files(isAdmin ? 'all' : 'shared', 'gcode')]).then(([a, b]) => setFiles([...a, ...b]), () => undefined)
  }, [loadPrints, isAdmin])

  useRealtimeMessage('print.update', (job) => {
    if (job.printerId !== printer.id) return
    setPrints((cur) => (cur.some((p) => p.id === job.id) ? cur.map((p) => (p.id === job.id ? job : p)) : [job, ...cur]))
  })

  // Temperature history: the server's last 60 min, then live samples from the WS status (one per 2 s)
  useEffect(() => {
    let alive = true
    api.printerTemps(printer.id, 60).then(
      (r) => alive && setTemps((cur) => [...r.samples, ...cur.filter((s) => s.t > (r.samples[r.samples.length - 1]?.t ?? 0))]),
      () => undefined,
    )
    return () => {
      alive = false
    }
  }, [printer.id])
  const lastAt = useRef(0)
  useEffect(() => {
    if (!status?.online || status.updatedAt - lastAt.current < TEMP_STEP_MS) return
    lastAt.current = status.updatedAt
    const s: TempSample = { t: status.updatedAt, nozzle: status.nozzleTemp, nozzleTarget: status.nozzleTarget, bed: status.bedTemp, bedTarget: status.bedTarget }
    setTemps((h) => {
      if (h.length && h[h.length - 1].t >= s.t) return h
      const from = s.t - TEMP_KEEP_MS
      return [...(h.length && h[0].t < from ? h.filter((x) => x.t >= from) : h), s]
    })
  }, [status])

  const current = useMemo(() => prints.find((p) => p.id === status?.currentPrintId) ?? null, [prints, status?.currentPrintId])
  const last = useMemo(() => prints.find((p) => p.id === status?.lastPrintId) ?? null, [prints, status?.lastPrintId])
  const fileOf = (id: number | undefined) => files.find((f) => f.id === id)
  const readOnly = useReadOnly()
  const active = !!status && ACTIVE.includes(status.state)
  const owner = isAdmin || (current != null && current.userId === user?.id)
  const canCommand = !readOnly && !!status && owner
  const canJog = isAdmin || !!user?.canControlPrinter
  // While the bed is occupied, the last job stays on screen with its final values
  const lastJob = status && !active && status.bedClear === false ? (status.lastJob ?? null) : null
  const thumb = fileOf(current?.fileId)?.thumbnailUrl ?? (lastJob ? fileOf(last?.fileId)?.thumbnailUrl : null) ?? null

  async function run(cmd: Command) {
    setBusy(true)
    try {
      await api.printerCommand(printer.id, cmd)
      toast('success', t(`printerTab.cmdSent.${cmd}`))
    } catch (err) {
      onError(err)
      throw err
    } finally {
      setBusy(false)
    }
  }

  async function bedCleared() {
    try {
      await api.bedCleared(printer.id)
      toast('success', t('printerTab.bedClearedToast'))
    } catch (err) {
      onError(err)
      throw err
    }
  }

  async function setLight(on: boolean) {
    setLightBusy(true)
    try {
      await api.printerControl(printer.id, { action: 'light', on })
    } catch (err) {
      onError(err)
    } finally {
      setLightBusy(false)
    }
  }

  if (!status) {
    return (
      <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted">
        <LoaderCircle className="animate-spin" size={18} />
        {t('printerTab.connecting')}
      </div>
    )
  }

  const shownState: PrinterState = lastJob ? RESULT_STATE[lastJob.result] : status.state
  const progress = lastJob ? (lastJob.progress ?? 0) : (status.progress ?? (status.state === 'complete' ? 100 : 0))
  // Time estimate: the backend's `estimate` when present (the printer reports 0 s / bogus remaining while heating),
  // else the printer's own values. Slicer-based estimates get a "~". Never "finishes at" = now before printing.
  const est = active ? (status.estimate ?? null) : null
  const phase = est?.phase ?? null
  const prePrint = phase === 'heating' || phase === 'preparing'
  const remainingSec = est ? est.remainingSec : active ? status.remainingSec : null
  const approx = est?.source === 'slicer' ? '~' : ''
  const etaRaw = est?.finishesAt ?? (remainingSec != null && active ? status.updatedAt + remainingSec * 1000 : null)
  // A finish time within a minute while heating/preparing (or with 0 s left before any progress) is bogus
  const bogus = (prePrint || (!est && remainingSec === 0 && (status.progress ?? 0) < 100)) && (etaRaw == null || etaRaw - status.updatedAt < 60_000)
  const eta = etaRaw != null && !bogus ? etaRaw : null
  const remainingText = remainingSec != null && !(bogus && !remainingSec) ? `${approx}${formatDuration(remainingSec)}` : '—'
  const heatingText =
    status.bedTarget && (!status.nozzleTarget || (status.bedTemp ?? 0) < status.bedTarget - 2) && (status.nozzleTemp ?? 0) >= (status.nozzleTarget ?? 0) - 2
      ? t('printerTab.phase.heatingBed', { v: Math.round(status.bedTemp ?? 0), target: status.bedTarget })
      : t('printerTab.phase.heating', { v: Math.round(status.nozzleTemp ?? 0), target: status.nozzleTarget ?? 0 })
  const phaseText = phase === 'heating' ? heatingText : phase === 'preparing' ? t('printerTab.phase.preparing') : phase === 'finishing' ? t('printerTab.phase.finishing') : null
  const fileName = (lastJob?.fileName ?? status.fileName)?.split('/').pop() ?? null
  const layer = lastJob ? lastJob.layer : status.layer
  const layers = lastJob ? (lastJob.totalLayers ?? lastJob.layerCount) : status.totalLayers
  const bedOccupied = status.online && status.bedClear === false && !active
  const hasJob = active || !!lastJob

  const source = current ? (
    <>
      <UserRound size={11} className="shrink-0" /> {t('printerTab.startedBy', { name: current.username })}
      {current.startedAt && <> · {timeAgo(t, current.startedAt)}</>}
    </>
  ) : lastJob ? (
    t(`printerTab.result.${lastJob.result}`)
  ) : active ? (
    t('printerTab.startedElsewhere')
  ) : (
    t(status.state === 'idle' ? 'printerTab.readyDesc' : 'printerTab.lastJobDesc')
  )

  // Why pause/cancel are disabled (tooltip; disabled buttons get no pointer events, so it sits on a wrapper)
  const commandReason = readOnly ? t('readOnly.tooltip') : active && !owner ? t('printerTab.controlsOwnerOnly') : undefined
  const lightReason = readOnly ? t('readOnly.tooltip') : !status.online ? t('jog.offline') : !canJog ? t('printerTab.noControlPermission') : undefined
  const lightBlocked = !!lightReason || lightBusy || status.lightOn == null

  // ---------------------------------------------------------------- floating cards (over the 3D)
  const overlay = (
    <>
      <PrinterUploadProgress printerId={printer.id} className="pointer-events-auto w-72 max-w-full rounded-xl bg-surface/90 shadow-lg backdrop-blur-md" />
      {hasJob && (
      <div className={`${glass} pointer-events-auto flex items-center gap-3 p-2.5 pr-4 max-sm:gap-2 max-sm:p-2`}>
        <ProgressRing value={progress} state={shownState} />
        <div className="min-w-0 space-y-0.5">
          <Badge tone={STATE_TONE[shownState]}>{t(`printerTab.state.${shownState}`)}</Badge>
            <>
              <p className="truncate text-xs font-medium tabular-nums">{layer != null ? t('printerTab.layerOf', { n: layer, total: layers ?? '—' }) : '—'}</p>
              <p className="truncate text-xs text-muted tabular-nums">
                {lastJob ? (
                  t('printerTab.finishedAtTime', { time: hhmm(lastJob.endedAt) })
                ) : prePrint ? (
                  <>
                    <span className="font-medium text-amber-700 dark:text-amber-300">{phaseText}</span>
                    {remainingText !== '—' && <> · {t('printerTab.timeLeft', { time: remainingText })}</>}
                  </>
                ) : eta ? (
                  <>
                    <span className="font-medium text-fg">{t('printerTab.finishesAtTime', { time: `${approx}${hhmm(eta)}` })}</span>
                    {' · '}
                    {t('printerTab.timeLeft', { time: remainingText })}
                  </>
                ) : (
                  '—'
                )}
              </p>
            </>
        </div>
      </div>
      )}
      {bedOccupied && (
        <div
          className="pointer-events-auto flex items-center gap-2 rounded-full border border-amber-500/40 bg-amber-50/90 py-1 pr-1 pl-2.5 text-xs shadow-md shadow-amber-500/10 backdrop-blur-md dark:bg-amber-950/70"
          title={
            last || lastJob
              ? t('printerTab.bedOccupiedDesc', { name: last?.fileName ?? fileName ?? '', when: timeAgo(t, last?.endedAt ?? lastJob?.endedAt ?? status.bedOccupiedSince) })
              : t('printerTab.bedOccupiedSince', { when: timeAgo(t, status.bedOccupiedSince) })
          }
        >
          <TriangleAlert size={13} className="shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="font-semibold text-amber-900 dark:text-amber-100">{t('printerTab.bedOccupied')}</span>
          <span title={readOnly ? t('readOnly.tooltip') : undefined} className={readOnly ? 'cursor-not-allowed' : ''}>
            <button
              type="button"
              disabled={readOnly}
              onClick={() => setConfirmBed(true)}
              className="inline-flex h-6 items-center gap-1 rounded-full bg-amber-500 px-2.5 font-semibold text-white shadow-sm hover:bg-amber-400 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-amber-500 disabled:pointer-events-none disabled:opacity-50"
            >
              <Hand size={12} />
              {t('printerTab.bedPillAction')}
            </button>
          </span>
        </div>
      )}
      {!status.online && (
        <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-line bg-surface/90 px-2.5 py-1 text-xs shadow-md backdrop-blur-md" title={t('printerTab.offlineDesc', { host: printer.host })}>
          <WifiOff size={13} className="text-muted" />
          <span className="font-medium">{t('printerTab.offlineTitle')}</span>
        </div>
      )}
      {socket !== 'open' && (
        <Badge tone="amber">
          <LoaderCircle size={11} className="animate-spin" /> {t('printerTab.reconnecting')}
        </Badge>
      )}
    </>
  )

  // ---------------------------------------------------------------- bottom status strip
  const strip = (
    <section aria-label={t('printerTab.strip.label')} className="flex flex-wrap items-center gap-x-2 gap-y-2 rounded-2xl border border-line bg-surface px-3 py-2 shadow-sm">
      <div className="flex min-w-0 flex-1 basis-56 items-center gap-2.5">
        {thumb ? (
          <img src={thumb} alt="" className="size-10 shrink-0 rounded-lg border border-line object-cover" />
        ) : (
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
            <FileCode2 size={18} />
          </span>
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold" title={fileName ?? undefined}>
            {fileName ?? t('printerTab.noJob')}
          </p>
          <p className="flex items-center gap-1 truncate text-[11px] text-muted">{source}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {prePrint && phaseText ? (
          <Chip icon={<LoaderCircle size={13} className="animate-spin text-amber-500" />} label={t('printerTab.phase.label')} value={phaseText} />
        ) : (
          <Chip icon={<Clock size={13} className="text-sky-500" />} label={t(lastJob ? 'printerTab.totalTime' : 'printerTab.elapsed')} value={formatDuration(lastJob ? lastJob.elapsedSec : status.elapsedSec)} />
        )}
        <Chip icon={<Hourglass size={13} className="text-sky-500" />} label={t('printerTab.remaining')} value={active ? remainingText : lastJob ? formatDuration(0) : '—'} />
        {lastJob ? (
          <Chip icon={<CircleCheck size={13} className="text-emerald-500" />} label={t('printerTab.finishedAt')} value={hhmm(lastJob.endedAt)} />
        ) : (
          <Chip icon={<CircleCheck size={13} className="text-emerald-500" />} label={t('printerTab.eta')} value={eta ? `${approx}${hhmm(eta)}` : '—'} />
        )}
        <span className="mx-0.5 h-6 w-px bg-line max-sm:hidden" aria-hidden />
        <Chip
          icon={<NozzleIcon size={13} />}
          label={t('printerTab.nozzle')}
          value={tempText(status.nozzleTemp, status.nozzleTarget, formatNumber)}
          title={t('printerTab.strip.nozzleTitle', { value: degrees(status.nozzleTemp, formatNumber), target: status.nozzleTarget ? `${status.nozzleTarget} °C` : t('printerTab.off') })}
        />
        <Chip
          icon={<BedIcon size={13} />}
          label={t('printerTab.bed')}
          value={tempText(status.bedTemp, status.bedTarget, formatNumber)}
          title={t('printerTab.strip.bedTitle', { value: degrees(status.bedTemp, formatNumber), target: status.bedTarget ? `${status.bedTarget} °C` : t('printerTab.off') })}
        />
        <Chip
          icon={<Fan size={13} className={status.fanPart ? 'animate-spin text-sky-500 [animation-duration:2s]' : 'text-muted'} />}
          label={t('printerTab.strip.fan')}
          value={status.fanPart != null ? `${status.fanPart}%` : '—'}
        />
        <FilamentChip slots={status.cfs} />
        <span title={lightReason ?? (status.lightOn == null ? t('printerTab.lightUnknown') : t(status.lightOn ? 'printerTab.lightTurnOff' : 'printerTab.lightTurnOn'))} className={lightReason ? 'cursor-not-allowed' : ''}>
          <button
            type="button"
            aria-pressed={!!status.lightOn}
            aria-label={t('printerTab.light')}
            disabled={lightBlocked}
            onClick={() => void setLight(!status.lightOn)}
            className={`inline-flex h-9 items-center gap-1.5 rounded-xl border px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-sky-500 disabled:pointer-events-none disabled:opacity-60 ${
              status.lightOn ? 'border-amber-500/40 bg-amber-500/10 text-amber-800 hover:bg-amber-500/20 dark:text-amber-200' : 'border-line bg-surface-2/60 text-muted hover:text-fg'
            }`}
          >
            {lightBusy ? <LoaderCircle size={13} className="animate-spin" /> : <LightIcon on={status.lightOn} size={13} />}
            {t('printerTab.light')}
          </button>
        </span>
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        {status.errorCode ? <Badge tone="red">{t('printerTab.errorCode', { code: status.errorCode })}</Badge> : null}
        <span title={commandReason} className={commandReason ? 'cursor-not-allowed' : ''}>
          {status.state === 'paused' ? (
            <Button variant="primary" icon={<CirclePlay size={15} />} disabled={!canCommand || busy} onClick={() => setConfirm('resume')}>
              {t('printerTab.resume')}
            </Button>
          ) : (
            <Button icon={<CirclePause size={15} />} disabled={!canCommand || busy || status.state !== 'printing'} onClick={() => setConfirm('pause')}>
              {t('printerTab.pause')}
            </Button>
          )}
        </span>
        <span title={commandReason} className={commandReason ? 'cursor-not-allowed' : ''}>
          <Button variant="danger" icon={<Ban size={15} />} disabled={!canCommand || busy || !['printing', 'paused', 'pausing'].includes(status.state)} onClick={() => setConfirm('cancel')}>
            {t('printerTab.cancel')}
          </Button>
        </span>
      </div>
    </section>
  )

  // ---------------------------------------------------------------- right panel tabs
  const main = <JogPanel printerId={printer.id} status={status} allowed={canJog} readOnly={readOnly} />
  const tempsTab = (
    <section className="flex min-h-[22rem] flex-1 flex-col rounded-2xl border border-line bg-surface p-3 shadow-sm">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="mr-auto flex items-center gap-2 text-sm font-semibold">
          <Thermometer size={16} className="text-rose-500" /> {t('printerTab.temperatures')}
        </h3>
        <Segmented label={t('tempChart.window')} value={win} onChange={setWin} options={WINDOWS.map((m) => ({ value: m, label: `${m} min` }))} />
      </div>
      <div className="mb-2 grid grid-cols-2 gap-2">
        <TempTile label={t('printerTab.nozzle')} value={status.nozzleTemp} target={status.nozzleTarget} icon={<NozzleIcon size={15} />} />
        <TempTile label={t('printerTab.bed')} value={status.bedTemp} target={status.bedTarget} icon={<BedIcon size={15} />} />
      </div>
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
        <span className="flex items-center gap-1.5">
          <SeriesKey series="nozzle" />
          {t('printerTab.nozzle')}
        </span>
        <span className="flex items-center gap-1.5">
          <SeriesKey series="bed" />
          {t('printerTab.bed')}
        </span>
        <span className="flex items-center gap-1.5">
          <SeriesKey series="nozzle" dashed />
          <SeriesKey series="bed" dashed />
          {t('printerTab.target')}
        </span>
      </div>
      <div className="min-h-44 flex-1">
        <TempChart samples={temps} minutes={Number(win)} />
      </div>
      {status.chamberTemp != null && (
        <p className="mt-2 text-xs text-muted">
          {t('printerTab.chamber')}: {formatNumber(status.chamberTemp, { maximumFractionDigits: 1 })} °C
        </p>
      )}
    </section>
  )

  const recent = (
    <section className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
      <h3 className="flex items-center gap-2 border-b border-line px-4 py-3 font-semibold">
        <History size={17} className="text-sky-500" /> {t('printerTab.recent')}
      </h3>
      {prints.length === 0 ? (
        <Empty>{t('printerTab.noPrints')}</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {prints.slice(0, 12).map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              {fileOf(p.fileId)?.thumbnailUrl ? (
                <img src={fileOf(p.fileId)!.thumbnailUrl!} alt="" className="size-8 rounded-lg border border-line object-cover" />
              ) : (
                <FileCode2 size={16} className="text-muted" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{p.fileName}</p>
                <p className="truncate text-xs text-muted">
                  {p.username} · {timeAgo(t, p.endedAt ?? p.startedAt ?? p.createdAt)}
                  {p.grams != null && ` · ${formatNumber(p.grams, { maximumFractionDigits: 1 })} g`}
                </p>
              </div>
              <PrintStateBadge state={p.state} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )

  const camera = (
    <section className="flex min-h-48 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line bg-surface-2/50 p-5 text-center">
      <span className="flex size-10 items-center justify-center rounded-2xl bg-surface text-muted shadow-xs">
        <Camera size={18} />
      </span>
      <p className="text-sm font-medium">{t('printerTab.noCamera')}</p>
      <p className="max-w-60 text-xs text-muted">{t('printerTab.noCameraDesc')}</p>
    </section>
  )

  const panel = (
    <aside className="@container flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface-2/40 shadow-sm">
      <div className="space-y-2.5 border-b border-line bg-surface px-3 pt-3 pb-2.5">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-sky-500/10 text-sky-500">
            <PrinterModelIcon size={16} kinematics={printer.kinematics} model={printer.model} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-sm font-semibold">
              <span className="truncate">{printer.name}</span>
              <span className={`size-2 shrink-0 rounded-full ${status.online ? 'bg-emerald-500 shadow-[0_0_0_3px] shadow-emerald-500/20' : 'bg-zinc-400'}`} aria-hidden />
            </p>
            <p className="truncate text-[11px] text-muted">
              {printer.host}
              {printer.firmware ? ` · ${printer.firmware}` : ''} · {t(status.online ? 'printerTab.online' : 'printerTab.offline')}
            </p>
          </div>
          <Badge tone={STATE_TONE[status.state]}>{t(`printerTab.state.${status.state}`)}</Badge>
        </div>
        {picker}
        <div role="tablist" aria-label={t('printerTab.tabs.label')} className="grid grid-cols-4 gap-0.5 rounded-xl border border-line bg-surface-2 p-0.5">
          {TABS.map((k) => (
            <button
              key={k}
              id={`printer-tab-${k}`}
              type="button"
              role="tab"
              aria-selected={activeTab === k}
              aria-controls="printer-tabpanel"
              title={t(`printerTab.tabs.${k}`)}
              onClick={() => setTab(k)}
              className={`inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-lg px-1.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-sky-500 ${
                activeTab === k ? 'bg-surface text-fg shadow-xs' : 'text-muted hover:text-fg'
              }`}
            >
              <span className="@min-[19rem]:@max-[27rem]:hidden">{TAB_ICON[k]}</span>
              <span className="truncate @max-[19rem]:hidden">{t(`printerTab.tabs.${k}`)}</span>
            </button>
          ))}
        </div>
      </div>
      <div id="printer-tabpanel" role="tabpanel" aria-labelledby={`printer-tab-${activeTab}`} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2.5">
        {activeTab === 'main' ? main : activeTab === 'temps' ? tempsTab : activeTab === 'history' ? recent : camera}
      </div>
    </aside>
  )

  return (
    <div className="h-full overflow-auto xl:overflow-hidden">
      <div className="flex flex-col gap-3 p-3 xl:grid xl:h-full xl:grid-cols-[minmax(0,7fr)_minmax(340px,3fr)] xl:grid-rows-[minmax(0,1fr)_auto]">
        <div className="h-[58vh] min-h-[380px] xl:col-start-1 xl:row-start-1 xl:h-auto xl:min-h-0">
          <LiveView printerId={printer.id} status={status} canExclude={canCommand} overlay={overlay} />
        </div>
        <div className="xl:col-span-2 xl:row-start-2">{strip}</div>
        <div className="max-xl:min-h-[480px] xl:col-start-2 xl:row-start-1 xl:min-h-0 [&>aside]:h-full">{panel}</div>
      </div>
      {confirm && (
        <ConfirmCommand cmd={confirm} fileName={status.fileName?.split('/').pop() ?? ''} onClose={() => setConfirm(null)} onConfirm={() => run(confirm)} />
      )}
      {confirmBed && <ConfirmBedClear onClose={() => setConfirmBed(false)} onConfirm={bedCleared} />}
    </div>
  )
}

const degrees = (v: number | null, formatNumber: (n: number, o?: Intl.NumberFormatOptions) => string) =>
  v != null ? `${formatNumber(v, { maximumFractionDigits: 0 })} °C` : '—'

function tempText(value: number | null, target: number | null, formatNumber: (n: number, o?: Intl.NumberFormatOptions) => string) {
  if (value == null) return '—'
  const v = formatNumber(value, { maximumFractionDigits: 0 })
  return target ? `${v} / ${target} °C` : `${v} °C`
}

/** A compact label/value chip of the status strip. */
function Chip({ icon, label, value, title }: { icon: ReactNode; label: string; value: string; title?: string }) {
  return (
    <div className="flex h-9 min-w-0 items-center gap-1.5 rounded-xl bg-surface-2/70 px-2.5" title={title ?? `${label}: ${value}`}>
      {icon}
      <div className="min-w-0 leading-tight">
        <p className="truncate text-[10px] text-muted">{label}</p>
        <p className="truncate text-xs font-semibold tabular-nums">{value}</p>
      </div>
    </div>
  )
}

function ConfirmBedClear({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => Promise<void> }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    try {
      await onConfirm()
      onClose()
    } catch {
      setBusy(false)
    }
  }
  return (
    <Modal
      size="sm"
      title={t('printerTab.bedClearTitle')}
      icon={<Hand size={18} className="text-amber-500" />}
      onClose={onClose}
      dismissable={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy} data-autofocus>
            {t('common.cancel')}
          </Button>
          <Button variant="warning" loading={busy} icon={<Hand size={14} />} onClick={() => void go()}>
            {t('printerTab.bedClearConfirm')}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed">{t('printerTab.bedClearDesc')}</p>
    </Modal>
  )
}

function ConfirmCommand({ cmd, fileName, onClose, onConfirm }: { cmd: Command; fileName: string; onClose: () => void; onConfirm: () => Promise<void> }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    try {
      await onConfirm()
      onClose()
    } catch {
      setBusy(false)
    }
  }
  return (
    <Modal
      size="sm"
      title={t(`printerTab.confirm.${cmd}`)}
      icon={cmd === 'cancel' ? <Ban size={18} className="text-red-500" /> : cmd === 'pause' ? <CirclePause size={18} /> : <CirclePlay size={18} />}
      onClose={onClose}
      dismissable={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy} data-autofocus>
            {t('printerTab.keep')}
          </Button>
          <Button variant={cmd === 'cancel' ? 'danger' : 'primary'} loading={busy} onClick={() => void go()}>
            {t(`printerTab.${cmd}`)}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed">{t(`printerTab.confirmDesc.${cmd}`, { name: fileName })}</p>
    </Modal>
  )
}

function ProgressRing({ value, state }: { value: number; state: PrinterState }) {
  const { t } = useI18n()
  const r = 50
  const c = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(100, value))
  const color = state === 'paused' || state === 'pausing' ? '#f59e0b' : state === 'stopping' || state === 'failed' || state === 'error' ? '#ef4444' : state === 'complete' ? '#10b981' : state === 'aborted' ? '#a1a1aa' : '#0ea5e9'
  return (
    <div className="relative size-16 shrink-0 max-sm:size-12" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={t('printerTab.progress')}>
      <svg viewBox="0 0 120 120" className="size-full -rotate-90">
        <circle cx="60" cy="60" r={r} fill="none" stroke="currentColor" strokeWidth="12" className="text-surface-2" />
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="12"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct / 100)}
          className="transition-[stroke-dashoffset] duration-700 ease-out"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-sm font-semibold tabular-nums max-sm:text-xs">{Math.round(pct)}%</span>
    </div>
  )
}

function TempTile({ label, value, target, icon }: { label: string; value: number | null; target: number | null; icon: ReactNode }) {
  const { t, formatNumber } = useI18n()
  const heating = target != null && target > 0 && value != null && Math.abs(target - value) > 2
  return (
    <div className="rounded-xl border border-line p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium">
        {icon}
        <span className="text-muted">{label}</span>
        {heating && <span className="ml-auto text-[10px] text-amber-600 dark:text-amber-400">{t('printerTab.heating')}</span>}
      </p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">
        {value != null ? formatNumber(value, { maximumFractionDigits: 1 }) : '—'}
        <span className="text-sm font-normal text-muted"> °C</span>
      </p>
      <p className="text-xs text-muted tabular-nums">
        {t('printerTab.target')}: {target ? `${target} °C` : t('printerTab.off')}
      </p>
    </div>
  )
}

/**
 * Filament on the printer (strip): colour dot + the printer's spool name, "External spool" or the CFS slot; % only when
 * measured. Hover: vendor, type, nozzle temperature range ("200–220 °C") and pressure advance of every loaded slot.
 */
function FilamentChip({ slots }: { slots: CfsSlot[] | null }) {
  const { t } = useI18n()
  const loaded = (slots ?? []).filter((s) => s.name || s.material || s.color)
  if (!loaded.length) return null
  const where = (s: CfsSlot) => (s.external ? t('printerTab.externalSpool') : `CFS ${s.box}${String.fromCharCode(64 + s.slot)}`)
  const label = (s: CfsSlot) => s.name ?? s.material ?? t('printerTab.emptySlot')
  const range = (s: CfsSlot) => (s.minTemp != null && s.maxTemp != null ? `${s.minTemp}–${s.maxTemp} °C` : null)
  const line = (s: CfsSlot) =>
    [
      `${where(s)}: ${label(s)}${s.remainingPct != null ? ` (${s.remainingPct}%)` : ''}`,
      s.vendor && `${t('printerTab.spool.vendor')}: ${s.vendor}`,
      s.type && `${t('printerTab.spool.type')}: ${s.type}`,
      range(s) && `${t('printerTab.spool.temps')}: ${range(s)}`,
      s.pressureAdvance != null && `${t('printerTab.spool.pa')}: ${s.pressureAdvance}`,
    ]
      .filter(Boolean)
      .join('\n')
  const first = loaded.find((s) => s.external) ?? loaded[0]
  const more = loaded.length - 1
  return (
    <div className="flex h-9 min-w-0 items-center gap-1.5 rounded-xl bg-surface-2/70 px-2.5" title={loaded.map(line).join('\n\n')}>
      <span
        className={`size-3 shrink-0 rounded-full ring-2 ring-surface ${first.color ? '' : 'border border-dashed border-line'}`}
        style={first.color ? { background: first.color } : undefined}
      />
      <div className="min-w-0 leading-tight">
        <p className="truncate text-[10px] text-muted">
          {where(first)}
          {more > 0 && ` +${more}`}
        </p>
        <p className="max-w-36 truncate text-xs font-semibold">
          {label(first)}
          {first.remainingPct != null && <span className="font-normal text-muted"> · {first.remainingPct}%</span>}
        </p>
      </div>
    </div>
  )
}
