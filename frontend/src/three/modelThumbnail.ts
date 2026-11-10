// Library thumbnail of a single model: offscreen render (own small WebGL context, released after a while idle),
// isometric orthographic view, neutral material tinted with the skin accent, transparent background, square PNG.
import { Box3, BufferGeometry, Color, DirectionalLight, HemisphereLight, Mesh, MeshStandardMaterial, OrthographicCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderer } from 'three'

let renderer: WebGLRenderer | null = null
let idleTimer: ReturnType<typeof setTimeout> | undefined

function getRenderer(size: number): WebGLRenderer {
  if (!renderer) {
    const canvas = document.createElement('canvas')
    renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true, powerPreference: 'low-power' })
    renderer.outputColorSpace = SRGBColorSpace
    renderer.setPixelRatio(1)
  }
  renderer.setSize(size, size, false)
  clearTimeout(idleTimer)
  // Browsers cap the number of live WebGL contexts: give this one back when the queue is quiet
  idleTimer = setTimeout(() => {
    renderer?.dispose()
    renderer?.forceContextLoss()
    renderer = null
  }, 15_000)
  return renderer
}

/** Renders `geometry` (file coordinates, Z up) and returns the PNG as base64 (no data: prefix). */
export async function renderModelThumbnail(geometry: BufferGeometry, accent: string, size = 256): Promise<string> {
  const r = getRenderer(size)
  const scene = new Scene()
  const tint = new Color('#c9ced6').lerp(new Color(accent), 0.55)
  const material = new MeshStandardMaterial({ color: tint, roughness: 0.62, metalness: 0.04 })
  const mesh = new Mesh(geometry, material)
  scene.add(mesh)

  if (!geometry.boundingBox) geometry.computeBoundingBox()
  const box = geometry.boundingBox?.clone() ?? new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1))
  const center = box.getCenter(new Vector3())

  // Isometric-ish view from the front-left, Z up
  const dir = new Vector3(-1, -1.25, 1).normalize()
  const radius = Math.max(box.getSize(new Vector3()).length() / 2, 1)
  const cam = new OrthographicCamera(-1, 1, 1, -1, 0.01, radius * 8)
  cam.up.set(0, 0, 1)
  cam.position.copy(center).addScaledVector(dir, radius * 3)
  cam.lookAt(center)
  cam.updateMatrixWorld()
  // Fit the frustum to the box corners as seen by the camera (tight framing, 12 % margin)
  const inv = cam.matrixWorldInverse
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (let i = 0; i < 8; i++) {
    const p = new Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(inv)
    x0 = Math.min(x0, p.x)
    x1 = Math.max(x1, p.x)
    y0 = Math.min(y0, p.y)
    y1 = Math.max(y1, p.y)
  }
  const half = (Math.max(x1 - x0, y1 - y0) / 2) * 1.12 || 1
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  cam.left = cx - half
  cam.right = cx + half
  cam.top = cy + half
  cam.bottom = cy - half
  cam.updateProjectionMatrix()

  scene.add(new HemisphereLight(0xffffff, 0x8a8f98, 1.6))
  const key = new DirectionalLight(0xffffff, 1.7)
  key.position.set(-0.6, -0.4, 1)
  cam.add(key)
  const rim = new DirectionalLight(0xffffff, 0.5)
  rim.position.set(1, 0.6, -0.4)
  cam.add(rim)
  scene.add(cam)
  // Lights ride on the camera; aim them at the model (a target outside the scene would sit at the origin)
  for (const l of [key, rim]) {
    l.target.position.copy(center)
    scene.add(l.target)
  }

  r.setClearColor(0x000000, 0)
  r.clear()
  r.render(scene, cam)
  material.dispose()

  const blob = await new Promise<Blob | null>((resolve) => r.domElement.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('thumbnail.render_failed')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}
