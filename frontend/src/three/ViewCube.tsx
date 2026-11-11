// Tinkercad-style view cube (Prepare, Preview, Live view). A 2D canvas draws a chamfered cube from the main camera's
// rotation with an orthographic projection (no extra WebGL context), and redraws only when that rotation, the
// hover, the theme, the skin or the language changes. 26 clickable regions: 6 faces, 12 edges, 8 corners.
// Drag orbits the main camera. When a face is aligned: 90° arrows (and roll arrows for top/bottom).
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Ellipsis, House, RotateCcw, RotateCw } from 'lucide-react'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Vector3, type Matrix4 } from 'three'
import { useTheme } from '../context/ThemeContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'
import { useAccent } from '../theme/accent'
import type { CubeCamera } from './cameraRig'

export interface ViewCubeHandle {
  /** Rotation of the main camera's view matrix (world → camera); cheap to call every frame. */
  update: (view: Matrix4) => void
}

interface Props {
  /** The camera to drive (read lazily: viewports are created in effects). */
  camera: () => CubeCamera | null
  /** Shows a Home button (default view). */
  onHome?: () => void
  className?: string
}

type V3 = [number, number, number]
type FaceKey = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right'

const SIZE = 110
/** Half the cube edge in CSS px (max projected extent 2·H·√3 ≈ 97 px; the shadow sits below) */
const H = 28
/** Chamfer: faces span ±A of the half edge, edge strips and corner facets fill the rest */
const A = 0.7
const DRAG_RAD_PER_PX = Math.PI / 120

// Face: outward normal n and text "up" u in world coordinates (Z up, −Y = front)
const FACES: { key: FaceKey; n: V3; u: V3 }[] = [
  { key: 'top', n: [0, 0, 1], u: [0, 1, 0] },
  { key: 'bottom', n: [0, 0, -1], u: [0, -1, 0] },
  { key: 'front', n: [0, -1, 0], u: [0, 0, 1] },
  { key: 'back', n: [0, 1, 0], u: [0, 0, 1] },
  { key: 'left', n: [-1, 0, 0], u: [0, 0, 1] },
  { key: 'right', n: [1, 0, 0], u: [0, 0, 1] },
]

const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const dirKey = (d: V3) => d.join(',')

/** One facet of the chamfered cube: 6 faces, 12 edge strips, 8 corner triangles (one per view direction). */
interface Facet {
  kind: 'face' | 'edge' | 'corner'
  dir: V3
  key: string
  /** unit outward normal */
  n: V3
  pts: V3[]
  face?: (typeof FACES)[number]
}

/** Vertices of a convex planar polygon, ordered by angle around its centre */
function ordered(pts: V3[], n: V3): V3[] {
  const c = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length) as V3
  const ref = [0, 1, 2].map((k) => pts[0][k] - c[k]) as V3
  const ref2 = cross(n, ref)
  const ang = (p: V3) => {
    const v = [0, 1, 2].map((k) => p[k] - c[k]) as V3
    return Math.atan2(dot(v, ref2), dot(v, ref))
  }
  return [...pts].sort((a, b) => ang(a) - ang(b))
}

const FACETS: Facet[] = (() => {
  const out: Facet[] = []
  const vals = [-1, 0, 1]
  for (const x of vals)
    for (const y of vals)
      for (const z of vals) {
        const d: V3 = [x, y, z]
        const count = d.filter(Boolean).length
        if (!count) continue
        const len = Math.hypot(x, y, z)
        const n: V3 = [x / len, y / len, z / len]
        const pts: V3[] = []
        if (count === 1) {
          // Inset square face
          const k = d.findIndex(Boolean)
          const [i, j] = [0, 1, 2].filter((q) => q !== k)
          for (const s of [-A, A])
            for (const t of [-A, A]) {
              const p: V3 = [0, 0, 0]
              p[k] = d[k]
              p[i] = s
              p[j] = t
              pts.push(p)
            }
        } else if (count === 2) {
          // Strip joining the two faces' edges, running along the free axis
          const free = d.findIndex((v) => !v)
          const [i, j] = [0, 1, 2].filter((q) => q !== free)
          for (const s of [-A, A])
            for (const swap of [false, true]) {
              const p: V3 = [0, 0, 0]
              p[free] = s
              p[i] = d[i] * (swap ? A : 1)
              p[j] = d[j] * (swap ? 1 : A)
              pts.push(p)
            }
        } else {
          // Corner triangle
          for (let k = 0; k < 3; k++) pts.push([0, 1, 2].map((q) => d[q] * (q === k ? 1 : A)) as V3)
        }
        out.push({
          kind: count === 1 ? 'face' : count === 2 ? 'edge' : 'corner',
          dir: d,
          key: dirKey(d),
          n,
          pts: ordered(pts, n),
          face: count === 1 ? FACES.find((f) => dirKey(f.n) === dirKey(d)) : undefined,
        })
      }
  return out
})()

// The 26 directions, faces first, then edges, then corners (keyboard menu)
const DIRS: V3[] = FACETS.map((f) => f.dir).sort((a, b) => a.filter(Boolean).length - b.filter(Boolean).length)

function dirParts(d: V3): FaceKey[] {
  const out: FaceKey[] = []
  if (d[2]) out.push(d[2] > 0 ? 'top' : 'bottom')
  if (d[1]) out.push(d[1] < 0 ? 'front' : 'back')
  if (d[0]) out.push(d[0] < 0 ? 'left' : 'right')
  return out
}

/** The world axis (±x/±y/±z) closest to v */
function snapAxis(v: V3): V3 {
  let k = 0
  for (let i = 1; i < 3; i++) if (Math.abs(v[i]) > Math.abs(v[k])) k = i
  const out: V3 = [0, 0, 0]
  out[k] = v[k] < 0 ? -1 : 1
  return out
}

const neg = (v: V3): V3 => [-v[0], -v[1], -v[2]]
const vec = (v: V3) => new Vector3(v[0], v[1], v[2])

interface Colors {
  surface: string
  fg: string
  accent: string
  accentText: string
  dark: boolean
}

function readColors(accent: string, dark: boolean): Colors {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
  return {
    surface: v('--surface', dark ? '#161b22' : '#ffffff'),
    fg: v('--fg', dark ? '#e6e9ee' : '#111827'),
    accent,
    accentText: '#ffffff',
    dark,
  }
}

function pointInPoly(x: number, y: number, q: [number, number][]) {
  let sign = 0
  for (let i = 0; i < q.length; i++) {
    const [ax, ay] = q[i]
    const [bx, by] = q[(i + 1) % q.length]
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
    if (Math.abs(c) < 1e-9) continue
    const s = c > 0 ? 1 : -1
    if (sign && s !== sign) return false
    sign = s
  }
  return sign !== 0
}

const FAMILY = '"Inter Variable", Inter, ui-sans-serif, system-ui, sans-serif'
/** Light direction in view space (upper left, towards the viewer) */
const LIGHT: V3 = [-0.35, 0.55, 0.76]

const ViewCube = forwardRef<ViewCubeHandle, Props>(function ViewCube({ camera, onHome, className = '' }, ref) {
  const { t, language } = useI18n()
  const { resolved } = useTheme()
  const palette = useAccent()
  const canvas = useRef<HTMLCanvasElement>(null)
  const root = useRef<HTMLDivElement>(null)
  // Row-major rotation rows: right, up, back (world axes of the camera)
  const rot = useRef<number[]>([1, 0, 0, 0, 0, 1, 0, -1, 0])
  const hover = useRef<string | null>(null)
  const colors = useRef<Colors | null>(null)
  const labels = useRef<Record<FaceKey, string>>({ top: '', bottom: '', front: '', back: '', left: '', right: '' })
  const drag = useRef<{ x: number; y: number; moved: boolean; id: number } | null>(null)
  const [aligned, setAligned] = useState<'none' | 'side' | 'pole'>('none')
  const alignedRef = useRef(aligned)
  const [menu, setMenu] = useState(false)

  const project = useCallback((p: V3): [number, number] => {
    const m = rot.current
    return [SIZE / 2 + (m[0] * p[0] + m[1] * p[1] + m[2] * p[2]) * H, SIZE / 2 - (m[3] * p[0] + m[4] * p[1] + m[5] * p[2]) * H]
  }, [])
  const facing = useCallback((n: V3) => {
    const m = rot.current
    return m[6] * n[0] + m[7] * n[1] + m[8] * n[2]
  }, [])

  const draw = useCallback(() => {
    const el = canvas.current
    const col = colors.current
    if (!el || !col) return
    const ctx = el.getContext('2d')
    if (!ctx) return
    const dpr = el.width / SIZE
    const m = rot.current
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, el.width, el.height)
    const poly = (pts: [number, number][], dx = 0) => {
      ctx.beginPath()
      pts.forEach(([x, y], i) => (i ? ctx.lineTo((x + dx) * dpr, y * dpr) : ctx.moveTo((x + dx) * dpr, y * dpr)))
      ctx.closePath()
    }

    // Soft shadow: a disc on a plane under the cube, blurred; fades out when looking from below.
    // Drawn far off-canvas so only its shadow lands in place (shadowBlur works everywhere, ctx.filter doesn't).
    const fromAbove = m[8]
    if (fromAbove > 0.02) {
      const ring: [number, number][] = []
      for (let i = 0; i < 40; i++) {
        const a = (i / 40) * Math.PI * 2
        ring.push(project([Math.cos(a) * 1.1, Math.sin(a) * 1.1, -1.3]))
      }
      const off = 1000
      ctx.save()
      ctx.shadowColor = `rgba(0,0,0,${((col.dark ? 0.6 : 0.24) * Math.min(1, fromAbove * 2.5)).toFixed(3)})`
      ctx.shadowBlur = 7 * dpr
      ctx.shadowOffsetX = off * dpr
      poly(ring, -off)
      ctx.fillStyle = '#000'
      ctx.fill()
      ctx.restore()
    }

    for (const f of FACETS) {
      const nz = facing(f.n)
      if (nz <= 1e-3) continue
      const hovered = f.key === hover.current
      poly(f.pts.map(project))
      if (hovered) {
        ctx.fillStyle = col.accent
        ctx.fill()
      } else {
        ctx.fillStyle = col.surface
        ctx.fill()
        const nv: V3 = [m[0] * f.n[0] + m[1] * f.n[1] + m[2] * f.n[2], m[3] * f.n[0] + m[4] * f.n[1] + m[5] * f.n[2], nz]
        const lit = Math.max(0, dot(nv, LIGHT))
        // Bevels get their own tone so they read as part of the cube
        const tone = f.kind === 'face' ? 0 : f.kind === 'edge' ? 1 : 1.6
        if (col.dark && tone) {
          ctx.fillStyle = `rgba(255,255,255,${(0.05 * tone).toFixed(3)})`
          ctx.fill()
        }
        const shade = col.dark ? 0.45 * (1 - lit) : 0.2 * (1 - lit) + 0.06 * tone
        ctx.fillStyle = `rgba(0,0,0,${shade.toFixed(3)})`
        ctx.fill()
      }
      ctx.strokeStyle = col.dark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.2)'
      ctx.lineWidth = Math.max(1, 0.75 * dpr)
      ctx.lineJoin = 'round'
      ctx.stroke()

      // Label: affine map of the face plane (local px when aligned), hidden when too oblique
      if (!f.face || nz < 0.18) continue
      const r = cross(f.face.u, f.face.n)
      const u = f.face.u
      const [cx, cy] = project(f.face.n)
      const a = m[0] * r[0] + m[1] * r[1] + m[2] * r[2]
      const b = -(m[3] * r[0] + m[4] * r[1] + m[5] * r[2])
      const c = -(m[0] * u[0] + m[1] * u[1] + m[2] * u[2])
      const d = m[3] * u[0] + m[4] * u[1] + m[5] * u[2]
      ctx.save()
      ctx.setTransform(a * dpr, b * dpr, c * dpr, d * dpr, cx * dpr, cy * dpr)
      const text = labels.current[f.face.key].toLocaleUpperCase(language)
      ctx.font = `700 10px ${FAMILY}`
      const w = ctx.measureText(text).width
      const size = Math.max(6, Math.min(11, (10 * (2 * A * H * 0.9)) / Math.max(1, w)))
      ctx.font = `700 ${size.toFixed(2)}px ${FAMILY}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.globalAlpha = Math.min(1, (nz - 0.18) / 0.3) * (hovered ? 1 : 0.75)
      ctx.fillStyle = hovered ? col.accentText : col.fg
      ctx.fillText(text, 0, 0.5)
      ctx.restore()
    }
  }, [facing, project, language])

  const hit = useCallback(
    (x: number, y: number): Facet | null => {
      for (const f of FACETS) if (facing(f.n) > 1e-3 && pointInPoly(x, y, f.pts.map(project))) return f
      return null
    },
    [facing, project],
  )

  useImperativeHandle(
    ref,
    () => (handle.current = {
      update(view: Matrix4) {
        const e = view.elements
        const next = [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]]
        const prev = rot.current
        let same = true
        for (let i = 0; i < 9; i++) if (Math.abs(next[i] - prev[i]) > 1e-6) same = false
        if (same) return
        rot.current = next
        draw()
        const back: V3 = [next[6], next[7], next[8]]
        const top = Math.max(...back.map(Math.abs))
        const state = top < 0.9995 ? 'none' : Math.abs(back[2]) > 0.9995 ? 'pole' : 'side'
        if (state !== alignedRef.current) {
          alignedRef.current = state
          setAligned(state)
        }
      },
    }),
    [draw],
  )

  // Initial orientation (the cube may mount after the camera last moved)
  const handle = useRef<ViewCubeHandle | null>(null)
  const cameraRef = useRef(camera)
  useEffect(() => {
    cameraRef.current = camera
  })
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const cam = cameraRef.current()
      if (cam) handle.current?.update(cam.viewRotation())
    })
    return () => cancelAnimationFrame(id)
  }, [])

  // Theme, skin and language → redraw
  useEffect(() => {
    colors.current = readColors(palette[500], resolved === 'dark')
    labels.current = { top: t('workspace.view.top'), bottom: t('workspace.view.bottom'), front: t('workspace.view.front'), back: t('workspace.view.back'), left: t('workspace.view.left'), right: t('workspace.view.right') }
    draw()
  }, [palette, resolved, t, draw])

  // Canvas backing store at the device pixel ratio; redraw once the web font is ready
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1))
    el.width = Math.round(SIZE * dpr)
    el.height = Math.round(SIZE * dpr)
    draw()
    let live = true
    document.fonts?.ready.then(() => live && draw(), () => undefined)
    return () => {
      live = false
    }
  }, [draw])

  // Menu: close on outside press / Escape
  useEffect(() => {
    if (!menu) return
    const down = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setMenu(false)
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false)
    document.addEventListener('pointerdown', down)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', down)
      document.removeEventListener('keydown', key)
    }
  }, [menu])

  const setHover = (key: string | null) => {
    if (hover.current === key) return
    hover.current = key
    draw()
  }

  /** Current camera basis snapped to world axes: back (target → camera), screen-up, screen-right */
  const basis = () => {
    const m = rot.current
    const back = snapAxis([m[6], m[7], m[8]])
    const upRaw: V3 = [m[3], m[4], m[5]]
    const k = back.findIndex((x) => x !== 0)
    upRaw[k] = 0
    const up = snapAxis(upRaw)
    return { back, up, right: snapAxis([m[0], m[1], m[2]]) }
  }

  const lookFrom = (dir: V3) => {
    const cam = camera()
    if (!cam) return
    let up: Vector3 | undefined
    if (!dir[0] && !dir[1]) {
      // Top/bottom: keep the screen-up closest to the current one
      const m = rot.current
      const hx = m[3]
      const hy = m[4]
      if (hx * hx + hy * hy > 1e-6) up = Math.abs(hx) > Math.abs(hy) ? new Vector3(Math.sign(hx), 0, 0) : new Vector3(0, Math.sign(hy), 0)
    }
    cam.lookFrom(vec(dir), up)
  }

  const step = (kind: 'up' | 'down' | 'left' | 'right' | 'cw' | 'ccw') => {
    const cam = camera()
    if (!cam) return
    const { back, up, right } = basis()
    const fwd = neg(back)
    const moves: Record<typeof kind, [V3, V3]> = {
      up: [up, fwd],
      down: [neg(up), back],
      left: [neg(right), up],
      right: [right, up],
      cw: [back, cross(up, fwd)],
      ccw: [back, cross(fwd, up)],
    }
    const [dir, newUp] = moves[kind]
    cam.lookFrom(vec(dir), vec(newUp))
  }

  const local = (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect()
    return [((e.clientX - r.left) / r.width) * SIZE, ((e.clientY - r.top) / r.height) * SIZE] as const
  }

  const name = (d: V3) =>
    dirParts(d)
      .map((k) => t(`workspace.view.${k}` as TranslationKey))
      .join(', ')

  const arrowCls =
    'absolute z-10 inline-flex size-5 items-center justify-center rounded-md text-fg/45 transition hover:bg-accent-500/12 hover:text-accent-600 focus-visible:outline-2 focus-visible:outline-accent-500 dark:hover:text-accent-400'
  const cornerCls = `${arrowCls} opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100`

  return (
    <div ref={root} className={`group relative shrink-0 select-none ${className}`} style={{ width: SIZE, height: SIZE }} role="group" aria-label={t('viewCube.label')}>
      <canvas
        ref={canvas}
        width={SIZE}
        height={SIZE}
        role="img"
        aria-label={t('viewCube.hint')}
        title={t('viewCube.hint')}
        className="absolute inset-0 touch-none"
        style={{ width: SIZE, height: SIZE, cursor: 'pointer' }}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (d && d.id === e.pointerId) {
            const dx = e.clientX - d.x
            const dy = e.clientY - d.y
            if (!d.moved && Math.hypot(dx, dy) < 3) return
            if (!d.moved) {
              d.moved = true
              setHover(null)
              e.currentTarget.style.cursor = 'grabbing'
            }
            d.x = e.clientX
            d.y = e.clientY
            camera()?.orbitBy(-dx * DRAG_RAD_PER_PX, -dy * DRAG_RAD_PER_PX)
            return
          }
          const [x, y] = local(e)
          const facet = hit(x, y)
          setHover(facet?.key ?? null)
          e.currentTarget.style.cursor = facet ? 'pointer' : 'grab'
        }}
        onPointerUp={(e) => {
          const d = drag.current
          drag.current = null
          e.currentTarget.style.cursor = 'pointer'
          if (!d || d.moved) return
          const [x, y] = local(e)
          const facet = hit(x, y)
          if (facet) lookFrom(facet.dir)
        }}
        onPointerCancel={() => {
          drag.current = null
        }}
        onPointerLeave={() => {
          if (!drag.current) setHover(null)
        }}
      />

      {aligned !== 'none' && (
        <>
          <button type="button" className={`${arrowCls} top-0 left-1/2 -translate-x-1/2`} aria-label={t('viewCube.orbitUp')} title={t('viewCube.orbitUp')} onClick={() => step('up')}>
            <ChevronUp size={14} strokeWidth={2.5} />
          </button>
          <button type="button" className={`${arrowCls} bottom-0 left-1/2 -translate-x-1/2`} aria-label={t('viewCube.orbitDown')} title={t('viewCube.orbitDown')} onClick={() => step('down')}>
            <ChevronDown size={14} strokeWidth={2.5} />
          </button>
          <button type="button" className={`${arrowCls} top-1/2 left-0 -translate-y-1/2`} aria-label={t('viewCube.orbitLeft')} title={t('viewCube.orbitLeft')} onClick={() => step('left')}>
            <ChevronLeft size={14} strokeWidth={2.5} />
          </button>
          <button type="button" className={`${arrowCls} top-1/2 right-0 -translate-y-1/2`} aria-label={t('viewCube.orbitRight')} title={t('viewCube.orbitRight')} onClick={() => step('right')}>
            <ChevronRight size={14} strokeWidth={2.5} />
          </button>
        </>
      )}
      {aligned === 'pole' && (
        <>
          <button type="button" className={`${arrowCls} top-0 left-0`} aria-label={t('viewCube.rollCcw')} title={t('viewCube.rollCcw')} onClick={() => step('ccw')}>
            <RotateCcw size={14} strokeWidth={2.25} />
          </button>
          <button type="button" className={`${arrowCls} top-0 right-0`} aria-label={t('viewCube.rollCw')} title={t('viewCube.rollCw')} onClick={() => step('cw')}>
            <RotateCw size={14} strokeWidth={2.25} />
          </button>
        </>
      )}
      {onHome && (
        <button type="button" className={`${cornerCls} bottom-0 left-0`} aria-label={t('viewCube.home')} title={t('viewCube.home')} onClick={onHome}>
          <House size={14} strokeWidth={2.25} />
        </button>
      )}
      <button
        type="button"
        className={`${cornerCls} right-0 bottom-0 ${menu ? 'opacity-100' : ''}`}
        aria-label={t('viewCube.views')}
        title={t('viewCube.views')}
        aria-haspopup="true"
        aria-expanded={menu}
        onClick={() => setMenu((v) => !v)}
      >
        <Ellipsis size={14} strokeWidth={2.25} />
      </button>

      {menu && (
        <div className="absolute top-full right-0 z-30 mt-1 w-64 rounded-xl border border-line bg-surface p-2 text-xs shadow-xl shadow-black/10" role="dialog" aria-label={t('viewCube.views')}>
          {(
            [
              ['viewCube.faces', 1],
              ['viewCube.edges', 2],
              ['viewCube.corners', 3],
            ] as const
          ).map(([label, n]) => (
            <div key={label} className="mb-1.5 last:mb-0">
              <p className="px-1 pb-1 text-[10px] font-semibold tracking-wide text-muted uppercase">{t(label)}</p>
              <div className={`grid gap-0.5 ${n === 3 ? 'grid-cols-1' : 'grid-cols-2'}`}>
                {DIRS.filter((d) => d.filter(Boolean).length === n).map((d) => (
                  <button
                    key={dirKey(d)}
                    type="button"
                    className="truncate rounded-md px-1.5 py-1 text-left text-fg/80 hover:bg-accent-500/10 hover:text-accent-700 focus-visible:outline-2 focus-visible:outline-accent-500 dark:hover:text-accent-300"
                    aria-label={t('viewCube.viewFrom', { name: name(d).toLocaleLowerCase(language) })}
                    onClick={() => {
                      setMenu(false)
                      lookFrom(d)
                    }}
                  >
                    {name(d)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
})

export default ViewCube
