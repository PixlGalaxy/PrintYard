// Shared types — keep in sync with backend/src/types.ts (status/phase1-contract.md)

export type Role = 'admin' | 'user'
export type Theme = 'system' | 'light' | 'dark'
/** Appearance mode (same values as Theme). `null` on a user = inherit the admin default. */
export type ThemeMode = Theme
export const THEME_MODES: ThemeMode[] = ['system', 'light', 'dark']
/** Accent skins — keep in sync with backend/src/types.ts and the [data-skin] blocks in index.css. */
export const SKINS = [
  'sky',
  'indigo',
  'ocean',
  'sunset',
  'forest',
  'grape',
  'crimson',
  'solar',
  'mint',
  'blossom',
  'ares',
  'poseidon',
  'zeus',
  'jade',
  'verdigris',
  'nebula',
  'sakura',
  'slate',
  'mono',
  'graphite',
  'ash',
  'terracotta',
  'olive',
  'maroon',
] as const
export type Skin = (typeof SKINS)[number]

/** 3D viewport navigation (mirrors backend/src/types.ts; behaviour in three/navigation.ts) */
export const NAV3D_PRESETS = ['slicedock', 'tinkercad', 'repetier', 'cad', 'blender', 'custom'] as const
export type Nav3dPreset = (typeof NAV3D_PRESETS)[number]
export const NAV3D_BUTTONS = ['left', 'middle', 'right'] as const
export const NAV3D_MODIFIERS = ['none', 'shift', 'ctrl', 'alt'] as const
export type Nav3dButton = (typeof NAV3D_BUTTONS)[number]
export type Nav3dModifier = (typeof NAV3D_MODIFIERS)[number]
export interface Nav3dBinding {
  button: Nav3dButton
  modifier: Nav3dModifier
}
export interface Nav3dCustom {
  orbit: Nav3dBinding
  pan: Nav3dBinding
  /** null = wheel only */
  zoom: Nav3dBinding | null
  zoomToCursor: boolean
}
export type Nav3dView = 'iso' | 'top' | 'front'
export interface Nav3dPrefs {
  preset: Nav3dPreset
  custom?: Nav3dCustom
  invertWheel?: boolean
  /** 0.2..3, 1 = default */
  orbitSpeed?: number
  zoomSpeed?: number
  defaultView?: Nav3dView
}

/** Creality bed surfaces (curr_bed_type values) for the K2 SE */
export const BED_SURFACES = ['Epoxy Resin Plate', 'Textured PEI Plate', 'High Temp Plate', 'Cool Plate', 'Engineering Plate', 'Customized Plate'] as const
export type BedSurface = (typeof BED_SURFACES)[number]
export const DEFAULT_BED_SURFACE: BedSurface = 'Epoxy Resin Plate'
/** Prepare tab settings level (Basic / Advanced / Expert), keep in sync with backend/src/types.ts */
export const PREPARE_LEVELS = ['basic', 'advanced', 'expert'] as const
export type PrepareLevel = (typeof PREPARE_LEVELS)[number]
export interface AppearanceDefaults {
  defaultMode: ThemeMode
  defaultSkin: Skin
}
export type Language = 'en' | 'es'
export type ExposureMode = 'none' | 'cloudflare' | 'nginx' | 'other'
export type PrinterModel = 'creality-k2se'
export type EngineId = 'creality' | 'orca'

export interface User {
  id: number
  username: string
  email: string | null
  role: Role
  isActive: boolean
  language: Language
  /** @deprecated legacy field: `themeMode ?? 'system'` */
  theme: Theme
  /** Explicit choice, or null = use the admin default */
  themeMode: ThemeMode | null
  skin: Skin | null
  /** Resolved values (user → admin default), on the signed-in user's own responses */
  effectiveThemeMode?: ThemeMode
  effectiveSkin?: Skin
  avatarUrl: string | null
  createdAt: number
  lastLoginAt: number | null
  /** May use the printer motion/temperature/fan controls (admins always) */
  canControlPrinter?: boolean
  /** 3D navigation preferences; null = SliceDock defaults */
  nav3d?: Nav3dPrefs | null
  /** Prepare tab settings level; null = admin default (`workspace.defaultLevel`) */
  prepareLevel?: PrepareLevel | null
}

export interface UserLimits {
  enabled: boolean
  maxGramsPerPrint: number | null
  maxGramsPerMonth: number | null
  maxHoursPerPrint: number | null
  requiresApproval: boolean
}

export interface AdminUser extends User {
  limits: UserLimits
  /** May print G-code SliceDock did not slice (admins always can). */
  canPrintUploadedGcode: boolean
}

export type PrinterKinematics = 'corexy' | 'cartesian' | 'delta' | 'unknown'

export interface Printer {
  id: number
  name: string
  model: PrinterModel
  /** Derived from `model` by the backend */
  kinematics: PrinterKinematics
  host: string
  staticIp: boolean
  mac: string | null
  serial: string | null
  firmware: string | null
  camera: { type: 'none' }
  lastSeenAt: number | null
  /** Bed surfaces the owner has (never empty) + the default one */
  bedSurfaces?: BedSurface[]
  defaultBedSurface?: BedSurface
}

export interface PrinterModelInfo {
  id: PrinterModel
  name: string
  vendor: string
  bed: { x: number; y: number; z: number }
  kinematics: PrinterKinematics
}

export interface ProbeResult {
  ok: boolean
  /** i18n error code */
  error?: string
  model?: string
  firmware?: string
  mac?: string
  hostname?: string
  resolvedHost?: string
  moonraker?: boolean
  creality?: boolean
}

/** After setup, the unauthenticated endpoint may return only `{ setupComplete: true }`. */
export interface SetupStatus {
  setupComplete: boolean
  lanAllowed?: boolean
  memoryLimitBytes?: number | null
  memoryOk?: boolean
  /** true if the container sees a LAN interface besides docker0/eth0 172.17.x */
  hostNetworkLikely?: boolean
}

export interface AppConfig {
  appName: 'SliceDock'
  version: string
  setupComplete: boolean
  languages: Language[]
  defaultLanguage: Language
  /** Global appearance defaults (optional for older servers) */
  appearance?: AppearanceDefaults
  /** Server started with SLICEDOCK_READ_ONLY=1: every printer write is refused (423 printers.read_only) */
  readOnly?: boolean
  /** Retention info for the Files page notice */
  files?: { retentionEnabled: boolean; retentionKeep: number; maxUploadMb?: number }
  /** Admin setting `printing.calibrateByDefault`: the print dialog's "Calibrate before printing" default */
  printing?: { calibrateByDefault?: boolean }
  /** Admin setting `workspace.defaultLevel` (optional for older servers) */
  workspace?: { defaultLevel?: PrepareLevel }
}

// ---------- Request bodies ----------

export interface PrinterInput {
  name: string
  model: PrinterModel
  host: string
  staticIp: boolean
  mac: string | null
}

/** PATCH /api/admin/printers/:id (owner preferences, no reconnect) */
export interface PrinterPrefsPatch {
  bedSurfaces?: BedSurface[]
  defaultBedSurface?: BedSurface
}

export interface ProbeRequest {
  model: PrinterModel
  host: string
  staticIp: boolean
  mac?: string
}

export interface SetupCompleteRequest {
  language: Language
  admin: { username: string; email: string; password: string }
  printer: PrinterInput
  exposure: { mode: ExposureMode; publicUrl: string | null }
  engine: { selected: EngineId; autoUpdate: boolean }
  /** Optional: older servers ignore it, newer ones default to 'basic' */
  workspace?: { defaultLevel: PrepareLevel }
}

export interface CreateUserRequest {
  username: string
  email?: string
  password: string
  role: Role
  language?: Language
}

export interface UpdateUserRequest {
  email?: string | null
  role?: Role
  isActive?: boolean
  language?: Language
  canPrintUploadedGcode?: boolean
  canControlPrinter?: boolean
}

export interface AccountPatch {
  email?: string | null
  language?: Language
  /** @deprecated use themeMode */
  theme?: Theme
  /** null = use the admin default */
  themeMode?: ThemeMode | null
  skin?: Skin | null
  /** null = SliceDock defaults */
  nav3d?: Nav3dPrefs | null
  /** null = use the admin default */
  prepareLevel?: PrepareLevel | null
}

/** GET /api/account/sessions (id is a public hash, not the token) */
export interface AccountSession {
  id: string
  createdAt: number
  lastSeenAt: number
  expiresAt: number
  ip: string | null
  userAgent: string | null
  current: boolean
}

// ---------- Admin ----------

/** Typed view of the settings keys known in Phase 1 (the API returns Record<string, unknown>). */
export interface Settings {
  'app.defaultLanguage': Language
  'appearance.defaultMode': ThemeMode
  'appearance.defaultSkin': Skin
  'workspace.defaultLevel': PrepareLevel
  'admin.email': string | null
  'exposure.mode': ExposureMode
  'exposure.trustedProxies': string[]
  'exposure.publicUrl': string | null
  'security.sessionHours': number
  'security.idleMinutes': number
  'engine.selected': EngineId
  'engine.autoUpdate': boolean
  'engine.checkIntervalHours': number
  'limits.costPerKg': number | null
  'limits.currency': string
  'files.retention.enabled': boolean
  'files.retention.keep': number
  /** keep only the newest N SliceDock uploads on each printer (others are deleted from the printer) */
  'printers.retention.enabled': boolean
  'printers.retention.keep': number
  /** idle heater safety: heaters on with no print and no control action for this long → off (0 = never) */
  'printers.idleHeaterOffMinutes': number
  'files.maxUploadMb': number
}

export interface AdminSystem {
  version: string
  node: string
  uptimeSec: number
  memory: { rss: number; heapUsed: number; limitBytes: number | null; ok: boolean }
  appdataRoot: string
  dataRoot: string
  dbSizeBytes: number
  engine: { selected: EngineId; installedVersion: string | null }
  /** X-Forwarded-* / CF headers seen while exposure mode is 'none' */
  proxyHeadersSeen?: boolean
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogLine {
  /** epoch ms (ISO string tolerated) */
  ts: number | string
  level: LogLevel
  channel: string
  msg: string
}

/** Shape from status/backend-notes.md (not in the contract). `meta` may be an object or a JSON string. */
export interface AuditEntry {
  id: number
  userId: number | null
  username: string | null
  action: string
  target: string | null
  meta: unknown
  ip: string | null
  createdAt: number
}

// ---------- Phase 2 shared types (status/phase2-contract.md "Shared types") ----------

export type FileKind = 'model' | 'project' | 'gcode'
export type Visibility = 'private' | 'shared'

export interface GcodeSummary {
  printSeconds: number | null
  filamentGrams: number[]
  filamentMm: number[]
  layers: number | null
  printerModel: string | null
  slicer: string | null
  /** `slicer` = sliced by SliceDock (trusted); `computed` = parsed from the moves (uploads). Absent on legacy rows. */
  estimateSource?: 'slicer' | 'computed'
  /** Uploads only: what the file's own comments claim (display only). */
  declared?: { printSeconds: number | null; filamentGrams: number[]; layers: number | null }
  /** Uploads only: dangerous-command scan. */
  scan?: GcodeScan
}

export type GcodeScanReason =
  | 'config_write'
  | 'shell_command'
  | 'firmware_restart'
  | 'firmware_update'
  | 'emergency_stop'
  | 'kinematics'
  | 'temperature_too_high'
  | 'motion_limit'
  | 'invalid_value'
  | 'unknown_heater'
  | 'malformed_command'
  | 'duplicate_parameter'
  | 'flow_limit'
  | 'unknown_command'

export interface GcodeScanFinding {
  line: number
  command: string
  reason: GcodeScanReason
  detail?: string
}

export interface GcodeScan {
  ok: boolean
  findings: GcodeScanFinding[]
  total: number
  version: number
  limits: { nozzle: number; bed: number }
}

/** `details` of `prints.dangerous_gcode` (first 20 findings). */
export interface DangerousGcodeDetails {
  total: number
  findings: GcodeScanFinding[]
  limits?: { nozzle: number; bed: number }
}

export interface FileMeta {
  triangles?: number
  bbox?: [number, number, number]
  gcode?: GcodeSummary
  project?: { plates: number; objects: number }
  /** G-code sliced by SliceDock itself. */
  trusted?: boolean
}

export interface LibraryFile {
  id: number
  ownerId: number
  ownerName: string
  kind: FileKind
  visibility: Visibility
  name: string
  ext: string
  size: number
  pinned: boolean
  createdAt: number
  updatedAt: number
  thumbnailUrl: string | null
  meta: FileMeta
}

/** 16 numbers, column-major (three.js Matrix4.elements) */
export type Mat4 = number[]

export interface SceneObject {
  id: string
  fileId: number
  name: string
  plate: number
  transform: Mat4
  /** 1-based */
  filamentSlot: number
  /** process key → value */
  overrides: Record<string, string>
}

export interface PlateDef {
  index: number
  name?: string
  bedType?: string
}

export interface FilamentSlot {
  slot: number
  presetId: string
  /** #RRGGBB */
  color: string
  cfs?: { box: number; slot: number }
  /** Filament option key (`ProfileBundle.filamentOptions`) → value for this slot only. Optional for older scenes. */
  overrides?: Record<string, string>
}

export interface SceneDoc {
  version: 1
  printerModel: PrinterModel
  machinePresetId: string
  processPresetId: string
  processOverrides: Record<string, string>
  filaments: FilamentSlot[]
  plates: PlateDef[]
  objects: SceneObject[]
}

export interface PresetSummary {
  id: string
  name: string
  kind: 'machine' | 'process' | 'filament'
  isDefault?: boolean
  filamentType?: string
  color?: string
  /** Custom filament preset (`id` = `custom:<n>`), created from the web */
  custom?: boolean
  ownerId?: number
  ownerName?: string
  scope?: FilamentPresetScope
  /** System preset the custom values are layered on */
  inherits?: string
  vendor?: string
}

export interface OptionDef {
  key: string
  label: string
  tooltip?: string
  type: 'bool' | 'int' | 'float' | 'percent' | 'floatOrPercent' | 'enum' | 'string' | 'point' | 'array'
  mode: 'simple' | 'pro' | 'develop'
  page: string
  group: string
  unit?: string
  min?: number
  max?: number
  enumValues?: { value: string; label: string }[]
}

export interface ProfileBundle {
  engineVersion: string
  printerModel: PrinterModel
  machine: PresetSummary[]
  process: PresetSummary[]
  filament: PresetSummary[]
  /** process options only */
  options: OptionDef[]
  /** filament options (Creality Print filament tab), editable per slot via `FilamentSlot.overrides` */
  filamentOptions: OptionDef[]
}

/** Flattened (inherits resolved) */
export interface ResolvedPreset {
  id: string
  values: Record<string, string>
  /** Custom filament presets: the system preset they inherit and the keys that differ from it */
  inherits?: string
  customKeys?: string[]
}

export type FilamentPresetScope = 'private' | 'shared'

/** A custom filament preset (`GET /api/filament-presets`); `values` holds only the overridden keys */
export interface FilamentPreset {
  id: number
  /** `custom:<id>`, the id used in scenes and the profile bundle */
  presetId: string
  ownerId: number
  ownerName: string
  scope: FilamentPresetScope
  printerModel: PrinterModel
  name: string
  inherits: string
  vendor: string | null
  filamentType: string | null
  color: string | null
  values: Record<string, string>
  createdAt: number
  updatedAt: number
  /** The viewer may edit/delete it (owner or admin) */
  canEdit: boolean
}

export interface FilamentPresetCreate {
  printerModel?: PrinterModel
  /** System preset id, or `custom:<n>` to start from another custom preset */
  basePresetId: string
  name: string
  vendor?: string | null
  filamentType?: string | null
  color?: string | null
  values?: Record<string, string>
  scope?: FilamentPresetScope
}

export interface FilamentPresetPatch {
  name?: string
  inherits?: string
  vendor?: string | null
  filamentType?: string | null
  color?: string | null
  /** Replaces the whole set of overridden keys */
  values?: Record<string, string>
}

export type SliceJobState = 'queued' | 'preparing' | 'slicing' | 'postprocessing' | 'done' | 'failed' | 'cancelled'

export type SliceJobStage =
  | 'queued'
  | 'building'
  | 'loading'
  | 'slicing'
  | 'walls'
  | 'infill'
  | 'supports'
  | 'toolpath'
  | 'gcode'
  | 'thumbnails'
  | 'saving'
  | 'done'

export interface SliceJob {
  id: string
  state: SliceJobState
  /** 0..100 */
  progress: number
  /** Finer-grained step of the engine run (shown under the progress bar) */
  stage?: SliceJobStage
  message?: string
  plate: number
  createdAt: number
  result?: { fileId: number; summary: GcodeSummary }
  error?: string
}

export type PrinterState =
  | 'offline'
  | 'idle'
  | 'printing'
  | 'paused'
  | 'pausing'
  /** Creality state 8: resume requested, the printer is getting back to printing */
  | 'resuming'
  | 'stopping'
  | 'complete'
  | 'failed'
  | 'aborted'
  | 'error'

export interface CfsSlot {
  box: number
  slot: number
  material: string | null
  color: string | null
  remainingPct: number | null
  /** Filament type reported by the printer (PLA, PETG…) */
  type?: string | null
  /** K2 SE external spool holder (box 0, "0A"): no CFS, no remaining % */
  external?: boolean
  /** Spool data saved on the printer (when reported) */
  vendor?: string | null
  name?: string | null
  minTemp?: number | null
  maxTemp?: number | null
  pressureAdvance?: number | null
}

export interface PrinterStatus {
  printerId: number
  online: boolean
  state: PrinterState
  nozzleTemp: number | null
  nozzleTarget: number | null
  bedTemp: number | null
  bedTarget: number | null
  chamberTemp: number | null
  progress: number | null
  layer: number | null
  totalLayers: number | null
  elapsedSec: number | null
  remainingSec: number | null
  fileName: string | null
  errorCode: number | null
  cfs: CfsSlot[] | null
  updatedAt: number
  currentPrintId: number | null
  /** false after a print ended until someone confirms the plate was emptied */
  bedClear?: boolean
  bedOccupiedSince?: number | null
  lastPrintId?: number | null
  /** Job being printed (also when started outside SliceDock); null when idle */
  job?: PrinterJobInfo | null
  /** The job that ended on the bed, kept while `bedClear === false` (final values) */
  lastJob?: LastJob | null
  /** Fans 0-100 % */
  fanPart?: number | null
  fanAux?: number | null
  fanCase?: number | null
  /** Homed axes, lowercase ("xyz", "" = none) */
  homedAxes?: string | null
  /** Toolhead position in mm */
  position?: [number, number, number] | null
  /** Highest targets the controls accept */
  maxNozzleTemp?: number | null
  maxBedTemp?: number | null
  /** Chamber light (Creality `lightSw`); null when unknown */
  lightOn?: boolean | null
  /** Speed (feedrate) and flow factors in %, null when unknown */
  speedFactor?: number | null
  flowFactor?: number | null
  /** Better time estimate while a job is active (the printer reports 0 s / bogus remaining while heating) */
  estimate?: PrinterEstimate | null
}

export interface PrinterEstimate {
  phase: 'heating' | 'preparing' | 'printing' | 'finishing' | null
  remainingSec: number | null
  /** epoch ms */
  finishesAt: number | null
  /** `printer` = printLeftTime, `slicer` = slicer estimate + heat-up (shown with "~"), `position` = file position × rate */
  source: 'printer' | 'slicer' | 'position' | null
}

/** One object of the job (Klipper exclude_object) */
export interface JobObject {
  /** Klipper name (what EXCLUDE_OBJECT NAME= takes), e.g. Object_1_id_0_copy_0 */
  name: string
  /** Friendly label, e.g. Object_1 */
  label: string
  center: [number, number] | null
  /** Footprint polygon in bed coordinates (mm) */
  polygon: [number, number][]
  excluded: boolean
  /** Byte offset when the object was excluded (moves before it were printed) */
  excludedAt?: number | null
  current: boolean
}

export type LastJobResult = 'done' | 'failed' | 'cancelled'

export interface LastJob extends PrinterJobInfo {
  endedAt: number
  result: LastJobResult
  progress: number | null
  elapsedSec: number | null
  totalLayers: number | null
  printId: number | null
}

/** POST /printers/:id/control — the server builds the G-code */
export type PrinterControlCommand =
  | { action: 'home'; axes: 'all' | 'xy' | 'x' | 'y' | 'z' }
  | { action: 'jog'; axis: 'x' | 'y' | 'z'; distance: number; feedrate: number }
  | { action: 'extrude'; length: number; speed: number }
  | { action: 'temp'; heater: 'nozzle' | 'bed'; target: number }
  | { action: 'fan'; percent: number }
  | { action: 'motors_off' }
  | { action: 'light'; on: boolean }
  /** Feedrate factor M220 (10-300 %), allowed while printing */
  | { action: 'speed_factor'; percent: number }
  /** Flow factor M221 (50-150 %), allowed while printing */
  | { action: 'flow_factor'; percent: number }

/** One sample of the printer's temperature history (every 2 s, last 60 min) */
export interface TempSample {
  t: number
  nozzle: number | null
  nozzleTarget: number | null
  bed: number | null
  bedTarget: number | null
}

export interface PrinterJobInfo {
  fileName: string
  /** byte offset the printer has reached in the G-code */
  filePosition: number | null
  fileSize: number | null
  layer: number | null
  layerCount: number | null
  /** nozzle position in mm, when known */
  toolhead: [number, number, number] | null
  slicer: string | null
  objectHeight: number | null
  /** Objects of the job (exclude object); empty when the G-code defines none */
  objects?: JobObject[]
}

/** `uploading` = G-code being sent to the printer (after `approved`, before `printing`); live views only, never stored. */
export type PrintRequestState = 'pending' | 'approved' | 'rejected' | 'uploading' | 'printing' | 'done' | 'failed' | 'cancelled'
/** Kept as an alias (it used to add `uploading`). */
export type PrintJobState = PrintRequestState

/** WS `print.upload`: SliceDock → printer upload progress (owner + admins, ≤4/s; 100 % once the printer answered). */
export interface PrintUploadProgress {
  printId: number
  printerId: number
  fileName: string
  sentBytes: number
  totalBytes: number
  /** 0-100 */
  percent: number
  etaSec: number | null
}

export interface PrintJob {
  id: number
  /** null once the user was deleted (`username` keeps the name) */
  userId: number | null
  username: string
  printerId: number
  fileId: number
  fileName: string
  grams: number | null
  seconds: number | null
  costEstimate: number | null
  state: PrintRequestState
  createdAt: number
  startedAt: number | null
  endedAt: number | null
  reason?: string
}

export interface UsageSummary {
  monthGrams: number
  /** monthGrams + pending/approved-not-started requests this month (what the monthly limit checks). */
  committedGrams?: number
  /** `/usage/me` only: bytes of all the user's files and the quota (null = unlimited). */
  storageBytes?: number
  storageQuotaBytes?: number | null
  monthCost: number | null
  limits: UserLimits
  /** Lets the Preview estimate the cost before printing */
  costPerKg: number | null
  currency: string
}

// ---------- Phase 2: engine manager (GET /api/admin/engine) ----------

export type EngineManagerState = 'idle' | 'downloading' | 'extracting' | 'testing' | 'error'

export interface EngineInstall {
  version: string
  path: string
  installedAt: number
}

export interface EngineRelease {
  version: string
  publishedAt: number
  assetUrl: string
  size: number
}

export interface EngineInfo {
  selected: EngineId
  installed: EngineInstall | null
  previous: EngineInstall | null
  latest: EngineRelease | null
  lastCheckAt: number | null
  state: EngineManagerState
  /** 0..100 */
  progress: number
  error?: string
}

export interface EngineProgress {
  state: EngineManagerState
  progress: number
  message?: string
}

// ---------- Phase 2: realtime (GET /api/ws) ----------

export type ServerMessage =
  | { type: 'printer.status'; data: PrinterStatus }
  | { type: 'slice.job'; data: SliceJob }
  | { type: 'engine.progress'; data: EngineProgress }
  | { type: 'print.update'; data: PrintJob }
  | { type: 'print.upload'; data: PrintUploadProgress }
  | { type: 'approval.pending'; data: PrintJob }
  | { type: 'appearance.defaults'; data: AppearanceDefaults }
  | { type: 'pong' }

export type ClientMessage = { type: 'subscribe'; printers: number[] } | { type: 'ping' }

// ---------- Phase 2: workspace requests (F1) ----------

/** POST /api/slice. `plate` is the 0-based index into `scene.plates` (same as SceneObject.plate). */
export interface SliceRequest {
  scene: SceneDoc
  plate: number
  /** base64 PNG without the data: prefix */
  thumbnails: { small: string; large: string }
  /** Base name of the output (project name); the server builds `<name>_plate<N>.gcode`. */
  name?: string
}

/** POST /api/projects and PUT /api/projects/:id */
export interface ProjectBody {
  name: string
  scene: SceneDoc
  /** base64 PNG (300×300) without the data: prefix */
  thumbnailPng?: string
}

// ---------- Phase 4: notifications (backend/src/modules/notifications) ----------

/** A G-code copy SliceDock uploaded to a printer for a library file */
export interface PrinterCopy {
  printerId: number
  printerName: string
  /** File name on the printer */
  name: string
}

/** What happened to one printer copy when its library file was deleted */
export interface PrinterCopyResult extends PrinterCopy {
  result: 'deleted' | 'missing' | 'skipped'
  /** Why it was skipped: in_use, unverified, offline, read_only, not_confirmed, … */
  reason?: string
}

/** Files → On the printer: one G-code file stored on the printer (`GET /api/printers/:id/files`) */
export interface PrinterStoredFile {
  name: string
  /** Full path on the printer */
  path: string
  size: number | null
  /** Epoch ms (printer clock) */
  createdAt: number | null
  /** mm */
  layerHeight: number | null
  filamentMm: number | null
  /** Rough estimate from the length */
  filamentGrams: number | null
  /** Slicer estimate (seconds) */
  estimatedSec: number | null
  materials: string[]
  /** `#rrggbb` per filament */
  colors: string[]
  software: string | null
  thumbnailUrl: string | null
  /** SliceDock uploaded it */
  uploadedBySliceDock: boolean
  libraryFileId: number | null
  /** Printing/paused or used by an open print (cannot be deleted) */
  inUse: boolean
}

/** Per-name result of `DELETE /api/printers/:id/files` */
export interface PrinterFileDeleteResult {
  name: string
  result: 'deleted' | 'missing' | 'skipped'
  /** in_use, offline, read_only, not_confirmed, … */
  reason?: string
}

export const NOTIFY_EVENTS = [
  'print.started',
  'print.finished',
  'print.failed',
  'print.cancelled',
  'print.paused',
  'approval.requested',
  'approval.approved',
  'approval.rejected',
  'limit.blocked',
  'printer.error',
  'printer.offline',
  'printer.heaters_auto_off',
  'engine.update_available',
  'engine.updated',
  'engine.update_failed',
] as const
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number]

export const NOTIFY_CHANNELS = ['discord', 'telegram', 'ntfy', 'webhook'] as const
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number]

/** Secrets come back as "********" when set; sending the mask back keeps them, '' clears. */
export interface NotifyChannelConfigs {
  discord: { enabled: boolean; webhookUrl: string | null; mention: string | null; events: NotifyEvent[] }
  telegram: { enabled: boolean; botToken: string | null; chatId: string | null; events: NotifyEvent[] }
  /** `localServer`: self-hosted on the LAN, private (192.168.x / 10.x / 172.16-31.x) addresses allowed */
  ntfy: { enabled: boolean; serverUrl: string; topic: string | null; token: string | null; localServer: boolean; events: NotifyEvent[] }
  webhook: { enabled: boolean; url: string | null; secret: string | null; events: NotifyEvent[] }
}

export interface NotifyChannelStatus {
  lastEvent: string | null
  lastAttemptAt: number | null
  lastSuccessAt: number | null
  lastError: string | null
  lastErrorAt: number | null
}

export interface AdminNotifications {
  channels: NotifyChannelConfigs
  status: Record<NotifyChannel, NotifyChannelStatus>
  events: NotifyEvent[]
  push: { subject: string; subjectFallback: boolean; devices: number }
  /** Flood protection of user-triggered events (limit.blocked, approval.requested), per user */
  rateLimit: NotifyRateLimit
}

export interface NotifyRateLimit {
  events: NotifyEvent[]
  maxPerWindow: number
  windowMinutes: number
  /** Events held back since the server started (grouped into digests) */
  heldTotal: number
  digestsSent: number
  /** Users currently held back: their digest ("N more…") goes out at `digestAt` */
  active: { userId: number; username: string | null; event: NotifyEvent; sent: number; held: number; digestAt: number | null; lastHeldAt: number | null }[]
}

export interface PushDevice {
  id: number
  userAgent: string | null
  /** Push service host (fcm.googleapis.com, web.push.apple.com, …) */
  service: string
  /** First 16 hex chars of sha256(endpoint): the browser recognises its own device with it */
  endpointHash: string
  createdAt: number
  lastSuccessAt: number | null
  failCount: number
}

export interface AccountNotifications {
  vapidPublicKey: string
  /** Events this account may receive by push (depends on the role) */
  events: NotifyEvent[]
  prefs: { events: NotifyEvent[] }
  devices: PushDevice[]
}

export interface PushSubscriptionBody {
  endpoint: string
  keys: { p256dh: string; auth: string }
  expirationTime?: number | null
}
