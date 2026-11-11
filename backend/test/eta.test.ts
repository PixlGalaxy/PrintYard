import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  BED_RATE,
  CALIBRATION_SEC,
  computeEta,
  etaPhase,
  NOZZLE_RATE,
  parseDuration,
  parseGcodeTiming,
  PREP_SEC,
  readGcodeTiming,
  secondsFromFileName,
  type EtaInput,
} from '../src/modules/printing/eta.js';

interface Step {
  name: string;
  state: string;
  nozzleTemp: number;
  nozzleTarget: number;
  bedTemp: number;
  bedTarget: number;
  layer: number;
  totalLayers: number;
  progress: number;
  elapsedSec: number;
  remainingSec: number;
  filePosition: number;
}

const fx = JSON.parse(readFileSync(new URL('./fixtures/k2se/heating-sequence.json', import.meta.url), 'utf8')) as {
  hints: EtaInput['hints'];
  fileName: string;
  fileSize: number;
  steps: Step[];
};
const SLICER = secondsFromFileName(fx.fileName)!;
const NOW = 1_800_000_000_000;

const input = (step: Step, over: Partial<EtaInput> = {}): EtaInput => ({
  status: { ...(step as unknown as EtaInput['status']), job: { filePosition: step.filePosition, fileSize: fx.fileSize } },
  hints: fx.hints,
  slicerSeconds: SLICER,
  printingSinceElapsed: null,
  now: NOW,
  ...over,
});
const step = (name: string) => fx.steps.find((s) => s.name === name)!;

describe('ETA: phases and remaining time over a real heating sequence', () => {
  it('reads the slicer time from the Creality file name (matches timeCost 13237 s)', () => {
    assert.equal(SLICER, 3 * 3600 + 40 * 60 + 37);
    assert.equal(secondsFromFileName('cube_PLA_1h0m.gcode'), 3600);
    assert.equal(secondsFromFileName('cube.gcode'), null);
    assert.equal(secondsFromFileName('Cube_1.gcode'), null);
  });

  it('heating: slicer estimate + heat-up + preparation, never the printer 0 s', () => {
    const s = step('heating-cold');
    const eta = computeEta(input(s))!;
    assert.equal(eta.phase, 'heating');
    assert.equal(eta.source, 'slicer');
    const heat = Math.max((220 - 25.3) / NOZZLE_RATE, (60 - 24.9) / BED_RATE);
    assert.equal(eta.remainingSec, Math.round(SLICER + heat + PREP_SEC));
    assert.equal(eta.finishesAt, NOW + eta.remainingSec! * 1000);
    // bed done, hotend still heating: the gap shrinks
    const later = computeEta(input(step('heating-bed-done')))!;
    assert.equal(later.phase, 'heating');
    assert.ok(later.remainingSec! < eta.remainingSec!);
    // calibration requested: longer preparation allowance
    assert.equal(computeEta(input(s, { calibrate: true }))!.remainingSec, Math.round(SLICER + heat + CALIBRATION_SEC));
  });

  it('preparing (homing/leveling): ignores the bogus 189 s from the printer', () => {
    const eta = computeEta(input(step('leveling')))!;
    assert.equal(eta.phase, 'preparing');
    assert.equal(eta.source, 'slicer');
    assert.ok(eta.remainingSec! > SLICER);
    // calibration running (withSelfTest 1..99) is preparing even if the file position moved
    const cal = computeEta(input(step('first-layer'), { hints: { ...fx.hints, selfTest: 50 } }))!;
    assert.equal(cal.phase, 'preparing');
    assert.equal(cal.remainingSec, Math.round(SLICER + CALIBRATION_SEC / 2));
  });

  it('first layer: position-based, the implausible printer value is rejected', () => {
    const eta = computeEta(input(step('first-layer'), { printingSinceElapsed: 250 }))!;
    assert.equal(eta.phase, 'printing');
    assert.equal(eta.source, 'position');
    const f = (40000 - 13562) / (5095921 - 13562);
    assert.equal(eta.remainingSec, Math.round(SLICER * (1 - f))); // < 120 s of printing: no pace correction yet
  });

  it('mid print: the printer value is used once plausible (layer ≥ 2, ×0.5..×2 of position-based)', () => {
    const eta = computeEta(input(step('mid-print'), { printingSinceElapsed: 200 }))!;
    assert.equal(eta.phase, 'printing');
    assert.equal(eta.source, 'printer');
    assert.equal(eta.remainingSec, 8521);
    // the same moment with a nonsense printer value falls back to position × observed pace
    const bogus = computeEta(input({ ...step('mid-print'), remainingSec: 60 }, { printingSinceElapsed: 200 }))!;
    assert.equal(bogus.source, 'position');
    const f = (2342801 - 13562) / (5095921 - 13562);
    const pace = (6387 - 200) / (SLICER * f);
    assert.equal(bogus.remainingSec, Math.round(SLICER * (1 - f) * pace));
  });

  it('end G-code: finishing, never 0', () => {
    const eta = computeEta(input(step('end-gcode')))!;
    assert.equal(eta.phase, 'finishing');
    assert.ok(eta.remainingSec! >= 1);
  });

  it('paused: no finish time; idle/complete: no estimate; unknown slicer time while heating → null, not 0', () => {
    const paused = computeEta(input({ ...step('mid-print'), state: 'paused' }, { printingSinceElapsed: 200 }))!;
    assert.equal(paused.finishesAt, null);
    assert.ok(paused.remainingSec! > 0);
    assert.equal(computeEta(input({ ...step('mid-print'), state: 'complete' })), null);
    assert.equal(computeEta(input({ ...step('mid-print'), state: 'idle' })), null);
    const unknown = computeEta(input(step('heating-cold'), { slicerSeconds: null }))!;
    assert.equal(unknown.phase, 'heating');
    assert.equal(unknown.remainingSec, null);
    assert.equal(unknown.finishesAt, null);
    assert.equal(etaPhase(input({ ...step('mid-print'), state: 'stopping' })), 'finishing');
  });

  it('every step of the sequence yields a non-zero remaining time', () => {
    let since: number | null = null;
    for (const s of fx.steps) {
      const i = input(s, { printingSinceElapsed: since });
      if (since === null && etaPhase(i) === 'printing') since = s.elapsedSec;
      const eta: ReturnType<typeof computeEta> = computeEta({ ...i, printingSinceElapsed: since });
      assert.ok(eta);
      assert.ok(eta.remainingSec !== null && eta.remainingSec > 0, `${s.name}: ${eta.remainingSec}`);
    }
  });

  it('without start/end offsets, layer 0 + progress 0 still counts as before the print', () => {
    const noHints = { startByte: null, endByte: null, estimatedSeconds: null, selfTest: null };
    assert.equal(etaPhase(input(step('leveling'), { hints: noHints, status: { ...input(step('leveling')).status, job: { filePosition: 9120, fileSize: fx.fileSize } } })), 'preparing');
    assert.equal(etaPhase(input(step('mid-print'), { hints: noHints })), 'printing');
  });
});

describe('ETA: slicer comments in the G-code', () => {
  it('parses durations and Creality/Orca/Cura comments with start/end offsets', () => {
    assert.equal(parseDuration('1d 2h 3m 4s'), 93784);
    assert.equal(parseDuration('nothing'), null);
    const head = '; HEADER_BLOCK_START\n; estimated printing time (normal mode) = 1h 2m 3s\nG28\n;LAYER_CHANGE\nG1 X1\n';
    const tail = ';LAYER_CHANGE\nG1 X2\n; EXECUTABLE_BLOCK_END\nM104 S0\n';
    const t = parseGcodeTiming(head, tail, 1000);
    assert.equal(t.seconds, 3723);
    assert.equal(t.startByte, head.indexOf(';LAYER_CHANGE'));
    assert.equal(t.endByte, 1000 + tail.indexOf('; EXECUTABLE_BLOCK_END'));
    assert.equal(parseGcodeTiming(';TIME:600\n;LAYER:0\n', '', 0).seconds, 600);
    assert.deepEqual(parseGcodeTiming('G1\n', 'G1\n', 0), { seconds: null, startByte: null, endByte: null });
  });

  it('reads head and tail of a file on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'printyard-eta-'));
    const p = join(dir, 'x.gcode');
    const body = 'G1 X1 E0.1\n'.repeat(40_000); // ~440 KB: tail is a separate read
    writeFileSync(p, `; estimated printing time (normal mode) = 10m 0s\nG28\n;LAYER_CHANGE\n${body}END_PRINT\n`);
    const t = await readGcodeTiming(p);
    assert.equal(t.seconds, 600);
    assert.ok(t.startByte !== null && t.startByte > 0);
    assert.ok(t.endByte !== null && t.endByte > 400_000);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('ETA: no estimate once the job is over (live bug: idle after a finished print showed "preparing")', () => {
  // Exact frame reported by the real printer while idle after a finished print, bed still occupied.
  const after = {
    state: 0, deviceState: 0, printProgress: 100, TotalLayer: 0, layer: 0, printLeftTime: 0, printJobTime: 0,
    nozzleTemp: '219.900000', targetNozzleTemp: 220, bedTemp0: '60.000000', targetBedTemp0: 60,
    printFileName: '/usr/data/printer_data/gcodes/Object_1_PLA_3h40m37s.gcode', withSelfTest: 100,
  };

  const viaService = async (raw: Record<string, unknown>, job: { filePosition: number; fileSize: number } | null = null) => {
    const { toPrinterStatus } = await import('../src/printers/k2se/protocol.js');
    const { EtaService } = await import('../src/modules/printing/eta.js');
    const status = { ...toPrinterStatus(1, raw, true), job: job as never };
    const manager = {
      addExtender() {},
      hasDriver: () => true,
      driver: () => ({ etaHints: () => ({ startByte: 13562, endByte: 5095921, estimatedSeconds: null, selfTest: 100 }) }),
      republish() {},
    };
    const svc = new EtaService({ manager: manager as never, tracked: () => null, gcodePath: async () => { throw new Error('no file'); } });
    return { status, eta: svc.estimate(status) };
  };

  it('state 0 + progress 100 + no layers + temps at target → estimate null', async () => {
    const { status, eta } = await viaService(after);
    assert.equal(status.state, 'idle');
    assert.equal(eta, null);
  });

  it('the same leftovers still flagged as running (state 1, no job file layers) → no phase either', async () => {
    const { eta } = await viaService({ ...after, state: 1 });
    assert.equal(eta, null);
    // and a running state without any file at all
    const { eta: noFile } = await viaService({ ...after, state: 1, printFileName: '', printProgress: 0 });
    assert.equal(noFile, null);
  });

  it('complete / aborted / failed → null; a real job start still gets an estimate', async () => {
    for (const state of [2, 3, 4]) assert.equal((await viaService({ ...after, state })).eta, null, `state ${state}`);
    const start = await viaService(
      { ...after, state: 1, printProgress: 0, TotalLayer: 756, layer: 0, nozzleTemp: '25.0', bedTemp0: '25.0' },
      { filePosition: 1830, fileSize: 5117963 },
    );
    assert.equal(start.eta?.phase, 'heating');
    assert.ok(start.eta!.remainingSec! > 13237); // slicer time from the Creality file name + heat-up
  });
});
