import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { CrealityConnection, type SocketLike } from '../src/printers/k2se/connection.js';

process.env.PRINTYARD_SILENT_LOGS = '1';

class FakeSocket extends EventEmitter implements SocketLike {
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {
    super();
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  terminate() {
    this.closed = true;
  }
  open() {
    this.emit('open');
  }
  push(obj: unknown) {
    this.emit('message', Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)), false);
  }
  drop() {
    this.emit('close');
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('CrealityConnection: reconnect, backoff, heartbeat (fake timers)', () => {
  let sockets: FakeSocket[];
  let online: boolean[];
  let frames: Record<string, unknown>[];
  let conn: CrealityConnection;

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
    sockets = [];
    online = [];
    frames = [];
    conn = new CrealityConnection({
      resolveUrl: async () => 'ws://192.168.8.250:9999',
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      onFrame: (f) => frames.push(f),
      onOnline: (v) => online.push(v),
      random: () => 0.5, // no jitter
    });
  });

  afterEach(() => {
    conn.stop();
    mock.timers.reset();
  });

  it('computes exponential backoff capped at 30 s with jitter', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 10].map((a) => conn.backoffDelay(a)), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    const jittered = new CrealityConnection({ resolveUrl: async () => null, onFrame() {}, onOnline() {}, random: () => 0 });
    assert.equal(jittered.backoffDelay(0), 750);
  });

  it('goes online on the first frame, requests status/CFS/files on open', async () => {
    conn.start();
    await flush();
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0]!.url, 'ws://192.168.8.250:9999');
    sockets[0]!.open();
    const sent = sockets[0]!.sent.map((s) => JSON.parse(s));
    assert.deepEqual(sent, [
      { method: 'get', params: { ReqPrinterPara: 1 } },
      { method: 'get', params: { boxsInfo: 1 } },
      { method: 'get', params: { reqGcodeFile: 1 } },
    ]);
    assert.ok(sent.every((m) => m.method === 'get')); // nothing but read-only queries on connect
    assert.deepEqual(online, []);
    sockets[0]!.push({ state: 1 });
    assert.deepEqual(online, [true]);
    assert.deepEqual(frames, [{ state: 1 }]);
    sockets[0]!.push('ok'); // heartbeat ack: not a frame
    assert.equal(frames.length, 1);
  });

  it('answers printer heart_beat with "ok" and sends its own heart_beat every 5 s', async () => {
    conn.start();
    await flush();
    const s = sockets[0]!;
    s.open();
    s.push({ state: 0 });
    s.sent.length = 0;
    s.push({ ModeCode: 'heart_beat' });
    assert.deepEqual(s.sent, ['ok']);
    s.sent.length = 0;
    mock.timers.tick(5000);
    assert.equal(JSON.parse(s.sent[0]!).ModeCode, 'heart_beat');
  });

  it('reconnects with growing delays and resets after success', async () => {
    conn.start();
    await flush();
    sockets[0]!.drop(); // connection refused
    await flush();
    assert.equal(sockets.length, 1);
    mock.timers.tick(999);
    await flush();
    assert.equal(sockets.length, 1);
    mock.timers.tick(1);
    await flush();
    assert.equal(sockets.length, 2); // after 1 s
    sockets[1]!.drop();
    mock.timers.tick(1999);
    await flush();
    assert.equal(sockets.length, 2);
    mock.timers.tick(1);
    await flush();
    assert.equal(sockets.length, 3); // after 2 s
    sockets[2]!.drop();
    mock.timers.tick(4000);
    await flush();
    assert.equal(sockets.length, 4); // after 4 s
    assert.equal(conn.failedAttempts, 3);

    // success resets the backoff
    sockets[3]!.open();
    sockets[3]!.push({ state: 0 });
    assert.equal(conn.failedAttempts, 0);
    sockets[3]!.drop();
    await flush();
    assert.deepEqual(online, [true, false]);
    mock.timers.tick(1000);
    await flush();
    assert.equal(sockets.length, 5);
  });

  it('probes after 10 s of silence and reconnects after 20 s', async () => {
    conn.start();
    await flush();
    const s = sockets[0]!;
    s.open();
    s.push({ state: 1 });
    s.sent.length = 0;
    mock.timers.tick(10_000);
    assert.ok(s.sent.some((m) => m.includes('ReqPrinterPara')), 'status probe sent');
    mock.timers.tick(10_000); // 20 s silent
    await flush();
    assert.equal(s.closed, true);
    assert.deepEqual(online, [true, false]);
    mock.timers.tick(1000);
    await flush();
    assert.equal(sockets.length, 2);
  });

  it('retries later when the address cannot be resolved', async () => {
    let url: string | null = null;
    const c = new CrealityConnection({
      resolveUrl: async () => url,
      createSocket: (u) => {
        const s = new FakeSocket(u);
        sockets.push(s);
        return s;
      },
      onFrame() {},
      onOnline() {},
      random: () => 0.5,
    });
    c.start();
    await flush();
    assert.equal(sockets.length, 0);
    url = 'ws://10.0.0.5:9999';
    mock.timers.tick(1000);
    await flush();
    assert.equal(sockets.length, 1);
    c.stop();
  });

  it('send() refuses while offline and stop() prevents reconnects', async () => {
    assert.equal(conn.send({ method: 'set', params: { pause: 1 } }), false);
    conn.start();
    await flush();
    conn.stop();
    sockets[0]!.drop();
    mock.timers.tick(60_000);
    await flush();
    assert.equal(sockets.length, 1);
  });
});
