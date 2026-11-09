import { Move3d, RotateCcw } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import Card, { SettingRow } from '../../components/Card'
import { selectCls } from '../../components/styles'
import { Button, Segmented, Toggle } from '../../components/ui'
import { useAuth } from '../../context/AuthContext'
import { useToast } from '../../context/ToastContext'
import { useI18n } from '../../i18n/I18nContext'
import type { TranslationKey } from '../../i18n/translations'
import { customConflict, DEFAULT_CUSTOM, resolveNav, type Action } from '../../three/navSchemes'
import {
  NAV3D_BUTTONS,
  NAV3D_MODIFIERS,
  NAV3D_PRESETS,
  type Nav3dBinding,
  type Nav3dButton,
  type Nav3dCustom,
  type Nav3dModifier,
  type Nav3dPrefs,
  type Nav3dPreset,
  type Nav3dView,
} from '../../types'

// three.js stays out of the Account chunk until the card is shown
const Nav3dPreview = lazy(() => import('./Nav3dPreview'))

const DEFAULTS: Nav3dPrefs = { preset: 'slicedock' }
const ACTIONS: Action[] = ['orbit', 'pan', 'zoom']

/** Account → 3D navigation: mouse scheme for the Prepare / Preview / Live 3D views (saved per user). */
export default function Nav3dCard() {
  const { t } = useI18n()
  const { user, updateAccount } = useAuth()
  const { onError } = useToast()
  const [draft, setDraft] = useState<Nav3dPrefs>(() => user?.nav3d ?? DEFAULTS)
  const saved = useRef(JSON.stringify(user?.nav3d ?? DEFAULTS))
  const nav = resolveNav(draft)
  const custom = draft.custom ?? DEFAULT_CUSTOM
  const conflict = draft.preset === 'custom' && customConflict(custom)

  // Auto-save (debounced, sliders fire a lot); invalid custom mappings are not sent
  useEffect(() => {
    const json = JSON.stringify(draft)
    if (json === saved.current || conflict) return
    const id = window.setTimeout(() => {
      saved.current = json
      updateAccount({ nav3d: json === JSON.stringify(DEFAULTS) ? null : draft }).catch((e: unknown) => {
        saved.current = ''
        onError(e)
      })
    }, 450)
    return () => window.clearTimeout(id)
  }, [draft, conflict, updateAccount, onError])

  const patch = (p: Partial<Nav3dPrefs>) => setDraft((d) => ({ ...d, ...p }))
  const setPreset = (preset: Nav3dPreset) =>
    setDraft((d) => (preset === 'custom' ? { ...d, preset, custom: d.custom ?? DEFAULT_CUSTOM } : { ...d, preset }))
  const setCustom = (p: Partial<Nav3dCustom>) => setDraft((d) => ({ ...d, custom: { ...(d.custom ?? DEFAULT_CUSTOM), ...p } }))

  const btn = (b: Nav3dButton) => t(`account.nav3d.button.${b}` as TranslationKey)
  const mod = (m: Nav3dModifier) => t(`account.nav3d.mod.${m}` as TranslationKey)
  const describe = (list: Nav3dBinding[]) => list.map((x) => (x.modifier === 'none' ? '' : `${mod(x.modifier)} + `) + btn(x.button)).join(' · ')

  return (
    <Card title={t('account.nav3d.title')} description={t('account.nav3d.desc')} icon={<Move3d size={18} />}>
      <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t('account.nav3d.preset')}>
        {NAV3D_PRESETS.map((p) => {
          const active = draft.preset === p
          return (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setPreset(p)}
              className={`rounded-xl border px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-accent-500 ${
                active ? 'border-accent-500/50 bg-accent-500/[0.07] ring-1 ring-accent-500/30' : 'border-line hover:border-accent-500/30 hover:bg-surface-2/60'
              }`}
            >
              <span className="block text-sm font-semibold">{t(`account.nav3d.preset.${p}` as TranslationKey)}</span>
              <span className="block text-[11px] leading-snug text-muted">{t(`account.nav3d.presetHint.${p}` as TranslationKey)}</span>
            </button>
          )
        })}
      </div>

      {draft.preset === 'custom' ? (
        <div className="space-y-2 rounded-xl border border-line bg-surface-2/40 p-3">
          {ACTIONS.map((a) => {
            const value = a === 'zoom' ? custom.zoom : custom[a]
            const set = (v: Nav3dBinding | null) => setCustom(a === 'zoom' ? { zoom: v } : { [a]: v ?? DEFAULT_CUSTOM[a] })
            return (
              <div key={a} className="grid grid-cols-[6rem_1fr_1fr] items-center gap-2">
                <span className="text-sm font-medium">{t(`account.nav3d.action.${a}` as TranslationKey)}</span>
                <select
                  aria-label={`${t(`account.nav3d.action.${a}` as TranslationKey)}: ${t('account.nav3d.buttonLabel')}`}
                  className={`${selectCls} h-8! text-xs`}
                  value={value?.button ?? 'wheel'}
                  onChange={(e) => set(e.target.value === 'wheel' ? null : { button: e.target.value as Nav3dButton, modifier: value?.modifier ?? 'none' })}
                >
                  {a === 'zoom' && <option value="wheel">{t('account.nav3d.wheelOnly')}</option>}
                  {NAV3D_BUTTONS.map((b) => (
                    <option key={b} value={b}>
                      {btn(b)}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`${t(`account.nav3d.action.${a}` as TranslationKey)}: ${t('account.nav3d.modifierLabel')}`}
                  className={`${selectCls} h-8! text-xs`}
                  value={value?.modifier ?? 'none'}
                  disabled={!value}
                  onChange={(e) => value && set({ ...value, modifier: e.target.value as Nav3dModifier })}
                >
                  {NAV3D_MODIFIERS.map((m) => (
                    <option key={m} value={m}>
                      {m === 'none' ? t('account.nav3d.mod.noneLong') : mod(m)}
                    </option>
                  ))}
                </select>
              </div>
            )
          })}
          {conflict && <p className="text-xs text-red-600 dark:text-red-400">{t('account.nav3d.conflict')}</p>}
          <SettingRow label={t('account.nav3d.zoomToCursor')} description={t('account.nav3d.zoomToCursorDesc')}>
            <Toggle checked={custom.zoomToCursor} onChange={(v) => setCustom({ zoomToCursor: v })} label={t('account.nav3d.zoomToCursor')} />
          </SettingRow>
        </div>
      ) : (
        <dl className="grid gap-1 rounded-xl border border-line bg-surface-2/40 p-3 text-xs sm:grid-cols-[6rem_1fr]">
          {ACTIONS.map((a) => (
            <div key={a} className="contents">
              <dt className="font-medium">{t(`account.nav3d.action.${a}` as TranslationKey)}</dt>
              <dd className="text-muted">
                {a === 'zoom'
                  ? [t(nav.zoomToCursor ? 'account.nav3d.wheelToCursor' : 'account.nav3d.wheel'), describe(nav.zoom)].filter(Boolean).join(' · ')
                  : describe(nav[a])}
              </dd>
            </div>
          ))}
          <dt className="font-medium">{t('account.nav3d.select')}</dt>
          <dd className="text-muted">{t('account.nav3d.selectHint')}</dd>
        </dl>
      )}

      <SettingRow label={t('account.nav3d.invertWheel')} description={t('account.nav3d.invertWheelDesc')}>
        <Toggle checked={draft.invertWheel ?? false} onChange={(v) => patch({ invertWheel: v || undefined })} label={t('account.nav3d.invertWheel')} />
      </SettingRow>
      <Slider label={t('account.nav3d.orbitSpeed')} value={nav.orbitSpeed} onChange={(v) => patch({ orbitSpeed: v === 1 ? undefined : v })} />
      <Slider label={t('account.nav3d.zoomSpeed')} value={nav.zoomSpeed} onChange={(v) => patch({ zoomSpeed: v === 1 ? undefined : v })} />
      <SettingRow label={t('account.nav3d.defaultView')} description={t('account.nav3d.defaultViewDesc')}>
        <Segmented<Nav3dView>
          label={t('account.nav3d.defaultView')}
          value={nav.defaultView}
          onChange={(v) => patch({ defaultView: v === 'iso' ? undefined : v })}
          options={(['iso', 'top', 'front'] as const).map((v) => ({ value: v, label: t(`account.nav3d.view.${v}` as TranslationKey) }))}
        />
      </SettingRow>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-medium">{t('account.nav3d.try')}</div>
            <div className="text-xs text-muted">{t('account.nav3d.tryDesc')}</div>
          </div>
          <Button variant="ghost" size="xs" icon={<RotateCcw size={14} />} onClick={() => setDraft(DEFAULTS)} disabled={JSON.stringify(draft) === JSON.stringify(DEFAULTS)}>
            {t('account.nav3d.reset')}
          </Button>
        </div>
        <Suspense fallback={<div className="h-56 rounded-xl border border-line bg-surface-2/60" />}>
          <Nav3dPreview prefs={draft} label={t('account.nav3d.try')} />
        </Suspense>
      </div>
    </Card>
  )
}

function Slider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <span className="text-sm font-medium">{label}</span>
      <span className="flex items-center gap-3">
        <input
          type="range"
          min={0.2}
          max={3}
          step={0.1}
          value={value}
          onChange={(e) => onChange(Math.round(Number(e.target.value) * 10) / 10)}
          className="w-44 accent-accent-500"
        />
        <span className="w-10 text-right font-mono text-xs tabular-nums text-muted">{value.toFixed(1)}×</span>
      </span>
    </label>
  )
}
