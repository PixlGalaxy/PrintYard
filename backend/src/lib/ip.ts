import { BlockList, isIP } from 'node:net';

/**
 * Reduces an address as sockets and proxies write it ("[::1]:443", "1.2.3.4:80",
 * "::ffff:10.0.0.2", "fe80::1%eth0", '"10.0.0.1"') to a bare IP. Returns null when it is not an IP.
 * IPv4-mapped IPv6 addresses become plain IPv4.
 */
export function normalizeIp(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  let v = raw.trim().replace(/^"(.*)"$/, '$1');
  if (v === '') return null;

  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(v);
  if (bracketed) v = bracketed[1]!;
  const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(v);
  if (v4WithPort) v = v4WithPort[1]!;
  v = v.replace(/%[\w.-]+$/, '');

  const family = isIP(v);
  if (family === 4) return v;
  if (family !== 6) return null;

  v = v.toLowerCase();
  const mappedDotted = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  if (mappedDotted && isIP(mappedDotted[1]!) === 4) return mappedDotted[1]!;
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1]!, 16);
    const lo = Number.parseInt(mappedHex[2]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return v;
}

export function ipFamily(ip: string): 'ipv4' | 'ipv6' | null {
  const f = isIP(ip);
  return f === 4 ? 'ipv4' : f === 6 ? 'ipv6' : null;
}

/** A BlockList that also accepts IPv4-mapped IPv6 input (normalised before checking). */
export class IpMatcher {
  private readonly list = new BlockList();
  private count = 0;

  /** Accepts "a.b.c.d", "a.b.c.d/n", IPv6 and IPv6/n. Returns false for invalid entries. */
  add(entry: string): boolean {
    const [addrRaw, prefixRaw, extra] = entry.trim().split('/');
    if (extra !== undefined) return false;
    const addr = normalizeIp(addrRaw);
    if (!addr) return false;
    const family = ipFamily(addr)!;
    const max = family === 'ipv4' ? 32 : 128;
    if (prefixRaw === undefined) {
      this.list.addAddress(addr, family);
    } else {
      if (!/^\d{1,3}$/.test(prefixRaw)) return false;
      const prefix = Number(prefixRaw);
      if (prefix > max) return false;
      this.list.addSubnet(addr, prefix, family);
    }
    this.count++;
    return true;
  }

  get size(): number {
    return this.count;
  }

  has(raw: string | null | undefined): boolean {
    const ip = normalizeIp(raw);
    if (!ip) return false;
    return this.list.check(ip, ipFamily(ip)!);
  }
}

export function isValidCidr(entry: string): boolean {
  return new IpMatcher().add(entry);
}

/** Private, loopback and link-local ranges (the contract's definition of "LAN"). */
export const PRIVATE_RANGES = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
] as const;

const privateMatcher = new IpMatcher();
for (const range of PRIVATE_RANGES) privateMatcher.add(range);

/** True for private/loopback/link-local IPv4/IPv6 (IPv4-mapped handled). Invalid input → false. */
export function isPrivateIp(raw: string | null | undefined): boolean {
  return privateMatcher.has(raw);
}

export function privateMatcherInstance(): IpMatcher {
  return privateMatcher;
}

/**
 * Everything an outbound request (admin-configured notification URLs) must never reach: private, loopback,
 * link-local, CGNAT, "this network", documentation/benchmark, multicast/reserved and the IPv6 forms that embed or
 * translate IPv4 (IPv4-compatible `::/96`, NAT64 `64:ff9b::/96`, 6to4, Teredo). Phase 3 review A #4.
 */
export const NON_PUBLIC_RANGES = [
  ...PRIVATE_RANGES,
  '0.0.0.0/8',
  '100.64.0.0/10',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::/96',
  '64:ff9b::/96',
  '64:ff9b:1::/48',
  '100::/64',
  '2001::/32',
  '2001:db8::/32',
  '2002::/16',
  'fec0::/10',
  'ff00::/8',
] as const;

const nonPublicMatcher = new IpMatcher();
for (const range of NON_PUBLIC_RANGES) nonPublicMatcher.add(range);

/** True only for a valid, globally routable unicast address (IPv4-mapped IPv6 handled). */
export function isPublicIp(raw: string | null | undefined): boolean {
  const ip = normalizeIp(raw);
  return ip !== null && !nonPublicMatcher.has(ip);
}

const rfc1918Matcher = new IpMatcher();
for (const range of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']) rfc1918Matcher.add(range);

/** RFC 1918 IPv4 only (never loopback, link-local/metadata or CGNAT). */
export function isRfc1918(raw: string | null | undefined): boolean {
  return rfc1918Matcher.has(raw);
}
