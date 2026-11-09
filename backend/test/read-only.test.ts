import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { PrintableFile } from '../src/modules/printing/files-source.js';
import { CrealityConnection, type SocketLike } from '../src/printers/k2se/connection.js';
import { K2SELiveDriver } from '../src/printers/k2se/live-driver.js';
import { isReadOnlyFrame } from '../src/printers/read-only.js';
import { PrinterSimulator } from '../src/printers/sim/simulator.js';
import { ADMIN, createTestApp, setupBody, type TestApp } from './helpers.js';
import { api, loginCookie, startServer, waitFor, type LiveServer } from './live-helpers.js';

// node --test runs each file in its own process, so this does not leak into other suites.
process.env.SLICEDOCK_READ_ONLY = '1';

const isReadOnlyError = (e: { code?: string; status?: number }) => e.code === 'printers.read_only' && e.status === 423;
const isWrite = (frame: string) => !isReadOnlyFrame(frame);

describe('read-only mode: frame classification', () => {
  it('only heart_beat, "ok" and get are reads', () => {
    assert.ok(isReadOnlyFrame('ok'));
    assert.ok(isReadOnlyFrame({ ModeCode: 'heart_beat', msg: 'x' }));
    assert.ok(isReadOnlyFrame({ method: 'get', params: { ReqPrinterPara: 1 } }));
    assert.ok(isReadOnlyFrame('{"method":"get","params":{"boxsInfo":1}}'));
    for (const f of [
      { method: 'set', params: { pause: 1 } },
      { method: 'set', params: { stop: 1 } },
      { method: 'set', params: { opGcodeFile: 'printprt:/x.gcode' } },
      { method: 'set', params: { gcodeCmd: 'M104 S0' } },
      { method: 'set', params: { nozzleTempControl: 0 } },
      { ModeCode: 'heart_beat', msg: 'x', params: { stop: 1 } },
      'garbage',
      [1],
    ]) {
      assert.equal(isReadOnlyFrame(f), false, JSON.stringify(f));
    }
  });
});

class FakeSocket extends EventEmitter implements SocketLike {
  sent: string[] = [];
  send(d: string) {
    this.sent.push(d);
  }
  close() {}
  terminate() {}
}

describe('read-only mode: transport refuses before a byte is written', () => {
  it('CrealityConnection.send throws for set frames and writes nothing', async () => {
    const sock = new FakeSocket();
    const c = new CrealityConnection({ resolveUrl: async () => 'ws://10.0.0.9:9999', createSocket: () => sock, onFrame() {}, onOnline() {} });
    c.start();
    await new Promise((r) => setImmediate(r));
    sock.emit('open');
    sock.emit('message', Buffer.from('{"state":1}'), false);
    sock.sent.length = 0;
    for (const params of [{ pause: 1 }, { pause: 0 }, { stop: 1 }, { opGcodeFile: 'printprt:/a.gcode' }, { gcodeCmd: 'G28' }, { bedTempControl: { num: 0, val: 0 } }]) {
      assert.throws(() => c.send({ method: 'set', params }), isReadOnlyError);
    }
    assert.throws(() => c.send('{"method":"set","params":{"lightSw":0}}'), isReadOnlyError);
    assert.deepEqual(sock.sent, []);
    assert.equal(c.send({ method: 'get', params: { boxsInfo: 1 } }), true);
    assert.equal(sock.sent.length, 1);
    c.stop();
  });
});

describe('read-only mode against the simulator', () => {
  let sim: PrinterSimulator;
  let port: number;
  let dir: string;
  let gpath: string;

  before(async () => {
    sim = new PrinterSimulator({ tickMs: 25 });
    port = await sim.start();
    dir = mkdtempSync(join(tmpdir(), 'slicedock-ro-'));
    gpath = join(dir, 'a.gcode');
    writeFileSync(gpath, 'G28\n');
  });
  after(async () => {
    await sim.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('driver: pause/resume/cancel/start/upload all throw printers.read_only; nothing reaches the printer', async () => {
    const d = new K2SELiveDriver({
      printerId: 1,
      host: 'sim',
      resolveEndpoint: async () => ({ host: '127.0.0.1', wsPort: port, httpPort: port, moonrakerPort: port }),
    });
    d.connect();
    await waitFor(() => d.getStatus().online);
    await waitFor(() => d.getIdentity().mac); // identity GET done
    const http0 = sim.httpLog.length;
    await assert.rejects(d.pause(), isReadOnlyError);
    await assert.rejects(d.resume(), isReadOnlyError);
    await assert.rejects(d.cancel(), isReadOnlyError);
    await assert.rejects(d.startPrint('/usr/data/printer_data/gcodes/calibration_cube.gcode'), isReadOnlyError);
    await assert.rejects(d.uploadFile('a.gcode', gpath), isReadOnlyError);
    await assert.rejects(d.sendGcode('G28'), isReadOnlyError);
    await assert.rejects(d.sendGcode('EXCLUDE_OBJECT NAME=Object_1_id_0_copy_0'), isReadOnlyError);
    await assert.rejects(d.setLight(false), isReadOnlyError);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(sim.commands, []); // no `set` ever arrived
    assert.equal(sim.uploads.length, 0);
    assert.ok(sim.wsLog.length > 0);
    assert.deepEqual(sim.wsLog.filter(isWrite), []);
    assert.deepEqual(sim.httpLog.slice(http0).filter((l) => !l.startsWith('GET ')), []);
    assert.ok(sim.moonRequests.every((m) => m === 'printer.objects.subscribe'));
    // reads still work
    assert.ok(Array.isArray(d.getStatus().cfs));
    d.disconnect();
  });

  describe('API', () => {
    let t: TestApp;
    let live: LiveServer;
    let admin: string;
    let printerId: number;
    const files = new Map<number, PrintableFile>();

    before(async () => {
      t = createTestApp({
        context: {
          printFiles: { get: (id) => files.get(id) ?? null },
          printerManager: { resolveEndpoint: async (h) => (h === 'sim' ? { host: '127.0.0.1', wsPort: port, httpPort: port, moonrakerPort: port } : null) },
        },
      });
      await t.agent.post('/api/setup/complete').send(setupBody({ printer: null, exposure: { mode: 'none' } }));
      printerId = (await t.agent.post('/api/admin/printers').send({ name: 'S', model: 'creality-k2se', host: 'sim' })).body.id;
      files.set(1, { id: 1, ownerId: 1, kind: 'gcode', visibility: 'private', name: 'a.gcode', path: gpath, gcode: null });
      t.ctx.printerManager.start();
      live = await startServer(t.ctx);
      admin = await loginCookie(live.base, ADMIN.username, ADMIN.password);
      await waitFor(() => t.ctx.printerManager.status(printerId).online);
    });
    after(async () => {
      await live.close();
      t.close();
    });

    it('GET /api/config reports readOnly', async () => {
      const r = await api(live.base, '', 'GET', '/api/config');
      assert.equal(r.body.readOnly, true);
      assert.deepEqual(r.body.files, { retentionEnabled: true, retentionKeep: 10 });
      t.ctx.settings.patch({ 'files.retention.enabled': false, 'files.retention.keep': 25 });
      assert.deepEqual((await api(live.base, '', 'GET', '/api/config')).body.files, { retentionEnabled: false, retentionKeep: 25 });
    });

    it('every printer-affecting route returns 423 printers.read_only', async () => {
      // a pending request to try approving (inserted directly: creating one is a write route too)
      const pid = Number(
        t.ctx.db
          .prepare(`INSERT INTO prints (user_id, printer_id, file_id, file_name, state, created_at) VALUES (1, ?, 1, 'a.gcode', 'pending', ?)`)
          .run(printerId, Date.now()).lastInsertRowid,
      );
      const http0 = sim.httpLog.length;
      const ws0 = sim.wsLog.length;
      for (const [method, path, body] of [
        ['POST', `/api/printers/${printerId}/pause`],
        ['POST', `/api/printers/${printerId}/resume`],
        ['POST', `/api/printers/${printerId}/cancel`],
        ['POST', `/api/printers/${printerId}/bed-cleared`],
        ['POST', '/api/prints', { printerId, fileId: 1, confirmBedClear: true }],
        ['POST', `/api/prints/${pid}/approve`, {}],
        ['POST', `/api/printers/${printerId}/control`, { action: 'home', axes: 'all' }],
        ['POST', `/api/printers/${printerId}/control`, { action: 'fan', percent: 50 }],
        ['POST', `/api/printers/${printerId}/control`, { action: 'temp', heater: 'nozzle', target: 0 }],
        ['POST', `/api/printers/${printerId}/control`, { action: 'motors_off' }],
        ['POST', `/api/printers/${printerId}/control`, { action: 'light', on: false }],
        ['POST', `/api/printers/${printerId}/control`, { action: 'speed_factor', percent: 120 }],
        ['POST', `/api/printers/${printerId}/control`, { action: 'flow_factor', percent: 95 }],
        ['POST', `/api/printers/${printerId}/exclude-object`, { name: 'Object_1_id_0_copy_0' }],
      ] as [string, string, unknown?][]) {
        const r = await api(live.base, admin, method, path, body);
        assert.equal(r.status, 423, `${method} ${path}`);
        assert.equal(r.body.error.code, 'printers.read_only');
      }
      await assert.rejects(
        t.ctx.printing.startPrint({ id: 1, username: 'admin', role: 'admin' }, { printerId, fileId: 1, source: 'mcp' }),
        isReadOnlyError,
      );
      await assert.rejects(
        t.ctx.printerControl.control({ id: 1, username: 'admin', role: 'admin' }, printerId, { action: 'home', axes: 'all' }),
        isReadOnlyError,
      );
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(sim.commands, []);
      assert.deepEqual(sim.gcodeLog, []);
      assert.equal(sim.uploads.length, 0);
      assert.deepEqual(sim.wsLog.slice(ws0).filter(isWrite), []);
      assert.deepEqual(sim.httpLog.slice(http0).filter((l) => !l.startsWith('GET ')), []);
      assert.equal((t.ctx.db.prepare('SELECT state FROM prints WHERE id = ?').get(pid) as { state: string }).state, 'pending');
      assert.equal((t.ctx.db.prepare('SELECT COUNT(*) AS n FROM prints').get() as { n: number }).n, 1);
    });

    it('reads keep working: status, live view', async () => {
      const s = await api(live.base, admin, 'GET', `/api/printers/${printerId}/status`);
      assert.equal(s.status, 200);
      assert.equal(s.body.online, true);
      assert.equal((await api(live.base, admin, 'GET', `/api/printers/${printerId}/current-gcode`)).body.error.code, 'printers.no_current_job');
    });
  });
});
