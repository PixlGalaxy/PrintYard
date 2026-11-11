import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Config {
  port: number;
  host: string;
  appdataRoot: string;
  dataRoot: string;
  dbPath: string;
  logLevel: LogLevel;
  version: string;
  isProduction: boolean;
  /** Built frontend (`backend/public`); served when it contains an index.html. */
  publicDir: string;
  /** Reserved for signing (Phase 2+). Sessions themselves are opaque tokens stored as sha256. */
  sessionSecret: string;
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`Invalid PORT: ${raw}`);
  return n;
}

/** Inside the container the volumes are /appdata and /data; anywhere else, folders next to the backend. */
function defaultRoot(containerPath: string, devPath: string, isProduction: boolean): string {
  return isProduction ? containerPath : resolve(devPath);
}

function loadOrCreateSecret(appdataRoot: string, fromEnv: string | undefined): string {
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim();
  const file = join(appdataRoot, 'secret.key');
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  }
  const secret = randomBytes(32).toString('base64url');
  writeFileSync(file, secret + '\n', { mode: 0o600 });
  return secret;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const isProduction = env.NODE_ENV === 'production';
  const appdataRoot = resolve(env.APPDATA_ROOT || defaultRoot('/appdata', './appdata', isProduction));
  const dataRoot = resolve(env.DATA_ROOT || defaultRoot('/data', './data', isProduction));
  mkdirSync(appdataRoot, { recursive: true });
  mkdirSync(dataRoot, { recursive: true });

  const level = (env.LOG_LEVEL ?? 'info').toLowerCase() as LogLevel;

  return {
    port: parsePort(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    appdataRoot,
    dataRoot,
    dbPath: join(appdataRoot, 'printyard.db'),
    logLevel: LOG_LEVELS.includes(level) ? level : 'info',
    version: env.APP_VERSION || 'dev',
    isProduction,
    publicDir: resolve(env.PUBLIC_DIR || fileURLToPath(new URL('../public', import.meta.url))),
    sessionSecret: loadOrCreateSecret(appdataRoot, env.SESSION_SECRET),
  };
}
