import Database from 'better-sqlite3';

export type Db = Database.Database;

/** Opens (or creates) the database. Pass ':memory:' for tests. */
export function openDb(path: string): Db {
  const db = new Database(path);
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}
