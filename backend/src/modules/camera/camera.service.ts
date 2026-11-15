import http from 'node:http';
import type { ServerResponse } from 'node:http';
import { AppError } from '../../errors.js';
import { logger } from '../../logger.js';
import type { PrinterEndpoint } from '../../printers/drivers/types.js';
import type { PrintersService } from '../printers/printers.service.js';

/** Creality K-series printers serve their camera with MJPG-streamer on this port (`/?action=stream|snapshot`). */
export const DEFAULT_CAMERA_PORT = 8080;
const BOUNDARY = 'printyardframe';
/** A frame bigger than this is not a camera frame (1080p MJPEG frames are ~100-400 KB). */
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
/** Garbage between frames is dropped once the buffer passes this without a header. */
const MAX_HEADER_BYTES = 64 * 1024;

export interface CameraServiceOptions {
  printers: PrintersService;
  /** Resolves the printer's address (private-host rule re-checked every time; `sim` → simulator). */
  endpoint: (printerId: number) => Promise<PrinterEndpoint | null>;
  /** Upstream closed this long after the last viewer leaves. */
  idleMs?: number;
  /** Viewers per printer (each one is a copy of every frame on the server's uplink). */
  maxViewers?: number;
  /** A stream is ended after this long; the page reconnects (and the session is checked again). */
  maxStreamMs?: number;
  /** No frame for this long = the camera stalled: the stream ends. */
  stallMs?: number;
  connectTimeoutMs?: number;
}

interface Viewer {
  res: ServerResponse;
  /** The socket buffer is full: frames are skipped (slow links get fewer frames instead of growing memory). */
  busy: boolean;
  timer: NodeJS.Timeout;
}

const unavailable = () => new AppError(502, 'printers.camera_unavailable', 'The printer camera is not answering');

/**
 * One upstream MJPEG connection per printer, fanned out to every viewer (MJPG-streamer on the printer is slow and
 * every extra client costs it CPU). New viewers get the last frame right away. Only frames are forwarded: each one
 * is re-framed in our own multipart stream, so nothing from the printer's HTTP headers reaches the browser.
 */
class Feed {
  readonly viewers = new Set<Viewer>();
  last: { frame: Buffer; at: number } | null = null;
  private req: http.ClientRequest | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private idleTimer: NodeJS.Timeout | null = null;
  private stallTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    readonly printerId: number,
    private readonly o: Required<Omit<CameraServiceOptions, 'printers' | 'endpoint'>>,
    private readonly onClosed: (feed: Feed) => void,
  ) {}

  /** Connects to the printer; rejects when the camera does not answer with an MJPEG stream. */
  open(ep: PrinterEndpoint): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
        this.close();
      };
      const req = http.get(
        { host: ep.host, port: ep.cameraPort ?? DEFAULT_CAMERA_PORT, path: '/?action=stream', timeout: this.o.connectTimeoutMs },
        (res) => {
          const type = String(res.headers['content-type'] ?? '');
          if (res.statusCode !== 200 || !/^multipart\//i.test(type)) {
            res.resume();
            return fail(unavailable());
          }
          settled = true;
          resolve();
          this.armStall();
          res.on('data', (chunk: Buffer) => this.onData(chunk));
          res.on('end', () => this.close());
          res.on('error', () => this.close());
        },
      );
      req.on('timeout', () => req.destroy(unavailable()));
      req.on('error', (err) => fail(err instanceof AppError ? err : unavailable()));
      this.req = req;
    });
  }

  private armStall(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      logger.printer.warn(`printer #${this.printerId}: camera stalled, closing the stream`);
      this.close();
    }, this.o.stallMs);
    this.stallTimer.unref();
  }

  /** Splits the printer's multipart stream into JPEG frames (Content-Length when sent, else the JPEG end marker). */
  private onData(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const head = this.buf.indexOf('\r\n\r\n');
      if (head < 0) {
        if (this.buf.length > MAX_HEADER_BYTES) this.buf = Buffer.alloc(0);
        return;
      }
      const headers = this.buf.subarray(0, head).toString('latin1');
      const start = head + 4;
      const len = /content-length:\s*(\d+)/i.exec(headers);
      let end: number;
      if (len) {
        const n = Number(len[1]);
        if (n <= 0 || n > MAX_FRAME_BYTES) {
          this.buf = this.buf.subarray(start);
          continue;
        }
        if (this.buf.length < start + n) return;
        end = start + n;
      } else {
        const eoi = this.buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
        if (eoi < 0) {
          if (this.buf.length - start > MAX_FRAME_BYTES) this.buf = Buffer.alloc(0);
          return;
        }
        end = eoi + 2;
      }
      const frame = Buffer.from(this.buf.subarray(start, end));
      this.buf = this.buf.subarray(end);
      if (frame[0] === 0xff && frame[1] === 0xd8) this.publish(frame);
    }
  }

  private publish(frame: Buffer): void {
    this.last = { frame, at: Date.now() };
    this.armStall();
    for (const v of this.viewers) this.send(v, frame);
  }

  private send(v: Viewer, frame: Buffer): void {
    if (v.busy || v.res.destroyed) return;
    v.res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
    v.res.write(frame);
    if (!v.res.write('\r\n')) {
      v.busy = true;
      v.res.once('drain', () => {
        v.busy = false;
      });
    }
  }

  attach(res: ServerResponse): void {
    if (this.closed) throw unavailable();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      // Reverse proxies (nginx, NPM) must not buffer a never-ending response
      'X-Accel-Buffering': 'no',
      Connection: 'close',
    });
    const timer = setTimeout(() => res.end(), this.o.maxStreamMs);
    timer.unref();
    const v: Viewer = { res, busy: false, timer };
    this.viewers.add(v);
    res.on('close', () => this.detach(v));
    if (this.last) this.send(v, this.last.frame);
  }

  private detach(v: Viewer): void {
    clearTimeout(v.timer);
    this.viewers.delete(v);
    if (this.viewers.size === 0 && !this.closed) {
      this.idleTimer = setTimeout(() => this.close(), this.o.idleMs);
      this.idleTimer.unref();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.req?.destroy();
    this.req = null;
    for (const v of [...this.viewers]) {
      clearTimeout(v.timer);
      v.res.end();
    }
    this.viewers.clear();
    this.onClosed(this);
  }
}

/** Authenticated camera proxy: browsers never talk to the printer (its ports have no auth and stay on the LAN). */
export class CameraService {
  private readonly feeds = new Map<number, Feed>();
  private readonly opening = new Map<number, Promise<Feed>>();
  private readonly o: Required<Omit<CameraServiceOptions, 'printers' | 'endpoint'>>;
  private readonly watch: NodeJS.Timeout;

  constructor(private readonly opts: CameraServiceOptions) {
    this.o = {
      idleMs: opts.idleMs ?? 5_000,
      maxViewers: opts.maxViewers ?? 8,
      maxStreamMs: opts.maxStreamMs ?? 30 * 60_000,
      stallMs: opts.stallMs ?? 15_000,
      connectTimeoutMs: opts.connectTimeoutMs ?? 5_000,
    };
    // A camera turned off (or a printer deleted / moved to another host) closes its open streams.
    this.watch = setInterval(() => {
      for (const id of [...this.feeds.keys()]) if (!this.enabled(id)) this.feeds.get(id)?.close();
    }, 5_000);
    this.watch.unref();
    opts.printers.onChange((c) => this.feeds.get(c.printer.id)?.close());
  }

  private enabled(printerId: number): boolean {
    return this.opts.printers.find(printerId)?.camera.type === 'mjpeg';
  }

  private async endpoint(printerId: number): Promise<PrinterEndpoint> {
    this.opts.printers.get(printerId); // 404 for an unknown printer
    if (!this.enabled(printerId)) throw new AppError(404, 'printers.camera_disabled', 'The camera is turned off for this printer');
    const ep = await this.opts.endpoint(printerId);
    if (!ep) throw unavailable();
    return ep;
  }

  /** `GET /api/printers/:id/camera/stream`: MJPEG (multipart/x-mixed-replace) until the viewer leaves. */
  async stream(printerId: number, res: ServerResponse): Promise<void> {
    const ep = await this.endpoint(printerId);
    let feed = this.feeds.get(printerId);
    if (feed && feed.viewers.size >= this.o.maxViewers) {
      throw new AppError(429, 'printers.camera_busy', 'Too many people are watching this camera');
    }
    if (!feed) {
      let pending = this.opening.get(printerId);
      if (!pending) {
        const f = new Feed(printerId, this.o, (closed) => {
          if (this.feeds.get(printerId) === closed) this.feeds.delete(printerId);
        });
        pending = f.open(ep).then(() => {
          this.feeds.set(printerId, f);
          return f;
        });
        this.opening.set(printerId, pending);
        void pending.finally(() => this.opening.delete(printerId)).catch(() => undefined);
      }
      feed = await pending;
    }
    if (res.destroyed) return;
    feed.attach(res);
  }

  /** `GET /api/printers/:id/camera/snapshot`: one JPEG (the live feed's last frame when a stream is open). */
  async snapshot(printerId: number): Promise<Buffer> {
    const ep = await this.endpoint(printerId);
    const live = this.feeds.get(printerId)?.last;
    if (live && Date.now() - live.at < 2_000) return live.frame;
    return new Promise((resolve, reject) => {
      const req = http.get(
        { host: ep.host, port: ep.cameraPort ?? DEFAULT_CAMERA_PORT, path: '/?action=snapshot', timeout: this.o.connectTimeoutMs },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return reject(unavailable());
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_FRAME_BYTES) {
              req.destroy();
              return reject(unavailable());
            }
            chunks.push(c);
          });
          res.on('end', () => {
            const jpeg = Buffer.concat(chunks);
            if (jpeg[0] === 0xff && jpeg[1] === 0xd8) resolve(jpeg);
            else reject(unavailable());
          });
          res.on('error', () => reject(unavailable()));
        },
      );
      req.on('timeout', () => req.destroy());
      req.on('error', () => reject(unavailable()));
    });
  }

  /** Open upstream connections (tests). */
  get openFeeds(): number {
    return this.feeds.size;
  }

  stop(): void {
    clearInterval(this.watch);
    for (const f of [...this.feeds.values()]) f.close();
  }
}
