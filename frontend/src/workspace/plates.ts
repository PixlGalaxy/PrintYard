// Plate layout, same rule as Creality Print / Orca (PartPlate.cpp): plates form a grid of
// ceil(sqrt(n)) columns, each offset by 1.2 × the printable width/depth.

export interface BedSize {
  /** printable width (X), mm */
  w: number
  /** printable depth (Y), mm */
  d: number
  /** printable height (Z), mm */
  h: number
}

/** Creality K2 SE (`printable_area` 0x0,220x0,220x215,0x215, `printable_height` 245) */
export const K2SE_BED: BedSize = { w: 220, d: 215, h: 245 }

/** Parses `printable_area` ("0x0,220x0,220x215,0x215") and `printable_height` from a machine preset. */
export function bedFromMachine(values: Record<string, string> | undefined): BedSize {
  if (!values) return K2SE_BED
  const pts = (values.printable_area ?? '')
    .split(',')
    .map((p) => p.split('x').map(Number))
    .filter((p) => p.length === 2 && p.every(Number.isFinite))
  const h = Number(values.printable_height)
  if (pts.length < 3) return K2SE_BED
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return {
    w: Math.max(...xs) - Math.min(...xs) || K2SE_BED.w,
    d: Math.max(...ys) - Math.min(...ys) || K2SE_BED.d,
    h: Number.isFinite(h) && h > 0 ? h : K2SE_BED.h,
  }
}

export const plateColumns = (count: number) => Math.max(1, Math.ceil(Math.sqrt(count)))

/** World origin (front-left corner) of plate `index` (0-based). */
export function plateOrigin(index: number, count: number, bed: BedSize): [number, number] {
  const cols = plateColumns(count)
  return [(index % cols) * bed.w * 1.2, -Math.floor(index / cols) * bed.d * 1.2]
}

/** Plate whose (gap-extended) area contains world point x,y, or -1. */
export function plateAt(x: number, y: number, count: number, bed: BedSize): number {
  let best = -1
  let bestDist = Infinity
  for (let i = 0; i < count; i++) {
    const [ox, oy] = plateOrigin(i, count, bed)
    const cx = ox + bed.w / 2
    const cy = oy + bed.d / 2
    // Each plate "owns" its cell of the grid (plate + half the gap on every side)
    if (Math.abs(x - cx) <= bed.w * 0.6 && Math.abs(y - cy) <= bed.d * 0.6) return i
    const dist = Math.hypot(x - cx, y - cy)
    if (dist < bestDist) {
      bestDist = dist
      best = i
    }
  }
  return best
}
