import type { GcodeScan } from '../../types.js';

/** The parts of B1's `GcodeSummary` that printing uses (kept structural so either side can evolve). */
export interface GcodeSummaryLike {
  printSeconds?: number | null;
  filamentGrams?: number[] | null;
  filamentMm?: number[] | null;
  layers?: number | null;
  /** `slicer` (trusted, PrintYard sliced it) or `computed` (parsed from the moves); absent on legacy rows. */
  estimateSource?: 'slicer' | 'computed';
  /** Uploads: dangerous-command scan (files/gcode-scan.ts). */
  scan?: GcodeScan;
}

export interface Actor {
  id: number;
  username: string;
  role: 'admin' | 'user';
  ip?: string | null;
}

export type PrintSource = 'web' | 'mcp';

export interface StartPrintInput {
  printerId: number;
  fileId: number;
  source: PrintSource;
  /** Web only: the user confirmed in the UI that the previous print was removed. Ignored for `mcp`. */
  confirmBedClear?: boolean;
  /** Admins only: print G-code the dangerous-command scan flagged (audited as `print.allow_dangerous`). */
  allowDangerous?: boolean;
  /** Run the printer's pre-print calibration (`enableSelfTest: 1`). Default: setting `printing.calibrateByDefault`. */
  calibrate?: boolean;
  /**
   * Files → On the printer: start this file that is already stored on the printer (no upload). `fileId` is the
   * library copy of its downloaded content (scanned + hashed); dispatch re-checks that the printer still lists
   * `path` with the same size as that copy.
   */
  printerFile?: { path: string };
}
