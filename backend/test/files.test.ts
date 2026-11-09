import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { boxStl, createB1App, makePng, upload, type B1App } from './b1-helpers.js';

const FIXTURE = readFileSync(new URL('./fixtures/k2se-cube.gcode', import.meta.url));

describe('files library', () => {
  let t: B1App;
  before(async () => {
    t = await createB1App();
    t.ctx.settings.patch({ 'files.retention.keep': 100 });
  });
  after(() => t.close());

  it('uploads a binary STL with stats, server-generated storage name and owner', async () => {
    const res = await upload(t.alice, boxStl(20, 30, 10), 'Cubé test.stl');
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.kind, 'model');
    assert.equal(res.body.ext, 'stl');
    assert.equal(res.body.name, 'Cubé test.stl');
    assert.equal(res.body.visibility, 'private');
    assert.equal(res.body.ownerName, 'alice');
    assert.equal(res.body.meta.triangles, 12);
    assert.deepEqual(res.body.meta.bbox, [20, 30, 10]);
    const row = t.ctx.files.getRow(res.body.id)!;
    assert.equal(row.stored_path, `users/${t.aliceId}/models/${res.body.id}-cube-test.stl`);
    assert.ok(existsSync(t.ctx.files.absolutePath(row)));
  });

  it('never uses the client path: traversal names are reduced to a base name', async () => {
    const res = await upload(t.alice, boxStl(), '../../../etc/evil.stl');
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'evil.stl');
    const abs = t.ctx.files.absolutePath(t.ctx.files.getRow(res.body.id)!);
    assert.ok(abs.startsWith(resolve(t.ctx.config.dataRoot, 'users') + sep));
    assert.throws(() => t.ctx.files.absolutePath({ stored_path: '../outside.stl' }));
  });

  it('rejects other extensions, fake content, empty and cross-site uploads', async () => {
    const exe = await upload(t.alice, Buffer.from('MZ'), 'virus.exe');
    assert.equal(exe.status, 400);
    assert.equal(exe.body.error.code, 'files.unsupported_type');
    const fake = await upload(t.alice, Buffer.from('hello, not an stl'), 'fake.stl');
    assert.equal(fake.status, 400);
    assert.equal(fake.body.error.code, 'files.invalid_format');
    const zip = await upload(t.alice, Buffer.from('not a zip'), 'x.3mf');
    assert.equal(zip.body.error.code, 'files.invalid_format');
    const cross = await t.alice.post('/api/files').set('Sec-Fetch-Site', 'cross-site').attach('file', boxStl(), 'a.stl');
    assert.equal(cross.status, 403);
    const noProof = await t.alice.post('/api/files').attach('file', boxStl(), 'a.stl');
    assert.equal(noProof.status, 415);
    const wrongOrigin = await t.alice.post('/api/files').set('Origin', 'https://evil.example').attach('file', boxStl(), 'a.stl');
    assert.equal(wrongOrigin.status, 415);
    const anon = await t.request.post('/api/files').set('Sec-Fetch-Site', 'same-origin').attach('file', boxStl(), 'a.stl');
    assert.equal(anon.status, 401);
    // Nothing left behind in the temp folder.
    const tmp = join(t.ctx.config.dataRoot, '.tmp');
    assert.deepEqual(existsSync(tmp) ? readdirSync(tmp) : [], []);
  });

  it('enforces files.maxUploadMb (413) and removes the partial file', async () => {
    t.ctx.settings.patch({ 'files.maxUploadMb': 1 });
    try {
      const big = Buffer.alloc(1024 * 1024 + 10, 0x3b); // ";;;;" is valid-looking G-code text
      const res = await upload(t.alice, big, 'big.gcode');
      assert.equal(res.status, 413);
      assert.equal(res.body.error.code, 'files.too_large');
      assert.deepEqual(readdirSync(join(t.ctx.config.dataRoot, '.tmp')), []);
    } finally {
      t.ctx.settings.patch({ 'files.maxUploadMb': 200 });
    }
  });

  it('parses the G-code summary and keeps embedded thumbnails', async () => {
    const res = await upload(t.alice, FIXTURE, 'cube.gcode');
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.kind, 'gcode');
    // Uploaded G-code: the comments are only `declared`; the numbers come from the moves (review finding #1).
    // (The fixture is a trimmed slice, so the computed usage is far below what its footer claims.)
    const g = res.body.meta.gcode;
    assert.equal(g.estimateSource, 'computed');
    assert.deepEqual(g.declared, { printSeconds: 21 * 60 + 20, filamentGrams: [3.53], layers: 100 });
    assert.equal(g.printerModel, 'Creality K2 SE');
    assert.equal(g.slicer, 'Creality_Print V7.3.1.6378');
    assert.ok(g.filamentGrams[0] > 0 && g.filamentMm[0] > 0 && g.printSeconds > 0 && g.layers > 0, JSON.stringify(g));
    assert.notEqual(res.body.meta.trusted, true);
    assert.equal(res.body.thumbnailUrl, null);
  });

  it('ownership and visibility: private files are invisible to others, admins see everything', async () => {
    const mine = await upload(t.alice, boxStl(), 'private.stl');
    const id = mine.body.id;
    assert.equal((await t.bob.get(`/api/files/${id}`)).status, 404);
    assert.equal((await t.bob.get(`/api/files/${id}/download`)).status, 404);
    assert.equal((await t.bob.get(`/api/files/${id}/content`)).status, 404);
    assert.equal((await t.bob.patch(`/api/files/${id}`).send({ visibility: 'shared' })).status, 404);
    assert.equal((await t.bob.delete(`/api/files/${id}`)).status, 404);
    assert.equal((await t.admin.get(`/api/files/${id}`)).status, 200);
    const bobList = await t.bob.get('/api/files?scope=private');
    assert.ok(!bobList.body.some((f: { id: number }) => f.id === id));
    assert.equal((await t.bob.get('/api/files?scope=all')).status, 403);
    const all = await t.admin.get('/api/files?scope=all');
    assert.ok(all.body.some((f: { id: number }) => f.id === id));

    const shared = await t.alice.patch(`/api/files/${id}`).send({ visibility: 'shared' });
    assert.equal(shared.status, 200);
    assert.equal(shared.body.visibility, 'shared');
    assert.equal((await t.bob.get(`/api/files/${id}/download`)).status, 200);
    const sharedList = await t.bob.get('/api/files?scope=shared&kind=model');
    assert.ok(sharedList.body.some((f: { id: number }) => f.id === id));
    // Shared is readable, not writable, by others.
    const steal = await t.bob.patch(`/api/files/${id}`).send({ name: 'mine.stl' });
    assert.equal(steal.status, 403);
    assert.equal(steal.body.error.code, 'files.forbidden');
    assert.equal((await t.bob.delete(`/api/files/${id}`)).status, 403);
    // Admin can change it.
    assert.equal((await t.admin.patch(`/api/files/${id}`).send({ pinned: true })).body.pinned, true);
  });

  it('download sends the original name; content is inline and sandboxed', async () => {
    const f = await upload(t.alice, boxStl(), 'Benchy ñ.stl');
    const dl = await t.alice.get(`/api/files/${f.body.id}/download`).buffer(true);
    assert.equal(dl.status, 200);
    assert.match(dl.headers['content-disposition']!, /^attachment; filename="Benchy _\.stl"; filename\*=UTF-8''Benchy%20%C3%B1\.stl$/);
    assert.equal(dl.body.length, boxStl().length);
    const raw = await t.alice.get(`/api/files/${f.body.id}/content`);
    assert.match(raw.headers['content-disposition']!, /^inline/);
    assert.equal(raw.headers['x-content-type-options'], 'nosniff');
    assert.match(raw.headers['content-security-policy']!, /sandbox/);
  });

  it('rename keeps the extension; patch validates', async () => {
    const f = await upload(t.alice, boxStl(), 'a.stl');
    const r = await t.alice.patch(`/api/files/${f.body.id}`).send({ name: 'renamed' });
    assert.equal(r.body.name, 'renamed.stl');
    assert.equal((await t.alice.patch(`/api/files/${f.body.id}`).send({ owner_id: 1 })).status, 400);
  });

  it('thumbnails: PUT PNG (raw or JSON) by the owner, GET by readers', async () => {
    const f = await upload(t.alice, boxStl(), 'thumb.stl');
    const id = f.body.id;
    const png = makePng(96, 96);
    const put = await t.alice.put(`/api/files/${id}/thumbnail`).set('Sec-Fetch-Site', 'same-origin').set('Content-Type', 'image/png').send(png);
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.match(put.body.thumbnailUrl, new RegExp(`^/api/files/${id}/thumbnail\\?v=\\d+$`));
    const get = await t.alice.get(`/api/files/${id}/thumbnail`).buffer(true);
    assert.equal(get.headers['content-type'], 'image/png');
    assert.deepEqual(Buffer.from(get.body), png);
    const json = await t.alice.put(`/api/files/${id}/thumbnail`).send({ png: makePng(10, 10).toString('base64') });
    assert.equal(json.status, 200);
    const notPng = await t.alice.put(`/api/files/${id}/thumbnail`).send({ png: Buffer.from('GIF89a').toString('base64') });
    assert.equal(notPng.body.error.code, 'files.invalid_thumbnail');
    assert.equal((await t.bob.put(`/api/files/${id}/thumbnail`).send({ png: png.toString('base64') })).status, 404);
  });

  it('delete removes the row, the file and the thumbnail', async () => {
    const f = await upload(t.alice, boxStl(), 'gone.stl');
    const row = t.ctx.files.getRow(f.body.id)!;
    const abs = t.ctx.files.absolutePath(row);
    await t.ctx.files.writeThumbnail(row.id, makePng(4, 4));
    assert.equal((await t.alice.delete(`/api/files/${f.body.id}`)).status, 204);
    assert.equal(existsSync(abs), false);
    assert.equal(existsSync(t.ctx.files.thumbnailPath(row.id)), false);
    assert.equal((await t.alice.get(`/api/files/${f.body.id}`)).status, 404);
  });
});

describe('files retention', () => {
  let t: B1App;
  before(async () => {
    t = await createB1App();
  });
  after(() => t.close());

  const ids = async (agent: B1App['alice']) =>
    ((await agent.get('/api/files?scope=private')).body as { id: number }[]).map((f) => f.id).sort((a, b) => a - b);

  it('keeps the newest N private files per user, exempting pinned and shared ones, and audits it', async () => {
    t.ctx.settings.patch({ 'files.retention.enabled': true, 'files.retention.keep': 3 });
    const pinned = (await upload(t.alice, boxStl(), 'pinned.stl')).body.id;
    await t.alice.patch(`/api/files/${pinned}`).send({ pinned: true });
    const shared = (await upload(t.alice, boxStl(), 'shared.stl', { visibility: 'shared' })).body.id;
    const uploaded: number[] = [];
    for (let i = 0; i < 5; i++) uploaded.push((await upload(t.alice, boxStl(), `f${i}.stl`)).body.id);
    // bob's files are not affected by alice's uploads
    const bobFile = (await upload(t.bob, boxStl(), 'bob.stl')).body.id;

    const kept = await ids(t.alice);
    assert.deepEqual(kept, [pinned, shared, ...uploaded.slice(-3)].sort((a, b) => a - b));
    assert.deepEqual(await ids(t.bob), [bobFile]);
    for (const gone of uploaded.slice(0, 2)) {
      assert.equal(t.ctx.files.getRow(gone), undefined);
      assert.equal(existsSync(join(t.ctx.config.dataRoot, 'users', String(t.aliceId), 'models', `${gone}-f${uploaded.indexOf(gone)}.stl`)), false);
    }
    const audit = await t.admin.get('/api/admin/audit');
    const entries = audit.body.items.filter((e: { action: string }) => e.action === 'file.retention');
    assert.ok(entries.length >= 1);
    assert.deepEqual(entries.flatMap((e: { meta: { removed: number[] } }) => e.meta.removed).sort(), uploaded.slice(0, 2).sort());
  });

  it('models used by a saved project are kept', async () => {
    t.ctx.settings.patch({ 'files.retention.keep': 2 });
    const model = (await upload(t.bob, boxStl(), 'used.stl')).body.id;
    // A (pinned) project row referencing the model.
    const project = (await upload(t.bob, boxStl(), 'p.stl')).body.id;
    await t.bob.patch(`/api/files/${project}`).send({ pinned: true });
    t.ctx.files.setProjectRefs(project, [model]);
    for (let i = 0; i < 3; i++) await upload(t.bob, boxStl(), `n${i}.stl`);
    assert.ok(t.ctx.files.getRow(model), 'referenced model survives retention');
  });

  it('does nothing when disabled', async () => {
    t.ctx.settings.patch({ 'files.retention.enabled': false, 'files.retention.keep': 1 });
    const before = (await ids(t.alice)).length;
    await upload(t.alice, boxStl(), 'x.stl');
    await upload(t.alice, boxStl(), 'y.stl');
    assert.equal((await ids(t.alice)).length, before + 2);
  });
});
