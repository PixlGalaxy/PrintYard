import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildControlGcode, buildExcludeGcode, controlSchema, type ControlContext } from '../src/modules/printing/control.js';
import { mergeObjects, parseDefineLine, parseLabelComment, readObjectDefinitions } from '../src/modules/printing/job-objects.js';
import { objectLabel, parseExcludeObject } from '../src/printers/k2se/moonraker.js';
import { parseAutohome, parsePosition } from '../src/printers/k2se/protocol.js';
import { PrinterSimulator, twoObjectGcode } from '../src/printers/sim/simulator.js';
import type { PrinterControlCommand } from '../src/types.js';
import { ADMIN, createTestApp, setupBody, type TestApp } from './helpers.js';
import { api, loginCookie, startServer, waitFor, type LiveServer } from './live-helpers.js';

const idle: ControlContext = {
  state: 'idle',
  homedAxes: 'xyz',
  position: [110, 107.5, 10],
  nozzleTemp: 25,
  maxNozzleTemp: 300,
  maxBedTemp: 100,
  bed: { x: 220, y: 215, z: 245 },
};
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'no error';
};

describe('control G-code builder', () => {
  it('builds homing, jog, temperatures, fan, motors off', () => {
    assert.equal(buildControlGcode({ action: 'home', axes: 'all' }, idle), 'G28');
    assert.equal(buildControlGcode({ action: 'home', axes: 'xy' }, idle), 'G28 X Y');
    assert.equal(buildControlGcode({ action: 'home', axes: 'z' }, { ...idle, homedAxes: '' }), 'G28 Z');
    assert.equal(buildControlGcode({ action: 'home', axes: 'x' }, idle), 'G28 X');
    assert.equal(buildControlGcode({ action: 'home', axes: 'y' }, idle), 'G28 Y');
    assert.equal(buildControlGcode({ action: 'jog', axis: 'x', distance: 10, feedrate: 6000 }, idle), 'G91\nG1 X10 F6000\nG90');
    assert.equal(buildControlGcode({ action: 'jog', axis: 'z', distance: -0.1, feedrate: 600 }, idle), 'G91\nG1 Z-0.1 F600\nG90');
    assert.equal(buildControlGcode({ action: 'temp', heater: 'nozzle', target: 210 }, idle), 'M104 S210');
    assert.equal(buildControlGcode({ action: 'temp', heater: 'bed', target: 0 }, idle), 'M140 S0');
    assert.equal(buildControlGcode({ action: 'fan', percent: 50 }, idle), 'M106 P0 S128');
    assert.equal(buildControlGcode({ action: 'fan', percent: 0 }, idle), 'M106 P0 S0');
    assert.equal(buildControlGcode({ action: 'motors_off' }, idle), 'M84');
    assert.equal(buildControlGcode({ action: 'extrude', length: -5, speed: 5 }, { ...idle, nozzleTemp: 215 }), 'M83\nG1 E-5 F300');
  });

  it('speed (M220 S10-300) and flow (M221 S50-150) factors, bounded', () => {
    assert.equal(buildControlGcode({ action: 'speed_factor', percent: 10 }, idle), 'M220 S10');
    assert.equal(buildControlGcode({ action: 'speed_factor', percent: 300 }, idle), 'M220 S300');
    assert.equal(buildControlGcode({ action: 'flow_factor', percent: 50 }, idle), 'M221 S50');
    assert.equal(buildControlGcode({ action: 'flow_factor', percent: 150 }, idle), 'M221 S150');
    for (const percent of [9, 301, 100.5]) assert.equal(code(() => buildControlGcode({ action: 'speed_factor', percent }, idle)), 'printers.factor_out_of_range');
    for (const percent of [49, 151]) assert.equal(code(() => buildControlGcode({ action: 'flow_factor', percent }, idle)), 'printers.factor_out_of_range');
    assert.equal(controlSchema.safeParse({ action: 'speed_factor', percent: 120 }).success, true);
    assert.equal(controlSchema.safeParse({ action: 'speed_factor', percent: 5 }).success, false);
    assert.equal(controlSchema.safeParse({ action: 'flow_factor', percent: 151 }).success, false);
    assert.equal(controlSchema.safeParse({ action: 'flow_factor', percent: 100, gcode: 'M112' }).success, false);
  });

  it('caps feedrates', () => {
    assert.equal(buildControlGcode({ action: 'jog', axis: 'y', distance: 1, feedrate: 999_999 }, idle), 'G91\nG1 Y1 F12000\nG90');
    assert.equal(buildControlGcode({ action: 'jog', axis: 'z', distance: 1, feedrate: 999_999 }, idle), 'G91\nG1 Z1 F900\nG90');
  });

  it('refuses: busy, not homed, unknown position, out of range, cold nozzle, targets above the maxima', () => {
    for (const state of ['printing', 'paused', 'pausing', 'stopping'] as const) {
      assert.equal(code(() => buildControlGcode({ action: 'home', axes: 'all' }, { ...idle, state })), 'printers.control_busy');
      assert.equal(code(() => buildControlGcode({ action: 'extrude', length: 5, speed: 5 }, { ...idle, state, nozzleTemp: 220 })), 'printers.control_busy');
      assert.equal(code(() => buildControlGcode({ action: 'motors_off' }, { ...idle, state })), 'printers.control_busy');
      // live tuning stays allowed: fan, temperatures, speed and flow factors
      assert.equal(buildControlGcode({ action: 'fan', percent: 100 }, { ...idle, state }), 'M106 P0 S255');
      assert.equal(buildControlGcode({ action: 'temp', heater: 'nozzle', target: 200 }, { ...idle, state }), 'M104 S200');
      assert.equal(buildControlGcode({ action: 'speed_factor', percent: 150 }, { ...idle, state }), 'M220 S150');
      assert.equal(buildControlGcode({ action: 'flow_factor', percent: 95 }, { ...idle, state }), 'M221 S95');
    }
    assert.equal(code(() => buildControlGcode({ action: 'jog', axis: 'z', distance: 1, feedrate: 600 }, { ...idle, homedAxes: 'xy' })), 'printers.not_homed');
    assert.equal(code(() => buildControlGcode({ action: 'jog', axis: 'x', distance: 1, feedrate: 600 }, { ...idle, homedAxes: null })), 'printers.not_homed');
    assert.equal(code(() => buildControlGcode({ action: 'jog', axis: 'x', distance: 1, feedrate: 600 }, { ...idle, position: null })), 'printers.position_unknown');
    assert.equal(code(() => buildControlGcode({ action: 'jog', axis: 'x', distance: 51, feedrate: 600 }, idle)), 'printers.out_of_range');
    assert.equal(code(() => buildControlGcode({ action: 'jog', axis: 'z', distance: -11, feedrate: 600 }, idle)), 'printers.out_of_range');
    assert.equal(code(() => buildControlGcode({ action: 'jog', axis: 'x', distance: 50, feedrate: 600 }, { ...idle, position: [200, 0, 0] })), 'printers.out_of_range');
    // back towards the volume from outside is fine
    assert.equal(buildControlGcode({ action: 'jog', axis: 'x', distance: 5, feedrate: 600 }, { ...idle, position: [-2, 0, 0] }), 'G91\nG1 X5 F600\nG90');
    assert.equal(code(() => buildControlGcode({ action: 'extrude', length: 5, speed: 5 }, { ...idle, nozzleTemp: 169 })), 'printers.nozzle_cold');
    assert.equal(code(() => buildControlGcode({ action: 'extrude', length: 5, speed: 5 }, { ...idle, nozzleTemp: null })), 'printers.nozzle_cold');
    assert.equal(code(() => buildControlGcode({ action: 'temp', heater: 'nozzle', target: 301 }, idle)), 'printers.temp_out_of_range');
    assert.equal(code(() => buildControlGcode({ action: 'temp', heater: 'bed', target: 101 }, idle)), 'printers.temp_out_of_range');
  });

  it('schema accepts only the typed union (no raw G-code, no extra keys)', () => {
    const ok: PrinterControlCommand[] = [
      { action: 'home', axes: 'all' },
      { action: 'jog', axis: 'x', distance: -50, feedrate: 3000 },
      { action: 'extrude', length: 10, speed: 5 },
      { action: 'temp', heater: 'bed', target: 60 },
      { action: 'fan', percent: 100 },
      { action: 'motors_off' },
      { action: 'light', on: true },
      { action: 'light', on: false },
    ];
    for (const c of ok) assert.ok(controlSchema.safeParse(c).success, JSON.stringify(c));
    for (const bad of [
      { action: 'gcode', gcode: 'M112' },
      { action: 'home', axes: 'all', gcode: 'M112' },
      { action: 'home', axes: 'x; M112' },
      { action: 'jog', axis: 'x', distance: 0, feedrate: 3000 },
      { action: 'jog', axis: 'x', distance: 50.1, feedrate: 3000 },
      { action: 'jog', axis: 'e', distance: 1, feedrate: 3000 },
      { action: 'jog', axis: 'x', distance: '1\nM112', feedrate: 3000 },
      { action: 'extrude', length: 51, speed: 5 },
      { action: 'extrude', length: 5, speed: 11 },
      { action: 'temp', heater: 'chamber', target: 40 },
      { action: 'temp', heater: 'nozzle', target: 200.5 },
      { action: 'fan', percent: 101 },
      { action: 'motors_off', all: true },
      { action: 'light', on: 1 },
      { action: 'light' },
      { action: 'light', on: true, gcode: 'M112' },
      'G28',
      null,
    ]) {
      assert.equal(controlSchema.safeParse(bad).success, false, JSON.stringify(bad));
    }
  });

  it('exclude G-code only with a safe name', () => {
    assert.equal(buildExcludeGcode('Object_1_id_0_copy_0'), 'EXCLUDE_OBJECT NAME=Object_1_id_0_copy_0');
    for (const n of ['a b', 'x\nM112', 'x;y', '', 'a'.repeat(200)]) assert.equal(code(() => buildExcludeGcode(n)), 'exclude.invalid_name');
  });
});

describe('exclude-object parsing', () => {
  it('parses Creality Print 7.3 EXCLUDE_OBJECT_DEFINE lines and labels', () => {
    const d = parseDefineLine('EXCLUDE_OBJECT_DEFINE NAME=Object_1_id_0_copy_0 CENTER=110.5,107 POLYGON=[[100,97],[121,97],[121,117.25],[100,117.25]]')!;
    assert.deepEqual(d, {
      name: 'Object_1_id_0_copy_0',
      label: 'Object_1',
      center: [110.5, 107],
      polygon: [[100, 97], [121, 97], [121, 117.25], [100, 117.25]],
    });
    assert.equal(parseDefineLine('EXCLUDE_OBJECT_DEFINE NAME=bad$name'), null);
    assert.equal(parseDefineLine('G1 X1'), null);
    assert.equal(objectLabel('Object_1_id_0_copy_1'), 'Object_1 (2)');
    assert.equal(objectLabel('OBJECT_1_ID_0_COPY_0'), 'OBJECT_1');
    assert.deepEqual(parseLabelComment('; printing object Benchy 3 id:2 copy 0'), { key: '_ID_2_COPY_0', label: 'Benchy 3' });
    assert.deepEqual(parseAutohome('X:1 Y:1 Z:0'), 'xy');
    assert.deepEqual(parsePosition('X:37.92 Y:91.11 Z:28.92'), [37.92, 91.11, 28.92]);
  });

  it('reads definitions from a file and merges them with Klipper status (upper-cased names)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slicedock-objs-'));
    try {
      const p = join(dir, 'two.gcode');
      writeFileSync(p, twoObjectGcode(3));
      const defs = await readObjectDefinitions(p);
      assert.deepEqual(defs.map((d) => [d.name, d.label]), [['Object_1_id_0_copy_0', 'Object_1'], ['Object_2_id_1_copy_0', 'Object_2']]);
      const live = parseExcludeObject({
        objects: [{ name: 'OBJECT_1_ID_0_COPY_0', center: [75, 107.5], polygon: [[65, 97.5]] }, { name: 'OBJECT_2_ID_1_COPY_0' }],
        excluded_objects: ['OBJECT_1_ID_0_COPY_0'],
        current_object: 'OBJECT_2_ID_1_COPY_0',
      });
      const merged = mergeObjects(defs, live, ['OBJECT_1_ID_0_COPY_0'], 'OBJECT_2_ID_1_COPY_0');
      assert.deepEqual(merged.map((o) => [o.name, o.excluded, o.current]), [['Object_1_id_0_copy_0', true, false], ['Object_2_id_1_copy_0', false, true]]);
      assert.equal(merged[0]!.polygon.length, 4);
      // no G-code definitions: Klipper's own list
      assert.deepEqual(mergeObjects(null, live, [], null).map((o) => o.label), ['OBJECT_1', 'OBJECT_2']);
      writeFileSync(p, 'G28\nG1 X1\n');
      assert.deepEqual(await readObjectDefinitions(p), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('printer controls + exclude object end-to-end (simulator)', () => {
  let t: TestApp;
  let live: LiveServer;
  let sim: PrinterSimulator;
  let printerId: number;
  let admin: string;
  let alice: string;
  let aliceId: number;
  const status = () => t.ctx.printerManager.status(printerId);
  const audit = (action: string) => (t.ctx.audit.list(500) as { action: string; meta?: unknown }[]).filter((e) => e.action === action);
  const control = (cookie: string, body: unknown) => api(live.base, cookie, 'POST', `/api/printers/${printerId}/control`, body);

  before(async () => {
    sim = new PrinterSimulator({ tickMs: 25, simSecondsPerTick: 4, heatPerTick: 100 });
    const port = await sim.start();
    t = createTestApp({
      context: {
        printFiles: { get: () => null },
        printerManager: { resolveEndpoint: async (h) => (h === 'sim' ? { host: '127.0.0.1', wsPort: port, httpPort: port, moonrakerPort: port } : null) },
      },
    });
    await t.agent.post('/api/setup/complete').send(setupBody({ printer: null, exposure: { mode: 'none' } }));
    aliceId = (await t.agent.post('/api/admin/users').send({ username: 'alice', password: 'alice-password-1', role: 'user' })).body.id;
    printerId = (await t.agent.post('/api/admin/printers').send({ name: 'Sim', model: 'creality-k2se', host: 'sim' })).body.id;
    t.ctx.printerManager.start();
    live = await startServer(t.ctx);
    admin = await loginCookie(live.base, ADMIN.username, ADMIN.password);
    alice = await loginCookie(live.base, 'alice', 'alice-password-1');
    await waitFor(() => status().online && status().state === 'idle' && status().homedAxes !== null);
  });
  after(async () => {
    await live?.close();
    t?.close();
    await sim?.stop();
  });

  it('users need the can_control_printer grant (admins always)', async () => {
    let r = await control(alice, { action: 'home', axes: 'all' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'printers.control_forbidden');
    assert.equal((await api(live.base, alice, 'GET', '/api/auth/me')).body.user.canControlPrinter, false);
    assert.equal((await api(live.base, admin, 'GET', '/api/auth/me')).body.user.canControlPrinter, true);
    r = await api(live.base, admin, 'PATCH', `/api/admin/users/${aliceId}`, { canControlPrinter: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.canControlPrinter, true);
    assert.equal((await api(live.base, alice, 'GET', '/api/auth/me')).body.user.canControlPrinter, true);
    assert.deepEqual(sim.gcodeLog, []);
  });

  it('a user without the grant cannot switch the light', async () => {
    const bob = (await t.agent.post('/api/admin/users').send({ username: 'bob', password: 'bob-password-12', role: 'user' })).body.id;
    assert.ok(bob);
    const cookie = await loginCookie(live.base, 'bob', 'bob-password-12');
    const r = await control(cookie, { action: 'light', on: false });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'printers.control_forbidden');
  });

  it('rejects raw G-code and malformed commands with 400', async () => {
    for (const body of [{ action: 'gcode', gcode: 'M112' }, { action: 'home', axes: 'all', extra: 'M112' }, { gcodeCmd: 'G28' }]) {
      const r = await control(admin, body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.deepEqual(sim.gcodeLog, []);
  });

  it('jog needs homing; home, jog, temperatures, fan, extrude, motors off reach the simulator', async () => {
    let r = await control(alice, { action: 'jog', axis: 'x', distance: 10, feedrate: 6000 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'printers.not_homed');

    r = await control(alice, { action: 'home', axes: 'all' });
    assert.equal(r.status, 200);
    await waitFor(() => status().homedAxes === 'xyz');
    assert.deepEqual(status().position, [110, 107.5, 0]);

    r = await control(alice, { action: 'jog', axis: 'x', distance: 10, feedrate: 6000 });
    assert.equal(r.status, 200);
    await waitFor(() => status().position?.[0] === 120);
    assert.equal(sim.relativeMode, false); // G90 restored
    r = await control(alice, { action: 'jog', axis: 'z', distance: -1, feedrate: 600 });
    assert.equal(r.body.error.code, 'printers.out_of_range');

    r = await control(alice, { action: 'temp', heater: 'nozzle', target: 301 });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'printers.temp_out_of_range');
    r = await control(alice, { action: 'extrude', length: 5, speed: 5 });
    assert.equal(r.body.error.code, 'printers.nozzle_cold');
    r = await control(alice, { action: 'temp', heater: 'nozzle', target: 200 });
    assert.equal(r.status, 200);
    await waitFor(() => (status().nozzleTemp ?? 0) >= 199);
    r = await control(alice, { action: 'extrude', length: 5, speed: 5 });
    assert.equal(r.status, 200);
    await waitFor(() => sim.extruded === 5);
    assert.equal((await control(alice, { action: 'temp', heater: 'nozzle', target: 0 })).status, 200);
    assert.equal((await control(alice, { action: 'temp', heater: 'bed', target: 55 })).status, 200);
    assert.equal((await control(alice, { action: 'fan', percent: 40 })).status, 200);
    await waitFor(() => status().fanPart === 40 && status().bedTarget === 55);
    assert.equal((await control(alice, { action: 'light', on: false })).status, 200);
    await waitFor(() => status().lightOn === false);
    assert.ok(sim.commands.some((c) => c.lightSw === 0));
    assert.ok(audit('printer.control').some((e) => JSON.stringify(e.meta).includes('"lightSw":0')));
    assert.equal((await control(alice, { action: 'motors_off' })).status, 200);
    await waitFor(() => status().homedAxes === '');
    assert.ok(sim.gcodeLog.includes('G91\nG1 X10 F6000\nG90'));
    assert.ok(sim.gcodeLog.includes('M84'));
    const entries = audit('printer.control');
    assert.ok(entries.length >= 8);
  });

  it('while printing only tuning (fan, light, temps, speed, flow) is allowed; exclude object validates and reaches Klipper; last job kept until bed cleared', async () => {
    await t.ctx.printerManager.driver(printerId).startPrint('/usr/data/printer_data/gcodes/two_cubes.gcode');
    await waitFor(() => status().state === 'printing' && status().job);
    let r = await control(admin, { action: 'jog', axis: 'x', distance: 1, feedrate: 600 });
    assert.equal(r.body.error.code, 'printers.control_busy');
    r = await control(admin, { action: 'motors_off' });
    assert.equal(r.body.error.code, 'printers.control_busy');
    // live tuning while printing: temperatures, speed and flow factors (M220/M221), fan
    assert.equal((await control(admin, { action: 'temp', heater: 'bed', target: 58 })).status, 200);
    assert.equal((await control(admin, { action: 'speed_factor', percent: 150 })).status, 200);
    assert.equal((await control(admin, { action: 'flow_factor', percent: 95 })).status, 200);
    await waitFor(() => status().speedFactor === 150 && status().flowFactor === 95 && status().bedTarget === 58);
    assert.ok(sim.gcodeLog.includes('M220 S150') && sim.gcodeLog.includes('M221 S95'));
    assert.ok(audit('printer.control').some((e) => JSON.stringify(e.meta).includes('"gcode":"M220 S150"')));
    assert.equal((await control(admin, { action: 'speed_factor', percent: 100 })).status, 200);
    assert.equal((await control(admin, { action: 'flow_factor', percent: 100 })).status, 200);
    assert.equal((await control(admin, { action: 'fan', percent: 80 })).status, 200);
    // the light is allowed while printing too (Creality WS lightSw, not G-code)
    const gcodes = sim.gcodeLog.length;
    assert.equal((await control(admin, { action: 'light', on: true })).status, 200);
    await waitFor(() => status().lightOn === true);
    assert.equal(sim.gcodeLog.length, gcodes);

    // objects: Klipper status merged with the parsed G-code (proper-case names + labels)
    const objs = await waitFor(() => {
      const o = status().job?.objects ?? [];
      return o.length === 2 && o[0]!.name === 'Object_1_id_0_copy_0' ? o : null;
    }, 8000);
    assert.deepEqual(objs.map((o) => o.label), ['Object_1', 'Object_2']);
    assert.equal(objs[0]!.polygon.length, 4);

    const ex = (cookie: string, name: unknown) => api(live.base, cookie, 'POST', `/api/printers/${printerId}/exclude-object`, { name });
    // started on the "touchscreen" (not a SliceDock print): admin only
    r = await ex(alice, 'Object_1_id_0_copy_0');
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'prints.not_owner');
    assert.equal((await ex(admin, 'Object 1')).status, 400);
    assert.equal((await ex(admin, 'Object_1;M112')).status, 400);
    r = await ex(admin, 'Object_9_id_8_copy_0');
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'exclude.unknown_object');
    r = await ex(admin, 'Object_1_id_0_copy_0');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await waitFor(() => status().job?.objects.find((o) => o.name === 'Object_1_id_0_copy_0')?.excluded);
    assert.deepEqual(sim.excluded, ['OBJECT_1_ID_0_COPY_0']);
    assert.ok(sim.gcodeLog.includes('EXCLUDE_OBJECT NAME=Object_1_id_0_copy_0'));
    r = await ex(admin, 'Object_1_id_0_copy_0');
    assert.equal(r.body.error.code, 'exclude.already_excluded');
    r = await ex(admin, 'Object_2_id_1_copy_0');
    assert.equal(r.body.error.code, 'exclude.last_object');
    assert.equal(audit('print.exclude_object').length, 1);
    // the simulator never "prints" the excluded object's moves
    for (let i = 0; i < 20; i++) {
      assert.notEqual(sim.moonObjects().exclude_object!.current_object, 'OBJECT_1_ID_0_COPY_0');
      await new Promise((res) => setTimeout(res, 20));
    }

    // finish → bed occupied, last job with final values
    const s = await waitFor(() => (status().state === 'complete' && status().lastJob ? status() : null), 20_000);
    assert.equal(s.bedClear, false);
    assert.equal(s.job, null);
    const last = s.lastJob!;
    assert.equal(last.result, 'done');
    assert.equal(last.fileName, 'two_cubes.gcode');
    assert.equal(last.layer, 60);
    assert.equal(last.totalLayers, 60);
    assert.equal(last.progress, 100);
    assert.ok(last.endedAt > 0);
    assert.deepEqual(last.objects.map((o) => [o.label, o.excluded]), [['Object_1', true], ['Object_2', false]]);

    const g = await fetch(`${live.base}/api/printers/${printerId}/current-gcode?last=1`, { headers: { Cookie: alice } });
    assert.equal(g.status, 200);
    assert.match(await g.text(), /EXCLUDE_OBJECT_DEFINE NAME=Object_2_id_1_copy_0/);

    assert.equal((await api(live.base, alice, 'POST', `/api/printers/${printerId}/bed-cleared`)).status, 200);
    assert.equal(status().lastJob, null);
    r = await api(live.base, alice, 'GET', `/api/printers/${printerId}/current-gcode?last=1`);
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'printers.no_last_job');
  });

  it('rate-limits control actions per user and printer', async () => {
    let limited = null;
    for (let i = 0; i < 25 && !limited; i++) {
      const r = await control(alice, { action: 'fan', percent: 10 });
      if (r.status === 429) limited = r;
    }
    assert.ok(limited, 'expected a 429');
    assert.equal(limited.body.error.code, 'printers.control_rate_limited');
  });
});
