import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { engineCpuList, parseCpuList } from '../src/modules/engine/creality-cli.js';

describe('engine CPU affinity', () => {
  it('parses kernel CPU lists', () => {
    assert.deepEqual(parseCpuList('0-3'), [0, 1, 2, 3]);
    assert.deepEqual(parseCpuList('4-7,10\n'), [4, 5, 6, 7, 10]);
    assert.deepEqual(parseCpuList('2'), [2]);
    assert.equal(parseCpuList(''), null);
    assert.equal(parseCpuList('3-1'), null);
    assert.equal(parseCpuList('a-b'), null);
  });

  it('keeps one allowed CPU free and never names a CPU outside the allowed set', () => {
    assert.equal(engineCpuList([0, 1, 2, 3]), '0,1,2');
    // container pinned with --cpuset-cpus=4-7: CPU 0 is not allowed (taskset would fail with EINVAL)
    assert.equal(engineCpuList([4, 5, 6, 7]), '4,5,6');
    assert.equal(engineCpuList([1, 3, 5]), '1,3');
  });

  it('skips taskset with fewer than 3 CPUs or an unknown set', () => {
    assert.equal(engineCpuList([0, 1]), null);
    assert.equal(engineCpuList(null), null);
  });
});
