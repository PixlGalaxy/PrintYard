// Profiles tab editor: the values of one process or filament profile, edited against its system parent with the
// same rows as Prepare (changed markers, reset to parent per key, level switch, search, page bar). System presets
// and profiles shared by other users open read-only (duplicate to change them).
import { ChevronRight, Copy, Lock, RotateCcw, Save, Users } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../../api'
import { Badge, Button, Segmented } from '../../../components/ui'
import { useToast } from '../../../context/ToastContext'
import { useI18n } from '../../../i18n/I18nContext'
import { PREPARE_LEVELS, type OptionDef, type PrepareLevel, type ProfileBundle } from '../../../types'
import { invalidateCustomFilaments, shortPresetName, usePreset } from '../../../workspace/profiles'
import { contextFromMachine, filamentDependencies, processDependencies } from '../../../workspace/settings/dependencies'
import { matches, same } from '../../../workspace/settings/values'
import BedTempTable from '../prepare/settings/BedTempTable'
import { ADVANCED_KEYS, BASIC_KEYS, FILAMENT_ADVANCED_PAGES, LEVEL_LABEL } from '../prepare/settings/levels'
import OptionList from '../prepare/settings/OptionList'
import PageBar from '../prepare/settings/PageBar'
import { FILAMENT_PAGE_KEYS, isBedGroup, OVERRIDE_PAGE, PROCESS_PAGE_KEYS, PROCESS_PAGE_ORDER } from '../prepare/settings/pages'
import SearchBox from '../prepare/settings/SearchBox'
import { usePageSpy } from '../prepare/settings/usePageSpy'
import { usePrepareLevel } from '../prepare/settings/usePrepareLevel'
import { UNKNOWN_FILAMENT_COLOR } from '../../../workspace/filamentColor'

export interface EditorProfile {
  kind: 'process' | 'filament'
  /** preset id: `custom:<n>` or the system preset name */
  presetId: string
  /** row id of a user profile; null for system presets */
  id: number | null
  name: string
  /** system parent (the preset itself for system presets) */
  inherits: string
  values: Record<string, string>
  canEdit: boolean
  system: boolean
  shared: boolean
  ownerName?: string
  mine: boolean
  color?: string | null
}

const sameValues = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k])
}

export default function ProfileEditor({
  bundle,
  profile,
  onDirty,
  onDuplicate,
}: {
  bundle: ProfileBundle
  profile: EditorProfile
  onDirty: (dirty: boolean) => void
  onDuplicate: () => void
}) {
  const { t } = useI18n()
  const { toast, onError } = useToast()
  const [level, setLevel] = usePrepareLevel()
  const basic = level === 'basic'
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<Record<string, string>>(() => ({ ...profile.values }))
  const [busy, setBusy] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const { kind } = profile
  const readOnly = profile.system || !profile.canEdit
  const parent = usePreset(bundle.printerModel, kind, profile.inherits)
  const machineId = (bundle.machine.find((m) => m.isDefault) ?? bundle.machine[0])?.id
  const machine = usePreset(bundle.printerModel, 'machine', machineId)
  const parentVals = parent?.values ?? {}
  const machineVals = machine?.values ?? {}

  const dirty = !readOnly && !sameValues(draft, profile.values)
  useEffect(() => onDirty(dirty), [dirty, onDirty])

  const overrideKeys = useMemo(() => new Set(bundle.filamentOptions.filter((o) => o.page === OVERRIDE_PAGE).map((o) => o.key)), [bundle])
  const isOverrideKey = (k: string) => kind === 'filament' && overrideKeys.has(k)
  const value = (key: string) => draft[key] ?? parentVals[key]
  const changed = (key: string) => key in draft
  const inherited = (key: string) => machineVals[key.replace(/^filament_/, '')] ?? parentVals[key]
  const setValue = (key: string, v: string | undefined) => {
    if (readOnly) return
    setDraft((d) => {
      const next = { ...d }
      if (v === undefined || (!isOverrideKey(key) && same(v, parentVals[key]))) delete next[key]
      else next[key] = v
      return next
    })
  }

  const deps = kind === 'process' ? processDependencies(value, contextFromMachine(machineVals, true)) : filamentDependencies(value, contextFromMachine(machineVals))
  const all = useMemo(() => {
    const list = (kind === 'process' ? bundle.options : bundle.filamentOptions).filter((o) => o.mode !== 'develop')
    return kind === 'process' ? [...list].sort((a, b) => (PROCESS_PAGE_ORDER.indexOf(a.page) + 1 || 99) - (PROCESS_PAGE_ORDER.indexOf(b.page) + 1 || 99)) : list
  }, [bundle, kind])
  const inLevel = (o: OptionDef) => {
    if (level === 'expert') return true
    if (kind === 'process') return basic ? BASIC_KEYS.has(o.key) : BASIC_KEYS.has(o.key) || ADVANCED_KEYS.has(o.key)
    return basic ? o.mode === 'simple' : FILAMENT_ADVANCED_PAGES.has(o.page)
  }
  const q = basic ? '' : query.trim().toLowerCase()
  const visible = all.filter((o) => !deps.hidden.has(o.key) && (q ? matches(o, q) : inLevel(o)))
  const pages = [...new Set(visible.map((o) => o.page))]
  const pageKeys = kind === 'process' ? PROCESS_PAGE_KEYS : FILAMENT_PAGE_KEYS
  const pageLabel = (p: string) => (pageKeys[p] ? t(pageKeys[p]) : p)
  const pageChanged = (p: string) => all.some((o) => o.page === p && changed(o.key))
  const spy = usePageSpy(scroller, pages, `${level}|${q}|${!!parent}|${profile.presetId}`)
  const count = Object.keys(draft).length
  const hiddenChanges = Object.keys(draft).filter((k) => !visible.some((o) => o.key === k)).length

  const save = async () => {
    if (profile.id == null) return
    setBusy(true)
    try {
      const saved = kind === 'process' ? await api.updateProcessProfile(profile.id, { values: draft }) : await api.updateFilamentPreset(profile.id, { values: draft })
      invalidateCustomFilaments()
      toast('success', t('profiles.saved', { name: saved.name }))
    } catch (err) {
      onError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2.5 border-b border-line px-3 pt-3 pb-2.5 sm:px-4">
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="flex min-w-0 items-center gap-2 font-semibold">
              {kind === 'filament' && <span className="size-3.5 shrink-0 rounded-full ring-1 ring-black/20 dark:ring-white/20" style={{ background: profile.color ?? UNKNOWN_FILAMENT_COLOR }} />}
              <span className="truncate">{profile.system ? shortPresetName(profile.name) : profile.name}</span>
              {profile.system ? (
                <Badge>{t('profiles.systemBadge')}</Badge>
              ) : profile.shared ? (
                <Badge tone="sky">
                  <Users size={12} /> {profile.mine ? t('profiles.sharedBadge') : profile.ownerName}
                </Badge>
              ) : null}
            </h2>
            <p className="truncate text-xs text-muted">
              {profile.system
                ? t('profiles.systemHint')
                : [t('profiles.basedOn', { name: shortPresetName(profile.inherits) }), count ? t('profiles.changedCount', { n: count }) : t('profiles.noChanges')].join(' · ')}
            </p>
          </div>
          {readOnly ? (
            <Button size="xs" variant="secondary" icon={<Copy size={14} />} onClick={onDuplicate}>
              {t('profiles.duplicateToEdit')}
            </Button>
          ) : (
            <div className="flex items-center gap-1.5">
              <Button size="xs" variant="ghost" icon={<RotateCcw size={14} />} disabled={!dirty || busy} onClick={() => setDraft({ ...profile.values })}>
                {t('profiles.discard')}
              </Button>
              <Button size="xs" variant="primary" icon={<Save size={14} />} disabled={!dirty} loading={busy} onClick={save}>
                {t('common.save')}
              </Button>
            </div>
          )}
        </div>
        {readOnly && !profile.system && (
          <p className="flex items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs text-muted">
            <Lock size={12} className="shrink-0" />
            {t('profiles.readOnlyShared', { owner: profile.ownerName ?? '' })}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<PrepareLevel> label={t('workspace.level.label')} value={level} onChange={setLevel} options={PREPARE_LEVELS.map((l) => ({ value: l, label: t(LEVEL_LABEL[l]) }))} />
          {!basic && (
            <div className="min-w-40 flex-1">
              <SearchBox value={query} onChange={(v) => (setQuery(v), scroller.current?.scrollTo({ top: 0 }))} placeholder={t(kind === 'process' ? 'workspace.process.search' : 'workspace.filSet.search')} />
            </div>
          )}
        </div>
        {!q && pages.length > 1 && <PageBar pages={pages} active={spy.active} onPick={spy.jump} label={pageLabel} changed={pageChanged} />}
      </div>
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto px-3 pb-6 sm:px-4">
        {!parent ? (
          <p className="py-10 text-center text-xs text-muted">{t('common.loading')}</p>
        ) : visible.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted">{t('workspace.process.noResults')}</p>
        ) : (
          // read-only: every control disabled without dimming the rows
          <fieldset disabled={readOnly} className="contents">
          <OptionList
            options={visible}
            pagePrefix={q ? pageLabel : undefined}
            renderGroup={(_p, _g, opts) =>
              kind === 'filament' && isBedGroup(opts) ? <BedTempTable opts={opts} value={value} changed={changed} setValue={setValue} readOnly={readOnly} /> : null
            }
            row={(o) => ({
              value: value(o.key),
              base: parentVals[o.key],
              changed: changed(o.key),
              disabled: deps.disabled.has(o.key),
              baseHint: (v: string) => t('profiles.parentValue', { value: v }),
              onChange: (v) => setValue(o.key, v),
              ...(isOverrideKey(o.key) && {
                override: {
                  active: o.key in draft,
                  inherited: inherited(o.key),
                  onToggle: (on: boolean) => setValue(o.key, on ? (inherited(o.key) ?? '0') : undefined),
                },
              }),
            })}
          />
          </fieldset>
        )}
        {basic && (
          <button
            type="button"
            onClick={() => setLevel('advanced')}
            className="mx-auto mt-3 flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-accent-600 hover:bg-accent-500/10 hover:text-accent-700 dark:text-accent-400 dark:hover:text-accent-300"
          >
            {t('workspace.level.showAll')}
            <ChevronRight size={14} />
          </button>
        )}
        {hiddenChanges > 0 && !q && <p className="mt-3 text-center text-[11px] text-muted">{t('profiles.hiddenChanges', { n: hiddenChanges })}</p>}
      </div>
    </div>
  )
}
