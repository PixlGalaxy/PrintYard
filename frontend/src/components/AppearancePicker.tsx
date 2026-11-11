import { Check, Laptop, Moon, RotateCcw, Sun } from 'lucide-react'
import { useI18n } from '../i18n/I18nContext'
import { SKIN_DOTS, skinLabelKey } from '../theme/skins'
import { SKINS, type Skin, type ThemeMode } from '../types'
import { Segmented } from './ui'

/** 'default' = inherit the admin default (only offered when `defaultValue` is passed). */
export type ModeValue = ThemeMode | 'default'
export type SkinValue = Skin | 'default'

export function ModePicker({
  value,
  onChange,
  defaultValue,
}: {
  value: ModeValue
  onChange: (v: ModeValue) => void
  /** Pass to offer "Use default" (shows which mode that is) */
  defaultValue?: ThemeMode
}) {
  const { t } = useI18n()
  const modeLabel = (m: ThemeMode) => t(m === 'system' ? 'theme.system' : m === 'light' ? 'theme.light' : 'theme.dark')
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented<ModeValue>
        label={t('appearance.mode')}
        value={value}
        onChange={onChange}
        options={[
          ...(defaultValue ? [{ value: 'default' as const, label: t('appearance.default'), icon: <RotateCcw size={14} /> }] : []),
          { value: 'system', label: t('theme.system'), icon: <Laptop size={14} /> },
          { value: 'light', label: t('theme.light'), icon: <Sun size={14} /> },
          { value: 'dark', label: t('theme.dark'), icon: <Moon size={14} /> },
        ]}
      />
      {defaultValue && value === 'default' && (
        <span className="text-xs text-muted">{t('appearance.defaultIs', { value: modeLabel(defaultValue) })}</span>
      )}
    </div>
  )
}

function Dots({ skin }: { skin: Skin }) {
  return (
    <span className="flex shrink-0 -space-x-1.5" aria-hidden>
      {SKIN_DOTS[skin].map((c) => (
        <span key={c} className="size-4 rounded-full ring-2 ring-surface" style={{ background: c }} />
      ))}
    </span>
  )
}

/** Swatch grid with names. Choosing a tile applies at once (the page re-skins live). */
export function SkinGrid({
  value,
  onChange,
  defaultValue,
}: {
  value: SkinValue
  onChange: (v: SkinValue) => void
  /** Pass to offer a "Use default" tile (previewing the default skin) */
  defaultValue?: Skin
}) {
  const { t } = useI18n()
  const tile = (v: SkinValue, skin: Skin, label: string, sub?: string) => {
    const active = v === value
    return (
      <button
        key={v}
        type="button"
        role="radio"
        aria-checked={active}
        onClick={() => onChange(v)}
        className={`relative flex min-w-0 items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 ${
          active ? 'border-accent-500 bg-accent-500/10' : 'border-line bg-surface hover:bg-surface-2'
        }`}
      >
        <Dots skin={skin} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">{label}</span>
          {sub && <span className="block truncate text-[11px] text-muted">{sub}</span>}
        </span>
        {active && <Check size={14} className="shrink-0 text-accent-600 dark:text-accent-400" />}
      </button>
    )
  }
  return (
    <div role="radiogroup" aria-label={t('appearance.skin')} className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {defaultValue && tile('default', defaultValue, t('appearance.useDefault'), t(skinLabelKey(defaultValue)))}
      {SKINS.map((s) => tile(s, s, t(skinLabelKey(s))))}
    </div>
  )
}
