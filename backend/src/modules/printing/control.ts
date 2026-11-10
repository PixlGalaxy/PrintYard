import { z } from 'zod';
import type { SettingsService } from '../../db/settings.js';
import { AppError, forbidden } from '../../errors.js';
import { logger } from '../../logger.js';
import { CrealityK2SEDriver } from '../../printers/drivers/creality-k2se.js';
import type { ControlTelemetry } from '../../printers/drivers/types.js';
import { isActiveState } from '../../printers/k2se/protocol.js';
import { OBJECT_NAME_RE } from '../../printers/k2se/moonraker.js';
import type { PrinterManager } from '../../printers/manager.js';
import { assertWritable, isReadOnly } from '../../printers/read-only.js';
import type { PrinterControlCommand, PrinterStatus } from '../../types.js';
import type { AuditService } from '../audit/audit.service.js';
import type { PrintersService } from '../printers/printers.service.js';
import type { UsersService } from '../users/users.service.js';
import type { Actor } from './types.js';

// ---------------------------------------------------------------- bounds

export const CONTROL_LIMITS = {
  /** mm, per jog. */
  maxJog: 50,
  /** mm/min caps (K2 SE: 800 mm/s XY, 30 mm/s Z machine maxima; manual moves stay well below). */
  maxFeedXY: 12_000,
  maxFeedZ: 900,
  /** mm per extrude/retract. */
  maxExtrude: 50,
  /** mm/s for extrude/retract. */
  maxExtrudeSpeed: 10,
  /** °C: below this the nozzle refuses to extrude (Klipper `min_extrude_temp` is 170 too). */
  minExtrudeTemp: 170,
  /** % bounds of `M220` (speed/feedrate factor) and `M221` (flow/extrusion factor). */
  speedFactor: { min: 10, max: 300 },
  flowFactor: { min: 50, max: 150 },
  /** Actions per user and printer in `rateWindowMs`. */
  rateMax: 20,
  rateWindowMs: 10_000,
  /** Smallest meaningful jog (mm) / extrusion (mm), slowest extrusion (mm/s) and feedrate (mm/min). */
  minJog: 0.01,
  minExtrude: 0.01,
  minExtrudeSpeed: 0.1,
  minFeed: 60,
  /** Motion state older than this is re-read before a jog/home/extrude; unconfirmable → `printers.state_stale`. */
  staleMs: 3000,
  /** After a home / motors off: the reported homing state must be at least this much newer than the command. */
  settleMs: 800,
  /** Minimum gap between two motion commands on one printer. */
  motionGapMs: 250,
  /** Refused attempts audited per user and printer per minute. */
  refusedAuditPerMinute: 5,
} as const;

/** The only shape the API accepts (never raw G-code). */
export const controlSchema: z.ZodType<PrinterControlCommand> = z.discriminatedUnion('action', [
  z.object({ action: z.literal('home'), axes: z.enum(['all', 'xy', 'x', 'y', 'z']) }).strict(),
  z
    .object({
      action: z.literal('jog'),
      axis: z.enum(['x', 'y', 'z']),
      distance: z.number().finite().refine((v) => Math.abs(v) >= CONTROL_LIMITS.minJog && Math.abs(v) <= CONTROL_LIMITS.maxJog, 'distance'),
      feedrate: z.number().finite().min(CONTROL_LIMITS.minFeed),
    })
    .strict(),
  z
    .object({
      action: z.literal('extrude'),
      length: z.number().finite().refine((v) => Math.abs(v) >= CONTROL_LIMITS.minExtrude && Math.abs(v) <= CONTROL_LIMITS.maxExtrude, 'length'),
      speed: z.number().finite().min(CONTROL_LIMITS.minExtrudeSpeed).max(CONTROL_LIMITS.maxExtrudeSpeed),
    })
    .strict(),
  z.object({ action: z.literal('temp'), heater: z.enum(['nozzle', 'bed']), target: z.number().int().min(0).max(400) }).strict(),
  z.object({ action: z.literal('fan'), percent: z.number().int().min(0).max(100) }).strict(),
  z.object({ action: z.literal('motors_off') }).strict(),
  z.object({ action: z.literal('light'), on: z.boolean() }).strict(),
  z
    .object({ action: z.literal('speed_factor'), percent: z.number().int().min(CONTROL_LIMITS.speedFactor.min).max(CONTROL_LIMITS.speedFactor.max) })
    .strict(),
  z
    .object({ action: z.literal('flow_factor'), percent: z.number().int().min(CONTROL_LIMITS.flowFactor.min).max(CONTROL_LIMITS.flowFactor.max) })
    .strict(),
]) as z.ZodType<PrinterControlCommand>;

export const excludeSchema = z.object({ name: z.string().regex(OBJECT_NAME_RE) }).strict();

/** What the builder needs to know about the printer right now. */
export interface ControlContext {
  state: PrinterStatus['state'];
  homedAxes: string | null;
  position: [number, number, number] | null;
  nozzleTemp: number | null;
  maxNozzleTemp: number;
  maxBedTemp: number;
  bed: { x: number; y: number; z: number };
  /** False while the last print may still be on the bed: no homing, jogging or extruding (default true). */
  bedClear?: boolean;
}

const refuse = (code: string, message: string, details?: Record<string, unknown>) => new AppError(409, code, message, details);
const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

/**
 * Turns a typed command into the G-code SliceDock sends. Pure (unit-tested): every bound and refusal lives here.
 * The light is not G-code (Creality WS `lightSw`): see `PrinterControlService.control`.
 * - while a job is active only the "tuning" actions are accepted (fan, temperatures, speed/flow factor);
 *   motion, extrusion and motors off are refused (`printers.control_busy`);
 * - while the bed may hold the last print, home/jog/extrude are refused (`printers.bed_not_cleared`);
 * - jogs need the axis homed (`printers.not_homed`) and must stay inside the build volume (`printers.out_of_range`).
 *   `ctx.position` is the position SliceDock *expects* (see `PrinterControlService`), and the jog is sent as ONE
 *   absolute move `G90\nG1 <axis><target> F<feed>`: the printer never leaves absolute mode, even when Klipper refuses
 *   the move (the old `G91 / G1 / G90` script left G91 on after an aborted G1);
 * - extrusion needs the nozzle at ≥ 170 °C (`printers.nozzle_cold`) and is sent as `G92 E0\nG1 E<len> F<f>\nG92 E0`:
 *   no M82/M83 mode change at all (from E=0 the move is `len` mm in both absolute and relative extrusion mode);
 * - targets are bounded by the printer/profile maxima (`printers.temp_out_of_range`).
 */
export type GcodeControlCommand = Exclude<PrinterControlCommand, { action: 'light' }>;

/** Actions allowed while a job is active (typical live tuning). The light is allowed too (not G-code). */
export const TUNING_ACTIONS: ReadonlySet<PrinterControlCommand['action']> = new Set(['fan', 'temp', 'speed_factor', 'flow_factor', 'light']);
/** Tuning that affects a running job: only its owner or an admin while printing/paused/uploading. */
export const JOB_TUNING_ACTIONS: ReadonlySet<PrinterControlCommand['action']> = new Set(['fan', 'temp', 'speed_factor', 'flow_factor']);
/** Actions that move the toolhead/extruder (need a clear bed and fresh motion state). */
export const MOTION_ACTIONS: ReadonlySet<PrinterControlCommand['action']> = new Set(['home', 'jog', 'extrude']);

const axisIndex = (a: 'x' | 'y' | 'z') => (a === 'x' ? 0 : a === 'y' ? 1 : 2);
/** Absolute target of a jog (the builder validated it). */
export function jogTarget(c: Extract<PrinterControlCommand, { action: 'jog' }>, position: [number, number, number]): number {
  return Math.round((position[axisIndex(c.axis)] + c.distance) * 1000) / 1000;
}

export function buildControlGcode(c: GcodeControlCommand, ctx: ControlContext): string {
  if (isActiveState(ctx.state) && !TUNING_ACTIONS.has(c.action)) {
    throw refuse('printers.control_busy', 'Only the fan, light, temperatures, speed and flow can be changed while a print is running');
  }
  if (MOTION_ACTIONS.has(c.action) && ctx.bedClear === false) {
    throw refuse('printers.bed_not_cleared', 'Remove the print from the bed first');
  }
  switch (c.action) {
    case 'home':
      return c.axes === 'all' ? 'G28' : c.axes === 'xy' ? 'G28 X Y' : `G28 ${c.axes.toUpperCase()}`;
    case 'jog': {
      if (!Number.isFinite(c.distance) || Math.abs(c.distance) < CONTROL_LIMITS.minJog || Math.abs(c.distance) > CONTROL_LIMITS.maxJog) {
        throw new AppError(400, 'printers.out_of_range', 'Jog distance out of range', { max: CONTROL_LIMITS.maxJog });
      }
      if (!(ctx.homedAxes ?? '').includes(c.axis)) {
        throw refuse('printers.not_homed', 'Home the printer before moving this axis', { axis: c.axis });
      }
      const i = axisIndex(c.axis);
      const cur = ctx.position?.[i];
      if (cur === undefined || cur === null) throw refuse('printers.position_unknown', 'The toolhead position is unknown');
      const max = c.axis === 'x' ? ctx.bed.x : c.axis === 'y' ? ctx.bed.y : ctx.bed.z;
      const target = jogTarget(c, ctx.position!);
      // Klipper aborts the rest of the script on "Move out of range" (leaving G91 on): refuse up front instead.
      // A move that brings an out-of-range toolhead back towards the volume is allowed.
      const inside = target >= 0 && target <= max;
      const towards = (cur < 0 && c.distance > 0 && target <= max) || (cur > max && c.distance < 0 && target >= 0);
      if (!inside && !towards) throw refuse('printers.out_of_range', 'The move would leave the build volume', { axis: c.axis, max });
      const cap = c.axis === 'z' ? CONTROL_LIMITS.maxFeedZ : CONTROL_LIMITS.maxFeedXY;
      const feed = Math.max(CONTROL_LIMITS.minFeed, Math.min(cap, Math.round(c.feedrate)));
      return `G90\nG1 ${c.axis.toUpperCase()}${fmt(target)} F${feed}`;
    }
    case 'extrude': {
      if (
        !Number.isFinite(c.length) ||
        Math.abs(c.length) < CONTROL_LIMITS.minExtrude ||
        Math.abs(c.length) > CONTROL_LIMITS.maxExtrude ||
        !(c.speed >= CONTROL_LIMITS.minExtrudeSpeed) ||
        c.speed > CONTROL_LIMITS.maxExtrudeSpeed
      ) {
        throw new AppError(400, 'printers.out_of_range', 'Extrusion out of range');
      }
      if (ctx.nozzleTemp === null || ctx.nozzleTemp < CONTROL_LIMITS.minExtrudeTemp) {
        throw refuse('printers.nozzle_cold', 'Heat the nozzle to at least 170 °C first', { min: CONTROL_LIMITS.minExtrudeTemp });
      }
      return `G92 E0\nG1 E${fmt(c.length)} F${Math.max(6, Math.round(c.speed * 60))}\nG92 E0`;
    }
    case 'temp': {
      const max = c.heater === 'nozzle' ? ctx.maxNozzleTemp : ctx.maxBedTemp;
      if (!Number.isInteger(c.target) || c.target < 0 || c.target > max) {
        throw new AppError(400, 'printers.temp_out_of_range', `Target must be between 0 and ${max} °C`, { heater: c.heater, max });
      }
      return c.heater === 'nozzle' ? `M104 S${c.target}` : `M140 S${c.target}`;
    }
    case 'fan': {
      if (!Number.isInteger(c.percent) || c.percent < 0 || c.percent > 100) throw new AppError(400, 'printers.out_of_range', 'Fan out of range');
      // Creality Print SetFanSpeed: `M106 P0 S<0-255>` (P0 = part-cooling fan).
      return `M106 P0 S${Math.round((c.percent * 255) / 100)}`;
    }
    case 'speed_factor':
    case 'flow_factor': {
      const b = c.action === 'speed_factor' ? CONTROL_LIMITS.speedFactor : CONTROL_LIMITS.flowFactor;
      if (!Number.isInteger(c.percent) || c.percent < b.min || c.percent > b.max) {
        throw new AppError(400, 'printers.factor_out_of_range', `Must be between ${b.min} and ${b.max} %`, { min: b.min, max: b.max });
      }
      return `${c.action === 'speed_factor' ? 'M220' : 'M221'} S${c.percent}`;
    }
    case 'motors_off':
      return 'M84';
  }
}

/** `EXCLUDE_OBJECT NAME=<name>` (the name was validated against the job's defined objects). */
export function buildExcludeGcode(name: string): string {
  if (!OBJECT_NAME_RE.test(name)) throw new AppError(400, 'exclude.invalid_name', 'Invalid object name');
  return `EXCLUDE_OBJECT NAME=${name}`;
}

// ---------------------------------------------------------------- service

export interface PrinterControlDeps {
  manager: PrinterManager;
  printers: PrintersService;
  users: UsersService;
  audit: AuditService;
  /** Owner of the print SliceDock is tracking (exclude object, job tuning: owner or admin). */
  currentOwner: (printerId: number) => number | null;
  /** While SliceDock uploads/starts a job on the printer: its owner (null = none); undefined when nothing is. */
  dispatchOwner?: (printerId: number) => number | null | undefined;
  /** `printers.idleHeaterOffMinutes` (idle heater safety); without it the watchdog is off. */
  settings?: Pick<SettingsService, 'get'>;
  /** Notification dispatcher hook (`printer.heaters_auto_off`, admins). */
  notify?: (event: 'printer.heaters_auto_off', data: { printerId: number; printerName: string; nozzleTarget: number | null; bedTarget: number | null }) => void;
  /** Idle heater check cadence (default 30 s). */
  heaterCheckMs?: number;
  now?: () => number;
}

/** What SliceDock expects the toolhead to do, per printer (see `PrinterControlService`). */
interface MotionState {
  /** Position after every accepted command (null = unknown: resync from the printer when idle and confirmed). */
  expected: [number, number, number] | null;
  /** The printer may still be executing our last move until then: no resync from reported positions before. */
  busyUntil: number;
  lastMotionAt: number;
  /** A home / motors off was sent then: the reported homing state must be newer than this + `settleMs`. */
  homingChangedAt: number;
}

interface PendingExcludes {
  key: string;
  /** Upper-case names sent for this job (confirmed or not): they count as excluded for the last-object rule. */
  names: Set<string>;
  /** Sent but never confirmed by Klipper: the same name may be retried. */
  unconfirmed: Set<string>;
}

const SYSTEM_ACTOR = { userId: null, username: 'system', ip: null };

/**
 * Motion/temperature/fan controls and exclude-object. Every action is audited (refusals too, rate-limited).
 *
 * Per printer, control commands and excludes run through ONE serial queue (one command in flight at a time), so
 * validation and the state update after the send are atomic:
 * - **expected position**: each accepted jog is applied to it immediately, and the next jog is validated against it
 *   (two quick `Z -10` from Z=10: the second sees Z=0 and is refused). It is re-synced from the printer's reported
 *   position only when our last move should be finished (`busyUntil`) and the report is fresh;
 * - **fresh state**: before home/jog/extrude the driver re-reads the homing/position state (`controlTelemetry`);
 *   older than `staleMs` or unconfirmable (link dropped, Moonraker down) → `printers.state_stale`;
 * - after **motors off** / **home** the homing state must be reported again after the command (`settleMs`).
 */
export class PrinterControlService {
  private readonly hits = new Map<string, number[]>();
  private readonly refusedHits = new Map<string, number[]>();
  /** Last speed/flow factor SliceDock set per printer (fallback when the printer does not report them). */
  private readonly factors = new Map<number, { speed: number | null; flow: number | null }>();
  private readonly motion = new Map<number, MotionState>();
  private readonly queues = new Map<number, Promise<unknown>>();
  private readonly pendingExcludes = new Map<number, PendingExcludes>();
  /** Last control action per printer (idle heater safety counts from it). */
  private readonly lastAction = new Map<number, number>();
  /** Since when a heater target > 0 is seen while idle. */
  private readonly heatingSince = new Map<number, number>();
  private heaterTimer: NodeJS.Timeout | null = null;

  constructor(private readonly d: PrinterControlDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** Fills `speedFactor`/`flowFactor` from the last value set when the printer reports none. Starts the heater watchdog. */
  attach(): void {
    this.d.manager.addExtender((s) => {
      const f = this.factors.get(s.printerId);
      if (!f || !s.online) return {};
      return { speedFactor: s.speedFactor ?? f.speed, flowFactor: s.flowFactor ?? f.flow };
    });
    if (this.d.settings && !this.heaterTimer) {
      this.heaterTimer = setInterval(() => void this.checkIdleHeaters(), this.d.heaterCheckMs ?? 30_000);
      this.heaterTimer.unref?.();
    }
  }

  stop(): void {
    if (this.heaterTimer) clearInterval(this.heaterTimer);
    this.heaterTimer = null;
  }

  /** Admins always; users with the `can_control_printer` grant. */
  canControl(actor: Actor): boolean {
    return actor.role === 'admin' || this.d.users.canControlPrinter(actor.id);
  }

  async control(actor: Actor, printerId: number, c: PrinterControlCommand): Promise<PrinterStatus> {
    try {
      assertWritable();
      this.d.printers.get(printerId);
      if (!this.canControl(actor)) throw forbidden('printers.control_forbidden', 'You are not allowed to control the printer');
      this.rateLimit(actor, printerId);
      return await this.serial(printerId, () => this.run(actor, printerId, c));
    } catch (err) {
      this.auditRefused(actor, printerId, c.action, err);
      throw err;
    }
  }

  private async run(actor: Actor, printerId: number, c: PrinterControlCommand): Promise<PrinterStatus> {
    const s = this.d.manager.status(printerId);
    if (!s.online) throw new AppError(409, 'prints.printer_offline', 'The printer is offline');
    const uploadOwner = this.d.dispatchOwner?.(printerId);
    const uploading = uploadOwner !== undefined;
    if (JOB_TUNING_ACTIONS.has(c.action) && (uploading || isActiveState(s.state))) {
      // A running (or starting) job: only its owner or an admin may change heaters, fan, speed and flow.
      const owner = uploading ? uploadOwner : this.d.currentOwner(printerId);
      if (actor.role !== 'admin' && owner !== actor.id) {
        throw forbidden('printers.forbidden_job', 'Only the owner of the current print or an admin can change this while it runs');
      }
    }
    if (uploading && c.action !== 'light' && !JOB_TUNING_ACTIONS.has(c.action)) {
      throw refuse('printers.control_busy', 'A print is being sent to the printer');
    }
    if (c.action === 'light') {
      // Allowed while printing (like the fan); a Creality WS `set` frame, not G-code.
      await this.d.manager.driver(printerId).setLight(c.on);
      this.touch(printerId);
      this.d.audit.log('printer.control', auditActor(actor), String(printerId), { printerId, ...c, frame: { lightSw: c.on ? 1 : 0 } });
      logger.printer.info(`printer #${printerId}: light ${c.on ? 'on' : 'off'} by "${actor.username}"`);
      return this.d.manager.status(printerId);
    }
    if (c.action === 'temp' && c.target > 0 && s.state === 'error') {
      throw refuse('printers.printer_error', 'The printer reports an error: heating is not allowed');
    }
    const ctx: ControlContext = {
      state: s.state,
      homedAxes: s.homedAxes,
      position: s.position,
      nozzleTemp: s.nozzleTemp,
      maxNozzleTemp: s.maxNozzleTemp ?? 300,
      maxBedTemp: s.maxBedTemp ?? 100,
      bed: CrealityK2SEDriver.info.bed,
      bedClear: s.bedClear,
    };
    const m = this.motionState(printerId);
    if (MOTION_ACTIONS.has(c.action)) {
      // Cheap refusals first (busy, bed occupied), then the fresh-state round trip.
      if (isActiveState(s.state) || !s.bedClear) buildControlGcode(c as GcodeControlCommand, ctx);
      const tel = await this.telemetry(printerId, s, m.homingChangedAt ? m.homingChangedAt + CONTROL_LIMITS.settleMs : 0);
      if (!tel.fresh) throw refuse('printers.state_stale', 'The printer state is not up to date: try again in a moment');
      const now = this.now();
      ctx.homedAxes = m.homingChangedAt && tel.receivedAt < m.homingChangedAt + CONTROL_LIMITS.settleMs ? '' : tel.homedAxes;
      if (now >= m.busyUntil && tel.position) m.expected = tel.position; // idle and confirmed: resync
      ctx.position = m.expected;
    }
    if (MOTION_ACTIONS.has(c.action) || c.action === 'motors_off') {
      const wait = m.lastMotionAt + CONTROL_LIMITS.motionGapMs - this.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      // The awaits above (fresh-state round trip, motion gap) can take seconds: a print may have started being
      // sent, started or ended (bed occupied) meanwhile. Re-validate against the state right before sending.
      const fresh = this.d.manager.status(printerId);
      if (!fresh.online) throw new AppError(409, 'prints.printer_offline', 'The printer is offline');
      if (this.d.dispatchOwner?.(printerId) !== undefined) throw refuse('printers.control_busy', 'A print is being sent to the printer');
      ctx.state = fresh.state;
      ctx.bedClear = fresh.bedClear;
      ctx.nozzleTemp = fresh.nozzleTemp;
    }
    const gcode = buildControlGcode(c as GcodeControlCommand, ctx);
    await this.d.manager.driver(printerId).sendGcode(gcode);
    const sentAt = this.now();
    this.touch(printerId);
    switch (c.action) {
      case 'jog': {
        const pos = [...ctx.position!] as [number, number, number];
        pos[c.axis === 'x' ? 0 : c.axis === 'y' ? 1 : 2] = jogTarget(c, ctx.position!);
        m.expected = pos;
        const feed = Math.max(CONTROL_LIMITS.minFeed, Math.min(c.axis === 'z' ? CONTROL_LIMITS.maxFeedZ : CONTROL_LIMITS.maxFeedXY, c.feedrate));
        m.busyUntil = sentAt + (Math.abs(c.distance) / feed) * 60_000 + 500;
        m.lastMotionAt = sentAt;
        break;
      }
      case 'home':
      case 'motors_off':
        m.expected = null;
        m.homingChangedAt = sentAt;
        m.busyUntil = sentAt + CONTROL_LIMITS.settleMs;
        m.lastMotionAt = sentAt;
        break;
      case 'extrude':
        m.lastMotionAt = sentAt;
        break;
      case 'speed_factor':
      case 'flow_factor': {
        const f = this.factors.get(printerId) ?? { speed: null, flow: null };
        this.factors.set(printerId, c.action === 'speed_factor' ? { ...f, speed: c.percent } : { ...f, flow: c.percent });
        break;
      }
      default:
        break;
    }
    this.d.audit.log('printer.control', auditActor(actor), String(printerId), { printerId, ...c, gcode });
    logger.printer.info(`printer #${printerId}: ${c.action} by "${actor.username}" (${gcode.replace(/\n/g, ' | ')})`);
    return this.d.manager.status(printerId);
  }

  /** Fresh homing/position from the driver (fallback for drivers without `controlTelemetry`: the status, while online). */
  private async telemetry(printerId: number, s: PrinterStatus, notBefore: number): Promise<ControlTelemetry> {
    const driver = this.d.manager.driver(printerId);
    if (driver.controlTelemetry) return driver.controlTelemetry(CONTROL_LIMITS.staleMs, notBefore);
    return { fresh: s.online, homedAxes: s.homedAxes, position: s.position, receivedAt: this.now() };
  }

  private motionState(printerId: number): MotionState {
    let m = this.motion.get(printerId);
    if (!m) {
      m = { expected: null, busyUntil: 0, lastMotionAt: 0, homingChangedAt: 0 };
      this.motion.set(printerId, m);
    }
    return m;
  }

  /** Runs `fn` after every earlier control/exclude command of this printer finished (one in flight). */
  private serial<T>(printerId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(printerId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    const settled = next.catch(() => undefined);
    this.queues.set(printerId, settled);
    void settled.then(() => {
      if (this.queues.get(printerId) === settled) this.queues.delete(printerId);
    });
    return next;
  }

  private touch(printerId: number): void {
    this.lastAction.set(printerId, this.now());
    this.heatingSince.delete(printerId);
  }

  /**
   * `EXCLUDE_OBJECT NAME=` while printing/paused: the print's owner or an admin. The name must be one of the job's
   * defined objects, not excluded yet (reported or still pending), and at least one other object must keep printing.
   * Serialised per printer with the controls; names sent but not reported yet count as excluded.
   */
  async excludeObject(actor: Actor, printerId: number, name: string): Promise<PrinterStatus> {
    try {
      assertWritable();
      this.d.printers.get(printerId);
      if (actor.role !== 'admin' && this.d.currentOwner(printerId) !== actor.id) {
        throw forbidden('prints.not_owner', 'Only the owner of the current print or an admin can do this');
      }
      if (!OBJECT_NAME_RE.test(name)) throw new AppError(400, 'exclude.invalid_name', 'Invalid object name');
      this.rateLimit(actor, printerId);
      return await this.serial(printerId, () => this.runExclude(actor, printerId, name));
    } catch (err) {
      this.auditRefused(actor, printerId, 'exclude_object', err);
      throw err;
    }
  }

  private async runExclude(actor: Actor, printerId: number, name: string): Promise<PrinterStatus> {
    const s = this.d.manager.status(printerId);
    if (!s.online) throw new AppError(409, 'prints.printer_offline', 'The printer is offline');
    if (!s.job || (s.state !== 'printing' && s.state !== 'paused')) throw new AppError(409, 'prints.invalid_state', 'Nothing is printing');
    const key = `${s.currentPrintId ?? ''}|${s.job.fileName}`;
    let pending = this.pendingExcludes.get(printerId);
    if (!pending || pending.key !== key) {
      pending = { key, names: new Set(), unconfirmed: new Set() };
      this.pendingExcludes.set(printerId, pending);
    }
    const p = pending;
    const objects = s.job.objects;
    const gone = (o: (typeof objects)[number]) => o.excluded || p.names.has(o.name.toUpperCase());
    const obj = objects.find((o) => o.name.toUpperCase() === name.toUpperCase());
    if (!obj) throw new AppError(404, 'exclude.unknown_object', 'This object is not part of the current print');
    const upper = obj.name.toUpperCase();
    if (obj.excluded || (p.names.has(upper) && !p.unconfirmed.has(upper))) {
      throw new AppError(409, 'exclude.already_excluded', 'This object is already excluded');
    }
    if (!objects.some((o) => o !== obj && !gone(o))) {
      throw new AppError(409, 'exclude.last_object', 'At least one object must keep printing (cancel the print instead)');
    }
    const driver = this.d.manager.driver(printerId);
    p.names.add(upper);
    let confirmed: boolean;
    let via: string;
    if (driver.excludeObject) {
      // Creality `excludeObjects` frame (+ Moonraker fallback), confirmed by Klipper's `excluded_objects`.
      via = 'excludeObjects';
      confirmed = await driver.excludeObject(obj.name);
    } else {
      via = buildExcludeGcode(obj.name);
      await driver.sendGcode(via);
      confirmed = true;
    }
    if (!confirmed) {
      // Stays counted for the last-object rule (it may still apply later); the same object can be retried.
      p.unconfirmed.add(upper);
      this.d.audit.log('print.exclude_unconfirmed', auditActor(actor), String(printerId), { printerId, name: obj.name, label: obj.label });
      logger.printer.warn(`printer #${printerId}: exclude of ${obj.name} by "${actor.username}" was not confirmed by the printer`);
      throw new AppError(502, 'printers.exclude_unconfirmed', 'The printer did not confirm the excluded object', { name: obj.name });
    }
    p.unconfirmed.delete(upper);
    this.d.audit.log('print.exclude_object', auditActor(actor), String(printerId), { printerId, name: obj.name, label: obj.label, via });
    logger.printer.info(`printer #${printerId}: object ${obj.name} excluded by "${actor.username}" (confirmed)`);
    return this.d.manager.status(printerId);
  }

  /**
   * Idle heater safety: not printing/paused/uploading, a heater target > 0, and no control action for
   * `printers.idleHeaterOffMinutes` → `M104 S0` + `M140 S0`, audited (`printer.heaters_auto_off`) and notified.
   * Returns the printers whose heaters were switched off (tests).
   */
  async checkIdleHeaters(): Promise<number[]> {
    const off: number[] = [];
    try {
      const minutes = this.d.settings?.get('printers.idleHeaterOffMinutes') ?? 0;
      if (!minutes || isReadOnly()) {
        this.heatingSince.clear();
        return off;
      }
      const now = this.now();
      for (const p of this.d.printers.list()) {
        if (!this.d.manager.hasDriver(p.id)) continue;
        const s = this.d.manager.status(p.id);
        const heating = (s.nozzleTarget ?? 0) > 0 || (s.bedTarget ?? 0) > 0;
        const busy = isActiveState(s.state) || this.d.dispatchOwner?.(p.id) !== undefined;
        if (!s.online || busy || !heating) {
          this.heatingSince.delete(p.id);
          continue;
        }
        if (!this.heatingSince.has(p.id)) this.heatingSince.set(p.id, now);
        const since = Math.max(this.heatingSince.get(p.id)!, this.lastAction.get(p.id) ?? 0);
        if (now - since < minutes * 60_000) continue;
        const gcode = 'M104 S0\nM140 S0';
        try {
          await this.serial(p.id, () => this.d.manager.driver(p.id).sendGcode(gcode));
        } catch (err) {
          logger.printer.warn(`printer #${p.id}: could not switch the idle heaters off`, err);
          continue;
        }
        this.touch(p.id);
        off.push(p.id);
        const meta = { printerId: p.id, minutes, nozzleTarget: s.nozzleTarget, bedTarget: s.bedTarget, gcode };
        this.d.audit.log('printer.heaters_auto_off', SYSTEM_ACTOR, String(p.id), meta);
        logger.printer.warn(`printer #${p.id}: heaters left on for ${minutes} min while idle, switched off`);
        try {
          this.d.notify?.('printer.heaters_auto_off', { printerId: p.id, printerName: p.name, nozzleTarget: s.nozzleTarget, bedTarget: s.bedTarget });
        } catch (err) {
          logger.printer.warn('heater auto-off notification failed', err);
        }
      }
    } catch (err) {
      logger.printer.warn('idle heater check failed', err);
    }
    return off;
  }

  /** `printer.control_refused` for 403/409 refusals, at most `refusedAuditPerMinute` per user and printer. */
  private auditRefused(actor: Actor, printerId: number, action: string, err: unknown): void {
    if (!(err instanceof AppError) || (err.status !== 403 && err.status !== 409)) return;
    try {
      const now = this.now();
      const key = `${actor.id}|${printerId}`;
      const recent = (this.refusedHits.get(key) ?? []).filter((t) => now - t < 60_000);
      if (recent.length >= CONTROL_LIMITS.refusedAuditPerMinute) return;
      recent.push(now);
      this.refusedHits.set(key, recent);
      this.d.audit.log('printer.control_refused', auditActor(actor), String(printerId), { printerId, action, code: err.code });
    } catch {
      /* auditing a refusal never masks the refusal */
    }
  }

  private rateLimit(actor: Actor, printerId: number): void {
    const now = this.now();
    const key = `${actor.id}|${printerId}`;
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < CONTROL_LIMITS.rateWindowMs);
    if (recent.length >= CONTROL_LIMITS.rateMax) {
      const retry = Math.max(1, Math.ceil((CONTROL_LIMITS.rateWindowMs - (now - recent[0]!)) / 1000));
      throw new AppError(429, 'printers.control_rate_limited', 'Too many printer commands, slow down', { retryAfter: retry }, { 'Retry-After': String(retry) });
    }
    recent.push(now);
    this.hits.set(key, recent);
  }
}

const auditActor = (a: Actor) => ({ userId: a.id, username: a.username, ip: a.ip ?? null });
