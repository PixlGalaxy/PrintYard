// Projects: save (POST/PUT /api/projects with a plate thumbnail), open from the library, download as .3mf.
import { api } from '../api'
import type { LibraryFile, ProfileBundle, SceneDoc } from '../types'
import { meshes } from './meshes'
import { env } from './ops'
import type { PresetDefaults } from './profiles'
import { emptyDoc, workspace } from './store'

export class ProjectError extends Error {}

/** Every object's mesh must be in the library (no upload still running). */
export const hasPendingUploads = (doc: SceneDoc) => doc.objects.some((o) => o.fileId <= 0)

export async function saveProject(name?: string): Promise<LibraryFile> {
  const { doc, project } = workspace.state
  if (hasPendingUploads(doc)) throw new ProjectError('workspace.project.waitUploads')
  const finalName = (name ?? project.name).trim() || 'Untitled'
  const thumbnailPng = env.viewport?.renderThumbnail(0, 300)
  const body = { name: finalName, scene: doc, thumbnailPng }
  const file = project.fileId ? await api.saveProject(project.fileId, body) : await api.createProject(body)
  // Only clear "dirty" if nothing changed while saving
  const changedMeanwhile = workspace.state.doc !== doc
  workspace.markSaved({ fileId: file.id, name: finalName })
  if (changedMeanwhile) workspace.update((d) => ({ ...d }), { history: false })
  return file
}

/** Loads the meshes of every object (missing ones are reported once per file). */
export function loadSceneMeshes(doc: SceneDoc, onError?: (name: string, err: unknown) => void) {
  const seen = new Set<number>()
  for (const o of doc.objects) {
    if (o.fileId <= 0 || seen.has(o.fileId)) continue
    seen.add(o.fileId)
    const e = meshes.get(o.fileId)
    if (e?.state === 'ready' || e?.state === 'loading') continue
    meshes.ensure(o.fileId, o.name).catch((err) => onError?.(o.name, err))
  }
}

export async function openProject(id: number, onMeshError?: (name: string, err: unknown) => void) {
  const { file, scene } = await api.project(id)
  const doc: SceneDoc = { ...emptyDoc(), ...scene, plates: scene.plates?.length ? scene.plates : [{ index: 0 }] }
  workspace.load(doc, { fileId: file.id, name: file.name.replace(/\.3mf$/i, '') })
  loadSceneMeshes(doc, onMeshError)
  env.viewport?.setView('iso', true, 'plate')
}

/**
 * Empty scene. Process and slot-1 filament: the user's "always used" profiles (Profiles tab) when set and available,
 * else the current ones (as before defaults existed).
 */
export function newProject(defaults: PresetDefaults = {}, bundle?: ProfileBundle | null) {
  const { doc } = workspace.state
  const process = defaults.process && bundle?.process.some((p) => p.id === defaults.process) ? defaults.process : doc.processPresetId
  const fil = defaults.filament ? bundle?.filament.find((p) => p.id === defaults.filament) : undefined
  const filaments = fil ? [{ slot: 1, presetId: fil.id, color: fil.color ?? doc.filaments[0]?.color ?? '#7DD3FC' }] : doc.filaments.slice(0, 1)
  workspace.load(
    { ...emptyDoc(), machinePresetId: doc.machinePresetId, processPresetId: process, filaments, printerModel: doc.printerModel },
    { fileId: null, name: '' },
  )
}

export async function downloadProject() {
  const { project, dirty } = workspace.state
  let fileId = project.fileId
  let name = project.name
  if (!fileId || dirty) {
    const f = await saveProject()
    fileId = f.id
    name = f.name
  }
  await api.downloadFile({ id: fileId, name: /\.3mf$/i.test(name) ? name : `${name}.3mf` })
}
