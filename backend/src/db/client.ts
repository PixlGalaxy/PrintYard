import { existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

/** Database file name before the SliceDock → PrintYard rename (`appdata/slicedock.db`). */
export const LEGACY_DB_FILE = 'slicedock.db';
const SIDECARS = ['-wal', '-shm', '-journal'] as const;

/**
 * Pre-rename installs keep their data: when `dbPath` does not exist yet but `slicedock.db` (same folder) does, the
 * database and its WAL/SHM sidecars are renamed to the new name before anything opens them. Sidecars move first and
 * the main file last, so an interrupted run simply resumes on the next boot (each rename is atomic on its own).
 * Returns true when the legacy file was adopted.
 */
export function adoptLegacyDbFile(dbPath: string): boolean {
  if (dbPath === ':memory:' || existsSync(dbPath)) return false;
  const legacy = join(dirname(dbPath), LEGACY_DB_FILE);
  if (legacy === dbPath || !existsSync(legacy)) return false;
  for (const s of SIDECARS) if (existsSync(legacy + s)) renameSync(legacy + s, dbPath + s);
  renameSync(legacy, dbPath);
  return true;
}

/** Opens (or creates) the database. Pass ':memory:' for tests. */
export function openDb(path: string): Db {
  const db = new Database(path);
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}
