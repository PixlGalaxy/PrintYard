/// <reference lib="webworker" />
// Parses STL (binary/ASCII), OBJ and 3MF off the main thread and precomputes everything the editor needs:
// flat normals, triangle count, volume, bounding box, convex hull points and the hull's flat facets
// (for "lay on face" and auto-orient). Results come back as transferable typed arrays.
import { Vector3 } from 'three'
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js'
import { unzipSync } from 'fflate'
import type { MeshWorkerRequest, MeshWorkerResponse, WorkerFacet } from './meshTypes'

declare const self: DedicatedWorkerGlobalScope

const decoder = new TextDecoder()

// ---------- format sniffing ----------

function sniff(buf: ArrayBuffer, name: string): 'stl' | 'obj' | '3mf' {
  const u8 = new Uint8Array(buf, 0, Math.min(buf.byteLength, 512))
  if (u8[0] === 0x50 && u8[1] === 0x4b) return '3mf' // "PK" zip
  if (buf.byteLength >= 84 && 84 + new DataView(buf).getUint32(80, true) * 50 === buf.byteLength) return 'stl'
  const head = decoder.decode(u8).trimStart().toLowerCase()
  if (head.startsWith('solid')) return 'stl'
  if (/^(#|v |vn |vt |o |g |mtllib|usemtl|s )/m.test(head)) return 'obj'
  return name.toLowerCase().endsWith('.obj') ? 'obj' : 'stl'
}

// ---------- STL ----------

function parseStl(buf: ArrayBuffer): Float32Array {
  const dv = new DataView(buf)
  if (buf.byteLength >= 84) {
    const n = dv.getUint32(80, true)
    if (84 + n * 50 === buf.byteLength) {
      const pos = new Float32Array(n * 9)
      let o = 84
      for (let i = 0; i < n; i++) {
        o += 12 // skip the stored normal (recomputed)
        for (let k = 0; k < 9; k++) {
          pos[i * 9 + k] = dv.getFloat32(o, true)
          o += 4
        }
        o += 2
      }
      return pos
    }
  }
  // ASCII: every "vertex x y z"
  const text = decoder.decode(buf)
  const out: number[] = []
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push(+m[1], +m[2], +m[3])
  if (out.length === 0 || out.length % 9 !== 0) throw new Error('mesh.invalid_stl')
  return new Float32Array(out)
}

// ---------- OBJ ----------

function parseObj(buf: ArrayBuffer): Float32Array {
  const text = decoder.decode(buf)
  const verts: number[] = []
  const out: number[] = []
  let start = 0
  const len = text.length
  while (start < len) {
    let end = text.indexOf('\n', start)
    if (end < 0) end = len
    const line = text.slice(start, end).trim()
    start = end + 1
    if (line.startsWith('v ')) {
      const p = line.split(/\s+/)
      verts.push(+p[1], +p[2], +p[3])
    } else if (line.startsWith('f ')) {
      const p = line.split(/\s+/).slice(1)
      const nv = verts.length / 3
      const idx = p.map((s) => {
        const i = parseInt(s, 10)
        return i < 0 ? nv + i : i - 1
      })
      for (let k = 1; k + 1 < idx.length; k++) {
        for (const i of [idx[0], idx[k], idx[k + 1]]) out.push(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2])
      }
    }
  }
  if (out.length === 0) throw new Error('mesh.invalid_obj')
  return new Float32Array(out)
}

// ---------- 3MF (core spec + production extension, as written by Creality/Bambu/Orca/PrusaSlicer) ----------

interface XObject {
  verts?: Float32Array
  tris?: Uint32Array
  components: { objectId: string; path: string | null; m: number[] | null }[]
}

const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`))
  return m ? m[1] : null
}

/** 3MF transform "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32" (row vectors) */
const parseTransform = (s: string | null) => {
  if (!s) return null
  const v = s.trim().split(/\s+/).map(Number)
  return v.length === 12 && v.every(Number.isFinite) ? v : null
}
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
/** a then b (row-vector convention: p' = p·A·B) */
function compose(a: number[], b: number[]) {
  const r = new Array(12).fill(0)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]
  for (let j = 0; j < 3; j++) r[9 + j] = a[9] * b[j] + a[10] * b[3 + j] + a[11] * b[6 + j] + b[9 + j]
  return r
}

function parseModelXml(xml: string): Map<string, XObject> {
  const objects = new Map<string, XObject>()
  const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g
  let m: RegExpExecArray | null
  while ((m = objRe.exec(xml))) {
    const id = attr(m[1], 'id')
    if (!id) continue
    const body = m[2]
    const o: XObject = { components: [] }
    const vs = body.indexOf('<vertices')
    if (vs >= 0) {
      const verts: number[] = []
      const vre = /<vertex\b([^>]*)\/?>/g
      vre.lastIndex = vs
      const vEnd = body.indexOf('</vertices>', vs)
      let v: RegExpExecArray | null
      while ((v = vre.exec(body)) && (vEnd < 0 || v.index < vEnd)) {
        verts.push(Number(attr(v[1], 'x')), Number(attr(v[1], 'y')), Number(attr(v[1], 'z')))
      }
      const tris: number[] = []
      const tre = /<triangle\b([^>]*)\/?>/g
      tre.lastIndex = vEnd > 0 ? vEnd : vs
      let t: RegExpExecArray | null
      while ((t = tre.exec(body))) tris.push(Number(attr(t[1], 'v1')), Number(attr(t[1], 'v2')), Number(attr(t[1], 'v3')))
      o.verts = new Float32Array(verts)
      o.tris = new Uint32Array(tris)
    }
    const cre = /<component\b([^>]*)\/?>/g
    let c: RegExpExecArray | null
    while ((c = cre.exec(body))) {
      const objectId = attr(c[1], 'objectid')
      if (objectId) o.components.push({ objectId, path: attr(c[1], 'p:path'), m: parseTransform(attr(c[1], 'transform')) })
    }
    objects.set(id, o)
  }
  return objects
}

function parse3mf(buf: ArrayBuffer): Float32Array {
  const files = unzipSync(new Uint8Array(buf), { filter: (f) => f.name.toLowerCase().endsWith('.model') })
  const models = new Map<string, Map<string, XObject>>()
  let rootPath = ''
  for (const [name, data] of Object.entries(files)) {
    const path = '/' + name.replace(/^\/+/, '')
    models.set(path.toLowerCase(), parseModelXml(decoder.decode(data)))
    if (path.toLowerCase() === '/3d/3dmodel.model') rootPath = path.toLowerCase()
  }
  if (!rootPath) rootPath = [...models.keys()][0] ?? ''
  const root = models.get(rootPath)
  if (!root) throw new Error('mesh.invalid_3mf')
  const rootXml = decoder.decode(Object.entries(files).find(([n]) => '/' + n.toLowerCase() === rootPath)![1])

  const chunks: Float32Array[] = []
  const emit = (path: string, id: string, m: number[], depth: number) => {
    if (depth > 8) return
    const obj = models.get(path)?.get(id)
    if (!obj) return
    if (obj.verts && obj.tris && obj.tris.length) {
      const v = obj.verts
      const t = obj.tris
      const out = new Float32Array(t.length * 3)
      for (let i = 0; i < t.length; i++) {
        const x = v[t[i] * 3]
        const y = v[t[i] * 3 + 1]
        const z = v[t[i] * 3 + 2]
        out[i * 3] = x * m[0] + y * m[3] + z * m[6] + m[9]
        out[i * 3 + 1] = x * m[1] + y * m[4] + z * m[7] + m[10]
        out[i * 3 + 2] = x * m[2] + y * m[5] + z * m[8] + m[11]
      }
      chunks.push(out)
    }
    for (const c of obj.components) {
      emit(c.path ? c.path.toLowerCase() : path, c.objectId, compose(c.m ?? IDENTITY, m), depth + 1)
    }
  }

  const items = [...rootXml.matchAll(/<item\b([^>]*)\/?>/g)]
  if (items.length) {
    for (const it of items) {
      const id = attr(it[1], 'objectid')
      if (id) emit(rootPath, id, parseTransform(attr(it[1], 'transform')) ?? IDENTITY, 0)
    }
  } else {
    for (const id of root.keys()) emit(rootPath, id, IDENTITY, 0)
  }
  const total = chunks.reduce((s, c) => s + c.length, 0)
  if (!total) throw new Error('mesh.invalid_3mf')
  const pos = new Float32Array(total)
  let o = 0
  for (const c of chunks) {
    pos.set(c, o)
    o += c.length
  }
  return pos
}

// ---------- analysis ----------

function analyse(pos: Float32Array) {
  const n = pos.length / 9
  const normals = new Float32Array(pos.length)
  let volume = 0
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < n; i++) {
    const o = i * 9
    const ax = pos[o], ay = pos[o + 1], az = pos[o + 2]
    const bx = pos[o + 3], by = pos[o + 4], bz = pos[o + 5]
    const cx = pos[o + 6], cy = pos[o + 7], cz = pos[o + 8]
    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz) || 1
    nx /= l
    ny /= l
    nz /= l
    for (let k = 0; k < 3; k++) {
      normals[o + k * 3] = nx
      normals[o + k * 3 + 1] = ny
      normals[o + k * 3 + 2] = nz
    }
    // signed tetrahedron volume
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
    for (let k = 0; k < 9; k += 3) {
      for (let a = 0; a < 3; a++) {
        const val = pos[o + k + a]
        if (val < min[a]) min[a] = val
        if (val > max[a]) max[a] = val
      }
    }
  }
  return { normals, volume: Math.abs(volume), min, max }
}

/** Exact-ish convex hull: drops points inside a 26-direction k-DOP, then QuickHull on the rest (capped). */
function hull(pos: Float32Array) {
  const count = pos.length / 3
  const dirs: number[][] = []
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) if (x || y || z) dirs.push([x, y, z])
  const best = dirs.map(() => -Infinity)
  const bestIdx = dirs.map(() => 0)
  for (let i = 0; i < count; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]
    for (let d = 0; d < dirs.length; d++) {
      const v = dirs[d][0] * x + dirs[d][1] * y + dirs[d][2] * z
      if (v > best[d]) {
        best[d] = v
        bestIdx[d] = i
      }
    }
  }
  const toV = (i: number) => new Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])
  const seed = new ConvexHull().setFromPoints([...new Set(bestIdx)].map(toV))
  const planes = seed.faces.map((f) => ({ n: f.normal.clone(), c: f.constant }))
  // Keep points outside (or on) the seed polytope; dedupe on a 1 µm grid
  const seen = new Set<string>()
  const keep: Vector3[] = []
  for (let i = 0; i < count; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]
    let inside = planes.length > 3
    for (const p of planes) {
      if (p.n.x * x + p.n.y * y + p.n.z * z - p.c > -1e-4) {
        inside = false
        break
      }
    }
    if (inside) continue
    const key = `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`
    if (seen.has(key)) continue
    seen.add(key)
    keep.push(new Vector3(x, y, z))
  }
  const CAP = 60_000
  let pts = keep
  if (keep.length > CAP) {
    const stride = keep.length / CAP
    pts = []
    for (let i = 0; i < CAP; i++) pts.push(keep[Math.floor(i * stride)])
    for (const i of bestIdx) pts.push(toV(i))
  }
  if (pts.length < 4) pts = [...new Set(bestIdx)].map(toV)
  const h = new ConvexHull().setFromPoints(pts)
  const verts = new Set<Vector3>()
  for (const f of h.faces) {
    let e = f.edge
    do {
      verts.add(e.head().point)
      e = e.next
    } while (e !== f.edge)
  }
  const hullPts = new Float32Array(verts.size * 3)
  let k = 0
  for (const v of verts) {
    hullPts[k++] = v.x
    hullPts[k++] = v.y
    hullPts[k++] = v.z
  }

  // Merge coplanar hull triangles into facets (normal within ~1°, same plane)
  const groups: { n: Vector3; c: number; area: number; tris: number[] }[] = []
  for (const f of h.faces) {
    const tri: Vector3[] = []
    let e = f.edge
    do {
      tri.push(e.head().point)
      e = e.next
    } while (e !== f.edge)
    let g = groups.find((x) => x.n.dot(f.normal) > 0.9998 && Math.abs(x.c - f.constant) < 0.05)
    if (!g) {
      g = { n: f.normal.clone(), c: f.constant, area: 0, tris: [] }
      groups.push(g)
    }
    for (let i = 1; i + 1 < tri.length; i++) {
      const a = tri[0], b = tri[i], c = tri[i + 1]
      g.area += new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a)).length() / 2
      g.tris.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
    }
  }
  const totalArea = groups.reduce((s, g) => s + g.area, 0) || 1
  const facets: WorkerFacet[] = groups
    .filter((g) => g.area / totalArea > 0.002)
    .sort((a, b) => b.area - a.area)
    .slice(0, 64)
    .map((g) => ({ normal: [g.n.x, g.n.y, g.n.z], area: g.area, tris: new Float32Array(g.tris) }))
  return { hullPts, facets }
}

self.onmessage = (ev: MessageEvent<MeshWorkerRequest>) => {
  const { id, buffer, name } = ev.data
  try {
    const format = sniff(buffer, name)
    const positions = format === '3mf' ? parse3mf(buffer) : format === 'obj' ? parseObj(buffer) : parseStl(buffer)
    const { normals, volume, min, max } = analyse(positions)
    const { hullPts, facets } = hull(positions)
    const res: MeshWorkerResponse = {
      id,
      ok: true,
      positions,
      normals,
      triangles: positions.length / 9,
      volume,
      min: min as [number, number, number],
      max: max as [number, number, number],
      hull: hullPts,
      facets,
    }
    self.postMessage(res, [positions.buffer, normals.buffer, hullPts.buffer, ...facets.map((f) => f.tris.buffer)])
  } catch (err) {
    const res: MeshWorkerResponse = { id, ok: false, error: err instanceof Error ? err.message : String(err) }
    self.postMessage(res)
  }
}
