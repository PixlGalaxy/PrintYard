// Auto-orient heuristic: try "which direction faces down" candidates (large convex-hull facets plus the six
// axes) and keep the one with the least overhang area, preferring a big contact face and a low height.
import { Matrix3, Matrix4, Quaternion, Vector3 } from 'three'
import type { MeshInfo } from './meshes'

const DOWN = new Vector3(0, 0, -1)
const COS_OVERHANG = Math.cos((45 * Math.PI) / 180)
const MAX_SAMPLES = 150_000

/** Rotation (world) that puts the best face down, or null when the current orientation is already best. */
export function bestOrientation(info: MeshInfo, m: Matrix4): Quaternion | null {
  const pos = info.geometry.getAttribute('position').array as Float32Array
  const triCount = pos.length / 9
  const stride = Math.max(1, Math.floor(triCount / MAX_SAMPLES))
  const nm = new Matrix3().getNormalMatrix(m)

  // Sampled triangles in world space: centroid, normal, area
  const n = Math.ceil(triCount / stride)
  const cen = new Float32Array(n * 3)
  const nor = new Float32Array(n * 3)
  const area = new Float32Array(n)
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), ab = new Vector3(), ac = new Vector3()
  let k = 0
  let total = 0
  for (let t = 0; t < triCount && k < n; t += stride, k++) {
    const o = t * 9
    a.set(pos[o], pos[o + 1], pos[o + 2]).applyMatrix4(m)
    b.set(pos[o + 3], pos[o + 4], pos[o + 5]).applyMatrix4(m)
    c.set(pos[o + 6], pos[o + 7], pos[o + 8]).applyMatrix4(m)
    ab.subVectors(b, a)
    ac.subVectors(c, a)
    const cr = ab.cross(ac)
    const ar = cr.length() / 2
    cr.normalize()
    cen[k * 3] = (a.x + b.x + c.x) / 3
    cen[k * 3 + 1] = (a.y + b.y + c.y) / 3
    cen[k * 3 + 2] = (a.z + b.z + c.z) / 3
    nor[k * 3] = cr.x
    nor[k * 3 + 1] = cr.y
    nor[k * 3 + 2] = cr.z
    area[k] = ar
    total += ar
  }
  if (!total) return null

  // Hull points in world space (for height / bed plane)
  const hull = info.hull
  const hp: Vector3[] = []
  for (let i = 0; i < hull.length; i += 3) hp.push(new Vector3(hull[i], hull[i + 1], hull[i + 2]).applyMatrix4(m))

  const candidates: { d: Vector3; contact: number }[] = [
    ...info.facets.slice(0, 24).map((f) => ({ d: new Vector3(...f.normal).applyMatrix3(nm).normalize(), contact: f.area * Math.abs(m.determinant()) ** (2 / 3) })),
    ...[
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ].map((v) => ({ d: new Vector3(...v), contact: 0 })),
  ]

  let extentMax = 0
  const scored = candidates.map(({ d, contact }) => {
    let lo = Infinity
    let hi = -Infinity
    for (const p of hp) {
      const v = p.dot(d)
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    const height = hi - lo
    extentMax = Math.max(extentMax, height)
    let overhang = 0
    let touching = 0
    for (let i = 0; i < n; i++) {
      const dot = nor[i * 3] * d.x + nor[i * 3 + 1] * d.y + nor[i * 3 + 2] * d.z
      if (dot <= COS_OVERHANG) continue
      const depth = hi - (cen[i * 3] * d.x + cen[i * 3 + 1] * d.y + cen[i * 3 + 2] * d.z)
      if (depth < 0.3) touching += area[i]
      else overhang += area[i] * dot
    }
    return { d, height, overhang, contact: Math.max(contact, touching) }
  })

  let best = scored[0]
  let bestScore = Infinity
  let current = Infinity
  for (const s of scored) {
    const score = s.overhang / total + 0.15 * (s.height / (extentMax || 1)) - 0.35 * Math.min(1, s.contact / total)
    if (s.d.distanceTo(DOWN) < 1e-3) current = Math.min(current, score)
    if (score < bestScore - 1e-6) {
      bestScore = score
      best = s
    }
  }
  if (best.d.distanceTo(DOWN) < 1e-3 || bestScore > current - 1e-3) return null
  return new Quaternion().setFromUnitVectors(best.d, DOWN)
}
