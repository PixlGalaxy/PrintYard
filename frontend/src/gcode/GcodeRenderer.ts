// Imperative three.js renderer for parsed G-code. Every extrusion segment is one instance of a small
// diamond-section prism (positioned in the vertex shader from start/end/width/height), so a 50 MB file
// (~1.5 M segments) is a single draw call. Layer range, move cursor and feature visibility are uniforms
// (no buffer rebuilds); colours are re-uploaded only when the colour mode changes. Renders on demand.
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  GLSL3,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Line,
  LineBasicMaterial,
  LineSegments,
  type Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  Scene,
  Shape,
  ShapeGeometry,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CameraRig, type CubeCamera } from '../three/cameraRig'
import { bindUserNavigation, type NavHandle } from '../three/navigation'
import { FEATURE_COUNT, type ParsedGcode } from './types'

export interface BedSpec {
  x: number
  y: number
  z: number
}

export type CameraPreset = 'iso' | 'top' | 'front' | 'left' | 'right'

const VERT = /* glsl */ `
in vec3 iStart;
in vec3 iEnd;
in vec2 iSize;
in vec3 iColor;
in float iType;
in float iObj;
// Exclude object: per object index, the first move NOT printed (1e12 = not excluded); moves from there on are hidden
uniform float uExclAt[64];
uniform float uSelObj;
uniform float uMin;
uniform float uMax;
uniform int uMask;
// Live print: moves < uPrinted are printed (fractional part = progress of the current move),
// moves from uLayerStart are in the current layer, from uTrailStart are the active extrusion trail
uniform float uPrinted;
uniform float uLayerStart;
uniform float uTrailStart;
// 0 = opaque pass (everything but the ghost), 1 = transparent ghost pass
uniform float uPass;
out vec3 vColor;
out vec3 vNormal;
out float vState;
out float vExcl;
out float vSel;
void main() {
  float idx = float(gl_InstanceID);
  int t = int(iType + 0.5);
  if (idx < uMin || idx >= uMax || ((uMask >> t) & 1) == 0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  int ob = int(iObj + 0.5);
  vExcl = 0.0;
  vSel = ob < 255 && abs(float(ob) - uSelObj) < 0.5 ? 1.0 : 0.0;
  if (ob < 64) {
    float at = uExclAt[ob];
    if (at < 1e11) {
      if (idx >= at) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
      }
      vExcl = 1.0;
    }
  }
  vec3 d = iEnd - iStart;
  float len = length(d);
  float cur = floor(uPrinted);
  float state = idx > cur || (idx == cur && fract(uPrinted) < 1e-4) ? 3.0 : idx >= uTrailStart ? 2.0 : idx >= uLayerStart ? 1.0 : 0.0;
  // The move being extruded right now is drawn up to the nozzle
  if (idx == cur && state < 2.5) len *= fract(uPrinted);
  vec3 dir = len > 1e-6 ? d / len : vec3(1.0, 0.0, 0.0);
  vec3 side = normalize(vec3(-dir.y, dir.x, 0.0) + vec3(1e-6, 0.0, 0.0));
  vec3 up = vec3(0.0, 0.0, 1.0);
  float w = iSize.x;
  float h = iSize.y;
  if ((uPass < 0.5 && state > 2.5) || (uPass > 0.5 && state < 2.5)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float ext = idx == cur && state < 2.5 ? 0.0 : w * 0.45;
  float along = -ext + position.x * (len + 2.0 * ext);
  vec3 p = iStart + dir * along + side * (position.y * w) + up * (position.z * h);
  vec3 n = normalize(dir * normal.x + side * (normal.y * h) + up * (normal.z * w));
  vNormal = normalize(normalMatrix * n);
  vColor = iColor;
  vState = state;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`

const FRAG = /* glsl */ `
in vec3 vColor;
in vec3 vNormal;
in float vState;
in float vExcl;
in float vSel;
uniform vec3 uExclColor;
uniform vec3 uSelColor;
uniform vec3 uGhost;
uniform vec3 uTrail;
uniform vec3 uLayerTint;
uniform float uLayerMix;
uniform float uHighlight;
layout(location = 0) out highp vec4 fragColor;
void main() {
  vec3 n = normalize(vNormal);
  vec3 l1 = normalize(vec3(0.35, 0.55, 1.0));
  vec3 l2 = normalize(vec3(-0.6, -0.2, 0.4));
  float diff = max(dot(n, l1), 0.0) * 0.62 + max(dot(n, l2), 0.0) * 0.18;
  float spec = pow(max(dot(reflect(-l1, n), vec3(0.0, 0.0, 1.0)), 0.0), 24.0) * 0.18;
  vec3 base = vColor;
  if (vState > 2.5) base = mix(vColor, uGhost, 0.9);
  else if (uHighlight > 0.5 && vState > 1.5) base = uTrail;
  else if (uHighlight > 0.5 && vState > 0.5) base = mix(vColor, uLayerTint, uLayerMix);
  if (vSel > 0.5 && vExcl < 0.5) base = mix(base, uSelColor, 0.45);
  // Excluded object: grey with diagonal hatching (screen-space stripes)
  if (vExcl > 0.5) base = uExclColor * (mod(gl_FragCoord.x + gl_FragCoord.y, 9.0) < 4.5 ? 1.0 : 0.7);
  vec3 c = base * (0.38 + diff) + vec3(spec) * (vState > 2.5 ? 0.3 : 1.0);
  if (vState > 2.5) c = uGhost * (0.85 + diff * 0.25);
  fragColor = vec4(c, vState > 2.5 ? 0.06 : 1.0);
}`

/** Unit diamond prism: x ∈ [0,1] along the move, y ∈ [-0.5,0.5] across, z ∈ [-1,0] down from the top. */
function prism(): BufferGeometry {
  // Cross-section corners (y, z): top, right, bottom, left
  const ring: [number, number][] = [
    [0, 0],
    [0.5, -0.5],
    [0, -1],
    [-0.5, -0.5],
  ]
  // Face normal signs (y, z) for the 4 sloped faces, scaled in the shader by h/w
  const faceN: [number, number][] = [
    [1, 1],
    [1, -1],
    [-1, -1],
    [-1, 1],
  ]
  const pos: number[] = []
  const nor: number[] = []
  const idx: number[] = []
  for (let f = 0; f < 4; f++) {
    const a = ring[f]
    const b = ring[(f + 1) % 4]
    const base = pos.length / 3
    for (const [x, c] of [
      [0, a],
      [1, a],
      [1, b],
      [0, b],
    ] as [number, [number, number]][]) {
      pos.push(x, c[0], c[1])
      nor.push(0, faceN[f][0], faceN[f][1])
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  for (const [x, nx] of [
    [0, -1],
    [1, 1],
  ]) {
    const base = pos.length / 3
    for (const c of ring) {
      pos.push(x, c[0], c[1])
      nor.push(nx, 0, 0)
    }
    if (nx < 0) idx.push(base, base + 2, base + 1, base, base + 3, base + 2)
    else idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new Float32BufferAttribute(nor, 3))
  g.setIndex(idx)
  return g
}

export class GcodeRenderer implements CubeCamera {
  private renderer: WebGLRenderer
  private scene = new Scene()
  private camera = new PerspectiveCamera(40, 1, 0.5, 5000)
  private controls: OrbitControls
  private nav: NavHandle
  private rig: CameraRig
  /** Camera rotation changed (view cube); called after each render */
  onCamera: ((view: Matrix4) => void) | null = null
  private bedGroup = new Group()
  private objectGroup = new Group()
  private objectFills: (Mesh | null)[] = []
  private mesh: Mesh | null = null
  private ghostMesh: Mesh | null = null
  private ghostMaterial: ShaderMaterial
  private geom: InstancedBufferGeometry | null = null
  private material: ShaderMaterial
  private travel: LineSegments | null = null
  private marker: Mesh
  private accent = { 100: '#e0f2fe', 400: '#38bdf8', 500: '#0ea5e9', 600: '#0284c7', 900: '#0c4a6e' }
  private colorAttr: InstancedBufferAttribute | null = null
  private data: ParsedGcode | null = null
  private bed: BedSpec = { x: 220, y: 215, z: 245 }
  private frame = 0
  private ro: ResizeObserver
  private dark = false
  private showTravel = false
  private range = { lo: 0, hi: 0, move: 0 }

  private readonly host: HTMLElement

  constructor(host: HTMLElement) {
    this.host = host
    this.renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.domElement.style.display = 'block'
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    this.renderer.domElement.style.touchAction = 'none'
    host.appendChild(this.renderer.domElement)

    this.camera.up.set(0, 0, 1)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.12
    this.controls.screenSpacePanning = true
    this.controls.addEventListener('change', () => this.invalidate())
    // User's 3D navigation scheme (Account → 3D navigation), shared by Preview and Live view
    this.nav = bindUserNavigation(this.controls)
    this.rig = new CameraRig(this.camera, this.controls, () => this.invalidate())

    this.material = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: DoubleSide,
      uniforms: {
        uMin: { value: 0 },
        uMax: { value: 0 },
        uMask: { value: (1 << FEATURE_COUNT) - 1 },
        uPrinted: { value: 1e12 },
        uLayerStart: { value: 1e12 },
        uTrailStart: { value: 1e12 },
        uGhost: { value: new Color(0xc4ccd6) },
        uTrail: { value: new Color(0x0c4a6e) },
        uLayerTint: { value: new Color(0x000000) },
        uLayerMix: { value: 0.42 },
        uHighlight: { value: 1 },
        uPass: { value: 0 },
        uExclAt: { value: new Array<number>(64).fill(1e12) },
        uSelObj: { value: -1 },
        uExclColor: { value: new Color(0x8a94a3) },
        uSelColor: { value: new Color(0x0ea5e9) },
      },
    })
    // Same uniform objects (so every update applies to both), except the pass selector
    this.ghostMaterial = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: DoubleSide,
      transparent: true,
      depthWrite: false,
      uniforms: { ...this.material.uniforms, uPass: { value: 1 } },
    })

    this.marker = new Mesh(new SphereGeometry(0.6, 16, 12), new MeshBasicMaterial({ color: 0xffffff }))
    this.marker.visible = false
    this.marker.renderOrder = 10
    ;(this.marker.material as MeshBasicMaterial).depthTest = false

    this.scene.add(this.bedGroup, this.objectGroup, this.marker)
    this.buildBed()
    this.setPreset(this.nav.nav.defaultView)

    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(host)
    this.resize()
  }

  /** Skin accent (hex shades): build-volume box, live trail and nozzle marker. */
  setAccent(a: { 100: string; 400: string; 500: string; 600: string; 900: string }) {
    this.accent = a
    this.setTheme(this.dark)
  }

  setTheme(dark: boolean) {
    this.dark = dark
    // Live-print colours that stay readable on each background: darker shades on light, lighter on dark
    const u = this.material.uniforms
    ;(u.uGhost.value as Color).set(dark ? 0x8794a8 : 0xa3b1c2)
    ;(u.uTrail.value as Color).set(dark ? this.accent[100] : this.accent[900])
    ;(u.uLayerTint.value as Color).set(dark ? 0xffffff : 0x000000)
    ;(u.uExclColor.value as Color).set(dark ? 0x4b5563 : 0x9aa3af)
    ;(u.uSelColor.value as Color).set(this.accent[500])
    u.uLayerMix.value = dark ? 0.38 : 0.42
    this.scene.background = new Color(dark ? 0x0d1016 : 0xeef1f5)
    this.buildBed()
    this.invalidate()
  }

  setBed(bed: BedSpec) {
    this.bed = bed
    this.buildBed()
    this.invalidate()
  }

  private buildBed() {
    for (const c of [...this.bedGroup.children]) {
      this.bedGroup.remove(c)
      const m = c as Mesh
      m.geometry?.dispose()
      ;(m.material as MeshBasicMaterial | undefined)?.dispose?.()
    }
    const { x, y, z } = this.bed
    const plate = new Mesh(new PlaneGeometry(x, y), new MeshBasicMaterial({ color: this.dark ? 0x1a1f29 : 0xdfe4ea }))
    plate.position.set(x / 2, y / 2, -0.05)
    const lines: number[] = []
    for (let gx = 0; gx <= x + 1e-6; gx += 10) lines.push(gx, 0, 0, gx, y, 0)
    for (let gy = 0; gy <= y + 1e-6; gy += 10) lines.push(0, gy, 0, x, gy, 0)
    const grid = new LineSegments(
      new BufferGeometry().setAttribute('position', new Float32BufferAttribute(lines, 3)),
      new LineBasicMaterial({ color: this.dark ? 0x2a3140 : 0xc6ced8 }),
    )
    const box: number[] = []
    const P = [
      [0, 0],
      [x, 0],
      [x, y],
      [0, y],
    ]
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = P[i]
      const [bx, by] = P[(i + 1) % 4]
      box.push(ax, ay, z, bx, by, z, ax, ay, 0, ax, ay, z)
    }
    const volume = new LineSegments(
      new BufferGeometry().setAttribute('position', new Float32BufferAttribute(box, 3)),
      new LineBasicMaterial({ color: this.accent[500], transparent: true, opacity: this.dark ? 0.25 : 0.35 }),
    )
    this.bedGroup.add(plate, grid, volume)
  }

  setData(g: ParsedGcode | null) {
    this.data = g
    this.marker.visible = false
    if (this.mesh) {
      this.scene.remove(this.mesh)
      if (this.ghostMesh) this.scene.remove(this.ghostMesh)
      this.geom?.dispose()
    }
    if (this.travel) {
      this.scene.remove(this.travel)
      this.travel.geometry.dispose()
      ;(this.travel.material as LineBasicMaterial).dispose()
    }
    this.mesh = null
    this.ghostMesh = null
    this.geom = null
    this.travel = null
    this.colorAttr = null
    if (!g || g.count === 0) {
      this.invalidate()
      return
    }
    const base = prism()
    const geom = new InstancedBufferGeometry()
    geom.index = base.index
    geom.setAttribute('position', base.getAttribute('position'))
    geom.setAttribute('normal', base.getAttribute('normal'))
    const inter = new InstancedInterleavedBuffer(g.seg, 8, 1)
    geom.setAttribute('iStart', new InterleavedBufferAttribute(inter, 3, 0))
    geom.setAttribute('iEnd', new InterleavedBufferAttribute(inter, 3, 3))
    geom.setAttribute('iSize', new InterleavedBufferAttribute(inter, 2, 6))
    this.colorAttr = new InstancedBufferAttribute(new Uint8Array(g.count * 3).fill(200), 3, true)
    geom.setAttribute('iColor', this.colorAttr)
    geom.setAttribute('iType', new InstancedBufferAttribute(g.type, 1, false))
    geom.setAttribute('iObj', new InstancedBufferAttribute(g.obj ?? new Uint8Array(g.count).fill(255), 1, false))
    geom.instanceCount = g.count
    // Bounding sphere for frustum culling: the whole bed volume
    geom.boundingSphere = null
    this.geom = geom
    const ghost = new Mesh(geom, this.ghostMaterial)
    ghost.frustumCulled = false
    ghost.visible = false
    ghost.renderOrder = 2
    this.ghostMesh = ghost
    this.scene.add(ghost)
    const mesh = new Mesh(geom, this.material)
    mesh.frustumCulled = false
    this.mesh = mesh
    this.scene.add(mesh)

    const tg = new BufferGeometry()
    tg.setAttribute('position', new BufferAttribute(g.travel, 3))
    this.travel = new LineSegments(tg, new LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.55 }))
    this.travel.frustumCulled = false
    this.travel.visible = this.showTravel
    this.scene.add(this.travel)
    this.applyRange()
  }

  setColors(colors: Uint8Array) {
    if (!this.colorAttr || colors.length !== this.colorAttr.array.length) return
    ;(this.colorAttr.array as Uint8Array).set(colors)
    this.colorAttr.needsUpdate = true
    this.invalidate()
  }

  /** Bit i = feature i visible */
  setFeatureMask(mask: number) {
    this.material.uniforms.uMask.value = mask
    this.invalidate()
  }

  setShowTravel(show: boolean) {
    this.showTravel = show
    if (this.travel) this.travel.visible = show
    this.invalidate()
  }

  /** Layers lo..hi (inclusive, 0-based); `move` = number of moves shown in layer hi (Infinity = all). */
  setRange(lo: number, hi: number, move: number) {
    this.range = { lo, hi, move }
    this.applyRange()
  }

  private applyRange() {
    const g = this.data
    if (!g || !g.layers) return
    const lo = Math.max(0, Math.min(this.range.lo, g.layers - 1))
    const hi = Math.max(lo, Math.min(this.range.hi, g.layers - 1))
    const start = g.layerStart[lo]
    const topStart = g.layerStart[hi]
    const topEnd = g.layerStart[hi + 1]
    const end = Math.min(topEnd, topStart + Math.max(0, Math.floor(Math.min(this.range.move, topEnd - topStart))))
    this.material.uniforms.uMin.value = start
    this.material.uniforms.uMax.value = end
    if (this.geom) this.geom.instanceCount = Math.max(0, end)
    if (this.travel) {
      const ts = g.layerTravelStart[lo]
      const te = g.layerTravelStart[hi + 1]
      this.travel.geometry.setDrawRange(ts * 2, Math.max(0, (te - ts) * 2))
    }
    // Tool marker at the end of the last shown move while scrubbing
    const scrubbing = end < topEnd && end > topStart
    this.marker.visible = scrubbing
    if (scrubbing) {
      const o = (end - 1) * 8
      this.marker.position.set(g.seg[o + 3], g.seg[o + 4], g.seg[o + 5] + 0.4)
    }
    this.invalidate()
  }

  /**
   * Live print view. `printed` = number of moves done (fractional part = progress of the current one),
   * `layerStart`/`trailStart` = first move of the current layer / of the highlighted trail,
   * `end` = moves drawn (the rest of the file is hidden), `highlight` toggles the layer/trail colours.
   * Only uniforms change: no buffer uploads per tick.
   */
  setLive(o: { printed: number; layerStart: number; trailStart: number; end: number; highlight: boolean; marker?: [number, number, number] | null; hideMarker?: boolean }) {
    const g = this.data
    if (!g) return
    const u = this.material.uniforms
    u.uPrinted.value = o.printed
    u.uLayerStart.value = o.layerStart
    u.uTrailStart.value = o.trailStart
    u.uHighlight.value = o.highlight ? 1 : 0
    u.uMin.value = 0
    u.uMax.value = Math.min(g.count, o.end)
    if (this.geom) this.geom.instanceCount = Math.min(g.count, o.end)
    if (this.travel) this.travel.visible = false
    if (this.ghostMesh) this.ghostMesh.visible = true
    let pos = o.marker ?? null
    if (!pos && g.count) {
      const i = Math.min(g.count - 1, Math.floor(o.printed))
      const f = o.printed - Math.floor(o.printed)
      const k = i * 8
      pos = [g.seg[k] + (g.seg[k + 3] - g.seg[k]) * f, g.seg[k + 1] + (g.seg[k + 4] - g.seg[k + 1]) * f, g.seg[k + 5]]
    }
    this.marker.visible = !!pos && !o.hideMarker
    if (pos) this.marker.position.set(pos[0], pos[1], pos[2] + 0.5)
    ;(this.marker.material as MeshBasicMaterial).color.set(this.dark ? this.accent[400] : this.accent[600])
    this.invalidate()
  }

  /**
   * Exclude object. `excludedFrom[i]` = first move index of object i that is NOT printed (Infinity = not excluded):
   * earlier moves render grey/hatched, later ones are hidden. `selected` = highlighted object index (-1 = none).
   */
  setObjectState(excludedFrom: number[], selected: number) {
    const arr = this.material.uniforms.uExclAt.value as number[]
    for (let i = 0; i < 64; i++) arr[i] = Number.isFinite(excludedFrom[i]) ? excludedFrom[i] : 1e12
    this.material.uniforms.uSelObj.value = selected
    this.invalidate()
  }

  /** Clickable object footprints (polygon outline + translucent fill) drawn at height `z`. */
  setObjectOutlines(objs: { polygon: [number, number][]; excluded: boolean; selected: boolean; current: boolean }[], z: number) {
    for (const c of [...this.objectGroup.children]) {
      this.objectGroup.remove(c)
      const m = c as Mesh
      m.geometry?.dispose()
      ;(m.material as MeshBasicMaterial | undefined)?.dispose?.()
    }
    this.objectFills = []
    objs.forEach((o, i) => {
      if (o.polygon.length < 3) {
        this.objectFills.push(null)
        return
      }
      const color = o.excluded ? (this.dark ? 0x6b7280 : 0x9ca3af) : o.selected ? this.accent[500] : o.current ? (this.dark ? 0xfbbf24 : 0xd97706) : this.dark ? 0xcbd5e1 : 0x475569
      const pts: number[] = []
      for (const [px, py] of [...o.polygon, o.polygon[0]]) pts.push(px, py, z + 0.05)
      const line = new Line(new BufferGeometry().setAttribute('position', new Float32BufferAttribute(pts, 3)), new LineBasicMaterial({ color, transparent: true, opacity: o.selected ? 1 : 0.85 }))
      line.renderOrder = 6
      ;(line.material as LineBasicMaterial).depthTest = false
      const shape = new Shape(o.polygon.map(([px, py]) => new Vector2(px, py)))
      const fill = new Mesh(
        new ShapeGeometry(shape),
        new MeshBasicMaterial({ color, transparent: true, opacity: o.selected ? 0.22 : o.excluded ? 0.12 : 0.05, depthWrite: false, side: DoubleSide }),
      )
      fill.position.z = z + 0.04
      fill.renderOrder = 5
      fill.userData.index = i
      this.objectFills.push(fill)
      this.objectGroup.add(fill, line)
    })
    this.invalidate()
  }

  /** Index of the object footprint under the pointer (client coordinates), or -1. */
  pickObject(clientX: number, clientY: number): number {
    const rect = this.renderer.domElement.getBoundingClientRect()
    if (!rect.width || !rect.height) return -1
    const ndc = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    const ray = new Raycaster()
    ray.setFromCamera(ndc, this.camera)
    const hits = ray.intersectObjects(this.objectFills.filter((m): m is Mesh => m !== null), false)
    return hits.length ? (hits[0].object.userData.index as number) : -1
  }

  /** Keeps the camera's height locked on `z` (follow the current layer). */
  followZ(z: number) {
    const dz = z - this.controls.target.z
    if (Math.abs(dz) < 1e-3) return
    this.controls.target.z += dz
    this.camera.position.z += dz
    this.controls.update()
    this.invalidate()
  }

  /** View cube: animate (300 ms) to look from `dir`, keeping target and zoom. */
  lookFrom(dir: Vector3, up?: Vector3) {
    this.rig.lookFrom(dir, up)
  }

  /** View cube drag: orbit by azimuth/polar deltas. */
  orbitBy(dTheta: number, dPhi: number) {
    this.rig.orbitBy(dTheta, dPhi)
  }

  viewRotation() {
    return this.rig.viewRotation()
  }

  setPreset(p: CameraPreset) {
    this.rig.cancel()
    const g = this.data
    const { x, y } = this.bed
    const c = g && g.count ? new Vector3((g.bbox[0] + g.bbox[3]) / 2, (g.bbox[1] + g.bbox[4]) / 2, (g.bbox[2] + g.bbox[5]) / 2) : new Vector3(x / 2, y / 2, 0)
    const size = g && g.count ? Math.max(g.bbox[3] - g.bbox[0], g.bbox[4] - g.bbox[1], g.bbox[5] - g.bbox[2], 30) : Math.max(x, y)
    const dist = size * 1.9 + 40
    const dirs: Record<CameraPreset, [number, number, number]> = {
      iso: [0.55, -0.85, 0.75],
      top: [0, -0.0001, 1],
      front: [0, -1, 0.12],
      left: [-1, 0, 0.12],
      right: [1, 0, 0.12],
    }
    const d = new Vector3(...dirs[p]).normalize().multiplyScalar(dist)
    this.camera.position.copy(c).add(d)
    this.controls.target.copy(c)
    this.camera.near = Math.max(0.1, dist / 500)
    this.camera.far = dist * 20 + 2000
    this.camera.updateProjectionMatrix()
    this.controls.update()
    this.invalidate()
  }

  private resize() {
    const w = this.host.clientWidth
    const h = this.host.clientHeight
    if (!w || !h) return
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.invalidate()
  }

  invalidate() {
    if (this.frame) return
    this.frame = requestAnimationFrame((time) => {
      this.frame = 0
      const animating = this.rig.step(time)
      // Damping keeps moving for a few frames after input
      if (this.controls.update() || animating) this.invalidate()
      this.renderer.render(this.scene, this.camera)
      this.onCamera?.(this.rig.viewRotation())
    })
  }

  dispose() {
    cancelAnimationFrame(this.frame)
    this.ro.disconnect()
    this.nav.dispose()
    this.rig.dispose()
    this.controls.dispose()
    this.setData(null)
    this.material.dispose()
    this.ghostMaterial.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
