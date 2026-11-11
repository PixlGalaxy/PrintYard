// Files library (/files): Private / Shared (+ All for admins) / On the printer tabs, grid or list, drag & drop uploads
// with the global queue, search + kind filter + sort, multi-select with bulk actions, context menu,
// thumbnails, retention info. Logic borrowed from WebinCloud's file explorer, in SliceDock's design.
import {
  ArrowDownWideNarrow,
  CheckSquare,
  Download,
  Ellipsis,
  FolderKanban,
  FolderOpen,
  Globe,
  LayoutGrid,
  List,
  Lock,
  Pencil,
  Pin,
  PinOff,
  Search,
  Share2,
  Square,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { adminApi, api } from '../../api'
import ConfirmModal from '../../components/ConfirmModal'
import { PrinterLayers } from '../../components/printerIcons'
import Modal from '../../components/Modal'
import PageHeader from '../../components/PageHeader'
import StorageUsage from '../../components/StorageUsage'
import { inputCls, selectCls } from '../../components/styles'
import { Badge, Button, Callout, Empty, ErrorState, IconButton, Loading, Segmented } from '../../components/ui'
import { useAuth } from '../../context/AuthContext'
import { useToast } from '../../context/ToastContext'
import { formatDuration } from '../../gcode/format'
import { GcodeBadges } from './GcodeBadges'
import { useStoredState } from '../../hooks'
import { useI18n } from '../../i18n/I18nContext'
import type { TranslationKey } from '../../i18n/translations'
import type { FileKind, LibraryFile } from '../../types'
import { formatBytes } from '../../validation'
import FileMenu, { type MenuItem } from './FileMenu'
import FileThumb, { KindIcon } from './FileThumb'
import { ACCEPT_ATTR } from './uploads/accept'
import { openPath } from './lookup'
import { useUploads } from './uploads/UploadContext'
import { PendingUploadCard, PendingUploadRow } from './PendingUploads'
import { usePendingUploads } from './uploads/pending'
import PrinterFilesView from './PrinterFilesView'
import { previewFile } from '../../workspace/previewFile'
import { useThumbnailBackfill } from '../../workspace/thumbnails'

type Scope = 'private' | 'shared' | 'all'
/** Library scopes plus "On the printer" (the printer's own G-code files) */
type Tab = Scope | 'printer'
type Sort = 'date' | 'name' | 'size'

export default function FilesPage() {
  const { t, formatDate, formatNumber } = useI18n()
  const { user, config } = useAuth()
  const { toast, onError } = useToast()
  const navigate = useNavigate()
  const uploads = useUploads()
  const isAdmin = user?.role === 'admin'

  const [tab, setTab] = useStoredState<Tab>('sd:files:scope', 'private')
  const onPrinter = tab === 'printer'
  const scope: Scope = tab === 'printer' ? 'private' : tab
  const [view, setView] = useStoredState<'grid' | 'list'>('sd:files:view', 'grid')
  const [sort, setSort] = useStoredState<Sort>('sd:files:sort', 'date')
  const [kind, setKind] = useState<FileKind | 'all'>('all')
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<LibraryFile[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [menu, setMenu] = useState<{ x: number; y: number; file: LibraryFile } | null>(null)
  const [renaming, setRenaming] = useState<LibraryFile | null>(null)
  const [deleting, setDeleting] = useState<LibraryFile[] | null>(null)
  const [dragging, setDragging] = useState(false)
  const [retention, setRetention] = useState<{ enabled: boolean; keep: number } | null>(
    config?.files ? { enabled: config.files.retentionEnabled, keep: config.files.retentionKeep } : null,
  )
  const input = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const effectiveScope: Scope = scope === 'all' && !isAdmin ? 'private' : scope
  const pendingUploads = usePendingUploads(effectiveScope, files)
  // Models without a thumbnail get one rendered in the background (owner/admin only, ≤ 50 MB)
  useThumbnailBackfill(onPrinter ? null : files, user)

  // Admins can read the real values when /config doesn't carry them
  useEffect(() => {
    if (retention || !isAdmin) return
    adminApi.settings().then((s) => setRetention({ enabled: s['files.retention.enabled'] ?? true, keep: s['files.retention.keep'] ?? 10 }), () => undefined)
  }, [retention, isAdmin])

  // Only the latest list request may land (a slow reply for the previous scope is dropped)
  const loadSeq = useRef(0)
  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    try {
      const list = await api.files(effectiveScope)
      if (seq !== loadSeq.current) return
      setFiles((prev) => {
        // Retention may have removed old files after an upload: tell the user
        if (prev && effectiveScope === 'private') {
          const now = new Set(list.map((f) => f.id))
          const gone = prev.filter((f) => !now.has(f.id) && f.ownerId === user?.id)
          if (gone.length) toast('info', t('library.retentionRemoved', { n: gone.length }))
        }
        return list
      })
      setError(null)
    } catch (err) {
      if (seq === loadSeq.current) setError(err)
    }
  }, [effectiveScope, t, toast, user?.id])

  // Switching scope: forget the old list right away (render-time reset, no effect)
  const [shownScope, setShownScope] = useState(effectiveScope)
  if (shownScope !== effectiveScope) {
    setShownScope(effectiveScope)
    setFiles(null)
    setError(null)
    setSelected(new Set())
  }
  useEffect(() => {
    if (onPrinter) return
    let alive = true
    const seq = ++loadSeq.current
    api.files(effectiveScope).then(
      (list) => {
        if (!alive || seq !== loadSeq.current) return
        setFiles(list)
        setError(null)
      },
      (err: unknown) => alive && seq === loadSeq.current && setError(err),
    )
    return () => {
      alive = false
    }
  }, [effectiveScope, onPrinter])

  useEffect(() => uploads.onUploaded(() => void load()), [uploads, load])

  const visible = useMemo(() => {
    if (!files) return []
    const q = query.trim().toLowerCase()
    const list = files.filter((f) => (kind === 'all' || f.kind === kind) && (!q || f.name.toLowerCase().includes(q) || f.ownerName.toLowerCase().includes(q)))
    const cmp: Record<Sort, (a: LibraryFile, b: LibraryFile) => number> = {
      date: (a, b) => b.createdAt - a.createdAt,
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
      size: (a, b) => b.size - a.size,
    }
    return [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || cmp[sort](a, b))
  }, [files, query, kind, sort])

  const canWrite = (f: LibraryFile) => isAdmin || f.ownerId === user?.id
  const selectedFiles = visible.filter((f) => selected.has(f.id))

  const toggle = (id: number, range = false) =>
    setSelected((cur) => {
      const next = new Set(cur)
      if (range && cur.size) {
        const ids = visible.map((f) => f.id)
        const lastIdx = ids.findIndex((x) => cur.has(x))
        const idx = ids.indexOf(id)
        const [a, b] = lastIdx < idx ? [lastIdx, idx] : [idx, lastIdx]
        for (const x of ids.slice(a, b + 1)) next.add(x)
        return next
      }
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // Keyboard: Ctrl/Cmd+A select all, Delete removes the selection, Esc clears it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (onPrinter) return
      if ((e.target as HTMLElement).closest('input,textarea,select,[role=dialog]')) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setSelected(new Set(visible.map((f) => f.id)))
      } else if (e.key === 'Escape') setSelected(new Set())
      else if (e.key === 'Delete' && selectedFiles.length && selectedFiles.every(canWrite)) setDeleting(selectedFiles)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const patch = async (f: LibraryFile, body: Parameters<typeof api.updateFile>[1], quiet = false) => {
    try {
      const updated = await api.updateFile(f.id, body)
      setFiles((cur) => cur?.map((x) => (x.id === f.id ? updated : x)) ?? cur)
      if (!quiet) {
        if (body.pinned !== undefined) toast('success', t(body.pinned ? 'library.pinnedToast' : 'library.unpinnedToast'))
        else if (body.visibility) toast('success', t(body.visibility === 'shared' ? 'library.sharedToast' : 'library.unsharedToast'))
        else toast('success', t('library.renamedToast'))
      }
      if (effectiveScope === 'shared' && body.visibility === 'private') void load()
    } catch (err) {
      onError(err)
      throw err
    }
  }

  const bulk = async (body: Parameters<typeof api.updateFile>[1]) => {
    const targets = selectedFiles.filter(canWrite)
    const results = await Promise.allSettled(targets.map((f) => api.updateFile(f.id, body)))
    const failed = results.filter((r) => r.status === 'rejected').length
    if (failed) toast('error', t('library.bulkFailed', { n: failed }))
    else toast('success', t('library.bulkDone', { n: targets.length }))
    void load()
  }

  const download = (f: LibraryFile) => void api.downloadFile(f).catch(onError)

  const remove = async (list: LibraryFile[], alsoPrinter = false) => {
    const results = await Promise.allSettled(list.map((f) => api.deleteFile(f.id, { printer: alsoPrinter })))
    const failed = results.filter((r) => r.status === 'rejected')
    const ok = list.length - failed.length
    if (failed.length) {
      onError((failed[0] as PromiseRejectedResult).reason)
      if (!ok) throw (failed[0] as PromiseRejectedResult).reason
    }
    // Per-copy printer results: deleted / already gone / skipped (in use, offline, read-only, unverified)
    const copies = results.flatMap((r) => (r.status === 'fulfilled' && r.value ? r.value.printer : []))
    const removed = copies.filter((c) => c.result !== 'skipped').length
    const skipped = copies.filter((c) => c.result === 'skipped')
    if (skipped.length) {
      const reasons = [...new Set(skipped.map((c) => t(PRINTER_SKIP[c.reason ?? ''] ?? 'library.printerSkip.other')))].join(', ')
      toast('info', t('library.deletedPrinterSkipped', { n: ok, removed, skipped: skipped.length, reasons }))
    } else if (copies.length) toast('success', t('library.deletedWithPrinter', { n: ok, removed }))
    else toast('success', t('library.deletedToast', { n: ok }))
    setSelected(new Set())
    const failedIds = new Set(list.filter((_, i) => results[i].status === 'rejected').map((f) => f.id))
    const gone = new Set(list.map((f) => f.id).filter((id) => !failedIds.has(id)))
    // A deleted G-code is no longer the Preview's current file
    if (user) previewFile.bindUser(user.id)
    previewFile.forget(gone)
    setFiles((cur) => cur?.filter((f) => !gone.has(f.id)) ?? cur)
  }

  const menuItems = (f: LibraryFile): MenuItem[] => {
    const w = canWrite(f)
    return [
      { key: 'open', icon: <FolderOpen size={16} className="text-sky-500" />, label: t(`library.open.${f.kind}`), onClick: () => navigate(openPath(f)) },
      { key: 'download', icon: <Download size={16} />, label: t('library.download'), onClick: () => download(f) },
      { key: 'sep1', icon: null, label: '', onClick: () => undefined },
      {
        key: 'share',
        icon: f.visibility === 'shared' ? <Lock size={16} /> : <Share2 size={16} className="text-violet-500" />,
        label: t(f.visibility === 'shared' ? 'library.unshare' : 'library.share'),
        disabled: !w,
        onClick: () => void patch(f, { visibility: f.visibility === 'shared' ? 'private' : 'shared' }).catch(() => undefined),
      },
      {
        key: 'pin',
        icon: f.pinned ? <PinOff size={16} /> : <Pin size={16} className="text-amber-500" />,
        label: t(f.pinned ? 'library.unpin' : 'library.pin'),
        disabled: !w,
        onClick: () => void patch(f, { pinned: !f.pinned }).catch(() => undefined),
      },
      { key: 'rename', icon: <Pencil size={16} />, label: t('library.rename'), disabled: !w, onClick: () => setRenaming(f) },
      { key: 'sep2', icon: null, label: '', onClick: () => undefined },
      { key: 'delete', icon: <Trash2 size={16} />, label: t('common.delete'), danger: true, disabled: !w, onClick: () => setDeleting([f]) },
    ]
  }

  const openMenu = (e: ReactMouseEvent, f: LibraryFile) => {
    e.preventDefault()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({ x: e.type === 'contextmenu' ? e.clientX : r.right - 240, y: e.type === 'contextmenu' ? e.clientY : r.bottom + 4, file: f })
  }

  // ---- drag & drop anywhere on the page
  const onDragEnter = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragDepth.current++
    setDragging(true)
  }
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (!dragDepth.current) setDragging(false)
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    if (e.dataTransfer.files.length) uploads.add(e.dataTransfer.files, scope === 'shared' ? 'shared' : 'private')
  }

  const counts = useMemo(() => {
    const c = { all: 0, model: 0, project: 0, gcode: 0 }
    for (const f of files ?? []) {
      c.all++
      c[f.kind]++
    }
    return c
  }, [files])

  const tabs: { value: Tab; label: string; icon: ReactNode }[] = [
    { value: 'private', label: t('library.scope.private'), icon: <Lock size={16} /> },
    { value: 'shared', label: t('library.scope.shared'), icon: <Globe size={16} /> },
    ...(isAdmin ? [{ value: 'all' as Tab, label: t('library.scope.all'), icon: <FolderKanban size={16} /> }] : []),
    { value: 'printer', label: t('library.scope.printer'), icon: <PrinterLayers size={16} /> },
  ]
  const scopeSwitch = <Segmented value={onPrinter ? 'printer' : effectiveScope} onChange={setTab} label={t('library.scope.label')} options={tabs} compactOnPhone />

  if (onPrinter) {
    return (
      <div className="relative space-y-5">
        <PageHeader title={t('library.title')} subtitle={t('library.subtitle')} />
        <PrinterFilesView scopeSwitch={scopeSwitch} />
      </div>
    )
  }

  return (
    <div
      className="relative space-y-5"
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <PageHeader
        title={t('library.title')}
        subtitle={t('library.subtitle')}
        actions={
          <>
            <input ref={input} type="file" multiple accept={ACCEPT_ATTR} className="hidden" onChange={(e) => {
              if (e.target.files?.length) uploads.add(e.target.files, scope === 'shared' ? 'shared' : 'private')
              e.target.value = ''
            }} />
            <Button variant="primary" size="md" icon={<UploadCloud size={16} />} onClick={() => input.current?.click()}>
              {t('library.upload.button')}
            </Button>
          </>
        }
      />

      <StorageUsage refreshKey={files ? files.length + files.reduce((a, f) => a + f.size, 0) : null} />

      {retention?.enabled && effectiveScope === 'private' && (
        <Callout tone="info" title={t('library.retentionTitle', { n: retention.keep })}>
          {t('library.retentionDesc')}
        </Callout>
      )}

      {/* Toolbar */}
      <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-3 shadow-sm lg:flex-row lg:items-center">
        {scopeSwitch}
        <div className="relative min-w-0 flex-1">
          <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('library.search')}
            aria-label={t('library.search')}
            className={`${inputCls} pl-9!`}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label={t('library.kind.label')} value={kind} onChange={(e) => setKind(e.target.value as FileKind | 'all')} className={`${selectCls} w-auto!`}>
            {(['all', 'model', 'project', 'gcode'] as const).map((k) => (
              <option key={k} value={k}>
                {t(`library.kind.${k}`)} ({counts[k]})
              </option>
            ))}
          </select>
          <label className="relative">
            <span className="sr-only">{t('library.sort.label')}</span>
            <ArrowDownWideNarrow size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className={`${selectCls} w-auto! pl-8!`}>
              {(['date', 'name', 'size'] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`library.sort.${s}`)}
                </option>
              ))}
            </select>
          </label>
          <Segmented
            value={view}
            onChange={setView}
            label={t('library.view')}
            options={[
              { value: 'grid', label: '', icon: <LayoutGrid size={14} aria-label={t('library.grid')} /> },
              { value: 'list', label: '', icon: <List size={14} aria-label={t('library.list')} /> },
            ]}
          />
        </div>
      </div>

      {/* Selection bar */}
      {selectedFiles.length > 0 && (
        <div className="sticky top-22 z-20 flex flex-wrap items-center gap-2 rounded-2xl border border-sky-500/30 bg-surface/95 px-3 py-2 shadow-lg shadow-black/5 backdrop-blur-md animate-[toast-in_.15s_ease-out]">
          <IconButton label={t('library.clearSelection')} onClick={() => setSelected(new Set())}>
            <X size={16} />
          </IconButton>
          <span className="mr-auto text-sm font-medium">{t('library.selected', { n: selectedFiles.length })}</span>
          <Button size="sm" icon={<Download size={14} />} onClick={() => selectedFiles.forEach((f, i) => setTimeout(() => download(f), i * 350))}>
            {t('library.download')}
          </Button>
          {selectedFiles.some(canWrite) && (
            <>
              <Button size="sm" icon={<Share2 size={14} />} onClick={() => void bulk({ visibility: 'shared' })}>
                {t('library.share')}
              </Button>
              <Button size="sm" icon={<Lock size={14} />} onClick={() => void bulk({ visibility: 'private' })}>
                {t('library.unshare')}
              </Button>
              <Button size="sm" icon={<Pin size={14} />} onClick={() => void bulk({ pinned: true })}>
                {t('library.pin')}
              </Button>
              <Button size="sm" variant="danger" icon={<Trash2 size={14} />} disabled={!selectedFiles.every(canWrite)} onClick={() => setDeleting(selectedFiles)}>
                {t('common.delete')}
              </Button>
            </>
          )}
        </div>
      )}

      {/* Content */}
      {error && !files ? (
        <div className="rounded-2xl border border-line bg-surface shadow-sm">
          <ErrorState error={error} onRetry={() => void load()} />
        </div>
      ) : !files ? (
        <Loading />
      ) : visible.length === 0 && pendingUploads.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-surface/50">
          <Empty
            icon={files.length ? <Search size={20} /> : <UploadCloud size={20} />}
            action={
              !files.length && effectiveScope !== 'all' ? (
                <Button variant="primary" icon={<UploadCloud size={14} />} onClick={() => input.current?.click()}>
                  {t('library.upload.button')}
                </Button>
              ) : undefined
            }
          >
            <p className="font-medium text-fg">{t(files.length ? 'library.noMatch' : `library.empty.${effectiveScope}`)}</p>
            {!files.length && <p className="mt-1">{t('library.dropHint')}</p>}
          </Empty>
        </div>
      ) : view === 'grid' ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
          {pendingUploads.map((it) => (
            <PendingUploadCard key={`up-${it.id}`} it={it} />
          ))}
          {visible.map((f) => {
            const sel = selected.has(f.id)
            return (
              <li
                key={f.id}
                onContextMenu={(e) => openMenu(e, f)}
                className={`group relative overflow-hidden rounded-2xl border bg-surface shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md ${
                  sel ? 'border-sky-500 ring-2 ring-sky-500/30' : 'border-line hover:border-sky-500/40'
                }`}
              >
                <button
                  type="button"
                  className="block w-full text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-500"
                  onClick={(e) => (e.ctrlKey || e.metaKey || e.shiftKey || selected.size ? toggle(f.id, e.shiftKey) : navigate(openPath(f)))}
                  title={t(`library.open.${f.kind}`)}
                >
                  <FileThumb file={f} className="aspect-square w-full border-b border-line" iconSize={36} />
                  <div className="p-3">
                    <p className="truncate text-sm font-medium" title={f.name}>
                      {f.name}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted">
                      <KindIcon kind={f.kind} size={12} />
                      {subtitle(f, formatBytes, formatNumber)}
                    </p>
                    {f.kind === 'gcode' && (
                      <div className="mt-1.5">
                        <GcodeBadges file={f} />
                      </div>
                    )}
                    {effectiveScope !== 'private' && <p className="mt-0.5 truncate text-[11px] text-muted">{f.ownerName}</p>}
                  </div>
                </button>
                <div className="absolute top-2 left-2 flex gap-1">
                  {f.pinned && (
                    <span title={t('library.pinnedHint')} className="flex size-6 items-center justify-center rounded-full bg-amber-500 text-white shadow">
                      <Pin size={12} />
                    </span>
                  )}
                  {f.visibility === 'shared' && (
                    <span title={t('library.scope.shared')} className="flex size-6 items-center justify-center rounded-full bg-violet-500 text-white shadow">
                      <Globe size={12} />
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  aria-label={t(sel ? 'library.deselect' : 'library.select')}
                  aria-pressed={sel}
                  onClick={() => toggle(f.id)}
                  className={`absolute top-2 right-2 flex size-7 items-center justify-center rounded-lg bg-surface/90 shadow transition-opacity focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-sky-500 ${
                    sel || selected.size ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 max-md:opacity-100'
                  }`}
                >
                  {sel ? <CheckSquare size={16} className="text-sky-500" /> : <Square size={16} className="text-muted" />}
                </button>
                <button
                  type="button"
                  aria-label={t('library.actions')}
                  onClick={(e) => openMenu(e, f)}
                  className="absolute right-2 bottom-2 flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-sky-500"
                >
                  <Ellipsis size={16} />
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface-2/50 text-left">
              <tr>
                <th className="w-10 py-2 pl-3">
                  <button
                    type="button"
                    aria-label={t('library.selectAll')}
                    onClick={() => setSelected(selected.size === visible.length ? new Set() : new Set(visible.map((f) => f.id)))}
                    className="flex text-muted hover:text-fg"
                  >
                    {selected.size && selected.size === visible.length ? <CheckSquare size={16} className="text-sky-500" /> : <Square size={16} />}
                  </button>
                </th>
                <th className="py-2 pr-4 text-xs font-medium text-muted">{t('library.col.name')}</th>
                <th className="py-2 pr-4 text-xs font-medium text-muted max-md:hidden">{t('library.col.details')}</th>
                {effectiveScope !== 'private' && <th className="py-2 pr-4 text-xs font-medium text-muted max-sm:hidden">{t('library.col.owner')}</th>}
                <th className="py-2 pr-4 text-right text-xs font-medium text-muted max-sm:hidden">{t('library.col.size')}</th>
                <th className="py-2 pr-4 text-xs font-medium text-muted max-lg:hidden">{t('library.col.date')}</th>
                <th className="w-12" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {pendingUploads.map((it) => (
                <PendingUploadRow key={`up-${it.id}`} it={it} columns={effectiveScope !== 'private' ? 7 : 6} />
              ))}
              {visible.map((f) => {
                const sel = selected.has(f.id)
                return (
                  <tr key={f.id} onContextMenu={(e) => openMenu(e, f)} className={`transition-colors ${sel ? 'bg-sky-500/[0.07]' : 'hover:bg-surface-2/60'}`}>
                    <td className="py-2 pl-3">
                      <button type="button" aria-label={t(sel ? 'library.deselect' : 'library.select')} aria-pressed={sel} onClick={(e) => toggle(f.id, e.shiftKey)} className="flex text-muted hover:text-fg">
                        {sel ? <CheckSquare size={16} className="text-sky-500" /> : <Square size={16} />}
                      </button>
                    </td>
                    <td className="max-w-0 py-2 pr-4">
                      <button type="button" onClick={() => navigate(openPath(f))} className="flex w-full min-w-0 items-center gap-3 text-left focus-visible:outline-2 focus-visible:outline-sky-500">
                        <FileThumb file={f} className="size-9 shrink-0 rounded-lg border border-line" iconSize={16} />
                        <span className="truncate font-medium hover:text-sky-600 dark:hover:text-sky-400">{f.name}</span>
                        {f.pinned && <Pin size={12} className="shrink-0 text-amber-500" aria-label={t('library.pinned')} />}
                        {f.visibility === 'shared' && <Globe size={12} className="shrink-0 text-violet-500" aria-label={t('library.scope.shared')} />}
                      </button>
                    </td>
                    <td className="py-2 pr-4 text-xs text-muted max-md:hidden">
                      <Badge tone={f.kind === 'model' ? 'sky' : f.kind === 'project' ? 'violet' : 'emerald'}>{t(`library.kind.${f.kind}`)}</Badge>{' '}
                      {subtitle(f, formatBytes, formatNumber, true)}
                      {f.kind === 'gcode' && (
                        <span className="mt-1 block">
                          <GcodeBadges file={f} />
                        </span>
                      )}
                    </td>
                    {effectiveScope !== 'private' && <td className="py-2 pr-4 text-xs text-muted max-sm:hidden">{f.ownerName}</td>}
                    <td className="py-2 pr-4 text-right font-mono text-xs text-muted tabular-nums max-sm:hidden">{formatBytes(f.size)}</td>
                    <td className="py-2 pr-4 text-xs whitespace-nowrap text-muted max-lg:hidden">{formatDate(f.createdAt)}</td>
                    <td className="py-2 pr-2">
                      <IconButton label={t('library.actions')} onClick={(e) => openMenu(e, f)}>
                        <Ellipsis size={16} />
                      </IconButton>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-4 z-40 flex flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed border-sky-500 bg-sky-500/10 backdrop-blur-sm animate-[fade-in_.12s_ease-out]">
          <span className="flex size-14 items-center justify-center rounded-2xl bg-sky-500 text-white shadow-lg shadow-sky-500/30">
            <UploadCloud size={26} />
          </span>
          <p className="text-base font-semibold text-sky-700 dark:text-sky-300">{t('library.dropTitle')}</p>
          <p className="text-sm text-sky-700/80 dark:text-sky-300/80">{t('library.dropTypes')}</p>
        </div>
      )}

      {menu && <FileMenu x={menu.x} y={menu.y} items={menuItems(menu.file)} onClose={() => setMenu(null)} />}
      {renaming && <RenameModal file={renaming} onClose={() => setRenaming(null)} onSave={(name) => patch(renaming, { name })} />}
      {deleting && <DeleteFilesDialog files={deleting} onClose={() => setDeleting(null)} onConfirm={(alsoPrinter) => remove(deleting, alsoPrinter)} />}
    </div>
  )
}

const PRINTER_SKIP: Record<string, TranslationKey> = {
  in_use: 'library.printerSkip.in_use',
  offline: 'library.printerSkip.offline',
  read_only: 'library.printerSkip.read_only',
  unverified: 'library.printerSkip.unverified',
}

/**
 * Delete confirmation. G-code files SliceDock uploaded to a printer list their printer copies; "Also delete from the
 * printer" (default on) removes them there too (the server skips copies in use, offline or not verifiable).
 */
function DeleteFilesDialog({ files, onClose, onConfirm }: { files: LibraryFile[]; onClose: () => void; onConfirm: (alsoPrinter: boolean) => Promise<unknown> }) {
  const { t } = useI18n()
  const [copies, setCopies] = useState<{ files: number; printers: string[] } | null>(null)
  const [alsoPrinter, setAlsoPrinter] = useState(true)
  useEffect(() => {
    const ids = files.filter((f) => f.kind === 'gcode').map((f) => f.id)
    if (!ids.length) return
    let alive = true
    api
      .printerCopies(ids)
      .then((r) => {
        if (!alive) return
        const withCopies = r.items.filter((i) => i.copies.length > 0)
        setCopies({ files: withCopies.length, printers: [...new Set(withCopies.flatMap((i) => i.copies.map((c) => c.printerName)))] })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [files])
  const onPrinter = copies && copies.files > 0 ? copies : null
  return (
    <ConfirmModal title={t('library.deleteTitle', { n: files.length })} confirmLabel={t('common.delete')} onClose={onClose} onConfirm={() => onConfirm(!!onPrinter && alsoPrinter)}>
      <p>{files.length === 1 ? t('library.deleteOne', { name: files[0].name }) : t('library.deleteMany', { n: files.length })}</p>
      {onPrinter && (
        <div className="mt-3 space-y-2 rounded-lg border border-line bg-surface-2/50 p-2.5 text-sm">
          <p>{t('library.alsoOnPrinter', { n: onPrinter.files, printer: onPrinter.printers.join(', ') })}</p>
          <label className="flex items-center gap-2 font-medium">
            <input type="checkbox" className="size-4 accent-sky-500" checked={alsoPrinter} onChange={(e) => setAlsoPrinter(e.target.checked)} />
            {t('library.alsoDeleteFromPrinter')}
          </label>
        </div>
      )}
    </ConfirmModal>
  )
}

function subtitle(
  f: LibraryFile,
  bytes: (n: number) => string,
  num: (n: number, o?: Intl.NumberFormatOptions) => string,
  noSize = false,
): string {
  const parts: string[] = []
  if (!noSize) parts.push(bytes(f.size))
  if (f.kind === 'gcode' && f.meta.gcode) {
    if (f.meta.gcode.printSeconds) parts.push(formatDuration(f.meta.gcode.printSeconds))
    const g = f.meta.gcode.filamentGrams.reduce((a, b) => a + b, 0)
    if (g) parts.push(`${num(g, { maximumFractionDigits: 0 })} g`)
  } else if (f.kind === 'model' && f.meta.triangles) parts.push(`${num(f.meta.triangles, { notation: 'compact' })} △`)
  else if (f.kind === 'project' && f.meta.project) parts.push(`${f.meta.project.objects} obj · ${f.meta.project.plates} pl`)
  return parts.join(' · ')
}

function RenameModal({ file, onClose, onSave }: { file: LibraryFile; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const { t } = useI18n()
  const base = file.name.toLowerCase().endsWith(`.${file.ext}`) ? file.name.slice(0, -(file.ext.length + 1)) : file.name
  const [name, setName] = useState(base)
  const [busy, setBusy] = useState(false)
  const invalid = !name.trim() || /[/\\]/.test(name)
  const save = async () => {
    if (invalid) return
    setBusy(true)
    try {
      await onSave(`${name.trim()}.${file.ext}`)
      onClose()
    } catch {
      setBusy(false)
    }
  }
  return (
    <Modal
      size="sm"
      title={t('library.renameTitle')}
      icon={<Pencil size={18} />}
      onClose={onClose}
      dismissable={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={busy} disabled={invalid} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
        className="flex items-center gap-2"
      >
        <label htmlFor="rename-input" className="sr-only">
          {t('library.col.name')}
        </label>
        <input id="rename-input" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} aria-invalid={invalid} maxLength={200} />
        <span className="shrink-0 font-mono text-sm text-muted">.{file.ext}</span>
      </form>
      {invalid && name && <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{t('library.invalidName')}</p>}
    </Modal>
  )
}

