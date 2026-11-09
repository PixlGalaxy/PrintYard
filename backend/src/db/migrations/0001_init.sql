-- SliceDock Phase 1 schema (status/phase1-contract.md). Timestamps are epoch milliseconds.

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL, -- JSON
  updated_at INTEGER NOT NULL
);

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
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
  last_login_at INTEGER
);

CREATE TABLE user_limits (
  user_id             INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled             INTEGER NOT NULL DEFAULT 0,
  max_grams_per_print REAL,
  max_grams_per_month REAL,
  max_hours_per_print REAL,
  requires_approval   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY, -- sha256 hex of the cookie token
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  ip           TEXT,
  user_agent   TEXT
);

CREATE TABLE printers (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  model        TEXT NOT NULL,
  host         TEXT NOT NULL,
  static_ip    INTEGER NOT NULL DEFAULT 1,
  mac          TEXT,
  serial       TEXT,
  firmware     TEXT,
  camera       TEXT NOT NULL DEFAULT '{"type":"none"}',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER,
  username   TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  meta       TEXT,
  ip         TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE ip_bans (
  ip         TEXT PRIMARY KEY,
  reason     TEXT,
  until      INTEGER,
  created_at INTEGER NOT NULL
);
