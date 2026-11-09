import { isIP } from 'node:net';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { AppError, notFound } from '../../errors.js';
import { normalizeMac } from '../../printers/drivers/http.js';
import { kinematicsOf, PRINTER_MODELS } from '../../printers/drivers/registry.js';
import type { ProbeFn } from '../../printers/drivers/registry.js';
import { invalidProbeHost, resolveProbeHost, type LookupFn } from '../../lib/probe-host.js';
import { BED_SURFACES, type BedSurface, type Printer, type PrinterModel, type ProbeResult } from '../../types.js';

const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i;

/** A bare IP or DNS hostname: no scheme, port, path or credentials. */
export const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine((v) => isIP(v) !== 0 || HOSTNAME.test(v), 'Must be an IP address or hostname');

export const macSchema = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z
    .string()
    .nullable()
    .refine((v) => v === null || normalizeMac(v) !== null, 'Must be a MAC address')
    .transform((v) => (v === null ? null : normalizeMac(v))),
);

export const modelSchema = z.enum(PRINTER_MODELS as [PrinterModel, ...PrinterModel[]]);

export const probeBodySchema = z.object({
  model: modelSchema,
  host: hostSchema,
  staticIp: z.boolean().default(true),
  mac: macSchema.optional(),
});

export type ProbeBody = z.infer<typeof probeBodySchema>;

/**
 * Validates the probe target (private IPv4 only, hostnames resolved and pinned: see `resolveProbeHost`) and runs
 * the model's probe. Shared by `POST /api/setup/test-printer` and `POST /api/admin/printers/test`.
 */
export async function runProbe(ctx: { probe: ProbeFn }, body: ProbeBody, lookup?: LookupFn): Promise<ProbeResult> {
  const ip = await resolveProbeHost(body.host, lookup);
  if (ip === null) return { ok: false, error: 'printers.unreachable' };
  return ctx.probe(body.model, ip, { staticIp: body.staticIp, mac: body.mac });
}

/** Host `sim` routes the printer to the built-in protocol simulator (development and tests). */
export const SIM_HOST = 'sim';

/**
 * Same private-host rule as the probe (backend-notes §11) for stored printers: IP literals must be RFC 1918,
 * localhost is refused, hostnames that resolve must resolve only to private IPv4. An unresolvable hostname is
 * accepted (the printer may be off); the driver re-checks before every connection. `sim` is always allowed.
 */
export async function assertPrinterHostAllowed(host: string, lookup?: LookupFn): Promise<void> {
  if (host.toLowerCase() === SIM_HOST) return;
  await resolveProbeHost(host, lookup); // throws printers.invalid_host
}

export { invalidProbeHost };

export const printerCreateSchema = z.object({
  name: z.string().trim().min(1).max(64),
  model: modelSchema,
  host: hostSchema,
  staticIp: z.boolean().default(true),
  mac: macSchema.optional(),
  serial: z.string().trim().max(128).nullable().optional(),
  firmware: z.string().trim().max(128).nullable().optional(),
});

/** The K2 SE machine profile's `default_bed_type`. */
export const DEFAULT_BED_SURFACE: BedSurface = 'Epoxy Resin Plate';

const bedSurfaceSchema = z.enum(BED_SURFACES);

export const printerUpdateSchema = printerCreateSchema
  .extend({
    /** The surfaces the owner has (at least one, no duplicates). */
    bedSurfaces: z
      .array(bedSurfaceSchema)
      .min(1)
      .max(BED_SURFACES.length)
      .refine((a) => new Set(a).size === a.length, 'Duplicate bed surface'),
    defaultBedSurface: bedSurfaceSchema,
  })
  .partial()
  .strict();

export type PrinterCreateInput = z.infer<typeof printerCreateSchema>;
export type PrinterUpdateInput = z.infer<typeof printerUpdateSchema>;

interface PrinterRow {
  id: number;
  name: string;
  model: string;
  host: string;
  static_ip: number;
  mac: string | null;
  serial: string | null;
  firmware: string | null;
  camera: string;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
  bed_clear?: number;
  bed_occupied_since?: number | null;
  last_print_id?: number | null;
  /** 0010: JSON array of BedSurface; NULL = only the profile default. */
  bed_surfaces?: string | null;
  default_bed_surface?: string | null;
}

const isSurface = (v: unknown): v is BedSurface => BED_SURFACES.includes(v as BedSurface);

/** Stored surfaces (in BED_SURFACES order) + a default that is always one of them. */
export function readBedSurfaces(json: string | null | undefined, def: string | null | undefined): { bedSurfaces: BedSurface[]; defaultBedSurface: BedSurface } {
  let list: BedSurface[] = [];
  try {
    const parsed: unknown = json ? JSON.parse(json) : null;
    if (Array.isArray(parsed)) list = BED_SURFACES.filter((b) => parsed.includes(b));
  } catch {
    list = [];
  }
  if (list.length === 0) list = [isSurface(def) ? def : DEFAULT_BED_SURFACE];
  const defaultBedSurface = isSurface(def) && list.includes(def) ? def : list[0]!;
  return { bedSurfaces: list, defaultBedSurface };
}

function toPrinter(row: PrinterRow): Printer {
  return {
    id: row.id,
    name: row.name,
    model: row.model as PrinterModel,
    kinematics: kinematicsOf(row.model),
    host: row.host,
    staticIp: row.static_ip === 1,
    mac: row.mac,
    serial: row.serial,
    firmware: row.firmware,
    camera: { type: 'none' }, // camera config arrives in a later phase
    lastSeenAt: row.last_seen_at,
    bedClear: row.bed_clear !== 0,
    bedOccupiedSince: row.bed_occupied_since ?? null,
    lastPrintId: row.last_print_id ?? null,
    ...readBedSurfaces(row.bed_surfaces, row.default_bed_surface),
  };
}

export type PrinterChange = { kind: 'create' | 'update' | 'delete'; printer: Printer };

export class PrintersService {
  private readonly listeners = new Set<(c: PrinterChange) => void>();

  constructor(private readonly db: Db) {}

  /** Admin create/update/delete (used by the printer manager to (re)connect). */
  onChange(cb: (c: PrinterChange) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(c: PrinterChange): void {
    for (const l of this.listeners) l(c);
  }

  list(): Printer[] {
    return (this.db.prepare('SELECT * FROM printers ORDER BY id').all() as PrinterRow[]).map(toPrinter);
  }

  get(id: number): Printer {
    const row = this.db.prepare('SELECT * FROM printers WHERE id = ?').get(id) as PrinterRow | undefined;
    if (!row) throw notFound();
    return toPrinter(row);
  }

  create(input: PrinterCreateInput): Printer {
    const now = Date.now();
    const r = this.db
      .prepare(
        `INSERT INTO printers (name, model, host, static_ip, mac, serial, firmware, camera, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '{"type":"none"}', ?, ?)`,
      )
      .run(
        input.name,
        input.model,
        input.host,
        input.staticIp ? 1 : 0,
        input.mac ?? null,
        input.serial ?? null,
        input.firmware ?? null,
        now,
        now,
      );
    const created = this.get(Number(r.lastInsertRowid));
    this.emit({ kind: 'create', printer: created });
    return created;
  }

  update(id: number, patch: PrinterUpdateInput): Printer {
    const before = this.get(id);
    // Bed surfaces are owner preferences: stored without reconnecting the driver.
    if (patch.bedSurfaces !== undefined || patch.defaultBedSurface !== undefined) {
      const list = patch.bedSurfaces ?? before.bedSurfaces;
      const wanted = patch.defaultBedSurface ?? before.defaultBedSurface;
      const next = readBedSurfaces(JSON.stringify(list), wanted);
      if (patch.defaultBedSurface !== undefined && next.defaultBedSurface !== patch.defaultBedSurface) {
        throw new AppError(400, 'printers.invalid_bed_surface', 'The default bed surface must be one of the owned surfaces');
      }
      this.db
        .prepare('UPDATE printers SET bed_surfaces = ?, default_bed_surface = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(next.bedSurfaces), next.defaultBedSurface, Date.now(), id);
    }
    const map: [string, unknown][] = [
      ['name', patch.name],
      ['model', patch.model],
      ['host', patch.host],
      ['static_ip', patch.staticIp === undefined ? undefined : patch.staticIp ? 1 : 0],
      ['mac', patch.mac],
      ['serial', patch.serial],
      ['firmware', patch.firmware],
    ];
    const present = map.filter(([, v]) => v !== undefined);
    if (present.length > 0) {
      this.db
        .prepare(`UPDATE printers SET ${present.map(([c]) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...present.map(([, v]) => v), Date.now(), id);
    }
    const updated = this.get(id);
    if (present.length > 0) this.emit({ kind: 'update', printer: updated });
    return updated;
  }

  delete(id: number): Printer {
    const p = this.get(id);
    this.db.prepare('DELETE FROM printers WHERE id = ?').run(id);
    this.emit({ kind: 'delete', printer: p });
    return p;
  }

  // ---- runtime updates from the live driver (no change event: they must not trigger a reconnect) ----

  find(id: number): Printer | null {
    const row = this.db.prepare('SELECT * FROM printers WHERE id = ?').get(id) as PrinterRow | undefined;
    return row ? toPrinter(row) : null;
  }

  touchSeen(id: number, at = Date.now()): void {
    this.db.prepare('UPDATE printers SET last_seen_at = ? WHERE id = ?').run(at, id);
  }

  /** Persists what the device reports about itself; only non-null values overwrite. */
  setIdentity(id: number, ident: { firmware?: string | null; serial?: string | null; mac?: string | null }): void {
    const cols: [string, string][] = [];
    if (ident.firmware) cols.push(['firmware', ident.firmware.slice(0, 128)]);
    if (ident.serial) cols.push(['serial', ident.serial.slice(0, 128)]);
    if (ident.mac) cols.push(['mac', ident.mac]);
    if (cols.length === 0) return;
    this.db
      .prepare(`UPDATE printers SET ${cols.map(([c]) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...cols.map(([, v]) => v), Date.now(), id);
  }

  /** MAC re-resolve found the printer elsewhere (staticIp=false). */
  setResolvedHost(id: number, host: string): void {
    this.db.prepare('UPDATE printers SET host = ?, updated_at = ? WHERE id = ?').run(host, Date.now(), id);
  }

  /** Material may be on the bed after a print ended. */
  markBedOccupied(id: number, printId: number | null, at = Date.now()): void {
    this.db
      .prepare('UPDATE printers SET bed_clear = 0, bed_occupied_since = ?, last_print_id = ? WHERE id = ?')
      .run(at, printId, id);
  }

  markBedCleared(id: number): void {
    this.db.prepare('UPDATE printers SET bed_clear = 1, bed_occupied_since = NULL, last_job = NULL WHERE id = ?').run(id);
  }

  /** The job that ended on the bed (JSON, owned by the job-info service); null clears it. */
  setLastJob(id: number, json: string | null): void {
    this.db.prepare('UPDATE printers SET last_job = ? WHERE id = ?').run(json, id);
  }

  getLastJob(id: number): string | null {
    const row = this.db.prepare('SELECT last_job FROM printers WHERE id = ?').get(id) as { last_job: string | null } | undefined;
    return row?.last_job ?? null;
  }
}
