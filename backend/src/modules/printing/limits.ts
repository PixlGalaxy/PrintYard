import { AppError } from '../../errors.js';
import type { UserLimits } from '../../types.js';

/**
 * Calendar month containing `now`, in the server's time zone (process `TZ`; the container sets it).
 * Returns [start, end) in epoch ms.
 */
export function monthRange(now: number = Date.now()): { start: number; end: number } {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).getTime();
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0).getTime();
  return { start, end };
}

export interface PrintEstimate {
  grams: number | null;
  seconds: number | null;
}

export type LimitDecision =
  | { ok: true; needsApproval: boolean; approvalReason?: 'requires_approval' | 'unknown_usage' }
  | { ok: false; error: AppError };

/**
 * Rules (contract §B2, plus judgement calls documented in status/b2-notes.md):
 * - admins are never limited;
 * - limits disabled (`enabled: false`) → the user prints freely: no gram/hour checks and no approval;
 * - with limits enabled: grams per print, grams this month (already used + this print), hours per print, and
 *   `requiresApproval` sends every print to approval;
 * - a limit that cannot be checked because the G-code has no estimate → needs approval (never silently allowed).
 */
export function evaluateLimits(
  limits: UserLimits,
  estimate: PrintEstimate,
  monthGramsUsed: number,
  isAdmin: boolean,
): LimitDecision {
  if (isAdmin || !limits.enabled) return { ok: true, needsApproval: false };
  let unknown = false;
  {
    const { grams, seconds } = estimate;
    if (limits.maxGramsPerPrint !== null) {
      if (grams === null) unknown = true;
      else if (grams > limits.maxGramsPerPrint) {
        return deny('prints.limit_per_print', 'This print uses more filament than your per-print limit', {
          limit: limits.maxGramsPerPrint,
          requested: round(grams),
        });
      }
    }
    if (limits.maxGramsPerMonth !== null) {
      if (grams === null) unknown = true;
      else if (monthGramsUsed + grams > limits.maxGramsPerMonth) {
        return deny('prints.limit_month', 'This print would exceed your monthly filament limit', {
          limit: limits.maxGramsPerMonth,
          used: round(monthGramsUsed),
          requested: round(grams),
          remaining: round(Math.max(0, limits.maxGramsPerMonth - monthGramsUsed)),
        });
      }
    }
    if (limits.maxHoursPerPrint !== null) {
      if (seconds === null) unknown = true;
      else if (seconds / 3600 > limits.maxHoursPerPrint) {
        return deny('prints.limit_hours', 'This print takes longer than your per-print time limit', {
          limit: limits.maxHoursPerPrint,
          requested: round(seconds / 3600),
        });
      }
    }
  }
  if (limits.requiresApproval) return { ok: true, needsApproval: true, approvalReason: 'requires_approval' };
  if (unknown) return { ok: true, needsApproval: true, approvalReason: 'unknown_usage' };
  return { ok: true, needsApproval: false };
}

function deny(code: string, message: string, details: Record<string, number>): LimitDecision {
  return { ok: false, error: new AppError(403, code, message, details) };
}

const round = (n: number) => Math.round(n * 100) / 100;

export function costFor(grams: number | null, costPerKg: number | null): number | null {
  if (grams === null || costPerKg === null) return null;
  return Math.round((grams / 1000) * costPerKg * 100) / 100;
}
