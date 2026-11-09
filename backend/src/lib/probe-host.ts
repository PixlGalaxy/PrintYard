import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AppError } from '../errors.js';
import { IpMatcher, normalizeIp } from './ip.js';

/** The only ranges the server will probe or sweep: RFC 1918 IPv4 (no loopback, link-local, multicast or public). */
const PROBE_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'] as const;
const probeMatcher = new IpMatcher();
for (const r of PROBE_RANGES) probeMatcher.add(r);

export function isProbeableIp(raw: string | null | undefined): boolean {
  const ip = normalizeIp(raw);
  return ip !== null && isIP(ip) === 4 && probeMatcher.has(ip);
}

export const invalidProbeHost = () =>
  new AppError(400, 'printers.invalid_host', 'Only private LAN addresses (10/8, 172.16/12, 192.168/16) can be probed');

export type LookupFn = (host: string) => Promise<string[]>;

const defaultLookup: LookupFn = async (host) =>
  (await dnsLookup(host, { all: true, family: 4 })).map((a) => a.address);

/**
 * Turns a probe target (IP literal or hostname) into the private IPv4 address the probe will actually contact.
 * Hostnames are resolved once and every IPv4 answer must be private; the probe then uses that IP, so a DNS
 * rebinding between check and fetch cannot redirect it. Throws `printers.invalid_host` for anything else.
 * Returns null when a hostname does not resolve (the caller reports it as unreachable).
 */
export async function resolveProbeHost(host: string, lookup: LookupFn = defaultLookup): Promise<string | null> {
  const literal = normalizeIp(host);
  if (literal !== null) {
    if (!isProbeableIp(literal)) throw invalidProbeHost();
    return literal;
  }
  if (/^localhost$/i.test(host) || /\.localhost\.?$/i.test(host)) throw invalidProbeHost();
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    return null;
  }
  if (addresses.length === 0) return null;
  if (!addresses.every(isProbeableIp)) throw invalidProbeHost();
  return normalizeIp(addresses[0])!;
}
