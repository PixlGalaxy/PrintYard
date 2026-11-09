// Dev-only mock for the Phase 2 F2 endpoints: files library (+ retention), printing & approvals,
// usage, live printer simulator, engine manager, and the realtime bus used by the fake WebSocket.
// F1's mock routes can reuse `mockFiles.add()` (e.g. slicing results / projects) and `mockPublish()`.
import { ApiError, type TransferOptions } from '../api'
import type {
  CfsSlot,
  EngineInfo,
  FileKind,
  GcodeScan,
  GcodeScanFinding,
  JobObject,
  LastJob,
  LibraryFile,
  PrintJob,
  PrinterState,
  PrinterStatus,
  ServerMessage,
  TempSample,
  UsageSummary,
} from '../types'
import { mockCore } from './mock'
import { generateSampleGcode, sampleStl, STRESS_OPTIONS, TWO_OBJECT_OPTIONS, type SampleOptions } from './sampleGcode'

export const NOT_HANDLED = Symbol('not-handled')

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const now = () => Date.now()
/** Simulated printer seconds per real second (a 1 h print takes 2 min) */
const SPEEDUP = 20

// ---------- realtime bus ----------

type Audience = 'all' | 'admins' | { userId: number; admins?: boolean }
type BusListener = (msg: ServerMessage, audience: Audience) => void
const busListeners = new Set<BusListener>()

export const mockBus = {
  on(cb: BusListener) {
    busListeners.add(cb)
    return () => void busListeners.delete(cb)
  },
}

/** Publish a server → client WS message to the fake sockets (filtered per session user on delivery). */
export function mockPublish(msg: ServerMessage, audience: Audience = 'all') {
  for (const l of busListeners) l(msg, audience)
}

// ---------- thumbnails (SVG data URLs: a shaded isometric object) ----------

const PALETTE = ['#0ea5e9', '#f97316', '#10b981', '#a855f7', '#ef4444', '#eab308', '#64748b', '#ec4899']

function shade(hex: string, f: number) {
  const n = parseInt(hex.slice(1), 16)
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)))
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`
}

export function mockThumbnail(seed: number, shape: 'box' | 'tower' | 'hex' | 'boat' = 'box'): string {
  const col = PALETTE[seed % PALETTE.length]
  const top = shade(col, 1.15)
  const left = shade(col, 0.85)
  const right = shade(col, 0.62)
  let body = ''
  if (shape === 'tower') {
    body = `<path d="M70 40 L100 55 L100 105 L70 120 L40 105 L40 55Z" fill="${left}"/><path d="M70 70 L100 55 L100 105 L70 120Z" fill="${right}"/><path d="M40 55 L70 40 L100 55 L70 70Z" fill="${top}"/><path d="M40 55 L70 70 L70 120 L40 105Z" fill="${left}"/>`
  } else if (shape === 'hex') {
    body = `<path d="M45 70 L58 58 L82 58 L95 70 L95 95 L82 107 L58 107 L45 95Z" fill="${right}"/><path d="M45 70 L58 58 L82 58 L95 70 L82 82 L58 82Z" fill="${top}"/><path d="M45 70 L58 82 L58 107 L45 95Z" fill="${left}"/><path d="M58 82 L82 82 L82 107 L58 107Z" fill="${left}"/><circle cx="70" cy="70" r="7" fill="${right}"/>`
  } else if (shape === 'boat') {
    body = `<path d="M30 85 Q70 120 112 82 L104 74 L38 76Z" fill="${right}"/><path d="M38 76 L104 74 L112 82 Q70 96 30 85Z" fill="${top}"/><rect x="58" y="48" width="28" height="27" rx="3" fill="${left}"/><path d="M58 48 L86 48 L82 42 L62 42Z" fill="${top}"/><rect x="64" y="55" width="7" height="7" rx="1" fill="${right}"/>`
  } else {
    body = `<path d="M70 48 L102 64 L70 80 L38 64Z" fill="${top}"/><path d="M38 64 L70 80 L70 114 L38 98Z" fill="${left}"/><path d="M70 80 L102 64 L102 98 L70 114Z" fill="${right}"/>`
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 140"><defs><radialGradient id="g" cx="50%" cy="40%" r="70%"><stop offset="0" stop-color="#f8fafc"/><stop offset="1" stop-color="#e2e8f0"/></radialGradient></defs><rect width="140" height="140" fill="url(#g)"/><ellipse cx="70" cy="118" rx="40" ry="7" fill="#0f172a" opacity=".12"/>${body}</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

// ---------- state ----------

interface F2State {
  files: LibraryFile[]
  prints: PrintJob[]
  engine: EngineInfo
  nextFileId: number
  nextPrintId: number
  /** simulated plate state (survives reloads) */
  bed?: { bedClear: boolean; bedOccupiedSince: number | null; lastPrintId: number | null; lastJob?: LastJob | null }
}

const KEY = 'sd:mock:f2'
/** File bytes live in memory only; after a reload, content is regenerated from the file kind. */
const blobs = new Map<number, Blob>()
const sampleCache = new Map<string, ReturnType<typeof generateSampleGcode>>()

function sample(key: 'default' | 'stress' | 'gear' | 'two', opts?: SampleOptions) {
  let s = sampleCache.get(key)
  if (!s) {
    s = generateSampleGcode(opts)
    sampleCache.set(key, s)
  }
  return s
}

const OLD_ENGINE = { version: '7.2.4.6131', path: '/appdata/engine/7.2.4.6131', installedAt: now() - 60 * DAY }
const CUR_ENGINE = { version: '7.3.0.6297', path: '/appdata/engine/7.3.0.6297', installedAt: now() - 21 * DAY }
const LATEST = {
  version: '7.3.1.6378',
  publishedAt: now() - 3 * DAY,
  assetUrl: 'https://github.com/CrealityOfficial/CrealityPrint/releases/download/v7.3.1/CrealityPrint-V7.3.1.6378-x86_64-Release.AppImage',
  size: 214_302_720,
}

// Seeded scan results (declared before seed(), which runs at module init).
const SCAN_OK: GcodeScan = { ok: true, findings: [], total: 0, version: 1, limits: { nozzle: 280, bed: 110 } }
const SCAN_BAD: GcodeScan = {
  ok: false,
  total: 3,
  version: 1,
  limits: { nozzle: 280, bed: 110 },
  findings: [
    { line: 12, command: 'M104 S320', reason: 'temperature_too_high', detail: 'S=320 > 280' },
    { line: 4810, command: 'SAVE_CONFIG', reason: 'config_write' },
    { line: 4811, command: 'MY_CUSTOM_MACRO', reason: 'unknown_command' },
  ],
}

function seed(): F2State {
  const t = now()
  const s = sample('default')
  const gear = sample('gear', { height: 12, radius: 26, wallPoints: 90, colors: ['#F97316', '#0EA5E9'] })
  const two = sample('two', TWO_OBJECT_OPTIONS)
  let id = 1
  const file = (ownerId: number, ownerName: string, kind: FileKind, name: string, extra: Partial<LibraryFile> = {}, shape?: Parameters<typeof mockThumbnail>[1]): LibraryFile => {
    const fid = id++
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    return {
      id: fid,
      ownerId,
      ownerName,
      kind,
      visibility: 'private',
      name,
      ext,
      size: 1_000_000,
      pinned: false,
      createdAt: t - fid * 7 * HOUR,
      updatedAt: t - fid * 7 * HOUR,
      thumbnailUrl: mockThumbnail(fid, shape),
      meta: {},
      ...extra,
    }
  }
  const gsum = (r: typeof s) => ({
    printSeconds: r.printSeconds,
    filamentGrams: r.filamentGrams,
    filamentMm: r.filamentMm,
    layers: r.layers,
    printerModel: 'Creality K2 SE',
    slicer: 'Creality Print 7.3.1.6378',
    estimateSource: 'slicer' as const,
  })
  const files: LibraryFile[] = [
    file(1, 'admin', 'gcode', 'Twisted_tower_PLA_0.2mm.gcode', { size: s.blob.size, pinned: true, meta: { gcode: gsum(s), trusted: true } }, 'tower'),
    file(1, 'admin', 'model', '3DBenchy.stl', { size: 11_285_384, meta: { triangles: 225_706, bbox: [60, 31, 48] } }, 'boat'),
    file(1, 'admin', 'project', 'Desk organizer.3mf', { size: 2_481_920, meta: { project: { plates: 2, objects: 5 } } }, 'box'),
    file(1, 'admin', 'gcode', 'Gear_set_PETG_0.2mm.gcode', { size: gear.blob.size, visibility: 'shared', meta: { gcode: gsum(gear), trusted: true } }, 'hex'),
    file(1, 'admin', 'model', 'Calibration_cube.stl', { size: 684, meta: { triangles: 12, bbox: [20, 20, 20] } }, 'box'),
    file(1, 'admin', 'model', 'Cable_clip.obj', { size: 187_402, meta: { triangles: 3_412, bbox: [18, 9, 6] } }, 'hex'),
    file(2, 'maria', 'model', 'Planter_hexagonal.stl', { size: 4_512_284, visibility: 'shared', meta: { triangles: 90_210, bbox: [120, 104, 95] } }, 'hex'),
    file(2, 'maria', 'project', 'Llavero María.3mf', { size: 912_331, meta: { project: { plates: 1, objects: 3 } } }, 'box'),
    file(2, 'maria', 'gcode', 'Planter_PLA_0.24mm.gcode', { size: 18_402_113, meta: { gcode: { ...gsum(s), printSeconds: 6 * 3600 + 1240, filamentGrams: [182.4], filamentMm: [61_200], layers: 396, estimateSource: 'computed', declared: { printSeconds: 5 * 3600, filamentGrams: [120], layers: 396 }, scan: SCAN_OK } } }, 'hex'),
    file(2, 'maria', 'gcode', 'Downloaded_calibration.gcode', { size: 2_204_113, meta: { gcode: { ...gsum(gear), estimateSource: 'computed', declared: { printSeconds: gear.printSeconds, filamentGrams: gear.filamentGrams, layers: gear.layers }, scan: SCAN_BAD } } }, 'box'),
    file(2, 'maria', 'model', 'Phone_stand.3mf', { size: 1_204_002, meta: { triangles: 18_220, bbox: [80, 70, 110] } }, 'tower'),
    // id 12: two objects (EXCLUDE_OBJECT_DEFINE), the running demo print (exclude object)
    file(2, 'maria', 'gcode', 'Two_towers_PLA_0.2mm.gcode', { size: two.blob.size, meta: { gcode: gsum(two), trusted: true } }, 'tower'),
  ]
  const job = (j: Partial<PrintJob> & Pick<PrintJob, 'userId' | 'username' | 'fileId' | 'fileName' | 'state'>, ago: number, dur = 2 * HOUR): PrintJob => ({
    id: 0,
    printerId: 1,
    grams: 40,
    seconds: dur / 1000,
    costEstimate: 0.9,
    createdAt: t - ago,
    startedAt: ['pending', 'rejected', 'cancelled'].includes(j.state) ? null : t - ago + 5 * MIN,
    endedAt: ['done', 'failed', 'cancelled', 'rejected'].includes(j.state) ? t - ago + dur : null,
    ...j,
  })
  const prints: PrintJob[] = [
    job({ userId: 1, username: 'admin', fileId: 4, fileName: 'Gear_set_PETG_0.2mm.gcode', state: 'done', grams: 23.1, costEstimate: 0.52 }, 9 * DAY, 75 * MIN),
    job({ userId: 2, username: 'maria', fileId: 9, fileName: 'Planter_PLA_0.24mm.gcode', state: 'done', grams: 182.4, costEstimate: 4.1 }, 6 * DAY, 6 * HOUR),
    job({ userId: 1, username: 'admin', fileId: 1, fileName: 'Twisted_tower_PLA_0.2mm.gcode', state: 'failed', grams: 9.8, reason: 'Filament runout' }, 4 * DAY, 40 * MIN),
    job({ userId: 2, username: 'maria', fileId: 9, fileName: 'Planter_PLA_0.24mm.gcode', state: 'rejected', reason: 'Too big for this week, sorry' }, 3 * DAY, 0),
    job({ userId: 1, username: 'admin', fileId: 4, fileName: 'Gear_set_PETG_0.2mm.gcode', state: 'cancelled', grams: 23.1 }, 2 * DAY, 0),
    job({ userId: 2, username: 'maria', fileId: 12, fileName: 'Two_towers_PLA_0.2mm.gcode', state: 'printing', grams: two.filamentGrams.reduce((a, b) => a + b, 0), seconds: two.printSeconds }, 40 * MIN, 0),
    job({ userId: 2, username: 'maria', fileId: 9, fileName: 'Planter_PLA_0.24mm.gcode', state: 'pending', grams: 182.4, seconds: 22_840, costEstimate: 4.1 }, 25 * MIN, 0),
    job({ userId: 2, username: 'maria', fileId: 4, fileName: 'Gear_set_PETG_0.2mm.gcode', state: 'pending', grams: 23.1, seconds: 4_500, costEstimate: 0.52 }, 8 * MIN, 0),
  ].map((p, i) => ({ ...p, id: i + 1 }))
  return {
    files,
    prints,
    engine: { selected: 'creality', installed: CUR_ENGINE, previous: OLD_ENGINE, latest: LATEST, lastCheckAt: t - 5 * HOUR, state: 'idle', progress: 0 },
    nextFileId: id,
    nextPrintId: prints.length + 1,
  }
}

function load(): F2State {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw) as F2State
  } catch {
    // ignore
  }
  return seed()
}

let st = load()
const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(st))
  } catch {
    // quota (thumbnails are small; ignore)
  }
}

export function resetF2() {
  st = seed()
  blobs.clear()
  Object.assign(sim, { bedClear: true, bedOccupiedSince: null, lastPrintId: null, state: 'idle', printId: null, fileName: null })
  save()
  startDemoPrint()
}

// ---------- files ----------

const kindOf = (ext: string): FileKind | null =>
  ext === 'gcode' ? 'gcode' : ['stl', 'obj', '3mf'].includes(ext) ? 'model' : null

function retention(ownerId: number): number {
  const s = mockCore.state.settings
  if (!s['files.retention.enabled']) return 0
  const keep = Math.max(1, Number(s['files.retention.keep']) || 10)
  const mine = st.files
    .filter((f) => f.ownerId === ownerId && f.visibility === 'private' && !f.pinned)
    .sort((a, b) => b.createdAt - a.createdAt)
  const drop = mine.slice(keep)
  if (!drop.length) return 0
  const ids = new Set(drop.map((f) => f.id))
  st.files = st.files.filter((f) => !ids.has(f.id))
  for (const id of ids) blobs.delete(id)
  mockCore.audit('files.retention', null, { deleted: drop.map((f) => f.name) })
  return drop.length
}

export const mockFiles = {
  /** Adds a file to the library (used by uploads, and by F1's slicing/project mocks). */
  add(input: { ownerId: number; name: string; kind: FileKind; blob?: Blob; meta?: LibraryFile['meta']; visibility?: LibraryFile['visibility']; thumbnailUrl?: string | null }): LibraryFile {
    const owner = mockCore.state.users.find((u) => u.id === input.ownerId)
    const fid = st.nextFileId++
    const t = now()
    const f: LibraryFile = {
      id: fid,
      ownerId: input.ownerId,
      ownerName: owner?.username ?? '?',
      kind: input.kind,
      visibility: input.visibility ?? 'private',
      name: input.name,
      ext: input.name.slice(input.name.lastIndexOf('.') + 1).toLowerCase(),
      size: input.blob?.size ?? 0,
      pinned: false,
      createdAt: t,
      updatedAt: t,
      thumbnailUrl: input.thumbnailUrl === undefined ? mockThumbnail(fid, input.kind === 'gcode' ? 'tower' : input.kind === 'project' ? 'box' : 'hex') : input.thumbnailUrl,
      meta: input.meta ?? {},
    }
    st.files.unshift(f)
    if (input.blob) blobs.set(fid, input.blob)
    retention(input.ownerId)
    save()
    return f
  },
  get: (id: number) => st.files.find((f) => f.id === id),
  list: () => st.files,
  /** User deletion: drop or hand over their files, cancel their pending prints, detach their history. */
  removeOwner(userId: number, files: 'delete' | 'transfer', toId: number) {
    const to = mockCore.state.users.find((u) => u.id === toId)
    const gone = mockCore.state.users.find((u) => u.id === userId)
    let fileCount = 0
    st.files = st.files.flatMap((f) => {
      if (f.ownerId !== userId) return [f]
      fileCount++
      if (files === 'delete') {
        blobs.delete(f.id)
        return []
      }
      const clash = st.files.some((x) => x.ownerId === toId && x.kind === f.kind && x.name === f.name)
      const dot = f.name.lastIndexOf('.')
      const name = clash ? `${f.name.slice(0, dot)} (${gone?.username ?? userId})${f.name.slice(dot)}` : f.name
      return [{ ...f, ownerId: toId, ownerName: to?.username ?? '?', name, pinned: true }]
    })
    let cancelled = 0
    for (const j of st.prints) {
      if (j.userId !== userId) continue
      if (j.state === 'pending') {
        j.state = 'cancelled'
        j.reason = 'user_deleted'
        cancelled++
      }
      if (j.state !== 'printing') j.userId = null
    }
    save()
    return { fileCount, cancelled }
  },
}

function readable(f: LibraryFile | undefined) {
  const u = mockCore.requireUser()
  if (!f || (f.ownerId !== u.id && f.visibility !== 'shared' && u.role !== 'admin')) throw new ApiError(404, 'common.not_found', 'Not found')
  return f
}
function writable(f: LibraryFile | undefined) {
  const u = mockCore.requireUser()
  const file = readable(f)
  if (file.ownerId !== u.id && u.role !== 'admin') throw new ApiError(403, 'auth.forbidden', 'Forbidden')
  return file
}

/** Parses a G-code footer cheaply (for uploaded .gcode files). */
async function summarize(blob: Blob) {
  const tail = await blob.slice(Math.max(0, blob.size - 64_000)).text()
  const head = await blob.slice(0, 16_000).text()
  const txt = head + '\n' + tail
  const num = (re: RegExp) => {
    const m = txt.match(re)
    return m ? m[1].split(',').map((v) => Number(v.trim())).filter(Number.isFinite) : []
  }
  const time = txt.match(/estimated printing time[^=]*=\s*(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?/)
  const secs = time ? (+(time[1] ?? 0)) * 86400 + (+(time[2] ?? 0)) * 3600 + (+(time[3] ?? 0)) * 60 + +(time[4] ?? 0) : null
  return {
    printSeconds: secs,
    filamentGrams: num(/; filament used \[g\] = ([^\n]+)/),
    filamentMm: num(/; filament used \[mm\] = ([^\n]+)/),
    layers: num(/; total layers count = (\d+)/)[0] ?? num(/; total layer number: (\d+)/)[0] ?? null,
    printerModel: txt.match(/; printer_model = ([^\n]+)/)?.[1] ?? null,
    slicer: txt.match(/; generated by ([^\n]+?) on /)?.[1]?.replace('_', ' ') ?? null,
  }
}

export async function mockUpload(path: string, file: File, opts: TransferOptions): Promise<unknown> {
  if (path !== '/files') throw new ApiError(404, 'common.not_found', 'No upload route')
  const u = mockCore.requireUser()
  if (mockCore.state.flags.writeFails) throw new ApiError(500, 'common.internal', 'Simulated server error')
  const ext = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase()
  const kind = kindOf(ext)
  if (!kind) throw new ApiError(400, 'files.unsupported_type', 'Unsupported file type')
  const max = Number(mockCore.state.settings['files.maxUploadMb']) || 200
  if (file.size > max * 1024 * 1024) throw new ApiError(413, 'files.too_large', 'File too large', { maxMb: max })
  // Simulated network: ~25 MB/s with at least 1.2 s per file, progress every 100 ms
  // ("Slow uploads" toolbar toggle: ~400 KB/s, at least 4 s, so the "Uploading <file>" rows are easy to see)
  const slow = mockCore.state.flags.slowUploads === true
  const ms = slow ? Math.max(4000, (file.size / 400e3) * 1000) : Math.max(1200, (file.size / 25e6) * 1000)
  for (let el = 0; el < ms; el += 100) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    opts.onProgress?.(Math.min(file.size, (file.size * el) / ms), file.size)
    await new Promise((r) => setTimeout(r, 100))
  }
  opts.onProgress?.(file.size, file.size)
  // Server-side work after the last byte (hash, thumbnail…): the client shows "Processing…" meanwhile
  await new Promise((r) => setTimeout(r, slow ? 1500 : 300))
  const meta: LibraryFile['meta'] = {}
  if (kind === 'gcode') {
    const declared = await summarize(file)
    meta.gcode = {
      ...declared,
      estimateSource: 'computed',
      declared: { printSeconds: declared.printSeconds, filamentGrams: declared.filamentGrams, layers: declared.layers },
      scan: mockScan(await file.slice(0, 8_000_000).text()),
    }
  }
  else if (ext === 'stl') {
    const head = new DataView(await file.slice(0, 84).arrayBuffer())
    const n = head.byteLength >= 84 ? head.getUint32(80, true) : 0
    if (84 + n * 50 === file.size) meta.triangles = n
  }
  const visibility = opts.fields?.visibility === 'shared' ? 'shared' : 'private'
  const f = mockFiles.add({ ownerId: u.id, name: file.name, kind, blob: file, meta, visibility })
  mockCore.audit('files.upload', f.name)
  mockCore.save()
  return f
}

/** File bytes: the uploaded blob, or regenerated sample content after a reload. */
function contentFor(f: LibraryFile): Blob {
  const kept = blobs.get(f.id)
  if (kept) return kept
  if (f.kind !== 'gcode') return sampleStl()
  if (f.name.startsWith('Stress_')) return sample('stress', STRESS_OPTIONS).blob
  if (f.name.startsWith('Gear_')) return sample('gear', { height: 12, radius: 26, wallPoints: 90, colors: ['#F97316', '#0EA5E9'] }).blob
  if (f.name.startsWith('Two_')) return sample('two', TWO_OBJECT_OPTIONS).blob
  return sample('default').blob
}

/** The file the simulated printer is running */
function currentFile(): LibraryFile | undefined {
  const job = st.prints.find((p) => p.id === sim.printId)
  return job ? mockFiles.get(job.fileId) : undefined
}

export async function mockBlob(path: string, opts: TransferOptions): Promise<Blob> {
  await new Promise((r) => setTimeout(r, mockCore.state.flags.latency))
  let blob: Blob
  const live = path.match(/^\/printers\/(\d+)\/(current-gcode|current-thumbnail)(\?last=1)?$/)
  if (live) {
    mockCore.requireUser()
    const lastJobFile = () => {
      const j = st.prints.find((p) => p.id === sim.lastJob?.printId)
      return !sim.bedClear && j ? mockFiles.get(j.fileId) : undefined
    }
    const running = sim.fileName ? currentFile() : undefined
    const f = live[3] ? lastJobFile() : (running ?? (live[2] === 'current-thumbnail' ? lastJobFile() : undefined))
    if (live[3] && !f) throw new ApiError(404, 'printers.no_last_job', 'No finished print on the bed')
    if (!f) throw new ApiError(404, 'printers.no_current_job', 'No job')
    if (live[2] === 'current-thumbnail') {
      const svg = decodeURIComponent((f.thumbnailUrl ?? mockThumbnail(f.id, 'tower')).split(',')[1])
      return new Blob([svg], { type: 'image/svg+xml' })
    }
    blob = contentFor(f)
  } else {
    const m = path.match(/^\/files\/(\d+)\/(content|download)$/)
    if (!m) throw new ApiError(404, 'common.not_found', 'Not found')
    blob = contentFor(readable(mockFiles.get(Number(m[1]))))
  }
  // Fake download progress
  for (let i = 1; i <= 5; i++) {
    opts.onProgress?.((blob.size * i) / 5, blob.size)
    await new Promise((r) => setTimeout(r, 60))
  }
  return blob
}

/** Dev toolbar: adds a ~50 MB G-code to the signed-in user's library. */
export function addStressFile() {
  const u = mockCore.state.users.find((x) => x.id === mockCore.state.sessionUserId)
  if (!u) return null
  const s = sample('stress', STRESS_OPTIONS)
  return mockFiles.add({
    ownerId: u.id,
    name: `Stress_${Math.round(s.blob.size / 1e6)}MB.gcode`,
    kind: 'gcode',
    blob: s.blob,
    meta: { gcode: { printSeconds: s.printSeconds, filamentGrams: s.filamentGrams, filamentMm: s.filamentMm, layers: s.layers, printerModel: 'Creality K2 SE', slicer: 'Creality Print 7.3.1.6378' } },
  })
}

// ---------- printer simulator ----------

interface Sim {
  state: PrinterState
  progress: number
  totalSec: number
  elapsed: number
  totalLayers: number
  fileName: string | null
  printId: number | null
  nozzle: number
  bed: number
  nozzleTarget: number
  bedTarget: number
  /** ticks left in a transitional state */
  hold: number
  cfs: CfsSlot[]
  bedClear: boolean
  bedOccupiedSince: number | null
  lastPrintId: number | null
  lastJob: LastJob | null
  fanPart: number
  light: boolean
  speedFactor: number
  flowFactor: number
  /** Before the print moves: heating the bed/nozzle, then preparing (probe/purge); null once printing */
  phase: 'heating' | 'preparing' | null
  homed: string
  pos: [number, number, number]
  /** exclude object: upper-case name -> byte offset when excluded */
  excluded: Record<string, number>
}

const CFS: CfsSlot[] = [
  // K2 SE external spool holder: no RFID/CFS measurement (the printer reports 100 %, the backend sends null)
  // Real K2 SE frame: {vendor:"Generic",type:"PLA",name:"Generic PLA",color:"#7a92ac",minTemp:200,maxTemp:220,pressure:0.02}
  { box: 0, slot: 1, material: 'Generic PLA', color: '#7a92ac', remainingPct: null, type: 'PLA', external: true, vendor: 'Generic', name: 'Generic PLA', minTemp: 200, maxTemp: 220, pressureAdvance: 0.02 },
  { box: 1, slot: 1, material: 'Hyper PLA', color: '#F2F2F2', remainingPct: 82, type: 'PLA', vendor: 'Creality', name: 'Hyper PLA', minTemp: 190, maxTemp: 240, pressureAdvance: 0.04 },
  { box: 1, slot: 2, material: 'Hyper PLA', color: '#0EA5E9', remainingPct: 46 },
  { box: 1, slot: 3, material: 'CR-PETG', color: '#F97316', remainingPct: 12 },
  { box: 1, slot: 4, material: null, color: null, remainingPct: null },
]

const sim: Sim = {
  state: 'idle',
  progress: 0,
  totalSec: 0,
  elapsed: 0,
  totalLayers: 0,
  fileName: null,
  printId: null,
  nozzle: 26,
  bed: 24,
  nozzleTarget: 0,
  bedTarget: 0,
  hold: 0,
  cfs: CFS.map((c) => ({ ...c })),
  bedClear: true,
  bedOccupiedSince: null,
  lastPrintId: null,
  lastJob: null,
  fanPart: 0,
  light: true,
  speedFactor: 100,
  flowFactor: 100,
  phase: null,
  homed: '',
  pos: [110, 107.5, 10],
  excluded: {},
}

if (st.bed) Object.assign(sim, st.bed)

function saveBed() {
  st.bed = { bedClear: sim.bedClear, bedOccupiedSince: sim.bedOccupiedSince, lastPrintId: sim.lastPrintId, lastJob: sim.lastJob }
  save()
}

function startSim(job: PrintJob, atPct = 0) {
  const f = mockFiles.get(job.fileId)
  sim.state = 'printing'
  sim.totalSec = job.seconds ?? f?.meta.gcode?.printSeconds ?? 3600
  sim.totalLayers = f?.meta.gcode?.layers ?? 300
  sim.progress = atPct
  sim.elapsed = (sim.totalSec * atPct) / 100
  sim.fileName = job.fileName
  sim.printId = job.id
  sim.nozzleTarget = 220
  sim.bedTarget = 60
  sim.fanPart = 100
  sim.homed = 'xyz'
  sim.excluded = {}
  sim.phase = null
  if (atPct > 0) {
    sim.nozzle = 219.6
    sim.bed = 60.1
  } else sim.phase = 'heating'
}

function startDemoPrint() {
  const job = st.prints.find((p) => p.state === 'printing')
  if (job) startSim(job, 37)
}
startDemoPrint()

const jitter = (v: number, target: number, rate: number, noise: number) => v + (target - v) * rate + (Math.random() - 0.5) * noise

function status(): PrinterStatus {
  const online = !mockCore.state.flags.printerOffline
  const printing = ['printing', 'paused', 'pausing', 'stopping'].includes(sim.state)
  return {
    printerId: 1,
    online,
    state: online ? sim.state : 'offline',
    nozzleTemp: online ? +sim.nozzle.toFixed(1) : null,
    nozzleTarget: online ? sim.nozzleTarget : null,
    bedTemp: online ? +sim.bed.toFixed(1) : null,
    bedTarget: online ? sim.bedTarget : null,
    chamberTemp: null,
    progress: online && (printing || sim.state === 'complete') ? Math.floor(sim.progress) : null,
    layer: online && printing ? Math.max(1, Math.ceil((sim.progress / 100) * sim.totalLayers)) : null,
    totalLayers: online && printing ? sim.totalLayers : null,
    elapsedSec: online && printing ? Math.round(sim.elapsed) : null,
    remainingSec: online && printing ? (sim.phase ? 0 : Math.max(0, Math.round(sim.totalSec - sim.elapsed))) : null,
    fileName: online && sim.fileName ? sim.fileName : null,
    errorCode: online ? 0 : null,
    cfs: online ? sim.cfs : null,
    updatedAt: now(),
    currentPrintId: online && printing ? sim.printId : null,
    bedClear: sim.bedClear,
    bedOccupiedSince: sim.bedOccupiedSince,
    lastPrintId: sim.lastPrintId,
    job: online && printing ? jobInfo() : null,
    lastJob: !printing && !sim.bedClear ? sim.lastJob : null,
    fanPart: online ? sim.fanPart : null,
    fanAux: online ? (printing ? 30 : 0) : null,
    fanCase: online ? (printing ? 50 : 0) : null,
    homedAxes: online ? sim.homed : null,
    position: online ? sim.pos : null,
    maxNozzleTemp: 300,
    maxBedTemp: 100,
    lightOn: online ? sim.light : null,
    speedFactor: online ? sim.speedFactor : null,
    flowFactor: online ? sim.flowFactor : null,
    estimate: online && printing ? estimate() : null,
  }
}

/** Like the backend's estimate: slicer time while heating/preparing (the printer reports 0 s then), printer's after. */
function estimate(): NonNullable<PrinterStatus['estimate']> {
  const left = Math.max(0, Math.round(sim.totalSec - sim.elapsed))
  if (sim.phase) {
    const prep = sim.phase === 'heating' ? Math.max(30, Math.round((sim.nozzleTarget - sim.nozzle) * 1.2)) + 60 : sim.hold * 10
    return { phase: sim.phase, remainingSec: left + prep, finishesAt: now() + (left + prep) * 1000, source: 'slicer' }
  }
  return { phase: sim.progress > 98 ? 'finishing' : 'printing', remainingSec: left, finishesAt: now() + left * 1000, source: 'printer' }
}

// ---------- temperature history (like the backend: a sample every 2 s, 60 min kept) ----------

const TEMP_KEEP_MS = 60 * 60_000
const tempHistory: TempSample[] = []
/** Seeds 45 min of plausible history (heat-up to the demo print's targets, or idle at room temperature). */
function seedTempHistory() {
  const t0 = Date.now() - 45 * 60_000
  const printing = sim.state === 'printing'
  for (let t = t0, i = 0; t < Date.now(); t += 2000, i++) {
    const heat = printing ? Math.min(1, Math.max(0, (i - 120) / 90)) : 0
    const nT = printing && i >= 120 ? sim.nozzleTarget : 0
    const bT = printing && i >= 100 ? sim.bedTarget : 0
    const n = 26 + (printing ? (sim.nozzleTarget - 26) * heat : 0) + Math.sin(i / 7) * 0.6
    const bh = printing ? Math.min(1, Math.max(0, (i - 100) / 160)) : 0
    const bd = 24 + (printing ? (sim.bedTarget - 24) * bh : 0) + Math.sin(i / 11) * 0.25
    tempHistory.push({ t, nozzle: +n.toFixed(1), nozzleTarget: nT, bed: +bd.toFixed(1), bedTarget: bT })
  }
}
seedTempHistory()
setInterval(() => {
  if (mockCore.state.flags.printerOffline) return
  tempHistory.push({ t: Date.now(), nozzle: +sim.nozzle.toFixed(1), nozzleTarget: sim.nozzleTarget, bed: +sim.bed.toFixed(1), bedTarget: sim.bedTarget })
  while (tempHistory.length && tempHistory[0].t < Date.now() - TEMP_KEEP_MS) tempHistory.shift()
}, 2000)

/** Objects of the running file (EXCLUDE_OBJECT_DEFINE in the sample) merged with the simulated Klipper state. */
function jobObjects(f: LibraryFile, filePos: number): JobObject[] {
  if (!f.name.startsWith('Two_')) return []
  const objs = sample('two', TWO_OBJECT_OPTIONS).objects
  // Objects alternate inside every layer: the current one follows the position inside the layer
  const layerFrac = ((sim.progress / 100) * sim.totalLayers) % 1
  const live = objs.filter((o) => !(o.name.toUpperCase() in sim.excluded))
  const cur = live.length ? live[Math.min(live.length - 1, Math.floor(layerFrac * live.length))] : null
  return objs.map((o) => {
    const at = sim.excluded[o.name.toUpperCase()]
    return { name: o.name, label: o.label, center: o.center, polygon: o.polygon, excluded: at !== undefined, excludedAt: at ?? null, current: cur?.name === o.name && filePos > 0 }
  })
}

function jobInfo(): PrinterStatus['job'] {
  const f = currentFile()
  if (!f || !sim.fileName) return null
  const size = contentFor(f).size
  return {
    fileName: `/usr/data/printer_data/gcodes/${sim.fileName}`,
    // Bytes advance with the (time-based) progress; good enough for the simulator
    filePosition: Math.floor((size * sim.progress) / 100),
    fileSize: size,
    layer: Math.max(1, Math.ceil((sim.progress / 100) * sim.totalLayers)),
    layerCount: sim.totalLayers,
    toolhead: null,
    slicer: f.meta.gcode?.slicer ?? null,
    objectHeight: null,
    objects: jobObjects(f, Math.floor((size * sim.progress) / 100)),
  }
}

function finishJob(state: PrintJob['state'], reason?: string) {
  // Whatever happened, something (or half of it) is now on the plate; keep the job on screen until cleared
  const info = jobInfo()
  if (info) {
    const done = state === 'done'
    sim.lastJob = {
      ...info,
      filePosition: done ? info.fileSize : info.filePosition,
      layer: done ? sim.totalLayers : info.layer,
      objects: (info.objects ?? []).map((o) => ({ ...o, current: false })),
      endedAt: now(),
      result: done ? 'done' : state === 'failed' ? 'failed' : 'cancelled',
      progress: done ? 100 : Math.floor(sim.progress),
      elapsedSec: Math.round(sim.elapsed),
      totalLayers: sim.totalLayers,
      printId: sim.printId,
    }
  }
  sim.bedClear = false
  sim.bedOccupiedSince = now()
  sim.lastPrintId = sim.printId
  saveBed()
  const job = st.prints.find((p) => p.id === sim.printId)
  if (job) {
    job.state = state
    job.endedAt = now()
    if (reason) job.reason = reason
    save()
    mockPublish({ type: 'print.update', data: job }, job.userId == null ? 'admins' : { userId: job.userId, admins: true })
  }
}

function tick() {
  if (!mockCore.state.setupComplete) return
  switch (sim.state) {
    case 'printing': {
      // Heating (the real printer reports 0 s remaining meanwhile), then a few seconds of preparing
      if (sim.phase === 'heating') {
        if (Math.abs(sim.nozzle - sim.nozzleTarget) < 2 && Math.abs(sim.bed - sim.bedTarget) < 1.5) {
          sim.phase = 'preparing'
          sim.hold = 4
        }
        break
      }
      if (sim.phase === 'preparing') {
        if (--sim.hold <= 0) sim.phase = null
        break
      }
      sim.elapsed += SPEEDUP
      sim.progress = Math.min(100, (sim.elapsed / sim.totalSec) * 100)
      const slot = sim.cfs[sim.progress > 50 && sim.progress < 58 ? 1 : 0]
      if (slot.remainingPct && Math.random() < 0.05) slot.remainingPct = Math.max(0, slot.remainingPct - 1)
      if (sim.progress >= 100) {
        sim.state = 'complete'
        sim.hold = 25
        sim.nozzleTarget = 0
        sim.bedTarget = 0
        finishJob('done')
      }
      break
    }
    case 'pausing':
      if (--sim.hold <= 0) sim.state = 'paused'
      break
    case 'stopping':
      if (--sim.hold <= 0) {
        sim.state = 'aborted'
        sim.hold = 10
        sim.nozzleTarget = 0
        sim.bedTarget = 0
        finishJob('cancelled')
      }
      break
    case 'complete':
    case 'aborted':
      if (--sim.hold <= 0) {
        sim.state = 'idle'
        sim.fileName = null
        sim.printId = null
      }
      break
  }
  sim.nozzle = jitter(sim.nozzle, sim.nozzleTarget || 26, sim.nozzleTarget ? 0.25 : 0.04, sim.nozzleTarget ? 0.8 : 0.2)
  sim.bed = jitter(sim.bed, sim.bedTarget || 24, sim.bedTarget ? 0.2 : 0.03, sim.bedTarget ? 0.3 : 0.1)
  mockPublish({ type: 'printer.status', data: status() })
}
setInterval(tick, 1000)

/** Dev toolbar: jump the running print to its last seconds (to see completion + "bed occupied"). */
export function finishPrintSoon() {
  if (sim.state === 'printing') sim.elapsed = Math.max(sim.elapsed, sim.totalSec - SPEEDUP * 3)
}

/** Dev toolbar: printer idle with a clear bed (no job, no last job). */
export function printerIdleSoon() {
  const job = st.prints.find((p) => p.id === sim.printId && ['printing', 'paused'].includes(p.state))
  if (job) {
    job.state = 'cancelled'
    job.endedAt = now()
    save()
  }
  Object.assign(sim, { state: 'idle', printId: null, fileName: null, progress: 0, nozzleTarget: 0, bedTarget: 0, fanPart: 0, bedClear: true, bedOccupiedSince: null, lastPrintId: null, lastJob: null })
  saveBed()
  mockPublish({ type: 'printer.status', data: status() })
}

/** Dev toolbar: start the demo print again (at 37 %). */
export function restartDemoPrint() {
  const job = st.prints.find((p) => p.fileId === 12) ?? st.prints[0]
  if (!job) return
  job.state = 'printing'
  job.endedAt = null
  job.startedAt = now() - 40 * MIN
  Object.assign(sim, { bedClear: true, bedOccupiedSince: null, lastPrintId: null, lastJob: null })
  saveBed()
  startSim(job, 37)
  // Starts cold: the heating + preparing phases come first (the printer then reports 0 s remaining)
  Object.assign(sim, { nozzle: 31, bed: 27, phase: 'heating' })
  mockPublish({ type: 'printer.status', data: status() })
}

// ---------- motion controls / exclude object ----------

function mockControl(kind: 'control' | 'exclude-object', b: Record<string, unknown>) {
  const u = mockCore.requireUser()
  readOnlyGuard()
  if (mockCore.state.flags.printerOffline) throw new ApiError(409, 'prints.printer_offline', 'Printer offline')
  const active = ['printing', 'paused', 'pausing', 'stopping'].includes(sim.state)
  if (kind === 'exclude-object') {
    const job = st.prints.find((x) => x.id === sim.printId)
    if (u.role !== 'admin' && job?.userId !== u.id) throw new ApiError(403, 'prints.not_owner', 'Not the owner')
    const name = String(b.name ?? '')
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) throw new ApiError(400, 'exclude.invalid_name', 'Invalid name')
    const info = jobInfo()
    if (!info || !['printing', 'paused'].includes(sim.state)) throw new ApiError(409, 'prints.invalid_state', 'Nothing is printing')
    const objs = info.objects ?? []
    const o = objs.find((x) => x.name.toUpperCase() === name.toUpperCase())
    if (!o) throw new ApiError(404, 'exclude.unknown_object', 'Unknown object')
    if (o.excluded) throw new ApiError(409, 'exclude.already_excluded', 'Already excluded')
    if (!objs.some((x) => x !== o && !x.excluded)) throw new ApiError(409, 'exclude.last_object', 'Last object')
    sim.excluded[o.name.toUpperCase()] = info.filePosition ?? 0
    mockCore.audit('print.exclude_object', 'K2 SE', { name: o.name })
    mockPublish({ type: 'printer.status', data: status() })
    return status()
  }
  if (u.role !== 'admin' && !(u as { canControlPrinter?: boolean }).canControlPrinter) throw new ApiError(403, 'printers.control_forbidden', 'Not allowed')
  const a = String(b.action)
  if (active && !['fan', 'light', 'temp', 'speed_factor', 'flow_factor'].includes(a)) throw new ApiError(409, 'printers.control_busy', 'Printing')
  // Same safety rules as the server: job tuning owner/admin only, no motion while the bed is occupied
  if (active && ['fan', 'temp', 'speed_factor', 'flow_factor'].includes(a) && u.role !== 'admin' && st.prints.find((x) => x.id === sim.printId)?.userId !== u.id) {
    throw new ApiError(403, 'printers.forbidden_job', 'Not the owner of the running print')
  }
  if (['home', 'jog', 'extrude'].includes(a) && !sim.bedClear) throw new ApiError(409, 'printers.bed_not_cleared', 'Remove the print first')
  const axisI = { x: 0, y: 1, z: 2 } as const
  const max = [220, 215, 245]
  switch (a) {
    case 'home': {
      const axes = b.axes === 'xy' ? 'xy' : b.axes === 'x' || b.axes === 'y' || b.axes === 'z' ? b.axes : 'xyz'
      sim.homed = ['x', 'y', 'z'].filter((x) => sim.homed.includes(x) || axes.includes(x)).join('')
      if (axes.includes('x')) sim.pos = [110, sim.pos[1], sim.pos[2]]
      if (axes.includes('y')) sim.pos = [sim.pos[0], 107.5, sim.pos[2]]
      if (axes.includes('z')) sim.pos = [sim.pos[0], sim.pos[1], 0]
      break
    }
    case 'jog': {
      const axis = String(b.axis) as 'x' | 'y' | 'z'
      const d = Number(b.distance)
      if (!(axis in axisI) || !Number.isFinite(d) || Math.abs(d) < 0.01 || Math.abs(d) > 50 || !(Number(b.feedrate) >= 60)) throw new ApiError(400, 'validation.failed', 'Invalid')
      if (!sim.homed.includes(axis)) throw new ApiError(409, 'printers.not_homed', 'Not homed')
      const i = axisI[axis]
      const next = sim.pos[i] + d
      if (next < 0 || next > max[i]) throw new ApiError(409, 'printers.out_of_range', 'Out of range')
      sim.pos = sim.pos.map((v, k) => (k === i ? Math.round(next * 1000) / 1000 : v)) as [number, number, number]
      break
    }
    case 'extrude':
      if (sim.nozzle < 170) throw new ApiError(409, 'printers.nozzle_cold', 'Cold nozzle')
      break
    case 'temp': {
      const target = Number(b.target)
      const lim = b.heater === 'bed' ? 100 : 300
      if (!Number.isInteger(target) || target < 0 || target > lim) throw new ApiError(400, 'printers.temp_out_of_range', 'Out of range')
      if (b.heater === 'bed') sim.bedTarget = target
      else sim.nozzleTarget = target
      break
    }
    case 'fan':
      sim.fanPart = Math.max(0, Math.min(100, Math.round(Number(b.percent) || 0)))
      break
    case 'motors_off':
      sim.homed = ''
      break
    case 'light':
      if (typeof b.on !== 'boolean') throw new ApiError(400, 'validation.failed', 'Invalid')
      sim.light = b.on
      break
    case 'speed_factor':
    case 'flow_factor': {
      const v = Number(b.percent)
      const [lo, hi] = a === 'speed_factor' ? [10, 300] : [50, 150]
      if (!Number.isInteger(v) || v < lo || v > hi) throw new ApiError(400, 'printers.factor_out_of_range', 'Out of range', { min: lo, max: hi })
      if (a === 'speed_factor') sim.speedFactor = v
      else sim.flowFactor = v
      break
    }
    default:
      throw new ApiError(400, 'validation.failed', 'Invalid command')
  }
  mockCore.audit('printer.control', 'K2 SE', b)
  mockPublish({ type: 'printer.status', data: status() })
  return status()
}

// ---------- engine manager ----------

function runEngineUpdate() {
  const e = st.engine
  const target = e.latest
  if (!target) return
  const steps: [EngineInfo['state'], number, string][] = [
    ...Array.from({ length: 20 }, (_, i) => ['downloading', Math.round(((i + 1) / 20) * 100), `Downloading ${target.version}`] as [EngineInfo['state'], number, string]),
    ['extracting', 100, 'Extracting AppImage'],
    ['extracting', 100, 'Extracting AppImage'],
    ['testing', 100, 'Slicing a test cube'],
    ['testing', 100, 'Slicing a test cube'],
  ]
  let i = 0
  const step = () => {
    if (i < steps.length) {
      const [state, progress, message] = steps[i++]
      e.state = state
      e.progress = progress
      save()
      mockPublish({ type: 'engine.progress', data: { state, progress, message } }, 'admins')
      setTimeout(step, state === 'downloading' ? 350 : 900)
      return
    }
    e.previous = e.installed
    e.installed = { version: target.version, path: `/appdata/engine/${target.version}`, installedAt: now() }
    e.state = 'idle'
    e.progress = 0
    save()
    mockCore.audit('engine.update', target.version)
    mockCore.save()
    mockPublish({ type: 'engine.progress', data: { state: 'idle', progress: 100, message: `Installed ${target.version}` } }, 'admins')
  }
  step()
}

export const engineInstalledVersion = () => st.engine.installed?.version ?? null

// ---------- prints ----------

/** Rough version of the backend scanner (files/gcode-scan.ts): the obvious dangerous commands only. */
function mockScan(text: string): GcodeScan {
  const findings: GcodeScanFinding[] = []
  let total = 0
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const cmd = lines[i].split(';')[0].trim().toUpperCase()
    if (!cmd) continue
    const name = cmd.split(/\s+/)[0]
    const temp = /^M(104|109)\b/.test(name) ? 280 : /^M(140|190)\b/.test(name) ? 110 : null
    const s = Number(cmd.match(/S([\d.]+)/)?.[1])
    let reason: GcodeScanFinding['reason'] | null = null
    if (['SAVE_CONFIG', 'M500', 'M501', 'M502'].includes(name)) reason = 'config_write'
    else if (name === 'RUN_SHELL_COMMAND') reason = 'shell_command'
    else if (name === 'FIRMWARE_RESTART' || name === 'RESTART') reason = 'firmware_restart'
    else if (name === 'M112') reason = 'emergency_stop'
    else if (name === 'M997') reason = 'firmware_update'
    else if (['SET_KINEMATIC_POSITION', 'SET_STEPPER_ENABLE', 'FORCE_MOVE'].includes(name)) reason = 'kinematics'
    else if (temp != null && s > temp) reason = 'temperature_too_high'
    if (!reason) continue
    total++
    if (findings.length < 50) findings.push({ line: i + 1, command: cmd.slice(0, 120), reason })
  }
  return { ok: total === 0, findings, total, version: 1, limits: { nozzle: 280, bed: 110 } }
}

/** prints.untrusted_gcode / prints.dangerous_gcode, like PrintingService. */
function gcodePolicy(f: LibraryFile, u: { role: string; canPrintUploadedGcode?: boolean }, allowDangerous: boolean) {
  if (f.meta.trusted) return
  if (u.role !== 'admin' && !u.canPrintUploadedGcode) throw new ApiError(403, 'prints.untrusted_gcode', 'Only G-code sliced in SliceDock can be printed')
  const scan = f.meta.gcode?.scan
  if (scan && !scan.ok && !allowDangerous) {
    throw new ApiError(403, 'prints.dangerous_gcode', 'The G-code contains commands SliceDock does not allow', {
      total: scan.total,
      findings: scan.findings.slice(0, 20),
      limits: scan.limits,
    })
  }
  if (scan && !scan.ok) mockCore.audit('print.allow_dangerous', f.name, { total: scan.total })
}

function usageFor(userId: number): UsageSummary {
  const u = mockCore.state.users.find((x) => x.id === userId)
  const start = new Date()
  start.setDate(1)
  start.setHours(0, 0, 0, 0)
  const grams = st.prints
    .filter((p) => p.userId === userId && (p.state === 'done' || p.state === 'printing') && p.createdAt >= start.getTime())
    .reduce((a, p) => a + (p.grams ?? 0), 0)
  const perKg = mockCore.state.settings['limits.costPerKg']
  return {
    monthGrams: Math.round(grams * 10) / 10,
    monthCost: perKg == null ? null : Math.round(grams * perKg) / 1000,
    limits: u?.limits ?? { enabled: false, maxGramsPerPrint: null, maxGramsPerMonth: null, maxHoursPerPrint: null, requiresApproval: false },
    costPerKg: perKg,
    currency: mockCore.state.settings['limits.currency'],
  }
}

function printerFree() {
  if (mockCore.state.flags.printerOffline) throw new ApiError(409, 'prints.printer_offline', 'Printer offline')
  if (!['idle', 'complete', 'aborted', 'failed'].includes(sim.state)) throw new ApiError(409, 'prints.printer_busy', 'Printer busy')
}

function bedNotCleared(): never {
  const last = st.prints.find((p) => p.id === sim.lastPrintId)
  throw new ApiError(409, 'prints.bed_not_cleared', 'Remove the previous print first', {
    lastPrintId: sim.lastPrintId,
    endedAt: last?.endedAt ?? sim.bedOccupiedSince,
    fileName: last?.fileName ?? null,
  })
}

function readOnlyGuard() {
  if (mockCore.state.flags.readOnly) throw new ApiError(423, 'printers.read_only', 'Read-only mode')
}

/**
 * Simulated SliceDock → printer upload: `print.update` with state `uploading`, then `print.upload` frames (4/s) up
 * to 100 % (sent when the "printer" answered), like the real backend. ~8 MB/s, or ~1 MB/s with "Slow uploads".
 */
async function sendToPrinter(job: PrintJob, confirmBedClear: boolean) {
  readOnlyGuard()
  printerFree()
  if (!sim.bedClear && !confirmBedClear) bedNotCleared()
  const audience: Audience = job.userId == null ? 'admins' : { userId: job.userId, admins: true }
  const total = mockFiles.get(job.fileId)?.size ?? 2_000_000
  const rate = mockCore.state.flags.slowUploads ? 1e6 : 8e6
  const ms = Math.max(mockCore.state.flags.slowUploads ? 4000 : 800, (total / rate) * 1000)
  mockPublish({ type: 'print.update', data: { ...job, state: 'uploading' as PrintJob['state'] } }, audience)
  const t0 = now()
  for (;;) {
    const el = now() - t0
    if (el >= ms) break
    const sent = Math.round((total * el) / ms)
    mockPublish({ type: 'print.upload', data: { printId: job.id, printerId: job.printerId, fileName: job.fileName, sentBytes: sent, totalBytes: total, percent: Math.min(99, Math.floor((sent / total) * 100)), etaSec: Math.max(1, Math.round((ms - el) / 1000)) } }, audience)
    await new Promise((r) => setTimeout(r, 250))
  }
  mockPublish({ type: 'print.upload', data: { printId: job.id, printerId: job.printerId, fileName: job.fileName, sentBytes: total, totalBytes: total, percent: 100, etaSec: 0 } }, audience)
  await new Promise((r) => setTimeout(r, 600)) // printer answers "started"
  start(job, confirmBedClear)
}

function start(job: PrintJob, confirmBedClear = false) {
  readOnlyGuard()
  printerFree()
  if (!sim.bedClear) {
    if (!confirmBedClear) bedNotCleared()
    sim.bedClear = true
    sim.bedOccupiedSince = null
    saveBed()
  }
  job.state = 'printing'
  job.startedAt = now()
  startSim(job)
  save()
  mockPublish({ type: 'print.update', data: job }, job.userId == null ? 'admins' : { userId: job.userId, admins: true })
}

/** Printer copies of a library G-code: one per SliceDock print of it that is not running (like printer_uploads). */
function mockPrinterCopies(fileId: number): { printerId: number; printerName: string; name: string }[] {
  const f = mockFiles.get(fileId)
  if (!f || f.kind !== 'gcode') return []
  return st.prints
    .filter((p) => p.fileId === fileId && ['done', 'failed', 'cancelled'].includes(p.state))
    .slice(0, 3)
    .map((p) => ({ printerId: 1, printerName: 'K2 SE', name: `${f.name.replace(/\.gcode$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_')}_p${p.id}.gcode` }))
}

// ---------- router ----------

export function handleF2(method: string, p: string, url: URL, b: Record<string, unknown>): unknown {
  // Files
  if (p === '/files' && method === 'GET') {
    const u = mockCore.requireUser()
    const scope = url.searchParams.get('scope') ?? 'private'
    const kind = url.searchParams.get('kind')
    let list = st.files
    if (scope === 'shared') list = list.filter((f) => f.visibility === 'shared')
    else if (scope === 'all') {
      if (u.role !== 'admin') throw new ApiError(403, 'auth.forbidden', 'Forbidden')
    } else list = list.filter((f) => f.ownerId === u.id)
    if (kind) list = list.filter((f) => f.kind === kind)
    return [...list].sort((a, b2) => b2.createdAt - a.createdAt)
  }
  if (p === '/files/printer-copies' && method === 'GET') {
    mockCore.requireUser()
    const ids = (url.searchParams.get('ids') ?? '').split(',').map(Number).filter((n) => n > 0)
    return { items: ids.map((id) => ({ fileId: id, copies: mockPrinterCopies(id) })) }
  }
  const fm = p.match(/^\/files\/(\d+)$/)
  if (fm) {
    const f = writable(mockFiles.get(Number(fm[1])))
    if (method === 'DELETE') {
      const copies = mockPrinterCopies(f.id)
      st.files = st.files.filter((x) => x.id !== f.id)
      blobs.delete(f.id)
      mockCore.audit('files.delete', f.name)
      save()
      if (url.searchParams.get('printer') !== '1') return undefined
      const ro = mockCore.state.flags.readOnly
      const off = mockCore.state.flags.printerOffline
      return { printer: copies.map((c) => (ro ? { ...c, result: 'skipped', reason: 'read_only' } : off ? { ...c, result: 'skipped', reason: 'offline' } : { ...c, result: 'deleted' })) }
    }
    if (method === 'PATCH') {
      if (typeof b.name === 'string') {
        const name = b.name.trim()
        if (!name || /[/\\]/.test(name)) throw new ApiError(400, 'files.invalid_name', 'Invalid name')
        f.name = name.toLowerCase().endsWith(`.${f.ext}`) ? name : `${name}.${f.ext}`
      }
      if (b.visibility === 'private' || b.visibility === 'shared') f.visibility = b.visibility
      if (typeof b.pinned === 'boolean') f.pinned = b.pinned
      f.updatedAt = now()
      if (b.pinned === false || b.visibility === 'private') retention(f.ownerId)
      mockCore.audit('files.update', f.name, b)
      save()
      return f
    }
  }

  // Temperature history
  const th = p.match(/^\/printers\/(\d+)\/temps$/)
  if (th && method === 'GET') {
    mockCore.requireUser()
    if (Number(th[1]) !== 1) throw new ApiError(404, 'printers.not_found', 'Not found')
    const minutes = Math.max(1, Math.min(60, Number(url.searchParams.get('minutes') ?? 30) || 30))
    const since = Date.now() - minutes * 60_000
    return { intervalMs: 2000, samples: tempHistory.filter((x) => x.t >= since) }
  }

  // Motion controls + exclude object (typed commands, same rules as the backend)
  const cm = p.match(/^\/printers\/(\d+)\/(control|exclude-object)$/)
  if (cm && method === 'POST') return mockControl(cm[2] as 'control' | 'exclude-object', b)

  // Printer live status & commands
  const pm = p.match(/^\/printers\/(\d+)\/(status|pause|resume|cancel|bed-cleared)$/)
  if (pm) {
    const u = mockCore.requireUser()
    if (Number(pm[1]) !== 1 || !mockCore.state.printers.some((x) => x.id === 1)) throw new ApiError(404, 'common.not_found', 'Not found')
    if (pm[2] === 'status') return status()
    if (pm[2] !== 'status') readOnlyGuard()
    if (pm[2] === 'bed-cleared') {
      sim.bedClear = true
      sim.bedOccupiedSince = null
      sim.lastJob = null
      saveBed()
      mockCore.audit('printer.bed_cleared', 'K2 SE')
      mockPublish({ type: 'printer.status', data: status() })
      return undefined
    }
    if (mockCore.state.flags.printerOffline) throw new ApiError(409, 'prints.printer_offline', 'Printer offline')
    const job = st.prints.find((x) => x.id === sim.printId)
    if (u.role !== 'admin' && job?.userId !== u.id) throw new ApiError(403, 'auth.forbidden', 'Forbidden')
    if (pm[2] === 'pause' && sim.state === 'printing') {
      sim.state = 'pausing'
      sim.hold = 2
    } else if (pm[2] === 'resume' && sim.state === 'paused') sim.state = 'printing'
    else if (pm[2] === 'cancel' && ['printing', 'paused', 'pausing'].includes(sim.state)) {
      sim.state = 'stopping'
      sim.hold = 2
    } else throw new ApiError(409, 'printers.invalid_state', 'Not possible in the current state')
    mockCore.audit(`printer.${pm[2]}`, 'K2 SE')
    mockPublish({ type: 'printer.status', data: status() })
    return undefined
  }

  // Prints
  if (p === '/prints' && method === 'POST') {
    const u = mockCore.requireUser()
    // Review 3A #3: at most 3 open approval requests per (non-admin) user
    if (u.role !== 'admin' && st.prints.filter((j) => j.userId === u.id && j.state === 'pending').length >= 3) {
      throw new ApiError(409, 'prints.too_many_pending', 'Too many pending requests', { max: 3 })
    }
    const f = readable(mockFiles.get(Number(b.fileId)))
    if (f.kind !== 'gcode') throw new ApiError(400, 'prints.not_gcode', 'Not G-code')
    gcodePolicy(f, u, b.allowDangerous === true && u.role === 'admin')
    const g = f.meta.gcode
    const grams = g?.filamentGrams.reduce((a, x) => a + x, 0) ?? null
    const seconds = g?.printSeconds ?? null
    const lim = u.limits
    if (lim.enabled) {
      if (lim.maxGramsPerPrint != null && grams != null && grams > lim.maxGramsPerPrint)
        throw new ApiError(403, 'prints.limit_per_print', 'Over the per-print limit', { limit: lim.maxGramsPerPrint, grams })
      if (lim.maxHoursPerPrint != null && seconds != null && seconds / 3600 > lim.maxHoursPerPrint)
        throw new ApiError(403, 'prints.limit_hours', 'Over the hours limit', { limit: lim.maxHoursPerPrint })
      if (lim.maxGramsPerMonth != null && grams != null && usageFor(u.id).monthGrams + grams > lim.maxGramsPerMonth)
        throw new ApiError(403, 'prints.limit_month', 'Over the monthly limit', { limit: lim.maxGramsPerMonth })
    }
    const perKg = mockCore.state.settings['limits.costPerKg']
    const job: PrintJob = {
      id: st.nextPrintId++,
      userId: u.id,
      username: u.username,
      printerId: Number(b.printerId) || 1,
      fileId: f.id,
      fileName: f.name,
      grams,
      seconds,
      costEstimate: perKg != null && grams != null ? Math.round(grams * perKg) / 1000 : null,
      state: 'pending',
      createdAt: now(),
      startedAt: null,
      endedAt: null,
    }
    if (lim.enabled && lim.requiresApproval) {
      st.prints.push(job)
      save()
      mockCore.audit('prints.request', f.name)
      mockPublish({ type: 'approval.pending', data: job }, 'admins')
      return job
    }
    // Calibrate before printing (auto bed leveling): accepted like the real API (`calibrate: boolean`)
    const calibrate = typeof b.calibrate === 'boolean' ? b.calibrate : undefined
    return sendToPrinter(job, b.confirmBedClear === true).then(() => {
      st.prints.push(job)
      mockCore.audit('prints.start', f.name, calibrate !== undefined ? { calibrate } : undefined)
      save()
      return job
    })
  }
  if (p === '/prints' && method === 'GET') {
    const u = mockCore.requireUser()
    const all = url.searchParams.get('scope') === 'all'
    if (all && u.role !== 'admin') throw new ApiError(403, 'auth.forbidden', 'Forbidden')
    return st.prints.filter((x) => all || x.userId === u.id).sort((a, c) => c.createdAt - a.createdAt)
  }
  if (p === '/prints/pending') {
    mockCore.requireAdmin()
    return st.prints.filter((x) => x.state === 'pending').sort((a, c) => a.createdAt - c.createdAt)
  }
  const prm = p.match(/^\/prints\/(\d+)(?:\/(approve|reject))?$/)
  if (prm) {
    const job = st.prints.find((x) => x.id === Number(prm[1]))
    if (!job) throw new ApiError(404, 'common.not_found', 'Not found')
    if (prm[2]) {
      mockCore.requireAdmin()
      if (job.state !== 'pending') throw new ApiError(409, 'prints.not_pending', 'Not pending')
      if (prm[2] === 'approve') {
        const requester = mockCore.state.users.find((x) => x.id === job.userId)
        const file = mockFiles.get(job.fileId)
        if (!file) throw new ApiError(409, 'prints.file_changed', 'The file changed or was removed')
        if (requester) gcodePolicy(file, requester, b.allowDangerous === true)
        const lim = requester?.limits
        if (lim?.enabled && lim.maxGramsPerPrint != null && job.grams != null && job.grams > lim.maxGramsPerPrint && b.force !== true)
          throw new ApiError(403, 'prints.limit_per_print', 'Over the per-print limit', { limit: lim.maxGramsPerPrint, grams: job.grams })
        return sendToPrinter(job, b.confirmBedClear === true).then(() => {
          mockCore.audit('prints.approve', job.fileName, { user: job.username, ...(typeof b.calibrate === 'boolean' && { calibrate: b.calibrate }) })
          return job
        })
      } else {
        job.state = 'rejected'
        job.reason = String(b.reason ?? '').trim() || undefined
        job.endedAt = now()
        save()
        mockCore.audit('prints.reject', job.fileName, { user: job.username, reason: job.reason })
        mockPublish({ type: 'print.update', data: job }, job.userId == null ? 'admins' : { userId: job.userId, admins: true })
      }
      return job
    }
    if (method === 'DELETE') {
      const u = mockCore.requireUser()
      if (job.userId !== u.id && u.role !== 'admin') throw new ApiError(403, 'auth.forbidden', 'Forbidden')
      if (job.state !== 'pending') throw new ApiError(409, 'prints.not_pending', 'Not pending')
      job.state = 'cancelled'
      job.endedAt = now()
      save()
      mockPublish({ type: 'print.update', data: job }, job.userId == null ? 'admins' : { userId: job.userId, admins: true })
      return undefined
    }
  }
  if (p === '/usage/me') {
    const me = mockCore.requireUser()
    const quotaMb = 2048
    return {
      ...usageFor(me.id),
      storageBytes: st.files.filter((f) => f.ownerId === me.id).reduce((a, f) => a + f.size, 0),
      storageQuotaBytes: me.role === 'admin' ? null : quotaMb * 1024 * 1024,
    }
  }

  // Engine manager
  if (p.startsWith('/admin/engine')) {
    mockCore.requireAdmin()
    const e = st.engine
    e.selected = mockCore.state.settings['engine.selected']
    if (p === '/admin/engine' && method === 'GET') return e
    if (p === '/admin/engine/check') {
      e.lastCheckAt = now()
      e.latest = LATEST
      save()
      return e
    }
    if (p === '/admin/engine/update') {
      if (e.state !== 'idle' && e.state !== 'error') throw new ApiError(409, 'engine.busy', 'Busy')
      if (!e.latest || e.installed?.version === e.latest.version) throw new ApiError(409, 'engine.up_to_date', 'Up to date')
      e.state = 'downloading'
      e.progress = 0
      save()
      setTimeout(runEngineUpdate, 200)
      return e
    }
    if (p === '/admin/engine/rollback') {
      if (!e.previous) throw new ApiError(409, 'engine.no_previous', 'No previous version')
      ;[e.installed, e.previous] = [e.previous, e.installed]
      mockCore.audit('engine.rollback', e.installed?.version ?? null)
      save()
      return e
    }
  }
  return NOT_HANDLED
}

/** Session-aware audience filter used by the fake sockets. */
export function audienceAllows(audience: Audience): boolean {
  const u = mockCore.state.users.find((x) => x.id === mockCore.state.sessionUserId && x.isActive)
  if (!u) return false
  if (audience === 'all') return true
  if (audience === 'admins') return u.role === 'admin'
  return u.id === audience.userId || (!!audience.admins && u.role === 'admin')
}
