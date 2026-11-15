import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PrinterSimulator } from '../src/printers/sim/simulator.js';
import { ADMIN, createTestApp, setupBody, type TestApp } from './helpers.js';
import { api, loginCookie, startServer, waitFor, type LiveServer } from './live-helpers.js';

const isJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8;

/** Reads a multipart MJPEG response until `frames` JPEG parts arrived, then cancels it. */
async function readFrames(res: Response, frames: number): Promise<Uint8Array[]> {
  const boundary = /boundary=([^;]+)/.exec(res.headers.get('content-type') ?? '')?.[1];
  assert.ok(boundary, 'multipart boundary');
  const reader = res.body!.getReader();
  let buf = Buffer.alloc(0);
  const out: Uint8Array[] = [];
  while (out.length < frames) {
    const { value, done } = await reader.read();
    if (done) break;
    buf = Buffer.concat([buf, value]);
    for (;;) {
      const head = buf.indexOf('\r\n\r\n');
      if (head < 0) break;
      const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, head).toString())?.[1]);
      if (buf.length < head + 4 + len) break;
      assert.ok(buf.subarray(0, head).toString().includes(`--${boundary}`));
      out.push(buf.subarray(head + 4, head + 4 + len));
      buf = buf.subarray(head + 4 + len);
    }
  }
  await reader.cancel();
  return out;
}

describe('printer camera proxy (simulator)', () => {
  let t: TestApp;
  let live: LiveServer;
  let sim: PrinterSimulator;
  let printerId: number;
  let admin: string;
  let alice: string;
  const get = (cookie: string | null, path: string) => fetch(`${live.base}${path}`, cookie ? { headers: { cookie } } : {});

  before(async () => {
    sim = new PrinterSimulator({ tickMs: 50 });
    const port = await sim.start();
    t = createTestApp({
      context: {
        printFiles: { get: () => null },
        printerManager: {
          resolveEndpoint: async (h) => (h === 'sim' ? { host: '127.0.0.1', wsPort: port, httpPort: port, moonrakerPort: port, cameraPort: port } : null),
        },
      },
    });
    await t.agent.post('/api/setup/complete').send(setupBody({ printer: null, exposure: { mode: 'none' } }));
    await t.agent.post('/api/admin/users').send({ username: 'alice', password: 'alice-password-1', role: 'user' });
    printerId = (await t.agent.post('/api/admin/printers').send({ name: 'Sim', model: 'creality-k2se', host: 'sim' })).body.id;
    live = await startServer(t.ctx);
    admin = await loginCookie(live.base, ADMIN.username, ADMIN.password);
    alice = await loginCookie(live.base, 'alice', 'alice-password-1');
  });
  after(async () => {
    t?.ctx.camera.stop();
    await live?.close();
    t?.close();
    await sim?.stop();
  });

  it('new printers have the camera on', async () => {
    const r = await api(live.base, admin, 'GET', '/api/admin/printers');
    assert.deepEqual(r.body.find((p: { id: number }) => p.id === printerId).camera, { type: 'mjpeg' });
  });

  it('anonymous callers get 401 (snapshot and stream)', async () => {
    for (const path of ['snapshot', 'stream']) {
      const r = await get(null, `/api/printers/${printerId}/camera/${path}`);
      assert.equal(r.status, 401);
      await r.body?.cancel();
    }
  });

  it('a signed-in user gets a JPEG snapshot', async () => {
    const r = await get(alice, `/api/printers/${printerId}/camera/snapshot`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/jpeg');
    assert.equal(r.headers.get('cache-control'), 'private, no-store');
    assert.ok(isJpeg(new Uint8Array(await r.arrayBuffer())));
  });

  it('streams MJPEG; viewers share one connection to the printer, closed after the last one leaves', async () => {
    const before = sim.cameraStreams;
    const [a, b] = await Promise.all([get(alice, `/api/printers/${printerId}/camera/stream`), get(admin, `/api/printers/${printerId}/camera/stream`)]);
    assert.equal(a.status, 200);
    assert.match(a.headers.get('content-type') ?? '', /^multipart\/x-mixed-replace; boundary=/);
    assert.equal(a.headers.get('x-accel-buffering'), 'no');
    const [fa, fb] = await Promise.all([readFrames(a, 3), readFrames(b, 3)]);
    assert.equal(fa.length, 3);
    assert.ok(fa.every(isJpeg) && fb.every(isJpeg));
    assert.equal(sim.cameraStreams - before, 1, 'one upstream stream for both viewers');
    assert.equal(t.ctx.camera.openFeeds, 1);
    await waitFor(() => t.ctx.camera.openFeeds === 0, 10_000);
  });

  it('turning the camera off: 404 camera_disabled, and an open stream ends', async () => {
    const r = await get(alice, `/api/printers/${printerId}/camera/stream`);
    assert.equal(r.status, 200);
    const reader = r.body!.getReader();
    let got = 0;
    while (got < 2000) {
      const { value, done } = await reader.read();
      assert.ok(!done, 'stream open before the change');
      got += value!.length;
    }
    const patch = await api(live.base, admin, 'PATCH', `/api/admin/printers/${printerId}`, { camera: { type: 'none' } });
    assert.equal(patch.status, 200);
    assert.deepEqual(patch.body.camera, { type: 'none' });
    // the stream ends within the watch interval (5 s)
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    const off = await api(live.base, alice, 'GET', `/api/printers/${printerId}/camera/snapshot`);
    assert.equal(off.status, 404);
    assert.equal(off.body.error.code, 'printers.camera_disabled');
    assert.equal((await api(live.base, admin, 'PATCH', `/api/admin/printers/${printerId}`, { camera: { type: 'bogus' } })).status, 400);
    assert.equal((await api(live.base, admin, 'PATCH', `/api/admin/printers/${printerId}`, { camera: { type: 'mjpeg' } })).status, 200);
  });

  it('a camera-only change keeps a dynamic-IP printer dynamic and does not reconnect it', async () => {
    let changes = 0;
    const off = t.ctx.printers.onChange(() => changes++);
    try {
      const dyn = (await api(live.base, admin, 'PATCH', `/api/admin/printers/${printerId}`, { staticIp: false, mac: 'AA:BB:CC:DD:EE:01' })).body;
      assert.equal(dyn.staticIp, false);
      changes = 0;
      for (const body of [{ camera: { type: 'none' } }, { camera: { type: 'mjpeg' } }, { bedSurfaces: ['Textured PEI Plate'] }]) {
        const r = await api(live.base, admin, 'PATCH', `/api/admin/printers/${printerId}`, body);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.staticIp, false, JSON.stringify(body));
      }
      assert.equal(changes, 0, 'no driver reconnect');
    } finally {
      off();
    }
  });

  it('only admins change the camera setting', async () => {
    const r = await api(live.base, alice, 'PATCH', `/api/admin/printers/${printerId}`, { camera: { type: 'none' } });
    assert.equal(r.status, 403);
  });

  it('no camera answering: 502 camera_unavailable', async () => {
    sim.cameraOn = false;
    try {
      const snap = await api(live.base, alice, 'GET', `/api/printers/${printerId}/camera/snapshot`);
      assert.equal(snap.status, 502);
      assert.equal(snap.body.error.code, 'printers.camera_unavailable');
      const stream = await api(live.base, alice, 'GET', `/api/printers/${printerId}/camera/stream`);
      assert.equal(stream.status, 502);
    } finally {
      sim.cameraOn = true;
    }
  });

  it('unknown printer: 404', async () => {
    const r = await api(live.base, alice, 'GET', '/api/printers/9999/camera/snapshot');
    assert.equal(r.status, 404);
  });
});
