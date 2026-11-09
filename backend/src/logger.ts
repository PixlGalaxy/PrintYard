import { CONTROL_CHARS } from './lib/sanitize.js';
import { logBuffer, type LogLevelName } from './log-buffer.js';

const RANK: Record<LogLevelName, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: LogLevelName = 'info';

export function setLogLevel(level: LogLevelName): void {
  minLevel = level;
}

/** Strip control characters so client-supplied values (usernames, hosts) cannot forge log lines. */
function sanitize(value: string): string {
  return value.replace(CONTROL_CHARS, ' ');
}

function write(channel: string, level: LogLevelName, rawMessage: string, detail?: unknown): void {
  if (RANK[level] < RANK[minLevel]) return;
  let msg = sanitize(rawMessage);
  if (detail instanceof Error) msg += `: ${sanitize(detail.message)}`;
  else if (detail !== undefined) {
    try {
      msg += ` ${sanitize(typeof detail === 'string' ? detail : JSON.stringify(detail))}`;
    } catch {
      /* unserialisable detail: keep the message only */
    }
  }
  const ts = Date.now();
  logBuffer.push({ ts, level, channel, msg });
  if (process.env.SLICEDOCK_SILENT_LOGS === '1') return;
  const line = `${new Date(ts).toISOString()} ${level.toUpperCase().padEnd(5)} [${channel}] ${msg}`;
  const stream = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  stream(line);
  if (detail instanceof Error && level === 'error' && detail.stack) console.error(detail.stack);
}

export interface ChannelLogger {
  debug(msg: string, detail?: unknown): void;
  info(msg: string, detail?: unknown): void;
  warn(msg: string, detail?: unknown): void;
  error(msg: string, detail?: unknown): void;
}

function channel(name: string): ChannelLogger {
  return {
    debug: (m, d) => write(name, 'debug', m, d),
    info: (m, d) => write(name, 'info', m, d),
    warn: (m, d) => write(name, 'warn', m, d),
    error: (m, d) => write(name, 'error', m, d),
  };
}

/** Channels: app (lifecycle), http (requests), auth (sign-in/out, bans), setup, printer, db. */
export const logger = {
  ...channel('app'),
  http: channel('http'),
  auth: channel('auth'),
  setup: channel('setup'),
  printer: channel('printer'),
  db: channel('db'),
  channel,
};
