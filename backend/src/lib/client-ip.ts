import type { IncomingHttpHeaders } from 'node:http';
import type { ExposureMode } from '../types.js';
import { IpMatcher, normalizeIp, privateMatcherInstance } from './ip.js';

/** The parts of a request IP resolution needs (an Express Request satisfies it). */
export interface RequestLike {
  headers: IncomingHttpHeaders;
  socket: { remoteAddress?: string | undefined; encrypted?: boolean };
}

export interface ExposureConfig {
  mode: ExposureMode;
  trustedProxies: readonly string[];
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name];
  if (Array.isArray(v)) return v.join(',');
  return v;
}

function forwardedForList(headers: IncomingHttpHeaders): string[] {
  const raw = headerValue(headers, 'x-forwarded-for');
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** Trusted-proxy matcher for every proxy mode: the configured CIDRs, or the private + loopback ranges when none are set. */
export function trustedProxyMatcher(trustedProxies: readonly string[]): IpMatcher {
  if (trustedProxies.length === 0) return privateMatcherInstance();
  const m = new IpMatcher();
  for (const entry of trustedProxies) m.add(entry);
  return m;
}

/** Whether the TCP peer is a proxy whose forwarding headers we may believe (never in mode "none"). */
export function isTrustedProxy(socketIp: string | null, exposure: ExposureConfig, matcher?: IpMatcher): boolean {
  if (!socketIp || exposure.mode === 'none') return false;
  return (matcher ?? trustedProxyMatcher(exposure.trustedProxies)).has(socketIp);
}

/** Forwarding headers that betray a reverse proxy / tunnel in front of us. */
export const FORWARDING_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'forwarded',
  'cf-connecting-ip',
  'true-client-ip',
  'x-client-ip',
] as const;

export function hasForwardingHeaders(headers: IncomingHttpHeaders): boolean {
  return FORWARDING_HEADERS.some((h) => headers[h] !== undefined);
}

/**
 * Resolves the real client IP according to `exposure.mode` (contract §Client IP resolution, hardened):
 * forwarding headers are only read when the socket address is in `exposure.trustedProxies`
 * (default: private + loopback ranges). Otherwise the socket address is the client.
 * - none: socket address, headers ignored.
 * - cloudflare: CF-Connecting-IP.
 * - nginx: right-most X-Forwarded-For entry (the one the trusted proxy appended), else X-Real-IP.
 * - other: walk X-Forwarded-For right-to-left skipping trusted proxies.
 * Header values that are not IPs are ignored. Returns '' only when the socket address is unknown.
 */
export function resolveClientIp(req: RequestLike, exposure: ExposureConfig, matcher?: IpMatcher): string {
  const socketIp = normalizeIp(req.socket.remoteAddress) ?? '';
  if (exposure.mode === 'none') return socketIp;
  const trusted = matcher ?? trustedProxyMatcher(exposure.trustedProxies);
  if (!trusted.has(socketIp)) return socketIp;

  switch (exposure.mode) {
    case 'cloudflare':
      return normalizeIp(headerValue(req.headers, 'cf-connecting-ip')) ?? socketIp;

    case 'nginx': {
      const xff = forwardedForList(req.headers);
      if (xff.length > 0) return normalizeIp(xff[xff.length - 1]) ?? socketIp;
      return normalizeIp(headerValue(req.headers, 'x-real-ip')) ?? socketIp;
    }

    case 'other': {
      let candidate = socketIp;
      const xff = forwardedForList(req.headers);
      for (let i = xff.length - 1; i >= 0; i--) {
        const ip = normalizeIp(xff[i]);
        if (!ip) break; // garbage: stop at the last hop we could verify
        candidate = ip;
        if (!trusted.has(ip)) break;
      }
      return candidate;
    }
  }
}

/** HTTPS when TLS terminates here, or a trusted proxy says `X-Forwarded-Proto: https`. */
export function isHttpsRequest(req: RequestLike, exposure: ExposureConfig, matcher?: IpMatcher): boolean {
  if (req.socket.encrypted) return true;
  const socketIp = normalizeIp(req.socket.remoteAddress);
  if (!isTrustedProxy(socketIp, exposure, matcher)) return false;
  const proto = headerValue(req.headers, 'x-forwarded-proto');
  return proto?.split(',')[0]?.trim().toLowerCase() === 'https';
}
