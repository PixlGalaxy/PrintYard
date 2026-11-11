// Filament slots of the scene (Creality's right panel "Filament" box): colour chip 01, 02…, preset per slot,
// CFS slot mapping, per-slot filament settings (overrides) and "Sync from CFS".
import { Check, ChevronDown, Copy, FlaskConical, Minus, Palette, PencilLine, Plus, RefreshCw, Settings2, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { api } from '../../../api'
import ConfirmModal from '../../../components/ConfirmModal'
import { PrinterModelIcon } from '../../../components/printerIcons'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import { useLoader } from '../../../hooks'
import { useI18n } from '../../../i18n/I18nContext'
import { usePrinterStatus } from '../../../realtime'
import type { CfsSlot, FilamentPreset, FilamentSlot, PresetSummary, PrinterModel, ProfileBundle, User } from '../../../types'
import { canEditPreset, copyName, customRowId } from '../../../workspace/filamentPresets'
import { cfsName, followsSpool, loadedSpools, PRINTER_KEYS, presetForSpool, printerOverrides, spoolFingerprint, spoolLabel, spoolName } from '../../../workspace/printerFilaments'
import { invalidateCustomFilaments, loadPreset, shortPresetName } from '../../../workspace/profiles'
import { useWs, workspace } from '../../../workspace/store'
import { Section, Tip } from './bits'
import FilamentPresetDialog, { type PresetDraft } from './FilamentPresetDialog'
import FilamentSettings from './FilamentSettings'
import { menuCls, menuItemCls, useDismiss } from './styles'

const MAX_SLOTS = 16


/**
 * Slot ← printer spool: the matched preset plus what the printer has saved for that spool (colour, nozzle temperatures
 * clamped into its range, pressure advance) as slot overrides. The slot's other tweaks stay when the preset is the same.
 */
async function slotFromSpool(model: PrinterModel, bundle: ProfileBundle | null, prev: FilamentSlot | undefined, slot: number, preset: PresetSummary, spool: CfsSlot): Promise<FilamentSlot> {
  let fromPrinter: Record<string, string> = {}
  try {
    const values = (await loadPreset(model, 'filament', preset.id)).values
    fromPrinter = printerOverrides(spool, values, new Set((bundle?.filamentOptions ?? []).map((o) => o.key)))
  } catch {
    // preset values unavailable: colour + mapping only
  }
  const kept = prev?.presetId === preset.id ? Object.fromEntries(Object.entries(prev.overrides ?? {}).filter(([k]) => !PRINTER_KEYS.includes(k))) : {}
  const overrides = { ...kept, ...fromPrinter }
  return {
    slot,
    presetId: preset.id,
    color: (spool.color ?? preset.color ?? prev?.color ?? '#7DD3FC').toUpperCase(),
    cfs: { box: spool.box, slot: spool.slot },
    ...(Object.keys(overrides).length ? { overrides } : {}),
  }
}

const textOn = (hex: string) => {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16)
  const l = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)
  return l > 150 ? 'text-black/65' : 'text-white/90'
}

export default function FilamentPanel({ bundle }: { bundle: ProfileBundle | null }) {
  const { t } = useI18n()
  const { toast } = useToast()
  const filaments = useWs((s) => s.doc.filaments)
  const list = bundle?.filament ?? []
  const [editing, setEditing] = useState<number | null>(null)
  // Custom filament presets: create/duplicate dialog, values editor, delete confirmation
  const { user } = useAuth()
  const { onError } = useToast()
  const [createDraft, setCreateDraft] = useState<PresetDraft | null>(null)
  const [editPreset, setEditPreset] = useState<FilamentPreset | null>(null)
  const [deleting, setDeleting] = useState<PresetSummary | null>(null)
  const presetAction = async (action: PresetAction, p: PresetSummary) => {
    if (action === 'duplicate') return setCreateDraft({ basePresetId: p.id, name: copyName(shortPresetName(p.name), t('filaments.copySuffix')) })
    if (action === 'delete') return setDeleting(p)
    const id = customRowId(p.id)
    if (!id) return
    try {
      setEditPreset(await api.filamentPreset(id))
    } catch (err) {
      onError(err)
    }
  }
  const newFromCurrent = () => {
    const f = filaments[0]
    const s = list.find((p) => p.id === f?.presetId)
    const base = s && !s.custom ? s : (list.find((p) => p.isDefault && !p.custom) ?? list.find((p) => !p.custom))
    if (base) setCreateDraft({ basePresetId: base.id, filamentType: base.filamentType ?? null, color: base.color ?? null })
  }
  const touched = useRef(false)
  const { data: printers } = useLoader(api.printers)
  const status = usePrinterStatus(printers?.[0]?.id ?? null)
  const cfs = status?.online ? (status.cfs ?? null) : null
  const loaded = loadedSpools(cfs)
  // "In your printer": loaded spools with their best-matching preset (first group of the preset picker)
  const inPrinter = loaded.flatMap((c) => {
    const p = presetForSpool(list, c)
    return p ? [{ spool: c, preset: p }] : []
  })
  const model = useWs((s) => s.doc.printerModel)
  useLoadedFilamentDefault(list, inPrinter[0], touched, (preset, spool) => slotFromSpool(model, bundle, undefined, 1, preset, spool))

  const applySpool = async (slot: number, preset: PresetSummary, spool: CfsSlot) => {
    const prev = workspace.state.doc.filaments.find((f) => f.slot === slot)
    const next = await slotFromSpool(model, bundle, prev, slot, preset, spool)
    workspace.update((d) => ({ ...d, filaments: d.filaments.map((f) => (f.slot === slot ? next : f)) }))
  }

  // The printer's spool changed (other filament loaded, edited on the screen): offer to update the slots using it
  const [notice, setNotice] = useState<{ spool: CfsSlot; slots: number[] } | null>(null)
  const prints = useRef(new Map<string, string>())
  const fingerprints = (cfs ?? []).map((c) => `${c.box}-${c.slot}=${spoolFingerprint(c)}`).join(';')
  useEffect(() => {
    const prev = prints.current
    const next = new Map((cfs ?? []).map((c) => [`${c.box}-${c.slot}`, spoolFingerprint(c)]))
    prints.current = next
    if (!prev.size) return
    for (const c of cfs ?? []) {
      const key = `${c.box}-${c.slot}`
      const was = prev.get(key)
      if (was === undefined || was === next.get(key) || !c.material) continue
      const slots = workspace.state.doc.filaments.filter((f) => f.cfs?.box === c.box && f.cfs.slot === c.slot).map((f) => f.slot)
      if (slots.length) {
        setNotice({ spool: c, slots })
        toast('info', t('workspace.filament.spoolChanged', { name: spoolName(c), slot: spoolLabel(c, t) }))
      }
    }
    // only when the printer's data changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprints])
  const updateFromNotice = async () => {
    if (!notice) return
    const preset = presetForSpool(list, notice.spool)
    setNotice(null)
    if (!preset) return toast('error', t('workspace.filament.syncNone'))
    for (const slot of notice.slots) await applySpool(slot, preset, notice.spool)
    toast('success', t('workspace.filament.spoolUpdated', { n: notice.slots.length }))
  }

  const setSlot = (slot: number, patch: Partial<FilamentSlot>) =>
    workspace.update((d) => ({ ...d, filaments: d.filaments.map((f) => (f.slot === slot ? { ...f, ...patch } : f)) }))

  const add = () => {
    const def = list.find((p) => p.isDefault) ?? list[0]
    if (!def) return
    workspace.update((d) => ({ ...d, filaments: [...d.filaments, { slot: d.filaments.length + 1, presetId: def.id, color: def.color ?? '#7DD3FC' }] }))
  }
  const remove = (slot: number) =>
    workspace.update((d) => ({
      ...d,
      filaments: d.filaments.filter((f) => f.slot !== slot).map((f, i) => ({ ...f, slot: i + 1 })),
      objects: d.objects.map((o) => (o.filamentSlot === slot ? { ...o, filamentSlot: 1 } : o.filamentSlot > slot ? { ...o, filamentSlot: o.filamentSlot - 1 } : o)),
    }))

  const syncFromCfs = async () => {
    const next: FilamentSlot[] = []
    let skipped = 0
    for (const spool of loaded) {
      const p = presetForSpool(list, spool)
      if (!p) {
        skipped++
        continue
      }
      // keeps the slot's own tweaks when it already used this preset; adds the printer's saved values
      next.push(await slotFromSpool(model, bundle, filaments[next.length], next.length + 1, p, spool))
    }
    if (!next.length) {
      toast('error', t('workspace.filament.syncNone'))
      return
    }
    workspace.update((d) => ({
      ...d,
      filaments: next,
      objects: d.objects.map((o) => (o.filamentSlot > next.length ? { ...o, filamentSlot: 1 } : o)),
    }))
    toast('success', skipped ? t('workspace.filament.syncedSome', { n: next.length, skipped }) : t('workspace.filament.synced', { n: next.length }))
  }

  // Presets grouped by material type for the dropdown
  const byType = new Map<string, PresetSummary[]>()
  for (const p of list) byType.set(p.filamentType ?? '—', [...(byType.get(p.filamentType ?? '—') ?? []), p])
  const editingSlot = editing != null ? filaments.find((f) => f.slot === editing) : undefined

  return (
    <Section
      title={t('workspace.filament.title')}
      icon={<Palette size={14} />}
      actions={
        <div className="flex items-center gap-0.5">
          <Tip label={cfs ? t('workspace.filament.sync') : t('workspace.filament.noCfs')} side="left">
            <button
              type="button"
              aria-label={t('workspace.filament.sync')}
              disabled={!loaded.length || !list.length}
              onClick={() => void syncFromCfs()}
              className="inline-flex h-7 items-center gap-1 rounded-lg px-1.5 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40"
            >
              <RefreshCw size={14} />
              CFS
            </button>
          </Tip>
          <Tip label={t('filaments.createFilament')} side="left">
            <button
              type="button"
              aria-label={t('filaments.createFilament')}
              disabled={!list.length}
              onClick={newFromCurrent}
              className="inline-flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40"
            >
              <FlaskConical size={14} />
            </button>
          </Tip>
          <Tip label={t('workspace.filament.add')} side="left">
            <button
              type="button"
              aria-label={t('workspace.filament.add')}
              disabled={filaments.length >= MAX_SLOTS || !list.length}
              onClick={add}
              className="inline-flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40"
            >
              <Plus size={16} />
            </button>
          </Tip>
        </div>
      }
    >
      {notice && (
        <div role="status" className="mb-2 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px]">
          <span className="size-3 shrink-0 rounded-full ring-1 ring-black/15" style={{ background: notice.spool.color ?? 'transparent' }} />
          <span className="min-w-0 flex-1">{t('workspace.filament.spoolChangedAsk', { name: spoolName(notice.spool), slot: spoolLabel(notice.spool, t) })}</span>
          <button type="button" onClick={() => void updateFromNotice()} className="shrink-0 rounded-md bg-amber-500/20 px-2 py-0.5 font-semibold hover:bg-amber-500/30">
            {t('workspace.filament.spoolUpdate')}
          </button>
          <button type="button" onClick={() => setNotice(null)} className="shrink-0 rounded-md px-1.5 py-0.5 text-muted hover:text-fg">
            {t('workspace.filament.spoolKeep')}
          </button>
        </div>
      )}
      <ul className="max-h-48 space-y-1.5 overflow-y-auto">
        {filaments.map((f) => {
          const n = Object.keys(f.overrides ?? {}).length
          return (
            <li key={f.slot} className="flex items-center gap-1.5">
              <label
                className="relative flex h-8 w-9 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-lg ring-1 ring-black/10 ring-inset transition-transform hover:scale-105 dark:ring-white/10"
                style={{ background: f.color }}
                title={t('workspace.filament.color')}
              >
                <input type="color" value={f.color} onChange={(e) => setSlot(f.slot, { color: e.target.value.toUpperCase() })} className="absolute inset-0 cursor-pointer opacity-0" aria-label={t('workspace.filament.color')} />
                <span className={`pointer-events-none font-mono text-[11px] font-bold ${textOn(f.color)}`}>{String(f.slot).padStart(2, '0')}</span>
              </label>
              <PresetPicker
                value={f.presetId}
                label={t('workspace.filament.preset', { n: f.slot })}
                groups={byType}
                inPrinter={inPrinter}
                current={f}
                mappedSpool={f.cfs ? (cfs ?? []).find((c) => c.box === f.cfs!.box && c.slot === f.cfs!.slot && !!c.material) : undefined}
                user={user}
                onAction={presetAction}
                onCreate={newFromCurrent}
                onPick={(p, spool) => {
                  if (f.slot === 1) touched.current = true
                  // a different material starts clean: its own preset values, no carried-over tweaks
                  const keep = p.id === f.presetId ? { overrides: f.overrides } : { overrides: undefined }
                  if (spool) void applySpool(f.slot, p, spool)
                  else setSlot(f.slot, { presetId: p.id, ...keep, ...(p.color && !f.cfs ? { color: p.color } : {}) })
                }}
              />
              <CfsChip slot={f} cfs={cfs} onPick={(c) => setSlot(f.slot, c ? { cfs: { box: c.box, slot: c.slot }, ...(c.color ? { color: c.color.toUpperCase() } : {}) } : { cfs: undefined })} />
              <Tip label={t('workspace.filament.edit')} side="left">
                <button
                  type="button"
                  aria-label={t('workspace.filament.edit')}
                  onClick={() => setEditing(f.slot)}
                  className="relative inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
                >
                  <Settings2 size={14} />
                  {n > 0 && <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent-500 px-0.5 text-[8px] font-bold text-white">{n}</span>}
                </button>
              </Tip>
              <button
                type="button"
                aria-label={t('workspace.filament.remove')}
                title={t('workspace.filament.remove')}
                disabled={filaments.length <= 1}
                onClick={() => remove(f.slot)}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-red-500/10 hover:text-red-500 disabled:opacity-30"
              >
                <Minus size={14} />
              </button>
            </li>
          )
        })}
      </ul>
      {editingSlot && bundle && <FilamentSettings bundle={bundle} slot={editingSlot} onClose={() => setEditing(null)} />}
      {editPreset && bundle && <FilamentSettings bundle={bundle} preset={editPreset} onClose={() => setEditPreset(null)} />}
      {createDraft && bundle && <FilamentPresetDialog bundle={bundle} draft={createDraft} onClose={() => setCreateDraft(null)} />}
      {deleting && (
        <ConfirmModal
          title={t('filaments.deleteTitle')}
          confirmLabel={t('common.delete')}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api.deleteFilamentPreset(customRowId(deleting.id) ?? 0)
              invalidateCustomFilaments()
            } catch (err) {
              onError(err)
              throw err
            }
          }}
        >
          {t('filaments.deleteBody', { name: deleting.name })}
        </ConfirmModal>
      )}
    </Section>
  )
}

type Spool = { spool: CfsSlot; preset: PresetSummary }
type PresetAction = 'edit' | 'duplicate' | 'delete'

/**
 * New, still-untouched scene (no objects, a single slot on the bundle's default preset): slot 01 takes the filament
 * loaded in the printer. Never after the user picked a filament for slot 01 in this session.
 */
function useLoadedFilamentDefault(list: PresetSummary[], first: Spool | undefined, touched: RefObject<boolean>, build: (p: PresetSummary, s: CfsSlot) => Promise<FilamentSlot>) {
  const pristine = useWs((s) => {
    const f = s.doc.filaments
    if (s.doc.objects.length || f.length !== 1 || f[0]!.cfs || f[0]!.overrides) return null
    return f[0]!.presetId
  })
  const defId = (list.find((p) => p.isDefault) ?? list[0])?.id
  const spool = first?.spool
  const preset = first?.preset
  useEffect(() => {
    if (!spool || !preset || !defId || touched.current || pristine !== defId) return
    let alive = true
    void build(preset, spool).then((slot) => {
      // still untouched when the preset values arrived
      const f = workspace.state.doc.filaments
      if (!alive || touched.current || workspace.state.doc.objects.length || f.length !== 1 || f[0]!.cfs || f[0]!.presetId !== defId) return
      workspace.update((d) => ({ ...d, filaments: [slot] }), { history: false, dirty: false })
    })
    return () => {
      alive = false
    }
    // `build` is recreated every render; the spool/preset identity is what matters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spool, preset, defId, pristine, touched])
}

/** Shown only when the printer measures it (CFS RFID); the external spool / unmeasured slots show nothing. */
const measuredPct = (c: CfsSlot) => (!c.external && c.box !== 0 && c.remainingPct != null ? c.remainingPct : null)

const norm = (s: string) => s.trim().toLowerCase()

/** Tooltip of the "From printer" badge: the values taken from the printer's spool. */
function printerTip(spool: CfsSlot, slot: FilamentSlot, t: ReturnType<typeof useI18n>['t']) {
  const o = slot.overrides ?? {}
  const lines = [t('workspace.filament.fromPrinter'), t('workspace.filament.fromPrinterTip', { name: spoolName(spool), slot: spoolLabel(spool, t) })]
  if (spool.color) lines.push(`${t('workspace.filament.color')}: ${spool.color.toUpperCase()}`)
  if (o.nozzle_temperature) lines.push(`${t('workspace.filament.nozzleTemp')}: ${o.nozzle_temperature} °C`)
  if (o.nozzle_temperature_initial_layer) lines.push(`${t('workspace.filament.nozzleTempFirst')}: ${o.nozzle_temperature_initial_layer} °C`)
  if (spool.minTemp != null && spool.maxTemp != null) lines.push(`${t('workspace.filament.printerRange')}: ${spool.minTemp}–${spool.maxTemp} °C`)
  if (o.pressure_advance) lines.push(`${t('workspace.filament.pressureAdvance')}: ${o.pressure_advance}`)
  return lines.join('\n')
}

/** Filament preset dropdown: "In your printer" (loaded spools) first, then every preset grouped by material. */
function PresetPicker({
  value,
  label,
  groups,
  inPrinter,
  current,
  mappedSpool,
  user,
  onAction,
  onCreate,
  onPick,
}: {
  value: string
  label: string
  groups: Map<string, PresetSummary[]>
  inPrinter: Spool[]
  current: FilamentSlot
  /** The printer spool this slot is mapped to (for the "From printer" badge) */
  mappedSpool?: CfsSlot
  user: User | null | undefined
  /** Custom presets: edit / duplicate / delete from the list */
  onAction: (action: PresetAction, p: PresetSummary) => void
  onCreate: () => void
  onPick: (p: PresetSummary, spool?: CfsSlot) => void
}) {
  const { t } = useI18n()
  const printerModel = useWs((s) => s.doc.printerModel)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  // Fixed position: the slot list scrolls (overflow) and would clip an absolute menu
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; maxH: number } | null>(null)
  useDismiss(ref, open, () => setOpen(false))
  const toggle = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) {
      const below = window.innerHeight - r.bottom - 12
      const above = r.top - 12
      const left = Math.max(8, Math.min(r.left, window.innerWidth - 296))
      setPos(below >= 260 || below >= above ? { left, top: r.bottom + 4, maxH: Math.min(320, below) } : { left, bottom: window.innerHeight - r.top + 4, maxH: Math.min(320, above) })
    }
    setOpen((o) => !o)
  }
  useEffect(() => {
    if (!open) return
    const close = (e: Event) => {
      if (!listRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])
  const all = [...groups.values()].flat()
  const selected = all.find((p) => p.id === value)
  const pick = (p: PresetSummary, spool?: CfsSlot) => {
    onPick(p, spool)
    setOpen(false)
  }
  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
  }, [open])
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
  }
  const fromSpool = (c: CfsSlot) => current.cfs?.box === c.box && current.cfs.slot === c.slot
  const spoolSelected = inPrinter.some((x) => x.preset.id === value && fromSpool(x.spool))

  return (
    <div ref={ref} className="relative min-w-0 flex-1">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        ref={btnRef}
        onClick={toggle}
        className="flex h-8 w-full min-w-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-left text-xs transition-colors hover:border-accent-500/40 focus-visible:outline-2 focus-visible:outline-accent-500"
      >
        <span className="min-w-0 flex-1 truncate">{shortPresetName(selected?.name ?? value)}</span>
        {mappedSpool && followsSpool(current, mappedSpool) && (
          <span
            className="inline-flex size-4.5 shrink-0 items-center justify-center rounded bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
            title={printerTip(mappedSpool, current, t)}
          >
            <PrinterModelIcon size={10} model={printerModel} aria-hidden />
            <span className="sr-only">{t('workspace.filament.fromPrinter')}</span>
          </span>
        )}
        <ChevronDown size={14} className="shrink-0 text-muted" />
      </button>
      {open && pos && (
        <div
          ref={listRef}
          role="listbox"
          aria-label={label}
          onKeyDown={onKey}
          style={{ left: pos.left, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxH }}
          className={`${menuCls} fixed! z-50 w-72 max-w-[calc(100vw-1rem)] overflow-y-auto`}
        >
          {inPrinter.length > 0 && (
            <div role="group" aria-label={t('workspace.filament.inPrinter')}>
              <p className="flex items-center gap-1.5 px-2.5 pt-1 pb-1 text-[10px] font-semibold tracking-wide text-muted uppercase">
                <PrinterModelIcon size={12} model={printerModel} />
                {t('workspace.filament.inPrinter')}
              </p>
              {inPrinter.map(({ spool, preset }) => {
                const pct = measuredPct(spool)
                const on = preset.id === value && fromSpool(spool)
                return (
                  <button key={`${spool.box}-${spool.slot}`} type="button" role="option" aria-selected={on} className={menuItemCls} onClick={() => pick(preset, spool)}>
                    <span className="size-3.5 shrink-0 rounded-full ring-1 ring-black/15 dark:ring-white/20" style={{ background: spool.color ?? 'transparent' }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">
                        {spoolName(spool)}
                        {spool.vendor && !norm(spoolName(spool)).startsWith(norm(spool.vendor)) && <span className="font-normal text-muted"> · {spool.vendor}</span>}
                      </span>
                      <span className="block truncate text-[10px] text-muted">
                        {spoolLabel(spool, t)}
                        {norm(spoolName(spool)) !== norm(shortPresetName(preset.name)) && ` · ${t('workspace.filament.usesPreset', { name: shortPresetName(preset.name) })}`}
                      </span>
                    </span>
                    {pct != null && <span className="font-mono text-[10px] text-muted">{pct}%</span>}
                    {on && <Check size={14} className="shrink-0 text-accent-500" />}
                  </button>
                )
              })}
              <div className="my-1 h-px bg-line" />
            </div>
          )}
          {!selected && (
            <button type="button" role="option" aria-selected className={menuItemCls} onClick={() => setOpen(false)}>
              <span className="min-w-0 flex-1 truncate text-xs">{shortPresetName(value)}</span>
              <Check size={14} className="text-accent-500" />
            </button>
          )}
          {[...groups].map(([type, ps]) => (
            <div key={type} role="group" aria-label={type}>
              <p className="px-2.5 pt-1.5 pb-0.5 text-[10px] font-semibold tracking-wide text-muted uppercase">{type}</p>
              {ps.map((p) => {
                const on = p.id === value && !spoolSelected
                const option = (
                  <button key={p.id} type="button" role="option" aria-selected={on} className={`${menuItemCls} py-1! ${p.custom ? 'min-w-0 flex-1' : ''}`} onClick={() => pick(p)}>
                    <span className="size-2.5 shrink-0 rounded-full ring-1 ring-black/10" style={{ background: p.color ?? 'transparent' }} />
                    <span className="min-w-0 flex-1 truncate text-xs" title={p.custom && p.inherits ? t('filaments.basedOn', { name: shortPresetName(p.inherits) }) : undefined}>
                      {shortPresetName(p.name)}
                    </span>
                    {p.custom && <span className="shrink-0 rounded bg-violet-500/12 px-1 text-[9px] font-semibold text-violet-600 dark:text-violet-300">{t(p.scope === 'shared' ? 'filaments.sharedBadge' : 'filaments.custom')}</span>}
                    {on && <Check size={14} className="shrink-0 text-accent-500" />}
                  </button>
                )
                if (!p.custom) return option
                const act = (a: PresetAction) => {
                  setOpen(false)
                  onAction(a, p)
                }
                const editable = canEditPreset(p, user)
                return (
                  <div key={p.id} role="none" className="group/custom flex items-center">
                    {option}
                    <span className="flex shrink-0 items-center pr-1 opacity-60 group-hover/custom:opacity-100 group-focus-within/custom:opacity-100">
                      {editable && (
                        <button type="button" tabIndex={-1} aria-label={t('filaments.editPreset', { name: p.name })} title={t('common.edit')} onClick={() => act('edit')} className="inline-flex size-6 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-fg">
                          <PencilLine size={12} />
                        </button>
                      )}
                      <button type="button" tabIndex={-1} aria-label={t('filaments.duplicatePreset', { name: p.name })} title={t(editable || p.ownerId !== user?.id ? 'filaments.duplicate' : 'filaments.duplicateToEdit')} onClick={() => act('duplicate')} className="inline-flex size-6 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-fg">
                        <Copy size={12} />
                      </button>
                      {editable && (
                        <button type="button" tabIndex={-1} aria-label={t('filaments.deletePreset', { name: p.name })} title={t('common.delete')} onClick={() => act('delete')} className="inline-flex size-6 items-center justify-center rounded text-muted hover:bg-red-500/10 hover:text-red-500">
                          <Trash2 size={12} />
                        </button>
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
          ))}
          <div className="my-1 h-px bg-line" />
          <button
            type="button"
            className={`${menuItemCls} text-accent-600 dark:text-accent-300`}
            onClick={() => {
              setOpen(false)
              onCreate()
            }}
          >
            <FlaskConical size={14} className="shrink-0" />
            <span className="flex-1 text-xs font-medium">{t('filaments.createFilament')}…</span>
          </button>

        </div>
      )}
    </div>
  )
}

function CfsChip({ slot, cfs, onPick }: { slot: FilamentSlot; cfs: CfsSlot[] | null; onPick: (c: CfsSlot | null) => void }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, open, () => setOpen(false))
  const mapped = slot.cfs ? cfs?.find((c) => c.box === slot.cfs!.box && c.slot === slot.cfs!.slot) : undefined

  if (!cfs) {
    return (
      <Tip label={slot.cfs ? t('workspace.filament.cfsMapped', { slot: cfsName(slot.cfs) }) : t('workspace.filament.noCfs')} side="left">
        <span className="inline-flex h-8 w-10 shrink-0 items-center justify-center rounded-lg border border-dashed border-line font-mono text-[10px] text-muted">{slot.cfs ? cfsName(slot.cfs) : 'CFS'}</span>
      </Tip>
    )
  }
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('workspace.filament.cfsPick', { n: slot.slot })}
        title={slot.cfs ? t('workspace.filament.cfsMapped', { slot: cfsName(slot.cfs) }) : t('workspace.filament.cfsAuto')}
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex h-8 w-10 items-center justify-center gap-1 rounded-lg border font-mono text-[10px] font-semibold transition-colors ${
          slot.cfs ? 'border-line bg-surface-2 text-fg hover:border-accent-500' : 'border-dashed border-line text-muted hover:border-accent-500 hover:text-fg'
        }`}
      >
        {slot.cfs && <span className="size-2 rounded-full ring-1 ring-black/15" style={{ background: mapped?.color ?? slot.color }} />}
        {slot.cfs ? cfsName(slot.cfs) : 'CFS'}
      </button>
      {open && (
        <div role="menu" className={`${menuCls} right-0 mt-1 w-56`}>
          <button type="button" role="menuitem" className={menuItemCls} onClick={() => (onPick(null), setOpen(false))}>
            <span className="size-3.5 rounded-full border border-dashed border-muted" />
            <span className="flex-1">{t('workspace.filament.cfsAuto')}</span>
            {!slot.cfs && <Check size={14} className="text-accent-500" />}
          </button>
          {cfs.map((c) => (
            <button
              key={`${c.box}-${c.slot}`}
              type="button"
              role="menuitem"
              disabled={!c.material}
              className={menuItemCls}
              onClick={() => (onPick(c), setOpen(false))}
            >
              <span className="size-3.5 rounded-full ring-1 ring-black/15" style={{ background: c.color ?? 'transparent' }} />
              <span className="w-7 font-mono text-xs font-semibold" title={spoolLabel(c, t)}>
                {cfsName(c)}
              </span>
              <span className="min-w-0 flex-1 truncate">{c.material ?? t('workspace.filament.cfsEmpty')}</span>
              {measuredPct(c) != null && <span className="font-mono text-[10px] text-muted">{measuredPct(c)}%</span>}
              {slot.cfs?.box === c.box && slot.cfs.slot === c.slot && <Check size={14} className="text-accent-500" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
