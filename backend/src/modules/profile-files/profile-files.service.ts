// PROFILES: import user process/filament presets from Creality Print / OrcaSlicer files, and export SliceDock profiles
// in the formats Creality Print imports. Everything is read in memory (no entry name is ever used as a path) and every
// imported value goes through the same screening as scene overrides before it is stored.
import { zipSync, type Zippable } from 'fflate';
import { AppError, notFound } from '../../errors.js';
import { logger } from '../../logger.js';
import type { PrinterModel, ProfileFileKind, ProfileImportReport } from '../../types.js';
import type { AuditActor, AuditService } from '../audit/audit.service.js';
import { MeshFormatError, readZipEntries } from '../files/mesh.js';
import type { FilamentPresetsService } from '../filament-presets/filament-presets.service.js';
import type { ProcessProfilesService } from '../process-profiles/process-profiles.service.js';
import { screenOverrides } from '../projects/scene.js';
import { UNSAFE_OPTION_KEY, type ProfilesService, type ProfileViewer } from '../profiles/profiles.service.js';
import {
  BUNDLE_STRUCTURE,
  buildPresetJson,
  classifyPreset,
  entryFileName,
  FILAMENT_META_KEYS,
  filamentBundleStructure,
  IMPORT_LIMITS,
  importTypeOf,
  isZip,
  normValue,
  parentText,
  pickParent,
  presetFamily,
  presetVersion,
  readPreset,
  safeEntryName,
  type ExportablePreset,
  type ImportType,
  type ParsedPreset,
  type PresetKindHint,
} from './creality.js';

const MODEL: PrinterModel = 'creality-k2se';
/** Reported items per list (the response stays small whatever the archive holds). */
const MAX_REPORT = 200;
const MAX_VALUES: Record<ProfileFileKind, number> = { process: 500, filament: 200 };
const FILAMENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9+_ -]{0,31}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

export interface ExportRequest {
  kind: ProfileFileKind;
  ids: number[];
  format: 'zip' | 'creality_filament';
}

export interface ExportFile {
  fileName: string;
  contentType: string;
  /** base64 */
  data: string;
}

type Viewer = ProfileViewer & { username: string };

const push = <T>(list: T[], item: T) => {
  if (list.length < MAX_REPORT) list.push(item);
};

export class ProfileFilesService {
  constructor(
    private readonly profiles: ProfilesService,
    private readonly processProfiles: ProcessProfilesService,
    private readonly filamentPresets: FilamentPresetsService,
    private readonly audit: AuditService,
  ) {}

  private system(kind: ProfileFileKind): { name: string; filamentType?: string; isDefault?: boolean }[] {
    const bundle = this.profiles.bundle(MODEL);
    return bundle[kind].filter((p) => !p.custom).map((p) => ({ name: p.name, ...(p.filamentType && { filamentType: p.filamentType }), ...(p.isDefault && { isDefault: true }) }));
  }

  // ---------- import ----------

  /** Unpacks the upload into preset JSON objects (with kind hints from a bundle structure). */
  private async readUpload(
    fileName: string,
    data: Buffer,
    report: ProfileImportReport,
  ): Promise<{ type: ImportType; entries: { entry: string; obj: Record<string, unknown>; hint?: PresetKindHint }[] }> {
    const type = importTypeOf(fileName);
    if (!type) throw new AppError(400, 'profile_files.unsupported_type', 'Import a .json, .zip, .creality_filament or .creality_printer file');
    if (data.length === 0) throw new AppError(400, 'profile_files.invalid_file', 'The file is empty');
    if (data.length > IMPORT_LIMITS.maxFileBytes) {
      throw new AppError(413, 'profile_files.too_large', `The file is larger than ${IMPORT_LIMITS.maxFileBytes / 1048576} MB`);
    }
    const parse = (entry: string, bytes: Uint8Array): Record<string, unknown> | null => {
      if (bytes.length > IMPORT_LIMITS.maxJsonBytes) {
        push(report.skipped, { entry, reason: 'too_large' });
        return null;
      }
      let obj: unknown;
      try {
        obj = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^\uFEFF/, ''));
      } catch {
        push(report.skipped, { entry, reason: 'invalid_json' });
        return null;
      }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        push(report.skipped, { entry, reason: 'not_a_preset' });
        return null;
      }
      return obj as Record<string, unknown>;
    };

    if (type === 'json') {
      if (isZip(data)) throw new AppError(400, 'profile_files.invalid_file', 'This .json file is an archive');
      if (data.length > IMPORT_LIMITS.maxJsonBytes) throw new AppError(413, 'profile_files.too_large', 'The JSON file is too large');
      const obj = parse(fileName, data);
      if (!obj) {
        const reason = report.skipped[report.skipped.length - 1]?.reason;
        throw new AppError(400, reason === 'invalid_json' ? 'profile_files.invalid_json' : 'profile_files.not_a_preset', 'This file is not a preset JSON');
      }
      return { type, entries: [{ entry: fileName, obj }] };
    }

    if (!isZip(data)) throw new AppError(400, 'profile_files.invalid_archive', 'This file is not a ZIP archive');
    const names: string[] = [];
    let files: Map<string, Uint8Array>;
    try {
      files = await readZipEntries(
        data,
        (name) => {
          if (name.endsWith('/')) return false; // folder entry
          names.push(name);
          return safeEntryName(name) && /\.json$/i.test(name);
        },
        { maxEntries: IMPORT_LIMITS.maxEntries, maxEntryBytes: IMPORT_LIMITS.maxJsonBytes, maxTotalBytes: IMPORT_LIMITS.maxTotalBytes },
      );
    } catch (err) {
      if (err instanceof MeshFormatError) {
        if (err.reason === 'too_many_entries') throw new AppError(413, 'profile_files.too_many_entries', `The archive has more than ${IMPORT_LIMITS.maxEntries} entries`);
        if (err.reason === 'too_large') throw new AppError(413, 'profile_files.too_large', 'The archive is too large once unpacked');
        throw new AppError(400, 'profile_files.invalid_archive', 'The archive cannot be read');
      }
      throw err;
    }
    for (const name of names) {
      if (!safeEntryName(name)) push(report.skipped, { entry: name.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 255), reason: 'unsafe_path' });
      else if (!/\.json$/i.test(name)) push(report.skipped, { entry: name, reason: 'not_json' });
    }

    // Kind hints from bundle_structure.json (printer bundles list their printer/filament/process files).
    const hints = new Map<string, PresetKindHint>();
    const structureBytes = [...files.entries()].find(([n]) => n === BUNDLE_STRUCTURE)?.[1];
    if (structureBytes) {
      const s = parse(BUNDLE_STRUCTURE, structureBytes);
      const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
      if (s) {
        for (const p of list(s.printer_config)) hints.set(p, 'printer');
        for (const p of list(s.filament_config)) hints.set(p, 'filament');
        for (const p of list(s.process_config)) hints.set(p, 'process');
        if (Array.isArray(s.printer_vendor)) {
          for (const v of s.printer_vendor) for (const p of list((v as Record<string, unknown> | null)?.filament_path)) hints.set(p, 'filament');
        }
      }
    }
    const entries: { entry: string; obj: Record<string, unknown>; hint?: PresetKindHint }[] = [];
    for (const [entry, bytes] of files) {
      if (entry === BUNDLE_STRUCTURE) continue;
      const obj = parse(entry, bytes);
      if (!obj) continue;
      const hint = hints.get(entry) ?? (type === 'creality_filament' ? 'filament' : undefined);
      entries.push({ entry, obj, ...(hint && { hint }) });
    }
    if (entries.length === 0 && report.skipped.length === 0) throw new AppError(400, 'profile_files.empty', 'The archive has no presets');
    return { type, entries };
  }

  /** Parent, diff against it, screening: what would be stored, and what is dropped (never stored). */
  private prepare(p: ParsedPreset, report: ProfileImportReport) {
    const system = this.system(p.kind);
    const parent = pickParent(p.kind, p.inherits, p.values, system);
    if (parent !== p.inherits) push(report.remapped, { profile: p.name, from: p.inherits, to: parent });
    const parentRaw = this.profiles.raw(MODEL, p.kind, parent);
    for (const key of p.invalid) push(report.dropped, { profile: p.name, key, reason: 'invalid_value' });

    const meta: { filamentType: string | null; vendor: string | null; color: string | null } = { filamentType: null, vendor: null, color: null };
    const diff: Record<string, string> = {};
    for (const [key, value] of Object.entries(p.values)) {
      const base = parentText(p.kind, parentRaw, key);
      const same = base !== undefined && normValue(base) === normValue(value);
      if (p.kind === 'filament' && (FILAMENT_META_KEYS as readonly string[]).includes(key)) {
        const v = value.replace(/^"(.*)"$/, '$1').trim();
        if (key === 'filament_type' && FILAMENT_TYPE.test(v)) meta.filamentType = v;
        else if (key === 'default_filament_colour' && HEX.test(v)) meta.color = v.toUpperCase();
        else if (key === 'filament_vendor' && v && v.length <= 64 && !/[;"\\]/.test(v)) meta.vendor = v;
        else if (v) push(report.dropped, { profile: p.name, key, reason: 'invalid_value' });
        continue;
      }
      // Unchanged keys are not part of a diff; unsafe keys are reported even then, so a hostile file is visible.
      if (same && !UNSAFE_OPTION_KEY.test(key)) continue;
      diff[key] = value;
    }
    const { ok, badKeys, badValues } = screenOverrides(diff, p.kind);
    for (const b of badKeys) push(report.dropped, { profile: p.name, key: b.key, reason: b.reason });
    for (const b of badValues) push(report.dropped, { profile: p.name, key: b.key, reason: b.reason });
    const keys = Object.keys(ok);
    if (keys.length > MAX_VALUES[p.kind]) {
      for (const k of keys.slice(MAX_VALUES[p.kind])) {
        delete ok[k];
        push(report.dropped, { profile: p.name, key: k, reason: 'too_many' });
      }
    }
    return { parent, values: ok, meta };
  }

  /** A name free for the viewer: "Name", else "Name (2)", "Name (3)"… (Creality asks to overwrite; SliceDock never does). */
  private freeName(kind: ProfileFileKind, name: string, viewer: Viewer): string | null {
    const free = (n: string) =>
      kind === 'process' ? this.processProfiles.nameFree(MODEL, n, viewer.id, 'private') : this.filamentPresets.nameFree(MODEL, n, viewer.id, 'private');
    if (free(name)) return name;
    for (let i = 2; i < 100; i++) {
      const suffix = ` (${i})`;
      const candidate = `${Array.from(name).slice(0, 100 - suffix.length).join('').trim()}${suffix}`;
      if (free(candidate)) return candidate;
    }
    return null;
  }

  async importFile(viewer: Viewer, fileName: string, data: Buffer, actor: AuditActor): Promise<ProfileImportReport> {
    const report: ProfileImportReport = { created: [], skipped: [], dropped: [], remapped: [], renamed: [] };
    const { type, entries } = await this.readUpload(fileName, data, report);
    const isSystem = (kind: 'process' | 'filament', name: string) =>
      kind === 'process' ? this.profiles.isSystemProcess(MODEL, name) : this.profiles.isSystemFilament(MODEL, name);
    for (const { entry, obj, hint } of entries) {
      const kind = classifyPreset(entry, obj, hint, isSystem);
      if (kind === 'printer') {
        // SliceDock slices with the official K2 SE machine profiles: printer presets are never imported.
        push(report.skipped, { entry, reason: 'printer_preset' });
        continue;
      }
      if (!kind) {
        push(report.skipped, { entry, reason: 'unknown_kind' });
        continue;
      }
      const parsed = readPreset(kind, entry, obj);
      const { parent, values, meta } = this.prepare(parsed, report);
      const name = this.freeName(kind, parsed.name, viewer);
      if (!name) {
        push(report.skipped, { entry, reason: 'name_taken' });
        continue;
      }
      if (name !== parsed.name) push(report.renamed, { from: parsed.name, to: name });
      try {
        // The create path validates again (same checks): nothing unscreened can be stored.
        const created =
          kind === 'process'
            ? this.processProfiles.create(viewer, { printerModel: MODEL, basePresetId: parent, name, values, scope: 'private' }, actor, 'import')
            : this.filamentPresets.create(
                viewer,
                { printerModel: MODEL, basePresetId: parent, name, values, scope: 'private', filamentType: meta.filamentType, vendor: meta.vendor, color: meta.color },
                actor,
              );
        push(report.created, { kind, id: created.id, presetId: created.presetId, name: created.name, inherits: created.inherits, keys: Object.keys(created.values).length });
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        push(report.skipped, { entry, reason: err.code });
      }
    }
    this.audit.log('profile.import', actor, fileName.slice(0, 200), {
      type,
      created: report.created.length,
      skipped: report.skipped.length,
      dropped: report.dropped.length,
      remapped: report.remapped.length,
    });
    logger.info(`Profile import "${fileName.slice(0, 80)}" by "${viewer.username}": ${report.created.length} created, ${report.skipped.length} skipped, ${report.dropped.length} keys dropped`);
    return report;
  }

  // ---------- export ----------

  exportFiles(viewer: Viewer, req: ExportRequest, actor: AuditActor): ExportFile {
    if (req.kind === 'process' && req.format !== 'zip') throw new AppError(400, 'profile_files.invalid_format', 'Process profiles export as .zip');
    const version = presetVersion(this.profiles.load(MODEL).source.engineVersion);
    const presets: ExportablePreset[] = [...new Set(req.ids)].map((id) => {
      // Only profiles the viewer can see (own, shared, any for admins); anything else is a 404.
      if (req.kind === 'process') {
        const p = this.processProfiles.get(viewer, id);
        return { kind: 'process', name: p.name, inherits: p.inherits, values: p.values };
      }
      const p = this.filamentPresets.get(viewer, id);
      return { kind: 'filament', name: p.name, inherits: p.inherits, values: p.values, filamentType: p.filamentType, vendor: p.vendor, color: p.color };
    });
    if (presets.length === 0) throw notFound();
    const files: Zippable = {};
    const used = new Set<string>();
    const paths: string[] = [];
    const folder = req.format === 'creality_filament' ? 'Creality/' : '';
    for (const p of presets) {
      let name = entryFileName(p.name);
      for (let i = 2; used.has(name.toLowerCase()); i++) name = entryFileName(`${p.name} (${i})`);
      used.add(name.toLowerCase());
      const json = buildPresetJson(p, version);
      files[`${folder}${name}`] = [new TextEncoder().encode(json), { level: 6 }];
      paths.push(`${folder}${name}`);
    }
    let fileName: string;
    if (req.format === 'creality_filament') {
      const family = presetFamily(presets[0]!.inherits);
      files['bundle_structure.json'] = [new TextEncoder().encode(filamentBundleStructure(family, paths)), { level: 6 }];
      fileName = presets.length === 1 ? `${entryFileName(presets[0]!.name).slice(0, -5)}.creality_filament` : 'Filament presets.creality_filament';
    } else {
      fileName = req.kind === 'process' ? 'Process presets.zip' : 'Filament presets.zip';
    }
    const zip = zipSync(files, { mtime: new Date() });
    this.audit.log('profile.export', actor, fileName, { kind: req.kind, format: req.format, count: presets.length });
    return { fileName, contentType: 'application/zip', data: Buffer.from(zip).toString('base64') };
  }
}
