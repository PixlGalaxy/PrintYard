// Per-slot filament settings (Creality's filament tab): page nav, Simple/Pro, search, grouped options with
// per-option reset and a modified dot, bed temperatures as a per-surface table, retraction overrides with an
// "override the printer" checkbox. Changes are stored in `FilamentSlot.overrides` (only differences from the preset).
// With `preset` instead of `slot` it edits a custom filament preset's own values (differences from its system base).
import { FilePlus2, FlaskConical, PencilLine, RotateCcw, Save, ThermometerSun } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { api } from '../../../api'
import Modal from '../../../components/Modal'
import { Badge, Button, Segmented } from '../../../components/ui'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import { useLoader, useStoredState } from '../../../hooks'
import { useI18n } from '../../../i18n/I18nContext'
import type { FilamentPreset, FilamentSlot, OptionDef, ProfileBundle } from '../../../types'
import { usePrinterStatus } from '../../../realtime'
import { canEditPreset, customRowId } from '../../../workspace/filamentPresets'
import { printerOverrides, spoolLabel, spoolName } from '../../../workspace/printerFilaments'
import { invalidateCustomFilaments, shortPresetName, usePreset } from '../../../workspace/profiles'
import { contextFromMachine, filamentDependencies } from '../../../workspace/settings/dependencies'
import { matches, same } from '../../../workspace/settings/values'
import { useWs, workspace } from '../../../workspace/store'
import BedTempTable from './settings/BedTempTable'
import { PAGE_ICONS } from './settings/icons'
import OptionList from './settings/OptionList'
import { FILAMENT_PAGE_KEYS, isBedGroup, OVERRIDE_PAGE } from './settings/pages'
import SearchBox from './settings/SearchBox'
import { usePageSpy } from './settings/usePageSpy'
import FilamentPresetDialog, { type PresetDraft } from './FilamentPresetDialog'

const PAGE_KEYS = FILAMENT_PAGE_KEYS
type Mode = 'simple' | 'pro'

type Props = { bundle: ProfileBundle; onClose: () => void } & ({ slot: FilamentSlot; preset?: undefined } | { preset: FilamentPreset; slot?: undefined })

export default function FilamentSettings({ bundle, slot, preset: custom, onClose }: Props) {
  const { t } = useI18n()
  const { user } = useAuth()
  const { toast, onError } = useToast()
  const doc = useWs((s) => s.doc)
  const activePlate = useWs((s) => s.activePlate)
  const [mode, setMode] = useStoredState<Mode>('sd:ws:filmode', 'simple')
  const [query, setQuery] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  // Preset mode: the values are compared with the custom preset's system base and kept locally until saved
  const [draft, setDraft] = useState<Record<string, string>>(() => ({ ...(custom?.values ?? {}) }))
  const [dialog, setDialog] = useState<PresetDraft | 'details' | null>(null)
  const [busy, setBusy] = useState(false)
  const model = custom?.printerModel ?? doc.printerModel
  const preset = usePreset(model, 'filament', slot ? slot.presetId : custom.inherits)
  const machine = usePreset(doc.printerModel, 'machine', doc.machinePresetId || undefined)
  const presetVals = preset?.values ?? {}
  const machineVals = machine?.values ?? {}
  const overrides = slot ? (slot.overrides ?? {}) : draft
  const bedType = doc.plates[activePlate]?.bedType ?? 'Epoxy Resin Plate'
  const summary = slot ? bundle.filament.find((p) => p.id === slot.presetId) : undefined

  const value = (key: string) => overrides[key] ?? presetVals[key]
  const changed = (key: string) => key in overrides

  // Values taken from the printer's spool (slot mapped to a loaded CFS/external spool): marked "From printer"
  const { data: printers } = useLoader(api.printers)
  const status = usePrinterStatus(slot?.cfs ? (printers?.[0]?.id ?? null) : null)
  const spool = slot?.cfs ? status?.cfs?.find((c) => c.box === slot.cfs!.box && c.slot === slot.cfs!.slot && !!c.material) : undefined
  const printerVals = useMemo(
    () => (spool && preset ? printerOverrides(spool, preset.values, new Set(bundle.filamentOptions.map((o) => o.key))) : {}),
    [spool, preset, bundle],
  )
  const fromPrinter = (key: string) => key in overrides && printerVals[key] !== undefined && same(overrides[key]!, printerVals[key]!)
  const printerTip = spool ? `${t('workspace.filament.fromPrinter')} · ${spoolName(spool)} (${spoolLabel(spool, t)})` : ''
  const inherited = (key: string) => machineVals[key.replace(/^filament_/, '')] ?? presetVals[key]

  const nextOverrides = (current: Record<string, string> | undefined, key: string, v: string | undefined) => {
    const o = { ...(current ?? {}) }
    if (v === undefined || (!isOverrideKey(key) && same(v, presetVals[key]))) delete o[key]
    else o[key] = v
    return o
  }
  const setValue = (key: string, v: string | undefined) => {
    if (!slot) return setDraft((d) => nextOverrides(d, key, v))
    workspace.update((d) => ({
      ...d,
      filaments: d.filaments.map((f) => {
        if (f.slot !== slot.slot) return f
        const o = nextOverrides(f.overrides, key, v)
        return { ...f, overrides: Object.keys(o).length ? o : undefined }
      }),
    }))
  }
  /** Reset all = back to profile + printer values; `profileOnly` also drops the printer's values. */
  const resetAll = (profileOnly = false) => {
    if (!slot) return setDraft({})
    const keep = profileOnly ? {} : printerVals
    workspace.update((d) => ({ ...d, filaments: d.filaments.map((f) => (f.slot === slot.slot ? { ...f, overrides: Object.keys(keep).length ? { ...keep } : undefined } : f)) }))
  }
  const clearSlot = (patch: Partial<FilamentSlot>) => {
    if (!slot) return
    workspace.update((d) => ({ ...d, filaments: d.filaments.map((f) => (f.slot === slot.slot ? { ...f, overrides: undefined, ...patch } : f)) }))
  }

  // Slot on a custom preset: "Update preset" folds the slot's changes into it
  const rowId = slot ? customRowId(slot.presetId) : null
  const canUpdate = !!rowId && canEditPreset(summary, user)
  const updatePreset = async () => {
    if (!rowId) return
    setBusy(true)
    try {
      const current = await api.filamentPreset(rowId)
      const saved = await api.updateFilamentPreset(rowId, { values: { ...current.values, ...overrides } })
      invalidateCustomFilaments()
      clearSlot({})
      toast('success', t('filaments.updated', { name: saved.name }))
    } catch (err) {
      onError(err)
    } finally {
      setBusy(false)
    }
  }
  const savePresetValues = async () => {
    if (!custom) return
    setBusy(true)
    try {
      const saved = await api.updateFilamentPreset(custom.id, { values: draft })
      invalidateCustomFilaments()
      toast('success', t('filaments.updated', { name: saved.name }))
      onClose()
    } catch (err) {
      onError(err)
      setBusy(false)
    }
  }
  const overridePage = new Set(bundle.filamentOptions.filter((o) => o.page === OVERRIDE_PAGE).map((o) => o.key))
  const isOverrideKey = (k: string) => overridePage.has(k)

  const deps = filamentDependencies(value, contextFromMachine(machineVals))
  const options = useMemo(() => bundle.filamentOptions.filter((o) => o.mode !== 'develop'), [bundle])
  const q = query.trim().toLowerCase()
  const visible = options.filter((o) => !deps.hidden.has(o.key) && (q ? matches(o, q) : mode === 'pro' || o.mode === 'simple'))
  const pages = [...new Set(visible.map((o) => o.page))]
  const pageLabel = (p: string) => (PAGE_KEYS[p] ? t(PAGE_KEYS[p]) : p)
  const count = Object.keys(overrides).length
  const printerCount = Object.keys(overrides).filter(fromPrinter).length
  const modified = count - printerCount
  const printerMissing = Object.keys(printerVals).some((k) => !fromPrinter(k))
  const spy = usePageSpy(scroller, pages, `${mode}|${q}|${!!preset}`)

  const renderGroup = (_page: string, _group: string, opts: OptionDef[]) =>
    isBedGroup(opts) ? <BedTempTable opts={opts} value={value} changed={changed} setValue={setValue} bedType={bedType} /> : null

  const presetName = slot ? (summary?.name ?? slot.presetId) : custom.name
  const color = slot ? slot.color : (custom.color ?? '#7DD3FC')
  return (
    <Modal
      size="lg"
      onClose={onClose}
      dismissable={!dialog && !busy}
      icon={
        <span className="flex size-full items-center justify-center rounded-[inherit] font-mono text-xs font-bold text-black/60" style={{ background: color }}>
          {slot ? String(slot.slot).padStart(2, '0') : <FlaskConical size={16} />}
        </span>
      }
      title={slot ? t('workspace.filSet.title', { n: slot.slot }) : t('filaments.settingsTitle', { name: custom.name })}
      subtitle={
        <span className="flex items-center gap-1.5">
          {slot ? shortPresetName(presetName) : t('filaments.basedOn', { name: shortPresetName(custom.inherits) })}
          {(summary?.custom || custom) && <Badge tone="violet">{t('filaments.custom')}</Badge>}
        </span>
      }
      footer={
        <>
          <span className="mr-auto text-xs text-muted">
            {printerCount > 0
              ? [t('workspace.filSet.fromPrinter', { n: printerCount }), modified > 0 && t('workspace.filSet.modified', { n: modified })].filter(Boolean).join(' · ')
              : count
                ? t('workspace.filSet.changed', { n: count })
                : t('workspace.filSet.noChanges')}
          </span>
          <Button
            variant="secondary"
            disabled={(!modified && !printerMissing) || busy}
            onClick={() => resetAll()}
            title={Object.keys(printerVals).length ? t('workspace.filSet.resetAllPrinterHint') : undefined}
          >
            <RotateCcw size={14} />
            {t('workspace.filSet.resetAll')}
          </Button>
          {printerCount > 0 && (
            <Button variant="ghost" disabled={busy} onClick={() => resetAll(true)}>
              {t('workspace.filSet.resetProfile')}
            </Button>
          )}
          {slot ? (
            <>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  setDialog({
                    basePresetId: slot.presetId,
                    values: overrides,
                    color: slot.color,
                    filamentType: summary?.filamentType ?? null,
                    vendor: summary?.vendor ?? null,
                  })
                }
              >
                <FilePlus2 size={14} />
                {t('filaments.saveAsNew')}
              </Button>
              {canUpdate && (
                <Button variant="secondary" disabled={!count} loading={busy} onClick={updatePreset}>
                  <Save size={14} />
                  {t('filaments.updatePreset')}
                </Button>
              )}
              <Button onClick={onClose}>{t('workspace.filSet.done')}</Button>
            </>
          ) : (
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setDialog('details')}>
                <PencilLine size={14} />
                {t('filaments.details')}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" loading={busy} onClick={savePresetValues}>
                {t('common.save')}
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="-m-4 flex h-[min(70dvh,640px)] min-h-0 sm:-m-5">
        <nav className="hidden w-44 shrink-0 flex-col gap-0.5 border-r border-line bg-surface-2/40 p-2 sm:flex" aria-label={t('workspace.filSet.pages')}>
          {pages.map((p) => {
            const Icon = PAGE_ICONS[p] ?? ThermometerSun
            const on = spy.active === p && !q
            const pageMods = options.filter((o) => o.page === p && changed(o.key)).length
            return (
              <button
                key={p}
                type="button"
                aria-current={on}
                disabled={!!q}
                onClick={() => spy.jump(p)}
                className={`flex h-8 items-center gap-2 rounded-lg px-2 text-left text-xs font-medium transition-colors disabled:opacity-50 ${on ? 'bg-accent-500/12 text-accent-700 dark:text-accent-300' : 'text-muted hover:bg-surface-2 hover:text-fg'}`}
              >
                <Icon size={14} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{pageLabel(p)}</span>
                {pageMods > 0 && <span className="rounded-full bg-accent-500 px-1.5 text-[10px] font-bold text-white tabular-nums">{pageMods}</span>}
              </button>
            )
          })}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-line p-3">
            <div className="min-w-0 flex-1">
              <SearchBox value={query} onChange={(v) => (setQuery(v), scroller.current?.scrollTo({ top: 0 }))} placeholder={t('workspace.filSet.search')} />
            </div>
            <Segmented<Mode> label={t('workspace.process.mode')} value={mode} onChange={setMode} options={[{ value: 'simple', label: t('workspace.mode.simple') }, { value: 'pro', label: t('workspace.mode.pro') }]} />
          </div>
          <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto px-4 pb-6">
            {!preset ? (
              <p className="py-10 text-center text-xs text-muted">{t('common.loading')}</p>
            ) : visible.length === 0 ? (
              <p className="py-10 text-center text-xs text-muted">{t('workspace.process.noResults')}</p>
            ) : (
              <OptionList
                options={visible}
                pagePrefix={q ? pageLabel : undefined}
                renderGroup={renderGroup}
                row={(o) => ({
                  value: value(o.key),
                  base: presetVals[o.key],
                  changed: changed(o.key),
                  ...(fromPrinter(o.key) && { fromPrinter: printerTip }),
                  disabled: deps.disabled.has(o.key),
                  proBadge: mode === 'simple',
                  onChange: (v) => setValue(o.key, v),
                  ...(isOverrideKey(o.key) && {
                    override: {
                      active: o.key in overrides,
                      inherited: inherited(o.key),
                      onToggle: (on: boolean) => setValue(o.key, on ? (inherited(o.key) ?? '0') : undefined),
                    },
                  }),
                })}
              />
            )}
          </div>
        </div>
      </div>
      {dialog === 'details' && custom && <FilamentPresetDialog bundle={bundle} preset={custom} onClose={() => setDialog(null)} />}
      {dialog && dialog !== 'details' && (
        <FilamentPresetDialog
          bundle={bundle}
          draft={dialog}
          onClose={() => setDialog(null)}
          // The slot now uses the new preset; its changes live in the preset
          onSaved={(p) => clearSlot({ presetId: p.presetId, ...(p.color && !slot?.cfs ? { color: p.color } : {}) })}
        />
      )}
    </Modal>
  )
}

