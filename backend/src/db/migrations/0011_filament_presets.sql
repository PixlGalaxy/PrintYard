-- SliceDock: custom filament presets created from the web (FILAMENTS).
-- `inherits` is the system filament preset the values are layered on; `values_json` holds only the overridden keys
-- (filament option allowlist, engine text form). Shared presets are visible to every user; only admins share.
CREATE TABLE filament_presets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope         TEXT NOT NULL DEFAULT 'private' CHECK (scope IN ('private', 'shared')),
  printer_model TEXT NOT NULL DEFAULT 'creality-k2se',
  name          TEXT NOT NULL,
  inherits      TEXT NOT NULL,
  vendor        TEXT,
  filament_type TEXT,
  color         TEXT,
  values_json   TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX filament_presets_owner ON filament_presets (owner_id);
CREATE INDEX filament_presets_scope ON filament_presets (scope);
