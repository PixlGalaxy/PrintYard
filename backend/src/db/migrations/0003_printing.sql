-- SliceDock Phase 2 (B2): print jobs, approvals, usage, "bed cleared" safety state. Epoch milliseconds.
-- file_id has no FOREIGN KEY on purpose: files (0002, B1) may be deleted by retention while history is kept;
-- file_name is a snapshot.

CREATE TABLE prints (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  printer_id    INTEGER NOT NULL,
  file_id       INTEGER NOT NULL,
  file_name     TEXT NOT NULL,
  printer_path  TEXT,              -- full path of the uploaded file on the printer
  grams         REAL,              -- estimate from the G-code summary
  seconds       REAL,              -- estimate from the G-code summary
  cost_estimate REAL,
  actual_grams  REAL,              -- measured/estimated at the end (progress-based)
  state         TEXT NOT NULL CHECK (state IN ('pending','approved','rejected','printing','done','failed','cancelled')),
  reason        TEXT,
  source        TEXT NOT NULL DEFAULT 'web',
  decided_by    INTEGER,
  decided_at    INTEGER,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  ended_at      INTEGER
);

CREATE INDEX prints_user_created ON prints (user_id, created_at);
CREATE INDEX prints_state ON prints (state);
CREATE INDEX prints_printer_state ON prints (printer_id, state);

ALTER TABLE printers ADD COLUMN bed_clear INTEGER NOT NULL DEFAULT 1;
ALTER TABLE printers ADD COLUMN bed_occupied_since INTEGER;
ALTER TABLE printers ADD COLUMN last_print_id INTEGER;
