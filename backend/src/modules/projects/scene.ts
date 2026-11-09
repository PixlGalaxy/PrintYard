import { z } from 'zod';
import { AppError } from '../../errors.js';
import { CONTROL_CHARS } from '../../lib/sanitize.js';
import type { SceneDoc } from '../../types.js';
import type { Mesh } from '../files/mesh.js';
import { firstValue, type ProfilesService, type ProfileViewer, type RawPreset } from '../profiles/profiles.service.js';
import { filamentOptionDefs, processOptionDefs, UNSAFE_OPTION_KEY } from '../profiles/profiles.service.js';
import type { OptionDef } from '../../types.js';
import { assertOptionValues } from '../profiles/option-bounds.js';
import type { BuildObject, BuildPlate } from './threemf.js';

/**
 * Free text that ends up inside the G-code the engine writes (config block `; notes = …`, object names in
 * `EXCLUDE_OBJECT_DEFINE NAME=…`): CR/LF and other control characters become spaces so no value can start a new
 * G-code line or forge a summary comment.
 */
export const singleLine = (max: number) => z.string().max(max).transform((v) => v.replace(CONTROL_CHARS, ' '));
const overrideKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'Invalid option key');
const overrides = z.record(overrideKey, singleLine(4096)).refine((o) => Object.keys(o).length <= 500, 'Too many overrides');
const presetId = z.string().min(1).max(200);
// Filament keys may contain capitals (`required_nozzle_HRC`).
const filamentOverrides = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, 'Invalid option key'), singleLine(4096))
  .refine((o) => Object.keys(o).length <= 200, 'Too many overrides');

export const sceneSchema = z.object({
  version: z.literal(1),
  printerModel: z.literal('creality-k2se'),
  machinePresetId: presetId,
  processPresetId: presetId,
  processOverrides: overrides,
  filaments: z
    .array(
      z.object({
        slot: z.number().int().min(1).max(32),
        presetId,
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        cfs: z.object({ box: z.number().int().min(0).max(16), slot: z.number().int().min(0).max(16) }).optional(),
        overrides: filamentOverrides.optional(),
      }),
    )
    .min(1)
    .max(32),
  plates: z
    .array(z.object({ index: z.number().int().min(0).max(63), name: singleLine(100).optional(), bedType: singleLine(64).optional() }))
    .min(1)
    .max(64),
  objects: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        fileId: z.number().int().positive(),
        name: singleLine(200),
        plate: z.number().int().min(0).max(63),
        transform: z.array(z.number().finite()).length(16),
        filamentSlot: z.number().int().min(1).max(32),
        overrides,
      }),
    )
    .max(500),
}) satisfies z.ZodType<SceneDoc>;

/**
 * Keys a client may override. Only real config options are accepted, and never ones that run code or change where
 * the engine writes (post-processing scripts, output names, raw G-code templates).
 */
let processDefs: Map<string, OptionDef> | null = null;
let filamentDefs: Map<string, OptionDef> | null = null;
function defsFor(kind: 'process' | 'filament'): Map<string, OptionDef> {
  if (kind === 'filament') return (filamentDefs ??= new Map(filamentOptionDefs().map((o) => [o.key, o])));
  return (processDefs ??= new Map(processOptionDefs().map((o) => [o.key, o])));
}

/**
 * Keys must be overridable options and values must fit their type, range and the hard safety caps
 * (`option-bounds.ts`): `nozzle_temperature_initial_layer: 999` is a 400 `slice.invalid_override` with
 * `details: { keys, issues }` (phase 3 review A #2).
 */
export function assertOverrides(o: Record<string, string>, where: string, kind: 'process' | 'filament' = 'process'): void {
  const defs = defsFor(kind);
  const bad = Object.keys(o).filter((k) => UNSAFE_OPTION_KEY.test(k) || !defs.has(k));
  if (bad.length > 0) {
    throw new AppError(400, 'slice.invalid_override', `Unsupported setting override in ${where}`, { keys: bad.slice(0, 20) });
  }
  assertOptionValues(o, defs, where);
}

/** Applies a string override to a raw value: arrays get every entry replaced (or split on commas). */
function applyOverride(cfg: RawPreset, key: string, value: string): void {
  const current = cfg[key];
  if (Array.isArray(current)) {
    const parts = value.split(',');
    cfg[key] = parts.length > 1 ? parts : current.map(() => value);
  } else cfg[key] = value;
}

/**
 * Flattened machine + process + one entry per filament slot for every filament key, plus overrides.
 * `viewer` is whose custom filament presets (`custom:<n>`) may be used; without it only system presets resolve.
 */
export function buildProjectConfig(profiles: ProfilesService, scene: SceneDoc, viewer?: ProfileViewer): RawPreset {
  assertOverrides(scene.processOverrides, 'processOverrides');
  for (const f of scene.filaments) if (f.overrides) assertOverrides(f.overrides, `filaments[slot ${f.slot}].overrides`, 'filament');
  for (const o of scene.objects) assertOverrides(o.overrides, `object "${o.name}"`);
  const machine = profiles.raw(scene.printerModel, 'machine', scene.machinePresetId);
  const process = profiles.raw(scene.printerModel, 'process', scene.processPresetId);
  const slots = [...scene.filaments].sort((a, b) => a.slot - b.slot);
  const resolved = slots.map((f) => profiles.filament(scene.printerModel, f.presetId, viewer));
  const filaments = resolved.map((r) => r.raw);
  // Custom presets saved before the safety caps (or edited directly in the DB) are re-checked on every use.
  resolved.forEach((r, i) => {
    if (r.customKeys.length === 0) return;
    const custom: Record<string, string> = {};
    for (const k of r.customKeys) {
      const v = firstValue(r.raw[k]);
      if (v !== undefined) custom[k] = v;
    }
    assertOptionValues(custom, defsFor('filament'), `filament preset "${r.settingsId}" (slot ${slots[i]!.slot})`);
  });

  const cfg: RawPreset = { ...machine, ...process };
  const filamentKeys = new Set(filaments.flatMap((f) => Object.keys(f)));
  for (const key of filamentKeys) {
    const fallback = filaments.map((f) => firstValue(f[key])).find((v) => v !== undefined) ?? '';
    cfg[key] = filaments.map((f) => firstValue(f[key]) ?? fallback);
  }
  cfg.filament_colour = slots.map((s) => s.color.toUpperCase());
  // Custom presets are written under their own name, inheriting their system preset (inherits_group below).
  cfg.filament_settings_id = resolved.map((r) => r.settingsId);
  cfg.print_settings_id = scene.processPresetId;
  cfg.printer_settings_id = scene.machinePresetId;
  const bedType = scene.plates[0]?.bedType ?? firstValue(profiles.load(scene.printerModel).model.default_bed_type);
  if (bedType) cfg.curr_bed_type = bedType;
  for (const [k, v] of Object.entries(scene.processOverrides)) applyOverride(cfg, k, v);
  // Per-slot filament overrides replace entry i of the per-filament array. Other slots keep their preset value (or
  // the override when no preset has the key; the CLI ignores it there since the key is not in their list below).
  slots.forEach((s, i) => {
    for (const [k, v] of Object.entries(s.overrides ?? {})) {
      const current = cfg[k];
      const base = Array.isArray(current) ? current : [];
      const next = slots.map((_, j) => base[j] ?? base[0] ?? v);
      next[i] = v;
      cfg[k] = next;
    }
  });
  // The CLI reloads the named system presets for Creality projects (refresh_creality_project_configuration) and only
  // keeps project values for the keys listed here: [process, filament 1..N, printer] (PresetBundle::load_config_model).
  // A custom filament lists its own keys too, so the engine keeps them over the inherited system preset.
  cfg.different_settings_to_system = [
    Object.keys(scene.processOverrides).sort().join(';'),
    ...slots.map((s, i) => [...new Set([...resolved[i]!.customKeys, ...Object.keys(s.overrides ?? {})])].sort().join(';')),
    '',
  ];
  cfg.inherits_group = ['', ...resolved.map((r) => r.inherits), ''];

  return cfg;
}

/** Printable XY rectangle from `printable_area` ("0x0,220x0,220x215,0x215"). */
export function printableArea(cfg: RawPreset): { minX: number; minY: number; maxX: number; maxY: number; height: number } {
  const pts = (Array.isArray(cfg.printable_area) ? cfg.printable_area : String(cfg.printable_area ?? '').split(','))
    .map((p) => p.split('x').map(Number))
    .filter((p) => p.length === 2 && p.every(Number.isFinite)) as [number, number][];
  if (pts.length < 3) return { minX: 0, minY: 0, maxX: 220, maxY: 215, height: Number(firstValue(cfg.printable_height)) || 245 };
  return {
    minX: Math.min(...pts.map((p) => p[0])),
    minY: Math.min(...pts.map((p) => p[1])),
    maxX: Math.max(...pts.map((p) => p[0])),
    maxY: Math.max(...pts.map((p) => p[1])),
    height: Number(firstValue(cfg.printable_height)) || 245,
  };
}

const EPS = 0.05;

/**
 * Turns scene objects into build objects: loads meshes (cached per file), drops each object onto the bed (min Z = 0,
 * the CLI does not do it for Creality projects) and checks it fits the printable volume of its plate.
 * `onlyPlate` keeps one plate and renumbers it to plate 0 (the slicing path).
 */
export async function prepareObjects(
  scene: SceneDoc,
  cfg: RawPreset,
  loadMeshFor: (fileId: number) => Promise<{ mesh: Mesh; name: string }>,
  opts: { onlyPlate?: number; validateBounds?: boolean } = {},
): Promise<{ objects: BuildObject[]; plates: BuildPlate[] }> {
  const area = printableArea(cfg);
  const filamentCount = scene.filaments.length;
  const objects: BuildObject[] = [];
  const outside: string[] = [];
  const selected = scene.objects.filter((o) => opts.onlyPlate === undefined || o.plate === opts.onlyPlate);
  const cache = new Map<number, { mesh: Mesh; name: string }>();
  for (const o of selected) {
    assertOverrides(o.overrides, `object "${o.name}"`);
    if (o.filamentSlot > filamentCount && !scene.filaments.some((f) => f.slot === o.filamentSlot)) {
      throw new AppError(400, 'slice.invalid_filament_slot', `Object "${o.name}" uses filament slot ${o.filamentSlot}, which is not defined`);
    }
    let entry = cache.get(o.fileId);
    if (!entry) {
      entry = await loadMeshFor(o.fileId);
      cache.set(o.fileId, entry);
    }
    const m = o.transform;
    const p = entry.mesh.positions;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!;
      const wx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
      const wy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
      const wz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
      if (wx < minX) minX = wx;
      if (wx > maxX) maxX = wx;
      if (wy < minY) minY = wy;
      if (wy > maxY) maxY = wy;
      if (wz < minZ) minZ = wz;
      if (wz > maxZ) maxZ = wz;
    }
    const transform = [...m];
    transform[14] = m[14]! - minZ; // lay on the bed
    if (
      opts.validateBounds !== false &&
      (minX < area.minX - EPS || maxX > area.maxX + EPS || minY < area.minY - EPS || maxY > area.maxY + EPS || maxZ - minZ > area.height + EPS)
    ) {
      outside.push(o.name || o.id);
    }
    // Slot ids are 1-based; map them to the filament's position in the sorted list (extruder index).
    const sorted = [...scene.filaments].sort((a, b) => a.slot - b.slot);
    const extruder = Math.max(1, sorted.findIndex((f) => f.slot === o.filamentSlot) + 1);
    objects.push({
      name: o.name || entry.name,
      mesh: entry.mesh,
      transform,
      extruder,
      overrides: o.overrides,
      plate: opts.onlyPlate === undefined ? o.plate : 0,
    });
  }
  if (outside.length > 0) {
    throw new AppError(400, 'slice.object_outside', 'Some objects are outside the printable area', { objects: outside });
  }
  const plates: BuildPlate[] =
    opts.onlyPlate === undefined
      ? scene.plates.map((pl) => ({ index: pl.index, ...(pl.name && { name: pl.name }), ...(pl.bedType && { bedType: pl.bedType }) }))
      : [{ index: 0, ...pickPlate(scene, opts.onlyPlate) }];
  return { objects, plates };
}

function pickPlate(scene: SceneDoc, index: number): { name?: string; bedType?: string } {
  const pl = scene.plates.find((p) => p.index === index);
  return { ...(pl?.name && { name: pl.name }), ...(pl?.bedType && { bedType: pl.bedType }) };
}
