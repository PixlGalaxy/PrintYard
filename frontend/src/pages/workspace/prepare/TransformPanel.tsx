import { Lock, LockOpen, Maximize, RotateCcw, X } from 'lucide-react'
import { useRef, useSyncExternalStore, type ReactNode } from 'react'
import { Euler, Matrix4, Quaternion, Vector3 } from 'three'
import { useI18n } from '../../../i18n/I18nContext'
import { useStoredState } from '../../../hooks'
import { centerAt, DEG, decompose, hullBox, toMatrix } from '../../../workspace/geometry'
import { meshes } from '../../../workspace/meshes'
import { rotateSelected, scaleToFit, setObjectMatrix } from '../../../workspace/ops'
import { useWs, workspace } from '../../../workspace/store'
import { Tip } from './bits'
import { floatCls } from './styles'
import NumberField from './NumberField'

const AXES = [
  ['X', 'text-red-500'],
  ['Y', 'text-emerald-500'],
  ['Z', 'text-accent-500'],
] as const
const AXIS_KEYS = ['x', 'y', 'z'] as const
/** Quick-rotate steps (°) around each world axis, applied to every selected object. */
const ROT_STEPS = [-90, -45, 45, 90]
/** Scale slider range (%); the number field accepts any positive value. */
const SCALE_MIN = 10
const SCALE_MAX = 400
const SCALE_PRESETS = [50, 100, 150, 200]

const iconBtn = 'inline-flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg'
const chipBtn =
  'h-7 rounded-md border border-line bg-surface-2/50 px-1 font-mono text-[11px] font-semibold tabular-nums transition-colors hover:border-accent-500/50 hover:bg-accent-500/10 focus-visible:outline-2 focus-visible:outline-accent-500'

/**
 * Floating card of the Move / Rotate / Scale tools; each tool gets its own card:
 * - Move: position.
 * - Rotate: ±45/±90° buttons per axis (whole selection, each object around its centre) and, with one object,
 *   the numeric rotation.
 * - Scale: a slider + % field (one uniform slider, or one per axis when unlocked), quick presets and the size in mm.
 */
export default function TransformPanel() {
  const { t } = useI18n()
  const tool = useWs((s) => s.tool)
  const selection = useWs((s) => s.selection)
  const doc = useWs((s) => s.doc)
  useSyncExternalStore(meshes.subscribe, () => meshes.version)
  const [locked, setLocked] = useStoredState('sd:ws:scaleLock', true)
  /** A slider drag in progress: only its first step goes to the undo history. */
  const dragging = useRef(false)

  if (tool !== 'move' && tool !== 'rotate' && tool !== 'scale') return null
  if (!selection.length || (tool !== 'rotate' && selection.length !== 1)) return null
  const obj = selection.length === 1 ? doc.objects.find((o) => o.id === selection[0]) : undefined
  const info = obj && meshes.info(obj.fileId)
  if (tool !== 'rotate' && (!obj || !info)) return null

  const header = (extra: ReactNode) => (
    <div className="mb-2.5 flex items-center gap-2">
      <h3 className="min-w-0 flex-1 truncate text-xs font-semibold">
        {t(`workspace.tool.${tool}`)}
        {selection.length > 1 && <span className="ml-1.5 font-normal text-muted">{t('workspace.transform.objects', { n: selection.length })}</span>}
      </h3>
      {extra}
      <button type="button" aria-label={t('common.close')} onClick={() => workspace.setTool('select')} className={iconBtn}>
        <X size={14} />
      </button>
    </div>
  )
  const card = (children: ReactNode) => <div className={`${floatCls} w-[336px] p-3 max-sm:w-auto animate-[pop-in_.15s_ease-out]`}>{children}</div>
  const label = (text: string, unit: string) => (
    <span className="text-[11px] leading-tight font-medium text-muted">
      {text}
      <span className="block text-[10px] font-normal text-muted/70">{unit}</span>
    </span>
  )

  // ---- single-object maths (all three cards)
  const single = obj && info ? (() => {
    const m = toMatrix(obj.transform)
    const box = hullBox(info.hull, m)
    const center = box.getCenter(new Vector3())
    const { q, s } = decompose(m)
    const euler = new Euler().setFromQuaternion(q, 'XYZ')
    return { m, box, center, q, s, rot: [euler.x / DEG, euler.y / DEG, euler.z / DEG] }
  })() : null

  /** Rebuilds the matrix from rotation + scale, keeping the object where it is. */
  const rebuild = (nq: Quaternion, ns: Vector3, history = true) => {
    if (!obj || !info || !single) return
    const next = new Matrix4().compose(new Vector3(), nq, ns)
    centerAt(next, info.hull, single.center.x, single.center.y)
    setObjectMatrix(obj.id, next, history)
  }

  // ---------------------------------------------------------------- Move
  if (tool === 'move' && single && obj) {
    const setPos = (axis: number, v: number) => {
      const d = [0, 0]
      d[axis] = v - (axis === 0 ? single.center.x : single.center.y)
      setObjectMatrix(obj.id, single.m.clone().premultiply(new Matrix4().makeTranslation(d[0], d[1], 0)))
    }
    const values = [single.center.x, single.center.y, single.box.min.z]
    return card(
      <>
        {header(null)}
        <div className="grid grid-cols-[64px_1fr_1fr_1fr] items-center gap-1.5">
          {label(t('workspace.transform.position'), 'mm')}
          {AXES.map(([a, cls], i) => (
            <NumberField key={a} label={`${t('workspace.transform.position')} ${a}`} prefix={a} prefixCls={cls} value={values[i]} step={1} digits={2} disabled={i === 2} onCommit={(v) => setPos(i, v)} />
          ))}
        </div>
      </>,
    )
  }

  // ---------------------------------------------------------------- Rotate
  if (tool === 'rotate') {
    const setRot = (axis: number, deg: number) => {
      if (!single) return
      const r = [...single.rot]
      r[axis] = deg
      rebuild(new Quaternion().setFromEuler(new Euler(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'XYZ')), single.s.clone())
    }
    return card(
      <>
        {header(
          single && (
            <Tip label={t('workspace.transform.resetRotation')}>
              <button type="button" aria-label={t('workspace.transform.resetRotation')} onClick={() => rebuild(new Quaternion(), single.s.clone())} className={iconBtn}>
                <RotateCcw size={14} />
              </button>
            </Tip>
          ),
        )}
        <div className="space-y-1.5">
          {AXES.map(([a, cls], i) => (
            <div key={a} className="grid grid-cols-[14px_repeat(2,minmax(0,1fr))_minmax(0,1.6fr)_repeat(2,minmax(0,1fr))] items-center gap-1">
              <span className={`font-mono text-[11px] font-bold ${cls}`}>{a}</span>
              {ROT_STEPS.slice(0, 2).map((d) => (
                <button key={d} type="button" title={t('workspace.transform.rotateBy', { axis: a, deg: d })} onClick={() => rotateSelected(AXIS_KEYS[i], d)} className={chipBtn}>
                  {d}°
                </button>
              ))}
              {single ? (
                <NumberField label={`${t('workspace.transform.rotation')} ${a}`} suffix="°" value={single.rot[i]} step={5} digits={1} onCommit={(v) => setRot(i, v)} />
              ) : (
                <span className="text-center text-[11px] text-muted">—</span>
              )}
              {ROT_STEPS.slice(2).map((d) => (
                <button key={d} type="button" title={t('workspace.transform.rotateBy', { axis: a, deg: `+${d}` })} onClick={() => rotateSelected(AXIS_KEYS[i], d)} className={chipBtn}>
                  +{d}°
                </button>
              ))}
            </div>
          ))}
        </div>
        {selection.length > 1 && <p className="mt-2 text-[11px] leading-snug text-muted">{t('workspace.transform.rotateEach')}</p>}
      </>,
    )
  }

  // ---------------------------------------------------------------- Scale
  if (!single || !obj || !info) return null
  const { s, q } = single
  const scale = [s.x * 100, s.y * 100, s.z * 100]
  const size = [info.size.x * Math.abs(s.x), info.size.y * Math.abs(s.y), info.size.z * Math.abs(s.z)]
  const setScale = (axis: number, pct: number, history = true) => {
    const k = pct / 100
    if (k <= 0) return
    const ns = s.clone()
    if (locked) ns.multiplyScalar(k / Math.abs(s.getComponent(axis)))
    else ns.setComponent(axis, Math.sign(s.getComponent(axis)) * k)
    rebuild(q.clone(), ns, history)
  }
  const setSize = (axis: number, mm: number) => {
    const base = info.size.getComponent(axis)
    if (mm <= 0 || !base) return
    setScale(axis, (mm / base) * 100)
  }
  /** Slider change: the first step of a drag is undoable, the rest replace it (one drag = one undo). */
  const slide = (axis: number, pct: number) => {
    setScale(axis, pct, !dragging.current)
    dragging.current = true
  }
  const endSlide = () => {
    dragging.current = false
  }

  const sliderRow = (axis: number, prefix: ReactNode, aria: string) => {
    const v = Math.abs(scale[axis])
    const pct = ((Math.min(SCALE_MAX, Math.max(SCALE_MIN, v)) - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)) * 100
    return (
      <div key={axis} className="grid grid-cols-[64px_minmax(0,1fr)_76px] items-center gap-2">
        {prefix}
        <div className="relative h-6">
          <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-accent-500/70" style={{ width: `${pct}%` }} />
          </div>
          {/* 100 % mark */}
          <span aria-hidden className="absolute top-1 h-4 w-0.5 -translate-x-1/2 rounded-full bg-fg/30" style={{ left: `${((100 - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)) * 100}%` }} />
          <input
            type="range"
            min={SCALE_MIN}
            max={SCALE_MAX}
            step={1}
            value={Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(v)))}
            aria-label={aria}
            aria-valuetext={`${Math.round(v)} %`}
            onChange={(e) => slide(axis, Number(e.target.value))}
            onPointerUp={(e) => {
              endSlide()
              // a mouse drag gives the focus back, so Ctrl+Z and the tool keys work right away
              e.currentTarget.blur()
            }}
            onKeyUp={endSlide}
            onBlur={endSlide}
            className="absolute inset-0 h-6 w-full cursor-pointer appearance-none bg-transparent focus-visible:outline-none [&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-accent-500 [&::-moz-range-thumb]:bg-surface [&::-moz-range-track]:bg-transparent [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-accent-500 [&::-webkit-slider-thumb]:bg-surface [&::-webkit-slider-thumb]:shadow-sm focus-visible:[&::-webkit-slider-thumb]:ring-4 focus-visible:[&::-webkit-slider-thumb]:ring-accent-500/30"
          />
        </div>
        <NumberField label={aria} suffix="%" value={v} step={5} digits={1} min={0.1} onCommit={(n) => setScale(axis, n)} />
      </div>
    )
  }

  return card(
    <>
      {header(
        <Tip label={t('workspace.transform.scaleToFit')}>
          <button type="button" aria-label={t('workspace.transform.scaleToFit')} onClick={() => scaleToFit(obj.id)} className={iconBtn}>
            <Maximize size={14} />
          </button>
        </Tip>,
      )}
      <div className="space-y-1">
        {locked
          ? sliderRow(0, label(t('workspace.transform.scale'), '%'), t('workspace.transform.scale'))
          : AXES.map(([a, cls], i) =>
              sliderRow(
                i,
                <span className="text-[11px] font-medium text-muted">
                  {i === 0 ? t('workspace.transform.scale') : ''} <b className={`font-mono ${cls}`}>{a}</b>
                </span>,
                `${t('workspace.transform.scale')} ${a}`,
              ),
            )}
      </div>
      <div className="mt-1.5 grid grid-cols-[64px_repeat(4,minmax(0,1fr))] items-center gap-1.5">
        <span />
        {SCALE_PRESETS.map((p) => {
          const on = scale.every((v) => Math.abs(Math.abs(v) - p) < 0.05)
          return (
            <button
              key={p}
              type="button"
              aria-pressed={on}
              onClick={() => rebuild(q.clone(), new Vector3(Math.sign(s.x) * (p / 100), Math.sign(s.y) * (p / 100), Math.sign(s.z) * (p / 100)))}
              className={`${chipBtn} ${on ? 'border-accent-500/60! bg-accent-500/15! text-accent-700 dark:text-accent-300' : ''}`}
            >
              {p}%
            </button>
          )
        })}
      </div>
      <div className="mt-2.5 grid grid-cols-[64px_1fr_1fr_1fr] items-center gap-1.5 border-t border-line pt-2.5">
        {label(t('workspace.transform.size'), 'mm')}
        {AXES.map(([a, cls], i) => (
          <NumberField key={a} label={`${t('workspace.transform.size')} ${a}`} prefix={a} prefixCls={cls} value={size[i]} step={1} digits={2} onCommit={(v) => setSize(i, v)} />
        ))}
      </div>
      <button
        type="button"
        onClick={() => setLocked((l) => !l)}
        aria-pressed={locked}
        className={`mt-2.5 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium transition-colors ${locked ? 'bg-accent-500/10 text-accent-600 dark:text-accent-400' : 'text-muted hover:bg-surface-2'}`}
      >
        {locked ? <Lock size={12} /> : <LockOpen size={12} />}
        {t('workspace.transform.uniform')}
      </button>
    </>,
  )
}
