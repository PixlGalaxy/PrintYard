import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import supertest from 'supertest';
import { createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { createContext, type AppContext, type ContextOptions } from '../src/context.js';
import { openDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import type { LoginGuardOptions } from '../src/modules/auth/login-guard.js';
import type { ProbeFn } from '../src/printers/drivers/registry.js';

process.env.SLICEDOCK_SILENT_LOGS = '1';

export const ADMIN = { username: 'admin', email: 'admin@example.com', password: 'correct-horse-battery' };

export const fakeProbe: ProbeFn = async (_model, host) =>
  host === '192.168.8.230'
    ? { ok: true, model: 'Creality K2 SE (F016)', mac: 'fc:ee:28:13:e2:ed', hostname: 'K2SE-E2ED', moonraker: true, creality: true }
    : { ok: false, error: 'printers.unreachable' };

export interface TestApp {
  ctx: AppContext;
  agent: ReturnType<typeof supertest.agent>;
  request: ReturnType<typeof supertest>;
  close(): void;
}

export function createTestApp(opts: { loginGuard?: LoginGuardOptions; context?: ContextOptions } = {}): TestApp {
  const dir = mkdtempSync(join(tmpdir(), 'slicedock-test-'));
  const config: Config = {
    port: 0,
    host: '127.0.0.1',
    appdataRoot: dir,
    dataRoot: dir,
    dbPath: join(dir, 'slicedock.db'),
    logLevel: 'error',
    version: 'test',
    isProduction: false,
    publicDir: join(dir, 'public'),
    sessionSecret: 'test-secret',
  };
  const db = openDb(':memory:');
  runMigrations(db);
  const ctx = createContext(config, db, {
    probe: fakeProbe,
    // Finalising a print waits for a stable terminal state (5 s in production); keep tests fast.
    printingTerminalStableMs: 200,
    ...opts.context,
    ...(opts.loginGuard && { loginGuard: opts.loginGuard }),
  });
  const app = createApp(ctx);
  return {
    ctx,
    agent: supertest.agent(app),
    request: supertest(app),
    close() {
      ctx.loginGuard.stop();
      ctx.printerControl.stop();
      ctx.profilesBackup.stop();
      ctx.printerMaterials.stop();
      ctx.printerManager.stop();
      ctx.hub.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function setupBody(overrides: Record<string, unknown> = {}) {
  return {
    language: 'es',
    admin: ADMIN,
    printer: { name: 'K2 SE', model: 'creality-k2se', host: '192.168.8.230', staticIp: true, mac: null },
    exposure: { mode: 'nginx', publicUrl: 'https://print.example.com' },
    engine: { selected: 'creality', autoUpdate: true },
    ...overrides,
  };
}

/** A minimal request shape for pure function tests. */
export function fakeReq(remoteAddress: string | undefined, headers: IncomingHttpHeaders = {}) {
  return { socket: { remoteAddress }, headers };
}
