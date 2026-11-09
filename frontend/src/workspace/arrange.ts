// 2D placement on plates: shelf bin packing of XY footprints (bounding rectangles) with spacing,
// overflowing onto extra plates, and a "free spot" search for newly imported objects.
import type { BedSize } from './plates'

export interface Footprint {
  id: string
  w: number
  d: number
}

export interface Placement {
  id: string
  plate: number
  /** centre of the footprint, plate-local */
  cx: number
  cy: number
}

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * Packs footprints onto `plates` (plate indices to fill, in order); items that fit nowhere go to new plates
 * numbered from `nextPlate`. Each plate's layout is centred on the bed.
 */
export function pack(items: Footprint[], bed: BedSize, spacing: number, plates: number[], nextPlate: number): Placement[] {
  const sorted = [...items].sort((a, b) => b.d - a.d || b.w - a.w)
  const out: Placement[] = []
  const queue = [...plates]
  let remaining = sorted
  while (remaining.length) {
    const plate = queue.length ? queue.shift()! : nextPlate++
    const placed: { it: Footprint; x: number; y: number }[] = []
    const rest: Footprint[] = []
    let x = 0
    let y = 0
    let rowD = 0
    let full = false
    for (const it of remaining) {
      if (full) {
        rest.push(it)
        continue
      }
      // Oversized items get a plate of their own (they will show as out of bounds)
      if (it.w > bed.w || it.d > bed.d) {
        if (!placed.length) {
          placed.push({ it, x: 0, y: 0 })
          full = true
        } else rest.push(it)
        continue
      }
      if (x > 0 && x + it.w > bed.w) {
        x = 0
        y += rowD + spacing
        rowD = 0
      }
      if (y + it.d > bed.d) {
        rest.push(it)
        continue
      }
      placed.push({ it, x, y })
      x += it.w + spacing
      rowD = Math.max(rowD, it.d)
    }
    if (!placed.length) {
      // Nothing fits even on an empty plate: force the first item
      placed.push({ it: rest.shift()!, x: 0, y: 0 })
    }
    const maxX = Math.max(...placed.map((p) => p.x + p.it.w))
    const maxY = Math.max(...placed.map((p) => p.y + p.it.d))
    const ox = (bed.w - maxX) / 2
    const oy = (bed.d - maxY) / 2
    for (const p of placed) out.push({ id: p.it.id, plate, cx: ox + p.x + p.it.w / 2, cy: oy + p.y + p.it.d / 2 })
    remaining = rest
  }
  return out
}

const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0

/** Closest free position to the bed centre for a w×d footprint, or null if the plate is full. */
export function findFreeSpot(w: number, d: number, occupied: Rect[], bed: BedSize, spacing: number): { cx: number; cy: number } | null {
  const cx0 = bed.w / 2
  const cy0 = bed.d / 2
  if (w > bed.w || d > bed.d) return occupied.length ? null : { cx: cx0, cy: cy0 }
  const step = 4
  const candidates: [number, number][] = []
  for (let cx = w / 2; cx <= bed.w - w / 2 + 1e-6; cx += step) {
    for (let cy = d / 2; cy <= bed.d - d / 2 + 1e-6; cy += step) candidates.push([cx, cy])
  }
  candidates.push([cx0, cy0])
  candidates.sort((a, b) => Math.hypot(a[0] - cx0, a[1] - cy0) - Math.hypot(b[0] - cx0, b[1] - cy0))
  const half = spacing / 2
  for (const [cx, cy] of candidates) {
    const r = { x0: cx - w / 2 - half, y0: cy - d / 2 - half, x1: cx + w / 2 + half, y1: cy + d / 2 + half }
    if (!occupied.some((o) => overlaps(r, { x0: o.x0 - half, y0: o.y0 - half, x1: o.x1 + half, y1: o.y1 + half }))) return { cx, cy }
  }
  return null
}
