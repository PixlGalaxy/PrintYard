import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TempHistoryService, TempRing } from '../src/modules/printing/temp-history.js';
import { factorsOf } from '../src/printers/k2se/moonraker.js';
import { offlineStatus, toPrinterStatus } from '../src/printers/k2se/protocol.js';
import type { PrinterManager } from '../src/printers/manager.js';
import type { PrintersService } from '../src/modules/printers/printers.service.js';
import type { PrinterStatus, TempSample } from '../src/types.js';
import { createTestApp, setupBody } from './helpers.js';

const sample = (t: number, nozzle = 20): TempSample => ({ t, nozzle, nozzleTarget: 0, bed: 21, bedTarget: 0 });

describe('temperature ring buffer', () => {
  it('keeps the newest `capacity` samples in order and filters by time', () => {
    const r = new TempRing(3);
    assert.deepEqual(r.since(0), []);
    assert.equal(r.last(), null);
    for (let i = 1; i <= 5; i++) r.push(sample(i * 1000));
    assert.equal(r.length, 3);
    assert.deepEqual(r.since(0).map((s) => s.t), [3000, 4000, 5000]);
    assert.deepEqual(r.since(4000).map((s) => s.t), [4000, 5000]);
    assert.equal(r.last()?.t, 5000);
    assert.throws(() => new TempRing(0));
  });

  it('samples online printers every interval, keeps 60 min, drops deleted printers', () => {
    let now = 1_000_000;
    const statuses = new Map<number, PrinterStatus>([
      [1, { ...toPrinterStatus(1, { state: 0, nozzleTemp: 200.04, targetNozzleTemp: 210, bedTemp0: 59.96, targetBedTemp0: 60 }, true) }],
      [2, offlineStatus(2)],
    ]);
    let ids = [1, 2];
    const manager = { hasDriver: (id: number) => statuses.has(id), driver: (id: number) => ({ getStatus: () => statuses.get(id)! }) } as unknown as PrinterManager;
    const printers = { list: () => ids.map((id) => ({ id })) } as unknown as PrintersService;
    const h = new TempHistoryService({ manager, printers, now: () => now });
    // 61 minutes of samples every 2 s
    for (let i = 0; i < 1830; i++) {
      h.sampleAll();
      now += 2000;
    }
    const all = h.history(1, 60);
    assert.equal(all.length, 1800); // 60 min / 2 s
    assert.deepEqual(all[0], { t: all[0]!.t, nozzle: 200, nozzleTarget: 210, bed: 60, bedTarget: 60 });
    assert.ok(all.every((s, i) => i === 0 || s.t - all[i - 1]!.t === 2000));
    assert.equal(h.history(1, 10).length, 300);
    assert.equal(h.history(1, 999).length, 1800); // clamped to 60
    assert.deepEqual(h.history(2, 60), []); // offline: no samples
    ids = [2];
    h.sampleAll();
    assert.deepEqual(h.history(1, 60), []);
  });
});

describe('speed / flow factors', () => {
  it('Moonraker gcode_move factors → percent; Creality curFeedratePct/curFlowratePct fallback', () => {
    assert.deepEqual(factorsOf({ gcode_move: { speed_factor: 1.5, extrude_factor: 0.95 } }), { speed: 150, flow: 95 });
    assert.deepEqual(factorsOf({}), { speed: null, flow: null });
    assert.deepEqual(factorsOf({ gcode_move: { speed_factor: 'x', extrude_factor: -1 } }), { speed: null, flow: null });
    const s = toPrinterStatus(1, { state: 0, curFeedratePct: 120, curFlowratePct: 98 }, true);
    assert.equal(s.speedFactor, 120);
    assert.equal(s.flowFactor, 98);
    assert.equal(toPrinterStatus(1, { state: 0 }, true).speedFactor, null);
    assert.equal(offlineStatus(1).flowFactor, null);
  });
});

describe('GET /api/printers/:id/temps', () => {
  it('returns the history (auth required, 404 for unknown printers, minutes validated)', async () => {
    const t = createTestApp();
    try {
      assert.equal((await t.agent.get('/api/printers/1/temps')).status, 401);
      await t.agent.post('/api/setup/complete').send(setupBody({ printer: null, exposure: { mode: 'none' } }));
      const id = (await t.agent.post('/api/admin/printers').send({ name: 'Sim', model: 'creality-k2se', host: 'sim' })).body.id as number;
      t.ctx.tempHistory.record(toPrinterStatus(id, { state: 0, nozzleTemp: 25, targetNozzleTemp: 0, bedTemp0: 24, targetBedTemp0: 0 }, true));
      const r = await t.agent.get(`/api/printers/${id}/temps?minutes=10`);
      assert.equal(r.status, 200);
      assert.equal(r.body.intervalMs, 2000);
      assert.equal(r.body.samples.length, 1);
      assert.equal(r.body.samples[0].nozzle, 25);
      assert.equal((await t.agent.get(`/api/printers/${id}/temps?minutes=0`)).status, 400);
      assert.equal((await t.agent.get(`/api/printers/${id}/temps?minutes=61`)).status, 400);
      assert.equal((await t.agent.get('/api/printers/999/temps')).status, 404);
    } finally {
      t.close();
    }
  });
});
