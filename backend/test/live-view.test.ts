import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { LiveViewService } from '../src/modules/printing/live-view.js';
import { gcodesRelativePath, mergeObjects, parseJob, statusFromQuery } from '../src/printers/k2se/moonraker.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/k2se/moonraker-query.json', import.meta.url), 'utf8')) as unknown;

describe('Moonraker live job parsing (real K2 SE capture)', () => {
  it('parses objects/query into LiveJob', () => {
    const objs = statusFromQuery(fixture)!;
    assert.deepEqual(parseJob(objs), {
      fileName: 'Object_1_PLA_3h40m37s.gcode',
      filePosition: 2342801,
      fileSize: 5117963,
      layer: 239,
      layerCount: 756,
      toolhead: [50.671, 32.696, 48.32],
      slicer: 'Creality',
      objectHeight: 151.2,
      objects: [],
    });
  });

  it('merges notify_status_update partials per object', () => {
    const objs = statusFromQuery(fixture)!;
    mergeObjects(objs, { virtual_sdcard: { file_position: 2400000, layer: 240 }, toolhead: { position: [1, 2, 3, 4] } });
    const job = parseJob(objs)!;
    assert.equal(job.filePosition, 2400000);
    assert.equal(job.layer, 240);
    assert.equal(job.fileSize, 5117963); // untouched fields kept
    assert.deepEqual(job.toolhead, [1, 2, 3]);
    mergeObjects(objs, JSON.parse('{"__proto__":{"x":1}}'));
    assert.equal(({} as Record<string, unknown>).x, undefined);
  });

  it('no job when idle; missing toolhead tolerated', () => {
    assert.equal(parseJob({ print_stats: { state: 'standby' }, virtual_sdcard: { is_active: false, file_path: '/x/gcodes/a.gcode' } }), null);
    const j = parseJob({ print_stats: { state: 'paused', filename: 'b.gcode' }, virtual_sdcard: { is_active: false } });
    assert.equal(j?.fileName, 'b.gcode');
    assert.equal(j?.toolhead, null);
    assert.equal(statusFromQuery({ error: 'x' }), null);
  });

  it('relative gcodes paths are safe', () => {
    assert.equal(gcodesRelativePath('/usr/data/printer_data/gcodes/a b.gcode'), 'a b.gcode');
    assert.equal(gcodesRelativePath('/usr/data/printer_data/gcodes/sub/a.gcode'), 'sub/a.gcode');
    assert.equal(gcodesRelativePath('/usr/data/printer_data/gcodes/../config/printer.cfg'), null);
    assert.equal(gcodesRelativePath(''), null);
    assert.equal(gcodesRelativePath(42), null);
  });
});

describe('LiveViewService cache', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'printyard-gcache-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('evicts to the 2 most recently used entries', async () => {
    const lv = new LiveViewService({
      manager: null as never,
      printing: { currentLibraryFile: () => null },
      files: { get: () => null },
      cacheDir: dir,
    });
    const now = Date.now() / 1000;
    ['a', 'b', 'c'].forEach((n, i) => {
      const f = join(dir, `${n}.gcode`);
      writeFileSync(f, n);
      utimesSync(f, now - 100 + i * 10, now - 100 + i * 10);
    });
    writeFileSync(join(dir, 'unrelated.txt'), 'x');
    await lv.evict(join(dir, 'a.gcode')); // the entry just written is always kept
    assert.deepEqual(readdirSync(dir).sort(), ['a.gcode', 'c.gcode', 'unrelated.txt']);
  });
});
