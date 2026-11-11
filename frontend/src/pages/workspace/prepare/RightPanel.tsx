import { Box, ChevronRight, Globe, Minus, Plus, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { selectCls } from '../../../components/styles'
import { Segmented, Toggle } from '../../../components/ui'
import { useI18n } from '../../../i18n/I18nContext'
import type { TranslationKey } from '../../../i18n/translations'
import { PREPARE_LEVELS, type OptionDef, type PrepareLevel, type ProfileBundle } from '../../../types'
import { shortPresetName, usePreset } from '../../../workspace/profiles'
import { contextFromMachine, processDependencies } from '../../../workspace/settings/dependencies'
import { matches, same } from '../../../workspace/settings/values'
import { useWs, workspace } from '../../../workspace/store'
import { Section, Tip } from './bits'
import FilamentPanel from './FilamentPanel'
import { ADVANCED_KEYS, LEVEL_LABEL } from './settings/levels'
import OptionList from './settings/OptionList'
import PageBar from './settings/PageBar'
import SearchBox from './settings/SearchBox'
import { usePageSpy } from './settings/usePageSpy'
import { usePrepareLevel } from './settings/usePrepareLevel'

const PAGE_ORDER = ['Quality', 'Strength', 'Speed', 'Support', 'Multimaterial', 'Others']
const PAGE_KEYS: Record<string, TranslationKey> = {
  Quality: 'slice.page.quality',
  Strength: 'slice.page.strength',
  Speed: 'slice.page.speed',
  Support: 'slice.page.support',
  Multimaterial: 'slice.page.multimaterial',
  Others: 'slice.page.others',
}
/** Pages whose options make sense per object (Creality's per-object settings are region/object options) */
const OBJECT_PAGES = new Set(['Quality', 'Strength', 'Speed', 'Support'])
const OBJECT_GROUPS = new Set(['Brim', 'Fuzzy Skin'])

export default function RightPanel({
  bundle,
  scopeObject,
  setScopeObject,
}: {
  bundle: ProfileBundle | null
  scopeObject: string | null
  setScopeObject: (id: string | null) => void
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <FilamentPanel bundle={bundle} />
      <ProcessSection bundle={bundle} scopeObject={scopeObject} setScopeObject={setScopeObject} />
    </div>
  )
}

// ---------- process ----------

function ProcessSection({
  bundle,
  scopeObject,
  setScopeObject,
}: {
  bundle: ProfileBundle | null
  scopeObject: string | null
  setScopeObject: (id: string | null) => void
}) {
  const { t } = useI18n()
  const doc = useWs((s) => s.doc)
  const selection = useWs((s) => s.selection)
  const [level, setLevel] = usePrepareLevel()
  const basic = level === 'basic'
  const [query, setQuery] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const preset = usePreset(doc.printerModel, 'process', doc.processPresetId || undefined)
  const machine = usePreset(doc.printerModel, 'machine', doc.machinePresetId || undefined)
  const obj = scopeObject ? doc.objects.find((o) => o.id === scopeObject) : undefined
  const scope: 'global' | 'object' = obj ? 'object' : 'global'
  const presetVals = preset?.values ?? {}

  const global = (key: string) => doc.processOverrides[key] ?? presetVals[key]
  const value = (key: string) => (obj ? (obj.overrides[key] ?? global(key)) : global(key))
  const changed = (key: string) => (obj ? key in obj.overrides : key in doc.processOverrides && !same(doc.processOverrides[key], presetVals[key]))
  const base = (key: string) => (obj ? global(key) : presetVals[key])

  const setValue = (key: string, v: string | undefined) => {
    workspace.update((d) => {
      if (obj) {
        return {
          ...d,
          objects: d.objects.map((o) => {
            if (o.id !== obj.id) return o
            const overrides = { ...o.overrides }
            const g = d.processOverrides[key] ?? presetVals[key]
            if (v === undefined || same(v, g)) delete overrides[key]
            else overrides[key] = v
            return { ...o, overrides }
          }),
        }
      }
      const overrides = { ...d.processOverrides }
      if (v === undefined || same(v, presetVals[key])) delete overrides[key]
      else overrides[key] = v
      return { ...d, processOverrides: overrides }
    })
  }

  const deps = processDependencies(value, contextFromMachine(machine?.values, scope === 'global'))
  const options = useMemo(
    () =>
      (bundle?.options ?? [])
        .filter((o) => o.mode !== 'develop')
        .sort((a, b) => (PAGE_ORDER.indexOf(a.page) + 1 || 99) - (PAGE_ORDER.indexOf(b.page) + 1 || 99)),
    [bundle],
  )
  const inScope = (o: OptionDef) => scope === 'global' || OBJECT_PAGES.has(o.page) || OBJECT_GROUPS.has(o.group)
  // Basic has no search: a query typed at another level does not leak into it
  const q = basic ? '' : query.trim().toLowerCase()
  const visible = basic ? [] : options.filter((o) => inScope(o) && !deps.hidden.has(o.key) && (q ? matches(o, q) : level === 'expert' || ADVANCED_KEYS.has(o.key)))
  const pages = [...new Set(visible.map((o) => o.page))]
  const pageLabel = (p: string) => t(PAGE_KEYS[p] ?? 'slice.page.others')
  const changedCount = obj ? Object.keys(obj.overrides).length : Object.keys(doc.processOverrides).length
  const pageChanged = (p: string) => options.some((o) => o.page === p && inScope(o) && changed(o.key))
  const singleSel = selection.length === 1 ? doc.objects.find((o) => o.id === selection[0]) : undefined
  const spy = usePageSpy(scroller, pages, `${level}|${q}|${scope}|${!!preset}`)
  const expertHint = t('workspace.level.expert')

  return (
    <Section
      title={t('workspace.process.title')}
      icon={<SlidersHorizontal size={14} />}
      className="flex min-h-0 flex-1 flex-col border-b-0"
      actions={<Segmented<PrepareLevel> label={t('workspace.level.label')} value={level} onChange={setLevel} options={PREPARE_LEVELS.map((l) => ({ value: l, label: t(LEVEL_LABEL[l]) }))} />}
    >
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <select
            className={`${selectCls} h-8! min-w-0 flex-1 text-xs`}
            value={doc.processPresetId}
            aria-label={t('workspace.process.preset')}
            onChange={(e) => workspace.update((d) => ({ ...d, processPresetId: e.target.value }))}
          >
            {(bundle?.process ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {shortPresetName(p.name)}
                {p.isDefault ? ` · ${t('workspace.process.default')}` : ''}
              </option>
            ))}
          </select>
          <Tip label={t('workspace.process.resetAll')} side="left">
            <button
              type="button"
              aria-label={t('workspace.process.resetAll')}
              disabled={!changedCount}
              onClick={() =>
                workspace.update((d) => (obj ? { ...d, objects: d.objects.map((o) => (o.id === obj.id ? { ...o, overrides: {} } : o)) } : { ...d, processOverrides: {} }))
              }
              className="relative inline-flex size-8 items-center justify-center rounded-lg border border-line text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40"
            >
              <RotateCcw size={14} />
              {changedCount > 0 && <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-500 px-1 text-[9px] font-bold text-white">{changedCount}</span>}
            </button>
          </Tip>
        </div>

        <div className="flex items-center gap-1 rounded-lg border border-line bg-surface-2 p-0.5 text-xs" role="radiogroup" aria-label={t('workspace.process.scope')}>
          <button
            type="button"
            role="radio"
            aria-checked={scope === 'global'}
            onClick={() => setScopeObject(null)}
            className={`inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md font-medium transition-colors ${scope === 'global' ? 'bg-surface text-fg shadow-xs' : 'text-muted hover:text-fg'}`}
          >
            <Globe size={14} />
            {t('workspace.process.global')}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={scope === 'object'}
            disabled={!singleSel && !obj}
            title={!singleSel && !obj ? t('workspace.process.objectHint') : undefined}
            onClick={() => singleSel && setScopeObject(singleSel.id)}
            className={`inline-flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-1.5 font-medium transition-colors disabled:opacity-45 ${scope === 'object' ? 'bg-violet-500 text-white shadow-xs' : 'text-muted hover:text-fg'}`}
          >
            <Box size={14} className="shrink-0" />
            <span className="truncate">{obj ? obj.name : t('workspace.process.object')}</span>
          </button>
        </div>

        {!basic && <SearchBox value={query} onChange={(v) => (setQuery(v), scroller.current?.scrollTo({ top: 0 }))} placeholder={t('workspace.process.search')} />}

        {!basic && !q && <PageBar pages={pages} active={spy.active} onPick={spy.jump} label={pageLabel} changed={pageChanged} />}
      </div>

      <div ref={scroller} className="relative -mx-3.5 mt-2 min-h-0 flex-1 overflow-y-auto px-3.5 pb-4">
        {level !== 'expert' && !q && <QuickSettings bundle={bundle} value={value} setValue={setValue} isObject={!!obj} />}
        {basic ? (
          <button
            type="button"
            onClick={() => setLevel('advanced')}
            className="mx-auto mt-1 flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-accent-600 hover:bg-accent-500/10 hover:text-accent-700 dark:text-accent-400 dark:hover:text-accent-300"
          >
            {t('workspace.level.showAll')}
            <ChevronRight size={14} />
          </button>
        ) : !preset ? (
          <p className="py-6 text-center text-xs text-muted">{t('common.loading')}</p>
        ) : visible.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted">{t('workspace.process.noResults')}</p>
        ) : (
          <OptionList
            options={visible}
            pagePrefix={q ? pageLabel : undefined}
            row={(o) => ({
              value: value(o.key),
              base: base(o.key),
              changed: changed(o.key),
              disabled: deps.disabled.has(o.key),
              levelBadge: level === 'advanced' && q && !ADVANCED_KEYS.has(o.key) ? expertHint : undefined,
              onChange: (v) => setValue(o.key, v),
            })}
          />
        )}
      </div>
    </Section>
  )
}

// ---------- quick settings (the Basic level, also on top of Advanced) ----------

function QuickSettings({
  bundle,
  value,
  setValue,
  isObject,
}: {
  bundle: ProfileBundle | null
  value: (k: string) => string | undefined
  setValue: (k: string, v: string | undefined) => void
  isObject: boolean
}) {
  const { t } = useI18n()
  const processId = useWs((s) => s.doc.processPresetId)
  const byHeight = (h: string) => bundle?.process.find((p) => p.name.startsWith(h))
  const quality = [
    { id: 'fast', preset: byHeight('0.24'), label: t('slice.quick.fast') },
    { id: 'standard', preset: byHeight('0.20'), label: t('slice.quick.standard') },
    { id: 'fine', preset: byHeight('0.16'), label: t('slice.quick.fine') },
  ].filter((q) => q.preset)
  const activeQ = quality.find((q) => q.preset!.id === processId)?.id
  const infill = parseFloat(value('sparse_infill_density') ?? '15') || 0
  const walls = parseInt(value('wall_loops') ?? '2', 10) || 0
  const shells = parseInt(value('top_shell_layers') ?? '5', 10) || 0
  const supports = value('enable_support') === '1'
  const tree = (value('support_type') ?? '').startsWith('tree')
  const plateOnly = value('support_on_build_plate_only') === '1'
  const brim = (value('brim_type') ?? 'auto_brim') !== 'no_brim'
  const skirtLoops = parseInt(value('skirt_loops') ?? '0', 10) || 0
  // The skirt is a plate-wide setting: per object only None / Brim
  const adhesion: Adhesion = brim ? 'brim' : !isObject && skirtLoops > 0 ? 'skirt' : 'none'
  const setAdhesion = (a: Adhesion) => {
    setValue('brim_type', a === 'brim' ? 'auto_brim' : 'no_brim')
    if (!isObject) setValue('skirt_loops', a === 'skirt' ? String(Math.max(1, skirtLoops)) : '0')
  }
  const adhesionOptions: Adhesion[] = isObject ? ['none', 'brim'] : ['none', 'skirt', 'brim']
  const pattern = bundle?.options.find((o) => o.key === 'sparse_infill_pattern')
  const patternValue = value('sparse_infill_pattern') ?? ''

  return (
    <div className="mt-1 mb-1 space-y-3 rounded-xl border border-accent-500/20 bg-accent-500/[0.04] p-3">
      {!isObject && quality.length > 0 && (
        <QuickRow label={t('slice.quick.quality')}>
          <div className="grid grid-cols-3 gap-1 rounded-lg border border-line bg-surface-2 p-0.5">
            {quality.map((q) => (
              <button
                key={q.id}
                type="button"
                aria-pressed={activeQ === q.id}
                onClick={() => workspace.update((d) => ({ ...d, processPresetId: q.preset!.id }))}
                className={`h-7 rounded-md text-xs font-medium transition-colors ${activeQ === q.id ? 'bg-surface text-fg shadow-xs' : 'text-muted hover:text-fg'}`}
              >
                {q.label}
              </button>
            ))}
          </div>
        </QuickRow>
      )}
      <QuickRow label={t('slice.quick.infill')} value={`${Math.round(infill)} %`}>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={infill}
          aria-label={t('slice.quick.infill')}
          onChange={(e) => setValue('sparse_infill_density', `${e.target.value}%`)}
          className="w-full accent-accent-500"
        />
        {pattern?.type === 'enum' && pattern.enumValues?.length ? (
          <div className="mt-1.5 flex items-center justify-between gap-3">
            <span className="text-xs text-muted">{t('slice.quick.pattern')}</span>
            <select
              value={patternValue}
              aria-label={t('slice.quick.pattern')}
              onChange={(e) => setValue('sparse_infill_pattern', e.target.value)}
              className={quickSelectCls}
            >
              {!pattern.enumValues.some((e) => e.value === patternValue) && <option value={patternValue}>{patternValue}</option>}
              {pattern.enumValues.map((e) => (
                <option key={e.value} value={e.value}>
                  {e.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </QuickRow>
      <div className="grid grid-cols-2 gap-3">
        <QuickRow label={t('slice.quick.walls')}>
          <Stepper value={walls} min={1} max={10} onChange={(v) => setValue('wall_loops', String(v))} label={t('slice.quick.walls')} />
        </QuickRow>
        <QuickRow label={t('slice.quick.shells')}>
          <Stepper
            value={shells}
            min={0}
            max={20}
            label={t('slice.quick.shells')}
            onChange={(v) => {
              setValue('top_shell_layers', String(v))
              setValue('bottom_shell_layers', String(Math.max(0, v - 1)))
            }}
          />
        </QuickRow>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium">{t('slice.quick.supports')}</span>
        <div className="flex items-center gap-2">
          {supports && (
            <select
              value={tree ? 'tree(auto)' : 'normal(auto)'}
              aria-label={t('slice.quick.supportType')}
              onChange={(e) => setValue('support_type', e.target.value)}
              className={quickSelectCls}
            >
              <option value="tree(auto)">{t('slice.quick.tree')}</option>
              <option value="normal(auto)">{t('slice.quick.normal')}</option>
            </select>
          )}
          <Toggle checked={supports} label={t('slice.quick.supports')} onChange={(v) => setValue('enable_support', v ? '1' : '0')} />
        </div>
      </div>
      {supports && (
        <div className="-mt-1.5 flex items-center justify-between gap-3">
          <span className="text-xs text-muted">{t('slice.quick.supportPlacement')}</span>
          <select
            value={plateOnly ? '1' : '0'}
            aria-label={t('slice.quick.supportPlacement')}
            onChange={(e) => setValue('support_on_build_plate_only', e.target.value)}
            className={quickSelectCls}
          >
            <option value="0">{t('slice.quick.everywhere')}</option>
            <option value="1">{t('slice.quick.plateOnly')}</option>
          </select>
        </div>
      )}
      <QuickRow label={t('slice.quick.adhesion')}>
        <div className={`grid gap-1 rounded-lg border border-line bg-surface-2 p-0.5 ${adhesionOptions.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`} role="radiogroup" aria-label={t('slice.quick.adhesion')}>
          {adhesionOptions.map((a) => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={adhesion === a}
              onClick={() => setAdhesion(a)}
              className={`h-7 rounded-md text-xs font-medium transition-colors ${adhesion === a ? 'bg-surface text-fg shadow-xs' : 'text-muted hover:text-fg'}`}
            >
              {t(ADHESION_LABEL[a])}
            </button>
          ))}
        </div>
      </QuickRow>
    </div>
  )
}

type Adhesion = 'none' | 'skirt' | 'brim'
const ADHESION_LABEL: Record<Adhesion, TranslationKey> = { none: 'slice.quick.none', skirt: 'slice.quick.skirt', brim: 'slice.quick.brim' }
const quickSelectCls = 'h-7 max-w-36 min-w-0 rounded-md border border-line bg-surface px-1.5 text-xs focus:border-accent-500 focus:outline-none'

function QuickRow({ label, value, children }: { label: string; value?: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="font-medium">{label}</span>
        {value && <span className="font-mono text-muted tabular-nums">{value}</span>}
      </div>
      {children}
    </div>
  )
}

function Stepper({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (v: number) => void; label: string }) {
  return (
    <div className="flex h-8 items-center rounded-lg border border-line bg-surface" role="group" aria-label={label}>
      <button type="button" aria-label="−" disabled={value <= min} onClick={() => onChange(value - 1)} className="inline-flex h-full w-8 items-center justify-center text-muted hover:text-fg disabled:opacity-30">
        <Minus size={14} />
      </button>
      <span className="flex-1 text-center font-mono text-xs tabular-nums">{value}</span>
      <button type="button" aria-label="+" disabled={value >= max} onClick={() => onChange(value + 1)} className="inline-flex h-full w-8 items-center justify-center text-muted hover:text-fg disabled:opacity-30">
        <Plus size={14} />
      </button>
    </div>
  )
}
