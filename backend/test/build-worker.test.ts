import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AppError } from '../src/errors.js';
import { BuildPool } from '../src/modules/projects/build-pool.js';
import { buildProjectConfig } from '../src/modules/projects/scene.js';
import { createB1App, sceneFor, type B1App } from './b1-helpers.js';

/** Binary STL with `n` small triangles spread over the bed (not watertight; the loader still has to weld them). */
function bigStl(n: number): Buffer {
  const buf = Buffer.alloc(84 + 50 * n);
  buf.writeUInt32LE(n, 80);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;
    const x = rnd() * 60;
    const y = rnd() * 60;
    const z = rnd() * 30;
    const pts = [x, y, z, x + 0.5, y, z + rnd(), x, y + 0.5, z + rnd()];
    pts.forEach((v, k) => buf.writeFloatLE(v, o + k * 4));
  }
  return buf;
}

describe('project build worker', () => {
  let t: B1App;
  let big: number;
  let broken: number;
  const viewer = () => ({ id: t.aliceId, role: 'user' as const });

  before(async () => {
    t = await createB1App({ engine: { fake: true } });
    t.ctx.settings.patch({ 'files.retention.keep': 100 });
    const add = async (name: string, data: Buffer) => {
      const tmp = await t.ctx.files.tempPath('stl');
      writeFileSync(tmp, data);
      const f = await t.ctx.files.addFile(
        { id: t.aliceId, username: 'alice' },
        { tmpPath: tmp, name, kind: 'model', ext: 'stl', visibility: 'private', size: data.length, sha256: null, meta: {} },
        { username: 'alice' },
      );
      return f.id;
    };
    big = await add('big.stl', bigStl(400_000));
    broken = await add('broken.stl', Buffer.from('solid x\nthis is not a mesh\nendsolid\n'));
  });
  after(async () => {
    await t.ctx.projects.pool.terminate();
    t.ctx.slicing.stop();
    t.close();
  });

  const dest = (n: string) => join(t.ctx.config.appdataRoot, `${n}.3mf`);
  const partials = () => readdirSync(t.ctx.config.appdataRoot).filter((f) => f.endsWith('.part'));

  it('keeps the event loop responsive while a big project builds', async () => {
    let maxGap = 0;
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 10);
    const started = Date.now();
    try {
      const out = await t.ctx.projects.build(viewer(), sceneFor([big]), dest('big'), { validateBounds: true });
      assert.equal(out.triangles, 400_000);
      assert.equal(out.objects, 1);
    } finally {
      clearInterval(timer);
    }
    const took = Date.now() - started;
    assert.ok(took > 300, `build should be heavy enough to matter (${took} ms)`);
    assert.ok(maxGap < 100, `a 10 ms timer was delayed ${maxGap} ms during a ${took} ms build`);
    assert.ok(t.ctx.projects.pool.alive, 'worker kept warm until idle');
  });

  it('propagates error codes from the worker', async () => {
    await assert.rejects(t.ctx.projects.build(viewer(), sceneFor([broken]), dest('broken')), (e: unknown) => e instanceof AppError && e.code === 'projects.invalid_model');
    const nine = sceneFor(Array(13).fill(big), { at: Array(13).fill([60, 60]) as [number, number][] });
    await assert.rejects(t.ctx.projects.build(viewer(), nine, dest('nine')), (e: unknown) => e instanceof AppError && e.code === 'projects.too_complex');
    await assert.rejects(
      t.ctx.projects.build(viewer(), sceneFor([big], { at: [[200, 200]] }), dest('out'), { validateBounds: true }),
      (e: unknown) => e instanceof AppError && e.code === 'slice.object_outside',
    );
    // Authorisation stays on the main thread.
    await assert.rejects(t.ctx.projects.build({ id: t.bobId, role: 'user' }, sceneFor([big]), dest('bob')), (e: unknown) => e instanceof AppError && e.code === 'projects.missing_model');
  });

  it('cancel terminates the worker and removes partial output', async () => {
    const ac = new AbortController();
    const p = t.ctx.projects.build(viewer(), sceneFor([big]), dest('cancel'), { signal: ac.signal, abortError: () => new AppError(499, 'slice.cancelled', 'Cancelled') });
    setTimeout(() => ac.abort(), 150);
    const t0 = Date.now();
    await assert.rejects(p, (e: unknown) => e instanceof AppError && e.code === 'slice.cancelled');
    assert.ok(Date.now() - t0 < 2000, 'cancel is immediate');
    assert.equal(t.ctx.projects.pool.alive, false, 'worker terminated (memory released)');
    assert.deepEqual(partials(), []);
    // The next build gets a fresh worker.
    const out = await t.ctx.projects.build(viewer(), sceneFor([big]), dest('after-cancel'));
    assert.equal(out.triangles, 400_000);
  });

  it('timeout terminates the worker with projects.build_timeout', async () => {
    await assert.rejects(
      t.ctx.projects.build(viewer(), sceneFor([big]), dest('slow'), { timeoutMs: 100 }),
      (e: unknown) => e instanceof AppError && e.code === 'projects.build_timeout',
    );
    assert.equal(t.ctx.projects.pool.alive, false);
    assert.deepEqual(partials(), []);
  });

  it('an idle worker is terminated after idleMs', async () => {
    const pool = new BuildPool({ idleMs: 50 });
    const scene = sceneFor([big]);
    const row = t.ctx.files.getRow(big)!;
    const out = await pool.run({
      scene,
      config: buildProjectConfig(t.ctx.profiles, scene),
      dest: dest('idle'),
      sources: { [big]: { path: t.ctx.files.absolutePath(row), ext: 'stl', name: 'big', fileName: 'big.stl' } },
      appVersion: '7.3.1',
    });
    assert.equal(out.objects, 1);
    assert.equal(pool.alive, true);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(pool.alive, false);
  });
});
