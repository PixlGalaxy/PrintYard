// Regression tests for the phase 3 security review (A): status/phase3-review-a.md, exploits E1–E5 and E7.
// (E6, printer retention, is covered by SAFETY-FIX.) No network: stub fetch + stub DNS, fake engine.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { analyzeGcodeFile, GcodeAnalyzer, MAX_LINE_CHARS, parseGcodeLine, shlexSplit } from '../src/modules/files/gcode-analyzer.js';
import { DEFAULT_SCAN_LIMITS, GcodeScanner, scanGcodeFile } from '../src/modules/files/gcode-scan.js';
import { buildRequest } from '../src/modules/notifications/channels.js';
import { FloodGuard, notifyText } from '../src/modules/notifications/flood.js';
import { postOutbound } from '../src/modules/notifications/outbound.js';
import { checkOptionValue, safetyCaps } from '../src/modules/profiles/option-bounds.js';
import { filamentOptionDefs, processOptionDefs } from '../src/modules/profiles/profiles.service.js';
import { sliceOutputName } from '../src/modules/slicing/slicing.service.js';
import { boxStl, createB1App, sceneFor, upload, type B1App } from './b1-helpers.js';

process.env.SLICEDOCK_FAKE_ENGINE_MS = '100';

function scan(text: string) {
  const s = new GcodeScanner(DEFAULT_SCAN_LIMITS);
  const a = new GcodeAnalyzer({ hooks: [s.hook] });
  for (const l of text.split('\n')) a.pushLine(l);
  return s.result();
}
const reasons = (text: string) => scan(text).findings.map((f) => f.reason);

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---------------------------------------------------------------- E1 / #1

describe('#1 scanner parses extended parameters exactly like Klipper (E1)', () => {
  const exploits: [string, string[]][] = [
    ['SET_HEATER_TEMPERATURE HEATER=extruder TARGET=200 X= TARGET=350', ['duplicate_parameter', 'temperature_too_high']],
    ['SET_HEATER_TEMPERATURE HEATER=extruder TARGET=350 #TARGET=200', ['temperature_too_high']],
    ['SET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=150 *TARGET=60', ['temperature_too_high']],
    ['START_PRINT EXTRUDER_TEMP=200 BED_TEMP=60 X= EXTRUDER_TEMP=350 Y= BED_TEMP=150', ['duplicate_parameter', 'temperature_too_high', 'temperature_too_high']],
    ['SET_VELOCITY_LIMIT VELOCITY=300 ACCEL=1000 X= ACCEL=200000 Y= VELOCITY=5000', ['duplicate_parameter', 'motion_limit', 'motion_limit']],
  ];
  for (const [line, expected] of exploits) {
    it(`flags: ${line}`, () => {
      const r = scan(`G90\n${line}\nG1 X1 Y1\n`);
      assert.equal(r.ok, false);
      assert.deepEqual(r.findings.map((f) => f.reason), expected);
    });
  }

  it('evaluates the value Klipper uses (last duplicate, args cut at # * ;)', () => {
    assert.equal(parseGcodeLine('SET_HEATER_TEMPERATURE HEATER=extruder TARGET=200 X= TARGET=350', 1)?.params.TARGET, '350');
    assert.equal(parseGcodeLine('SET_HEATER_TEMPERATURE HEATER=extruder TARGET=350 #TARGET=200', 1)?.params.TARGET, '350');
    assert.equal(parseGcodeLine('SET_HEATER_TEMPERATURE HEATER=extruder TARGET=350 ;TARGET=200', 1)?.params.TARGET, '350');
    assert.deepEqual(parseGcodeLine('set_heater_temperature heater=extruder target=210', 1)?.params, { HEATER: 'extruder', TARGET: '210' });
    assert.equal(parseGcodeLine('START_PRINT EXTRUDER_TEMP="3"50', 1)?.params.EXTRUDER_TEMP, '350');
    assert.equal(parseGcodeLine("START_PRINT EXTRUDER_TEMP='350'", 1)?.params.EXTRUDER_TEMP, '350');
  });

  it('shlex: quotes, escapes and errors', () => {
    assert.deepEqual(shlexSplit(`A=1 B="x y" C='p q' D=a\\ b E= ""`), ['A=1', 'B=x y', 'C=p q', 'D=a b', 'E=', '']);
    assert.deepEqual(shlexSplit('A="a\\"b\\\\c\\d"'), ['A=a"b\\c\\d']);
    assert.equal(shlexSplit('A="open'), null);
    assert.equal(shlexSplit("A='open"), null);
    assert.equal(shlexSplit('A=\\'), null);
  });

  it('malformed parameters (Klipper refuses the line) and non-numbers are findings', () => {
    assert.deepEqual(reasons('SET_HEATER_TEMPERATURE HEATER=extruder TARGET="200'), ['malformed_command']);
    assert.deepEqual(reasons('SET_HEATER_TEMPERATURE HEATER=extruder 350'), ['malformed_command']);
    assert.deepEqual(reasons('SET_HEATER_TEMPERATURE*1 HEATER=extruder TARGET=350'), ['malformed_command']);
    for (const v of ['nan', 'inf', '1_000', '0x15E', '"350"', '３５０']) {
      assert.deepEqual(reasons(`SET_HEATER_TEMPERATURE HEATER=extruder TARGET='${v}'`), ['invalid_value'], v);
    }
  });

  it('classic commands: temperatures, duplicates and factor extremes', () => {
    assert.deepEqual(reasons('M104 S280\nM109 S280\nM140 S110\nM190 S110\nM141 S60\nM220 S100\nM221 S100'), []);
    assert.deepEqual(reasons('M104 S301\nM109 S301\nM140 S111\nM190 S111\nM141 S61\nM191 S61'), Array(6).fill('temperature_too_high'));
    assert.deepEqual(reasons('M104 S200 S350'), ['duplicate_parameter', 'temperature_too_high']);
    assert.deepEqual(reasons('M104 S350*12'), ['temperature_too_high']);
    assert.deepEqual(reasons('M220 S1000'), ['motion_limit']);
    assert.deepEqual(reasons('M221 S500'), ['flow_limit']);
    assert.deepEqual(reasons('START_PRINT EXTRUDER_TEMP=220 BED_TEMP=60 CHAMBER_TEMP=90'), ['temperature_too_high']);
    assert.deepEqual(reasons('SET_HEATER_TEMPERATURE HEATER=chamber TARGET=90'), ['temperature_too_high']);
  });
});

describe('#1 end-to-end: the exploit upload is no longer printable (E1b)', () => {
  let t: B1App;
  let printerId: number;
  before(async () => {
    t = await createB1App({ printerManager: { resolveEndpoint: async () => null } });
    printerId = (await t.admin.post('/api/admin/printers').send({ name: 'Sim', model: 'creality-k2se', host: 'sim' })).body.id;
    await t.admin.patch(`/api/admin/users/${t.aliceId}`).send({ canPrintUploadedGcode: true });
  });
  after(() => t?.close());
  it('scan.ok = false and POST /prints is prints.dangerous_gcode', async () => {
    const g = 'G90\nM83\nSET_HEATER_TEMPERATURE HEATER=extruder TARGET=200 X= TARGET=350\nSET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=150 #TARGET=60\nG1 X10 Y10 E1 F3000\n';
    const up = await upload(t.alice, Buffer.from(g), 'hot.gcode');
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.equal(up.body.meta.gcode.scan.ok, false);
    const r = await t.alice.post('/api/prints').send({ printerId, fileId: up.body.id });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error.code, 'prints.dangerous_gcode');
  });
});

// ---------------------------------------------------------------- E5 / #8

describe('#8 analyzer is linear on huge lines (E5)', () => {
  let dir: string;
  before(() => (dir = mkdtempSync(join(tmpdir(), 'sd-r3a-'))));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('128 MB without a newline is analyzed in < 2 s and flagged', async () => {
    const p = join(dir, 'long.gcode');
    writeFileSync(p, Buffer.alloc(128 * 1024 * 1024, 0x41));
    const t0 = Date.now();
    const r = await scanGcodeFile(p, DEFAULT_SCAN_LIMITS);
    const ms = Date.now() - t0;
    assert.ok(ms < 2000, `took ${ms} ms`);
    assert.equal(r.ok, false);
    assert.equal(r.findings[0]?.reason, 'malformed_command');
  });

  it('parameters past the cut are never trusted; a long comment is fine', async () => {
    const hidden = join(dir, 'hidden.gcode');
    writeFileSync(hidden, `G90\nSET_HEATER_TEMPERATURE HEATER=extruder TARGET=200${' '.repeat(MAX_LINE_CHARS)} TARGET=350\nG1 X1\n`);
    const r = await scanGcodeFile(hidden, DEFAULT_SCAN_LIMITS);
    assert.deepEqual(r.findings.map((f) => [f.line, f.reason]), [[2, 'malformed_command']]);
    const comment = join(dir, 'comment.gcode');
    writeFileSync(comment, `G90\nG1 X1 ; ${'x'.repeat(MAX_LINE_CHARS * 3)}\nG1 X2\n`);
    const c = await scanGcodeFile(comment, DEFAULT_SCAN_LIMITS);
    assert.equal(c.ok, true, JSON.stringify(c.findings));
    assert.equal((await analyzeGcodeFile(comment)).lines, 3);
  });
});

// ---------------------------------------------------------------- E2 / #2

describe('#2 override and preset values are range-checked; sliced output is scanned (E2)', () => {
  let t: B1App;
  let model: number;
  const BASE = 'Hyper PLA @Creality K2 SE 0.4 nozzle';
  before(async () => {
    t = await createB1App({ engine: { fake: true } });
    model = (await upload(t.alice, boxStl(20, 20, 20), 'cube.stl')).body.id;
  });
  after(() => {
    delete process.env.SLICEDOCK_FAKE_ENGINE_UNSAFE;
    t.ctx.slicing.stop();
    t.close();
  });

  it('safety caps follow the scanner (nozzle 280, bed 100) and option types', () => {
    const caps = safetyCaps();
    assert.equal(caps.nozzle, 280);
    assert.equal(caps.bed, 100);
    const fil = new Map(filamentOptionDefs().map((o) => [o.key, o]));
    const proc = new Map(processOptionDefs().map((o) => [o.key, o]));
    const check = (m: typeof fil, k: string, v: string) => checkOptionValue(m.get(k)!, v);
    assert.equal(check(fil, 'nozzle_temperature', '280'), null);
    assert.match(check(fil, 'nozzle_temperature', '281')!, /range/);
    assert.match(check(fil, 'hot_plate_temp_initial_layer', '101')!, /range/);
    assert.match(check(fil, 'filament_flow_ratio', '5')!, /range/);
    assert.match(check(fil, 'filament_max_volumetric_speed', '500')!, /range/);
    assert.match(check(fil, 'fan_max_speed', '101')!, /range/);
    assert.match(check(fil, 'filament_density', '0')!, /range/);
    assert.equal(check(proc, 'travel_speed', '500'), null);
    assert.match(check(proc, 'travel_speed', '5000')!, /range/);
    assert.match(check(proc, 'travel_speed', '500,5000')!, /range/);
    assert.match(check(proc, 'default_acceleration', '200000')!, /range/);
    assert.match(check(proc, 'default_jerk', '50')!, /range/);
    assert.equal(check(proc, 'sparse_infill_density', '15%'), null);
    assert.equal(check(proc, 'layer_height', 'abc'), 'number');
  });

  it('presets above the caps are refused (was 0–500 °C)', async () => {
    const p = await t.alice.post('/api/filament-presets').send({ basePresetId: BASE, name: 'Hot', values: { nozzle_temperature: '500', hot_plate_temp: '500' } });
    assert.equal(p.status, 400, JSON.stringify(p.body));
    assert.equal(p.body.error.code, 'filament_presets.invalid_value');
    assert.deepEqual(p.body.error.details.keys.sort(), ['hot_plate_temp', 'nozzle_temperature']);
  });

  it('slot, process and object overrides above the caps are slice.invalid_override (projects and slicing)', async () => {
    const base = sceneFor([model]);
    const cases = [
      { ...base, filaments: [{ ...base.filaments[0]!, overrides: { nozzle_temperature_initial_layer: '999', hot_plate_temp_initial_layer: '999' } }] },
      { ...base, processOverrides: { default_acceleration: '200000' } },
      { ...base, objects: base.objects.map((o) => ({ ...o, overrides: { travel_speed: '5000' } })) },
    ];
    for (const scene of cases) {
      const proj = await t.alice.post('/api/projects').send({ name: 'hot', scene });
      assert.equal(proj.status, 400, JSON.stringify(proj.body));
      assert.equal(proj.body.error.code, 'slice.invalid_override');
      assert.ok(proj.body.error.details.issues.length > 0);
      const s = await t.alice.post('/api/slice').send({ scene, plate: 0 });
      assert.equal(s.status, 400);
      assert.equal(s.body.error.code, 'slice.invalid_override');
    }
  });

  it('a legacy custom preset with 500 °C stored before the caps cannot be sliced', async () => {
    const p = await t.alice.post('/api/filament-presets').send({ basePresetId: BASE, name: 'Legacy', values: { nozzle_temperature: '220' } });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    t.ctx.db.prepare('UPDATE filament_presets SET values_json = ? WHERE id = ?').run(JSON.stringify({ nozzle_temperature: '500' }), p.body.id);
    const base = sceneFor([model]);
    const scene = { ...base, filaments: [{ ...base.filaments[0]!, presetId: p.body.presetId }] };
    const s = await t.alice.post('/api/slice').send({ scene, plate: 0 });
    assert.equal(s.status, 400, JSON.stringify(s.body));
    assert.equal(s.body.error.code, 'slice.invalid_override');
  });

  it('sliced output: clean output is trusted and carries its scan; unsafe output fails slice.unsafe_output', async () => {
    const ok = await t.alice.post('/api/slice').send({ scene: sceneFor([model]), plate: 0 });
    assert.equal(ok.status, 202, JSON.stringify(ok.body));
    const done = await waitFor(async () => (await t.alice.get(`/api/slice/${ok.body.id}`)).body, (j) => ['done', 'failed'].includes(j.state));
    assert.equal(done.state, 'done', JSON.stringify(done));
    const file = (await t.alice.get(`/api/files/${done.result.fileId}`)).body;
    assert.equal(file.meta.trusted, true);
    assert.equal(file.meta.gcode.scan.ok, true);

    process.env.SLICEDOCK_FAKE_ENGINE_UNSAFE = '1';
    const filesBefore = (t.ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE kind = 'gcode'").get() as { n: number }).n;
    const bad = await t.alice.post('/api/slice').send({ scene: sceneFor([model]), plate: 0 });
    const failed = await waitFor(async () => (await t.alice.get(`/api/slice/${bad.body.id}`)).body, (j) => ['done', 'failed'].includes(j.state));
    delete process.env.SLICEDOCK_FAKE_ENGINE_UNSAFE;
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error, 'slice.unsafe_output');
    assert.equal((t.ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE kind = 'gcode'").get() as { n: number }).n, filesBefore);
  });
});

// ---------------------------------------------------------------- output names (coordinator item)

describe('sliced G-code names', () => {
  it('<project or first object name>_plate<N>.gcode, never plate_plate1', () => {
    assert.equal(sliceOutputName(undefined, 'cube.stl', 0), 'cube_plate1.gcode');
    assert.equal(sliceOutputName('My Project', 'cube', 2), 'My Project_plate3.gcode');
    assert.equal(sliceOutputName('plate', 'plate_1.gcode', 0), 'SliceDock_plate1.gcode');
    assert.equal(sliceOutputName(undefined, 'plate_1', 0), 'SliceDock_plate1.gcode');
    assert.equal(sliceOutputName('benchy_plate1', '', 0), 'benchy_plate1.gcode');
    assert.equal(sliceOutputName('a/b<c>:d', '', 0), 'a_b_c_d_plate1.gcode');
    const long = sliceOutputName('A'.repeat(200), '', 9);
    assert.ok(long.length <= 64 && long.endsWith('_plate10.gcode'), long);
  });

  it('a multi-object plate uses the project name sent by the client', async () => {
    const t = await createB1App({ engine: { fake: true } });
    try {
      const a = (await upload(t.alice, boxStl(10, 10, 10), 'a.stl')).body.id;
      const b = (await upload(t.alice, boxStl(10, 10, 10), 'b.stl')).body.id;
      const scene = sceneFor([a, b], { at: [[60, 60], [150, 150]] });
      for (const [name, expected] of [['Desk organizer', 'Desk organizer_plate1.gcode'], [undefined, 'obj0_plate1.gcode']] as const) {
        const r = await t.alice.post('/api/slice').send({ scene, plate: 0, ...(name && { name }) });
        assert.equal(r.status, 202, JSON.stringify(r.body));
        const done = await waitFor(async () => (await t.alice.get(`/api/slice/${r.body.id}`)).body, (j) => ['done', 'failed'].includes(j.state));
        assert.equal(done.state, 'done', JSON.stringify(done));
        assert.equal((await t.alice.get(`/api/files/${done.result.fileId}`)).body.name, expected);
      }
    } finally {
      t.ctx.slicing.stop();
      t.close();
    }
  });
});

// ---------------------------------------------------------------- E3 / #4 #5

describe('#4 #5 outbound requests: SSRF, rebinding, redirects, secrets (E3)', () => {
  const lookup = async (h: string) => (h === 'public.example' || h === 'ntfy.example' || h === 'attacker.example' ? ['93.184.216.34'] : ['10.0.0.1']);
  const stub = (responses: ((u: string) => Response)[]) => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const impl = (async (u: unknown, init: { headers: Record<string, string> }) => {
      calls.push({ url: String(u), headers: init.headers });
      return responses[Math.min(calls.length - 1, responses.length - 1)]!(String(u));
    }) as unknown as typeof fetch;
    return { calls, impl };
  };

  for (const url of ['https://127.0.0.1:3000/api/x', 'https://192.168.8.230/', 'https://[::1]/', 'https://169.254.169.254/latest', 'https://localhost/', 'https://internal.example/']) {
    it(`first hop to ${url} is refused before sending`, async () => {
      const s = stub([() => new Response('ok')]);
      await assert.rejects(postOutbound({ url, body: '{}', headers: {} }, { fetchImpl: s.impl, lookup }), /private or reserved/);
      assert.equal(s.calls.length, 0);
    });
  }

  for (const target of ['https://0.0.0.0:3000/', 'https://[::]:3000/', 'https://100.64.0.1/', 'https://[64:ff9b::7f00:1]/', 'https://[::7f00:1]/', 'https://198.18.0.1/', 'https://[::ffff:127.0.0.1]/']) {
    it(`redirect into ${target} is refused`, async () => {
      const s = stub([() => new Response(null, { status: 307, headers: { location: target } }), () => new Response('x')]);
      await assert.rejects(postOutbound({ url: 'https://public.example/hook', body: '{}', headers: {} }, { fetchImpl: s.impl, lookup }), /private or reserved/);
      assert.equal(s.calls.length, 1);
    });
  }

  it('the response body never reaches the error', async () => {
    const s = stub([() => new Response('INTERNAL-SECRET-PAGE-CONTENT', { status: 500 })]);
    const e = await postOutbound({ url: 'https://public.example/', body: '', headers: {} }, { fetchImpl: s.impl, lookup }).catch((x: Error) => x);
    assert.equal((e as Error).message, 'HTTP 500');
    assert.ok(!JSON.stringify(e).includes('INTERNAL-SECRET'));
  });

  it('at most 3 redirects', async () => {
    const s = stub([() => new Response(null, { status: 302, headers: { location: 'https://public.example/again' } })]);
    await assert.rejects(postOutbound({ url: 'https://public.example/', body: '', headers: {} }, { fetchImpl: s.impl, lookup }), /Too many redirects/);
    assert.equal(s.calls.length, 4);
  });

  it('ntfy local server: RFC 1918 only (never loopback or metadata), otherwise public only', async () => {
    const ok = stub([() => new Response('')]);
    await postOutbound({ url: 'http://192.168.1.20:8080/t', body: 'x', headers: {}, allowHttpPrivate: true }, { fetchImpl: ok.impl, lookup });
    assert.equal(ok.calls.length, 1);
    for (const url of ['http://127.0.0.1/t', 'https://169.254.169.254/t', 'https://100.64.0.1/t']) {
      await assert.rejects(postOutbound({ url, body: 'x', headers: {}, allowHttpPrivate: true }, { fetchImpl: ok.impl, lookup }), DeliveryLike);
    }
    await assert.rejects(postOutbound({ url: 'https://192.168.1.20/t', body: 'x', headers: {} }, { fetchImpl: ok.impl, lookup }), /private or reserved/);
    assert.equal(ok.calls.length, 1);
  });

  it('the ntfy Bearer token is not forwarded to another origin', async () => {
    const req = buildRequest(
      'ntfy',
      { ntfy: { enabled: true, serverUrl: 'https://ntfy.example', topic: 't', token: 'tk_SECRET', localServer: false, events: [] } } as never,
      { event: 'test', language: 'en', title: 'x', body: 'y', fields: [], path: '/', link: null },
      { data: {}, at: 0 },
    );
    const s = stub([() => new Response(null, { status: 302, headers: { location: 'https://attacker.example/steal' } }), () => new Response('')]);
    await postOutbound(req, { fetchImpl: s.impl, lookup });
    assert.equal(s.calls[0]!.headers.Authorization, 'Bearer tk_SECRET');
    assert.equal(new URL(s.calls[1]!.url).host, 'attacker.example');
    assert.equal(s.calls[1]!.headers.Authorization, undefined);
  });
});
const DeliveryLike = /private|reserved|LAN/;

// ---------------------------------------------------------------- E4 / #3

describe('#3 notification flooding (E4)', () => {
  let t: B1App;
  let printerId: number;
  const calls: string[] = [];
  before(async () => {
    t = await createB1App({
      printerManager: { resolveEndpoint: async () => null },
      notifications: {
        fetchImpl: (async (_u: unknown, init: { body: string }) => {
          calls.push(String(init.body));
          return new Response(null, { status: 204 });
        }) as unknown as typeof fetch,
        retryDelaysMs: [0, 0, 0],
        lookup: async () => ['93.184.216.34'],
        dedupeMs: 0,
      },
    });
    printerId = (await t.admin.post('/api/admin/printers').send({ name: 'P', model: 'creality-k2se', host: 'sim' })).body.id;
    t.ctx.settings.patch({ 'notify.discord.enabled': true, 'notify.discord.webhookUrl': 'https://discord.com/api/webhooks/1234567890/fake-token-abcdefghijklmnopqrstuvwxyz' });
    await t.admin.patch(`/api/admin/users/${t.aliceId}`).send({ canPrintUploadedGcode: true });
    await t.admin.put(`/api/admin/users/${t.aliceId}/limits`).send({ enabled: true, maxGramsPerPrint: 1, maxGramsPerMonth: null, maxHoursPerPrint: null, requiresApproval: false });
  });
  after(() => t?.close());

  it('30 refused prints = 5 messages + one digest "N more"; long names are truncated', async () => {
    const up = await upload(t.alice, Buffer.from('G90\nM82\nG1 X10 Y10 E5000 F3000\n'), 'big.gcode');
    assert.equal(up.status, 201, JSON.stringify(up.body));
    for (let i = 0; i < 30; i++) {
      await t.alice.patch(`/api/files/${up.body.id}`).send({ name: `spam ${i} ADMIN READ THIS ${'x'.repeat(150)}.gcode` });
      const r = await t.alice.post('/api/prints').send({ printerId, fileId: up.body.id });
      assert.match(r.body.error?.code ?? '', /^prints\.limit/, JSON.stringify(r.body));
    }
    await t.ctx.notifications.flush();
    assert.equal(calls.length, 5);
    assert.ok(!calls[0]!.includes('x'.repeat(100)), 'file names are truncated');
    const view = (await t.admin.get('/api/admin/notifications')).body;
    assert.equal(view.rateLimit.maxPerWindow, 5);
    assert.equal(view.rateLimit.active[0].username, 'alice');
    assert.equal(view.rateLimit.active[0].held, 25);
    t.ctx.notifications.flood.flushDigests();
    await t.ctx.notifications.flush();
    assert.equal(calls.length, 6);
    assert.match(calls[5]!, /\+25 (more like this|avisos similares)/);
  });

  it('pending approval requests are capped per user (prints.too_many_pending)', async () => {
    await t.admin.put(`/api/admin/users/${t.aliceId}/limits`).send({ enabled: true, maxGramsPerPrint: null, maxGramsPerMonth: null, maxHoursPerPrint: null, requiresApproval: true });
    const up = await upload(t.alice, Buffer.from('G90\nG1 X1 E1\n'), 'small.gcode');
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await t.alice.post('/api/prints').send({ printerId, fileId: up.body.id })).status);
    assert.deepEqual(codes, [202, 202, 202, 409, 409, 409]);
    const r = await t.alice.post('/api/prints').send({ printerId, fileId: up.body.id });
    assert.equal(r.body.error.code, 'prints.too_many_pending');
  });

  it('notifyText strips control/bidi characters and truncates', () => {
    assert.equal(notifyText('a‮b\nc​d'), 'ab cd');
    assert.equal(Array.from(notifyText('é'.repeat(200))).length, 80);
  });

  it('FloodGuard only limits user-triggered events', () => {
    const g = new FloodGuard({ max: 1, windowMs: 60_000, onDigest: () => undefined });
    assert.equal(g.admit('print.finished', { userId: 1 }, 0), true);
    assert.equal(g.admit('print.finished', { userId: 1 }, 1), true);
    assert.equal(g.admit('approval.requested', { userId: 1 }, 2), true);
    assert.equal(g.admit('approval.requested', { userId: 1 }, 3), false);
    assert.equal(g.admit('approval.requested', { userId: 2 }, 4), true);
    g.stop();
  });
});

// ---------------------------------------------------------------- E7 / #7

// PROFILES (product decision): profiles are personal, so the owner keeps editing a shared preset; other users can
// only use or duplicate it. This replaces the earlier "admin-only once shared" rule of review A #7.
describe('#7 shared presets: owner or admin edits, others duplicate (E7, PROFILES)', () => {
  let t: B1App;
  const BASE = 'Hyper PLA @Creality K2 SE 0.4 nozzle';
  before(async () => (t = await createB1App()));
  after(() => t?.close());

  it('others get read-only + can duplicate; owner and admin edits are audited with the changed keys', async () => {
    const p = (await t.alice.post('/api/filament-presets').send({ basePresetId: BASE, name: 'Club PLA', values: { nozzle_temperature: '210' } })).body;
    assert.equal(p.canEdit, true);
    assert.equal((await t.alice.post(`/api/filament-presets/${p.id}/share`).send({ scope: 'shared' })).status, 200);
    assert.equal((await t.alice.get(`/api/filament-presets/${p.id}`)).body.canEdit, true);
    assert.equal((await t.bob.get(`/api/filament-presets/${p.id}`)).body.canEdit, false);
    const e = await t.bob.patch(`/api/filament-presets/${p.id}`).send({ values: { nozzle_temperature: '250' } });
    assert.equal(e.status, 403);
    assert.equal(e.body.error.code, 'filament_presets.forbidden');
    assert.equal((await t.bob.delete(`/api/filament-presets/${p.id}`)).status, 403);
    assert.equal((await t.bob.post(`/api/filament-presets/${p.id}/share`).send({ scope: 'private' })).status, 403);
    assert.equal((await t.bob.get(`/api/filament-presets/${p.id}`)).body.values.nozzle_temperature, '210');
    const own = await t.alice.patch(`/api/filament-presets/${p.id}`).send({ values: { nozzle_temperature: '212' } });
    assert.equal(own.status, 200, JSON.stringify(own.body));
    const dup = await t.bob.post('/api/filament-presets').send({ basePresetId: p.presetId, name: 'My Club PLA' });
    assert.equal(dup.status, 201, JSON.stringify(dup.body));
    assert.equal(dup.body.canEdit, true);
    const a = await t.admin.patch(`/api/filament-presets/${p.id}`).send({ values: { nozzle_temperature: '215' } });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const row = t.ctx.db.prepare("SELECT meta FROM audit_log WHERE action = 'filament_preset.update' ORDER BY id DESC LIMIT 1").get() as { meta: string };
    assert.deepEqual(JSON.parse(row.meta).changed, [{ key: 'nozzle_temperature', from: '212', to: '215' }]);
  });
});
