import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { gramsFromLength } from '../src/modules/printer-files/printer-files.service.js';
import { parseFileList } from '../src/printers/k2se/protocol.js';
import { PrinterSimulator, sampleGcode } from '../src/printers/sim/simulator.js';
import { createB1App, type B1App } from './b1-helpers.js';
import { waitFor } from './live-helpers.js';

const DANGEROUS = ['G90', 'M83', 'G1 X10 Y10 E1 F3000', 'SAVE_CONFIG', ''].join('\n');
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('printer file list parsing (real K2 SE reqGcodeFile frame)', () => {
  it('maps Creality metadata', () => {
    // Trimmed from status/research (wsget.json), the real printer's reply.
    const list = parseFileList({
      retGcodeFileInfo2: [
        {
          custom_types: 1, type: 8, name: '4color_3DBenchy_PLA_1h0m.gcode', path: '/usr/data/printer_data/gcodes/4color_3DBenchy_PLA_1h0m.gcode',
          file_size: 2416121, create_time: 1583064866, timeCost: 3602, consumables: 5237, floorHeight: 20, material: 'PLA;PLA;PLA;PLA',
          nozzleTemp: 22000, bedTemp: 6000, software: 'Creality', thumbnail: '/usr/data/creality/local_gcode/humbnail/4color_3DBenchy_PLA_1h0m.png',
          materialColors: '#FF0000;#FFFFFF;#0000FF;#000000', materialIds: '01001;01001;01001;01001', match: 'T1A=  T1B=  T1C=  T1D=  ',
        },
        { name: 'evil.gcode', path: '/usr/data/printer_data/gcodes/evil.gcode', file_size: 10, thumbnail: '/x/../../etc/passwd' },
      ],
    })!;
    assert.equal(list.length, 2);
    assert.deepEqual(list[0]!.details, {
      createdAt: 1583064866000,
      layerHeight: 0.2,
      filamentMm: 5237,
      estimatedSec: 3602,
      materials: ['PLA', 'PLA', 'PLA', 'PLA'],
      colors: ['#ff0000', '#ffffff', '#0000ff', '#000000'],
      software: 'Creality',
      thumbnail: '4color_3DBenchy_PLA_1h0m.png',
    });
    assert.equal(list[1]!.details!.thumbnail, null);
    assert.equal(gramsFromLength(5237, 'PLA'), 15.6);
    assert.equal(gramsFromLength(null, 'PLA'), null);
  });
});

describe('Files → On the printer (API, printer simulator)', () => {
  let t: B1App;
  let sim: PrinterSimulator;
  let printerId: number;
  const base = () => `/api/printers/${printerId}/files`;
  const audit = (action: string) => (t.ctx.audit.list(500) as { action: string; meta?: unknown; target?: string }[]).filter((e) => e.action === action);
  const grant = (id: number, body: Record<string, boolean>) => t.admin.patch(`/api/admin/users/${id}`).send(body);
  const approval = (requiresApproval: boolean) =>
    t.admin.put(`/api/admin/users/${t.aliceId}/limits`).send({
      enabled: requiresApproval, maxGramsPerPrint: null, maxGramsPerMonth: null, maxHoursPerPrint: null, requiresApproval,
    });
  const reqFiles = () => sim.wsLog.filter((f) => f.includes('reqGcodeFile')).length;
  const status = () => t.ctx.printerManager.status(printerId);
  const finishOnSim = async () => {
    await waitFor(() => status().state === 'printing', 8000);
    await t.admin.post(`/api/printers/${printerId}/cancel`).send({});
    await waitFor(() => t.ctx.printers.get(printerId).bedClear === false, 8000);
    await t.admin.post(`/api/printers/${printerId}/bed-cleared`).send({});
    await waitFor(() => {
      const s = status();
      return s.online && !['printing', 'paused', 'preparing'].includes(s.state) && t.ctx.printers.get(printerId).bedClear && t.ctx.printing.currentOwner(printerId) === null;
    }, 8000);
  };

  before(async () => {
    sim = new PrinterSimulator({ tickMs: 25, simSecondsPerTick: 600, heatPerTick: 100, foreignFiles: true });
    const port = await sim.start();
    t = await createB1App({
      printerManager: {
        resolveEndpoint: async (host) => (host === 'sim' ? { host: '127.0.0.1', wsPort: port, httpPort: port, moonrakerPort: port } : null),
      },
    });
    printerId = (await t.admin.post('/api/admin/printers').send({ name: 'Sim', model: 'creality-k2se', host: 'sim' })).body.id;
    t.ctx.printerManager.start();
    await waitFor(() => status().online && status().state === 'idle' && status(), 8000);
    await approval(false);
  });
  after(async () => {
    delete process.env.SLICEDOCK_READ_ONLY;
    t?.close();
    await sim?.stop();
  });

  it('lists the printer files with Creality metadata, cached ~10 s, refresh on demand', async () => {
    const r = await t.alice.get(base());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const names = r.body.map((f: { name: string }) => f.name);
    for (const n of ['plate_plate1.gcode', 'PantherPaw_plate1.gcode', 'Object_1_PLA_3h40m37s.gcode', '4color_3DBenchy_PLA_1h0m.gcode', 'Spatula_PLA_32m19s.gcode', '3DBenchy_PLA_22m53s.gcode', 'calibration_cube.gcode']) {
      assert.ok(names.includes(n), n);
    }
    const obj = r.body.find((f: { name: string }) => f.name === 'Object_1_PLA_3h40m37s.gcode');
    assert.equal(obj.layerHeight, 0.2);
    assert.equal(obj.filamentMm, 35888);
    assert.equal(obj.estimatedSec, 13237);
    assert.equal(obj.createdAt, 1794175463000);
    assert.deepEqual(obj.colors, ['#56df3d']);
    assert.equal(obj.uploadedBySliceDock, false);
    assert.equal(obj.libraryFileId, null);
    assert.equal(obj.inUse, false);
    assert.match(obj.thumbnailUrl, /^\/api\/printers\/\d+\/files\/thumbnail\?name=Object_1_PLA_3h40m37s\.gcode&v=\d+$/);
    assert.equal(r.body.find((f: { name: string }) => f.name === 'plate_plate1.gcode').layerHeight, 0.16);

    const before = reqFiles();
    await t.alice.get(base());
    assert.equal(reqFiles(), before); // cached
    await t.alice.get(`${base()}?refresh=1`);
    assert.ok(reqFiles() > before);
    assert.equal((await t.alice.get('/api/printers/999/files')).status, 404);
  });

  it('marks files SliceDock uploaded (active printer_uploads record)', async () => {
    t.ctx.printerRetention.recordUpload(printerId, '/usr/data/printer_data/gcodes/calibration_cube.gcode', null, sim.fileSize('calibration_cube.gcode'));
    const r = await t.alice.get(`${base()}?refresh=1`);
    assert.equal(r.body.find((f: { name: string }) => f.name === 'calibration_cube.gcode').uploadedBySliceDock, true);
    assert.equal(r.body.find((f: { name: string }) => f.name === 'Spatula_PLA_32m19s.gcode').uploadedBySliceDock, false);
  });

  it('proxies thumbnails (PNG only, cached) and validates names against the printer list', async () => {
    const before = sim.thumbnailRequests;
    const r = await t.alice.get(`${base()}/thumbnail`).query({ name: 'Spatula_PLA_32m19s.gcode' }).buffer(true);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/png');
    assert.ok(Buffer.from(r.body).subarray(0, 8).equals(PNG_SIG));
    await t.alice.get(`${base()}/thumbnail`).query({ name: 'Spatula_PLA_32m19s.gcode' });
    assert.equal(sim.thumbnailRequests, before + 1);
    for (const name of ['../../../etc/passwd', 'nope.gcode', '/usr/data/printer_data/gcodes/Spatula_PLA_32m19s.gcode', '']) {
      const bad = await t.alice.get(`${base()}/thumbnail`).query({ name });
      assert.ok(bad.status === 404 || bad.status === 400, `${name}: ${bad.status}`);
    }
  });

  it('imports a printer file into the library as uploaded (untrusted, scanned) G-code', async () => {
    const r = await t.alice.post(`${base()}/import`).send({ name: 'Spatula_PLA_32m19s.gcode' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.kind, 'gcode');
    assert.equal(r.body.name, 'Spatula_PLA_32m19s.gcode');
    assert.equal(r.body.ownerId, t.aliceId);
    assert.notEqual(r.body.meta.trusted, true);
    assert.equal(r.body.meta.gcode.scan.ok, true);
    assert.equal(r.body.meta.gcode.estimateSource, 'computed');
    assert.equal(r.body.size, sim.fileSize('Spatula_PLA_32m19s.gcode'));
    assert.ok(audit('printer.file_import').some((e) => e.target === 'Spatula_PLA_32m19s.gcode'));
    assert.equal((await t.alice.post(`${base()}/import`).send({ name: '../x.gcode' })).status, 404);
  });

  it('import refuses files above the size cap', async () => {
    await t.admin.patch('/api/admin/settings').send({ 'files.maxUploadMb': 1 });
    sim.addStoredFile('huge.gcode', Buffer.concat([sampleGcode(10), Buffer.alloc(1100 * 1024, 0x3b)]));
    const r = await t.alice.post(`${base()}/import`).send({ name: 'huge.gcode' });
    assert.equal(r.status, 413, JSON.stringify(r.body));
    assert.equal(r.body.error.code, 'files.too_large');
    await t.admin.patch('/api/admin/settings').send({ 'files.maxUploadMb': 200 });
  });

  it('print: non-admins need can_print_uploaded_gcode (refused before downloading)', async () => {
    const dl = sim.gcodeDownloads;
    const r = await t.alice.post(`${base()}/print`).send({ name: 'PantherPaw_plate1.gcode' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'prints.untrusted_gcode');
    assert.equal(sim.gcodeDownloads, dl);
    assert.ok(audit('print.refused').some((e) => e.target === 'PantherPaw_plate1.gcode'));
  });

  it('print: scanned + started in place (no re-upload), the printing file cannot be deleted', async () => {
    await grant(t.aliceId, { canPrintUploadedGcode: true });
    const uploads = sim.uploads.length;
    const r = await t.alice.post(`${base()}/print`).send({ name: 'PantherPaw_plate1.gcode', calibrate: true });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.job.state, 'printing');
    assert.equal(r.body.imported, true);
    assert.equal(sim.uploads.length, uploads); // started the printer's own file
    assert.deepEqual(sim.lastStart, { path: '/usr/data/printer_data/gcodes/PantherPaw_plate1.gcode', enableSelfTest: 1 });
    await waitFor(() => status().state === 'printing', 8000);

    await grant(t.aliceId, { canControlPrinter: true });
    const list = await t.alice.get(`${base()}?refresh=1`);
    assert.equal(list.body.find((f: { name: string }) => f.name === 'PantherPaw_plate1.gcode').inUse, true);
    const del = await t.alice.delete(base()).send({ names: ['PantherPaw_plate1.gcode'] });
    assert.equal(del.status, 200);
    assert.deepEqual(del.body.results, [{ name: 'PantherPaw_plate1.gcode', result: 'skipped', reason: 'in_use' }]);
    assert.ok(sim.fileNames().includes('PantherPaw_plate1.gcode'));
    await grant(t.aliceId, { canControlPrinter: false });
    await finishOnSim();

    // Same content again → the library copy is reused (no second import).
    const again = await t.alice.post(`${base()}/print`).send({ name: 'PantherPaw_plate1.gcode' });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(again.body.imported, false);
    assert.equal(again.body.fileId, r.body.fileId);
    await finishOnSim();
  });

  it('print: the bed-cleared rule applies', async () => {
    const r = await t.alice.post(`${base()}/print`).send({ name: '3DBenchy_PLA_22m53s.gcode' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await waitFor(() => status().state === 'printing', 8000);
    await t.admin.post(`/api/printers/${printerId}/cancel`).send({});
    await waitFor(() => t.ctx.printers.get(printerId).bedClear === false, 8000);
    await waitFor(() => t.ctx.printing.currentOwner(printerId) === null && status().state !== 'printing', 8000);
    const blocked = await t.alice.post(`${base()}/print`).send({ name: '3DBenchy_PLA_22m53s.gcode' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'prints.bed_not_cleared');
    const ok = await t.alice.post(`${base()}/print`).send({ name: '3DBenchy_PLA_22m53s.gcode', confirmBedClear: true });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    await finishOnSim();
  });

  it('print: dangerous commands are refused', async () => {
    sim.addStoredFile('evil.gcode', Buffer.from(DANGEROUS), 60, { software: 'Unknown' });
    const r = await t.alice.post(`${base()}/print`).send({ name: 'evil.gcode' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'prints.dangerous_gcode');
  });

  it('print: approvals keep the printer file (protected while pending) and start it in place', async () => {
    await approval(true);
    const r = await t.alice.post(`${base()}/print`).send({ name: 'Spatula_PLA_32m19s.gcode' });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.job.state, 'pending');
    const del = await t.admin.delete(base()).send({ names: ['Spatula_PLA_32m19s.gcode'] });
    assert.equal(del.body.results[0].reason, 'in_use');
    const uploads = sim.uploads.length;
    const ok = await t.admin.post(`/api/prints/${r.body.job.id}/approve`).send({});
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.state, 'printing');
    assert.equal(sim.uploads.length, uploads);
    assert.equal(sim.lastStart?.path, '/usr/data/printer_data/gcodes/Spatula_PLA_32m19s.gcode');
    await finishOnSim();
    await approval(false);
  });

  it('a printer file changed after the request fails the approval', async () => {
    await approval(true);
    const r = await t.alice.post(`${base()}/print`).send({ name: 'Object_1_PLA_3h40m37s.gcode' });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    sim.addStoredFile('Object_1_PLA_3h40m37s.gcode', sampleGcode(7), 60, { software: 'Creality' });
    const res = await t.admin.post(`/api/prints/${r.body.job.id}/approve`).send({});
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'prints.file_changed');
    await approval(false);
  });

  it('delete: admin or can_control_printer; foreign files allowed; per-name results; audited', async () => {
    const denied = await t.bob.delete(base()).send({ names: ['Spatula_PLA_32m19s.gcode'] });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'printers.control_forbidden');
    await grant(t.bobId, { canControlPrinter: true });
    const r = await t.bob.delete(base()).send({ names: ['Spatula_PLA_32m19s.gcode', 'not-there.gcode', 'calibration_cube.gcode'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.results, [
      { name: 'Spatula_PLA_32m19s.gcode', result: 'deleted' },
      { name: 'not-there.gcode', result: 'missing' },
      { name: 'calibration_cube.gcode', result: 'deleted' },
    ]);
    assert.ok(sim.deletes.includes('/usr/data/printer_data/gcodes/Spatula_PLA_32m19s.gcode'));
    assert.ok(!sim.fileNames().includes('Spatula_PLA_32m19s.gcode'));
    const a = audit('printer.file_delete').filter((e) => JSON.stringify(e.meta).includes('"manual":true'));
    assert.equal(a.length, 2);
    assert.ok(JSON.stringify(a).includes('"uploadedBySliceDock":true')); // calibration_cube was recorded as ours
    const row = t.ctx.db.prepare("SELECT delete_reason FROM printer_uploads WHERE remote_name = 'calibration_cube.gcode'").get() as { delete_reason: string };
    assert.equal(row.delete_reason, 'manual');
    const list = await t.bob.get(base());
    assert.ok(!list.body.some((f: { name: string }) => f.name === 'Spatula_PLA_32m19s.gcode'));
    assert.equal((await t.bob.delete(base()).send({ names: [] })).status, 400);
    await grant(t.bobId, { canControlPrinter: false });
  });

  it('read-only mode refuses print and delete, list still works', async () => {
    process.env.SLICEDOCK_READ_ONLY = '1';
    try {
      assert.equal((await t.admin.delete(base()).send({ names: ['two_cubes.gcode'] })).status, 423);
      assert.equal((await t.admin.post(`${base()}/print`).send({ name: 'two_cubes.gcode' })).status, 423);
      assert.equal((await t.admin.get(base())).status, 200);
      assert.ok(sim.fileNames().includes('two_cubes.gcode'));
    } finally {
      delete process.env.SLICEDOCK_READ_ONLY;
    }
  });

  it('offline printer → 409', async () => {
    const id = (await t.admin.post('/api/admin/printers').send({ name: 'Gone', model: 'creality-k2se', host: '192.168.250.250' })).body.id;
    const r = await t.alice.get(`/api/printers/${id}/files`);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'prints.printer_offline');
  });
});
