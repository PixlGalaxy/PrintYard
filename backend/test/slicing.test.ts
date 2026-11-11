import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { unzipSync } from 'fflate';
import { boxStl, createB1App, makePng, sceneFor, upload, type B1App } from './b1-helpers.js';

process.env.SLICEDOCK_FAKE_ENGINE_MS = '300';

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('projects (3MF builder)', () => {
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

  it('saves a Creality Print project with the scene sidecar and reopens it', async () => {
    const scene = sceneFor([model, model], { plate: [0, 1], at: [[100, 100], [10, 10]] });
    const res = await t.alice.post('/api/projects').send({ name: 'My project', scene, thumbnailPng: makePng(64, 64).toString('base64') });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.kind, 'project');
    assert.equal(res.body.name, 'My project.3mf');
    assert.deepEqual(res.body.meta.project, { plates: 2, objects: 2 });
    assert.ok(res.body.thumbnailUrl);

    const zip = unzipSync(new Uint8Array(readFileSync(t.ctx.files.absolutePath(t.ctx.files.getRow(res.body.id)!))));
    const text = (n: string) => new TextDecoder().decode(zip[n]!);
    assert.ok(zip['Metadata/plate_1.png']);
    assert.match(text('3D/3dmodel.model'), /<metadata name="Application">Creality_Print V7\.3\.1 Release<\/metadata>/);
    // Plate 2 (index 1) of 2: cols = 2 → x offset 220·1.2 = 264.
    assert.match(text('3D/3dmodel.model'), /<item objectid="2" transform="1 0 0 0 1 0 0 0 1 100 100 0" printable="1"\/>/);
    assert.match(text('3D/3dmodel.model'), /<item objectid="4" transform="1 0 0 0 1 0 0 0 1 274 10 0" printable="1"\/>/);
    assert.match(text('Metadata/creality.config'), /key="Company" value="Creality"/);
    const cfg = JSON.parse(text('Metadata/project_settings.config'));
    assert.equal(cfg.layer_height, '0.16');
    assert.deepEqual(cfg.different_settings_to_system, ['layer_height', '', '']);
    assert.equal(cfg.printer_settings_id, 'Creality K2 SE 0.4 nozzle');
    assert.deepEqual(cfg.filament_settings_id, ['Hyper PLA @Creality K2 SE 0.4 nozzle']);
    assert.deepEqual(cfg.filament_colour, ['#38BDF8']);
    assert.equal(cfg.from, 'project');
    assert.match(text('Metadata/model_settings.config'), /<metadata key="plater_id" value="2"\/>/);
    assert.deepEqual(JSON.parse(text('Metadata/slicedock_scene.json')), scene);

    const got = await t.alice.get(`/api/projects/${res.body.id}`);
    assert.equal(got.status, 200);
    assert.deepEqual(got.body.scene, scene);
    assert.equal((await t.bob.get(`/api/projects/${res.body.id}`)).status, 404);

    const put = await t.alice.put(`/api/projects/${res.body.id}`).send({ name: 'Renamed', scene: { ...scene, processOverrides: {} } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.name, 'Renamed.3mf');
    assert.deepEqual((await t.alice.get(`/api/projects/${res.body.id}`)).body.scene.processOverrides, {});
    assert.equal((await t.bob.put(`/api/projects/${res.body.id}`).send({ name: 'x', scene })).status, 404);
  });

  it('writes per-slot filament overrides (nozzle temperature) into the project config', async () => {
    const base = sceneFor([model]);
    const scene = { ...base, filaments: [{ ...base.filaments[0]!, overrides: { nozzle_temperature: '237' } }] };
    const res = await t.alice.post('/api/projects').send({ name: 'Hot', scene });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const zip = unzipSync(new Uint8Array(readFileSync(t.ctx.files.absolutePath(t.ctx.files.getRow(res.body.id)!))));
    const cfg = JSON.parse(new TextDecoder().decode(zip['Metadata/project_settings.config']!));
    assert.deepEqual(cfg.nozzle_temperature, ['237']);
    assert.deepEqual(cfg.different_settings_to_system, ['layer_height', 'nozzle_temperature', '']);
    assert.deepEqual((await t.alice.get(`/api/projects/${res.body.id}`)).body.scene.filaments[0].overrides, { nozzle_temperature: '237' });
    const bad = await t.alice
      .post('/api/projects')
      .send({ name: 'x', scene: { ...base, filaments: [{ ...base.filaments[0]!, overrides: { filament_end_gcode: 'x' } }] } });
    assert.equal(bad.body.error?.code, 'slice.invalid_override');
  });

  it("refuses other users' private models, unknown presets and dangerous overrides", async () => {
    const bobModel = (await upload(t.bob, boxStl(), 'bob.stl')).body.id;
    const r1 = await t.alice.post('/api/projects').send({ name: 'x', scene: sceneFor([bobModel]) });
    assert.equal(r1.status, 400);
    assert.equal(r1.body.error.code, 'projects.missing_model');
    const r2 = await t.alice.post('/api/projects').send({ name: 'x', scene: { ...sceneFor([model]), processPresetId: 'nope' } });
    assert.equal(r2.body.error.code, 'profiles.preset_not_found');
    for (const key of ['post_process', 'machine_start_gcode', 'filename_format', 'not_an_option']) {
      const r = await t.alice.post('/api/projects').send({ name: 'x', scene: { ...sceneFor([model]), processOverrides: { [key]: 'x' } } });
      assert.equal(r.body.error?.code, 'slice.invalid_override', key);
    }
  });
});

describe('slicing jobs (fake engine)', () => {
  let t: B1App;
  let model: number;
  before(async () => {
    t = await createB1App({ engine: { fake: true } });
    t.ctx.settings.patch({ 'files.retention.keep': 100 });
    model = (await upload(t.alice, boxStl(20, 20, 20), 'cube.stl')).body.id;
  });
  after(() => {
    t.ctx.slicing.stop();
    t.close();
  });

  const thumbs = { small: makePng(96, 96).toString('base64'), large: makePng(300, 300).toString('base64') };

  it('queues, slices, injects thumbnails, parses the summary and stores the G-code', async () => {
    const sent: unknown[] = [];
    const orig = t.ctx.hub.publish.bind(t.ctx.hub);
    t.ctx.hub.publish = ((topic: string, data: unknown, filter?: unknown) => {
      if (topic === 'slice.job') sent.push(data);
      return orig(topic, data, filter as never);
    }) as typeof t.ctx.hub.publish;
    const res = await t.alice.post('/api/slice').send({ scene: sceneFor([model]), plate: 0, thumbnails: thumbs });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.state, 'queued');
    assert.equal((await t.bob.get(`/api/slice/${res.body.id}`)).status, 404);
    const done = await waitFor(
      async () => (await t.alice.get(`/api/slice/${res.body.id}`)).body,
      (j) => ['done', 'failed', 'cancelled'].includes(j.state),
    );
    assert.equal(done.state, 'done', JSON.stringify(done));
    assert.equal(done.progress, 100);
    assert.equal(done.result.summary.layers, 100);
    assert.equal(done.result.summary.printerModel, 'Creality K2 SE');
    const file = (await t.alice.get(`/api/files/${done.result.fileId}`)).body;
    assert.equal(file.kind, 'gcode');
    assert.equal(file.name, 'obj0_plate1.gcode');
    // Sliced by SliceDock: summary trusted for limits (review finding #1), content hash recorded.
    assert.equal(file.meta.trusted, true);
    assert.equal(file.meta.gcode.estimateSource, 'slicer');
    assert.match(t.ctx.files.getRow(file.id)!.sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.ok(file.thumbnailUrl);
    const gcode = readFileSync(t.ctx.files.absolutePath(t.ctx.files.getRow(file.id)!), 'latin1');
    assert.match(gcode, /; HEADER_BLOCK_END\n\n; THUMBNAIL_BLOCK_START\n\n;\n; thumbnail begin 96x96 \d+\n/);
    assert.match(gcode, /; thumbnail begin 300x300 \d+\n/);
    const states = sent.map((j) => (j as { state: string }).state);
    assert.deepEqual([...new Set(states)], ['queued', 'preparing', 'slicing', 'postprocessing', 'done']);
    t.ctx.hub.publish = orig;
  });

  it('publishes smooth progress with stage ids at most ~4 per second', async () => {
    process.env.SLICEDOCK_FAKE_ENGINE_MS = '2500';
    const sent: { at: number; state: string; progress: number; stage?: string }[] = [];
    const orig = t.ctx.hub.publish.bind(t.ctx.hub);
    t.ctx.hub.publish = ((topic: string, data: unknown, filter?: unknown) => {
      if (topic === 'slice.job') sent.push({ at: Date.now(), ...(data as { state: string; progress: number; stage?: string }) });
      return orig(topic, data, filter as never);
    }) as typeof t.ctx.hub.publish;
    try {
      const res = await t.alice.post('/api/slice').send({ scene: sceneFor([model]), plate: 0 });
      const done = await waitFor(async () => (await t.alice.get(`/api/slice/${res.body.id}`)).body, (j) => j.state === 'done');
      assert.equal(done.stage, 'done');
      const mine = sent.filter((m) => m.state !== 'queued');
      for (let k = 1; k < mine.length; k++) assert.ok(mine[k]!.progress >= mine[k - 1]!.progress, 'monotonic');
      const slicing = mine.filter((m) => m.state === 'slicing').map((m) => m.progress);
      assert.ok(new Set(slicing).size >= 6, `intermediate values: ${slicing.join(',')}`);
      assert.ok(slicing.some((p) => p > 5 && p < 35), 'creeps during the silent load');
      const stages = [...new Set(mine.map((m) => m.stage))];
      for (const st of ['building', 'loading', 'gcode', 'done']) assert.ok(stages.includes(st), `${st} in ${stages.join(',')}`);
      // Short engine stages may be merged by the 4/s throttle; several must still show up.
      assert.ok(stages.filter((st) => ['slicing', 'walls', 'infill', 'supports', 'toolpath'].includes(st!)).length >= 2, stages.join(','));
      // ≤ 4/s overall, allowing the immediate state-change sends.
      const spanS = (mine.at(-1)!.at - mine[0]!.at) / 1000;
      assert.ok(mine.length <= Math.ceil(spanS * 4) + 6, `${mine.length} messages in ${spanS.toFixed(1)} s`);
    } finally {
      t.ctx.hub.publish = orig;
      process.env.SLICEDOCK_FAKE_ENGINE_MS = '300';
    }
  });

  it('runs one job at a time and cancels queued and running jobs', async () => {
    const a = (await t.alice.post('/api/slice').send({ scene: sceneFor([model]), plate: 0 })).body;
    const b = (await t.alice.post('/api/slice').send({ scene: sceneFor([model]), plate: 0 })).body;
    await new Promise((r) => setTimeout(r, 60));
    const bNow = (await t.alice.get(`/api/slice/${b.id}`)).body;
    assert.equal(bNow.state, 'queued');
    assert.match(bNow.message, /Waiting|Starting/);
    const cancelB = await t.alice.delete(`/api/slice/${b.id}`);
    assert.equal(cancelB.body.state, 'cancelled');
    const running = await waitFor(async () => (await t.alice.get(`/api/slice/${a.id}`)).body, (j) => j.state === 'slicing');
    assert.equal(running.state, 'slicing');
    await t.alice.delete(`/api/slice/${a.id}`);
    const cancelled = await waitFor(async () => (await t.alice.get(`/api/slice/${a.id}`)).body, (j) => j.state === 'cancelled');
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.result, undefined);
  });

  it('fails a job whose object is outside the bed; validates the request', async () => {
    const out = await t.alice.post('/api/slice').send({ scene: sceneFor([model], { at: [[210, 10]] }), plate: 0 });
    assert.equal(out.status, 202);
    const failed = await waitFor(async () => (await t.alice.get(`/api/slice/${out.body.id}`)).body, (j) => j.state === 'failed');
    assert.equal(failed.error, 'slice.object_outside');
    const empty = await t.alice.post('/api/slice').send({ scene: sceneFor([model]), plate: 1 });
    assert.equal(empty.body.error.code, 'slice.empty_plate');
    const badThumb = await t.alice.post('/api/slice').send({ scene: sceneFor([model]), plate: 0, thumbnails: { small: 'aGVsbG8=' } });
    assert.equal(badThumb.body.error.code, 'slice.invalid_thumbnail');
    const bobs = await t.bob.post('/api/slice').send({ scene: sceneFor([model]), plate: 0 });
    assert.equal(bobs.body.error.code, 'projects.missing_model');
  });
});

describe('engine manager', () => {
  it('without an engine, slicing answers 409 engine.not_installed', async () => {
    const t = await createB1App({ engine: { fake: false } });
    try {
      const model = (await upload(t.alice, boxStl(), 'c.stl')).body.id;
      const res = await t.alice.post('/api/slice').send({ scene: sceneFor([model]), plate: 0 });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'engine.not_installed');
      const status = await t.admin.get('/api/admin/engine');
      assert.equal(status.body.installed, null);
      assert.equal((await t.alice.get('/api/admin/engine')).status, 403);
      const rb = await t.admin.post('/api/admin/engine/rollback');
      assert.equal(rb.body.error.code, 'engine.no_previous');
      // The profiles API still works from the bundled snapshot.
      assert.equal((await t.alice.get('/api/profiles/creality-k2se')).body.machine.length, 1);
      assert.equal((await t.alice.get('/api/profiles/other')).status, 404);
      const es = await t.alice.get('/api/profiles/creality-k2se?lang=es');
      assert.equal(es.body.options.find((o: { key: string }) => o.key === 'layer_height').label, 'Altura de la capa');
      // Without ?lang the user's language applies (alice was created with the default 'es' from setup).
      const def = await t.alice.get('/api/profiles/creality-k2se');
      assert.equal(def.body.options.find((o: { key: string }) => o.key === 'layer_height').label, 'Altura de la capa');
      const en = await t.alice.get('/api/profiles/creality-k2se?lang=en');
      assert.equal(en.body.options.find((o: { key: string }) => o.key === 'layer_height').label, 'Layer height');
      const preset = await t.alice.get(`/api/profiles/creality-k2se/preset/process/${encodeURIComponent('0.20mm Standard @Creality K2 SE 0.4 nozzle')}`);
      assert.equal(preset.body.values.layer_height, '0.2');
    } finally {
      t.close();
    }
  });

  it('an install whose binary vanished is reported broken and slicing answers 409 engine.broken', async () => {
    const t = await createB1App({ engine: { fake: false } });
    try {
      // A Windows temp cleanup deleted squashfs-root/bin of a test install: the folder is still there.
      const root = join(t.ctx.config.appdataRoot, 'engine', 'versions', '7.3.1.6378', 'squashfs-root');
      mkdirSync(join(root, 'resources'), { recursive: true });
      writeFileSync(
        join(t.ctx.config.appdataRoot, 'engine', 'state.json'),
        JSON.stringify({ installed: { version: '7.3.1.6378', path: root, installedAt: 1 }, previous: null, latest: null, lastCheckAt: null }),
      );
      // Re-read the state as a restart would.
      const engine = t.ctx.engine as unknown as { persisted: unknown; readState(): unknown };
      engine.persisted = engine.readState();
      const status = await t.admin.get('/api/admin/engine');
      assert.equal(status.body.installed.version, '7.3.1.6378');
      assert.equal(status.body.broken, true);
      const model = (await upload(t.alice, boxStl(), 'c.stl')).body.id;
      const res = await t.alice.post('/api/slice').send({ scene: sceneFor([model]), plate: 0 });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'engine.broken');
      // Binary back (reinstalled): no longer broken.
      mkdirSync(join(root, 'bin'), { recursive: true });
      writeFileSync(join(root, 'bin', 'CrealityPrint'), '');
      assert.equal((await t.admin.get('/api/admin/engine')).body.broken, undefined);
    } finally {
      t.close();
    }
  });

  it('checks GitHub releases (stubbed), updates (fake) with progress and rolls back', async () => {
    const release = {
      tag_name: 'v7.3.1',
      published_at: '2026-10-31T05:41:23Z',
      assets: [
        { name: 'CrealityPrint-V7.3.1.6378-x86_64-Release.AppImage', size: 191511032, browser_download_url: 'https://github.com/CrealityOfficial/CrealityPrint/releases/download/v7.3.1/CrealityPrint-V7.3.1.6378-x86_64-Release.AppImage' },
        { name: 'CrealityPrint_7.3.1.6378_Release.exe', size: 1, browser_download_url: 'https://github.com/CrealityOfficial/CrealityPrint/releases/download/v7.3.1/CrealityPrint_7.3.1.6378_Release.exe' },
      ],
    };
    const fetchImpl = (async () => new Response(JSON.stringify(release), { status: 200 })) as typeof fetch;
    const t = await createB1App({ engine: { fake: true, fetchImpl } });
    const progress: { state: string }[] = [];
    const orig = t.ctx.hub.publish.bind(t.ctx.hub);
    t.ctx.hub.publish = ((topic: string, data: unknown, filter?: unknown) => {
      if (topic === 'engine.progress') progress.push(data as { state: string });
      return orig(topic, data, filter as never);
    }) as typeof t.ctx.hub.publish;
    try {
      const check = await t.admin.post('/api/admin/engine/check');
      assert.equal(check.status, 200, JSON.stringify(check.body));
      assert.deepEqual(check.body.latest, {
        version: '7.3.1.6378',
        publishedAt: '2026-10-31T05:41:23Z',
        assetUrl: 'https://github.com/CrealityOfficial/CrealityPrint/releases/download/v7.3.1/CrealityPrint-V7.3.1.6378-x86_64-Release.AppImage',
        size: 191511032,
        sha256: null,
      });
      assert.ok(check.body.lastCheckAt);
      const up = await t.admin.post('/api/admin/engine/update');
      assert.equal(up.status, 202);
      assert.equal((await t.admin.post('/api/admin/engine/update')).body.error.code, 'engine.busy');
      const st = await waitFor(async () => (await t.admin.get('/api/admin/engine')).body, (s) => s.state === 'idle' && s.progress === 100);
      assert.equal(st.installed.version, '7.3.1.6378-fake');
      assert.ok(['downloading', 'extracting', 'testing'].every((s) => progress.some((p) => p.state === s)));
      // The first install has nothing to roll back to.
      const rb = await t.admin.post('/api/admin/engine/rollback');
      assert.equal(rb.status, 409);
      assert.equal(rb.body.error.code, 'engine.no_previous');
    } finally {
      t.ctx.hub.publish = orig;
      t.close();
    }
  });
});
