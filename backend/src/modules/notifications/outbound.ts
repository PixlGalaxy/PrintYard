import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { isIP } from 'node:net';
import { isPublicIp, isRfc1918, normalizeIp } from '../../lib/ip.js';

export type FetchFn = typeof fetch;
export type LookupFn = (host: string) => Promise<string[]>;

export const OUTBOUND_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 3;
/** Headers that carry a secret and never follow a redirect to another origin (review 3A #5). */
const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-slicedock-signature']);
/** Hosts whose error bodies are short API errors, worth a line in the server log (never returned to clients). */
const API_HOSTS = /^(?:(?:ptb|canary)\.)?discord(?:app)?\.com$|^api\.telegram\.org$/i;

const defaultLookup: LookupFn = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Thrown for every failed delivery; `message` never contains the URL (it may carry a token) nor a response body. */
export class DeliveryError extends Error {
  constructor(
    message: string,
    /** HTTP status, when the remote answered. */
    readonly status: number | null = null,
    /** false = retrying cannot help (4xx except 408/429, bad configuration). */
    readonly retryable = true,
    /** Server-log only: a short API error body from a known API host (Discord/Telegram). */
    readonly detail: string | null = null,
  ) {
    super(message);
  }
}

export interface OutboundRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
  /**
   * ntfy "self-hosted on my LAN": the destination may be an RFC 1918 address (http or https). Loopback, link-local
   * (cloud metadata), CGNAT and every other reserved range stay refused. Without it only public addresses are allowed.
   */
  allowHttpPrivate?: boolean;
}

export interface OutboundDeps {
  /** Tests: replaces the pinned transport (no DNS pinning then). */
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
    return (await lookup(bare)).map((a) => normalizeIp(a) ?? a);
  } catch {
    throw new DeliveryError('Host name does not resolve');
  }
}

/**
 * Checks one hop (the first one and every redirect) and returns the address to connect to. https only, except a
 * local ntfy server; every resolved address must be public (or RFC 1918 for a local ntfy server).
 */
async function vetHop(url: URL, req: OutboundRequest, lookup: LookupFn, redirect: boolean): Promise<string> {
  if (url.username || url.password) throw new DeliveryError(redirect ? 'Redirect with credentials refused' : 'URLs with credentials are not allowed', null, false);
  const local = req.allowHttpPrivate === true;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new DeliveryError(redirect ? 'Redirect to a non-https URL refused' : local ? 'Only http(s) destinations are allowed' : 'Only https destinations are allowed', null, false);
  }
  const addrs = await addressesOf(url.hostname, lookup);
  const ok = (a: string) => isPublicIp(a) || (local && isRfc1918(a));
  if (addrs.length === 0 || !addrs.every(ok)) {
    throw new DeliveryError(
      local ? 'Destination must be a public address or a private (192.168.x / 10.x / 172.16-31.x) LAN address' : 'Destination is a private or reserved address',
      null,
      false,
    );
  }
  // Plain http only inside the LAN, never to the internet.
  if (url.protocol === 'http:' && !addrs.every(isRfc1918)) {
    throw new DeliveryError('Plain http is only allowed for servers on a private network', null, false);
  }
  return addrs[0]!;
}

interface HopResult {
  status: number;
  location: string | null;
  /** Reads at most `max` characters of the body (and discards the rest). */
  text: (max: number) => Promise<string>;
  discard: () => void;
}

/** Real transport: node:http(s) connecting to the vetted address (DNS pinned: no rebinding between check and use). */
function pinnedRequest(url: URL, address: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<HopResult> {
  const family = isIP(address) === 6 ? 6 : 4;
  const lookup: LookupFunction = (_host, opts, cb) => {
    if ((opts as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address, family }]);
    else cb(null, address, family);
  };
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<HopResult>((resolve, reject) => {
    const r = send(
      url,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
        lookup,
        timeout: timeoutMs,
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res: IncomingMessage) => {
        const loc = res.headers.location;
        resolve({
          status: res.statusCode ?? 0,
          location: typeof loc === 'string' ? loc : null,
          discard: () => res.resume(),
          text: (max) =>
            new Promise<string>((done) => {
              let out = '';
              res.setEncoding('utf8');
              res.on('data', (c: string) => {
                if (out.length < max) out += c;
                if (out.length >= max) res.destroy();
              });
              res.on('end', () => done(out.slice(0, max)));
              res.on('close', () => done(out.slice(0, max)));
              res.on('error', () => done(out.slice(0, max)));
            }),
        });
      },
    );
    r.on('timeout', () => r.destroy(Object.assign(new Error('Timed out'), { name: 'TimeoutError' })));
    r.on('error', reject);
    r.end(body);
  });
}

/** Test transport: a `fetch` stub. */
async function fetchRequest(fetchImpl: FetchFn, url: URL, headers: Record<string, string>, body: string, timeoutMs: number): Promise<HopResult> {
  const res = await fetchImpl(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  return {
    status: res.status,
    location: res.headers.get('location'),
    discard: () => void res.body?.cancel().catch(() => undefined),
    text: async (max) => {
      try {
        return (await res.text()).slice(0, max);
      } catch {
        return '';
      }
    },
  };
}

/**
 * POSTs with a timeout and manual redirect handling (at most 3, each hop re-vetted). Resolves on 2xx; throws a
 * DeliveryError otherwise. Response bodies never reach the error message (no read primitive into the LAN).
 */
export async function postOutbound(req: OutboundRequest, deps: OutboundDeps = {}): Promise<number> {
  const lookup = deps.lookup ?? defaultLookup;
  const timeoutMs = deps.timeoutMs ?? OUTBOUND_TIMEOUT_MS;
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    throw new DeliveryError('Invalid URL', null, false);
  }
  let headers = { ...req.headers };
  let address = await vetHop(url, req, lookup, false);

  for (let hop = 0; ; hop++) {
    let res: HopResult;
    try {
      res = deps.fetchImpl ? await fetchRequest(deps.fetchImpl, url, headers, req.body, timeoutMs) : await pinnedRequest(url, address, headers, req.body, timeoutMs);
    } catch (err) {
      const name = (err as Error).name;
      throw new DeliveryError(name === 'TimeoutError' || name === 'AbortError' ? 'Timed out' : 'Network error');
    }
    if (res.status >= 200 && res.status < 300) {
      res.discard();
      return res.status;
    }
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      res.discard();
      if (!res.location || hop >= MAX_REDIRECTS) throw new DeliveryError(`Too many redirects (HTTP ${res.status})`, res.status, false);
      let next: URL;
      try {
        next = new URL(res.location, url);
      } catch {
        throw new DeliveryError(`Invalid redirect (HTTP ${res.status})`, res.status, false);
      }
      address = await vetHop(next, req, lookup, true);
      // Another origin never gets the token / signature (browsers and undici do the same for Authorization).
      if (next.origin !== url.origin) headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !SECRET_HEADERS.has(k.toLowerCase())));
      url = next;
      continue;
    }
    const detail = API_HOSTS.test(url.hostname) ? (await res.text(300)).replace(/\s+/g, ' ').trim() || null : (res.discard(), null);
    const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
    throw new DeliveryError(`HTTP ${res.status}`, res.status, retryable, detail);
  }
}
