import type {
  AccountNotifications,
  PrinterCopy,
  PrinterCopyResult,
  PrinterFileDeleteResult,
  PrinterStoredFile,
  AdminNotifications,
  NotifyChannel,
  NotifyChannelConfigs,
  NotifyChannelStatus,
  NotifyEvent,
  PushDevice,
  PushSubscriptionBody,
  AccountPatch,
  AccountSession,
  AdminSystem,
  AdminUser,
  AppConfig,
  AuditEntry,
  CreateUserRequest,
  EngineInfo,
  FileKind,
  LibraryFile,
  PrintJob,
  PrinterControlCommand,
  TempSample,
  PrinterStatus,
  UsageSummary,
  Visibility,
  PresetSummary,
  FilamentPreset,
  FilamentPresetCreate,
  FilamentPresetPatch,
  FilamentPresetScope,
  ProcessProfile,
  ProcessProfileCreate,
  ProcessProfilePatch,
  ProfileExportFile,
  ProfileExportRequest,
  ProfileImportReport,
  PrinterModel,
  ProfileBundle,
  ProjectBody,
  ResolvedPreset,
  SceneDoc,
  SliceJob,
  SliceRequest,
  LogLine,
  Printer,
  PrinterInput,
  PrinterPrefsPatch,
  PrinterModelInfo,
  ProbeRequest,
  ProbeResult,
  SetupCompleteRequest,
  SetupStatus,
  Settings,
  UpdateUserRequest,
  User,
  UserLimits,
} from './types'

/**
 * Error returned by the API: `{ error: { code, message, details? } }`.
 * `code` is an i18n key (translated with `errorMessage()` in i18n/I18nContext).
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown
  /** Seconds until a rate limit lifts, when the server tells us */
  readonly retryAfter: number | null

  constructor(status: number, code: string, message: string, details?: unknown, retryAfter: number | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
    this.retryAfter = retryAfter
  }
}

export const isUnauthorized = (err: unknown) => err instanceof ApiError && err.status === 401

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export type Transport = (method: Method, path: string, body?: unknown) => Promise<unknown>

function readRetryAfter(res: Response, error: Record<string, unknown> | undefined): number | null {
  const details = error?.details as Record<string, unknown> | undefined
  const candidates = [error?.retryAfter, details?.retryAfter, res.headers.get('Retry-After')]
  for (const c of candidates) {
    const n = typeof c === 'string' ? Number(c) : c
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) return n
  }
  return null
}

const httpTransport: Transport = async (method, path, body) => {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'common.network', 'Cannot reach the SliceDock server.')
  }

  if (res.status === 204) return undefined
  const data: unknown = await res.json().catch(() => null)

  if (!res.ok) {
    const error = (data as { error?: Record<string, unknown> } | null)?.error
    if (error && typeof error.code === 'string') {
      throw new ApiError(
        res.status,
        error.code,
        typeof error.message === 'string' ? error.message : error.code,
        error.details,
        readRetryAfter(res, error),
      )
    }
    // No JSON error body: backend down, crashed or a proxy error page
    throw new ApiError(
      res.status,
      res.status === 401 ? 'auth.unauthorized' : res.status >= 500 ? 'common.network' : 'common.internal',
      `Request failed (${res.status})`,
    )
  }
  return data
}

export interface TransferOptions {
  /** Bytes done / total (total is 0 when unknown) */
  onProgress?: (loaded: number, total: number) => void
  signal?: AbortSignal
  /** Extra multipart fields (e.g. visibility) */
  fields?: Record<string, string>
}

export type Uploader = (path: string, file: File, opts: TransferOptions) => Promise<unknown>
export type BlobFetcher = (path: string, opts: TransferOptions) => Promise<Blob>

function errorFromBody(status: number, text: string): ApiError {
  try {
    const error = (JSON.parse(text) as { error?: Record<string, unknown> }).error
    if (error && typeof error.code === 'string') {
      return new ApiError(status, error.code, typeof error.message === 'string' ? error.message : error.code, error.details)
    }
  } catch {
    // not JSON
  }
  const code = status === 413 ? 'common.payload_too_large' : status === 401 ? 'auth.unauthorized' : status >= 500 ? 'common.network' : 'common.internal'
  return new ApiError(status, code, `Request failed (${status})`)
}

/** Multipart upload with progress (fetch has no upload progress, so XHR). */
const xhrUpload: Uploader = (path, file, { onProgress, signal, fields }) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api${path}`)
    xhr.withCredentials = true
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.upload.onprogress = (e) => onProgress?.(e.loaded, e.lengthComputable ? e.total : 0)
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(xhr.responseText ? JSON.parse(xhr.responseText) : undefined)
        } catch {
          resolve(undefined)
        }
      } else reject(errorFromBody(xhr.status, xhr.responseText))
    }
    xhr.onerror = () => reject(new ApiError(0, 'common.network', 'Cannot reach the SliceDock server.'))
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal?.addEventListener('abort', () => xhr.abort(), { once: true })
    const form = new FormData()
    for (const [k, v] of Object.entries(fields ?? {})) form.append(k, v)
    form.append('file', file, file.name)
    xhr.send(form)
  })

export type BinarySender = (method: Method, path: string, blob: Blob) => Promise<unknown>

/** Raw binary body (Content-Type = the blob's type), JSON response. */
const httpBinary: BinarySender = async (method, path, blob) => {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    })
  } catch {
    throw new ApiError(0, 'common.network', 'Cannot reach the SliceDock server.')
  }
  const text = await res.text().catch(() => '')
  if (!res.ok) throw errorFromBody(res.status, text)
  return text ? JSON.parse(text) : undefined
}

/** Fetches a binary response, reporting download progress. */
const httpBlob: BlobFetcher = async (path, { onProgress, signal }) => {
  let res: Response
  try {
    res = await fetch(`/api${path}`, { credentials: 'same-origin', signal })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new ApiError(0, 'common.network', 'Cannot reach the SliceDock server.')
  }
  if (!res.ok) throw errorFromBody(res.status, await res.text().catch(() => ''))
  const total = Number(res.headers.get('Content-Length') ?? 0)
  if (!res.body || !onProgress) return res.blob()
  const reader = res.body.getReader()
  const chunks: BlobPart[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value as BlobPart)
    loaded += value.byteLength
    onProgress(loaded, total)
  }
  return new Blob(chunks, { type: res.headers.get('Content-Type') ?? 'application/octet-stream' })
}

/** Triggers a browser download of `blob` as `name`. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

// Dev-only fake backend (`npm run dev:mock`). `import.meta.env.DEV` is false in `vite build`,
// so this branch and the dynamic import are removed from production bundles.
let transport: Transport = httpTransport
let uploader: Uploader = xhrUpload
let blobFetcher: BlobFetcher = httpBlob
let binarySender: BinarySender = httpBinary
if (import.meta.env.DEV && import.meta.env.VITE_MOCK === '1') {
  const mock = import('./dev/mock')
  binarySender = async (method, path, blob) => (await mock).mockBinary(method, path, blob)
  transport = async (method, path, body) => (await mock).mockTransport(method, path, body)
  uploader = async (path, file, opts) => (await mock).mockUpload(path, file, opts)
  blobFetcher = async (path, opts) => (await mock).mockBlob(path, opts)
}

const req = <T>(method: Method, path: string, body?: unknown) => transport(method, path, body) as Promise<T>
const get = <T>(path: string) => req<T>('GET', path)

const qs = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) s.set(k, String(v))
  const out = s.toString()
  return out ? `?${out}` : ''
}

export const api = {
  // Public
  health: () => get<{ ok: true; version: string }>('/health'),
  config: () => get<AppConfig>('/config'),
  setupStatus: () => get<SetupStatus>('/setup/status'),
  printerModels: () => get<PrinterModelInfo[]>('/printer-models'),

  // Setup (LAN-only, before the admin exists)
  setupTestPrinter: (body: ProbeRequest) => req<ProbeResult>('POST', '/setup/test-printer', body),
  setupComplete: (body: SetupCompleteRequest) => req<{ user: User }>('POST', '/setup/complete', body),

  // Auth
  login: (username: string, password: string) => req<{ user: User }>('POST', '/auth/login', { username, password }),
  logout: () => req<void>('POST', '/auth/logout'),
  me: () => get<{ user: User }>('/auth/me'),

  // Account
  updateAccount: (patch: AccountPatch) => req<{ user: User }>('PATCH', '/account', patch),
  changePassword: (currentPassword: string, newPassword: string) =>
    req<void>('POST', '/account/password', { currentPassword, newPassword }),

  /** Profile picture: the (client-cropped) image as a raw body; the server re-encodes it to 256×256 WebP */
  uploadAvatar: (image: Blob) => binarySender('PUT', '/account/avatar', image) as Promise<{ user: User }>,
  removeAvatar: () => req<{ user: User }>('DELETE', '/account/avatar'),
  /** `{ userId: avatarUrl }` for users with a picture (prints/audit lists only carry ids) */
  avatars: () => get<{ avatars: Record<string, string> }>('/avatars'),

  sessions: () => get<{ sessions: AccountSession[] }>('/account/sessions'),
  revokeSession: (id: string) => req<void>('DELETE', `/account/sessions/${encodeURIComponent(id)}`),

  // Printers
  printers: () => get<Printer[]>('/printers'),
  printerStatus: (id: number) => get<PrinterStatus>(`/printers/${id}/status`),
  printerCommand: (id: number, command: 'pause' | 'resume' | 'cancel') => req<void>('POST', `/printers/${id}/${command}`),
  /** Someone removed the finished print from the plate */
  bedCleared: (id: number) => req<void>('POST', `/printers/${id}/bed-cleared`),
  /** The G-code the printer is running (also for jobs started outside SliceDock) */
  printerCurrentGcode: (id: number, opts: TransferOptions & { last?: boolean } = {}) =>
    blobFetcher(`/printers/${id}/current-gcode${opts.last ? '?last=1' : ''}`, opts),
  /** Jog / home / temperatures / fan / motors off (typed; the server builds the G-code) */
  printerControl: (id: number, command: PrinterControlCommand) => req<PrinterStatus>('POST', `/printers/${id}/control`, command),
  printerTemps: (id: number, minutes: number) => req<{ intervalMs: number; samples: TempSample[] }>('GET', `/printers/${id}/temps?minutes=${minutes}`),
  /** Stops printing one object of the running job (Klipper EXCLUDE_OBJECT) */
  excludeObject: (id: number, name: string) => req<PrinterStatus>('POST', `/printers/${id}/exclude-object`, { name }),
  printerCurrentThumbnail: (id: number) => blobFetcher(`/printers/${id}/current-thumbnail`, {}),

  // Files (Phase 2)
  files: (scope: 'private' | 'shared' | 'all' = 'private', kind?: FileKind) => get<LibraryFile[]>(`/files${qs({ scope, kind })}`),
  uploadFile: (file: File, opts: TransferOptions & { visibility?: Visibility } = {}) =>
    uploader('/files', file, { ...opts, fields: { ...opts.fields, ...(opts.visibility ? { visibility: opts.visibility } : {}) } }) as Promise<LibraryFile>,
  updateFile: (id: number, patch: { name?: string; visibility?: Visibility; pinned?: boolean }) =>
    req<LibraryFile>('PATCH', `/files/${id}`, patch),
  /** Deletes a library file; `printer: true` also removes the copies SliceDock uploaded to printers (per-copy results) */
  deleteFile: (id: number, opts: { printer?: boolean } = {}) =>
    req<{ printer: PrinterCopyResult[] } | undefined>('DELETE', `/files/${id}${opts.printer ? '?printer=1' : ''}`),
  /** Printer copies SliceDock uploaded for these files (what a delete can also remove) */
  printerCopies: (ids: number[]) => get<{ items: { fileId: number; copies: PrinterCopy[] }[] }>(`/files/printer-copies?ids=${ids.join(',')}`),
  /** Raw file bytes for the viewers (`/files/:id/content`), with download progress */
  fileContent: (id: number, opts: TransferOptions = {}) => blobFetcher(`/files/${id}/content`, opts),
  /** Replaces a file's thumbnail (owner/admin): base64 PNG without the data: prefix, ≤ 512 KB */
  setFileThumbnail: (id: number, png: string) => req<LibraryFile>('PUT', `/files/${id}/thumbnail`, { png }),
  /** Saves the file to disk under its original name */
  downloadFile: async (file: Pick<LibraryFile, 'id' | 'name'>) => {
    if (import.meta.env.DEV && import.meta.env.VITE_MOCK === '1') {
      saveBlob(await blobFetcher(`/files/${file.id}/download`, {}), file.name)
      return
    }
    // Real backend: let the browser stream it (Content-Disposition carries the name)
    const a = document.createElement('a')
    a.href = `/api/files/${file.id}/download`
    a.download = file.name
    document.body.appendChild(a)
    a.click()
    a.remove()
  },

  // Printing (Phase 2)
  /** `calibrate`: auto bed leveling before the print (sent only when chosen; undefined = server default). */
  createPrint: (printerId: number, fileId: number, confirmBedClear = false, allowDangerous = false, calibrate?: boolean) =>
    req<PrintJob>('POST', '/prints', {
      printerId,
      fileId,
      ...(confirmBedClear && { confirmBedClear }),
      ...(allowDangerous && { allowDangerous }),
      ...(calibrate !== undefined && { calibrate }),
    }),
  // Files → On the printer (the printer's own G-code files)
  printerFiles: (printerId: number, refresh = false) => get<PrinterStoredFile[]>(`/printers/${printerId}/files${refresh ? '?refresh=1' : ''}`),
  importPrinterFile: (printerId: number, name: string) => req<LibraryFile>('POST', `/printers/${printerId}/files/import`, { name }),
  /** Downloads + scans the printer's file, then starts it in place (no re-upload); same rules as uploaded G-code */
  printPrinterFile: (printerId: number, name: string, opts: { confirmBedClear?: boolean; allowDangerous?: boolean; calibrate?: boolean } = {}) =>
    req<{ job: PrintJob; fileId: number; imported: boolean }>('POST', `/printers/${printerId}/files/print`, {
      name,
      ...(opts.confirmBedClear && { confirmBedClear: true }),
      ...(opts.allowDangerous && { allowDangerous: true }),
      ...(opts.calibrate !== undefined && { calibrate: opts.calibrate }),
    }),
  deletePrinterFiles: (printerId: number, names: string[]) =>
    req<{ results: PrinterFileDeleteResult[] }>('DELETE', `/printers/${printerId}/files`, { names }),
  prints: (scope: 'mine' | 'all' = 'mine') => get<PrintJob[]>(`/prints${qs({ scope })}`),
  cancelPrintRequest: (id: number) => req<void>('DELETE', `/prints/${id}`),
  usage: () => get<UsageSummary>('/usage/me'),

  // Workspace: profiles, slicing, projects (Phase 2, F1)
  profiles: (model: PrinterModel, lang?: string) => get<ProfileBundle>(`/profiles/${model}${qs({ lang })}`),
  preset: (model: PrinterModel, kind: PresetSummary['kind'], id: string) =>
    get<ResolvedPreset>(`/profiles/${model}/preset/${kind}/${encodeURIComponent(id)}`),
  // Custom filament presets (FILAMENTS). `scope`: usable = mine + shared, everyone = admins only
  filamentPresets: (scope: 'usable' | 'mine' | 'shared' | 'everyone' = 'usable') => get<FilamentPreset[]>(`/filament-presets${qs({ scope })}`),
  filamentPreset: (id: number) => get<FilamentPreset>(`/filament-presets/${id}`),
  createFilamentPreset: (body: FilamentPresetCreate) => req<FilamentPreset>('POST', '/filament-presets', body),
  updateFilamentPreset: (id: number, patch: FilamentPresetPatch) => req<FilamentPreset>('PATCH', `/filament-presets/${id}`, patch),
  deleteFilamentPreset: (id: number) => req<void>('DELETE', `/filament-presets/${id}`),
  /** Owner or admin */
  shareFilamentPreset: (id: number, scope: FilamentPresetScope) => req<FilamentPreset>('POST', `/filament-presets/${id}/share`, { scope }),
  // User process profiles (PROFILES tab): same rules as custom filaments
  processProfiles: (scope: 'usable' | 'mine' | 'shared' | 'everyone' = 'usable') => get<ProcessProfile[]>(`/process-profiles${qs({ scope })}`),
  processProfile: (id: number) => get<ProcessProfile>(`/process-profiles/${id}`),
  createProcessProfile: (body: ProcessProfileCreate) => req<ProcessProfile>('POST', '/process-profiles', body),
  updateProcessProfile: (id: number, patch: ProcessProfilePatch) => req<ProcessProfile>('PATCH', `/process-profiles/${id}`, patch),
  deleteProcessProfile: (id: number) => req<void>('DELETE', `/process-profiles/${id}`),
  shareProcessProfile: (id: number, scope: FilamentPresetScope) => req<ProcessProfile>('POST', `/process-profiles/${id}/share`, { scope }),
  /** Creality Print / Orca preset file (.json, .zip, .creality_filament, .creality_printer), sent as base64 */
  importProfiles: (fileName: string, data: string) => req<ProfileImportReport>('POST', '/profile-files/import', { fileName, data }),
  exportProfiles: (body: ProfileExportRequest) => req<ProfileExportFile>('POST', '/profile-files/export', body),
  sliceStart: (body: SliceRequest) => req<SliceJob>('POST', '/slice', body),
  sliceJob: (id: string) => get<SliceJob>(`/slice/${encodeURIComponent(id)}`),
  sliceCancel: (id: string) => req<void>('DELETE', `/slice/${encodeURIComponent(id)}`),
  createProject: (body: ProjectBody) => req<LibraryFile>('POST', '/projects', body),
  saveProject: (id: number, body: ProjectBody) => req<LibraryFile>('PUT', `/projects/${id}`, body),
  project: (id: number) => get<{ file: LibraryFile; scene: SceneDoc }>(`/projects/${id}`),
}

export const adminApi = {
  /** Moderation: removes a user's profile picture (audited) */
  removeAvatar: (id: number) => req<AdminUser>('DELETE', `/admin/users/${id}/avatar`),
  users: () => get<AdminUser[]>('/admin/users'),
  createUser: (body: CreateUserRequest) => req<AdminUser>('POST', '/admin/users', body),
  updateUser: (id: number, body: UpdateUserRequest) => req<AdminUser>('PATCH', `/admin/users/${id}`, body),
  /** `files`: what happens to the user's library (required by the server) */
  deleteUser: (id: number, files: 'delete' | 'transfer') => req<void>('DELETE', `/admin/users/${id}?files=${files}`),
  setLimits: (id: number, limits: UserLimits) => req<AdminUser>('PUT', `/admin/users/${id}/limits`, limits),
  resetPassword: (id: number, newPassword: string) => req<void>('POST', `/admin/users/${id}/password`, { newPassword }),

  settings: () => get<Settings>('/admin/settings'),
  updateSettings: (patch: Partial<Settings>) => req<Settings>('PATCH', '/admin/settings', patch),

  printers: () => get<Printer[]>('/admin/printers'),
  createPrinter: (body: PrinterInput) => req<Printer>('POST', '/admin/printers', body),
  updatePrinter: (id: number, body: Partial<PrinterInput> & PrinterPrefsPatch) => req<Printer>('PATCH', `/admin/printers/${id}`, body),
  deletePrinter: (id: number) => req<void>('DELETE', `/admin/printers/${id}`),
  testPrinter: (body: ProbeRequest) => req<ProbeResult>('POST', '/admin/printers/test', body),

  system: () => get<AdminSystem>('/admin/system'),
  logs: (limit = 500) => get<{ lines: LogLine[] }>(`/admin/logs${qs({ limit })}`),
  audit: (limit = 200, before?: number) => get<{ items: AuditEntry[] }>(`/admin/audit${qs({ limit, before })}`),

  // Engine manager (Phase 2)
  engine: () => get<EngineInfo>('/admin/engine'),
  engineCheck: () => req<EngineInfo>('POST', '/admin/engine/check'),
  engineUpdate: () => req<EngineInfo>('POST', '/admin/engine/update'),
  engineRollback: () => req<EngineInfo>('POST', '/admin/engine/rollback'),

  // Prints & approvals (Phase 2)
  pendingPrints: () => get<PrintJob[]>('/prints/pending'),
  approvePrint: (id: number, opts: { confirmBedClear?: boolean; force?: boolean; allowDangerous?: boolean; calibrate?: boolean } = {}) => {
    const body = {
      ...(opts.calibrate !== undefined && { calibrate: opts.calibrate }),
      ...(opts.confirmBedClear && { confirmBedClear: true }),
      ...(opts.force && { force: true }),
      ...(opts.allowDangerous && { allowDangerous: true }),
    }
    return req<PrintJob>('POST', `/prints/${id}/approve`, Object.keys(body).length ? body : undefined)
  },
  rejectPrint: (id: number, reason: string) => req<PrintJob>('POST', `/prints/${id}/reject`, { reason }),
}

// ---------- Phase 4: notifications ----------

export const notifyApi = {
  // Admin → Notifications (channels)
  admin: () => get<AdminNotifications>('/admin/notifications'),
  updateChannel: <C extends NotifyChannel>(channel: C, patch: Partial<NotifyChannelConfigs[C]>) =>
    req<AdminNotifications>('PATCH', `/admin/notifications/${channel}`, patch),
  testChannel: (channel: NotifyChannel) => req<{ ok: true; status: NotifyChannelStatus }>('POST', `/admin/notifications/${channel}/test`),

  // Account → Notifications (Web Push on this account's devices)
  mine: () => get<AccountNotifications>('/account/notifications'),
  setPrefs: (events: NotifyEvent[]) => req<AccountNotifications>('PUT', '/account/notifications/prefs', { events }),
  subscribe: (body: PushSubscriptionBody) => req<PushDevice>('POST', '/account/notifications/subscriptions', body),
  /** Forget the current browser's subscription (by endpoint) */
  unsubscribeEndpoint: (endpoint: string) => req<void>('POST', '/account/notifications/subscriptions/remove', { endpoint }),
  removeDevice: (id: number) => req<void>('DELETE', `/account/notifications/subscriptions/${id}`),
  sendTest: () => req<{ sent: number; failed: number; removed: number }>('POST', '/account/notifications/test'),
}
