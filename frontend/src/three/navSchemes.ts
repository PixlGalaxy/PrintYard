import type { Nav3dBinding, Nav3dButton, Nav3dCustom, Nav3dModifier, Nav3dPrefs, Nav3dPreset, Nav3dView } from '../types'

/** 3D navigation schemes (pure data, no three.js: the Account card imports this). Applied by ./navigation.ts. */

export type Action = 'orbit' | 'pan' | 'zoom'
export interface Mapping {
  orbit: Nav3dBinding[]
  pan: Nav3dBinding[]
  zoom: Nav3dBinding[]
  zoomToCursor: boolean
}

const b = (button: Nav3dButton, modifier: Nav3dModifier = 'none'): Nav3dBinding => ({ button, modifier })

/** Built-in schemes. Wheel always zooms. */
export const NAV3D_SCHEMES: Record<Exclude<Nav3dPreset, 'custom'>, Mapping> = {
  // Creality Print / OrcaSlicer: left orbit, right or middle pan (Shift/Ctrl+left pan too), zoom to cursor
  slicedock: { orbit: [b('left')], pan: [b('right'), b('middle'), b('left', 'shift'), b('left', 'ctrl')], zoom: [], zoomToCursor: true },
  // Tinkercad: right-drag orbit, Shift/Ctrl+right-drag or middle-drag pan, wheel zoom (towards the cursor)
  tinkercad: { orbit: [b('right')], pan: [b('right', 'shift'), b('right', 'ctrl'), b('middle')], zoom: [], zoomToCursor: true },
  // Repetier-Host: left-drag rotates, Shift+left or middle moves the view, wheel zoom (towards the centre).
  // Right-drag moves the object in Repetier; here it pans (objects move with the gizmo).
  repetier: { orbit: [b('left')], pan: [b('left', 'shift'), b('middle'), b('right')], zoom: [], zoomToCursor: false },
  // AutoCAD / Fusion 360: middle pan, Shift+middle orbit, wheel zoom to cursor
  cad: { orbit: [b('middle', 'shift')], pan: [b('middle')], zoom: [], zoomToCursor: true },
  // Blender: middle orbit, Shift+middle pan, Ctrl+middle zoom, wheel zoom
  blender: { orbit: [b('middle')], pan: [b('middle', 'shift')], zoom: [b('middle', 'ctrl')], zoomToCursor: false },
}

export const DEFAULT_CUSTOM: Nav3dCustom = { orbit: b('left'), pan: b('right'), zoom: null, zoomToCursor: true }

export interface ResolvedNav extends Mapping {
  invertWheel: boolean
  orbitSpeed: number
  zoomSpeed: number
  defaultView: Nav3dView
}

const clamp = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(3, Math.max(0.2, v)) : 1)

export function resolveNav(prefs: Nav3dPrefs | null | undefined): ResolvedNav {
  const preset = prefs?.preset ?? 'slicedock'
  let mapping: Mapping
  if (preset === 'custom') {
    const c = prefs?.custom ?? DEFAULT_CUSTOM
    mapping = { orbit: [c.orbit], pan: [c.pan], zoom: c.zoom ? [c.zoom] : [], zoomToCursor: c.zoomToCursor }
  } else {
    mapping = NAV3D_SCHEMES[preset] ?? NAV3D_SCHEMES.slicedock
  }
  return {
    ...mapping,
    invertWheel: prefs?.invertWheel ?? false,
    orbitSpeed: clamp(prefs?.orbitSpeed),
    zoomSpeed: clamp(prefs?.zoomSpeed),
    defaultView: prefs?.defaultView ?? 'iso',
  }
}

export const BUTTONS: Record<number, Nav3dButton> = { 0: 'left', 1: 'middle', 2: 'right' }
export function modifierOf(e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): Nav3dModifier {
  if (e.ctrlKey || e.metaKey) return 'ctrl'
  if (e.shiftKey) return 'shift'
  if (e.altKey) return 'alt'
  return 'none'
}

/** The action a press starts, or null (e.g. a plain left press in a scheme where left only selects). */
export function actionFor(nav: Mapping, button: Nav3dButton, modifier: Nav3dModifier): Action | null {
  const hit = (list: Nav3dBinding[]) => list.some((x) => x.button === button && x.modifier === modifier)
  if (hit(nav.zoom)) return 'zoom'
  if (hit(nav.orbit)) return 'orbit'
  if (hit(nav.pan)) return 'pan'
  return null
}

/** True when a left-drag moves the camera (then "select" is a click without drag). */
export const leftNavigates = (nav: Mapping) => [...nav.orbit, ...nav.pan, ...nav.zoom].some((x) => x.button === 'left')


const sameBinding = (a: Nav3dBinding | null, c: Nav3dBinding | null) => !!a && !!c && a.button === c.button && a.modifier === c.modifier

/** Same rule as the backend: orbit, pan and zoom need different bindings. */
export const customConflict = (c: Nav3dCustom) => sameBinding(c.orbit, c.pan) || sameBinding(c.orbit, c.zoom) || sameBinding(c.pan, c.zoom)
