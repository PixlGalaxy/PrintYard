import type { PrinterModel, PrinterModelInfo, PrinterStatus, ProbeResult } from '../../types.js';

/** What the driver learns about the device once connected (persisted by the printer manager). */
export interface PrinterIdentity {
  mac: string | null;
  firmware: string | null;
  /** Creality `deviceSn` (newer firmware only; the K2 SE 2.3.6.57 does not send it). */
  serial: string | null;
  hostname: string | null;
  model: string | null;
}

/** Where to reach a printer: the address actually contacted plus its ports (the simulator uses one port for all). */
export interface PrinterEndpoint {
  host: string;
  wsPort: number;
  httpPort: number;
  moonrakerPort: number;
}

/** One G-code file in the printer's own storage. */
export interface PrinterFileInfo {
  name: string;
  /** Full path on the printer (what start/delete need). */
  path: string;
  size: number | null;
}

export interface UploadResult {
  /** Full path of the file on the printer (what `startPrint` needs). */
  path: string;
  /** Size the printer reports for the stored file (verified equal to the local file). */
  size?: number;
}

/** Freshly confirmed motion state for validating a control command (`PrinterControlService`). */
export interface ControlTelemetry {
  /** The link is up and the data below is at most `maxAgeMs` old (refreshed on demand). */
  fresh: boolean;
  homedAxes: string | null;
  position: [number, number, number] | null;
  /** Epoch ms of the data used. */
  receivedAt: number;
}

/** Live connection to one printer (one instance per configured printer, owned by the PrinterManager). */
export interface PrinterDriver {
  readonly printerId: number;
  /** Starts the background connection (reconnects on its own until `disconnect`). */
  connect(): void;
  disconnect(): void;
  /** The configured host changed (edit or MAC re-resolve): reconnect there. */
  setHost(host: string): void;
  getStatus(): PrinterStatus;
  getIdentity(): PrinterIdentity;
  /** Consecutive failed connection attempts (0 while online). */
  readonly failedAttempts: number;
  on(event: 'status', cb: (s: PrinterStatus) => void): void;
  on(event: 'identity', cb: (id: PrinterIdentity) => void): void;
  /**
   * Uploads a local G-code file under `name` (already sanitised) and returns its path on the printer. `onProgress`
   * gets the file bytes written so far and `done` once the printer accepted the body (called often: callers throttle).
   */
  uploadFile(name: string, localPath: string, onProgress?: (sentBytes: number, totalBytes: number, done: boolean) => void): Promise<UploadResult>;
  /** `calibrate` → Creality `enableSelfTest: 1` (pre-print calibration); default false. */
  startPrint(printerPath: string, opts?: { calibrate?: boolean }): Promise<void>;
  /** Fresh list of the printer's G-code files (read-only query); null when offline or no answer. */
  listFiles(): Promise<PrinterFileInfo[] | null>;
  /**
   * Deletes one G-code file from the printer. Refuses (409 `printers.file_in_use`) the file being printed/paused.
   * Resolves true once the file is gone from the printer's list, false if it is still listed after the wait.
   */
  deleteFile(printerPath: string): Promise<boolean>;
  /** Runs server-built G-code (control builder / exclude object) over the printer's own G-code transport. */
  sendGcode(script: string): Promise<void>;
  /** Chamber light on/off (Creality WS `lightSw`). */
  setLight(on: boolean): Promise<void>;
  /**
   * Re-reads the homing/position state when it is older than `maxAgeMs` (read-only queries) and says whether it is
   * fresh. Optional: without it the control service treats the published status as fresh while online.
   */
  controlTelemetry?(maxAgeMs: number, notBefore?: number): Promise<ControlTelemetry>;
  /**
   * Excludes one object of the running job and resolves true only once Klipper reports it in
   * `exclude_object.excluded_objects` (false = not confirmed in time). Optional: fakes fall back to `sendGcode`.
   */
  excludeObject?(name: string): Promise<boolean>;
  /** Klipper `print_stats.state` (`printing`, `paused`, `complete`, `cancelled`, `error`, `standby`) or null when unknown. */
  jobState?(): string | null;
  /** Raw Klipper `exclude_object` status from Moonraker (null when unknown). */
  excludeObjectStatus(): Record<string, unknown> | null;
  /** Inputs for the ETA (modules/printing/eta.ts); optional so test fakes can omit it. */
  etaHints?(): EtaHints;
  pause(): Promise<void>;
  resume(): Promise<void>;
  cancel(): Promise<void>;
  // ---- live view (read-only GETs) ----
  /** The file being printed (relative to the printer's gcodes root), or null. */
  currentJobFile(): CurrentJobFile | null;
  /** Streams the printer's copy of `relPath` to `dest`; throws 413 above `maxBytes`. Returns bytes written. */
  downloadGcode(relPath: string, dest: string, maxBytes: number): Promise<number>;
  /** Current job preview PNG, or null. */
  fetchThumbnail(maxBytes?: number): Promise<Buffer | null>;
}

export interface CurrentJobFile {
  fileName: string;
  relPath: string;
  size: number | null;
  /** Moonraker metadata uuid (changes when the file is re-uploaded). */
  uuid: string | null;
}

export interface ProbeOptions {
  staticIp: boolean;
  mac?: string | null | undefined;
}

/** The static side of a driver class (what the registry stores). */
export interface PrinterDriverClass {
  readonly info: PrinterModelInfo;
  probe(host: string, opts?: ProbeOptions): Promise<ProbeResult>;
  discoverByMac(mac: string): Promise<string | null>;
}

export type { PrinterModel, PrinterStatus };

/** Raw values the ETA needs that are not part of `PrinterStatus`. */
export interface EtaHints {
  /** Moonraker metadata `gcode_start_byte` / `gcode_end_byte` (print moves begin / end G-code begins). */
  startByte: number | null;
  endByte: number | null;
  /** Moonraker metadata `estimated_time` (slicer estimate, seconds). */
  estimatedSeconds: number | null;
  /** Creality `withSelfTest`: 1..99 while the pre-print calibration runs, 100 when done. */
  selfTest: number | null;
}
