import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPrivateIp, normalizeIp } from '../../lib/ip.js';

export type FetchFn = typeof fetch;
export type LookupFn = (host: string) => Promise<string[]>;

export const OUTBOUND_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

const defaultLookup: LookupFn = async (host) => (await dnsLookup(host, { all: true })).map((a) => a.address);

/** Thrown for every failed delivery; `message` never contains the URL (it may carry a token). */
export class DeliveryError extends Error {
  constructor(
    message: string,
    /** HTTP status, when the remote answered. */
    readonly status: number | null = null,
    /** false = retrying cannot help (4xx except 408/429, bad configuration). */
    readonly retryable = true,
  ) {
    super(message);
  }
}

export interface OutboundRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
  /** ntfy: plain http is allowed when the host is (or resolves to) a private address. */
  allowHttpPrivate?: boolean;
}

export interface OutboundDeps {
  fetchImpl?: FetchFn;
  lookup?: LookupFn;
  timeoutMs?: number;
}

/** All addresses of a host (IP literals as they are). */
async function addressesOf(host: string, lookup: LookupFn): Promise<string[]> {
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare)) return [normalizeIp(bare) ?? bare];
  if (/^localhost$/i.test(bare) || /\.localhost\.?$/i.test(bare)) return ['127.0.0.1'];
  try {
    return await lookup(bare);
  } catch {
    throw new DeliveryError('Host name does not resolve');
  }
}

/** Validates the first hop: https always; http only with allowHttpPrivate and a private destination. */
async function checkTarget(url: URL, req: OutboundRequest, lookup: LookupFn): Promise<void> {
  if (url.username || url.password) throw new DeliveryError('URLs with credentials are not allowed', null, false);
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && req.allowHttpPrivate) {
    const addrs = await addressesOf(url.hostname, lookup);
    if (addrs.length > 0 && addrs.every(isPrivateIp)) return;
    throw new DeliveryError('Plain http is only allowed for servers on a private network', null, false);
  }
  throw new DeliveryError('Only https destinations are allowed', null, false);
}

/** Redirect hops must stay on https and must not lead into the private network. */
async function checkRedirect(url: URL, lookup: LookupFn): Promise<void> {
  if (url.protocol !== 'https:') throw new DeliveryError('Redirect to a non-https URL refused', null, false);
  if (url.username || url.password) throw new DeliveryError('Redirect with credentials refused', null, false);
  const addrs = await addressesOf(url.hostname, lookup);
  if (addrs.length === 0 || addrs.some(isPrivateIp)) throw new DeliveryError('Redirect to a private address refused', null, false);
}

/**
 * POSTs with a timeout and manual redirect handling (never into the private network). Resolves on 2xx; throws a
 * DeliveryError otherwise. The response body is read (capped) only to build a short error message.
 */
export async function postOutbound(req: OutboundRequest, deps: OutboundDeps = {}): Promise<number> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const lookup = deps.lookup ?? defaultLookup;
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    throw new DeliveryError('Invalid URL', null, false);
  }
  await checkTarget(url, req, lookup);

  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: req.headers,
        body: req.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(deps.timeoutMs ?? OUTBOUND_TIMEOUT_MS),
      });
    } catch (err) {
      const name = (err as Error).name;
      throw new DeliveryError(name === 'TimeoutError' || name === 'AbortError' ? 'Timed out' : 'Network error');
    }
    if (res.status >= 200 && res.status < 300) {
      await res.body?.cancel().catch(() => undefined);
      return res.status;
    }
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => undefined);
      if (!location || hop >= MAX_REDIRECTS) throw new DeliveryError(`Too many redirects (HTTP ${res.status})`, res.status, false);
      const next = new URL(location, url);
      await checkRedirect(next, lookup);
      url = next;
      continue;
    }
    const text = await readCapped(res, 300);
    const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
    throw new DeliveryError(`HTTP ${res.status}${text ? `: ${text}` : ''}`, res.status, retryable);
  }
}

async function readCapped(res: Response, max: number): Promise<string> {
  try {
    const text = await res.text();
    return text.replace(/\s+/g, ' ').trim().slice(0, max);
  } catch {
    return '';
  }
}
