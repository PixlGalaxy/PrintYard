import { Box, TriangleAlert } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { Box3, Vector3 } from 'three'
import { useI18n } from '../../../i18n/I18nContext'
import { hullBox, toMatrix } from '../../../workspace/geometry'
import { meshes } from '../../../workspace/meshes'
import { outsideObjects } from '../../../workspace/ops'
import { useWs } from '../../../workspace/store'
import { floatCls } from './styles'

/** Bottom-left card: name, size, volume and triangle count of the selection. */
export default function ObjectInfo() {
  const { t, formatNumber } = useI18n()
  const selection = useWs((s) => s.selection)
  const doc = useWs((s) => s.doc)
  useSyncExternalStore(meshes.subscribe, () => meshes.version)
  const objs = doc.objects.filter((o) => selection.includes(o.id))
  if (!objs.length) return null

  const box = new Box3()
  let volume = 0
  let triangles = 0
  for (const o of objs) {
    const info = meshes.info(o.fileId)
    if (!info) continue
    const m = toMatrix(o.transform)
    box.union(hullBox(info.hull, m))
    volume += info.volume * Math.abs(m.determinant())
    triangles += info.triangles
  }
  const size = box.isEmpty() ? new Vector3() : box.getSize(new Vector3())
  const outside = outsideObjects(doc).some((o) => selection.includes(o.id))
  const fmt = (n: number) => formatNumber(n, { maximumFractionDigits: 1, minimumFractionDigits: 1 })

  return (
    <div className={`${floatCls} w-64 p-3 text-xs animate-[pop-in_.15s_ease-out]`}>
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-accent-500/10 text-accent-500">
          <Box size={16} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold">{objs.length === 1 ? objs[0].name : t('workspace.info.many', { n: objs.length })}</p>
          <p className="text-muted">{t('workspace.info.plate', { n: objs[0].plate + 1 })}</p>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
        <dt className="text-muted">{t('workspace.info.size')}</dt>
        <dd className="text-right font-mono tabular-nums">
          {fmt(size.x)} × {fmt(size.y)} × {fmt(size.z)} mm
        </dd>
        <dt className="text-muted">{t('workspace.info.volume')}</dt>
        <dd className="text-right font-mono tabular-nums">{formatNumber(volume / 1000, { maximumFractionDigits: 2 })} cm³</dd>
        <dt className="text-muted">{t('workspace.info.triangles')}</dt>
        <dd className="text-right font-mono tabular-nums">{formatNumber(triangles)}</dd>
      </dl>
      {outside && (
        <p className="mt-2.5 flex items-start gap-1.5 rounded-lg bg-red-500/10 px-2 py-1.5 text-[11px] text-red-600 dark:text-red-400">
          <TriangleAlert size={14} className="mt-px shrink-0" />
          {t('workspace.info.outside')}
        </p>
      )}
    </div>
  )
}
