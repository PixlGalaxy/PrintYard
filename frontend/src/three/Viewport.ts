// Imperative three.js editor viewport (plain three, no react-three-fiber: the scene is driven by the store
// through `sync()`, renders only on demand and never re-creates geometry on transform).
import {
  AmbientLight,
  Box3,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Plane,
  Quaternion,
  Ray,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import type { SceneDoc } from '../types'
import { hullBox, isOutside, toMatrix } from '../workspace/geometry'
import type { MeshInfo } from '../workspace/meshes'
import { plateOrigin, type BedSize } from '../workspace/plates'
import type { Tool } from '../workspace/store'
import { BED_THEMES, buildPlate, disposeGroup } from './bed'
import { CameraRig, type CubeCamera } from './cameraRig'
import { bindUserNavigation, type NavHandle } from './navigation'
import { UNKNOWN_FILAMENT_COLOR } from '../workspace/filamentColor'

/**
 * Closest hit distance (world units) of a ray against a non-indexed mesh, double-sided. A tight Möller–Trumbore
 * loop over the raw position array: ~10× faster than Mesh.raycast on 1M-triangle meshes.
 */
function rayMeshDistance(ray: Ray, mesh: Mesh): number | null {
  mesh.updateWorldMatrix(true, false)
  const inv = mesh.matrixWorld.clone().invert()
  const local = ray.clone().applyMatrix4(inv)
  const ox = local.origin.x, oy = local.origin.y, oz = local.origin.z
  const dx = local.direction.x, dy = local.direction.y, dz = local.direction.z
  const p = mesh.geometry.getAttribute('position').array as Float32Array
  let best = Infinity
  for (let i = 0; i < p.length; i += 9) {
    const ax = p[i], ay = p[i + 1], az = p[i + 2]
    const e1x = p[i + 3] - ax, e1y = p[i + 4] - ay, e1z = p[i + 5] - az
    const e2x = p[i + 6] - ax, e2y = p[i + 7] - ay, e2z = p[i + 8] - az
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x
    const det = e1x * px + e1y * py + e1z * pz
    if (det > -1e-12 && det < 1e-12) continue
    const f = 1 / det
    const tx = ox - ax, ty = oy - ay, tz = oz - az
    const u = (tx * px + ty * py + tz * pz) * f
    if (u < 0 || u > 1) continue
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x
    const v = (dx * qx + dy * qy + dz * qz) * f
    if (v < 0 || u + v > 1) continue
    const t = (e2x * qx + e2y * qy + e2z * qz) * f
    if (t > 0 && t < best) best = t
  }
  if (best === Infinity) return null
  return local.at(best, new Vector3()).applyMatrix4(mesh.matrixWorld).distanceTo(ray.origin)
}

export type ViewName = 'iso' | 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right'

export interface ViewportCallbacks {
  onPick: (id: string | null, mods: { shift: boolean; ctrl: boolean }) => void
  /** End of a gizmo drag: new file→world matrices of the moved objects */
  onTransformEnd: (matrices: Map<string, Matrix4>) => void
  /** Lay on face: world normal of the clicked facet */
  onLayFace: (id: string, worldNormal: Vector3) => void
  onPlatePick: (plate: number) => void
  /** Camera rotation changed (for the view cube) */
  onCamera?: (view: Matrix4) => void
}

export interface SyncInput {
  doc: SceneDoc
  selection: string[]
  hidden: string[]
  activePlate: number
  tool: Tool
  bed: BedSize
  dark: boolean
  /** accent colour of the current skin (#rrggbb) */
  accent: string
  mesh: (fileId: number) => MeshInfo | null
}

interface Node {
  id: string
  group: Group
  mesh: Mesh | null
  material: MeshStandardMaterial
  info: MeshInfo | null
  key: string
  box: Box3
  outside: boolean
  color: string
  facets: Group | null
}

const RED = new Color('#ef4444')
const DIRS: Record<ViewName, Vector3> = {
  iso: new Vector3(-0.62, -1.35, 1.05),
  top: new Vector3(0, -0.0001, 1),
  bottom: new Vector3(0, 0.0001, -1),
  front: new Vector3(0, -1, 0.0001),
  back: new Vector3(0, 1, 0.0001),
  left: new Vector3(-1, 0, 0.0001),
  right: new Vector3(1, 0, 0.0001),
}

export class Viewport implements CubeCamera {
  readonly renderer: WebGLRenderer
  readonly scene = new Scene()
  readonly camera = new PerspectiveCamera(35, 1, 1, 20000)
  private controls: OrbitControls
  private nav: NavHandle
  private rig: CameraRig
  private gizmo: TransformControls
  private proxy = new Object3D()
  private plates = new Group()
  private objects = new Group()
  private helpers = new Group()
  private nodes = new Map<string, Node>()
  private selBoxes: LineSegments
  private raf = 0
  private tween: { from: Vector3; to: Vector3; tFrom: Vector3; tTo: Vector3; start: number; ms: number } | null = null
  private input: SyncInput | null = null
  private plateKey = ''
  private dragStart: Map<string, Matrix4> | null = null
  private proxyStart = new Matrix4()
  private pointerDown: { x: number; y: number; onGizmo: boolean; button: number } | null = null
  /** Ctrl/⌘ + left press on an object (Repetier-Host style): becomes a drag on the bed plane once it moves. */
  private ctrlPress: { id: string; x: number; y: number; pointerId: number; plane: Plane; from: Vector3; dragging: boolean; shift: boolean } | null = null
  private hoverFacet: Mesh | null = null
  private ro: ResizeObserver
  private disposed = false
  private viewMatrix = new Matrix4()
  private accent = new Color('#0ea5e9')
  private gizmoAccent = ''

  private container: HTMLElement
  private cb: ViewportCallbacks

  constructor(container: HTMLElement, cb: ViewportCallbacks) {
    this.container = container
    this.cb = cb
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.outputColorSpace = SRGBColorSpace
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.domElement.style.display = 'block'
    this.renderer.domElement.style.outline = 'none'
    container.appendChild(this.renderer.domElement)

    this.camera.up.set(0, 0, 1)
    this.camera.position.set(-140, -300, 260)

    this.scene.add(new HemisphereLight(0xffffff, 0x8a94a6, 1.4))
    this.scene.add(new AmbientLight(0xffffff, 0.35))
    const head = new DirectionalLight(0xffffff, 1.9)
    head.position.set(0.3, 0.2, 1)
    this.camera.add(head)
    const fill = new DirectionalLight(0xffffff, 0.55)
    fill.position.set(0.4, 1, -0.6)
    this.scene.add(fill)
    this.scene.add(this.camera, this.plates, this.objects, this.helpers)

    this.selBoxes = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: '#0ea5e9', transparent: true, opacity: 0.95, depthTest: false }))
    this.selBoxes.renderOrder = 10
    this.helpers.add(this.selBoxes)

    const controls = new OrbitControls(this.camera, this.renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.14
    controls.screenSpacePanning = true
    controls.zoomToCursor = true
    controls.minDistance = 15
    controls.maxDistance = 4000
    controls.addEventListener('change', () => this.invalidate())
    this.controls = controls
    // Mouse scheme from the user's 3D navigation prefs (Account → 3D navigation), follows live changes
    this.nav = bindUserNavigation(controls)
    this.rig = new CameraRig(this.camera, controls, this.invalidate)

    const gizmo = new TransformControls(this.camera, this.renderer.domElement)
    gizmo.setSize(0.85)
    gizmo.addEventListener('change', () => this.invalidate())
    gizmo.addEventListener('dragging-changed', (e) => {
      controls.enabled = !(e as unknown as { value: boolean }).value
    })
    gizmo.addEventListener('mouseDown', () => this.beginDrag())
    gizmo.addEventListener('objectChange', () => this.applyDrag())
    gizmo.addEventListener('mouseUp', () => this.endDrag())
    this.gizmo = gizmo
    this.scene.add(this.proxy)
    this.scene.add(gizmo.getHelper())

    const el = this.renderer.domElement
    // Capture phase: runs before the navigation / OrbitControls / gizmo listeners so a Ctrl-drag on an object
    // moves the object instead of the camera.
    el.addEventListener('pointerdown', this.onCtrlDown, { capture: true })
    el.addEventListener('pointermove', this.onCtrlMove, { capture: true })
    el.addEventListener('pointerup', this.onCtrlUp, { capture: true })
    el.addEventListener('pointercancel', this.onCtrlUp, { capture: true })
    el.addEventListener('pointerdown', this.onPointerDown)
    el.addEventListener('pointerup', this.onPointerUp)
    el.addEventListener('pointermove', this.onPointerMove)
    el.addEventListener('contextmenu', (e) => e.preventDefault())

    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(container)
    this.resize()
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    this.gizmo.detach()
    this.gizmo.dispose()
    this.nav.dispose()
    this.rig.dispose()
    this.controls.dispose()
    disposeGroup(this.plates)
    for (const n of this.nodes.values()) n.material.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  // ---------- rendering ----------

  invalidate = () => {
    if (this.raf || this.disposed) return
    this.raf = requestAnimationFrame(this.frame)
  }

  private frame = (time: number) => {
    this.raf = 0
    let more = false
    if (this.tween) {
      const t = Math.min(1, (time - this.tween.start) / this.tween.ms)
      const k = 1 - Math.pow(1 - t, 3)
      this.camera.position.lerpVectors(this.tween.from, this.tween.to, k)
      this.controls.target.lerpVectors(this.tween.tFrom, this.tween.tTo, k)
      if (t >= 1) this.tween = null
      more = true
    }
    if (this.rig.step(time)) more = true
    if (this.controls.update()) more = true
    this.renderer.render(this.scene, this.camera)
    this.viewMatrix.extractRotation(this.camera.matrixWorldInverse)
    this.cb.onCamera?.(this.viewMatrix)
    if (more || this.tween) this.invalidate()
  }

  private resize() {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    if (!w || !h) return
    this.renderer.setSize(w, h, false)
    this.renderer.domElement.style.width = `${w}px`
    this.renderer.domElement.style.height = `${h}px`
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.invalidate()
  }

  // ---------- sync from the store ----------

  sync(input: SyncInput) {
    const prevTool = this.input?.tool
    this.input = input
    const { doc, bed, dark, activePlate } = input
    const theme = { ...BED_THEMES[dark ? 'dark' : 'light'], borderActive: input.accent }
    this.accent.set(input.accent)
    if (this.gizmoAccent !== input.accent) {
      // Gizmo hover/drag highlight follows the skin (axes keep three's default X red / Y green / Z blue)
      this.gizmoAccent = input.accent
      this.gizmo.setColors(0xff0000, 0x00ff00, 0x0000ff, input.accent)
    }
    ;(this.selBoxes.material as LineBasicMaterial).color.copy(this.accent)

    const plateKey = `${doc.plates.length}|${bed.w}x${bed.d}x${bed.h}|${dark}|${activePlate}|${input.accent}`
    if (plateKey !== this.plateKey) {
      const first = !this.plateKey
      this.plateKey = plateKey
      disposeGroup(this.plates)
      this.plates.clear()
      doc.plates.forEach((_, i) => {
        const g = buildPlate(bed, i, i === activePlate, theme)
        const [ox, oy] = plateOrigin(i, doc.plates.length, bed)
        g.position.set(ox, oy, 0)
        this.plates.add(g)
      })
      if (first) this.setView(this.nav.nav.defaultView, false)
    }

    const seen = new Set<string>()
    const selected = new Set(input.selection)
    const hidden = new Set(input.hidden)
    const slotColor = new Map(doc.filaments.map((f) => [f.slot, f.color]))
    for (const o of doc.objects) {
      seen.add(o.id)
      let node = this.nodes.get(o.id)
      if (!node) {
        const material = new MeshStandardMaterial({ roughness: 0.62, metalness: 0.02, side: DoubleSide })
        const group = new Group()
        group.matrixAutoUpdate = false
        group.userData.id = o.id
        node = { id: o.id, group, mesh: null, material, info: null, key: '', box: new Box3(), outside: false, color: '', facets: null }
        this.nodes.set(o.id, node)
        this.objects.add(group)
      }
      const info = input.mesh(o.fileId)
      if (info && node.info !== info) {
        if (node.mesh) node.group.remove(node.mesh)
        node.mesh = new Mesh(info.geometry, node.material)
        node.mesh.position.copy(info.center).negate()
        node.mesh.updateMatrix()
        node.mesh.matrixAutoUpdate = false
        node.mesh.userData.id = o.id
        node.group.add(node.mesh)
        node.info = info
        node.key = ''
        this.dropFacets(node)
      }
      const key = `${o.plate}|${doc.plates.length}|${o.transform.join(',')}`
      if (key !== node.key && node.info && !this.dragStart?.has(o.id)) {
        node.key = key
        const [ox, oy] = plateOrigin(o.plate, doc.plates.length, bed)
        const world = new Matrix4().makeTranslation(ox, oy, 0).multiply(toMatrix(o.transform))
        const c = node.info.center
        node.group.matrix.copy(world).multiply(new Matrix4().makeTranslation(c.x, c.y, c.z))
        node.group.matrixWorldNeedsUpdate = true
        hullBox(node.info.hull, world, node.box)
        const local = node.box.clone().translate(new Vector3(-ox, -oy, 0))
        node.outside = isOutside(local, bed)
      }
      node.color = slotColor.get(o.filamentSlot) ?? UNKNOWN_FILAMENT_COLOR
      node.group.visible = !hidden.has(o.id)
      this.paint(node, selected.has(o.id))
    }
    for (const [id, node] of this.nodes) {
      if (seen.has(id)) continue
      this.objects.remove(node.group)
      node.material.dispose()
      this.dropFacets(node)
      this.nodes.delete(id)
    }

    this.updateSelectionBoxes()
    if (!this.dragStart) this.attachGizmo()
    if (input.tool === 'layFace') this.showFacets()
    else if (prevTool === 'layFace') for (const n of this.nodes.values()) this.dropFacets(n)
    this.invalidate()
  }

  private paint(node: Node, selected: boolean) {
    const base = new Color(node.color)
    if (node.outside) base.lerp(RED, 0.55)
    node.material.color.copy(base)
    if (selected) node.material.emissive.copy(this.accent).multiplyScalar(0.28)
    else if (node.outside) node.material.emissive.copy(RED).multiplyScalar(0.12)
    else node.material.emissive.setRGB(0, 0, 0)
  }

  private updateSelectionBoxes() {
    const pts: number[] = []
    for (const id of this.input?.selection ?? []) {
      const n = this.nodes.get(id)
      if (!n?.info || !n.group.visible) continue
      const { min, max } = n.box
      const size = new Vector3().subVectors(max, min)
      const l = Math.max(2, Math.min(size.x, size.y, size.z) * 0.22)
      for (const x of [min.x, max.x])
        for (const y of [min.y, max.y])
          for (const z of [min.z, max.z]) {
            const sx = x === min.x ? 1 : -1
            const sy = y === min.y ? 1 : -1
            const sz = z === min.z ? 1 : -1
            pts.push(x, y, z, x + sx * l, y, z, x, y, z, x, y + sy * l, z, x, y, z, x, y, z + sz * l)
          }
    }
    this.selBoxes.geometry.dispose()
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(pts, 3))
    this.selBoxes.geometry = g
  }

  // ---------- gizmo ----------

  private selectedNodes() {
    return (this.input?.selection ?? []).map((id) => this.nodes.get(id)).filter((n): n is Node => !!n?.info && n.group.visible)
  }

  private attachGizmo() {
    const tool = this.input?.tool
    const nodes = this.selectedNodes()
    if (!nodes.length || !tool || tool === 'select' || tool === 'layFace') {
      this.gizmo.detach()
      return
    }
    const mode = tool === 'move' ? 'translate' : tool === 'rotate' ? 'rotate' : 'scale'
    this.gizmo.setMode(mode)
    const single = nodes.length === 1
    this.gizmo.setSpace(mode === 'translate' ? 'world' : single ? 'local' : 'world')
    const box = new Box3()
    for (const n of nodes) box.union(n.box)
    const c = box.getCenter(new Vector3())
    this.proxy.position.copy(c)
    if (single && mode !== 'translate') {
      const q = new Quaternion()
      nodes[0].group.matrix.decompose(new Vector3(), q, new Vector3())
      this.proxy.quaternion.copy(q)
    } else this.proxy.quaternion.identity()
    this.proxy.scale.set(1, 1, 1)
    this.proxy.updateMatrixWorld(true)
    if (this.gizmo.object !== this.proxy) this.gizmo.attach(this.proxy)
  }

  setSnap(on: boolean) {
    this.gizmo.setTranslationSnap(on ? 5 : null)
    this.gizmo.setRotationSnap(on ? (15 * Math.PI) / 180 : null)
    this.gizmo.setScaleSnap(on ? 0.05 : null)
  }

  private beginDrag() {
    this.dragStart = new Map(this.selectedNodes().map((n) => [n.id, n.group.matrix.clone()]))
    this.proxy.updateMatrixWorld(true)
    this.proxyStart.copy(this.proxy.matrixWorld)
  }

  private applyDrag() {
    if (!this.dragStart || !this.input) return
    if (this.gizmo.mode === 'scale' && this.dragStart.size > 1) {
      // several objects: uniform scale only (a non-uniform world-axis scale would shear rotated objects)
      const s = this.proxy.scale
      const k = [s.x, s.y, s.z].reduce((a, b) => (Math.abs(b - 1) > Math.abs(a - 1) ? b : a), 1)
      s.set(k, k, k)
    }
    this.proxy.updateMatrixWorld(true)
    const delta = this.proxy.matrixWorld.clone().multiply(this.proxyStart.clone().invert())
    for (const [id, start] of this.dragStart) {
      const n = this.nodes.get(id)
      if (!n?.info) continue
      n.group.matrix.copy(delta).multiply(start)
      n.group.matrixWorldNeedsUpdate = true
      const world = n.group.matrix.clone().multiply(new Matrix4().makeTranslation(-n.info.center.x, -n.info.center.y, -n.info.center.z))
      hullBox(n.info.hull, world, n.box)
    }
    this.updateSelectionBoxes()
    this.invalidate()
  }

  private endDrag() {
    const start = this.dragStart
    this.dragStart = null
    if (!start) return
    const out = new Map<string, Matrix4>()
    let changed = false
    for (const [id, m] of start) {
      const n = this.nodes.get(id)
      if (!n?.info) continue
      if (!n.group.matrix.equals(m)) changed = true
      out.set(id, n.group.matrix.clone().multiply(new Matrix4().makeTranslation(-n.info.center.x, -n.info.center.y, -n.info.center.z)))
    }
    if (changed) this.cb.onTransformEnd(out)
    else this.attachGizmo()
  }

  // ---------- lay on face ----------

  private dropFacets(n: Node) {
    if (!n.facets) return
    n.facets.parent?.remove(n.facets)
    disposeGroup(n.facets)
    n.facets = null
    this.hoverFacet = null
  }

  private showFacets() {
    const sel = new Set(this.input?.selection ?? [])
    for (const n of this.nodes.values()) {
      if (!sel.has(n.id)) {
        this.dropFacets(n)
        continue
      }
      if (n.facets || !n.info || !n.mesh) continue
      const g = new Group()
      for (const f of n.info.facets) {
        const t = f.tris.slice()
        for (let i = 0; i < t.length; i += 3) {
          t[i] += f.normal[0] * 0.08
          t[i + 1] += f.normal[1] * 0.08
          t[i + 2] += f.normal[2] * 0.08
        }
        const geo = new BufferGeometry()
        geo.setAttribute('position', new Float32BufferAttribute(t, 3))
        const m = new Mesh(
          geo,
          new MeshBasicMaterial({ color: this.accent, transparent: true, opacity: 0.22, side: DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
        )
        m.userData.normal = new Vector3(...f.normal)
        m.userData.id = n.id
        m.renderOrder = 5
        g.add(m)
      }
      n.facets = g
      n.mesh.add(g)
    }
  }

  // ---------- picking ----------

  private raycaster = new Raycaster()
  private ndc = new Vector2()

  private setRay(e: PointerEvent) {
    const r = this.renderer.domElement.getBoundingClientRect()
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    this.raycaster.setFromCamera(this.ndc, this.camera)
  }

  private onPointerDown = (e: PointerEvent) => {
    // TransformControls sets `axis` while the pointer hovers one of its handles
    this.pointerDown = { x: e.clientX, y: e.clientY, onGizmo: !!this.gizmo.object && this.gizmo.axis !== null, button: e.button }
  }

  private onPointerUp = (e: PointerEvent) => {
    const down = this.pointerDown
    this.pointerDown = null
    if (!down || down.onGizmo || down.button !== 0) return
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return
    this.setRay(e)
    if (this.input?.tool === 'layFace') {
      const hit = this.pickFacet()
      if (hit) {
        const id = hit.object.userData.id as string
        const n = this.nodes.get(id)!
        const nm = new Matrix4().extractRotation(n.group.matrix)
        const normal = (hit.object.userData.normal as Vector3).clone().applyMatrix4(nm).normalize()
        this.cb.onLayFace(id, normal)
        return
      }
    }
    const id = this.pickObject()
    if (id) {
      this.cb.onPick(id, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey })
      return
    }
    const plateHit = this.raycaster.intersectObjects(this.plates.children, true).find((h) => h.object.name === 'bed-surface')
    if (plateHit) this.cb.onPlatePick(plateHit.object.userData.plate as number)
    this.cb.onPick(null, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey })
  }

  private pickFacet() {
    const groups = [...this.nodes.values()].map((n) => n.facets).filter((g): g is Group => !!g)
    return this.raycaster.intersectObjects(groups, true)[0] ?? null
  }

  // ---------- Ctrl + drag moves objects (any tool) ----------

  private onCtrlDown = (e: PointerEvent) => {
    if (e.button !== 0 || !(e.ctrlKey || e.metaKey) || e.pointerType === 'touch' || this.input?.tool === 'layFace') return
    this.setRay(e)
    const hit = this.pickObjectHit()
    if (!hit) return // empty space: the usual Ctrl-drag navigation
    e.preventDefault()
    e.stopImmediatePropagation()
    const from = this.raycaster.ray.at(hit.dist, new Vector3())
    this.ctrlPress = { id: hit.id, x: e.clientX, y: e.clientY, pointerId: e.pointerId, plane: new Plane(new Vector3(0, 0, 1), -from.z), from, dragging: false, shift: e.shiftKey }
    this.renderer.domElement.setPointerCapture(e.pointerId)
  }

  private onCtrlMove = (e: PointerEvent) => {
    const p = this.ctrlPress
    if (!p || e.pointerId !== p.pointerId) {
      if (!this.pointerDown && !this.gizmo.dragging && (e.ctrlKey || e.metaKey) && e.pointerType !== 'touch' && this.input?.tool !== 'layFace') {
        // Hint: Ctrl over an object = it can be dragged
        this.setRay(e)
        const over = [...this.nodes.values()].some((n) => n.mesh && n.group.visible && this.raycaster.ray.intersectsBox(n.box))
        if (over) {
          this.renderer.domElement.style.cursor = 'move'
          e.stopImmediatePropagation()
        }
      }
      return
    }
    e.stopImmediatePropagation()
    if (!p.dragging) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) <= 4) return
      p.dragging = true
      const sel = this.input?.selection ?? []
      const ids = sel.includes(p.id) ? sel : [p.id]
      if (!sel.includes(p.id)) this.cb.onPick(p.id, { shift: false, ctrl: false })
      this.gizmo.detach()
      this.dragStart = new Map(ids.map((id) => this.nodes.get(id)).filter((n): n is Node => !!n?.info).map((n) => [n.id, n.group.matrix.clone()]))
      this.renderer.domElement.style.cursor = 'move'
    }
    this.setRay(e)
    const to = this.raycaster.ray.intersectPlane(p.plane, new Vector3())
    if (!to || !this.dragStart) return
    const delta = new Matrix4().makeTranslation(to.x - p.from.x, to.y - p.from.y, 0)
    for (const [id, start] of this.dragStart) {
      const n = this.nodes.get(id)
      if (!n?.info) continue
      n.group.matrix.copy(delta).multiply(start)
      n.group.matrixWorldNeedsUpdate = true
      const world = n.group.matrix.clone().multiply(new Matrix4().makeTranslation(-n.info.center.x, -n.info.center.y, -n.info.center.z))
      hullBox(n.info.hull, world, n.box)
    }
    this.updateSelectionBoxes()
    this.invalidate()
  }

  private onCtrlUp = (e: PointerEvent) => {
    const p = this.ctrlPress
    if (!p || e.pointerId !== p.pointerId) return
    this.ctrlPress = null
    e.stopImmediatePropagation()
    const el = this.renderer.domElement
    if (el.hasPointerCapture(p.pointerId)) el.releasePointerCapture(p.pointerId)
    el.style.cursor = ''
    if (p.dragging) this.endDrag()
    else if (e.type === 'pointerup') this.cb.onPick(p.id, { shift: p.shift, ctrl: true }) // plain Ctrl+click: toggle selection
  }

  private pickObjectHit(): { id: string; dist: number } | null {
    const ray = this.raycaster.ray
    let best: { id: string; dist: number } | null = null
    for (const n of this.nodes.values()) {
      if (!n.mesh || !n.group.visible || !ray.intersectsBox(n.box)) continue
      const dist = rayMeshDistance(ray, n.mesh)
      if (dist !== null && (!best || dist < best.dist)) best = { id: n.id, dist }
    }
    return best
  }

  /** Box test first, then an exact raycast only against the candidates (cheap even for 1M-triangle meshes). */
  private pickObject(): string | null {
    const ray = this.raycaster.ray
    const candidates = [...this.nodes.values()]
      .filter((n) => n.mesh && n.group.visible && ray.intersectsBox(n.box))
      .map((n) => ({ n, d: ray.origin.distanceTo(n.box.getCenter(new Vector3())) }))
      .sort((a, b) => a.d - b.d)
    let best: { id: string; dist: number } | null = null
    for (const { n } of candidates) {
      const dist = rayMeshDistance(this.raycaster.ray, n.mesh!)
      if (dist !== null && (!best || dist < best.dist)) best = { id: n.id, dist }
    }
    return best?.id ?? null
  }

  private onPointerMove = (e: PointerEvent) => {
    if (this.pointerDown || this.gizmo.dragging) return
    this.setRay(e)
    if (this.input?.tool === 'layFace') {
      const hit = this.pickFacet()
      const m = (hit?.object as Mesh | undefined) ?? null
      if (m !== this.hoverFacet) {
        if (this.hoverFacet) (this.hoverFacet.material as MeshBasicMaterial).opacity = 0.22
        if (m) (m.material as MeshBasicMaterial).opacity = 0.6
        this.hoverFacet = m
        this.invalidate()
      }
      this.renderer.domElement.style.cursor = m ? 'pointer' : ''
      return
    }
    const over = [...this.nodes.values()].some((n) => n.mesh && n.group.visible && this.raycaster.ray.intersectsBox(n.box))
    this.renderer.domElement.style.cursor = over ? 'pointer' : ''
  }

  // ---------- camera ----------

  private focusBox(target: 'plate' | 'selection' | 'all'): Box3 {
    const box = new Box3()
    if (target !== 'plate') {
      const nodes = target === 'selection' ? this.selectedNodes() : [...this.nodes.values()].filter((n) => n.info && n.group.visible)
      for (const n of nodes) box.union(n.box)
    }
    if (box.isEmpty() && this.input) {
      const { bed, activePlate, doc } = this.input
      const [ox, oy] = plateOrigin(activePlate, doc.plates.length, bed)
      box.set(new Vector3(ox, oy, 0), new Vector3(ox + bed.w, oy + bed.d, bed.h * 0.35))
    }
    return box
  }

  /** View cube: animate (300 ms) to look from `dir`, keeping target and zoom. */
  lookFrom(dir: Vector3, up?: Vector3) {
    this.tween = null
    this.rig.lookFrom(dir, up)
  }

  /** View cube drag: orbit by azimuth/polar deltas. */
  orbitBy(dTheta: number, dPhi: number) {
    this.tween = null
    this.rig.orbitBy(dTheta, dPhi)
  }

  viewRotation() {
    return this.rig.viewRotation()
  }

  setView(view: ViewName, animate = true, target: 'plate' | 'selection' | 'all' = 'plate') {
    this.rig.cancel()
    const box = this.focusBox(target)
    const center = box.getCenter(new Vector3())
    const radius = Math.max(box.getSize(new Vector3()).length() / 2, 20)
    const fov = (this.camera.fov * Math.PI) / 180
    const fit = Math.max(1, 1 / Math.min(1, this.camera.aspect))
    const dist = (radius / Math.sin(fov / 2)) * (target === 'plate' ? 0.86 : 1.02) * fit
    const dir = DIRS[view].clone().normalize()
    const to = center.clone().add(dir.multiplyScalar(dist))
    if (!animate) {
      this.camera.position.copy(to)
      this.controls.target.copy(center)
      this.controls.update()
      this.invalidate()
      return
    }
    this.tween = { from: this.camera.position.clone(), to, tFrom: this.controls.target.clone(), tTo: center, start: performance.now(), ms: 420 }
    this.invalidate()
  }

  /** Keeps the current direction, refits the distance. */
  zoomToFit(target: 'plate' | 'selection' | 'all') {
    this.rig.cancel()
    const dir = this.camera.position.clone().sub(this.controls.target).normalize()
    const box = this.focusBox(target)
    const center = box.getCenter(new Vector3())
    const radius = Math.max(box.getSize(new Vector3()).length() / 2, 15)
    const dist = (radius / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.05 * Math.max(1, 1 / Math.min(1, this.camera.aspect))
    this.tween = { from: this.camera.position.clone(), to: center.clone().add(dir.multiplyScalar(dist)), tFrom: this.controls.target.clone(), tTo: center, start: performance.now(), ms: 380 }
    this.invalidate()
  }

  zoomBy(factor: number) {
    this.rig.cancel()
    const offset = this.camera.position.clone().sub(this.controls.target).multiplyScalar(factor)
    this.tween = { from: this.camera.position.clone(), to: this.controls.target.clone().add(offset), tFrom: this.controls.target.clone(), tTo: this.controls.target.clone(), start: performance.now(), ms: 200 }
    this.invalidate()
  }

  // ---------- thumbnails ----------

  /** PNG (base64, no data: prefix) of a plate's objects, seen from the front-left, transparent background. */
  renderThumbnail(plate: number, size: number): string {
    const nodes = [...this.nodes.values()].filter((n) => {
      const o = this.input?.doc.objects.find((x) => x.id === n.id)
      return o && o.plate === plate && n.info
    })
    const box = new Box3()
    for (const n of nodes) box.union(n.box)
    if (box.isEmpty() && this.input) {
      const [ox, oy] = plateOrigin(plate, this.input.doc.plates.length, this.input.bed)
      box.set(new Vector3(ox, oy, 0), new Vector3(ox + this.input.bed.w, oy + this.input.bed.d, 10))
    }
    const cam = new PerspectiveCamera(30, 1, 1, 20000)
    cam.up.set(0, 0, 1)
    const center = box.getCenter(new Vector3())
    const radius = Math.max(box.getSize(new Vector3()).length() / 2, 5)
    cam.position.copy(center).add(new Vector3(-0.55, -1.25, 0.95).normalize().multiplyScalar((radius / Math.sin((15 * Math.PI) / 180)) * 1.02))
    cam.lookAt(center)
    const light = new DirectionalLight(0xffffff, 1.9)
    light.position.set(0.3, 0.2, 1)
    cam.add(light)
    this.scene.add(cam)

    const visibility = new Map<Object3D, boolean>()
    const hide = (o: Object3D) => {
      visibility.set(o, o.visible)
      o.visible = false
    }
    hide(this.plates)
    hide(this.helpers)
    hide(this.gizmo.getHelper())
    hide(this.camera)
    const keep = new Set(nodes.map((n) => n.group))
    for (const n of this.nodes.values()) if (!keep.has(n.group)) hide(n.group)
    const emissive = nodes.map((n) => n.material.emissive.clone())
    for (const n of nodes) n.material.emissive.setRGB(0, 0, 0)

    const rt = new WebGLRenderTarget(size, size, { samples: 4, colorSpace: SRGBColorSpace })
    const prevTarget = this.renderer.getRenderTarget()
    this.renderer.setRenderTarget(rt)
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.clear()
    this.renderer.render(this.scene, cam)
    const px = new Uint8Array(size * size * 4)
    this.renderer.readRenderTargetPixels(rt, 0, 0, size, size, px)
    this.renderer.setRenderTarget(prevTarget)
    rt.dispose()

    nodes.forEach((n, i) => n.material.emissive.copy(emissive[i]))
    for (const [o, v] of visibility) o.visible = v
    this.scene.remove(cam)
    this.invalidate()

    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    const img = ctx.createImageData(size, size)
    for (let y = 0; y < size; y++) img.data.set(px.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4)
    ctx.putImageData(img, 0, 0)
    return canvas.toDataURL('image/png').split(',')[1]
  }
}
