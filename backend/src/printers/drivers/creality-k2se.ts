import { AppError } from '../../errors.js';
import { createExclusive } from '../../lib/exclusive.js';
import { lanSubnets24 } from '../../lib/network.js';
import { invalidProbeHost, isProbeableIp } from '../../lib/probe-host.js';
import { logger } from '../../logger.js';
import type { PrinterModelInfo, ProbeResult } from '../../types.js';
import { formatHostForUrl, getJson, isRecord, normalizeMac } from './http.js';
import { K2SELiveDriver } from '../k2se/live-driver.js';
import type { PrinterDriver, ProbeOptions } from './types.js';

const PROBE_TIMEOUT_MS = 3000;
const DISCOVERY_TIMEOUT_MS = 800;
const DISCOVERY_CONCURRENCY = 32;
const MOONRAKER_PORT = 7125;

/** One LAN sweep at a time, server-wide (each sweep is 254 × N GETs). */
const discoveryLock = createExclusive(
  () =>
    new AppError(429, 'printers.discovery_busy', 'A printer search is already running, try again shortly', undefined, {
      'Retry-After': '15',
    }),
);

/** Creality board codes reported by `/info` → model name. */
const MODEL_CODES: Record<string, string> = {
  F016: 'Creality K2 SE',
  F021: 'Creality K2',
  F012: 'Creality K2 Pro',
  F008: 'Creality K2 Plus',
};

interface CrealityInfo {
  model: string;
  mac: string | null;
}

function parseCrealityInfo(body: unknown): CrealityInfo | null {
  if (!isRecord(body) || typeof body.model !== 'string' || body.mac === undefined) return null;
  return { model: body.model, mac: normalizeMac(body.mac) };
}

/** Every MAC in Moonraker's `result.system_info.network.*.mac_address` (ip_addresses there can be stale: ignored). */
export function macsFromSystemInfo(body: unknown): string[] {
  if (!isRecord(body) || !isRecord(body.result) || !isRecord(body.result.system_info)) return [];
  const network = body.result.system_info.network;
  if (!isRecord(network)) return [];
  const out: string[] = [];
  for (const iface of Object.values(network)) {
    if (!isRecord(iface)) continue;
    const mac = normalizeMac(iface.mac_address);
    if (mac && mac !== '00:00:00:00:00:00') out.push(mac);
  }
  return out;
}

function parsePrinterInfo(body: unknown): { hostname?: string; softwareVersion?: string } | null {
  if (!isRecord(body) || !isRecord(body.result)) return null;
  const r = body.result;
  return {
    ...(typeof r.hostname === 'string' && { hostname: r.hostname }),
    ...(typeof r.software_version === 'string' && { softwareVersion: r.software_version }),
  };
}

/**
 * Creality K2 SE (board F016, K1C-family firmware).
 * - static `probe`/`discoverByMac`: identification and LAN discovery (HTTP GETs only);
 * - instances: the live connection and control (WS :9999 + HTTP upload), implemented in `K2SELiveDriver`.
 */
export class CrealityK2SEDriver extends K2SELiveDriver implements PrinterDriver {
  static readonly info: PrinterModelInfo = {
    id: 'creality-k2se',
    name: 'Creality K2 SE',
    vendor: 'Creality',
    bed: { x: 220, y: 215, z: 245 },
  };

  /** Identify whatever answers at `host`. With staticIp=false and a MAC, falls back to a LAN sweep. */
  static async probe(host: string, opts: ProbeOptions = { staticIp: true }): Promise<ProbeResult> {
    // Callers pass an already resolved address (see resolveProbeHost); refuse anything outside RFC 1918 regardless.
    if (!isProbeableIp(host)) throw invalidProbeHost();
    const result = await CrealityK2SEDriver.probeHost(host);
    const wantedMac = normalizeMac(opts.mac ?? null);
    const needsDiscovery = !opts.staticIp && wantedMac !== null && (!result.ok || (result.mac && result.mac !== wantedMac));
    if (!needsDiscovery) return result;

    logger.printer.info(`Printer not found at ${host}; searching the LAN for ${wantedMac}`);
    const found = await CrealityK2SEDriver.discoverByMac(wantedMac);
    if (!found) {
      return result.ok ? { ok: false, error: 'printers.mac_mismatch', ...pickIdentity(result) } : { ok: false, error: 'printers.not_found' };
    }
    const again = await CrealityK2SEDriver.probeHost(found);
    return { ...again, resolvedHost: found };
  }

  private static async probeHost(host: string): Promise<ProbeResult> {
    const base = `http://${formatHostForUrl(host)}`;
    const moon = `${base}:${MOONRAKER_PORT}`;
    const [infoBody, sysBody, printerBody] = await Promise.all([
      getJson(`${base}/info`, PROBE_TIMEOUT_MS),
      getJson(`${moon}/machine/system_info`, PROBE_TIMEOUT_MS),
      getJson(`${moon}/printer/info`, PROBE_TIMEOUT_MS),
    ]);

    const info = parseCrealityInfo(infoBody);
    const macs = macsFromSystemInfo(sysBody);
    const printerInfo = parsePrinterInfo(printerBody);
    const moonraker = macs.length > 0 || printerInfo !== null;
    const creality = info !== null;

    if (!creality && !moonraker) {
      const answered = infoBody !== null || sysBody !== null || printerBody !== null;
      return { ok: false, error: answered ? 'printers.unrecognized' : 'printers.unreachable', creality: false, moonraker: false };
    }

    const mac = info?.mac ?? macs[0];
    const modelName = info ? (MODEL_CODES[info.model] ? `${MODEL_CODES[info.model]} (${info.model})` : info.model) : undefined;
    return {
      ok: true,
      ...(modelName && { model: modelName }),
      ...(mac && { mac }),
      ...(printerInfo?.hostname && { hostname: printerInfo.hostname }),
      // The Creality firmware version (e.g. 2.3.6.57) is only exposed over the :9999 WebSocket (Phase 2 driver).
      moonraker,
      creality,
    };
  }

  /**
   * Sweeps the /24 of each LAN interface on :7125 (concurrency 32, 800 ms timeout) and returns the host whose
   * Moonraker `system_info` lists `mac`. Needs `--network host` (or a LAN-routable network) inside Docker.
   */
  static async discoverByMac(rawMac: string): Promise<string | null> {
    const mac = normalizeMac(rawMac);
    if (!mac) return null;
    return discoveryLock(() => CrealityK2SEDriver.sweep(mac));
  }

  private static async sweep(mac: string): Promise<string | null> {
    const candidates: string[] = [];
    for (const { prefix, self } of lanSubnets24()) {
      for (let i = 1; i <= 254; i++) {
        const ip = `${prefix}.${i}`;
        if (ip !== self && isProbeableIp(ip)) candidates.push(ip);
      }
    }
    if (candidates.length === 0) return null;

    let found: string | null = null;
    let next = 0;
    const worker = async () => {
      while (found === null && next < candidates.length) {
        const ip = candidates[next++]!;
        const body = await getJson(`http://${ip}:${MOONRAKER_PORT}/machine/system_info`, DISCOVERY_TIMEOUT_MS);
        if (found === null && macsFromSystemInfo(body).includes(mac)) found = ip;
      }
    };
    await Promise.all(Array.from({ length: Math.min(DISCOVERY_CONCURRENCY, candidates.length) }, worker));
    if (found) logger.printer.info(`Found ${mac} at ${found}`);
    return found;
  }
}

function pickIdentity(r: ProbeResult): Partial<ProbeResult> {
  return {
    ...(r.model && { model: r.model }),
    ...(r.mac && { mac: r.mac }),
    ...(r.hostname && { hostname: r.hostname }),
    ...(r.moonraker !== undefined && { moonraker: r.moonraker }),
    ...(r.creality !== undefined && { creality: r.creality }),
  };
}
