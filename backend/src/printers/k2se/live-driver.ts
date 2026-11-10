import { createWriteStream, statSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { AppError } from '../../errors.js';
import { logger } from '../../logger.js';
import type { LiveJob, PrinterStatus } from '../../types.js';
import { JobRetention } from './job-retention.js';
import { formatHostForUrl, getJson, isRecord, normalizeMac } from '../drivers/http.js';
import type { ControlTelemetry, CurrentJobFile, EtaHints, PrinterDriver, PrinterEndpoint, PrinterIdentity, UploadResult } from '../drivers/types.js';
import { assertWritable } from '../read-only.js';
import { postMultipartFile, type UploadProgress } from '../drivers/upload.js';
import { CrealityConnection, type SocketFactory } from './connection.js';
import { k2seScanLimits } from '../../modules/files/gcode-scan.js';
import { factorsOf, gcodesRelativePath, homedAxesOf, MoonrakerFeed, OBJECT_NAME_RE, parseJob, positionOf, type MoonrakerObjects } from './moonraker.js';
import {
  cmd,
  gcodeDirFromList,
  isActiveState,
  isThumbnailName,
  mergeFrame,
  num,
  offlineStatus,
  parseFileList,
  parseFirmware,
  toPrinterStatus,
  type PrinterFileEntry,
  type RawPrinterState,
} from './protocol.js';

export interface LiveDriverOptions {
  printerId: number;
  host: string;
  /** Turns the configured host into the address/ports to contact (null = refuse/unresolvable now). */
  resolveEndpoint: (host: string) => Promise<PrinterEndpoint | null>;
  createSocket?: SocketFactory;
  /** Minimum gap between `status` events when nothing important changed. */
  statusThrottleMs?: number;
  /** CFS info is only sent on request: re-ask this often. */
  boxsInfoEveryMs?: number;
  uploadTimeoutMs?: number;
  /** Abort the printer upload when no byte moved for this long (default 30 s). */
  uploadStallMs?: number;
  /** After the whole body was sent: abort when the printer has not answered within this (default 120 s). */
  uploadAnswerMs?: number;
  /** How long to wait for an uploaded file to show up in the printer's file list. */
  fileReadyTimeoutMs?: number;
  /** Live job view from Moonraker (websocket subscription, polling fallback). Default true. */
  moonraker?: boolean;
  /** How long a transitional frame (idle/0 blip while resuming) keeps the last job and state. Default 5 s. */
  transitionHoldMs?: number;
  connection?: Partial<{ heartbeatMs: number; probeAfterMs: number; staleAfterMs: number; backoffInitialMs: number; backoffMaxMs: number; random: () => number }>;
}

type StatusCb = (s: PrinterStatus) => void;
type IdentityCb = (i: PrinterIdentity) => void;

export const printerOffline = () => new AppError(409, 'prints.printer_offline', 'The printer is offline');
export const uploadFailed = (message = 'Upload to the printer failed') => new AppError(502, 'prints.upload_failed', message);
export const uploadUnverified = (message = 'The printer did not confirm the uploaded file') => new AppError(502, 'prints.upload_unverified', message);

/** K2 SE hardware spec (Creality): bed up to 100 °C, hotend up to 300 °C. The controls never exceed these. */
export const K2SE_SPEC = { maxBedTemp: 100, maxNozzleTemp: 300 } as const;

/**
 * Live K2 SE driver: one Creality WebSocket (:9999) merged into `PrinterStatus`, uploads via `POST :80/upload/<name>`
 * and control via WS `set` frames (exactly what Creality Print sends).
 */
export class K2SELiveDriver implements PrinterDriver {
  readonly printerId: number;
  private host: string;
  private endpoint: PrinterEndpoint | null = null;
  private raw: RawPrinterState = {};
  private files: PrinterFileEntry[] | null = null;
  private online = false;
  private readonly conn: CrealityConnection;
  private readonly statusCbs = new Set<StatusCb>();
  private readonly identityCbs = new Set<IdentityCb>();
  private readonly fileWaiters = new Set<(list: PrinterFileEntry[]) => void>();
  private identity: PrinterIdentity = { mac: null, firmware: null, serial: null, hostname: null, model: null };
  private identifiedHost: string | null = null;
  private lastEmit = 0;
  private lastEmitKey = '';
  private throttleTimer: NodeJS.Timeout | null = null;
  private boxTimer: NodeJS.Timeout | null = null;
  private readonly opts: LiveDriverOptions;
  private readonly moon: MoonrakerFeed | null;
  private moonObjects: MoonrakerObjects = {};
  /** Epoch ms of the last Creality data frame (0 = none on this connection). */
  private lastFrameAt = 0;
  private readonly frameWaiters = new Set<() => void>();
  /** Keeps the job across the K2 SE's transitional pause/resume frames. */
  private readonly retention: JobRetention;
  private holdTimer: NodeJS.Timeout | null = null;
  private holdTimerAt = 0;

  constructor(opts: LiveDriverOptions) {
    this.opts = opts;
    this.printerId = opts.printerId;
    this.host = opts.host;
    this.retention = new JobRetention(opts.transitionHoldMs ?? 5000);
    this.conn = new CrealityConnection({
      label: `printer #${opts.printerId}`,
      ...opts.connection,
      ...(opts.createSocket && { createSocket: opts.createSocket }),
      resolveUrl: async () => {
        const ep = await opts.resolveEndpoint(this.host);
        this.endpoint = ep;
        return ep ? `ws://${formatHostForUrl(ep.host)}:${ep.wsPort}` : null;
      },
      onFrame: (f) => this.onFrame(f),
      onOnline: (v) => this.onOnline(v),
    });
    this.moon =
      opts.moonraker === false
        ? null
        : new MoonrakerFeed({
            label: `printer #${opts.printerId}`,
            endpoint: () => this.endpoint,
            isActive: () => isActiveState(toPrinterStatus(this.printerId, this.raw, this.online).state),
            onUpdate: (o) => {
              this.moonObjects = o;
              this.emitStatus(false);
            },
          });
  }

  get failedAttempts(): number {
    return this.conn.failedAttempts;
  }

  connect(): void {
    this.conn.start();
  }

  disconnect(): void {
    this.conn.stop();
    this.moon?.stop();
    if (this.throttleTimer) clearTimeout(this.throttleTimer);
    if (this.boxTimer) clearInterval(this.boxTimer);
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.throttleTimer = null;
    this.boxTimer = null;
  }

  setHost(host: string): void {
    if (host === this.host) return;
    this.host = host;
    this.identifiedHost = null;
    this.raw = {};
    this.files = null;
    this.moon?.stop();
    this.moonObjects = {};
    this.retention.reset();
    this.conn.restart();
  }

  getHost(): string {
    return this.host;
  }

  getStatus(): PrinterStatus {
    const klipper = this.jobState();
    const s = composeLiveStatus(this.printerId, this.raw, this.online, this.moonObjects, klipper);
    this.retention.apply(s, klipper);
    this.scheduleHoldExpiry();
    return s;
  }

  /** Re-publishes once a transitional hold (JobRetention) expires, so a real end shows up without a new frame. */
  private scheduleHoldExpiry(): void {
    const until = this.retention.holdUntil();
    if (until === null || until === this.holdTimerAt) return;
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimerAt = until;
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      this.emitStatus(false);
    }, Math.max(0, until - Date.now()) + 50);
    this.holdTimer.unref?.();
  }

  /**
   * Homing/position for validating a motion command, never older than `maxAgeMs`: when the last Creality frame is
   * older, asks for a status dump (`get ReqPrinterPara`) and waits up to 2 s; Moonraker is re-queried (read-only GET)
   * unless its websocket delivered data within `maxAgeMs` (and after `notBefore`). Moonraker not answering → not fresh (no stale fallback).
   */
  async controlTelemetry(maxAgeMs: number, notBefore = 0): Promise<ControlTelemetry> {
    const stale: ControlTelemetry = { fresh: false, homedAxes: null, position: null, receivedAt: 0 };
    if (!this.online) return stale;
    if (Date.now() - this.lastFrameAt > maxAgeMs || this.lastFrameAt < notBefore) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.frameWaiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, Math.min(2000, maxAgeMs));
        this.frameWaiters.add(done);
        if (!this.conn.send(cmd.reqStatus())) done();
      });
    }
    if (!this.online || Date.now() - this.lastFrameAt > maxAgeMs) return stale;
    if (this.moon && !(await this.moon.refresh(maxAgeMs, notBefore))) return stale;
    if (!this.online) return stale;
    const s = this.getStatus();
    // Moonraker (Klipper toolhead) is authoritative for homing/position when present.
    const at = this.moon ? this.moon.dataAt : this.lastFrameAt;
    return { fresh: true, homedAxes: s.homedAxes, position: s.position, receivedAt: at };
  }

  /** Klipper `print_stats.state` from Moonraker (null when unknown or Moonraker data is older than 10 s). */
  jobState(): string | null {
    if (!this.moon || Date.now() - this.moon.dataAt > 10_000) return null;
    const st = this.moonObjects.print_stats?.state;
    return typeof st === 'string' ? st : null;
  }

  /**
   * Exclude object the way Creality Print does on K-series printers (`excludeObjects` WS frame, upper-case Klipper
   * name), then waits up to `confirmMs` for Moonraker to list it in `excluded_objects`. Not confirmed → one fallback
   * through Moonraker `POST /printer/gcode/script` (`EXCLUDE_OBJECT NAME=<NAME>`) and another wait. Never claims
   * success without Klipper's confirmation.
   */
  async excludeObject(name: string, confirmMs = 5000): Promise<boolean> {
    assertWritable();
    const upper = name.toUpperCase();
    if (!OBJECT_NAME_RE.test(upper)) throw new AppError(400, 'exclude.invalid_name', 'Invalid object name');
    this.sendOrThrow(cmd.excludeObjects(upper));
    if (await this.waitExcluded(upper, confirmMs)) return true;
    logger.printer.warn(`printer #${this.printerId}: ${upper} not reported excluded, trying Moonraker gcode/script`);
    const ep = this.endpoint;
    if (ep && this.opts.moonraker !== false) {
      try {
        const script = encodeURIComponent(`EXCLUDE_OBJECT NAME=${upper}`);
        const res = await fetch(`http://${formatHostForUrl(ep.host)}:${ep.moonrakerPort}/printer/gcode/script?script=${script}`, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(5000),
        });
        await res.body?.cancel().catch(() => undefined);
      } catch (err) {
        logger.printer.warn(`printer #${this.printerId}: Moonraker exclude failed`, err);
      }
      if (await this.waitExcluded(upper, Math.min(confirmMs, 3000))) return true;
    }
    return false;
  }

  private excludedNow(upper: string): boolean {
    const eo = this.moonObjects.exclude_object;
    const list = eo && Array.isArray(eo.excluded_objects) ? eo.excluded_objects : [];
    return list.some((n) => typeof n === 'string' && n.toUpperCase() === upper);
  }

  private async waitExcluded(upper: string, timeoutMs: number): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      if (this.excludedNow(upper)) return true;
      if (Date.now() >= until || !this.online) return false;
      await new Promise((r) => setTimeout(r, 250));
      // Subscription pushes normally; re-query when it is quiet (read-only GET).
      await this.moon?.refresh(500);
    }
  }

  /** Raw Moonraker `exclude_object` status, available even when no job is active (null when unknown). */
  excludeObjectStatus(): Record<string, unknown> | null {
    return this.moonObjects.exclude_object ?? null;
  }

  /**
   * The file being printed, as Moonraker sees it (works for prints started anywhere): relative path inside the
   * `gcodes` root, size and Moonraker's metadata uuid. Falls back to the Creality WS file name.
   */
  etaHints(): EtaHints {
    const vs = this.moonObjects.virtual_sdcard ?? {};
    const cur = isRecord(vs.cur_print_data) ? vs.cur_print_data : {};
    const meta = isRecord(cur.metadata) ? cur.metadata : {};
    const pos = (v: unknown) => {
      const n = num(v);
      return n !== null && n > 0 ? n : null;
    };
    return {
      startByte: pos(meta.gcode_start_byte),
      endByte: pos(meta.gcode_end_byte),
      estimatedSeconds: pos(meta.estimated_time),
      selfTest: num(this.raw.withSelfTest),
    };
  }

  currentJobFile(): CurrentJobFile | null {
    const s = toPrinterStatus(this.printerId, this.raw, this.online);
    if (!isActiveState(s.state) && s.state !== 'complete') return null;
    const vs = this.moonObjects.virtual_sdcard ?? {};
    const cur = isRecord(vs.cur_print_data) ? vs.cur_print_data : {};
    const meta = isRecord(cur.metadata) ? cur.metadata : {};
    const fromMoon = gcodesRelativePath(vs.file_path);
    const relPath = fromMoon && (!s.fileName || fromMoon.endsWith(s.fileName)) ? fromMoon : gcodesRelativePath(this.raw.printFileName);
    if (!relPath) return null;
    return {
      fileName: relPath.split('/').pop()!,
      relPath,
      size: fromMoon === relPath ? (num(vs.file_size) ?? num(meta.size)) : null,
      uuid: fromMoon === relPath && typeof meta.uuid === 'string' ? meta.uuid : null,
    };
  }

  /** `GET :7125/server/files/gcodes/<relPath>` streamed to `dest` (written atomically). Returns bytes. */
  async downloadGcode(relPath: string, dest: string, maxBytes: number): Promise<number> {
    const ep = this.endpoint;
    if (!this.online || !ep) throw printerOffline();
    const url = `http://${formatHostForUrl(ep.host)}:${ep.moonrakerPort}/server/files/gcodes/${relPath.split('/').map(encodeURIComponent).join('/')}`;
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new AppError(502, 'printers.gcode_unavailable', `The printer did not serve the G-code (HTTP ${res.status})`);
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body.cancel().catch(() => undefined);
      throw new AppError(413, 'printers.gcode_too_large', 'The current G-code is too large to preview');
    }
    let bytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > maxBytes) cb(new AppError(413, 'printers.gcode_too_large', 'The current G-code is too large to preview'));
        else cb(null, chunk);
      },
    });
    const part = `${dest}.${process.pid}.${Date.now()}.part`;
    try {
      await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), counter, createWriteStream(part));
      await rename(part, dest);
    } catch (err) {
      await rm(part, { force: true });
      throw err;
    }
    return bytes;
  }

  /** `GET :80/downloads/original/current_print_image.png` (null when the printer has none). */
  async fetchThumbnail(maxBytes = 2 * 1024 * 1024): Promise<Buffer | null> {
    return this.fetchPng('/downloads/original/current_print_image.png', maxBytes);
  }

  /** `GET :80/downloads/humbnail/<n>.png` (the stock UI's file-list thumbnail; "humbnail" is the firmware's spelling). */
  async fetchFileThumbnail(thumbName: string, maxBytes = 1024 * 1024): Promise<Buffer | null> {
    if (!isThumbnailName(thumbName)) return null;
    return this.fetchPng(`/downloads/humbnail/${encodeURIComponent(thumbName)}`, maxBytes);
  }

  /** Read-only GET of a PNG on the printer's port 80 (null on any failure or non-PNG content). */
  private async fetchPng(path: string, maxBytes: number): Promise<Buffer | null> {
    const ep = this.endpoint;
    if (!this.online || !ep) return null;
    try {
      const res = await fetch(`http://${formatHostForUrl(ep.host)}:${ep.httpPort}${path}`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > maxBytes) return null;
      // PNG signature check: never relay arbitrary content as image/png.
      return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? buf : null;
    } catch {
      return null;
    }
  }

  getIdentity(): PrinterIdentity {
    return { ...this.identity };
  }

  /** Last file list reported by the printer (null until the first `reqGcodeFile` reply). */
  getFiles(): PrinterFileEntry[] | null {
    return this.files;
  }

  on(event: 'status', cb: StatusCb): void;
  on(event: 'identity', cb: IdentityCb): void;
  on(event: 'status' | 'identity', cb: StatusCb | IdentityCb): void {
    if (event === 'status') this.statusCbs.add(cb as StatusCb);
    else this.identityCbs.add(cb as IdentityCb);
  }

  // ---- commands (only ever sent on an explicit user action through the API) ----

  async pause(): Promise<void> {
    this.sendOrThrow(cmd.pause());
  }

  async resume(): Promise<void> {
    this.sendOrThrow(cmd.resume());
  }

  async cancel(): Promise<void> {
    this.sendOrThrow(cmd.stop());
  }

  /**
   * Runs G-code built by SliceDock itself (control builder, `EXCLUDE_OBJECT`) through the Creality WS `gcodeCmd`,
   * the transport Creality Print uses for its console/fan controls. Never called with client-supplied text.
   */
  async sendGcode(script: string): Promise<void> {
    if (!script || script.length > 512 || /[^\x20-\x7e\n]/.test(script)) throw new AppError(400, 'printers.invalid_gcode', 'Invalid control G-code');
    this.sendOrThrow(cmd.gcode(script));
  }

  /** Chamber light through the Creality WS (`{"method":"set","params":{"lightSw":0|1}}`). */
  async setLight(on: boolean): Promise<void> {
    this.sendOrThrow(cmd.light(on));
  }

  async startPrint(printerPath: string, opts: { calibrate?: boolean } = {}): Promise<void> {
    this.sendOrThrow(cmd.start(printerPath, opts.calibrate === true));
  }

  /**
   * Creality Print `Klipper4408Interface`: `POST http://<ip>/upload/<name>`, multipart field `file`; success when the
   * body contains "OK" (Creality Print) or JSON `code: 200` (stock web UI). Then waits until the file shows up in the
   * printer's own list (`CheckUploadFileReady`) and returns its full path.
   */
  async uploadFile(name: string, localPath: string, onProgress?: UploadProgress): Promise<UploadResult> {
    assertWritable();
    if (!this.online || !this.endpoint) throw printerOffline();
    const ep = this.endpoint;
    const size = statSync(localPath).size;
    let body = '';
    try {
      const res = await postMultipartFile({
        host: ep.host,
        port: ep.httpPort,
        path: `/upload/${encodeURIComponent(name)}`,
        field: 'file',
        fileName: name,
        localPath,
        timeoutMs: this.opts.uploadTimeoutMs ?? 15 * 60_000,
        stallMs: this.opts.uploadStallMs ?? 30_000,
        answerMs: this.opts.uploadAnswerMs ?? 120_000,
        ...(onProgress && { onProgress }),
      });
      body = res.body;
      if (res.status < 200 || res.status >= 300) throw uploadFailed(`Printer answered HTTP ${res.status}`);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw uploadFailed(`Upload to the printer failed: ${(err as Error).message}`);
    }
    if (!uploadAccepted(body)) throw uploadFailed('The printer did not accept the file');
    logger.printer.info(`printer #${this.printerId}: uploaded ${name} (${size} bytes)`);
    // Verified or nothing: the exact name with the exact size must show up (Creality list, else Moonraker metadata).
    const entry = await this.waitForFile(name, size);
    if (!entry) {
      logger.printer.warn(`printer #${this.printerId}: ${name} not confirmed with ${size} bytes, the print is not started`);
      throw uploadUnverified();
    }
    return { path: entry.path, size };
  }

  /** `GET :7125/server/files/metadata?filename=<name>` → size (null when unknown). Read-only. */
  private async moonrakerFileSize(name: string): Promise<number | null> {
    const ep = this.endpoint;
    if (!ep || this.opts.moonraker === false) return null;
    const body = await getJson(`http://${formatHostForUrl(ep.host)}:${ep.moonrakerPort}/server/files/metadata?filename=${encodeURIComponent(name)}`, 3000);
    return isRecord(body) && isRecord(body.result) ? num(body.result.size) : null;
  }

  async listFiles(): Promise<PrinterFileEntry[] | null> {
    if (!this.online) return null;
    const list = await this.waitForList(() => true, 5000);
    return list ?? null;
  }

  /**
   * Creality Print `deleteprt:<path>` over the WS (what its Files page sends). Never for the active job's file.
   * Then re-reads the file list until the file is gone.
   */
  async deleteFile(printerPath: string): Promise<boolean> {
    assertWritable();
    if (!this.online) throw printerOffline();
    if (!printerPath.startsWith('/') || printerPath.includes('..') || /[:\\\u0000]/.test(printerPath)) {
      throw new AppError(400, 'printers.invalid_path', 'Invalid printer file path');
    }
    const s = toPrinterStatus(this.printerId, this.raw, this.online);
    const active = isActiveState(s.state) || num(this.raw.deviceState) === 7;
    const current = this.currentJobFile();
    const name = printerPath.split('/').pop();
    if (active && (s.fileName === name || current?.fileName === name || this.raw.printFileName === printerPath)) {
      throw new AppError(409, 'printers.file_in_use', 'The file is being printed');
    }
    this.sendOrThrow(cmd.deleteFile(printerPath));
    logger.printer.info(`printer #${this.printerId}: deleted ${printerPath}`);
    const list = await this.waitForList((l) => !l.some((e) => e.path === printerPath), this.opts.fileReadyTimeoutMs ?? 10_000);
    return list !== null;
  }

  /** Asks for the file list (every 2 s) until `ok(list)`; null on timeout. */
  private waitForList(ok: (list: PrinterFileEntry[]) => boolean, timeoutMs: number): Promise<PrinterFileEntry[] | null> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: PrinterFileEntry[] | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        this.fileWaiters.delete(waiter);
        resolve(v);
      };
      const waiter = (list: PrinterFileEntry[]) => {
        if (ok(list)) finish(list);
      };
      this.fileWaiters.add(waiter);
      const timer = setTimeout(() => finish(null), timeoutMs);
      const poll = setInterval(() => this.conn.send(cmd.reqFiles()), 2000);
      this.conn.send(cmd.reqFiles());
    });
  }

  /**
   * Waits until the printer lists `name` with exactly `size` bytes. A listed entry without a size is confirmed via
   * Moonraker's metadata; a different size (still flushing, truncated) keeps waiting until the timeout (→ null).
   */
  private async waitForFile(name: string, size: number): Promise<PrinterFileEntry | null> {
    const deadline = Date.now() + (this.opts.fileReadyTimeoutMs ?? 15_000);
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return null;
      const entry = await this.waitForListedFile(name, size, left);
      if (!entry) return null;
      if (entry.size === size) return entry;
      // No size in the Creality list: ask Moonraker.
      if ((await this.moonrakerFileSize(name)) === size) return entry;
      await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(0, deadline - Date.now()))));
    }
  }

  private waitForListedFile(name: string, size: number, timeoutMs: number): Promise<PrinterFileEntry | null> {
    const match = (list: PrinterFileEntry[]) => list.find((e) => e.name === name && (e.size === null || e.size === size)) ?? null;
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: PrinterFileEntry | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        this.fileWaiters.delete(waiter);
        resolve(v);
      };
      const waiter = (list: PrinterFileEntry[]) => {
        const hit = match(list);
        if (hit) finish(hit);
      };
      this.fileWaiters.add(waiter);
      const timer = setTimeout(() => finish(null), timeoutMs);
      const poll = setInterval(() => this.conn.send(cmd.reqFiles()), 2000);
      this.conn.send(cmd.reqFiles());
    });
  }

  private sendOrThrow(frame: unknown): void {
    assertWritable();
    if (!this.conn.send(frame)) throw printerOffline();
  }

  // ---- inbound ----

  private onOnline(v: boolean): void {
    this.online = v;
    if (!v) this.lastFrameAt = 0;
    if (v) {
      this.boxTimer ??= setInterval(() => this.conn.send(cmd.reqBoxsInfo()), this.opts.boxsInfoEveryMs ?? 60_000);
      this.boxTimer.unref?.();
      void this.identify();
      this.moon?.start();
    } else {
      this.moon?.stop();
      this.moonObjects = {};
      if (this.boxTimer) clearInterval(this.boxTimer);
      this.boxTimer = null;
    }
    this.emitStatus(true);
  }

  private onFrame(frame: Record<string, unknown>): void {
    this.lastFrameAt = Date.now();
    const list = parseFileList(frame);
    if (list) {
      this.files = list;
      for (const w of [...this.fileWaiters]) w(list);
    }
    const prevCfs = this.raw.cfsConnect;
    const prevMaterial = `${String(this.raw.materialStatus)}|${String(this.raw.feedState)}|${String(this.raw.materialDetect)}`;
    mergeFrame(this.raw, frame);
    for (const w of [...this.frameWaiters]) w();
    if ('cfsConnect' in frame && frame.cfsConnect !== prevCfs) this.requestBoxsInfo();
    // Filament loaded/unloaded/changed on the printer screen: ask again (read-only `get`, throttled).
    const material = `${String(this.raw.materialStatus)}|${String(this.raw.feedState)}|${String(this.raw.materialDetect)}`;
    if (material !== prevMaterial && ('materialStatus' in frame || 'feedState' in frame || 'materialDetect' in frame)) this.requestBoxsInfo();
    if ('modelVersion' in frame || 'deviceSn' in frame || 'hostname' in frame || 'model' in frame) this.updateIdentity({
      firmware: parseFirmware(this.raw.modelVersion) ?? this.identity.firmware,
      serial: typeof this.raw.deviceSn === 'string' && this.raw.deviceSn ? this.raw.deviceSn : this.identity.serial,
      hostname: typeof this.raw.hostname === 'string' ? this.raw.hostname : this.identity.hostname,
      model: typeof this.raw.model === 'string' ? this.raw.model : this.identity.model,
    });
    this.emitStatus(false);
  }

  private lastBoxsRequest = 0;

  /** `get boxsInfo`, at most every 2 s (frames can flip materialStatus/feedState several times a second). */
  private requestBoxsInfo(): void {
    const now = Date.now();
    if (now - this.lastBoxsRequest < 2000) return;
    this.lastBoxsRequest = now;
    this.conn.send(cmd.reqBoxsInfo());
  }

  /** MAC from `/info` (Creality) or Moonraker `system_info`; once per host. GETs only. */
  private async identify(): Promise<void> {
    const ep = this.endpoint;
    if (!ep || this.identifiedHost === ep.host) return;
    this.identifiedHost = ep.host;
    const base = `http://${formatHostForUrl(ep.host)}`;
    const info = await getJson(`${base}:${ep.httpPort}/info`, 3000);
    let mac = isRecord(info) ? normalizeMac(info.mac) : null;
    if (!mac) {
      const sys = await getJson(`${base}:${ep.moonrakerPort}/machine/system_info`, 3000);
      const network = isRecord(sys) && isRecord(sys.result) && isRecord(sys.result.system_info) ? sys.result.system_info.network : null;
      if (isRecord(network)) {
        for (const iface of Object.values(network)) {
          const m = isRecord(iface) ? normalizeMac(iface.mac_address) : null;
          if (m && m !== '00:00:00:00:00:00') {
            mac = m;
            break;
          }
        }
      }
    }
    if (mac) this.updateIdentity({ mac });
  }

  private updateIdentity(patch: Partial<PrinterIdentity>): void {
    const next = { ...this.identity, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.identity)) return;
    this.identity = next;
    for (const cb of this.identityCbs) safe(() => cb(this.getIdentity()));
  }

  /**
   * Frames arrive every ~250 ms (mostly position/temperature noise). Emit immediately when the state, layer,
   * progress, file or error changes; otherwise at most once per `statusThrottleMs`.
   */
  private emitStatus(force: boolean): void {
    const s = this.getStatus();
    const objects = s.job?.objects.map((o) => `${o.name}:${o.excluded ? 1 : 0}${o.current ? 1 : 0}`).join(',');
    const key = `${s.online}|${s.state}|${s.layer}|${s.progress}|${s.fileName}|${s.errorCode}|${s.nozzleTarget}|${s.bedTarget}|${JSON.stringify(s.cfs)}|${s.fanPart}|${s.lightOn}|${s.speedFactor}|${s.flowFactor}|${s.homedAxes}|${objects}`;
    const important = force || key !== this.lastEmitKey;
    const now = Date.now();
    const gap = this.opts.statusThrottleMs ?? 1000;
    if (!important && now - this.lastEmit < gap) {
      if (!this.throttleTimer) {
        this.throttleTimer = setTimeout(() => {
          this.throttleTimer = null;
          this.emitStatus(true);
        }, gap - (now - this.lastEmit));
        this.throttleTimer.unref?.();
      }
      return;
    }
    if (this.throttleTimer) clearTimeout(this.throttleTimer);
    this.throttleTimer = null;
    this.lastEmit = now;
    this.lastEmitKey = key;
    for (const cb of this.statusCbs) safe(() => cb(s));
  }

  /** Raw merged state (diagnostics/tests). */
  rawState(): Readonly<RawPrinterState> {
    return this.raw;
  }

  /** True while the printer reports an active job (used before sending start). */
  isBusy(): boolean {
    const s = this.getStatus();
    return isActiveState(s.state) || num(this.raw.deviceState) === 7;
  }
}

export function uploadAccepted(body: string): boolean {
  try {
    const j = JSON.parse(body) as unknown;
    if (isRecord(j) && (j.code === 200 || j.code === '200')) return true;
  } catch {
    /* not JSON */
  }
  return /\bok\b/i.test(body);
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    logger.printer.error('printer listener failed', err);
  }
}

export { offlineStatus };

/** Moonraker job, only when it is about the file the Creality WS reports (stale objects are ignored). */
function liveJobOf(moonObjects: MoonrakerObjects, fileName: string | null): LiveJob | null {
  const job = parseJob(moonObjects);
  if (!job) return null;
  if (fileName && job.fileName !== fileName) return null;
  return job;
}

/**
 * One status from the merged Creality frames and Moonraker objects (pure; `klipper` = fresh `print_stats.state` or
 * null). The driver runs the result through `JobRetention` before publishing.
 */
export function composeLiveStatus(
  printerId: number,
  raw: RawPrinterState,
  online: boolean,
  moonObjects: MoonrakerObjects,
  klipper: string | null,
): PrinterStatus {
  const s = toPrinterStatus(printerId, raw, online);
  if (s.online) {
    // The K2 SE reports transient Creality states while pausing/resuming (seen as a momentary idle/abort frame):
    // while Klipper itself still says printing/paused, keep showing the job instead of a terminal state.
    if ((klipper === 'printing' || klipper === 'paused') && !isActiveState(s.state) && s.state !== 'error' && s.fileName !== null) {
      s.state = klipper === 'paused' ? 'paused' : 'printing';
    }
  }
  s.job = isActiveState(s.state) ? liveJobOf(moonObjects, s.fileName) : null;
  if (s.online) {
    // Moonraker is authoritative for homing/position (Klipper toolhead); the Creality WS is the fallback.
    s.homedAxes = homedAxesOf(moonObjects) ?? s.homedAxes;
    s.position = positionOf(moonObjects) ?? s.position;
    const f = factorsOf(moonObjects);
    s.speedFactor = f.speed ?? s.speedFactor;
    s.flowFactor = f.flow ?? s.flowFactor;
    // Nozzle: min(filament/profile high, printer-reported max, K2 SE spec 300). Bed: min(printer, spec 100).
    const limits = k2seScanLimits();
    s.maxNozzleTemp = Math.min(s.maxNozzleTemp ?? K2SE_SPEC.maxNozzleTemp, limits.nozzle, K2SE_SPEC.maxNozzleTemp);
    s.maxBedTemp = Math.min(s.maxBedTemp ?? K2SE_SPEC.maxBedTemp, limits.bed, K2SE_SPEC.maxBedTemp);
  }
  return s;
}
