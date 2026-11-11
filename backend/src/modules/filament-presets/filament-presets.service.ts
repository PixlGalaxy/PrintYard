import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { AppError, forbidden, notFound } from '../../errors.js';
import { CONTROL_CHARS } from '../../lib/sanitize.js';
import { logger } from '../../logger.js';
import type { FilamentPreset, FilamentPresetScope, PrinterModel } from '../../types.js';
import type { AuditActor, AuditService } from '../audit/audit.service.js';
import { cleanName } from '../files/files.service.js';
import { screenOverrides } from '../projects/scene.js';
import {
  CUSTOM_FILAMENT_PREFIX,
  customFilamentId,
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
 * Display name of a user profile (filament or process), cleaned like a file name (`cleanName`: last path segment,
 * no control characters, no `<>:"|?*`). Also written as `filament_settings_id` / `print_settings_id` in the 3MF
 * (G-code header `"a";"b"`), so `;` and `\` are refused.
 */
export const profileNameSchema = z
  .string()
  .max(400)
  .transform((v) => cleanLine(cleanName(cleanLine(v))))
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
export const valuesSchema = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, 'Invalid option key'), z.string().max(4096));

export const createSchema = z.object({
  printerModel: z.literal('creality-k2se').default('creality-k2se'),
  /** System preset id, or `custom:<n>` to copy an existing custom preset (its values become the starting point). */
  basePresetId: z.string().min(1).max(200),
  name: profileNameSchema,
  vendor: metaText(64).nullable().optional(),
  filamentType: typeSchema.nullable().optional(),
  color: colorSchema.nullable().optional(),
  /** Extra overridden keys (e.g. a scene slot's current overrides), layered over the base's custom values. */
  values: valuesSchema.default({}),
  scope: z.enum(['private', 'shared']).default('private'),
});

export const patchSchema = z.object({
  name: profileNameSchema.optional(),
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

/**
 * Validates and normalises custom values: keys must be filament options (same allowlist as slot overrides), values
 * are single-line engine text, numbers are finite and inside the key's bounds and safety caps (temperatures at most
 * the scanner limits, not 500), bools are 0/1, enums known values.
 * `nil` ("use the printer's value") is accepted for the Setting Overrides keys.
 */
export function validateFilamentValues(values: Record<string, string>): Record<string, string> {
  if (Object.keys(values).length > MAX_VALUES) throw new AppError(400, 'filament_presets.too_many_values', `At most ${MAX_VALUES} settings`);
  // Same allowlist, unsafe-key pattern, type/range/safety caps and CR/LF stripping as scene overrides (review 3A #2).
  const { ok: out, badKeys, badValues } = screenOverrides(values, 'filament');
  if (badKeys.length > 0) {
    throw new AppError(400, 'slice.invalid_override', 'Unsupported filament setting', { keys: badKeys.slice(0, 20).map((b) => b.key) });
  }
  if (badValues.length > 0) {
    throw new AppError(400, 'filament_presets.invalid_value', 'Some filament settings have invalid values', {
      keys: badValues.slice(0, 20).map((b) => b.key),
      issues: badValues.slice(0, 20),
    });
  }
  return out;
}

/** Audit detail of a values edit: changed keys with old → new (values are capped, at most 50 keys). */
function changedValues(before: Record<string, string>, after: Record<string, string>): { key: string; from: string | null; to: string | null }[] {
  const out: { key: string; from: string | null; to: string | null }[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const from = before[key] ?? null;
    const to = after[key] ?? null;
    if (from !== to) out.push({ key, from: from?.slice(0, 64) ?? null, to: to?.slice(0, 64) ?? null });
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * Users whose default process/filament is a profile that is gone (deleted) or no longer visible to them (unshared:
 * every user but `keepOwner`) fall back to the bundle default.
 */
export function clearDefaults(db: Db, column: 'default_process_preset' | 'default_filament_preset', presetId: string, keepOwner?: number): void {
  db.prepare(`UPDATE users SET ${column} = NULL WHERE ${column} = ? AND id != ? AND role != 'admin'`).run(presetId, keepOwner ?? 0);
  if (keepOwner === undefined) db.prepare(`UPDATE users SET ${column} = NULL WHERE ${column} = ?`).run(presetId);
}

// ---- service ----

export class FilamentPresetsService implements CustomFilamentProvider {
  constructor(
    private readonly db: Db,
    private readonly profiles: ProfilesService,
    private readonly audit: AuditService,
  ) {}

  private readonly changeListeners = new Set<() => void>();

  /** Called after every stored change (create, edit, delete, share, user hand-over): the printer backup listens. */
  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  private changed(): void {
    for (const cb of this.changeListeners) {
      try {
        cb();
      } catch (err) {
        logger.warn('profile change listener failed', err);
      }
    }
  }

  /** Every stored profile of every user (printer backup). */
  allRecords(): (CustomFilamentRecord & { printerModel: PrinterModel; updatedAt: number })[] {
    const rows = this.db.prepare(`${SELECT} ORDER BY u.username, p.name COLLATE NOCASE, p.id`).all() as Row[];
    return rows.map((r) => ({ ...this.toRecord(r), printerModel: r.printer_model, updatedAt: r.updated_at }));
  }

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
      // Profiles are personal: the owner (or an admin) edits, renames, deletes and shares them; others duplicate.
      canEdit: viewer.role === 'admin' || r.owner_id === viewer.id,
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

  /**
   * Owner or admin (PROFILES: profiles are personal, the owner keeps control of a shared one). Projects and sliced
   * G-code keep a copy of the values, so a later edit only affects new slices; other users can duplicate instead.
   */
  private writableRow(id: number, viewer: ProfileViewer): Row {
    const r = this.visibleRow(id, viewer);
    if (viewer.role === 'admin' || r.owner_id === viewer.id) return r;
    throw forbidden('filament_presets.forbidden', 'Only the owner or an admin can change this filament');
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
  nameFree(printerModel: PrinterModel, name: string, ownerId: number, scope: FilamentPresetScope, exceptId = 0): boolean {
    if (this.profiles.isSystemFilament(printerModel, name)) return false;
    return !this.db
      .prepare(
        `SELECT 1 FROM filament_presets WHERE id != ? AND printer_model = ? AND name = ? COLLATE NOCASE
           AND (owner_id = ? OR (scope = 'shared' AND ? = 'shared'))`,
      )
      .get(exceptId, printerModel, name, ownerId, scope);
  }

  private assertNameFree(printerModel: PrinterModel, name: string, ownerId: number, scope: FilamentPresetScope, exceptId = 0): void {
    if (!this.nameFree(printerModel, name, ownerId, scope, exceptId)) {
      throw new AppError(409, 'filament_presets.name_taken', 'A filament with this name already exists');
    }
  }

  /** The system preset a custom preset inherits from must exist and belong to the model. */
  private assertSystemBase(printerModel: PrinterModel, id: string): void {
    if (customFilamentId(id) !== null || !this.profiles.isSystemFilament(printerModel, id)) {
      throw new AppError(400, 'filament_presets.invalid_base', 'Choose a system filament preset as the base');
    }
  }

  create(viewer: ProfileViewer & { username: string }, body: CreateBody, actor: AuditActor): FilamentPreset {
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
    this.changed();
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
        ownerId: r.owner_id,
        scope: r.scope,
        fields: Object.keys(patch),
        ...(values && { keys: Object.keys(values).length, changed: changedValues(this.toRecord(r).values, values) }),
      });
      this.changed();
    }
    return this.get(viewer, id);
  }

  /** Projects keep working: slicing copies the values into the 3MF, so nothing references the row afterwards. */
  delete(viewer: ProfileViewer, id: number, actor: AuditActor): void {
    const r = this.writableRow(id, viewer);
    this.db.prepare('DELETE FROM filament_presets WHERE id = ?').run(id);
    clearDefaults(this.db, 'default_filament_preset', `${CUSTOM_FILAMENT_PREFIX}${id}`);
    this.audit.log('filament_preset.delete', actor, r.name, { id, ownerId: r.owner_id, scope: r.scope });
    this.changed();
  }

  /** Owner or admin: share with every user, or make private again (other users' defaults on it are cleared). */
  setScope(viewer: ProfileViewer, id: number, scope: FilamentPresetScope, actor: AuditActor): FilamentPreset {
    const r = this.writableRow(id, viewer);
    if (r.scope !== scope) {
      this.assertNameFree(r.printer_model, r.name, r.owner_id, scope, id);
      this.db.prepare('UPDATE filament_presets SET scope = ?, updated_at = ? WHERE id = ?').run(scope, Date.now(), id);
      if (scope === 'private') clearDefaults(this.db, 'default_filament_preset', `${CUSTOM_FILAMENT_PREFIX}${id}`, r.owner_id);
      this.audit.log('filament_preset.share', actor, r.name, { id, scope, ownerId: r.owner_id });
      this.changed();
    }
    return this.get(viewer, id);
  }

  /**
   * User deletion: private presets go with the user (`files=delete`) or move to the admin (`transfer`, renamed on
   * a clash); shared presets always move to the acting admin so everyone keeps them. Returns the moved count.
   */
  handOver(userId: number, username: string, adminId: number, mode: 'delete' | 'transfer'): number {
    const moved = this.db.transaction(() => {
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
    this.changed();
    return moved;
  }

  private nameUsedBy(ownerId: number, printerModel: string, name: string, exceptId: number): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM filament_presets WHERE owner_id = ? AND printer_model = ? AND name = ? COLLATE NOCASE AND id != ?')
      .get(ownerId, printerModel, name, exceptId);
  }
}
