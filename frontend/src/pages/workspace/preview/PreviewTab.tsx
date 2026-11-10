// Preview tab: G-code viewer (worker parser + instanced three.js renderer), legend with colour modes
// and per-feature toggles, vertical layer range slider, move slider with playback, slicing summary,
// usage vs limits, Print (with approvals / bed-occupied flow) and Download.
// The file comes from the `fileId` prop or `?file=<id>` (F1's Slice → Preview hands it over that way); it then becomes
// the user's "current preview file" (workspace/previewFile.ts), which survives tab switches and reloads until the user
// prints it, opens/slices another one, or closes it.
import { ArrowRight, Box, Download, FileCode2, FolderOpen, Layers, LoaderCircle, RotateCcw, Scale, Timer, UploadCloud, Wallet, X } from 'lucide-react'
import { PrinterLayers, PrinterModelIcon } from '../../../components/printerIcons'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { api, ApiError } from '../../../api'
import { Badge, Button, Callout, Empty, ErrorState, IconButton } from '../../../components/ui'
import { useAuth } from '../../../context/AuthContext'
import { useTheme } from '../../../context/ThemeContext'
import { useToast } from '../../../context/ToastContext'
import { computeColors, type ColorMode } from '../../../gcode/colors'
import { formatDuration, totalGrams } from '../../../gcode/format'
import { GcodeRenderer } from '../../../gcode/GcodeRenderer'
import { parseGcode } from '../../../gcode/parse'
import { FEATURES, type ParsedGcode } from '../../../gcode/types'
import { useLoader, useStoredState } from '../../../hooks'
import { usePrinterStatus } from '../../../realtime'
import { useI18n } from '../../../i18n/I18nContext'
import { useReadOnly } from '../../../readOnly'
import ReadOnlyHint from '../../../components/ReadOnlyHint'
import type { LibraryFile, UsageSummary } from '../../../types'
import { formatBytes } from '../../../validation'
import { findLibraryFile } from '../../files/lookup'
import { extOf } from '../../files/uploads/accept'
import { useUploads } from '../../files/uploads/UploadContext'
import LayerSlider from './LayerSlider'
import Legend from './Legend'
import MoveBar from './MoveBar'
import PrintDialog, { UsageBlock } from './PrintDialog'
import { useAccent } from '../../../theme/accent'
import ViewCube, { type ViewCubeHandle } from '../../../three/ViewCube'
import { previewFile, usePreviewFile } from '../../../workspace/previewFile'

// The last parsed file survives tab switches (re-parsing 50 MB is not free)
let cache: { key: string; blob: Blob; parsed: ParsedGcode } | null = null
/** Deleted files we already told the user about (one toast per id) */
const goneToasted = new Set<number>()
const NOT_FOUND = Symbol('preview.not_found')

type Load = { phase: 'idle' } | { phase: 'download' | 'parse'; progress: number } | { phase: 'error'; error: unknown } | { phase: 'ready' }
/** Everything loaded for one file id: results for another (stale) id are never shown */
type Loaded = { id: number; load: Load; file: LibraryFile | null; parsed: ParsedGcode | null; blob: Blob | null }

const ALL_FEATURES = (1 << FEATURES.length) - 1

export default function PreviewTab({ fileId: fileIdProp }: { fileId?: number | null } = {}) {
  const { t, formatNumber, formatDate } = useI18n()
  const { user } = useAuth()
  const { resolved } = useTheme()
  const { onError, toast } = useToast()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const paramId = fileIdProp ?? (Number(params.get('file')) || null)
  const storedId = usePreviewFile(user?.id ?? null)
  // An explicit file (link, slice result, picker) becomes the current preview file
  useEffect(() => {
    if (paramId) previewFile.set(paramId)
  }, [paramId])
  const fileId = paramId ?? storedId
  const readOnly = useReadOnly()

  const host = useRef<HTMLDivElement>(null)
  const renderer = useRef<GcodeRenderer | null>(null)
  const cube = useRef<ViewCubeHandle>(null)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [mode, setMode] = useStoredState<ColorMode>('sd:preview:mode', 'feature')
  const [mask, setMask] = useState(ALL_FEATURES)
  const [showTravel, setShowTravel] = useStoredState('sd:preview:travel', false)
  const [lo, setLo] = useState(0)
  const [hi, setHi] = useState(0)
  const [move, setMove] = useState(Number.POSITIVE_INFINITY)
  const [playing, setPlaying] = useState(false)
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [printOpen, setPrintOpen] = useState(false)
  const [line, setLine] = useState<{ idx: number; text: string } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  // Only what was loaded for THIS id counts (nothing selected → idle; a new id → loading until its own result)
  const mine = fileId && loaded?.id === fileId ? loaded : null
  const file = mine?.file ?? null
  const parsed = mine?.parsed ?? null
  const blob = mine?.blob ?? null
  const load: Load = !fileId ? { phase: 'idle' } : (mine?.load ?? { phase: 'download', progress: 0 })

  // ---- renderer lifecycle
  useEffect(() => {
    if (!host.current) return
    const r = new GcodeRenderer(host.current)
    renderer.current = r
    r.onCamera = (view) => cube.current?.update(view)
    api.printerModels().then(
      (models) => {
        const bed = models[0]?.bed
        if (bed) r.setBed(bed)
      },
      () => undefined,
    )
    return () => {
      r.dispose()
      renderer.current = null
    }
  }, [])

  useEffect(() => {
    renderer.current?.setTheme(resolved === 'dark')
  }, [resolved])
  const accent = useAccent()
  useEffect(() => {
    renderer.current?.setAccent(accent)
  }, [accent])

  useEffect(() => {
    api.usage().then(setUsage, () => undefined)
  }, [])

  // ---- load + parse
  const uid = user?.id ?? null
  const isAdmin = user?.role === 'admin'

  /** Closes the current G-code (back to the picker) and drops `?file=` */
  const closeFile = useCallback(() => {
    previewFile.set(null)
    setParams(
      (p) => {
        if (!p.has('file')) return p
        const n = new URLSearchParams(p)
        n.delete('file')
        return n
      },
      { replace: true },
    )
  }, [setParams])

  // A deleted (or no longer visible) file is forgotten quietly: at most one toast per id, never an error overlay
  const onGone = useRef<(id: number) => void>(() => undefined)
  useEffect(() => {
    onGone.current = (id) => {
      if (!goneToasted.has(id)) {
        goneToasted.add(id)
        toast('info', t('preview.currentGone'))
      }
      previewFile.forget([id])
      if (Number(params.get('file')) === id) closeFile()
    }
  }, [closeFile, toast, t, params])

  useEffect(() => {
    if (!fileId || uid === null) return
    const id = fileId
    const ctrl = new AbortController()
    // Every update is tagged with its id and dropped once this effect is gone (out-of-order responses)
    const put = (patch: Partial<Loaded>) => {
      if (ctrl.signal.aborted) return
      setLoaded((cur) => ({ ...(cur?.id === id ? cur : { id, file: null, parsed: null, blob: null, load: { phase: 'download', progress: 0 } }), ...patch, id }))
    }
    void (async () => {
      try {
        put({ load: { phase: 'download', progress: 0 } })
        const f = await findLibraryFile(id, isAdmin)
        if (ctrl.signal.aborted) return
        if (!f) throw NOT_FOUND
        put({ file: f })
        const key = `${f.id}:${f.updatedAt}:${f.size}`
        let entry = cache?.key === key ? cache : null
        if (!entry) {
          const b = await api.fileContent(f.id, { signal: ctrl.signal, onProgress: (l, tot) => put({ load: { phase: 'download', progress: (tot || f.size) ? l / (tot || f.size) : 0 } }) })
          put({ load: { phase: 'parse', progress: 0 } })
          const p = await parseGcode(b, (fr) => put({ load: { phase: 'parse', progress: fr } }), ctrl.signal)
          entry = { key, blob: b, parsed: p }
          cache = entry
        }
        if (ctrl.signal.aborted) return
        setLo(0)
        setHi(Math.max(0, entry.parsed.layers - 1))
        setMove(Number.POSITIVE_INFINITY)
        put({ blob: entry.blob, parsed: entry.parsed, load: { phase: 'ready' } })
      } catch (err) {
        if (ctrl.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return
        if (err === NOT_FOUND || (err instanceof ApiError && err.status === 404)) return onGone.current(id)
        put({ load: { phase: 'error', error: err } })
      }
    })()
    return () => ctrl.abort()
  }, [fileId, uid, isAdmin, reloadKey])

  // ---- push data into the renderer
  useEffect(() => {
    const r = renderer.current
    if (!r) return
    r.setData(parsed)
    if (parsed) r.setPreset('iso')
  }, [parsed])

  const filamentColors = useMemo(() => parsed?.meta.filamentColors ?? [], [parsed])
  const colorResult = useMemo(() => (parsed ? computeColors(parsed, mode, filamentColors) : null), [parsed, mode, filamentColors])
  useEffect(() => {
    if (colorResult) renderer.current?.setColors(colorResult.colors)
  }, [colorResult])
  useEffect(() => renderer.current?.setFeatureMask(mask), [mask])
  useEffect(() => renderer.current?.setShowTravel(showTravel), [showTravel])
  useEffect(() => renderer.current?.setRange(lo, hi, move), [lo, hi, move, parsed])

  const layerMoves = parsed ? parsed.layerStart[hi + 1] - parsed.layerStart[hi] : 0
  const shownMoves = Math.min(move, layerMoves)

  // ---- playback through moves, then layers (start position read from refs)
  const playFrom = useRef({ hi: 0, move: 0, layerMoves: 0 })
  useEffect(() => {
    playFrom.current = { hi, move, layerMoves }
  }, [hi, move, layerMoves])
  useEffect(() => {
    if (!playing || !parsed) return
    let raf = 0
    let last = performance.now()
    const from = playFrom.current
    let curHi = from.hi
    let cur = Number.isFinite(from.move) && from.move < from.layerMoves ? from.move : 0
    const step = (now: number) => {
      const dt = now - last
      last = now
      const total = parsed.layerStart[curHi + 1] - parsed.layerStart[curHi]
      cur += Math.max(1, total / 2600) * dt // ~2.6 s per layer
      if (cur >= total) {
        if (curHi >= parsed.layers - 1) {
          setMove(Number.POSITIVE_INFINITY)
          setPlaying(false)
          return
        }
        curHi++
        cur = 0
        setHi(curHi)
      }
      setMove(Math.floor(cur))
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing, parsed])

  // ---- current move details + its G-code line
  const curIndex = parsed && layerMoves ? parsed.layerStart[hi] + Math.max(0, Math.min(shownMoves, layerMoves) - 1) : -1
  const lineText = line && line.idx === curIndex ? line.text : ''
  useEffect(() => {
    if (!parsed || !blob || curIndex < 0 || !Number.isFinite(move)) return
    let alive = true
    const off = parsed.offset[curIndex]
    void blob
      .slice(off, off + 160)
      .text()
      .then((s) => alive && setLine({ idx: curIndex, text: s.split('\n')[0].trim() }))
    return () => {
      alive = false
    }
  }, [parsed, blob, curIndex, move])

  // ---- keyboard: ↑/↓ layers, ←/→ moves (when focus is not in a control)
  const setRange = useCallback((nlo: number, nhi: number) => {
    setLo(nlo)
    setHi(nhi)
    setMove(Number.POSITIVE_INFINITY)
  }, [])
  useEffect(() => {
    if (!parsed) return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.closest('input,select,textarea,[role=slider],[role=dialog]')) return
      const max = parsed.layers - 1
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const n = Math.max(0, Math.min(max, hi + (e.key === 'ArrowUp' ? 1 : -1)))
        setRange(Math.min(lo, n), n)
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const base = Number.isFinite(move) ? move : layerMoves
        setMove(Math.max(0, Math.min(layerMoves, base + (e.key === 'ArrowRight' ? 1 : -1))))
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [parsed, hi, lo, move, layerMoves, setRange])

  // ---- summary values
  const meta = parsed?.meta
  const gs = file?.meta.gcode
  const seconds = meta?.estimatedSeconds ?? gs?.printSeconds ?? (parsed ? Math.round(parsed.modelSeconds) : null)
  const gramsPerSlot = meta?.filamentGrams.length ? meta.filamentGrams : (gs?.filamentGrams ?? [])
  const mmPerSlot = meta?.filamentMm.length ? meta.filamentMm : gs?.filamentMm?.length ? gs.filamentMm : parsed ? Array.from(parsed.toolMm).filter((v) => v > 0) : []
  const grams = totalGrams(gramsPerSlot, mmPerSlot)
  const cost = usage?.costPerKg != null && grams != null ? (grams / 1000) * usage.costPerKg : null
  const money = (v: number) => formatNumber(v, { style: 'currency', currency: usage?.currency || 'USD' })

  // ---- drop a .gcode anywhere on the tab: upload to the library, then open it
  const uploads = useUploads()
  const [dragging, setDragging] = useState(false)
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const files = Array.from(e.dataTransfer.files).filter((f) => extOf(f.name) === 'gcode')
    if (!files.length) return
    const [item] = uploads.add(files.slice(0, 1))
    uploads.waitFor(item.id).then(
      (f) => setParams((p) => {
        const n = new URLSearchParams(p)
        n.set('tab', 'preview')
        n.set('file', String(f.id))
        return n
      }),
      (err: unknown) => onError(err),
    )
  }

  const openFile = (id: number) =>
    setParams((p) => {
      const n = new URLSearchParams(p)
      n.set('tab', 'preview')
      n.set('file', String(id))
      return n
    })

  const loading = load.phase === 'download' || load.phase === 'parse'

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false)
      }}
      onDrop={onDrop}
    >
      {/* Viewport */}
      <div className="relative min-h-[420px] min-w-0 flex-1 overflow-hidden bg-surface-2">
        <div ref={host} className="absolute inset-0" aria-label={t('preview.viewport')} role="img" />

        {parsed && load.phase === 'ready' && (
          <>
            <div className="absolute top-3 left-3">
              <Legend
                g={parsed}
                mode={mode}
                onMode={setMode}
                mask={mask}
                onMask={setMask}
                showTravel={showTravel}
                onShowTravel={setShowTravel}
                range={colorResult?.range}
                filamentColors={filamentColors}
              />
            </div>
            <div className="absolute top-2 right-[4.5rem] max-sm:hidden">
              <ViewCube ref={cube} camera={() => renderer.current} onHome={() => renderer.current?.setPreset('iso')} />
            </div>
            <div className="absolute top-3 right-3 bottom-24">
              <LayerSlider layers={parsed.layers} lo={lo} hi={hi} zOf={(l) => parsed.layerZ[l] ?? 0} onChange={setRange} />
            </div>
            <div className="pointer-events-none absolute inset-x-3 bottom-3 flex justify-center pr-16">
              <MoveBar
                total={layerMoves}
                value={shownMoves}
                onChange={(v) => {
                  setPlaying(false)
                  setMove(v >= layerMoves ? Number.POSITIVE_INFINITY : v)
                }}
                playing={playing}
                onTogglePlay={() => setPlaying((p) => !p)}
              >
                {Number.isFinite(move) && curIndex >= 0 && (
                  <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line pb-1.5 text-[11px] text-muted">
                    <Badge tone="sky">{t(`preview.feature.${FEATURES[parsed.type[curIndex]]}`)}</Badge>
                    <span className="font-mono tabular-nums">
                      X {parsed.seg[curIndex * 8 + 3].toFixed(2)} Y {parsed.seg[curIndex * 8 + 4].toFixed(2)} Z {parsed.seg[curIndex * 8 + 5].toFixed(2)}
                    </span>
                    <span className="font-mono tabular-nums">{Math.round(parsed.speed[curIndex])} mm/s</span>
                    <span className="font-mono tabular-nums">
                      {parsed.seg[curIndex * 8 + 6].toFixed(2)}×{parsed.seg[curIndex * 8 + 7].toFixed(2)} mm
                    </span>
                    <span className="font-mono tabular-nums">
                      {t('preview.fan')} {Math.round((parsed.fan[curIndex] / 255) * 100)}%
                    </span>
                    <span className="font-mono tabular-nums">{parsed.temp[curIndex]} °C</span>
                    {lineText && <code className="w-full truncate rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-fg/80">{lineText}</code>}
                  </div>
                )}
              </MoveBar>
            </div>
          </>
        )}

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-surface-2/70 backdrop-blur-[2px]">
            <div role="status" className="w-72 rounded-2xl border border-line bg-surface p-5 text-center shadow-xl">
              <LoaderCircle className="mx-auto animate-spin text-sky-500" aria-hidden />
              <p className="mt-3 text-sm font-medium">{t(load.phase === 'download' ? 'preview.downloading' : 'preview.parsing')}</p>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full rounded-full bg-sky-500 transition-[width] duration-200" style={{ width: `${Math.round(load.progress * 100)}%` }} />
              </div>
              <p className="mt-1.5 font-mono text-xs text-muted tabular-nums">{Math.round(load.progress * 100)}%</p>
            </div>
          </div>
        )}

        {load.phase === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <div className="max-w-sm rounded-2xl border border-line bg-surface shadow-xl">
              <ErrorState error={load.error} onRetry={() => setReloadKey((k) => k + 1)} />
            </div>
          </div>
        )}

        {load.phase === 'idle' && !dragging && (
          <p className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-1.5 rounded-lg border border-line bg-surface/85 px-2.5 py-1.5 text-xs text-muted shadow-sm backdrop-blur">
            <UploadCloud size={13} />
            {t('preview.dropHint')}
          </p>
        )}

        {parsed && load.phase === 'ready' && parsed.count === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Callout tone="warning">{t('preview.noExtrusion')}</Callout>
          </div>
        )}

        {dragging && (
          <div className="pointer-events-none absolute inset-3 flex items-center justify-center rounded-2xl border-2 border-dashed border-sky-500 bg-sky-500/10 text-sm font-medium text-sky-700 backdrop-blur-[1px] dark:text-sky-300">
            <UploadCloud size={20} className="mr-2" />
            {t('preview.dropGcode')}
          </div>
        )}
      </div>

      {/* Summary / actions */}
      <aside className="flex w-full shrink-0 flex-col border-t border-line bg-surface lg:h-full lg:min-h-0 lg:w-80 lg:border-t-0 lg:border-l xl:w-88">
        {/* body scrolls; the Print/Download footer always stays visible */}
        <div className="space-y-4 p-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          {fileId && !file ? (
            <div className="flex items-center gap-3" aria-busy="true">
              <span className="size-14 shrink-0 animate-pulse rounded-xl bg-surface-2" />
              <div className="min-w-0 flex-1 space-y-2">
                <span className="block h-3.5 w-3/4 animate-pulse rounded bg-surface-2" />
                <span className="block h-3 w-1/2 animate-pulse rounded bg-surface-2" />
              </div>
              <IconButton label={t('preview.close')} onClick={closeFile}>
                <X size={16} />
              </IconButton>
            </div>
          ) : file ? (
            <div className="flex items-center gap-3">
              {file.thumbnailUrl ? (
                <img src={file.thumbnailUrl} alt="" className="size-14 shrink-0 rounded-xl border border-line object-cover" />
              ) : (
                <span className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-sky-500/10 text-sky-500">
                  <FileCode2 size={22} />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold" title={file.name}>
                  {file.name}
                </p>
                <p className="text-xs text-muted">
                  {formatBytes(file.size)} · {formatDate(file.createdAt)}
                </p>
                {meta?.slicer && <p className="truncate text-[11px] text-muted">{meta.slicer}</p>}
              </div>
              <IconButton label={t('preview.close')} onClick={closeFile}>
                <X size={16} />
              </IconButton>
            </div>
          ) : (
            <PickGcode onOpen={openFile} />
          )}

          {parsed && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <Tile icon={<Timer size={15} />} label={t('preview.stat.time')} value={formatDuration(seconds)} tone="text-sky-500" />
                <Tile icon={<Layers size={15} />} label={t('preview.stat.layers')} value={formatNumber(parsed.layers)} tone="text-violet-500" />
                <Tile icon={<Scale size={15} />} label={t('preview.stat.filament')} value={grams != null ? `${formatNumber(grams, { maximumFractionDigits: 1 })} g` : '—'} tone="text-emerald-500" />
                <Tile icon={<Wallet size={15} />} label={t('preview.stat.cost')} value={cost != null ? money(cost) : '—'} tone="text-amber-500" hint={cost == null ? t('preview.costUnknown') : undefined} />
              </div>

              <div>
                <h3 className="mb-1.5 text-xs font-medium text-muted">{t('preview.filaments')}</h3>
                <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                  {(mmPerSlot.length ? mmPerSlot : [0]).map((mm, i) => (
                    <li key={i} className="flex items-center gap-2.5 px-3 py-2 text-sm">
                      <span className="size-4 shrink-0 rounded-md ring-1 ring-black/10" style={{ background: filamentColors[i] ?? '#94a3b8' }} />
                      <span className="min-w-0 flex-1 truncate">
                        {t('preview.slot', { n: i + 1 })}
                        {meta?.filamentTypes[i] && <span className="text-muted"> · {meta.filamentTypes[i]}</span>}
                      </span>
                      <span className="font-mono text-xs text-muted tabular-nums">{formatNumber(mm / 1000, { maximumFractionDigits: 2 })} m</span>
                      <span className="w-16 text-right font-mono text-xs tabular-nums">
                        {gramsPerSlot[i] != null ? `${formatNumber(gramsPerSlot[i], { maximumFractionDigits: 1 })} g` : '—'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              {usage?.limits.enabled && <UsageBlock usage={usage} grams={grams} seconds={seconds} />}

              <details className="group rounded-xl border border-line px-3 py-2 text-xs text-muted">
                <summary className="cursor-pointer font-medium text-fg/80 select-none">{t('preview.details')}</summary>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                  <dt>{t('preview.printerModel')}</dt>
                  <dd className="truncate text-right text-fg">{meta?.printerModel ?? '—'}</dd>
                  <dt>{t('preview.layerHeight')}</dt>
                  <dd className="text-right font-mono text-fg">{meta?.layerHeight ?? '—'}</dd>
                  <dt>{t('preview.size')}</dt>
                  <dd className="text-right font-mono text-fg">
                    {(parsed.bbox[3] - parsed.bbox[0]).toFixed(1)}×{(parsed.bbox[4] - parsed.bbox[1]).toFixed(1)}×{parsed.bbox[5].toFixed(1)}
                  </dd>
                  <dt>{t('preview.segments')}</dt>
                  <dd className="text-right font-mono text-fg">{formatNumber(parsed.count)}</dd>
                  <dt>{t('preview.lines')}</dt>
                  <dd className="text-right font-mono text-fg">{formatNumber(parsed.lines)}</dd>
                  <dt>{t('preview.parseTime')}</dt>
                  <dd className="text-right font-mono text-fg">{formatNumber(parsed.parseMs)} ms</dd>
                </dl>
              </details>
            </>
          )}
        </div>

        <div className="sticky bottom-0 z-10 shrink-0 space-y-2 border-t border-line bg-surface p-4 pb-[calc(1rem+var(--sd-tray-h,0px))] transition-[padding] duration-200">
          <ReadOnlyHint className="flex w-full">
          <Button variant="primary" size="md" className="w-full" icon={<PrinterLayers size={16} />} disabled={!file || !parsed || readOnly} onClick={() => setPrintOpen(true)}>
            {t(usage?.limits.enabled && usage.limits.requiresApproval ? 'prints.requestApproval' : 'preview.print')}
          </Button>
          </ReadOnlyHint>
          <div className="flex gap-2">
            <Button className="flex-1" icon={<Download size={14} />} disabled={!file} onClick={() => file && void api.downloadFile(file).catch(onError)}>
              {t('preview.download')}
            </Button>
            <IconButton label={t('preview.openFiles')} onClick={() => navigate('/files')}>
              <FolderOpen size={16} />
            </IconButton>
            {parsed && (
              <IconButton label={t('preview.resetView')} onClick={() => {
                setRange(0, parsed.layers - 1)
                setMask(ALL_FEATURES)
                renderer.current?.setPreset('iso')
              }}>
                <RotateCcw size={16} />
              </IconButton>
            )}
          </div>
        </div>
      </aside>

      {printOpen && file && (
        <PrintDialog
          target={{ fileId: file.id, fileName: file.name, grams, seconds }}
          usage={usage}
          onClose={() => setPrintOpen(false)}
          onDone={(job) => {
            api.usage().then(setUsage, () => undefined)
            // Printed (or sent for approval): it is no longer the "current" G-code
            if (job.state !== 'failed' && job.state !== 'rejected') previewFile.forget([file.id])
            setParams((p) => {
              const n = new URLSearchParams(p)
              n.delete('file')
              if (job.state === 'printing') n.set('tab', 'printer')
              return n
            })
          }}
        />
      )}
    </div>
  )
}

function Tile({ icon, label, value, tone, hint }: { icon: ReactNode; label: string; value: string; tone: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2/40 px-3 py-2.5" title={hint}>
      <div className={`flex items-center gap-1.5 text-[11px] font-medium ${tone}`}>
        {icon}
        <span className="text-muted">{label}</span>
      </div>
      <div className="mt-0.5 truncate text-base font-semibold tabular-nums">{value}</div>
    </div>
  )
}

/** Shown when no G-code is selected: recent G-code files from the library. */
function PickGcode({ onOpen }: { onOpen: (id: number) => void }) {
  const { t, formatDate } = useI18n()
  const [files, setFiles] = useState<LibraryFile[] | null>(null)
  const { data: printers } = useLoader(api.printers)
  const printer = printers?.[0] ?? null
  const status = usePrinterStatus(printer?.id ?? null)
  const busy = status?.online && (status.state === 'printing' || status.state === 'paused' || status.state === 'pausing' || status.state === 'resuming')
  const jobName = (status?.job?.fileName ?? status?.fileName ?? '').split('/').pop() ?? ''
  useEffect(() => {
    Promise.all([api.files('private', 'gcode'), api.files('shared', 'gcode')]).then(
      ([mine, shared]) => {
        const seen = new Set<number>()
        setFiles([...mine, ...shared].filter((f) => !seen.has(f.id) && seen.add(f.id)).slice(0, 8))
      },
      () => setFiles([]),
    )
  }, [])
  return (
    <div className="space-y-3">
      {busy && (
        <Link
          to="/?tab=printer"
          className="group flex items-center gap-3 rounded-2xl border border-accent-500/30 bg-accent-500/[0.06] p-4 shadow-lg shadow-black/5 transition-colors hover:border-accent-500/60 hover:bg-accent-500/10"
        >
          <span className="relative flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-500 text-white shadow-sm shadow-accent-500/30">
            <PrinterModelIcon size={19} kinematics={printer?.kinematics} model={printer?.model} />
            {status?.state === 'printing' && <span className="absolute -top-0.5 -right-0.5 size-2.5 animate-pulse rounded-full border-2 border-surface bg-emerald-500" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">{t(status?.state === 'printing' || status?.state === 'resuming' ? 'preview.busyPrinting' : 'preview.busyPaused', { printer: printer?.name ?? 'K2 SE' })}</span>
            <span className="block truncate font-mono text-xs text-muted" title={jobName}>
              {jobName || '—'}
              {status?.progress != null && ` · ${Math.round(status.progress)}%`}
            </span>
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-accent-600 group-hover:gap-1.5 dark:text-accent-300">
            {t('preview.watchLive')}
            <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" />
          </span>
        </Link>
      )}
      <div className="w-full">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-sky-500/10 text-sky-500">
            <Box size={20} />
          </span>
          <div>
            <h2 className="font-semibold">{t('preview.pickTitle')}</h2>
            <p className="text-xs text-muted">{t('preview.pickDesc')}</p>
          </div>
        </div>
        {files === null ? (
          <div className="flex justify-center py-8 text-muted">
            <LoaderCircle className="animate-spin" />
          </div>
        ) : files.length === 0 ? (
          <Empty icon={<FileCode2 size={20} />}>{t('preview.noGcode')}</Empty>
        ) : (
          <ul className="mt-4 divide-y divide-line overflow-hidden rounded-xl border border-line">
            {files.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  onClick={() => onOpen(f.id)}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
                >
                  {f.thumbnailUrl ? <img src={f.thumbnailUrl} alt="" className="size-9 rounded-lg border border-line object-cover" /> : <FileCode2 size={18} className="text-muted" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{f.name}</span>
                    <span className="block text-xs text-muted">
                      {formatDuration(f.meta.gcode?.printSeconds)} · {formatDate(f.createdAt)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
