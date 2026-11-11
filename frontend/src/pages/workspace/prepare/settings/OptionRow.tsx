// One setting row (process or filament): label with tooltip, modified dot, typed control, reset, greyed when a
// dependency rule turns it off. Values are Creality config strings ("1"/"0", "15%", enum keys).
import { Check, Info, Minus, Plus, RotateCcw } from 'lucide-react'
import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { PrinterModelIcon } from '../../../../components/printerIcons'
import { useI18n } from '../../../../i18n/I18nContext'
import type { OptionDef } from '../../../../types'
import { display, unitOf } from '../../../../workspace/settings/values'
import { useWs } from '../../../../workspace/store'

export interface RowProps {
  def: OptionDef
  value: string | undefined
  /** value the reset goes back to (preset, or the global value for an object) */
  base: string | undefined
  changed: boolean
  disabled?: boolean
  /** show the PRO badge on advanced options (Simple mode search results) */
  proBadge?: boolean
  /** small level hint (e.g. "Expert") on search results outside the current settings level */
  levelBadge?: string
  onChange: (v: string | undefined) => void
  /** "Setting Overrides" rows: checkbox that turns the per-filament value on/off */
  override?: { active: boolean; inherited: string | undefined; onToggle: (on: boolean) => void }
  /** "Preset: …" hint label (defaults to workspace.process.was) */
  baseHint?: (value: string) => string
  /** The value came from the printer's spool: tooltip text for the printer icon */
  fromPrinter?: string
}

const inputBase =
  'h-7 rounded-md border border-line bg-surface px-2 text-xs shadow-xs transition-colors focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none disabled:cursor-not-allowed disabled:bg-surface-2'

const stop = (e: KeyboardEvent<HTMLInputElement>) => {
  e.stopPropagation()
  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
  if (e.key === 'Escape') {
    const el = e.target as HTMLInputElement
    el.value = el.defaultValue
    el.blur()
  }
}

export default function OptionRow({ def, value, base, changed, disabled, proBadge, levelBadge, onChange, override, baseHint, fromPrinter }: RowProps) {
  const { t } = useI18n()
  const printerModel = useWs((s) => s.doc.printerModel)
  const off = disabled || (override ? !override.active : false)
  const v = override && !override.active ? (override.inherited ?? '') : (value ?? '')
  const unit = unitOf(def)
  const isList = v.includes(',') && def.type !== 'string' && def.type !== 'enum'

  let control: ReactNode
  if (def.type === 'bool' && !isList) {
    const on = v === '1' || v === 'true'
    control = (
      <button
        type="button"
        role="checkbox"
        aria-checked={on}
        aria-label={def.label}
        disabled={off}
        onClick={() => onChange(on ? '0' : '1')}
        className={`inline-flex size-[18px] items-center justify-center rounded-[5px] border transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-500 disabled:cursor-not-allowed ${
          on ? 'border-accent-600 bg-accent-600 text-white' : 'border-line bg-surface hover:border-accent-500'
        }`}
      >
        {on && <Check size={14} strokeWidth={3} />}
      </button>
    )
  } else if (def.type === 'enum' && def.enumValues?.length) {
    const s = v.replace(/^"(.*)"$/, '$1')
    control = (
      <select value={s} disabled={off} onChange={(e) => onChange(e.target.value)} aria-label={def.label} className={`${inputBase} max-w-40 min-w-0 pr-6`}>
        {!def.enumValues.some((e) => e.value === s) && <option value={s}>{s}</option>}
        {def.enumValues.map((e) => (
          <option key={e.value} value={e.value}>
            {e.label}
          </option>
        ))}
      </select>
    )
  } else if (def.type === 'int' && !isList) {
    control = <IntStepper def={def} value={v} disabled={off} onChange={onChange} />
  } else if ((def.type === 'float' || def.type === 'percent' || def.type === 'floatOrPercent') && !isList) {
    const pct = def.type === 'percent' || (def.type !== 'floatOrPercent' && v.endsWith('%'))
    const raw0 = pct ? v.replace(/%$/, '') : v
    // "90." / "0.20" → "90" / "0.2" (keeps a trailing % for float-or-percent values)
    const shown = /^-?\d*\.?\d*%?$/.test(raw0) && raw0 !== '' ? `${parseFloat(raw0)}${raw0.endsWith('%') ? '%' : ''}` : raw0
    control = (
      <span className="flex items-center gap-1">
        <input
          key={v}
          defaultValue={shown}
          inputMode="decimal"
          disabled={off}
          aria-label={def.label}
          onBlur={(e) => {
            const raw = e.target.value.trim().replace(',', '.')
            if (raw === '' || raw === shown) return
            const okNum = /^-?\d*\.?\d+%?$/.test(raw)
            if (!okNum || (raw.endsWith('%') && def.type === 'float')) {
              e.target.value = shown
              return
            }
            let n = parseFloat(raw)
            if (!raw.endsWith('%')) {
              if (def.min !== undefined) n = Math.max(def.min, n)
              if (def.max !== undefined) n = Math.min(def.max, n)
            }
            onChange(pct ? `${n}%` : raw.endsWith('%') ? `${n}%` : String(n))
          }}
          onKeyDown={stop}
          className={`${inputBase} w-[4.5rem] text-right font-mono tabular-nums`}
        />
        <Unit text={pct ? '%' : unit} />
      </span>
    )
  } else {
    control = (
      <span className="flex items-center gap-1">
        <input
          key={v}
          defaultValue={v.replace(/^"(.*)"$/, '$1')}
          disabled={off}
          aria-label={def.label}
          onBlur={(e) => e.target.value !== v.replace(/^"(.*)"$/, '$1') && onChange(e.target.value)}
          onKeyDown={stop}
          className={`${inputBase} w-28 font-mono`}
        />
        <Unit text={unit} />
      </span>
    )
  }

  const hint = baseHint ?? ((value: string) => t('workspace.process.was', { value }))
  return (
    <div
      className={`group/row relative flex min-h-10 items-center gap-2 py-1.5 pl-3 transition-opacity ${disabled ? 'opacity-45' : ''}`}
      title={disabled ? t('workspace.opt.disabledHint') : undefined}
      data-key={def.key}
    >
      {changed && (
        <span
          aria-label={fromPrinter ? t('workspace.filament.fromPrinter') : t('workspace.opt.modified')}
          className={`absolute top-1/2 left-0 size-1.5 -translate-y-1/2 rounded-full ${fromPrinter ? 'bg-emerald-500' : 'bg-accent-500'}`}
        />
      )}
      {override && (
        <button
          type="button"
          role="checkbox"
          aria-checked={override.active}
          aria-label={t('workspace.opt.override')}
          title={t('workspace.opt.override')}
          disabled={disabled}
          onClick={() => override.onToggle(!override.active)}
          className={`inline-flex size-4 shrink-0 items-center justify-center rounded border transition-colors ${override.active ? 'border-accent-600 bg-accent-600 text-white' : 'border-line bg-surface hover:border-accent-500'}`}
        >
          {override.active && <Check size={12} strokeWidth={3} />}
        </button>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className={`truncate text-xs ${changed ? (fromPrinter ? 'font-semibold text-emerald-700 dark:text-emerald-300' : 'font-semibold text-accent-700 dark:text-accent-300') : ''}`} title={def.label}>
            {def.label}
          </span>
          {def.tooltip && (
            <span className="group/info inline-flex shrink-0" tabIndex={0} aria-label={def.tooltip}>
              <Info size={12} className="text-muted/70 group-hover/info:text-accent-500" aria-hidden />
              <span className="pointer-events-none absolute top-full right-0 left-2 z-50 -mt-1 rounded-lg border border-line bg-surface p-2.5 text-[11px] leading-relaxed whitespace-pre-line text-fg opacity-0 shadow-xl shadow-black/10 transition-opacity group-hover/info:opacity-100 group-hover/info:delay-200 group-focus/info:opacity-100">
                {def.tooltip}
                <span className="mt-1.5 block font-mono text-[10px] text-muted">{def.key}</span>
              </span>
            </span>
          )}
          {fromPrinter && (
            <span className="inline-flex shrink-0 items-center rounded bg-emerald-500/12 p-0.5 text-emerald-700 dark:text-emerald-300" title={fromPrinter} aria-label={fromPrinter}>
              <PrinterModelIcon size={10} model={printerModel} aria-hidden />
            </span>
          )}
          {proBadge && def.mode === 'pro' && <span className="rounded bg-violet-500/15 px-1 text-[9px] font-semibold text-violet-600 dark:text-violet-400">PRO</span>}
          {levelBadge && <span className="shrink-0 rounded bg-violet-500/15 px-1 text-[9px] font-semibold text-violet-600 uppercase dark:text-violet-400">{levelBadge}</span>}
        </div>
        {changed && base !== undefined && !override && <span className="block truncate text-[10px] text-muted">{hint(display(def, base))}</span>}
        {override && !override.active && override.inherited !== undefined && (
          <span className="block truncate text-[10px] text-muted">{t('workspace.opt.inherits', { value: display(def, override.inherited) })}</span>
        )}
      </div>
      {changed && !override && (
        <button
          type="button"
          aria-label={t('workspace.process.reset')}
          title={t('workspace.process.reset')}
          onClick={() => onChange(undefined)}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-accent-500 opacity-80 hover:bg-accent-500/10 hover:opacity-100"
        >
          <RotateCcw size={12} />
        </button>
      )}
      <div className="shrink-0">{control}</div>
    </div>
  )
}

function Unit({ text }: { text?: string }) {
  if (!text) return <span className="w-11" />
  return (
    <span className="line-clamp-2 w-11 text-[10px] leading-[1.15] text-muted" title={text}>
      {text}
    </span>
  )
}

/** Integer field with −/+ (Shift = ×10), ↑/↓ keys, clamped to min/max. */
function IntStepper({ def, value, disabled, onChange }: { def: OptionDef; value: string; disabled?: boolean; onChange: (v: string) => void }) {
  const cur = parseInt(value, 10)
  const [draft, setDraft] = useState<string | null>(null)
  const clamp = (n: number) => Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, n))
  const set = (n: number) => {
    const c = clamp(Math.round(n))
    if (c !== cur) onChange(String(c))
  }
  const step = (dir: 1 | -1, big = false) => set((Number.isFinite(cur) ? cur : 0) + dir * (big ? 10 : 1))
  const unit = unitOf(def)
  return (
    <span className="flex items-center gap-1">
      <span className={`flex h-7 items-center rounded-md border border-line bg-surface shadow-xs focus-within:border-accent-500 focus-within:ring-2 focus-within:ring-accent-500/20 ${disabled ? 'bg-surface-2' : ''}`}>
        <button type="button" tabIndex={-1} aria-label="−" disabled={disabled || (def.min !== undefined && cur <= def.min)} onClick={(e) => step(-1, e.shiftKey)} className="inline-flex h-full w-6 items-center justify-center text-muted hover:text-fg disabled:opacity-30">
          <Minus size={12} />
        </button>
        <input
          aria-label={def.label}
          inputMode="numeric"
          disabled={disabled}
          value={draft ?? (Number.isFinite(cur) ? String(cur) : value)}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={() => {
            if (draft !== null && draft.trim() !== '' && Number.isFinite(Number(draft))) set(Number(draft))
            setDraft(null)
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            else if (e.key === 'Escape') {
              setDraft(null)
              ;(e.target as HTMLInputElement).blur()
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault()
              setDraft(null)
              step(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey)
            }
          }}
          className="w-9 min-w-0 bg-transparent text-center font-mono text-xs tabular-nums outline-none disabled:cursor-not-allowed"
        />
        <button type="button" tabIndex={-1} aria-label="+" disabled={disabled || (def.max !== undefined && cur >= def.max)} onClick={(e) => step(1, e.shiftKey)} className="inline-flex h-full w-6 items-center justify-center text-muted hover:text-fg disabled:opacity-30">
          <Plus size={12} />
        </button>
      </span>
      <Unit text={unit} />
    </span>
  )
}
