import { appEnvFlag } from '../lib/env.js';
import { AppError } from '../errors.js';

/**
 * Hard read-only mode (`PRINTYARD_READ_ONLY=1`): watch a real printer with zero risk. Enforced at the lowest
 * layer (WS transport, HTTP upload, Moonraker JSON-RPC) and again at the API routes. Read on every call.
 *
 * Allowed: the stock heart_beat and its "ok" reply, WS `get` queries, Moonraker `printer.objects.query|subscribe`,
 * and HTTP GETs (identity, G-code download, thumbnail).
 */
export function isReadOnly(): boolean {
  return appEnvFlag('READ_ONLY');
}

export const readOnlyError = () =>
  new AppError(423, 'printers.read_only', 'PrintYard is in read-only mode: printer control is disabled');

export function assertWritable(): void {
  if (isReadOnly()) throw readOnlyError();
}

/** True for frames that only read: `"ok"`, `{ModeCode:"heart_beat"}`, `{method:"get"}`. */
export function isReadOnlyFrame(frame: unknown): boolean {
  let f = frame;
  if (typeof f === 'string') {
    if (f.trim() === 'ok') return true;
    try {
      f = JSON.parse(f) as unknown;
    } catch {
      return false;
    }
  }
  if (typeof f !== 'object' || f === null || Array.isArray(f)) return false;
  const o = f as Record<string, unknown>;
  if (o.ModeCode === 'heart_beat' && Object.keys(o).every((k) => k === 'ModeCode' || k === 'msg')) return true;
  return o.method === 'get';
}

const MOONRAKER_READ_METHODS = new Set(['printer.objects.subscribe', 'printer.objects.query', 'server.info', 'printer.info']);

export function isReadOnlyMoonrakerMethod(method: unknown): boolean {
  return typeof method === 'string' && MOONRAKER_READ_METHODS.has(method);
}
