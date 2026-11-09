import { MOUSE, type Camera } from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { Nav3dButton, Nav3dPrefs } from '../types'
import { getNavPrefs, onNavPrefs } from './navPrefs'
import { actionFor, BUTTONS, modifierOf, resolveNav, type ResolvedNav } from './navSchemes'

export { NAV3D_SCHEMES, resolveNav, type ResolvedNav } from './navSchemes'

/**
 * Per-user 3D navigation (Account → 3D navigation). One OrbitControls per viewport; a pointerdown listener that runs
 * before OrbitControls' own picks the action from (button + modifier) and rewrites `mouseButtons` for that press.
 * Left click (without drag) always stays "select"; the gizmo keeps working because TransformControls disables the
 * controls while it drags.
 */

const KEY: Record<Nav3dButton, 'LEFT' | 'MIDDLE' | 'RIGHT'> = { left: 'LEFT', middle: 'MIDDLE', right: 'RIGHT' }

export interface NavHandle {
  setPrefs(prefs: Nav3dPrefs | null | undefined): void
  readonly nav: ResolvedNav
  dispose(): void
}

/**
 * Applies the user's scheme to an existing OrbitControls (Prepare viewport, G-code Preview, Live view).
 * `base` = the viewport's own rotate/zoom speeds (multiplied by the user's sensitivity).
 */
export function applyNavigation(controls: OrbitControls, prefs: Nav3dPrefs | null | undefined, base: { rotateSpeed?: number; zoomSpeed?: number } = {}): NavHandle {
  const el = controls.domElement as HTMLElement | null
  const baseRotate = base.rotateSpeed ?? controls.rotateSpeed
  const baseZoom = base.zoomSpeed ?? controls.zoomSpeed
  let nav = resolveNav(prefs)

  const apply = () => {
    controls.rotateSpeed = baseRotate * nav.orbitSpeed
    controls.zoomSpeed = baseZoom * nav.zoomSpeed * (nav.invertWheel ? -1 : 1)
    controls.zoomToCursor = nav.zoomToCursor
  }

  const onDown = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return
    const button = BUTTONS[e.button]
    if (!button) return
    const action = actionFor(nav, button, modifierOf(e))
    // OrbitControls swaps ROTATE <-> PAN while Shift/Ctrl/Meta is held: pre-swap so the result is what we want.
    const swapped = e.shiftKey || e.ctrlKey || e.metaKey
    const code = action === 'zoom' ? MOUSE.DOLLY : action === 'orbit' ? (swapped ? MOUSE.PAN : MOUSE.ROTATE) : action === 'pan' ? (swapped ? MOUSE.ROTATE : MOUSE.PAN) : null
    ;(controls.mouseButtons as Record<string, MOUSE | null>)[KEY[button]] = code
  }

  // Our listener must run before OrbitControls' own pointerdown: re-connect it after ours.
  if (el) {
    controls.disconnect()
    el.addEventListener('pointerdown', onDown)
    controls.connect(el)
  }
  apply()

  return {
    get nav() {
      return nav
    },
    setPrefs(p) {
      nav = resolveNav(p)
      apply()
    },
    dispose() {
      el?.removeEventListener('pointerdown', onDown)
    },
  }
}

/** A ready OrbitControls with the user's scheme (for new viewports). */
export function createCameraControls(camera: Camera, el: HTMLElement, prefs: Nav3dPrefs | null | undefined, opts: { damping?: number } = {}) {
  const controls = new OrbitControls(camera, el)
  controls.enableDamping = true
  controls.dampingFactor = opts.damping ?? 0.14
  controls.screenSpacePanning = true
  const handle = applyNavigation(controls, prefs)
  return {
    controls,
    handle,
    dispose() {
      handle.dispose()
      controls.dispose()
    },
  }
}

/** applyNavigation + follows live changes of the signed-in user's prefs. */
export function bindUserNavigation(controls: OrbitControls, base?: { rotateSpeed?: number; zoomSpeed?: number }): NavHandle {
  const h = applyNavigation(controls, getNavPrefs(), base)
  const off = onNavPrefs((p) => h.setPrefs(p))
  return {
    get nav() {
      return h.nav
    },
    setPrefs: h.setPrefs,
    dispose() {
      off()
      h.dispose()
    },
  }
}
