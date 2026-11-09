import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { costFor, evaluateLimits, monthRange } from '../src/modules/printing/limits.js';
import type { UserLimits } from '../src/types.js';

const L = (p: Partial<UserLimits> = {}): UserLimits => ({
  enabled: true,
  maxGramsPerPrint: null,
  maxGramsPerMonth: null,
  maxHoursPerPrint: null,
  requiresApproval: false,
  ...p,
});

describe('limits: evaluateLimits', () => {
  it('per print', () => {
    const r = evaluateLimits(L({ maxGramsPerPrint: 50 }), { grams: 60, seconds: 100 }, 0, false);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, 'prints.limit_per_print');
      assert.equal(r.error.status, 403);
      assert.deepEqual(r.error.details, { limit: 50, requested: 60 });
    }
    assert.deepEqual(evaluateLimits(L({ maxGramsPerPrint: 50 }), { grams: 50, seconds: 100 }, 0, false), { ok: true, needsApproval: false });
  });

  it('per month counts what was already used', () => {
    const r = evaluateLimits(L({ maxGramsPerMonth: 100 }), { grams: 30, seconds: 1 }, 80, false);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, 'prints.limit_month');
      assert.deepEqual(r.error.details, { limit: 100, used: 80, requested: 30, remaining: 20 });
    }
    assert.equal(evaluateLimits(L({ maxGramsPerMonth: 100 }), { grams: 20, seconds: 1 }, 80, false).ok, true);
  });

  it('hours per print', () => {
    const r = evaluateLimits(L({ maxHoursPerPrint: 2 }), { grams: 1, seconds: 2 * 3600 + 1 }, 0, false);
    assert.equal(!r.ok && r.error.code, 'prints.limit_hours');
    assert.equal(evaluateLimits(L({ maxHoursPerPrint: 2 }), { grams: 1, seconds: 7200 }, 0, false).ok, true);
  });

  it('disabled limits, admins, approval and unknown estimates', () => {
    assert.deepEqual(evaluateLimits(L({ enabled: false, maxGramsPerPrint: 1 }), { grams: 500, seconds: 1 }, 0, false), { ok: true, needsApproval: false });
    assert.deepEqual(evaluateLimits(L({ maxGramsPerPrint: 1, requiresApproval: true }), { grams: 500, seconds: 1 }, 0, true), { ok: true, needsApproval: false });
    // limits off → prints freely, even with requiresApproval set
    assert.deepEqual(evaluateLimits(L({ enabled: false, requiresApproval: true }), { grams: 5, seconds: 1 }, 0, false), {
      ok: true,
      needsApproval: false,
    });
    assert.deepEqual(evaluateLimits(L({ enabled: false, maxGramsPerPrint: 10 }), { grams: null, seconds: null }, 0, false), {
      ok: true,
      needsApproval: false,
    });
    assert.deepEqual(evaluateLimits(L({ requiresApproval: true }), { grams: 5, seconds: 1 }, 0, false), {
      ok: true,
      needsApproval: true,
      approvalReason: 'requires_approval',
    });
    assert.deepEqual(evaluateLimits(L({ maxGramsPerPrint: 10 }), { grams: null, seconds: 1 }, 0, false), {
      ok: true,
      needsApproval: true,
      approvalReason: 'unknown_usage',
    });
    // a hard violation wins over approval
    const r = evaluateLimits(L({ maxGramsPerPrint: 10, requiresApproval: true }), { grams: 11, seconds: 1 }, 0, false);
    assert.equal(r.ok, false);
  });

  it('cost', () => {
    assert.equal(costFor(250, 20), 5);
    assert.equal(costFor(null, 20), null);
    assert.equal(costFor(250, null), null);
  });
});

describe('limits: month boundary in the server time zone', () => {
  let tz: string | undefined;
  before(() => {
    tz = process.env.TZ;
    process.env.TZ = 'America/New_York';
  });
  after(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  it('uses local midnight on the 1st, not UTC', () => {
    // 2026-12-01T03:00Z is still November 30, 22:00 in New York.
    const lateNov = Date.UTC(2026, 11, 1, 3, 0, 0);
    const r = monthRange(lateNov);
    assert.equal(new Date(r.start).toISOString(), '2026-11-01T04:00:00.000Z'); // EDT → UTC-4
    assert.equal(new Date(r.end).toISOString(), '2026-12-01T05:00:00.000Z'); // EST → UTC-5
    assert.ok(lateNov >= r.start && lateNov < r.end);
    // 2026-12-01T05:00Z is exactly local midnight Dec 1 → the next month.
    const dec = monthRange(Date.UTC(2026, 11, 1, 5, 0, 0));
    assert.equal(dec.start, r.end);
  });

  it('wraps December → January', () => {
    const r = monthRange(Date.UTC(2026, 11, 31, 12));
    assert.equal(new Date(r.end).toISOString(), '2027-01-01T05:00:00.000Z');
  });
});
