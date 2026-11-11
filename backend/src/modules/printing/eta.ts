/**
 * Print time estimate that stays sensible while the K2 SE heats, homes and levels. During that phase the printer
 * reports `printLeftTime` 0 and then implausible values (e.g. 3 m 9 s for a 3 h 40 m job) until a few layers in.
 *
 * Phase:  heating (before the first print move, temps < target − 3 °C) → preparing (homing/leveling/purge: still
 *         inside the start G-code, or the calibration `withSelfTest` 1..99) → printing → finishing (end G-code).
 * Remaining:
 *   heating/preparing → slicer estimate + heat-up from the temperature gap + preparation allowance  (source slicer)
 *   printing          → printer `printLeftTime` once layer ≥ 2 and it agrees (×0.5..×2) with the position-based
 *                       value (source printer); else slicerSeconds × (1 − fraction) corrected by the observed
 *                       rate (elapsed printing time / slicer time for the part done)                   (source position)
 * Never 0 while the job is not finished.
 */
import { open } from 'node:fs/promises';
import { logger } from '../../logger.js';
import type { EtaHints } from '../../printers/drivers/types.js';
import { isActiveState } from '../../printers/k2se/protocol.js';
import type { PrinterManager } from '../../printers/manager.js';
import type { PrintEta, PrintEtaPhase, PrinterStatus } from '../../types.js';

/** K2 SE heating rates (°C/s), conservative: hotend ~2.5 °C/s, bed ~0.6 °C/s (25→60 °C in about a minute). */
export const NOZZLE_RATE = 2.5;
export const BED_RATE = 0.6;
/** Homing + purge after heating; with the pre-print calibration (auto-leveling) it is much longer. */
export const PREP_SEC = 45;
export const CALIBRATION_SEC = 180;
const HEAT_MARGIN = 3;
const FINISHING_SEC = 15;

export interface EtaInput {
  status: Pick<
    PrinterStatus,
    'state' | 'nozzleTemp' | 'nozzleTarget' | 'bedTemp' | 'bedTarget' | 'layer' | 'totalLayers' | 'progress' | 'elapsedSec' | 'remainingSec'
  > & { job: { filePosition: number | null; fileSize: number | null } | null; fileName?: string | null };
  hints: EtaHints;
  /** Slicer estimate of the whole print (seconds), null when unknown. */
  slicerSeconds: number | null;
  /** `elapsedSec` when the printing phase began (null until then). */
  printingSinceElapsed: number | null;
  /** The job asked for the pre-print calibration (PrintYard jobs only). */
  calibrate?: boolean;
  now: number;
}

export function heatUpSeconds(s: EtaInput['status']): number {
  const gap = (cur: number | null, target: number | null) => (cur !== null && target !== null && target > 0 ? Math.max(0, target - cur) : 0);
  return Math.max(gap(s.nozzleTemp, s.nozzleTarget) / NOZZLE_RATE, gap(s.bedTemp, s.bedTarget) / BED_RATE);
}

export function etaPhase(i: EtaInput): PrintEtaPhase | null {
  const s = i.status;
  if (!isActiveState(s.state)) return null;
  // No job at all (no file from the printer nor from Moonraker): nothing to estimate.
  if (!s.job && !s.fileName) return null;
  // Post-completion leftovers the firmware may still report as "running": progress 100, no layers, nothing left.
  if ((s.progress ?? 0) >= 100 && !s.totalLayers && !s.layer && !(s.remainingSec && s.remainingSec > 0)) return null;
  if (s.state === 'stopping') return 'finishing';
  const fp = s.job?.filePosition ?? null;
  const size = s.job?.fileSize ?? null;
  const { startByte, endByte, selfTest } = i.hints;
  if (fp !== null && endByte !== null && fp >= endByte) return 'finishing';
  if ((s.progress ?? 0) >= 100) return 'finishing';
  const preStart =
    fp !== null && startByte !== null
      ? fp < startByte
      : (s.layer ?? 0) < 1 && (s.progress ?? 0) === 0 && (fp === null || size === null || fp / size < 0.005);
  const calibrating = selfTest !== null && selfTest > 0 && selfTest < 100;
  if (!preStart && !calibrating) return 'printing';
  const hot = (cur: number | null, target: number | null) => target === null || target <= 0 || cur === null || cur >= target - HEAT_MARGIN;
  if (!hot(s.nozzleTemp, s.nozzleTarget) || !hot(s.bedTemp, s.bedTarget)) return 'heating';
  return 'preparing';
}

/** Fraction of the print moves done, by file position (start/end G-code excluded when known), else progress. */
export function printedFraction(i: EtaInput): number | null {
  const s = i.status;
  const fp = s.job?.filePosition ?? null;
  const size = s.job?.fileSize ?? null;
  if (fp !== null && size !== null && size > 0) {
    const start = i.hints.startByte ?? 0;
    const end = i.hints.endByte ?? size;
    if (end > start) return clamp((fp - start) / (end - start), 0, 1);
  }
  return s.progress !== null ? clamp(s.progress / 100, 0, 1) : null;
}

export function computeEta(i: EtaInput): PrintEta | null {
  const phase = etaPhase(i);
  if (phase === null) return null;
  const s = i.status;
  const printerLeft = s.remainingSec !== null && s.remainingSec > 0 ? s.remainingSec : null;
  let remaining: number | null = null;
  let source: PrintEta['source'] = null;

  if (phase === 'heating' || phase === 'preparing') {
    const selfTest = i.hints.selfTest;
    const calibrating = selfTest !== null && selfTest > 0 && selfTest < 100;
    const prep = calibrating
      ? (CALIBRATION_SEC * (100 - selfTest)) / 100
      : phase === 'heating'
        ? i.calibrate
          ? CALIBRATION_SEC
          : PREP_SEC
        : PREP_SEC / 2;
    if (i.slicerSeconds !== null) {
      remaining = i.slicerSeconds + (phase === 'heating' ? heatUpSeconds(s) : 0) + prep;
      source = 'slicer';
    }
  } else if (phase === 'finishing') {
    remaining = Math.min(printerLeft ?? FINISHING_SEC, 120);
    source = printerLeft !== null ? 'printer' : 'position';
  } else {
    const f = printedFraction(i);
    const printingElapsed = i.printingSinceElapsed !== null && s.elapsedSec !== null ? Math.max(0, s.elapsedSec - i.printingSinceElapsed) : null;
    let positional: number | null = null;
    if (f !== null) {
      if (i.slicerSeconds !== null) {
        positional = i.slicerSeconds * (1 - f);
        // Correct by the observed pace once there is enough signal (slow/fast printer, speed factor changes).
        if (printingElapsed !== null && printingElapsed >= 120 && f >= 0.03) {
          positional *= clamp(printingElapsed / (i.slicerSeconds * f), 0.5, 2);
        }
      } else if (printingElapsed !== null && printingElapsed >= 120 && f >= 0.03) {
        positional = (printingElapsed * (1 - f)) / f;
      }
    }
    const layer = s.layer ?? 0;
    const plausible =
      printerLeft !== null && layer >= 2 && (positional === null || (printerLeft / Math.max(1, positional) >= 0.5 && printerLeft / Math.max(1, positional) <= 2));
    if (plausible) {
      remaining = printerLeft;
      source = 'printer';
    } else if (positional !== null) {
      remaining = positional;
      source = 'position';
    } else if (i.slicerSeconds !== null) {
      remaining = i.slicerSeconds;
      source = 'slicer';
    }
  }

  if (remaining !== null) remaining = Math.max(1, Math.round(remaining));
  const paused = s.state === 'paused' || s.state === 'pausing';
  return {
    phase,
    remainingSec: remaining,
    finishesAt: remaining !== null && !paused ? i.now + remaining * 1000 : null,
    source,
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------- slicer time sources

/** Creality Print names exports `<model>_<material>_3h40m37s.gcode`. */
export function secondsFromFileName(name: string | null | undefined): number | null {
  const m = /_(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?\.gcode$/i.exec(name ?? '');
  if (!m || !(m[1] || m[2] || m[3] || m[4])) return null;
  const s = Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
  return s > 0 ? s : null;
}

/** `1d 2h 3m 4s` → seconds. */
export function parseDuration(text: string): number | null {
  let s = 0;
  let any = false;
  for (const [, v, u] of text.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi)) {
    any = true;
    s += Number(v) * ({ d: 86400, h: 3600, m: 60, s: 1 } as Record<string, number>)[u!.toLowerCase()]!;
  }
  return any && s > 0 ? Math.round(s) : null;
}

export interface GcodeTiming {
  seconds: number | null;
  /** Byte offset of the first layer (print moves begin). */
  startByte: number | null;
  /** Byte offset where the end G-code begins. */
  endByte: number | null;
}

/** Slicer comments: Creality Print / Orca (`; estimated printing time (normal mode) = …`), Cura (`;TIME:`), PrusaSlicer. */
export function parseGcodeTiming(head: string, tail: string, tailOffset: number): GcodeTiming {
  const text = `${head}\n${tail}`;
  let seconds: number | null = null;
  const est = /estimated printing time[^=\n]*=\s*([^\n]+)/i.exec(text);
  if (est?.[1]) seconds = parseDuration(est[1]);
  if (seconds === null) {
    const cura = /^;(?:TIME|PRINT_TIME|print_time)\s*[:=]\s*(\d+)/m.exec(text);
    if (cura?.[1]) seconds = Number(cura[1]) || null;
  }
  if (seconds === null) {
    const total = /;\s*(?:total )?(?:print(?:ing)? )?time\s*[:=]\s*([\dhms\s]+)$/im.exec(text);
    if (total?.[1]) seconds = parseDuration(total[1]);
  }
  const first = /^;(?:LAYER_CHANGE|LAYER:\s*[01]\b)/m.exec(head);
  // head/tail are latin1-decoded: one char per byte, so string offsets are byte offsets.
  const startByte = first ? first.index : null;
  let endByte: number | null = null;
  const endRe = /^(?:; EXECUTABLE_BLOCK_END|END_PRINT|PRINT_END|;\s*end gcode|; filament end gcode)/gim;
  let m: RegExpExecArray | null;
  let lastIdx = -1;
  while ((m = endRe.exec(tail))) lastIdx = m.index;
  if (lastIdx >= 0) {
    // Prefer the first end marker after the last layer change in the tail.
    const lastLayer = tail.lastIndexOf(';LAYER_CHANGE');
    endRe.lastIndex = Math.max(0, lastLayer);
    const after = endRe.exec(tail);
    const idx = after ? after.index : lastIdx;
    endByte = tailOffset + idx;
  }
  return { seconds, startByte, endByte };
}

const HEAD = 1024 * 1024;
const TAIL = 256 * 1024;

export async function readGcodeTiming(path: string): Promise<GcodeTiming> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const headBuf = Buffer.alloc(Math.min(HEAD, size));
    await fh.read(headBuf, 0, headBuf.length, 0);
    const tailStart = Math.max(0, size - TAIL);
    const tailBuf = Buffer.alloc(size - tailStart);
    await fh.read(tailBuf, 0, tailBuf.length, tailStart);
    return parseGcodeTiming(headBuf.toString('latin1'), tailBuf.toString('latin1'), tailStart);
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------- service

export interface EtaDeps {
  manager: PrinterManager;
  /** Slicer seconds + calibration flag of the PrintYard job running on the printer (library G-code summary). */
  tracked: (printerId: number) => { slicerSeconds: number | null; calibrate: boolean } | null;
  /** Local path of the current job's G-code (library file or cached printer download). */
  gcodePath: (printerId: number) => Promise<string>;
  now?: () => number;
}

interface JobState {
  key: string;
  printingSinceElapsed: number | null;
  timing: GcodeTiming | null;
  parsing: boolean;
}

/** Adds `PrinterStatus.estimate` (manager extender). */
export class EtaService {
  private readonly jobs = new Map<number, JobState>();
  /** Latest background G-code parse (tests await it). */
  lastParse: Promise<unknown> | null = null;

  constructor(private readonly d: EtaDeps) {}

  attach(): void {
    this.d.manager.addExtender((s) => ({ estimate: this.estimate(s) }));
  }

  estimate(s: PrinterStatus): PrintEta | null {
    if (!s.online || !isActiveState(s.state)) {
      this.jobs.delete(s.printerId);
      return null;
    }
    const key = `${s.job?.fileName ?? s.fileName ?? ''}|${s.job?.fileSize ?? ''}`;
    let js = this.jobs.get(s.printerId);
    if (!js || js.key !== key) this.jobs.set(s.printerId, (js = { key, printingSinceElapsed: null, timing: null, parsing: false }));
    const driver = this.d.manager.hasDriver(s.printerId) ? this.d.manager.driver(s.printerId) : null;
    const raw = driver?.etaHints?.() ?? { startByte: null, endByte: null, estimatedSeconds: null, selfTest: null };
    const hints: EtaHints = {
      startByte: raw.startByte ?? js.timing?.startByte ?? null,
      endByte: raw.endByte ?? js.timing?.endByte ?? null,
      estimatedSeconds: raw.estimatedSeconds,
      selfTest: raw.selfTest,
    };
    const tracked = this.d.tracked(s.printerId);
    const slicerSeconds =
      positive(tracked?.slicerSeconds) ?? positive(hints.estimatedSeconds) ?? secondsFromFileName(s.job?.fileName ?? s.fileName) ?? positive(js.timing?.seconds);
    // Outside files without any estimate yet (or without start/end offsets): read the cached G-code once.
    // Only once Moonraker reported the job (same cache key as the live view, so the file is downloaded once).
    if (!js.timing && !js.parsing && s.job?.fileSize != null && (slicerSeconds === null || hints.startByte === null)) {
      this.parseInBackground(s.printerId, js);
    }
    const input: EtaInput = {
      status: s,
      hints,
      slicerSeconds,
      printingSinceElapsed: js.printingSinceElapsed,
      calibrate: tracked?.calibrate ?? false,
      now: this.d.now?.() ?? Date.now(),
    };
    if (js.printingSinceElapsed === null && etaPhase(input) === 'printing' && s.elapsedSec !== null) {
      js.printingSinceElapsed = s.elapsedSec;
      input.printingSinceElapsed = s.elapsedSec;
    }
    return computeEta(input);
  }

  private parseInBackground(printerId: number, js: JobState): void {
    js.parsing = true;
    this.lastParse = (async () => {
      try {
        js.timing = await readGcodeTiming(await this.d.gcodePath(printerId));
      } catch (err) {
        js.timing = { seconds: null, startByte: null, endByte: null };
        logger.printer.debug(`printer #${printerId}: G-code timing unavailable (${(err as Error).message})`);
      } finally {
        js.parsing = false;
      }
      if (this.jobs.get(printerId) === js) this.d.manager.republish(printerId);
    })();
  }
}

const positive = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
