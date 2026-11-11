import { AppError } from '../errors.js';
import { resolveProbeHost } from '../lib/probe-host.js';
import { logger } from '../logger.js';
import { SIM_HOST, type PrintersService } from '../modules/printers/printers.service.js';
import { forPrinterSubscribers, TOPICS } from '../realtime/index.js';
import type { RealtimeHub } from '../realtime/hub.js';
import type { Printer, PrinterStatus } from '../types.js';
import { CrealityK2SEDriver } from './drivers/creality-k2se.js';
import type { PrinterDriver, PrinterEndpoint } from './drivers/types.js';
import { offlineStatus } from './k2se/protocol.js';
import { sharedSimulator } from './sim/simulator.js';

export type EndpointResolver = (host: string) => Promise<PrinterEndpoint | null>;
export type DriverFactory = (printer: Printer, resolveEndpoint: EndpointResolver) => PrinterDriver;

export interface PrinterManagerOptions {
  printers: PrintersService;
  hub: RealtimeHub;
  /** `PRINTYARD_SIM_PRINTER=1`: route EVERY printer to the simulator (never contacts real hardware). */
  simulateAll?: boolean;
  createDriver?: DriverFactory;
  resolveEndpoint?: EndpointResolver;
  discoverByMac?: (mac: string) => Promise<string | null>;
  /** How often offline dynamic-IP printers are re-resolved by MAC. */
  rediscoverEveryMs?: number;
}

/** Extra fields the printing module adds to every published status (current job, bed state). */
export type StatusDecorator = (printerId: number) => Partial<Pick<PrinterStatus, 'currentPrintId'>>;
/** Extra fields computed from the decorated status (job objects, last job). Applied in registration order. */
export type StatusExtender = (status: PrinterStatus, printer: Printer) => Partial<PrinterStatus>;
export type StatusListener = (status: PrinterStatus, prev: PrinterStatus | null) => void;

const SEEN_PERSIST_MS = 30_000;

/**
 * Keeps ONE live connection per configured printer and fans status out to browsers through the hub
 * (`printer.status` to subscribers). Persists last_seen_at, firmware, serial and MAC. Re-resolves a dynamic-IP
 * printer by MAC when it stays offline.
 */
export class PrinterManager {
  private readonly drivers = new Map<number, PrinterDriver>();
  private readonly last = new Map<number, PrinterStatus>();
  private readonly seenAt = new Map<number, number>();
  private readonly discoveredAt = new Map<number, number>();
  private readonly listeners = new Set<StatusListener>();
  private decorator: StatusDecorator = () => ({});
  private readonly extenders: StatusExtender[] = [];
  private unsubscribe: (() => void) | null = null;
  private rediscoverTimer: NodeJS.Timeout | null = null;
  private started = false;
  private readonly resolveEndpoint: EndpointResolver;

  constructor(private readonly o: PrinterManagerOptions) {
    this.resolveEndpoint = o.resolveEndpoint ?? defaultEndpointResolver(o.simulateAll ?? false);
  }

  get isStarted(): boolean {
    return this.started;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.o.simulateAll) logger.printer.warn('PRINTYARD_SIM_PRINTER=1: every printer is routed to the simulator');
    for (const p of this.o.printers.list()) this.add(p);
    this.unsubscribe = this.o.printers.onChange((c) => {
      if (c.kind === 'create') this.add(c.printer);
      else if (c.kind === 'delete') this.remove(c.printer.id);
      else {
        this.remove(c.printer.id);
        this.add(c.printer);
      }
    });
    this.rediscoverTimer = setInterval(() => void this.rediscover(), this.o.rediscoverEveryMs ?? 30_000);
    this.rediscoverTimer.unref();
  }

  stop(): void {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.rediscoverTimer) clearInterval(this.rediscoverTimer);
    this.rediscoverTimer = null;
    for (const id of [...this.drivers.keys()]) this.remove(id);
  }

  setDecorator(fn: StatusDecorator): void {
    this.decorator = fn;
  }

  addExtender(fn: StatusExtender): void {
    this.extenders.push(fn);
  }

  onStatus(cb: StatusListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  driver(printerId: number): PrinterDriver {
    const d = this.drivers.get(printerId);
    if (!d) throw new AppError(409, 'prints.printer_offline', 'The printer is offline');
    return d;
  }

  hasDriver(printerId: number): boolean {
    return this.drivers.has(printerId);
  }

  /** Current status with the bed state and current print (404 if the printer does not exist). */
  status(printerId: number): PrinterStatus {
    const printer = this.o.printers.get(printerId);
    const raw = this.drivers.get(printerId)?.getStatus() ?? offlineStatus(printerId);
    return this.decorate(raw, printer);
  }

  /** Re-publish (e.g. after the bed was cleared or a job changed). */
  republish(printerId: number): void {
    const printer = this.o.printers.find(printerId);
    if (!printer) return;
    const raw = this.drivers.get(printerId)?.getStatus() ?? offlineStatus(printerId);
    this.o.hub.publish(TOPICS.printerStatus, this.decorate(raw, printer), forPrinterSubscribers(printerId));
  }

  private decorate(s: PrinterStatus, printer: Printer): PrinterStatus {
    let out: PrinterStatus = {
      ...s,
      currentPrintId: null,
      ...this.decorator(s.printerId),
      bedClear: printer.bedClear,
      bedOccupiedSince: printer.bedOccupiedSince,
      lastPrintId: printer.lastPrintId,
    };
    for (const ext of this.extenders) {
      try {
        out = { ...out, ...ext(out, printer) };
      } catch (err) {
        logger.printer.error('status extender failed', err);
      }
    }
    return out;
  }

  private add(printer: Printer): void {
    if (this.drivers.has(printer.id)) return;
    const driver = this.o.createDriver
      ? this.o.createDriver(printer, this.resolveEndpoint)
      : new CrealityK2SEDriver({ printerId: printer.id, host: printer.host, resolveEndpoint: this.resolveEndpoint });
    driver.on('status', (s) => this.onDriverStatus(s));
    driver.on('identity', (ident) => {
      try {
        this.o.printers.setIdentity(printer.id, ident);
      } catch (err) {
        logger.printer.warn(`printer #${printer.id}: cannot persist identity`, err);
      }
    });
    this.drivers.set(printer.id, driver);
    driver.connect();
  }

  private remove(id: number): void {
    const d = this.drivers.get(id);
    if (!d) return;
    d.disconnect();
    this.drivers.delete(id);
    this.last.delete(id);
  }

  private onDriverStatus(raw: PrinterStatus): void {
    const id = raw.printerId;
    const printer = this.o.printers.find(id);
    if (!printer) return;
    if (raw.online) {
      const now = Date.now();
      if (now - (this.seenAt.get(id) ?? 0) >= SEEN_PERSIST_MS) {
        this.seenAt.set(id, now);
        this.o.printers.touchSeen(id, now);
      }
    }
    const prev = this.last.get(id) ?? null;
    this.last.set(id, raw);
    for (const l of this.listeners) {
      try {
        l(raw, prev);
      } catch (err) {
        logger.printer.error('status listener failed', err);
      }
    }
    // Listeners may have changed the bed state / current job: decorate after them.
    const fresh = this.o.printers.find(id) ?? printer;
    this.o.hub.publish(TOPICS.printerStatus, this.decorate(raw, fresh), forPrinterSubscribers(id));
  }

  /** Dynamic-IP printers that stay offline: sweep the LAN for their MAC (at most every 5 min per printer). */
  private async rediscover(): Promise<void> {
    if (this.o.simulateAll) return;
    const discover = this.o.discoverByMac ?? ((mac: string) => CrealityK2SEDriver.discoverByMac(mac));
    for (const [id, d] of this.drivers) {
      if (d.getStatus().online || d.failedAttempts < 3) continue;
      const p = this.o.printers.find(id);
      if (!p || p.staticIp || !p.mac || p.host.toLowerCase() === SIM_HOST) continue;
      const now = Date.now();
      if (now - (this.discoveredAt.get(id) ?? 0) < 5 * 60_000) continue;
      this.discoveredAt.set(id, now);
      try {
        const found = await discover(p.mac);
        if (found && found !== p.host && this.drivers.get(id) === d) {
          logger.printer.info(`printer #${id} (${p.mac}) moved ${p.host} → ${found}`);
          this.o.printers.setResolvedHost(id, found);
          d.setHost(found);
        }
      } catch (err) {
        if (!(err instanceof AppError && err.code === 'printers.discovery_busy')) {
          logger.printer.warn(`printer #${id}: MAC re-resolve failed`, err);
        }
      }
    }
  }

  /** Test helper: run one re-discovery pass now. */
  rediscoverNow(): Promise<void> {
    return this.rediscover();
  }
}

/**
 * Real printers: the private-host rule (RFC 1918 only, hostname resolved and pinned) is re-checked before every
 * connection. Host `sim`, or every host with `simulateAll`, goes to the in-process simulator on loopback.
 */
export function defaultEndpointResolver(simulateAll: boolean): EndpointResolver {
  const warned = new Set<string>();
  return async (host) => {
    if (simulateAll || host.toLowerCase() === SIM_HOST) {
      const { port } = await sharedSimulator();
      return { host: '127.0.0.1', wsPort: port, httpPort: port, moonrakerPort: port };
    }
    try {
      const ip = await resolveProbeHost(host);
      if (!ip) return null;
      return { host: ip, wsPort: 9999, httpPort: 80, moonrakerPort: 7125 };
    } catch (err) {
      if (!warned.has(host)) {
        warned.add(host);
        logger.printer.warn(`Refusing to connect to ${host}: ${(err as Error).message}`);
      }
      return null;
    }
  };
}
