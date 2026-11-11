// Profiles tab (`/?tab=profiles`): the user's own process and filament profiles, profiles other users shared, and
// the system presets. Pick one on the left, edit its values on the right against its system parent. Each row has
// the Default star ("always used" by new projects), the Shared toggle and actions; import and export use Creality
// Print's preset files.
import { Copy, Download, FileUp, FlaskConical, PencilLine, Plus, SlidersHorizontal, Star, Trash2, Users } from 'lucide-react'
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../../../api'
import ConfirmModal from '../../../components/ConfirmModal'
import Modal from '../../../components/Modal'
import { Button, ErrorState, IconButton, Loading, Segmented, Toggle } from '../../../components/ui'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import { useStoredState } from '../../../hooks'
import { useI18n } from '../../../i18n/I18nContext'
import type { FilamentPreset, PrinterModel, ProcessProfile, ProfileBundle, ProfileFileKind, ProfileImportReport } from '../../../types'
import { copyName, useFilamentPresets, useProcessProfiles } from '../../../workspace/filamentPresets'
import { invalidateCustomFilaments, shortPresetName, useBundle } from '../../../workspace/profiles'
import FilamentPresetDialog, { type PresetDraft } from '../prepare/FilamentPresetDialog'
import { IMPORT_ACCEPT, MAX_IMPORT_BYTES, readAsBase64, saveExport } from './files'
import ImportReportDialog from './ImportReportDialog'
import ProcessProfileDialog, { type ProcessDialogMode } from './ProcessProfileDialog'
import ProfileEditor, { type EditorProfile } from './ProfileEditor'

const MODEL: PrinterModel = 'creality-k2se'

export default function ProfilesTab() {
  const { t, language } = useI18n()
  const [kind, setKind] = useStoredState<ProfileFileKind>('sd:profiles:kind', 'process')
  const { bundle, error, retry } = useBundle(MODEL, language)
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex shrink-0 items-center gap-3 border-b border-line bg-surface px-3 py-2 sm:px-4">
        <Segmented<ProfileFileKind>
          label={t('profiles.kindLabel')}
          value={kind}
          onChange={setKind}
          options={[
            { value: 'process', label: t('profiles.kind.process'), icon: <SlidersHorizontal size={14} /> },
            { value: 'filament', label: t('profiles.kind.filament'), icon: <FlaskConical size={14} /> },
          ]}
        />
        <p className="hidden min-w-0 truncate text-xs text-muted md:block">{t('profiles.intro')}</p>
      </div>
      {error && !bundle ? (
        <div className="p-6">
          <ErrorState error={error} onRetry={retry} />
        </div>
      ) : !bundle ? (
        <Loading />
      ) : (
        <ProfilesSection key={kind} kind={kind} bundle={bundle} />
      )}
    </div>
  )
}

/** One list row: a user profile (own or shared by another user) or a system preset. */
interface Row extends EditorProfile {
  updatedAt: number
  filamentType?: string | null
  process?: ProcessProfile
  filament?: FilamentPreset
}

function ProfilesSection({ kind, bundle }: { kind: ProfileFileKind; bundle: ProfileBundle }) {
  const { t } = useI18n()
  const { user, updateAccount } = useAuth()
  const { toast, onError } = useToast()
  const processList = useProcessProfiles('usable', kind === 'process')
  const filamentList = useFilamentPresets('usable', kind === 'filament')
  const { data, error, retry } = kind === 'process' ? processList : filamentList
  const [selected, setSelected] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [processDialog, setProcessDialog] = useState<ProcessDialogMode | null>(null)
  const [filamentDraft, setFilamentDraft] = useState<PresetDraft | null>(null)
  const [filamentDetails, setFilamentDetails] = useState<FilamentPreset | null>(null)
  const [deleting, setDeleting] = useState<Row | null>(null)
  const [report, setReport] = useState<{ fileName: string; report: ProfileImportReport } | null>(null)
  const [exportIds, setExportIds] = useState<number[] | null>(null)
  const [importing, setImporting] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const onDirty = useCallback((d: boolean) => setDirty(d), [])

  const defaultId = kind === 'process' ? user?.defaultProcessPreset : user?.defaultFilamentPreset
  const rows = useMemo<Row[]>(() => {
    const custom: Row[] = (data ?? []).map((p) => {
      const f = kind === 'filament' ? (p as FilamentPreset) : undefined
      return {
        kind,
        presetId: p.presetId,
        id: p.id,
        name: p.name,
        inherits: p.inherits,
        values: p.values,
        canEdit: p.canEdit,
        system: false,
        shared: p.scope === 'shared',
        ownerName: p.ownerName,
        mine: p.ownerId === user?.id,
        updatedAt: p.updatedAt,
        ...(f ? { filament: f, color: f.color ?? bundle.filament.find((s) => s.id === f.inherits)?.color, filamentType: f.filamentType } : { process: p as ProcessProfile }),
      }
    })
    const system: Row[] = bundle[kind]
      .filter((p) => !p.custom)
      .map((p) => ({
        kind,
        presetId: p.id,
        id: null,
        name: p.name,
        inherits: p.id,
        values: {},
        canEdit: false,
        system: true,
        shared: false,
        mine: false,
        updatedAt: 0,
        color: p.color,
        filamentType: p.filamentType,
      }))
    return [...custom, ...system]
  }, [data, bundle, kind, user?.id])

  const mine = rows.filter((r) => !r.system && r.mine)
  const shared = rows.filter((r) => !r.system && !r.mine)
  const system = rows.filter((r) => r.system)
  const current = rows.find((r) => r.presetId === selected) ?? mine[0] ?? rows.find((r) => r.presetId === defaultId) ?? system[0] ?? null
  const exportable = rows.filter((r) => !r.system && r.id != null)

  const select = (presetId: string) => {
    if (presetId === current?.presetId) return
    if (dirty) setPending(presetId)
    else setSelected(presetId)
  }
  const afterCreate = (presetId: string) => {
    setDirty(false)
    setSelected(presetId)
  }

  // ---- row actions ----
  const setDefault = async (r: Row) => {
    const next = defaultId === r.presetId ? null : r.presetId
    try {
      await updateAccount(kind === 'process' ? { defaultProcessPreset: next } : { defaultFilamentPreset: next })
      toast('success', next ? t('profiles.defaultSet', { name: r.system ? shortPresetName(r.name) : r.name }) : t('profiles.defaultCleared'))
    } catch (err) {
      onError(err)
    }
  }
  const toggleShare = async (r: Row) => {
    if (r.id == null) return
    const scope = r.shared ? 'private' : 'shared'
    try {
      const saved = kind === 'process' ? await api.shareProcessProfile(r.id, scope) : await api.shareFilamentPreset(r.id, scope)
      invalidateCustomFilaments()
      toast('success', t(saved.scope === 'shared' ? 'filaments.nowShared' : 'filaments.nowPrivate', { name: saved.name }))
    } catch (err) {
      onError(err)
    }
  }
  const duplicate = (r: Row) => {
    const name = copyName(r.system ? shortPresetName(r.name) : r.name, t('filaments.copySuffix'))
    if (kind === 'process') setProcessDialog(r.system ? { mode: 'create', basePresetId: r.presetId, name } : { mode: 'duplicate', basePresetId: r.presetId, name })
    else setFilamentDraft({ basePresetId: r.presetId, name, filamentType: r.filamentType ?? null, color: r.color ?? null })
  }
  const rename = (r: Row) => {
    if (r.process) setProcessDialog({ mode: 'rename', profile: r.process })
    else if (r.filament) setFilamentDetails(r.filament)
  }
  const create = () => {
    if (kind === 'process') setProcessDialog({ mode: 'create' })
    else {
      const base = bundle.filament.find((p) => p.isDefault && !p.custom) ?? bundle.filament.find((p) => !p.custom)
      if (base) setFilamentDraft({ basePresetId: base.id, filamentType: base.filamentType ?? null, color: base.color ?? null })
    }
  }
  const exportRows = async (ids: number[], format: 'zip' | 'creality_filament') => {
    try {
      saveExport(await api.exportProfiles({ kind, ids, format }))
    } catch (err) {
      onError(err)
    }
  }
  const exportMany = () => {
    const ids = checked.size ? [...checked] : exportable.map((r) => r.id!)
    if (!ids.length) return
    if (kind === 'process') void exportRows(ids, 'zip')
    else setExportIds(ids)
  }
  const importFile = async (file: File) => {
    if (file.size > MAX_IMPORT_BYTES) {
      toast('error', t('errors.profile_files.too_large'))
      return
    }
    setImporting(true)
    try {
      const result = await api.importProfiles(file.name, await readAsBase64(file))
      invalidateCustomFilaments()
      setReport({ fileName: file.name, report: result })
      const first = result.created.find((c) => c.kind === kind)
      if (first && !dirty) setSelected(first.presetId)
    } catch (err) {
      onError(err)
    } finally {
      setImporting(false)
    }
  }

  const rowView = (r: Row) => (
    <ProfileRow
      key={r.presetId}
      row={r}
      active={r.presetId === current?.presetId}
      isDefault={r.presetId === defaultId}
      checked={r.id != null && checked.has(r.id)}
      onCheck={(on) =>
        setChecked((s) => {
          const next = new Set(s)
          if (on) next.add(r.id!)
          else next.delete(r.id!)
          return next
        })
      }
      onSelect={() => select(r.presetId)}
      onDefault={() => void setDefault(r)}
      onShare={() => void toggleShare(r)}
      onDuplicate={() => duplicate(r)}
      onRename={() => rename(r)}
      onDelete={() => setDeleting(r)}
      onExport={() => r.id != null && void exportRows([r.id], kind === 'filament' ? 'creality_filament' : 'zip')}
    />
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      <aside className="flex shrink-0 flex-col border-line bg-surface max-lg:border-b lg:w-[23rem] lg:border-r xl:w-[26rem]">
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line p-2.5">
          <Button size="xs" variant="primary" icon={<Plus size={14} />} onClick={create}>
            {t('profiles.new')}
          </Button>
          <Button size="xs" icon={<FileUp size={14} />} loading={importing} onClick={() => fileInput.current?.click()}>
            {t('profiles.import.button')}
          </Button>
          <Button size="xs" icon={<Download size={14} />} disabled={!exportable.length} onClick={exportMany}>
            {checked.size ? t('profiles.exportSelected', { n: checked.size }) : t('profiles.exportAll')}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept={IMPORT_ACCEPT}
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void importFile(f)
            }}
          />
        </div>
        <div className="min-h-0 lg:flex-1 lg:overflow-y-auto max-lg:max-h-[45dvh] max-lg:overflow-y-auto">
          {error && !data ? (
            <div className="p-4">
              <ErrorState error={error} onRetry={retry} />
            </div>
          ) : !data ? (
            <Loading />
          ) : (
            <>
              <Group title={t('profiles.group.mine')} count={mine.length}>
                {mine.length ? mine.map(rowView) : <p className="px-3 py-3 text-xs text-muted">{t(kind === 'process' ? 'profiles.emptyProcess' : 'profiles.emptyFilament')}</p>}
              </Group>
              {shared.length > 0 && (
                <Group title={t('profiles.group.shared')} count={shared.length}>
                  {shared.map(rowView)}
                </Group>
              )}
              <Group title={t('profiles.group.system')} count={system.length}>
                {system.map(rowView)}
              </Group>
            </>
          )}
        </div>
      </aside>
      <section className="flex min-h-[34rem] min-w-0 flex-1 flex-col bg-surface lg:min-h-0" aria-label={t('profiles.editor')}>
        {current ? (
          <ProfileEditor key={`${current.presetId}|${current.updatedAt}`} bundle={bundle} profile={current} onDirty={onDirty} onDuplicate={() => duplicate(current)} />
        ) : (
          <p className="py-10 text-center text-xs text-muted">{t('common.loading')}</p>
        )}
      </section>

      {processDialog && <ProcessProfileDialog bundle={bundle} state={processDialog} onClose={() => setProcessDialog(null)} onSaved={(p) => afterCreate(p.presetId)} />}
      {filamentDraft && <FilamentPresetDialog bundle={bundle} draft={filamentDraft} onClose={() => setFilamentDraft(null)} onSaved={(p) => afterCreate(p.presetId)} />}
      {filamentDetails && <FilamentPresetDialog bundle={bundle} preset={filamentDetails} onClose={() => setFilamentDetails(null)} />}
      {report && <ImportReportDialog fileName={report.fileName} report={report.report} onClose={() => setReport(null)} />}
      {exportIds && (
        <ExportFormatDialog
          count={exportIds.length}
          onClose={() => setExportIds(null)}
          onExport={(format) => {
            void exportRows(exportIds, format)
            setExportIds(null)
          }}
        />
      )}
      {pending && (
        <ConfirmModal
          title={t('profiles.discardTitle')}
          confirmLabel={t('profiles.discard')}
          onClose={() => setPending(null)}
          onConfirm={async () => {
            setDirty(false)
            setSelected(pending)
          }}
        >
          {t('profiles.discardBody')}
        </ConfirmModal>
      )}
      {deleting && (
        <ConfirmModal
          title={t('profiles.deleteTitle')}
          confirmLabel={t('common.delete')}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              if (deleting.id == null) return
              if (kind === 'process') await api.deleteProcessProfile(deleting.id)
              else await api.deleteFilamentPreset(deleting.id)
              invalidateCustomFilaments()
              setChecked((s) => {
                const next = new Set(s)
                next.delete(deleting.id!)
                return next
              })
              if (deleting.presetId === current?.presetId) setSelected(null)
            } catch (err) {
              onError(err)
              throw err
            }
          }}
        >
          {t(deleting.shared ? 'profiles.deleteSharedBody' : 'profiles.deleteBody', { name: deleting.name })}
        </ConfirmModal>
      )}
    </div>
  )
}

function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <div role="group" aria-label={title}>
      <p className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-line/70 bg-surface/95 px-3 pt-2.5 pb-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase backdrop-blur">
        {title}
        <span className="rounded-full bg-surface-2 px-1.5 text-[10px] font-semibold tabular-nums">{count}</span>
      </p>
      <ul className="divide-y divide-line/60">{children}</ul>
    </div>
  )
}

function ProfileRow({
  row,
  active,
  isDefault,
  checked,
  onCheck,
  onSelect,
  onDefault,
  onShare,
  onDuplicate,
  onRename,
  onDelete,
  onExport,
}: {
  row: Row
  active: boolean
  isDefault: boolean
  checked: boolean
  onCheck: (on: boolean) => void
  onSelect: () => void
  onDefault: () => void
  onShare: () => void
  onDuplicate: () => void
  onRename: () => void
  onDelete: () => void
  onExport: () => void
}) {
  const { t } = useI18n()
  const name = row.system ? shortPresetName(row.name) : row.name
  const changes = Object.keys(row.values).length
  return (
    <li className={`group/row relative flex items-start gap-2 px-3 py-2 transition-colors ${active ? 'bg-accent-500/8' : 'hover:bg-surface-2/60'}`}>
      {active && <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent-500" />}
      {!row.system ? (
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onCheck(e.target.checked)}
          aria-label={t('profiles.selectForExport', { name })}
          className="mt-1 size-3.5 shrink-0 accent-accent-600"
        />
      ) : (
        <span className="w-3.5 shrink-0" />
      )}
      <button type="button" onClick={onSelect} aria-current={active} className="min-w-0 flex-1 text-left">
        <span className="flex items-center gap-1.5">
          {row.kind === 'filament' && <span className="size-2.5 shrink-0 rounded-full ring-1 ring-black/10 dark:ring-white/15" style={{ background: row.color ?? 'transparent' }} />}
          <span className={`truncate text-sm ${active ? 'font-semibold' : 'font-medium'}`}>{name}</span>
        </span>
        <span className="block truncate text-[11px] text-muted">
          {row.system
            ? [row.filamentType, t('profiles.systemBadge')].filter(Boolean).join(' · ')
            : [!row.mine && t('profiles.byOwner', { owner: row.ownerName ?? '' }), t('profiles.basedOn', { name: shortPresetName(row.inherits) }), t('profiles.changedCount', { n: changes })]
                .filter(Boolean)
                .join(' · ')}
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton
          label={isDefault ? t('profiles.defaultOn') : t('profiles.makeDefault')}
          aria-pressed={isDefault}
          className={`size-7! ${isDefault ? 'text-amber-500 hover:text-amber-500' : ''}`}
          onClick={onDefault}
        >
          <Star size={16} fill={isDefault ? 'currentColor' : 'none'} />
        </IconButton>
        {!row.system && row.canEdit && (
          <span className="flex items-center px-1" title={row.shared ? t('profiles.sharedOn') : t('profiles.sharedOff')}>
            <Toggle checked={row.shared} label={t('profiles.sharedToggle', { name })} onChange={onShare} />
          </span>
        )}
        {!row.system && !row.canEdit && (
          <span className="flex size-7 items-center justify-center text-sky-500" title={t('profiles.byOwner', { owner: row.ownerName ?? '' })}>
            <Users size={14} />
          </span>
        )}
        <IconButton label={row.system ? t('profiles.newFromThis') : t('filaments.duplicate')} className="size-7!" onClick={onDuplicate}>
          <Copy size={14} />
        </IconButton>
        {!row.system && row.canEdit && (
          <IconButton label={t('profiles.rename')} className="size-7! max-sm:hidden" onClick={onRename}>
            <PencilLine size={14} />
          </IconButton>
        )}
        {!row.system && (
          <IconButton label={t('profiles.export')} className="size-7! max-sm:hidden" onClick={onExport}>
            <Download size={14} />
          </IconButton>
        )}
        {!row.system && row.canEdit && (
          <IconButton label={t('common.delete')} tone="danger" className="size-7!" onClick={onDelete}>
            <Trash2 size={14} />
          </IconButton>
        )}
      </div>
    </li>
  )
}

function ExportFormatDialog({ count, onClose, onExport }: { count: number; onClose: () => void; onExport: (format: 'zip' | 'creality_filament') => void }) {
  const { t } = useI18n()
  const [format, setFormat] = useState<'zip' | 'creality_filament'>('creality_filament')
  return (
    <Modal
      size="sm"
      onClose={onClose}
      icon={<Download size={18} />}
      title={t('profiles.exportTitle', { n: count })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" icon={<Download size={14} />} onClick={() => onExport(format)}>
            {t('profiles.export')}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <Segmented<'zip' | 'creality_filament'>
          label={t('profiles.exportFormat')}
          value={format}
          onChange={setFormat}
          options={[
            { value: 'creality_filament', label: '.creality_filament' },
            { value: 'zip', label: '.zip' },
          ]}
        />
        <p className="text-xs text-muted">{t(format === 'zip' ? 'profiles.exportZipHint' : 'profiles.exportBundleHint')}</p>
      </div>
    </Modal>
  )
}
