// Slice runs: one job per plate (POST /api/slice), progress from the WebSocket (`slice.job`) with a polling
// fallback, cancel, and the final results. UI reads it with `useSlicing()`.
import { useSyncExternalStore } from 'react'
import { api } from '../api'
import { realtime } from '../realtime'
import type { SceneDoc, SliceJob } from '../types'
import { env } from './ops'

export interface SliceRun {
  id: number
  plates: number[]
  jobs: Record<number, SliceJob | undefined>
  /** error before a job existed (e.g. engine not installed) */
  error: unknown
  finished: boolean
}

const TERMINAL = new Set(['done', 'failed', 'cancelled'])
let run: SliceRun | null = null
const listeners = new Set<() => void>()
let pollTimer: ReturnType<typeof setInterval> | null = null
let stopListen: (() => void) | null = null
let nextRun = 1

function set(next: SliceRun | null) {
  run = next
  for (const l of listeners) l()
}

function patchJob(job: SliceJob) {
  if (!run) return
  const plate = run.plates.find((p) => run!.jobs[p]?.id === job.id)
  if (plate === undefined) return
  const prev = run.jobs[plate]
  // Ignore stale updates (polling can race the socket)
  if (prev && TERMINAL.has(prev.state) && !TERMINAL.has(job.state)) return
  const jobs = { ...run.jobs, [plate]: job }
  const finished = run.plates.every((p) => jobs[p] && TERMINAL.has(jobs[p]!.state))
  set({ ...run, jobs, finished })
  if (finished) stopWatching()
}

function startWatching() {
  stopWatching()
  stopListen = realtime.listen((msg) => {
    if (msg.type === 'slice.job') patchJob(msg.data)
  })
  pollTimer = setInterval(() => {
    if (!run) return
    for (const p of run.plates) {
      const j = run.jobs[p]
      if (j && !TERMINAL.has(j.state)) api.sliceJob(j.id).then(patchJob, () => undefined)
    }
  }, 1500)
}

function stopWatching() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  stopListen?.()
  stopListen = null
}

export const slicing = {
  get run() {
    return run
  },
  subscribe(cb: () => void) {
    listeners.add(cb)
    return () => void listeners.delete(cb)
  },
  /** Starts slicing the given plates (sequential POSTs; the server queues them). */
  async start(doc: SceneDoc, plates: number[]) {
    if (run && !run.finished) return
    const id = nextRun++
    set({ id, plates, jobs: {}, error: null, finished: false })
    startWatching()
    for (const plate of plates) {
      const vp = env.viewport
      const thumbnails = vp ? { small: vp.renderThumbnail(plate, 96), large: vp.renderThumbnail(plate, 300) } : { small: '', large: '' }
      try {
        const job = await api.sliceStart({ scene: doc, plate, thumbnails })
        if (!run || run.id !== id) return
        set({ ...run, jobs: { ...run.jobs, [plate]: job } })
        patchJob(job)
      } catch (error) {
        if (!run || run.id !== id) return
        stopWatching()
        set({ ...run, error, finished: true })
        return
      }
    }
  },
  async cancel() {
    if (!run) return
    const active = run.plates.map((p) => run!.jobs[p]).filter((j): j is SliceJob => !!j && !TERMINAL.has(j.state))
    await Promise.allSettled(active.map((j) => api.sliceCancel(j.id)))
    if (run) {
      const jobs = { ...run.jobs }
      for (const p of run.plates) {
        const j = jobs[p]
        if (!j || !TERMINAL.has(j.state)) jobs[p] = { ...(j ?? { id: '', plate: p, createdAt: Date.now(), progress: 0 }), state: 'cancelled' } as SliceJob
      }
      stopWatching()
      set({ ...run, jobs, finished: true })
    }
  },
  dismiss() {
    if (run && !run.finished) return
    stopWatching()
    set(null)
  },
}

export function useSlicing() {
  return useSyncExternalStore(slicing.subscribe, () => run)
}

/** Overall progress 0..100 across the run's plates. */
export function runProgress(r: SliceRun) {
  if (!r.plates.length) return 0
  return r.plates.reduce((s, p) => {
    const j = r.jobs[p]
    return s + (j ? (j.state === 'done' ? 100 : j.progress) : 0)
  }, 0) / r.plates.length
}
