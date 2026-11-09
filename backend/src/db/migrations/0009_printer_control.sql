-- SliceDock: printer motion/temperature controls (PRINTER-UX).
-- Non-admin users may use the jog/temperature/fan controls only when an admin grants this permission.
ALTER TABLE users ADD COLUMN can_control_printer INTEGER NOT NULL DEFAULT 0;
-- The job that left material on the bed (JSON, see LastJob), kept until someone confirms the bed is clear.
ALTER TABLE printers ADD COLUMN last_job TEXT;
