// Bed temperatures of a filament as one table (surface × first layer / other layers), with the surface in use
// highlighted. Used for the bed temperature group of the filament settings (Prepare slots and the Profiles tab).
import { RotateCcw, ThermometerSun } from 'lucide-react'
import { useI18n } from '../../../../i18n/I18nContext'
import type { TranslationKey } from '../../../../i18n/translations'
import type { OptionDef } from '../../../../types'

/** Bed temperature keys per bed surface (prefix → PlateDef.bedType + label) */
const BEDS: { prefix: string; bedType: string; label: TranslationKey }[] = [
  { prefix: 'epoxy_resin_plate', bedType: 'Epoxy Resin Plate', label: 'workspace.bed.epoxy' },
  { prefix: 'textured_plate', bedType: 'Textured PEI Plate', label: 'workspace.bed.texturedPei' },
  { prefix: 'hot_plate', bedType: 'High Temp Plate', label: 'workspace.bed.smoothPei' },
  { prefix: 'cool_plate', bedType: 'Cool Plate', label: 'workspace.bed.cool' },
  { prefix: 'eng_plate', bedType: 'Engineering Plate', label: 'workspace.bed.engineering' },
  { prefix: 'customized_plate', bedType: 'Customized Plate', label: 'workspace.bed.custom' },
]

export default function BedTempTable({
  opts,
  value,
  changed,
  setValue,
  bedType,
  readOnly = false,
}: {
  opts: OptionDef[]
  value: (key: string) => string | undefined
  changed: (key: string) => boolean
  setValue: (key: string, v: string | undefined) => void
  /** surface in use (highlighted); undefined = none */
  bedType?: string
  readOnly?: boolean
}) {
  const { t } = useI18n()
  const byKey = new Map(opts.map((o) => [o.key, o]))
  const beds = BEDS.filter((b) => byKey.has(`${b.prefix}_temp`) || byKey.has(`${b.prefix}_temp_initial_layer`))
  const cell = (key: string) => {
    const def = byKey.get(key)
    if (!def) return <span className="text-center text-muted">—</span>
    const v = value(key) ?? ''
    const mod = changed(key)
    return (
      <span className="flex items-center justify-end gap-1">
        {mod && !readOnly && (
          <button type="button" aria-label={t('workspace.process.reset')} title={t('workspace.process.reset')} onClick={() => setValue(key, undefined)} className="inline-flex size-5 items-center justify-center rounded text-accent-500 hover:bg-accent-500/10">
            <RotateCcw size={12} />
          </button>
        )}
        <input
          key={v}
          defaultValue={v}
          inputMode="numeric"
          disabled={readOnly}
          aria-label={`${def.label} · ${key}`}
          title={def.tooltip}
          onBlur={(e) => {
            const n = parseInt(e.target.value, 10)
            if (!Number.isFinite(n) || String(n) === v) return (e.target.value = v), undefined
            setValue(key, String(Math.min(def.max ?? 300, Math.max(def.min ?? 0, n))))
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          className={`h-7 w-14 rounded-md border bg-surface px-1.5 text-right font-mono text-xs tabular-nums shadow-xs focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none disabled:bg-surface-2 ${mod ? 'border-accent-500/60 font-semibold text-accent-700 dark:text-accent-300' : 'border-line'}`}
        />
        <span className="w-5 text-[10px] text-muted">°C</span>
      </span>
    )
  }
  return (
    <div className="py-1.5">
      <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-1 text-xs">
        <span />
        <span className="pr-6 text-right text-[10px] font-medium text-muted">{t('workspace.filSet.firstLayer')}</span>
        <span className="pr-6 text-right text-[10px] font-medium text-muted">{t('workspace.filSet.otherLayers')}</span>
        {beds.map((b) => {
          const current = b.bedType === bedType
          const mod = changed(`${b.prefix}_temp`) || changed(`${b.prefix}_temp_initial_layer`)
          return (
            <div key={b.prefix} className="contents">
              <span className={`relative flex min-w-0 items-center gap-1.5 truncate rounded-md py-1 pl-3 ${current ? 'font-semibold text-accent-700 dark:text-accent-300' : ''}`}>
                {mod && <span className="absolute left-0 size-1.5 rounded-full bg-accent-500" />}
                {current && <ThermometerSun size={12} className="shrink-0" />}
                <span className="truncate">{t(b.label)}</span>
                {current && <span className="shrink-0 rounded bg-accent-500/12 px-1 text-[9px] font-semibold">{t('workspace.filSet.inUse')}</span>}
              </span>
              {cell(`${b.prefix}_temp_initial_layer`)}
              {cell(`${b.prefix}_temp`)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
