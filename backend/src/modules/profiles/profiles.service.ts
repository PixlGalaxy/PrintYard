import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { AppError, notFound } from '../../errors.js';
import { resourcesDir } from '../../lib/resources.js';
import { logger } from '../../logger.js';
import { defaultFilamentColour, hexColour } from './filament-colours.js';
import { localizeOptions, optionText } from './i18n.js';
import type {
  FilamentPresetScope,
  Language,
  OptionDef,
  PresetKind,
  PresetSummary,
  PrinterModel,
  ProfileBundle,
  ResolvedPreset,
  Role,
} from '../../types.js';

/** Raw preset value as stored in the vendor JSON: scalars are strings, per-extruder/filament values arrays of strings. */
export type RawValue = string | string[];
export type RawPreset = Record<string, RawValue>;

/** Keys that describe the preset itself, not a slicer setting. */
export const META_KEYS = new Set([
  'type',
  'from',
  'inherits',
  'instantiation',
  'setting_id',
  'filament_id',
  'name',
  'compatible_printers',
  'compatible_printers_condition',
  'compatible_prints',
  'compatible_prints_condition',
  'renamed_from',
  'version',
  'description',
  'is_custom_defined',
  'base_id',
]);

/** Where the vendor JSON lives: the bundled snapshot or an installed engine's `resources/profiles`. */
export interface ProfileSource {
  /** `Creality.json` vendor index. */
  indexFile: string;
  /** Folder that the index's `sub_path` entries are relative to. */
  vendorDir: string;
  /** Engine version these profiles ship with (bundled snapshot: the version it was copied from). */
  engineVersion: string;
  /** true when read from an installed engine. */
  fromEngine: boolean;
}

/** Bundled snapshot copied from Creality Print (see backend/resources/profiles/creality/README.md). */
export const BUNDLED_PROFILES_VERSION = '7.3.1';

export function bundledProfileSource(): ProfileSource {
  const dir = join(resourcesDir(), 'profiles', 'creality');
  return { indexFile: join(dir, 'Creality.json'), vendorDir: dir, engineVersion: BUNDLED_PROFILES_VERSION, fromEngine: false };
}

/** Profiles inside an extracted AppImage (`<root>/resources/profiles/Creality.json` + `Creality/`). */
export function engineProfileSource(engineRoot: string, version: string): ProfileSource | null {
  const profiles = join(engineRoot, 'resources', 'profiles');
  const indexFile = join(profiles, 'Creality.json');
  if (!existsSync(indexFile)) return null;
  return { indexFile, vendorDir: join(profiles, 'Creality'), engineVersion: version, fromEngine: true };
}

/** SliceDock printer model → vendor machine model name (`printer_model` in the machine presets). */
export const PRINTER_MODELS: Record<PrinterModel, { vendorModel: string }> = {
  'creality-k2se': { vendorModel: 'Creality K2 SE' },
};

interface IndexEntry {
  name: string;
  sub_path: string;
}

interface PresetEntry {
  name: string;
  kind: PresetKind;
  raw: RawPreset;
}

export interface PrinterProfiles {
  source: ProfileSource;
  printerModel: PrinterModel;
  vendorModel: string;
  /** Machine model JSON (`* _model.json`). */
  model: RawPreset;
  machine: PresetEntry[];
  process: PresetEntry[];
  filament: PresetEntry[];
  /** name → flattened values (meta keys removed). */
  flat: Map<string, RawPreset>;
}

const KINDS: { list: string; kind: PresetKind }[] = [
  { list: 'machine_list', kind: 'machine' },
  { list: 'process_list', kind: 'process' },
  { list: 'filament_list', kind: 'filament' },
];

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function insideDir(dir: string, file: string): boolean {
  const root = resolve(dir);
  const target = resolve(file);
  return target.startsWith(root + sep);
}

/** "x" or ["x", ...] → "x" (first element); used for filament values that are one-element arrays. */
export function firstValue(v: RawValue | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

/** The engine's own text form: arrays are comma-joined (e.g. printable_area "0x0,220x0,…"). */
export function serializeValue(v: RawValue): string {
  return Array.isArray(v) ? v.join(',') : v;
}

/**
 * Loads only what one printer model needs from a vendor index: its machine presets, the process/filament presets
 * whose `compatible_printers` name one of them, and every `inherits` ancestor. Files are only read when their index
 * name mentions the model (all official K2 SE presets do) or when they are an ancestor.
 */
export function loadPrinterProfiles(source: ProfileSource, printerModel: PrinterModel): PrinterProfiles {
  const vendorModel = PRINTER_MODELS[printerModel]?.vendorModel;
  if (!vendorModel) throw notFound();
  const index = readJson(source.indexFile) as Record<string, unknown>;
  const paths = new Map<string, { sub: string; kind: PresetKind | 'model' }>();
  for (const { list, kind } of [...KINDS, { list: 'machine_model_list', kind: 'model' as const }]) {
    const entries = Array.isArray(index[list]) ? (index[list] as IndexEntry[]) : [];
    for (const e of entries) {
      if (typeof e?.name === 'string' && typeof e?.sub_path === 'string') paths.set(e.name, { sub: e.sub_path, kind });
    }
  }

  const rawCache = new Map<string, RawPreset>();
  const readPreset = (name: string): RawPreset => {
    const cached = rawCache.get(name);
    if (cached) return cached;
    const entry = paths.get(name);
    if (!entry) throw new Error(`Profile "${name}" is not in the vendor index`);
    const file = join(source.vendorDir, entry.sub);
    if (!insideDir(source.vendorDir, file)) throw new Error(`Profile path escapes the vendor folder: ${entry.sub}`);
    const raw = readJson(file) as RawPreset;
    rawCache.set(name, raw);
    return raw;
  };

  const flat = new Map<string, RawPreset>();
  const flatten = (name: string, depth = 0): RawPreset => {
    const done = flat.get(name);
    if (done) return done;
    if (depth > 16) throw new Error(`Inheritance chain too deep at "${name}"`);
    const raw = readPreset(name);
    const parentName = typeof raw.inherits === 'string' && raw.inherits !== '' ? raw.inherits : null;
    // Shallow per-key override, arrays replaced whole (PresetBundle::load_vendor_configs_from_json).
    const merged: RawPreset = parentName ? { ...flatten(parentName, depth + 1) } : {};
    for (const [k, v] of Object.entries(raw)) if (!META_KEYS.has(k)) merged[k] = v;
    flat.set(name, merged);
    return merged;
  };

  const modelName = [...paths.entries()].find(([n, e]) => e.kind === 'model' && n === vendorModel)?.[0];
  if (!modelName) throw new Error(`Machine model "${vendorModel}" not found in ${source.indexFile}`);
  const model = readPreset(modelName);
  const shortName = vendorModel.replace(/^Creality\s+/, '');

  const result: PrinterProfiles = { source, printerModel, vendorModel, model, machine: [], process: [], filament: [], flat };
  const candidates = (kind: PresetKind) =>
    [...paths.entries()].filter(([n, e]) => e.kind === kind && n.includes(shortName)).map(([n]) => n);

  for (const name of candidates('machine')) {
    const raw = readPreset(name);
    if (raw.instantiation !== 'true' || raw.printer_model !== vendorModel) continue;
    flatten(name);
    result.machine.push({ name, kind: 'machine', raw });
  }
  const machineNames = new Set(result.machine.map((m) => m.name));
  for (const kind of ['process', 'filament'] as const) {
    for (const name of candidates(kind)) {
      const raw = readPreset(name);
      if (raw.instantiation !== 'true') continue;
      const compatible = Array.isArray(raw.compatible_printers) ? raw.compatible_printers : [];
      if (!compatible.some((p) => machineNames.has(p))) continue;
      const merged = flatten(name);
      // Official filaments ship an empty colour: give them their first official colour (filament-colours.ts) so the
      // preset list, new slots, new custom filaments and the 3MF all agree.
      if (kind === 'filament' && !hexColour(firstValue(merged.default_filament_colour))) {
        const colour = defaultFilamentColour(name);
        merged.default_filament_colour = Array.isArray(merged.default_filament_colour) ? [colour] : colour;
      }
      result[kind].push({ name, kind, raw });
    }
  }
  return result;
}

// ---- option definitions (crealityprint-option-modes.json) ----

interface RawOption {
  key: string;
  type: string;
  mode: string;
  label?: string;
  sidetext?: string;
  enum_values?: string[];
  ui?: { tab: string; page: string; group: string; tab_line: number }[];
}

const TYPE_MAP: Record<string, OptionDef['type']> = {
  coBool: 'bool',
  coInt: 'int',
  coFloat: 'float',
  coPercent: 'percent',
  coFloatOrPercent: 'floatOrPercent',
  coEnum: 'enum',
  coString: 'string',
  coPoint: 'point',
  coPoint3: 'point',
};

const MODE_MAP: Record<string, OptionDef['mode']> = { comSimple: 'simple', comAdvanced: 'pro', comDevelop: 'develop' };

/** Plural (per-extruder / per-filament) types: one value per filament slot, so the slot edits a scalar. */
const PER_SLOT_TYPE_MAP: Record<string, OptionDef['type']> = {
  coBools: 'bool',
  coInts: 'int',
  coFloats: 'float',
  coPercents: 'percent',
  coFloatsOrPercents: 'floatOrPercent',
  coEnums: 'enum',
  coStrings: 'string',
  coPoints: 'point',
};

const optionCache = new Map<string, OptionDef[]>();
let vectorKeys: Set<string> | null = null;

/**
 * true for vector options (`coFloats`, `coStrings`, …: one value per extruder / filament), which Creality Print
 * writes as JSON arrays in preset files. `filament_<key>` overrides are vectors like their extruder originals.
 */
export function isVectorOption(key: string): boolean {
  if (!vectorKeys) {
    const data = readJson(join(resourcesDir(), 'crealityprint-option-modes.json')) as { options: RawOption[] };
    vectorKeys = new Set(data.options.filter((o) => Object.hasOwn(PER_SLOT_TYPE_MAP, o.type)).map((o) => o.key));
  }
  return vectorKeys.has(key) || (key.startsWith('filament_') && (FILAMENT_OVERRIDE_BASE_KEYS as readonly string[]).includes(key.slice(9)));
}

/**
 * Extruder options a filament can override (Orca/Creality `filament_extruder_override_keys`, as present in the K2 SE
 * filament profiles), in the order of the "Setting Overrides" page. The override key is `filament_<key>`; the
 * value `nil` means "use the printer's value".
 */
export const FILAMENT_OVERRIDE_BASE_KEYS = [
  'retraction_length',
  'z_hop',
  'z_hop_types',
  'retract_lift_above',
  'retract_lift_below',
  'retract_lift_enforce',
  'retraction_speed',
  'deretraction_speed',
  'retract_restart_extra',
  'retraction_minimum_travel',
  'retract_when_changing_layer',
  'wipe',
  'wipe_distance',
  'retract_before_wipe',
] as const;

/** Options shown in one Creality Print settings tab, in UI order (tab line). */
function optionDefsForTab(tab: 'process' | 'filament'): OptionDef[] {
  const cached = optionCache.get(tab);
  if (cached) return cached;
  const file = join(resourcesDir(), 'crealityprint-option-modes.json');
  const data = readJson(file) as { options: RawOption[] };
  const withLine: { def: OptionDef; line: number }[] = [];
  const toDef = (o: RawOption, key: string, page: string, group: string): OptionDef => {
    const unit = o.sidetext?.trim();
    // Tooltip and enum labels from PrintConfig.cpp (English; translated per request in localizeOptions).
    const text = optionText(o.key);
    const labels = text?.enumLabels?.length === o.enum_values?.length ? text?.enumLabels : undefined;
    const type = TYPE_MAP[o.type] ?? (tab === 'filament' ? PER_SLOT_TYPE_MAP[o.type] : undefined) ?? 'array';
    return {
      key,
      label: o.label?.trim() || o.key,
      ...(text?.tooltip && { tooltip: text.tooltip }),
      type,
      mode: MODE_MAP[o.mode] ?? 'pro',
      page,
      group,
      ...(unit && { unit }),
      ...((o.type === 'coPercent' || o.type === 'coPercents') && { min: 0, max: 100 }),
      ...(o.enum_values?.length && { enumValues: o.enum_values.map((v, i) => ({ value: v, label: labels?.[i] ?? v })) }),
    };
  };
  for (const o of data.options) {
    const ui = o.ui?.find((u) => u.tab === tab);
    if (!ui) continue;
    withLine.push({ def: toDef(o, o.key, ui.page, ui.group), line: ui.tab_line });
  }
  if (tab === 'filament') {
    // Creality Print's filament "Setting Overrides" page (TabFilament, after Cooling): per-filament copies of the
    // extruder retraction options, `filament_<key>`. The option-modes JSON only lists the extruder originals, so
    // label/type/unit/group come from those.
    const byKey = new Map(data.options.map((o) => [o.key, o]));
    const coolingEnd = Math.max(0, ...withLine.filter((x) => x.def.page === 'Cooling').map((x) => x.line));
    FILAMENT_OVERRIDE_BASE_KEYS.forEach((base, i) => {
      const o = byKey.get(base);
      if (!o) return;
      const group = o.ui?.find((u) => u.tab === 'printer_extruder')?.group ?? 'Retraction';
      withLine.push({ def: toDef(o, `filament_${base}`, 'Setting Overrides', group), line: coolingEnd + 0.001 * (i + 1) });
    });
  }
  withLine.sort((a, b) => a.line - b.line);
  const defs = withLine.map((x) => x.def);
  optionCache.set(tab, defs);
  return defs;
}

/** Process options shown in the Creality Print process tab, in UI order (tab line). */
export function processOptionDefs(): OptionDef[] {
  return optionDefsForTab('process');
}

/** Keys a client must never set: they run code or change where/what the engine writes. */
export const UNSAFE_OPTION_KEY = /gcode|post_process|filename|thumbnail|printhost|print_host|upload/;

/**
 * Filament options (Creality Print filament tab), in UI order. Raw G-code templates (`filament_start_gcode`, …)
 * are left out because they cannot be overridden.
 */
export function filamentOptionDefs(): OptionDef[] {
  return optionDefsForTab('filament').filter((o) => !UNSAFE_OPTION_KEY.test(o.key));
}

// ---- custom filament presets (FILAMENTS) ----

/** Scene/bundle id prefix of custom filament presets: `custom:<row id>`. */
export const CUSTOM_FILAMENT_PREFIX = 'custom:';

/** Row id of a `custom:<n>` preset id (0 when malformed), or null for system preset ids. */
export function customFilamentId(presetId: string): number | null {
  if (!presetId.startsWith(CUSTOM_FILAMENT_PREFIX)) return null;
  const rest = presetId.slice(CUSTOM_FILAMENT_PREFIX.length);
  const n = /^\d{1,15}$/.test(rest) ? Number(rest) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

export interface ProfileViewer {
  id: number;
  role: Role;
}

/** What the profiles service needs from a custom filament preset row. */
export interface CustomFilamentRecord {
  id: number;
  ownerId: number;
  ownerName: string;
  scope: FilamentPresetScope;
  name: string;
  inherits: string;
  vendor: string | null;
  filamentType: string | null;
  color: string | null;
  values: Record<string, string>;
}

/** Implemented by FilamentPresetsService; returns only presets the viewer may use (own private + shared). */
export interface CustomFilamentProvider {
  usable(printerModel: PrinterModel, viewer: ProfileViewer): CustomFilamentRecord[];
  usableById(printerModel: PrinterModel, id: number, viewer: ProfileViewer): CustomFilamentRecord | null;
}

/** What the profiles service needs from a user process profile row. */
export interface CustomProcessRecord {
  id: number;
  ownerId: number;
  ownerName: string;
  scope: FilamentPresetScope;
  name: string;
  inherits: string;
  values: Record<string, string>;
}

/** Implemented by ProcessProfilesService; returns only profiles the viewer may use (own + shared; admins: any by id). */
export interface CustomProcessProvider {
  usable(printerModel: PrinterModel, viewer: ProfileViewer): CustomProcessRecord[];
  usableById(printerModel: PrinterModel, id: number, viewer: ProfileViewer): CustomProcessRecord | null;
}

/**
 * A process preset resolved for a project. A user profile resolves to its system parent (`raw`) plus its own values
 * (`values`), which the project build applies through the same path as scene overrides (checked, then layered).
 */
export interface ProcessResolution {
  /** `print_settings_id` */
  settingsId: string;
  /** `inherits_group[0]` ('' for system presets) */
  inherits: string;
  raw: RawPreset;
  values: Record<string, string>;
}

/** A filament preset resolved for a project: flattened values plus what the 3MF needs to keep them. */
export interface FilamentResolution {
  /** `filament_settings_id` entry. */
  settingsId: string;
  /** `inherits_group` entry ('' for system presets). */
  inherits: string;
  raw: RawPreset;
  /** Keys that differ from the inherited system preset (listed in `different_settings_to_system`). */
  customKeys: string[];
}

/** Applies a string override to a raw value: arrays get every entry replaced (or split on commas). */
export function applyOverride(cfg: RawPreset, key: string, value: string): void {
  const current = cfg[key];
  if (Array.isArray(current)) {
    const parts = value.split(',');
    cfg[key] = parts.length > 1 ? parts : current.map(() => value);
  } else cfg[key] = value;
}

/** Sets one filament value in a flattened preset, keeping the stored shape (per-filament values are arrays). */
function setFilamentValue(raw: RawPreset, key: string, value: string): void {
  raw[key] = typeof raw[key] === 'string' ? value : [value];
}

// ---- service ----

function stripQuotes(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const s = v.replace(/^"+|"+$/g, '').trim();
  return s === '' ? undefined : s;
}

export class ProfilesService {
  private cache = new Map<string, { mtimeMs: number; profiles: PrinterProfiles }>();
  private custom: CustomFilamentProvider | null = null;
  private customProcess: CustomProcessProvider | null = null;

  /** `currentSource` returns the installed engine's profiles when available, else the bundled snapshot. */
  constructor(private readonly currentSource: () => ProfileSource) {}

  source(): ProfileSource {
    return this.currentSource();
  }

  /** Registers the custom filament preset store (wired in context.ts). */
  setCustomFilaments(provider: CustomFilamentProvider): void {
    this.custom = provider;
  }

  /** Registers the user process profile store (wired in context.ts). */
  setCustomProcesses(provider: CustomProcessProvider): void {
    this.customProcess = provider;
  }

  /** true when `name` is a system filament preset of the model (custom names must not shadow them). */
  isSystemFilament(printerModel: PrinterModel, name: string): boolean {
    return this.load(printerModel).filament.some((e) => e.name === name);
  }

  /** true when `name` is a system process preset of the model. */
  isSystemProcess(printerModel: PrinterModel, name: string): boolean {
    return this.load(printerModel).process.some((e) => e.name === name);
  }

  /**
   * The process preset a scene uses. `custom:<n>` resolves only when the viewer may use the profile (own, shared, or
   * any for admins); a deleted or unshared profile is `profiles.preset_not_found` with `details.kind/id`.
   */
  process(printerModel: PrinterModel, id: string, viewer?: ProfileViewer): ProcessResolution {
    const n = customFilamentId(id);
    if (n === null) return { settingsId: id, inherits: '', raw: this.raw(printerModel, 'process', id), values: {} };
    const rec = n && viewer && this.customProcess ? this.customProcess.usableById(printerModel, n, viewer) : null;
    if (!rec) {
      throw new AppError(404, 'profiles.preset_not_found', 'This process profile was deleted or is no longer shared with you', { kind: 'process', id });
    }
    return { settingsId: rec.name, inherits: rec.inherits, raw: this.raw(printerModel, 'process', rec.inherits), values: { ...rec.values } };
  }

  /** Flattened system preset ⊕ the custom values (and its type/vendor/colour metadata). */
  private applyCustom(printerModel: PrinterModel, rec: CustomFilamentRecord): FilamentResolution {
    const base = this.raw(printerModel, 'filament', rec.inherits);
    const raw: RawPreset = { ...base };
    for (const [k, v] of Object.entries(rec.values)) setFilamentValue(raw, k, v);
    if (rec.filamentType && rec.values.filament_type === undefined) setFilamentValue(raw, 'filament_type', rec.filamentType);
    if (rec.vendor && rec.values.filament_vendor === undefined) setFilamentValue(raw, 'filament_vendor', rec.vendor);
    if (rec.color && rec.values.default_filament_colour === undefined) setFilamentValue(raw, 'default_filament_colour', rec.color);
    const customKeys = Object.keys(raw)
      .filter((k) => base[k] === undefined || serializeValue(base[k]) !== serializeValue(raw[k]!) || rec.values[k] !== undefined)
      .sort();
    return { settingsId: rec.name, inherits: rec.inherits, raw, customKeys };
  }

  private customRecord(printerModel: PrinterModel, id: string, viewer: ProfileViewer | undefined): CustomFilamentRecord {
    const n = customFilamentId(id);
    const rec = n && viewer && this.custom ? this.custom.usableById(printerModel, n, viewer) : null;
    if (!rec) {
      throw new AppError(404, 'profiles.preset_not_found', 'This filament preset was deleted or is no longer shared with you', { kind: 'filament', id });
    }
    return rec;
  }

  /**
   * A filament preset as a project uses it. System ids resolve to the flattened preset; `custom:<n>` ids (only when
   * the viewer may use them) to the inherited system preset with the custom values layered on top.
   */
  filament(printerModel: PrinterModel, id: string, viewer?: ProfileViewer): FilamentResolution {
    if (customFilamentId(id) === null) {
      return { settingsId: id, inherits: '', raw: this.raw(printerModel, 'filament', id), customKeys: [] };
    }
    return this.applyCustom(printerModel, this.customRecord(printerModel, id, viewer));
  }

  load(printerModel: PrinterModel): PrinterProfiles {
    if (!Object.hasOwn(PRINTER_MODELS, printerModel)) throw notFound();
    let source = this.currentSource();
    let key = `${source.indexFile}|${printerModel}`;
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(source.indexFile).mtimeMs;
    } catch {
      /* missing: loader reports it */
    }
    const hit = this.cache.get(key);
    if (hit && hit.mtimeMs === mtimeMs) return hit.profiles;
    let profiles: PrinterProfiles;
    try {
      profiles = loadPrinterProfiles(source, printerModel);
      if (profiles.machine.length === 0) throw new Error('no machine presets');
    } catch (err) {
      if (!source.fromEngine) throw err;
      logger.warn(`Engine profiles unusable (${(err as Error).message}); using the bundled snapshot`);
      source = bundledProfileSource();
      key = `${source.indexFile}|${printerModel}`;
      profiles = loadPrinterProfiles(source, printerModel);
    }
    this.cache.set(key, { mtimeMs, profiles });
    return profiles;
  }

  /** `lang` translates option labels/tooltips/pages/groups/enum labels (Creality's own catalogs; English fallback). */
  bundle(printerModel: PrinterModel, viewer?: ProfileViewer, lang: Language = 'en'): ProfileBundle {
    const p = this.load(printerModel);
    const defaultMachine = p.machine[0]?.name;
    const machineFlat = defaultMachine ? p.flat.get(defaultMachine) : undefined;
    const defaultProcess = firstValue(machineFlat?.default_print_profile);
    const defaultMaterials = (firstValue(p.model.default_materials) ?? '').split(';').filter(Boolean);
    const defaultFilament =
      defaultMaterials
        .map((m) => p.filament.find((f) => f.name.startsWith(`${m} @`))?.name)
        .find((n): n is string => !!n) ?? p.filament[0]?.name;

    const summary = (e: PresetEntry, isDefault: boolean): PresetSummary => {
      const flat = p.flat.get(e.name) ?? {};
      const out: PresetSummary = { id: e.name, name: e.name, kind: e.kind };
      if (isDefault) out.isDefault = true;
      if (e.kind === 'filament') {
        const type = firstValue(flat.filament_type);
        const color = stripQuotes(firstValue(flat.default_filament_colour));
        if (type) out.filamentType = type;
        if (color && /^#[0-9a-f]{6}$/i.test(color)) out.color = color.toUpperCase();
      }
      return out;
    };

    // Custom presets follow the system ones; a preset whose system base is gone (engine update) is left out.
    const systemNames = new Set(p.filament.map((e) => e.name));
    const custom: PresetSummary[] = [];
    for (const rec of viewer && this.custom ? this.custom.usable(printerModel, viewer) : []) {
      if (!systemNames.has(rec.inherits)) continue;
      const flat = this.applyCustom(printerModel, rec).raw;
      const type = rec.filamentType ?? firstValue(flat.filament_type);
      const color = rec.color ?? stripQuotes(firstValue(flat.default_filament_colour));
      custom.push({
        id: `${CUSTOM_FILAMENT_PREFIX}${rec.id}`,
        name: rec.name,
        kind: 'filament',
        custom: true,
        ownerId: rec.ownerId,
        ownerName: rec.ownerName,
        scope: rec.scope,
        inherits: rec.inherits,
        ...(type && { filamentType: type }),
        ...(color && /^#[0-9a-f]{6}$/i.test(color) && { color: color.toUpperCase() }),
        ...(rec.vendor && { vendor: rec.vendor }),
      });
    }

    // User process profiles (own + shared), after the system presets; a profile whose parent is gone is left out.
    const processNames = new Set(p.process.map((e) => e.name));
    const customProcess: PresetSummary[] = (viewer && this.customProcess ? this.customProcess.usable(printerModel, viewer) : [])
      .filter((rec) => processNames.has(rec.inherits))
      .map((rec) => ({
        id: `${CUSTOM_FILAMENT_PREFIX}${rec.id}`,
        name: rec.name,
        kind: 'process' as const,
        custom: true,
        ownerId: rec.ownerId,
        ownerName: rec.ownerName,
        scope: rec.scope,
        inherits: rec.inherits,
      }));

    return {
      engineVersion: p.source.engineVersion,
      printerModel,
      machine: p.machine.map((e) => summary(e, e.name === defaultMachine)),
      process: [...p.process.map((e) => summary(e, e.name === defaultProcess)), ...customProcess],
      filament: [...p.filament.map((e) => summary(e, e.name === defaultFilament)), ...custom],
      options: localizeOptions(processOptionDefs(), lang, 'process'),
      filamentOptions: localizeOptions(filamentOptionDefs(), lang, 'filament'),
    };
  }

  /** Flattened preset values (raw form, arrays kept) for building a project. */
  raw(printerModel: PrinterModel, kind: PresetKind, id: string): RawPreset {
    const p = this.load(printerModel);
    if (!p[kind].some((e) => e.name === id)) throw new AppError(404, 'profiles.preset_not_found', `Unknown ${kind} preset`);
    return p.flat.get(id)!;
  }

  resolved(printerModel: PrinterModel, kind: PresetKind, id: string, viewer?: ProfileViewer): ResolvedPreset {
    if (kind === 'process' && customFilamentId(id) !== null) {
      const r = this.process(printerModel, id, viewer);
      const raw: RawPreset = { ...r.raw };
      for (const [k, v] of Object.entries(r.values)) applyOverride(raw, k, v);
      const values: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) values[k] = serializeValue(v);
      return { id, values, inherits: r.inherits, customKeys: Object.keys(r.values).sort() };
    }
    const custom = kind === 'filament' && customFilamentId(id) !== null ? this.filament(printerModel, id, viewer) : null;
    const raw = custom ? custom.raw : this.raw(printerModel, kind, id);
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) values[k] = serializeValue(v);
    return custom ? { id, values, inherits: custom.inherits, customKeys: custom.customKeys } : { id, values };
  }

}
