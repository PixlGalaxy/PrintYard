// Dev-only fake backend for `npm run dev:mock` (VITE_MOCK=1). It is loaded through a dynamic import
// guarded by `import.meta.env.DEV && VITE_MOCK`, so production builds never contain it.
// State lives in localStorage (`sd:mock`) so actions survive reloads; the dev toolbar switches scenarios
// (or add `?mock-scenario=<fresh|blocked|lowMemory|loggedOut|admin|user>` to any URL).
import { ApiError, type BinarySender, type Transport } from '../api'
import { handleF1 } from './mockF1'
import { handleNotify, resetNotify } from './mockNotify'
import { handlePrinterPresets } from './mockPrinterPresets'
import { engineInstalledVersion, handleF2, mockFiles, mockPublish, NOT_HANDLED, resetF2 } from './mockF2'
import { BED_SURFACES, DEFAULT_BED_SURFACE, NAV3D_PRESETS, PREPARE_LEVELS, type BedSurface, type Nav3dPrefs, type PrepareLevel } from '../types'
import type {
  AdminUser,
  AuditEntry,
  Language,
  LogLevel,
  LogLine,
  Printer,
  ProbeResult,
  Role,
  Settings,
  Skin,
  Theme,
  ThemeMode,
  User,
  UserLimits,
} from '../types'

export const MOCK_PASSWORD = 'slicedock123'

export interface MockFlags {
  /** false = the browser looks like it comes through a proxy / public host */
  lanAllowed: boolean
  /** Container memory limit at 1 GiB (warning banners) */
  lowMemory: boolean
  /** Test connection answers "unreachable" */
  probeFails: boolean
  /** Every write (POST/PATCH/PUT/DELETE except auth) fails with a 500 */
  writeFails: boolean
  /** Simulated latency in ms */
  latency: number
  /** F2: the printer does not answer (status offline, prints refused) */
  printerOffline: boolean
  /** F2: requests arrive with proxy headers while exposure mode is 'none' */
  proxyHeaders: boolean
  /** F2: server in read-only mode (printer writes refused with 423) */
  readOnly: boolean
  /** Upload progress demo: slow browser → SliceDock uploads (~400 KB/s) and SliceDock → printer sends (~1 MB/s) */
  slowUploads?: boolean
}

type MockUser = AdminUser & { password: string }

interface MockSession {
  id: string
  userId: number
  createdAt: number
  lastSeenAt: number
  expiresAt: number
  ip: string
  userAgent: string
  current: boolean
}

interface State {
  setupComplete: boolean
  sessionUserId: number | null
  users: MockUser[]
  printers: Printer[]
  settings: Settings
  audit: AuditEntry[]
  sessions: MockSession[]
  nextId: number
  flags: MockFlags
}

export type Scenario = 'fresh' | 'blocked' | 'lowMemory' | 'loggedOut' | 'admin' | 'user'

const KEY = 'sd:mock'
const HOUR = 3_600_000
const DAY = 24 * HOUR
const GiB = 1024 ** 3
const now = () => Date.now()

const DEFAULT_SETTINGS: Settings = {
  'app.defaultLanguage': 'en',
  'appearance.defaultMode': 'system',
  'appearance.defaultSkin': 'sky',
  'workspace.defaultLevel': 'basic',
  'admin.email': null,
  'exposure.mode': 'none',
  'exposure.trustedProxies': [],
  'exposure.publicUrl': null,
  'security.sessionHours': 168,
  'security.idleMinutes': 0,
  'engine.selected': 'creality',
  'engine.autoUpdate': true,
  'engine.checkIntervalHours': 24,
  'limits.costPerKg': null,
  'limits.currency': 'USD',
  'files.retention.enabled': true,
  'files.retention.keep': 10,
  'printers.retention.enabled': true,
  'printers.retention.keep': 10,
  'printers.idleHeaterOffMinutes': 15,
  'printers.profilesBackup.enabled': true,
  'files.maxUploadMb': 200,
}

const DEFAULT_FLAGS: MockFlags = { lanAllowed: true, lowMemory: false, probeFails: false, writeFails: false, latency: 300, printerOffline: false, proxyHeaders: false, readOnly: false, slowUploads: false }
const NO_LIMITS: UserLimits = { enabled: false, maxGramsPerPrint: null, maxGramsPerMonth: null, maxHoursPerPrint: null, requiresApproval: false }

const K2SE: Printer = {
  id: 1,
  name: 'K2 SE',
  model: 'creality-k2se',
  kinematics: 'corexy',
  host: '192.168.8.230',
  staticIp: true,
  mac: 'fc:ee:28:13:e2:ed',
  serial: null,
  firmware: null,
  camera: { type: 'none' },
  lastSeenAt: null,
  bedSurfaces: ['Epoxy Resin Plate', 'Textured PEI Plate'],
  defaultBedSurface: 'Epoxy Resin Plate',
}

function freshState(flags: MockFlags = DEFAULT_FLAGS): State {
  return {
    setupComplete: false,
    sessionUserId: null,
    users: [],
    printers: [],
    settings: { ...DEFAULT_SETTINGS },
    audit: [],
    sessions: [],
    nextId: 1,
    flags: { ...flags },
  }
}

/** A configured install: three users (one with limits, one disabled), the K2 SE, some audit history. */
function seededState(flags: MockFlags): State {
  const t = now()
  const user = (id: number, username: string, role: Role, extra: Partial<MockUser> = {}): MockUser => ({
    id,
    username,
    email: null,
    role,
    isActive: true,
    language: 'en',
    theme: 'system',
    themeMode: null,
    skin: null,
    avatarUrl: null,
    createdAt: t - 30 * DAY,
    lastLoginAt: t - 2 * HOUR,
    limits: NO_LIMITS,
    canPrintUploadedGcode: false,
    password: MOCK_PASSWORD,
    ...extra,
  })
  const users = [
    user(1, 'admin', 'admin', { email: 'admin@example.com', createdAt: t - 45 * DAY }),
    user(2, 'maria', 'user', {
      email: 'maria@example.com',
      language: 'en',
      avatarUrl: seedAvatar('M', '#f472b6', '#7c3aed'),
      lastLoginAt: t - 26 * HOUR,
      limits: { enabled: true, maxGramsPerPrint: 250, maxGramsPerMonth: 2000, maxHoursPerPrint: 12, requiresApproval: true },
    }),
    user(3, 'jorge', 'user', { isActive: false, lastLoginAt: t - 12 * DAY, createdAt: t - 20 * DAY }),
  ]
  const entries: [string, number | null, string | null, unknown, number][] = [
    ['setup.complete', 1, null, null, 45 * DAY],
    ['user.create', 1, 'maria', { role: 'user' }, 30 * DAY],
    ['user.create', 1, 'jorge', { role: 'user' }, 20 * DAY],
    ['user.limits', 1, 'maria', { enabled: true, maxGramsPerPrint: 250 }, 19 * DAY],
    ['user.update', 1, 'jorge', { isActive: false }, 5 * DAY],
    ['auth.login_failed', null, 'maria', null, 27 * HOUR],
    ['auth.login', 2, null, null, 26 * HOUR],
    ['settings.update', 1, null, ['limits.costPerKg', 'limits.currency'], 8 * HOUR],
    ['auth.login', 1, null, null, 2 * HOUR],
  ]
  const audit: AuditEntry[] = entries
    .map(([action, userId, target, meta, ago], i) => ({
      id: i + 1,
      userId,
      username: userId ? users.find((u) => u.id === userId)!.username : target,
      action,
      target: action.startsWith('auth.') ? null : target,
      meta,
      ip: action === 'auth.login_failed' ? '203.0.113.42' : '192.168.8.20',
      createdAt: t - ago,
    }))
    .reverse()
  return {
    setupComplete: true,
    sessionUserId: null,
    users,
    printers: [{ ...K2SE, lastSeenAt: t - 3 * 60_000 }],
    settings: { ...DEFAULT_SETTINGS, 'admin.email': 'admin@example.com', 'limits.costPerKg': 22.5 },
    audit,
    sessions: [],
    nextId: 10,
    flags: { ...flags },
  }
}

function load(): State {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const s = JSON.parse(raw) as State
      return { ...s, flags: { ...DEFAULT_FLAGS, ...s.flags } }
    }
  } catch {
    // ignore
  }
  return freshState()
}

let state = load()
const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    // ignore
  }
}

/** Internals shared with the Phase 2 mock modules (mockF2.ts, F1's mocks). */
export const mockCore = {
  get state() {
    return state
  },
  save: () => save(),
  requireUser: () => requireUser(),
  requireAdmin: () => requireAdmin(),
  audit: (action: string, target: string | null = null, meta: unknown = null) => audit(action, target, meta),
}

// ---------- Controls used by the dev toolbar ----------

export const mockControls = {
  get flags(): MockFlags {
    return state.flags
  },
  get summary() {
    const me = state.users.find((u) => u.id === state.sessionUserId)
    return { setupComplete: state.setupComplete, user: me ? `${me.username} (${me.role})` : null }
  },
  setFlag<K extends keyof MockFlags>(key: K, value: MockFlags[K]) {
    state.flags = { ...state.flags, [key]: value }
    save()
  },
  scenario(s: Scenario) {
    const flags = { ...state.flags, lanAllowed: s !== 'blocked', lowMemory: s === 'lowMemory' }
    if (s === 'fresh' || s === 'blocked' || s === 'lowMemory') state = freshState(flags)
    else {
      state = seededState(flags)
      if (s === 'admin' || s === 'user') login(s === 'admin' ? 1 : 2)
    }
    save()
    resetF2()
    resetNotify()
  },
  reset() {
    state = freshState()
    save()
    resetF2()
    resetNotify()
  },
}

// `?mock-scenario=admin` (any Scenario) applies a scenario on load — handy for screenshots and links
{
  const requested = new URLSearchParams(location.search).get('mock-scenario') as Scenario | null
  const valid: Scenario[] = ['fresh', 'blocked', 'lowMemory', 'loggedOut', 'admin', 'user']
  if (requested && valid.includes(requested)) mockControls.scenario(requested)
}

// ---------- Helpers ----------

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const startedAt = now() - 5 * HOUR

const publicUser = ({ password: _p, limits: _l, canPrintUploadedGcode: _c, ...u }: MockUser): User => ({
  ...u,
  canControlPrinter: u.role === 'admin' || !!u.canControlPrinter,
})
/** The signed-in user's own view: adds the resolved appearance (user → admin default), like the backend. */
const selfUser = (u: MockUser): User => ({
  ...publicUser(u),
  effectiveThemeMode: u.themeMode ?? state.settings['appearance.defaultMode'],
  effectiveSkin: u.skin ?? state.settings['appearance.defaultSkin'],
})
const adminUser = ({ password: _p, ...u }: MockUser): AdminUser => ({ ...u, canControlPrinter: u.role === 'admin' || !!u.canControlPrinter })

function audit(action: string, target: string | null = null, meta: unknown = null) {
  const me = state.users.find((u) => u.id === state.sessionUserId)
  const id = (state.audit[0]?.id ?? 0) + 1
  state.audit.unshift({ id, userId: me?.id ?? null, username: me?.username ?? null, action, target, meta, ip: '192.168.8.20', createdAt: now() })
}

function login(userId: number) {
  const t = now()
  state.sessionUserId = userId
  state.sessions = state.sessions.map((s) => ({ ...s, current: false }))
  state.sessions.push({
    id: Math.random().toString(16).slice(2, 14),
    userId,
    createdAt: t,
    lastSeenAt: t,
    expiresAt: t + state.settings['security.sessionHours'] * HOUR,
    ip: '192.168.8.20',
    userAgent: navigator.userAgent,
    current: true,
  })
  const u = state.users.find((x) => x.id === userId)
  if (u) u.lastLoginAt = t
}

function requireUser() {
  const u = state.users.find((x) => x.id === state.sessionUserId && x.isActive)
  if (!u) throw new ApiError(401, 'auth.unauthorized', 'Unauthorized')
  return u
}
function requireAdmin() {
  const u = requireUser()
  if (u.role !== 'admin') throw new ApiError(403, 'auth.forbidden', 'Forbidden')
  return u
}
const activeAdmins = () => state.users.filter((u) => u.role === 'admin' && u.isActive)

function probe(body: { host?: string; mac?: string; staticIp?: boolean }): ProbeResult {
  if (state.flags.probeFails || !body.host) {
    if (body.staticIp === false && body.mac) return { ok: false, error: 'printers.not_found' }
    return { ok: false, error: 'printers.unreachable' }
  }
  const resolvedHost = body.host === K2SE.host ? undefined : K2SE.host
  if (resolvedHost && body.staticIp !== false) return { ok: false, error: 'printers.unreachable' }
  return { ok: true, model: 'Creality K2 SE (F016)', mac: K2SE.mac!, hostname: 'K2SE-E2ED', creality: true, moonraker: true, resolvedHost }
}

const LOG_MESSAGES: [LogLevel, string, string][] = [
  ['info', 'app', 'SliceDock listening on http://0.0.0.0:3000'],
  ['info', 'db', 'Migrations up to date (1 applied)'],
  ['debug', 'http', 'GET /api/config 200 2ms'],
  ['info', 'auth', 'Login ok for admin from 192.168.8.20'],
  ['warn', 'auth', 'Login failed for maria from 203.0.113.42'],
  ['debug', 'http', 'GET /api/printers 200 4ms'],
  ['info', 'printer', 'Probe 192.168.8.230: Creality K2 SE (F016), mac fc:ee:28:13:e2:ed'],
  ['warn', 'system', 'Container memory limit is 1.0 GB; 2 GB recommended for slicing'],
  ['error', 'printer', 'Probe 192.168.8.231 failed: connect ETIMEDOUT 192.168.8.231:7125'],
  ['info', 'audit', 'settings.update by admin: limits.costPerKg, limits.currency'],
]
const logLines = (): LogLine[] =>
  Array.from({ length: 60 }, (_, i) => {
    const [level, channel, msg] = LOG_MESSAGES[i % LOG_MESSAGES.length]
    return { ts: startedAt + i * 4 * 60_000, level, channel, msg }
  })

// ---------- Router ----------

export const mockTransport: Transport = async (method, path, body) => {
  await delay(state.flags.latency)
  const b = (body ?? {}) as Record<string, unknown>
  const url = new URL(path, 'http://mock')
  const p = url.pathname
  const idMatch = p.match(/\/(\d+)(?:\/|$)/)
  const id = idMatch ? Number(idMatch[1]) : Number.NaN
  const flags = state.flags

  try {
    if (flags.writeFails && method !== 'GET' && !p.startsWith('/auth/') && !p.endsWith('/test') && !p.endsWith('/test-printer')) {
      throw new ApiError(500, 'common.internal', 'Simulated server error')
    }

    // ---------- public ----------
    if (p === '/health') return { ok: true, version: '0.1.0-mock' }
    if (p === '/config') {
      return { appName: 'SliceDock', version: '0.1.0-mock', setupComplete: state.setupComplete, languages: ['en', 'es'], defaultLanguage: state.settings['app.defaultLanguage'], appearance: { defaultMode: state.settings['appearance.defaultMode'], defaultSkin: state.settings['appearance.defaultSkin'] }, workspace: { defaultLevel: state.settings['workspace.defaultLevel'] ?? 'basic' }, readOnly: flags.readOnly, files: { retentionEnabled: state.settings['files.retention.enabled'], retentionKeep: state.settings['files.retention.keep'], maxUploadMb: state.settings['files.maxUploadMb'] }, printing: { calibrateByDefault: (state.settings as unknown as Record<string, unknown>)['printing.calibrateByDefault'] === true } }
    }
    if (p === '/setup/status') {
      const admin = state.users.some((u) => u.id === state.sessionUserId && u.role === 'admin')
      if (state.setupComplete && !admin) return { setupComplete: true }
      return {
        setupComplete: state.setupComplete,
        lanAllowed: flags.lanAllowed,
        memoryLimitBytes: flags.lowMemory ? GiB : 4 * GiB,
        memoryOk: !flags.lowMemory,
        hostNetworkLikely: false,
      }
    }
    if (p === '/printer-models') return [{ id: 'creality-k2se', name: 'Creality K2 SE', vendor: 'Creality', bed: { x: 220, y: 215, z: 245 }, kinematics: 'corexy' }]

    // ---------- setup ----------
    if (p.startsWith('/setup/')) {
      if (!flags.lanAllowed) throw new ApiError(403, 'setup.not_lan', 'Setup is LAN-only')
      if (state.setupComplete) throw new ApiError(409, 'setup.already_complete', 'Already complete')
      if (p === '/setup/test-printer') return probe(b)
      if (p === '/setup/complete') {
        const admin = b.admin as { username: string; email: string; password: string }
        const printer = b.printer as Omit<Printer, 'id'> | null
        const exposure = b.exposure as { mode: Settings['exposure.mode']; publicUrl: string | null }
        const engine = b.engine as { selected: Settings['engine.selected']; autoUpdate: boolean }
        const level = (b.workspace as { defaultLevel?: PrepareLevel } | undefined)?.defaultLevel ?? 'basic'
        if (!PREPARE_LEVELS.includes(level)) throw new ApiError(400, 'validation.failed', 'Invalid workspace.defaultLevel')
        const u: MockUser = {
          id: state.nextId++,
          username: admin.username,
          email: admin.email || null,
          role: 'admin',
          isActive: true,
          language: b.language as Language,
          theme: 'system',
    themeMode: null,
    skin: null,
          avatarUrl: null,
          createdAt: now(),
          lastLoginAt: now(),
          password: admin.password,
          limits: NO_LIMITS,
          canPrintUploadedGcode: false,
        }
        state.users.push(u)
        if (printer) {
          state.printers.push({ ...printer, id: state.nextId++, serial: null, firmware: null, camera: { type: 'none' }, lastSeenAt: null })
        }
        Object.assign(state.settings, {
          'exposure.mode': exposure.mode,
          'exposure.publicUrl': exposure.publicUrl,
          'engine.selected': engine.selected,
          'engine.autoUpdate': engine.autoUpdate,
          'workspace.defaultLevel': level,
          'admin.email': admin.email || null,
          'app.defaultLanguage': b.language,
        })
        state.setupComplete = true
        login(u.id)
        audit('setup.complete')
        return { user: selfUser(u) }
      }
    }

    // ---------- auth ----------
    if (p === '/auth/login') {
      const u = state.users.find((x) => x.username.toLowerCase() === String(b.username).toLowerCase())
      if (!u || u.password !== b.password) {
        audit('auth.login_failed', String(b.username))
        throw new ApiError(401, 'auth.invalid_credentials', 'Invalid credentials')
      }
      if (!u.isActive) throw new ApiError(403, 'auth.account_disabled', 'Account disabled')
      login(u.id)
      audit('auth.login')
      return { user: selfUser(u) }
    }
    if (p === '/auth/logout') {
      if (state.sessionUserId) audit('auth.logout')
      state.sessions = state.sessions.filter((s) => !s.current)
      state.sessionUserId = null
      return undefined
    }
    if (p === '/auth/me') return { user: selfUser(requireUser()) }

    // ---------- account ----------
    if (p === '/account' && method === 'PATCH') {
      const u = requireUser()
      if ('email' in b) u.email = (b.email as string | null) || null
      if ('language' in b) u.language = b.language as Language
      if ('theme' in b) u.themeMode = b.theme as Theme
      if ('themeMode' in b) u.themeMode = (b.themeMode as ThemeMode | null) ?? null
      if ('skin' in b) u.skin = (b.skin as Skin | null) ?? null
      if ('nav3d' in b) {
        const n = b.nav3d as Nav3dPrefs | null
        if (n && (!NAV3D_PRESETS.includes(n.preset) || (n.preset === 'custom' && !n.custom))) throw new ApiError(400, 'validation.failed', 'Invalid nav3d')
        u.nav3d = n ?? null
      }
      if ('prepareLevel' in b) {
        const l = b.prepareLevel as PrepareLevel | null
        if (l !== null && !PREPARE_LEVELS.includes(l)) throw new ApiError(400, 'validation.failed', 'Invalid prepareLevel')
        u.prepareLevel = l
      }
      // "Always used" presets (the real server checks the user may use them)
      if ('defaultProcessPreset' in b) u.defaultProcessPreset = (b.defaultProcessPreset as string | null) ?? null
      if ('defaultFilamentPreset' in b) u.defaultFilamentPreset = (b.defaultFilamentPreset as string | null) ?? null
      if ('showPrinterFilaments' in b) u.showPrinterFilaments = Boolean(b.showPrinterFilaments)
      u.theme = u.themeMode ?? 'system'
      audit('account.update', null, Object.keys(b))
      return { user: selfUser(u) }
    }
    if (p === '/account/password') {
      const u = requireUser()
      if (u.password !== b.currentPassword) throw new ApiError(400, 'auth.invalid_current_password', 'Wrong password')
      u.password = String(b.newPassword)
      state.sessions = state.sessions.filter((s) => s.userId !== u.id || s.current)
      audit('account.password')
      return undefined
    }
    if (p === '/account/sessions') {
      const u = requireUser()
      return { sessions: state.sessions.filter((s) => s.userId === u.id).map(({ userId: _u, ...s }) => s) }
    }
    // AVATARS: the mock keeps the (client-cropped) image as a data URL; the real server re-encodes to 256×256 WebP
    if (p === '/account/avatar' && method === 'PUT') {
      const u = requireUser()
      const dataUrl = String(b.dataUrl ?? '')
      if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(dataUrl)) throw new ApiError(400, 'avatar.invalid_image', 'Invalid image')
      if (dataUrl.length > (5 * 1024 * 1024 * 4) / 3) throw new ApiError(413, 'avatar.too_large', 'Too large')
      u.avatarUrl = dataUrl
      audit('account.avatar', null, { bytes: Math.round((dataUrl.length * 3) / 4) })
      return { user: selfUser(u) }
    }
    if (p === '/account/avatar' && method === 'DELETE') {
      const u = requireUser()
      if (u.avatarUrl) audit('account.avatar_remove')
      u.avatarUrl = null
      return { user: selfUser(u) }
    }
    if (p === '/avatars') {
      requireUser()
      return { avatars: Object.fromEntries(state.users.filter((u) => u.avatarUrl).map((u) => [String(u.id), u.avatarUrl!])) }
    }
    if (p.startsWith('/account/sessions/') && method === 'DELETE') {
      const u = requireUser()
      const sid = p.split('/').pop()
      const before = state.sessions.length
      state.sessions = state.sessions.filter((s) => !(s.id === sid && s.userId === u.id))
      if (state.sessions.length === before) throw new ApiError(404, 'common.not_found', 'Not found')
      return undefined
    }
    // Phase 2 F2 routes (files, prints, usage, live printer, engine manager): see mockF2.ts
    // Phase 4 notifications: see mockNotify.ts
    // Printer-side presets (printer filaments, profiles backup): see mockPrinterPresets.ts
    const presets = handlePrinterPresets(method, p, url)
    if (presets !== NOT_HANDLED) return presets
    const notify = handleNotify(method, p, b)
    if (notify !== NOT_HANDLED) return notify
    const f2 = handleF2(method, p, url, b)
    if (f2 !== NOT_HANDLED) return await f2 // POST /prints is async (simulated send to the printer)
    // Phase 2 F1 routes (profiles, slicing, projects): see mockF1.ts
    const f1 = handleF1(method, p, url, b)
    if (f1 !== NOT_HANDLED) return f1

    if (p === '/printers') {
      requireUser()
      return state.printers
    }

    // ---------- admin ----------
    if (p.startsWith('/admin/')) {
      const me = requireAdmin()
      if (p === '/admin/users' && method === 'GET') return state.users.map(adminUser)
      if (p === '/admin/users' && method === 'POST') {
        if (state.users.some((u) => u.username.toLowerCase() === String(b.username).toLowerCase())) {
          throw new ApiError(409, 'users.username_taken', 'Username taken')
        }
        const u: MockUser = {
          id: state.nextId++,
          username: String(b.username),
          email: (b.email as string) || null,
          role: b.role as Role,
          isActive: true,
          language: (b.language as Language) ?? 'en',
          theme: 'system',
    themeMode: null,
    skin: null,
          avatarUrl: null,
          createdAt: now(),
          lastLoginAt: null,
          password: String(b.password),
          limits: NO_LIMITS,
          canPrintUploadedGcode: false,
        }
        state.users.push(u)
        audit('user.create', u.username, { role: u.role })
        return adminUser(u)
      }
      if (p.startsWith('/admin/users/')) {
        const u = state.users.find((x) => x.id === id)
        if (!u) throw new ApiError(404, 'common.not_found', 'Not found')
        if (p.endsWith('/avatar') && method === 'DELETE') {
          if (u.avatarUrl) audit('user.avatar_remove', u.username, { id: u.id })
          u.avatarUrl = null
          return adminUser(u)
        }
        if (p.endsWith('/limits')) {
          u.limits = b as unknown as UserLimits
          audit('user.limits', u.username, b)
          return adminUser(u)
        }
        if (p.endsWith('/password')) {
          u.password = String(b.newPassword)
          state.sessions = state.sessions.filter((s) => s.userId !== u.id)
          audit('user.password_reset', u.username)
          return undefined
        }
        if (method === 'DELETE') {
          if (u.id === me.id) throw new ApiError(403, 'users.cannot_delete_self', 'Cannot delete yourself')
          if (u.role === 'admin' && u.isActive && activeAdmins().length === 1) throw new ApiError(409, 'users.last_admin', 'Last admin')
          const files = url.searchParams.get('files')
          if (files !== 'delete' && files !== 'transfer') throw new ApiError(400, 'users.files_option_required', 'Choose what happens to the files')
          const r = mockFiles.removeOwner(u.id, files, me.id)
          state.users = state.users.filter((x) => x.id !== id)
          audit('user.delete', u.username, { id: u.id, files, fileCount: r.fileCount, cancelledRequests: r.cancelled })
          return undefined
        }
        if (method === 'PATCH') {
          const demote = 'role' in b && b.role !== u.role
          const deactivate = b.isActive === false && u.isActive
          if (u.id === me.id && (demote || deactivate)) throw new ApiError(403, 'users.cannot_modify_self', 'Self')
          if ((demote || deactivate) && u.role === 'admin' && activeAdmins().length === 1) throw new ApiError(409, 'users.last_admin', 'Last admin')
          if ('email' in b) u.email = (b.email as string | null) || null
          if ('role' in b) u.role = b.role as Role
          if ('isActive' in b) u.isActive = Boolean(b.isActive)
          if ('language' in b) u.language = b.language as Language
          if ('canPrintUploadedGcode' in b) u.canPrintUploadedGcode = Boolean(b.canPrintUploadedGcode)
          if ('canControlPrinter' in b) u.canControlPrinter = Boolean(b.canControlPrinter)
          audit('user.update', u.username, b)
          return adminUser(u)
        }
      }
      if (p === '/admin/settings' && method === 'GET') return state.settings
      if (p === '/admin/settings' && method === 'PATCH') {
        if ('workspace.defaultLevel' in b && !PREPARE_LEVELS.includes(b['workspace.defaultLevel'] as PrepareLevel)) {
          throw new ApiError(400, 'validation.failed', 'Invalid settings', { issues: [{ key: 'workspace.defaultLevel', message: 'Invalid option' }] })
        }
        Object.assign(state.settings, b)
        audit('settings.update', null, Object.keys(b))
        if (Object.keys(b).some((k) => k.startsWith('appearance.'))) {
          mockPublish({ type: 'appearance.defaults', data: { defaultMode: state.settings['appearance.defaultMode'], defaultSkin: state.settings['appearance.defaultSkin'] } })
        }
        return state.settings
      }
      if (p === '/admin/printers/test') return probe(b)
      if (p === '/admin/printers' && method === 'GET') return state.printers
      if (p === '/admin/printers' && method === 'POST') {
        const pr: Printer = { ...(b as unknown as Printer), id: state.nextId++, serial: null, firmware: null, camera: { type: 'none' }, lastSeenAt: null }
        state.printers.push(pr)
        audit('printer.create', pr.name)
        return pr
      }
      if (p.startsWith('/admin/printers/')) {
        const pr = state.printers.find((x) => x.id === id)
        if (!pr) throw new ApiError(404, 'common.not_found', 'Not found')
        if (method === 'DELETE') {
          state.printers = state.printers.filter((x) => x.id !== id)
          audit('printer.delete', pr.name)
          return undefined
        }
        if ('bedSurfaces' in b || 'defaultBedSurface' in b) {
          const list = BED_SURFACES.filter((x) => ((b.bedSurfaces as BedSurface[] | undefined) ?? pr.bedSurfaces ?? [DEFAULT_BED_SURFACE]).includes(x))
          if (!list.length) throw new ApiError(400, 'validation.failed', 'At least one bed surface')
          const def = (b.defaultBedSurface as BedSurface | undefined) ?? pr.defaultBedSurface
          if (b.defaultBedSurface && !list.includes(b.defaultBedSurface as BedSurface)) throw new ApiError(400, 'printers.invalid_bed_surface', 'Not owned')
          b.bedSurfaces = list
          b.defaultBedSurface = def && list.includes(def) ? def : list[0]
        }
        Object.assign(pr, b)
        audit('printer.update', pr.name)
        return pr
      }
      if (p === '/admin/system') {
        return {
          version: '0.1.0-mock',
          node: 'v24.22.0',
          uptimeSec: Math.round((now() - startedAt) / 1000),
          memory: { rss: 142 * 1024 ** 2, heapUsed: 61 * 1024 ** 2, limitBytes: flags.lowMemory ? GiB : 4 * GiB, ok: !flags.lowMemory },
          appdataRoot: '/appdata',
          dataRoot: '/data',
          dbSizeBytes: 212_992,
          engine: { selected: state.settings['engine.selected'], installedVersion: engineInstalledVersion() },
          proxyHeadersSeen: flags.proxyHeaders && state.settings['exposure.mode'] === 'none',
        }
      }
      if (p === '/admin/logs') {
        const limit = Number(url.searchParams.get('limit') ?? 500)
        return { lines: logLines().slice(-limit) }
      }
      if (p === '/admin/audit') {
        const limit = Number(url.searchParams.get('limit') ?? 200)
        const before = Number(url.searchParams.get('before') ?? Number.POSITIVE_INFINITY)
        return { items: state.audit.filter((e) => e.id < before).slice(0, limit) }
      }
    }
    throw new ApiError(404, 'common.not_found', `Mock: no route for ${method} ${p}`)
  } finally {
    save()
  }
}

export { mockBlob, mockUpload } from './mockF2'

/** Raw-body uploads (profile picture): sent through the router as a data URL. */
export const mockBinary: BinarySender = async (method, path, blob) => {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
  return mockTransport(method, path, { dataUrl })
}

/** A seeded profile picture (gradient + initial), so lists show both photos and initials. */
function seedAvatar(letter: string, from: string, to: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="256" height="256" fill="url(#g)"/><circle cx="128" cy="100" r="46" fill="#fff" fill-opacity=".85"/><path d="M40 256c10-60 48-88 88-88s78 28 88 88z" fill="#fff" fill-opacity=".85"/><text x="214" y="236" font-family="sans-serif" font-size="34" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text></svg>`
  return `data:image/svg+xml;base64,${btoa(svg)}`
}
