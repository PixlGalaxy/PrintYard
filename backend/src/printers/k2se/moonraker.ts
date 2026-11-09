/**
 * Moonraker (:7125) live-job feed for the K2 SE: `printer.objects.subscribe` over the Moonraker websocket
 * (JSON-RPC 2.0), falling back to polling `GET /printer/objects/query` every second while a job runs.
 * Read-only: only `printer.objects.subscribe` / `GET` are ever sent.
 */
import WebSocket from 'ws';
import { logger } from '../../logger.js';
import type { JobObject, LiveJob } from '../../types.js';
import { formatHostForUrl, getJson, isRecord } from '../drivers/http.js';
import type { PrinterEndpoint } from '../drivers/types.js';
import { isReadOnlyMoonrakerMethod } from '../read-only.js';
import { basename, num } from './protocol.js';

export type MoonrakerObjects = Record<string, Record<string, unknown>>;

export const SUBSCRIBED_OBJECTS = {
  print_stats: null,
  virtual_sdcard: null,
  toolhead: ['position', 'homed_axes'],
  exclude_object: null,
  gcode_move: ['speed_factor', 'extrude_factor'],
} as const;
export const QUERY_PATH = '/printer/objects/query?print_stats&virtual_sdcard&toolhead=position,homed_axes&exclude_object&gcode_move=speed_factor,extrude_factor';

/** Per-object shallow merge (Moonraker notifications carry only the changed fields of each object). */
export function mergeObjects(state: MoonrakerObjects, update: unknown): MoonrakerObjects {
  if (!isRecord(update)) return state;
  for (const [obj, fields] of Object.entries(update)) {
    if (!isRecord(fields) || obj === '__proto__' || obj === 'constructor') continue;
    const cur = (state[obj] ??= {});
    for (const [k, v] of Object.entries(fields)) {
      if (k === '__proto__' || k === 'constructor') continue;
      cur[k] = v;
    }
  }
  return state;
}

/** `{result:{status:{...}}}` from `/printer/objects/query` or the subscribe reply → objects. */
export function statusFromQuery(body: unknown): MoonrakerObjects | null {
  if (!isRecord(body) || !isRecord(body.result) || !isRecord(body.result.status)) return null;
  return mergeObjects({}, body.result.status);
}

/** Merged objects → `LiveJob`, or null when nothing is printing (or paused). */
export function parseJob(o: MoonrakerObjects): LiveJob | null {
  const vs = o.virtual_sdcard ?? {};
  const ps = o.print_stats ?? {};
  const state = typeof ps.state === 'string' ? ps.state : null;
  const active = vs.is_active === true || state === 'printing' || state === 'paused';
  if (!active) return null;
  const fileName = basename(vs.file_path) ?? (typeof ps.filename === 'string' ? basename(ps.filename) : null);
  if (!fileName) return null;
  const cur = isRecord(vs.cur_print_data) ? vs.cur_print_data : {};
  const meta = isRecord(cur.metadata) ? cur.metadata : {};
  const pos = (o.toolhead ?? {}).position;
  const toolhead =
    Array.isArray(pos) && pos.length >= 3 && pos.slice(0, 3).every((v) => typeof v === 'number' && Number.isFinite(v))
      ? ([round3(pos[0] as number), round3(pos[1] as number), round3(pos[2] as number)] as [number, number, number])
      : null;
  const layerCount = num(vs.layer_count) ?? num(meta.layer_count);
  return {
    fileName,
    filePosition: num(vs.file_position),
    fileSize: num(vs.file_size) ?? num(meta.size),
    layer: num(vs.layer),
    layerCount: layerCount !== null && layerCount > 0 ? layerCount : null,
    toolhead,
    slicer: typeof meta.slicer === 'string' ? meta.slicer : null,
    objectHeight: num(meta.object_height),
    objects: parseExcludeObject(o.exclude_object),
  };
}

/** Klipper names accepted by `EXCLUDE_OBJECT NAME=` (Creality Print: `Object_1_id_0_copy_0`). */
export const OBJECT_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

/** `Object_1_id_0_copy_1` → `Object_1 (2)`; other names are kept as they are. */
export function objectLabel(name: string): string {
  const m = /^(.+?)_id_\d+_copy_(\d+)$/i.exec(name);
  if (!m) return name;
  const copy = Number(m[2]);
  return copy > 0 ? `${m[1]} (${copy + 1})` : m[1]!;
}

const point = (v: unknown): [number, number] | null =>
  Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number' && Number.isFinite(v[0]) && Number.isFinite(v[1])
    ? [round3(v[0]), round3(v[1])]
    : null;

/** Moonraker `exclude_object` → objects (names upper-cased by Klipper are kept as reported). */
export function parseExcludeObject(eo: unknown): JobObject[] {
  if (!isRecord(eo) || !Array.isArray(eo.objects)) return [];
  const excluded = new Set(Array.isArray(eo.excluded_objects) ? eo.excluded_objects.filter((n): n is string => typeof n === 'string') : []);
  const current = typeof eo.current_object === 'string' ? eo.current_object : null;
  const out: JobObject[] = [];
  for (const o of eo.objects.slice(0, 256)) {
    if (!isRecord(o) || typeof o.name !== 'string' || !OBJECT_NAME_RE.test(o.name)) continue;
    const polygon = Array.isArray(o.polygon) ? o.polygon.slice(0, 512).map(point).filter((p): p is [number, number] => p !== null) : [];
    out.push({ name: o.name, label: objectLabel(o.name), center: point(o.center), polygon, excluded: excluded.has(o.name), excludedAt: null, current: current === o.name });
  }
  return out;
}

/** Moonraker `toolhead.homed_axes` (`"xyz"`) or null when not reported. */
export function homedAxesOf(o: MoonrakerObjects): string | null {
  const h = o.toolhead?.homed_axes;
  return typeof h === 'string' ? h.toLowerCase().replace(/[^xyz]/g, '') : null;
}

/** Moonraker `gcode_move.speed_factor/extrude_factor` (1.0 = 100 %) → percent (null when not reported). */
export function factorsOf(o: MoonrakerObjects): { speed: number | null; flow: number | null } {
  const f = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 10 ? Math.round(v * 100) : null);
  const gm = o.gcode_move ?? {};
  return { speed: f(gm.speed_factor), flow: f(gm.extrude_factor) };
}

/** Moonraker `toolhead.position` (first 3 values) or null. */
export function positionOf(o: MoonrakerObjects): [number, number, number] | null {
  const pos = o.toolhead?.position;
  return Array.isArray(pos) && pos.length >= 3 && pos.slice(0, 3).every((v) => typeof v === 'number' && Number.isFinite(v))
    ? [round3(pos[0] as number), round3(pos[1] as number), round3(pos[2] as number)]
    : null;
}

/** Relative path inside Moonraker's `gcodes` root for a printer-side absolute path (null if unsafe/outside). */
export function gcodesRelativePath(filePath: unknown): string | null {
  if (typeof filePath !== 'string' || filePath === '') return null;
  const i = filePath.indexOf('/gcodes/');
  const rel = i >= 0 ? filePath.slice(i + '/gcodes/'.length) : filePath.replace(/^\/+/, '');
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('\\'))) return null;
  return parts.join('/');
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export interface FeedOptions {
  label: string;
  endpoint: () => PrinterEndpoint | null;
  /** True while the Creality WS says a job is active (informational; polling runs whenever the websocket is down). */
  isActive: () => boolean;
  onUpdate: (objects: MoonrakerObjects) => void;
  pollMs?: number;
  /** Retry the websocket after it failed (meanwhile: polling). */
  wsRetryMs?: number;
  createSocket?: (url: string) => WebSocket;
}

/** Keeps `objects` fresh while the printer is online. */
export class MoonrakerFeed {
  private ws: WebSocket | null = null;
  private subscribed = false;
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private readonly objects: MoonrakerObjects = {};
  /** When the last Moonraker data arrived (websocket message or successful query); 0 = never. */
  private lastDataAt = 0;

  constructor(private readonly o: FeedOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.openWs();
    this.pollTimer = setInterval(() => void this.poll(), this.o.pollMs ?? 1000);
    this.pollTimer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.pollTimer = null;
    this.retryTimer = null;
    this.closeWs();
    this.lastDataAt = 0;
    for (const k of Object.keys(this.objects)) delete this.objects[k];
  }

  /** Time of the last Moonraker data (0 = none yet). */
  get dataAt(): number {
    return this.lastDataAt;
  }

  get usingWebsocket(): boolean {
    return this.subscribed;
  }

  private openWs(): void {
    const ep = this.o.endpoint();
    if (!ep || !this.running) return;
    const url = `ws://${formatHostForUrl(ep.host)}:${ep.moonrakerPort}/websocket`;
    let ws: WebSocket;
    try {
      ws = this.o.createSocket?.(url) ?? new WebSocket(url, { maxPayload: 4 * 1024 * 1024, handshakeTimeout: 5000, perMessageDeflate: false });
    } catch {
      return this.scheduleRetry();
    }
    this.ws = ws;
    ws.on('open', () => this.rpc(ws, 'printer.objects.subscribe', { objects: SUBSCRIBED_OBJECTS }, 1));
    ws.on('message', (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!isRecord(msg)) return;
      this.lastDataAt = Date.now();
      if (msg.id === 1 && isRecord(msg.result) && isRecord(msg.result.status)) {
        this.subscribed = true;
        mergeObjects(this.objects, msg.result.status);
        this.emit();
      } else if (msg.method === 'notify_status_update' && Array.isArray(msg.params)) {
        mergeObjects(this.objects, msg.params[0]);
        this.emit();
      } else if (msg.method === 'notify_klippy_disconnected') {
        for (const k of Object.keys(this.objects)) delete this.objects[k];
      }
    });
    const lost = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.subscribed) logger.printer.debug(`${this.o.label}: Moonraker websocket lost, polling meanwhile`);
      this.subscribed = false;
      // Never keep a frozen toolhead/homing state: it would win over fresh Creality data (phase-3 review B #3).
      this.dropMotionState();
      this.emit();
      this.scheduleRetry();
    };
    ws.on('close', lost);
    ws.on('error', lost);
  }

  /** The only way this feed writes to Moonraker: read-only JSON-RPC methods, always (not just in read-only mode). */
  private rpc(ws: WebSocket, method: string, params: unknown, id: number): void {
    if (!isReadOnlyMoonrakerMethod(method)) throw new Error(`Moonraker method ${method} is not allowed`);
    ws.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }));
  }

  private scheduleRetry(): void {
    if (!this.running || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.openWs();
    }, this.o.wsRetryMs ?? 30_000);
    this.retryTimer.unref?.();
  }

  private closeWs(): void {
    const ws = this.ws;
    this.ws = null;
    this.subscribed = false;
    try {
      ws?.terminate();
    } catch {
      /* ignore */
    }
  }

  /** Forgets the motion-related objects (position, homing, factors) until Moonraker reports them again. */
  private dropMotionState(): void {
    delete this.objects.toolhead;
    delete this.objects.gcode_move;
  }

  /**
   * Makes sure the objects are at most `maxAgeMs` old before a motion command is validated: a subscribed websocket
   * with recent traffic (newer than `notBefore`) counts; otherwise one read-only `GET /printer/objects/query` (2 s timeout). False = Moonraker
   * did not answer (the toolhead/homing state is then dropped, never trusted stale).
   */
  async refresh(maxAgeMs: number, notBefore = 0): Promise<boolean> {
    if (!this.running) return false;
    if (this.subscribed && Date.now() - this.lastDataAt <= maxAgeMs && this.lastDataAt >= notBefore) return true;
    const ep = this.o.endpoint();
    if (!ep) return false;
    const body = await getJson(`http://${formatHostForUrl(ep.host)}:${ep.moonrakerPort}${QUERY_PATH}`, 2000);
    const status = statusFromQuery(body);
    if (!status || !this.running) {
      if (!this.subscribed) {
        this.dropMotionState();
        this.emit();
      }
      return false;
    }
    mergeObjects(this.objects, status);
    this.lastDataAt = Date.now();
    this.emit();
    return true;
  }

  /** Fallback whenever the websocket is not subscribed (printing or idle). */
  private async poll(): Promise<void> {
    // Also while idle: a dropped websocket must never leave a frozen homing/position state (review B #3).
    if (!this.running || this.subscribed || this.polling) return;
    const ep = this.o.endpoint();
    if (!ep) return;
    this.polling = true;
    try {
      const body = await getJson(`http://${formatHostForUrl(ep.host)}:${ep.moonrakerPort}${QUERY_PATH}`, 2000);
      const status = statusFromQuery(body);
      if (status && this.running && !this.subscribed) {
        this.lastDataAt = Date.now();
        mergeObjects(this.objects, status);
        this.emit();
      }
    } finally {
      this.polling = false;
    }
  }

  private emit(): void {
    try {
      this.o.onUpdate(this.objects);
    } catch (err) {
      logger.printer.error(`${this.o.label}: Moonraker update handler failed`, err);
    }
  }
}
