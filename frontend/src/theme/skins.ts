import type { Skin, ThemeMode } from '../types'
import { SKINS, THEME_MODES } from '../types'

export const DEFAULT_MODE: ThemeMode = 'system'
export const DEFAULT_SKIN: Skin = 'sky'

export const isThemeMode = (v: unknown): v is ThemeMode => THEME_MODES.includes(v as ThemeMode)
export const isSkin = (v: unknown): v is Skin => SKINS.includes(v as Skin)

/** Preview dots (accent 300 / 500 / 700) for the swatch picker — same values as the [data-skin] blocks in index.css. */
export const SKIN_DOTS: Record<Skin, [string, string, string]> = {
  sky: ['#7dd3fc', '#0ea5e9', '#0369a1'],
  indigo: ['#a5b4fc', '#6366f1', '#4338ca'],
  ocean: ['#67e8f9', '#06b6d4', '#0e7490'],
  sunset: ['#fdba74', '#f97316', '#c2410c'],
  forest: ['#6ee7b7', '#10b981', '#047857'],
  grape: ['#c4b5fd', '#8b5cf6', '#6d28d9'],
  crimson: ['#fda4af', '#f43f5e', '#be123c'],
  solar: ['#fcd34d', '#f59e0b', '#b45309'],
  mint: ['#5eead4', '#14b8a6', '#0f766e'],
  blossom: ['#f0abfc', '#d946ef', '#a21caf'],
  ares: ['#fca5a5', '#ef4444', '#b91c1c'],
  poseidon: ['#93c5fd', '#3b82f6', '#1d4ed8'],
  zeus: ['#fde047', '#eab308', '#a16207'],
  jade: ['#86efac', '#22c55e', '#15803d'],
  verdigris: ['#bef264', '#84cc16', '#4d7c0f'],
  nebula: ['#d8b4fe', '#a855f7', '#7e22ce'],
  sakura: ['#f9a8d4', '#ec4899', '#be185d'],
  slate: ['#cbd5e1', '#64748b', '#334155'],
  mono: ['#d1d5db', '#6b7280', '#374151'],
  graphite: ['#d4d4d8', '#71717a', '#3f3f46'],
  ash: ['#d4d4d4', '#737373', '#404040'],
  terracotta: ['#d6d3d1', '#78716c', '#44403c'],
  olive: ['#c2df90', '#8cbe37', '#608226'],
  maroon: ['#d8979d', '#b1434c', '#7a2e35'],
}

/** i18n key of a skin's display name. */
export const skinLabelKey = (skin: Skin) => `appearance.skin.${skin}` as const
