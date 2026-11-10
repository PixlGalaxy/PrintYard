/**
 * Printer control / job tracking audit (simulator on loopback only, never the real printer):
 * - a motion command is re-validated after its fresh-state round trip (bed occupied / print dispatching meanwhile);
 * - a tracked print replaced by another job on the printer is released promptly.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import WebSocket from 'ws';
import { CrealityK2SEDriver } from '../src/printers/drivers/creality-k2se.js';
import type { ControlTelemetry } from '../src/printers/drivers/types.js';
import { PrinterSimulator, twoObjectGcode } from '../src/printers/sim/simulator.js';
import type { PrintableFile } from '../src/modules/printing/files-source.js';
import { ADMIN, createTestApp, setupBody, type TestApp } from './helpers.js';
import { api, loginCookie, startServer, waitFor, type LiveServer } from './live-helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs before each `controlTelemetry` (a slow Moonraker / status round trip). */
let telemetryHook: (() => Promise<void>) | null = null;

class SlowTelemetryDriver extends CrealityK2SEDriver {
  override async controlTelemetry(maxAgeMs: number, notBefore = 0): Promise<ControlTelemetry> {
    const hook = telemetryHook;
    if (hook) await hook();
    return super.controlTelemetry(maxAgeMs, notBefore);
  }
}

describe('printer control and job tracking (simulator)', () => {
  let t: TestApp;
  let live: LiveServer;
  let sim: PrinterSimulator;
  let dir: string;
  let printerId: number;
  let simPort: number;
  let admin: string;
  let bob: string;
  let bobId: number;
  const files = new Map<number, PrintableFile>();
  const status = () => t.ctx.printerManager.status(printerId);
  const control = (c: string, body: unknown) => api(live.base, c, 'POST', `/api/printers/${printerId}/control`, body);
  const resetRate = () => (t.ctx.printerControl as unknown as { hits: Map<string, number[]> }).hits.clear();

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sd-audit-'));
    sim = new PrinterSimulator({ tickMs: 50, simSecondsPerTick: 10, heatPerTick: 100 });
    const port = await sim.start();
    simPort = port;
    const resolveEndpoint = async (h: string) => (h === 'sim' ? { host: '127.0.0.1', wsPort: port, httpPort: port, moonrakerPort: port } : null);
    t = createTestApp({
      context: {
        printFiles: { get: (id: number) => files.get(id) ?? null },
        printerManager: {
          resolveEndpoint,
          createDriver: (p, resolve) => new SlowTelemetryDriver({ printerId: p.id, host: p.host, resolveEndpoint: resolve }),
        },
      },
    });
    await t.agent.post('/api/setup/complete').send(setupBody({ printer: null, exposure: { mode: 'none' } }));
    printerId = (await t.agent.post('/api/admin/printers').send({ name: 'Sim', model: 'creality-k2se', host: 'sim' })).body.id as number;
    t.ctx.printerManager.start();
    live = await startServer(t.ctx);
    admin = await loginCookie(live.base, ADMIN.username, ADMIN.password);
    bobId = (await t.agent.post('/api/admin/users').send({ username: 'bob', password: 'bob-password-12', role: 'user' })).body.id;
    bob = await loginCookie(live.base, 'bob', 'bob-password-12');
    const gcode = twoObjectGcode(400) + '\n; estimated printing time (normal mode) = 300m 0s\n';
    const path = join(dir, '1.gcode');
    writeFileSync(path, gcode);
    files.set(1, {
      id: 1, ownerId: bobId, kind: 'gcode', visibility: 'private', name: 'bob.gcode', path, trusted: true,
      sha256: createHash('sha256').update(gcode).digest('hex'),
      gcode: { printSeconds: 1200, filamentGrams: [5], filamentMm: [1600], layers: 100 },
    } as PrintableFile);
    await waitFor(() => status().online && status().state === 'idle' && status().homedAxes !== null, 8000);
    assert.equal((await control(admin, { action: 'home', axes: 'all' })).status, 200);
    await waitFor(() => status().homedAxes === 'xyz');
    await sleep(900);
  });

  after(async () => {
    telemetryHook = null;
    await live?.close();
    t?.close();
    await sim?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('a jog is refused when the bed becomes occupied while its state is being refreshed', async () => {
    resetRate();
    const n0 = sim.gcodeLog.length;
    telemetryHook = async () => {
      telemetryHook = null;
      // A print ended (or another session marked it) while this jog waited for fresh telemetry.
      t.ctx.printers.markBedOccupied(printerId, null);
      await sleep(50);
    };
    const r = await control(admin, { action: 'jog', axis: 'x', distance: 5, feedrate: 3000 });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error.code, 'printers.bed_not_cleared');
    await sleep(150);
    assert.equal(sim.gcodeLog.length, n0, `sent: ${JSON.stringify(sim.gcodeLog.slice(n0))}`);
    assert.equal((await api(live.base, admin, 'POST', `/api/printers/${printerId}/bed-cleared`)).status, 200);
  });

  it('a jog is refused when a print starts being sent while its state is being refreshed', async () => {
    resetRate();
    t.ctx.printers.markBedCleared(printerId);
    await sleep(300);
    const n0 = sim.gcodeLog.length;
    sim.uploadBytesPerSec = 100 * 1024;
    let started: ReturnType<typeof api> | null = null;
    telemetryHook = async () => {
      telemetryHook = null;
      started = api(live.base, bob, 'POST', '/api/prints', { printerId, fileId: 1 });
      await waitFor(() => t.ctx.printing.dispatchOwner(printerId) === bobId, 5000);
    };
    const r = await control(admin, { action: 'jog', axis: 'y', distance: 5, feedrate: 3000 });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error.code, 'printers.control_busy');
    assert.ok(!sim.gcodeLog.slice(n0).some((g) => g.includes('G1 Y')), `sent: ${JSON.stringify(sim.gcodeLog.slice(n0))}`);
    sim.uploadBytesPerSec = 0;
    const created = await started!;
    assert.equal(created.status, 201, JSON.stringify(created.body));
    await waitFor(() => status().state === 'printing', 10_000);
    assert.equal((await api(live.base, admin, 'POST', `/api/printers/${printerId}/cancel`)).status, 200);
    await waitFor(() => !['printing', 'paused', 'stopping'].includes(status().state), 10_000);
  });

  it('a tracked print replaced by another job on the printer is released (its owner cannot control the new job)', async () => {
    resetRate();
    await waitFor(() => t.ctx.printing.currentOwner(printerId) === null && status().state !== 'printing', 10_000);
    t.ctx.printers.markBedCleared(printerId);
    // As after a SliceDock restart: Bob's print is still "printing" in the DB and tracked again by attach(),
    // but meanwhile it ended and somebody started another file on the touchscreen.
    const row = t.ctx.db.prepare('SELECT id, printer_path, started_at FROM prints WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(bobId) as {
      id: number;
      printer_path: string;
      started_at: number;
    };
    t.ctx.db.prepare(`UPDATE prints SET state = 'printing', reason = NULL, ended_at = NULL WHERE id = ?`).run(row.id);
    (t.ctx.printing as unknown as { tracking: Map<number, unknown> }).tracking.set(printerId, {
      jobId: row.id,
      userId: bobId,
      expectName: row.printer_path.split('/').pop(),
      startedAt: row.started_at,
      seenActive: true,
      lastProgress: null,
      cancelledBy: null,
    });
    sim.addStoredFile('touchscreen_job.gcode', Buffer.from(twoObjectGcode(50)), 3000);
    const entry = (await t.ctx.printerManager.driver(printerId).listFiles())!.find((f) => f.name === 'touchscreen_job.gcode')!;
    const ws = new WebSocket(`ws://127.0.0.1:${simPort}`);
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ method: 'set', params: { opGcodeFile: `printprt:${entry.path}`, enableSelfTest: 0 } }));
    ws.close();
    await waitFor(() => status().state === 'printing' && status().fileName === 'touchscreen_job.gcode', 10_000);
    // terminal-state debounce in tests: 200 ms; give it several rounds
    await waitFor(() => t.ctx.printing.currentOwner(printerId) === null, 3000).catch(() => null);
    assert.equal(t.ctx.printing.currentOwner(printerId), null, 'tracking released');
    const ended = t.ctx.db.prepare('SELECT state, reason FROM prints WHERE id = ?').get(row.id) as { state: string; reason: string };
    assert.deepEqual({ ...ended }, { state: 'cancelled', reason: 'replaced_on_printer' });
    const r = await api(live.base, bob, 'POST', `/api/printers/${printerId}/pause`);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error.code, 'prints.not_owner');
    assert.equal((await api(live.base, admin, 'POST', `/api/printers/${printerId}/cancel`)).status, 200);
    await waitFor(() => !['printing', 'paused', 'stopping'].includes(status().state), 10_000);
  });
});
