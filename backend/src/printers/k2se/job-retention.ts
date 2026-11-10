import type { LiveJob, PrinterState, PrinterStatus } from '../../types.js';
import { isActiveState } from './protocol.js';

/**
 * Keeps `PrinterStatus.job` (and the state) steady across the K2 SE's transitional frames.
 *
 * Seen on the real printer while resuming from a pause: Creality `state` 8 (restoring), a momentary `state: 0`
 * (idle) frame, and Moonraker briefly reporting `print_stats.state` "standby" / `virtual_sdcard.is_active` false
 * (so the live job parses as null), then printing again. Without this the Printer tab showed "nothing is printing"
 * for a few seconds. Rules:
 * - While the state is pausing / paused / resuming, the last live job (same file) is kept even if Moonraker drops it.
 *   While printing, it is kept for up to `holdMs` after Moonraker last reported it.
 * - A non-active frame (idle, aborted, failed) within `holdMs` of the last active one is a transition, not an end:
 *   the previous active state and job are published instead, unless the previous state was `stopping` (a real
 *   cancel) or Klipper confirms a terminal state (`complete` / `cancelled` / `error`). `complete` and `error` are
 *   never masked, but `complete` keeps the final job view during the hold.
 * - The live G-code position (`job.filePosition`, `job.toolhead`) and `position` keep their last value while a
 *   transitional frame does not carry them.
 * The printing service's own terminal-state debounce (`terminalStableMs`) still runs on top of this.
 */
export class JobRetention {
  private job: LiveJob | null = null;
  private jobAt = 0;
  private lastActive: PrinterState | null = null;
  private lastActiveAt = 0;
  private position: [number, number, number] | null = null;

  constructor(private readonly holdMs = 5000) {}

  /** When the current hold expires (epoch ms), so the caller can re-publish then; null when nothing is held. */
  holdUntil(): number | null {
    return this.lastActive ? this.lastActiveAt + this.holdMs : null;
  }

  reset(): void {
    this.job = null;
    this.lastActive = null;
    this.position = null;
  }

  /** Applies the rules to a freshly composed status (mutates and returns it). `klipper` = fresh `print_stats.state`. */
  apply(s: PrinterStatus, klipper: string | null, now = Date.now()): PrinterStatus {
    if (!s.online) return s;
    // A different file is a different job.
    if (this.job && s.fileName && s.fileName !== this.job.fileName) this.reset();
    const transitional = (st: PrinterState | null) => st === 'pausing' || st === 'paused' || st === 'resuming';

    if (isActiveState(s.state)) {
      if (s.job) {
        if (this.job && this.job.fileName === s.job.fileName) {
          if (s.job.filePosition === null) s.job.filePosition = this.job.filePosition;
          if (s.job.toolhead === null) s.job.toolhead = this.job.toolhead;
        }
        this.job = s.job;
        this.jobAt = now;
      } else if (this.job && (transitional(s.state) || now - this.jobAt < this.holdMs)) {
        s.job = this.job;
      }
      if (s.position) this.position = s.position;
      else s.position = this.position;
      this.lastActive = s.state;
      this.lastActiveAt = now;
      return s;
    }

    const holding = this.lastActive !== null && now - this.lastActiveAt < this.holdMs;
    const confirmedEnd = klipper === 'complete' || klipper === 'cancelled' || klipper === 'error';
    if (holding && this.lastActive !== 'stopping' && !confirmedEnd && (s.state === 'idle' || s.state === 'aborted' || s.state === 'failed')) {
      s.state = this.lastActive!;
      s.job = this.job;
      if (!s.position) s.position = this.position;
      return s;
    }
    if (holding && s.state === 'complete' && this.job) {
      s.job = this.job;
      return s;
    }
    if (!holding) this.reset();
    return s;
  }
}
