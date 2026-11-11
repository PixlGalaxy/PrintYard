// PRINTER-PRESETS: a copy of every user's process profiles and custom filaments on the printer itself, so a PrintYard
// reinstall (lost /appdata) can get them back. The K2 SE has no place for user presets (Creality Print syncs them to
// Creality Cloud), so PrintYard writes ONE JSON file into Moonraker's `config` root (`printyard/profiles-backup.json`):
// a plain file upload, never printer.cfg, no restart, safe while printing. Debounced, fire-and-forget: a failure is
// logged and shown in Admin → Printers, it never blocks a profile save. Restoring reads the file back as untrusted
// input (size cap, shape validation) and imports it through the profile import path (same screening, "Name (2)").
import { z } from 'zod';
import type { SettingsService } from '../../db/settings.js';
import { AppError } from '../../errors.js';
import { logger } from '../../logger.js';
import type { PrinterManager } from '../../printers/manager.js';
import type { PrinterModel, ProfileImportReport, ProfilesBackupPreview, ProfilesBackupStatus } from '../../types.js';
import type { AuditActor, AuditService } from '../audit/audit.service.js';
import type { FilamentPresetsService } from '../filament-presets/filament-presets.service.js';
import type { PrintersService } from '../printers/printers.service.js';
import type { ProcessProfilesService } from '../process-profiles/process-profiles.service.js';
import type { ImportItem, ProfileFilesService } from '../profile-files/profile-files.service.js';
import type { UsersService } from '../users/users.service.js';

export const BACKUP_PATH = 'printyard/profiles-backup.json';
export const BACKUP_FORMAT = 'printyard-profiles-backup';
/** Pre-rename location and format id (SliceDock): restore still reads them, they are never written. */
export const LEGACY_BACKUP_PATH = 'slicedock/profiles-backup.json';
export const LEGACY_BACKUP_FORMAT = 'slicedock-profiles-backup';
const MODEL: PrinterModel = 'creality-k2se';
/** Largest backup file read back from the printer (400 profiles × 500 keys stays far below). */
export const MAX_BACKUP_BYTES = 4 * 1024 * 1024;
const MAX_ITEMS = 2000;
const MAX_PREVIEW_ITEMS = 500;

const valueRecord = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), z.string().max(4096)).refine((v) => Object.keys(v).length <= 600, 'Too many values');
const name = z.string().min(1).max(200);
const owner = z.string().min(1).max(64);
const processItem = z.object({ owner, shared: z.boolean(), name, inherits: z.string().max(200), values: valueRecord, updatedAt: z.string().max(40).optional() });
const filamentItem = processItem.extend({
  vendor: z.string().max(64).nullable().optional(),
  filamentType: z.string().max(32).nullable().optional(),
  color: z.string().max(16).nullable().optional(),
});

/** Shape of the backup file (versioned; unknown extra fields are ignored). */
const backupShape = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.literal(1),
  printyardVersion: z.string().max(64),
  createdAt: z.string().max(40),
  printerModel: z.string().max(64),
  process: z.array(processItem).max(MAX_ITEMS),
  filament: z.array(filamentItem).max(MAX_ITEMS),
});
export type ProfilesBackup = z.infer<typeof backupShape>;

/** A pre-rename file (`slicedock-profiles-backup`, `slicedockVersion`) read as the current shape. */
function upgradeLegacyBackup(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const o = v as Record<string, unknown>;
  if (o.format !== LEGACY_BACKUP_FORMAT) return v;
  const { slicedockVersion, ...rest } = o;
  return { ...rest, format: BACKUP_FORMAT, printyardVersion: rest.printyardVersion ?? slicedockVersion };
}

/** Validates a backup file, current or pre-rename. */
export const backupSchema = z.preprocess(upgradeLegacyBackup, backupShape);

interface PrinterState {
  lastBackupAt: number | null;
  lastAttemptAt: number | null;
  lastError: string | null;
  pending: boolean;
  /** Content of the last successful write (nothing changed → no rewrite on reconnect). */
  lastHash: string | null;
}

export interface ProfilesBackupDeps {
  settings: SettingsService;
  manager: PrinterManager;
  printers: PrintersService;
  users: UsersService;
  processProfiles: ProcessProfilesService;
  filamentPresets: FilamentPresetsService;
  profileFiles: ProfileFilesService;
  audit: AuditService;
  version: string;
  /** Debounce after a change (default 8 s). */
  debounceMs?: number;
}

type Viewer = { id: number; role: 'admin' | 'user'; username: string };

const sortedJson = (v: Record<string, string>) => JSON.stringify(Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))));

export class ProfilesBackupService {
  private readonly state = new Map<number, PrinterState>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private readonly unsubscribers: (() => void)[] = [];

  constructor(private readonly deps: ProfilesBackupDeps) {}

  enabled(): boolean {
    return this.deps.settings.get('printers.profilesBackup.enabled');
  }

  /** Listens to profile changes, printer reconnects and the on/off setting. */
  attach(): void {
    if (this.unsubscribers.length) return;
    const changed = () => this.markPending();
    this.unsubscribers.push(this.deps.processProfiles.onChange(changed), this.deps.filamentPresets.onChange(changed));
    this.unsubscribers.push(
      this.deps.manager.onStatus((s, prev) => {
        // Back online: write what changed meanwhile (and once per server start, so the status is known).
        if (s.online && !prev?.online && this.enabled()) {
          const st = this.stateOf(s.printerId);
          if (st.pending || st.lastBackupAt === null) this.schedule();
        }
      }),
    );
    this.unsubscribers.push(
      this.deps.settings.onChange((keys) => {
        if (keys.includes('printers.profilesBackup.enabled') && this.enabled()) this.markPending();
      }),
    );
  }

  stop(): void {
    for (const u of this.unsubscribers.splice(0)) u();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private stateOf(printerId: number): PrinterState {
    let s = this.state.get(printerId);
    if (!s) {
      s = { lastBackupAt: null, lastAttemptAt: null, lastError: null, pending: false, lastHash: null };
      this.state.set(printerId, s);
    }
    return s;
  }

  private markPending(): void {
    if (!this.enabled()) return;
    for (const p of this.deps.printers.list()) if (p.model === MODEL) this.stateOf(p.id).pending = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runNow();
    }, this.deps.debounceMs ?? 8000);
    this.timer.unref?.();
  }

  /** Runs one backup pass now (serialised; a change during a pass triggers another one). */
  runNow(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.pass();
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** The backup document (no ids, no secrets: owner usernames, names, parents, values and metadata only). */
  build(): ProfilesBackup {
    const iso = (ms: number) => new Date(ms).toISOString();
    return {
      format: BACKUP_FORMAT,
      version: 1,
      printyardVersion: this.deps.version.slice(0, 64),
      createdAt: new Date().toISOString(),
      printerModel: MODEL,
      process: this.deps.processProfiles
        .allRecords()
        .filter((r) => r.printerModel === MODEL)
        .map((r) => ({ owner: r.ownerName, shared: r.scope === 'shared', name: r.name, inherits: r.inherits, values: r.values, updatedAt: iso(r.updatedAt) })),
      filament: this.deps.filamentPresets
        .allRecords()
        .filter((r) => r.printerModel === MODEL)
        .map((r) => ({
          owner: r.ownerName,
          shared: r.scope === 'shared',
          name: r.name,
          inherits: r.inherits,
          vendor: r.vendor,
          filamentType: r.filamentType,
          color: r.color,
          values: r.values,
          updatedAt: iso(r.updatedAt),
        })),
    };
  }

  private async pass(): Promise<void> {
    if (!this.enabled()) return;
    const doc = this.build();
    const { createdAt: _skip, ...stable } = doc;
    const hash = JSON.stringify(stable);
    const data = Buffer.from(JSON.stringify(doc, null, 1));
    for (const p of this.deps.printers.list()) {
      if (p.model !== MODEL) continue;
      const st = this.stateOf(p.id);
      if (!this.deps.manager.status(p.id).online || !this.deps.manager.hasDriver(p.id)) {
        st.pending = true; // written when it comes back
        continue;
      }
      if (!st.pending && st.lastHash === hash) continue;
      const driver = this.deps.manager.driver(p.id);
      if (!driver.writeConfigFile) continue;
      st.lastAttemptAt = Date.now();
      try {
        await driver.writeConfigFile(BACKUP_PATH, data);
        st.lastBackupAt = Date.now();
        st.lastError = null;
        st.pending = false;
        st.lastHash = hash;
        logger.printer.info(`printer #${p.id}: profiles backup written (${doc.process.length} process, ${doc.filament.length} filament)`);
      } catch (err) {
        st.lastError = err instanceof AppError ? err.code : 'profiles_backup.write_failed';
        st.pending = true;
        logger.printer.warn(`printer #${p.id}: profiles backup failed (${(err as Error).message})`);
      }
    }
  }

  status(): ProfilesBackupStatus {
    const counts = { process: this.deps.processProfiles.allRecords().length, filament: this.deps.filamentPresets.allRecords().length };
    return {
      enabled: this.enabled(),
      path: BACKUP_PATH,
      printers: this.deps.printers
        .list()
        .filter((p) => p.model === MODEL)
        .map((p) => {
          const st = this.stateOf(p.id);
          return {
            printerId: p.id,
            name: p.name,
            online: this.deps.manager.status(p.id).online,
            lastBackupAt: st.lastBackupAt,
            lastAttemptAt: st.lastAttemptAt,
            lastError: st.lastError,
            pending: st.pending || this.timer !== null,
            ...counts,
          };
        }),
    };
  }

  /** Admin "Back up now": writes immediately (even when nothing changed). */
  async backupNow(actor: AuditActor): Promise<ProfilesBackupStatus> {
    if (!this.enabled()) throw new AppError(409, 'profiles_backup.disabled', 'The profiles backup is turned off');
    for (const p of this.deps.printers.list()) if (p.model === MODEL) this.stateOf(p.id).pending = true;
    await this.runNow();
    this.deps.audit.log('profiles_backup.run', actor, null, {});
    return this.status();
  }

  // ---------- restore ----------

  /** Reads and validates the printer's backup file (untrusted: size cap, JSON shape). */
  async read(printerId: number): Promise<ProfilesBackup> {
    this.deps.printers.get(printerId);
    if (!this.deps.manager.status(printerId).online || !this.deps.manager.hasDriver(printerId)) {
      throw new AppError(409, 'prints.printer_offline', 'The printer is offline');
    }
    const driver = this.deps.manager.driver(printerId);
    if (!driver.readConfigFile) throw new AppError(409, 'profiles_backup.unsupported', 'This printer cannot hold a backup');
    // Backups written before the rename live in `slicedock/`: read there when the new file is missing.
    const buf = (await driver.readConfigFile(BACKUP_PATH, MAX_BACKUP_BYTES)) ?? (await driver.readConfigFile(LEGACY_BACKUP_PATH, MAX_BACKUP_BYTES));
    if (!buf) throw new AppError(404, 'profiles_backup.not_found', 'There is no PrintYard backup on this printer');
    let json: unknown;
    try {
      json = JSON.parse(buf.toString('utf8').replace(/^﻿/, ''));
    } catch {
      throw new AppError(422, 'profiles_backup.invalid', 'The backup file on the printer is not valid JSON');
    }
    const parsed = backupSchema.safeParse(json);
    if (!parsed.success) {
      throw new AppError(422, 'profiles_backup.invalid', 'The backup file on the printer is not a PrintYard profiles backup', {
        issues: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join('.').slice(0, 80), message: i.message.slice(0, 120) })),
      });
    }
    return parsed.data;
  }

  /** Owner by username (active users), else the restoring admin. */
  private ownerFor(username: string, admin: Viewer): { viewer: Viewer; known: boolean } {
    const row = this.deps.users.findRowByUsername(username);
    if (row && row.is_active === 1) return { viewer: { id: row.id, role: row.role, username: row.username }, known: true };
    return { viewer: admin, known: false };
  }

  /** Already there: same owner, name, parent and values (restoring twice creates nothing). */
  private exists(kind: 'process' | 'filament', ownerId: number, item: { name: string; inherits: string; values: Record<string, string> }): boolean {
    const records = kind === 'process' ? this.deps.processProfiles.allRecords() : this.deps.filamentPresets.allRecords();
    const values = sortedJson(item.values);
    return records.some((r) => r.ownerId === ownerId && r.name.toLowerCase() === item.name.toLowerCase() && r.inherits === item.inherits && sortedJson(r.values) === values);
  }

  private plan(doc: ProfilesBackup, admin: Viewer) {
    const taken = new Map<string, Set<string>>();
    const items: (ProfilesBackupPreview['items'][number] & { ownerViewer: Viewer; item: ImportItem })[] = [];
    const add = (kind: 'process' | 'filament', it: ProfilesBackup['process'][number] & Partial<ProfilesBackup['filament'][number]>, i: number) => {
      const { viewer, known } = this.ownerFor(it.owner, admin);
      const scope = it.shared ? 'shared' : 'private';
      const unchanged = this.exists(kind, viewer.id, it);
      const key = `${kind}|${viewer.id}`;
      const used = taken.get(key) ?? new Set<string>();
      taken.set(key, used);
      const finalName = unchanged ? it.name : (this.deps.profileFiles.freeName(kind, it.name, viewer, scope, used) ?? it.name);
      if (!unchanged) used.add(finalName.toLowerCase());
      // Same shape as a Creality user preset JSON, so it takes the import path unchanged.
      const obj: Record<string, unknown> = { ...it.values, name: it.name, inherits: it.inherits };
      if (kind === 'filament') {
        if (it.filamentType) obj.filament_type = it.filamentType;
        if (it.vendor) obj.filament_vendor = it.vendor;
        if (it.color) obj.default_filament_colour = it.color;
      }
      items.push({
        kind,
        name: it.name,
        owner: it.owner,
        restoreOwner: viewer.username,
        ownerKnown: known,
        shared: it.shared,
        action: unchanged ? 'unchanged' : 'create',
        finalName,
        ownerViewer: viewer,
        item: { kind, entry: `${kind}[${i}] ${it.name}`.slice(0, 200), obj, scope },
      });
    };
    doc.process.forEach((it, i) => add('process', it, i));
    doc.filament.forEach((it, i) => add('filament', it, i));
    return items;
  }

  async preview(printerId: number, admin: Viewer): Promise<ProfilesBackupPreview> {
    const doc = await this.read(printerId);
    const items = this.plan(doc, admin);
    const create = items.filter((i) => i.action === 'create');
    return {
      printerId,
      createdAt: doc.createdAt,
      printyardVersion: doc.printyardVersion,
      counts: {
        process: doc.process.length,
        filament: doc.filament.length,
        create: create.length,
        unchanged: items.length - create.length,
        renamed: create.filter((i) => i.finalName !== i.name).length,
        ownerMapped: items.filter((i) => !i.ownerKnown).length,
      },
      items: items.slice(0, MAX_PREVIEW_ITEMS).map(({ ownerViewer: _v, item: _i, ...rest }) => rest),
    };
  }

  /** Imports the printer's backup (read again: the file may have changed since the preview). Admin only. */
  async restore(printerId: number, admin: Viewer, actor: AuditActor): Promise<ProfileImportReport> {
    const doc = await this.read(printerId);
    const report: ProfileImportReport = { created: [], skipped: [], dropped: [], remapped: [], renamed: [] };
    const byOwner = new Map<number, { viewer: Viewer; items: ImportItem[] }>();
    for (const p of this.plan(doc, admin)) {
      if (p.action !== 'create') continue;
      const group = byOwner.get(p.ownerViewer.id) ?? { viewer: p.ownerViewer, items: [] };
      group.items.push(p.item);
      byOwner.set(p.ownerViewer.id, group);
    }
    for (const { viewer, items } of byOwner.values()) this.deps.profileFiles.importItems(viewer, items, actor, report);
    this.deps.audit.log('profiles_backup.restore', actor, String(printerId), {
      backupCreatedAt: doc.createdAt,
      created: report.created.length,
      skipped: report.skipped.length,
      dropped: report.dropped.length,
    });
    logger.info(`Profiles backup restored from printer #${printerId} by "${admin.username}": ${report.created.length} created, ${report.skipped.length} skipped`);
    return report;
  }
}
