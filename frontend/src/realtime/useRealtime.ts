import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api } from '../api'
import type { PrinterStatus, ServerMessage } from '../types'
import { realtime, type DataOf, type MessageType, type RealtimeState } from './client'

/** Connection state of the shared socket ('idle' | 'connecting' | 'open' | 'closed'). */
export function useRealtimeState(): RealtimeState {
  return useSyncExternalStore(
    (cb) => realtime.onState(cb),
    () => realtime.state,
  )
}

/**
 * Runs `handler` for every server message of `type` (the latest handler is always used,
 * so inline callbacks are fine). Keeps the socket open while mounted.
 *   useRealtimeMessage('slice.job', (job) => …)
 */
export function useRealtimeMessage<T extends MessageType>(type: T, handler: (data: DataOf<T>) => void) {
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  }, [handler])
  useEffect(
    () =>
      realtime.listen((msg) => {
        if (msg.type === type && 'data' in msg) (ref.current as (d: unknown) => void)(msg.data)
      }),
    [type],
  )
}

/**
 * General hook: subscribes to `printers` while mounted, calls `onMessage` for every message.
 *   const { state } = useRealtime({ printers: [1], onMessage: (m) => … })
 */
export function useRealtime(options: { printers?: number[]; onMessage?: (msg: ServerMessage) => void } = {}) {
  const state = useRealtimeState()
  const ref = useRef(options.onMessage)
  useEffect(() => {
    ref.current = options.onMessage
  }, [options.onMessage])
  useEffect(() => realtime.listen((m) => ref.current?.(m)), [])
  const key = (options.printers ?? []).join(',')
  useEffect(() => {
    if (!key) return
    const offs = key.split(',').map((id) => realtime.watchPrinter(Number(id)))
    return () => offs.forEach((off) => off())
  }, [key])
  return { state, send: (m: Parameters<typeof realtime.send>[0]) => realtime.send(m), reconnect: () => realtime.reconnectNow() }
}

/**
 * Live status of one printer: seeded from `GET /api/printers/:id/status`, then kept up to date by
 * `printer.status` messages. `null` until the first value arrives (or when `printerId` is null).
 */
export function usePrinterStatus(printerId: number | null | undefined): PrinterStatus | null {
  const [status, setStatus] = useState<PrinterStatus | null>(null)
  const [forId, setForId] = useState(printerId)
  // Reset when the printer changes (render-time state adjustment, no effect needed)
  if (forId !== printerId) {
    setForId(printerId)
    setStatus(null)
  }

  useEffect(() => {
    if (printerId == null) return
    let alive = true
    api.printerStatus(printerId).then(
      (s) => {
        // Don't overwrite a newer pushed value with the (older) HTTP snapshot
        if (alive) setStatus((cur) => (cur && cur.updatedAt >= s.updatedAt ? cur : s))
      },
      () => undefined,
    )
    const offWatch = realtime.watchPrinter(printerId)
    const offListen = realtime.listen((msg) => {
      if (msg.type === 'printer.status' && msg.data.printerId === printerId) setStatus(msg.data)
    })
    return () => {
      alive = false
      offWatch()
      offListen()
    }
  }, [printerId])

  return printerId == null ? null : status
}
