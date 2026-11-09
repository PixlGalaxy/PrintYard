import { useCallback, useEffect, useState } from 'react'
import { adminApi } from '../../../api'
import { useRealtimeMessage } from '../../../realtime'
import type { PrintJob } from '../../../types'

/** Pending print requests (admins only). Live via `approval.pending` / `print.update`. */
export function usePendingApprovals(enabled: boolean) {
  const [items, setItems] = useState<PrintJob[]>([])

  const reload = useCallback(async () => {
    if (!enabled) return
    try {
      setItems(await adminApi.pendingPrints())
    } catch {
      // badge only; errors surface on the Prints page
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    let alive = true
    adminApi.pendingPrints().then(
      (list) => alive && setItems(list),
      () => undefined,
    )
    return () => {
      alive = false
    }
  }, [enabled])

  useRealtimeMessage('approval.pending', (job) => {
    if (enabled) setItems((cur) => (cur.some((j) => j.id === job.id) ? cur : [...cur, job]))
  })
  useRealtimeMessage('print.update', (job) => {
    if (enabled && job.state !== 'pending') setItems((cur) => cur.filter((j) => j.id !== job.id))
  })

  return { items: enabled ? items : [], reload }
}
