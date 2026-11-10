// Client-rendered library thumbnails for models (STL/OBJ/3MF have no embedded picture). Rendered right after a model
// is parsed in Prepare, and lazily backfilled for models a list shows without one. One background queue
// (concurrency 1); each file is tried once per session. Results go to `PUT /api/files/:id/thumbnail` and are shown at
// once through `useThumbUrl` (the lists may still carry the old `thumbnailUrl: null`).
import { useEffect, useSyncExternalStore } from 'react'
import type { BufferGeometry } from 'three'
import { api } from '../api'
import type { LibraryFile, User } from '../types'
// three.js (renderer + mesh worker) is loaded on first use, so the Files page does not pull it in up front

const MAX_BACKFILL_BYTES = 50 * 1024 * 1024
const MODEL_EXTS = new Set(['stl', 'obj', '3mf'])

/** file id → thumbnail URL rendered in this session */
const urls = new Map<number, string>()
/** queued, running or already tried (never retried in a loop) */
const tried = new Set<number>()
const listeners = new Set<() => void>()
let version = 0
const emit = () => {
  version++
  for (const l of listeners) l()
}

type Task = { file: LibraryFile; geometry?: BufferGeometry }
const queue: Task[] = []
let running = false

function accentColor(): string {
  const v = typeof document !== 'undefined' ? getComputedStyle(document.documentElement).getPropertyValue('--accent-500').trim() : ''
  return /^#[0-9a-f]{3,8}$/i.test(v) ? v : '#0ea5e9'
}

/** The name with its real extension (a renamed file may have lost it; the parser sniffs by name for OBJ). */
const parseName = (f: LibraryFile) => (f.name.toLowerCase().endsWith(`.${f.ext}`) ? f.name : `${f.name}.${f.ext}`)

async function runTask({ file, geometry }: Task) {
  const [{ renderModelThumbnail }, { meshes }] = await Promise.all([import('../three/modelThumbnail'), import('./meshes')])
  let geo = geometry ?? meshes.info(file.id)?.geometry ?? null
  let detached = false
  if (!geo) {
    const buf = await (await api.fileContent(file.id)).arrayBuffer()
    geo = (await meshes.parseDetached(parseName(file), buf)).geometry
    detached = true
  }
  try {
    const png = await renderModelThumbnail(geo, accentColor(), 256)
    const saved = await api.setFileThumbnail(file.id, png)
    urls.set(file.id, saved.thumbnailUrl ?? `data:image/png;base64,${png}`)
    emit()
  } finally {
    if (detached) geo.dispose()
  }
}

async function pump() {
  if (running) return
  running = true
  try {
    for (let task = queue.shift(); task; task = queue.shift()) {
      try {
        await runTask(task)
      } catch {
        /* best effort: the kind icon stays */
      }
      // Yield between files so a long backfill never hogs the main thread
      await new Promise((r) => setTimeout(r, 50))
    }
  } finally {
    running = false
  }
}

export const modelThumbs = {
  /** A model was just parsed (import / add from library) and has no thumbnail yet: render it from that mesh. */
  fromMesh(file: LibraryFile, geometry: BufferGeometry) {
    if (file.kind !== 'model' || file.thumbnailUrl || tried.has(file.id)) return
    tried.add(file.id)
    queue.unshift({ file, geometry })
    void pump()
  },
  /** Queues the models in `files` that have no thumbnail and that `viewer` may write (owner or admin). */
  backfill(files: readonly LibraryFile[], viewer: Pick<User, 'id' | 'role'> | null | undefined) {
    if (!viewer) return
    let added = false
    for (const f of files) {
      if (f.kind !== 'model' || f.thumbnailUrl || tried.has(f.id) || !MODEL_EXTS.has(f.ext.toLowerCase())) continue
      if (f.size > MAX_BACKFILL_BYTES || (f.ownerId !== viewer.id && viewer.role !== 'admin')) continue
      tried.add(f.id)
      queue.push({ file: f })
      added = true
    }
    if (added) void pump()
  },
  url: (f: Pick<LibraryFile, 'id' | 'thumbnailUrl'>) => f.thumbnailUrl ?? urls.get(f.id) ?? null,
  subscribe(cb: () => void) {
    listeners.add(cb)
    return () => void listeners.delete(cb)
  },
}

/** `file.thumbnailUrl`, or the one rendered in this session. */
export function useThumbUrl(f: Pick<LibraryFile, 'id' | 'thumbnailUrl'>): string | null {
  useSyncExternalStore(modelThumbs.subscribe, () => version)
  return modelThumbs.url(f)
}

/** Backfills missing model thumbnails for a shown list (in the background, once per file). */
export function useThumbnailBackfill(files: readonly LibraryFile[] | null, viewer: Pick<User, 'id' | 'role'> | null | undefined) {
  const id = viewer?.id
  const role = viewer?.role
  useEffect(() => {
    if (files && id != null && role) modelThumbs.backfill(files, { id, role })
  }, [files, id, role])
}
