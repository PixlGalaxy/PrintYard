import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { zipSync } from 'fflate';
import { createApp } from '../src/app.js';
import { load3mf } from '../src/modules/files/mesh.js';
import type { SlicerEngine } from '../src/modules/engine/engine.types.js';
import { boxStl, createB1App, sceneFor, upload, type B1App } from './b1-helpers.js';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { unzipSync } from 'fflate';

process.env.PRINTYARD_FAKE_ENGINE_MS = '200';

const enc = new TextEncoder();

describe('3MF vertex amplification', () => {
  it('only welds vertices that triangles use, so unused vertices × instances cost nothing', async () => {
    // A 30 KB file with 2000 vertices × 9000 instances used to weld 18 M unique vertices (~1.7 GB, then
    // "Map maximum size exceeded"). Here: 400 unused vertices + one triangle, 2000 instances.
    let verts = '';
    for (let i = 0; i < 400; i++) verts += `<vertex x="${i}" y="0" z="${i % 5}"/>`;
    let comps = '';
    for (let i = 0; i < 2000; i++) comps += `<component objectid="1" transform="1 0 0 0 1 0 0 0 1 0 ${i} 0"/>`;
    const xml =
      '<?xml version="1.0"?><model unit="millimeter"><resources>' +
      `<object id="1" type="model"><mesh><vertices>${verts}</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>` +
      `<object id="2" type="model"><components>${comps}</components></object>` +
      '</resources><build><item objectid="2"/></build></model>';
    const dir = mkdtempSync(join(tmpdir(), 'sd-3mf-'));
    try {
      const path = join(dir, 'bomb.3mf');
      writeFileSync(path, zipSync({ '3D/3dmodel.model': enc.encode(xml) }));
      const mesh = await load3mf(path);
      assert.equal(mesh.indices.length / 3, 2000);
      assert.ok(mesh.positions.length / 3 <= 3 * 2000, `welded ${mesh.positions.length / 3} vertices for 2000 triangles`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps triangles before a bad vertex reference and drops the rest of that mesh (unchanged behaviour)', async () => {
    const xml =
      '<?xml version="1.0"?><model unit="millimeter"><resources>' +
      '<object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/></vertices>' +
      '<triangles><triangle v1="0" v2="1" v3="2"/><triangle v1="0" v2="1" v3="3"/><triangle v1="0" v2="9" v3="3"/><triangle v1="1" v2="2" v3="3"/></triangles></mesh></object>' +
      '</resources><build><item objectid="1"/></build></model>';
    const dir = mkdtempSync(join(tmpdir(), 'sd-3mf-'));
    try {
      const path = join(dir, 'bad.3mf');
      writeFileSync(path, zipSync({ '3D/3dmodel.model': enc.encode(xml) }));
      const mesh = await load3mf(path);
      assert.equal(mesh.indices.length / 3, 2);
      assert.equal(mesh.positions.length / 3, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('library hardening', () => {
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

  it('a low filament_density override cannot shrink the grams that limits use', async () => {
    t.ctx.settings.patch({ 'files.retention.keep': 100 });
    // Like the real engine: `filament used [g]` = volume × filament_density ("for statistics only").
    const real = t.ctx.engine.current()!;
    const engine: SlicerEngine = {
      id: real.id,
      root: real.root,
      version: real.version,
      async slice(req) {
        const out = await real.slice(req);
        const zip = unzipSync(new Uint8Array(readFileSync(req.projectFile)));
        const cfg = JSON.parse(new TextDecoder().decode(zip['Metadata/project_settings.config']!));
        const density = Number(cfg.filament_density[0]);
        const g = (3.53 * density) / 1.24;
        const text = readFileSync(out.gcodePath, 'latin1').replace(/^(; (?:total )?filament used \[g\] = ).*$/gm, `$1${g.toFixed(2)}`);
        writeFileSync(out.gcodePath, text, 'latin1');
        return out;
      },
    };
    const orig = t.ctx.engine.current.bind(t.ctx.engine);
    t.ctx.engine.current = () => engine;
    try {
      const base = sceneFor([model]);
      const scene = { ...base, filaments: [{ ...base.filaments[0]!, overrides: { filament_density: '0.3' } }] };
      const res = await t.alice.post('/api/slice').send({ scene, plate: 0 });
      assert.equal(res.status, 202, JSON.stringify(res.body));
      let job = res.body;
      const end = Date.now() + 15_000;
      while (!['done', 'failed', 'cancelled'].includes(job.state) && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 50));
        job = (await t.alice.get(`/api/slice/${res.body.id}`)).body;
      }
      assert.equal(job.state, 'done', JSON.stringify(job));
      const grams = (job.result.summary.filamentGrams as number[]).reduce((a, b) => a + b, 0);
      assert.ok(grams >= 3.4, `limits would see ${grams} g for a 3.53 g print`);
      const file = (await t.alice.get(`/api/files/${job.result.fileId}`)).body;
      assert.ok(file.meta.gcode.filamentGrams[0] >= 3.4, JSON.stringify(file.meta.gcode));
    } finally {
      t.ctx.engine.current = orig;
    }
  });

  it('cleans project names like every other file name', async () => {
    const res = await t.alice.post('/api/projects').send({ name: 'evil\r\nname/../<b>x', scene: sceneFor([model]) });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.doesNotMatch(res.body.name, /[\r\n/<>]/);
  });

  it('removes the temp file of an aborted upload', async () => {
    const tmpDir = join((t.ctx.files as unknown as { dataRoot: string }).dataRoot, '.tmp');
    const server = createApp(t.ctx).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
      const login = await t.alice.get('/api/auth/me');
      assert.equal(login.status, 200);
      // Re-use alice's cookie.
      const cookie = (t.alice as unknown as { jar: { getCookies(o: unknown): { toValueString(): string }[] } }).jar
        .getCookies({ domain: '127.0.0.1', path: '/', secure: false, script: false })
        .map((c) => c.toValueString())
        .join('; ');
      const port = (server.address() as AddressInfo).port;
      const boundary = 'XBOUNDARY';
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/files',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(10 * 1024 * 1024),
          'sec-fetch-site': 'same-origin',
          cookie,
        },
      });
      req.on('error', () => undefined);
      req.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.stl"\r\nContent-Type: application/octet-stream\r\n\r\n`);
      req.write(Buffer.alloc(256 * 1024, 0x41));
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(readdirSync(tmpDir).length > 0, 'the upload started');
      req.destroy();
      const end = Date.now() + 3000;
      while (Date.now() < end && readdirSync(tmpDir).length > 0) await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(readdirSync(tmpDir), []);
    } finally {
      server.close();
    }
  });
});
