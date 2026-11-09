-- SliceDock (B2): per-print "Print calibration" choice (Creality `enableSelfTest`), kept through approval.
ALTER TABLE prints ADD COLUMN calibrate INTEGER NOT NULL DEFAULT 0;
