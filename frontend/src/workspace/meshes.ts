// Loaded meshes, keyed by library file id (negative ids = local files still uploading).
// Geometry is built once per file and shared by every object that uses it (duplicates are free).
import { BufferAttribute, BufferGeometry, Vector3 } from 'three'
import { api } from '../api'
import type { MeshWorkerRequest, MeshWorkerResponse, WorkerFacet } from './meshTypes'

export interface MeshInfo {
  geometry: BufferGeometry
  triangles: number
  /** mm³ */
  volume: number
  /** raw bounding box (file coordinates) */
  min: Vector3
  max: Vector3
  center: Vector3
  size: Vector3
  /** convex hull points, file coordinates */
  hull: Float32Array
  facets: WorkerFacet[]
}

export type MeshEntry = { state: 'loading' } | { state: 'ready'; info: MeshInfo } | { state: 'error'; error: string }

const cache = new Map<number, MeshEntry>()
const listeners = new Set<() => void>()
let version = 0

const emit = () => {
  version++
  for (const l of listeners) l()
}

export const meshes = {
  get version() {
    return version
  },
  subscribe(cb: () => void) {
    listeners.add(cb)
    return () => void listeners.delete(cb)
  },
  get(fileId: number): MeshEntry | undefined {
    return cache.get(fileId)
  },
  info(fileId: number): MeshInfo | null {
    const e = cache.get(fileId)
    return e?.state === 'ready' ? e.info : null
  },
  /** Parse local bytes (drag & drop) under a (temporary) id. */
  async parse(fileId: number, name: string, buffer: ArrayBuffer): Promise<MeshInfo> {
    cache.set(fileId, { state: 'loading' })
    emit()
    try {
      const info = await runWorker(name, buffer)
      cache.set(fileId, { state: 'ready', info })
      emit()
      return info
    } catch (err) {
      cache.set(fileId, { state: 'error', error: err instanceof Error ? err.message : String(err) })
      emit()
      throw err
    }
  },
  /** Load a library file's mesh (once). */
  ensure(fileId: number, name: string): Promise<MeshInfo> {
    const e = cache.get(fileId)
    if (e?.state === 'ready') return Promise.resolve(e.info)
    const pending = inflight.get(fileId)
    if (pending) return pending
    const p = (async () => {
      cache.set(fileId, { state: 'loading' })
      emit()
      try {
        const buf = await (await api.fileContent(fileId)).arrayBuffer()
        return await meshes.parse(fileId, name, buf)
      } catch (err) {
        cache.set(fileId, { state: 'error', error: err instanceof Error ? err.message : String(err) })
        emit()
        throw err
      } finally {
        inflight.delete(fileId)
      }
    })()
    inflight.set(fileId, p)
    return p
  },
  /** Parses bytes in the worker pool WITHOUT caching (background thumbnails); the caller disposes the geometry. */
  parseDetached(name: string, buffer: ArrayBuffer): Promise<MeshInfo> {
    return runWorker(name, buffer)
  },
  /** A temporary id finished uploading: the same mesh is now known under the real id. */
  alias(from: number, to: number) {
    const e = cache.get(from)
    if (e) cache.set(to, e)
    emit()
  },
  drop(fileId: number) {
    const e = cache.get(fileId)
    if (e?.state === 'ready' && ![...cache.entries()].some(([id, x]) => id !== fileId && x === e)) e.info.geometry.dispose()
    cache.delete(fileId)
    emit()
  },
}

const inflight = new Map<number, Promise<MeshInfo>>()

// ---------- worker pool ----------

const POOL = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1))
const workers: Worker[] = []
const busy = new Set<Worker>()
const queue: (() => void)[] = []
let nextJob = 1

function getWorker(): Promise<Worker> {
  const free = workers.find((w) => !busy.has(w))
  if (free) return Promise.resolve(free)
  if (workers.length < POOL) {
    const w = new Worker(new URL('./mesh.worker.ts', import.meta.url), { type: 'module' })
    workers.push(w)
    return Promise.resolve(w)
  }
  return new Promise((resolve) => queue.push(() => resolve(getWorker())))
}

async function runWorker(name: string, buffer: ArrayBuffer): Promise<MeshInfo> {
  const w = await getWorker()
  busy.add(w)
  const id = nextJob++
  try {
    const res = await new Promise<MeshWorkerResponse>((resolve, reject) => {
      const onMsg = (ev: MessageEvent<MeshWorkerResponse>) => {
        if (ev.data.id !== id) return
        w.removeEventListener('message', onMsg)
        w.removeEventListener('error', onErr)
        resolve(ev.data)
      }
      const onErr = (ev: ErrorEvent) => {
        w.removeEventListener('message', onMsg)
        w.removeEventListener('error', onErr)
        reject(new Error(ev.message || 'mesh.worker_failed'))
      }
      w.addEventListener('message', onMsg)
      w.addEventListener('error', onErr)
      const req: MeshWorkerRequest = { id, name, buffer }
      w.postMessage(req, [buffer])
    })
    if (!res.ok) throw new Error(res.error)
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(res.positions, 3))
    geometry.setAttribute('normal', new BufferAttribute(res.normals, 3))
    const min = new Vector3(...res.min)
    const max = new Vector3(...res.max)
    geometry.boundingBox = null
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    return {
      geometry,
      triangles: res.triangles,
      volume: res.volume,
      min,
      max,
      center: min.clone().add(max).multiplyScalar(0.5),
      size: max.clone().sub(min),
      hull: res.hull,
      facets: res.facets,
    }
  } finally {
    busy.delete(w)
    queue.shift()?.()
  }
}
