// Dev-only mock for the Phase 2 F1 endpoints: profiles (a real K2 SE subset generated from the Creality Print
// 7.3.1 profiles, see data/k2se-profiles.json), slicing (simulated job progress over the fake WebSocket, result
// = a sample G-code in the library) and projects (scene JSON + a real 3MF built in the browser).
import { strToU8, zipSync } from 'fflate'
import { ApiError } from '../api'
import type { LibraryFile, OptionDef, PresetSummary, ProfileBundle, ResolvedPreset, SceneDoc, SliceJob, SliceJobStage, SliceRequest } from '../types'
import data from './data/k2se-profiles.json'
import { mockCore } from './mock'
import { engineInstalledVersion, mockBlob, mockFiles, mockPublish, NOT_HANDLED } from './mockF2'
import { generateSampleGcode } from './sampleGcode'
import { customFilamentSummaries, handleFilaments, resolveCustomFilament } from './mockFilaments'
import { dependencySelfChecks } from '../workspace/settings/dependencies'

// Dev-only: the option dependency rules check themselves once when the mock loads
{
  const fails = dependencySelfChecks()
  if (fails.length) console.error('[mock] dependency self-checks failed:', fails)
  else console.info('[mock] dependency self-checks passed')
}

interface RawPreset {
  id: string
  name: string
  kind: 'machine' | 'process' | 'filament'
  isDefault?: boolean
  filamentType?: string
  color?: string
  values: Record<string, string>
}
interface RawData {
  engineVersion: string
  machine: RawPreset[]
  process: RawPreset[]
  filament: RawPreset[]
  options: OptionDef[]
  es: Record<string, EsStrings>
  filamentOptions: OptionDef[]
  filamentEs: Record<string, EsStrings>
}
type EsStrings = { label?: string; tooltip?: string; group?: string; unit?: string; enum?: string[] }

const localize = (list: OptionDef[], tr: Record<string, EsStrings>) =>
  list.map((o) => {
    const t = tr[o.key]
    if (!t) return o
    return {
      ...o,
      label: t.label ?? o.label,
      tooltip: t.tooltip ?? o.tooltip,
      group: t.group ?? o.group,
      unit: t.unit ?? o.unit,
      enumValues: o.enumValues?.map((e, i) => ({ ...e, label: t.enum?.[i] ?? e.label })),
    }
  })
const DATA = data as unknown as RawData
const MODEL = 'creality-k2se'

const summary = ({ values: _v, ...p }: RawPreset): PresetSummary => p

function bundle(lang: string | null): ProfileBundle {
  const es = lang === 'es'
  return {
    engineVersion: DATA.engineVersion,
    printerModel: MODEL,
    machine: DATA.machine.map(summary),
    process: DATA.process.map(summary),
    filament: [...DATA.filament.map(summary), ...customFilamentSummaries(DATA.filament)],
    options: es ? localize(DATA.options, DATA.es) : DATA.options,
    filamentOptions: es ? localize(DATA.filamentOptions, DATA.filamentEs) : DATA.filamentOptions,
  }
}

// ---------- state (scene sidecars of projects, slice jobs) ----------

const KEY = 'sd:mock:f1'
const scenes: Record<number, SceneDoc> = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<number, SceneDoc>
  } catch {
    return {}
  }
})()
const saveScenes = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(scenes))
  } catch {
    // ignore
  }
}

interface MockJob {
  job: SliceJob
  ownerId: number
  req: SliceRequest
  cancelled: boolean
}
const jobs = new Map<string, MockJob>()
const queue: MockJob[] = []
let runningJob: MockJob | null = null

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function publish(m: MockJob, patch: Partial<SliceJob>) {
  m.job = { ...m.job, ...patch }
  mockPublish({ type: 'slice.job', data: m.job }, { userId: m.ownerId })
}

const STEPS = ['Generating perimeters', 'Generating infill', 'Generating support material', 'Generating skirt & brim', 'Exporting G-code']
/** B1 stages over the slicing progress (0..100) */
const SLICE_STAGES: [number, SliceJobStage][] = [
  [0, 'loading'],
  [15, 'slicing'],
  [30, 'walls'],
  [50, 'infill'],
  [65, 'supports'],
  [80, 'toolpath'],
  [92, 'gcode'],
]

/** Dev toolbar: make the next project builds (slicing + project save) fail with a backend build error. */
const FAIL_KEY = 'sd:mock:build-fail'
export type MockBuildFailure = 'none' | 'projects.build_timeout' | 'projects.build_failed'
export const mockBuildFailure = {
  get(): MockBuildFailure {
    try {
      return (localStorage.getItem(FAIL_KEY) as MockBuildFailure | null) ?? 'none'
    } catch {
      return 'none'
    }
  },
  set(v: MockBuildFailure) {
    try {
      localStorage.setItem(FAIL_KEY, v)
    } catch {
      // ignore
    }
  },
}
const buildError = () => {
  const f = mockBuildFailure.get()
  return f === 'none' ? null : new ApiError(f === 'projects.build_timeout' ? 504 : 500, f, f === 'projects.build_timeout' ? 'Building the project took too long' : 'The project build worker died')
}

async function runQueue() {
  if (runningJob) return
  while (queue.length) {
    const m = queue.shift()!
    if (m.cancelled) continue
    runningJob = m
    try {
      publish(m, { state: 'preparing', stage: 'building', progress: 2, message: 'Building 3MF' })
      await sleep(900)
      const fail = buildError()
      if (fail) throw fail
      for (let p = 4; p <= 96 && !m.cancelled; p += 4) {
        const stage = [...SLICE_STAGES].reverse().find(([from]) => p >= from)![1]
        publish(m, { state: 'slicing', stage, progress: p, message: STEPS[Math.min(STEPS.length - 1, Math.floor(p / 21))] })
        await sleep(160)
      }
      if (m.cancelled) continue
      publish(m, { state: 'postprocessing', stage: 'thumbnails', progress: 98, message: 'Injecting thumbnails' })
      await sleep(450)
      if (m.cancelled) continue
      publish(m, { state: 'postprocessing', stage: 'saving', progress: 99, message: 'Saving' })
      await sleep(300)
      if (m.cancelled) continue
      const result = await sliceResult(m)
      publish(m, { state: 'done', stage: 'done', progress: 100, message: undefined, result })
    } catch (err) {
      publish(m, { state: 'failed', error: err instanceof ApiError ? err.code : err instanceof Error ? err.message : String(err) })
    } finally {
      runningJob = null
    }
  }
}

async function sliceResult(m: MockJob) {
  const { scene, plate, thumbnails } = m.req
  const proc = DATA.process.find((p) => p.id === scene.processPresetId) ?? DATA.process[0]
  const lh = Number(scene.processOverrides.layer_height ?? proc.values.layer_height) || 0.2
  const objs = scene.objects.filter((o) => o.plate === plate)
  const colors = [scene.filaments[0]?.color ?? '#F2F2F2', scene.filaments[1]?.color ?? '#0EA5E9'] as [string, string]
  // Height/radius: a rough proxy for the plate's content (the mock does not slice the real meshes)
  const height = Math.min(80, 16 + objs.length * 8)
  const g = generateSampleGcode({ layerHeight: lh, height, radius: 18 + Math.min(14, objs.length * 3), colors })
  const base = (scene.objects[0]?.name ?? 'plate').replace(/[^\w.-]+/g, '_').slice(0, 40)
  const file: LibraryFile = mockFiles.add({
    ownerId: m.ownerId,
    name: `${base}_plate_${plate + 1}.gcode`,
    kind: 'gcode',
    blob: g.blob,
    thumbnailUrl: thumbnails.large ? `data:image/png;base64,${thumbnails.large}` : undefined,
    meta: {
      gcode: {
        printSeconds: g.printSeconds,
        filamentGrams: g.filamentGrams,
        filamentMm: g.filamentMm,
        layers: g.layers,
        printerModel: 'Creality K2 SE',
        slicer: `Creality Print ${DATA.engineVersion}`,
        estimateSource: 'slicer',
      },
      trusted: true,
    },
  })
  mockCore.audit('slice.done', file.name)
  mockCore.save()
  return { fileId: file.id, summary: file.meta.gcode! }
}

// ---------- 3MF (Creality/Bambu dialect, simplified: STL meshes only) ----------

function stlTriangles(buf: ArrayBuffer): Float32Array | null {
  const dv = new DataView(buf)
  if (buf.byteLength >= 84) {
    const n = dv.getUint32(80, true)
    if (84 + n * 50 === buf.byteLength) {
      const out = new Float32Array(n * 9)
      for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) out[i * 9 + k] = dv.getFloat32(84 + i * 50 + 12 + k * 4, true)
      return out
    }
  }
  const txt = new TextDecoder().decode(buf)
  if (!txt.trimStart().startsWith('solid')) return null
  const v = [...txt.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].flatMap((m) => [+m[1], +m[2], +m[3]])
  return v.length ? new Float32Array(v) : null
}

async function build3mf(name: string, scene: SceneDoc, thumb?: string): Promise<Blob> {
  const W = 220
  const D = 215
  const cols = Math.ceil(Math.sqrt(scene.plates.length))
  const objects: string[] = []
  const items: string[] = []
  const settings: string[] = []
  let id = 1
  for (const o of scene.objects) {
    let tris: Float32Array | null = null
    try {
      tris = stlTriangles(await (await mockBlob(`/files/${o.fileId}/content`, {})).arrayBuffer())
    } catch {
      tris = null
    }
    if (!tris) continue
    const verts: string[] = []
    const faces: string[] = []
    for (let i = 0; i < tris.length / 3; i++) verts.push(`<vertex x="${tris[i * 3]}" y="${tris[i * 3 + 1]}" z="${tris[i * 3 + 2]}"/>`)
    for (let i = 0; i < tris.length / 9; i++) faces.push(`<triangle v1="${i * 3}" v2="${i * 3 + 1}" v3="${i * 3 + 2}"/>`)
    objects.push(`<object id="${id}" type="model"><mesh><vertices>${verts.join('')}</vertices><triangles>${faces.join('')}</triangles></mesh></object>`)
    const m = o.transform
    const ox = (o.plate % cols) * W * 1.2
    const oy = -Math.floor(o.plate / cols) * D * 1.2
    items.push(`<item objectid="${id}" transform="${[m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10], m[12] + ox, m[13] + oy, m[14]].join(' ')}" printable="1"/>`)
    settings.push(
      `<object id="${id}"><metadata key="name" value="${o.name.replace(/"/g, '&quot;')}"/><metadata key="extruder" value="${o.filamentSlot}"/>${Object.entries(o.overrides)
        .map(([k, v]) => `<metadata key="${k}" value="${v.replace(/"/g, '&quot;')}"/>`)
        .join('')}</object>`,
    )
    id++
  }
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Application">Creality_Print V7.3.1</metadata>
<metadata name="Title">${name.replace(/</g, '')}</metadata>
<resources>${objects.join('')}</resources>
<build>${items.join('')}</build>
</model>`
  const proc = DATA.process.find((p) => p.id === scene.processPresetId)
  const machine = DATA.machine.find((p) => p.id === scene.machinePresetId) ?? DATA.machine[0]
  const config = { ...machine.values, ...(proc?.values ?? {}), ...scene.processOverrides, print_settings_id: scene.processPresetId, printer_settings_id: machine.id, filament_settings_id: scene.filaments.map((f) => f.presetId), filament_colour: scene.filaments.map((f) => f.color) }
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="png" ContentType="image/png"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
    ),
    '3D/3dmodel.model': strToU8(model),
    'Metadata/model_settings.config': strToU8(`<?xml version="1.0" encoding="UTF-8"?><config>${settings.join('')}${scene.plates.map((p, i) => `<plate><metadata key="plater_id" value="${i + 1}"/><metadata key="plater_name" value="${p.name ?? ''}"/><metadata key="bed_type" value="${p.bedType ?? ''}"/></plate>`).join('')}</config>`),
    'Metadata/project_settings.config': strToU8(JSON.stringify(config, null, 2)),
    'Metadata/slicedock_scene.json': strToU8(JSON.stringify(scene)),
  }
  if (thumb) files['Metadata/plate_1.png'] = Uint8Array.from(atob(thumb), (c) => c.charCodeAt(0))
  return new Blob([zipSync(files, { level: 6 }) as Uint8Array<ArrayBuffer>], { type: 'model/3mf' })
}

// ---------- router ----------

export function handleF1(method: string, p: string, url: URL, b: Record<string, unknown>): unknown {
  const custom = handleFilaments(method, p, url, b, DATA.filament)
  if (custom !== NOT_HANDLED) return custom
  // Profiles
  const pm = p.match(/^\/profiles\/([\w-]+)(?:\/preset\/(machine|process|filament)\/(.+))?$/)
  if (pm && method === 'GET') {
    mockCore.requireUser()
    if (pm[1] !== MODEL) throw new ApiError(404, 'common.not_found', 'Unknown printer model')
    if (!pm[2]) return bundle(url.searchParams.get('lang'))
    const id = decodeURIComponent(pm[3])
    if (pm[2] === 'filament' && id.startsWith('custom:')) return resolveCustomFilament(id, DATA.filament)
    const list = DATA[pm[2] as 'machine' | 'process' | 'filament']
    const preset = list.find((x) => x.id === id)
    if (!preset) throw new ApiError(404, 'common.not_found', 'Unknown preset')
    return { id: preset.id, values: preset.values } satisfies ResolvedPreset
  }

  // Slicing
  if (p === '/slice' && method === 'POST') {
    const u = mockCore.requireUser()
    if (!engineInstalledVersion()) throw new ApiError(409, 'engine.not_installed', 'No slicing engine installed')
    const req = b as unknown as SliceRequest
    if (!req.scene?.objects?.some((o) => o.plate === req.plate)) throw new ApiError(400, 'slice.empty_plate', 'Nothing to slice on this plate')
    const job: SliceJob = { id: `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, state: 'queued', stage: 'queued', progress: 0, plate: req.plate, createdAt: Date.now() }
    const m: MockJob = { job, ownerId: u.id, req, cancelled: false }
    jobs.set(job.id, m)
    queue.push(m)
    setTimeout(() => void runQueue(), 400)
    return job
  }
  const sm = p.match(/^\/slice\/([\w-]+)$/)
  if (sm) {
    const u = mockCore.requireUser()
    const m = jobs.get(sm[1])
    if (!m || (m.ownerId !== u.id && u.role !== 'admin')) throw new ApiError(404, 'common.not_found', 'Not found')
    if (method === 'DELETE') {
      if (!['done', 'failed', 'cancelled'].includes(m.job.state)) {
        m.cancelled = true
        publish(m, { state: 'cancelled' })
      }
      return undefined
    }
    return m.job
  }

  // Projects
  if (p === '/projects' && method === 'POST') return saveProject(null, b)
  const prm = p.match(/^\/projects\/(\d+)$/)
  if (prm) {
    const id = Number(prm[1])
    if (method === 'PUT') return saveProject(id, b)
    if (method === 'GET') {
      const u = mockCore.requireUser()
      const file = mockFiles.get(id)
      if (!file || file.kind !== 'project' || (file.ownerId !== u.id && file.visibility !== 'shared')) throw new ApiError(404, 'common.not_found', 'Not found')
      const scene = scenes[id]
      if (!scene) throw new ApiError(404, 'projects.no_scene', 'This project has no SliceDock scene')
      return { file, scene }
    }
  }
  return NOT_HANDLED
}

async function saveProject(id: number | null, b: Record<string, unknown>) {
  const u = mockCore.requireUser()
  const name = String(b.name ?? '').trim() || 'Untitled'
  const scene = b.scene as SceneDoc
  const thumb = typeof b.thumbnailPng === 'string' ? b.thumbnailPng : undefined
  const fail = buildError()
  if (fail) throw fail
  const blob = await build3mf(name, scene, thumb)
  const fileName = name.toLowerCase().endsWith('.3mf') ? name : `${name}.3mf`
  const meta = { project: { plates: scene.plates.length, objects: scene.objects.length } }
  const thumbnailUrl = thumb ? `data:image/png;base64,${thumb}` : undefined
  if (id !== null) {
    const old = mockFiles.get(id)
    if (!old || old.kind !== 'project' || old.ownerId !== u.id) throw new ApiError(404, 'common.not_found', 'Not found')
    // mockFiles has no "replace": drop the old record, store a new one (the client keeps the returned id)
    const list = mockFiles.list()
    list.splice(list.indexOf(old), 1)
    delete scenes[id]
  }
  const file = mockFiles.add({ ownerId: u.id, name: fileName, kind: 'project', blob, meta, thumbnailUrl })
  scenes[file.id] = scene
  saveScenes()
  mockCore.audit('project.create', file.name)
  mockCore.save()
  return file
}
