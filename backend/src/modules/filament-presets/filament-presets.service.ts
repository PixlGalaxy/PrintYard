import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { AppError, forbidden, notFound } from '../../errors.js';
import { CONTROL_CHARS } from '../../lib/sanitize.js';
import { logger } from '../../logger.js';
import type { FilamentPreset, FilamentPresetScope, OptionDef, PrinterModel } from '../../types.js';
import type { AuditActor, AuditService } from '../audit/audit.service.js';
import {
  CUSTOM_FILAMENT_PREFIX,
  customFilamentId,
  filamentOptionDefs,
  UNSAFE_OPTION_KEY,
  type CustomFilamentProvider,
  type CustomFilamentRecord,
  type ProfilesService,
  type ProfileViewer,
} from '../profiles/profiles.service.js';

interface Row {
  id: number;
  owner_id: number;
  owner_name: string;
  scope: FilamentPresetScope;
  printer_model: PrinterModel;
  name: string;
  inherits: string;
  vendor: string | null;
  filament_type: string | null;
  color: string | null;
  values_json: string;
  created_at: number;
  updated_at: number;
}

const SELECT = 'SELECT p.*, u.username AS owner_name FROM filament_presets p JOIN users u ON u.id = p.owner_id';

/** Most presets one user may own (shared ones count for their owner too). */
export const MAX_PRESETS_PER_USER = 200;
const MAX_VALUES = 200;

// ---- validation ----

/** Free text that reaches the engine config: CR/LF and control characters become spaces (sec-fix notes). */
const cleanLine = (v: string) => v.replace(CONTROL_CHARS, ' ').trim();

/**
 * Display name, also written as `filament_settings_id` in the 3MF (G-code header `"a";"b"`), so `;` and `"` are refused.
 */
const nameSchema = z
  .string()
  .transform(cleanLine)
  .pipe(
    z
      .string()
      .min(1)
      .max(100)
      .refine((v) => !/[;"\\]/.test(v), 'The name cannot contain ; " or \\')
      .refine((v) => !v.startsWith(CUSTOM_FILAMENT_PREFIX), 'Reserved name'),
  );
const metaText = (max: number) => z.string().transform(cleanLine).pipe(z.string().max(max));
/** Material type, also written as `filament_type`: letters, digits, `+`, `-`, `_` and spaces. */
const typeSchema = metaText(32).refine((v) => v === '' || /^[A-Za-z0-9][A-Za-z0-9+_ -]*$/.test(v), 'Invalid filament type');
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/).transform((v) => v.toUpperCase());
const valuesSchema = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, 'Invalid option key'), z.string().max(4096));

export const createSchema = z.object({
  printerModel: z.literal('creality-k2se').default('creality-k2se'),
  /** System preset id, or `custom:<n>` to copy an existing custom preset (its values become the starting point). */
  basePresetId: z.string().min(1).max(200),
  name: nameSchema,
  vendor: metaText(64).nullable().optional(),
  filamentType: typeSchema.nullable().optional(),
  color: colorSchema.nullable().optional(),
  /** Extra overridden keys (e.g. a scene slot's current overrides), layered over the base's custom values. */
  values: valuesSchema.default({}),
  scope: z.enum(['private', 'shared']).default('private'),
});

export const patchSchema = z.object({
  name: nameSchema.optional(),
  /** Change the system preset it inherits from (system id only). */
  inherits: z.string().min(1).max(200).optional(),
  vendor: metaText(64).nullable().optional(),
  filamentType: typeSchema.nullable().optional(),
  color: colorSchema.nullable().optional(),
  /** Replaces the whole set of overridden keys. */
  values: valuesSchema.optional(),
});

export type CreateBody = z.infer<typeof createSchema>;
export type PatchBody = z.infer<typeof patchSchema>;

/** Numeric range per key (checked after the type). Units come from the option table. */
function boundsFor(def: OptionDef): { min: number; max: number } {
  const k = def.key;
  if (def.unit === '°C' || /temp/.test(k)) return { min: 0, max: 500 };
  if (def.type === 'percent' || def.unit === '%' || /fan_speed|fan_min_speed|fan_max_speed/.test(k)) return { min: 0, max: 100 };
  if (k === 'filament_diameter') return { min: 0.5, max: 5 };
  if (k === 'filament_density') return { min: 0, max: 30 };
  if (k === 'filament_flow_ratio') return { min: 0.01, max: 5 };
  if (k === 'pressure_advance') return { min: 0, max: 5 };
  if (k === 'filament_cost') return { min: 0, max: 1_000_000 };
  if (k === 'filament_max_volumetric_speed') return { min: 0, max: 500 };
  return { min: -100_000, max: 100_000 };
}

const NUMBER = /^-?(\d+(\.\d*)?|\.\d+)$/;

let defsByKey: Map<string, OptionDef> | null = null;
function filamentDefs(): Map<string, OptionDef> {
  if (!defsByKey) defsByKey = new Map(filamentOptionDefs().map((o) => [o.key, o]));
  return defsByKey;
}

/**
 * Validates and normalises custom values: keys must be filament options (same allowlist as slot overrides), values
 * are single-line engine text, numbers are finite and inside the key's bounds, bools are 0/1, enums known values.
 * `nil` ("use the printer's value") is accepted for the Setting Overrides keys.
 */
export function validateFilamentValues(values: Record<string, string>): Record<string, string> {
  const defs = filamentDefs();
  const entries = Object.entries(values);
  if (entries.length > MAX_VALUES) throw new AppError(400, 'filament_presets.too_many_values', `At most ${MAX_VALUES} settings`);
  const badKeys: string[] = [];
  const badValues: { key: string; reason: string }[] = [];
  const out: Record<string, string> = {};
  for (const [key, rawValue] of entries) {
    const def = defs.get(key);
    if (!def || UNSAFE_OPTION_KEY.test(key)) {
      badKeys.push(key);
      continue;
    }
    const v = rawValue.replace(CONTROL_CHARS, ' ').trim();
    const fail = (reason: string) => badValues.push({ key, reason });
    if (v === 'nil' && def.page === 'Setting Overrides') {
      out[key] = v;
      continue;
    }
    switch (def.type) {
      case 'bool':
        if (v !== '0' && v !== '1') fail('bool');
        break;
      case 'int':
      case 'float':
      case 'percent':
      case 'floatOrPercent': {
        const num = def.type === 'percent' || def.type === 'floatOrPercent' ? v.replace(/%$/, '') : v;
        if (!NUMBER.test(num)) {
          fail('number');
          break;
        }
        if (def.type === 'int' && !/^-?\d+$/.test(num)) {
          fail('integer');
          break;
        }
        const n = Number(num);
        const b = v.endsWith('%') ? { min: 0, max: 1000 } : boundsFor(def);
        if (!Number.isFinite(n) || n < b.min || n > b.max) fail(`range ${b.min}..${b.max}`);
        break;
      }
      case 'enum':
        if (def.enumValues?.length && !def.enumValues.some((e) => e.value === v)) fail('enum');
        break;
      default:
        if (key === 'default_filament_colour' && v !== '' && !/^#[0-9a-fA-F]{6}$/.test(v)) fail('color');
        break;
    }
    out[key] = v;
  }
  if (badKeys.length > 0) {
    throw new AppError(400, 'slice.invalid_override', 'Unsupported filament setting', { keys: badKeys.slice(0, 20) });
  }
  if (badValues.length > 0) {
    throw new AppError(400, 'filament_presets.invalid_value', 'Some filament settings have invalid values', {
      keys: badValues.slice(0, 20).map((b) => b.key),
      issues: badValues.slice(0, 20),
    });
  }
  return out;
}

// ---- service ----

export class FilamentPresetsService implements CustomFilamentProvider {
  constructor(
    private readonly db: Db,
    private readonly profiles: ProfilesService,
    private readonly audit: AuditService,
  ) {}

  private toRecord(r: Row): CustomFilamentRecord {
    let values: Record<string, string> = {};
    try {
      const parsed = JSON.parse(r.values_json) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') values[k] = v;
      }
    } catch {
      values = {};
    }
    return {
      id: r.id,
      ownerId: r.owner_id,
      ownerName: r.owner_name,
      scope: r.scope,
      name: r.name,
      inherits: r.inherits,
      vendor: r.vendor,
      filamentType: r.filament_type,
      color: r.color,
      values,
    };
  }

  private toView(r: Row, viewer: ProfileViewer): FilamentPreset {
    const rec = this.toRecord(r);
    return {
      id: r.id,
      presetId: `${CUSTOM_FILAMENT_PREFIX}${r.id}`,
      ownerId: r.owner_id,
      ownerName: r.owner_name,
      scope: r.scope,
      printerModel: r.printer_model,
      name: r.name,
      inherits: r.inherits,
      vendor: r.vendor,
      filamentType: r.filament_type,
      color: r.color,
      values: rec.values,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      canEdit: r.owner_id === viewer.id || viewer.role === 'admin',
    };
  }

  private row(id: number): Row | undefined {
    return this.db.prepare(`${SELECT} WHERE p.id = ?`).get(id) as Row | undefined;
  }

  private canUse(r: Row, viewer: ProfileViewer): boolean {
    return r.scope === 'shared' || r.owner_id === viewer.id || viewer.role === 'admin';
  }

  /** Visible = usable; private presets of other users are a 404 (admins see them too). */
  private visibleRow(id: number, viewer: ProfileViewer): Row {
    const r = this.row(id);
    if (!r || !this.canUse(r, viewer)) throw notFound();
    return r;
  }

  private writableRow(id: number, viewer: ProfileViewer): Row {
    const r = this.visibleRow(id, viewer);
    if (r.owner_id !== viewer.id && viewer.role !== 'admin') {
      throw forbidden('filament_presets.forbidden', 'Only the owner or an admin can change this filament');
    }
    return r;
  }

  // CustomFilamentProvider (listing: own + shared; by id: admins may use any, e.g. editing another user's project)
  usable(printerModel: PrinterModel, viewer: ProfileViewer): CustomFilamentRecord[] {
    const rows = this.db
      .prepare(`${SELECT} WHERE p.printer_model = ? AND (p.owner_id = ? OR p.scope = 'shared') ORDER BY p.name COLLATE NOCASE, p.id`)
      .all(printerModel, viewer.id) as Row[];
    return rows.map((r) => this.toRecord(r));
  }

  usableById(printerModel: PrinterModel, id: number, viewer: ProfileViewer): CustomFilamentRecord | null {
    const r = this.row(id);
    return r && r.printer_model === printerModel && this.canUse(r, viewer) ? this.toRecord(r) : null;
  }

  /** `scope`: mine (own, any scope), shared, or all usable (mine + shared, default). `everyone` = admins only. */
  list(viewer: ProfileViewer, scope: 'usable' | 'mine' | 'shared' | 'everyone' = 'usable'): FilamentPreset[] {
    let where: string;
    const args: unknown[] = [];
    if (scope === 'mine') {
      where = 'p.owner_id = ?';
      args.push(viewer.id);
    } else if (scope === 'shared') where = "p.scope = 'shared'";
    else if (scope === 'everyone') {
      if (viewer.role !== 'admin') throw forbidden();
      where = '1 = 1';
    } else {
      where = "(p.owner_id = ? OR p.scope = 'shared')";
      args.push(viewer.id);
    }
    const rows = this.db.prepare(`${SELECT} WHERE ${where} ORDER BY p.name COLLATE NOCASE, p.id`).all(...args) as Row[];
    return rows.map((r) => this.toView(r, viewer));
  }

  get(viewer: ProfileViewer, id: number): FilamentPreset {
    return this.toView(this.visibleRow(id, viewer), viewer);
  }

  /** Names are unique per owner and among shared presets, and never equal a system preset. */
  private assertNameFree(printerModel: PrinterModel, name: string, ownerId: number, scope: FilamentPresetScope, exceptId = 0): void {
    if (this.profiles.isSystemFilament(printerModel, name)) {
      throw new AppError(409, 'filament_presets.name_taken', 'A system filament already has this name');
    }
    const clash = this.db
      .prepare(
        `SELECT 1 FROM filament_presets WHERE id != ? AND printer_model = ? AND name = ? COLLATE NOCASE
           AND (owner_id = ? OR (scope = 'shared' AND ? = 'shared'))`,
      )
      .get(exceptId, printerModel, name, ownerId, scope);
    if (clash) throw new AppError(409, 'filament_presets.name_taken', 'You already have a filament with this name');
  }

  /** The system preset a custom preset inherits from must exist and belong to the model. */
  private assertSystemBase(printerModel: PrinterModel, id: string): void {
    if (customFilamentId(id) !== null || !this.profiles.isSystemFilament(printerModel, id)) {
      throw new AppError(400, 'filament_presets.invalid_base', 'Choose a system filament preset as the base');
    }
  }

  create(viewer: ProfileViewer & { username: string }, body: CreateBody, actor: AuditActor): FilamentPreset {
    if (body.scope === 'shared' && viewer.role !== 'admin') {
      throw forbidden('filament_presets.share_admin_only', 'Only admins can create shared filaments');
    }
    let inherits = body.basePresetId;
    let baseValues: Record<string, string> = {};
    let baseMeta: Pick<CustomFilamentRecord, 'vendor' | 'filamentType' | 'color'> = { vendor: null, filamentType: null, color: null };
    const fromId = customFilamentId(body.basePresetId);
    if (fromId !== null) {
      // Duplicate / save-as from another custom preset: start from its values and inherit its system base.
      const src = this.usableById(body.printerModel, fromId, viewer);
      if (!src) throw new AppError(404, 'profiles.preset_not_found', 'Unknown filament preset');
      inherits = src.inherits;
      baseValues = src.values;
      baseMeta = { vendor: src.vendor, filamentType: src.filamentType, color: src.color };
    }
    this.assertSystemBase(body.printerModel, inherits);
    const values = validateFilamentValues({ ...baseValues, ...body.values });
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM filament_presets WHERE owner_id = ?').get(viewer.id) as { n: number }).n;
    if (count >= MAX_PRESETS_PER_USER) {
      throw new AppError(409, 'filament_presets.too_many', `At most ${MAX_PRESETS_PER_USER} custom filaments per user`);
    }
    this.assertNameFree(body.printerModel, body.name, viewer.id, body.scope);
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO filament_presets (owner_id, scope, printer_model, name, inherits, vendor, filament_type, color, values_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        viewer.id,
        body.scope,
        body.printerModel,
        body.name,
        inherits,
        body.vendor === undefined ? baseMeta.vendor : body.vendor || null,
        body.filamentType === undefined ? baseMeta.filamentType : body.filamentType || null,
        body.color === undefined ? baseMeta.color : body.color,
        JSON.stringify(values),
        now,
        now,
      );
    const id = Number(info.lastInsertRowid);
    this.audit.log('filament_preset.create', actor, body.name, { id, inherits, scope: body.scope, keys: Object.keys(values).length });
    logger.info(`Custom filament #${id} "${body.name}" created by "${viewer.username}" (inherits "${inherits}")`);
    return this.get(viewer, id);
  }

  update(viewer: ProfileViewer, id: number, patch: PatchBody, actor: AuditActor): FilamentPreset {
    const r = this.writableRow(id, viewer);
    if (patch.inherits !== undefined) this.assertSystemBase(r.printer_model, patch.inherits);
    const values = patch.values === undefined ? undefined : validateFilamentValues(patch.values);
    if (patch.name !== undefined && patch.name !== r.name) this.assertNameFree(r.printer_model, patch.name, r.owner_id, r.scope, id);
    const sets: string[] = [];
    const args: unknown[] = [];
    const add = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      args.push(v);
    };
    if (patch.name !== undefined) add('name', patch.name);
    if (patch.inherits !== undefined) add('inherits', patch.inherits);
    if (patch.vendor !== undefined) add('vendor', patch.vendor || null);
    if (patch.filamentType !== undefined) add('filament_type', patch.filamentType || null);
    if (patch.color !== undefined) add('color', patch.color);
    if (values !== undefined) add('values_json', JSON.stringify(values));
    if (sets.length > 0) {
      add('updated_at', Date.now());
      this.db.prepare(`UPDATE filament_presets SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
      this.audit.log('filament_preset.update', actor, patch.name ?? r.name, {
        id,
        fields: Object.keys(patch),
        ...(values && { keys: Object.keys(values).length }),
      });
    }
    return this.get(viewer, id);
  }

  /** Projects keep working: slicing copies the values into the 3MF, so nothing references the row afterwards. */
  delete(viewer: ProfileViewer, id: number, actor: AuditActor): void {
    const r = this.writableRow(id, viewer);
    this.db.prepare('DELETE FROM filament_presets WHERE id = ?').run(id);
    this.audit.log('filament_preset.delete', actor, r.name, { id, ownerId: r.owner_id, scope: r.scope });
  }

  /** Admins only (route guard): share globally or make private again (kept by its owner). */
  setScope(viewer: ProfileViewer, id: number, scope: FilamentPresetScope, actor: AuditActor): FilamentPreset {
    if (viewer.role !== 'admin') throw forbidden('filament_presets.share_admin_only', 'Only admins can share filaments');
    const r = this.visibleRow(id, viewer);
    if (r.scope !== scope) {
      this.assertNameFree(r.printer_model, r.name, r.owner_id, scope, id);
      this.db.prepare('UPDATE filament_presets SET scope = ?, updated_at = ? WHERE id = ?').run(scope, Date.now(), id);
      this.audit.log('filament_preset.share', actor, r.name, { id, scope, ownerId: r.owner_id });
    }
    return this.get(viewer, id);
  }

  /**
   * User deletion: private presets go with the user (`files=delete`) or move to the admin (`transfer`, renamed on
   * a clash); shared presets always move to the acting admin so everyone keeps them. Returns the moved count.
   */
  handOver(userId: number, username: string, adminId: number, mode: 'delete' | 'transfer'): number {
    return this.db.transaction(() => {
      if (mode === 'delete') this.db.prepare("DELETE FROM filament_presets WHERE owner_id = ? AND scope = 'private'").run(userId);
      const rows = this.db.prepare('SELECT id, name, scope, printer_model FROM filament_presets WHERE owner_id = ?').all(userId) as Pick<
        Row,
        'id' | 'name' | 'scope' | 'printer_model'
      >[];
      for (const r of rows) {
        let name = r.name;
        for (let n = 1; this.nameUsedBy(adminId, r.printer_model, name, r.id); n++) {
          name = `${r.name} (${username}${n > 1 ? ` ${n}` : ''})`.slice(0, 100);
          if (n > 50) break;
        }
        this.db.prepare('UPDATE filament_presets SET owner_id = ?, name = ? WHERE id = ?').run(adminId, name, r.id);
      }
      return rows.length;
    })();
  }

  private nameUsedBy(ownerId: number, printerModel: string, name: string, exceptId: number): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM filament_presets WHERE owner_id = ? AND printer_model = ? AND name = ? COLLATE NOCASE AND id != ?')
      .get(ownerId, printerModel, name, exceptId);
  }
}
