import { z } from 'zod';
import { AppError, forbidden } from '../../errors.js';
import { logger } from '../../logger.js';
import { CrealityK2SEDriver } from '../../printers/drivers/creality-k2se.js';
import { isActiveState } from '../../printers/k2se/protocol.js';
import { OBJECT_NAME_RE } from '../../printers/k2se/moonraker.js';
import type { PrinterManager } from '../../printers/manager.js';
import { assertWritable } from '../../printers/read-only.js';
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
} as const;

/** The only shape the API accepts (never raw G-code). */
export const controlSchema: z.ZodType<PrinterControlCommand> = z.discriminatedUnion('action', [
  z.object({ action: z.literal('home'), axes: z.enum(['all', 'xy', 'x', 'y', 'z']) }).strict(),
  z
    .object({
      action: z.literal('jog'),
      axis: z.enum(['x', 'y', 'z']),
      distance: z.number().finite().refine((v) => v !== 0 && Math.abs(v) <= CONTROL_LIMITS.maxJog, 'distance'),
      feedrate: z.number().finite().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal('extrude'),
      length: z.number().finite().refine((v) => v !== 0 && Math.abs(v) <= CONTROL_LIMITS.maxExtrude, 'length'),
      speed: z.number().finite().positive().max(CONTROL_LIMITS.maxExtrudeSpeed),
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
}

const refuse = (code: string, message: string, details?: Record<string, unknown>) => new AppError(409, code, message, details);
const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

/**
 * Turns a typed command into the G-code SliceDock sends. Pure (unit-tested): every bound and refusal lives here.
 * The light is not G-code (Creality WS `lightSw`): see `PrinterControlService.control`.
 * - while a job is active only the "tuning" actions are accepted (fan, temperatures, speed/flow factor);
 *   motion, extrusion and motors off are refused (`printers.control_busy`);
 * - jogs need the axis homed (`printers.not_homed`) and must stay inside the build volume (`printers.out_of_range`);
 * - extrusion needs the nozzle at ≥ 170 °C (`printers.nozzle_cold`);
 * - targets are bounded by the printer/profile maxima (`printers.temp_out_of_range`).
 */
export type GcodeControlCommand = Exclude<PrinterControlCommand, { action: 'light' }>;

/** Actions allowed while a job is active (typical live tuning). The light is allowed too (not G-code). */
export const TUNING_ACTIONS: ReadonlySet<PrinterControlCommand['action']> = new Set(['fan', 'temp', 'speed_factor', 'flow_factor', 'light']);

export function buildControlGcode(c: GcodeControlCommand, ctx: ControlContext): string {
  if (isActiveState(ctx.state) && !TUNING_ACTIONS.has(c.action)) {
    throw refuse('printers.control_busy', 'Only the fan, light, temperatures, speed and flow can be changed while a print is running');
  }
  switch (c.action) {
    case 'home':
      return c.axes === 'all' ? 'G28' : c.axes === 'xy' ? 'G28 X Y' : `G28 ${c.axes.toUpperCase()}`;
    case 'jog': {
      if (c.distance === 0 || !Number.isFinite(c.distance) || Math.abs(c.distance) > CONTROL_LIMITS.maxJog) {
        throw new AppError(400, 'printers.out_of_range', 'Jog distance out of range', { max: CONTROL_LIMITS.maxJog });
      }
      if (!(ctx.homedAxes ?? '').includes(c.axis)) {
        throw refuse('printers.not_homed', 'Home the printer before moving this axis', { axis: c.axis });
      }
      const i = c.axis === 'x' ? 0 : c.axis === 'y' ? 1 : 2;
      const cur = ctx.position?.[i];
      if (cur === undefined || cur === null) throw refuse('printers.position_unknown', 'The toolhead position is unknown');
      const max = c.axis === 'x' ? ctx.bed.x : c.axis === 'y' ? ctx.bed.y : ctx.bed.z;
      const target = cur + c.distance;
      // Klipper aborts the rest of the script on "Move out of range" (leaving G91 on): refuse up front instead.
      // A move that brings an out-of-range toolhead back towards the volume is allowed.
      const inside = target >= 0 && target <= max;
      const towards = (cur < 0 && c.distance > 0 && target <= max) || (cur > max && c.distance < 0 && target >= 0);
      if (!inside && !towards) throw refuse('printers.out_of_range', 'The move would leave the build volume', { axis: c.axis, max });
      const cap = c.axis === 'z' ? CONTROL_LIMITS.maxFeedZ : CONTROL_LIMITS.maxFeedXY;
      const feed = Math.max(60, Math.min(cap, Math.round(c.feedrate)));
      return `G91\nG1 ${c.axis.toUpperCase()}${fmt(c.distance)} F${feed}\nG90`;
    }
    case 'extrude': {
      if (c.length === 0 || Math.abs(c.length) > CONTROL_LIMITS.maxExtrude || c.speed <= 0 || c.speed > CONTROL_LIMITS.maxExtrudeSpeed) {
        throw new AppError(400, 'printers.out_of_range', 'Extrusion out of range');
      }
      if (ctx.nozzleTemp === null || ctx.nozzleTemp < CONTROL_LIMITS.minExtrudeTemp) {
        throw refuse('printers.nozzle_cold', 'Heat the nozzle to at least 170 °C first', { min: CONTROL_LIMITS.minExtrudeTemp });
      }
      return `M83\nG1 E${fmt(c.length)} F${Math.round(c.speed * 60)}`;
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
  /** Owner of the print SliceDock is tracking (exclude object: owner or admin). */
  currentOwner: (printerId: number) => number | null;
  now?: () => number;
}

/** Motion/temperature/fan controls and exclude-object. Every action is audited. */
export class PrinterControlService {
  private readonly hits = new Map<string, number[]>();
  /** Last speed/flow factor SliceDock set per printer (fallback when the printer does not report them). */
  private readonly factors = new Map<number, { speed: number | null; flow: number | null }>();

  constructor(private readonly d: PrinterControlDeps) {}

  /** Fills `speedFactor`/`flowFactor` from the last value set when the printer reports none. */
  attach(): void {
    this.d.manager.addExtender((s) => {
      const f = this.factors.get(s.printerId);
      if (!f || !s.online) return {};
      return { speedFactor: s.speedFactor ?? f.speed, flowFactor: s.flowFactor ?? f.flow };
    });
  }

  /** Admins always; users with the `can_control_printer` grant. */
  canControl(actor: Actor): boolean {
    return actor.role === 'admin' || this.d.users.canControlPrinter(actor.id);
  }

  async control(actor: Actor, printerId: number, c: PrinterControlCommand): Promise<PrinterStatus> {
    assertWritable();
    this.d.printers.get(printerId);
    if (!this.canControl(actor)) throw forbidden('printers.control_forbidden', 'You are not allowed to control the printer');
    this.rateLimit(actor, printerId);
    const s = this.d.manager.status(printerId);
    if (!s.online) throw new AppError(409, 'prints.printer_offline', 'The printer is offline');
    if (c.action === 'light') {
      // Allowed while printing (like the fan); a Creality WS `set` frame, not G-code.
      await this.d.manager.driver(printerId).setLight(c.on);
      this.d.audit.log('printer.control', auditActor(actor), String(printerId), { printerId, ...c, frame: { lightSw: c.on ? 1 : 0 } });
      logger.printer.info(`printer #${printerId}: light ${c.on ? 'on' : 'off'} by "${actor.username}"`);
      return this.d.manager.status(printerId);
    }
    const gcode = buildControlGcode(c, {
      state: s.state,
      homedAxes: s.homedAxes,
      position: s.position,
      nozzleTemp: s.nozzleTemp,
      maxNozzleTemp: s.maxNozzleTemp ?? 300,
      maxBedTemp: s.maxBedTemp ?? 100,
      bed: CrealityK2SEDriver.info.bed,
    });
    await this.d.manager.driver(printerId).sendGcode(gcode);
    if (c.action === 'speed_factor' || c.action === 'flow_factor') {
      const f = this.factors.get(printerId) ?? { speed: null, flow: null };
      this.factors.set(printerId, c.action === 'speed_factor' ? { ...f, speed: c.percent } : { ...f, flow: c.percent });
    }
    this.d.audit.log('printer.control', auditActor(actor), String(printerId), { printerId, ...c, gcode });
    logger.printer.info(`printer #${printerId}: ${c.action} by "${actor.username}" (${gcode.replace(/\n/g, ' | ')})`);
    return this.d.manager.status(printerId);
  }

  /**
   * `EXCLUDE_OBJECT NAME=` while printing/paused: the print's owner or an admin. The name must be one of the job's
   * defined objects, not excluded yet, and at least one other object must keep printing.
   */
  async excludeObject(actor: Actor, printerId: number, name: string): Promise<PrinterStatus> {
    assertWritable();
    this.d.printers.get(printerId);
    if (actor.role !== 'admin' && this.d.currentOwner(printerId) !== actor.id) {
      throw forbidden('prints.not_owner', 'Only the owner of the current print or an admin can do this');
    }
    if (!OBJECT_NAME_RE.test(name)) throw new AppError(400, 'exclude.invalid_name', 'Invalid object name');
    this.rateLimit(actor, printerId);
    const s = this.d.manager.status(printerId);
    if (!s.online) throw new AppError(409, 'prints.printer_offline', 'The printer is offline');
    if (!s.job || (s.state !== 'printing' && s.state !== 'paused')) throw new AppError(409, 'prints.invalid_state', 'Nothing is printing');
    const objects = s.job.objects;
    const obj = objects.find((o) => o.name.toUpperCase() === name.toUpperCase());
    if (!obj) throw new AppError(404, 'exclude.unknown_object', 'This object is not part of the current print');
    if (obj.excluded) throw new AppError(409, 'exclude.already_excluded', 'This object is already excluded');
    if (!objects.some((o) => o !== obj && !o.excluded)) {
      throw new AppError(409, 'exclude.last_object', 'At least one object must keep printing (cancel the print instead)');
    }
    const gcode = buildExcludeGcode(obj.name);
    await this.d.manager.driver(printerId).sendGcode(gcode);
    this.d.audit.log('print.exclude_object', auditActor(actor), String(printerId), { printerId, name: obj.name, label: obj.label });
    logger.printer.info(`printer #${printerId}: object ${obj.name} excluded by "${actor.username}"`);
    return this.d.manager.status(printerId);
  }

  private rateLimit(actor: Actor, printerId: number): void {
    const now = (this.d.now ?? Date.now)();
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
