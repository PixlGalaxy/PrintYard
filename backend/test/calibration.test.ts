import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { PrintableFile } from '../src/modules/printing/files-source.js';
import { PrinterSimulator } from '../src/printers/sim/simulator.js';
import { ADMIN, createTestApp, setupBody, type TestApp } from './helpers.js';
import { api, loginCookie, startServer, waitFor, type LiveServer } from './live-helpers.js';

const GCODE = ['; PrintYard calibration test', 'G28', ';LAYER_CHANGE', 'G1 X10 Y10 E1', ';LAYER_CHANGE', 'G1 X20 Y20 E1', '; estimated printing time (normal mode) = 10m 0s', ''].join('\n');

describe('print calibration (enableSelfTest) and live estimate, against the simulator', () => {
  let t: TestApp;
  let live: LiveServer;
  let sim: PrinterSimulator;
  let dir: string;
  let printerId: number;
  let admin: string;
  let carol: string;
  let carolId: number;

  const status = () => t.ctx.printerManager.status(printerId);
  const waitState = (s: string, ms = 8000) => waitFor(() => status().state === s && status(), ms);
  const finish = async () => {
    // the job must be running on the (simulated) printer before it can be cancelled
    await waitFor(() => ['printing', 'paused'].includes(status().state) && status().currentPrintId !== null, 10_000);
    await api(live.base, admin, 'POST', `/api/printers/${printerId}/cancel`);
    await waitFor(() => status().state === 'aborted' && status().currentPrintId === null, 10_000);
    await api(live.base, admin, 'POST', `/api/printers/${printerId}/bed-cleared`);
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'printyard-cal-'));
    const gpath = join(dir, 'cube.gcode');
    writeFileSync(gpath, GCODE);
    const sha = createHash('sha256').update(GCODE).digest('hex');
    // slow heating so the heating/preparing phases are observable
    sim = new PrinterSimulator({ tickMs: 25, simSecondsPerTick: 10, heatPerTick: 20 });
    const port = await sim.start();
    const files = new Map<number, PrintableFile>();
    t = createTestApp({
      context: {
        printFiles: { get: (id) => files.get(id) ?? null },
        printerManager: { resolveEndpoint: async (h) => (h === 'sim' ? { host: '127.0.0.1', wsPort: port, httpPort: port, moonrakerPort: port } : null) },
      },
    });
    await t.agent.post('/api/setup/complete').send(setupBody({ printer: null, exposure: { mode: 'none' } }));
    carolId = (await t.agent.post('/api/admin/users').send({ username: 'carol', password: 'carol-password-1', role: 'user' })).body.id;
    files.set(1, {
      id: 1, ownerId: carolId, kind: 'gcode', visibility: 'private', name: 'Cube.gcode', path: gpath, trusted: true, sha256: sha,
      gcode: { printSeconds: 600, filamentGrams: [5], filamentMm: [1600], layers: 2 },
    });
    printerId = (await t.agent.post('/api/admin/printers').send({ name: 'Sim', model: 'creality-k2se', host: 'sim' })).body.id;
    t.ctx.printerManager.start();
    live = await startServer(t.ctx);
    admin = await loginCookie(live.base, ADMIN.username, ADMIN.password);
    carol = await loginCookie(live.base, 'carol', 'carol-password-1');
    await waitState('idle');
  });

  after(async () => {
    await live?.close();
    t?.close();
    await sim?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to no calibration (setting printing.calibrateByDefault = false); the estimate survives heating', async () => {
    assert.equal((await api(live.base, '', 'GET', '/api/config')).body.printing.calibrateByDefault, false);
    const res = await api(live.base, carol, 'POST', '/api/prints', { printerId, fileId: 1 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.calibrate, false);
    assert.ok(/gcodes[/]Cube_p[0-9]+[.]gcode$/.test(sim.lastStart!.path), sim.lastStart!.path);
    assert.equal(sim.lastStart!.enableSelfTest, 0);

    const heating = await waitFor(() => status().estimate?.phase === 'heating' && status().estimate);
    assert.equal(heating.source, 'slicer');
    assert.ok(heating.remainingSec! > 600, String(heating.remainingSec)); // slicer 600 s + heat-up + preparation
    assert.ok(heating.finishesAt! > Date.now());
    const printing = await waitFor(() => status().estimate?.phase === 'printing' && status().estimate, 10_000);
    assert.ok(printing.remainingSec! > 0);
    await finish();
    assert.equal(status().estimate ?? null, null);
  });

  it('calibrate: true → enableSelfTest 1, the simulator calibrates (withSelfTest) and the ETA shows preparing', async () => {
    const res = await api(live.base, carol, 'POST', '/api/prints', { printerId, fileId: 1, calibrate: true });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.calibrate, true);
    assert.ok(/gcodes[/]Cube_p[0-9]+[.]gcode$/.test(sim.lastStart!.path), sim.lastStart!.path);
    assert.equal(sim.lastStart!.enableSelfTest, 1);
    assert.deepEqual(sim.commands.at(-1), { opGcodeFile: `printprt:${sim.lastStart!.path}`, enableSelfTest: 1 });
    const prep = await waitFor(() => status().estimate?.phase === 'preparing' && status().estimate, 10_000);
    assert.ok(prep.remainingSec! > 600);
    await finish();
  });

  it('the admin default applies when the request does not say; approval keeps (or overrides) the choice', async () => {
    t.ctx.settings.patch({ 'printing.calibrateByDefault': true });
    const admins = await t.agent.get('/api/admin/settings');
    assert.equal(admins.body['printing.calibrateByDefault'], true); // exposed in admin settings
    await t.agent.put(`/api/admin/users/${carolId}/limits`).send({
      enabled: true, maxGramsPerPrint: null, maxGramsPerMonth: null, maxHoursPerPrint: null, requiresApproval: true,
    });
    const pending = await api(live.base, carol, 'POST', '/api/prints', { printerId, fileId: 1 });
    assert.equal(pending.status, 202);
    assert.equal(pending.body.calibrate, true); // default captured at request time
    const approved = await api(live.base, admin, 'POST', `/api/prints/${pending.body.id}/approve`, { calibrate: false });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.calibrate, false, JSON.stringify(approved.body));
    assert.equal(sim.lastStart?.enableSelfTest, 0);
    await finish();

    const p2 = await api(live.base, carol, 'POST', '/api/prints', { printerId, fileId: 1, calibrate: false });
    assert.equal(p2.status, 202, JSON.stringify(p2.body));
    assert.equal(p2.body.calibrate, false);
    const a2 = await api(live.base, admin, 'POST', `/api/prints/${p2.body.id}/approve`, {});
    assert.equal(a2.body.calibrate, false, JSON.stringify(a2.body)); // the requester's explicit choice passes through approval
    assert.equal(sim.lastStart?.enableSelfTest, 0);
    await finish();

    assert.equal((await api(live.base, carol, 'POST', '/api/prints', { printerId, fileId: 1, calibrate: 'yes' })).status, 400);
    t.ctx.settings.patch({ 'printing.calibrateByDefault': false });
  });
});
