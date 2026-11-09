// Transform helpers. A SceneObject's `transform` maps FILE coordinates (the mesh as stored in the library)
// to PLATE-LOCAL printer coordinates (mm, origin at the front-left corner of its plate, Z up).
import { Box3, Matrix4, Quaternion, Vector3 } from 'three'
import type { Mat4 } from '../types'
import type { BedSize } from './plates'

const _v = new Vector3()

export const toMatrix = (m: Mat4) => new Matrix4().fromArray(m)
export const fromMatrix = (m: Matrix4): Mat4 => m.elements.map((x) => (Math.abs(x) < 1e-12 ? 0 : Number(x.toFixed(6))))

/** Bounding box of the hull points under `m`. */
export function hullBox(hull: Float32Array, m: Matrix4, out = new Box3()): Box3 {
  out.makeEmpty()
  const e = m.elements
  for (let i = 0; i < hull.length; i += 3) {
    const x = hull[i], y = hull[i + 1], z = hull[i + 2]
    _v.set(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14])
    out.expandByPoint(_v)
  }
  return out
}

/** Moves the object so that its lowest point touches z = 0. */
export function dropToBed(m: Matrix4, hull: Float32Array): Matrix4 {
  const box = hullBox(hull, m)
  if (!box.isEmpty()) m.premultiply(new Matrix4().makeTranslation(0, 0, -box.min.z))
  return m
}

/** Rotates `m` by `q` around the centre of its bounding box (keeps the object in place). */
export function rotateAroundCenter(m: Matrix4, q: Quaternion, hull: Float32Array): Matrix4 {
  const c = hullBox(hull, m).getCenter(new Vector3())
  const r = new Matrix4().makeTranslation(c.x, c.y, c.z).multiply(new Matrix4().makeRotationFromQuaternion(q)).multiply(new Matrix4().makeTranslation(-c.x, -c.y, -c.z))
  return m.premultiply(r)
}

/** Translates `m` so that its bounding-box centre (XY) is at x,y. */
export function centerAt(m: Matrix4, hull: Float32Array, x: number, y: number): Matrix4 {
  const c = hullBox(hull, m).getCenter(new Vector3())
  return m.premultiply(new Matrix4().makeTranslation(x - c.x, y - c.y, 0))
}

export function isOutside(box: Box3, bed: BedSize, eps = 0.05) {
  return box.min.x < -eps || box.min.y < -eps || box.max.x > bed.w + eps || box.max.y > bed.d + eps || box.max.z > bed.h + eps || box.min.z < -eps
}

/** Decomposes into position / Euler degrees / scale (for the numeric panel). */
export function decompose(m: Matrix4) {
  const p = new Vector3()
  const q = new Quaternion()
  const s = new Vector3()
  m.decompose(p, q, s)
  return { p, q, s }
}

export const DEG = Math.PI / 180
