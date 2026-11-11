-- SliceDock: per-user Prepare settings level (basic | advanced | expert). NULL = admin default (`workspace.defaultLevel`).
ALTER TABLE users ADD COLUMN prepare_level TEXT;
