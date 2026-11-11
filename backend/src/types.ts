// Shared with frontend/src/types.ts (keep in sync with status/phase1-contract.md).

export type Role = 'admin' | 'user';
export type Theme = 'system' | 'light' | 'dark';
/** Appearance mode (same values as Theme). `null` on a user = inherit the admin default. */
export type ThemeMode = Theme;
export const THEME_MODES: ThemeMode[] = ['system', 'light', 'dark'];
/** Accent skins (keep in sync with frontend/src/types.ts + the [data-skin] blocks in frontend/src/index.css). */
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
] as const;
export type Skin = (typeof SKINS)[number];

/** Prepare tab settings level (keep in sync with frontend/src/types.ts). */
export const PREPARE_LEVELS = ['basic', 'advanced', 'expert'] as const;
export type PrepareLevel = (typeof PREPARE_LEVELS)[number];

/** 3D viewport navigation (PREP-UX). Keep in sync with frontend/src/types.ts + frontend/src/three/navigation.ts. */
export const NAV3D_PRESETS = ['slicedock', 'tinkercad', 'repetier', 'cad', 'blender', 'custom'] as const;
export type Nav3dPreset = (typeof NAV3D_PRESETS)[number];
export const NAV3D_BUTTONS = ['left', 'middle', 'right'] as const;
export const NAV3D_MODIFIERS = ['none', 'shift', 'ctrl', 'alt'] as const;
export interface Nav3dBinding {
  button: (typeof NAV3D_BUTTONS)[number];
  modifier: (typeof NAV3D_MODIFIERS)[number];
}
export interface Nav3dPrefs {
  preset: Nav3dPreset;
  /** Mouse mapping used when `preset === 'custom'` (zoom null = wheel only). */
  custom?: { orbit: Nav3dBinding; pan: Nav3dBinding; zoom: Nav3dBinding | null; zoomToCursor: boolean };
  /** Apply to every preset. */
  invertWheel?: boolean;
  /** Multipliers, 0.2..3 (1 = default). */
  orbitSpeed?: number;
  zoomSpeed?: number;
  defaultView?: 'iso' | 'top' | 'front';
}

/** Creality bed surfaces (Creality Print `curr_bed_type` values) a K2 SE can use. */
export const BED_SURFACES = [
  'Epoxy Resin Plate',
  'Textured PEI Plate',
  'High Temp Plate',
  'Cool Plate',
  'Engineering Plate',
  'Customized Plate',
] as const;
export type BedSurface = (typeof BED_SURFACES)[number];
export type Language = 'en' | 'es';
export type ExposureMode = 'none' | 'cloudflare' | 'nginx' | 'other';
export type PrinterModel = 'creality-k2se';

export interface User {
  id: number;
  username: string;
  email: string | null;
  role: Role;
  isActive: boolean;
  language: Language;
  /** @deprecated legacy field: `themeMode ?? 'system'`. */
  theme: Theme;
  /** Explicit choice, or null = use the admin default (`appearance.defaultMode`). */
  themeMode: ThemeMode | null;
  /** Explicit choice, or null = use the admin default (`appearance.defaultSkin`). */
  skin: Skin | null;
  /** Resolved values (user → admin default), present on the signed-in user's own responses. */
  effectiveThemeMode?: ThemeMode;
  effectiveSkin?: Skin;
  avatarUrl: string | null;
  createdAt: number;
  lastLoginAt: number | null;
  /** May use the printer motion/temperature/fan controls (admins always). */
  canControlPrinter: boolean;
  /** 3D navigation preferences; null = SliceDock defaults. */
  nav3d: Nav3dPrefs | null;
  /** Prepare tab settings level; null = use the admin default (`workspace.defaultLevel`). */
  prepareLevel: PrepareLevel | null;
  /** Process preset id used by "New project" and a fresh workspace (system name or `custom:<n>`); null = bundle default. */
  defaultProcessPreset: string | null;
  /** Filament preset id for slot 1 of a new project; null = bundle default. */
  defaultFilamentPreset: string | null;
  /** Lists the printer's own filaments (Profiles tab, Prepare picker). Off by default. */
  showPrinterFilaments: boolean;
}

export interface UserLimits {
  enabled: boolean;
  maxGramsPerPrint: number | null;
  maxGramsPerMonth: number | null;
  maxHoursPerPrint: number | null;
  requiresApproval: boolean;
}

export interface AdminUser extends User {
  limits: UserLimits;
  /** May print G-code SliceDock did not slice (uploads). Admins are always allowed; this stays as stored. */
  canPrintUploadedGcode: boolean;
}

export interface Printer {
  id: number;
  name: string;
  model: PrinterModel;
  /** Derived from `model` (driver registry). */
  kinematics: PrinterKinematics;
  host: string;
  staticIp: boolean;
  mac: string | null;
  serial: string | null;
  firmware: string | null;
  camera: { type: 'none' };
  lastSeenAt: number | null;
  /** Phase 2 "bed cleared" safety state (false after a print ended until someone confirms the bed is empty). */
  bedClear: boolean;
  bedOccupiedSince: number | null;
  lastPrintId: number | null;
  /** Bed surfaces the owner has for this printer (subset of BED_SURFACES, never empty). */
  bedSurfaces: BedSurface[];
  /** One of `bedSurfaces`. */
  defaultBedSurface: BedSurface;
}

export type PrinterKinematics = 'corexy' | 'cartesian' | 'delta' | 'unknown';

export interface PrinterModelInfo {
  id: PrinterModel;
  name: string;
  vendor: string;
  bed: { x: number; y: number; z: number };
  /** Motion system (drives the printer icon in the UI). */
  kinematics: PrinterKinematics;
}

export interface ProbeResult {
  ok: boolean;
  error?: string /* i18n code */;
  model?: string;
  firmware?: string;
  mac?: string;
  hostname?: string;
  resolvedHost?: string;
  moonraker?: boolean;
  creality?: boolean;
}

/** `GET /api/setup/status` for non-admin callers once setup is complete. */
export interface SetupStatusPublic {
  setupComplete: true;
}

export interface SetupStatus {
  setupComplete: boolean;
  lanAllowed: boolean;
  memoryLimitBytes: number | null;
  memoryOk: boolean;
  hostNetworkLikely: boolean /* true if container sees a LAN interface besides docker0/eth0 172.17.x */;
}

export interface AppConfig {
  /** `SLICEDOCK_READ_ONLY=1`: printer control (print/pause/resume/cancel/approve/bed-cleared) is disabled. */
  readOnly: boolean;
  /** Retention policy of the private library (settings `files.retention.*`). */
  files: { retentionEnabled: boolean; retentionKeep: number };
  /** Default of the print dialog's "Print calibration" toggle (setting `printing.calibrateByDefault`). */
  printing?: { calibrateByDefault: boolean };
  appName: 'SliceDock';
  version: string;
  setupComplete: boolean;
  languages: Language[];
  defaultLanguage: Language;
  /** Global appearance defaults (Admin → Settings → Appearance). */
  appearance: { defaultMode: ThemeMode; defaultSkin: Skin };
  /** Prepare tab defaults (setting `workspace.defaultLevel`). */
  workspace: { defaultLevel: PrepareLevel };
}

export interface AuditEntry {
  id: number;
  userId: number | null;
  username: string | null;
  action: string;
  target: string | null;
  meta: unknown;
  ip: string | null;
  createdAt: number;
}

export const LANGUAGES: Language[] = ['en', 'es'];

// ---- Phase 2: live printer, printing, usage (B2; status/phase2-contract.md §Shared types) ----

export type PrinterState =
  | 'offline'
  | 'idle'
  | 'printing'
  | 'paused'
  | 'pausing'
  /** Creality state 8 (restoring): resuming after a pause; the job stays shown. */
  | 'resuming'
  | 'stopping'
  | 'complete'
  | 'failed'
  | 'aborted'
  | 'error';

export interface CfsSlot {
  box: number;
  slot: number;
  material: string | null;
  color: string | null;
  /** null when there is no CFS/RFID measurement (always for the external spool). */
  remainingPct: number | null;
  /** Filament type reported by the printer (PLA, PETG…), when known. */
  type?: string | null;
  /** The external spool holder (box 0), not a CFS slot. */
  external?: boolean;
  /** Raw slot details as the printer reports them (`boxsInfo.materialBoxs[].materials[]`). */
  vendor?: string | null;
  name?: string | null;
  minTemp?: number | null;
  maxTemp?: number | null;
  /** Pressure advance (`pressure`). */
  pressureAdvance?: number | null;
  /** RFID tag id; null for an empty slot or Creality's placeholder (`00001`, `0`, `''`). */
  rfid?: string | null;
  /** Same as `remainingPct`: only a CFS/RFID measurement, never the external holder's constant 100. */
  percent?: number | null;
  /** The slot the printer currently feeds from. */
  selected?: boolean;
  /** Creality `editStatus` (1 = editable on the printer). */
  editStatus?: number | null;
}

export interface PrinterStatus {
  printerId: number;
  online: boolean;
  state: PrinterState;
  nozzleTemp: number | null;
  nozzleTarget: number | null;
  bedTemp: number | null;
  bedTarget: number | null;
  chamberTemp: number | null;
  progress: number | null;
  layer: number | null;
  totalLayers: number | null;
  elapsedSec: number | null;
  remainingSec: number | null;
  fileName: string | null;
  errorCode: number | null;
  cfs: CfsSlot[] | null;
  updatedAt: number;
  currentPrintId: number | null;
  /** False after a print ended (material may be on the bed) until a user confirms it was removed. */
  bedClear: boolean;
  bedOccupiedSince: number | null;
  lastPrintId: number | null;
  /** Live view of the running job (Moonraker), refreshed ~1 s while printing; null otherwise. */
  job: LiveJob | null;
  /** The job that ended on this bed, kept while `bedClear === false` (final values, objects); null otherwise. */
  lastJob: LastJob | null;
  /** Part-cooling / auxiliary / case fan, 0-100 % (null when unknown). */
  fanPart: number | null;
  fanAux: number | null;
  fanCase: number | null;
  /** Homed axes, lowercase (`"xyz"`, `""` = none homed; null when unknown). */
  homedAxes: string | null;
  /** Toolhead position in mm (null when unknown). */
  position: [number, number, number] | null;
  /** Highest target the controls accept (min of the printer's firmware limit and the K2 SE profile maxima). */
  maxNozzleTemp: number | null;
  maxBedTemp: number | null;
  /** Chamber/LED light (Creality WS `lightSw`); null when unknown. */
  lightOn: boolean | null;
  /** Speed (feedrate) factor in % (Moonraker `gcode_move.speed_factor`, else Creality `curFeedratePct`, else the last value SliceDock set); null when unknown. */
  speedFactor: number | null;
  /** Flow (extrusion) factor in % (`gcode_move.extrude_factor` / `curFlowratePct` / last set); null when unknown. */
  flowFactor: number | null;
  /**
   * SliceDock's time estimate for the active job (null when nothing runs). Use this instead of `remainingSec`,
   * which the printer reports as 0 / implausible values while heating, homing and leveling.
   */
  estimate?: PrintEta | null;
}

export type PrintEtaPhase = 'heating' | 'preparing' | 'printing' | 'finishing';

export interface PrintEta {
  phase: PrintEtaPhase | null;
  /** Never 0 while the job is not finished; null when unknown. */
  remainingSec: number | null;
  /** Epoch ms; null while paused or unknown. */
  finishesAt: number | null;
  /** `printer` = printLeftTime (plausible), `slicer` = slicer estimate (+ heat-up), `position` = file position × slicer/elapsed rate. */
  source: 'printer' | 'slicer' | 'position' | null;
}

/** One sample of the temperature history (`GET /api/printers/:id/temps`). */
export interface TempSample {
  /** epoch ms */
  t: number;
  nozzle: number | null;
  nozzleTarget: number | null;
  bed: number | null;
  bedTarget: number | null;
}

/** One object of the job (Klipper `exclude_object`, defined by `EXCLUDE_OBJECT_DEFINE` in the G-code). */
export interface JobObject {
  /** Klipper name, e.g. `Object_1_id_0_copy_0` (what `EXCLUDE_OBJECT NAME=` takes). */
  name: string;
  /** Friendly label, e.g. `Object_1` or `Object_1 (2)`. */
  label: string;
  center: [number, number] | null;
  /** Footprint polygon in bed coordinates (mm). */
  polygon: [number, number][];
  excluded: boolean;
  /** Byte offset of the job when SliceDock first saw the object excluded (moves before it were printed). */
  excludedAt: number | null;
  /** Currently being printed. */
  current: boolean;
}

export type LastJobResult = 'done' | 'failed' | 'cancelled';

/** The finished job kept on the Printer tab until the bed is cleared. */
export interface LastJob extends LiveJob {
  endedAt: number;
  result: LastJobResult;
  progress: number | null;
  elapsedSec: number | null;
  totalLayers: number | null;
  /** SliceDock print id (null for prints started elsewhere). */
  printId: number | null;
}

export interface LiveJob {
  fileName: string;
  /** Byte offset the printer is executing (for the live G-code view). */
  filePosition: number | null;
  fileSize: number | null;
  layer: number | null;
  layerCount: number | null;
  toolhead: [number, number, number] | null;
  slicer: string | null;
  objectHeight: number | null;
  /** Objects of the job (empty when the G-code defines none). */
  objects: JobObject[];
}

/** `POST /api/printers/:id/control` (the server builds the G-code; raw G-code is never accepted). */
export type PrinterControlCommand =
  | { action: 'home'; axes: 'all' | 'xy' | 'x' | 'y' | 'z' }
  | { action: 'jog'; axis: 'x' | 'y' | 'z'; distance: number; feedrate: number }
  | { action: 'extrude'; length: number; speed: number }
  | { action: 'temp'; heater: 'nozzle' | 'bed'; target: number }
  | { action: 'fan'; percent: number }
  /** Chamber light (Creality WS `lightSw`, not G-code). Allowed while printing, like the fan. */
  | { action: 'light'; on: boolean }
  /** Feedrate factor `M220 S<10-300>` (allowed while printing). */
  | { action: 'speed_factor'; percent: number }
  /** Extrusion (flow) factor `M221 S<50-150>` (allowed while printing). */
  | { action: 'flow_factor'; percent: number }
  | { action: 'motors_off' };

/**
 * `uploading` (additive): the G-code is being sent to the printer (between `approved` and `printing`). It is not
 * stored: the row stays `approved` in the DB while SliceDock streams the file, and API/WS views report `uploading`.
 */
export type PrintRequestState = 'pending' | 'approved' | 'uploading' | 'rejected' | 'printing' | 'done' | 'failed' | 'cancelled';

/** WS `print.upload` (owner + admins, at most 4/s per print, always the first and the 100 % frame). */
export interface PrintUploadProgress {
  printId: number;
  printerId: number;
  fileName: string;
  sentBytes: number;
  totalBytes: number;
  /** 0-100 (integer). */
  percent: number;
  /** Seconds left at the current average rate (null until measurable). */
  etaSec: number | null;
}

export interface PrintJob {
  id: number;
  /** null once the user was deleted (`username` keeps the snapshot). */
  userId: number | null;
  username: string;
  printerId: number;
  fileId: number;
  fileName: string;
  grams: number | null;
  seconds: number | null;
  costEstimate: number | null;
  state: PrintRequestState;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  reason?: string;
  /** "Print calibration" requested (Creality `enableSelfTest: 1`). Always sent by the server. */
  calibrate?: boolean;
}

export interface UsageSummary {
  monthGrams: number;
  /** monthGrams + this month's requests still pending or approved-but-not-started (what the monthly limit checks). */
  committedGrams: number;
  /** `GET /api/usage/me` only: bytes of all the user's files, and the quota (null = unlimited). */
  storageBytes?: number;
  storageQuotaBytes?: number | null;
  monthCost: number | null;
  limits: UserLimits;
  /** Settings `limits.costPerKg` / `limits.currency`, so clients can price estimates the same way. */
  costPerKg: number | null;
  currency: string;
}

// ---- Phase 2: files, projects, profiles, slicing, engine (B1; status/phase2-contract.md §Shared types) ----

export type FileKind = 'model' | 'project' | 'gcode';
export type Visibility = 'private' | 'shared';

export interface GcodeSummary {
  printSeconds: number | null;
  filamentGrams: number[];
  filamentMm: number[];
  layers: number | null;
  printerModel: string | null;
  slicer: string | null;
  /**
   * Where printSeconds/filamentGrams/layers come from: `slicer` = SliceDock sliced the file (summary stored at slice
   * time, file immutable); `computed` = parsed from the moves server-side (uploads). Absent on legacy rows.
   */
  estimateSource?: 'slicer' | 'computed';
  /** Uploads only: what the file's own comments claim (display only, never used for limits). */
  declared?: { printSeconds: number | null; filamentGrams: number[]; layers: number | null };
  /** Uploads only: dangerous-command scan (finding #3). Absent on sliced files and legacy rows. */
  scan?: GcodeScan;
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
  | 'unknown_command';

export interface GcodeScanFinding {
  /** 1-based line number */
  line: number;
  /** The command line (comment stripped, upper case, max 120 chars). */
  command: string;
  reason: GcodeScanReason;
  /** e.g. `S350 > 280` */
  detail?: string;
}

/** Files → On the printer: one G-code file stored on the printer (`GET /api/printers/:id/files`). */
export interface PrinterStoredFile {
  name: string;
  /** Full path on the printer. */
  path: string;
  size: number | null;
  /** Epoch ms (printer clock; null when the firmware reports none). */
  createdAt: number | null;
  /** mm (Creality `floorHeight` / 100). */
  layerHeight: number | null;
  filamentMm: number | null;
  /** Rough estimate from the length (1.75 mm, material density); null when unknown. */
  filamentGrams: number | null;
  /** Slicer estimate (seconds). */
  estimatedSec: number | null;
  materials: string[];
  /** `#rrggbb` per extruder/filament. */
  colors: string[];
  software: string | null;
  /** `/api/printers/:id/files/thumbnail?name=…` or null. */
  thumbnailUrl: string | null;
  /** SliceDock uploaded it (a `printer_uploads` record that is still active). */
  uploadedBySliceDock: boolean;
  /** Library file it was uploaded from (still in the library), when known. */
  libraryFileId: number | null;
  /** Printing/paused file or file of an open print (cannot be deleted). */
  inUse: boolean;
}

export interface GcodeScan {
  ok: boolean;
  /** First 50 findings (see `total`). */
  findings: GcodeScanFinding[];
  total: number;
  version: number;
  /** Temperature maxima the scan used (°C). */
  limits: { nozzle: number; bed: number };
}

export interface FileMeta {
  triangles?: number;
  bbox?: [number, number, number];
  gcode?: GcodeSummary;
  project?: { plates: number; objects: number };
  /** G-code sliced by SliceDock itself (its summary is trusted; content verified by sha256 before printing). */
  trusted?: boolean;
}

export interface LibraryFile {
  id: number;
  ownerId: number;
  ownerName: string;
  kind: FileKind;
  visibility: Visibility;
  name: string;
  ext: string;
  size: number;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  thumbnailUrl: string | null;
  meta: FileMeta;
}

/** 16 numbers, column-major (three.js Matrix4.elements). */
export type Mat4 = number[];

export interface SceneObject {
  id: string;
  fileId: number;
  name: string;
  plate: number;
  transform: Mat4;
  /** 1-based */
  filamentSlot: number;
  /** process key → value */
  overrides: Record<string, string>;
}

export interface PlateDef {
  index: number;
  name?: string;
  bedType?: string;
}

export interface FilamentSlot {
  slot: number;
  presetId: string;
  /** #RRGGBB */
  color: string;
  cfs?: { box: number; slot: number };
  /** Filament option key (`ProfileBundle.filamentOptions`) → value for this slot only. Optional for older scenes. */
  overrides?: Record<string, string>;
}

export interface SceneDoc {
  version: 1;
  printerModel: PrinterModel;
  machinePresetId: string;
  processPresetId: string;
  processOverrides: Record<string, string>;
  filaments: FilamentSlot[];
  plates: PlateDef[];
  objects: SceneObject[];
}

export type PresetKind = 'machine' | 'process' | 'filament';

export interface PresetSummary {
  id: string;
  name: string;
  kind: PresetKind;
  isDefault?: boolean;
  filamentType?: string;
  color?: string;
  /** Custom filament preset (`id` = `custom:<n>`), created from the web (FILAMENTS). */
  custom?: boolean;
  ownerId?: number;
  /** Owner's username (custom presets). */
  ownerName?: string;
  scope?: FilamentPresetScope;
  /** System preset the custom values are layered on. */
  inherits?: string;
  vendor?: string;
}

export interface OptionDef {
  key: string;
  label: string;
  tooltip?: string;
  type: 'bool' | 'int' | 'float' | 'percent' | 'floatOrPercent' | 'enum' | 'string' | 'point' | 'array';
  mode: 'simple' | 'pro' | 'develop';
  page: string;
  group: string;
  unit?: string;
  min?: number;
  max?: number;
  enumValues?: { value: string; label: string }[];
}

export interface ProfileBundle {
  engineVersion: string;
  printerModel: PrinterModel;
  machine: PresetSummary[];
  process: PresetSummary[];
  filament: PresetSummary[];
  /** process options only */
  options: OptionDef[];
  /** filament options (Creality Print filament tab), editable per slot via `FilamentSlot.overrides` */
  filamentOptions: OptionDef[];
}

/** Flattened (inherits resolved). */
export interface ResolvedPreset {
  id: string;
  values: Record<string, string>;
  /** Custom filament presets: the system preset they inherit and the keys that differ from it. */
  inherits?: string;
  customKeys?: string[];
}

export type FilamentPresetScope = 'private' | 'shared';

/** A custom filament preset (`GET /api/filament-presets`). `values` holds only the overridden keys. */
export interface FilamentPreset {
  /** Numeric row id; the preset id used in scenes/bundles is `custom:<id>`. */
  id: number;
  presetId: string;
  ownerId: number;
  ownerName: string;
  scope: FilamentPresetScope;
  printerModel: PrinterModel;
  name: string;
  inherits: string;
  vendor: string | null;
  filamentType: string | null;
  color: string | null;
  values: Record<string, string>;
  createdAt: number;
  updatedAt: number;
  /** The viewer may edit/delete it (owner, or admin). */
  canEdit: boolean;
}

/** A user process profile (`GET /api/process-profiles`). `values` holds only the keys overridden on `inherits`. */
export interface ProcessProfile {
  /** Numeric row id; the preset id used in scenes/bundles is `custom:<id>`. */
  id: number;
  presetId: string;
  ownerId: number;
  ownerName: string;
  scope: FilamentPresetScope;
  printerModel: PrinterModel;
  name: string;
  inherits: string;
  values: Record<string, string>;
  createdAt: number;
  updatedAt: number;
  /** The viewer may edit, rename, delete and share it (owner, or admin). */
  canEdit: boolean;
}

export type ProfileFileKind = 'process' | 'filament';

/** `POST /api/profile-files/import` result: what was created and what was left out, and why. */
export interface ProfileImportReport {
  created: { kind: ProfileFileKind; id: number; presetId: string; name: string; inherits: string; keys: number }[];
  /** Whole entries (archive files or the uploaded json) that produced no profile. */
  skipped: { entry: string; reason: string }[];
  /** Keys left out of a created profile. `reason`: unsafe | unsupported | a value check (`range 0..300`, `number`, …). */
  dropped: { profile: string; key: string; reason: string }[];
  /** `inherits` that is not a K2 SE system preset, and the parent used instead. */
  remapped: { profile: string; from: string; to: string }[];
  /** Name already taken (or a system preset name): the profile was saved under `to`. */
  renamed: { from: string; to: string }[];
}

// ---- printer-side presets ----

/** One filament of the printer's own material list (WS `retMaterials`), mapped onto SliceDock's system presets. */
export interface PrinterMaterial {
  /** Creality material id (`base.id`, e.g. "01001"). */
  id: string;
  name: string;
  brand: string;
  /** Material type (`base.meterialType`, e.g. "PLA"). */
  type: string;
  /** First official colour (`base.colors[0]`), `#RRGGBB`. */
  color: string | null;
  /** Official colours (at most 12). */
  colors: string[];
  minTemp: number | null;
  maxTemp: number | null;
  /** `kvParam.nozzle_temperature` / `hot_plate_temp`. */
  nozzleTemp: number | null;
  bedTemp: number | null;
  /** `kvParam.inherits` as the printer sends it. */
  inherits: string;
  /** The SliceDock system preset it maps to (exact `inherits`, else same family / material); null when none. */
  systemPresetId: string | null;
  /** Settings that differ from that system preset (printer value, SliceDock value), at most 50. */
  differs: { key: string; printer: string; slicedock: string | null; kept: boolean }[];
  /** What "Duplicate as my filament" stores: the differing values that passed the same screening as an import. */
  values: Record<string, string>;
}

export interface PrinterMaterialsView {
  /** The viewer's "Show printer filaments" preference; when false nothing was asked from the printer. */
  enabled: boolean;
  printerId: number | null;
  online: boolean;
  /** Epoch ms of the cached answer (null = never fetched). */
  fetchedAt: number | null;
  materials: PrinterMaterial[];
  /** Error code of the last failed fetch (e.g. `printer_materials.no_answer`). */
  error?: string;
}

/** Status of the profiles backup on each printer (Admin → Printers). */
export interface ProfilesBackupStatus {
  enabled: boolean;
  /** Path in the printer's Moonraker `config` root. */
  path: string;
  printers: {
    printerId: number;
    name: string;
    online: boolean;
    lastBackupAt: number | null;
    lastAttemptAt: number | null;
    /** Error code of the last failed attempt (cleared by a success). */
    lastError: string | null;
    /** A change is waiting to be written (debounce, or the printer is offline). */
    pending: boolean;
    process: number;
    filament: number;
  }[];
}

/** What a restore of the printer's backup would do (Admin → Printers → Restore). */
export interface ProfilesBackupPreview {
  printerId: number;
  createdAt: string;
  slicedockVersion: string;
  counts: { process: number; filament: number; create: number; unchanged: number; renamed: number; ownerMapped: number };
  items: {
    kind: ProfileFileKind;
    name: string;
    owner: string;
    /** The SliceDock user it will belong to (unknown owners → the restoring admin). */
    restoreOwner: string;
    ownerKnown: boolean;
    shared: boolean;
    action: 'create' | 'unchanged';
    /** Name after de-duplication ("Name (2)") when `action` is create. */
    finalName: string;
  }[];
}

export type SliceJobState = 'queued' | 'preparing' | 'slicing' | 'postprocessing' | 'done' | 'failed' | 'cancelled';

export interface SliceJob {
  id: string;
  state: SliceJobState;
  /** 0..100 */
  progress: number;
  message?: string;
  /**
   * Stable stage id for i18n: queued | building | loading | slicing | walls | infill | supports | toolpath | gcode |
   * thumbnails | saving | done (B1, see status/b1-notes.md). `message` stays the engine's English text.
   */
  stage?: string;
  plate: number;
  createdAt: number;
  result?: { fileId: number; summary: GcodeSummary };
  error?: string;
}

export type EngineState = 'idle' | 'downloading' | 'extracting' | 'testing' | 'error';

export interface EngineInstall {
  version: string;
  path: string;
  installedAt: number;
  /** sha256 of the downloaded AppImage (absent for the fake engine / old installs). */
  sha256?: string;
}

export interface EngineRelease {
  version: string;
  publishedAt: string;
  assetUrl: string;
  size: number;
  /** sha256 from the GitHub API asset `digest`, when GitHub published one (verified on download). */
  sha256?: string | null;
}

export interface EngineStatus {
  selected: 'creality' | 'orca';
  installed: EngineInstall | null;
  previous: EngineInstall | null;
  latest: EngineRelease | null;
  lastCheckAt: number | null;
  state: EngineState;
  progress: number;
  error?: string;
  /** The installed engine's binary is missing (damaged install): slicing fails until it is reinstalled. */
  broken?: true;
}
