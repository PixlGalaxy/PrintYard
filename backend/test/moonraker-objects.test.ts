/** Moonraker objects come from the printer's LAN port: a hostile payload must not mutate shared built-ins. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeObjects, statusFromQuery } from '../src/printers/k2se/moonraker.js';

describe('Moonraker objects from the printer', () => {
  it('never mutate built-ins (toString / hasOwnProperty / valueOf as object names)', () => {
    const fnCall = Function.prototype.call;
    // Exactly what a hostile `notify_status_update` / objects query carries (JSON.parse keeps "__proto__" as a key).
    const hostile = JSON.parse(
      '{"toString":{"call":1,"polluted":true},"hasOwnProperty":{"call":1},"valueOf":{"polluted":true},"__proto__":{"polluted":true},"constructor":{"polluted":true}}',
    ) as unknown;
    try {
      const merged = mergeObjects({}, hostile);
      assert.equal((Object.prototype.toString as unknown as { call: unknown }).call, fnCall);
      assert.equal((Object.prototype.hasOwnProperty as unknown as { call: unknown }).call, fnCall);
      assert.equal((Object.prototype.valueOf as unknown as { polluted?: unknown }).polluted, undefined);
      assert.equal(({} as { polluted?: unknown }).polluted, undefined);
      // the data is still kept as plain own objects
      assert.deepEqual({ ...merged.toString }, { call: 1, polluted: true });
      const q = statusFromQuery({ result: { status: { hasOwnProperty: { call: 2 } } } });
      assert.equal((Object.prototype.hasOwnProperty as unknown as { call: unknown }).call, fnCall);
      assert.deepEqual({ ...q!.hasOwnProperty }, { call: 2 });
    } finally {
      for (const f of [Object.prototype.toString, Object.prototype.hasOwnProperty, Object.prototype.valueOf] as unknown as Record<string, unknown>[]) {
        delete f.call;
        delete f.polluted;
      }
    }
  });

  it('later updates still merge into the same object', () => {
    const state = mergeObjects({}, { toolhead: { homed_axes: 'xyz' } });
    mergeObjects(state, { toolhead: { position: [1, 2, 3, 0] } });
    assert.deepEqual(state.toolhead, { homed_axes: 'xyz', position: [1, 2, 3, 0] });
  });
});
