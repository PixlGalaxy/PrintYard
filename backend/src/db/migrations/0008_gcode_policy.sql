-- SliceDock: uploaded G-code policy (phase 2 review finding #3).
-- Non-admin users may only print G-code SliceDock sliced itself unless an admin grants this permission.
ALTER TABLE users ADD COLUMN can_print_uploaded_gcode INTEGER NOT NULL DEFAULT 0;
