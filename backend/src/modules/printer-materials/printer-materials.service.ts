// PRINTER-PRESETS: the printer's own filament list (Creality WS `get reqMaterials` → `retMaterials[]`). The K2 SE only
// holds Creality's factory filaments there (no user filaments, no process presets): PrintYard shows them read-only,
// mapped onto its system presets, with the settings that differ. Off unless the viewer turned "Show printer
// filaments" on: while nobody has, PrintYard never asks the printer for them.
import { CONTROL_CHARS } from '../../lib/sanitize.js';
import { logger } from '../../logger.js';
import type { PrinterManager } from '../../printers/manager.js';
import type { PrinterMaterial, PrinterMaterialsView, PrinterModel } from '../../types.js';
import type { PrintersService } from '../printers/printers.service.js';
import { FILAMENT_META_KEYS, normValue, parentText, readPreset } from '../profile-files/creality.js';
import type { ProfileFilesService } from '../profile-files/profile-files.service.js';
import type { ProfilesService } from '../profiles/profiles.service.js';
import type { UsersService } from '../users/users.service.js';

const MODEL: PrinterModel = 'creality-k2se';
/** Untrusted printer data: caps per answer. */
export const MATERIAL_LIMITS = { entries: 100, keys: 400, valueChars: 8192, differs: 50, colors: 12 } as const;
/** Settings that describe the preset, not how it prints (never shown as a difference). */
const NOT_A_SETTING = new Set<string>([...FILAMENT_META_KEYS, 'inherits', 'compatible_printers', 'compatible_printers_condition', 'compatible_prints', 'compatible_prints_condition', 'filament_settings_id', 'name', 'from', 'version', 'setting_id', 'filament_id', 'instantiation', 'type']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(CONTROL_CHARS, ' ').trim().slice(0, max) : '');
const finite = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
/** `#RRGGBB` or `#RRGGBBAA` (alpha dropped) → `#RRGGBB`. */
const hex = (v: unknown): string | null => (typeof v === 'string' && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v.trim()) ? v.trim().slice(0, 7).toUpperCase() : null);

/**
 * Validates the raw `retMaterials[]` and maps each entry onto a K2 SE system preset through the import path
 * (`preparePreset`: parent pick, diff, the same screening as overrides). Malformed entries are skipped.
 */
export function parseMaterials(raw: unknown, profiles: ProfilesService, profileFiles: ProfileFilesService): PrinterMaterial[] {
  if (!Array.isArray(raw)) return [];
  const out: PrinterMaterial[] = [];
  for (const e of raw.slice(0, MATERIAL_LIMITS.entries)) {
    if (!isRecord(e) || !isRecord(e.base) || !isRecord(e.kvParam)) continue;
    const base = e.base;
    const name = text(base.name, 100);
    if (!name) continue;
    const kvEntries = Object.entries(e.kvParam);
    if (kvEntries.length > MATERIAL_LIMITS.keys) continue;
    const kv: Record<string, string> = {};
    for (const [k, v] of kvEntries) {
      if (typeof v === 'string' && v.length <= MATERIAL_LIMITS.valueChars && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k)) kv[k] = v;
    }
    const inherits = text(kv.inherits, 200);
    const parsed = readPreset('filament', name, { ...kv, name, inherits });
    const report = { dropped: [] as { profile: string; key: string; reason: string }[], remapped: [] as { profile: string; from: string; to: string }[] };
    let systemPresetId: string | null = null;
    let values: Record<string, string> = {};
    const differs: PrinterMaterial['differs'] = [];
    try {
      const prepared = profileFiles.preparePreset(parsed, report);
      systemPresetId = prepared.parent;
      values = prepared.values;
      const parent = profiles.raw(MODEL, 'filament', prepared.parent);
      for (const [key, value] of Object.entries(parsed.values)) {
        if (NOT_A_SETTING.has(key)) continue;
        const mine = parentText('filament', parent, key);
        if (mine !== undefined && normValue(mine) === normValue(value)) continue;
        if (differs.length >= MATERIAL_LIMITS.differs) break;
        differs.push({ key, printer: value.slice(0, 200), printyard: mine?.slice(0, 200) ?? null, kept: key in values });
      }
    } catch (err) {
      logger.printer.debug(`printer material "${name}": no matching system preset (${(err as Error).message})`);
    }
    const colors = (Array.isArray(base.colors) ? base.colors : []).map(hex).filter((c): c is string => !!c).slice(0, MATERIAL_LIMITS.colors);
    out.push({
      id: text(base.id, 32) || name,
      name,
      brand: text(base.brand, 64),
      type: text(base.meterialType, 32) || text(kv.filament_type, 32),
      color: colors[0] ?? null,
      colors,
      minTemp: finite(base.minTemp),
      maxTemp: finite(base.maxTemp),
      nozzleTemp: finite(kv.nozzle_temperature?.split(',')[0]),
      bedTemp: finite(kv.hot_plate_temp?.split(',')[0]),
      inherits,
      systemPresetId,
      differs,
      values,
    });
  }
  return out;
}

interface CacheEntry {
  fetchedAt: number | null;
  materials: PrinterMaterial[];
  error?: string;
}

export interface PrinterMaterialsDeps {
  manager: PrinterManager;
  printers: PrintersService;
  users: UsersService;
  profiles: ProfilesService;
  profileFiles: ProfileFilesService;
  /** Answers older than this are fetched again on the next request (default 5 min). */
  ttlMs?: number;
}

export class PrinterMaterialsService {
  private readonly cache = new Map<number, CacheEntry>();
  private readonly inflight = new Map<number, Promise<CacheEntry>>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: PrinterMaterialsDeps) {}

  /** Refresh when a printer (re)connects, only while some user shows printer filaments. */
  attach(): void {
    this.unsubscribe ??= this.deps.manager.onStatus((s, prev) => {
      if (!s.online || prev?.online) return;
      this.cache.delete(s.printerId);
      if (this.deps.users.anyShowsPrinterFilaments()) void this.fetch(s.printerId);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private fetch(printerId: number): Promise<CacheEntry> {
    const running = this.inflight.get(printerId);
    if (running) return running;
    const job = (async (): Promise<CacheEntry> => {
      const prev = this.cache.get(printerId);
      const driver = this.deps.manager.hasDriver(printerId) ? this.deps.manager.driver(printerId) : null;
      if (!driver?.requestMaterials) return prev ?? { fetchedAt: null, materials: [], error: 'printer_materials.unsupported' };
      try {
        const raw = await driver.requestMaterials();
        if (raw === null) {
          const entry = { ...(prev ?? { fetchedAt: null, materials: [] }), error: 'printer_materials.no_answer' };
          this.cache.set(printerId, entry);
          return entry;
        }
        const entry: CacheEntry = { fetchedAt: Date.now(), materials: parseMaterials(raw, this.deps.profiles, this.deps.profileFiles) };
        this.cache.set(printerId, entry);
        logger.printer.info(`printer #${printerId}: ${entry.materials.length} printer filaments read`);
        return entry;
      } catch (err) {
        logger.printer.warn(`printer #${printerId}: reading the printer's filaments failed`, err);
        const entry = { ...(prev ?? { fetchedAt: null, materials: [] }), error: 'printer_materials.no_answer' };
        this.cache.set(printerId, entry);
        return entry;
      }
    })().finally(() => this.inflight.delete(printerId));
    this.inflight.set(printerId, job);
    return job;
  }

  /**
   * The viewer's view of a printer's filaments (default: the first printer). Asks the printer only when the viewer
   * turned the list on, the printer is online and the cached answer is older than the TTL (or `refresh`).
   */
  async list(viewer: { id: number }, printerId?: number, refresh = false): Promise<PrinterMaterialsView> {
    const enabled = this.deps.users.getUser(viewer.id).showPrinterFilaments;
    const all = this.deps.printers.list();
    // Default: the first printer that is online (else the first one).
    const printer = printerId !== undefined ? this.deps.printers.get(printerId) : (all.find((p) => this.deps.manager.status(p.id).online) ?? all[0] ?? null);
    if (!printer) return { enabled, printerId: null, online: false, fetchedAt: null, materials: [] };
    const online = this.deps.manager.status(printer.id).online;
    if (!enabled) return { enabled, printerId: printer.id, online, fetchedAt: null, materials: [] };
    let entry = this.cache.get(printer.id);
    const stale = !entry?.fetchedAt || Date.now() - entry.fetchedAt > (this.deps.ttlMs ?? 5 * 60_000);
    if (online && (refresh || stale)) entry = await this.fetch(printer.id);
    return {
      enabled,
      printerId: printer.id,
      online,
      fetchedAt: entry?.fetchedAt ?? null,
      materials: entry?.materials ?? [],
      ...(entry?.error && { error: entry.error }),
    };
  }
}
