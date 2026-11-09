import { readFileSync } from 'node:fs';

export const GIB = 1024 ** 3;
/** Anything at or above this is "no limit" (cgroup v1 reports ~2^63 when unlimited). */
const UNLIMITED_THRESHOLD = 2 ** 50;

const CGROUP_V2 = '/sys/fs/cgroup/memory.max';
const CGROUP_V1 = '/sys/fs/cgroup/memory/memory.limit_in_bytes';

type ReadFile = (path: string) => string;

const defaultRead: ReadFile = (path) => readFileSync(path, 'utf8');

function parseLimit(raw: string): number | null | undefined {
  const v = raw.trim();
  if (v === '' ) return undefined;
  if (v === 'max') return null;
  if (!/^\d+$/.test(v)) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n >= UNLIMITED_THRESHOLD) return null;
  return n;
}

/** Container memory limit in bytes from cgroup v2, then v1; null = unlimited or unknown (not in a cgroup). */
export function readMemoryLimit(read: ReadFile = defaultRead): number | null {
  for (const path of [CGROUP_V2, CGROUP_V1]) {
    let raw: string;
    try {
      raw = read(path);
    } catch {
      continue;
    }
    const parsed = parseLimit(raw);
    if (parsed !== undefined) return parsed;
  }
  return null;
}

/** Contract: memoryOk = limit === null || limit > 1 GiB (2 GiB recommended). */
export function isMemoryOk(limit: number | null): boolean {
  return limit === null || limit > GIB;
}

export function memoryStatus(read?: ReadFile): { limitBytes: number | null; ok: boolean } {
  const limitBytes = readMemoryLimit(read);
  return { limitBytes, ok: isMemoryOk(limitBytes) };
}
