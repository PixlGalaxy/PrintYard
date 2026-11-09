import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { openDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { sqlFileSource } from '../src/modules/printing/files-source.js';

describe('printing: files source over B1 files table', () => {
  it('maps a gcode row (relative stored_path, meta.gcode)', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    db.prepare(`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (7, 'u', 'x', 'user', 1, 1)`).run();
    const meta = { gcode: { printSeconds: 600, filamentGrams: [5], filamentMm: [1000], layers: 3, printerModel: null, slicer: null } };
    db.prepare(
      `INSERT INTO files (id, owner_id, kind, visibility, name, ext, stored_path, size, meta, created_at, updated_at)
       VALUES (3, 7, 'gcode', 'shared', 'Cube.gcode', 'gcode', 'users/7/gcode/3-cube.gcode', 10, ?, 1, 1)`,
    ).run(JSON.stringify(meta));
    const src = sqlFileSource(db, '/data');
    const f = src.get(3)!;
    assert.equal(f.ownerId, 7);
    assert.equal(f.kind, 'gcode');
    assert.equal(f.visibility, 'shared');
    assert.equal(f.name, 'Cube.gcode');
    assert.equal(f.path, resolve(join('/data', 'users/7/gcode/3-cube.gcode')));
    assert.deepEqual(f.gcode?.filamentGrams, [5]);
    assert.equal(src.get(99), null);
    db.close();
  });
});
