-- SliceDock Phase 2 (B1): user file library (models, projects, G-code). Epoch milliseconds.
-- stored_path is relative to DATA_ROOT and always server-generated (users/<owner>/<kind dir>/<id>-<slug>.<ext>).

CREATE TABLE files (
  id            INTEGER PRIMARY KEY,
  owner_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('model', 'project', 'gcode')),
  visibility    TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared')),
  name          TEXT NOT NULL,             -- display name (original file name, editable)
  ext           TEXT NOT NULL,             -- lower-case, no dot: stl, 3mf, obj, gcode
  stored_path   TEXT NOT NULL UNIQUE,
  size          INTEGER NOT NULL,
  sha256        TEXT,
  pinned        INTEGER NOT NULL DEFAULT 0,
  meta          TEXT NOT NULL DEFAULT '{}', -- JSON FileMeta
  has_thumbnail INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX files_owner_created ON files (owner_id, created_at);
CREATE INDEX files_visibility ON files (visibility, created_at);

-- Models referenced by a saved project's scene: retention keeps them while the project exists.
CREATE TABLE file_refs (
  project_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  file_id    INTEGER NOT NULL,
  PRIMARY KEY (project_id, file_id)
);
CREATE INDEX file_refs_file ON file_refs (file_id);
