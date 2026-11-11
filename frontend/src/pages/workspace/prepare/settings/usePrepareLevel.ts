// The signed-in user's Prepare settings level: their own choice (saved on the account), else the admin default.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../../../../context/AuthContext'
import { useToast } from '../../../../context/ToastContext'
import type { PrepareLevel } from '../../../../types'
import { isPrepareLevel } from './levels'

/** Old per-browser Simple/Pro switch (before levels were saved on the account). */
const LEGACY_KEY = 'sd:ws:mode'

function takeLegacyMode(): string | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (raw === null) return null
    localStorage.removeItem(LEGACY_KEY)
    return JSON.parse(raw) as string
  } catch {
    return null
  }
}

export function usePrepareLevel(): [PrepareLevel, (level: PrepareLevel) => void] {
  const { user, config, updateAccount } = useAuth()
  const { onError } = useToast()
  const [pending, setPending] = useState<PrepareLevel | null>(null)
  const seq = useRef(0)

  const saved = isPrepareLevel(user?.prepareLevel) ? user.prepareLevel : null
  const fallback = config?.workspace?.defaultLevel
  const level: PrepareLevel = pending ?? saved ?? (isPrepareLevel(fallback) ? fallback : 'basic')

  const change = useCallback(
    (next: PrepareLevel) => {
      const id = ++seq.current
      setPending(next)
      updateAccount({ prepareLevel: next }).then(
        () => id === seq.current && setPending(null),
        (err: unknown) => {
          if (id !== seq.current) return
          setPending(null)
          onError(err)
        },
      )
    },
    [onError, updateAccount],
  )

  // One-time migration of the old local "Pro" choice to the account (only when the user has not saved a level).
  const migrated = useRef(false)
  useEffect(() => {
    if (!user || migrated.current) return
    migrated.current = true
    const legacy = takeLegacyMode()
    if (legacy === 'pro' && user.prepareLevel == null) updateAccount({ prepareLevel: 'expert' }).catch(() => undefined)
  }, [user, updateAccount])

  return [level, change]
}
