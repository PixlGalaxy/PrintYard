import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crc32, deflateSync } from 'node:zlib';
import { WebSocketServer, type WebSocket } from 'ws';
import { appEnv } from '../../lib/env.js';
import { logger } from '../../logger.js';

/**
 * In-process Creality K2 SE simulator speaking the same LAN protocol as the real printer, on ONE port:
 * - WebSocket (any path, like :9999): full dump on connect, partial delta pushes every tick, `get`
 *   ReqPrinterPara / boxsInfo / reqGcodeFile / reqMaterials, `set` pause / stop / opGcodeFile printprt: + deleteprt:, heart_beat → "ok".
 * - HTTP (like :80): `GET /info`, `POST /upload/<name>` (multipart field `file`), `GET /downloads/humbnail/*`.
 * - HTTP (like Moonraker :7125): `GET /machine/system_info`, `GET /printer/info`, `GET /printer/objects/query`,
 *   `GET /server/files/gcodes/<name>`; Moonraker websocket at `/websocket` (`printer.objects.subscribe` +
 *   `notify_status_update` on every push). `GET /downloads/original/current_print_image.png` while printing.
 *   `POST /server/files/upload` (root=config) + `GET /server/files/config/<path>` (PrintYard's profile backup).
 * Used when a printer's host is `sim` or `PRINTYARD_SIM_PRINTER=1`. Never used for a real address.
 */

export interface SimulatorOptions {
  /** Real milliseconds between ticks (pushes). */
  tickMs?: number;
  /** Simulated print seconds that pass per tick. */
  simSecondsPerTick?: number;
  /** Degrees per tick while heating/cooling. */
  heatPerTick?: number;
  mac?: string;
  /** Delay before the printer reacts to start (it shows the old state meanwhile), in ticks. */
  startDelayTicks?: number;
  /**
   * Throttle for `POST /upload/*` in bytes per second (0 = unlimited) so upload progress is visible. The shared
   * simulator reads `PRINTYARD_SIM_UPLOAD_KBPS` (default 1024 KiB/s).
   */
  uploadBytesPerSec?: number;
  /**
   * Also store files "from elsewhere" (Creality Print / the touchscreen samples), with Creality metadata and
   * thumbnails, like the user's real K2 SE. Off by default so tests see only the two sample files.
   */
  foreignFiles?: boolean;
  /** `retMaterials[]` answered to `get reqMaterials` (default: the trimmed real capture in test/fixtures, else []). */
  materials?: unknown[];
}

/**
 * The real K2 SE's material list (trimmed capture, backend/test/fixtures/k2se/retmaterials.json). Only present in a
 * source checkout: the Docker image has no test folder, so its simulator answers an empty list.
 */
export function simMaterials(): unknown[] {
  try {
    const raw = JSON.parse(readFileSync(new URL('../../../test/fixtures/k2se/retmaterials.json', import.meta.url), 'utf8')) as { retMaterials?: unknown };
    return Array.isArray(raw.retMaterials) ? raw.retMaterials : [];
  } catch {
    return [];
  }
}

/** Creality list metadata of a stored file (what `retGcodeFileInfo2` reports). */
export interface SimFileMeta {
  /** Epoch seconds. */
  createTime?: number;
  /** mm × 100. */
  floorHeight?: number;
  /** Filament length in mm. */
  consumables?: number;
  material?: string;
  materialColors?: string;
  software?: string;
  /** false = no thumbnail on the printer. */
  thumbnail?: boolean;
}

interface SimObject {
  name: string;
  center: [number, number] | null;
  polygon: [number, number][];
  /** Byte ranges of the object's moves (`EXCLUDE_OBJECT_START` … `EXCLUDE_OBJECT_END`). */
  ranges: [number, number][];
}

interface SimFile {
  objects: SimObject[];
  name: string;
  path: string;
  size: number;
  bytes: Buffer;
  uuid: string;
  seconds: number;
  layers: number;
  createTime: number;
  meta: SimFileMeta;
}

const GCODE_DIR = '/usr/data/printer_data/gcodes';
const ROOM = 25;

type Raw = Record<string, unknown>;

export class PrinterSimulator {
  readonly commands: Raw[] = [];
  readonly uploads: { name: string; size: number }[] = [];
  /** Paths removed with `deleteprt:` (a refused delete of the active file is not listed). */
  readonly deletes: string[] = [];
  /** Moonraker websocket JSON-RPC methods received (tests check they are read-only). */
  readonly moonRequests: string[] = [];
  /** `GET /server/files/gcodes/*` served (tests check caching). */
  gcodeDownloads = 0;
  /** Every HTTP request received, as "METHOD /path" (tests prove read-only mode sends none that write). */
  readonly httpLog: string[] = [];
  /** Every raw WS text frame received from clients (Creality side). */
  readonly wsLog: string[] = [];
  /** `gcodeCmd` scripts received (control / exclude object), in order. */
  readonly gcodeLog: string[] = [];
  /** Objects excluded with `EXCLUDE_OBJECT NAME=` during the current print (upper-case, like Klipper). */
  readonly excluded: string[] = [];
  /** Filament moved with manual `G1 E` (mm, negative = retracted). */
  extruded = 0;
  private homed = '';
  private relative = false;
  /** Test hook: make the next uploads fail with HTTP 500. */
  failUploads = false;
  /** Test hook: list uploaded files with a wrong size (truncated/still flushing) so the upload cannot be verified. */
  misreportUploadSize = false;
  /** Test hook: stop reading upload bodies after the first chunk (a stalled printer). */
  stallUploads = false;
  /** Test hook: Moonraker HTTP answers 503 and its websocket is refused (Moonraker down/restarting). */
  moonrakerDown = false;
  /** Test hook: ignore the Creality `excludeObjects` frame (only the Moonraker gcode/script fallback works). */
  ignoreExcludeFrame = false;
  /** Test hook: ignore every exclude path (nothing is ever reported excluded). */
  ignoreExcludes = false;
  /** Test hook: on pause, first report a transient `state: 4` (abort) frame, like the real K2 SE glitch. */
  pauseGlitch = false;
  /** Test hook: the printer ignores `get ReqPrinterPara` and sends no pushes (a frozen Creality WS link). */
  freezeCrealityWs = false;
  /** Test hook: a running print does not advance (tests that need the job alive on slow CI runners). */
  holdProgress = false;
  /** Files in Moonraker's `config` root written through `POST /server/files/upload` (path → content). */
  readonly configFiles = new Map<string, Buffer>();
  /** Test hook: `POST /server/files/upload` answers 500. */
  failConfigUploads = false;
  /** `retMaterials[]` answered to `get reqMaterials`; tests may replace it. */
  materials: unknown[];
  /** `get reqMaterials` requests received. */
  materialRequests = 0;
  /** Upload throttle in bytes/s (0 = unlimited); tests may change it at runtime. */
  uploadBytesPerSec: number;
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<WebSocket>();
  private readonly moonClients = new Set<WebSocket>();
  private current: SimFile | null = null;
  private moonPrintState = 'standby';
  private timer: NodeJS.Timeout | null = null;
  private readonly files = new Map<string, SimFile>();
  private readonly o: Required<SimulatorOptions>;
  private elapsed = 0;
  private total = 0;
  private nozzle = ROOM;
  private bed = ROOM;
  private pendingStart: { file: SimFile; ticks: number; selfTest: boolean } | null = null;
  /** Ticks of pre-print calibration left (`enableSelfTest: 1`); 0 = none. */
  private selfTestLeft = 0;
  /** The last start command received (tests check the calibration flag). */
  lastStart: { path: string; enableSelfTest: number } | null = null;
  private transition: { to: number; ticks: number } | null = null;
  readonly state: Raw;

  constructor(opts: SimulatorOptions = {}) {
    this.o = {
      tickMs: 1000,
      simSecondsPerTick: 30,
      heatPerTick: 40,
      mac: 'AA:BB:CC:00:51:4D',
      startDelayTicks: 1,
      uploadBytesPerSec: 0,
      foreignFiles: false,
      materials: [],
      ...opts,
    };
    this.materials = opts.materials ?? simMaterials();
    this.uploadBytesPerSec = this.o.uploadBytesPerSec;
    this.addFile({ name: 'calibration_cube.gcode', bytes: sampleGcode(100), seconds: 900, layers: 100 });
    this.addFile({ name: 'two_cubes.gcode', bytes: twoObjectGcode(60), seconds: 1200, layers: 60 });
    if (this.o.foreignFiles) for (const f of FOREIGN_FILES) this.addStoredFile(f.name, sampleGcode(f.layers, f.label), f.seconds, f.meta);
    this.state = {
      TotalLayer: 0,
      layer: 0,
      printProgress: 0,
      dProgress: 0,
      printJobTime: 0,
      printLeftTime: 0,
      printFileName: '',
      printId: '',
      printStartTime: 0,
      state: 0,
      deviceState: 0,
      err: { errcode: 0, key: 0 },
      nozzleTemp: temp(ROOM),
      targetNozzleTemp: 0,
      bedTemp0: temp(ROOM),
      targetBedTemp0: 0,
      bedTemp1: '0.000000',
      bedTemp2: '0.000000',
      targetBedTemp1: 0,
      targetBedTemp2: 0,
      boxTemp: 0,
      maxNozzleTemp: 320,
      maxBedTemp: 115,
      curPosition: 'X:110.00 Y:107.50 Z:10.00',
      autohome: 'X:0 Y:0 Z:0',
      curFeedratePct: 100,
      curFlowratePct: 100,
      usedMaterialLength: 0,
      modelFanPct: 0,
      caseFanPct: 0,
      auxiliaryFanPct: 0,
      fan: 0,
      lightSw: 1,
      cfsConnect: 1,
      materialStatus: 0,
      materialDetect: 0,
      feedState: 0,
      hostname: 'K2SE-SIM',
      model: 'F016',
      modelVersion: 'printer hw ver:;printer sw ver:;DWIN hw ver:CR4CU220812S11;DWIN sw ver:2.3.6.57-sim;',
      video: 0,
      webrtcSupport: 0,
      repoPlrStatus: 0,
      withSelfTest: 100,
      connect: 1,
    };
  }

  get port(): number {
    return (this.server?.address() as AddressInfo | null)?.port ?? 0;
  }

  async start(port = 0, host = '127.0.0.1'): Promise<number> {
    if (this.server) return this.port;
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    const server = createServer((req, res) => void this.onHttp(req, res));
    server.on('upgrade', (req, socket, head) => {
      const moon = (req.url ?? '').split('?')[0] === '/websocket';
      this.wss!.handleUpgrade(req, socket, head, (ws) => (moon ? this.onMoonWs(ws) : this.onWs(ws)));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve());
    });
    this.server = server;
    this.timer = setInterval(() => this.tick(), this.o.tickMs);
    this.timer.unref();
    return this.port;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const c of [...this.clients, ...this.moonClients]) c.terminate();
    this.clients.clear();
    this.moonClients.clear();
    this.wss?.close();
    const s = this.server;
    this.server = null;
    s?.closeAllConnections(); // a stalled upload (test hook) would keep close() waiting forever
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  /** Test hook: drop every WebSocket (the driver must reconnect). */
  dropConnections(): void {
    for (const c of this.clients) c.terminate();
    this.clients.clear();
  }

  /** Advance the simulation by one tick synchronously (tests). */
  step(n = 1): void {
    for (let i = 0; i < n; i++) this.tick();
  }

  // ---- HTTP ----

  private async onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://sim');
    this.httpLog.push(`${req.method} ${url.pathname}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && url.pathname === '/info') {
        return json(200, { mac: this.o.mac.replace(/:/g, '').toUpperCase(), model: 'F016', version: '1.0.0' });
      }
      if (req.method === 'GET' && url.pathname === '/machine/system_info') {
        return json(200, { result: { system_info: { network: { wlan0: { mac_address: this.o.mac.toLowerCase(), ip_addresses: [] } } } } });
      }
      if (req.method === 'GET' && url.pathname === '/printer/info') {
        return json(200, { result: { hostname: 'K2SE-SIM', software_version: 'sim' } });
      }
      if (this.moonrakerDown && ['/printer/objects/query', '/server/files/metadata', '/printer/info'].includes(url.pathname)) {
        return json(503, { error: { code: 503, message: 'Moonraker unavailable' } });
      }
      if (req.method === 'POST' && url.pathname === '/printer/gcode/script') {
        const script = url.searchParams.get('script') ?? '';
        this.moonGcode.push(script);
        const m = /^EXCLUDE_OBJECT NAME=([A-Za-z0-9_.-]+)$/i.exec(script.trim());
        if (m && !this.ignoreExcludes) this.excludeNamed(m[1]!);
        return json(200, { result: 'ok' });
      }
      if (req.method === 'GET' && url.pathname === '/server/files/metadata') {
        const f = this.files.get(url.searchParams.get('filename') ?? '');
        if (!f) return json(404, { error: { code: 404, message: 'not found' } });
        return json(200, { result: { filename: f.name, size: this.listedSize(f), modified: f.createTime, uuid: f.uuid } });
      }
      if (req.method === 'GET' && url.pathname === '/printer/objects/query') {
        return json(200, { result: { eventtime: process.uptime(), status: this.moonObjects() } });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/server/files/gcodes/')) {
        const name = decodeURIComponent(url.pathname.slice('/server/files/gcodes/'.length));
        const f = this.files.get(name);
        if (!f) return json(404, { error: { code: 404, message: 'File does not exist' } });
        this.gcodeDownloads++;
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': String(f.bytes.length) });
        res.end(f.bytes);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/server/files/upload') {
        const body = await readBody(req, 16 * 1024 * 1024);
        const ct = String(req.headers['content-type'] ?? '');
        const root = multipartField(body, ct, 'root') ?? 'gcodes';
        const dir = multipartField(body, ct, 'path') ?? '';
        const file = extractMultipartFile(body, ct);
        const fileName = multipartFileName(body, ct);
        if (this.failConfigUploads) return json(500, { error: { code: 500, message: 'sim failure' } });
        if (root !== 'config' || !file || !fileName) return json(400, { error: { code: 400, message: 'bad upload' } });
        const path = [dir, fileName].filter(Boolean).join('/');
        if (path.includes('..') || path.startsWith('/')) return json(400, { error: { code: 400, message: 'bad path' } });
        this.configFiles.set(path, Buffer.from(file));
        return json(201, { result: { item: { path, root: 'config', size: file.length }, action: 'create_file' } });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/server/files/config/')) {
        const path = decodeURIComponent(url.pathname.slice('/server/files/config/'.length));
        const f = this.configFiles.get(path);
        if (!f) return json(404, { error: { code: 404, message: 'File does not exist' } });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(f.length) });
        res.end(f);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/downloads/original/current_print_image.png') {
        if (!this.current) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(TINY_PNG);
        return;
      }
      if (req.method === 'POST' && url.pathname.startsWith('/upload/')) {
        const name = decodeURIComponent(url.pathname.slice('/upload/'.length));
        const body = await readBody(req, 1024 * 1024 * 1024, this.uploadBytesPerSec, () => this.stallUploads);
        if (this.failUploads) return json(500, { code: 500, message: 'sim failure' });
        const file = extractMultipartFile(body, String(req.headers['content-type'] ?? ''));
        if (!file || !name.toLowerCase().endsWith('.gcode')) return json(400, { code: 400, message: 'bad upload' });
        const printing = this.isActive() && String(this.state.printFileName).endsWith('/' + name);
        if (printing) return json(400, { code: 400, message: 'file is printing' });
        const meta = gcodeMeta(file);
        this.addFile({ name, bytes: Buffer.from(file), seconds: meta.seconds ?? 600, layers: meta.layers ?? 50 });
        this.uploads.push({ name, size: file.length });
        if (this.misreportUploadSize) this.misreported.add(name);
        else this.misreported.delete(name);
        return json(200, { code: 200, message: 'OK' });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/downloads/humbnail/')) {
        const png = decodeURIComponent(url.pathname.slice('/downloads/humbnail/'.length));
        const f = [...this.files.values()].find((x) => x.meta.thumbnail !== false && `${x.name.replace(/\.gcode$/i, '')}.png` === png);
        if (!f) {
          res.writeHead(404).end();
          return;
        }
        this.thumbnailRequests++;
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(thumbnailPng(f.meta.materialColors?.split(';')[0] ?? '#3B82F6', f.name));
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/downloads/')) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(404).end();
    } catch (err) {
      logger.printer.warn('sim: HTTP handler failed', err);
      if (!res.headersSent) res.writeHead(500).end();
    }
  }

  // ---- WebSocket ----

  private onWs(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
    ws.on('message', (data) => this.onWsMessage(ws, data.toString()));
    ws.send(JSON.stringify(this.state));
  }

  private onMoonWs(ws: WebSocket): void {
    if (this.moonrakerDown) return void ws.terminate();
    this.moonClients.add(ws);
    ws.on('close', () => this.moonClients.delete(ws));
    ws.on('error', () => this.moonClients.delete(ws));
    ws.on('message', (data) => {
      let msg: Raw;
      try {
        msg = JSON.parse(data.toString()) as Raw;
      } catch {
        return;
      }
      this.moonRequests.push(String(msg.method));
      if (msg.method === 'printer.objects.subscribe') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { eventtime: process.uptime(), status: this.moonObjects() } }));
      }
    });
  }

  /** Moonraker `print_stats`, `virtual_sdcard`, `toolhead` shaped like the real K2 SE's. */
  moonObjects(): Record<string, Raw> {
    const f = this.current;
    const frac = this.total > 0 ? this.elapsed / this.total : 0;
    const pos = String(this.state.curPosition);
    const num = (re: RegExp, d: number) => Number(re.exec(pos)?.[1] ?? d);
    let filePos = f ? Math.floor(frac * f.size) : 0;
    let currentObject: string | null = null;
    for (const o of f?.objects ?? []) {
      const r = o.ranges.find(([a, b]) => filePos >= a && filePos < b);
      if (!r) continue;
      // An excluded object is skipped like Klipper does: its moves are never "printed".
      if (this.excluded.includes(o.name.toUpperCase())) filePos = r[1];
      else currentObject = o.name.toUpperCase();
    }
    return {
      print_stats: { filename: f?.name ?? '', state: this.moonPrintState, print_duration: this.elapsed, info: { total_layer: null, current_layer: null } },
      exclude_object: {
        objects: (f?.objects ?? []).map((o) => ({ name: o.name.toUpperCase(), center: o.center, polygon: o.polygon })),
        excluded_objects: f ? [...this.excluded] : [],
        current_object: currentObject,
      },
      virtual_sdcard: {
        file_path: f?.path ?? null,
        progress: f ? frac : 0,
        is_active: this.state.state === 1 || this.state.state === 6,
        file_position: filePos,
        file_size: f?.size ?? 0,
        layer: f ? this.state.layer : 0,
        layer_count: f ? this.state.TotalLayer : 0,
        cur_print_data: f
          ? { filename: f.name, metadata: { size: f.size, uuid: f.uuid, slicer: 'PrintYard-sim', layer_count: f.layers, object_height: Math.round(f.layers * 2) / 10 } }
          : {},
      },
      gcode_move: { speed_factor: Number(this.state.curFeedratePct ?? 100) / 100, extrude_factor: Number(this.state.curFlowratePct ?? 100) / 100 },
      toolhead: {
        position: [num(/X:([-\d.]+)/, 110), num(/Y:([-\d.]+)/, 107.5), num(/Z:([-\d.]+)/, 0), frac * 5000],
        homed_axes: this.homed,
      },
    };
  }

  private onWsMessage(ws: WebSocket, text: string): void {
    this.wsLog.push(text);
    if (text === 'ok') return;
    if (this.freezeCrealityWs && !text.includes('"set"')) return;
    let msg: Raw;
    try {
      msg = JSON.parse(text) as Raw;
    } catch {
      return;
    }
    if (msg.ModeCode === 'heart_beat') return void ws.send('ok');
    const params = (msg.params ?? {}) as Raw;
    if (msg.method === 'get') {
      if ('ReqPrinterPara' in params) ws.send(JSON.stringify(this.state));
      if ('boxsInfo' in params) ws.send(JSON.stringify({ boxsInfo: this.boxsInfo() }));
      if ('reqGcodeFile' in params) ws.send(JSON.stringify({ retGcodeFileInfo2: this.fileList() }));
      if ('reqMaterials' in params) {
        this.materialRequests++;
        ws.send(JSON.stringify({ retMaterials: this.materials }));
      }
      return;
    }
    if (msg.method !== 'set') return;
    this.commands.push(params);
    if ('pause' in params) {
      if (params.pause === 1 && this.state.state === 1 && this.pauseGlitch) {
        // Real K2 SE: a momentary non-active Creality state while Klipper keeps printing/pausing.
        this.moonPrintState = 'paused';
        this.push({ state: 4 });
        this.setState(6, { to: 5, ticks: 2 });
      } else if (params.pause === 1 && this.state.state === 1) this.setState(6, { to: 5, ticks: 1 });
      // Real K2 SE: resume goes through state 8 (restoring) before printing again.
      else if (params.pause === 0 && this.state.state === 5) this.setState(8, { to: 1, ticks: 1 });
    }
    if ('stop' in params && params.stop === 1 && this.isActive()) {
      this.setState(7, { to: 4, ticks: 1 });
    }
    if (typeof params.opGcodeFile === 'string' && params.opGcodeFile.startsWith('printprt:')) {
      const path = params.opGcodeFile.slice('printprt:'.length);
      const file = [...this.files.values()].find((f) => f.path === path);
      const selfTest = params.enableSelfTest === 1;
      this.lastStart = { path, enableSelfTest: selfTest ? 1 : 0 };
      if (file && !this.isActive() && !this.pendingStart) this.pendingStart = { file, ticks: this.o.startDelayTicks, selfTest };
    }
    if (typeof params.opGcodeFile === 'string' && params.opGcodeFile.startsWith('deleteprt:')) {
      const path = params.opGcodeFile.slice('deleteprt:'.length);
      const file = [...this.files.values()].find((f) => f.path === path);
      const busy = (this.isActive() && this.current?.path === path) || this.pendingStart?.file.path === path;
      if (file && !busy) {
        this.files.delete(file.name);
        this.deletes.push(path);
      }
      ws.send(JSON.stringify({ retGcodeFileInfo2: this.fileList() }));
    }
    if ('lightSw' in params && (params.lightSw === 0 || params.lightSw === 1)) this.push({ lightSw: params.lightSw });
    if (Array.isArray(params.excludeObjects) && !this.ignoreExcludeFrame && !this.ignoreExcludes) {
      for (const n of params.excludeObjects) if (typeof n === 'string') this.excludeNamed(n);
    }
    if (typeof params.gcodeCmd === 'string') this.runGcode(params.gcodeCmd);
  }

  /** The small G-code subset PrintYard's controls send (G28/G90/G91/G1/M83/M104/M140/M106/M220/M221/M84/EXCLUDE_OBJECT). */
  private runGcode(script: string): void {
    this.gcodeLog.push(script);
    const delta: Raw = {};
    const pos = String(this.state.curPosition);
    const cur: Record<string, number> = { X: 0, Y: 0, Z: 0 };
    for (const a of ['X', 'Y', 'Z']) cur[a] = Number(new RegExp(a + ':(-?[0-9.]+)').exec(pos)?.[1] ?? 0);
    const max: Record<string, number> = { X: 220, Y: 215, Z: 245 };
    const finish = () => {
      delta.curPosition = `X:${cur.X!.toFixed(2)} Y:${cur.Y!.toFixed(2)} Z:${cur.Z!.toFixed(2)}`;
      delta.autohome = `X:${this.homed.includes('x') ? 1 : 0} Y:${this.homed.includes('y') ? 1 : 0} Z:${this.homed.includes('z') ? 1 : 0}`;
      this.push(delta);
    };
    for (const rawLine of script.split('\n')) {
      const line = rawLine.split(';')[0]!.trim();
      const [word, ...args] = line.split(/\s+/);
      const code = (word ?? '').toUpperCase();
      const arg = (k: string) => {
        const a = args.find((x) => x.toUpperCase().startsWith(k));
        return a === undefined ? null : a.slice(k.length);
      };
      if (code === 'G28') {
        const axes = args.length === 0 ? ['X', 'Y', 'Z'] : args.map((a) => a.toUpperCase().slice(0, 1));
        for (const a of axes) {
          const ax = a.toLowerCase();
          this.homed = ['x', 'y', 'z'].filter((x) => x === ax || this.homed.includes(x)).join('');
          cur[a] = a === 'Z' ? 0 : max[a]! / 2;
        }
      } else if (code === 'G90') this.relative = false;
      else if (code === 'G91') this.relative = true;
      else if (code === 'G1' || code === 'G0') {
        for (const a of ['X', 'Y', 'Z']) {
          const v = arg(a);
          if (v === null) continue;
          const n = Number(v);
          if (!Number.isFinite(n)) continue;
          if (!this.homed.includes(a.toLowerCase())) return finish(); // Klipper: "Must home axis first" aborts the script
          const next = this.relative ? cur[a]! + n : n;
          if (next < 0 || next > max[a]!) return finish(); // "Move out of range" aborts the script
          cur[a] = next;
        }
        const e = arg('E');
        if (e !== null && Number.isFinite(Number(e))) {
          if (this.nozzle < 170) return finish(); // "Extrude below minimum temp"
          this.extruded += Number(e);
        }
      } else if (code === 'M104') delta.targetNozzleTemp = Number(arg('S') ?? 0);
      else if (code === 'M140') delta.targetBedTemp0 = Number(arg('S') ?? 0);
      else if (code === 'M106') {
        const p = Number(arg('P') ?? 0);
        const pct = Math.round((Number(arg('S') ?? 0) / 255) * 100);
        if (p === 0) delta.modelFanPct = pct;
        else if (p === 1) delta.caseFanPct = pct;
        else if (p === 2) delta.auxiliaryFanPct = pct;
      } else if (code === 'M107') delta.modelFanPct = 0;
      else if (code === 'M220' || code === 'M221') {
        const n = Math.round(Number(arg('S') ?? 100));
        if (Number.isFinite(n) && n > 0) delta[code === 'M220' ? 'curFeedratePct' : 'curFlowratePct'] = n;
      }
      else if (code === 'M84' || code === 'M18') this.homed = '';
      // EXCLUDE_OBJECT via `gcodeCmd` is ignored mid-print by the real K2 SE (seen on hardware): emulate that.
    }
    finish();
  }

  /** Moonraker `POST /printer/gcode/script` scripts received. */
  readonly moonGcode: string[] = [];

  /** Klipper EXCLUDE_OBJECT for one (upper-case) name of the running job, then a status push. */
  private excludeNamed(raw: string): void {
    const name = raw.toUpperCase();
    if (!this.current?.objects.some((o) => o.name.toUpperCase() === name) || this.excluded.includes(name)) return;
    this.excluded.push(name);
    this.push({});
  }

  /** Test helper: is the simulated toolhead in relative (G91) mode? */
  get relativeMode(): boolean {
    return this.relative;
  }

  /** `GET /downloads/humbnail/*` served (tests check the proxy cache). */
  thumbnailRequests = 0;

  /**
   * Test helper: stores a file as if it came from Creality Print / the touchscreen / a USB stick (not PrintYard),
   * with Creality list metadata. Replaces a file with the same name.
   */
  addStoredFile(name: string, bytes: Buffer, seconds = 600, meta: SimFileMeta = {}): void {
    const m = gcodeMeta(bytes);
    this.addFile({ name, bytes, seconds: seconds || m.seconds || 600, layers: m.layers ?? 50, meta });
  }

  /** Test helper: names of the files stored on the simulated printer. */
  fileNames(): string[] {
    return [...this.files.keys()];
  }

  // ---- simulation ----

  private isActive(): boolean {
    const s = this.state.state;
    return s === 1 || s === 5 || s === 6 || s === 7 || s === 8;
  }

  private setState(code: number, transition: { to: number; ticks: number } | null = null): void {
    this.transition = transition;
    const moon: Record<number, string> = { 1: 'printing', 5: 'paused', 6: 'paused', 7: 'printing', 8: 'printing', 2: 'complete', 4: 'cancelled' };
    this.moonPrintState = moon[code] ?? this.moonPrintState;
    if (code === 2 || code === 4) this.current = null;
    const delta: Raw = { state: code };
    if (code === 4 || code === 2) {
      delta.deviceState = 0;
      delta.targetNozzleTemp = 0;
      delta.targetBedTemp0 = 0;
      delta.printLeftTime = 0;
    }
    if (code === 2) {
      delta.printProgress = 100;
      delta.layer = this.state.TotalLayer;
    }
    this.push(delta);
  }

  private tick(): void {
    const delta: Raw = {};
    if (this.transition && --this.transition.ticks <= 0) {
      const to = this.transition.to;
      this.transition = null;
      this.setState(to);
    }
    if (this.pendingStart && --this.pendingStart.ticks <= 0) {
      const f = this.pendingStart.file;
      this.selfTestLeft = this.pendingStart.selfTest ? SELF_TEST_TICKS : 0;
      this.pendingStart = null;
      this.current = f;
      this.excluded.length = 0;
      this.homed = 'xyz';
      this.moonPrintState = 'printing';
      this.elapsed = 0;
      this.total = Math.max(1, f.seconds);
      const now = Math.floor(Date.now() / 1000);
      Object.assign(delta, {
        state: 1,
        deviceState: 1,
        printFileName: f.path,
        printId: `local_${now}`,
        printStartTime: now,
        TotalLayer: f.layers,
        layer: 0,
        printProgress: 0,
        dProgress: 0,
        printJobTime: 0,
        printLeftTime: this.total,
        usedMaterialLength: 0,
        targetNozzleTemp: 220,
        targetBedTemp0: 60,
        modelFanPct: 100,
        withSelfTest: this.selfTestLeft > 0 ? 1 : 100,
      });
      Object.assign(this.state, delta);
    }
    const tn = Number(this.state.targetNozzleTemp) || ROOM;
    const tb = Number(this.state.targetBedTemp0) || ROOM;
    const n2 = approach(this.nozzle, tn, this.o.heatPerTick);
    const b2 = approach(this.bed, tb, this.o.heatPerTick / 2);
    if (n2 !== this.nozzle) delta.nozzleTemp = temp((this.nozzle = n2));
    if (b2 !== this.bed) delta.bedTemp0 = temp((this.bed = b2));

    if (this.state.state === 1 && Math.abs(this.nozzle - tn) < 3 && this.selfTestLeft > 0) {
      // Pre-print calibration (auto-leveling): the firmware reports `withSelfTest` 1..99, then 100.
      this.selfTestLeft--;
      delta.withSelfTest = this.selfTestLeft === 0 ? 100 : Math.round(((SELF_TEST_TICKS - this.selfTestLeft) / SELF_TEST_TICKS) * 99);
    } else if (this.state.state === 1 && Math.abs(this.nozzle - tn) < 3) {
      if (!this.holdProgress) this.elapsed = Math.min(this.total, this.elapsed + this.o.simSecondsPerTick);
      const frac = this.elapsed / this.total;
      const layers = Number(this.state.TotalLayer) || 1;
      delta.printProgress = Math.min(100, Math.floor(frac * 100));
      delta.layer = Math.max(1, Math.min(layers, Math.ceil(frac * layers)));
      delta.printJobTime = this.elapsed;
      delta.printLeftTime = Math.max(0, this.total - this.elapsed);
      delta.usedMaterialLength = Math.round(frac * 5000);
      delta.curPosition = `X:${(110 + 50 * Math.sin(this.elapsed)).toFixed(2)} Y:${(107 + 50 * Math.cos(this.elapsed)).toFixed(2)} Z:${(frac * 20).toFixed(2)}`;
      Object.assign(this.state, delta);
      if (this.elapsed >= this.total) {
        this.push(delta);
        this.setState(2);
        return;
      }
    }
    if (Object.keys(delta).length > 0) this.push(delta);
  }

  private push(delta: Raw): void {
    Object.assign(this.state, delta);
    const frame = JSON.stringify(delta);
    if (!this.freezeCrealityWs) for (const c of this.clients) if (c.readyState === c.OPEN) c.send(frame);
    if (this.moonClients.size > 0) {
      const note = JSON.stringify({ jsonrpc: '2.0', method: 'notify_status_update', params: [this.moonObjects(), process.uptime()] });
      for (const c of this.moonClients) if (c.readyState === c.OPEN) c.send(note);
    }
  }

  private addFile(f: Omit<SimFile, 'path' | 'createTime' | 'size' | 'uuid' | 'objects' | 'meta'> & { meta?: SimFileMeta }): void {
    this.files.set(f.name, {
      ...f,
      meta: f.meta ?? {},
      objects: simObjects(f.bytes),
      size: f.bytes.length,
      uuid: randomUUID(),
      path: `${GCODE_DIR}/${f.name}`,
      createTime: f.meta?.createTime ?? Math.floor(Date.now() / 1000),
    });
  }

  private readonly misreported = new Set<string>();

  private listedSize(f: SimFile): number {
    return this.misreported.has(f.name) ? Math.max(0, f.size - 100) : f.size;
  }

  /** Test helper: kill the Moonraker websockets (the driver falls back / re-queries). */
  dropMoonraker(): void {
    for (const c of this.moonClients) c.terminate();
    this.moonClients.clear();
  }

  /** Test helper: size of a stored file (null when absent). */
  fileSize(name: string): number | null {
    return this.files.get(name)?.size ?? null;
  }

  private fileList(): Raw[] {
    return [...this.files.values()]
      .sort((a, b) => b.createTime - a.createTime)
      .map((f) => ({
        custom_types: 1,
        type: 8,
        name: f.name,
        path: f.path,
        file_size: this.listedSize(f),
        create_time: f.createTime,
        timeCost: f.seconds,
        consumables: f.meta.consumables ?? 1000,
        floorHeight: f.meta.floorHeight ?? 20,
        modelX: 0,
        modelY: 0,
        modelZ: 0,
        material: f.meta.material ?? 'PLA',
        nozzleTemp: 22000,
        bedTemp: 6000,
        software: f.meta.software ?? 'PrintYard',
        thumbnail: f.meta.thumbnail === false ? '' : `/usr/data/creality/local_gcode/humbnail/${f.name.replace(/\.gcode$/, '')}.png`,
        startPixel: 0,
        endPixel: 0,
        modelHeight: 0,
        layerHeight: 0,
        preview: `/usr/data/creality/local_gcode/original/${f.name.replace(/\.gcode$/, '')}.png`,
        materialColors: f.meta.materialColors ?? '#3B82F6',
        materialIds: (f.meta.material ?? 'PLA').split(';').map(() => '01001').join(';'),
        match: '',
      }));
  }

  private boxsInfo(): Raw {
    const mat = (id: number, type: string, name: string, color: string, percent: number) => ({
      id, vendor: 'Creality', type, color, name, minTemp: 190, maxTemp: 230, selected: 0, pressure: 0.04, percent, editStatus: 1, rfid: '', state: 1,
    });
    return {
      name: 'MF003',
      materialBoxs: [
        { id: 0, state: 0, type: 1, materials: [mat(0, 'PLA', 'Generic PLA', '#07a92ac', 100)] },
        {
          id: 1, state: 1, type: 0, temp: 26, humidity: 41,
          materials: [
            mat(0, 'PLA', 'Hyper PLA', '#0ffffff', 80),
            mat(1, 'PLA', 'Hyper PLA', '#0000000', 55),
            mat(2, 'PETG', 'Hyper PETG', '#0ff0000', 30),
            { id: 3, vendor: '', type: '', color: '', name: '', state: 0, percent: 0 },
          ],
        },
      ],
    };
  }
}

const temp = (v: number) => v.toFixed(6);

/** Simulated pre-print calibration length when `enableSelfTest: 1`. */
const SELF_TEST_TICKS = 4;

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Files "from elsewhere" on the user's real K2 SE (names from the probe and from Creality Print's Local files),
 * with the metadata the firmware reports for them. Used when `foreignFiles` is on (the shared dev simulator).
 */
const FOREIGN_FILES: { name: string; label: string; layers: number; seconds: number; meta: SimFileMeta }[] = [
  { name: 'Object_1_PLA_3h40m37s.gcode', label: 'Object_1', layers: 120, seconds: 13237,
    meta: { createTime: 1794175463, floorHeight: 20, consumables: 35888, material: 'PLA', materialColors: '#56DF3D', software: 'Creality' } },
  { name: 'plate_plate1.gcode', label: 'plate', layers: 80, seconds: 5420,
    meta: { createTime: 1794090000, floorHeight: 16, consumables: 14210, material: 'PLA', materialColors: '#F97316', software: 'Creality' } },
  { name: 'PantherPaw_plate1.gcode', label: 'PantherPaw', layers: 60, seconds: 2710,
    meta: { createTime: 1793990000, floorHeight: 20, consumables: 6875, material: 'PLA;PLA', materialColors: '#111111;#FFFFFF', software: 'Creality' } },
  { name: '4color_3DBenchy_PLA_1h0m.gcode', label: '3DBenchy', layers: 240, seconds: 3602,
    meta: { createTime: 1583064866, floorHeight: 20, consumables: 5237, material: 'PLA;PLA;PLA;PLA', materialColors: '#FF0000;#FFFFFF;#0000FF;#000000', software: 'Creality' } },
  { name: 'Spatula_PLA_32m19s.gcode', label: 'Spatula', layers: 40, seconds: 1939,
    meta: { createTime: 1583064866, floorHeight: 20, consumables: 6258, material: 'PLA', materialColors: '#FFFFFF', software: 'Creality' } },
  { name: '3DBenchy_PLA_22m53s.gcode', label: '3DBenchy', layers: 240, seconds: 1373,
    meta: { createTime: 1583064866, floorHeight: 20, consumables: 3720, material: 'PLA', materialColors: '#FF6A13', software: 'Creality' } },
];

/** A 96×96 PNG: a rounded "part" in `color` on a transparent plate (a stand-in for Creality's thumbnails). */
function thumbnailPng(color: string, seed: string): Buffer {
  const hex = /^#?([0-9a-f]{6})$/i.exec(color.trim())?.[1] ?? '3b82f6';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  const w = 96;
  const k = [...seed].reduce((a, c) => a + c.charCodeAt(0), 0) % 12;
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * w);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * stride + 1 + x * 4;
      const dx = (x - 48) / (26 + k);
      const dy = (y - 50) / (22 + (11 - k));
      if (dx ** 4 + dy ** 4 > 1) continue;
      const shade = 0.7 + 0.3 * (1 - Math.max(0, Math.min(1, (y - 28) / 44)));
      raw[o] = Math.round(r * shade);
      raw[o + 1] = Math.round(g * shade);
      raw[o + 2] = Math.round(b * shade);
      raw[o + 3] = 255;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(w, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A small real-looking G-code (one square perimeter per layer) for the preloaded sample file. */
export function sampleGcode(layers: number, label?: string): Buffer {
  const head = label ? `; generated by Creality Print (simulated "${label}")` : '; generated by PrintYard printer simulator';
  const out = [head, `; total layer number: ${layers}`, 'G28', 'M104 S220', 'M140 S60', 'G90', 'M83'];
  for (let l = 1; l <= layers; l++) {
    const z = (l * 0.2).toFixed(2);
    out.push(';LAYER_CHANGE', `;Z:${z}`, `G1 Z${z} F600`, ';TYPE:Outer wall');
    for (const [x, y] of [[90, 90], [130, 90], [130, 130], [90, 130], [90, 90]]) out.push(`G1 X${x} Y${y} E1.2 F3000`);
  }
  out.push('; estimated printing time (normal mode) = 15m 0s', '');
  return Buffer.from(out.join('\n'));
}

/** Two 20 mm cubes with Creality Print 7.x `EXCLUDE_OBJECT_DEFINE` / `START` / `END` and `; printing object` comments. */
export function twoObjectGcode(layers: number): Buffer {
  const cubes = [
    { name: 'Object_1_id_0_copy_0', label: 'Object_1', id: 0, x: 75, y: 107.5 },
    { name: 'Object_2_id_1_copy_0', label: 'Object_2', id: 1, x: 145, y: 107.5 },
  ];
  const out = ['; generated by PrintYard printer simulator (two objects)', `; total layer number: ${layers}`];
  for (const c of cubes) {
    const poly = [[c.x - 10, c.y - 10], [c.x + 10, c.y - 10], [c.x + 10, c.y + 10], [c.x - 10, c.y + 10]].map(([x, y]) => `[${x},${y}]`).join(',');
    out.push(`EXCLUDE_OBJECT_DEFINE NAME=${c.name} CENTER=${c.x},${c.y} POLYGON=[${poly}]`);
  }
  out.push('G28', 'M104 S220', 'M140 S60', 'G90', 'M83');
  for (let l = 1; l <= layers; l++) {
    const z = (l * 0.2).toFixed(2);
    out.push(';LAYER_CHANGE', `;Z:${z}`, `G1 Z${z} F600`);
    for (const c of cubes) {
      out.push(`; printing object ${c.label} id:${c.id} copy 0`, `EXCLUDE_OBJECT_START NAME=${c.name}`, ';TYPE:Outer wall');
      const pts = [[c.x - 10, c.y - 10], [c.x + 10, c.y - 10], [c.x + 10, c.y + 10], [c.x - 10, c.y + 10], [c.x - 10, c.y - 10]];
      for (const [x, y] of pts) out.push(`G1 X${x} Y${y} E1.1 F3000`);
      out.push(`EXCLUDE_OBJECT_END NAME=${c.name}`, `; stop printing object ${c.label} id:${c.id} copy 0`);
    }
  }
  out.push('; estimated printing time (normal mode) = 20m 0s', '');
  return Buffer.from(out.join('\n'));
}

/** Objects (definitions + byte ranges) of a G-code file, as the simulated Klipper sees them. */
function simObjects(bytes: Buffer): SimObject[] {
  const text = bytes.toString('latin1');
  const objects = new Map<string, SimObject>();
  for (const m of text.matchAll(/^EXCLUDE_OBJECT_DEFINE NAME=(\S+)(?: CENTER=(-?[\d.]+),(-?[\d.]+))?(?: POLYGON=(\[\[.*\]\]))?/gm)) {
    let polygon: [number, number][] = [];
    try {
      polygon = m[4] ? (JSON.parse(m[4]) as [number, number][]) : [];
    } catch {
      polygon = [];
    }
    objects.set(m[1]!.toUpperCase(), { name: m[1]!, center: m[2] ? [Number(m[2]), Number(m[3])] : null, polygon, ranges: [] });
  }
  if (objects.size === 0) return [];
  const open = new Map<string, number>();
  for (const m of text.matchAll(/^EXCLUDE_OBJECT_(START|END) NAME=(\S+)/gm)) {
    const key = m[2]!.toUpperCase();
    if (m[1] === 'START') open.set(key, m.index);
    else if (open.has(key)) {
      objects.get(key)?.ranges.push([open.get(key)!, m.index + m[0].length]);
      open.delete(key);
    }
  }
  return [...objects.values()];
}

function approach(cur: number, target: number, step: number): number {
  if (Math.abs(target - cur) <= step) return target;
  return cur + Math.sign(target - cur) * step;
}

function readBody(req: IncomingMessage, max: number, bytesPerSec = 0, stall: () => boolean = () => false): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const started = Date.now();
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
      if (stall()) {
        req.pause(); // never resumed: the sender sees no progress
        return;
      }
      if (bytesPerSec > 0) {
        // Throttle: stop reading until the wall clock catches up with `size / rate` (backpressure to the sender).
        const ahead = (size / bytesPerSec) * 1000 - (Date.now() - started);
        if (ahead > 5) {
          req.pause();
          setTimeout(() => req.resume(), ahead);
        }
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Minimal multipart parser: returns the content of the part named `file`. */
export function extractMultipartFile(body: Buffer, contentType: string): Buffer | null {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = m?.[1] ?? m?.[2];
  if (!boundary) return null;
  const delim = Buffer.from(`--${boundary}`);
  let pos = body.indexOf(delim);
  while (pos >= 0) {
    const headerStart = pos + delim.length + 2;
    const headerEnd = body.indexOf('\r\n\r\n', headerStart);
    if (headerEnd < 0) return null;
    const headers = body.subarray(headerStart, headerEnd).toString('utf8');
    const next = body.indexOf(delim, headerEnd);
    if (next < 0) return null;
    if (/name="file"/i.test(headers)) return body.subarray(headerEnd + 4, next - 2);
    pos = next;
  }
  return null;
}

const HEADER_END = Buffer.from([13, 10, 13, 10]);

function multipartParts(body: Buffer, contentType: string): { headers: string; content: Buffer }[] {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = m?.[1] ?? m?.[2];
  if (!boundary) return [];
  const delim = Buffer.from(`--${boundary}`);
  const out: { headers: string; content: Buffer }[] = [];
  let pos = body.indexOf(delim);
  while (pos >= 0) {
    const headerStart = pos + delim.length + 2;
    const headerEnd = body.indexOf(HEADER_END, headerStart);
    if (headerEnd < 0) break;
    const next = body.indexOf(delim, headerEnd);
    if (next < 0) break;
    out.push({ headers: body.subarray(headerStart, headerEnd).toString('utf8'), content: body.subarray(headerEnd + 4, next - 2) });
    pos = next;
  }
  return out;
}

/** Text value of the multipart field `name` (not a file part). */
function multipartField(body: Buffer, contentType: string, name: string): string | null {
  const part = multipartParts(body, contentType).find((p) => p.headers.toLowerCase().includes(`name="${name}"`) && !/filename=/i.test(p.headers));
  return part ? part.content.toString('utf8') : null;
}

/** File name of the multipart `file` part. */
function multipartFileName(body: Buffer, contentType: string): string | null {
  const part = multipartParts(body, contentType).find((p) => /name="file"/i.test(p.headers));
  return part ? (/filename="([^"]*)"/i.exec(part.headers)?.[1] ?? null) : null;
}

/** Print time and layer count from slicer comments (Creality Print / Orca footer, Cura header). */
export function gcodeMeta(buf: Buffer): { seconds: number | null; layers: number | null } {
  const head = buf.subarray(0, 64 * 1024).toString('utf8');
  const tail = buf.subarray(Math.max(0, buf.length - 64 * 1024)).toString('utf8');
  const text = head + '\n' + tail;
  let seconds: number | null = null;
  const est = /estimated printing time[^=\n]*=\s*([^\n]+)/i.exec(text);
  if (est?.[1]) {
    let s = 0;
    for (const [, v, u] of est[1].matchAll(/(\d+)\s*([dhms])/g)) s += Number(v) * ({ d: 86400, h: 3600, m: 60, s: 1 } as Record<string, number>)[u!]!;
    seconds = s || null;
  }
  const t = /^;TIME:(\d+)/m.exec(text);
  if (seconds === null && t?.[1]) seconds = Number(t[1]);
  const l = /total layers? (?:count|number)\s*[:=]\s*(\d+)/i.exec(text) ?? /^;LAYER_COUNT:(\d+)/m.exec(text);
  let layers = l?.[1] ? Number(l[1]) : null;
  if (layers === null) {
    const all = buf.toString('utf8');
    const n = (all.match(/^;LAYER_CHANGE/gm) ?? []).length;
    layers = n > 0 ? n : null;
  }
  return { seconds, layers };
}

let shared: PrinterSimulator | null = null;
let sharedStart: Promise<number> | null = null;

/** The process-wide simulator used for printers with host `sim` (started on first use, loopback only). */
export async function sharedSimulator(): Promise<{ sim: PrinterSimulator; port: number }> {
  if (!shared) {
    const secs = Number(appEnv('SIM_SPEED'));
    const kbps = Number(appEnv('SIM_UPLOAD_KBPS') ?? 1024);
    shared = new PrinterSimulator({
      ...(Number.isFinite(secs) && secs > 0 && { simSecondsPerTick: secs }),
      uploadBytesPerSec: Number.isFinite(kbps) && kbps > 0 ? kbps * 1024 : 0,
      foreignFiles: appEnv('SIM_FILES') !== '0',
    });
    sharedStart = shared.start(0, '127.0.0.1');
    logger.printer.info('Printer simulator enabled');
  }
  const port = await sharedStart!;
  return { sim: shared, port };
}

export async function stopSharedSimulator(): Promise<void> {
  const s = shared;
  shared = null;
  sharedStart = null;
  await s?.stop();
}
