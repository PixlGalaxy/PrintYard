-- slicedock:foreign-keys=off
-- SliceDock Phase 2 security fixes (status/phase2-review.md #2).
-- 1) ids that other rows reference never get reused: users, printers, files and prints become AUTOINCREMENT
--    (SQLite cannot add it in place, so each table is rebuilt; data and ids are kept). The sequence of each table
--    starts above the highest id that is still referenced anywhere, so ids freed before this migration are not reused.
-- 2) print requests snapshot the file they were made for (sha256, size, owner) so approval can re-verify it.
-- Runs with foreign keys off (see migrate.ts); a foreign_key_check runs before commit.

-- ---- users ----
CREATE TABLE users_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  language      TEXT NOT NULL DEFAULT 'en',
  theme         TEXT NOT NULL DEFAULT 'system',
  avatar_path   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_login_at INTEGER,
  theme_mode    TEXT CHECK (theme_mode IS NULL OR theme_mode IN ('system','light','dark')),
  skin          TEXT
);
INSERT INTO users_new (id, username, email, password_hash, role, is_active, language, theme, avatar_path, created_at,
  updated_at, last_login_at, theme_mode, skin)
SELECT id, username, email, password_hash, role, is_active, language, theme, avatar_path, created_at, updated_at,
  last_login_at, theme_mode, skin FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

-- ---- printers ----
CREATE TABLE printers_new (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  model              TEXT NOT NULL,
  host               TEXT NOT NULL,
  static_ip          INTEGER NOT NULL DEFAULT 1,
  mac                TEXT,
  serial             TEXT,
  firmware           TEXT,
  camera             TEXT NOT NULL DEFAULT '{"type":"none"}',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  last_seen_at       INTEGER,
  bed_clear          INTEGER NOT NULL DEFAULT 1,
  bed_occupied_since INTEGER,
  last_print_id      INTEGER
);
INSERT INTO printers_new SELECT id, name, model, host, static_ip, mac, serial, firmware, camera, created_at, updated_at,
  last_seen_at, bed_clear, bed_occupied_since, last_print_id FROM printers;
DROP TABLE printers;
ALTER TABLE printers_new RENAME TO printers;

-- ---- files ----
CREATE TABLE files_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('model', 'project', 'gcode')),
  visibility    TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared')),
  name          TEXT NOT NULL,
  ext           TEXT NOT NULL,
  stored_path   TEXT NOT NULL UNIQUE,
  size          INTEGER NOT NULL,
  sha256        TEXT,
  pinned        INTEGER NOT NULL DEFAULT 0,
  meta          TEXT NOT NULL DEFAULT '{}',
  has_thumbnail INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
INSERT INTO files_new SELECT id, owner_id, kind, visibility, name, ext, stored_path, size, sha256, pinned, meta,
  has_thumbnail, created_at, updated_at FROM files;
DROP TABLE files;
ALTER TABLE files_new RENAME TO files;
CREATE INDEX files_owner_created ON files (owner_id, created_at);
CREATE INDEX files_visibility ON files (visibility, created_at);

-- ---- prints (+ file snapshot) ----
CREATE TABLE prints_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username      TEXT,
  printer_id    INTEGER NOT NULL,
  file_id       INTEGER NOT NULL,
  file_name     TEXT NOT NULL,
  file_sha256   TEXT,              -- content hash at request time (approval re-verifies it)
  file_size     INTEGER,
  file_owner_id INTEGER,
  printer_path  TEXT,
  grams         REAL,
  seconds       REAL,
  cost_estimate REAL,
  actual_grams  REAL,
  state         TEXT NOT NULL CHECK (state IN ('pending','approved','rejected','printing','done','failed','cancelled')),
  reason        TEXT,
  source        TEXT NOT NULL DEFAULT 'web',
  decided_by    INTEGER,
  decided_at    INTEGER,
  forced        INTEGER NOT NULL DEFAULT 0, -- approved with force: true over a limit
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  ended_at      INTEGER
);
INSERT INTO prints_new (id, user_id, username, printer_id, file_id, file_name, printer_path, grams, seconds,
  cost_estimate, actual_grams, state, reason, source, decided_by, decided_at, created_at, started_at, ended_at)
SELECT id, user_id, username, printer_id, file_id, file_name, printer_path, grams, seconds, cost_estimate,
  actual_grams, state, reason, source, decided_by, decided_at, created_at, started_at, ended_at FROM prints;
DROP TABLE prints;
ALTER TABLE prints_new RENAME TO prints;
CREATE INDEX prints_user_created ON prints (user_id, created_at);
CREATE INDEX prints_state ON prints (state);
CREATE INDEX prints_printer_state ON prints (printer_id, state);
CREATE INDEX prints_file_state ON prints (file_id, state);

-- Pending requests made before this migration have no snapshot (file_sha256 NULL): approving them fails with
-- prints.file_changed because the file cannot be verified.

-- ---- sequences: start above every id still referenced ----
DELETE FROM sqlite_sequence WHERE name IN ('users', 'printers', 'files', 'prints');
INSERT INTO sqlite_sequence (name, seq) VALUES
  ('users', MAX(COALESCE((SELECT MAX(id) FROM users), 0), COALESCE((SELECT MAX(user_id) FROM prints), 0),
    COALESCE((SELECT MAX(user_id) FROM audit_log), 0))),
  ('printers', MAX(COALESCE((SELECT MAX(id) FROM printers), 0), COALESCE((SELECT MAX(printer_id) FROM prints), 0))),
  ('files', MAX(COALESCE((SELECT MAX(id) FROM files), 0), COALESCE((SELECT MAX(file_id) FROM prints), 0),
    COALESCE((SELECT MAX(file_id) FROM file_refs), 0))),
  ('prints', MAX(COALESCE((SELECT MAX(id) FROM prints), 0), COALESCE((SELECT MAX(print_id) FROM printer_uploads), 0),
    COALESCE((SELECT MAX(last_print_id) FROM printers), 0)));
