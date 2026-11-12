// Editor operations (import, arrange, orient, lay on face, duplicate, plates…). They combine the scene store,
// the mesh cache and the placement helpers; every user-visible change is one undo step.
import { Matrix4, Quaternion, Vector3 } from 'three'
import type { LibraryFile, SceneDoc, SceneObject } from '../types'
import type { Viewport } from '../three/Viewport'
import { findFreeSpot, pack, type Rect } from './arrange'
import { centerAt, dropToBed, fromMatrix, hullBox, rotateAroundCenter, toMatrix } from './geometry'
import { meshes, type MeshInfo } from './meshes'
import { bestOrientation, type OrientMode } from './orient'
import { K2SE_BED, plateAt, plateOrigin, type BedSize } from './plates'
import { newObjectId, workspace } from './store'
import { modelThumbs } from './thumbnails'

export const MODEL_EXTS = ['stl', '3mf', 'obj']
export const MAX_PLATES = 36

/** Shared editor environment (set by the Prepare tab). */
export const env: { bed: BedSize; spacing: number; viewport: Viewport | null } = { bed: K2SE_BED, spacing: 6, viewport: null }

const extOf = (name: string) => name.toLowerCase().split('.').pop() ?? ''
const objOf = (doc: SceneDoc, id: string) => doc.objects.find((o) => o.id === id)

/** Plate-local XY rectangle of an object. */
function rectOf(o: SceneObject): Rect | null {
  const info = meshes.info(o.fileId)
  if (!info) return null
  const b = hullBox(info.hull, toMatrix(o.transform))
  return { x0: b.min.x, y0: b.min.y, x1: b.max.x, y1: b.max.y }
}

/** Places a mesh with a given rotation/scale on the first plate (from `prefer`) with room; may add a plate. */
function placeNew(doc: SceneDoc, info: MeshInfo, base: Matrix4, prefer: number, exclude: Set<string> = new Set()): { doc: SceneDoc; plate: number; m: Matrix4 } {
  const m = base.clone()
  dropToBed(m, info.hull)
  const b = hullBox(info.hull, m)
  const w = b.max.x - b.min.x
  const d = b.max.y - b.min.y
  const order = [prefer, ...doc.plates.map((_, i) => i).filter((i) => i !== prefer)]
  for (const plate of order) {
    const occupied = doc.objects.filter((o) => o.plate === plate && !exclude.has(o.id)).map(rectOf).filter((r): r is Rect => !!r)
    const spot = findFreeSpot(w, d, occupied, env.bed, env.spacing)
    if (spot) return { doc, plate, m: centerAt(m, info.hull, spot.cx, spot.cy) }
    if (plate !== prefer) continue
    // No gap big enough: re-arrange the preferred plate with the new object, if everything still fits on it
    const mine = doc.objects.filter((o) => o.plate === plate && !exclude.has(o.id) && meshes.info(o.fileId))
    const items = mine.map((o) => {
      const r = rectOf(o)!
      return { id: o.id, w: r.x1 - r.x0, d: r.y1 - r.y0 }
    })
    const placed = pack([...items, { id: '__new__', w, d }], env.bed, env.spacing, [plate], Number.MAX_SAFE_INTEGER)
    if (placed.every((p) => p.plate === plate)) {
      const byId = new Map(placed.map((p) => [p.id, p]))
      const objects = doc.objects.map((o) => {
        const p = byId.get(o.id)
        const oi = p && meshes.info(o.fileId)
        return p && oi ? { ...o, transform: fromMatrix(centerAt(toMatrix(o.transform), oi.hull, p.cx, p.cy)) } : o
      })
      const np = byId.get('__new__')!
      return { doc: { ...doc, objects }, plate, m: centerAt(m, info.hull, np.cx, np.cy) }
    }
  }
  if (doc.plates.length < MAX_PLATES) {
    const plate = doc.plates.length
    const lastBed = doc.plates[doc.plates.length - 1]?.bedType
    return { doc: { ...doc, plates: [...doc.plates, { index: plate, bedType: lastBed }] }, plate, m: centerAt(m, info.hull, env.bed.w / 2, env.bed.d / 2) }
  }
  return { doc, plate: prefer, m: centerAt(m, info.hull, env.bed.w / 2, env.bed.d / 2) }
}

function addMeshObject(fileId: number, name: string, info: MeshInfo) {
  const id = newObjectId()
  workspace.update((doc) => {
    const placed = placeNew(doc, info, new Matrix4(), workspace.state.activePlate)
    const slot = doc.filaments[0]?.slot ?? 1
    const obj: SceneObject = { id, fileId, name: name.replace(/\.(stl|3mf|obj)$/i, ''), plate: placed.plate, transform: fromMatrix(placed.m), filamentSlot: slot, overrides: {} }
    return { ...placed.doc, objects: [...placed.doc.objects, obj] }
  })
  workspace.select([id])
}

export interface ImportCallbacks {
  /**
   * Queues the file in the global upload queue (private library) right away and returns the queue item id plus a
   * promise of the stored file. The tray and the Objects list read their progress from that item.
   */
  upload: (file: File, tempFileId: number | null) => { itemId: number | null; done: Promise<LibraryFile> }
  /** Cancels a queued/running upload (a model that could not be read is not kept uploading). */
  cancelUpload?: (itemId: number) => void
  onError: (name: string, err: unknown) => void
  onGcode?: (file: LibraryFile) => void
  onUnsupported?: (name: string) => void
}

interface PendingImport {
  name: string
  size: number
  itemId: number | null
  /** Local parse of the dropped bytes (never rejects: null = could not be read). */
  parse: Promise<MeshInfo | null>
  placed: boolean
}

/** Imports still pending (keyed by temporary file id): placed in the scene once uploaded AND parsed. */
const pendingImports = new Map<number, PendingImport>()

const isAbort = (err: unknown) => err instanceof DOMException && err.name === 'AbortError'

/**
 * Drag & drop / file picker. Every model shows up at once as a pending row ("Uploading <name>" + progress): the
 * upload is queued FIRST (so the tray and the row show it immediately) and the mesh is parsed in parallel. When both
 * are done the row turns into a normal object (upload done but parse still running → "Processing…").
 */
export function importFiles(files: File[], cbs: ImportCallbacks) {
  for (const file of files) {
    const ext = extOf(file.name)
    if (ext === 'gcode') {
      void cbs.upload(file, null).done.then((f) => cbs.onGcode?.(f), (err) => !isAbort(err) && cbs.onError(file.name, err))
      continue
    }
    if (!MODEL_EXTS.includes(ext)) {
      cbs.onUnsupported?.(file.name)
      continue
    }
    const temp = workspace.tempFileId()
    const { itemId, done } = cbs.upload(file, temp)
    const base = { name: file.name, size: file.size, itemId }
    workspace.setUpload(temp, { ...base, state: 'uploading' })
    const parse = file
      .arrayBuffer()
      .then((buf) => meshes.parse(temp, file.name, buf))
      .then(
        (info) => info,
        (err: unknown) => {
          const p = pendingImports.get(temp)
          if (p && !p.placed) {
            if (p.itemId !== null) cbs.cancelUpload?.(p.itemId)
            workspace.setUpload(temp, { ...base, state: 'error', errorKind: 'parse', error: err instanceof Error ? err.message : String(err) })
            cbs.onError(file.name, err)
          }
          return null
        },
      )
    pendingImports.set(temp, { ...base, parse, placed: false })
    done.then(
      (lib) => completeUpload(temp, lib),
      (err: unknown) => {
        const p = pendingImports.get(temp)
        // A model that could not be read (its upload was cancelled) or was removed keeps its own state.
        if (!p || p.placed || workspace.state.uploads[temp]?.errorKind === 'parse') return
        workspace.setUpload(temp, { ...base, state: 'error', errorKind: 'upload', error: isAbort(err) ? undefined : err instanceof Error ? err.message : String(err) })
        if (!isAbort(err)) cbs.onError(file.name, err)
      },
    )
  }
}

/** Queue item of a pending import (a retried upload finishing later is mapped back with it). */
export function pendingImportOf(itemId: number): number | null {
  for (const [temp, p] of pendingImports) if (p.itemId === itemId && !p.placed) return temp
  return null
}

/**
 * The upload of a pending import finished (first try, or a retry from the tray / the row): wait for the local parse
 * ("Processing…" meanwhile), then place the object under the real library id.
 */
export function completeUpload(temp: number, file: LibraryFile) {
  const p = pendingImports.get(temp)
  if (!p || p.placed) return
  const cur = workspace.state.uploads[temp]
  if (cur?.errorKind === 'parse') return
  workspace.setUpload(temp, { name: p.name, size: p.size, itemId: p.itemId, state: 'processing' })
  void p.parse.then((info) => {
    if (p.placed || !pendingImports.has(temp) || !info) return
    p.placed = true
    pendingImports.delete(temp)
    meshes.alias(temp, file.id)
    meshes.drop(temp)
    workspace.setUpload(temp, null)
    addMeshObject(file.id, p.name, info)
    // Models have no embedded picture: render the library thumbnail from the mesh we already have
    modelThumbs.fromMesh(file, info.geometry)
  })
}

/** Removes a pending import (failed, or cancelled by the user). */
export function dismissUpload(temp: number, cancelUpload?: (itemId: number) => void) {
  const p = pendingImports.get(temp)
  if (p?.itemId != null) cancelUpload?.(p.itemId)
  pendingImports.delete(temp)
  if (workspace.state.doc.objects.some((o) => o.fileId === temp)) workspace.update((d) => ({ ...d, objects: d.objects.filter((o) => o.fileId !== temp) }))
  workspace.setUpload(temp, null)
  meshes.drop(temp)
}

/** Adds a model that is already in the library. */
export async function addLibraryModel(file: LibraryFile) {
  // A renamed file may have lost its extension; the parser falls back to the name for OBJ
  const name = file.name.toLowerCase().endsWith(`.${file.ext}`) ? file.name : `${file.name}.${file.ext}`
  const info = await meshes.ensure(file.id, name)
  addMeshObject(file.id, file.name, info)
  modelThumbs.fromMesh(file, info.geometry)
}

// ---------- selection-based edits ----------

const selected = () => workspace.state.doc.objects.filter((o) => workspace.state.selection.includes(o.id))

export function deleteSelected() {
  const ids = new Set(workspace.state.selection)
  if (!ids.size) return
  workspace.update((d) => ({ ...d, objects: d.objects.filter((o) => !ids.has(o.id)) }))
}

export function deleteObjects(ids: string[]) {
  const set = new Set(ids)
  workspace.update((d) => ({ ...d, objects: d.objects.filter((o) => !set.has(o.id)) }))
}

export function duplicateSelected() {
  const src = selected()
  if (!src.length) return
  const newIds: string[] = []
  workspace.update((doc) => {
    let d = doc
    for (const o of src) {
      const info = meshes.info(o.fileId)
      if (!info) continue
      const placed = placeNew(d, info, toMatrix(o.transform), o.plate)
      const id = newObjectId()
      newIds.push(id)
      d = { ...placed.doc, objects: [...placed.doc.objects, { ...o, id, plate: placed.plate, transform: fromMatrix(placed.m), name: o.name }] }
    }
    return d
  })
  if (newIds.length) workspace.select(newIds)
}

export function selectAllOnPlate() {
  const plate = workspace.state.activePlate
  workspace.select(workspace.state.doc.objects.filter((o) => o.plate === plate && !workspace.state.hidden.includes(o.id)).map((o) => o.id))
}

/** Applies `fn` to the plate-local matrix of each target object, then drops it to the bed. */
function transformObjects(ids: string[], fn: (m: Matrix4, info: MeshInfo, o: SceneObject) => Matrix4 | null, drop = true, history = true) {
  const changes: Record<string, Partial<SceneObject>> = {}
  for (const id of ids) {
    const o = objOf(workspace.state.doc, id)
    const info = o && meshes.info(o.fileId)
    if (!o || !info) continue
    const m = fn(toMatrix(o.transform), info, o)
    if (!m) continue
    if (drop) dropToBed(m, info.hull)
    changes[id] = { transform: fromMatrix(m) }
  }
  if (Object.keys(changes).length) workspace.updateObjects(changes, { history })
  return Object.keys(changes).length
}

/** End of a gizmo drag: world matrices → plate-local (an object dragged onto another plate moves there). */
export function applyWorldMatrices(world: Map<string, Matrix4>) {
  const { doc } = workspace.state
  const changes: Record<string, Partial<SceneObject>> = {}
  for (const [id, wm] of world) {
    const o = objOf(doc, id)
    const info = o && meshes.info(o.fileId)
    if (!o || !info) continue
    const c = hullBox(info.hull, wm).getCenter(new Vector3())
    const plate = Math.max(0, plateAt(c.x, c.y, doc.plates.length, env.bed))
    const [ox, oy] = plateOrigin(plate, doc.plates.length, env.bed)
    const m = new Matrix4().makeTranslation(-ox, -oy, 0).multiply(wm)
    dropToBed(m, info.hull)
    changes[id] = { transform: fromMatrix(m), plate }
  }
  workspace.updateObjects(changes)
  const last = changes[workspace.state.selection[workspace.state.selection.length - 1]]
  if (last?.plate !== undefined) workspace.setActivePlate(last.plate)
}

export function layOnFace(id: string, worldNormal: Vector3) {
  const q = new Quaternion().setFromUnitVectors(worldNormal.clone().normalize(), new Vector3(0, 0, -1))
  transformObjects([id], (m, info) => rotateAroundCenter(m, q, info.hull))
}

/** Auto-orient the selection (or every object of the active plate). Returns how many objects turned. */
export function autoOrient(mode: OrientMode = 'strong'): number {
  const ids = workspace.state.selection.length
    ? workspace.state.selection
    : workspace.state.doc.objects.filter((o) => o.plate === workspace.state.activePlate).map((o) => o.id)
  return transformObjects(ids, (m, info) => {
    const q = bestOrientation(info, m, mode)
    return q ? rotateAroundCenter(m, q, info.hull) : null
  })
}

export function centerSelected() {
  const objs = selected()
  if (!objs.length) return
  // Moves the selection as a group so that its bounding box is centred on its plate
  const byPlate = new Map<number, SceneObject[]>()
  for (const o of objs) byPlate.set(o.plate, [...(byPlate.get(o.plate) ?? []), o])
  const changes: Record<string, Partial<SceneObject>> = {}
  for (const list of byPlate.values()) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const o of list) {
      const r = rectOf(o)
      if (!r) continue
      x0 = Math.min(x0, r.x0)
      y0 = Math.min(y0, r.y0)
      x1 = Math.max(x1, r.x1)
      y1 = Math.max(y1, r.y1)
    }
    const dx = env.bed.w / 2 - (x0 + x1) / 2
    const dy = env.bed.d / 2 - (y0 + y1) / 2
    for (const o of list) changes[o.id] = { transform: fromMatrix(toMatrix(o.transform).premultiply(new Matrix4().makeTranslation(dx, dy, 0))) }
  }
  workspace.updateObjects(changes)
}

export function mirrorSelected(axis: 'x' | 'y' | 'z') {
  const s = new Vector3(axis === 'x' ? -1 : 1, axis === 'y' ? -1 : 1, axis === 'z' ? -1 : 1)
  transformObjects(workspace.state.selection, (m, info) => {
    const c = hullBox(info.hull, m).getCenter(new Vector3())
    return m.premultiply(new Matrix4().makeTranslation(c.x, c.y, c.z).multiply(new Matrix4().makeScale(s.x, s.y, s.z)).multiply(new Matrix4().makeTranslation(-c.x, -c.y, -c.z)))
  })
}

/** Rotate by a fixed step around a world axis through the object's centre (toolbar quick rotate). */
export function rotateSelected(axis: 'x' | 'y' | 'z', deg: number) {
  const q = new Quaternion().setFromAxisAngle(new Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0), (deg * Math.PI) / 180)
  transformObjects(workspace.state.selection, (m, info) => rotateAroundCenter(m, q, info.hull))
}

/** Arrow-key nudge (mm). Not dropped to bed, no plate change. */
export function nudgeSelected(dx: number, dy: number) {
  transformObjects(workspace.state.selection, (m) => m.premultiply(new Matrix4().makeTranslation(dx, dy, 0)), false)
}

/** Numeric transform panel: set the full plate-local matrix of one object. `history: false` while a slider is
 *  being dragged (only the first step of a drag is undoable, so one drag = one undo). */
export function setObjectMatrix(id: string, m: Matrix4, history = true) {
  transformObjects([id], () => m, true, history)
}

/** Uniformly scales an object down (or up) so it fits the printable volume with a small margin. */
export function scaleToFit(id: string) {
  transformObjects([id], (m, info) => {
    const b = hullBox(info.hull, m)
    const size = b.getSize(new Vector3())
    const k = Math.min((env.bed.w - 2) / size.x, (env.bed.d - 2) / size.y, (env.bed.h - 1) / size.z)
    const c = b.getCenter(new Vector3())
    m.premultiply(new Matrix4().makeTranslation(c.x, c.y, c.z).multiply(new Matrix4().makeScale(k, k, k)).multiply(new Matrix4().makeTranslation(-c.x, -c.y, -c.z)))
    return centerAt(m, info.hull, env.bed.w / 2, env.bed.d / 2)
  })
}

export function setFilamentSlot(ids: string[], slot: number) {
  workspace.updateObjects(Object.fromEntries(ids.map((id) => [id, { filamentSlot: slot }])))
}

export function renameObject(id: string, name: string) {
  const n = name.trim()
  if (n) workspace.updateObjects({ [id]: { name: n.slice(0, 120) } })
}

// ---------- arrange & plates ----------

/** Arranges the active plate (`scope = 'plate'`) or everything across plates. */
export function arrange(scope: 'plate' | 'all') {
  const { doc, activePlate } = workspace.state
  const targets = doc.objects.filter((o) => (scope === 'all' || o.plate === activePlate) && meshes.info(o.fileId))
  if (!targets.length) return
  const items = targets.map((o) => {
    const r = rectOf(o)!
    return { id: o.id, w: r.x1 - r.x0, d: r.y1 - r.y0 }
  })
  const plates = scope === 'all' ? doc.plates.map((_, i) => i) : [activePlate]
  const placements = pack(items, env.bed, env.spacing, plates, doc.plates.length)
  workspace.update((d) => {
    const maxPlate = Math.max(d.plates.length - 1, ...placements.map((p) => p.plate))
    const lastBed = d.plates[d.plates.length - 1]?.bedType
    const newPlates = [...d.plates]
    for (let i = d.plates.length; i <= Math.min(maxPlate, MAX_PLATES - 1); i++) newPlates.push({ index: i, bedType: lastBed })
    const byId = new Map(placements.map((p) => [p.id, p]))
    return {
      ...d,
      plates: newPlates,
      objects: d.objects.map((o) => {
        const p = byId.get(o.id)
        const info = p && meshes.info(o.fileId)
        if (!p || !info) return o
        const plate = Math.min(p.plate, MAX_PLATES - 1)
        return { ...o, plate, transform: fromMatrix(centerAt(dropToBed(toMatrix(o.transform), info.hull), info.hull, p.cx, p.cy)) }
      }),
    }
  })
}

export function addPlate() {
  const { doc } = workspace.state
  if (doc.plates.length >= MAX_PLATES) return
  workspace.update((d) => ({ ...d, plates: [...d.plates, { index: d.plates.length, bedType: d.plates[d.plates.length - 1]?.bedType }] }))
  workspace.setActivePlate(workspace.state.doc.plates.length - 1)
  env.viewport?.setView('iso', true, 'plate')
}

/** Deletes a plate and its objects; later plates shift down. */
export function removePlate(index: number) {
  workspace.update((d) => {
    if (d.plates.length <= 1) return { ...d, objects: d.objects.filter((o) => o.plate !== index) }
    return {
      ...d,
      plates: d.plates.filter((_, i) => i !== index).map((p, i) => ({ ...p, index: i })),
      objects: d.objects.filter((o) => o.plate !== index).map((o) => (o.plate > index ? { ...o, plate: o.plate - 1 } : o)),
    }
  })
}

export function renamePlate(index: number, name: string) {
  workspace.update((d) => ({ ...d, plates: d.plates.map((p, i) => (i === index ? { ...p, name: name.trim() || undefined } : p)) }))
}

export function setPlateBedType(index: number | 'all', bedType: string) {
  workspace.update((d) => ({ ...d, plates: d.plates.map((p, i) => (index === 'all' || i === index ? { ...p, bedType } : p)) }))
}

/** Moves objects to another plate, finding a free spot there. */
export function moveToPlate(ids: string[], plate: number) {
  workspace.update((doc) => {
    let d = doc
    for (const id of ids) {
      const o = objOf(d, id)
      const info = o && meshes.info(o.fileId)
      if (!o || !info || o.plate === plate) continue
      const others = { ...d, objects: d.objects.filter((x) => x.id !== id) }
      const placed = placeNew(others, info, toMatrix(o.transform), plate, new Set([id]))
      d = { ...placed.doc, objects: [...placed.doc.objects, { ...o, plate: placed.plate, transform: fromMatrix(placed.m) }] }
    }
    return d
  })
  workspace.setActivePlate(plate)
}

/** Objects whose meshes are outside the printable volume (plate-local check). */
export function outsideObjects(doc: SceneDoc, plate?: number): SceneObject[] {
  return doc.objects.filter((o) => {
    if (plate !== undefined && o.plate !== plate) return false
    const info = meshes.info(o.fileId)
    if (!info) return false
    const b = hullBox(info.hull, toMatrix(o.transform))
    const eps = 0.05
    return b.min.x < -eps || b.min.y < -eps || b.max.x > env.bed.w + eps || b.max.y > env.bed.d + eps || b.max.z > env.bed.h + eps
  })
}
