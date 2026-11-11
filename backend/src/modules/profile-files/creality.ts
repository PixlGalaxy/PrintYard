// Creality Print / OrcaSlicer user preset files: what a user preset JSON looks like, the archives Creality Print's
// "Export presets" dialog writes, and the pure parse/build helpers PrintYard's import and export use.
//
// Formats (Creality Print src/slic3r/GUI/CreatePresetsDialog.cpp, ExportConfigsDialog; Preset::save):
// - A user preset is saved as a diff against its system parent by `DynamicConfig::save_to_json`: `name`, `from:
//   "User"`, `version` (a Semver string, presets without one are skipped on load), `inherits`, `is_custom_defined`,
//   the `print_settings_id` / `filament_settings_id` id key (the importer picks the preset collection from it), then
//   every changed option: scalars as strings, vector options (all filament options) as arrays of strings.
// - "Process presets (.zip)" / "Filament presets (.zip)": a plain zip of `<preset name>.json` (save_presets_to_zip).
// - "Filament bundle (.creality_filament)": a zip of `<vendor>/<preset name>.json` plus `bundle_structure.json`
//   `{ version, bundle_id, bundle_type: "filament config bundle", filament_name, printer_vendor: [{ vendor,
//   filament_path: [...] }] }`.
// - "Printer config bundle (.creality_printer)": `printer/…json`, `filament/…json`, `process/…json` plus
//   `bundle_structure.json` `{ bundle_type: "printer config bundle", printer_preset_name, printer_config,
//   filament_config, process_config }`. PrintYard imports its process and filament presets only.
import { CONTROL_CHARS } from '../../lib/sanitize.js';
import { cleanName } from '../files/files.service.js';
import { isVectorOption, META_KEYS, firstValue, serializeValue, type RawPreset, type RawValue } from '../profiles/profiles.service.js';

export const BUNDLE_STRUCTURE = 'bundle_structure.json';

export type PresetKindHint = 'process' | 'filament' | 'printer';

/** Upload limits (security): file size, archive entries, inflated total, one JSON. */
export const IMPORT_LIMITS = {
  maxFileBytes: 5 * 1024 * 1024,
  maxEntries: 200,
  maxTotalBytes: 20 * 1024 * 1024,
  maxJsonBytes: 1024 * 1024,
} as const;

/** Upload file types PrintYard accepts (extension, lower case). */
export const IMPORT_TYPES = ['json', 'zip', 'creality_filament', 'creality_printer'] as const;
export type ImportType = (typeof IMPORT_TYPES)[number];

export function importTypeOf(fileName: string): ImportType | null {
  const m = /\.(json|zip|creality_filament|creality_printer)$/i.exec(fileName.trim());
  return m ? (m[1]!.toLowerCase() as ImportType) : null;
}

export const isZip = (buf: Uint8Array) => buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5) && (buf[3] === 4 || buf[3] === 6);

/**
 * Archive entry names are only labels: they are never joined to a path. Still, names that look like paths outside
 * the archive (`..`, absolute, drive letters, backslashes, control characters) are refused and reported.
 */
export function safeEntryName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (/[\\\u0000-\u001f\u007f]/.test(name) || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  return !name.split('/').some((seg) => seg === '..' || seg === '.');
}

/** Keys of a user preset JSON that describe the preset, not a setting (never imported, never reported). */
const IMPORT_META = new Set([
  ...META_KEYS,
  'print_settings_id',
  'filament_settings_id',
  'printer_settings_id',
  'updated_time',
  'user_id',
  'print_extruder_id',
  'print_extruder_variant',
  'filament_extruder_variant',
  'printer_extruder_id',
  'printer_extruder_variant',
  'filament_self_index',
  'bundle_type',
]);

/** Values of a filament preset that PrintYard keeps as profile metadata (type, brand, colour). */
export const FILAMENT_META_KEYS = ['filament_type', 'filament_vendor', 'default_filament_colour'] as const;

/** Canonical form for comparing with the parent: "0.20" = "0.2", "15.0%" = "15%", quotes stripped. */
export function normValue(v: string): string {
  const s = v.trim().replace(/^"(.*)"$/, '$1');
  const n = Number(s.replace(/%$/, ''));
  return s !== '' && Number.isFinite(n) ? `${n}${s.endsWith('%') ? '%' : ''}` : s;
}

export interface ParsedPreset {
  kind: 'process' | 'filament';
  /** Archive entry (or the uploaded file name). */
  entry: string;
  /** Cleaned display name (not yet de-duplicated). */
  name: string;
  /** `inherits` as written in the file ('' for root presets). */
  inherits: string;
  /** Setting keys → engine text form (filament: first extruder's value). */
  values: Record<string, string>;
  /** Keys whose JSON value is neither a string, a number, a bool nor a list of those. */
  invalid: string[];
}

/** Display name from a preset `name` (or the file name): cleaned like a file name, no `;`/`"`/`\`, ≤ 100 chars. */
export function cleanProfileName(raw: string): string {
  const s = cleanName(raw.replace(/\.json$/i, ''))
    .replace(CONTROL_CHARS, ' ')
    .replace(/[;"\\]/g, '_')
    .trim();
  return Array.from(s).slice(0, 100).join('').trim();
}

function scalarText(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return undefined;
}

/**
 * Which kind of preset a JSON is: the bundle structure, the archive folder, `type`, then the id key Creality's
 * importer uses (`print_settings_id` / `filament_settings_id` / `printer_settings_id`). null = unknown.
 */
export function classifyPreset(entry: string, obj: Record<string, unknown>, hint: PresetKindHint | undefined, isSystem: (kind: 'process' | 'filament', name: string) => boolean): PresetKindHint | null {
  if (hint) return hint;
  const folder = entry.includes('/') ? entry.split('/')[0]!.toLowerCase() : '';
  if (folder === 'process' || folder === 'print') return 'process';
  if (folder === 'filament') return 'filament';
  if (folder === 'printer' || folder === 'machine') return 'printer';
  const type = typeof obj.type === 'string' ? obj.type.toLowerCase() : '';
  if (type === 'process' || type === 'print') return 'process';
  if (type === 'filament') return 'filament';
  if (type === 'machine' || type === 'printer' || type === 'machine_model') return 'printer';
  if ('print_settings_id' in obj) return 'process';
  if ('filament_settings_id' in obj) return 'filament';
  if ('printer_settings_id' in obj) return 'printer';
  const inherits = typeof obj.inherits === 'string' ? obj.inherits : '';
  if (inherits && isSystem('process', inherits)) return 'process';
  if (inherits && isSystem('filament', inherits)) return 'filament';
  return null;
}

/** Reads the setting values of a preset JSON object (meta keys left out). */
export function readPreset(kind: 'process' | 'filament', entry: string, obj: Record<string, unknown>): ParsedPreset {
  const values: Record<string, string> = {};
  const invalid: string[] = [];
  for (const [key, v] of Object.entries(obj)) {
    if (IMPORT_META.has(key)) continue;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) {
      invalid.push(key.slice(0, 64));
      continue;
    }
    if (Array.isArray(v)) {
      const parts = v.map(scalarText);
      if (parts.length === 0 || parts.some((p) => p === undefined)) {
        invalid.push(key);
        continue;
      }
      // Filament options are per filament: PrintYard edits one filament, so the first entry is the value.
      values[key] = kind === 'filament' ? parts[0]! : parts.join(',');
    } else {
      const s = scalarText(v);
      if (s === undefined) invalid.push(key);
      else values[key] = s;
    }
  }
  const rawName = typeof obj.name === 'string' && obj.name.trim() ? obj.name : (entry.split('/').pop() ?? entry);
  return {
    kind,
    entry,
    name: cleanProfileName(rawName) || 'Imported profile',
    inherits: typeof obj.inherits === 'string' ? obj.inherits.replace(CONTROL_CHARS, ' ').trim().slice(0, 200) : '',
    values,
    invalid,
  };
}

/** Value of `key` in the parent, in the same text form `readPreset` produces. */
export function parentText(kind: 'process' | 'filament', parent: RawPreset, key: string): string | undefined {
  const v = parent[key];
  if (v === undefined) return undefined;
  return kind === 'filament' ? firstValue(v) : serializeValue(v);
}

/** "Hyper PLA @Creality K2 SE 0.4 nozzle" → "Hyper PLA" (Creality's get_filament_name). */
export const presetFamily = (name: string) => (name.includes('@') ? name.slice(0, name.lastIndexOf('@')).trim() : name.trim());

/**
 * The K2 SE system preset to use as parent: the exact `inherits`, else the same family on the K2 SE ("0.20mm
 * Standard @Creality K1C" → "0.20mm Standard @Creality K2 SE 0.4 nozzle"), else (process) the same layer height,
 * else (filament) the generic preset of the same material, else the bundle default.
 */
export function pickParent(
  kind: 'process' | 'filament',
  inherits: string,
  values: Record<string, string>,
  system: { name: string; filamentType?: string; isDefault?: boolean }[],
): string {
  if (system.some((s) => s.name === inherits)) return inherits;
  const family = presetFamily(inherits).toLowerCase();
  if (family) {
    const same = system.find((s) => presetFamily(s.name).toLowerCase() === family);
    if (same) return same.name;
  }
  if (kind === 'process') {
    const h = Number(values.layer_height ?? /^(\d+(?:\.\d+)?)mm\b/.exec(inherits)?.[1]);
    if (Number.isFinite(h) && h > 0) {
      const byHeight = system.find((s) => Math.abs(Number(/^(\d+(?:\.\d+)?)mm\b/.exec(s.name)?.[1]) - h) < 1e-6);
      if (byHeight) return byHeight.name;
    }
  } else {
    const type = (values.filament_type ?? '').trim().toUpperCase();
    if (type) {
      const typed = system.filter((s) => (s.filamentType ?? '').toUpperCase() === type);
      const generic = typed.find((s) => s.name.startsWith('Generic ')) ?? typed[0];
      if (generic) return generic.name;
    }
  }
  return (system.find((s) => s.isDefault) ?? system[0])!.name;
}

// ---- export ----

/** Creality's preset `version` is a Semver string; the engine version padded to four parts ("7.3.1" → "7.3.1.0"). */
export function presetVersion(engineVersion: string): string {
  const parts = engineVersion.split(/[.-]/).filter((p) => /^\d+$/.test(p)).slice(0, 4);
  while (parts.length < 4) parts.push('0');
  return parts.join('.');
}

export interface ExportablePreset {
  kind: 'process' | 'filament';
  name: string;
  inherits: string;
  values: Record<string, string>;
  /** Filament metadata columns written back as their option keys. */
  filamentType?: string | null;
  vendor?: string | null;
  color?: string | null;
}

/**
 * One user preset JSON as Creality Print saves it (DynamicConfig::save_to_json): meta keys, the id key, then the
 * changed options; vector options (filament options, per-extruder process options) as arrays of strings. Keys
 * sorted, 4-space indent (nlohmann::json dump with setw(4)).
 */
export function buildPresetJson(p: ExportablePreset, version: string): string {
  const out: Record<string, RawValue> = {};
  const shaped = (key: string, v: string): RawValue => (isVectorOption(key) ? (p.kind === 'filament' ? [v] : v.split(',')) : v);
  const values: Record<string, string> = { ...p.values };
  if (p.kind === 'filament') {
    if (p.filamentType && values.filament_type === undefined) values.filament_type = p.filamentType;
    if (p.vendor && values.filament_vendor === undefined) values.filament_vendor = p.vendor;
    if (p.color && values.default_filament_colour === undefined) values.default_filament_colour = p.color;
  }
  for (const [k, v] of Object.entries(values)) out[k] = shaped(k, v);
  out.from = 'User';
  out.inherits = p.inherits;
  out.is_custom_defined = '0';
  out.name = p.name;
  out.version = version;
  if (p.kind === 'process') out.print_settings_id = p.name;
  else out.filament_settings_id = [p.name];
  const sorted = Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
  return `${JSON.stringify(sorted, null, 4)}\n`;
}

/** File name for an archive entry: path separators and characters Windows refuses become `_`. */
export function entryFileName(name: string): string {
  const s = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'preset';
  return `${s}.json`;
}

/** `bundle_structure.json` of a filament bundle (Creality's "Filament bundle (.creality_filament)"). */
export function filamentBundleStructure(filamentName: string, paths: string[]): string {
  return JSON.stringify({
    version: '',
    bundle_id: `offline_${filamentName}_${Math.floor(Date.now() / 1000)}`,
    bundle_type: 'filament config bundle',
    filament_name: filamentName,
    printer_vendor: [{ vendor: 'Creality', filament_path: paths }],
  });
}
