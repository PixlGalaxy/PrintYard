/**
 * Regression tests for the phase-3 review B findings (status/phase3-review-b.md, exploits X1–X8) and review A #6
 * (printer retention must never delete a printer file PrintYard did not upload). Simulator on loopback only.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { CrealityK2SEDriver } from '../src/printers/drivers/creality-k2se.js';
import { printerUploadName, safePrinterFileName } from '../src/printers/k2se/protocol.js';
import { PrinterSimulator, twoObjectGcode } from '../src/printers/sim/simulator.js';
import type { PrintableFile } from '../src/modules/printing/files-source.js';
import { ADMIN, createTestApp, setupBody, type TestApp } from './helpers.js';
import { api, loginCookie, startServer, waitFor, type LiveServer } from './live-helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const N = String.fromCharCode(10);

interface World {
  t: TestApp;
  live: LiveServer;
  sim: PrinterSimulator;
  dir: string;
  printerId: number;
  admin: string;
  files: Map<number, PrintableFile>;
}

async function world(opts: { simSecondsPerTick: number; driver?: Record<string, number> }): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'sd-safety-'));
  const sim = new PrinterSimulator({ tickMs: 50, simSecondsPerTick: opts.simSecondsPerTick, heatPerTick: 100 });
  const port = await sim.start();
  const files = new Map<number, PrintableFile>();
  const resolveEndpoint = async (h: string) => (h === 'sim' ? { host: '127.0.0.1', wsPort: port, httpPort: port, moonrakerPort: port } : null);
  const t = createTestApp({
    context: {
      printFiles: { get: (id: number) => files.get(id) ?? null },
      printerManager: {
        resolveEndpoint,
        createDriver: (p, resolve) => new CrealityK2SEDriver({ printerId: p.id, host: p.host, resolveEndpoint: resolve, ...opts.driver }),
      },
    },
  });
  await t.agent.post('/api/setup/complete').send(setupBody({ printer: null, exposure: { mode: 'none' } }));
  const printerId = (await t.agent.post('/api/admin/printers').send({ name: 'Sim', model: 'creality-k2se', host: 'sim' })).body.id as number;
  t.ctx.printerManager.start();
  const live = await startServer(t.ctx);
  const admin = await loginCookie(live.base, ADMIN.username, ADMIN.password);
  await waitFor(() => {
    const s = t.ctx.printerManager.status(printerId);
    return s.online && s.state === 'idle' && s.homedAxes !== null;
  }, 20_000);
  return { t, live, sim, dir, printerId, admin, files };
}

async function closeWorld(w: World | undefined): Promise<void> {
  await w?.live.close();
  w?.t.close();
  await w?.sim.stop();
  if (w) rmSync(w.dir, { recursive: true, force: true });
}

function addGcode(w: World, id: number, ownerId: number, name: string, gcode: string | Buffer): void {
  const path = join(w.dir, `${id}.gcode`);
  writeFileSync(path, gcode);
  w.files.set(id, {
    id, ownerId, kind: 'gcode', visibility: 'private', name, path, trusted: true,
    sha256: createHash('sha256').update(gcode).digest('hex'),
    gcode: { printSeconds: 1200, filamentGrams: [5], filamentMm: [1600], layers: 100 },
  } as PrintableFile);
}

describe('phase 3 safety: printer controls (simulator)', () => {
  let w: World;
  let alice: string;
  let bob: string;
  let bobId: number;
  const status = () => w.t.ctx.printerManager.status(w.printerId);
  const control = (c: string, body: unknown) => api(w.live.base, c, 'POST', `/api/printers/${w.printerId}/control`, body);
  const ex = (c: string, name: string) => api(w.live.base, c, 'POST', `/api/printers/${w.printerId}/exclude-object`, { name });
  const audit = (action: string) => (w.t.ctx.audit.list(1000) as { action: string; meta?: Record<string, unknown> }[]).filter((e) => e.action === action);
  /** The control rate limit (20 / 10 s) is not what these tests are about. */
  const resetRate = () => (w.t.ctx.printerControl as unknown as { hits: Map<string, number[]> }).hits.clear();
  const settle = () => sleep(900);
  const homeAll = async () => {
    const r = await control(w.admin, { action: 'home', axes: 'all' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await waitFor(() => status().homedAxes === 'xyz');
    await settle();
  };

  before(async () => {
    w = await world({ simSecondsPerTick: 10 });
    const aliceId = (await w.t.agent.post('/api/admin/users').send({ username: 'alice', password: 'alice-password-1', role: 'user' })).body.id;
    bobId = (await w.t.agent.post('/api/admin/users').send({ username: 'bob', password: 'bob-password-12', role: 'user' })).body.id;
    await api(w.live.base, w.admin, 'PATCH', `/api/admin/users/${aliceId}`, { canControlPrinter: true });
    await api(w.live.base, w.admin, 'PATCH', `/api/admin/users/${bobId}`, { canControlPrinter: true });
    alice = await loginCookie(w.live.base, 'alice', 'alice-password-1');
    bob = await loginCookie(w.live.base, 'bob', 'bob-password-12');
    addGcode(w, 1, bobId, 'bob two.gcode', twoObjectGcode(400) + '\n; estimated printing time (normal mode) = 300m 0s\n');
  });
  after(() => closeWorld(w));

  it('X1: while another user uploads/prints, heaters, fan, speed and flow are owner/admin only; motion is blocked during the upload', async () => {
    w.sim.uploadBytesPerSec = 40 * 1024; // keep the upload running for a moment
    const started = api(w.live.base, bob, 'POST', '/api/prints', { printerId: w.printerId, fileId: 1 });
    await waitFor(() => w.t.ctx.printing.dispatchOwner(w.printerId) === bobId, 5000);
    let r = await control(alice, { action: 'jog', axis: 'x', distance: 1, feedrate: 600 });
    assert.equal(r.body.error.code, 'printers.control_busy');
    r = await control(alice, { action: 'home', axes: 'all' });
    assert.equal(r.body.error.code, 'printers.control_busy');
    r = await control(alice, { action: 'temp', heater: 'nozzle', target: 0 });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'printers.forbidden_job');
    const created = await started;
    w.sim.uploadBytesPerSec = 0;
    assert.equal(created.status, 201, JSON.stringify(created.body));
    await waitFor(() => status().state === 'printing', 10_000);

    const n0 = w.sim.gcodeLog.length;
    for (const body of [
      { action: 'temp', heater: 'nozzle', target: 0 },
      { action: 'temp', heater: 'bed', target: 0 },
      { action: 'flow_factor', percent: 50 },
      { action: 'speed_factor', percent: 300 },
      { action: 'fan', percent: 0 },
    ]) {
      r = await control(alice, body);
      assert.equal(r.status, 403, JSON.stringify(body));
      assert.equal(r.body.error.code, 'printers.forbidden_job');
    }
    assert.equal(w.sim.gcodeLog.length, n0, 'nothing reached the printer');
    // the light stays open; the owner and admins may tune
    assert.equal((await control(alice, { action: 'light', on: true })).status, 200);
    assert.equal((await control(bob, { action: 'fan', percent: 60 })).status, 200);
    assert.equal((await control(w.admin, { action: 'speed_factor', percent: 100 })).status, 200);
    assert.ok(audit('printer.control_refused').some((e) => e.meta?.code === 'printers.forbidden_job'));
  });

  it('X2: parallel / duplicate excludes cannot remove every object', async () => {
    const objs = await waitFor(() => (status().job?.objects.length === 2 ? status().job!.objects : null), 20_000);
    assert.equal((await ex(alice, objs[0]!.name)).status, 403);
    resetRate();
    const res = await Promise.all([ex(bob, objs[0]!.name), ex(bob, objs[0]!.name), ex(bob, objs[1]!.name)]);
    const codes = res.map((r) => (r.status === 200 ? 'ok' : r.body.error.code)).sort();
    assert.deepEqual(codes, ['exclude.already_excluded', 'exclude.last_object', 'ok'], JSON.stringify(codes));
    assert.equal(w.sim.excluded.length, 1);
    assert.equal((await api(w.live.base, w.admin, 'POST', `/api/printers/${w.printerId}/cancel`)).status, 200);
    await waitFor(() => !['printing', 'paused', 'stopping'].includes(status().state), 10_000);
  });

  it('X3: with the last print on the bed, home / jog / extrude are refused (printers.bed_not_cleared)', async () => {
    resetRate();
    await waitFor(() => status().bedClear === false, 5000);
    const n0 = w.sim.gcodeLog.length;
    for (const body of [
      { action: 'home', axes: 'all' },
      { action: 'home', axes: 'z' },
      { action: 'jog', axis: 'x', distance: 50, feedrate: 12000 },
      { action: 'jog', axis: 'z', distance: -1, feedrate: 600 },
      { action: 'extrude', length: 5, speed: 5 },
    ]) {
      const r = await control(alice, body);
      assert.equal(r.status, 409, JSON.stringify(body));
      assert.equal(r.body.error.code, 'printers.bed_not_cleared');
    }
    assert.equal((await control(w.admin, { action: 'home', axes: 'all' })).body.error.code, 'printers.bed_not_cleared');
    assert.equal(w.sim.gcodeLog.length, n0);
    assert.ok(audit('printer.control_refused').some((e) => e.meta?.code === 'printers.bed_not_cleared'));
    assert.equal((await api(w.live.base, w.admin, 'POST', `/api/printers/${w.printerId}/bed-cleared`)).status, 200);
  });

  it('X4: jogs are absolute and validated against the expected position (parallel and rapid clicks)', async () => {
    resetRate();
    await homeAll();
    let r = await control(alice, { action: 'jog', axis: 'z', distance: 10, feedrate: 900 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await waitFor(() => w.sim.gcodeLog.at(-1) === `G90${N}G1 Z10 F900`);
    const n0 = w.sim.gcodeLog.length;
    const [a, b] = await Promise.all([
      control(alice, { action: 'jog', axis: 'z', distance: -10, feedrate: 900 }),
      control(alice, { action: 'jog', axis: 'z', distance: -10, feedrate: 900 }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal((a.status === 409 ? a : b).body.error.code, 'printers.out_of_range');
    await sleep(200);
    assert.deepEqual(w.sim.gcodeLog.slice(n0), [`G90${N}G1 Z0 F900`]);
    assert.equal(w.sim.relativeMode, false);
    // three rapid +50 X clicks from X=110: the third (→ 260) is refused before any position report
    const xs = [];
    for (let i = 0; i < 3; i++) xs.push(await control(alice, { action: 'jog', axis: 'x', distance: 50, feedrate: 12000 }));
    assert.deepEqual(xs.map((x) => x.status), [200, 200, 409]);
    await sleep(200);
    assert.ok(w.sim.gcodeLog.includes(`G90${N}G1 X160 F12000`) && w.sim.gcodeLog.includes(`G90${N}G1 X210 F12000`));
    assert.ok(!w.sim.gcodeLog.some((g) => g.includes('G91')), 'never relative mode');
  });

  it('X5: stale or dropped links refuse motion (printers.state_stale); motors off needs a fresh homing report', async () => {
    resetRate();
    await homeAll();
    // Moonraker down (websocket killed, HTTP 503): no frozen homing/position is trusted
    w.sim.moonrakerDown = true;
    w.sim.dropMoonraker();
    await sleep(100);
    let r = await control(alice, { action: 'jog', axis: 'x', distance: 10, feedrate: 6000 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'printers.state_stale');
    r = await control(alice, { action: 'home', axes: 'all' });
    assert.equal(r.body.error.code, 'printers.state_stale');
    w.sim.moonrakerDown = false;

    // motors off un-homes locally right away; the fresh report then says unhomed too
    assert.equal((await control(alice, { action: 'motors_off' })).status, 200);
    r = await control(alice, { action: 'jog', axis: 'x', distance: 10, feedrate: 6000 });
    assert.equal(r.body.error.code, 'printers.not_homed');
    await settle();
    r = await control(alice, { action: 'jog', axis: 'x', distance: 10, feedrate: 6000 });
    assert.equal(r.body.error.code, 'printers.not_homed');

    // a frozen Creality link (no frames, status requests ignored) is stale after ~3 s
    resetRate();
    await homeAll();
    w.sim.freezeCrealityWs = true;
    await sleep(3300);
    r = await control(alice, { action: 'jog', axis: 'x', distance: 1, feedrate: 600 });
    assert.equal(r.body.error.code, 'printers.state_stale');
    w.sim.freezeCrealityWs = false;
    await sleep(100);
    r = await control(alice, { action: 'jog', axis: 'x', distance: 1, feedrate: 600 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  it('X6: bed max = min(K2 SE spec 100 °C, printer), nozzle max = min(profile, printer, 300)', async () => {
    resetRate();
    assert.equal(status().maxBedTemp, 100); // the simulator reports 115
    assert.equal(status().maxNozzleTemp, 280); // CR-ABS profile high; printer 320
    let r = await control(alice, { action: 'temp', heater: 'bed', target: 101 });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'printers.temp_out_of_range');
    assert.equal((await control(alice, { action: 'temp', heater: 'bed', target: 100 })).status, 200);
    r = await control(alice, { action: 'temp', heater: 'nozzle', target: 281 });
    assert.equal(r.body.error.code, 'printers.temp_out_of_range');
    assert.equal((await control(alice, { action: 'temp', heater: 'bed', target: 0 })).status, 200);
  });

  it('X7: values that round to nothing are refused by the schema; extrusion never changes M82/M83', async () => {
    resetRate();
    const raw = async (body: string) =>
      (await fetch(`${w.live.base}/api/printers/${w.printerId}/control`, { method: 'POST', headers: { Cookie: alice, 'Content-Type': 'application/json' }, body })).status;
    for (const body of [
      '{"action":"jog","axis":"x","distance":1e309,"feedrate":600}',
      '{"action":"jog","axis":"x","distance":-0,"feedrate":600}',
      '{"action":"jog","axis":"x","distance":1e-9,"feedrate":600}',
      '{"action":"jog","axis":"x","distance":0.001,"feedrate":600}',
      '{"action":"jog","axis":"x","distance":1,"feedrate":1e-300}',
      '{"action":"jog","axis":"x","distance":1,"feedrate":59}',
      '{"action":"extrude","length":1,"speed":1e-9}',
      '{"action":"extrude","length":0.001,"speed":5}',
      '{"action":"temp","heater":"nozzle","target":"200"}',
    ]) {
      assert.equal(await raw(body), 400, body);
    }
    assert.equal((await control(alice, { action: 'temp', heater: 'nozzle', target: 200 })).status, 200);
    await waitFor(() => (status().nozzleTemp ?? 0) >= 199, 5000);
    const r = await control(alice, { action: 'extrude', length: 5, speed: 5 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await waitFor(() => w.sim.gcodeLog.at(-1) === `G92 E0${N}G1 E5 F300${N}G92 E0`);
    assert.equal((await control(alice, { action: 'temp', heater: 'nozzle', target: 0 })).status, 200);
  });

  it('X8: printer-side names are unique per print and never traverse', () => {
    assert.notEqual(printerUploadName('a b.gcode', 1), printerUploadName('a_b.gcode', 2));
    assert.equal(safePrinterFileName('a b.gcode'), safePrinterFileName('a_b.gcode')); // why the id is needed
    assert.equal(printerUploadName('../../etc/passwd.gcode', 3), 'etc_passwd_p3.gcode');
    assert.equal(printerUploadName('a"b;printprt:/x.gcode', 4), 'a_b_printprt_x_p4.gcode');
    assert.equal(printerUploadName('Cube.gcode', 5, 'ab12'), 'Cube_p5_ab12.gcode');
    assert.ok(printerUploadName('x'.repeat(300) + '.gcode', 6).length <= 80);
  });

  it('idle heater safety: heaters left on while idle are switched off, audited and notified', async () => {
    resetRate();
    const svc = w.t.ctx.printerControl as unknown as { lastAction: Map<number, number>; heatingSince: Map<number, number> };
    const notified: unknown[] = [];
    const emit = w.t.ctx.notifications.emit.bind(w.t.ctx.notifications);
    w.t.ctx.notifications.emit = ((type: string, data: unknown) => {
      if (type === 'printer.heaters_auto_off') notified.push(data);
      return emit(type as never, data as never);
    }) as typeof w.t.ctx.notifications.emit;
    assert.equal(w.t.ctx.settings.get('printers.idleHeaterOffMinutes'), 15);
    assert.equal((await control(alice, { action: 'temp', heater: 'bed', target: 60 })).status, 200);
    await waitFor(() => status().bedTarget === 60);
    assert.deepEqual(await w.t.ctx.printerControl.checkIdleHeaters(), []); // just set
    const old = Date.now() - 16 * 60_000;
    svc.lastAction.set(w.printerId, old);
    svc.heatingSince.set(w.printerId, old);
    assert.deepEqual(await w.t.ctx.printerControl.checkIdleHeaters(), [w.printerId]);
    await waitFor(() => w.sim.gcodeLog.at(-1) === `M104 S0${N}M140 S0`);
    await waitFor(() => status().bedTarget === 0);
    assert.equal(audit('printer.heaters_auto_off').length, 1);
    assert.equal(notified.length, 1);
    // disabled with 0
    w.t.ctx.settings.patch({ 'printers.idleHeaterOffMinutes': 0 });
    assert.equal((await control(alice, { action: 'temp', heater: 'bed', target: 50 })).status, 200);
    svc.lastAction.set(w.printerId, old);
    assert.deepEqual(await w.t.ctx.printerControl.checkIdleHeaters(), []);
    assert.equal((await control(alice, { action: 'temp', heater: 'bed', target: 0 })).status, 200);
  });
});

describe('phase 3 safety: upload verification, stall timeout, retention (simulator)', () => {
  let w: World;
  const status = () => w.t.ctx.printerManager.status(w.printerId);
  const print = (fileId: number) => api(w.live.base, w.admin, 'POST', '/api/prints', { printerId: w.printerId, fileId, confirmBedClear: true });
  const finishAndClear = async () => {
    await api(w.live.base, w.admin, 'POST', `/api/printers/${w.printerId}/cancel`);
    await waitFor(() => !['printing', 'paused', 'stopping'].includes(status().state), 10_000);
    await waitFor(() => status().currentPrintId === null, 10_000);
    await api(w.live.base, w.admin, 'POST', `/api/printers/${w.printerId}/bed-cleared`);
  };

  before(async () => {
    w = await world({ simSecondsPerTick: 1, driver: { fileReadyTimeoutMs: 1500, uploadStallMs: 300, uploadAnswerMs: 800 } });
    addGcode(w, 1001, 1, 'calibration_cube.gcode', twoObjectGcode(30)); // id far from the real library ids below
  });
  after(() => closeWorld(w));

  it('review A #6: an upload named like a printer file never overwrites it, and retention deletes only verified PrintYard uploads', async () => {
    w.t.ctx.settings.patch({ 'printers.retention.keep': 1 });
    const original = w.sim.fileSize('calibration_cube.gcode');
    assert.ok(original);
    const first = await print(1001);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const firstName = `calibration_cube_p${first.body.id}.gcode`;
    assert.ok(w.sim.fileNames().includes(firstName));
    assert.equal(w.sim.fileSize('calibration_cube.gcode'), original, 'the touchscreen file was not overwritten');
    await waitFor(() => status().state === 'printing', 20_000);
    await finishAndClear();

    const second = await print(1001);
    assert.equal(second.status, 201, JSON.stringify(second.body));
    const r2 = (await w.t.ctx.printing.lastRetention) as { deleted: string[]; kept: { path: string; reason: string }[] };
    assert.deepEqual(r2.deleted.map((p) => p.split('/').pop()), [firstName]);
    assert.ok(w.sim.fileNames().includes('calibration_cube.gcode'));
    assert.equal(w.sim.fileSize('calibration_cube.gcode'), original);
    await waitFor(() => status().state === 'printing', 20_000);
    await finishAndClear();

    // A record whose size no longer matches the printer's file (replaced on the touchscreen) is never deleted.
    const secondName = `calibration_cube_p${second.body.id}.gcode`;
    w.t.ctx.db.prepare('UPDATE printer_uploads SET size = size + 1 WHERE remote_name = ? AND deleted_at IS NULL').run(secondName);
    const third = await print(1001);
    assert.equal(third.status, 201, JSON.stringify(third.body));
    const r3 = (await w.t.ctx.printing.lastRetention) as { deleted: string[]; kept: { path: string; reason: string }[] };
    assert.deepEqual(r3.deleted, []);
    assert.ok(r3.kept.some((k) => k.path.endsWith(secondName) && k.reason === 'unverified'), JSON.stringify(r3));
    assert.ok(w.sim.fileNames().includes(secondName));
    await waitFor(() => status().state === 'printing', 20_000);
    await finishAndClear();
  });

  it('an upload the printer does not list with the exact size fails (prints.upload_unverified) and is not started', async () => {
    w.sim.misreportUploadSize = true;
    const starts = w.sim.commands.filter((c) => typeof c.opGcodeFile === 'string' && c.opGcodeFile.startsWith('printprt:')).length;
    try {
      const r = await print(1001);
      assert.equal(r.status, 502, JSON.stringify(r.body));
      assert.equal(r.body.error.code, 'prints.upload_unverified');
    } finally {
      w.sim.misreportUploadSize = false;
    }
    assert.equal(w.sim.commands.filter((c) => typeof c.opGcodeFile === 'string' && c.opGcodeFile.startsWith('printprt:')).length, starts);
    const job = (await api(w.live.base, w.admin, 'GET', '/api/prints?scope=mine')).body.items?.[0] ?? null;
    if (job) assert.equal(job.state, 'failed');
  });

  it('a stalled printer upload is aborted quickly instead of holding the dispatch for 15 minutes', async () => {
    w.sim.stallUploads = true;
    const t0 = Date.now();
    try {
      const r = await print(1001);
      assert.equal(r.status, 502, JSON.stringify(r.body));
      assert.equal(r.body.error.code, 'prints.upload_failed');
    } finally {
      w.sim.stallUploads = false;
    }
    assert.ok(Date.now() - t0 < 10_000);
    assert.equal(w.t.ctx.printing.dispatchOwner(w.printerId), undefined);
  });

  it('exclude object: Creality excludeObjects frame, Moonraker fallback, never success without confirmation', async () => {
    const ex = (name: string) => api(w.live.base, w.admin, 'POST', `/api/printers/${w.printerId}/exclude-object`, { name });
    await w.t.ctx.printerManager.driver(w.printerId).startPrint('/usr/data/printer_data/gcodes/two_cubes.gcode');
    const objs = await waitFor(() => (status().state === 'printing' && status().job?.objects.length === 2 ? status().job!.objects : null), 20_000);
    // the printer ignores every path → 502 printers.exclude_unconfirmed, nothing shown as excluded
    w.sim.ignoreExcludes = true;
    let r = await ex(objs[0]!.name);
    w.sim.ignoreExcludes = false;
    assert.equal(r.status, 502, JSON.stringify(r.body));
    assert.equal(r.body.error.code, 'printers.exclude_unconfirmed');
    assert.equal(w.sim.excluded.length, 0);
    assert.equal(status().job!.objects.find((o) => o.name === objs[0]!.name)!.excluded, false);
    // still counted for the last-object rule (it may apply late), but the same object can be retried
    assert.equal((await ex(objs[1]!.name)).body.error.code, 'exclude.last_object');
    // the WS frame is ignored this time: the Moonraker gcode/script fallback does it
    w.sim.ignoreExcludeFrame = true;
    r = await ex(objs[0]!.name);
    w.sim.ignoreExcludeFrame = false;
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(w.sim.excluded, [objs[0]!.name.toUpperCase()]);
    assert.ok(w.sim.moonGcode.includes(`EXCLUDE_OBJECT NAME=${objs[0]!.name.toUpperCase()}`));
    assert.ok(w.sim.commands.some((c) => JSON.stringify(c.excludeObjects) === JSON.stringify([objs[0]!.name.toUpperCase()])));
    assert.ok(!w.sim.gcodeLog.some((g) => g.startsWith('EXCLUDE_OBJECT')), 'gcodeCmd is not used (ignored mid-print by the K2 SE)');
    await api(w.live.base, w.admin, 'POST', `/api/printers/${w.printerId}/cancel`);
    await waitFor(() => !['printing', 'paused', 'stopping'].includes(status().state), 10_000);
    await api(w.live.base, w.admin, 'POST', `/api/printers/${w.printerId}/bed-cleared`);
  });

  it('pause glitch: a transient terminal frame while pausing never finalises the print; a finalised-but-running print is healed', async () => {
    const res = await print(1001);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const id = res.body.id as number;
    const row = () => w.t.ctx.db.prepare('SELECT state, reason FROM prints WHERE id = ?').get(id) as { state: string; reason: string | null };
    await waitFor(() => status().state === 'printing', 20_000);
    await sleep(200);
    w.sim.pauseGlitch = true;
    assert.equal((await api(w.live.base, w.admin, 'POST', `/api/printers/${w.printerId}/pause`)).status, 200);
    await waitFor(() => status().state === 'paused', 5000);
    await sleep(600); // > terminalStableMs (200 ms in tests)
    w.sim.pauseGlitch = false;
    assert.equal(row().state, 'printing');
    assert.equal(status().currentPrintId, id);
    assert.equal((await api(w.live.base, w.admin, 'POST', `/api/printers/${w.printerId}/resume`)).status, 200);
    await waitFor(() => status().state === 'printing', 20_000);
    assert.equal(row().state, 'printing');

    // Heal: the row was finalised as cancelled while the same job keeps running → back to printing.
    (w.t.ctx.printing as unknown as { tracking: Map<number, unknown> }).tracking.delete(w.printerId);
    w.t.ctx.db.prepare(`UPDATE prints SET state = 'cancelled', reason = 'cancelled_on_printer', ended_at = ? WHERE id = ?`).run(Date.now(), id);
    await waitFor(() => row().state === 'printing', 20_000);
    assert.equal(row().reason, null);
    await waitFor(() => status().currentPrintId === id, 5000);

    // A real cancel is finalised once stable.
    assert.equal((await api(w.live.base, w.admin, 'POST', `/api/printers/${w.printerId}/cancel`)).status, 200);
    await waitFor(() => row().state === 'cancelled', 8000);
    await api(w.live.base, w.admin, 'POST', `/api/printers/${w.printerId}/bed-cleared`);
  });

  it('deleting library G-code also deletes its verified printer copies (skips unverified / read-only)', async () => {
    const DIRP = '/usr/data/printer_data/gcodes';
    const libUpload = async (name: string) => {
      const r = await w.t.agent.post('/api/files').set('Sec-Fetch-Site', 'same-origin').attach('file', Buffer.from(twoObjectGcode(5)), name);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body.id as number;
    };
    /** A finished PrintYard print of library file `fileId` whose G-code is on the printer. */
    const copyOnPrinter = async (fileId: number, base: string) => {
      const printId = Number(
        w.t.ctx.db
          .prepare(`INSERT INTO prints (user_id, username, printer_id, file_id, file_name, state, created_at) VALUES (1, 'admin', ?, ?, ?, 'done', ?)`)
          .run(w.printerId, fileId, `${base}.gcode`, Date.now()).lastInsertRowid,
      );
      const name = printerUploadName(`${base}.gcode`, printId);
      const local = join(w.dir, name);
      writeFileSync(local, twoObjectGcode(5));
      const { path, size } = await w.t.ctx.printerManager.driver(w.printerId).uploadFile(name, local);
      w.t.ctx.printerRetention.recordUpload(w.printerId, path, printId, size ?? null);
      return name;
    };
    const a = await libUpload('lib a.gcode');
    const b = await libUpload('lib b.gcode');
    const c = await libUpload('lib c.gcode');
    const aName = await copyOnPrinter(a, 'lib_a');
    const bName = await copyOnPrinter(b, 'lib_b');
    const cName = await copyOnPrinter(c, 'lib_c');
    // b's printer file was replaced on the touchscreen (different size): never deleted
    w.t.ctx.db.prepare('UPDATE printer_uploads SET size = size + 7 WHERE remote_name = ?').run(bName);

    const copies = await w.t.agent.get(`/api/files/printer-copies?ids=${a},${b},${c}`);
    assert.equal(copies.status, 200);
    assert.deepEqual(copies.body.items.map((i: { copies: { name: string }[] }) => i.copies.map((x) => x.name)), [[aName], [bName], [cName]]);

    let r = await w.t.agent.delete(`/api/files/${a}?printer=1`).set('Sec-Fetch-Site', 'same-origin');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.printer.map((x: { name: string; result: string }) => [x.name, x.result]), [[aName, 'deleted']]);
    assert.ok(!w.sim.fileNames().includes(aName));
    assert.ok(w.sim.deletes.includes(`${DIRP}/${aName}`));

    r = await w.t.agent.delete(`/api/files/${b}?printer=1`).set('Sec-Fetch-Site', 'same-origin');
    assert.deepEqual(r.body.printer.map((x: { result: string; reason?: string }) => [x.result, x.reason]), [['skipped', 'unverified']]);
    assert.ok(w.sim.fileNames().includes(bName));

    process.env.PRINTYARD_READ_ONLY = '1';
    try {
      r = await w.t.agent.delete(`/api/files/${c}?printer=1`).set('Sec-Fetch-Site', 'same-origin');
    } finally {
      delete process.env.PRINTYARD_READ_ONLY;
    }
    assert.equal(r.status, 200, JSON.stringify(r.body)); // the library delete itself works in read-only mode
    assert.deepEqual(r.body.printer.map((x: { result: string; reason?: string }) => [x.result, x.reason]), [['skipped', 'read_only']]);
    assert.ok(w.sim.fileNames().includes(cName));
    // without ?printer=1 nothing on the printer is touched (204 as before)
    const d = await libUpload('lib d.gcode');
    const dName = await copyOnPrinter(d, 'lib_d');
    assert.equal((await w.t.agent.delete(`/api/files/${d}`).set('Sec-Fetch-Site', 'same-origin')).status, 204);
    assert.ok(w.sim.fileNames().includes(dName));
  });
});
