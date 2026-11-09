import { FEATURE_COLORS, FEATURES, type ParsedGcode } from './types'

export type ColorMode = 'feature' | 'speed' | 'height' | 'width' | 'fan' | 'temperature' | 'filament' | 'layerTime'
export const COLOR_MODES: ColorMode[] = ['feature', 'filament', 'speed', 'height', 'width', 'fan', 'temperature', 'layerTime']

/** Orca-like range palette (cold → hot) */
export const RANGE_STOPS = ['#0b2c7a', '#135985', '#1c8891', '#04d60f', '#aaf200', '#fcf903', '#f5ce0a', '#d16830', '#c2523c', '#942616']

const hex = (h: string): [number, number, number] => {
  const n = parseInt(h.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const STOPS = RANGE_STOPS.map(hex)
const FEATURE_RGB = FEATURES.map((f) => hex(FEATURE_COLORS[f]))

export interface ColorResult {
  /** rgb per segment */
  colors: Uint8Array
  /** gradient modes: value range */
  range?: { min: number; max: number; unit: string; decimals: number }
}

function lerpStops(t: number, out: Uint8Array, o: number) {
  const x = Math.min(1, Math.max(0, t)) * (STOPS.length - 1)
  const i = Math.min(STOPS.length - 2, Math.floor(x))
  const f = x - i
  const a = STOPS[i]
  const b = STOPS[i + 1]
  out[o] = a[0] + (b[0] - a[0]) * f
  out[o + 1] = a[1] + (b[1] - a[1]) * f
  out[o + 2] = a[2] + (b[2] - a[2]) * f
}

/** Robust min/max (ignores the extreme 0.5 % so a single odd move does not flatten the scale). */
function range(get: (i: number) => number, n: number): [number, number] {
  if (n === 0) return [0, 1]
  const step = Math.max(1, Math.floor(n / 20000))
  const sample: number[] = []
  for (let i = 0; i < n; i += step) sample.push(get(i))
  sample.sort((a, b) => a - b)
  const lo = sample[Math.floor(sample.length * 0.005)]
  const hi = sample[Math.min(sample.length - 1, Math.ceil(sample.length * 0.995))]
  return lo === hi ? [lo - 0.5, hi + 0.5] : [lo, hi]
}

export function computeColors(g: ParsedGcode, mode: ColorMode, filamentColors: string[]): ColorResult {
  const n = g.count
  const out = new Uint8Array(n * 3)
  if (mode === 'feature') {
    for (let i = 0; i < n; i++) {
      const c = FEATURE_RGB[g.type[i]]
      out[i * 3] = c[0]
      out[i * 3 + 1] = c[1]
      out[i * 3 + 2] = c[2]
    }
    return { colors: out }
  }
  if (mode === 'filament') {
    const cols = Array.from({ length: 16 }, (_, k) => hex(filamentColors[k] ?? RANGE_STOPS[(k * 3) % RANGE_STOPS.length]))
    for (let i = 0; i < n; i++) {
      const c = cols[g.tool[i]]
      out[i * 3] = c[0]
      out[i * 3 + 1] = c[1]
      out[i * 3 + 2] = c[2]
    }
    return { colors: out }
  }
  let get: (i: number) => number
  let unit = ''
  let decimals = 0
  switch (mode) {
    case 'speed':
      get = (i) => g.speed[i]
      unit = 'mm/s'
      break
    case 'height':
      get = (i) => g.seg[i * 8 + 7]
      unit = 'mm'
      decimals = 2
      break
    case 'width':
      get = (i) => g.seg[i * 8 + 6]
      unit = 'mm'
      decimals = 2
      break
    case 'fan':
      get = (i) => (g.fan[i] / 255) * 100
      unit = '%'
      break
    case 'temperature':
      get = (i) => g.temp[i]
      unit = '°C'
      break
    case 'layerTime': {
      // Per-segment lookup of its layer's time
      const layerOf = new Float32Array(n)
      for (let l = 0; l < g.layers; l++) for (let i = g.layerStart[l]; i < g.layerStart[l + 1]; i++) layerOf[i] = g.layerTime[l]
      get = (i) => layerOf[i]
      unit = 's'
      decimals = 1
      break
    }
  }
  const [min, max] = mode === 'fan' ? [0, 100] : range(get, n)
  const span = max - min || 1
  for (let i = 0; i < n; i++) lerpStops((get(i) - min) / span, out, i * 3)
  return { colors: out, range: { min, max, unit, decimals } }
}
