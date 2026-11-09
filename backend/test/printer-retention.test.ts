import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { PrintableFile } from '../src/modules/printing/files-source.js';
import { PrinterSimulator } from '../src/printers/sim/simulator.js';
import { createTestApp, setupBody, type TestApp } from './helpers.js';
import { waitFor } from './live-helpers.js';

const GCODE = ['; SliceDock retention test', ';LAYER_CHANGE', 'G1 X10 Y10 E1', '; estimated printing time (normal mode) = 10m 0s', ''].join('\n');
const DIR = '/usr/data/printer_data/gcodes';

describe('printer file retention (simulator)', () => {
  let t: TestApp;
  let sim: PrinterSimulator;
  let dir: string;
  let gpath: string;
  let printerId: number;
  const files = new Map<number, PrintableFile>();
  const audit = (action: string) => (t.ctx.audit.list(500) as { action: string; target: string }[]).filter((e) => e.action === action);
  const upload = async (name: string) => {
    const { path } = await t.ctx.printerManager.driver(printerId).uploadFile(name, gpath);
    t.ctx.printerRetention.recordUpload(printerId, path, null, null);
    return path;
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'slicedock-retention-'));
    gpath = join(dir, 'cube.gcode');
    writeFileSync(gpath, GCODE);
    // Slow simulated print (1 sim second per tick) so the job stays active during the test.
    sim = new PrinterSimulator({ tickMs: 25, simSecondsPerTick: 1, heatPerTick: 100 });
    const port = await sim.start();
    t = createTestApp({
      context: {
        printFiles: { get: (id) => files.get(id) ?? null },
        printerManager: {
          resolveEndpoint: async (host) => (host === 'sim' ? { host: '127.0.0.1', wsPort: port, httpPort: port, moonrakerPort: port } : null),
        },
      },
    });
    await t.agent.post('/api/setup/complete').send(setupBody({ printer: null, exposure: { mode: 'none' } }));
    files.set(1, { id: 1, ownerId: 1, kind: 'gcode', visibility: 'private', name: 'Printing now.gcode', path: gpath, gcode: { printSeconds: 600 } });
    printerId = (await t.agent.post('/api/admin/printers').send({ name: 'Sim', model: 'creality-k2se', host: 'sim' })).body.id;
    t.ctx.printerManager.start();
    await waitFor(() => t.ctx.printerManager.status(printerId).state === 'idle', 8000);
  });

  after(async () => {
    delete process.env.SLICEDOCK_READ_ONLY;
    t?.close();
    await sim?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('exposes the settings with defaults and validates them', async () => {
    const s = await t.agent.get('/api/admin/settings');
    assert.equal(s.body['printers.retention.enabled'], true);
    assert.equal(s.body['printers.retention.keep'], 10);
    const bad = await t.agent.patch('/api/admin/settings').send({ 'printers.retention.keep': 0 });
    assert.equal(bad.status, 400);
    const ok = await t.agent.patch('/api/admin/settings').send({ 'printers.retention.keep': 2 });
    assert.equal(ok.status, 200);
    assert.equal(ok.body['printers.retention.keep'], 2);
  });

  it('deletes only the oldest SliceDock uploads beyond N, never foreign files', async () => {
    for (const n of ['a.gcode', 'b.gcode', 'c.gcode', 'd.gcode']) await upload(n);
    const r = await t.ctx.printerRetention.run(printerId);
    assert.deepEqual(r.deleted, [`${DIR}/a.gcode`, `${DIR}/b.gcode`]);
    assert.deepEqual(sim.fileNames().sort(), ['c.gcode', 'calibration_cube.gcode', 'd.gcode', 'two_cubes.gcode']);
    assert.ok(sim.commands.some((c) => c.opGcodeFile === `deleteprt:${DIR}/a.gcode`));
    assert.deepEqual(audit('printer.file_retention').map((e) => e.target).sort(), ['a.gcode', 'b.gcode']);
    assert.deepEqual(t.ctx.printerRetention.activeUploads(printerId).map((u) => u.remote_name), ['d.gcode', 'c.gcode']);
    // Re-uploading a name replaces the old record instead of counting twice.
    await upload('c.gcode');
    assert.deepEqual(t.ctx.printerRetention.activeUploads(printerId).map((u) => u.remote_name), ['c.gcode', 'd.gcode']);
    assert.deepEqual((await t.ctx.printerRetention.run(printerId)).deleted, []);
  });

  it('runs after a print upload and keeps the printing file and pending prints', async () => {
    // Pending request for a file named like an old upload: that printer file must stay.
    t.ctx.db
      .prepare(`INSERT INTO prints (user_id, username, printer_id, file_id, file_name, state, created_at) VALUES (1, 'admin', ?, 9, 'd.gcode', 'pending', ?)`)
      .run(printerId, Date.now());
    t.ctx.settings.patch({ 'printers.retention.keep': 1 });
    const res = await t.agent.post('/api/prints').send({ printerId, fileId: 1, confirmBedClear: true });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const first = (await t.ctx.printing.lastRetention) as { deleted: string[]; kept: { path: string; reason: string }[] };
    // Newest = Printing_now.gcode (kept by N=1); c.gcode deleted; d.gcode kept for the pending print.
    assert.deepEqual(first.deleted, [`${DIR}/c.gcode`]);
    assert.deepEqual(first.kept, [{ path: `${DIR}/d.gcode`, reason: 'in_use' }]);
    await waitFor(() => t.ctx.printerManager.status(printerId).state === 'printing', 8000);

    // A newer upload pushes the printing file over the limit: it is kept while active.
    await upload('e.gcode');
    const second = await t.ctx.printerRetention.run(printerId);
    assert.ok(second.kept.some((k) => k.path === `${DIR}/Printing_now.gcode` && k.reason === 'in_use'), JSON.stringify(second));
    assert.ok(sim.fileNames().includes('Printing_now.gcode'));
    // The driver itself also refuses to delete the active file.
    await assert.rejects(t.ctx.printerManager.driver(printerId).deleteFile(`${DIR}/Printing_now.gcode`), (e: { code?: string }) => e.code === 'printers.file_in_use');
    assert.ok(sim.fileNames().includes('Printing_now.gcode'));
  });

  it('forgets uploads that are already gone and does nothing when disabled or read-only', async () => {
    await upload('f.gcode');
    await upload('g.gcode');
    t.ctx.settings.patch({ 'printers.retention.enabled': false });
    const before = sim.deletes.length;
    assert.equal((await t.ctx.printerRetention.run(printerId)).skipped, 'disabled');
    t.ctx.settings.patch({ 'printers.retention.enabled': true });
    process.env.SLICEDOCK_READ_ONLY = '1';
    try {
      assert.equal((await t.ctx.printerRetention.run(printerId)).skipped, 'read_only');
      await assert.rejects(t.ctx.printerManager.driver(printerId).deleteFile(`${DIR}/f.gcode`), (e: { code?: string }) => e.code === 'printers.read_only');
    } finally {
      delete process.env.SLICEDOCK_READ_ONLY;
    }
    assert.equal(sim.deletes.length, before);
    // Simulate a delete on the touchscreen: the record is dropped without sending anything.
    t.ctx.db.prepare(`UPDATE printer_uploads SET remote_path = ? WHERE remote_name = 'f.gcode' AND deleted_at IS NULL`).run(`${DIR}/gone.gcode`);
    await t.ctx.printerRetention.run(printerId);
    assert.ok(!sim.commands.some((c) => c.opGcodeFile === `deleteprt:${DIR}/gone.gcode`));
    const reasons = t.ctx.db.prepare(`SELECT remote_name, delete_reason FROM printer_uploads WHERE remote_name IN ('f.gcode','e.gcode')`).all();
    assert.deepEqual(reasons, [
      { remote_name: 'e.gcode', delete_reason: 'retention' },
      { remote_name: 'f.gcode', delete_reason: 'missing' },
    ]);
  });
});
