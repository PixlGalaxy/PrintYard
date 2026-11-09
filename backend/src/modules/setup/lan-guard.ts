import { isIP } from 'node:net';
import type { RequestLike } from '../../lib/client-ip.js';
import { isPrivateIp, normalizeIp } from '../../lib/ip.js';

/**
 * Any of these means a proxy (Nginx Proxy Manager, Cloudflare Tunnel, ...) sits in front of us, so the
 * socket address is the proxy's LAN address and says nothing about the real visitor.
 */
export const PROXY_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'forwarded',
  'cf-connecting-ip',
  'cf-ray',
  'cf-visitor',
  'true-client-ip',
  'x-client-ip',
] as const;

const LAN_SUFFIXES = ['.local', '.lan', '.home.arpa'];

/** Extracts the hostname from a Host header ("example.com:3000", "[::1]:3000", "192.168.1.5"). Lower-cased. */
export function hostnameFromHostHeader(host: string | undefined): string | null {
  if (typeof host !== 'string') return null;
  const v = host.trim().toLowerCase();
  if (v === '') return null;
  if (v.startsWith('[')) {
    const m = /^\[([0-9a-f:.%a-z-]+)\](?::\d{1,5})?$/.exec(v);
    return m ? m[1]! : null;
  }
  const colonCount = (v.match(/:/g) ?? []).length;
  if (colonCount > 1) return isIP(v) === 6 ? v : null; // bare IPv6 without brackets (non-standard)
  const m = /^([^:]+)(?::\d{1,5})?$/.exec(v);
  if (!m) return null;
  return m[1]!.replace(/\.$/, '');
}

/** Host header check (rule 3): private/loopback IP literal, localhost, *.local/.lan/.home.arpa, or a single label. */
export function isLanHostHeader(host: string | undefined): boolean {
  const hostname = hostnameFromHostHeader(host);
  if (!hostname) return false;
  if (isIP(hostname) !== 0 || isIP(hostname.replace(/%.*$/, '')) !== 0) return isPrivateIp(hostname);
  if (!/^[a-z0-9.-]+$/.test(hostname) || hostname.startsWith('.') || hostname.includes('..')) return false;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (LAN_SUFFIXES.some((suffix) => hostname.endsWith(suffix) && hostname.length > suffix.length)) return true;
  // A dotted all-numeric name that is not a valid IP ("1.2.3", "999.1.1.1") is not a hostname we accept.
  return !hostname.includes('.') && !/^\d+$/.test(hostname);
}

/**
 * True only if the request certainly comes straight from the local network (contract §Setup = LAN only):
 * 1. the socket peer is private/loopback/link-local,
 * 2. no proxy/forwarding header is present at all,
 * 3. the Host header names a LAN address/hostname.
 * Setup is the moment the first admin is created, so anything uncertain is refused.
 */
export function isLanSetupRequest(req: RequestLike): boolean {
  const socketIp = normalizeIp(req.socket.remoteAddress);
  if (!socketIp || !isPrivateIp(socketIp)) return false;

  for (const name of PROXY_HEADERS) {
    if (req.headers[name] !== undefined) return false;
  }

  const host = req.headers.host;
  return isLanHostHeader(Array.isArray(host) ? host[0] : host);
}
