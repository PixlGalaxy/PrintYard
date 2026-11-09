import { z } from 'zod';
import { isValidCidr } from '../lib/ip.js';
import { SKINS, type Skin, type ThemeMode } from '../types.js';
import { NOTIFY_SETTING_DEFS } from '../modules/notifications/settings.js';
import type { Db } from './client.js';

export const SECRET_MASK = '********';

export interface SettingDef<T = unknown> {
  schema: z.ZodType<T>;
  default: T;
  /** Returned as SECRET_MASK; a PATCH carrying SECRET_MASK keeps the stored value. */
  secret?: boolean;
}

/** '' from a cleared input means "unset". */
const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '';
    } catch {
      return false;
    }
  }, 'Must be an http(s) URL')
  .transform((v) => v.replace(/\/+$/, ''));

const def = <T>(schema: z.ZodType<T>, defaultValue: T, secret = false): SettingDef<T> => ({
  schema,
  default: defaultValue,
  secret,
});

/** Phase 1 settings keys with their defaults (contract §Settings keys). */
export const SETTING_DEFS = {
  'app.defaultLanguage': def(z.enum(['en', 'es']), 'en' as 'en' | 'es'),
  // Appearance defaults: every user who has not picked their own mode/skin follows these.
  'appearance.defaultMode': def(z.enum(['system', 'light', 'dark']), 'system' as ThemeMode),
  'appearance.defaultSkin': def(z.enum(SKINS), 'sky' as Skin),
  'admin.email': def(z.preprocess(emptyToNull, z.email().max(254).nullable()), null as string | null),
  'exposure.mode': def(z.enum(['none', 'cloudflare', 'nginx', 'other']), 'none' as 'none' | 'cloudflare' | 'nginx' | 'other'),
  'exposure.trustedProxies': def(
    z.array(z.string().trim().refine(isValidCidr, 'Must be an IP or CIDR')).max(64),
    [] as string[],
  ),
  'exposure.publicUrl': def(z.preprocess(emptyToNull, httpUrl.nullable()), null as string | null),
  'security.sessionHours': def(z.number().int().min(1).max(24 * 365), 168),
  'security.idleMinutes': def(z.number().int().min(0).max(60 * 24 * 365), 0),
  'engine.selected': def(z.enum(['creality', 'orca']), 'creality' as 'creality' | 'orca'),
  'engine.autoUpdate': def(z.boolean(), true),
  'engine.checkIntervalHours': def(z.number().int().min(1).max(24 * 30), 24),
  // Phase 2 (B1): file library + slicing
  'files.retention.enabled': def(z.boolean(), true),
  'files.retention.keep': def(z.number().int().min(1).max(10_000), 10),
  'files.maxUploadMb': def(z.number().int().min(1).max(4096), 200),
  // Per-user storage quota (all files incl. shared/pinned); 0 = unlimited. Admins are never limited.
  'files.quotaMb': def(z.number().int().min(0).max(10_485_760), 2048),
  'slicing.timeoutMinutes': def(z.number().int().min(1).max(240), 15),
  /** 0 = automatic (75 % of the container memory limit, or 4096 MB without one). */
  'slicing.maxMemoryMb': def(z.number().int().min(0).max(1_048_576), 0),
  // Printer-side retention: after each upload keep only the newest N files SliceDock uploaded to that printer.
  'printers.retention.enabled': def(z.boolean(), true),
  'printers.retention.keep': def(z.number().int().min(1).max(1000), 10),
  // B2: default of the "Print calibration" toggle (Creality `enableSelfTest`) when a request does not say.
  'printing.calibrateByDefault': def(z.boolean(), false),
  'limits.costPerKg': def(z.number().min(0).max(1_000_000).nullable(), null as number | null),
  'limits.currency': def(
    z
      .string()
      .trim()
      .transform((v) => v.toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code')),
    'USD',
  ),
  // Phase 4: admin notification channels (Discord, Telegram, ntfy, webhook); see modules/notifications/settings.ts
  ...NOTIFY_SETTING_DEFS,
} satisfies Record<string, SettingDef<any>>;

export type SettingDefs = Record<string, SettingDef<any>>;
export type SettingKey = keyof typeof SETTING_DEFS;
export type SettingValues = { [K in SettingKey]: (typeof SETTING_DEFS)[K]['default'] };

export interface PatchIssue {
  key: string;
  message: string;
}

export class SettingsValidationError extends Error {
  constructor(readonly issues: PatchIssue[]) {
    super('Invalid settings');
  }
}

/** Replaces non-empty secret values with SECRET_MASK. */
export function maskSettings(values: Record<string, unknown>, defs: SettingDefs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const isSet = value !== null && value !== undefined && value !== '';
    out[key] = defs[key]?.secret && isSet ? SECRET_MASK : value;
  }
  return out;
}

/**
 * Validates a partial update against the definitions. Unknown keys and invalid values are reported all at once;
 * secrets sent back as SECRET_MASK are dropped (unchanged). Returns only the keys to write.
 */
export function validatePatch(input: unknown, defs: SettingDefs): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new SettingsValidationError([{ key: '', message: 'Body must be an object of settings' }]);
  }
  const issues: PatchIssue[] = [];
  const updates: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input)) {
    const d = Object.hasOwn(defs, key) ? defs[key] : undefined;
    if (!d) {
      issues.push({ key, message: 'Unknown setting' });
      continue;
    }
    if (d.secret && raw === SECRET_MASK) continue;
    const parsed = d.schema.safeParse(raw);
    if (!parsed.success) {
      issues.push({ key, message: parsed.error.issues.map((i) => i.message).join('; ') });
      continue;
    }
    updates[key] = parsed.data;
  }
  if (issues.length > 0) throw new SettingsValidationError(issues);
  return updates;
}

/** Key/value settings stored as JSON in `settings`, merged over the defaults, cached in memory. */
export class SettingsService<D extends SettingDefs = typeof SETTING_DEFS> {
  private cache: Map<string, unknown> | null = null;
  private readonly listeners = new Set<(changed: string[]) => void>();

  constructor(
    private readonly db: Db,
    readonly defs: D = SETTING_DEFS as unknown as D,
  ) {}

  private load(): Map<string, unknown> {
    if (this.cache) return this.cache;
    const map = new Map<string, unknown>();
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    for (const row of rows) {
      const d = this.defs[row.key];
      if (!d) continue; // stale key from another version: ignore
      try {
        const parsed = d.schema.safeParse(JSON.parse(row.value));
        if (parsed.success) map.set(row.key, parsed.data);
      } catch {
        /* corrupt JSON: fall back to the default */
      }
    }
    this.cache = map;
    return map;
  }

  get<K extends keyof D & string>(key: K): D[K]['default'] {
    const map = this.load();
    return (map.has(key) ? map.get(key) : structuredClone(this.defs[key]!.default)) as D[K]['default'];
  }

  /** Every key, merged with defaults (secrets unmasked: server-side use only). */
  getAll(): { [K in keyof D]: D[K]['default'] } {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(this.defs)) out[key] = this.get(key);
    return out as { [K in keyof D]: D[K]['default'] };
  }

  /** What the admin API returns. */
  getAllMasked(): Record<string, unknown> {
    return maskSettings(this.getAll(), this.defs);
  }

  /** Validates then writes in one transaction. Returns the keys whose stored value actually changed. */
  patch(input: unknown): string[] {
    const updates = validatePatch(input, this.defs);
    return this.writeValidated(updates);
  }

  /** Writes already-validated values (also used by setup inside its own transaction). */
  writeValidated(updates: Record<string, unknown>): string[] {
    const current = this.getAll() as Record<string, unknown>;
    const changed = Object.keys(updates).filter((k) => JSON.stringify(current[k]) !== JSON.stringify(updates[k]));
    if (changed.length === 0) return [];
    const now = Date.now();
    const stmt = this.db.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    );
    this.db.transaction(() => {
      for (const key of changed) stmt.run(key, JSON.stringify(updates[key]), now);
    })();
    this.cache = null;
    for (const l of this.listeners) l(changed);
    return changed;
  }

  onChange(listener: (changed: string[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  invalidate(): void {
    this.cache = null;
  }
}
