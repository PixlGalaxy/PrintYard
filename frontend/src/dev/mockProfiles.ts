// Dev-only mock for the Profiles tab: user process profiles (`/process-profiles`, `custom:<id>` process presets) and
// Creality Print preset import/export (`/profile-files/*`). Mirrors the backend rules in a smaller form: personal
// profiles, owner-or-admin edits and sharing, G-code/unknown keys and out-of-range temperatures dropped on import.
// A first load seeds one process profile that the second mock user (maria) shares.
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { ApiError } from '../api'
import type {
  FilamentPreset,
  OptionDef,
  PresetSummary,
  ProcessProfile,
  ProcessProfileCreate,
  ProcessProfilePatch,
  ProfileExportRequest,
  ProfileImportReport,
  ResolvedPreset,
} from '../types'
import { mockCore } from './mock'
import { handleFilaments } from './mockFilaments'
import { NOT_HANDLED } from './mockF2'

interface SystemPreset {
  id: string
  name: string
  isDefault?: boolean
  filamentType?: string
  color?: string
  values: Record<string, string>
}
interface Data {
  engineVersion: string
  process: SystemPreset[]
  filament: SystemPreset[]
  options: OptionDef[]
  filamentOptions: OptionDef[]
}
type Row = Omit<ProcessProfile, 'canEdit' | 'presetId' | 'ownerName'>

const KEY = 'sd:mock:processProfiles'
const SEED: Row = {
  id: 1,
  ownerId: 2,
  scope: 'shared',
  printerModel: 'creality-k2se',
  name: 'Fast draft (club)',
  inherits: '0.24mm Standard @Creality K2 SE 0.4 nozzle',
  values: { sparse_infill_density: '10%', wall_loops: '2', outer_wall_speed: '250' },
  createdAt: Date.now() - 2 * 86_400_000,
  updatedAt: Date.now() - 2 * 86_400_000,
}
const db: { next: number; rows: Row[] } = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '') as { next: number; rows: Row[] }
  } catch {
    return { next: 2, rows: [SEED] }
  }
})()
const persist = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(db))
  } catch {
    /* private mode */
  }
}

const usernameOf = (id: number) => mockCore.state.users.find((u) => u.id === id)?.username ?? '?'
type Me = { id: number; role: string }
const view = (r: Row, me: Me): ProcessProfile => ({ ...r, presetId: `custom:${r.id}`, ownerName: usernameOf(r.ownerId), canEdit: me.role === 'admin' || r.ownerId === me.id })
const usable = (r: Row, me: Me) => r.scope === 'shared' || r.ownerId === me.id || me.role === 'admin'
const UNSAFE = /gcode|post_process|filename|thumbnail|printhost|print_host|upload/

function validate(values: Record<string, string> | undefined, defs: Map<string, OptionDef>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(values ?? {})) {
    if (UNSAFE.test(k) || !defs.has(k)) throw new ApiError(400, 'slice.invalid_override', 'Unsupported process setting', { keys: [k] })
    const clean = String(v).replace(/\p{Cc}+/gu, ' ').trim()
    if (/^(nan|infinity)$/i.test(clean)) throw new ApiError(400, 'filament_presets.invalid_value', 'Invalid value', { keys: [k] })
    out[k] = clean
  }
  return out
}

function assertName(name: string, ownerId: number, system: SystemPreset[], exceptId = 0) {
  if (!name.trim() || /[;"\\/]/.test(name)) throw new ApiError(400, 'validation.failed', 'Invalid name')
  if (!nameFree(name, ownerId, system, exceptId)) throw new ApiError(409, 'profiles.name_taken', 'Name taken')
}
const nameFree = (name: string, ownerId: number, system: SystemPreset[], exceptId = 0) => {
  const n = name.trim().toLowerCase()
  return !system.some((s) => s.name.toLowerCase() === n) && !db.rows.some((r) => r.id !== exceptId && r.ownerId === ownerId && r.name.toLowerCase() === n)
}

/** Bundle entries for the signed-in user (own + shared) */
export function customProcessSummaries(system: SystemPreset[]): PresetSummary[] {
  const me = mockCore.state.users.find((u) => u.id === mockCore.state.sessionUserId)
  if (!me) return []
  return db.rows
    .filter((r) => (r.scope === 'shared' || r.ownerId === me.id) && system.some((s) => s.id === r.inherits))
    .map((r) => ({ id: `custom:${r.id}`, name: r.name, kind: 'process' as const, custom: true, ownerId: r.ownerId, ownerName: usernameOf(r.ownerId), scope: r.scope, inherits: r.inherits }))
}

/** `GET /profiles/:model/preset/process/custom:<id>` */
export function resolveCustomProcess(id: string, system: SystemPreset[]): ResolvedPreset {
  const me = mockCore.requireUser()
  const r = db.rows.find((x) => `custom:${x.id}` === id)
  const base = r && system.find((s) => s.id === r.inherits)
  if (!r || !base || !usable(r, me)) throw new ApiError(404, 'profiles.preset_not_found', 'This process profile was deleted or is no longer shared with you')
  return { id, values: { ...base.values, ...r.values }, inherits: r.inherits, customKeys: Object.keys(r.values).sort() }
}

function createRow(me: Me, body: ProcessProfileCreate, data: Data): ProcessProfile {
  let inherits = body.basePresetId
  let baseValues: Record<string, string> = {}
  if (body.basePresetId.startsWith('custom:')) {
    const src = db.rows.find((r) => `custom:${r.id}` === body.basePresetId)
    if (!src || !usable(src, me)) throw new ApiError(404, 'profiles.preset_not_found', 'Unknown process profile')
    inherits = src.inherits
    baseValues = src.values
  }
  if (!data.process.some((s) => s.id === inherits)) throw new ApiError(400, 'profiles.invalid_base', 'Choose a system preset')
  assertName(body.name, me.id, data.process)
  const now = Date.now()
  const row: Row = {
    id: db.next++,
    ownerId: me.id,
    scope: body.scope ?? 'private',
    printerModel: 'creality-k2se',
    name: body.name.trim(),
    inherits,
    values: validate({ ...baseValues, ...body.values }, new Map(data.options.map((o) => [o.key, o]))),
    createdAt: now,
    updatedAt: now,
  }
  db.rows.push(row)
  persist()
  mockCore.audit('process_profile.create', row.name, { id: row.id })
  return view(row, me)
}

// ---------- import / export (Creality Print preset files) ----------

const presetFamily = (n: string) => (n.includes('@') ? n.slice(0, n.lastIndexOf('@')).trim() : n.trim())
const scalar = (v: unknown, filament: boolean): string | undefined => {
  if (Array.isArray(v)) return v.length && v.every((x) => typeof x === 'string' || typeof x === 'number') ? (filament ? String(v[0]) : v.join(',')) : undefined
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return typeof v === 'boolean' ? (v ? '1' : '0') : String(v)
  return undefined
}
const META = new Set(['name', 'inherits', 'from', 'version', 'type', 'instantiation', 'setting_id', 'filament_id', 'base_id', 'is_custom_defined', 'compatible_printers', 'compatible_printers_condition', 'compatible_prints', 'compatible_prints_condition', 'print_settings_id', 'filament_settings_id', 'printer_settings_id', 'updated_time', 'user_id', 'description', 'renamed_from'])
const TEMP_MAX = 300

function importPreset(me: Me & { username: string }, entry: string, obj: Record<string, unknown>, hint: string | undefined, data: Data, report: ProfileImportReport) {
  const inherits = typeof obj.inherits === 'string' ? obj.inherits : ''
  const kind =
    hint ??
    (entry.startsWith('process/') || 'print_settings_id' in obj || obj.type === 'process' || data.process.some((s) => s.id === inherits)
      ? 'process'
      : entry.startsWith('filament/') || 'filament_settings_id' in obj || obj.type === 'filament' || data.filament.some((s) => s.id === inherits)
        ? 'filament'
        : entry.startsWith('printer/') || 'printer_settings_id' in obj
          ? 'printer'
          : null)
  if (kind === 'printer') return void report.skipped.push({ entry, reason: 'printer_preset' })
  if (kind !== 'process' && kind !== 'filament') return void report.skipped.push({ entry, reason: 'unknown_kind' })
  const system = data[kind]
  const rawName = (typeof obj.name === 'string' && obj.name.trim()) || entry.split('/').pop()!.replace(/\.json$/i, '')
  const name0 = rawName.replace(/\p{Cc}+/gu, ' ').replace(/[;"\\/<>:|?*]/g, '_').trim().slice(0, 100) || 'Imported profile'
  const parent =
    system.find((s) => s.id === inherits)?.id ??
    system.find((s) => inherits && presetFamily(s.id).toLowerCase() === presetFamily(inherits).toLowerCase())?.id ??
    (kind === 'filament' ? system.find((s) => s.filamentType === scalar(obj.filament_type, true) && s.id.startsWith('Generic '))?.id : undefined) ??
    (system.find((s) => s.isDefault) ?? system[0]).id
  if (parent !== inherits) report.remapped.push({ profile: name0, from: inherits, to: parent })
  const parentVals = system.find((s) => s.id === parent)!.values
  const defs = new Set((kind === 'process' ? data.options : data.filamentOptions).map((o) => o.key))
  const values: Record<string, string> = {}
  let filamentType: string | null = null
  let color: string | null = null
  for (const [k, raw] of Object.entries(obj)) {
    if (META.has(k)) continue
    const v = scalar(raw, kind === 'filament')
    if (v === undefined) {
      report.dropped.push({ profile: name0, key: k, reason: 'invalid_value' })
      continue
    }
    if (kind === 'filament' && k === 'filament_type') {
      filamentType = v
      continue
    }
    if (kind === 'filament' && k === 'default_filament_colour') {
      if (/^#[0-9a-f]{6}$/i.test(v)) color = v.toUpperCase()
      continue
    }
    if (UNSAFE.test(k)) {
      report.dropped.push({ profile: name0, key: k, reason: 'unsafe' })
      continue
    }
    if (parentVals[k] !== undefined && String(parentVals[k]) === v) continue
    if (!defs.has(k)) {
      report.dropped.push({ profile: name0, key: k, reason: 'unsupported' })
      continue
    }
    const clean = v.replace(/\p{Cc}+/gu, ' ').trim()
    if (/temp/.test(k) && !/^-?\d+(\.\d+)?$/.test(clean)) {
      report.dropped.push({ profile: name0, key: k, reason: 'number' })
      continue
    }
    if (/temp/.test(k) && Number(clean) > TEMP_MAX) {
      report.dropped.push({ profile: name0, key: k, reason: `range 0..${TEMP_MAX}` })
      continue
    }
    values[k] = clean
  }
  let name = name0
  const free = (n: string) =>
    kind === 'process'
      ? nameFree(n, me.id, data.process)
      : !system.some((s) => s.name.toLowerCase() === n.toLowerCase()) &&
        !(handleFilaments('GET', '/filament-presets', new URL('http://x/?scope=mine'), {}, data.filament) as FilamentPreset[]).some((p) => p.name.toLowerCase() === n.toLowerCase())
  for (let i = 2; !free(name) && i < 100; i++) name = `${name0} (${i})`
  if (name !== name0) report.renamed.push({ from: name0, to: name })
  try {
    const created =
      kind === 'process'
        ? createRow(me, { basePresetId: parent, name, values }, data)
        : (handleFilaments('POST', '/filament-presets', new URL('http://x/'), { basePresetId: parent, name, values, filamentType, color }, data.filament) as FilamentPreset)
    report.created.push({ kind, id: created.id, presetId: created.presetId, name: created.name, inherits: created.inherits, keys: Object.keys(created.values).length })
  } catch (err) {
    report.skipped.push({ entry, reason: err instanceof ApiError ? err.code : 'invalid_value' })
  }
}

function importFile(me: Me & { username: string }, fileName: string, b64: string, data: Data): ProfileImportReport {
  const m = /\.(json|zip|creality_filament|creality_printer)$/i.exec(fileName)
  if (!m) throw new ApiError(400, 'profile_files.unsupported_type', 'Unsupported file type')
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  if (bytes.length > 5 * 1024 * 1024) throw new ApiError(413, 'profile_files.too_large', 'Too large')
  const report: ProfileImportReport = { created: [], skipped: [], dropped: [], remapped: [], renamed: [] }
  const parse = (entry: string, text: string): Record<string, unknown> | null => {
    try {
      const o = JSON.parse(text) as unknown
      if (o && typeof o === 'object' && !Array.isArray(o)) return o as Record<string, unknown>
      report.skipped.push({ entry, reason: 'not_a_preset' })
    } catch {
      report.skipped.push({ entry, reason: 'invalid_json' })
    }
    return null
  }
  if (m[1].toLowerCase() === 'json') {
    const obj = parse(fileName, strFromU8(bytes))
    if (!obj) throw new ApiError(400, report.skipped[0]?.reason === 'invalid_json' ? 'profile_files.invalid_json' : 'profile_files.not_a_preset', 'Not a preset')
    importPreset(me, fileName, obj, undefined, data, report)
    return report
  }
  let files: Record<string, Uint8Array>
  try {
    let count = 0
    files = unzipSync(bytes, {
      filter: (f) => {
        if (++count > 200) throw new ApiError(413, 'profile_files.too_many_entries', 'Too many entries')
        const safe = !/(^|\/)\.\.(\/|$)|^\/|\\|^[A-Za-z]:/.test(f.name)
        if (!safe) report.skipped.push({ entry: f.name, reason: 'unsafe_path' })
        else if (!/\.json$/i.test(f.name) && !f.name.endsWith('/')) report.skipped.push({ entry: f.name, reason: 'not_json' })
        return safe && /\.json$/i.test(f.name) && f.originalSize <= 1024 * 1024
      },
    })
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError(400, 'profile_files.invalid_archive', 'Cannot read the archive')
  }
  const hints = new Map<string, string>()
  const structure = files['bundle_structure.json'] ? parse('bundle_structure.json', strFromU8(files['bundle_structure.json'])) : null
  for (const [list, kind] of [['printer_config', 'printer'], ['filament_config', 'filament'], ['process_config', 'process']] as const) {
    for (const p of (structure?.[list] as string[] | undefined) ?? []) hints.set(p, kind)
  }
  for (const [entry, content] of Object.entries(files)) {
    if (entry === 'bundle_structure.json') continue
    const obj = parse(entry, strFromU8(content))
    if (obj) importPreset(me, entry, obj, hints.get(entry) ?? (/\.creality_filament$/i.test(fileName) ? 'filament' : undefined), data, report)
  }
  return report
}

function exportFiles(me: Me, req: ProfileExportRequest, data: Data) {
  const version = `${data.engineVersion.split('.').concat(['0', '0', '0', '0']).slice(0, 4).join('.')}`
  const filament = req.kind === 'filament'
  const presets = req.ids.map((id) => {
    if (!filament) {
      const r = db.rows.find((x) => x.id === id)
      if (!r || !usable(r, me)) throw new ApiError(404, 'common.not_found', 'Not found')
      return { name: r.name, inherits: r.inherits, values: r.values as Record<string, string> }
    }
    const f = handleFilaments('GET', `/filament-presets/${id}`, new URL('http://x/'), {}, data.filament) as FilamentPreset
    return { name: f.name, inherits: f.inherits, values: { ...f.values, ...(f.filamentType && { filament_type: f.filamentType }), ...(f.color && { default_filament_colour: f.color }) } }
  })
  const folder = req.format === 'creality_filament' ? 'Creality/' : ''
  const files: Zippable = {}
  for (const p of presets) {
    const json: Record<string, unknown> = { from: 'User', inherits: p.inherits, is_custom_defined: '0', name: p.name, version }
    for (const [k, v] of Object.entries(p.values)) json[k] = filament ? [v] : v
    if (filament) json.filament_settings_id = [p.name]
    else json.print_settings_id = p.name
    const sorted = Object.fromEntries(Object.keys(json).sort().map((k) => [k, json[k]]))
    files[`${folder}${p.name.replace(/[\\/:*?"<>|]/g, '_')}.json`] = strToU8(`${JSON.stringify(sorted, null, 4)}\n`)
  }
  if (req.format === 'creality_filament') {
    files['bundle_structure.json'] = strToU8(
      JSON.stringify({ version: '', bundle_id: `offline_${presetFamily(presets[0].inherits)}_${Math.floor(Date.now() / 1000)}`, bundle_type: 'filament config bundle', filament_name: presetFamily(presets[0].inherits), printer_vendor: [{ vendor: 'Creality', filament_path: Object.keys(files) }] }),
    )
  }
  const zip = zipSync(files, { level: 6 })
  let bin = ''
  for (const byte of zip) bin += String.fromCharCode(byte)
  const fileName = req.format === 'creality_filament' ? (presets.length === 1 ? `${presets[0].name}.creality_filament` : 'Filament presets.creality_filament') : filament ? 'Filament presets.zip' : 'Process presets.zip'
  mockCore.audit('profile.export', fileName, { kind: req.kind, count: presets.length })
  return { fileName, contentType: 'application/zip', data: btoa(bin) }
}

// ---------- router ----------

export function handleProfiles(method: string, p: string, url: URL, b: Record<string, unknown>, data: Data): unknown {
  if (p === '/profile-files/import' && method === 'POST') {
    const me = mockCore.requireUser()
    const report = importFile(me, String(b.fileName ?? ''), String(b.data ?? ''), data)
    mockCore.audit('profile.import', String(b.fileName ?? ''), { created: report.created.length })
    return report
  }
  if (p === '/profile-files/export' && method === 'POST') {
    const req = b as unknown as ProfileExportRequest
    if (req.kind === 'process' && req.format === 'creality_filament') throw new ApiError(400, 'profile_files.invalid_format', 'Process profiles export as .zip')
    return exportFiles(mockCore.requireUser(), { ...req, format: req.format ?? 'zip' }, data)
  }
  if (!p.startsWith('/process-profiles')) return NOT_HANDLED
  const me = mockCore.requireUser()
  if (p === '/process-profiles' && method === 'GET') {
    const scope = url.searchParams.get('scope') ?? 'usable'
    if (scope === 'everyone' && me.role !== 'admin') throw new ApiError(403, 'auth.forbidden', 'Forbidden')
    return db.rows
      .filter((r) => (scope === 'mine' ? r.ownerId === me.id : scope === 'shared' ? r.scope === 'shared' : scope === 'everyone' ? true : r.ownerId === me.id || r.scope === 'shared'))
      .sort((a, c) => a.name.localeCompare(c.name))
      .map((r) => view(r, me))
  }
  if (p === '/process-profiles' && method === 'POST') return createRow(me, b as unknown as ProcessProfileCreate, data)
  const m = p.match(/^\/process-profiles\/(\d+)(\/share)?$/)
  if (!m) return NOT_HANDLED
  const row = db.rows.find((r) => r.id === Number(m[1]))
  if (!row || !usable(row, me)) throw new ApiError(404, 'common.not_found', 'Not found')
  if (method === 'GET') return view(row, me)
  if (row.ownerId !== me.id && me.role !== 'admin') throw new ApiError(403, 'profiles.forbidden', 'Owner or admin only')
  if (m[2] && method === 'POST') {
    row.scope = (b.scope as Row['scope']) ?? 'shared'
    if (row.scope === 'private') for (const u of mockCore.state.users) if (u.id !== row.ownerId && u.role !== 'admin' && u.defaultProcessPreset === `custom:${row.id}`) u.defaultProcessPreset = null
    row.updatedAt = Date.now()
    persist()
    mockCore.save()
    return view(row, me)
  }
  if (method === 'PATCH') {
    const patch = b as ProcessProfilePatch
    if (patch.name !== undefined) assertName(patch.name, row.ownerId, data.process, row.id)
    if (patch.inherits !== undefined && !data.process.some((s) => s.id === patch.inherits)) throw new ApiError(400, 'profiles.invalid_base', 'Choose a system preset')
    Object.assign(row, {
      ...(patch.name !== undefined && { name: patch.name.trim() }),
      ...(patch.inherits !== undefined && { inherits: patch.inherits }),
      ...(patch.values !== undefined && { values: validate(patch.values, new Map(data.options.map((o) => [o.key, o]))) }),
      updatedAt: Date.now(),
    })
    persist()
    return view(row, me)
  }
  if (method === 'DELETE') {
    for (const u of mockCore.state.users) if (u.defaultProcessPreset === `custom:${row.id}`) u.defaultProcessPreset = null
    db.rows.splice(db.rows.indexOf(row), 1)
    persist()
    mockCore.save()
    return undefined
  }
  return NOT_HANDLED
}
