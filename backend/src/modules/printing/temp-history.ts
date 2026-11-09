import type { PrinterManager } from '../../printers/manager.js';
import type { PrinterStatus, TempSample } from '../../types.js';
import type { PrintersService } from '../printers/printers.service.js';

/** Sample period and retention of the per-printer temperature history (Printer tab → Temperatures chart). */
export const TEMP_HISTORY = { intervalMs: 2000, keepMinutes: 60 } as const;

/** Fixed-size ring buffer of temperature samples (oldest overwritten first). */
export class TempRing {
  private readonly buf: (TempSample | undefined)[];
  private start = 0;
  private size = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('capacity must be a positive integer');
    this.buf = new Array<TempSample | undefined>(capacity);
  }

  get length(): number {
    return this.size;
  }

  push(s: TempSample): void {
    if (this.size < this.capacity) {
      this.buf[(this.start + this.size) % this.capacity] = s;
      this.size++;
    } else {
      this.buf[this.start] = s;
      this.start = (this.start + 1) % this.capacity;
    }
  }

  /** Samples with `t >= since`, oldest first. */
  since(since: number): TempSample[] {
    const out: TempSample[] = [];
    for (let i = 0; i < this.size; i++) {
      const s = this.buf[(this.start + i) % this.capacity]!;
      if (s.t >= since) out.push(s);
    }
    return out;
  }

  last(): TempSample | null {
    return this.size ? this.buf[(this.start + this.size - 1) % this.capacity]! : null;
  }
}

export interface TempHistoryDeps {
  manager: PrinterManager;
  printers: PrintersService;
  now?: () => number;
  intervalMs?: number;
  keepMinutes?: number;
}

/** Samples every printer's nozzle/bed (actual + target) every 2 s while it is online; keeps the last 60 min in memory. */
export class TempHistoryService {
  private readonly rings = new Map<number, TempRing>();
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly capacity: number;

  constructor(private readonly d: TempHistoryDeps) {
    this.intervalMs = d.intervalMs ?? TEMP_HISTORY.intervalMs;
    this.capacity = Math.ceil(((d.keepMinutes ?? TEMP_HISTORY.keepMinutes) * 60_000) / this.intervalMs);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sampleAll(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One tick: a sample per online printer (drivers' raw status, no decoration). Printers that were deleted are dropped. */
  sampleAll(): void {
    const ids = new Set<number>();
    for (const p of this.d.printers.list()) {
      ids.add(p.id);
      if (!this.d.manager.hasDriver(p.id)) continue;
      this.record(this.d.manager.driver(p.id).getStatus());
    }
    for (const id of this.rings.keys()) if (!ids.has(id)) this.rings.delete(id);
  }

  record(s: PrinterStatus): void {
    if (!s.online) return;
    let ring = this.rings.get(s.printerId);
    if (!ring) this.rings.set(s.printerId, (ring = new TempRing(this.capacity)));
    ring.push({ t: (this.d.now ?? Date.now)(), nozzle: s.nozzleTemp, nozzleTarget: s.nozzleTarget, bed: s.bedTemp, bedTarget: s.bedTarget });
  }

  /** The last `minutes` (1-60) of samples, oldest first. */
  history(printerId: number, minutes: number): TempSample[] {
    const m = Math.max(1, Math.min(TEMP_HISTORY.keepMinutes, minutes));
    return this.rings.get(printerId)?.since((this.d.now ?? Date.now)() - m * 60_000) ?? [];
  }
}
