-- SliceDock (PRINTER-FILES): print a G-code file that is already stored on the printer (Files → On the printer).
-- printer_file = full printer path to start as is (no upload); NULL = upload the library file (every other print).
ALTER TABLE prints ADD COLUMN printer_file TEXT;
