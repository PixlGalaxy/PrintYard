import { Lock, LockOpen, Maximize, RotateCcw, X } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { Euler, Matrix4, Quaternion, Vector3 } from 'three'
import { useI18n } from '../../../i18n/I18nContext'
import { useStoredState } from '../../../hooks'
import { centerAt, DEG, decompose, hullBox, toMatrix } from '../../../workspace/geometry'
import { meshes } from '../../../workspace/meshes'
import { scaleToFit, setObjectMatrix } from '../../../workspace/ops'
import { useWs, workspace } from '../../../workspace/store'
import { Tip } from './bits'
import { floatCls } from './styles'
import NumberField from './NumberField'

const AXES = [
  ['X', 'text-red-500'],
  ['Y', 'text-emerald-500'],
  ['Z', 'text-accent-500'],
] as const

/** Numeric position / rotation / scale / size for one selected object. */
export default function TransformPanel() {
  const { t } = useI18n()
  const tool = useWs((s) => s.tool)
  const selection = useWs((s) => s.selection)
  const doc = useWs((s) => s.doc)
  useSyncExternalStore(meshes.subscribe, () => meshes.version)
  const [locked, setLocked] = useStoredState('sd:ws:scaleLock', true)

  if (selection.length !== 1 || tool === 'select' || tool === 'layFace') return null
  const obj = doc.objects.find((o) => o.id === selection[0])
  const info = obj && meshes.info(obj.fileId)
  if (!obj || !info) return null

  const m = toMatrix(obj.transform)
  const box = hullBox(info.hull, m)
  const center = box.getCenter(new Vector3())
  const { q, s } = decompose(m)
  const euler = new Euler().setFromQuaternion(q, 'XYZ')
  const rot = [euler.x / DEG, euler.y / DEG, euler.z / DEG]
  const scale = [s.x * 100, s.y * 100, s.z * 100]
  const size = [info.size.x * Math.abs(s.x), info.size.y * Math.abs(s.y), info.size.z * Math.abs(s.z)]

  /** Rebuilds the matrix from rotation + scale, keeping the object where it is. */
  const rebuild = (nq: Quaternion, ns: Vector3) => {
    const next = new Matrix4().compose(new Vector3(), nq, ns)
    centerAt(next, info.hull, center.x, center.y)
    setObjectMatrix(obj.id, next)
  }
  const setPos = (axis: number, v: number) => {
    const d = [0, 0, 0]
    d[axis] = v - (axis === 0 ? center.x : center.y)
    setObjectMatrix(obj.id, m.clone().premultiply(new Matrix4().makeTranslation(d[0], d[1], 0)))
  }
  const setRot = (axis: number, deg: number) => {
    const r = [...rot]
    r[axis] = deg
    rebuild(new Quaternion().setFromEuler(new Euler(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'XYZ')), s.clone())
  }
  const setScale = (axis: number, pct: number) => {
    const k = pct / 100
    if (k <= 0) return
    const ns = s.clone()
    if (locked) ns.multiplyScalar(k / Math.abs(s.getComponent(axis)))
    else ns.setComponent(axis, Math.sign(s.getComponent(axis)) * k)
    rebuild(q.clone(), ns)
  }
  const setSize = (axis: number, mm: number) => {
    const base = info.size.getComponent(axis)
    if (mm <= 0 || !base) return
    setScale(axis, (mm / base) * 100)
  }

  const row = (label: string, values: number[], onCommit: (axis: number, v: number) => void, opts: { suffix: string; step: number; digits: number; disabled?: number[] }) => (
    <div className="grid grid-cols-[64px_1fr_1fr_1fr] items-center gap-1.5">
      <span className="text-[11px] leading-tight font-medium text-muted">
        {label}
        <span className="block text-[10px] font-normal text-muted/70">{opts.suffix}</span>
      </span>
      {AXES.map(([a, cls], i) => (
        <NumberField
          key={a}
          label={`${label} ${a}`}
          prefix={a}
          prefixCls={cls}
          value={values[i]}
          step={opts.step}
          digits={opts.digits}
          disabled={opts.disabled?.includes(i)}
          onCommit={(v) => onCommit(i, v)}
        />
      ))}
    </div>
  )

  return (
    <div className={`${floatCls} w-[336px] p-3 max-sm:w-auto animate-[pop-in_.15s_ease-out]`}>
      <div className="mb-2.5 flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-xs font-semibold">{t(`workspace.tool.${tool}`)}</h3>
        <Tip label={t('workspace.transform.resetRotation')}>
          <button
            type="button"
            aria-label={t('workspace.transform.resetRotation')}
            onClick={() => rebuild(new Quaternion(), s.clone())}
            className="inline-flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
          >
            <RotateCcw size={14} />
          </button>
        </Tip>
        <Tip label={t('workspace.transform.scaleToFit')}>
          <button
            type="button"
            aria-label={t('workspace.transform.scaleToFit')}
            onClick={() => scaleToFit(obj.id)}
            className="inline-flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
          >
            <Maximize size={14} />
          </button>
        </Tip>
        <button
          type="button"
          aria-label={t('common.close')}
          onClick={() => workspace.setTool('select')}
          className="inline-flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
        >
          <X size={14} />
        </button>
      </div>
      <div className="space-y-1.5">
        {row(t('workspace.transform.position'), [center.x, center.y, box.min.z], (a, v) => setPos(a, v), { suffix: 'mm', step: 1, digits: 2, disabled: [2] })}
        {row(t('workspace.transform.rotation'), rot, setRot, { suffix: '°', step: 5, digits: 1 })}
        {row(t('workspace.transform.scale'), scale, setScale, { suffix: '%', step: 5, digits: 1 })}
        {row(t('workspace.transform.size'), size, setSize, { suffix: 'mm', step: 1, digits: 2 })}
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
    </div>
  )
}
