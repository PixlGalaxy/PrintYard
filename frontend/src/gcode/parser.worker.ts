// Streaming G-code parser (runs in a Web Worker). Reads the Blob as raw bytes chunk by chunk, parses
// G0/G1/G2/G3/G92/M82/M83/M104/M109/M106/M107/T<n> and Orca/Creality/Prusa/Cura feature comments,
// and returns compact typed arrays (transferred, not copied). Handles 50 MB+ files without building
// strings for motion lines.
import { FEATURE_COUNT, type GcodeMeta, type GcodeObject, type ParsedGcode, type WorkerRequest, type WorkerResponse } from './types'

const FIL_AREA = Math.PI * 0.875 * 0.875
const PROGRESS_EVERY = 4 * 1024 * 1024
// Upper bound on drawn moves (extrusions + travels). Real files stay far below it (a 200 MB G-code is ~8M moves),
// but a short G2/G3 line expands to up to 720 pieces, so a hostile file of ~1 MB could otherwise need several GB.
const MAX_MOVES = 1 << 24

class Grow<T extends Float32Array | Uint8Array | Uint16Array | Uint32Array> {
  arr: T
  n = 0
  private readonly Ctor: { new (n: number): T }
  constructor(Ctor: { new (n: number): T }, cap: number) {
    this.Ctor = Ctor
    this.arr = new Ctor(cap)
  }
  ensure(extra: number) {
    if (this.n + extra <= this.arr.length) return
    let cap = this.arr.length * 2
    while (cap < this.n + extra) cap *= 2
    const next = new this.Ctor(cap)
    next.set(this.arr)
    this.arr = next
  }
  push(v: number) {
    if (this.n >= this.arr.length) this.ensure(1)
    this.arr[this.n++] = v
  }
  trim(): T {
    return this.arr.slice(0, this.n) as T
  }
}

const featureCache = new Map<string, number>()
function featureIndex(raw: string): number {
  const key = raw.trim().toLowerCase()
  let v = featureCache.get(key)
  if (v !== undefined) return v
  if (/^(outer wall|external perimeter|wall-outer|perimeter external)/.test(key)) v = 0
  else if (/^(inner wall|perimeter|wall-inner|internal perimeter)/.test(key)) v = 1
  else if (/overhang/.test(key)) v = 2
  else if (/^(sparse infill|internal infill|fill|infill)$/.test(key)) v = 3
  else if (/^(internal solid infill|solid infill|skin)$/.test(key)) v = 4
  else if (/^(top surface|top solid infill|top)/.test(key)) v = 5
  else if (/^(bottom surface|bottom solid infill|bottom)/.test(key)) v = 6
  else if (/bridge/.test(key)) v = 7
  else if (/^gap (infill|fill)/.test(key)) v = 8
  else if (/^skirt/.test(key)) v = 9
  else if (/^brim/.test(key)) v = 10
  else if (/support.*(interface|transition)/.test(key)) v = 12
  else if (/^support/.test(key)) v = 11
  else if (/(prime|wipe) tower/.test(key)) v = 13
  else if (/^ironing/.test(key)) v = 14
  else v = 15
  featureCache.set(key, v)
  return v
}

function parseDuration(s: string): number | null {
  let total = 0
  let any = false
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/g)) {
    any = true
    const n = Number(m[1])
    total += m[2] === 'd' ? n * 86400 : m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : n
  }
  return any ? Math.round(total) : null
}

const nums = (s: string) =>
  s
    .split(/[,;]/)
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v))

async function parse(blob: Blob, post: (m: WorkerResponse) => void): Promise<ParsedGcode> {
  const t0 = performance.now()
  const total = blob.size
  // Rough initial capacity: ~1 segment per 32 bytes
  const cap = Math.max(4096, Math.min(1 << 23, Math.ceil(total / 32)))
  const seg = new Grow(Float32Array, cap * 8)
  const type = new Grow(Uint8Array, cap)
  const tool = new Grow(Uint8Array, cap)
  const fan = new Grow(Uint8Array, cap)
  const speed = new Grow(Float32Array, cap)
  const temp = new Grow(Uint16Array, cap)
  const offset = new Grow(Uint32Array, cap)
  const obj = new Grow(Uint8Array, cap)
  const objects: GcodeObject[] = []
  const objIndex = new Map<string, number>()
  let curObj = 255
  const travel = new Grow(Float32Array, Math.max(4096, cap) * 2)
  const layerStart = new Grow(Uint32Array, 1024)
  const layerTravelStart = new Grow(Uint32Array, 1024)
  const layerZ = new Grow(Float32Array, 1024)
  const layerTime = new Grow(Float32Array, 1024)
  const featureTime = new Float64Array(FEATURE_COUNT)
  const featureCount = new Uint32Array(FEATURE_COUNT)
  const toolMm = new Float64Array(16)
  const bbox: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  const meta: GcodeMeta = {
    estimatedSeconds: null,
    filamentMm: [],
    filamentGrams: [],
    filamentColors: [],
    filamentTypes: [],
    filamentDensity: [],
    layerCount: null,
    printerModel: null,
    slicer: null,
    layerHeight: null,
    nozzle: null,
  }

  // Machine state
  let x = 0
  let y = 0
  let z = 0
  let e = 0
  let absPos = true
  let absE = true
  let feed = 1800 // mm/min
  let curType = 15
  let curTool = 0
  let curFan = 0
  let curTemp = 0
  let widthCmt = -1
  let heightCmt = -1
  let markerMode = false
  let pendingLayer = false
  let layers = 0
  let curLayerZ = -1
  let prevLayerZ = 0
  let curLayerTime = 0
  let modelSeconds = 0
  let lines = 0

  const dec = new TextDecoder()

  const newLayer = () => {
    if (layers > 0) layerTime.push(curLayerTime)
    curLayerTime = 0
    prevLayerZ = curLayerZ < 0 ? 0 : curLayerZ
    curLayerZ = z
    layerStart.push(type.n)
    layerTravelStart.push(travel.n / 6)
    layerZ.push(z)
    layers++
    pendingLayer = false
  }

  const linear = (nx: number, ny: number, nz: number, de: number, lineOffset: number) => {
    const dx = nx - x
    const dy = ny - y
    const len = Math.sqrt(dx * dx + dy * dy)
    const v = feed / 60
    z = nz
    if (len > 1e-6 && seg.n / 8 + travel.n / 6 >= MAX_MOVES) throw new Error('This G-code has too many moves to preview')
    if (len > 1e-6 && de > 1e-7) {
      // Extrusion
      if (layers === 0 || (markerMode ? pendingLayer : Math.abs(z - curLayerZ) > 0.009)) newLayer()
      let h = heightCmt > 0 ? heightCmt : z - prevLayerZ
      if (!(h > 0.02) || h > 1.5) h = meta.layerHeight ?? 0.2
      let w = widthCmt > 0 ? widthCmt : (de * FIL_AREA) / (len * h)
      if (!(w > 0.05)) w = 0.05
      else if (w > 3) w = 3
      seg.ensure(8)
      const a = seg.arr
      const o = seg.n
      a[o] = x
      a[o + 1] = y
      a[o + 2] = z
      a[o + 3] = nx
      a[o + 4] = ny
      a[o + 5] = z
      a[o + 6] = w
      a[o + 7] = h
      seg.n += 8
      type.push(curType)
      tool.push(curTool)
      fan.push(curFan)
      speed.push(v)
      temp.push(curTemp)
      offset.push(lineOffset)
      obj.push(curObj)
      featureCount[curType]++
      const dt = len / v
      featureTime[curType] += dt
      curLayerTime += dt
      modelSeconds += dt
      toolMm[curTool & 15] += de
      if (nx < bbox[0]) bbox[0] = nx
      if (ny < bbox[1]) bbox[1] = ny
      if (z < bbox[2]) bbox[2] = z
      if (nx > bbox[3]) bbox[3] = nx
      if (ny > bbox[4]) bbox[4] = ny
      if (z > bbox[5]) bbox[5] = z
    } else if (len > 1e-6) {
      // Travel
      travel.ensure(6)
      const a = travel.arr
      const o = travel.n
      a[o] = x
      a[o + 1] = y
      a[o + 2] = z
      a[o + 3] = nx
      a[o + 4] = ny
      a[o + 5] = z
      travel.n += 6
      const dt = len / v
      curLayerTime += dt
      modelSeconds += dt
    } else if (de > 1e-7) {
      toolMm[curTool & 15] += de
    }
    x = nx
    y = ny
  }

  const comment = (s: string) => {
    if (s.startsWith('TYPE:')) {
      curType = featureIndex(s.slice(5))
      return
    }
    if (s.startsWith('WIDTH:')) {
      widthCmt = Number(s.slice(6)) || -1
      return
    }
    if (s.startsWith('HEIGHT:')) {
      heightCmt = Number(s.slice(7)) || -1
      return
    }
    if (s.startsWith('LAYER_CHANGE') || /^LAYER:-?\d+/.test(s)) {
      markerMode = true
      pendingLayer = true
      return
    }
    if (s.startsWith('Z:')) return
    if (s.startsWith('TIME:')) {
      meta.estimatedSeconds ??= Number(s.slice(5)) || null
      return
    }
    const eq = s.indexOf('=')
    const colon = s.indexOf(':')
    if (eq < 0 && colon < 0) {
      const gen = s.match(/^generated by (.+?)(?: on .*)?$/i)
      if (gen) meta.slicer ??= gen[1].replace(/_/g, ' ').trim()
      return
    }
    const sep = eq >= 0 && (colon < 0 || eq < colon) ? eq : colon
    const key = s.slice(0, sep).trim().toLowerCase()
    const val = s.slice(sep + 1).trim()
    switch (key) {
      case 'estimated printing time (normal mode)':
      case 'estimated printing time':
      case 'model printing time':
        if (key !== 'model printing time' || meta.estimatedSeconds == null) meta.estimatedSeconds = parseDuration(val) ?? meta.estimatedSeconds
        break
      case 'filament used [mm]':
      case 'total filament length [mm]':
        if (!meta.filamentMm.length) meta.filamentMm = nums(val)
        break
      case 'filament used [g]':
      case 'total filament weight [g]':
        if (!meta.filamentGrams.length) meta.filamentGrams = nums(val)
        break
      case 'filament used':
        // Cura: "Filament used: 1.234m"
        if (!meta.filamentMm.length && /m$/.test(val)) meta.filamentMm = nums(val.replace(/m/g, '')).map((m) => m * 1000)
        break
      case 'filament_colour':
      case 'extruder_colour':
        if (!meta.filamentColors.length || key === 'filament_colour') {
          const cols = val.split(/[;,]/).map((c) => c.trim().replace(/"/g, '')).filter((c) => /^#[0-9a-f]{6}$/i.test(c))
          if (cols.length) meta.filamentColors = cols
        }
        break
      case 'filament_type':
        meta.filamentTypes = val.split(/[;,]/).map((v) => v.trim().replace(/"/g, ''))
        break
      case 'filament_density':
        meta.filamentDensity = nums(val)
        break
      case 'total layer number':
      case 'total layers count':
      case 'layer_count':
      case 'layer count':
        meta.layerCount ??= Number(val) || null
        break
      case 'printer_model':
        meta.printerModel ??= val.replace(/"/g, '') || null
        break
      case 'layer_height':
        meta.layerHeight ??= Number(val) || null
        break
      case 'nozzle_diameter':
        meta.nozzle ??= nums(val)[0] ?? null
        break
      case 'flavor':
        break
    }
  }

  // Byte-level line parser ---------------------------------------------------
  let buf = new Uint8Array(0)
  let pos = 0
  let has = false

  /** Reads a number at `pos` (sets `has`). */
  const num = (end: number): number => {
    let i = pos
    while (i < end && (buf[i] === 32 || buf[i] === 9)) i++
    let neg = false
    if (buf[i] === 45) {
      neg = true
      i++
    } else if (buf[i] === 43) i++
    let v = 0
    let digits = 0
    while (i < end) {
      const c = buf[i] - 48
      if (c < 0 || c > 9) break
      v = v * 10 + c
      i++
      digits++
    }
    if (buf[i] === 46) {
      i++
      let scale = 0.1
      while (i < end) {
        const c = buf[i] - 48
        if (c < 0 || c > 9) break
        v += c * scale
        scale *= 0.1
        i++
        digits++
      }
    }
    if (i < end && (buf[i] === 101 || buf[i] === 69) && digits) {
      // exponent (rare)
      let j = i + 1
      let eneg = false
      if (buf[j] === 45) {
        eneg = true
        j++
      } else if (buf[j] === 43) j++
      let ex = 0
      let ed = 0
      while (j < end && buf[j] >= 48 && buf[j] <= 57) {
        ex = ex * 10 + buf[j] - 48
        j++
        ed++
      }
      if (ed) {
        v *= 10 ** (eneg ? -ex : ex)
        i = j
      }
    }
    pos = i
    has = digits > 0
    return neg ? -v : v
  }

  const line = (ls: number, le: number, lineOffset: number) => {
    lines++
    let i = ls
    while (i < le && (buf[i] === 32 || buf[i] === 9)) i++
    if (i >= le) return
    const c0 = buf[i]
    if (c0 === 59) {
      // ';' comment
      let j = i + 1
      while (j < le && buf[j] === 32) j++
      if (le - j > 0 && le - j < 400) comment(dec.decode(buf.subarray(j, buf[le - 1] === 13 ? le - 1 : le)))
      return
    }
    const C = c0 & 0xdf // upper-case
    if (C === 69 && le - i > 14 && le - i < 8192) {
      // EXCLUDE_OBJECT_DEFINE / _START / _END (Klipper exclude_object, Creality Print 7.x)
      const text = dec.decode(buf.subarray(i, le))
      const m = /^EXCLUDE_OBJECT_(DEFINE|START|END)\b(.*)$/i.exec(text.split(';')[0].trim())
      if (m) {
        const name = /\bNAME=("?)([^\s"]+)\1/i.exec(m[2])?.[2]
        const kind = m[1].toUpperCase()
        if (kind === 'END') curObj = 255
        else if (name) {
          const key = name.toUpperCase()
          let idx = objIndex.get(key)
          if (idx === undefined && objects.length < 254) {
            idx = objects.length
            objIndex.set(key, idx)
            objects.push({ name, center: null, polygon: [] })
          }
          if (idx !== undefined && kind === 'DEFINE') {
            const c = /\bCENTER=(-?[\d.]+),(-?[\d.]+)/i.exec(m[2])
            if (c) objects[idx].center = [Number(c[1]), Number(c[2])]
            const poly = /\bPOLYGON=(\[\[.*?\]\])/i.exec(m[2])?.[1]
            if (poly) objects[idx].polygon = [...poly.matchAll(/\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]/g)].slice(0, 512).map((p) => [Number(p[1]), Number(p[2])] as [number, number])
          }
          if (kind === 'START' && idx !== undefined) curObj = idx
        }
      }
      return
    }
    if (C === 71) {
      // G
      pos = i + 1
      const code = num(le)
      if (!has) return
      if (code === 0 || code === 1 || code === 2 || code === 3) {
        let nx = x
        let ny = y
        let nz = z
        let de = 0
        let I = 0
        let J = 0
        let R = Number.NaN
        let hasE = false
        let k = pos
        while (k < le) {
          const ch = buf[k] & 0xdf
          if (buf[k] === 59) break
          if (ch >= 65 && ch <= 90) {
            pos = k + 1
            const v = num(le)
            k = pos
            if (!has) continue
            switch (ch) {
              case 88:
                nx = absPos ? v : x + v
                break
              case 89:
                ny = absPos ? v : y + v
                break
              case 90:
                nz = absPos ? v : z + v
                break
              case 69:
                hasE = true
                de = absE ? v - e : v
                e = absE ? v : e + v
                break
              case 70:
                if (v > 0) feed = v
                break
              case 73:
                I = v
                break
              case 74:
                J = v
                break
              case 82:
                R = v
                break
            }
          } else k++
        }
        if (!hasE) de = 0
        if (code <= 1) linear(nx, ny, nz, de, lineOffset)
        else {
          // Arc → short linear pieces
          let cx: number
          let cy: number
          const cw = code === 2
          if (!Number.isNaN(R) && I === 0 && J === 0) {
            const dx = nx - x
            const dy = ny - y
            const d = Math.hypot(dx, dy)
            const r = Math.abs(R)
            const hgt = Math.sqrt(Math.max(0, r * r - (d * d) / 4))
            const sgn = (cw ? 1 : -1) * (R < 0 ? -1 : 1)
            cx = x + dx / 2 - (sgn * hgt * dy) / (d || 1)
            cy = y + dy / 2 + (sgn * hgt * dx) / (d || 1)
          } else {
            cx = x + I
            cy = y + J
          }
          const r = Math.hypot(x - cx, y - cy)
          const a0 = Math.atan2(y - cy, x - cx)
          let a1 = Math.atan2(ny - cy, nx - cx)
          let sweep = a1 - a0
          if (cw && sweep >= -1e-9) sweep -= Math.PI * 2
          if (!cw && sweep <= 1e-9) sweep += Math.PI * 2
          a1 = a0 + sweep
          const n = Math.max(1, Math.min(720, Math.ceil((Math.abs(sweep) * r) / 0.6)))
          const z0 = z
          for (let s = 1; s <= n; s++) {
            const t = s / n
            const a = a0 + sweep * t
            linear(s === n ? nx : cx + Math.cos(a) * r, s === n ? ny : cy + Math.sin(a) * r, z0 + (nz - z0) * t, de / n, lineOffset)
          }
        }
      } else if (code === 90) absPos = true
      else if (code === 91) absPos = false
      else if (code === 92) {
        let k = pos
        while (k < le) {
          const ch = buf[k] & 0xdf
          if (buf[k] === 59) break
          if (ch >= 65 && ch <= 90) {
            pos = k + 1
            const v = num(le)
            k = pos
            if (!has) continue
            if (ch === 88) x = v
            else if (ch === 89) y = v
            else if (ch === 90) z = v
            else if (ch === 69) e = v
          } else k++
        }
      } else if (code === 28) {
        x = 0
        y = 0
        z = 0
      }
      return
    }
    if (C === 77) {
      // M
      pos = i + 1
      const code = num(le)
      if (!has) return
      if (code === 82) absE = true
      else if (code === 83) absE = false
      else if (code === 104 || code === 109 || code === 106) {
        let s = Number.NaN
        let p = 0
        let k = pos
        while (k < le) {
          const ch = buf[k] & 0xdf
          if (buf[k] === 59) break
          if (ch === 83 || ch === 80 || ch === 84) {
            pos = k + 1
            const v = num(le)
            k = pos
            if (!has) continue
            if (ch === 83) s = v
            else p = v
          } else k++
        }
        if (Number.isNaN(s)) return
        if (code === 106) {
          if (p === 0) curFan = Math.max(0, Math.min(255, Math.round(s)))
        } else if (s > 0 || code === 104) curTemp = Math.max(0, Math.min(65535, Math.round(s)))
      } else if (code === 107) curFan = 0
      return
    }
    if (C === 84) {
      // T<n>
      const d = buf[i + 1] - 48
      if (d >= 0 && d <= 9) {
        pos = i + 1
        const v = num(le)
        if (has && v >= 0 && v < 16) curTool = v
      }
    }
  }

  // Stream ------------------------------------------------------------------
  const reader = blob.stream().getReader()
  let carry = new Uint8Array(0)
  let base = 0 // absolute offset of buf[0]
  let nextProgress = PROGRESS_EVERY
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (carry.length) {
      buf = new Uint8Array(carry.length + value.length)
      buf.set(carry)
      buf.set(value, carry.length)
    } else buf = value
    let ls = 0
    const n = buf.length
    for (let k = 0; k < n; k++) {
      if (buf[k] === 10) {
        line(ls, k, base + ls)
        ls = k + 1
      }
    }
    carry = buf.slice(ls)
    base += ls
    if (base >= nextProgress) {
      post({ type: 'progress', loaded: base, total })
      nextProgress = base + PROGRESS_EVERY
    }
  }
  if (carry.length) {
    buf = carry
    line(0, carry.length, base)
  }
  if (layers > 0) layerTime.push(curLayerTime)
  layerStart.push(type.n)
  layerTravelStart.push(travel.n / 6)

  if (!Number.isFinite(bbox[0])) bbox.fill(0)
  const count = type.n
  return {
    seg: seg.trim(),
    type: type.trim(),
    tool: tool.trim(),
    fan: fan.trim(),
    speed: speed.trim(),
    temp: temp.trim(),
    offset: offset.trim(),
    obj: obj.trim(),
    objects,
    count,
    travel: travel.trim(),
    travelCount: travel.n / 6,
    layerStart: layerStart.trim(),
    layerTravelStart: layerTravelStart.trim(),
    layerZ: layerZ.trim(),
    layerTime: layerTime.trim(),
    layers,
    featureTime,
    featureCount,
    toolMm,
    bbox,
    modelSeconds,
    meta,
    bytes: total,
    lines,
    parseMs: Math.round(performance.now() - t0),
  }
}

const ctx = self as unknown as {
  postMessage: (msg: WorkerResponse, transfer?: Transferable[]) => void
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null
}
ctx.onmessage = async (ev) => {
  if (ev.data.type !== 'parse') return
  try {
    const result = await parse(ev.data.blob, (m) => ctx.postMessage(m))
    const transfer = [
      result.seg.buffer,
      result.type.buffer,
      result.tool.buffer,
      result.fan.buffer,
      result.speed.buffer,
      result.temp.buffer,
      result.offset.buffer,
      result.obj.buffer,
      result.travel.buffer,
      result.layerStart.buffer,
      result.layerTravelStart.buffer,
      result.layerZ.buffer,
      result.layerTime.buffer,
    ] as ArrayBuffer[]
    ctx.postMessage({ type: 'done', result } satisfies WorkerResponse, transfer)
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) } satisfies WorkerResponse)
  }
}
