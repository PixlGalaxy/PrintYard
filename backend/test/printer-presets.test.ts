import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { BACKUP_PATH, LEGACY_BACKUP_PATH } from '../src/modules/profiles-backup/profiles-backup.service.js';
import { PrinterSimulator } from '../src/printers/sim/simulator.js';
import { createB1App, type B1App } from './b1-helpers.js';
import { waitFor } from './live-helpers.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/k2se/retmaterials.json', import.meta.url), 'utf8')) as { retMaterials: Record<string, any>[] };
const GENERIC_PLA = 'Generic PLA @Creality K2 SE 0.4 nozzle';

describe('printer-side presets (printer simulator)', () => {
  let t: B1App;
  let sim: PrinterSimulator;
  let printerId: number;
  const status = () => t.ctx.printerManager.status(printerId);
  const backupOf = (body: { printers: { printerId: number }[] }) => body.printers.find((p) => p.printerId === printerId) as any;

  before(async () => {
    // The real capture, with one setting changed on the printer so a difference shows.
    const materials = structuredClone(fixture.retMaterials);
    materials[1]!.kvParam.nozzle_temperature = '225';
    materials.push({ base: { name: 'Evil' }, kvParam: 'not an object' }, 42 as never, null as never);
    sim = new PrinterSimulator({ tickMs: 50, materials });
    const port = await sim.start();
    t = await createB1App({
      profilesBackupDebounceMs: 150,
      printerManager: {
        resolveEndpoint: async (host) => (host === 'sim' ? { host: '127.0.0.1', wsPort: port, httpPort: port, moonrakerPort: port } : null),
      },
    });
    printerId = (await t.admin.post('/api/admin/printers').send({ name: 'Sim', model: 'creality-k2se', host: 'sim' })).body.id;
    t.ctx.printerManager.start();
    await waitFor(() => status().online && status(), 8000);
  });
  after(async () => {
    t.ctx.printerManager.stop();
    t.close();
    await sim.stop();
  });

  it('never asks the printer for its filaments while the setting is off (default)', async () => {
    const me = await t.alice.get('/api/auth/me');
    assert.equal(me.body.user.showPrinterFilaments, false);
    const res = await t.alice.get('/api/printer-materials');
    assert.equal(res.status, 200);
    assert.deepEqual({ enabled: res.body.enabled, materials: res.body.materials }, { enabled: false, materials: [] });
    assert.equal(sim.materialRequests, 0);
  });

  it('lists the printer filaments mapped to system presets, with differences, when turned on', async () => {
    const on = await t.alice.patch('/api/account').send({ showPrinterFilaments: true });
    assert.equal(on.body.user.showPrinterFilaments, true);
    const res = await t.alice.get('/api/printer-materials');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.online, true);
    assert.equal(sim.materialRequests, 1);
    const list = res.body.materials as any[];
    assert.equal(list.length, 4, 'malformed entries are skipped');
    const generic = list.find((m) => m.name === 'Generic PLA');
    assert.equal(generic.systemPresetId, GENERIC_PLA);
    assert.equal(generic.color, '#FFFFFF');
    assert.equal(generic.type, 'PLA');
    assert.deepEqual(generic.differs, []);
    const hyper = list.find((m) => m.name === 'Hyper PLA');
    assert.equal(hyper.color, '#C12E1F');
    assert.equal(hyper.brand, 'Creality');
    assert.deepEqual(hyper.differs.map((d: { key: string }) => d.key), ['nozzle_temperature']);
    assert.equal(hyper.differs[0].printer, '225');
    assert.deepEqual(hyper.values, { nozzle_temperature: '225' });
    // Cached: a second read does not ask the printer again; refresh=1 does.
    await t.alice.get('/api/printer-materials');
    assert.equal(sim.materialRequests, 1);
    await t.alice.get('/api/printer-materials?refresh=1');
    assert.equal(sim.materialRequests, 2);
    // bob has it off: no list for him.
    assert.equal((await t.bob.get('/api/printer-materials')).body.materials.length, 0);
    // "Duplicate as my filament" goes through the normal create path with the screened values.
    const dup = await t.alice.post('/api/filament-presets').send({ basePresetId: hyper.systemPresetId, name: 'Hyper PLA (printer)', values: hyper.values, color: hyper.color, filamentType: hyper.type });
    assert.equal(dup.status, 201, JSON.stringify(dup.body));
    assert.deepEqual(dup.body.values, { nozzle_temperature: '225' });
  });

  it('writes a debounced backup of every profile to the printer config root and restores it', async () => {
    const proc = await t.alice.post('/api/process-profiles').send({ basePresetId: '0.20mm Standard @Creality K2 SE 0.4 nozzle', name: 'Alice fast', values: { sparse_infill_density: '10%' }, scope: 'shared' });
    assert.equal(proc.status, 201, JSON.stringify(proc.body));
    await t.bob.post('/api/filament-presets').send({ basePresetId: GENERIC_PLA, name: 'Bob PLA', color: '#112233', values: { nozzle_temperature: '215' } });
    await waitFor(() => sim.configFiles.has(BACKUP_PATH) && JSON.parse(sim.configFiles.get(BACKUP_PATH)!.toString()).filament.some((f: { name: string }) => f.name === 'Bob PLA'), 5000);
    const doc = JSON.parse(sim.configFiles.get(BACKUP_PATH)!.toString());
    assert.equal(doc.format, 'printyard-profiles-backup');
    assert.equal(doc.version, 1);
    assert.equal(doc.printerModel, 'creality-k2se');
    assert.deepEqual(doc.process.map((p: { owner: string; name: string; shared: boolean }) => [p.owner, p.name, p.shared]), [['alice', 'Alice fast', true]]);
    const bob = doc.filament.find((f: { name: string }) => f.name === 'Bob PLA');
    assert.deepEqual(bob, { owner: 'bob', shared: false, name: 'Bob PLA', inherits: GENERIC_PLA, vendor: null, filamentType: null, color: '#112233', values: { nozzle_temperature: '215' }, updatedAt: bob.updatedAt });
    const raw = sim.configFiles.get(BACKUP_PATH)!.toString();
    assert.ok(!/password|hash|"id"|ownerId/i.test(raw), 'no secrets or ids');
    // Only that file, only in the config root: nothing else was written.
    assert.deepEqual([...sim.configFiles.keys()], [BACKUP_PATH]);
    assert.ok(!sim.httpLog.some((l) => /printer\.cfg|restart|firmware_restart/i.test(l)));

    const st = await t.admin.get('/api/admin/profiles-backup');
    assert.equal(st.body.enabled, true);
    assert.equal(backupOf(st.body).lastError, null);
    assert.ok(backupOf(st.body).lastBackupAt > 0);
    assert.equal((await t.alice.get('/api/admin/profiles-backup')).status, 403);

    // Restore into a fresh state: delete bob's filament, keep alice's profile (unchanged → not duplicated).
    const bobRow = (await t.bob.get('/api/filament-presets?scope=mine')).body.find((p: { name: string }) => p.name === 'Bob PLA');
    await t.bob.delete(`/api/filament-presets/${bobRow.id}`);
    const preview = await t.admin.get(`/api/admin/profiles-backup/preview?printerId=${printerId}`);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const byName = Object.fromEntries(preview.body.items.map((i: { name: string }) => [i.name, i]));
    assert.equal(byName['Alice fast'].action, 'unchanged');
    assert.equal(byName['Bob PLA'].action, 'create');
    assert.equal(byName['Bob PLA'].restoreOwner, 'bob');
    const restored = await t.admin.post('/api/admin/profiles-backup/restore').send({ printerId });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.deepEqual(restored.body.created.map((c: { name: string }) => c.name), ['Bob PLA']);
    const back = (await t.bob.get('/api/filament-presets?scope=mine')).body.find((p: { name: string }) => p.name === 'Bob PLA');
    assert.equal(back.color, '#112233');
    assert.deepEqual(back.values, { nozzle_temperature: '215' });
    assert.equal((await t.alice.post('/api/admin/profiles-backup/restore').send({ printerId })).status, 403);
  });

  it('treats the backup file as untrusted: unknown owners → admin, name clashes renamed, bad values dropped', async () => {
    const hostile = {
      format: 'printyard-profiles-backup',
      version: 1,
      printyardVersion: 'x',
      createdAt: new Date().toISOString(),
      printerModel: 'creality-k2se',
      process: [{ owner: 'ghost', shared: false, name: 'Alice fast', inherits: '0.20mm Standard @Creality K2 SE 0.4 nozzle', values: { sparse_infill_density: '12%', machine_start_gcode: 'M104 S999' } }],
      filament: [{ owner: 'ghost', shared: false, name: 'Hot', inherits: GENERIC_PLA, values: { nozzle_temperature: '999', filament_start_gcode: 'G28' } }],
    };
    sim.configFiles.set(BACKUP_PATH, Buffer.from(JSON.stringify(hostile)));
    // The admin owns an "Alice fast" too, so the restore (ghost → admin) must rename.
    await t.admin.post('/api/process-profiles').send({ basePresetId: '0.20mm Standard @Creality K2 SE 0.4 nozzle', name: 'Alice fast' });
    const preview = await t.admin.get(`/api/admin/profiles-backup/preview?printerId=${printerId}`);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.counts.ownerMapped, 2);
    const item = preview.body.items.find((i: { kind: string }) => i.kind === 'process');
    assert.equal(item.restoreOwner, 'admin');
    assert.equal(item.finalName, 'Alice fast (2)');
    const res = await t.admin.post('/api/admin/profiles-backup/restore').send({ printerId });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.renamed, [{ from: 'Alice fast', to: 'Alice fast (2)' }]);
    const dropped = res.body.dropped.map((d: { key: string }) => d.key).sort();
    assert.deepEqual(dropped, ['filament_start_gcode', 'machine_start_gcode', 'nozzle_temperature']);
    const created = (await t.admin.get('/api/process-profiles?scope=mine')).body.find((p: { name: string }) => p.name === 'Alice fast (2)');
    assert.deepEqual(created.values, { sparse_infill_density: '12%' });

    // Not a backup / not JSON / too large → refused, nothing imported.
    sim.configFiles.set(BACKUP_PATH, Buffer.from('{"format":"other"}'));
    assert.equal((await t.admin.get(`/api/admin/profiles-backup/preview?printerId=${printerId}`)).body.error.code, 'profiles_backup.invalid');
    sim.configFiles.set(BACKUP_PATH, Buffer.from('not json'));
    assert.equal((await t.admin.post('/api/admin/profiles-backup/restore').send({ printerId })).body.error.code, 'profiles_backup.invalid');
    sim.configFiles.set(BACKUP_PATH, Buffer.alloc(5 * 1024 * 1024, 32));
    assert.equal((await t.admin.get(`/api/admin/profiles-backup/preview?printerId=${printerId}`)).status, 413);
    sim.configFiles.delete(BACKUP_PATH);
    assert.equal((await t.admin.get(`/api/admin/profiles-backup/preview?printerId=${printerId}`)).body.error.code, 'profiles_backup.not_found');
  });

  it('restores a pre-rename backup from slicedock/profiles-backup.json (old format id and version field)', async () => {
    const legacy = {
      format: 'slicedock-profiles-backup',
      version: 1,
      slicedockVersion: 'old-1',
      createdAt: new Date().toISOString(),
      printerModel: 'creality-k2se',
      process: [{ owner: 'alice', shared: false, name: 'Legacy profile', inherits: '0.20mm Standard @Creality K2 SE 0.4 nozzle', values: { sparse_infill_density: '17%' } }],
      filament: [],
    };
    sim.configFiles.delete(BACKUP_PATH);
    sim.configFiles.set(LEGACY_BACKUP_PATH, Buffer.from(JSON.stringify(legacy)));
    try {
      const preview = await t.admin.get(`/api/admin/profiles-backup/preview?printerId=${printerId}`);
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      assert.equal(preview.body.printyardVersion, 'old-1');
      assert.deepEqual(preview.body.items.map((i: { name: string }) => i.name), ['Legacy profile']);
      const res = await t.admin.post('/api/admin/profiles-backup/restore').send({ printerId });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.created.map((c: { name: string }) => c.name), ['Legacy profile']);
      // A backup at the new path wins over the old one.
      sim.configFiles.set(BACKUP_PATH, Buffer.from(JSON.stringify({ ...legacy, format: 'printyard-profiles-backup', slicedockVersion: undefined, printyardVersion: 'new-1' })));
      assert.equal((await t.admin.get(`/api/admin/profiles-backup/preview?printerId=${printerId}`)).body.printyardVersion, 'new-1');
    } finally {
      sim.configFiles.delete(LEGACY_BACKUP_PATH);
      sim.configFiles.delete(BACKUP_PATH);
    }
  });

  it('reports a failed write without blocking saves, and can be turned off', async () => {
    sim.failConfigUploads = true;
    const saved = await t.alice.post('/api/process-profiles').send({ basePresetId: '0.20mm Standard @Creality K2 SE 0.4 nozzle', name: 'During outage' });
    assert.equal(saved.status, 201);
    await waitFor(async () => backupOf((await t.admin.get('/api/admin/profiles-backup')).body).lastError === 'prints.upload_failed', 5000);
    sim.failConfigUploads = false;
    const run = await t.admin.post('/api/admin/profiles-backup/run');
    assert.equal(backupOf(run.body).lastError, null);
    assert.ok(JSON.parse(sim.configFiles.get(BACKUP_PATH)!.toString()).process.some((p: { name: string }) => p.name === 'During outage'));

    assert.equal((await t.admin.patch('/api/admin/settings').send({ 'printers.profilesBackup.enabled': false })).status, 200);
    sim.configFiles.delete(BACKUP_PATH);
    await t.alice.post('/api/process-profiles').send({ basePresetId: '0.20mm Standard @Creality K2 SE 0.4 nozzle', name: 'Not backed up' });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(sim.configFiles.has(BACKUP_PATH), false);
    assert.equal((await t.admin.post('/api/admin/profiles-backup/run')).body.error.code, 'profiles_backup.disabled');
  });
});
