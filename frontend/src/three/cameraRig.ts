// Camera moves for the view cube, shared by the Prepare viewport and the G-code renderer (Preview, Live view).
// Both use a Z-up OrbitControls, so the camera orientation is fully defined by its direction from the target
// (azimuth θ around Z, polar φ from +Z). Animations interpolate θ/φ (not positions): a 180° turn orbits around
// the target instead of passing through it, and top/bottom "rolls" animate as an azimuth turn.
import { Matrix4, Vector3, type PerspectiveCamera } from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

/** Polar offset used for exact top/bottom views (OrbitControls needs a defined azimuth there). */
const POLE = 1e-4
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

/** Camera target for the view cube (implemented by Viewport and GcodeRenderer). */
export interface CubeCamera {
  /** Animates to look from `dir` (world, target → camera), keeping target and distance. `up` = screen-up hint for top/bottom views. */
  lookFrom(dir: Vector3, up?: Vector3): void
  /** Orbits by azimuth/polar deltas (radians), no animation (cube drag). */
  orbitBy(dTheta: number, dPhi: number): void
  /** Current rotation of the view matrix (initial cube orientation). */
  viewRotation(): Matrix4
}

export class CameraRig implements CubeCamera {
  private anim: { start: number; ms: number; th0: number; ph0: number; th1: number; ph1: number; dist: number } | null = null
  private readonly view = new Matrix4()
  private readonly camera: PerspectiveCamera
  private readonly controls: OrbitControls
  private readonly invalidate: () => void

  constructor(camera: PerspectiveCamera, controls: OrbitControls, invalidate: () => void) {
    this.camera = camera
    this.controls = controls
    this.invalidate = invalidate
    // Any user navigation in the main view stops a running cube animation
    controls.addEventListener('start', this.cancel)
  }

  cancel = () => {
    this.anim = null
  }

  private offset() {
    return this.camera.position.clone().sub(this.controls.target)
  }

  lookFrom(dir: Vector3, up?: Vector3, ms = 300) {
    const off = this.offset()
    const dist = off.length() || 1
    const th0 = Math.atan2(off.y, off.x)
    const ph0 = Math.acos(Math.min(1, Math.max(-1, off.z / dist)))
    const d = dir.clone().normalize()
    let th1: number
    let ph1: number
    if (Math.abs(d.z) > 0.9999) {
      // Top/bottom: the azimuth decides which way is "up" on screen (camera sits opposite to the screen-up)
      let ux = up?.x ?? 0
      let uy = up?.y ?? 0
      if (ux * ux + uy * uy < 1e-8) {
        ux = -Math.cos(th0)
        uy = -Math.sin(th0)
      }
      th1 = Math.atan2(-uy, -ux)
      ph1 = d.z > 0 ? POLE : Math.PI - POLE
    } else {
      th1 = Math.atan2(d.y, d.x)
      ph1 = Math.acos(d.z)
    }
    while (th1 - th0 > Math.PI) th1 -= 2 * Math.PI
    while (th1 - th0 < -Math.PI) th1 += 2 * Math.PI
    this.anim = { start: performance.now(), ms, th0, ph0, th1, ph1, dist }
    this.invalidate()
  }

  orbitBy(dTheta: number, dPhi: number) {
    this.anim = null
    const off = this.offset()
    const dist = off.length() || 1
    const th = Math.atan2(off.y, off.x) + dTheta
    const ph = Math.min(Math.PI - POLE, Math.max(POLE, Math.acos(Math.min(1, Math.max(-1, off.z / dist))) + dPhi))
    this.place(th, ph, dist)
    this.controls.update()
    this.invalidate()
  }

  /** Advances the animation (call once per frame, before controls.update()); true while it runs. */
  step(now: number): boolean {
    const a = this.anim
    if (!a) return false
    const t = Math.min(1, Math.max(0, (now - a.start) / a.ms))
    const k = easeInOut(t)
    this.place(a.th0 + (a.th1 - a.th0) * k, a.ph0 + (a.ph1 - a.ph0) * k, a.dist)
    if (t >= 1) this.anim = null
    return true
  }

  private place(th: number, ph: number, dist: number) {
    const s = Math.sin(ph)
    this.camera.position.set(Math.cos(th) * s, Math.sin(th) * s, Math.cos(ph)).multiplyScalar(dist).add(this.controls.target)
  }

  /** Rotation part of the current view matrix (world → camera), for the view cube. */
  viewRotation(): Matrix4 {
    this.camera.updateMatrixWorld()
    return this.view.extractRotation(this.camera.matrixWorldInverse)
  }

  dispose() {
    this.controls.removeEventListener('start', this.cancel)
  }
}
