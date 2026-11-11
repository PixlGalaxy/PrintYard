// SliceDock → PrintYard rename: existing installs keep working with no manual steps (status/rename-notes.md).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { adoptLegacyDbFile, openDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { appEnv, appEnvFlag } from '../src/lib/env.js';
import { PRINTYARD_CONFIG_FILE, PRINTYARD_CONFIG_READ_FILE } from '../src/printers/drivers/types.js';

process.env.PRINTYARD_SILENT_LOGS = '1';

describe('rename compatibility', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'printyard-rename-'));
    dirs.push(d);
    return d;
  };
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('the database is now appdata/printyard.db', () => {
    const dir = tmp();
    const cfg = loadConfig({ APPDATA_ROOT: join(dir, 'appdata'), DATA_ROOT: join(dir, 'data'), SESSION_SECRET: 'x' });
    assert.equal(cfg.dbPath, join(dir, 'appdata', 'printyard.db'));
  });

  it('adopts a pre-rename slicedock.db (and its WAL/SHM files) before the database is opened', () => {
    const dir = tmp();
    const legacy = join(dir, 'slicedock.db');
    const db = openDb(legacy);
    runMigrations(db);
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('rename.test', '\"kept\"', 0)").run();
    db.close();
    writeFileSync(`${legacy}-wal`, ''); // an empty WAL / SHM is valid: SQLite rebuilds them
    writeFileSync(`${legacy}-shm`, '');

    const target = join(dir, 'printyard.db');
    assert.equal(adoptLegacyDbFile(target), true);
    for (const s of ['', '-wal', '-shm']) {
      assert.equal(existsSync(legacy + s), false, `slicedock.db${s} moved`);
      assert.equal(existsSync(target + s), true, `printyard.db${s} present`);
    }
    const reopened = openDb(target);
    runMigrations(reopened); // nothing left to apply, data intact
    assert.equal((reopened.prepare("SELECT value FROM settings WHERE key = 'rename.test'").get() as { value: string }).value, '"kept"');
    reopened.close();
    assert.equal(adoptLegacyDbFile(target), false, 'second boot: nothing to do');
  });

  it('never touches slicedock.db when printyard.db already exists, and is a no-op on fresh installs', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'printyard.db'), '');
    writeFileSync(join(dir, 'slicedock.db'), 'old');
    assert.equal(adoptLegacyDbFile(join(dir, 'printyard.db')), false);
    assert.equal(existsSync(join(dir, 'slicedock.db')), true);

    const fresh = tmp();
    assert.equal(adoptLegacyDbFile(join(fresh, 'printyard.db')), false);
    assert.equal(adoptLegacyDbFile(':memory:'), false);
  });

  it('finishes an interrupted adoption (sidecars already moved, main file not yet)', () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'slicedock.db'), '');
    writeFileSync(join(dir, 'printyard.db-wal'), '');
    assert.equal(adoptLegacyDbFile(join(dir, 'printyard.db')), true);
    assert.equal(existsSync(join(dir, 'printyard.db')), true);
    assert.equal(existsSync(join(dir, 'printyard.db-wal')), true);
  });

  it('reads PRINTYARD_* env vars, falling back to the deprecated SLICEDOCK_* names', () => {
    assert.equal(appEnv('READ_ONLY', { PRINTYARD_READ_ONLY: '1' }), '1');
    assert.equal(appEnv('READ_ONLY', { SLICEDOCK_READ_ONLY: '1' }), '1');
    assert.equal(appEnv('READ_ONLY', { PRINTYARD_READ_ONLY: '0', SLICEDOCK_READ_ONLY: '1' }), '0', 'the new name wins');
    assert.equal(appEnv('READ_ONLY', {}), undefined);
    assert.equal(appEnvFlag('SIM_PRINTER', { SLICEDOCK_SIM_PRINTER: '1' }), true);
    assert.equal(appEnvFlag('SIM_PRINTER', { PRINTYARD_SIM_PRINTER: '0', SLICEDOCK_SIM_PRINTER: '1' }), false);
  });

  it('writes printer config files only under printyard/, but reads the old slicedock/ folder too', () => {
    assert.equal(PRINTYARD_CONFIG_FILE.test('printyard/profiles-backup.json'), true);
    assert.equal(PRINTYARD_CONFIG_FILE.test('slicedock/profiles-backup.json'), false);
    assert.equal(PRINTYARD_CONFIG_READ_FILE.test('slicedock/profiles-backup.json'), true);
    assert.equal(PRINTYARD_CONFIG_READ_FILE.test('printer.cfg'), false);
    assert.equal(PRINTYARD_CONFIG_READ_FILE.test('slicedock/../printer.cfg'), false);
  });
});
