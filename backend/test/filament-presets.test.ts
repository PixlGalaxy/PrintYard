import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { unzipSync } from 'fflate';
import { validateFilamentValues } from '../src/modules/filament-presets/filament-presets.service.js';
import { boxStl, createB1App, sceneFor, upload, type B1App } from './b1-helpers.js';

process.env.SLICEDOCK_FAKE_ENGINE_MS = '200';

const BASE = 'Hyper PLA @Creality K2 SE 0.4 nozzle';
const BASE_PETG = 'Hyper PETG @Creality K2 SE 0.4 nozzle';

describe('custom filament presets', () => {
  let t: B1App;
  let model: number;
  before(async () => {
    t = await createB1App({ engine: { fake: true } });
    model = (await upload(t.alice, boxStl(20, 20, 20), 'cube.stl')).body.id;
  });
  after(() => {
    t.ctx.slicing.stop();
    t.close();
  });

  const create = (agent: B1App['alice'], body: Record<string, unknown>) =>
    agent.post('/api/filament-presets').send({ basePresetId: BASE, name: 'My PLA', ...body });

  it('creates, lists, updates and deletes a private preset', async () => {
    const res = await create(t.alice, { name: 'Silk PLA', color: '#ff00aa', filamentType: 'PLA', values: { nozzle_temperature: '230' } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.presetId, `custom:${res.body.id}`);
    assert.equal(res.body.inherits, BASE);
    assert.equal(res.body.color, '#FF00AA');
    assert.equal(res.body.scope, 'private');
    assert.deepEqual(res.body.values, { nozzle_temperature: '230' });
    assert.equal(res.body.canEdit, true);

    const mine = (await t.alice.get('/api/filament-presets')).body as { id: number }[];
    assert.ok(mine.some((p) => p.id === res.body.id));
    assert.ok(!((await t.bob.get('/api/filament-presets')).body as { id: number }[]).some((p) => p.id === res.body.id));
    assert.equal((await t.bob.get(`/api/filament-presets/${res.body.id}`)).status, 404);

    const patched = await t.alice.patch(`/api/filament-presets/${res.body.id}`).send({ name: 'Silk PLA v2', values: { nozzle_temperature: '232', fan_max_speed: '80' } });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.name, 'Silk PLA v2');
    assert.deepEqual(patched.body.values, { nozzle_temperature: '232', fan_max_speed: '80' });
    assert.equal((await t.bob.patch(`/api/filament-presets/${res.body.id}`).send({ name: 'x' })).status, 404);
    assert.equal((await t.bob.delete(`/api/filament-presets/${res.body.id}`)).status, 404);
    assert.equal((await t.alice.delete(`/api/filament-presets/${res.body.id}`)).status, 204);
    assert.equal((await t.alice.get(`/api/filament-presets/${res.body.id}`)).status, 404);
    const audit = t.ctx.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'filament_preset.%' ORDER BY id").all() as { action: string }[];
    assert.deepEqual(
      audit.map((a) => a.action),
      ['filament_preset.create', 'filament_preset.update', 'filament_preset.delete'],
    );
  });

  it('validates keys, values, names and the base preset', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ values: { filament_start_gcode: 'M104 S0' } }, 'slice.invalid_override'],
      [{ values: { layer_height: '0.1' } }, 'slice.invalid_override'],
      [{ values: { nozzle_temperature: '900' } }, 'filament_presets.invalid_value'],
      [{ values: { nozzle_temperature: 'hot' } }, 'filament_presets.invalid_value'],
      [{ values: { nozzle_temperature: '220.5' } }, 'filament_presets.invalid_value'],
      [{ values: { filament_diameter: 'NaN' } }, 'filament_presets.invalid_value'],
      [{ values: { slow_down_for_layer_cooling: 'yes' } }, 'filament_presets.invalid_value'],
      [{ values: { filament_z_hop_types: 'Teleport' } }, 'filament_presets.invalid_value'],
      [{ basePresetId: 'nope' }, 'filament_presets.invalid_base'],
      [{ basePresetId: 'custom:99999' }, 'profiles.preset_not_found'],
      [{ name: BASE }, 'filament_presets.name_taken'],
      [{ name: 'a;b' }, 'validation.failed'],
      [{ name: '../' }, 'validation.failed'],
    ];
    for (const [body, code] of cases) {
      const r = await create(t.alice, { name: 'Bad', ...body });
      assert.equal(r.body.error?.code, code, `${JSON.stringify(body)} → ${JSON.stringify(r.body)}`);
    }
    // CR/LF stripping and `nil` for the Setting Overrides page.
    assert.deepEqual(validateFilamentValues({ filament_notes: 'line1\r\n; injected', filament_retraction_length: 'nil' }), {
      filament_notes: 'line1 ; injected',
      filament_retraction_length: 'nil',
    });
    const first = await create(t.alice, { name: 'Dup' });
    assert.equal(first.status, 201);
    assert.equal((await create(t.alice, { name: 'dup' })).body.error?.code, 'filament_presets.name_taken');
    assert.equal((await create(t.bob, { name: 'Dup' })).status, 201, 'names are per owner');
  });

  it('shares presets (owner or admin) and merges them into the profile bundle', async () => {
    const own = (await create(t.bob, { name: 'Bob PETG', basePresetId: BASE_PETG, values: { nozzle_temperature: '245' } })).body;
    assert.equal((await t.alice.post(`/api/filament-presets/${own.id}/share`).send({ scope: 'shared' })).status, 404, 'private of another user');
    const shared = await t.bob.post(`/api/filament-presets/${own.id}/share`).send({ scope: 'shared' });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.equal(shared.body.scope, 'shared');

    const bundle = (await t.alice.get('/api/profiles/creality-k2se')).body;
    const entry = bundle.filament.find((f: { id: string }) => f.id === `custom:${own.id}`);
    assert.ok(entry, 'shared preset in alice’s bundle');
    assert.equal(entry.custom, true);
    assert.equal(entry.inherits, BASE_PETG);
    assert.equal(entry.filamentType, 'PETG');
    assert.equal(entry.ownerId, t.bobId);
    assert.equal(entry.scope, 'shared');
    // Alice can use but not edit it.
    assert.equal((await t.alice.get(`/api/filament-presets/${own.id}`)).body.canEdit, false);
    assert.equal((await t.alice.patch(`/api/filament-presets/${own.id}`).send({ name: 'x' })).body.error?.code, 'filament_presets.forbidden');
    assert.equal((await t.alice.delete(`/api/filament-presets/${own.id}`)).status, 403);

    const resolved = (await t.alice.get(`/api/profiles/creality-k2se/preset/filament/${encodeURIComponent(`custom:${own.id}`)}`)).body;
    assert.equal(resolved.values.nozzle_temperature, '245');
    assert.equal(resolved.inherits, BASE_PETG);
    assert.ok(resolved.customKeys.includes('nozzle_temperature'));
    const base = (await t.alice.get(`/api/profiles/creality-k2se/preset/filament/${encodeURIComponent(BASE_PETG)}`)).body;
    assert.equal(resolved.values.filament_density, base.values.filament_density, 'inherited values come from the base');
    assert.equal((await t.admin.get('/api/filament-presets?scope=shared')).body.length, 1);
    assert.equal((await t.alice.get('/api/filament-presets?scope=everyone')).status, 403);
  });

  it('duplicates from a custom preset and writes the custom values into the 3MF', async () => {
    const src = (await create(t.alice, { name: 'Hot PLA', values: { nozzle_temperature: '235', hot_plate_temp: '65' } })).body;
    const dup = await create(t.alice, { name: 'Hot PLA copy', basePresetId: src.presetId, values: { fan_max_speed: '70' } });
    assert.equal(dup.status, 201, JSON.stringify(dup.body));
    assert.equal(dup.body.inherits, BASE);
    assert.deepEqual(dup.body.values, { nozzle_temperature: '235', hot_plate_temp: '65', fan_max_speed: '70' });

    const base = sceneFor([model]);
    const scene = {
      ...base,
      filaments: [
        { slot: 1, presetId: dup.body.presetId, color: '#FF0000', overrides: { nozzle_temperature_initial_layer: '240' } },
        { slot: 2, presetId: BASE, color: '#00FF00' },
      ],
    };
    const res = await t.alice.post('/api/projects').send({ name: 'Custom', scene });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const zip = unzipSync(new Uint8Array(readFileSync(t.ctx.files.absolutePath(t.ctx.files.getRow(res.body.id)!))));
    const cfg = JSON.parse(new TextDecoder().decode(zip['Metadata/project_settings.config']!));
    assert.deepEqual(cfg.nozzle_temperature, ['235', '220']);
    assert.deepEqual(cfg.hot_plate_temp, ['65', '60']);
    assert.deepEqual(cfg.nozzle_temperature_initial_layer, ['240', '220']);
    assert.deepEqual(cfg.filament_settings_id, ['Hot PLA copy', BASE]);
    assert.deepEqual(cfg.inherits_group, ['', BASE, '', '']);
    assert.deepEqual(cfg.different_settings_to_system, [
      'layer_height',
      'fan_max_speed;hot_plate_temp;nozzle_temperature;nozzle_temperature_initial_layer',
      '',
      '',
    ]);

    // Permission: bob cannot use alice's private preset (project save and slicing).
    const bobModel = (await upload(t.bob, boxStl(), 'b.stl')).body.id;
    const bobScene = { ...sceneFor([bobModel]), filaments: [{ slot: 1, presetId: src.presetId, color: '#FF0000' }] };
    assert.equal((await t.bob.post('/api/projects').send({ name: 'x', scene: bobScene })).body.error?.code, 'profiles.preset_not_found');
    assert.equal((await t.bob.post('/api/slice').send({ scene: bobScene, plate: 0 })).body.error?.code, 'profiles.preset_not_found');
    const sliced = await t.alice.post('/api/slice').send({ scene: { ...scene, plates: [{ index: 0 }] }, plate: 0 });
    assert.equal(sliced.status, 202, JSON.stringify(sliced.body));
    // The preset can be deleted while projects use it: the 3MF already has the values.
    assert.equal((await t.alice.delete(`/api/filament-presets/${dup.body.id}`)).status, 204);
  });

  it('hands presets over when a user is deleted', async () => {
    const carol = await t.admin.post('/api/admin/users').send({ username: 'carol', password: 'carol-password-1', role: 'admin' });
    const carolId = carol.body.id as number;
    const now = Date.now();
    const ins = t.ctx.db.prepare(
      'INSERT INTO filament_presets (owner_id, scope, name, inherits, values_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    ins.run(carolId, 'private', 'Carol private', BASE, '{}', now, now);
    ins.run(carolId, 'shared', 'Carol shared', BASE, '{}', now, now);
    assert.equal((await t.admin.delete(`/api/admin/users/${carolId}?files=delete`)).status, 204);
    const rows = t.ctx.db.prepare("SELECT name, owner_id FROM filament_presets WHERE name LIKE 'Carol%'").all() as { name: string; owner_id: number }[];
    assert.deepEqual(rows.map((r) => r.name), ['Carol shared']);
    assert.notEqual(rows[0]!.owner_id, carolId);
  });
});
