-- SliceDock: user process profiles (PROFILES tab) and per-user default process/filament presets.
-- Same shape as filament_presets: `inherits` is the system process preset the values are layered on, `values_json`
-- holds only the overridden keys (process option allowlist, engine text form). Shared = visible to every user.
CREATE TABLE process_profiles (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope         TEXT NOT NULL DEFAULT 'private' CHECK (scope IN ('private', 'shared')),
  printer_model TEXT NOT NULL DEFAULT 'creality-k2se',
  name          TEXT NOT NULL,
  inherits      TEXT NOT NULL,
  values_json   TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX process_profiles_owner ON process_profiles (owner_id);
CREATE INDEX process_profiles_scope ON process_profiles (scope);
-- Preset ids ("0.20mm Standard @…" or "custom:<n>") used by "New project" and a fresh workspace. NULL = bundle default.
ALTER TABLE users ADD COLUMN default_process_preset TEXT;
ALTER TABLE users ADD COLUMN default_filament_preset TEXT;
