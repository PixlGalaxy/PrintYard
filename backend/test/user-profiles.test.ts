import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { unzipSync } from 'fflate';
import { boxStl, createB1App, sceneFor, upload, type B1App } from './b1-helpers.js';

process.env.PRINTYARD_FAKE_ENGINE_MS = '200';

const PROCESS = '0.20mm Standard @Creality K2 SE 0.4 nozzle';
const PROCESS_016 = '0.16mm Standard @Creality K2 SE 0.4 nozzle';
const PLA = 'Hyper PLA @Creality K2 SE 0.4 nozzle';

type Agent = B1App['alice'];

describe('user process profiles', () => {
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

  const create = (agent: Agent, body: Record<string, unknown>) => agent.post('/api/process-profiles').send({ basePresetId: PROCESS, name: 'Strong', ...body });

  it('creates, lists, edits and deletes a private profile; others cannot see it', async () => {
    const res = await create(t.alice, { name: 'Strong parts', values: { wall_loops: '4', sparse_infill_density: '40%' } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.presetId, `custom:${res.body.id}`);
    assert.equal(res.body.inherits, PROCESS);
    assert.deepEqual(res.body.values, { wall_loops: '4', sparse_infill_density: '40%' });
    assert.equal(res.body.canEdit, true);
    assert.equal(res.body.scope, 'private');

    assert.ok(((await t.alice.get('/api/process-profiles')).body as { id: number }[]).some((p) => p.id === res.body.id));
    assert.ok(!((await t.bob.get('/api/process-profiles')).body as { id: number }[]).some((p) => p.id === res.body.id));
    assert.equal((await t.bob.get(`/api/process-profiles/${res.body.id}`)).status, 404);
    assert.equal((await t.bob.patch(`/api/process-profiles/${res.body.id}`).send({ name: 'x' })).status, 404);
    assert.equal((await t.bob.delete(`/api/process-profiles/${res.body.id}`)).status, 404);
    assert.equal((await t.bob.post(`/api/process-profiles/${res.body.id}/share`).send({ scope: 'shared' })).status, 404);
    // Admins see and manage every profile.
    assert.equal((await t.admin.get(`/api/process-profiles/${res.body.id}`)).body.canEdit, true);

    const resolved = (await t.alice.get(`/api/profiles/creality-k2se/preset/process/${encodeURIComponent(res.body.presetId)}`)).body;
    assert.equal(resolved.values.wall_loops, '4');
    assert.equal(resolved.values.layer_height, '0.2', 'inherited from the parent');
    assert.equal(resolved.inherits, PROCESS);
    assert.deepEqual(resolved.customKeys, ['sparse_infill_density', 'wall_loops']);
    assert.equal((await t.bob.get(`/api/profiles/creality-k2se/preset/process/${encodeURIComponent(res.body.presetId)}`)).body.error?.code, 'profiles.preset_not_found');

    const patched = await t.alice.patch(`/api/process-profiles/${res.body.id}`).send({ name: 'Strong v2', values: { wall_loops: '5' } });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.deepEqual(patched.body.values, { wall_loops: '5' });
    assert.equal((await t.alice.delete(`/api/process-profiles/${res.body.id}`)).status, 204);
    assert.equal((await t.alice.get(`/api/process-profiles/${res.body.id}`)).status, 404);
    const audit = t.ctx.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'process_profile.%' ORDER BY id").all() as { action: string }[];
    assert.deepEqual(audit.map((a) => a.action), ['process_profile.create', 'process_profile.update', 'process_profile.delete']);
  });

  it('refuses G-code keys, unknown keys and out-of-range values, strips CR/LF and cleans names', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ values: { machine_start_gcode: 'M104 S300' } }, 'slice.invalid_override'],
      [{ values: { post_process: 'rm -rf /' } }, 'slice.invalid_override'],
      [{ values: { filename_format: 'x' } }, 'slice.invalid_override'],
      [{ values: { nozzle_temperature: '220' } }, 'slice.invalid_override'],
      [{ values: { outer_wall_speed: '99999' } }, 'filament_presets.invalid_value'],
      [{ values: { wall_loops: 'NaN' } }, 'filament_presets.invalid_value'],
      [{ values: { enable_support: 'yes' } }, 'filament_presets.invalid_value'],
      [{ basePresetId: 'nope' }, 'profiles.invalid_base'],
      [{ basePresetId: 'custom:99999' }, 'profiles.preset_not_found'],
      [{ name: PROCESS }, 'profiles.name_taken'],
      [{ name: 'a;b' }, 'validation.failed'],
      [{ name: '../../' }, 'validation.failed'],
    ];
    for (const [body, code] of cases) {
      const r = await create(t.alice, { name: 'Bad', ...body });
      assert.equal(r.body.error?.code, code, `${JSON.stringify(body)} → ${JSON.stringify(r.body)}`);
    }
    const clean = await create(t.alice, { name: '..\\evil/My\r\nprofile', values: { wall_loops: ' 3\r\n' } });
    assert.equal(clean.status, 201, JSON.stringify(clean.body));
    assert.equal(clean.body.name, 'My profile');
    assert.deepEqual(clean.body.values, { wall_loops: '3' });
    assert.equal((await create(t.alice, { name: 'my PROFILE' })).body.error?.code, 'profiles.name_taken');
    assert.equal((await create(t.bob, { name: 'My profile' })).status, 201, 'names are per owner');
  });

  it('shares with every user (owner or admin), shows the owner, and others can only duplicate', async () => {
    const p = (await create(t.bob, { name: 'Bob fast', basePresetId: PROCESS, values: { sparse_infill_density: '10%' } })).body;
    assert.equal((await t.alice.post(`/api/process-profiles/${p.id}/share`).send({ scope: 'shared' })).status, 404);
    const shared = await t.bob.post(`/api/process-profiles/${p.id}/share`).send({ scope: 'shared' });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.equal(shared.body.scope, 'shared');

    const bundle = (await t.alice.get('/api/profiles/creality-k2se')).body;
    const entry = bundle.process.find((x: { id: string }) => x.id === p.presetId);
    assert.ok(entry, 'shared profile in alice’s bundle');
    assert.equal(entry.custom, true);
    assert.equal(entry.ownerName, 'bob');
    assert.equal(entry.scope, 'shared');
    assert.equal(entry.inherits, PROCESS);
    assert.ok(bundle.process.slice(0, 3).every((x: { custom?: boolean }) => !x.custom), 'system presets first');

    const seen = (await t.alice.get(`/api/process-profiles/${p.id}`)).body;
    assert.equal(seen.canEdit, false);
    assert.equal(seen.ownerName, 'bob');
    assert.equal((await t.alice.patch(`/api/process-profiles/${p.id}`).send({ name: 'x' })).body.error?.code, 'profiles.forbidden');
    assert.equal((await t.alice.delete(`/api/process-profiles/${p.id}`)).status, 403);
    assert.equal((await t.alice.post(`/api/process-profiles/${p.id}/share`).send({ scope: 'private' })).status, 403);
    // The owner still edits a shared profile; an admin can too.
    assert.equal((await t.bob.patch(`/api/process-profiles/${p.id}`).send({ values: { sparse_infill_density: '12%' } })).status, 200);
    assert.equal((await t.admin.patch(`/api/process-profiles/${p.id}`).send({ name: 'Bob fast (club)' })).status, 200);

    const dup = await t.alice.post('/api/process-profiles').send({ basePresetId: p.presetId, name: 'Alice fast' });
    assert.equal(dup.status, 201, JSON.stringify(dup.body));
    assert.equal(dup.body.ownerId, t.aliceId);
    assert.equal(dup.body.inherits, PROCESS);
    assert.deepEqual(dup.body.values, { sparse_infill_density: '12%' });
  });

  it('applies a custom profile at build/slice time through the override path; unavailable profiles are refused', async () => {
    const p = (await create(t.alice, { name: 'Slice me', basePresetId: PROCESS_016, values: { wall_loops: '4', outer_wall_speed: '150' } })).body;
    const scene = { ...sceneFor([model]), processPresetId: p.presetId, processOverrides: { wall_loops: '3' } };
    const res = await t.alice.post('/api/projects').send({ name: 'Custom process', scene });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const z = unzipSync(new Uint8Array(readFileSync(t.ctx.files.absolutePath(t.ctx.files.getRow(res.body.id)!))));
    const cfg = JSON.parse(new TextDecoder().decode(z['Metadata/project_settings.config']!));
    assert.equal(cfg.print_settings_id, 'Slice me');
    assert.equal(cfg.inherits_group[0], PROCESS_016);
    assert.equal(cfg.wall_loops, '3', 'scene overrides win over the profile');
    assert.equal(cfg.outer_wall_speed, '150', 'profile value');
    assert.equal(cfg.layer_height, '0.16', 'from the 0.16 mm parent');
    assert.deepEqual(cfg.different_settings_to_system[0].split(';'), ['outer_wall_speed', 'wall_loops']);

    // A value that slipped into the DB (older row, manual edit) is re-checked on every use.
    t.ctx.db.prepare('UPDATE process_profiles SET values_json = ? WHERE id = ?').run(JSON.stringify({ outer_wall_speed: '99999' }), p.id);
    assert.equal((await t.alice.post('/api/slice').send({ scene, plate: 0 })).body.error?.code, 'slice.invalid_override');
    t.ctx.db.prepare('UPDATE process_profiles SET values_json = ? WHERE id = ?').run(JSON.stringify({ machine_end_gcode: 'M104 S0' }), p.id);
    assert.equal((await t.alice.post('/api/slice').send({ scene, plate: 0 })).body.error?.code, 'slice.invalid_override');
    t.ctx.db.prepare('UPDATE process_profiles SET values_json = ? WHERE id = ?').run(JSON.stringify({ wall_loops: '4' }), p.id);
    const ok = await t.alice.post('/api/slice').send({ scene, plate: 0 });
    assert.equal(ok.status, 202, JSON.stringify(ok.body));

    // Bob cannot slice with alice's private profile (project save and slice).
    const bobModel = (await upload(t.bob, boxStl(), 'b.stl')).body.id;
    const bobScene = { ...sceneFor([bobModel]), processPresetId: p.presetId };
    const denied = await t.bob.post('/api/slice').send({ scene: bobScene, plate: 0 });
    assert.equal(denied.body.error?.code, 'profiles.preset_not_found');
    assert.deepEqual(denied.body.error?.details, { kind: 'process', id: p.presetId });
    assert.equal((await t.bob.post('/api/projects').send({ name: 'x', scene: bobScene })).body.error?.code, 'profiles.preset_not_found');

    // Shared: bob may use it. Unshared again (or deleted): refused with the same clear error.
    await t.alice.post(`/api/process-profiles/${p.id}/share`).send({ scope: 'shared' });
    assert.equal((await t.bob.post('/api/projects').send({ name: 'shared ok', scene: bobScene })).status, 201);
    await t.alice.post(`/api/process-profiles/${p.id}/share`).send({ scope: 'private' });
    assert.equal((await t.bob.post('/api/slice').send({ scene: bobScene, plate: 0 })).body.error?.code, 'profiles.preset_not_found');
    assert.equal((await t.alice.delete(`/api/process-profiles/${p.id}`)).status, 204);
    assert.equal((await t.alice.post('/api/slice').send({ scene, plate: 0 })).body.error?.code, 'profiles.preset_not_found');
  });

  it('stores per-user defaults (system or custom), refuses unusable ones and clears them when the profile goes away', async () => {
    const p = (await create(t.alice, { name: 'Default me', values: { wall_loops: '3' } })).body;
    const set = await t.alice.patch('/api/account').send({ defaultProcessPreset: p.presetId, defaultFilamentPreset: PLA });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.user.defaultProcessPreset, p.presetId);
    assert.equal(set.body.user.defaultFilamentPreset, PLA);
    assert.equal((await t.alice.get('/api/auth/me')).body.user.defaultProcessPreset, p.presetId);
    assert.equal((await t.bob.patch('/api/account').send({ defaultProcessPreset: p.presetId })).body.error?.code, 'profiles.preset_not_found');
    assert.equal((await t.bob.patch('/api/account').send({ defaultFilamentPreset: 'Nope @x' })).body.error?.code, 'profiles.preset_not_found');
    assert.equal((await t.bob.patch('/api/account').send({ defaultProcessPreset: PROCESS_016 })).status, 200);

    // Shared → bob picks it as default → unshared: bob's default is cleared, alice keeps hers.
    await t.alice.post(`/api/process-profiles/${p.id}/share`).send({ scope: 'shared' });
    assert.equal((await t.bob.patch('/api/account').send({ defaultProcessPreset: p.presetId })).status, 200);
    await t.alice.post(`/api/process-profiles/${p.id}/share`).send({ scope: 'private' });
    const users = () => t.ctx.db.prepare('SELECT username, default_process_preset AS d FROM users WHERE username IN (?, ?) ORDER BY username').all('alice', 'bob');
    assert.deepEqual(users(), [
      { username: 'alice', d: p.presetId },
      { username: 'bob', d: null },
    ]);
    await t.alice.delete(`/api/process-profiles/${p.id}`);
    assert.deepEqual(users(), [
      { username: 'alice', d: null },
      { username: 'bob', d: null },
    ]);
    assert.equal((await t.alice.patch('/api/account').send({ defaultProcessPreset: null })).body.user.defaultProcessPreset, null);
  });
});
