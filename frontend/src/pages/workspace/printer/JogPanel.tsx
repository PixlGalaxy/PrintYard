// Printer tab → Main: Repetier Host-style manual control, then preheat + light, then live-tuning slider rows.
// - Manual control: home buttons (X, Y, Z, all), a circular XY jog pad (ring segments ±X/±Y, centre = home XY),
//   a vertical Z pill (single step / ×10 step), a vertical E pill (extrude/retract, nozzle ≥ 170 °C), step selector
//   (0.1/1/10/50 mm), jog feedrate and the X/Y/Z readout (green = homed). Locked while a job is active.
// - Preheat: PLA/PETG/ABS/ASA/TPU (first-layer nozzle/bed temps of the bundled K2 SE "Generic" filament profiles,
//   bounded by the printer's maxima) + Off; light switch.
// - Sliders with a numeric input: speed % (M220), flow % (M221), part fan %, bed and nozzle temperature (gradient
//   track blue → green → yellow → red, current temperature marker, thumb = target). Allowed WHILE printing.
// Every control sends a TYPED command; the server builds the G-code. Disabled in read-only mode, offline, or
// without the "control the printer" permission (the reason is shown once, on top). Mirrors the server's safety rules:
// - bed occupied (last print not removed): homing, jogging and extruding are locked ("Remove the print first");
// - a print is being uploaded: motion and motors off are locked;
// - while a job runs/uploads: heaters, fan, speed and flow only for its owner or an admin.
import { ChevronDown, ChevronsDown, ChevronsUp, ChevronUp, Fan, Gauge, House, Lock, Move3d, Power, PowerOff, Waves } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '../../../api'
import { BedIcon, ExtruderIcon, LightIcon, NozzleIcon } from '../../../components/printerIcons'
import { inputCls, selectCls } from '../../../components/styles'
import { Segmented } from '../../../components/ui'
import { useToast } from '../../../context/ToastContext'
import { useStoredState } from '../../../hooks'
import { useI18n } from '../../../i18n/I18nContext'
import type { PrinterControlCommand, PrinterState, PrinterStatus } from '../../../types'

const ACTIVE: PrinterState[] = ['printing', 'paused', 'pausing', 'stopping']
const STEPS = ['0.1', '1', '10', '50'] as const
const FEEDS = [1500, 3000, 6000, 12000]
const Z_FEED = 600
const E_SPEED = 5
const MIN_EXTRUDE_TEMP = 170
/** First-layer temps of the bundled "Generic <material> @Creality K2 SE 0.4 nozzle" filament profiles. */
const PREHEAT = [
  { id: 'pla', nozzle: 220, bed: 60 },
  { id: 'petg', nozzle: 250, bed: 80 },
  { id: 'abs', nozzle: 260, bed: 90 },
  { id: 'asa', nozzle: 260, bed: 90 },
  { id: 'tpu', nozzle: 230, bed: 35 },
] as const
/** Last non-zero part-fan % per printer (in memory + localStorage): the Fan toggle restores it (default 100 %). */
const fanMem = new Map<number, number>()
function fanMemory(printerId: number): number {
  const cached = fanMem.get(printerId)
  if (cached) return cached
  try {
    const v = Number(localStorage.getItem(`sd:fan:last:${printerId}`))
    if (Number.isInteger(v) && v > 0 && v <= 100) {
      fanMem.set(printerId, v)
      return v
    }
  } catch {
    /* storage unavailable */
  }
  return 100
}
function rememberFan(printerId: number, v: number) {
  if (!Number.isInteger(v) || v <= 0 || v > 100) return
  fanMem.set(printerId, v)
  try {
    localStorage.setItem(`sd:fan:last:${printerId}`, String(v))
  } catch {
    /* storage unavailable */
  }
}
/** Optimistic slider value: kept until the printer reports it (or this timeout) */
const PENDING_MS = 5000
const COMMIT_DEBOUNCE_MS = 250
const TEMP_GRADIENT = 'linear-gradient(90deg, #3b82f6 0%, #22c55e 33%, #eab308 62%, #ef4444 100%)'

interface Props {
  printerId: number
  status: PrinterStatus
  /** Admin, or a user with the "can control the printer" permission */
  allowed: boolean
  readOnly: boolean
  /** A print is being uploaded to this printer (SliceDock state `uploading`). */
  uploading?: boolean
  /** The running/uploading job belongs to someone else and the viewer is not an admin (tuning locked). */
  jobLocked?: boolean
}

export default function JogPanel({ printerId, status, allowed, readOnly, uploading = false, jobLocked = false }: Props) {
  const { t } = useI18n()
  const { onError } = useToast()
  const [step, setStep] = useStoredState<(typeof STEPS)[number]>('sd:jog:step', '10')
  const [feed, setFeed] = useStoredState('sd:jog:feed', 6000)
  const [busy, setBusy] = useState<string | null>(null)

  const active = ACTIVE.includes(status.state)
  const blocked = readOnly || !status.online || !allowed
  const bedOccupied = status.bedClear === false
  /** Motors off: not while printing/uploading. Home/jog/extrude: also not while the bed is occupied. */
  const motorsOff = blocked || active || uploading
  const motionOff = motorsOff || bedOccupied
  /** Heaters, fan, speed, flow: owner/admin only while a job runs or uploads. */
  const tuningOff = blocked || jobLocked
  const homed = status.homedAxes ?? ''
  const maxN = status.maxNozzleTemp ?? 300
  const maxB = status.maxBedTemp ?? 100
  const cold = (status.nozzleTemp ?? 0) < MIN_EXTRUDE_TEMP
  const s = Number(step)
  const big = Math.min(50, s * 10)
  const eSmall = Math.max(1, Math.min(50, s))
  const eBig = Math.min(50, eSmall * 10)

  const reason = readOnly
    ? t('readOnly.tooltip')
    : !status.online
      ? t('jog.offline')
      : !allowed
        ? t('jog.noPermission')
        : jobLocked
          ? t('jog.ownerOnly')
          : active
            ? t('jog.printing')
            : uploading
              ? t('jog.uploading')
              : bedOccupied
                ? t('jog.bedOccupied')
                : null
  /** Tooltip over the locked motion controls. */
  const motionReason = motionOff ? (bedOccupied && !blocked && !active && !uploading ? t('jog.bedOccupied') : (reason ?? undefined)) : undefined

  async function send(key: string, cmd: PrinterControlCommand) {
    setBusy(key)
    try {
      await api.printerControl(printerId, cmd)
      return true
    } catch (err) {
      onError(err)
      return false
    } finally {
      setBusy(null)
    }
  }

  const jog = (axis: 'x' | 'y' | 'z', distance: number) =>
    void send(`jog-${axis}`, { action: 'jog', axis, distance, feedrate: axis === 'z' ? Z_FEED : feed })
  const axisOff = (a: 'x' | 'y' | 'z') => motionOff || !homed.includes(a) || busy !== null
  const eOff = motionOff || cold || busy !== null
  const eReason = !motionOff && cold ? t('jog.coldNozzle', { min: MIN_EXTRUDE_TEMP }) : undefined

  const fanOn = (status.fanPart ?? 0) > 0
  async function toggleFan() {
    if (fanOn) {
      rememberFan(printerId, status.fanPart ?? 0)
      await send('fan', { action: 'fan', percent: 0 })
    } else await send('fan', { action: 'fan', percent: fanMemory(printerId) })
  }

  async function preheat(nozzle: number, bed: number, key: string) {
    if (await send(key, { action: 'temp', heater: 'nozzle', target: Math.min(nozzle, maxN) })) {
      await send(key, { action: 'temp', heater: 'bed', target: Math.min(bed, maxB) })
    }
  }

  const homeBtn = (axes: 'x' | 'y' | 'z' | 'all', label: string) => (
    <button
      key={axes}
      type="button"
      title={t(`jog.home.${axes}`)}
      aria-label={t(`jog.home.${axes}`)}
      disabled={motionOff || busy !== null}
      onClick={() => void send(`home-${axes}`, { action: 'home', axes })}
      className={`flex h-8 w-11 flex-col items-center justify-center rounded-lg border text-[10px] leading-none font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-sky-500 disabled:pointer-events-none disabled:opacity-40 ${
        axes === 'all'
          ? 'border-sky-500/40 bg-sky-500/10 text-sky-700 hover:bg-sky-500/20 dark:text-sky-300'
          : 'border-line bg-surface hover:border-sky-500/50 hover:bg-sky-500/10'
      }`}
    >
      <House size={13} className={busy === `home-${axes}` ? 'animate-pulse' : ''} />
      <span className="mt-0.5">{label}</span>
    </button>
  )

  return (
    <>
      {reason && (
        <p className="flex items-start gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-0.5 text-[11px] leading-snug text-muted">
          <Lock size={13} className="mt-px shrink-0" />
          {reason}
        </p>
      )}

      {/* Manual control */}
      <section className="rounded-2xl border border-line bg-surface px-3 py-2.5 shadow-sm">
        <div className="mb-1.5 flex items-center gap-2">
          <Move3d size={16} className="text-sky-500" />
          <h3 className="mr-auto text-sm font-semibold">{t('jog.manual')}</h3>
          <span className="flex gap-1 font-mono text-[11px] tabular-nums" aria-label={t('jog.position')}>
            {(['x', 'y', 'z'] as const).map((a, i) => (
              <span
                key={a}
                title={homed.includes(a) ? t('jog.axisHomed', { axis: a.toUpperCase() }) : t('jog.axisNotHomed', { axis: a.toUpperCase() })}
                className={`rounded-md px-1.5 py-0.5 ${homed.includes(a) ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300' : 'bg-surface-2 text-muted'}`}
              >
                {a.toUpperCase()} {status.position ? status.position[i].toFixed(1) : '—'}
              </span>
            ))}
          </span>
        </div>

        <div className={`flex items-center justify-between gap-2 ${motionReason ? 'cursor-not-allowed' : ''}`} title={motionReason}>
          <div className="flex flex-col gap-1" role="group" aria-label={t('jog.homing')}>
            {homeBtn('x', 'X')}
            {homeBtn('y', 'Y')}
            {homeBtn('z', 'Z')}
            {homeBtn('all', t('jog.all'))}
          </div>

          <XYPad
            label={t('jog.xyPad')}
            homeLabel={t('jog.home.xy')}
            moveLabel={(axis) => t('jog.moveBy', { axis, d: step })}
            disabled={{ x: axisOff('x'), y: axisOff('y'), home: motionOff || busy !== null }}
            onJog={(axis, dir) => jog(axis, dir * s)}
            onHome={() => void send('home-xy', { action: 'home', axes: 'xy' })}
          />

          <Pill
            label={t('jog.zPad')}
            caption="Z"
            buttons={[
              { icon: <ChevronsUp size={16} />, label: t('jog.moveBy', { axis: 'Z+', d: big }), onClick: () => jog('z', big), disabled: axisOff('z') },
              { icon: <ChevronUp size={16} />, label: t('jog.moveBy', { axis: 'Z+', d: step }), onClick: () => jog('z', s), disabled: axisOff('z') },
              { icon: <ChevronDown size={16} />, label: t('jog.moveBy', { axis: 'Z-', d: step }), onClick: () => jog('z', -s), disabled: axisOff('z') },
              { icon: <ChevronsDown size={16} />, label: t('jog.moveBy', { axis: 'Z-', d: big }), onClick: () => jog('z', -big), disabled: axisOff('z') },
            ]}
          />
          <span title={eReason} className={eReason ? 'cursor-not-allowed' : ''}>
            <Pill
              label={t('jog.extruder')}
              caption="E"
              icon={<ExtruderIcon size={12} />}
              buttons={[
                { icon: <ChevronsUp size={16} />, label: t('jog.retractBy', { d: eBig }), onClick: () => void send('e', { action: 'extrude', length: -eBig, speed: E_SPEED }), disabled: eOff },
                { icon: <ChevronUp size={16} />, label: t('jog.retractBy', { d: eSmall }), onClick: () => void send('e', { action: 'extrude', length: -eSmall, speed: E_SPEED }), disabled: eOff },
                { icon: <ChevronDown size={16} />, label: t('jog.extrudeBy', { d: eSmall }), onClick: () => void send('e', { action: 'extrude', length: eSmall, speed: E_SPEED }), disabled: eOff },
                { icon: <ChevronsDown size={16} />, label: t('jog.extrudeBy', { d: eBig }), onClick: () => void send('e', { action: 'extrude', length: eBig, speed: E_SPEED }), disabled: eOff },
              ]}
            />
          </span>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Segmented label={t('jog.step')} value={step} onChange={setStep} options={STEPS.map((v) => ({ value: v, label: v }))} />
          <span className="text-[11px] text-muted">mm</span>
          <select aria-label={t('jog.feedrate')} title={t('jog.feedrate')} className={`${selectCls} h-8! w-auto! flex-1 text-xs`} value={feed} onChange={(e) => setFeed(Number(e.target.value))} disabled={motionOff}>
            {FEEDS.map((f) => (
              <option key={f} value={f}>
                {t('jog.feedOption', { v: f / 60 })}
              </option>
            ))}
          </select>
          <button
            type="button"
            title={t('jog.motorsOff')}
            aria-label={t('jog.motorsOff')}
            disabled={motorsOff || busy !== null}
            onClick={() => void send('motors', { action: 'motors_off' })}
            className="inline-flex size-8 items-center justify-center rounded-lg border border-line text-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-sky-500 disabled:pointer-events-none disabled:opacity-40"
          >
            <PowerOff size={14} />
          </button>
        </div>
        {!motionOff && homed !== 'xyz' && <p className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-300">{t('jog.homeFirst')}</p>}
      </section>

      {/* Preheat + light */}
      <section className="rounded-2xl border border-line bg-surface px-3 py-2.5 shadow-sm">
        <div className="flex items-center gap-2">
          <h3 className="mr-auto text-sm font-semibold">{t('jog.preheat')}</h3>
          <RoundToggle
            on={!!status.lightOn}
            tone="amber"
            icon={<LightIcon on={status.lightOn} size={14} className={status.lightOn ? 'text-white!' : ''} />}
            label={status.lightOn == null ? t('printerTab.lightUnknown') : t(status.lightOn ? 'printerTab.lightTurnOff' : 'printerTab.lightTurnOn')}
            disabled={blocked || busy !== null || status.lightOn == null}
            onClick={() => void send('light', { action: 'light', on: !status.lightOn })}
          />
          <RoundToggle
            on={fanOn}
            tone="cyan"
            icon={<Fan size={14} className={fanOn ? 'animate-spin [animation-duration:2s]' : ''} />}
            label={fanOn ? t('jog.fanTurnOff') : t('jog.fanTurnOn', { v: fanMemory(printerId) })}
            disabled={tuningOff || busy !== null || status.fanPart == null}
            onClick={() => void toggleFan()}
          />
        </div>
        <div className="mt-1.5 grid grid-cols-6 gap-1">
          {PREHEAT.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={tuningOff || busy !== null}
              title={t('jog.presetTitle', { nozzle: Math.min(p.nozzle, maxN), bed: Math.min(p.bed, maxB) })}
              onClick={() => void preheat(p.nozzle, p.bed, `preset-${p.id}`)}
              className="h-7 min-w-0 rounded-lg border border-line bg-surface-2/50 px-1 text-xs font-semibold transition-colors hover:border-orange-500/50 hover:bg-orange-500/10 focus-visible:outline-2 focus-visible:outline-sky-500 disabled:pointer-events-none disabled:opacity-40"
            >
              {busy === `preset-${p.id}` ? '…' : t(`jog.preset.${p.id}`)}
            </button>
          ))}
          <button
            type="button"
            disabled={tuningOff || busy !== null}
            title={t('jog.preheatOff')}
            onClick={() => void preheat(0, 0, 'preset-off')}
            className="inline-flex h-7 min-w-0 items-center justify-center gap-1 rounded-lg border border-rose-500/30 bg-rose-500/10 px-1 text-xs font-semibold text-rose-600 transition-colors hover:bg-rose-500/20 focus-visible:outline-2 focus-visible:outline-rose-500 disabled:pointer-events-none disabled:opacity-40 dark:text-rose-400"
          >
            <Power size={12} />
            <span className="truncate">{t('jog.preset.off')}</span>
          </button>
        </div>
      </section>

      {/* Live tuning (also while printing) */}
      <section className="space-y-0.5 rounded-2xl border border-line bg-surface px-3 py-2 shadow-sm">
        <SliderRow
          icon={<Gauge size={14} className="text-sky-500" />}
          label={t('jog.speedFactor')}
          unit="%"
          min={10}
          max={300}
          step={5}
          value={status.speedFactor ?? null}
          fallback={100}
          disabled={tuningOff}
          onCommit={(v) => send('speed', { action: 'speed_factor', percent: v })}
        />
        <SliderRow
          icon={<Waves size={14} className="text-sky-500" />}
          label={t('jog.flowFactor')}
          unit="%"
          min={50}
          max={150}
          step={1}
          value={status.flowFactor ?? null}
          fallback={100}
          disabled={tuningOff}
          onCommit={(v) => send('flow', { action: 'flow_factor', percent: v })}
        />
        <SliderRow
          icon={<Fan size={14} className={status.fanPart ? 'animate-spin text-sky-500 [animation-duration:2s]' : 'text-sky-500'} />}
          label={t('jog.partFan')}
          unit="%"
          min={0}
          max={100}
          step={5}
          value={status.fanPart ?? null}
          fallback={0}
          disabled={tuningOff}
          onCommit={(v) => {
            rememberFan(printerId, v)
            return send('fan', { action: 'fan', percent: v })
          }}
        />
        <SliderRow
          icon={<BedIcon size={14} />}
          label={t('printerTab.bed')}
          unit="°C"
          min={0}
          max={maxB}
          step={1}
          value={status.bedTarget ?? null}
          fallback={0}
          current={status.bedTemp}
          disabled={tuningOff}
          onCommit={(v) => send('bed', { action: 'temp', heater: 'bed', target: v })}
        />
        <SliderRow
          icon={<NozzleIcon size={14} />}
          label={t('printerTab.nozzle')}
          unit="°C"
          min={0}
          max={maxN}
          step={1}
          value={status.nozzleTarget ?? null}
          fallback={0}
          current={status.nozzleTemp}
          disabled={tuningOff}
          onCommit={(v) => send('nozzle', { action: 'temp', heater: 'nozzle', target: v })}
        />
      </section>
    </>
  )
}

// ---------------------------------------------------------------- circular XY pad

const polar = (r: number, deg: number) => {
  const a = (deg * Math.PI) / 180
  return `${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`
}
/** Annulus segment centred on `deg` (screen angles: 0 = right, 90 = down). */
const segment = (deg: number, r1: number, r2: number, half = 42) =>
  `M ${polar(r2, deg - half)} A ${r2} ${r2} 0 0 1 ${polar(r2, deg + half)} L ${polar(r1, deg + half)} A ${r1} ${r1} 0 0 0 ${polar(r1, deg - half)} Z`

function XYPad({
  label,
  homeLabel,
  moveLabel,
  disabled,
  onJog,
  onHome,
}: {
  label: string
  homeLabel: string
  moveLabel: (axis: string) => string
  disabled: { x: boolean; y: boolean; home: boolean }
  onJog: (axis: 'x' | 'y', dir: 1 | -1) => void
  onHome: () => void
}) {
  const segs = [
    { key: 'Y+', deg: -90, axis: 'y' as const, dir: 1 as const },
    { key: 'X+', deg: 0, axis: 'x' as const, dir: 1 as const },
    { key: 'Y-', deg: 90, axis: 'y' as const, dir: -1 as const },
    { key: 'X-', deg: 180, axis: 'x' as const, dir: -1 as const },
  ]
  const btn = (off: boolean, run: () => void) => ({
    role: 'button',
    tabIndex: off ? -1 : 0,
    'aria-disabled': off || undefined,
    onClick: () => !off && run(),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (!off && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault()
        run()
      }
    },
  })
  return (
    <svg viewBox="-100 -100 200 200" className="aspect-square w-full max-w-36 min-w-28 flex-1 select-none" role="group" aria-label={label}>
      <circle r="99" className="fill-surface-2/60 stroke-line" strokeWidth="1" />
      {segs.map((sg) => {
        const off = disabled[sg.axis]
        const [ax, ay] = polar(68, sg.deg).split(' ').map(Number)
        return (
          <g key={sg.key} {...btn(off, () => onJog(sg.axis, sg.dir))} aria-label={moveLabel(sg.key)} className={`group outline-none ${off ? 'opacity-40' : 'cursor-pointer'}`}>
            <title>{moveLabel(sg.key)}</title>
            <path
              d={segment(sg.deg, 38, 95)}
              className={`fill-surface stroke-line transition-colors ${off ? '' : 'group-hover:fill-sky-500/15 group-focus-visible:stroke-sky-500 group-active:fill-sky-500/30'}`}
              strokeWidth="1.5"
            />
            <g transform={`translate(${ax} ${ay}) rotate(${sg.deg + 90})`}>
              <path d="M -9 4 L 0 -6 L 9 4" fill="none" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" className={`stroke-muted ${off ? '' : 'group-hover:stroke-sky-600 dark:group-hover:stroke-sky-300'}`} />
            </g>
            <text
              x={ax}
              y={ay + (sg.deg === -90 ? 22 : sg.deg === 90 ? -16 : 18)}
              textAnchor="middle"
              className="fill-muted font-mono text-[13px] font-semibold"
            >
              {sg.key}
            </text>
          </g>
        )
      })}
      <g {...btn(disabled.home, onHome)} aria-label={homeLabel} className={`group outline-none ${disabled.home ? 'opacity-40' : 'cursor-pointer'}`}>
        <title>{homeLabel}</title>
        <circle r="31" className={`fill-sky-500/10 stroke-sky-500/40 ${disabled.home ? '' : 'group-hover:fill-sky-500/20 group-focus-visible:stroke-sky-500'}`} strokeWidth="1.5" />
        <House x={-12} y={-15} width={24} height={24} className="text-sky-600 dark:text-sky-300" />
        <text y="20" textAnchor="middle" className="fill-sky-700 font-mono text-[10px] font-semibold dark:fill-sky-300">
          XY
        </text>
      </g>
    </svg>
  )
}

// ---------------------------------------------------------------- vertical pills (Z, E)

function Pill({ label, caption, icon, buttons }: { label: string; caption: string; icon?: ReactNode; buttons: { icon: ReactNode; label: string; onClick: () => void; disabled: boolean }[] }) {
  const b = (x: (typeof buttons)[number], i: number) => (
    <button
      key={i}
      type="button"
      title={x.label}
      aria-label={x.label}
      disabled={x.disabled}
      onClick={x.onClick}
      className="flex h-7 w-full items-center justify-center rounded-full text-fg transition-colors hover:bg-sky-500/15 hover:text-sky-700 focus-visible:outline-2 focus-visible:outline-sky-500 active:bg-sky-500/25 disabled:pointer-events-none disabled:opacity-35 dark:hover:text-sky-300"
    >
      {x.icon}
    </button>
  )
  return (
    <div role="group" aria-label={label} className="flex w-10 flex-col items-center gap-0.5 rounded-full border border-line bg-surface-2/60 p-0.5">
      {b(buttons[0], 0)}
      {b(buttons[1], 1)}
      <span className="flex h-5 items-center gap-0.5 font-mono text-[11px] font-semibold text-muted" aria-hidden>
        {icon}
        {caption}
      </span>
      {b(buttons[2], 2)}
      {b(buttons[3], 3)}
    </div>
  )
}

// ---------------------------------------------------------------- round toggle (light, fan)

function RoundToggle({ on, tone, icon, label, disabled, onClick }: { on: boolean; tone: 'amber' | 'cyan'; icon: ReactNode; label: string; disabled: boolean; onClick: () => void }) {
  const lit = tone === 'amber' ? 'border-amber-500 bg-amber-500 text-white shadow-md shadow-amber-500/30' : 'border-cyan-500 bg-cyan-500 text-white shadow-md shadow-cyan-500/30'
  const idle = tone === 'amber' ? 'border-amber-500/60 text-amber-600 hover:bg-amber-500/10 dark:text-amber-300' : 'border-cyan-500/60 text-cyan-600 hover:bg-cyan-500/10 dark:text-cyan-300'
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex size-7 shrink-0 items-center justify-center rounded-full border-2 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:pointer-events-none disabled:opacity-40 ${on ? lit : idle}`}
    >
      {icon}
    </button>
  )
}

// ---------------------------------------------------------------- slider rows

function SliderRow({
  icon,
  label,
  unit,
  min,
  max,
  step,
  value,
  fallback,
  current,
  disabled,
  onCommit,
}: {
  icon: ReactNode
  label: string
  unit: string
  min: number
  max: number
  step: number
  /** Value reported by the printer (target for temperatures) */
  value: number | null
  fallback: number
  /** Current temperature (temperature rows): marker on the gradient track */
  current?: number | null
  disabled: boolean
  onCommit: (v: number) => Promise<boolean>
}) {
  const { t, formatNumber } = useI18n()
  const { toast } = useToast()
  // draft = while dragging; pending = sent (or about to be), shown until the printer reports it (no snap-back)
  const [draft, setDraft] = useState<number | null>(null)
  const [pending, setPending] = useState<number | null>(null)
  const [text, setText] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const expiry = useRef<ReturnType<typeof setTimeout> | null>(null)
  const temp = current !== undefined
  // Confirmed by the printer: drop the optimistic value (state adjusted during render)
  if (pending !== null && value === pending) setPending(null)
  const shown = draft ?? pending ?? value ?? fallback
  const pct = (v: number) => ((Math.max(min, Math.min(max, v)) - min) / (max - min || 1)) * 100
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      if (expiry.current) clearTimeout(expiry.current)
    },
    [],
  )

  const commit = (v: number) => {
    const n = Math.round(Math.max(min, Math.min(max, v)))
    setDraft(null)
    if (timer.current) clearTimeout(timer.current)
    if (n === (value ?? fallback) && pending === null) return
    setPending(n)
    timer.current = setTimeout(() => {
      void onCommit(n).then((ok) => {
        if (expiry.current) clearTimeout(expiry.current)
        if (!ok) return setPending((p) => (p === n ? null : p)) // the error was already toasted
        // Not confirmed in time: back to what the printer reports
        expiry.current = setTimeout(() => {
          setPending((p) => {
            if (p === n) toast('error', t('jog.notConfirmed', { name: label }))
            return p === n ? null : p
          })
        }, PENDING_MS)
      })
    }, COMMIT_DEBOUNCE_MS)
  }
  const commitText = () => {
    if (text === null) return
    const n = Number(text.replace(',', '.'))
    setText(null)
    if (text.trim() !== '' && Number.isFinite(n)) commit(n)
  }

  return (
    <div className="grid grid-cols-[6.25rem_minmax(0,1fr)_4.25rem] items-center gap-2">
      <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      <div className="relative h-6" title={temp && current != null ? t('jog.currentTemp', { v: formatNumber(current, { maximumFractionDigits: 1 }) }) : undefined}>
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-surface-2" style={temp ? { background: TEMP_GRADIENT, opacity: disabled ? 0.45 : 0.9 } : undefined}>
          {!temp && <div className="h-full rounded-full bg-sky-500/70" style={{ width: `${pct(shown)}%` }} />}
        </div>
        {temp && current != null && (
          <span
            aria-hidden
            className="absolute top-0 h-6 w-0.5 -translate-x-1/2 rounded-full bg-fg/80 shadow-[0_0_0_1.5px] shadow-surface"
            style={{ left: `${pct(current)}%` }}
          />
        )}
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={shown}
          disabled={disabled}
          aria-label={label}
          aria-valuetext={`${shown} ${unit}`}
          onPointerDown={() => setDraft(shown)}
          onChange={(e) => setDraft(Number(e.target.value))}
          onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key.startsWith('Page')) && commit(Number((e.target as HTMLInputElement).value))}
          className="absolute inset-0 h-6 w-full cursor-pointer appearance-none bg-transparent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 [&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-sky-500 [&::-moz-range-thumb]:bg-surface [&::-moz-range-track]:bg-transparent [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-sky-500 [&::-webkit-slider-thumb]:bg-surface [&::-webkit-slider-thumb]:shadow-sm focus-visible:[&::-webkit-slider-thumb]:ring-4 focus-visible:[&::-webkit-slider-thumb]:ring-sky-500/30"
        />
      </div>
      <label className="relative block">
        <span className="sr-only">{label}</span>
        <input
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          value={text ?? String(shown)}
          onChange={(e) => setText(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitText()
            if (e.key === 'Escape') setText(null)
          }}
          className={`${inputCls} h-7! pr-7! pl-2! text-right text-xs tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none`}
        />
        <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[10px] text-muted">{unit}</span>
      </label>
    </div>
  )
}
