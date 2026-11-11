import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { AppError, forbidden, notFound } from '../../errors.js';
import { logger } from '../../logger.js';
import type { FilamentPresetScope, PrinterModel, ProcessProfile } from '../../types.js';
import type { AuditActor, AuditService } from '../audit/audit.service.js';
import { clearDefaults, profileNameSchema, valuesSchema } from '../filament-presets/filament-presets.service.js';
import { screenOverrides } from '../projects/scene.js';
import {
  CUSTOM_FILAMENT_PREFIX,
  customFilamentId,
  type CustomProcessProvider,
  type CustomProcessRecord,
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
  values_json: string;
  created_at: number;
  updated_at: number;
}

const SELECT = 'SELECT p.*, u.username AS owner_name FROM process_profiles p JOIN users u ON u.id = p.owner_id';

/** Most process profiles one user may own. */
export const MAX_PROCESS_PROFILES_PER_USER = 200;
/** The process tab has ~400 options; a profile overrides at most all of them. */
const MAX_VALUES = 500;

export const processCreateSchema = z.object({
  printerModel: z.literal('creality-k2se').default('creality-k2se'),
  /** System process preset name, or `custom:<n>` to duplicate a profile the viewer can see. */
  basePresetId: z.string().min(1).max(200),
  name: profileNameSchema,
  values: valuesSchema.default({}),
  scope: z.enum(['private', 'shared']).default('private'),
});

export const processPatchSchema = z.object({
  name: profileNameSchema.optional(),
  /** Another system parent (values are kept). */
  inherits: z.string().min(1).max(200).optional(),
  /** Replaces the whole set of overridden keys. */
  values: valuesSchema.optional(),
});

export type ProcessCreateBody = z.infer<typeof processCreateSchema>;
export type ProcessPatchBody = z.infer<typeof processPatchSchema>;

/**
 * Validates and normalises process profile values with the checks scene `processOverrides` get at slice time
 * (`screenOverrides`): process option allowlist, no G-code / output keys, typed ranges and safety caps, CR/LF
 * stripped. Anything failing is refused (400), never stored.
 */
export function validateProcessValues(values: Record<string, string>): Record<string, string> {
  if (Object.keys(values).length > MAX_VALUES) throw new AppError(400, 'filament_presets.too_many_values', `At most ${MAX_VALUES} settings`);
  const { ok, badKeys, badValues } = screenOverrides(values, 'process');
  if (badKeys.length > 0) {
    throw new AppError(400, 'slice.invalid_override', 'Unsupported process setting', { keys: badKeys.slice(0, 20).map((b) => b.key) });
  }
  if (badValues.length > 0) {
    throw new AppError(400, 'filament_presets.invalid_value', 'Some process settings have invalid values', {
      keys: badValues.slice(0, 20).map((b) => b.key),
      issues: badValues.slice(0, 20),
    });
  }
  return ok;
}

function parseValues(json: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
    }
  } catch {
    /* corrupt row: no values */
  }
  return out;
}

/** User process profiles (PROFILES tab). Mirrors FilamentPresetsService: personal, optionally shared with everyone. */
export class ProcessProfilesService implements CustomProcessProvider {
  constructor(
    private readonly db: Db,
    private readonly profiles: ProfilesService,
    private readonly audit: AuditService,
  ) {}

  private toRecord(r: Row): CustomProcessRecord {
    return { id: r.id, ownerId: r.owner_id, ownerName: r.owner_name, scope: r.scope, name: r.name, inherits: r.inherits, values: parseValues(r.values_json) };
  }

  private toView(r: Row, viewer: ProfileViewer): ProcessProfile {
    return {
      id: r.id,
      presetId: `${CUSTOM_FILAMENT_PREFIX}${r.id}`,
      ownerId: r.owner_id,
      ownerName: r.owner_name,
      scope: r.scope,
      printerModel: r.printer_model,
      name: r.name,
      inherits: r.inherits,
      values: parseValues(r.values_json),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      canEdit: viewer.role === 'admin' || r.owner_id === viewer.id,
    };
  }

  private row(id: number): Row | undefined {
    return this.db.prepare(`${SELECT} WHERE p.id = ?`).get(id) as Row | undefined;
  }

  private canUse(r: Row, viewer: ProfileViewer): boolean {
    return r.scope === 'shared' || r.owner_id === viewer.id || viewer.role === 'admin';
  }

  /** Another user's private profile is a 404 (admins see every profile). */
  private visibleRow(id: number, viewer: ProfileViewer): Row {
    const r = this.row(id);
    if (!r || !this.canUse(r, viewer)) throw notFound();
    return r;
  }

  private writableRow(id: number, viewer: ProfileViewer): Row {
    const r = this.visibleRow(id, viewer);
    if (viewer.role === 'admin' || r.owner_id === viewer.id) return r;
    throw forbidden('profiles.forbidden', 'Only the owner or an admin can change this profile');
  }

  // CustomProcessProvider
  usable(printerModel: PrinterModel, viewer: ProfileViewer): CustomProcessRecord[] {
    const rows = this.db
      .prepare(`${SELECT} WHERE p.printer_model = ? AND (p.owner_id = ? OR p.scope = 'shared') ORDER BY p.name COLLATE NOCASE, p.id`)
      .all(printerModel, viewer.id) as Row[];
    return rows.map((r) => this.toRecord(r));
  }

  usableById(printerModel: PrinterModel, id: number, viewer: ProfileViewer): CustomProcessRecord | null {
    const r = this.row(id);
    return r && r.printer_model === printerModel && this.canUse(r, viewer) ? this.toRecord(r) : null;
  }

  list(viewer: ProfileViewer, scope: 'usable' | 'mine' | 'shared' | 'everyone' = 'usable'): ProcessProfile[] {
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

  get(viewer: ProfileViewer, id: number): ProcessProfile {
    return this.toView(this.visibleRow(id, viewer), viewer);
  }

  /** true when `name` is free for `ownerId` (and among shared profiles when `scope` is shared). */
  nameFree(printerModel: PrinterModel, name: string, ownerId: number, scope: FilamentPresetScope, exceptId = 0): boolean {
    if (this.profiles.isSystemProcess(printerModel, name)) return false;
    return !this.db
      .prepare(
        `SELECT 1 FROM process_profiles WHERE id != ? AND printer_model = ? AND name = ? COLLATE NOCASE
           AND (owner_id = ? OR (scope = 'shared' AND ? = 'shared'))`,
      )
      .get(exceptId, printerModel, name, ownerId, scope);
  }

  private assertNameFree(printerModel: PrinterModel, name: string, ownerId: number, scope: FilamentPresetScope, exceptId = 0): void {
    if (!this.nameFree(printerModel, name, ownerId, scope, exceptId)) {
      throw new AppError(409, 'profiles.name_taken', 'A profile with this name already exists');
    }
  }

  private assertSystemBase(printerModel: PrinterModel, id: string): void {
    if (customFilamentId(id) !== null || !this.profiles.isSystemProcess(printerModel, id)) {
      throw new AppError(400, 'profiles.invalid_base', 'Choose a system process preset as the parent');
    }
  }

  count(ownerId: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM process_profiles WHERE owner_id = ?').get(ownerId) as { n: number }).n;
  }

  create(viewer: ProfileViewer & { username: string }, body: ProcessCreateBody, actor: AuditActor, via: 'web' | 'import' = 'web'): ProcessProfile {
    let inherits = body.basePresetId;
    let baseValues: Record<string, string> = {};
    const fromId = customFilamentId(body.basePresetId);
    if (fromId !== null) {
      // Duplicate: start from the source profile's values (shared ones from other users included) and its parent.
      const src = this.usableById(body.printerModel, fromId, viewer);
      if (!src) throw new AppError(404, 'profiles.preset_not_found', 'Unknown process profile', { kind: 'process', id: body.basePresetId });
      inherits = src.inherits;
      baseValues = src.values;
    }
    this.assertSystemBase(body.printerModel, inherits);
    const values = validateProcessValues({ ...baseValues, ...body.values });
    if (this.count(viewer.id) >= MAX_PROCESS_PROFILES_PER_USER) {
      throw new AppError(409, 'profiles.too_many', `At most ${MAX_PROCESS_PROFILES_PER_USER} process profiles per user`);
    }
    this.assertNameFree(body.printerModel, body.name, viewer.id, body.scope);
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO process_profiles (owner_id, scope, printer_model, name, inherits, values_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(viewer.id, body.scope, body.printerModel, body.name, inherits, JSON.stringify(values), now, now);
    const id = Number(info.lastInsertRowid);
    this.audit.log('process_profile.create', actor, body.name, { id, inherits, scope: body.scope, keys: Object.keys(values).length, via });
    logger.info(`Process profile #${id} "${body.name}" created by "${viewer.username}" (inherits "${inherits}")`);
    return this.get(viewer, id);
  }

  update(viewer: ProfileViewer, id: number, patch: ProcessPatchBody, actor: AuditActor): ProcessProfile {
    const r = this.writableRow(id, viewer);
    if (patch.inherits !== undefined) this.assertSystemBase(r.printer_model, patch.inherits);
    const values = patch.values === undefined ? undefined : validateProcessValues(patch.values);
    if (patch.name !== undefined && patch.name !== r.name) this.assertNameFree(r.printer_model, patch.name, r.owner_id, r.scope, id);
    const sets: string[] = [];
    const args: unknown[] = [];
    const add = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      args.push(v);
    };
    if (patch.name !== undefined) add('name', patch.name);
    if (patch.inherits !== undefined) add('inherits', patch.inherits);
    if (values !== undefined) add('values_json', JSON.stringify(values));
    if (sets.length > 0) {
      add('updated_at', Date.now());
      this.db.prepare(`UPDATE process_profiles SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
      this.audit.log('process_profile.update', actor, patch.name ?? r.name, {
        id,
        ownerId: r.owner_id,
        scope: r.scope,
        fields: Object.keys(patch),
        ...(values && { keys: Object.keys(values).length }),
      });
    }
    return this.get(viewer, id);
  }

  /** Projects keep working: a build copies the values into the 3MF. Slicing a scene that still names it fails. */
  delete(viewer: ProfileViewer, id: number, actor: AuditActor): void {
    const r = this.writableRow(id, viewer);
    this.db.prepare('DELETE FROM process_profiles WHERE id = ?').run(id);
    clearDefaults(this.db, 'default_process_preset', `${CUSTOM_FILAMENT_PREFIX}${id}`);
    this.audit.log('process_profile.delete', actor, r.name, { id, ownerId: r.owner_id, scope: r.scope });
  }

  setScope(viewer: ProfileViewer, id: number, scope: FilamentPresetScope, actor: AuditActor): ProcessProfile {
    const r = this.writableRow(id, viewer);
    if (r.scope !== scope) {
      this.assertNameFree(r.printer_model, r.name, r.owner_id, scope, id);
      this.db.prepare('UPDATE process_profiles SET scope = ?, updated_at = ? WHERE id = ?').run(scope, Date.now(), id);
      if (scope === 'private') clearDefaults(this.db, 'default_process_preset', `${CUSTOM_FILAMENT_PREFIX}${id}`, r.owner_id);
      this.audit.log('process_profile.share', actor, r.name, { id, scope, ownerId: r.owner_id });
    }
    return this.get(viewer, id);
  }

  /** User deletion: same rules as filament presets (private ones deleted or moved, shared ones always moved). */
  handOver(userId: number, username: string, adminId: number, mode: 'delete' | 'transfer'): number {
    return this.db.transaction(() => {
      if (mode === 'delete') this.db.prepare("DELETE FROM process_profiles WHERE owner_id = ? AND scope = 'private'").run(userId);
      const rows = this.db.prepare('SELECT id, name, printer_model FROM process_profiles WHERE owner_id = ?').all(userId) as Pick<Row, 'id' | 'name' | 'printer_model'>[];
      for (const r of rows) {
        let name = r.name;
        for (let n = 1; n <= 50 && this.nameUsedBy(adminId, r.printer_model, name, r.id); n++) {
          name = `${r.name} (${username}${n > 1 ? ` ${n}` : ''})`.slice(0, 100);
        }
        this.db.prepare('UPDATE process_profiles SET owner_id = ?, name = ? WHERE id = ?').run(adminId, name, r.id);
      }
      return rows.length;
    })();
  }

  private nameUsedBy(ownerId: number, printerModel: string, name: string, exceptId: number): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM process_profiles WHERE owner_id = ? AND printer_model = ? AND name = ? COLLATE NOCASE AND id != ?')
      .get(ownerId, printerModel, name, exceptId);
  }
}
