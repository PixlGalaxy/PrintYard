/**
 * Creality WebSocket (:9999) protocol helpers for the K2 SE (board F016, K1C-family firmware 2.3.6.x).
 * Pure functions only: merging partial frames and mapping them to the shared `PrinterStatus`.
 *
 * Sources: frames captured from the real printer (test/fixtures/k2se), Creality Print 7.3.1 `applyDeviceData`,
 * `formatBoxsInfoData`, `StartPrint` (resources/web/deviceMgr bundle), status/research/k2se-printer.md.
 */
import type { CfsSlot, PrinterState, PrinterStatus } from '../../types.js';

/** Cumulative printer state: the printer only pushes the keys that changed, so frames are merged in. */
export type RawPrinterState = Record<string, unknown>;

/** Keys that are large lists or replies, kept out of the cumulative state (handled separately). */
const DETACHED_KEYS = new Set(['retGcodeFileInfo2', 'retGcodeFileInfo', 'historyList', 'objects']);

export type ParsedFrame =
  | { kind: 'ok' }
  | { kind: 'heartbeat' }
  | { kind: 'data'; data: Record<string, unknown> }
  | { kind: 'invalid' };

/** A text frame `ok` is the reply to our heart_beat; `{"ModeCode":"heart_beat"}` must be answered with `ok`. */
export function parseFrame(text: string): ParsedFrame {
  const t = text.trim();
  if (t === 'ok') return { kind: 'ok' };
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    return { kind: 'invalid' };
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { kind: 'invalid' };
  const data = v as Record<string, unknown>;
  if (data.ModeCode === 'heart_beat') return { kind: 'heartbeat' };
  return { kind: 'data', data };
}

/** Shallow merge (nested objects such as `err` and `boxsInfo` are replaced whole, like Creality Print does). */
export function mergeFrame(state: RawPrinterState, frame: Record<string, unknown>): RawPrinterState {
  for (const [k, v] of Object.entries(frame)) {
    if (DETACHED_KEYS.has(k)) continue;
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    state[k] = v;
  }
  return state;
}

/** Temperatures arrive as strings ("219.980000"), targets as ints. */
export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);

/**
 * Print `state` codes (Creality Print status card): 0 idle, 1 printing, 2 complete, 3 failed, 4 abort, 5 paused,
 * 6 pausing, 7 stopping, 8 restoring (power-loss recovery resuming → shown as printing).
 */
export const STATE_CODES: Record<number, PrinterState> = {
  0: 'idle',
  1: 'printing',
  2: 'complete',
  3: 'failed',
  4: 'aborted',
  5: 'paused',
  6: 'pausing',
  7: 'stopping',
  8: 'printing',
};

/** Error code from `err.errcode`; Creality Print also shows 115 for pending power-loss recovery and 2839 for runout. */
export function errorCode(raw: RawPrinterState): number | null {
  const err = raw.err;
  const code = typeof err === 'object' && err !== null ? num((err as Record<string, unknown>).errcode) : null;
  if (code !== null && code !== 0) return code;
  if (num(raw.repoPlrStatus) === 1) return 115;
  if (num(raw.materialStatus) === 1) return 2839;
  return null;
}

export function mapState(raw: RawPrinterState): PrinterState {
  const code = num(raw.state);
  const mapped = code !== null ? (STATE_CODES[code] ?? 'idle') : 'idle';
  const err = num((raw.err as Record<string, unknown> | undefined)?.errcode ?? null);
  // An error code while a job is running is reported in errorCode but does not hide the job state.
  const running = mapped === 'printing' || mapped === 'paused' || mapped === 'pausing' || mapped === 'stopping';
  if (err !== null && err !== 0 && !running) return 'error';
  return mapped;
}

/** States in which a new print may be started (the printer is ready and nothing is running). */
export function isReadyForPrint(status: Pick<PrinterStatus, 'online' | 'state'>): boolean {
  return status.online && (status.state === 'idle' || status.state === 'complete' || status.state === 'aborted' || status.state === 'failed');
}

export function isActiveState(state: PrinterState): boolean {
  return state === 'printing' || state === 'paused' || state === 'pausing' || state === 'stopping';
}

/** `#07a92ac` (pad digit + RRGGBB, 8 chars) → `#7a92ac`; `#RRGGBB` kept; anything else → null. */
export function normalizeColor(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const hex = v.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6,9}$/i.test(hex)) return null;
  // Creality prefixes the RGB value: `#07a92ac` (pad digit), `#FF7a92ac` (alpha) → keep the last 6 digits.
  return `#${hex.slice(-6).toLowerCase()}`;
}

/** Creality writes `00001` (or 0 / '') when a slot has no real RFID tag. */
export function realRfid(v: unknown): string | null {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (s === '' || /^0*1?$/.test(s)) return null;
  return s.slice(0, 64);
}

/**
 * `boxsInfo.materialBoxs[]` → slots. CFS units are `type 0` (box id 1..4, materials id 0..3 → slot 1..4);
 * the external spool holder is `type 1` and is reported as box 0, slot 1 (`external: true`, `remainingPct: null`).
 */
export function parseCfs(boxsInfo: unknown): CfsSlot[] | null {
  if (typeof boxsInfo !== 'object' || boxsInfo === null) return null;
  const boxes = (boxsInfo as Record<string, unknown>).materialBoxs;
  if (!Array.isArray(boxes)) return null;
  const out: CfsSlot[] = [];
  for (const b of boxes) {
    if (typeof b !== 'object' || b === null) continue;
    const box = b as Record<string, unknown>;
    const isExternal = num(box.type) === 1;
    const boxId = isExternal ? 0 : (num(box.id) ?? 0);
    const materials = Array.isArray(box.materials) ? box.materials : [];
    for (const m of materials) {
      if (typeof m !== 'object' || m === null) continue;
      const mat = m as Record<string, unknown>;
      const id = num(mat.id) ?? 0;
      const name = typeof mat.name === 'string' && mat.name.trim() !== '' ? mat.name.trim() : null;
      const type = typeof mat.type === 'string' && mat.type.trim() !== '' ? mat.type.trim() : null;
      const material = name ?? type;
      const pct = num(mat.percent);
      // The external holder has no sensor: the K2 SE always reports 100 % there, so it is not a measurement.
      const measured = !isExternal && material !== null && pct !== null;
      const remaining = measured ? Math.max(0, Math.min(100, pct)) : null;
      const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 64) : null);
      out.push({
        box: boxId,
        slot: id + 1,
        material,
        color: material ? normalizeColor(mat.color) : null,
        remainingPct: remaining,
        type: material ? type : null,
        ...(isExternal && { external: true }),
        vendor: material ? str(mat.vendor) : null,
        name,
        minTemp: material ? num(mat.minTemp) : null,
        maxTemp: material ? num(mat.maxTemp) : null,
        pressureAdvance: material ? num(mat.pressure) : null,
        rfid: material ? realRfid(mat.rfid) : null,
        percent: remaining,
        selected: num(mat.selected) === 1,
        editStatus: num(mat.editStatus),
      });
    }
  }
  out.sort((a, b) => a.box - b.box || a.slot - b.slot);
  return out;
}

/** `modelVersion: "printer hw ver:;printer sw ver:;DWIN hw ver:CR4CU220812S11;DWIN sw ver:2.3.6.57;"` → `2.3.6.57`. */
export function parseFirmware(modelVersion: unknown): string | null {
  if (typeof modelVersion !== 'string') return null;
  const pick = (label: string) => {
    const m = new RegExp(`${label}:([^;]*)`, 'i').exec(modelVersion);
    const v = m?.[1]?.trim();
    return v ? v : null;
  };
  return pick('printer sw ver') ?? pick('DWIN sw ver');
}

export function basename(path: unknown): string | null {
  if (typeof path !== 'string' || path === '') return null;
  const parts = path.split('/');
  return parts[parts.length - 1] || null;
}

export function toPrinterStatus(
  printerId: number,
  raw: RawPrinterState,
  online: boolean,
  now = Date.now(),
): PrinterStatus {
  if (!online) return offlineStatus(printerId, now);
  const state = mapState(raw);
  const total = num(raw.TotalLayer);
  let progress = num(raw.printProgress) ?? num(raw.dProgress);
  if (state === 'complete') progress = 100;
  const active = isActiveState(state) || state === 'complete';
  const chamber = num(raw.boxTemp);
  return {
    printerId,
    online: true,
    state,
    nozzleTemp: round1(num(raw.nozzleTemp)),
    nozzleTarget: num(raw.targetNozzleTemp),
    bedTemp: round1(num(raw.bedTemp0) ?? num(raw.bedTemp)),
    bedTarget: num(raw.targetBedTemp0),
    // The K2 SE has no chamber sensor (boxTemp is always 0): report null rather than a fake 0 °C.
    chamberTemp: chamber !== null && chamber > 0 ? round1(chamber) : null,
    progress: active || state === 'aborted' || state === 'failed' ? progress : null,
    layer: active ? num(raw.layer) : null,
    totalLayers: active && total !== null && total > 0 ? total : null,
    elapsedSec: active ? num(raw.printJobTime) : null,
    remainingSec: isActiveState(state) ? num(raw.printLeftTime) : state === 'complete' ? 0 : null,
    fileName: state === 'idle' ? null : basename(raw.printFileName),
    errorCode: errorCode(raw),
    cfs: parseCfs(raw.boxsInfo),
    updatedAt: now,
    currentPrintId: null,
    bedClear: true,
    bedOccupiedSince: null,
    lastPrintId: null,
    job: null,
    lastJob: null,
    fanPart: pct(raw.modelFanPct),
    fanAux: pct(raw.auxiliaryFanPct),
    fanCase: pct(raw.caseFanPct),
    homedAxes: parseAutohome(raw.autohome),
    position: parsePosition(raw.curPosition),
    maxNozzleTemp: num(raw.maxNozzleTemp),
    maxBedTemp: num(raw.maxBedTemp),
    lightOn: raw.lightSw === undefined || raw.lightSw === null ? null : num(raw.lightSw) === 1,
    speedFactor: factor(raw.curFeedratePct),
    flowFactor: factor(raw.curFlowratePct),
  };
}

/** A positive % factor (Creality `curFeedratePct`/`curFlowratePct`); null when absent or nonsense. */
const factor = (v: unknown): number | null => {
  const n = num(v);
  return n === null || n <= 0 || n > 1000 ? null : Math.round(n);
};

const pct = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.max(0, Math.min(100, Math.round(n)));
};

/** Creality `autohome: "X:1 Y:1 Z:0"` → `"xy"` (null when absent). */
export function parseAutohome(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let out = '';
  const re: Record<string, RegExp> = { X: /X:1(?!\d)/, Y: /Y:1(?!\d)/, Z: /Z:1(?!\d)/ };
  for (const axis of ['X', 'Y', 'Z']) if (re[axis]!.test(v)) out += axis.toLowerCase();
  return out;
}

/** Creality `curPosition: "X:37.92 Y:91.11 Z:28.92"` → `[x, y, z]` (null when incomplete). */
export function parsePosition(v: unknown): [number, number, number] | null {
  if (typeof v !== 'string') return null;
  const get = (axis: string) => {
    const m = new RegExp(axis + ':(-?[0-9.]+)').exec(v);
    const n = m?.[1] !== undefined ? Number(m[1]) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  const x = get('X');
  const y = get('Y');
  const z = get('Z');
  return x === null || y === null || z === null ? null : [x, y, z];
}

export function offlineStatus(printerId: number, now = Date.now()): PrinterStatus {
  return {
    printerId,
    online: false,
    state: 'offline',
    nozzleTemp: null,
    nozzleTarget: null,
    bedTemp: null,
    bedTarget: null,
    chamberTemp: null,
    progress: null,
    layer: null,
    totalLayers: null,
    elapsedSec: null,
    remainingSec: null,
    fileName: null,
    errorCode: null,
    cfs: null,
    updatedAt: now,
    currentPrintId: null,
    bedClear: true,
    bedOccupiedSince: null,
    lastPrintId: null,
    job: null,
    lastJob: null,
    fanPart: null,
    fanAux: null,
    fanCase: null,
    homedAxes: null,
    position: null,
    maxNozzleTemp: null,
    maxBedTemp: null,
    lightOn: null,
    speedFactor: null,
    flowFactor: null,
  };
}

export interface PrinterFileEntry {
  name: string;
  path: string;
  size: number | null;
  /** Extra metadata from `retGcodeFileInfo2` (absent on the old `retGcodeFileInfo` format). */
  details?: PrinterFileDetails;
}

/** What Creality Print's "Local files" shows per file (`retGcodeFileInfo2`). */
export interface PrinterFileDetails {
  /** `create_time` (epoch seconds on the printer) → epoch ms; null when missing or 0. */
  createdAt: number | null;
  /** `floorHeight` (mm × 100, e.g. 20 → 0.2 mm). */
  layerHeight: number | null;
  /** `consumables` (filament length in mm). */
  filamentMm: number | null;
  /** `timeCost` (slicer estimate in seconds). */
  estimatedSec: number | null;
  /** `material` split on ";" (e.g. ["PLA","PLA"]). */
  materials: string[];
  /** `materialColors` split on ";" (normalised `#rrggbb`). */
  colors: string[];
  /** `software` (e.g. "Creality"). */
  software: string | null;
  /** File name of the printer-side thumbnail (`thumbnail` basename, `<n>.png`), null when none. */
  thumbnail: string | null;
}

const listOf = (v: unknown): string[] =>
  typeof v === 'string' ? v.split(';').map((x) => x.trim()).filter((x) => x.length > 0 && x.length <= 40).slice(0, 16) : [];

/** Thumbnail basename from the printer's own path; only `<safe name>.png` is accepted. */
function thumbnailName(v: unknown): string | null {
  const b = basename(v);
  return b && isThumbnailName(b) ? b : null;
}

/** `<name>.png` without path separators, colons, control chars or a leading dot. */
export function isThumbnailName(name: string): boolean {
  return /^[^/\\:\x00-\x1f]{1,200}\.png$/i.test(name) && !name.startsWith('.');
}

function fileDetails(r: Record<string, unknown>): PrinterFileDetails {
  const pos = (v: unknown) => {
    const n = num(v);
    return n !== null && n > 0 ? n : null;
  };
  const created = pos(r.create_time);
  const floor = pos(r.floorHeight);
  return {
    createdAt: created !== null ? Math.round(created * 1000) : null,
    layerHeight: floor !== null ? Math.round(floor) / 100 : null,
    filamentMm: pos(r.consumables),
    estimatedSec: pos(r.timeCost),
    materials: listOf(r.material),
    colors: listOf(r.materialColors).map((c) => normalizeColor(c) ?? '').filter(Boolean),
    software: typeof r.software === 'string' && r.software ? r.software.slice(0, 60) : null,
    thumbnail: thumbnailName(r.thumbnail),
  };
}

/** `retGcodeFileInfo2` (newer firmware) or `retGcodeFileInfo.fileInfo` ("dir:name:size:..;") → entries. */
export function parseFileList(frame: Record<string, unknown>): PrinterFileEntry[] | null {
  const v2 = frame.retGcodeFileInfo2;
  if (Array.isArray(v2)) {
    return v2.flatMap((e) => {
      if (typeof e !== 'object' || e === null) return [];
      const r = e as Record<string, unknown>;
      if (typeof r.name !== 'string' || typeof r.path !== 'string') return [];
      return [{ name: r.name, path: r.path, size: num(r.file_size), details: fileDetails(r) }];
    });
  }
  const v1 = frame.retGcodeFileInfo;
  if (typeof v1 === 'object' && v1 !== null && typeof (v1 as Record<string, unknown>).fileInfo === 'string') {
    return ((v1 as Record<string, unknown>).fileInfo as string)
      .split(';')
      .filter(Boolean)
      .flatMap((entry) => {
        const f = entry.split(':');
        if (f.length < 3 || !f[0] || !f[1]) return [];
        return [{ name: f[1], path: `${f[0]}/${f[1]}`, size: num(f[2]) }];
      });
  }
  return null;
}

export const DEFAULT_GCODE_DIR = '/usr/data/printer_data/gcodes';

/** Directory where uploads land, derived from the printer's own file list (Creality Print `HandleSendPrintCommand`). */
export function gcodeDirFromList(list: PrinterFileEntry[] | null): string {
  for (const e of list ?? []) {
    const m = /^(.*\/gcodes)\//.exec(e.path);
    if (m?.[1]) return m[1];
  }
  return DEFAULT_GCODE_DIR;
}

/**
 * Printer-side filenames: Creality's `opGcodeFile` uses `:` as a separator (`renameprt:<old>:<new>`) so only a
 * conservative charset is kept. Always ends in `.gcode`.
 */
export function safePrinterFileName(name: string): string {
  const base = name.replace(/\.gcode$/i, '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+/, '')
    .replace(/_+/g, '_')
    .slice(0, 80);
  return `${cleaned || 'print'}.gcode`;
}

/**
 * Printer-side name of a SliceDock upload: the sanitised name plus the print id (`Cube_p12.gcode`), so two library
 * files that sanitise to the same name (`a b` / `a_b`, CJK names) never overwrite each other or a touchscreen file.
 * `extra` is appended when that name is still taken on the printer.
 */
export function printerUploadName(name: string, printId: number, extra = ''): string {
  const base = safePrinterFileName(name).replace(/\.gcode$/, '').slice(0, 64);
  return `${base}_p${printId}${extra ? `_${extra.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}` : ''}.gcode`;
}

// ---- outgoing frames ----

export const cmd = {
  heartbeat: () => ({ ModeCode: 'heart_beat', msg: new Date().toString() }),
  reqStatus: () => ({ method: 'get', params: { ReqPrinterPara: 1 } }),
  reqBoxsInfo: () => ({ method: 'get', params: { boxsInfo: 1 } }),
  reqFiles: () => ({ method: 'get', params: { reqGcodeFile: 1 } }),
  pause: () => ({ method: 'set', params: { pause: 1 } }),
  resume: () => ({ method: 'set', params: { pause: 0 } }),
  stop: () => ({ method: 'set', params: { stop: 1 } }),
  /**
   * Creality Print LAN start (`DeviceInterface.StartNormalPrint(ip, path, print_calibration)`):
   * `printprt:<full path>` + `enableSelfTest` 1 = run the printer's pre-print calibration (auto-leveling etc.), 0 = skip.
   */
  start: (path: string, calibrate = false) => ({
    method: 'set',
    params: { opGcodeFile: `printprt:${path}`, enableSelfTest: calibrate ? 1 : 0 },
  }),
  /** Creality Print file delete (`deleteprt:<full path>`); the firmware also drops its own thumbnail/metadata. */
  deleteFile: (path: string) => ({ method: 'set', params: { opGcodeFile: `deleteprt:${path}` } }),
  /**
   * G-code through the Creality WS (what Creality Print's fan/console controls send). Only ever built server-side
   * by the control builder / exclude-object (never raw client input).
   */
  gcode: (script: string) => ({ method: 'set', params: { gcodeCmd: script } }),
  /**
   * Creality Print exclude object (deviceMgr `ExcludeObject`, LAN socket): `{"method":"set","params":{"excludeObjects":[name]}}`
   * with the Klipper object name as the printer reports it (upper case). The firmware runs `EXCLUDE_OBJECT` itself;
   * `gcodeCmd: EXCLUDE_OBJECT ...` is ignored mid-print on the K2 SE.
   */
  excludeObjects: (name: string) => ({ method: 'set', params: { excludeObjects: [name] } }),
  /** Creality Print light switch (`lightSw` 1 = on, 0 = off). */
  light: (on: boolean) => ({ method: 'set', params: { lightSw: on ? 1 : 0 } }),
};
