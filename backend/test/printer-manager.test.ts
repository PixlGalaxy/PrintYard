import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { PrinterDriver, PrinterIdentity } from '../src/printers/drivers/types.js';
import { offlineStatus } from '../src/printers/k2se/protocol.js';
import { PrinterManager } from '../src/printers/manager.js';
import { createTestApp, setupBody, type TestApp } from './helpers.js';

class FakeDriver implements PrinterDriver {
  host: string;
  failedAttempts = 5;
  connected = false;
  constructor(readonly printerId: number, host: string) {
    this.host = host;
  }
  connect() {
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
  }
  setHost(h: string) {
    this.host = h;
  }
  getStatus() {
    return offlineStatus(this.printerId);
  }
  getIdentity(): PrinterIdentity {
    return { mac: null, firmware: null, serial: null, hostname: null, model: null };
  }
  on() {}
  async uploadFile() {
    return { path: '' };
  }
  async startPrint() {}
  async listFiles() {
    return null;
  }
  async deleteFile() {
    return false;
  }
  async sendGcode() {}
  async setLight() {}
  excludeObjectStatus() {
    return null;
  }
  async pause() {}
  async resume() {}
  async cancel() {}
  currentJobFile() {
    return null;
  }
  async downloadGcode() {
    return 0;
  }
  async fetchThumbnail() {
    return null;
  }
}

describe('printer hosts and the manager', () => {
  let t: TestApp;
  before(async () => {
    t = createTestApp();
    await t.agent.post('/api/setup/complete').send(setupBody({ printer: null }));
  });
  after(() => t.close());

  it('refuses non-private printer hosts on create/update (printers.invalid_host)', async () => {
    for (const host of ['8.8.8.8', '127.0.0.1', 'localhost', '169.254.1.1']) {
      const r = await t.agent.post('/api/admin/printers').send({ name: 'x', model: 'creality-k2se', host });
      assert.equal(r.status, 400, host);
      assert.equal(r.body.error.code, 'printers.invalid_host');
    }
    const ok = await t.agent.post('/api/admin/printers').send({ name: 'x', model: 'creality-k2se', host: '10.1.2.3' });
    assert.equal(ok.status, 201);
    const sim = await t.agent.post('/api/admin/printers').send({ name: 's', model: 'creality-k2se', host: 'sim' });
    assert.equal(sim.status, 201);
    const bad = await t.agent.patch(`/api/admin/printers/${ok.body.id}`).send({ host: '1.1.1.1' });
    assert.equal(bad.body.error.code, 'printers.invalid_host');
    assert.equal((await t.agent.patch(`/api/admin/printers/${ok.body.id}`).send({ name: 'renamed' })).status, 200);
    await t.agent.delete(`/api/admin/printers/${ok.body.id}`);
    await t.agent.delete(`/api/admin/printers/${sim.body.id}`);
  });

  it('setup refuses a public printer host', async () => {
    const t2 = createTestApp();
    const r = await t2.agent.post('/api/setup/complete').send(setupBody({ printer: { name: 'P', model: 'creality-k2se', host: '8.8.4.4' } }));
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'printers.invalid_host');
    t2.close();
  });

  it('follows printer CRUD and re-resolves a dynamic-IP printer by MAC', async () => {
    const drivers: FakeDriver[] = [];
    const discovered: string[] = [];
    const m = new PrinterManager({
      printers: t.ctx.printers,
      hub: t.ctx.hub,
      createDriver: (p) => {
        const d = new FakeDriver(p.id, p.host);
        drivers.push(d);
        return d;
      },
      discoverByMac: async (mac) => {
        discovered.push(mac);
        return '192.168.8.77';
      },
    });
    const p = t.ctx.printers.create({ name: 'dyn', model: 'creality-k2se', host: '192.168.8.50', staticIp: false, mac: 'fc:ee:28:13:e2:ed' });
    const fixed = t.ctx.printers.create({ name: 'fixed', model: 'creality-k2se', host: '192.168.8.51', staticIp: true, mac: 'fc:ee:28:13:e2:ee' });
    m.start();
    assert.equal(drivers.length, 2);
    assert.ok(drivers.every((d) => d.connected));
    await m.rediscoverNow();
    assert.deepEqual(discovered, ['fc:ee:28:13:e2:ed']); // static IP printers are never swept
    assert.equal(t.ctx.printers.get(p.id).host, '192.168.8.77');
    assert.equal(drivers[0]!.host, '192.168.8.77');
    await m.rediscoverNow();
    assert.equal(discovered.length, 1); // rate-limited

    t.ctx.printers.update(fixed.id, { name: 'renamed' });
    assert.equal(drivers.length, 3); // reconnected with the new config
    assert.equal(drivers[1]!.connected, false);
    t.ctx.printers.delete(fixed.id);
    assert.equal(drivers[2]!.connected, false);
    assert.equal(m.hasDriver(fixed.id), false);
    m.stop();
    assert.equal(drivers[0]!.connected, false);
  });
});
