// Global upload queue (borrowed from WebinCloud's useUploadQueue/UploadContext): parallel uploads with
// progress and speed, cancel, retry, and a tray in the corner. Used by the Files page and the Workspace.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, ApiError } from '../../../api'
import { useI18n } from '../../../i18n/I18nContext'
import type { LibraryFile, Visibility } from '../../../types'
import { isAccepted } from './accept'

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'error' | 'cancelled'

export interface UploadItem {
  id: number
  file: File
  visibility: Visibility
  status: UploadStatus
  /** 0..1 */
  progress: number
  /** bytes/s over the last few seconds */
  speed?: number
  error?: string
  result?: LibraryFile
}


const CONCURRENCY = 3
const REFRESH_MS = 250
const SPEED_WINDOW_MS = 3000

type Listener = (file: LibraryFile, itemId: number) => void

interface UploadValue {
  items: UploadItem[]
  running: boolean
  /** Queues files (unsupported types are rejected right away) and starts uploading. */
  add: (files: File[] | FileList, visibility?: Visibility) => UploadItem[]
  cancel: (id?: number) => void
  retry: (id: number) => void
  clear: () => void
  /** Called for every finished upload (Files page refreshes, Workspace adds to scene…). */
  onUploaded: (cb: Listener) => () => void
  /** Resolves with the stored file when the given queue item finishes (rejects on error/cancel). */
  waitFor: (id: number) => Promise<LibraryFile>
}

const UploadContext = createContext<UploadValue | null>(null)

export function UploadProvider({ children }: { children: ReactNode }) {
  const { errorMessage } = useI18n()
  const [items, setItems] = useState<UploadItem[]>([])
  const latest = useRef(items)
  const nextId = useRef(1)
  const controllers = useRef(new Map<number, AbortController>())
  const listeners = useRef(new Set<Listener>())
  const waiters = useRef(new Map<number, { resolve: (f: LibraryFile) => void; reject: (e: unknown) => void }[]>())
  const active = useRef(0)
  const pumpRef = useRef<() => void>(() => undefined)

  useEffect(() => {
    latest.current = items
  }, [items])

  const patch = useCallback((id: number, changes: Partial<UploadItem>) => {
    setItems((cur) => {
      const next = cur.map((it) => (it.id === id ? { ...it, ...changes } : it))
      latest.current = next
      return next
    })
  }, [])

  const settle = (id: number, file: LibraryFile | null, err?: unknown) => {
    for (const w of waiters.current.get(id) ?? []) {
      if (file) w.resolve(file)
      else w.reject(err)
    }
    waiters.current.delete(id)
  }

  const pump = useCallback(() => {
    while (active.current < CONCURRENCY) {
      const item = latest.current.find((it) => it.status === 'queued' && !controllers.current.has(it.id))
      if (!item) return
      const ctrl = new AbortController()
      controllers.current.set(item.id, ctrl)
      active.current++
      patch(item.id, { status: 'uploading', progress: 0, speed: undefined, error: undefined })
      let shownAt = 0
      const samples: { at: number; bytes: number }[] = []
      api
        .uploadFile(item.file, {
          visibility: item.visibility,
          signal: ctrl.signal,
          onProgress: (loaded, total) => {
            const t = performance.now()
            samples.push({ at: t, bytes: loaded })
            while (samples.length > 1 && t - samples[0].at > SPEED_WINDOW_MS) samples.shift()
            // Always show the last event (all bytes sent → the row switches to "Processing…")
            if (t - shownAt < REFRESH_MS && loaded < (total || item.file.size)) return
            shownAt = t
            const first = samples[0]
            const speed = t > first.at ? ((loaded - first.bytes) / (t - first.at)) * 1000 : undefined
            patch(item.id, { progress: (total || item.file.size) ? Math.min(1, loaded / (total || item.file.size)) : 0, speed })
          },
        })
        .then(
          (file) => {
            patch(item.id, { status: 'done', progress: 1, speed: undefined, result: file })
            settle(item.id, file)
            for (const l of listeners.current) l(file, item.id)
          },
          (err: unknown) => {
            const aborted = ctrl.signal.aborted
            patch(item.id, aborted ? { status: 'cancelled', progress: 0, speed: undefined } : { status: 'error', error: errorMessage(err), speed: undefined })
            settle(item.id, null, err)
          },
        )
        .finally(() => {
          controllers.current.delete(item.id)
          active.current--
          pumpRef.current()
        })
    }
  }, [errorMessage, patch])
  useEffect(() => {
    pumpRef.current = pump
  }, [pump])

  const add = useCallback(
    (files: File[] | FileList, visibility: Visibility = 'private') => {
      const fresh: UploadItem[] = Array.from(files).map((file) => {
        const ok = isAccepted(file.name)
        return {
          id: nextId.current++,
          file,
          visibility,
          status: ok ? 'queued' : 'error',
          progress: 0,
          error: ok ? undefined : errorMessage(new ApiError(400, 'files.unsupported_type', 'Unsupported file type')),
        }
      })
      const next = [...latest.current, ...fresh]
      latest.current = next
      setItems(next)
      queueMicrotask(pump)
      return fresh
    },
    [errorMessage, pump],
  )

  const cancel = useCallback(
    (id?: number) => {
      for (const it of latest.current) {
        if (id !== undefined && it.id !== id) continue
        if (it.status === 'queued') {
          patch(it.id, { status: 'cancelled' })
          settle(it.id, null, new DOMException('Aborted', 'AbortError'))
        }
        controllers.current.get(it.id)?.abort()
      }
    },
    [patch],
  )

  const retry = useCallback(
    (id: number) => {
      patch(id, { status: 'queued', progress: 0, error: undefined })
      queueMicrotask(pump)
    },
    [patch, pump],
  )

  const clear = useCallback(() => {
    setItems((cur) => {
      const next = cur.filter((it) => it.status === 'uploading' || it.status === 'queued')
      latest.current = next
      return next
    })
  }, [])

  const onUploaded = useCallback((cb: Listener) => {
    listeners.current.add(cb)
    return () => void listeners.current.delete(cb)
  }, [])

  const waitFor = useCallback((id: number) => {
    const it = latest.current.find((x) => x.id === id)
    if (it?.status === 'done' && it.result) return Promise.resolve(it.result)
    return new Promise<LibraryFile>((resolve, reject) => {
      const list = waiters.current.get(id) ?? []
      list.push({ resolve, reject })
      waiters.current.set(id, list)
    })
  }, [])

  const running = items.some((it) => it.status === 'uploading' || it.status === 'queued')

  // Leaving the page mid-upload loses the files: ask the browser to confirm
  useEffect(() => {
    if (!running) return
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [running])

  const value = useMemo<UploadValue>(
    () => ({ items, running, add, cancel, retry, clear, onUploaded, waitFor }),
    [items, running, add, cancel, retry, clear, onUploaded, waitFor],
  )
  return <UploadContext.Provider value={value}>{children}</UploadContext.Provider>
}

export function useUploads() {
  const ctx = useContext(UploadContext)
  if (!ctx) throw new Error('useUploads must be used within UploadProvider')
  return ctx
}
