// Build plate visuals: rounded bed surface, 10/50 mm grid, outline, plate number, origin axes, build volume.
import {
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Shape,
  ShapeGeometry,
  SRGBColorSpace,
} from 'three'
import type { BedSize } from '../workspace/plates'

export interface BedTheme {
  surface: string
  surfaceActive: string
  gridMinor: string
  gridMajor: string
  border: string
  borderActive: string
  label: string
  volume: string
}

export const BED_THEMES: Record<'light' | 'dark', BedTheme> = {
  light: {
    surface: '#e4e8ee',
    surfaceActive: '#e9edf3',
    gridMinor: '#d3d9e2',
    gridMajor: '#bcc5d1',
    border: '#a7b1bf',
    borderActive: '#0ea5e9',
    label: 'rgba(71,85,105,0.30)',
    volume: '#94a3b8',
  },
  dark: {
    surface: '#151922',
    surfaceActive: '#181d27',
    gridMinor: '#212734',
    gridMajor: '#2b3343',
    border: '#3a4354',
    borderActive: '#38bdf8',
    label: 'rgba(148,163,184,0.22)',
    volume: '#4b5568',
  },
}

function roundedRect(w: number, d: number, r: number) {
  const s = new Shape()
  s.moveTo(r, 0)
  s.lineTo(w - r, 0)
  s.quadraticCurveTo(w, 0, w, r)
  s.lineTo(w, d - r)
  s.quadraticCurveTo(w, d, w - r, d)
  s.lineTo(r, d)
  s.quadraticCurveTo(0, d, 0, d - r)
  s.lineTo(0, r)
  s.quadraticCurveTo(0, 0, r, 0)
  return s
}

function labelTexture(text: string, color: string) {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 256
  const ctx = c.getContext('2d')!
  ctx.fillStyle = color
  ctx.font = '600 180px Inter Variable, Inter, system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 128, 140)
  const tex = new CanvasTexture(c)
  tex.colorSpace = SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

/** One plate at its world origin. `active` gets the accent outline and the build-volume box. */
export function buildPlate(bed: BedSize, index: number, active: boolean, theme: BedTheme): Group {
  const g = new Group()
  g.name = `plate-${index}`
  g.userData.plate = index
  const { w, d, h } = bed

  const surface = new Mesh(
    new ShapeGeometry(roundedRect(w, d, 6), 6),
    new MeshBasicMaterial({ color: active ? theme.surfaceActive : theme.surface, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
  )
  surface.position.z = -0.02
  surface.userData.plate = index
  surface.name = 'bed-surface'
  g.add(surface)

  // Grid (minor every 10 mm, major every 50 mm)
  const minor: number[] = []
  const major: number[] = []
  for (let x = 10; x < w; x += 10) (x % 50 === 0 ? major : minor).push(x, 0, 0, x, d, 0)
  for (let y = 10; y < d; y += 10) (y % 50 === 0 ? major : minor).push(0, y, 0, w, y, 0)
  const lines = (pts: number[], color: string) => {
    const geo = new BufferGeometry()
    geo.setAttribute('position', new Float32BufferAttribute(pts, 3))
    return new LineSegments(geo, new LineBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false }))
  }
  g.add(lines(minor, theme.gridMinor), lines(major, theme.gridMajor))

  // Outline
  const outline = new BufferGeometry().setFromPoints(roundedRect(w, d, 6).getPoints(8))
  const border = new Line(outline, new LineBasicMaterial({ color: active ? theme.borderActive : theme.border, transparent: true, opacity: active ? 0.95 : 0.7 }))
  border.position.z = 0.01
  g.add(border)

  // Plate number in the front-left corner
  // (the active plate's number takes the skin's accent, translucent)
  const labelColor = active ? `#${new Color(theme.borderActive).getHexString()}8c` : theme.label
  const label = new Mesh(new PlaneGeometry(34, 34), new MeshBasicMaterial({ map: labelTexture(String(index + 1), labelColor), transparent: true, depthWrite: false }))
  label.position.set(22, 22, 0.02)
  g.add(label)

  // Origin axes (X red, Y green)
  const axes = new BufferGeometry()
  axes.setAttribute('position', new Float32BufferAttribute([0, 0, 0.05, 18, 0, 0.05, 0, 0, 0.05, 0, 18, 0.05], 3))
  const red = new Color('#ef4444')
  const green = new Color('#22c55e')
  axes.setAttribute('color', new Float32BufferAttribute([red.r, red.g, red.b, red.r, red.g, red.b, green.r, green.g, green.b, green.r, green.g, green.b], 3))
  g.add(new LineSegments(axes, new LineBasicMaterial({ vertexColors: true, linewidth: 2 })))

  if (active) {
    const v: number[] = []
    const top = [
      [0, 0],
      [w, 0],
      [w, d],
      [0, d],
    ]
    for (let i = 0; i < 4; i++) {
      const [x0, y0] = top[i]
      const [x1, y1] = top[(i + 1) % 4]
      v.push(x0, y0, h, x1, y1, h)
      v.push(x0, y0, 0, x0, y0, h)
    }
    const geo = new BufferGeometry()
    geo.setAttribute('position', new Float32BufferAttribute(v, 3))
    g.add(new LineSegments(geo, new LineBasicMaterial({ color: theme.volume, transparent: true, opacity: 0.35, depthWrite: false })))
  }
  return g
}

export function disposeGroup(g: Group) {
  g.traverse((o) => {
    const m = o as Mesh
    m.geometry?.dispose()
    const mat = m.material as MeshBasicMaterial | MeshBasicMaterial[] | undefined
    for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) {
      x.map?.dispose()
      x.dispose()
    }
  })
}
