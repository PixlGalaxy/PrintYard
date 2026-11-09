import WebSocket from 'ws';
import { logger } from '../../logger.js';
import { isReadOnly, isReadOnlyFrame, readOnlyError } from '../read-only.js';
import { cmd, parseFrame } from './protocol.js';

/** The subset of a `ws` client socket the connection uses (a fake is injected in tests). */
export interface SocketLike {
  on(event: 'open', cb: () => void): unknown;
  on(event: 'message', cb: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close', cb: () => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  send(data: string): void;
  close(): void;
  terminate(): void;
}

export type SocketFactory = (url: string) => SocketLike;

/** 16 MB: `retGcodeFileInfo2` replies grow with the number of files on the printer (~150 KB per 200 files). */
export const MAX_PRINTER_FRAME = 16 * 1024 * 1024;

export const defaultSocketFactory: SocketFactory = (url) =>
  new WebSocket(url, { maxPayload: MAX_PRINTER_FRAME, handshakeTimeout: 5000, perMessageDeflate: false }) as unknown as SocketLike;

export interface ConnectionOptions {
  /** Resolved per attempt (IP may change; null = not connectable now → retry later). */
  resolveUrl: () => Promise<string | null>;
  onFrame: (data: Record<string, unknown>) => void;
  onOnline: (online: boolean) => void;
  createSocket?: SocketFactory;
  label?: string;
  /** Client heart_beat cadence (stock web UI: 5 s; printer answers "ok"). */
  heartbeatMs?: number;
  /** No frame for this long → ask for a status dump (ha_creality_ws: 10 s). */
  probeAfterMs?: number;
  /** No frame for this long → drop and reconnect (Creality Print read timeout: 20 s). */
  staleAfterMs?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  random?: () => number;
}

/**
 * One WebSocket to the printer's :9999 with heartbeat, liveness detection and reconnect with exponential backoff
 * (1 s, 2 s, 4 s … capped at 30 s, ±25 % jitter). The backoff resets after the first frame of a connection.
 */
export class CrealityConnection {
  private socket: SocketLike | null = null;
  private stopped = true;
  private online = false;
  private attempts = 0;
  private lastRx = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private generation = 0;
  private readonly o: Required<Omit<ConnectionOptions, 'label'>> & { label: string };

  constructor(opts: ConnectionOptions) {
    this.o = {
      createSocket: defaultSocketFactory,
      label: 'printer',
      heartbeatMs: 5000,
      probeAfterMs: 10_000,
      staleAfterMs: 20_000,
      backoffInitialMs: 1000,
      backoffMaxMs: 30_000,
      random: Math.random,
      ...opts,
    };
  }

  get isOnline(): boolean {
    return this.online;
  }

  /** Reconnect attempts since the last successful frame. */
  get failedAttempts(): number {
    return this.attempts;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connectNow();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.teardown();
    this.setOnline(false);
  }

  /** Drop the current socket and reconnect right away (e.g. after the host changed). */
  restart(): void {
    if (this.stopped) return;
    this.generation++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.teardown();
    this.setOnline(false);
    this.attempts = 0;
    void this.connectNow();
  }

  /**
   * Sends a JSON frame; false if not connected. In read-only mode anything but `get`/heart_beat throws
   * `printers.read_only` before a byte is written.
   */
  send(frame: unknown): boolean {
    if (isReadOnly() && !isReadOnlyFrame(frame)) throw readOnlyError();
    if (!this.socket || !this.online) return false;
    try {
      this.socket.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  /** The delay before reconnect attempt number `attempt` (0-based). Exposed for tests. */
  backoffDelay(attempt: number): number {
    const base = Math.min(this.o.backoffMaxMs, this.o.backoffInitialMs * 2 ** Math.min(attempt, 20));
    return Math.round(base * (0.75 + 0.5 * this.o.random()));
  }

  private async connectNow(): Promise<void> {
    const gen = this.generation;
    let url: string | null = null;
    try {
      url = await this.o.resolveUrl();
    } catch (err) {
      logger.printer.warn(`${this.o.label}: cannot resolve address`, err);
    }
    if (this.stopped || gen !== this.generation) return;
    if (!url) return this.scheduleReconnect();

    let sock: SocketLike;
    try {
      sock = this.o.createSocket(url);
    } catch (err) {
      logger.printer.warn(`${this.o.label}: connect failed`, err);
      return this.scheduleReconnect();
    }
    this.socket = sock;
    let closed = false;
    const onClosed = () => {
      if (closed || this.socket !== sock) return;
      closed = true;
      this.teardown();
      this.setOnline(false);
      if (!this.stopped) this.scheduleReconnect();
    };
    sock.on('open', () => {
      if (this.socket !== sock) return;
      this.lastRx = Date.now();
      // Creality Print ReqInit asks for files + CFS right after connecting; the printer pushes a full dump on its own.
      this.rawSend(sock, cmd.reqStatus());
      this.rawSend(sock, cmd.reqBoxsInfo());
      this.rawSend(sock, cmd.reqFiles());
      this.startTicking(sock);
    });
    sock.on('message', (data) => {
      if (this.socket !== sock) return;
      this.lastRx = Date.now();
      const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      const frame = parseFrame(text);
      if (frame.kind === 'heartbeat') return this.rawSend(sock, 'ok');
      if (frame.kind !== 'data') return;
      if (!this.online) {
        this.attempts = 0;
        this.setOnline(true);
      }
      try {
        this.o.onFrame(frame.data);
      } catch (err) {
        logger.printer.error(`${this.o.label}: frame handler failed`, err);
      }
    });
    sock.on('close', onClosed);
    sock.on('error', (err) => {
      logger.printer.debug(`${this.o.label}: socket error`, err);
      onClosed();
    });
  }

  private startTicking(sock: SocketLike): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    let probed = false;
    this.tickTimer = setInterval(() => {
      if (this.socket !== sock) return;
      const silent = Date.now() - this.lastRx;
      if (silent >= this.o.staleAfterMs) {
        logger.printer.info(`${this.o.label}: no data for ${Math.round(silent / 1000)} s, reconnecting`);
        try {
          sock.terminate();
        } catch {
          /* ignore */
        }
        // `close` may not fire for a terminated fake/dead socket: clean up ourselves.
        this.teardown();
        this.setOnline(false);
        if (!this.stopped) this.scheduleReconnect();
        return;
      }
      if (silent >= this.o.probeAfterMs) {
        if (!probed) this.rawSend(sock, cmd.reqStatus());
        probed = true;
      } else probed = false;
      this.rawSend(sock, cmd.heartbeat());
    }, this.o.heartbeatMs);
    this.tickTimer.unref?.();
  }

  private rawSend(sock: SocketLike, frame: unknown): void {
    if (isReadOnly() && !isReadOnlyFrame(frame)) return; // internal frames are reads; never let one through
    try {
      sock.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
    } catch {
      /* closing */
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoffDelay(this.attempts);
    this.attempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectNow();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private teardown(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    const s = this.socket;
    this.socket = null;
    if (s) {
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
  }

  private setOnline(v: boolean): void {
    if (this.online === v) return;
    this.online = v;
    try {
      this.o.onOnline(v);
    } catch (err) {
      logger.printer.error(`${this.o.label}: online handler failed`, err);
    }
  }
}
