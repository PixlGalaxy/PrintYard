import { useCallback, useEffect, useRef, useState } from 'react'
import { isUnauthorized } from './api'
import { useToast } from './context/ToastContext'

/** useState persisted in localStorage (falls back to memory if storage is unavailable). */
export function useStoredState<T>(key: string, initial: T | (() => T)) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw !== null) return JSON.parse(raw) as T
    } catch {
      // storage blocked or invalid JSON
    }
    return typeof initial === 'function' ? (initial as () => T)() : initial
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // ignore
    }
  }, [key, value])

  return [value, setValue] as const
}

/** Calls `fn` now and every `ms` while the tab is visible (pass `ms = 0` to only call once). */
export function usePolling(fn: () => Promise<void> | void, ms: number) {
  const ref = useRef(fn)
  useEffect(() => {
    ref.current = fn
  }, [fn])
  useEffect(() => {
    let inFlight = false
    const tick = async () => {
      if (inFlight || document.visibilityState !== 'visible') return
      inFlight = true
      try {
        await ref.current()
      } finally {
        inFlight = false
      }
    }
    void tick()
    if (!ms) return
    const t = setInterval(tick, ms)
    return () => clearInterval(t)
  }, [ms])
}

/**
 * Loads data once (and on `reload()`); errors are kept for an inline error state.
 * A 401 also goes through the toast handler, which signs the user out.
 */
export function useLoader<T>(fn: () => Promise<T>) {
  const { onError } = useToast()
  const fnRef = useRef(fn)
  useEffect(() => {
    fnRef.current = fn
  }, [fn])
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<unknown>(null)

  const reload = useCallback(async () => {
    try {
      setData(await fnRef.current())
      setError(null)
    } catch (err) {
      if (isUnauthorized(err)) onError(err)
      setError(err)
    }
  }, [onError])

  useEffect(() => {
    void reload()
  }, [reload])

  return { data, error, reload, setData }
}
