// Dev-only: generates a realistic multi-layer G-code (Creality Print 7.3 / Orca dialect) for the mock.
// A twisted, bulging rounded-square tower with skirt, bottom/top solid layers, walls, sparse infill,
// retractions, z-hops, fan and temperature changes, and a two-colour band (T1) for the filament view.

export interface SampleOptions {
  name?: string
  /** Total height in mm */
  height?: number
  layerHeight?: number
  /** Points per wall loop (more = bigger file) */
  wallPoints?: number
  /** Sparse infill spacing in mm */
  infillSpacing?: number
  /** Base half-size in mm */
  radius?: number
  colors?: [string, string]
  /** Object centres: more than one → Creality Print EXCLUDE_OBJECT_DEFINE/START/END blocks per object */
  objects?: [number, number][]
}

export interface SampleObject {
  name: string
  label: string
  center: [number, number]
  polygon: [number, number][]
}

const FIL_AREA = Math.PI * 0.875 * 0.875 // 1.75 mm filament
const DENSITY = 1.24
const W = 0.45

export interface SampleResult {
  blob: Blob
  printSeconds: number
  filamentMm: number[]
  filamentGrams: number[]
  layers: number
  objects: SampleObject[]
}

const f3 = (n: number) => {
  const s = n.toFixed(3)
  return s.replace(/\.?0+$/, '') || '0'
}
const f5 = (n: number) => n.toFixed(5).replace(/^(-?)0\./, '$1.')

function hms(sec: number) {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return `${h ? `${h}h ` : ''}${m}m ${s}s`
}

export function generateSampleGcode(opts: SampleOptions = {}): SampleResult {
  const height = opts.height ?? 60
  const lh = opts.layerHeight ?? 0.2
  const pts = opts.wallPoints ?? 120
  const spacing = opts.infillSpacing ?? 3
  const R0 = opts.radius ?? 20
  const colors = opts.colors ?? ['#F2F2F2', '#0EA5E9']
  const centers: [number, number][] = opts.objects ?? [[110, 107.5]]
  const multi = centers.length > 1
  const reach = R0 * 1.14 * 1.2 + 1
  const objects: SampleObject[] = multi
    ? centers.map(([ox, oy], i) => ({
        name: `Object_${i + 1}_id_${i}_copy_0`,
        label: `Object_${i + 1}`,
        center: [ox, oy],
        polygon: [
          [ox - reach, oy - reach],
          [ox + reach, oy - reach],
          [ox + reach, oy + reach],
          [ox - reach, oy + reach],
        ],
      }))
    : []
  let cx = centers[0][0]
  let cy = centers[0][1]
  const layers = Math.round(height / lh)
  const bottomLayers = 4
  const topLayers = 5
  const bandFrom = Math.round(layers * 0.5)
  const bandTo = bandFrom + Math.round(layers * 0.08)

  const parts: string[] = []
  let buf: string[] = []
  const out = (s: string) => {
    buf.push(s)
    if (buf.length > 4000) {
      parts.push(buf.join('\n') + '\n')
      buf = []
    }
  }

  let x = 0
  let y = 0
  let z = 0
  let time = 0
  let tool = 0
  const usedMm = [0, 0]
  let lastF = 0

  const travel = (nx: number, ny: number) => {
    const d = Math.hypot(nx - x, ny - y)
    if (d < 0.01) return
    const longMove = d > 2
    if (longMove) {
      out('G1 E-.8 F2400')
      out(`G1 Z${f3(z + 0.4)} F12000`)
    }
    out(`G1 X${f3(nx)} Y${f3(ny)} F30000`)
    time += d / 500 + (longMove ? 0.08 : 0)
    if (longMove) {
      out(`G1 Z${f3(z)} F12000`)
      out('G1 E.8 F2400')
    }
    x = nx
    y = ny
    lastF = 30000
  }
  const extrude = (nx: number, ny: number, speed: number, width = W) => {
    const d = Math.hypot(nx - x, ny - y)
    if (d < 0.005) return
    const e = (d * width * lh) / FIL_AREA
    const F = Math.round(speed * 60)
    out(`G1 X${f3(nx)} Y${f3(ny)} E${f5(e)}${F !== lastF ? ` F${F}` : ''}`)
    lastF = F
    time += d / speed
    usedMm[tool] += e
    x = nx
    y = ny
  }

  /** Superellipse loop (convex), twisted by `angle`, scaled by `r`. */
  const loop = (r: number, angle: number): [number, number][] => {
    const n = 4
    const res: [number, number][] = []
    const ca = Math.cos(angle)
    const sa = Math.sin(angle)
    for (let i = 0; i < pts; i++) {
      const t = (i / pts) * Math.PI * 2
      const c = Math.cos(t)
      const s = Math.sin(t)
      const px = Math.sign(c) * Math.abs(c) ** (2 / n) * r
      const py = Math.sign(s) * Math.abs(s) ** (2 / n) * r
      res.push([cx + px * ca - py * sa, cy + px * sa + py * ca])
    }
    return res
  }

  /** Intersections of the line {p · dir⊥ = k} with a convex polygon → [a, b] or null. */
  const scan = (poly: [number, number][], ang: number, k: number): [[number, number], [number, number]] | null => {
    const nx = -Math.sin(ang)
    const ny = Math.cos(ang)
    const hits: [number, number][] = []
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i]
      const [x2, y2] = poly[(i + 1) % poly.length]
      const d1 = x1 * nx + y1 * ny - k
      const d2 = x2 * nx + y2 * ny - k
      if ((d1 <= 0 && d2 > 0) || (d1 > 0 && d2 <= 0)) {
        const t = d1 / (d1 - d2)
        hits.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t])
      }
    }
    if (hits.length < 2) return null
    const dx = Math.cos(ang)
    const dy = Math.sin(ang)
    hits.sort((a, b) => a[0] * dx + a[1] * dy - (b[0] * dx + b[1] * dy))
    return [hits[0], hits[hits.length - 1]]
  }

  const fill = (poly: [number, number][], ang: number, step: number, speed: number) => {
    const nx = -Math.sin(ang)
    const ny = Math.cos(ang)
    let lo = Infinity
    let hi = -Infinity
    for (const [px, py] of poly) {
      const k = px * nx + py * ny
      lo = Math.min(lo, k)
      hi = Math.max(hi, k)
    }
    let flip = false
    let first = true
    for (let k = lo + step / 2; k < hi; k += step) {
      const seg = scan(poly, ang, k)
      if (!seg) continue
      const [a, b] = flip ? [seg[1], seg[0]] : seg
      if (first || Math.hypot(a[0] - x, a[1] - y) > step * 2.5) travel(a[0], a[1])
      else extrude(a[0], a[1], speed)
      extrude(b[0], b[1], speed)
      flip = !flip
      first = false
    }
  }

  const wall = (poly: [number, number][], speed: number) => {
    // Start each loop at a different point so the seam is "aligned" like Orca's default
    travel(poly[0][0], poly[0][1])
    for (let i = 1; i <= poly.length; i++) extrude(poly[i % poly.length][0], poly[i % poly.length][1], speed)
  }

  const now = new Date()
  const stamp = `${now.toISOString().slice(0, 10)} at ${now.toTimeString().slice(0, 8)}`
  const body: string[] = []
  const header = (est: number, mm: number[], g: number[]) =>
    [
      '; HEADER_BLOCK_START',
      `; generated by Creality_Print V7.3.1.6378 on ${stamp}`,
      `; total layer number: ${layers}`,
      `; estimated printing time (normal mode) = ${hms(est)}`,
      `; total filament length [mm] : ${mm.map((v) => v.toFixed(2)).join(',')}`,
      `; total filament weight [g] : ${g.map((v) => v.toFixed(2)).join(',')}`,
      '; HEADER_BLOCK_END',
      '',
    ].join('\n')

  // ---- start G-code ----
  body.push('; EXECUTABLE_BLOCK_START')
  for (const o of objects) {
    body.push(`EXCLUDE_OBJECT_DEFINE NAME=${o.name} CENTER=${f3(o.center[0])},${f3(o.center[1])} POLYGON=[${o.polygon.map(([px, py]) => `[${f3(px)},${f3(py)}]`).join(',')}]`)
  }
  body.push(
    'M140 S60',
    'M104 S150',
    'START_PRINT EXTRUDER_TEMP=225 BED_TEMP=60',
    'T0',
    'M104 S225',
    'M109 S225',
    'G90',
    'M83',
    'G92 E0',
    'M106 S0',
  )
  for (const l of body) out(l)

  for (let li = 0; li < layers; li++) {
    z = +(lh * (li + 1)).toFixed(3)
    const h = z / height
    const r = R0 * (1 + 0.14 * Math.sin(h * Math.PI))
    const angle = h * (Math.PI / 2)
    const firstLayer = li === 0
    const sp = (v: number) => (firstLayer ? 50 : v)

    out(';LAYER_CHANGE')
    out(`;Z:${f3(z)}`)
    out(`;HEIGHT:${f3(lh)}`)
    out(`G1 Z${f3(z)} F12000`)
    if (li === 1) {
      out('M104 S220')
      out('M106 S180')
    }
    if (li === 2) out('M106 S255')
    if (li === bandFrom || li === bandTo) {
      tool = li === bandFrom ? 1 : 0
      out('; CP TOOLCHANGE START')
      out(`T${tool}`)
      out('; CP TOOLCHANGE END')
      time += 45
    }

    for (let oi = 0; oi < centers.length; oi++) {
      cx = centers[oi][0]
      cy = centers[oi][1]
      const obj = objects[oi]
      if (obj) {
        out(`; printing object ${obj.label} id:${oi} copy 0`)
        out(`EXCLUDE_OBJECT_START NAME=${obj.name}`)
      }
      if (firstLayer) {
        out(';TYPE:Skirt')
        out(';WIDTH:0.5')
        wall(loop(r + 6, angle), 50)
      }
      out(';TYPE:Inner wall')
      out(';WIDTH:0.45')
      wall(loop(r - W, angle), sp(300))
      out(';TYPE:Outer wall')
      out(';WIDTH:0.42')
      wall(loop(r, angle), sp(200))

      const inner = loop(r - 2 * W, angle)
      const ang = (li % 2 ? -1 : 1) * (Math.PI / 4) + angle
      if (li < bottomLayers) {
        out(';TYPE:Bottom surface')
        out(';WIDTH:0.45')
        fill(inner, ang, W, sp(150))
      } else if (li >= layers - topLayers) {
        out(li === layers - 1 ? ';TYPE:Top surface' : ';TYPE:Internal solid infill')
        out(';WIDTH:0.45')
        fill(inner, ang, W, li === layers - 1 ? 150 : 250)
      } else if (li >= layers - topLayers - 2 || li < bottomLayers + 1) {
        out(';TYPE:Internal solid infill')
        out(';WIDTH:0.45')
        fill(inner, ang, W * 2, 250)
      } else {
        out(';TYPE:Sparse infill')
        out(';WIDTH:0.45')
        fill(inner, li % 2 ? Math.PI / 4 : -Math.PI / 4, spacing, 270)
      }
      if (obj) {
        out(`EXCLUDE_OBJECT_END NAME=${obj.name}`)
        out(`; stop printing object ${obj.label} id:${oi} copy 0`)
      }
    }
    time += 0.6 // layer change overhead
  }

  out(';TYPE:Custom')
  out('; filament end gcode')
  out('M106 S0')
  out('END_PRINT')
  out('; EXECUTABLE_BLOCK_END')

  const grams = usedMm.map((mm) => (mm * FIL_AREA * DENSITY) / 1000)
  out('')
  out(`; filament used [mm] = ${usedMm.map((v) => v.toFixed(2)).join(', ')}`)
  out(`; filament used [cm3] = ${usedMm.map((v) => ((v * FIL_AREA) / 1000).toFixed(2)).join(', ')}`)
  out(`; filament used [g] = ${grams.map((v) => v.toFixed(2)).join(', ')}`)
  out(`; total filament used [g] = ${grams.reduce((a, b) => a + b, 0).toFixed(2)}`)
  out(`; total layers count = ${layers}`)
  out(`; estimated printing time (normal mode) = ${hms(time)}`)
  out('; CONFIG_BLOCK_START')
  out('; printer_model = Creality K2 SE')
  out(`; filament_colour = ${colors.join(';')}`)
  out('; filament_density = 1.24;1.24')
  out('; filament_type = PLA;PLA')
  out('; filament_settings_id = "Hyper PLA @Creality K2 SE 0.4 nozzle";"Hyper PLA @Creality K2 SE 0.4 nozzle"')
  out(`; layer_height = ${lh}`)
  out('; nozzle_diameter = 0.4')
  out('; sparse_infill_density = 15%')
  out('; CONFIG_BLOCK_END')
  parts.push(buf.join('\n') + '\n')

  return {
    blob: new Blob([header(time, usedMm, grams), ...parts], { type: 'text/x-gcode' }),
    printSeconds: Math.round(time),
    filamentMm: usedMm.map((v) => +v.toFixed(2)),
    filamentGrams: grams.map((v) => +v.toFixed(2)),
    layers,
    objects,
  }
}

/** Two towers side by side (the mock's exclude-object demo). */
export const TWO_OBJECT_OPTIONS: SampleOptions = { height: 30, radius: 13, wallPoints: 90, objects: [[72, 107.5], [148, 107.5]], colors: ['#F2F2F2', '#22C55E'] }

/** ~50 MB stress file (fine layers, smooth walls, dense infill). */
export const STRESS_OPTIONS: SampleOptions = { height: 110, layerHeight: 0.1, wallPoints: 640, infillSpacing: 1.2, radius: 30 }

/** A tiny binary STL (a cube) for model downloads/content in the mock. */
export function sampleStl(size = 20): Blob {
  const s = size
  const v = [
    [0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0],
    [0, 0, s], [s, 0, s], [s, s, s], [0, s, s],
  ]
  const faces = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ]
  const buf = new ArrayBuffer(84 + faces.length * 50)
  const dv = new DataView(buf)
  dv.setUint32(80, faces.length, true)
  faces.forEach((f, i) => {
    const o = 84 + i * 50 + 12
    f.forEach((vi, j) => v[vi].forEach((c, k) => dv.setFloat32(o + j * 12 + k * 4, c, true)))
  })
  return new Blob([buf], { type: 'model/stl' })
}
