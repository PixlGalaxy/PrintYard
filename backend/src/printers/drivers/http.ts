/** Read-only HTTP helpers for talking to printers on the LAN. Only GET is ever issued. */

const MAX_BODY = 256 * 1024;

export function formatHostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/** GET a URL and parse JSON, with a hard timeout and a body size cap. Never throws: returns null on any failure. */
export async function getJson(url: string, timeoutMs: number): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const text = await readCapped(res, MAX_BODY);
    if (text === null) return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function readCapped(res: Response, max: number): Promise<string | null> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** "FCEE2813E2ED", "fc-ee-28-13-e2-ed", "fc:ee:28:13:e2:ed" → "fc:ee:28:13:e2:ed"; null if not a MAC. */
export function normalizeMac(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const hex = raw.trim().toLowerCase().replace(/[:\-.\s]/g, '');
  if (!/^[0-9a-f]{12}$/.test(hex)) return null;
  return hex.match(/../g)!.join(':');
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
