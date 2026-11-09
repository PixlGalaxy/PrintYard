import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useStoredState } from '../hooks'
import { useRealtimeMessage } from '../realtime'
import { DEFAULT_MODE, DEFAULT_SKIN, isSkin, isThemeMode } from '../theme/skins'
import type { AppearanceDefaults, Skin, Theme, ThemeMode } from '../types'
import { useAuth } from './AuthContext'

export interface AppearanceChoice {
  /** null = use the admin default */
  themeMode?: ThemeMode | null
  skin?: Skin | null
}

interface ThemeValue {
  /** Effective mode (user choice → admin default). Kept as `theme` for older callers. */
  theme: Theme
  /** What is actually shown once "system" is resolved */
  resolved: 'light' | 'dark'
  /** The signed-in user's own choices (null = inherit); null when signed out */
  themeMode: ThemeMode | null
  skin: Skin | null
  /** Effective accent skin */
  effectiveSkin: Skin
  /** Global defaults (Admin → Settings → Appearance) */
  defaults: AppearanceDefaults
  /** Sets the mode explicitly (signed out: remembered on this device only). */
  setTheme: (theme: Theme) => Promise<void>
  /** Saves mode and/or skin on the account (null = back to the default). */
  setAppearance: (choice: AppearanceChoice) => Promise<void>
  /** Admin just saved new defaults (realtime also delivers them). */
  setDefaults: (defaults: AppearanceDefaults) => void
}

const ThemeContext = createContext<ThemeValue | null>(null)
const media = () => window.matchMedia('(prefers-color-scheme: dark)')

const validDefaults = (d: unknown): AppearanceDefaults | null => {
  const v = d as Partial<AppearanceDefaults> | null | undefined
  return v && isThemeMode(v.defaultMode) && isSkin(v.defaultSkin) ? { defaultMode: v.defaultMode, defaultSkin: v.defaultSkin } : null
}

/** Listens for `appearance.defaults` while signed in (mounted only then, so it never opens a socket signed out). */
function LiveDefaults({ onChange }: { onChange: (d: AppearanceDefaults) => void }) {
  useRealtimeMessage('appearance.defaults', (d) => {
    const v = validDefaults(d)
    if (v) onChange(v)
  })
  return null
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { user, config, updateAccount } = useAuth()
  // Effective values applied last time: read by /theme.js before first paint (no flash)
  const [cachedMode, setCachedMode] = useStoredState<ThemeMode>('sd:theme', DEFAULT_MODE)
  const [cachedSkin, setCachedSkin] = useStoredState<Skin>('sd:skin', DEFAULT_SKIN)
  // Last known global defaults (used until /api/config answers)
  const [cachedDefaults, setCachedDefaults] = useStoredState<AppearanceDefaults | null>('sd:appearanceDefaults', null)
  // A signed-out visitor's own pick from the public pages' toggle (else the global default)
  const [guestMode, setGuestMode] = useStoredState<ThemeMode | null>('sd:guestTheme', null)
  // Pushed by the server after an admin change; only valid for the config it was received with
  const [live, setLive] = useState<{ base: AppearanceDefaults | undefined; value: AppearanceDefaults } | null>(null)
  const liveDefaults = live && live.base === config?.appearance ? live.value : null
  const setLiveDefaults = useCallback(
    (value: AppearanceDefaults) => setLive({ base: config?.appearance, value }),
    [config?.appearance],
  )
  // Optimistic choice while PATCH /api/account is in flight (instant preview)
  const [pending, setPending] = useState<AppearanceChoice | null>(null)
  const [systemDark, setSystemDark] = useState(() => media().matches)

  const defaults: AppearanceDefaults = useMemo(
    () =>
      liveDefaults ??
      validDefaults(config?.appearance) ??
      validDefaults(cachedDefaults) ?? { defaultMode: DEFAULT_MODE, defaultSkin: DEFAULT_SKIN },
    [liveDefaults, config?.appearance, cachedDefaults],
  )

  useEffect(() => {
    if (JSON.stringify(cachedDefaults) !== JSON.stringify(defaults)) setCachedDefaults(defaults)
  }, [defaults, cachedDefaults, setCachedDefaults])

  const pick = <K extends keyof AppearanceChoice>(key: K, current: AppearanceChoice[K]) =>
    pending && key in pending ? pending[key] : current
  const themeMode = user ? ((pick('themeMode', user.themeMode ?? null) as ThemeMode | null | undefined) ?? null) : null
  const skin = user ? ((pick('skin', user.skin ?? null) as Skin | null | undefined) ?? null) : null
  const validMode = isThemeMode(themeMode) ? themeMode : null
  const validSkin = isSkin(skin) ? skin : null

  // user === undefined: session still loading → keep what /theme.js painted (no flash for signed-in users)
  const loadingSession = user === undefined
  const effectiveMode: ThemeMode = loadingSession
    ? isThemeMode(cachedMode) ? cachedMode : DEFAULT_MODE
    : user ? (validMode ?? defaults.defaultMode) : isThemeMode(guestMode) ? guestMode : defaults.defaultMode
  const effectiveSkin: Skin = loadingSession
    ? isSkin(cachedSkin) ? cachedSkin : DEFAULT_SKIN
    : user ? (validSkin ?? defaults.defaultSkin) : defaults.defaultSkin
  const resolved = effectiveMode === 'system' ? (systemDark ? 'dark' : 'light') : effectiveMode

  useEffect(() => {
    const m = media()
    const onChange = () => setSystemDark(m.matches)
    m.addEventListener('change', onChange)
    return () => m.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', resolved === 'dark')
    root.dataset.skin = effectiveSkin
    setCachedMode(effectiveMode)
    setCachedSkin(effectiveSkin)
  }, [resolved, effectiveMode, effectiveSkin, setCachedMode, setCachedSkin])

  const setAppearance = useCallback(
    async (choice: AppearanceChoice) => {
      if (!user) {
        if (choice.themeMode !== undefined) setGuestMode(choice.themeMode)
        return
      }
      setPending((p) => ({ ...p, ...choice }))
      try {
        await updateAccount(choice)
      } finally {
        setPending(null)
      }
    },
    [user, updateAccount, setGuestMode],
  )

  const setTheme = useCallback((next: Theme) => setAppearance({ themeMode: next }), [setAppearance])

  const value = useMemo<ThemeValue>(
    () => ({
      theme: effectiveMode,
      resolved,
      themeMode: validMode,
      skin: validSkin,
      effectiveSkin,
      defaults,
      setTheme,
      setAppearance,
      setDefaults: setLiveDefaults,
    }),
    [effectiveMode, resolved, validMode, validSkin, effectiveSkin, defaults, setTheme, setAppearance, setLiveDefaults],
  )
  return (
    <ThemeContext.Provider value={value}>
      {user && <LiveDefaults onChange={setLiveDefaults} />}
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
