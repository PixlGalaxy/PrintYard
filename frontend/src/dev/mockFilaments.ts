// Dev-only mock for custom filament presets (`/filament-presets`, `custom:<id>` in the profile bundle).
// Mirrors the backend rules: private = owner only, shared = everyone (admins share), names unique per owner.
import { ApiError } from '../api'
import type { FilamentPreset, FilamentPresetCreate, FilamentPresetPatch, PresetSummary, ResolvedPreset } from '../types'
import { mockCore } from './mock'
import { NOT_HANDLED } from './mockF2'

interface SystemPreset {
  id: string
  name: string
  filamentType?: string
  color?: string
  values: Record<string, string>
}
type Row = Omit<FilamentPreset, 'canEdit' | 'presetId' | 'ownerName'>

const KEY = 'sd:mock:filaments'
const load = (): { next: number; rows: Row[] } => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '') as { next: number; rows: Row[] }
  } catch {
    return { next: 1, rows: [] }
  }
}
const db = load()
const persist = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(db))
  } catch {
    /* private mode */
  }
}

const usernameOf = (id: number) => mockCore.state.users.find((u) => u.id === id)?.username ?? '?'
const view = (r: Row, me: { id: number; role: string }): FilamentPreset => ({
  ...r,
  presetId: `custom:${r.id}`,
  ownerName: usernameOf(r.ownerId),
  // Shared presets: admins only (backend review 3A #7)
  canEdit: me.role === 'admin' || (r.ownerId === me.id && r.scope !== 'shared'),
})
const usable = (r: Row, me: { id: number; role: string }) => r.scope === 'shared' || r.ownerId === me.id || me.role === 'admin'
const BAD_VALUE = /^(nan|infinity)$/i

function validate(values: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(values ?? {})) {
    if (/gcode|post_process|filename/.test(k)) throw new ApiError(400, 'slice.invalid_override', 'Unsupported filament setting', { keys: [k] })
    const clean = String(v).replace(/\p{Cc}+/gu, ' ').trim()
    if (BAD_VALUE.test(clean) || (/temp/.test(k) && Number(clean) > 500)) throw new ApiError(400, 'filament_presets.invalid_value', 'Invalid value', { keys: [k] })
    out[k] = clean
  }
  return out
}

function assertName(name: string, ownerId: number, system: SystemPreset[], exceptId = 0) {
  if (!name.trim() || /[;"\\]/.test(name)) throw new ApiError(400, 'validation.failed', 'Invalid name')
  const n = name.trim().toLowerCase()
  if (system.some((s) => s.name.toLowerCase() === n) || db.rows.some((r) => r.id !== exceptId && r.ownerId === ownerId && r.name.toLowerCase() === n)) {
    throw new ApiError(409, 'filament_presets.name_taken', 'Name taken')
  }
}

/** Bundle entries for the signed-in user (own + shared) */
export function customFilamentSummaries(system: SystemPreset[]): PresetSummary[] {
  const me = mockCore.state.users.find((u) => u.id === mockCore.state.sessionUserId)
  if (!me) return []
  return db.rows
    .filter((r) => r.scope === 'shared' || r.ownerId === me.id)
    .filter((r) => system.some((s) => s.id === r.inherits))
    .map((r) => {
      const base = system.find((s) => s.id === r.inherits)!
      return {
        id: `custom:${r.id}`,
        name: r.name,
        kind: 'filament' as const,
        custom: true,
        ownerId: r.ownerId,
        ownerName: usernameOf(r.ownerId),
        scope: r.scope,
        inherits: r.inherits,
        ...((r.filamentType ?? base.filamentType) && { filamentType: r.filamentType ?? base.filamentType }),
        ...((r.color ?? base.color) && { color: r.color ?? base.color }),
        ...(r.vendor && { vendor: r.vendor }),
      }
    })
}

/** `GET /profiles/:model/preset/filament/custom:<id>` */
export function resolveCustomFilament(id: string, system: SystemPreset[]): ResolvedPreset {
  const me = mockCore.requireUser()
  const r = db.rows.find((x) => `custom:${x.id}` === id)
  const base = r && system.find((s) => s.id === r.inherits)
  if (!r || !base || !usable(r, me)) throw new ApiError(404, 'profiles.preset_not_found', 'Unknown filament preset')
  const values: Record<string, string> = { ...base.values, ...(r.filamentType && { filament_type: r.filamentType }), ...(r.color && { default_filament_colour: r.color }), ...r.values }
  return { id, values, inherits: r.inherits, customKeys: Object.keys(values).filter((k) => values[k] !== base.values[k] || k in r.values).sort() }
}

export function handleFilaments(method: string, p: string, url: URL, b: Record<string, unknown>, system: SystemPreset[]): unknown {
  if (!p.startsWith('/filament-presets')) return NOT_HANDLED
  const me = mockCore.requireUser()
  if (p === '/filament-presets' && method === 'GET') {
    const scope = url.searchParams.get('scope') ?? 'usable'
    if (scope === 'everyone' && me.role !== 'admin') throw new ApiError(403, 'auth.forbidden', 'Forbidden')
    return db.rows
      .filter((r) => (scope === 'mine' ? r.ownerId === me.id : scope === 'shared' ? r.scope === 'shared' : scope === 'everyone' ? true : r.ownerId === me.id || r.scope === 'shared'))
      .sort((a, c) => a.name.localeCompare(c.name))
      .map((r) => view(r, me))
  }
  if (p === '/filament-presets' && method === 'POST') {
    const body = b as unknown as FilamentPresetCreate
    if (body.scope === 'shared' && me.role !== 'admin') throw new ApiError(403, 'filament_presets.share_admin_only', 'Admins only')
    let inherits = body.basePresetId
    let baseValues: Record<string, string> = {}
    const src = db.rows.find((r) => `custom:${r.id}` === body.basePresetId)
    if (body.basePresetId.startsWith('custom:')) {
      if (!src || !usable(src, me)) throw new ApiError(404, 'profiles.preset_not_found', 'Unknown filament preset')
      inherits = src.inherits
      baseValues = src.values
    }
    if (!system.some((s) => s.id === inherits)) throw new ApiError(400, 'filament_presets.invalid_base', 'Choose a system preset')
    assertName(body.name, me.id, system)
    const now = Date.now()
    const row: Row = {
      id: db.next++,
      ownerId: me.id,
      scope: body.scope ?? 'private',
      printerModel: 'creality-k2se',
      name: body.name.trim(),
      inherits,
      vendor: body.vendor ?? src?.vendor ?? null,
      filamentType: body.filamentType ?? src?.filamentType ?? null,
      color: body.color ?? src?.color ?? null,
      values: validate({ ...baseValues, ...body.values }),
      createdAt: now,
      updatedAt: now,
    }
    db.rows.push(row)
    persist()
    mockCore.audit('filament_preset.create', row.name, { id: row.id })
    return view(row, me)
  }
  const m = p.match(/^\/filament-presets\/(\d+)(\/share)?$/)
  if (!m) return NOT_HANDLED
  const row = db.rows.find((r) => r.id === Number(m[1]))
  if (!row || !usable(row, me)) throw new ApiError(404, 'common.not_found', 'Not found')
  const writable = row.ownerId === me.id || me.role === 'admin'
  if (m[2] && method === 'POST') {
    if (me.role !== 'admin') throw new ApiError(403, 'filament_presets.share_admin_only', 'Admins only')
    row.scope = (b.scope as Row['scope']) ?? 'shared'
    row.updatedAt = Date.now()
    persist()
    return view(row, me)
  }
  if (method === 'GET') return view(row, me)
  if (!writable) throw new ApiError(403, 'filament_presets.forbidden', 'Owner or admin only')
  if (me.role !== 'admin' && row.scope === 'shared' && method !== 'POST') {
    throw new ApiError(403, 'filament_presets.shared_read_only', 'Shared: only an admin can change it')
  }
  if (method === 'PATCH') {
    const patch = b as FilamentPresetPatch
    if (patch.name !== undefined) assertName(patch.name, row.ownerId, system, row.id)
    if (patch.inherits !== undefined && !system.some((s) => s.id === patch.inherits)) throw new ApiError(400, 'filament_presets.invalid_base', 'Choose a system preset')
    Object.assign(row, {
      ...(patch.name !== undefined && { name: patch.name.trim() }),
      ...(patch.inherits !== undefined && { inherits: patch.inherits }),
      ...(patch.vendor !== undefined && { vendor: patch.vendor || null }),
      ...(patch.filamentType !== undefined && { filamentType: patch.filamentType || null }),
      ...(patch.color !== undefined && { color: patch.color }),
      ...(patch.values !== undefined && { values: validate(patch.values) }),
      updatedAt: Date.now(),
    })
    persist()
    return view(row, me)
  }
  if (method === 'DELETE') {
    db.rows.splice(db.rows.indexOf(row), 1)
    persist()
    return undefined
  }
  return NOT_HANDLED
}
