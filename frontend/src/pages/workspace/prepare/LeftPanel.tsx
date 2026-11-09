import { BedIcon, NozzleIcon } from '../../../components/printerIcons'
import { Boxes, CircleAlert, Info, Copy, Ellipsis, Eye, EyeOff, FileUp, LoaderCircle, Pencil, Printer as PrinterIcon, RotateCcw, SlidersHorizontal, SquareArrowRight, Trash2, Upload, X } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api } from '../../../api'
import { selectCls } from '../../../components/styles'
import { useLoader } from '../../../hooks'
import { useI18n } from '../../../i18n/I18nContext'
import type { TranslationKey } from '../../../i18n/translations'
import { usePrinterStatus } from '../../../realtime'
import type { BedSurface, PrinterState, ProfileBundle, SceneObject } from '../../../types'
import { BED_KEYS, isBedSurface, ownedSurfaces } from '../../../workspace/bedSurfaces'
import { meshes } from '../../../workspace/meshes'
import { deleteObjects, dismissUpload, duplicateSelected, env, moveToPlate, outsideObjects, renameObject, setFilamentSlot, setPlateBedType } from '../../../workspace/ops'
import { shortPresetName } from '../../../workspace/profiles'
import { useWs, workspace, type UploadInfo } from '../../../workspace/store'
import { ProgressBar, TransferStats } from '../../../components/TransferProgress'
import { etaOf } from '../../../components/transferEta'
import { useUploads } from '../../files/uploads/UploadContext'
import { formatBytes } from '../../../validation'
import { Section, Tip } from './bits'
import { menuCls, menuItemCls, useDismiss } from './styles'


const STATE_TONE: Partial<Record<PrinterState, string>> = {
  printing: 'bg-accent-500',
  paused: 'bg-amber-500',
  pausing: 'bg-amber-500',
  idle: 'bg-emerald-500',
  complete: 'bg-emerald-500',
  error: 'bg-red-500',
  failed: 'bg-red-500',
}

export default function LeftPanel({
  bundle,
  onSettings,
  onImport,
  onLibrary,
}: {
  bundle: ProfileBundle | null
  onSettings: (objectId: string) => void
  onImport: () => void
  onLibrary: () => void
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PrinterCard bundle={bundle} />
      <ObjectList onSettings={onSettings} onImport={onImport} onLibrary={onLibrary} />
    </div>
  )
}

/** An empty scene whose plates have no surface yet takes the printer's default one (so slicing uses it too). */
function useDefaultBedSurface(def: BedSurface | null) {
  const empty = useWs((s) => s.doc.objects.length === 0 && s.doc.plates.every((p) => !p.bedType))
  useEffect(() => {
    // not an undo step and not an unsaved change: it is the scene's starting state
    if (def && empty) workspace.update((d) => ({ ...d, plates: d.plates.map((p) => ({ ...p, bedType: def })) }), { history: false, dirty: false })
  }, [def, empty])
}

function PrinterCard({ bundle }: { bundle: ProfileBundle | null }) {
  const { t } = useI18n()
  const { data: printers } = useLoader(api.printers)
  const printer = printers?.[0] ?? null
  const status = usePrinterStatus(printer?.id ?? null)
  const doc = useWs((s) => s.doc)
  const active = useWs((s) => s.activePlate)
  // Only the surfaces the owner has (Admin → Printers); a plate may still carry another one (old project)
  const owned = ownedSurfaces(printer)
  const bedType = doc.plates[active]?.bedType ?? owned.def
  const bedOptions = owned.list.includes(bedType as BedSurface) ? owned.list : [...owned.list, bedType]
  useDefaultBedSurface(printers ? owned.def : null)
  const online = status?.online ?? false
  const state = status?.state ?? 'offline'
  const fmtT = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v)}°`)

  return (
    <Section title={t('workspace.printer.title')} icon={<PrinterIcon size={14} />}>
      <div className="rounded-xl border border-line bg-surface-2/50 p-2.5">
        <div className="flex items-center gap-2.5">
          <span className="relative flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent-400/20 to-accent-600/20 text-accent-500">
            <PrinterIcon size={18} />
            <span
              className={`absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-surface ${online ? (STATE_TONE[state] ?? 'bg-emerald-500') : 'bg-zinc-400'}`}
              aria-hidden
            />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold">{printer?.name ?? 'Creality K2 SE'}</p>
            <p className="truncate text-[11px] text-muted">
              {online ? t(`workspace.printer.state.${state}` as TranslationKey) : printer ? t('workspace.printer.offline') : t('workspace.printer.none')}
            </p>
          </div>
        </div>
        {online && (
          <div className="mt-2 flex items-center gap-3 text-[11px] text-muted tabular-nums">
            <span className="inline-flex items-center gap-1" title={t('workspace.printer.nozzle')}>
              <NozzleIcon size={12} />
              {fmtT(status?.nozzleTemp)}
              <span className="text-muted/70">/ {fmtT(status?.nozzleTarget)}</span>
            </span>
            <span className="inline-flex items-center gap-1" title={t('workspace.printer.bed')}>
              <BedIcon size={12} />
              {fmtT(status?.bedTemp)}
              <span className="text-muted/70">/ {fmtT(status?.bedTarget)}</span>
            </span>
            {status?.progress != null && (state === 'printing' || state === 'paused') && <span className="ml-auto font-medium text-accent-600 dark:text-accent-400">{Math.round(status.progress)} %</span>}
          </div>
        )}
        {online && status?.progress != null && (state === 'printing' || state === 'paused') && (
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full bg-accent-500 transition-[width] duration-700" style={{ width: `${status.progress}%` }} />
          </div>
        )}
      </div>

      <div className="mt-3 space-y-2">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-muted">{t('workspace.printer.preset')}</span>
          <select
            className={`${selectCls} h-8! text-xs`}
            value={doc.machinePresetId}
            onChange={(e) => workspace.update((d) => ({ ...d, machinePresetId: e.target.value }))}
          >
            {(bundle?.machine ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          {bedOptions.length === 1 ? (
            <div className="min-w-0">
              <span className="mb-1 block text-[11px] font-medium text-muted">{t('workspace.printer.bedType')}</span>
              <span className="flex h-8 items-center truncate rounded-lg border border-line bg-surface-2/60 px-2.5 text-xs" title={t('workspace.printer.bedOnlyOne')}>
                {isBedSurface(bedType) ? t(BED_KEYS[bedType]) : bedType}
              </span>
            </div>
          ) : (
            <label className="block min-w-0">
              <span className="mb-1 block text-[11px] font-medium text-muted">{t('workspace.printer.bedType')}</span>
              <select className={`${selectCls} h-8! text-xs`} value={bedType} onChange={(e) => setPlateBedType('all', e.target.value)}>
                {bedOptions.map((b) => (
                  <option key={b} value={b}>
                    {isBedSurface(b) ? t(BED_KEYS[b]) : b}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div>
            <span className="mb-1 block text-[11px] font-medium text-muted">{t('workspace.printer.nozzleSize')}</span>
            <span className="flex h-8 items-center rounded-lg border border-line bg-surface-2/60 px-2.5 font-mono text-xs">0.4 mm</span>
          </div>
        </div>
      </div>
    </Section>
  )
}

function ObjectList({ onSettings, onImport, onLibrary }: { onSettings: (objectId: string) => void; onImport: () => void; onLibrary: () => void }) {
  const { t } = useI18n()
  const doc = useWs((s) => s.doc)
  const selection = useWs((s) => s.selection)
  const hidden = useWs((s) => s.hidden)
  const active = useWs((s) => s.activePlate)
  const uploads = useWs((s) => s.uploads)
  useSyncExternalStore(meshes.subscribe, () => meshes.version)
  const outside = new Set(outsideObjects(doc).map((o) => o.id))
  // Imports not placed yet (uploading / processing / failed): shown as pending rows above the plates
  const pending = Object.entries(uploads).filter(([id]) => !doc.objects.some((o) => o.fileId === Number(id)))

  return (
    <Section
      title={t('workspace.objects.title')}
      icon={<Boxes size={14} />}
      className="flex min-h-0 flex-1 flex-col border-b-0"
      actions={<span className="text-xs text-muted tabular-nums">{doc.objects.length}</span>}
    >
      <div className="-mx-1.5 min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {pending.length > 0 && (
          <ul className="mb-2 space-y-1" aria-live="polite">
            {pending.map(([id, u]) => (
              <PendingImportRow key={id} temp={Number(id)} info={u} />
            ))}
          </ul>
        )}
        {doc.plates.map((p, i) => {
          const objs = doc.objects.filter((o) => o.plate === i)
          return (
            <div key={i} className="mb-2">
              <button
                type="button"
                onClick={() => {
                  workspace.setActivePlate(i)
                  env.viewport?.setView('iso', true, 'plate')
                }}
                className={`relative flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs font-semibold transition-colors ${
                  i === active ? 'text-accent-600 dark:text-accent-400' : 'text-muted hover:text-fg'
                }`}
              >
                <span className={`size-1.5 rounded-full ${i === active ? 'bg-accent-500' : 'bg-line'}`} />
                <span className="min-w-0 truncate">{p.name || t('workspace.plate.name', { n: i + 1 })}</span>
                {i === 0 && (
                  <span className="group/plinfo inline-flex" tabIndex={0} aria-label={t('workspace.plate.info')}>
                    <Info size={12} className="text-muted/70 group-hover/plinfo:text-accent-500" aria-hidden />
                    <span role="tooltip" className="pointer-events-none absolute top-full right-0 left-0 z-50 mt-1 rounded-lg border border-line bg-surface p-2.5 text-[11px] leading-relaxed font-normal text-fg opacity-0 shadow-xl shadow-black/10 transition-opacity group-hover/plinfo:opacity-100 group-hover/plinfo:delay-200 group-focus/plinfo:opacity-100">
                      {t('workspace.plate.info')}
                    </span>
                  </span>
                )}
                <span className="flex-1" />
                <span className="font-normal tabular-nums">{objs.length}</span>
              </button>
              {objs.length === 0 && pending.length > 0 ? null : objs.length === 0 ? (
                <div className="mx-1 my-1.5 rounded-xl border border-dashed border-line bg-surface-2/50 px-3 py-3 text-center">
                  <p className="text-xs font-medium">{t('workspace.empty.title')}</p>
                  <p className="mt-0.5 text-[11px] leading-snug text-muted">{t('workspace.empty.body')}</p>
                  <div className="mt-2.5 flex flex-col gap-1.5">
                    <button type="button" onClick={onImport} className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-accent-600 px-3 text-xs font-medium text-white hover:bg-accent-500">
                      <Upload size={13} />
                      {t('workspace.empty.browse')}
                    </button>
                    <button type="button" onClick={onLibrary} className="inline-flex h-8 items-center justify-center rounded-lg border border-line bg-surface px-3 text-xs font-medium hover:bg-surface-2">
                      {t('workspace.empty.library')}
                    </button>
                  </div>
                  <p className="mt-2 font-mono text-[10px] text-muted">STL · 3MF · OBJ</p>
                </div>
              ) : (
                <ul className="space-y-0.5">
                  {objs.map((o) => (
                    <ObjectRow
                      key={o.id}
                      obj={o}
                      selected={selection.includes(o.id)}
                      hidden={hidden.includes(o.id)}
                      outside={outside.has(o.id)}
                      uploading={o.fileId <= 0 ? uploads[o.fileId] : undefined}
                      onSettings={() => onSettings(o.id)}
                    />
                  ))}
                </ul>
              )}
            </div>
          )
        })}
      </div>
    </Section>
  )
}

/**
 * A model being imported: file icon + "Uploading <name>" + thin progress bar + % · speed · ETA (from the global
 * upload queue item), then an indeterminate "Processing…" bar (server reply / local mesh build), or an error row
 * with retry (upload failures) and remove.
 */
function PendingImportRow({ temp, info }: { temp: number; info: UploadInfo }) {
  const { t } = useI18n()
  const { items, retry, cancel } = useUploads()
  const item = info.itemId !== null ? items.find((i) => i.id === info.itemId) : undefined
  // A failed upload retried from the tray is running again: follow the queue item
  const retrying = info.state === 'error' && info.errorKind === 'upload' && (item?.status === 'queued' || item?.status === 'uploading')
  const state = retrying ? 'uploading' : info.state
  const queued = state === 'uploading' && item?.status === 'queued'
  const progress = item?.progress ?? 0
  const processing = state === 'processing' || (state === 'uploading' && item?.status === 'uploading' && progress >= 1)
  const failed = state === 'error'
  const label = failed
    ? t(info.errorKind === 'parse' ? 'upload.parseFailedFile' : item?.status === 'cancelled' ? 'upload.cancelledFile' : 'upload.failedFile', { name: info.name })
    : processing
      ? t('upload.processingFile', { name: info.name })
      : queued
        ? t('upload.waitingFile', { name: info.name })
        : t('upload.uploadingFile', { name: info.name })
  return (
    <li
      data-pending-import={temp}
      className={`rounded-lg px-2 py-1.5 text-[13px] ${failed ? 'bg-red-500/10 ring-1 ring-red-500/25' : 'bg-surface-2/60 ring-1 ring-line/60'}`}
    >
      <div className="flex items-center gap-1.5">
        {failed ? (
          <CircleAlert size={14} className="shrink-0 text-red-500" />
        ) : processing ? (
          <LoaderCircle size={14} className="shrink-0 animate-spin text-accent-500" />
        ) : (
          <FileUp size={14} className="shrink-0 text-accent-500" />
        )}
        <span className={`min-w-0 flex-1 truncate ${failed ? 'text-red-600 dark:text-red-400' : ''}`} title={failed ? (info.error ?? item?.error ?? label) : info.name}>
          {label}
        </span>
        {failed && info.errorKind === 'upload' && info.itemId !== null && (
          <button
            type="button"
            onClick={() => retry(info.itemId!)}
            aria-label={t('common.retry')}
            title={t('common.retry')}
            className="inline-flex size-6 items-center justify-center rounded-md text-muted hover:bg-surface hover:text-fg"
          >
            <RotateCcw size={13} />
          </button>
        )}
        <button
          type="button"
          onClick={() => dismissUpload(temp, cancel)}
          aria-label={failed ? t('upload.remove') : t('common.cancel')}
          title={failed ? t('upload.remove') : t('common.cancel')}
          className="inline-flex size-6 items-center justify-center rounded-md text-muted hover:bg-surface hover:text-red-500"
        >
          <X size={13} />
        </button>
      </div>
      {!failed && (
        <div className="mt-1 pl-5">
          <ProgressBar value={progress} indeterminate={processing || queued} tone="accent" label={label} />
          {processing ? (
            <p className="mt-0.5 text-[11px] text-muted">{t('upload.processing')}</p>
          ) : queued ? (
            <p className="mt-0.5 text-[11px] text-muted">{t('library.upload.status.queued')} · {formatBytes(info.size)}</p>
          ) : (
            <TransferStats className="mt-0.5" fraction={progress} total={info.size} speed={item?.speed} etaSec={etaOf(info.size, progress * info.size, item?.speed)} />
          )}
        </div>
      )}
    </li>
  )
}

function ObjectRow({
  obj,
  selected,
  hidden,
  outside,
  uploading,
  onSettings,
}: {
  obj: SceneObject
  selected: boolean
  hidden: boolean
  outside: boolean
  uploading?: { state: string; error?: string }
  onSettings: () => void
}) {
  const { t } = useI18n()
  const doc = useWs((s) => s.doc)
  const [editing, setEditing] = useState(false)
  const [menu, setMenu] = useState<'slot' | 'more' | null>(null)
  const ref = useRef<HTMLLIElement>(null)
  useDismiss(ref, menu !== null, () => setMenu(null))
  const slot = doc.filaments.find((f) => f.slot === obj.filamentSlot)
  const entry = meshes.get(obj.fileId)
  const overrides = Object.keys(obj.overrides).length

  return (
    <li
      ref={ref}
      data-object-row={obj.id}
      data-selected={selected || undefined}
      className={`group relative flex h-8 items-center gap-1.5 rounded-lg pr-1 pl-2 text-[13px] transition-colors ${
        selected ? 'bg-accent-500/12 text-fg ring-1 ring-accent-500/30' : 'hover:bg-surface-2'
      } ${hidden ? 'opacity-55' : ''}`}
    >
      <button
        type="button"
        aria-label={t('workspace.objects.filament')}
        title={slot ? `${String(slot.slot).padStart(2, '0')} · ${shortPresetName(slot.presetId)}` : undefined}
        onClick={() => setMenu(menu === 'slot' ? null : 'slot')}
        className="flex size-5 shrink-0 items-center justify-center rounded-md text-[9px] font-bold text-black/60 ring-1 ring-black/10 ring-inset"
        style={{ background: slot?.color ?? '#9ca3af' }}
      >
        {obj.filamentSlot}
      </button>
      {editing ? (
        <input
          autoFocus
          defaultValue={obj.name}
          aria-label={t('workspace.objects.rename')}
          onBlur={(e) => {
            renameObject(obj.id, e.target.value)
            setEditing(false)
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') setEditing(false)
          }}
          className="h-6 min-w-0 flex-1 rounded-md border border-accent-500 bg-surface px-1.5 text-[13px] outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={(e) => workspace.select([obj.id], e.shiftKey || e.ctrlKey || e.metaKey ? 'toggle' : 'set')}
          onDoubleClick={() => setEditing(true)}
          className="min-w-0 flex-1 truncate rounded text-left focus-visible:outline-none focus-visible:underline focus-visible:decoration-accent-500"
          title={obj.name}
        >
          {obj.name}
        </button>
      )}
      {uploading?.state === 'error' ? (
        <Tip label={uploading.error ?? t('workspace.objects.uploadFailed')} side="left">
          <button type="button" onClick={() => dismissUpload(obj.fileId)} aria-label={t('workspace.objects.uploadFailed')} className="text-red-500">
            <CircleAlert size={14} />
          </button>
        </Tip>
      ) : uploading || entry?.state === 'loading' ? (
        <Tip label={uploading ? t('workspace.objects.uploading') : t('workspace.objects.loading')} side="left">
          <LoaderCircle size={14} className="animate-spin text-accent-500" />
        </Tip>
      ) : entry?.state === 'error' ? (
        <Tip label={t('workspace.objects.meshError')} side="left">
          <CircleAlert size={14} className="text-red-500" />
        </Tip>
      ) : outside ? (
        <Tip label={t('workspace.info.outside')} side="left">
          <CircleAlert size={14} className="text-red-500" />
        </Tip>
      ) : null}
      {overrides > 0 && (
        <Tip label={t('workspace.objects.overrides', { n: overrides })} side="left">
          <button
            type="button"
            onClick={onSettings}
            className="inline-flex h-5 items-center gap-0.5 rounded-md bg-violet-500/15 px-1 text-[10px] font-semibold text-violet-600 dark:text-violet-400"
          >
            <SlidersHorizontal size={10} />
            {overrides}
          </button>
        </Tip>
      )}
      <span className={`flex items-center ${selected || menu ? '' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`}>
        <button
          type="button"
          aria-label={hidden ? t('workspace.objects.show') : t('workspace.objects.hide')}
          title={hidden ? t('workspace.objects.show') : t('workspace.objects.hide')}
          onClick={() => workspace.toggleHidden(obj.id)}
          className="inline-flex size-6 items-center justify-center rounded-md text-muted hover:bg-surface hover:text-fg"
        >
          {hidden ? <EyeOff size={13} /> : <Eye size={13} />}
        </button>
        <button
          type="button"
          aria-label={t('workspace.objects.more')}
          title={t('workspace.objects.more')}
          onClick={() => setMenu(menu === 'more' ? null : 'more')}
          className="inline-flex size-6 items-center justify-center rounded-md text-muted hover:bg-surface hover:text-fg"
        >
          <Ellipsis size={14} />
        </button>
      </span>

      {menu === 'slot' && (
        <div className={`${menuCls} top-full left-0 mt-1 w-56`}>
          {doc.filaments.map((f) => (
            <button
              key={f.slot}
              type="button"
              className={menuItemCls}
              onClick={() => {
                setFilamentSlot(selected ? [...new Set([...workspace.state.selection, obj.id])] : [obj.id], f.slot)
                setMenu(null)
              }}
            >
              <span className="size-4 shrink-0 rounded-md ring-1 ring-black/10 ring-inset" style={{ background: f.color }} />
              <span className="font-mono text-xs text-muted">{String(f.slot).padStart(2, '0')}</span>
              <span className="min-w-0 flex-1 truncate">{shortPresetName(f.presetId)}</span>
            </button>
          ))}
        </div>
      )}
      {menu === 'more' && (
        <div className={`${menuCls} top-full right-0 mt-1 w-52`}>
          <button type="button" className={menuItemCls} onClick={() => (setEditing(true), setMenu(null))}>
            <Pencil size={14} className="text-muted" />
            {t('workspace.objects.rename')}
          </button>
          <button type="button" className={menuItemCls} onClick={() => (onSettings(), setMenu(null))}>
            <SlidersHorizontal size={14} className="text-violet-500" />
            {t('workspace.objects.settings')}
          </button>
          <button
            type="button"
            className={menuItemCls}
            onClick={() => {
              if (!selected) workspace.select([obj.id])
              duplicateSelected()
              setMenu(null)
            }}
          >
            <Copy size={14} className="text-muted" />
            {t('workspace.tool.duplicate')}
          </button>
          {doc.plates.length > 1 && (
            <div className="my-1 border-t border-line pt-1">
              <p className="px-2.5 py-1 text-[11px] font-medium text-muted">{t('workspace.objects.moveTo')}</p>
              <div className="flex flex-wrap gap-1 px-2 pb-1">
                {doc.plates.map((_, i) => (
                  <button
                    key={i}
                    type="button"
                    disabled={i === obj.plate}
                    onClick={() => {
                      moveToPlate(selected ? workspace.state.selection : [obj.id], i)
                      setMenu(null)
                    }}
                    className="inline-flex h-6 min-w-6 items-center justify-center gap-0.5 rounded-md border border-line px-1 text-[11px] font-semibold tabular-nums hover:border-accent-500 hover:text-accent-600 disabled:opacity-40"
                  >
                    <SquareArrowRight size={10} />
                    {i + 1}
                  </button>
                ))}
              </div>
            </div>
          )}
          <button type="button" className={`${menuItemCls} text-red-600 dark:text-red-400`} onClick={() => (deleteObjects(selected ? workspace.state.selection : [obj.id]), setMenu(null))}>
            <Trash2 size={14} />
            {t('common.delete')}
          </button>
        </div>
      )}
    </li>
  )
}
