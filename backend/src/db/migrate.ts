import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';
import type { Db } from './client.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

/** Applies numbered `NNNN_name.sql` files in order, each in its own transaction, tracked in schema_migrations. */
export function runMigrations(db: Db, dir = MIGRATIONS_DIR): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  );
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_[\w-]+\.sql$/.test(f))
    .sort();

  let count = 0;
  for (const file of files) {
    const version = Number.parseInt(file.slice(0, 4), 10);
    if (applied.has(version)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    // Table rebuilds (SQLite "12-step" ALTER) must run with foreign keys off, or DROP TABLE would cascade into the
    // children. The pragma cannot change inside a transaction, so it is toggled around it and checked before commit.
    const fkOff = /^--\s*slicedock:foreign-keys=off\b/m.test(sql);
    const fkWasOn = fkOff && (db.pragma('foreign_keys', { simple: true }) as number) === 1;
    if (fkWasOn) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(sql);
        if (fkOff) {
          const violations = db.prepare('PRAGMA foreign_key_check').all();
          if (violations.length > 0) throw new Error(`${file}: foreign key check failed (${JSON.stringify(violations.slice(0, 5))})`);
        }
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
          version,
          file,
          Date.now(),
        );
      })();
    } finally {
      if (fkWasOn) db.pragma('foreign_keys = ON');
    }
    logger.db.info(`Applied migration ${file}`);
    count++;
  }
  return count;
}
