import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { logger } from '../logger.js';
import type { Role } from '../types.js';

/**
 * Realtime hub behind `GET /api/ws` (contract §Realtime).
 *
 * Server → client: `{ type: <topic>, data }`. Topics in use: `printer.status`, `slice.job`, `engine.progress`,
 * `print.update`, `approval.pending` (plus `pong`, `hello`, `error`).
 * Client → server: `{ type: 'subscribe', printers: number[] }`, `{ type: 'unsubscribe', printers }`, `{ type: 'ping' }`.
 *
 * Other modules only call `hub.publish(topic, data, filter)`:
 * ```ts
 * ctx.hub.publish('slice.job', job, forUser(job.userId));
 * ctx.hub.publish('engine.progress', p, forAdmins);
 * ```
 */

export interface HubClientInfo {
  readonly userId: number;
  readonly username: string;
  readonly role: Role;
  /** Printer ids this client subscribed to (`printer.status` only goes to subscribers). */
  readonly printers: ReadonlySet<number>;
}

export type HubFilter = (client: HubClientInfo) => boolean;

/** Only this user's connections. */
export const forUser =
  (userId: number): HubFilter =>
  (c) =>
    c.userId === userId;
/** Only admins. */
export const forAdmins: HubFilter = (c) => c.role === 'admin';
/** This user plus every admin (e.g. `print.update`). */
export const forUserAndAdmins =
  (userId: number | null): HubFilter =>
  (c) =>
    (userId !== null && c.userId === userId) || c.role === 'admin';
/** Clients that subscribed to this printer. */
export const forPrinterSubscribers =
  (printerId: number): HubFilter =>
  (c) =>
    c.printers.has(printerId);

/** What the hub needs to authenticate an upgrade request (kept abstract so tests and app wiring stay simple). */
export interface HubAuth {
  /** Returns the signed-in user for this upgrade request, or null (→ 401). */
  authenticate(
    req: IncomingMessage,
  ): { userId: number; username: string; role: Role; sessionId: string; /** stored session id (sha256 of the token) */ sessionKey?: string } | null;
  /** Re-validates a session periodically without extending it (no idle-timer touch); null closes the socket. */
  revalidate(sessionId: string, req: IncomingMessage): { role: Role } | null;
  /** True if the Origin is allowed (same-origin check). */
  originAllowed(req: IncomingMessage): boolean;
  /** True if the client IP is banned. */
  banned?(req: IncomingMessage): boolean;
}

export interface HubOptions {
  path?: string;
  pingIntervalMs?: number;
  /** Max inbound frame from browsers. */
  maxPayload?: number;
  /** Drop messages to a client whose send buffer exceeds this (slow consumer). */
  maxBufferedBytes?: number;
  /** Called after a client subscribes to printers, so the current status can be sent immediately. */
  onSubscribe?: (client: HubClientInfo, printerIds: number[], send: (topic: string, data: unknown) => void) => void;
  /** Can the client see this printer? Defaults to true for every authenticated user. */
  canSubscribe?: (client: HubClientInfo, printerId: number) => boolean;
}

interface Client extends HubClientInfo {
  ws: WebSocket;
  sessionId: string;
  sessionKey: string | null;
  req: IncomingMessage;
  role: Role;
  printers: Set<number>;
  alive: boolean;
}

const MAX_SUBSCRIPTIONS = 32;

export class RealtimeHub {
  private readonly clients = new Set<Client>();
  private readonly wss: WebSocketServer;
  private readonly path: string;
  private readonly pingIntervalMs: number;
  private readonly maxBufferedBytes: number;
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly servers = new Set<Server>();

  constructor(
    private readonly auth: HubAuth,
    private readonly opts: HubOptions = {},
  ) {
    this.path = opts.path ?? '/api/ws';
    this.pingIntervalMs = opts.pingIntervalMs ?? 25_000;
    this.maxBufferedBytes = opts.maxBufferedBytes ?? 4 * 1024 * 1024;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxPayload ?? 64 * 1024, perMessageDeflate: false });
  }

  private readonly taps = new Set<(topic: string, data: unknown) => void>();

  /** Observes every `publish` in-process (no socket involved). Returns an unsubscribe function. */
  tap(listener: (topic: string, data: unknown) => void): () => void {
    this.taps.add(listener);
    return () => this.taps.delete(listener);
  }

  /** Number of connected clients (diagnostics/tests). */
  get size(): number {
    return this.clients.size;
  }

  /** Hooks the HTTP server's `upgrade` event for `path`. Other upgrade paths are left alone (destroyed if unhandled). */
  attach(server: Server): void {
    if (this.servers.has(server)) return;
    this.servers.add(server);
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    if (!this.pingTimer) {
      this.pingTimer = setInterval(() => this.heartbeat(), this.pingIntervalMs);
      this.pingTimer.unref();
    }
  }

  /**
   * Sends `{ type: topic, data }` to every connected client matching `filter` (all authenticated clients when
   * omitted). Never throws. Data must be JSON-serialisable.
   */
  publish(topic: string, data: unknown, filter?: HubFilter): number {
    // In-process observers (notifications) see every publish, even with no sockets connected.
    for (const tap of this.taps) {
      try {
        tap(topic, data);
      } catch (err) {
        logger.error(`realtime: tap failed for ${topic}`, err);
      }
    }
    if (this.clients.size === 0) return 0;
    let frame: string;
    try {
      frame = JSON.stringify({ type: topic, data });
    } catch (err) {
      logger.error(`realtime: cannot serialise ${topic}`, err);
      return 0;
    }
    let sent = 0;
    for (const c of this.clients) {
      if (filter && !safeFilter(filter, c)) continue;
      if (this.sendRaw(c, frame)) sent++;
    }
    return sent;
  }

  /**
   * Disconnects all of a user's sockets (deleted, disabled, role changed, sessions revoked). `exceptSessionKey`
   * keeps the sockets of that session (e.g. the one that just changed its password).
   */
  disconnectUser(userId: number, exceptSessionKey?: string): number {
    let n = 0;
    for (const c of this.clients) {
      if (c.userId !== userId || (exceptSessionKey !== undefined && c.sessionKey === exceptSessionKey)) continue;
      this.drop(c);
      n++;
    }
    return n;
  }

  /** Disconnects the sockets of one session (logout, session revoked from the account page). */
  disconnectSession(sessionKey: string): number {
    let n = 0;
    for (const c of this.clients) {
      if (c.sessionKey !== sessionKey) continue;
      this.drop(c);
      n++;
    }
    return n;
  }

  private drop(c: Client): void {
    this.clients.delete(c);
    try {
      c.ws.close(4401, 'session ended');
    } catch {
      c.ws.terminate();
    }
  }

  close(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const c of this.clients) c.ws.terminate();
    this.clients.clear();
    this.wss.close();
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = req.url ?? '';
    const pathname = url.split('?')[0];
    if (pathname !== this.path) {
      // Only our path is a WebSocket endpoint; anything else is refused.
      return reject(socket, 404, 'Not Found');
    }
    try {
      if (this.auth.banned?.(req)) return reject(socket, 403, 'Forbidden');
      if (!this.auth.originAllowed(req)) {
        logger.http.info(`WS upgrade refused (origin ${String(req.headers.origin ?? 'none')})`);
        return reject(socket, 403, 'Forbidden');
      }
      const user = this.auth.authenticate(req);
      if (!user) return reject(socket, 401, 'Unauthorized');
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req, user));
    } catch (err) {
      logger.error('WS upgrade failed', err);
      reject(socket, 500, 'Internal Server Error');
    }
  }

  private onConnection(
    ws: WebSocket,
    req: IncomingMessage,
    user: { userId: number; username: string; role: Role; sessionId: string; sessionKey?: string },
  ): void {
    const client: Client = {
      ws,
      req,
      sessionId: user.sessionId,
      sessionKey: user.sessionKey ?? null,
      userId: user.userId,
      username: user.username,
      role: user.role,
      printers: new Set(),
      alive: true,
    };
    this.clients.add(client);
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (raw, isBinary) => this.onMessage(client, raw, isBinary));
    ws.on('close', () => this.clients.delete(client));
    ws.on('error', () => this.clients.delete(client));
    this.sendTo(client, 'hello', { userId: client.userId, role: client.role });
  }

  private onMessage(client: Client, raw: RawData, isBinary: boolean): void {
    client.alive = true;
    if (isBinary) return;
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return this.sendTo(client, 'error', { code: 'realtime.bad_message' });
    }
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as { type?: unknown; printers?: unknown };
    switch (m.type) {
      case 'ping':
        return this.sendTo(client, 'pong', { ts: Date.now() });
      case 'subscribe':
      case 'unsubscribe': {
        const ids = Array.isArray(m.printers)
          ? m.printers.filter((v): v is number => Number.isSafeInteger(v) && (v as number) > 0).slice(0, MAX_SUBSCRIPTIONS)
          : [];
        if (m.type === 'unsubscribe') {
          for (const id of ids) client.printers.delete(id);
          return;
        }
        const added: number[] = [];
        for (const id of ids) {
          if (client.printers.size >= MAX_SUBSCRIPTIONS) break;
          if (this.opts.canSubscribe && !this.opts.canSubscribe(client, id)) continue;
          client.printers.add(id);
          added.push(id);
        }
        if (added.length > 0) {
          try {
            this.opts.onSubscribe?.(client, added, (topic, data) => this.sendTo(client, topic, data));
          } catch (err) {
            logger.error('realtime: onSubscribe failed', err);
          }
        }
        return;
      }
      default:
        return;
    }
  }

  private heartbeat(): void {
    for (const c of this.clients) {
      if (!c.alive) {
        c.ws.terminate();
        this.clients.delete(c);
        continue;
      }
      // An address banned after the upgrade (login brute force) loses its live feed too, like the HTTP API.
      if (safeCheck(() => this.auth.banned?.(c.req) === true)) {
        c.ws.close(4403, 'address blocked');
        this.clients.delete(c);
        continue;
      }
      // Sessions can be revoked (logout elsewhere, password reset, user disabled): re-check on every ping.
      const session = this.auth.revalidate(c.sessionId, c.req);
      if (!session) {
        c.ws.close(4401, 'session ended');
        this.clients.delete(c);
        continue;
      }
      c.role = session.role;
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        /* closed */
      }
    }
  }

  private sendTo(client: Client, topic: string, data: unknown): void {
    this.sendRaw(client, JSON.stringify({ type: topic, data }));
  }

  private sendRaw(client: Client, frame: string): boolean {
    if (client.ws.readyState !== client.ws.OPEN) return false;
    if (client.ws.bufferedAmount > this.maxBufferedBytes) return false; // slow consumer: drop, it gets the next update
    client.ws.send(frame);
    return true;
  }
}

function safeFilter(filter: HubFilter, c: HubClientInfo): boolean {
  try {
    return filter(c);
  } catch {
    return false;
  }
}

function safeCheck(check: () => boolean): boolean {
  try {
    return check();
  } catch {
    return false;
  }
}

function reject(socket: Duplex, status: number, text: string): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * Same-origin check for the upgrade: the browser's `Origin` must match the `Host` the request was sent to, or the
 * configured public URL (reverse proxies may rewrite Host). A missing Origin is refused: browsers always send it.
 */
export function isSameOrigin(req: IncomingMessage, publicUrl: string | null): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return false;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (o.protocol !== 'http:' && o.protocol !== 'https:') return false;
  const host = req.headers.host;
  if (typeof host === 'string' && o.host.toLowerCase() === host.toLowerCase()) return true;
  if (publicUrl) {
    try {
      if (new URL(publicUrl).origin === o.origin) return true;
    } catch {
      /* invalid setting */
    }
  }
  return false;
}
