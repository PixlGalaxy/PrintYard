-- SliceDock: per-user 3D navigation + bed surfaces per printer (PREP-UX).
-- 3D navigation preferences (JSON, validated by modules/account/nav3d.ts). NULL = SliceDock defaults.
ALTER TABLE users ADD COLUMN nav3d TEXT;
-- Bed surfaces the owner has (JSON array of Creality bed types) and the default one. NULL = profile default only.
ALTER TABLE printers ADD COLUMN bed_surfaces TEXT;
ALTER TABLE printers ADD COLUMN default_bed_surface TEXT;
