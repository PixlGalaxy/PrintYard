import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { SocketLike } from '../src/printers/k2se/connection.js';
import { K2SELiveDriver } from '../src/printers/k2se/live-driver.js';

process.env.PRINTYARD_SILENT_LOGS = '1';

class FakeSocket extends EventEmitter implements SocketLike {
  sent: string[] = [];
  send(d: string) {
    this.sent.push(d);
  }
  close() {}
  terminate() {}
  push(o: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(o)), false);
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('CFS: boxsInfo re-query (read-only `get` only)', () => {
  let sock: FakeSocket;
  let driver: K2SELiveDriver;
  const boxRequests = () => sock.sent.filter((s) => s.includes('"boxsInfo"')).length;

  beforeEach(async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 5_000_000 });
    sock = new FakeSocket();
    driver = new K2SELiveDriver({
      printerId: 1,
      host: '10.0.0.9',
      // endpoint with no reachable HTTP: identity GETs fail fast and are irrelevant here
      resolveEndpoint: async () => ({ host: '10.0.0.9', wsPort: 9999, httpPort: 1, moonrakerPort: 1 }),
      createSocket: () => sock,
      moonraker: false,
    });
    driver.connect();
    await flush();
    sock.emit('open');
    sock.push({ state: 0, materialStatus: 0, feedState: 0, cfsConnect: 1 }); // cfsConnect change → one request
    await flush();
    mock.timers.tick(2500); // past the 2 s throttle window (also sends a heart_beat)
  });

  afterEach(() => {
    driver.disconnect();
    mock.timers.reset();
  });

  it('asks again when the printer signals a material change (throttled to one per 2 s)', () => {
    const before = boxRequests();
    sock.push({ feedState: 1 });
    assert.equal(boxRequests(), before + 1);
    sock.push({ feedState: 0 }); // within 2 s: throttled
    sock.push({ materialStatus: 1 });
    assert.equal(boxRequests(), before + 1);
    mock.timers.tick(2000);
    sock.push({ materialStatus: 0 });
    assert.equal(boxRequests(), before + 2);
    // unrelated frames do not trigger it
    mock.timers.tick(2000);
    sock.push({ nozzleTemp: '200.0', materialStatus: 0 });
    assert.equal(boxRequests(), before + 2);
  });

  it('re-queries every 60 s while connected, and a boxsInfo push updates the slots', () => {
    // the printer keeps pushing status (otherwise the connection is dropped as stale after 20 s)
    const advance = (ms: number) => {
      for (let t = 0; t < ms; t += 5000) {
        mock.timers.tick(5000);
        sock.push({ nozzleTemp: '25.0' });
      }
    };
    const before = boxRequests();
    advance(60_000);
    assert.equal(boxRequests(), before + 1);
    advance(60_000);
    assert.equal(boxRequests(), before + 2);
    sock.push({ boxsInfo: { materialBoxs: [{ id: 0, type: 1, materials: [{ id: 0, type: 'PETG', name: 'Generic PETG', color: '#0ff0000', rfid: '00001', percent: 100 }] }] } });
    const slot = driver.getStatus().cfs![0]!;
    assert.equal(slot.name, 'Generic PETG');
    assert.equal(slot.color, '#ff0000');
    // only `get` frames, heartbeats and "ok" were ever written
    for (const f of sock.sent) {
      const o = JSON.parse(f) as { method?: string; ModeCode?: string };
      assert.ok(o.method === 'get' || o.ModeCode === 'heart_beat', f);
    }
  });
});
