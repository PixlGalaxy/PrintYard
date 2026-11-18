/**
 * Print start safety (simulator on loopback only, never the real printer):
 * - a print cannot start while the printer is busy (homing / a jog) — Klipper `idle_timeout` or a command just sent;
 * - before every print the bed is lowered a little and the print starts only after that move finished.
 * K2 SE field reports: starting a print right after a home let the printer's pre-print homing drag the nozzle
 * across the bed.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { machineBusyOf } from '../src/printers/k2se/moonraker.js';
import { BED_DROP } from '../src/printers/k2se/live-driver.js';
import { PrinterSimulator, twoObjectGcode } from '../src/printers/sim/simulator.js';
import type { PrintableFile } from '../src/modules/printing/files-source.js';
import { ADMIN, createTestApp, setupBody, type TestApp } from './helpers.js';
import { api, loginCookie, startServer, waitFor, type LiveServer } from './live-helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('machineBusyOf (Klipper idle_timeout)', () => {
  it('busy only when Klipper runs commands outside a print', () => {
    assert.equal(machineBusyOf({ idle_timeout: { state: 'Printing' }, print_stats: { state: 'standby' } }), true);
    assert.equal(machineBusyOf({ idle_timeout: { state: 'Printing' }, print_stats: { state: 'printing' } }), false);
    assert.equal(machineBusyOf({ idle_timeout: { state: 'Printing' }, print_stats: { state: 'paused' } }), false);
    assert.equal(machineBusyOf({ idle_timeout: { state: 'Ready' }, print_stats: { state: 'standby' } }), false);
    assert.equal(machineBusyOf({ idle_timeout: { state: 'Idle' } }), false);
    assert.equal(machineBusyOf({ print_stats: { state: 'standby' } }), null);
  });
});

describe('print start safety (simulator)', () => {
  let t: TestApp;
  let live: LiveServer;
  let sim: PrinterSimulator;
  let dir: string;
  let printerId: number;
  let admin: string;
  const files = new Map<number, PrintableFile>();
  const status = () => t.ctx.printerManager.status(printerId);
  const print = () => api(live.base, admin, 'POST', '/api/prints', { printerId, fileId: 1, confirmBedClear: true });
  const startFrames = () => sim.commands.filter((c) => typeof c.opGcodeFile === 'string' && c.opGcodeFile.startsWith('printprt:'));
  const finish = async () => {
    assert.equal((await api(live.base, admin, 'POST', `/api/printers/${printerId}/cancel`)).status, 200);
    await waitFor(() => !['printing', 'paused', 'stopping'].includes(status().state), 10_000);
    t.ctx.printers.markBedCleared(printerId);
    await waitFor(() => t.ctx.printing.currentOwner(printerId) === null, 10_000);
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sd-start-'));
    sim = new PrinterSimulator({ tickMs: 50, simSecondsPerTick: 1, heatPerTick: 100 });
    sim.holdProgress = true;
    const port = await sim.start();
    t = createTestApp({
      context: {
        printFiles: { get: (id: number) => files.get(id) ?? null },
        printerManager: {
          resolveEndpoint: async (h: string) => (h === 'sim' ? { host: '127.0.0.1', wsPort: port, httpPort: port, moonrakerPort: port } : null),
        },
      },
    });
    await t.agent.post('/api/setup/complete').send(setupBody({ printer: null, exposure: { mode: 'none' } }));
    printerId = (await t.agent.post('/api/admin/printers').send({ name: 'Sim', model: 'creality-k2se', host: 'sim' })).body.id as number;
    t.ctx.printerManager.start();
    live = await startServer(t.ctx);
    admin = await loginCookie(live.base, ADMIN.username, ADMIN.password);
    const gcode = twoObjectGcode(400);
    const path = join(dir, '1.gcode');
    writeFileSync(path, gcode);
    files.set(1, {
      id: 1, ownerId: 1, kind: 'gcode', visibility: 'private', name: 'part.gcode', path, trusted: true,
      sha256: createHash('sha256').update(gcode).digest('hex'),
      gcode: { printSeconds: 1200, filamentGrams: [5], filamentMm: [1600], layers: 100 },
    } as PrintableFile);
    await waitFor(() => status().online && status().state === 'idle' && status().busy === false, 8000);
  });

  after(async () => {
    await live?.close();
    t?.close();
    await sim?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('a print is refused while the printer is homing, and allowed once it is done', async () => {
    sim.homeBusyMs = 4000;
    try {
      assert.equal((await api(live.base, admin, 'POST', `/api/printers/${printerId}/control`, { action: 'home', axes: 'all' })).status, 200);
      await waitFor(() => status().busy === true);
      const r = await print();
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.error.code, 'prints.printer_moving');
      assert.equal(startFrames().length, 0, 'nothing started');
      // still busy after the 3 s "just sent" window: Klipper's idle_timeout is what keeps it busy
      await sleep(3200);
      assert.equal(status().busy, true);
      assert.equal((await print()).status, 409);
      await waitFor(() => status().busy === false, 5000);
    } finally {
      sim.homeBusyMs = 0;
    }
    const ok = await print();
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    await waitFor(() => status().state === 'printing', 10_000);
    await finish();
  });

  it('homed Z: the bed goes down 10 mm (G1 + M400 through Moonraker) and the print starts only after it', async () => {
    await waitFor(() => status().homedAxes === 'xyz' && status().busy === false, 8000);
    const z = status().position![2];
    const m0 = sim.moonGcode.length;
    const s0 = startFrames().length;
    sim.moonScriptDelayMs = 1500; // the move takes a while
    try {
      const pending = print();
      await waitFor(() => sim.moonGcode.length > m0, 15_000);
      const target = Math.round(Math.min(z + BED_DROP.homedMm, BED_DROP.maxZ) * 100) / 100;
      assert.equal(sim.moonGcode[m0], `G90\nG1 Z${target} F600\nM400`);
      await sleep(700);
      assert.equal(startFrames().length, s0, 'the print waits for the bed move');
      const r = await pending;
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(startFrames().length, s0 + 1);
    } finally {
      sim.moonScriptDelayMs = 0;
    }
    await waitFor(() => status().state === 'printing', 10_000);
    await finish();
  });

  it('Z not homed: FORCE_MOVE 3 mm (the printer homing macro own safety move)', async () => {
    assert.equal((await api(live.base, admin, 'POST', `/api/printers/${printerId}/control`, { action: 'motors_off' })).status, 200);
    await waitFor(() => !(status().homedAxes ?? '').includes('z') && status().busy === false, 8000);
    const m0 = sim.moonGcode.length;
    const r = await print();
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(sim.moonGcode[m0], `FORCE_MOVE STEPPER=stepper_z DISTANCE=${BED_DROP.unhomedMm} VELOCITY=5`);
    await waitFor(() => status().state === 'printing', 10_000);
    await finish();
  });
});
