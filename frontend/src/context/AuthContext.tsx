import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, isUnauthorized } from '../api'
import { resetAvatarDirectory } from '../avatars'
import { setNavPrefs } from '../three/navPrefs'
import type { AccountPatch, AppConfig, User } from '../types'

interface AuthValue {
  /** null until loaded (or when the server cannot be reached; see `loadError`) */
  config: AppConfig | null
  /** undefined = still checking the session, null = signed out */
  user: User | null | undefined
  loading: boolean
  loadError: unknown
  reload: () => Promise<void>
  setUser: (user: User | null) => void
  /** Setup just finished: the server already started a session for the new admin. */
  completeSetup: (user: User) => void
  logout: () => Promise<void>
  updateAccount: (patch: AccountPatch) => Promise<User>
}

async function bootstrap(): Promise<{ config: AppConfig; user: User | null }> {
  const config = await api.config()
  if (!config.setupComplete) return { config, user: null }
  try {
    return { config, user: (await api.me()).user }
  } catch (err) {
    if (isUnauthorized(err)) return { config, user: null }
    throw err
  }
}

const AuthContext = createContext<AuthValue | null>(null)

/** Loads /api/config and the current session (custom hook so it can fetch on mount). */
function useBootstrap() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<unknown>(null)

  const apply = useCallback((p: Promise<{ config: AppConfig; user: User | null }>) => {
    return p.then(
      (r) => {
        setConfig(r.config)
        setUser(r.user)
        setLoadError(null)
        setLoading(false)
      },
      (err: unknown) => {
        setLoadError(err)
        setLoading(false)
      },
    )
  }, [])

  useEffect(() => {
    void apply(bootstrap())
  }, [apply])

  const reload = useCallback(async () => {
    setLoading(true)
    await apply(bootstrap())
  }, [apply])

  return { config, setConfig, user, setUser, loading, loadError, reload }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { config, setConfig, user, setUser, loading, loadError, reload } = useBootstrap()
  // Imperative 3D viewports read the user's navigation scheme from this store
  useEffect(() => setNavPrefs(user?.nav3d), [user])

  const completeSetup = useCallback(
    (u: User) => {
      setConfig((c) => (c ? { ...c, setupComplete: true } : c))
      setUser(u)
    },
    [setConfig, setUser],
  )

  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined)
    resetAvatarDirectory()
    setUser(null)
  }, [setUser])

  const updateAccount = useCallback(async (patch: AccountPatch) => {
    const { user: next } = await api.updateAccount(patch)
    setUser(next)
    return next
  }, [setUser])

  const value = useMemo<AuthValue>(
    () => ({ config, user, loading, loadError, reload, setUser, completeSetup, logout, updateAccount }),
    [config, user, setUser, loading, loadError, reload, completeSetup, logout, updateAccount],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
