-- SliceDock Phase 2 close (BE-CLOSE): printer-side file retention + user deletion that keeps print history.

-- Files SliceDock uploaded to a printer. Only these are ever deleted by printer retention.
-- deleted_at: removed from the printer (by retention) or replaced by a newer upload with the same name.
CREATE TABLE printer_uploads (
  id           INTEGER PRIMARY KEY,
  printer_id   INTEGER NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
  remote_name  TEXT NOT NULL,
  remote_path  TEXT NOT NULL,
  print_id     INTEGER,
  size         INTEGER,
  uploaded_at  INTEGER NOT NULL,
  deleted_at   INTEGER,
  delete_reason TEXT
);
CREATE INDEX printer_uploads_active ON printer_uploads (printer_id, deleted_at, uploaded_at);

-- prints: history must survive deleting the user. user_id becomes nullable (SET NULL) and the username is
-- snapshotted. SQLite cannot alter a foreign key, so the table is rebuilt.
CREATE TABLE prints_new (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username      TEXT,
  printer_id    INTEGER NOT NULL,
  file_id       INTEGER NOT NULL,
  file_name     TEXT NOT NULL,
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
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  ended_at      INTEGER
);

INSERT INTO prints_new (id, user_id, username, printer_id, file_id, file_name, printer_path, grams, seconds, cost_estimate,
  actual_grams, state, reason, source, decided_by, decided_at, created_at, started_at, ended_at)
SELECT p.id, p.user_id, (SELECT u.username FROM users u WHERE u.id = p.user_id), p.printer_id, p.file_id, p.file_name,
  p.printer_path, p.grams, p.seconds, p.cost_estimate, p.actual_grams, p.state, p.reason, p.source, p.decided_by,
  p.decided_at, p.created_at, p.started_at, p.ended_at
FROM prints p;

DROP TABLE prints;
ALTER TABLE prints_new RENAME TO prints;

CREATE INDEX prints_user_created ON prints (user_id, created_at);
CREATE INDEX prints_state ON prints (state);
CREATE INDEX prints_printer_state ON prints (printer_id, state);
