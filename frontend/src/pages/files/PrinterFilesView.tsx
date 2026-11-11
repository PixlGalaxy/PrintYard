// Files → "On the printer" (like Creality Print's Local files): the printer's own G-code list with thumbnails,
// PrintYard badge, select all / multi-select, sort, refresh, and Print / Import / Delete per file or in bulk.
import {
  ArrowDownWideNarrow,
  CalendarDays,
  CheckSquare,
  Clock,
  FileCode2,
  FolderInput,
  HardDrive,
  Layers,
  Lock,
  PlugZap,
  RefreshCw,
  Ruler,
  Search,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, ApiError } from '../../api'
import ConfirmModal from '../../components/ConfirmModal'
import { PrinterLayers } from '../../components/printerIcons'
import { inputCls, selectCls } from '../../components/styles'
import { Badge, Button, Callout, Empty, ErrorState, IconButton, Loading } from '../../components/ui'
import { useAuth } from '../../context/AuthContext'
import { useToast } from '../../context/ToastContext'
import { formatDuration } from '../../gcode/format'
import { useStoredState } from '../../hooks'
import { useI18n } from '../../i18n/I18nContext'
import type { TranslationKey } from '../../i18n/translations'
import { useReadOnly } from '../../readOnly'
import type { Printer, PrinterStoredFile, UsageSummary } from '../../types'
import { formatBytes } from '../../validation'
import PrintDialog, { type PrintTarget } from '../workspace/preview/PrintDialog'

type Sort = 'date' | 'size' | 'layer' | 'name'

const SKIP: Record<string, TranslationKey> = {
  in_use: 'printerFiles.skip.in_use',
  offline: 'printerFiles.skip.offline',
  read_only: 'printerFiles.skip.read_only',
  not_confirmed: 'printerFiles.skip.not_confirmed',
}

export default function PrinterFilesView({ scopeSwitch }: { scopeSwitch: ReactNode }) {
  const { t, formatDate, formatNumber } = useI18n()
  const { user } = useAuth()
  const { toast, onError } = useToast()
  const readOnly = useReadOnly()
  const canDelete = user?.role === 'admin' || !!user?.canControlPrinter

  const [printers, setPrinters] = useState<Printer[] | null>(null)
  const [printerId, setPrinterId] = useStoredState<number | null>('sd:printerFiles:printer', null)
  const [sort, setSort] = useStoredState<Sort>('sd:printerFiles:sort', 'date')
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<PrinterStoredFile[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState<PrinterStoredFile[] | null>(null)
  const [importing, setImporting] = useState<Set<string>>(new Set())
  const [printing, setPrinting] = useState<PrintTarget | null>(null)
  const [usage, setUsage] = useState<UsageSummary | null>(null)

  useEffect(() => {
    api.printers().then(setPrinters, (err: unknown) => setError(err))
    api.usage().then(setUsage, () => undefined)
  }, [])

  const printer = printers?.find((p) => p.id === printerId) ?? printers?.[0] ?? null
  const pid = printer?.id ?? null

  const load = useCallback(
    async (refresh = false) => {
      if (pid == null) return
      setRefreshing(true)
      try {
        const list = await api.printerFiles(pid, refresh)
        setFiles(list)
        setError(null)
        setSelected((cur) => new Set([...cur].filter((n) => list.some((f) => f.name === n))))
      } catch (err) {
        setError(err)
        setFiles(null)
      } finally {
        setRefreshing(false)
      }
    },
    [pid],
  )

  // Printer changed: forget the old list right away (render-time reset), then load
  const [shownPrinter, setShownPrinter] = useState(pid)
  if (shownPrinter !== pid) {
    setShownPrinter(pid)
    setFiles(null)
    setError(null)
    setSelected(new Set())
  }
  useEffect(() => {
    if (pid == null) return
    let alive = true
    api.printerFiles(pid).then(
      (list) => alive && (setFiles(list), setError(null)),
      (err: unknown) => alive && setError(err),
    )
    return () => {
      alive = false
    }
  }, [pid])

  const visible = useMemo(() => {
    if (!files) return []
    const q = query.trim().toLowerCase()
    const list = files.filter((f) => !q || f.name.toLowerCase().includes(q))
    const cmp: Record<Sort, (a: PrinterStoredFile, b: PrinterStoredFile) => number> = {
      date: (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
      size: (a, b) => (b.size ?? 0) - (a.size ?? 0),
      layer: (a, b) => (a.layerHeight ?? 99) - (b.layerHeight ?? 99),
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
    }
    return [...list].sort((a, b) => cmp[sort](a, b) || a.name.localeCompare(b.name, undefined, { numeric: true }))
  }, [files, query, sort])

  const selectedFiles = visible.filter((f) => selected.has(f.name))
  const allSelected = visible.length > 0 && selectedFiles.length === visible.length
  const toggle = (name: string) =>
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const importFiles = async (list: PrinterStoredFile[]) => {
    if (pid == null) return
    setImporting((cur) => new Set([...cur, ...list.map((f) => f.name)]))
    const results = await Promise.allSettled(list.map((f) => api.importPrinterFile(pid, f.name)))
    setImporting((cur) => new Set([...cur].filter((n) => !list.some((f) => f.name === n))))
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    const ok = list.length - failed.length
    if (failed.length) onError(failed[0].reason)
    if (ok === 1 && list.length === 1) toast('success', t('printerFiles.importedOne', { name: list[0].name }))
    else if (ok) toast('success', t('printerFiles.importedMany', { n: ok }))
    if (failed.length && list.length > 1) toast('error', t('printerFiles.importFailed', { n: failed.length }))
  }

  const remove = async (list: PrinterStoredFile[]) => {
    if (pid == null) return
    try {
      const { results } = await api.deletePrinterFiles(pid, list.map((f) => f.name))
      const removed = results.filter((r) => r.result !== 'skipped').length
      const skipped = results.filter((r) => r.result === 'skipped')
      if (skipped.length) {
        const reasons = [...new Set(skipped.map((r) => t(SKIP[r.reason ?? ''] ?? 'printerFiles.skip.other')))].join(', ')
        toast('info', t('printerFiles.deletedSkipped', { n: removed, skipped: skipped.length, reasons }))
      } else toast('success', t('printerFiles.deletedToast', { n: removed }))
      const gone = new Set(results.filter((r) => r.result !== 'skipped').map((r) => r.name))
      setFiles((cur) => cur?.filter((f) => !gone.has(f.name)) ?? cur)
      setSelected(new Set())
    } catch (err) {
      onError(err)
      throw err
    }
  }

  const openPrint = (f: PrinterStoredFile) =>
    pid != null && setPrinting({ fileId: 0, fileName: f.name, grams: f.filamentGrams, seconds: f.estimatedSec, printerFile: { printerId: pid, name: f.name } })

  const offline = error instanceof ApiError && (error.code === 'prints.printer_offline' || error.code === 'printers.files_unavailable')
  const busy = (f: PrinterStoredFile) => importing.has(f.name)

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-3 shadow-sm lg:flex-row lg:items-center">
        {scopeSwitch}
        {printers && printers.length > 1 && (
          <select aria-label={t('printerFiles.printer')} value={pid ?? ''} onChange={(e) => setPrinterId(Number(e.target.value))} className={`${selectCls} w-auto!`}>
            {printers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <div className="relative min-w-0 flex-1">
          <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('printerFiles.search')} aria-label={t('printerFiles.search')} className={`${inputCls} pl-9!`} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="md"
            icon={allSelected ? <CheckSquare size={16} className="text-sky-500" /> : <Square size={16} />}
            disabled={!visible.length}
            onClick={() => setSelected(allSelected ? new Set() : new Set(visible.map((f) => f.name)))}
          >
            {t('library.selectAll')}
          </Button>
          <label className="relative">
            <span className="sr-only">{t('printerFiles.sort.label')}</span>
            <ArrowDownWideNarrow size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className={`${selectCls} w-auto! pl-8!`}>
              {(['date', 'size', 'layer', 'name'] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`printerFiles.sort.${s}`)}
                </option>
              ))}
            </select>
          </label>
          <Button size="md" icon={<RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />} disabled={pid == null || refreshing} onClick={() => void load(true)}>
            {t('printerFiles.refresh')}
          </Button>
        </div>
      </div>

      {files && printer && (
        <p className="flex items-center gap-2 px-1 text-xs text-muted">
          <PrinterLayers size={14} />
          {t('printerFiles.count', { n: files.length, printer: printer.name })}
          <span className="max-sm:hidden">· {t('printerFiles.hint')}</span>
        </p>
      )}
      {readOnly && <Callout tone="warning">{t('readOnly.tooltip')}</Callout>}

      {/* Selection bar */}
      {selectedFiles.length > 0 && (
        <div className="sticky top-22 z-20 flex flex-wrap items-center gap-2 rounded-2xl border border-sky-500/30 bg-surface/95 px-3 py-2 shadow-lg shadow-black/5 backdrop-blur-md animate-[toast-in_.15s_ease-out]">
          <IconButton label={t('library.clearSelection')} onClick={() => setSelected(new Set())}>
            <X size={16} />
          </IconButton>
          <span className="mr-auto text-sm font-medium">{t('library.selected', { n: selectedFiles.length })}</span>
          {selectedFiles.length === 1 && (
            <Button size="sm" variant="primary" icon={<PrinterLayers size={14} />} disabled={readOnly} onClick={() => openPrint(selectedFiles[0])}>
              {t('printerFiles.print')}
            </Button>
          )}
          <Button size="sm" icon={<FolderInput size={14} />} loading={selectedFiles.some(busy)} onClick={() => void importFiles(selectedFiles)}>
            {t('printerFiles.importShort')}
          </Button>
          {canDelete && (
            <Button size="sm" variant="danger" icon={<Trash2 size={14} />} disabled={readOnly} onClick={() => setDeleting(selectedFiles)}>
              {t('common.delete')}
            </Button>
          )}
        </div>
      )}

      {/* Content */}
      {printers && printers.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-surface/50">
          <Empty icon={<PrinterLayers size={20} />}>
            <p className="font-medium text-fg">{t('printerFiles.noPrinters')}</p>
          </Empty>
        </div>
      ) : offline ? (
        <div className="rounded-2xl border border-dashed border-line bg-surface/50">
          <Empty
            icon={<PlugZap size={20} />}
            action={
              <Button icon={<RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />} onClick={() => void load(true)}>
                {t('printerFiles.refresh')}
              </Button>
            }
          >
            <p className="font-medium text-fg">{t('printerFiles.offlineTitle')}</p>
            <p className="mt-1">{t('printerFiles.offlineDesc')}</p>
          </Empty>
        </div>
      ) : error && !files ? (
        <div className="rounded-2xl border border-line bg-surface shadow-sm">
          <ErrorState error={error} onRetry={() => void load(true)} />
        </div>
      ) : !files ? (
        <Loading />
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-surface/50">
          <Empty icon={files.length ? <Search size={20} /> : <FileCode2 size={20} />}>
            <p className="font-medium text-fg">{t(files.length ? 'library.noMatch' : 'printerFiles.empty')}</p>
          </Empty>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {visible.map((f) => {
            const sel = selected.has(f.name)
            return (
              <li
                key={f.name}
                className={`group relative flex flex-col overflow-hidden rounded-2xl border bg-surface shadow-sm transition-all hover:shadow-md ${
                  sel ? 'border-sky-500 ring-2 ring-sky-500/30' : 'border-line hover:border-sky-500/40'
                }`}
              >
                <button
                  type="button"
                  onClick={() => toggle(f.name)}
                  aria-pressed={sel}
                  aria-label={t(sel ? 'library.deselect' : 'library.select')}
                  className="block w-full text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-500"
                >
                  <Thumb file={f} />
                </button>
                <div className="absolute top-2 left-2 flex flex-wrap gap-1">
                  {f.uploadedByPrintYard && (
                    <span title={t('printerFiles.printYardHint')} className="rounded-full bg-sky-500 px-2 py-0.5 text-[11px] font-semibold text-white shadow">
                      {t('printerFiles.printYard')}
                    </span>
                  )}
                  {f.inUse && (
                    <span title={t('printerFiles.inUseHint')} className="flex items-center gap-1 rounded-full bg-amber-500 px-2 py-0.5 text-[11px] font-semibold text-white shadow">
                      <Lock size={10} />
                      {t('printerFiles.inUse')}
                    </span>
                  )}
                </div>
                <span
                  aria-hidden
                  className={`pointer-events-none absolute top-2 right-2 flex size-7 items-center justify-center rounded-lg bg-surface/90 shadow transition-opacity ${
                    sel || selected.size ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 max-md:opacity-100'
                  }`}
                >
                  {sel ? <CheckSquare size={16} className="text-sky-500" /> : <Square size={16} className="text-muted" />}
                </span>
                <div className="flex flex-1 flex-col p-3">
                  <p className="line-clamp-2 text-sm font-medium break-all" title={f.name}>
                    {f.name.replace(/\.gcode$/i, '')}
                  </p>
                  {f.colors.length > 0 && (
                    <div className="mt-1.5 flex items-center gap-1" aria-label={f.materials.join(', ')}>
                      {f.colors.slice(0, 8).map((c, i) => (
                        <span key={i} title={f.materials[i] ?? undefined} className="size-3 rounded-full border border-black/10 dark:border-white/20" style={{ backgroundColor: c }} />
                      ))}
                      {f.materials[0] && <span className="ml-1 text-[11px] text-muted">{[...new Set(f.materials)].join(' · ')}</span>}
                    </div>
                  )}
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted">
                    <Meta icon={<Layers size={12} />} label={t('printerFiles.layer')} value={f.layerHeight != null ? `${formatNumber(f.layerHeight, { maximumFractionDigits: 2 })} mm` : '—'} />
                    <Meta
                      icon={<Ruler size={12} />}
                      label={t('printerFiles.filament')}
                      value={f.filamentMm != null ? `${formatNumber(f.filamentMm / 1000, { maximumFractionDigits: 2 })} m` : '—'}
                    />
                    <Meta icon={<Clock size={12} />} label={t('printerFiles.time')} value={f.estimatedSec != null ? formatDuration(f.estimatedSec) : '—'} />
                    <Meta icon={<HardDrive size={12} />} label={t('printerFiles.size')} value={f.size != null ? formatBytes(f.size) : '—'} />
                    <Meta icon={<CalendarDays size={12} />} label={t('printerFiles.created')} value={f.createdAt != null ? formatDate(f.createdAt) : '—'} wide />
                  </dl>
                  {!f.uploadedByPrintYard && <p className="mt-1.5 text-[11px] text-muted/80">{t('printerFiles.foreign')}</p>}
                  <div className="mt-auto flex items-center gap-1 pt-3">
                    <Button size="sm" variant="primary" className="flex-1" icon={<PrinterLayers size={14} />} disabled={readOnly || f.inUse} onClick={() => openPrint(f)}>
                      {t('printerFiles.print')}
                    </Button>
                    <IconButton label={t('printerFiles.import')} title={t('printerFiles.import')} disabled={busy(f)} onClick={() => void importFiles([f])}>
                      <FolderInput size={16} className={busy(f) ? 'animate-pulse' : ''} />
                    </IconButton>
                    {canDelete && (
                      <IconButton label={t('printerFiles.delete')} title={f.inUse ? t('printerFiles.inUseHint') : t('printerFiles.delete')} tone="danger" disabled={readOnly || f.inUse} onClick={() => setDeleting([f])}>
                        <Trash2 size={16} />
                      </IconButton>
                    )}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {deleting && printer && (
        <ConfirmModal title={t('printerFiles.deleteTitle', { n: deleting.length })} confirmLabel={t('common.delete')} onClose={() => setDeleting(null)} onConfirm={() => remove(deleting)}>
          <p>{t('printerFiles.deleteDesc', { printer: printer.name })}</p>
          <ul className="mt-3 max-h-56 space-y-1 overflow-y-auto rounded-lg border border-line bg-surface-2/50 p-2 text-sm">
            {deleting.map((f) => (
              <li key={f.name} className="flex items-center gap-2">
                <FileCode2 size={14} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate" title={f.name}>
                  {f.name}
                </span>
                {f.inUse ? (
                  <Badge tone="amber">{t('printerFiles.inUse')}</Badge>
                ) : f.uploadedByPrintYard ? (
                  <Badge tone="sky">{t('printerFiles.printYard')}</Badge>
                ) : (
                  <Badge tone="red">{t('printerFiles.foreign')}</Badge>
                )}
              </li>
            ))}
          </ul>
          {deleting.some((f) => !f.uploadedByPrintYard && !f.inUse) && (
            <p className="mt-2 text-xs text-red-700 dark:text-red-300">
              {t('printerFiles.foreignWarning', { n: deleting.filter((f) => !f.uploadedByPrintYard && !f.inUse).length })}
            </p>
          )}
          {deleting.some((f) => f.inUse) && <p className="mt-1 text-xs text-muted">{t('printerFiles.inUseSkipped')}</p>}
        </ConfirmModal>
      )}
      {printing && (
        <PrintDialog
          target={printing}
          usage={usage}
          onClose={() => setPrinting(null)}
          onDone={() => {
            setSelected(new Set())
            void load(true)
          }}
        />
      )}
    </div>
  )
}

function Thumb({ file }: { file: PrinterStoredFile }) {
  const [broken, setBroken] = useState(false)
  return (
    <span className="flex aspect-[4/3] w-full items-center justify-center border-b border-line bg-gradient-to-b from-surface-2/40 to-surface-2">
      {file.thumbnailUrl && !broken ? (
        <img src={file.thumbnailUrl} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)} className="size-full object-contain p-3" />
      ) : (
        <FileCode2 size={36} className="text-emerald-500/70" />
      )}
    </span>
  )
}

function Meta({ icon, label, value, wide = false }: { icon: ReactNode; label: string; value: string; wide?: boolean }) {
  return (
    <div className={`flex min-w-0 items-center gap-1.5 ${wide ? 'col-span-2' : ''}`} title={label}>
      <dt className="shrink-0 text-muted/80">
        {icon}
        <span className="sr-only">{label}</span>
      </dt>
      <dd className="truncate tabular-nums">{value}</dd>
    </div>
  )
}
