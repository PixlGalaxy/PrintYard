import type { Db } from '../../db/client.js';
import { conflict, forbidden, notFound } from '../../errors.js';
import { parseNav3d } from '../account/nav3d.js';
import { SKINS, type AdminUser, type Nav3dPrefs, type Language, type Role, type Skin, type Theme, type ThemeMode, type User, type UserLimits } from '../../types.js';

export interface UserRow {
  id: number;
  username: string;
  email: string | null;
  password_hash: string;
  role: Role;
  is_active: number;
  language: string;
  theme: string;
  /** 0004: NULL = inherit the admin default. */
  theme_mode?: string | null;
  skin?: string | null;
  avatar_path: string | null;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
  /** 0008: may print uploaded (not SliceDock-sliced) G-code. */
  can_print_uploaded_gcode?: number;
  /** 0009: may use the printer jog/temperature/fan controls. */
  can_control_printer?: number;
  /** 0010: 3D navigation preferences (JSON, see Nav3dPrefs); NULL = defaults. */
  nav3d?: string | null;
}

interface LimitsRow {
  user_id: number;
  enabled: number;
  max_grams_per_print: number | null;
  max_grams_per_month: number | null;
  max_hours_per_print: number | null;
  requires_approval: number;
}

export const DEFAULT_LIMITS: UserLimits = {
  enabled: false,
  maxGramsPerPrint: null,
  maxGramsPerMonth: null,
  maxHoursPerPrint: null,
  requiresApproval: false,
};

const asMode = (v: unknown): ThemeMode | null => (v === 'system' || v === 'light' || v === 'dark' ? v : null);
const asSkin = (v: unknown): Skin | null => (SKINS.includes(v as Skin) ? (v as Skin) : null);

export function toUser(row: UserRow): User {
  const themeMode = asMode(row.theme_mode);
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    isActive: row.is_active === 1,
    language: (row.language === 'es' ? 'es' : 'en') as Language,
    theme: (themeMode ?? 'system') as Theme,
    themeMode,
    skin: asSkin(row.skin),
    // Avatars arrive in a later phase; the URL shape is reserved.
    avatarUrl: row.avatar_path ? `/api/users/${row.id}/avatar` : null,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    canControlPrinter: row.role === 'admin' || row.can_control_printer === 1,
    nav3d: parseNav3d(row.nav3d),
  };
}

function toLimits(row: LimitsRow | undefined): UserLimits {
  if (!row) return { ...DEFAULT_LIMITS };
  return {
    enabled: row.enabled === 1,
    maxGramsPerPrint: row.max_grams_per_print,
    maxGramsPerMonth: row.max_grams_per_month,
    maxHoursPerPrint: row.max_hours_per_print,
    requiresApproval: row.requires_approval === 1,
  };
}

export interface CreateUserInput {
  username: string;
  email: string | null;
  passwordHash: string;
  role: Role;
  language: Language;
}

export interface AdminUpdateInput {
  email?: string | null | undefined;
  role?: Role | undefined;
  isActive?: boolean | undefined;
  language?: Language | undefined;
  canPrintUploadedGcode?: boolean | undefined;
  canControlPrinter?: boolean | undefined;
}

export interface ProfileUpdateInput {
  email?: string | null | undefined;
  language?: Language | undefined;
  /** null = inherit the admin default. */
  themeMode?: ThemeMode | null | undefined;
  skin?: Skin | null | undefined;
  /** null = back to the defaults. */
  nav3d?: Nav3dPrefs | null | undefined;
}

function buildUpdate(fields: [column: string, value: unknown][]): { sql: string; values: unknown[] } | null {
  const present = fields.filter(([, v]) => v !== undefined);
  if (present.length === 0) return null;
  return {
    sql: present.map(([c]) => `${c} = ?`).join(', ') + ', updated_at = ?',
    values: [...present.map(([, v]) => v), Date.now()],
  };
}

export class UsersService {
  constructor(private readonly db: Db) {}

  adminExists(): boolean {
    return this.db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get() !== undefined;
  }

  activeAdminCount(): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1").get() as { n: number }
    ).n;
  }

  findRowById(id: number): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  /** Admins always; users when an admin granted `can_print_uploaded_gcode`. */
  canPrintUploadedGcode(id: number): boolean {
    const row = this.findRowById(id);
    return !!row && (row.role === 'admin' || row.can_print_uploaded_gcode === 1);
  }

  /** Admins always; users when an admin granted `can_control_printer` (motion/temperature/fan controls). */
  canControlPrinter(id: number): boolean {
    const row = this.findRowById(id);
    return !!row && row.is_active === 1 && (row.role === 'admin' || row.can_control_printer === 1);
  }

  /** Case-insensitive (column is COLLATE NOCASE). */
  findRowByUsername(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  }

  getUser(id: number): User {
    const row = this.findRowById(id);
    if (!row) throw notFound();
    return toUser(row);
  }

  getAdminUser(id: number): AdminUser {
    const row = this.findRowById(id);
    if (!row) throw notFound();
    const limits = this.db.prepare('SELECT * FROM user_limits WHERE user_id = ?').get(id) as LimitsRow | undefined;
    return { ...toUser(row), limits: toLimits(limits), canPrintUploadedGcode: row.can_print_uploaded_gcode === 1 };
  }

  listAdminUsers(): AdminUser[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY id').all() as UserRow[];
    const limits = new Map(
      (this.db.prepare('SELECT * FROM user_limits').all() as LimitsRow[]).map((l) => [l.user_id, l]),
    );
    return rows.map((r) => ({
      ...toUser(r),
      limits: toLimits(limits.get(r.id)),
      canPrintUploadedGcode: r.can_print_uploaded_gcode === 1,
    }));
  }

  /** Inserts the user plus a disabled limits row. Wrap in a transaction when combined with other writes. */
  create(input: CreateUserInput): number {
    if (this.findRowByUsername(input.username)) throw conflict('users.username_taken', 'Username is already taken');
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO users (username, email, password_hash, role, is_active, language, theme, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, 'system', ?, ?)`,
      )
      .run(input.username, input.email, input.passwordHash, input.role, input.language, now, now);
    const id = Number(result.lastInsertRowid);
    this.db.prepare('INSERT INTO user_limits (user_id, enabled, requires_approval) VALUES (?, 0, 0)').run(id);
    return id;
  }

  /** Admin edit. Guards: never demote/deactivate yourself, nor the last active admin. */
  adminUpdate(actorId: number, id: number, patch: AdminUpdateInput): void {
    this.db.transaction(() => {
      const row = this.findRowById(id);
      if (!row) throw notFound();
      const demoting = patch.role !== undefined && patch.role !== 'admin' && row.role === 'admin';
      const deactivating = patch.isActive === false && row.is_active === 1;
      if ((demoting || deactivating) && id === actorId) {
        throw forbidden('users.cannot_modify_self', 'You cannot demote or deactivate your own account');
      }
      if ((demoting || deactivating) && row.role === 'admin' && row.is_active === 1 && this.activeAdminCount() <= 1) {
        throw conflict('users.last_admin', 'At least one active admin is required');
      }
      const update = buildUpdate([
        ['email', patch.email],
        ['role', patch.role],
        ['is_active', patch.isActive === undefined ? undefined : patch.isActive ? 1 : 0],
        ['language', patch.language],
        ['can_print_uploaded_gcode', patch.canPrintUploadedGcode === undefined ? undefined : patch.canPrintUploadedGcode ? 1 : 0],
        ['can_control_printer', patch.canControlPrinter === undefined ? undefined : patch.canControlPrinter ? 1 : 0],
      ]);
      if (!update) return;
      this.db.prepare(`UPDATE users SET ${update.sql} WHERE id = ?`).run(...update.values, id);
      // A deactivated account is signed out everywhere at once.
      if (deactivating) this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    })();
  }

  /** Delete guards: the user exists, is not yourself and is not the last active admin. */
  assertDeletable(actorId: number, id: number): UserRow {
    const row = this.findRowById(id);
    if (!row) throw notFound();
    if (id === actorId) throw forbidden('users.cannot_delete_self', 'You cannot delete your own account');
    if (row.role === 'admin' && row.is_active === 1 && this.activeAdminCount() <= 1) {
      throw conflict('users.last_admin', 'At least one active admin is required');
    }
    return row;
  }

  /** Guards as above. Sessions and limits cascade; prints keep their username snapshot (user_id set NULL). */
  delete(actorId: number, id: number): UserRow {
    return this.db.transaction(() => {
      const row = this.assertDeletable(actorId, id);
      this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
      return row;
    })();
  }

  setLimits(id: number, limits: UserLimits): void {
    if (!this.findRowById(id)) throw notFound();
    this.db
      .prepare(
        `INSERT INTO user_limits (user_id, enabled, max_grams_per_print, max_grams_per_month, max_hours_per_print, requires_approval)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, max_grams_per_print = excluded.max_grams_per_print,
           max_grams_per_month = excluded.max_grams_per_month, max_hours_per_print = excluded.max_hours_per_print,
           requires_approval = excluded.requires_approval`,
      )
      .run(
        id,
        limits.enabled ? 1 : 0,
        limits.maxGramsPerPrint,
        limits.maxGramsPerMonth,
        limits.maxHoursPerPrint,
        limits.requiresApproval ? 1 : 0,
      );
  }

  setPasswordHash(id: number, hash: string): void {
    const r = this.db
      .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(hash, Date.now(), id);
    if (r.changes === 0) throw notFound();
  }

  updateProfile(id: number, patch: ProfileUpdateInput): void {
    const update = buildUpdate([
      ['email', patch.email],
      ['language', patch.language],
      ['theme_mode', patch.themeMode],
      // Legacy column kept in sync (NOT NULL)
      ['theme', patch.themeMode === undefined ? undefined : (patch.themeMode ?? 'system')],
      ['skin', patch.skin],
      ['nav3d', patch.nav3d === undefined ? undefined : patch.nav3d === null ? null : JSON.stringify(patch.nav3d)],
    ]);
    if (!update) return;
    this.db.prepare(`UPDATE users SET ${update.sql} WHERE id = ?`).run(...update.values, id);
  }

  touchLogin(id: number): void {
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), id);
  }
}
