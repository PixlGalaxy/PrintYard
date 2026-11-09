import { useEffect, useRef } from 'react'
import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  EdgesGeometry,
  GridHelper,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'
import { useAccent } from '../../theme/accent'
import { createCameraControls } from '../../three/navigation'
import type { Nav3dPrefs, Nav3dView } from '../../types'

const VIEWS: Record<Nav3dView, Vector3> = {
  iso: new Vector3(-0.62, -1.35, 1.05),
  top: new Vector3(0, -0.0001, 1),
  front: new Vector3(0, -1, 0.0001),
}

/** Small three.js sandbox (a cube on a grid) to try the 3D navigation scheme before using it in the workspace. */
export default function Nav3dPreview({ prefs, label }: { prefs: Nav3dPrefs; label: string }) {
  const host = useRef<HTMLDivElement>(null)
  const api = useRef<{ setPrefs: (p: Nav3dPrefs) => void; setAccent: (c: string) => void; view: (v: Nav3dView) => void } | null>(null)
  const accent = useAccent()[500]

  useEffect(() => {
    const el = host.current
    if (!el) return
    const renderer = new WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = SRGBColorSpace
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.touchAction = 'none'
    el.appendChild(renderer.domElement)

    const scene = new Scene()
    const camera = new PerspectiveCamera(35, 1, 1, 5000)
    camera.up.set(0, 0, 1)
    scene.add(new AmbientLight(0xffffff, 0.6))
    const sun = new DirectionalLight(0xffffff, 1.8)
    sun.position.set(-0.4, -0.6, 1)
    camera.add(sun)
    scene.add(camera)

    const grid = new GridHelper(160, 16, 0x8a94a6, 0x8a94a6)
    grid.rotation.x = Math.PI / 2
    ;(grid.material as LineBasicMaterial).transparent = true
    ;(grid.material as LineBasicMaterial).opacity = 0.35
    scene.add(grid)

    const base = new Color('#94a3b8')
    const mat = new MeshStandardMaterial({ color: base, roughness: 0.55 })
    const cube = new Mesh(new BoxGeometry(30, 30, 30), mat)
    cube.position.set(0, 0, 15)
    const edges = new LineSegments(new EdgesGeometry(cube.geometry), new LineBasicMaterial({ color: '#334155' }))
    cube.add(edges)
    scene.add(cube)
    let selected = false
    let accentColor = new Color('#0ea5e9')

    const { controls, handle, dispose } = createCameraControls(camera, renderer.domElement, prefs)
    controls.target.set(0, 0, 10)
    controls.minDistance = 30
    controls.maxDistance = 900

    let raf = 0
    const invalidate = () => {
      if (!raf) raf = requestAnimationFrame(frame)
    }
    const frame = () => {
      raf = 0
      const more = controls.update()
      renderer.render(scene, camera)
      if (more) invalidate()
    }
    controls.addEventListener('change', invalidate)

    const view = (v: Nav3dView) => {
      camera.position.copy(VIEWS[v]).normalize().multiplyScalar(190).add(controls.target)
      controls.update()
      invalidate()
    }
    view(prefs.defaultView ?? 'iso')

    const paint = () => {
      mat.color.copy(selected ? accentColor : base)
      ;(edges.material as LineBasicMaterial).color.set(selected ? accentColor : new Color('#334155'))
      invalidate()
    }

    // Left click without drag = select (as in the workspace)
    let down: { x: number; y: number } | null = null
    const ray = new Raycaster()
    const onDown = (e: PointerEvent) => {
      down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null
    }
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return
      const r = renderer.domElement.getBoundingClientRect()
      ray.setFromCamera(new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera)
      selected = ray.intersectObject(cube, false).length > 0 ? !selected : false
      paint()
    }
    const noMenu = (e: Event) => e.preventDefault()
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointerup', onUp)
    renderer.domElement.addEventListener('contextmenu', noMenu)

    const resize = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (!w || !h) return
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      invalidate()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    resize()

    api.current = {
      setPrefs: (p) => handle.setPrefs(p),
      setAccent: (c) => {
        accentColor = new Color(c)
        paint()
      },
      view,
    }
    return () => {
      api.current = null
      cancelAnimationFrame(raf)
      ro.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerup', onUp)
      renderer.domElement.removeEventListener('contextmenu', noMenu)
      dispose()
      cube.geometry.dispose()
      edges.geometry.dispose()
      mat.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
    // Created once; prefs/accent changes are pushed below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => api.current?.setPrefs(prefs), [prefs])
  useEffect(() => api.current?.view(prefs.defaultView ?? 'iso'), [prefs.defaultView])
  useEffect(() => api.current?.setAccent(accent), [accent])

  return <div ref={host} role="img" aria-label={label} className="h-56 w-full overflow-hidden rounded-xl border border-line bg-surface-2/60" />
}
