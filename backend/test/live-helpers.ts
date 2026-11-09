import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import type { AppContext } from '../src/context.js';

export interface LiveServer {
  server: Server;
  base: string;
  wsUrl: string;
  close(): Promise<void>;
}

/** A real HTTP server (needed for WebSocket upgrades) around a test context. */
export async function startServer(ctx: AppContext): Promise<LiveServer> {
  const server = createServer(createApp(ctx));
  ctx.hub.attach(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    base: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/api/ws`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Logs in and returns the `Cookie` header value. */
export async function loginCookie(base: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200) throw new Error(`login failed ${res.status}`);
  const set = res.headers.getSetCookie().find((c) => c.startsWith('sd_session='));
  if (!set) throw new Error('no session cookie');
  return set.split(';')[0]!;
}

export interface WsClient {
  ws: WebSocket;
  messages: { type: string; data: any }[];
  next(type: string, pred?: (data: any) => boolean, timeoutMs?: number): Promise<any>;
  send(obj: unknown): void;
  close(): void;
}

/** Connects; resolves on open, rejects with the HTTP status on a refused upgrade. */
export function wsConnect(url: string, headers: Record<string, string>): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const messages: { type: string; data: any }[] = [];
    const waiters = new Set<() => void>();
    ws.on('message', (raw) => {
      messages.push(JSON.parse(raw.toString()));
      for (const w of [...waiters]) w();
    });
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.on('error', (err) => reject(err));
    ws.on('open', () =>
      resolve({
        ws,
        messages,
        send: (obj) => ws.send(JSON.stringify(obj)),
        close: () => ws.close(),
        next(type, pred = () => true, timeoutMs = 5000) {
          let seen = 0;
          return new Promise((res, rej) => {
            const check = () => {
              for (; seen < messages.length; seen++) {
                const m = messages[seen]!;
                if (m.type === type && pred(m.data)) {
                  cleanup();
                  return res(m.data);
                }
              }
            };
            const timer = setTimeout(() => {
              cleanup();
              rej(new Error(`timeout waiting for ${type}`));
            }, timeoutMs);
            const cleanup = () => {
              clearTimeout(timer);
              waiters.delete(check);
            };
            waiters.add(check);
            check();
          });
        },
      }),
    );
  });
}

export async function api(base: string, cookie: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Cookie: cookie, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
}

export async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 5000, stepMs = 20): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
