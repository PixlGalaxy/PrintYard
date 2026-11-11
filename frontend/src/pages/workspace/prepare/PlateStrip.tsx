import { LayoutGrid, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import ConfirmModal from '../../../components/ConfirmModal'
import { useI18n } from '../../../i18n/I18nContext'
import { addPlate, arrange, env, MAX_PLATES, removePlate } from '../../../workspace/ops'
import { useWs, workspace } from '../../../workspace/store'
import { Tip } from './bits'
import { floatCls } from './styles'

/** Plates as chips (like Creality's per-plate icons): pick the active plate, arrange it, delete it. */
export default function PlateStrip() {
  const { t } = useI18n()
  const doc = useWs((s) => s.doc)
  const active = useWs((s) => s.activePlate)
  const [confirm, setConfirm] = useState<number | null>(null)
  const counts = doc.plates.map((_, i) => doc.objects.filter((o) => o.plate === i).length)

  const pick = (i: number) => {
    workspace.setActivePlate(i)
    env.viewport?.setView('iso', true, 'plate')
  }

  return (
    <>
    <div className={`${floatCls} flex max-w-full items-center gap-1 p-1`}>
      <div className="relative flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:thin]">
        {doc.plates.map((p, i) => (
          <button
            key={i}
            type="button"
            onClick={() => pick(i)}
            aria-pressed={i === active}
            title={p.name || t('workspace.plate.name', { n: i + 1 })}
            className={`flex h-8 shrink-0 items-center gap-1.5 rounded-xl px-2.5 text-xs font-semibold transition-colors ${
              i === active ? 'bg-accent-500 text-white shadow-sm shadow-accent-500/30' : 'text-muted hover:bg-surface-2 hover:text-fg'
            }`}
          >
            <span className="tabular-nums">{i + 1}</span>
            {p.name && <span className="max-w-24 truncate font-medium">{p.name}</span>}
            <span className={`rounded-full px-1.5 text-[10px] tabular-nums ${i === active ? 'bg-white/20' : 'bg-surface-2'}`}>{counts[i]}</span>
          </button>
        ))}
      </div>
      <span aria-hidden className="mx-0.5 h-6 w-px shrink-0 bg-line" />
      <Tip label={t('workspace.arrange.plate')} side="top">
        <button
          type="button"
          aria-label={t('workspace.arrange.plate')}
          disabled={!counts[active]}
          onClick={() => arrange('plate')}
          className="inline-flex size-8 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-35"
        >
          <LayoutGrid size={16} />
        </button>
      </Tip>
      <Tip label={t('workspace.plate.delete')} side="top">
        <button
          type="button"
          aria-label={t('workspace.plate.delete')}
          disabled={doc.plates.length <= 1 && !counts[active]}
          onClick={() => (counts[active] ? setConfirm(active) : removePlate(active))}
          className="inline-flex size-8 items-center justify-center rounded-xl text-muted hover:bg-red-500/10 hover:text-red-500 disabled:opacity-35"
        >
          <Trash2 size={16} />
        </button>
      </Tip>
      <Tip label={t('workspace.tool.addPlate')} side="top">
        <button
          type="button"
          aria-label={t('workspace.tool.addPlate')}
          disabled={doc.plates.length >= MAX_PLATES}
          onClick={addPlate}
          className="inline-flex size-8 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-35"
        >
          <Plus size={16} />
        </button>
      </Tip>
    </div>
      {confirm !== null && (
        <ConfirmModal
          title={t('workspace.plate.deleteTitle', { n: confirm + 1 })}
          confirmLabel={t('common.delete')}
          onConfirm={async () => removePlate(confirm)}
          onClose={() => setConfirm(null)}
        >
          {t('workspace.plate.deleteBody', { n: counts[confirm] })}
        </ConfirmModal>
      )}
    </>
  )
}
