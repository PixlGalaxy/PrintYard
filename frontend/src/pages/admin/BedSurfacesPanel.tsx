import { Check, Layers } from 'lucide-react'
import { useState } from 'react'
import { adminApi } from '../../api'
import { selectCls } from '../../components/styles'
import { useToast } from '../../context/ToastContext'
import { useI18n } from '../../i18n/I18nContext'
import { BED_SURFACES, DEFAULT_BED_SURFACE, type BedSurface, type Printer } from '../../types'
import { BED_KEYS, ownedSurfaces } from '../../workspace/bedSurfaces'
import { Panel } from './shared'

/** Admin → Printers: which bed surfaces the owner has per printer (Prepare only offers those) + the default one. */
export default function BedSurfacesPanel({ printers, onSaved }: { printers: Printer[]; onSaved: (p: Printer) => void }) {
  const { t } = useI18n()
  if (printers.length === 0) return null
  return (
    <Panel title={t('printers.bed.title')} description={t('printers.bed.desc')} icon={<Layers size={18} />}>
      <div className="space-y-5">
        {printers.map((p) => (
          <PrinterSurfaces key={p.id} printer={p} showName={printers.length > 1} onSaved={onSaved} />
        ))}
      </div>
    </Panel>
  )
}

function PrinterSurfaces({ printer, showName, onSaved }: { printer: Printer; showName: boolean; onSaved: (p: Printer) => void }) {
  const { t } = useI18n()
  const { toast, onError } = useToast()
  const { list, def } = ownedSurfaces(printer)
  const [busy, setBusy] = useState(false)

  async function save(bedSurfaces: BedSurface[], defaultBedSurface: BedSurface) {
    setBusy(true)
    try {
      onSaved(await adminApi.updatePrinter(printer.id, { bedSurfaces, defaultBedSurface }))
      toast('success', t('printers.bed.saved'))
    } catch (err) {
      onError(err)
    } finally {
      setBusy(false)
    }
  }

  const toggle = (b: BedSurface) => {
    const next = list.includes(b) ? list.filter((x) => x !== b) : BED_SURFACES.filter((x) => x === b || list.includes(x))
    if (next.length === 0) return
    void save(next, next.includes(def) ? def : next[0]!)
  }

  return (
    <div className="space-y-3">
      {showName && <p className="text-sm font-semibold">{printer.name}</p>}
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('printers.bed.owned')}>
        {BED_SURFACES.map((b) => {
          const on = list.includes(b)
          const last = on && list.length === 1
          return (
            <button
              key={b}
              type="button"
              aria-pressed={on}
              disabled={busy || last}
              title={last ? t('printers.bed.atLeastOne') : undefined}
              onClick={() => toggle(b)}
              className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent-500 disabled:cursor-not-allowed ${
                on ? 'border-accent-500/50 bg-accent-500/10 text-accent-700 dark:text-accent-300' : 'border-line text-muted hover:border-accent-500/30 hover:text-fg'
              } ${busy ? 'opacity-60' : ''}`}
            >
              <span className={`flex size-3.5 items-center justify-center rounded border ${on ? 'border-accent-500 bg-accent-500 text-white' : 'border-line'}`}>
                {on && <Check size={10} strokeWidth={3} />}
              </span>
              {t(BED_KEYS[b])}
              {b === DEFAULT_BED_SURFACE && (
                <span className="rounded-full bg-emerald-500/15 px-1.5 py-px text-[10px] font-semibold text-emerald-700 dark:text-emerald-300" title={t('printers.bed.recommendedDesc')}>
                  {t('printers.bed.recommended')}
                </span>
              )}
            </button>
          )
        })}
      </div>
      <label className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <span>
          <span className="block text-sm font-medium">{t('printers.bed.default')}</span>
          <span className="block text-xs text-muted">{t('printers.bed.defaultDesc')}</span>
        </span>
        <select className={`${selectCls} sm:w-56`} value={def} disabled={busy || list.length < 2} onChange={(e) => void save(list, e.target.value as BedSurface)}>
          {list.map((b) => (
            <option key={b} value={b}>
              {t(BED_KEYS[b])}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
