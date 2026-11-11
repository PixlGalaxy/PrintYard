-- SliceDock: per-user "Show printer filaments" (Profiles tab + Prepare picker list the printer's own material list).
-- Off by default: while it is off for everyone, SliceDock never asks the printer for its materials.
ALTER TABLE users ADD COLUMN show_printer_filaments INTEGER NOT NULL DEFAULT 0;
