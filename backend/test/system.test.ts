import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NetworkInterfaceInfo } from 'node:os';
import { LogBuffer } from '../src/log-buffer.js';
import { GIB, isMemoryOk, readMemoryLimit } from '../src/lib/memory.js';
import { hostNetworkLikely, lanSubnets24 } from '../src/lib/network.js';
import { macsFromSystemInfo } from '../src/printers/drivers/creality-k2se.js';
import { normalizeMac } from '../src/printers/drivers/http.js';
import './helpers.js';

function reader(files: Record<string, string>) {
  return (p: string) => {
    const v = files[p];
    if (v === undefined) throw new Error('ENOENT');
    return v;
  };
}

describe('memory cgroup check', () => {
  it('reads cgroup v2, falls back to v1, treats max/huge as unlimited', () => {
    assert.equal(readMemoryLimit(reader({ '/sys/fs/cgroup/memory.max': '2147483648\n' })), 2 * GIB);
    assert.equal(readMemoryLimit(reader({ '/sys/fs/cgroup/memory.max': 'max\n' })), null);
    assert.equal(readMemoryLimit(reader({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '536870912' })), 512 * 1024 ** 2);
    assert.equal(readMemoryLimit(reader({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712' })), null);
    assert.equal(readMemoryLimit(reader({})), null);
  });

  it('memoryOk = null or > 1 GiB', () => {
    assert.equal(isMemoryOk(null), true);
    assert.equal(isMemoryOk(GIB), false);
    assert.equal(isMemoryOk(GIB + 1), true);
    assert.equal(isMemoryOk(512 * 1024 ** 2), false);
  });
});

const iface = (address: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal,
  cidr: `${address}/24`,
});

describe('hostNetworkLikely', () => {
  it('false on a default Docker bridge (eth0 172.17.x only)', () => {
    assert.equal(hostNetworkLikely({ lo: [iface('127.0.0.1', true)], eth0: [iface('172.17.0.2')] }, true), false);
  });
  it('true with --network host (real LAN NIC visible)', () => {
    assert.equal(
      hostNetworkLikely({ lo: [iface('127.0.0.1', true)], docker0: [iface('172.17.0.1')], enp3s0: [iface('192.168.8.20')] }, true),
      true,
    );
    assert.deepEqual(lanSubnets24({ enp3s0: [iface('192.168.8.20')], wlan0: [iface('192.168.8.21')] }, true), [
      { prefix: '192.168.8', self: '192.168.8.20' },
    ]);
  });
});

describe('K2 SE probe parsing', () => {
  it('normalises MACs from /info and Moonraker', () => {
    assert.equal(normalizeMac('FCEE2813E2ED'), 'fc:ee:28:13:e2:ed');
    assert.equal(normalizeMac('fc-ee-28-13-e2-ed'), 'fc:ee:28:13:e2:ed');
    assert.equal(normalizeMac('nope'), null);
    assert.deepEqual(
      macsFromSystemInfo({ result: { system_info: { network: { wlan0: { mac_address: 'fc:ee:28:13:e2:ed', ip_addresses: [] } } } } }),
      ['fc:ee:28:13:e2:ed'],
    );
    assert.deepEqual(macsFromSystemInfo({ result: {} }), []);
    assert.deepEqual(macsFromSystemInfo('garbage'), []);
  });
});

describe('LogBuffer', () => {
  it('keeps only the newest N lines, oldest first', () => {
    const b = new LogBuffer(3);
    for (let i = 1; i <= 5; i++) b.push({ ts: i, level: 'info', channel: 'app', msg: String(i) });
    assert.deepEqual(b.tail().map((l) => l.msg), ['3', '4', '5']);
    assert.deepEqual(b.tail(2).map((l) => l.msg), ['4', '5']);
  });
});
