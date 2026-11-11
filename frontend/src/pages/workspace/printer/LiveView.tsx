// Live 3D view of the running print (Repetier-Host style). Loads the G-code the printer is running once
// per job, then maps `job.filePosition` (bytes) to a move index (byte offsets recorded by the worker).
// Older layers: normal colours. Current layer: a darker/lighter shade. The last ~20 mm before the nozzle:
// a high-contrast trail ending at the nozzle marker. Not printed yet: ghost (toggle). Between the ~1 s
// status ticks the nozzle advances along the move list at the moves' feedrates, so nothing jumps.
// Exclude object: every object of the job gets a clickable footprint (and a chip); excluded objects are
// drawn grey/hatched and their remaining moves are hidden. While the bed is occupied, the LAST job stays
// visible, fully printed, with its final values.
// Layout (Printer tab): the caller's status cards float top-left (`overlay`), the view cube + view toggles
// top-right, the objects chips and the (collapsible) legend bottom-left.
import { Ban, Box, ChevronDown, Crosshair, Eye, EyeOff, Highlighter, ListTree, LoaderCircle, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../../../api'
import Modal from '../../../components/Modal'
import { Button } from '../../../components/ui'
import { useTheme } from '../../../context/ThemeContext'
import { useToast } from '../../../context/ToastContext'
import { computeColors } from '../../../gcode/colors'
import { GcodeRenderer } from '../../../gcode/GcodeRenderer'
import { parseGcode } from '../../../gcode/parse'
import type { ParsedGcode } from '../../../gcode/types'
import { useStoredState } from '../../../hooks'
import { useI18n } from '../../../i18n/I18nContext'
import type { JobObject, PrinterStatus } from '../../../types'
import { useAccent } from '../../../theme/accent'
import ViewCube, { type ViewCubeHandle } from '../../../three/ViewCube'

const TRAIL_MM = 20
const TRAIL_MAX_MOVES = 80
/** How far (in seconds of motion) the animation may run ahead of the last reported position */
const LEAD_SEC = 1.3
const FRAME_MS = 40

let cache: { key: string; parsed: ParsedGcode } | null = null

/** Number of values in a sorted array that are < x (upper bound for offsets) */
function countBelow(arr: Uint32Array, x: number, n = arr.length) {
  let lo = 0
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Seconds of motion between two move indices (feedrate model) */
function motionSeconds(g: ParsedGcode, from: number, to: number) {
  let sec = 0
  for (let i = Math.max(0, Math.floor(from)); i < Math.min(g.count, Math.floor(to)); i++) {
    const k = i * 8
    sec += Math.hypot(g.seg[k + 3] - g.seg[k], g.seg[k + 4] - g.seg[k + 1]) / (g.speed[i] || 50)
  }
  return sec
}

/** Advances a fractional move index by `sec` of motion at each move's feedrate. */
function advance(g: ParsedGcode, from: number, sec: number, limit: number) {
  let p = from
  let left = sec
  while (left > 0 && p < limit) {
    const i = Math.floor(p)
    const k = i * 8
    const len = Math.hypot(g.seg[k + 3] - g.seg[k], g.seg[k + 4] - g.seg[k + 1]) || 0.01
    const v = g.speed[i] || 50
    const rest = (1 - (p - i)) * (len / v)
    if (rest > left) {
      p += (left * v) / len
      left = 0
    } else {
      left -= rest
      p = i + 1
    }
  }
  return Math.min(p, limit)
}

interface Props {
  printerId: number
  status: PrinterStatus
  /** May exclude objects of the running job (owner or admin, not read-only) */
  canExclude: boolean
  /** Floating status cards (top-left, over the 3D) */
  overlay?: ReactNode
}

export default function LiveView({ printerId, status, canExclude, overlay }: Props) {
  const { t, errorMessage } = useI18n()
  const { toast, onError } = useToast()
  const { resolved } = useTheme()
  const accent = useAccent()
  const liveJob = status.job ?? null
  const lastJob = !liveJob && status.bedClear === false ? (status.lastJob ?? null) : null
  const job = liveJob ?? lastJob
  const finished = !liveJob && !!lastJob
  const jobKey = job ? `${printerId}|${job.fileName}|${job.fileSize ?? ''}` : null
  const host = useRef<HTMLDivElement>(null)
  const renderer = useRef<GcodeRenderer | null>(null)
  const cube = useRef<ViewCubeHandle>(null)
  const [parsed, setParsed] = useState<{ key: string; parsed: ParsedGcode } | null>(null)
  const [loading, setLoading] = useState<{ key: string; progress: number; error?: unknown } | null>(null)
  const [thumb, setThumb] = useState<{ key: string; url: string } | null>(null)
  const [ghost, setGhost] = useStoredState('sd:live:ghost', true)
  const [follow, setFollow] = useStoredState('sd:live:follow', true)
  const [highlight, setHighlight] = useStoredState('sd:live:highlight', true)
  const [legendOpen, setLegendOpen] = useStoredState('sd:live:legend', true)
  const [hud, setHud] = useState<{ layer: number; layers: number } | null>(null)
  // Selected object, scoped to the job it was picked in
  const [pick, setPick] = useState<{ key: string | null; name: string } | null>(null)
  const [confirmObj, setConfirmObj] = useState<JobObject | null>(null)

  const selected = pick && pick.key === jobKey ? pick.name : null
  const setSelected = (name: string | null) => setPick(name ? { key: jobKey, name } : null)
  const g = parsed && parsed.key === jobKey ? parsed.parsed : cache && cache.key === jobKey ? cache.parsed : null
  const objects = useMemo(() => job?.objects ?? [], [job?.objects])
  const excludedCount = objects.filter((o) => o.excluded).length

  // Renderer
  useEffect(() => {
    if (!host.current) return
    const r = new GcodeRenderer(host.current)
    renderer.current = r
    r.onCamera = (view) => cube.current?.update(view)
    api.printerModels().then((m) => m[0]?.bed && r.setBed(m[0].bed), () => undefined)
    return () => {
      r.dispose()
      renderer.current = null
    }
  }, [])
  useEffect(() => renderer.current?.setTheme(resolved === 'dark'), [resolved])
  useEffect(() => renderer.current?.setAccent(accent), [accent])

  // Thumbnail while the G-code loads
  useEffect(() => {
    if (!jobKey) return
    let url: string | null = null
    let alive = true
    api.printerCurrentThumbnail(printerId).then(
      (blob) => {
        if (!alive) return
        url = URL.createObjectURL(blob)
        setThumb({ key: jobKey, url })
      },
      () => undefined,
    )
    return () => {
      alive = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [jobKey, printerId])

  // G-code of the running job (once per job; the finished job reuses it, or loads it with ?last=1)
  useEffect(() => {
    if (!jobKey || cache?.key === jobKey) return
    const ctrl = new AbortController()
    void (async () => {
      try {
        const blob = await api.printerCurrentGcode(printerId, {
          last: finished,
          signal: ctrl.signal,
          onProgress: (l, tot) => setLoading({ key: jobKey, progress: (tot ? l / tot : 0) * 0.5 }),
        })
        const p = await parseGcode(blob, (f) => setLoading({ key: jobKey, progress: 0.5 + f * 0.5 }), ctrl.signal)
        cache = { key: jobKey, parsed: p }
        setParsed(cache)
        setLoading(null)
      } catch (err) {
        if (ctrl.signal.aborted) return
        setLoading({ key: jobKey, progress: 0, error: err })
      }
    })()
    return () => ctrl.abort()
  }, [jobKey, printerId, finished])

  const colors = useMemo(() => (g ? computeColors(g, 'feature', g.meta.filamentColors).colors : null), [g])
  useEffect(() => {
    const r = renderer.current
    if (!r) return
    r.setData(g)
    if (g && colors) {
      r.setColors(colors)
      r.setPreset('iso')
    }
  }, [g, colors])

  // Reported position → move index; the animation runs between ticks
  // rate = seconds of motion per real second (1 on a real printer; learnt from the ticks)
  const anim = useRef({ p: 0, target: 0, cap: 0, synced: false, rate: 1, tickAt: 0 })
  const filePos = job?.filePosition ?? null
  const jobLayer = job?.layer ?? status.layer ?? null
  useEffect(() => {
    if (!g) return
    // A finished job is drawn as printed (to the end when it completed)
    const done = finished && lastJob?.result === 'done'
    const target = done
      ? g.count
      : filePos != null
        ? countBelow(g.offset, filePos, g.count)
        : jobLayer != null
          ? g.layerStart[Math.max(0, Math.min(g.layers, jobLayer - 1))]
          : 0
    const a = anim.current
    const now = performance.now()
    if (!finished && a.synced && target > a.target && a.tickAt) {
      const measured = motionSeconds(g, a.target, target) / Math.max(0.2, (now - a.tickAt) / 1000)
      a.rate = Math.min(60, Math.max(0.3, a.rate * 0.5 + measured * 0.5))
    }
    a.tickAt = now
    a.target = target
    a.cap = finished ? target : advance(g, target, LEAD_SEC * a.rate, g.count)
    // Resync when far off (job start, seek, reconnect, finished) — otherwise never go backwards
    if (finished || !a.synced || Math.abs(a.p - target) > 400) {
      a.p = target
      a.synced = true
    } else if (a.p < target) a.p = Math.max(a.p, target - 0.5)
  }, [g, filePos, jobLayer, finished, lastJob?.result])
  useEffect(() => {
    anim.current.synced = false
  }, [jobKey])

  // Objects of the job ↔ objects defined in the parsed G-code (by name, case-insensitive like Klipper)
  const objIndex = useMemo(() => {
    const m = new Map<string, number>()
    g?.objects.forEach((o, i) => m.set(o.name.toUpperCase(), i))
    return m
  }, [g])
  const selectedIdx = selected ? (objIndex.get(selected.toUpperCase()) ?? -1) : -1
  useEffect(() => {
    if (!g) return
    const from: number[] = new Array(64).fill(Infinity)
    for (const o of objects) {
      const i = objIndex.get(o.name.toUpperCase())
      if (i === undefined || i >= 64 || !o.excluded) continue
      // Moves before the exclusion were printed (grey); later ones are hidden. Unknown → from "now".
      from[i] = o.excludedAt != null ? countBelow(g.offset, o.excludedAt, g.count) : Math.floor(anim.current.target)
    }
    renderer.current?.setObjectState(from, selectedIdx)
  }, [g, objects, objIndex, selectedIdx])

  // Footprints at the current layer height (rebuilt when the layer or the selection changes)
  const layerZ = g && hud ? (g.layerZ[Math.max(0, hud.layer - 1)] ?? 0) : 0
  useEffect(() => {
    const r = renderer.current
    if (!r) return
    if (!g || objects.length === 0) return r.setObjectOutlines([], 0)
    r.setObjectOutlines(
      objects.map((o) => ({
        polygon: o.polygon.length >= 3 ? o.polygon : (g.objects[objIndex.get(o.name.toUpperCase()) ?? -1]?.polygon ?? []),
        excluded: o.excluded,
        selected: o.name === selected,
        current: o.current && !finished,
      })),
      layerZ,
    )
  }, [g, objects, objIndex, selected, layerZ, finished])

  // Click (not drag) on a footprint selects the object
  const down = useRef<{ x: number; y: number } | null>(null)
  const onPointerDown = (e: React.PointerEvent) => {
    down.current = { x: e.clientX, y: e.clientY }
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const d = down.current
    down.current = null
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || objects.length === 0) return
    const i = renderer.current?.pickObject(e.clientX, e.clientY) ?? -1
    setSelected(i >= 0 ? (objects[i]?.name ?? null) : null)
  }

  const moving = status.state === 'printing' && !finished
  const opts = useRef({ ghost, follow, highlight })
  useEffect(() => {
    opts.current = { ghost, follow, highlight }
  }, [ghost, follow, highlight])

  useEffect(() => {
    if (!g) return
    let raf = 0
    let last = performance.now()
    let lastDraw = 0
    let lastLayer = -1
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(0.25, (now - last) / 1000)
      last = now
      const a = anim.current
      if (moving) a.p = Math.min(a.cap, advance(g, a.p, dt * a.rate, a.cap))
      if (now - lastDraw < FRAME_MS) return
      lastDraw = now
      const i = Math.min(g.count - 1, Math.floor(a.p))
      const layer = Math.max(0, countBelow(g.layerStart, i + 1, g.layers + 1) - 1)
      // Trail: walk back ~20 mm
      let trail = i
      let mm = 0
      while (trail > 0 && mm < TRAIL_MM && i - trail < TRAIL_MAX_MOVES) {
        trail--
        const k = trail * 8
        mm += Math.hypot(g.seg[k + 3] - g.seg[k], g.seg[k + 4] - g.seg[k + 1])
      }
      const o = opts.current
      renderer.current?.setLive({
        printed: a.p,
        layerStart: finished ? 1e12 : g.layerStart[layer],
        trailStart: finished ? 1e12 : trail,
        end: o.ghost || finished ? g.count : g.layerStart[Math.min(g.layers, layer + 1)],
        highlight: o.highlight && !finished,
        hideMarker: finished,
      })
      if (o.follow && !finished) renderer.current?.followZ(g.layerZ[layer] ?? 0)
      if (layer !== lastLayer) {
        lastLayer = layer
        setHud({ layer: layer + 1, layers: g.layers })
      }
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [g, moving, finished])

  // The server answers only once Klipper reports the object in `excluded_objects` (else printers.exclude_unconfirmed):
  // until then the chip shows "Excluding…"; the excluded look comes from the confirmed status only.
  const [pendingEx, setPendingEx] = useState<ReadonlySet<string>>(() => new Set())
  async function exclude(o: JobObject) {
    setPendingEx((p) => new Set(p).add(o.name))
    setSelected(null)
    try {
      await api.excludeObject(printerId, o.name)
      toast('success', t('exclude.done', { name: o.label }))
    } catch (err) {
      onError(err)
    } finally {
      setPendingEx((p) => {
        const n = new Set(p)
        n.delete(o.name)
        return n
      })
    }
  }

  const load = loading && loading.key === jobKey ? loading : null
  const thumbUrl = thumb && thumb.key === jobKey ? thumb.url : null
  const dark = resolved === 'dark'
  const sel = objects.find((o) => o.name === selected) ?? null
  const remaining = objects.filter((o) => !o.excluded).length
  const excludable = canExclude && !finished && (status.state === 'printing' || status.state === 'paused')

  const legend = g && (
    <div className="pointer-events-auto rounded-xl border border-line bg-surface/90 text-xs shadow-lg shadow-black/5 backdrop-blur-md max-sm:hidden">
      <button
        type="button"
        aria-expanded={legendOpen}
        onClick={() => setLegendOpen(!legendOpen)}
        className="flex w-full items-center gap-1.5 rounded-xl px-2.5 py-1.5 font-medium text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-sky-500"
      >
        <ListTree size={14} />
        {t('printerTab.legend')}
        <ChevronDown size={14} className={`ml-auto transition-transform ${legendOpen ? 'rotate-180' : ''}`} />
      </button>
      {legendOpen && (
        <div className="w-48 px-2.5 pb-2">
          <LegendRow color="#FF7D38" label={t('printerTab.live.printed')} />
          {highlight && !finished && (
            <>
              <LegendRow color={dark ? '#ffb07e' : '#a94d1f'} label={t('printerTab.live.currentLayer')} />
              <LegendRow color={dark ? accent[100] : accent[900]} label={t('printerTab.live.trail')} ring />
            </>
          )}
          {ghost && !finished && <LegendRow color={dark ? '#3b4556' : '#cfd6df'} label={t('printerTab.live.upcoming')} />}
          {excludedCount > 0 && <LegendRow color={dark ? '#4b5563' : '#9aa3af'} label={t('exclude.legend')} hatch />}
          {!finished && <LegendRow color={dark ? accent[400] : accent[600]} label={t('printerTab.live.nozzle')} dot />}
        </div>
      )}
    </div>
  )

  return (
    <section className="relative h-full min-h-0 overflow-hidden rounded-2xl border border-line bg-surface-2 shadow-sm">
      <div className="absolute inset-0">
        <div ref={host} className="absolute inset-0" role="img" aria-label={t('printerTab.live.title')} onPointerDown={onPointerDown} onPointerUp={onPointerUp} />

        {/* Top-right: view cube (with Home) + view toggles */}
        <div className="absolute top-2 right-2 z-10 flex flex-col items-end gap-1.5">
          {/* Always mounted (idle, loading, finished, printing): the camera can always be orbited/panned/zoomed */}
          <div className="max-sm:hidden">
            <ViewCube ref={cube} camera={() => renderer.current} onHome={() => renderer.current?.setPreset('iso')} />
          </div>
          {g && !finished && (
            <div className="flex flex-col items-end gap-1">
              <ToggleChip on={highlight} onClick={() => setHighlight(!highlight)} icon={<Highlighter size={14} />} label={t('printerTab.live.highlight')} />
              <ToggleChip on={ghost} onClick={() => setGhost(!ghost)} icon={ghost ? <Eye size={14} /> : <EyeOff size={14} />} label={t('printerTab.live.ghost')} />
              <ToggleChip on={follow} onClick={() => setFollow(!follow)} icon={<Crosshair size={14} />} label={t('printerTab.live.follow')} />
            </div>
          )}
        </div>

        {/* Top-left: the caller's floating status cards */}
        {overlay && (
          <div className="pointer-events-none absolute top-2.5 left-2.5 z-10 flex max-w-[min(20rem,calc(100%-9rem))] flex-col items-start gap-2 sm:top-3 sm:left-3">{overlay}</div>
        )}

        {/* Bottom-left: objects (exclude object) + legend */}
        <div className="pointer-events-none absolute inset-x-3 bottom-3 z-10 flex flex-col items-start gap-2">
        {/* Objects (exclude object) */}
        {g && objects.length > 0 && (
          <div className="pointer-events-auto flex max-w-full flex-col items-start gap-2">
            {sel && (
              <div className="flex max-w-full flex-wrap items-center gap-2 rounded-xl border border-line bg-surface/95 p-2 pl-3 text-sm shadow-xl shadow-black/10 backdrop-blur-md">
                <span className="truncate font-medium">{sel.label}</span>
                {sel.excluded ? (
                  <span className="text-xs text-muted">{t('exclude.alreadyExcluded')}</span>
                ) : pendingEx.has(sel.name) ? (
                  <span className="inline-flex items-center gap-1 text-xs text-muted">
                    <LoaderCircle size={12} className="animate-spin" /> {t('exclude.pending')}
                  </span>
                ) : excludable ? (
                  remaining > 1 ? (
                    <Button variant="danger" size="xs" icon={<Ban size={14} />} onClick={() => setConfirmObj(sel)}>
                      {t('exclude.button', { name: sel.label })}
                    </Button>
                  ) : (
                    <span className="text-xs text-muted">{t('exclude.lastOne')}</span>
                  )
                ) : (
                  !finished && <span className="text-xs text-muted">{t('exclude.notAllowed')}</span>
                )}
                <button type="button" className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg" aria-label={t('common.close')} onClick={() => setSelected(null)}>
                  <X size={14} />
                </button>
              </div>
            )}
            <div className="flex max-w-full flex-wrap items-center gap-1.5 rounded-xl border border-line bg-surface/92 p-1.5 text-xs shadow-lg shadow-black/5 backdrop-blur-md">
              <span className="px-1.5 font-medium text-muted">
                {excludedCount > 0 ? t('exclude.countExcluded', { n: objects.length, x: excludedCount }) : t('exclude.count', { n: objects.length })}
              </span>
              {objects.map((o) => (
                <button
                  key={o.name}
                  type="button"
                  aria-pressed={o.name === selected}
                  onClick={() => setSelected(o.name === selected ? null : o.name)}
                  title={o.name}
                  className={`inline-flex h-6 items-center gap-1.5 rounded-full border px-2 font-medium transition-colors focus-visible:outline-2 focus-visible:outline-sky-500 ${
                    o.name === selected
                      ? 'border-sky-500/50 bg-sky-500/15 text-sky-700 dark:text-sky-300'
                      : o.excluded
                        ? 'border-line text-muted'
                        : 'border-line hover:text-fg'
                  }`}
                >
                  {o.current && !finished && !o.excluded && !pendingEx.has(o.name) && <span className="size-1.5 rounded-full bg-amber-500" aria-label={t('exclude.printingNow')} />}
                  {pendingEx.has(o.name) && !o.excluded && <LoaderCircle size={12} className="animate-spin" aria-label={t('exclude.pending')} />}
                  <span className={o.excluded ? 'line-through' : ''}>{o.label}</span>
                  {o.excluded && <span className="rounded-full bg-surface-2 px-1.5 text-[10px] no-underline">{t('exclude.alreadyExcluded')}</span>}
                  {pendingEx.has(o.name) && !o.excluded && <span className="text-[10px] text-muted">{t('exclude.pending')}</span>}
                </button>
              ))}
            </div>
          </div>
        )}
        {legend}
        </div>

        {!job && (
          <div className="pointer-events-none absolute inset-x-0 bottom-6 flex flex-col items-center gap-1.5 px-4 text-center">
            <span className="flex size-10 items-center justify-center rounded-2xl bg-surface/90 text-muted shadow-xs">
              <Box size={22} />
            </span>
            <p className="text-sm font-medium">{t('printerTab.live.idle')}</p>
            <p className="max-w-72 text-xs text-muted">{t('printerTab.live.idleDesc')}</p>
          </div>
        )}

        {job && !g && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
            <div role="status" className="pointer-events-auto flex w-80 flex-col items-center rounded-2xl border border-line bg-surface p-5 text-center shadow-xl">
              {thumbUrl ? (
                <img src={thumbUrl} alt="" className="size-28 rounded-xl border border-line object-cover" />
              ) : (
                <LoaderCircle className="animate-spin text-sky-500" aria-hidden />
              )}
              <p className="mt-3 truncate text-sm font-medium" title={job.fileName}>
                {job.fileName.split('/').pop()}
              </p>
              {load?.error ? (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                  {t('printerTab.live.loadFailed')} {errorMessage(load.error)}
                </p>
              ) : (
                <>
                  <p className="mt-1 text-xs text-muted">{t('printerTab.live.loading')}</p>
                  <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                    <div className="h-full rounded-full bg-sky-500 transition-[width] duration-200" style={{ width: `${Math.round((load?.progress ?? 0) * 100)}%` }} />
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
      {confirmObj && <ConfirmExclude obj={confirmObj} onClose={() => setConfirmObj(null)} onConfirm={async () => void exclude(confirmObj)} />}
    </section>
  )
}

function ConfirmExclude({ obj, onClose, onConfirm }: { obj: JobObject; onClose: () => void; onConfirm: () => Promise<void> }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    try {
      await onConfirm()
      onClose()
    } catch {
      setBusy(false)
    }
  }
  return (
    <Modal
      size="sm"
      title={t('exclude.confirmTitle', { name: obj.label })}
      icon={<Ban size={18} className="text-red-500" />}
      onClose={onClose}
      dismissable={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy} data-autofocus>
            {t('exclude.keep')}
          </Button>
          <Button variant="danger" loading={busy} icon={<Ban size={14} />} onClick={() => void go()}>
            {t('exclude.button', { name: obj.label })}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed">{t('exclude.confirmDesc', { name: obj.label })}</p>
    </Modal>
  )
}

function ToggleChip({ on, onClick, icon, label }: { on: boolean; onClick: () => void; icon: ReactNode; label: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium backdrop-blur-md transition-colors max-sm:size-8 max-sm:justify-center max-sm:px-0 focus-visible:outline-2 focus-visible:outline-sky-500 ${
        on ? 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300' : 'border-line bg-surface/80 text-muted hover:text-fg'
      }`}
    >
      {icon}
      {/* Phones: icon-only chips stacked under each other, so they never slide under the status card */}
      <span className="max-sm:sr-only">{label}</span>
    </button>
  )
}

function LegendRow({ color, label, ring, dot, hatch }: { color: string; label: string; ring?: boolean; dot?: boolean; hatch?: boolean }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span
        className={`shrink-0 ${dot ? 'size-2.5 rounded-full' : 'h-2.5 w-4 rounded-[3px]'} ${ring ? 'ring-2 ring-sky-500/30' : 'ring-1 ring-black/10'}`}
        style={{ background: hatch ? `repeating-linear-gradient(135deg, ${color} 0 3px, transparent 3px 5px)` : color }}
      />
      <span className="truncate">{label}</span>
    </div>
  )
}
