import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { createB1App, type B1App } from './b1-helpers.js';

process.env.SLICEDOCK_FAKE_ENGINE_MS = '200';

const PROCESS = '0.20mm Standard @Creality K2 SE 0.4 nozzle';
const PROCESS_016 = '0.16mm Standard @Creality K2 SE 0.4 nozzle';
const PLA = 'Hyper PLA @Creality K2 SE 0.4 nozzle';
const GENERIC_PETG = 'Generic PETG @Creality K2 SE 0.4 nozzle';

type Agent = B1App['alice'];
const b64 = (data: Uint8Array | string) => Buffer.from(typeof data === 'string' ? data : data).toString('base64');
const importFile = (agent: Agent, fileName: string, data: Uint8Array | string) => agent.post('/api/profile-files/import').send({ fileName, data: b64(data) });
const zip = (entries: Record<string, string | Uint8Array>) => {
  const z: Zippable = {};
  for (const [k, v] of Object.entries(entries)) z[k] = typeof v === 'string' ? strToU8(v) : v;
  return zipSync(z);
};

describe('Creality Print preset import/export', () => {
  let t: B1App;
  before(async () => {
    t = await createB1App({ engine: { fake: true } });
  });
  after(() => {
    t.ctx.slicing.stop();
    t.close();
  });

  const userProcess = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      from: 'User',
      inherits: PROCESS,
      is_custom_defined: '0',
      name: 'Imported strong',
      print_settings_id: 'Imported strong',
      version: '7.3.1.0',
      wall_loops: '4',
      sparse_infill_density: '35%',
      layer_height: '0.2', // same as the parent: not part of the diff
      ...over,
    });

  it('imports a single user process json as a diff against its parent', async () => {
    const res = await importFile(t.alice, 'Imported strong.json', userProcess());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.created.length, 1);
    const c = res.body.created[0];
    assert.equal(c.kind, 'process');
    assert.equal(c.inherits, PROCESS);
    assert.deepEqual((await t.alice.get(`/api/process-profiles/${c.id}`)).body.values, { sparse_infill_density: '35%', wall_loops: '4' });
    assert.deepEqual(res.body.dropped, []);
    assert.deepEqual(res.body.remapped, []);
    // Same name again: saved as "(2)" and reported.
    const again = await importFile(t.alice, 'x.json', userProcess());
    assert.equal(again.body.created[0].name, 'Imported strong (2)');
    assert.deepEqual(again.body.renamed, [{ from: 'Imported strong', to: 'Imported strong (2)' }]);
  });

  it('drops G-code keys and out-of-range values from hostile presets and reports them', async () => {
    const hostile = userProcess({
      name: 'Hostile\r\nM104 S999',
      machine_start_gcode: 'M104 S999\nM140 S200',
      post_process: ['/bin/sh -c "curl evil"'],
      filename_format: '../../etc/passwd',
      outer_wall_speed: '99999',
      wall_loops: '-1e309',
      sparse_infill_density: '20%\nM104 S999',
      notes: 'ok note\r\n; injected',
      bridge_speed: { nested: true },
    });
    const res = await importFile(t.alice, 'hostile.json', hostile);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const created = res.body.created[0];
    assert.ok(!created.name.includes('\n'));
    const stored = (await t.alice.get(`/api/process-profiles/${created.id}`)).body.values as Record<string, string>;
    for (const k of ['machine_start_gcode', 'post_process', 'filename_format', 'outer_wall_speed', 'wall_loops', 'bridge_speed']) assert.ok(!(k in stored), k);
    assert.ok(Object.values(stored).every((v) => !/[\r\n]/.test(v)), 'no CR/LF stored');
    const dropped = new Map((res.body.dropped as { key: string; reason: string }[]).map((d) => [d.key, d.reason]));
    assert.equal(dropped.get('machine_start_gcode'), 'unsafe');
    assert.equal(dropped.get('post_process'), 'unsafe');
    assert.equal(dropped.get('filename_format'), 'unsafe');
    assert.match(dropped.get('outer_wall_speed') ?? '', /^range/);
    assert.ok(dropped.has('wall_loops'));
    assert.equal(dropped.get('bridge_speed'), 'invalid_value');
    // "20%\nM104 S999" becomes one line and fails the number check: dropped, not stored with a newline.
    assert.ok(dropped.has('sparse_infill_density'));
  });

  it('imports a filament json from another printer, remapping the parent and keeping type/colour as metadata', async () => {
    const res = await importFile(
      t.alice,
      'petg.json',
      JSON.stringify({
        from: 'User',
        inherits: 'Some PETG @Creality K1C 0.4 nozzle',
        name: 'Club PETG',
        filament_settings_id: ['Club PETG'],
        version: '6.0.0.0',
        filament_type: ['PETG'],
        default_filament_colour: ['#00ff00'],
        nozzle_temperature: ['245'],
        filament_start_gcode: ['M104 S999'],
        nozzle_temperature_initial_layer: ['450'],
      }),
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const c = res.body.created[0];
    assert.equal(c.kind, 'filament');
    assert.equal(c.inherits, GENERIC_PETG);
    assert.deepEqual(res.body.remapped, [{ profile: 'Club PETG', from: 'Some PETG @Creality K1C 0.4 nozzle', to: GENERIC_PETG }]);
    const p = (await t.alice.get(`/api/filament-presets/${c.id}`)).body;
    assert.equal(p.filamentType, 'PETG');
    assert.equal(p.color, '#00FF00');
    assert.equal(p.values.nozzle_temperature, '245');
    assert.ok(!('filament_start_gcode' in p.values));
    assert.ok(!('nozzle_temperature_initial_layer' in p.values));
    const reasons = (res.body.dropped as { key: string; reason: string }[]).map((d) => `${d.key}:${d.reason}`);
    assert.ok(reasons.includes('filament_start_gcode:unsafe'));
    assert.ok(reasons.some((r) => r.startsWith('nozzle_temperature_initial_layer:range')));
  });

  it('imports a .creality_printer bundle: process and filament only, the printer preset is ignored', async () => {
    const bundle = zip({
      'bundle_structure.json': JSON.stringify({
        bundle_type: 'printer config bundle',
        printer_preset_name: 'My K2',
        printer_config: ['printer/My K2.json'],
        filament_config: ['filament/Bundle PLA.json'],
        process_config: ['process/Bundle fine.json'],
      }),
      'printer/My K2.json': JSON.stringify({ name: 'My K2', inherits: 'Creality K2 SE 0.4 nozzle', printer_settings_id: 'My K2', machine_start_gcode: 'M104 S300' }),
      'filament/Bundle PLA.json': JSON.stringify({ name: 'Bundle PLA', inherits: PLA, filament_settings_id: ['Bundle PLA'], nozzle_temperature: ['225'] }),
      'process/Bundle fine.json': JSON.stringify({ name: 'Bundle fine', inherits: PROCESS_016, print_settings_id: 'Bundle fine', wall_loops: '3' }),
    });
    const res = await importFile(t.alice, 'My K2.creality_printer', bundle);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual((res.body.created as { kind: string; name: string }[]).map((c) => `${c.kind}:${c.name}`).sort(), ['filament:Bundle PLA', 'process:Bundle fine']);
    assert.deepEqual(res.body.skipped, [{ entry: 'printer/My K2.json', reason: 'printer_preset' }]);
  });

  it('refuses oversized files, too many entries, zip bombs, malformed json and unsafe entry names', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 10, 0x20);
    assert.equal((await importFile(t.alice, 'big.json', big)).status, 413);

    const many: Record<string, string> = {};
    for (let i = 0; i < 205; i++) many[`p${i}.json`] = '{}';
    const tooMany = await importFile(t.alice, 'many.zip', zip(many));
    assert.equal(tooMany.status, 413);
    assert.equal(tooMany.body.error.code, 'profile_files.too_many_entries');

    // ~21 MB of zeros compresses to a few KB: refused while inflating, before it fills memory.
    const bomb = zipSync({ 'a.json': [new Uint8Array(1024 * 1024 * 21), { level: 9 }] });
    assert.ok(bomb.length < 200_000);
    assert.equal((await importFile(t.alice, 'bomb.zip', bomb)).body.error?.code, 'profile_files.too_large');

    assert.equal((await importFile(t.alice, 'bad.json', '{"name": "x", ')).body.error?.code, 'profile_files.invalid_json');
    assert.equal((await importFile(t.alice, 'arr.json', '[1,2]')).body.error?.code, 'profile_files.not_a_preset');
    assert.equal((await importFile(t.alice, 'x.exe', '{}')).body.error?.code, 'profile_files.unsupported_type');
    assert.equal((await importFile(t.alice, 'x.zip', 'not a zip')).body.error?.code, 'profile_files.invalid_archive');
    assert.equal((await t.alice.post('/api/profile-files/import').send({ fileName: 'x.json', data: '!!!' })).body.error?.code, 'validation.failed');

    const before = new Set(readdirSync(t.ctx.config.appdataRoot, { recursive: true }) as string[]);
    const sneaky = zip({
      '../../evil.json': userProcess({ name: 'Evil 1' }),
      '/abs/evil.json': userProcess({ name: 'Evil 2' }),
      'C:/win/evil.json': userProcess({ name: 'Evil 3' }),
      'readme.txt': 'hello',
      'broken.json': '{nope',
      'ok/Good.json': userProcess({ name: 'Good one' }),
    });
    const res = await importFile(t.alice, 'sneaky.zip', sneaky);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual((res.body.created as { name: string }[]).map((c) => c.name), ['Good one']);
    const skipped = new Map((res.body.skipped as { entry: string; reason: string }[]).map((s) => [s.entry, s.reason]));
    assert.equal(skipped.get('../../evil.json'), 'unsafe_path');
    assert.equal(skipped.get('/abs/evil.json'), 'unsafe_path');
    assert.equal(skipped.get('C:/win/evil.json'), 'unsafe_path');
    assert.equal(skipped.get('readme.txt'), 'not_json');
    assert.equal(skipped.get('broken.json'), 'invalid_json');
    const afterFiles = (readdirSync(t.ctx.config.appdataRoot, { recursive: true }) as string[]).filter((f) => !before.has(f));
    assert.ok(!afterFiles.some((f) => /evil/i.test(f)), `nothing written from entry names: ${afterFiles.join(', ')}`);
  });

  it('exports Creality Print formats and imports them back unchanged (round trip)', async () => {
    const proc = (await t.alice.post('/api/process-profiles').send({ basePresetId: PROCESS, name: 'Round trip', values: { wall_loops: '5', sparse_infill_density: '25%' } })).body;
    const fil = (
      await t.alice.post('/api/filament-presets').send({ basePresetId: PLA, name: 'Round PLA', color: '#FF8800', filamentType: 'PLA', values: { nozzle_temperature: '228', fan_max_speed: '90' } })
    ).body;

    const pz = await t.alice.post('/api/profile-files/export').send({ kind: 'process', ids: [proc.id], format: 'zip' });
    assert.equal(pz.status, 200, JSON.stringify(pz.body));
    assert.equal(pz.body.fileName, 'Process presets.zip');
    const pFiles = unzipSync(new Uint8Array(Buffer.from(pz.body.data, 'base64')));
    assert.deepEqual(Object.keys(pFiles), ['Round trip.json']);
    const pj = JSON.parse(new TextDecoder().decode(pFiles['Round trip.json']!));
    assert.deepEqual(pj, {
      from: 'User',
      inherits: PROCESS,
      is_custom_defined: '0',
      name: 'Round trip',
      print_settings_id: 'Round trip',
      sparse_infill_density: '25%',
      version: pj.version,
      wall_loops: '5',
    });
    assert.match(pj.version, /^\d+\.\d+\.\d+\.\d+$/);

    const fb = await t.alice.post('/api/profile-files/export').send({ kind: 'filament', ids: [fil.id], format: 'creality_filament' });
    assert.equal(fb.body.fileName, 'Round PLA.creality_filament');
    const fFiles = unzipSync(new Uint8Array(Buffer.from(fb.body.data, 'base64')));
    assert.deepEqual(Object.keys(fFiles).sort(), ['Creality/Round PLA.json', 'bundle_structure.json']);
    const structure = JSON.parse(new TextDecoder().decode(fFiles['bundle_structure.json']!));
    assert.equal(structure.bundle_type, 'filament config bundle');
    assert.equal(structure.filament_name, 'Hyper PLA');
    assert.deepEqual(structure.printer_vendor, [{ vendor: 'Creality', filament_path: ['Creality/Round PLA.json'] }]);
    const fj = JSON.parse(new TextDecoder().decode(fFiles['Creality/Round PLA.json']!));
    assert.deepEqual(fj.filament_settings_id, ['Round PLA']);
    assert.deepEqual(fj.nozzle_temperature, ['228']);
    assert.deepEqual(fj.default_filament_colour, ['#FF8800']);
    assert.equal(fj.inherits, PLA);

    const fz = await t.alice.post('/api/profile-files/export').send({ kind: 'filament', ids: [fil.id], format: 'zip' });
    assert.equal(fz.body.fileName, 'Filament presets.zip');

    // Import into bob's account: same parents, same values, same metadata.
    const back1 = await importFile(t.bob, pz.body.fileName, Buffer.from(pz.body.data, 'base64'));
    const back2 = await importFile(t.bob, fb.body.fileName, Buffer.from(fb.body.data, 'base64'));
    const back3 = await importFile(t.bob, fz.body.fileName, Buffer.from(fz.body.data, 'base64'));
    for (const r of [back1, back2, back3]) {
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.dropped, []);
      assert.deepEqual(r.body.remapped, []);
      assert.deepEqual(r.body.skipped, []);
    }
    const p2 = (await t.bob.get(`/api/process-profiles/${back1.body.created[0].id}`)).body;
    assert.equal(p2.name, 'Round trip');
    assert.equal(p2.inherits, PROCESS);
    assert.deepEqual(p2.values, proc.values);
    for (const r of [back2, back3]) {
      const f2 = (await t.bob.get(`/api/filament-presets/${r.body.created[0].id}`)).body;
      assert.equal(f2.inherits, PLA);
      assert.deepEqual(f2.values, fil.values);
      assert.equal(f2.color, '#FF8800');
    }

    // Export is limited to profiles the user can see.
    assert.equal((await t.bob.post('/api/profile-files/export').send({ kind: 'process', ids: [proc.id] })).status, 404);
    assert.equal((await t.alice.post('/api/profile-files/export').send({ kind: 'process', ids: [proc.id], format: 'creality_filament' })).body.error?.code, 'profile_files.invalid_format');
  });
});
