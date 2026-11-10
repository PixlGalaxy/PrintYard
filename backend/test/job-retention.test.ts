import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { JobRetention } from '../src/printers/k2se/job-retention.js';
import { composeLiveStatus } from '../src/printers/k2se/live-driver.js';
import { mergeObjects, statusFromQuery, type MoonrakerObjects } from '../src/printers/k2se/moonraker.js';
import { mergeFrame, type RawPrinterState } from '../src/printers/k2se/protocol.js';
import type { PrinterStatus } from '../src/types.js';

const read = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/k2se/${name}`, import.meta.url), 'utf8')) as unknown;
const CREALITY = JSON.parse((read('printing-stream.json') as string[])[0]!) as Record<string, unknown>;
const MOON = read('moonraker-query.json');
const SEQ = (read('pause-resume-sequence.json') as { steps: { t: number; creality: Record<string, unknown>; moonraker: Record<string, unknown> }[] }).steps;

type Step = { t: number; creality: Record<string, unknown>; moonraker: Record<string, unknown> };

/** Replays frames through the driver's pure status pipeline + retention, sampling every 250 ms like the UI sees it. */
function replay(steps: Step[], until = steps.at(-1)!.t, holdMs = 5000): { t: number; s: PrinterStatus }[] {
  const raw: RawPrinterState = mergeFrame({}, CREALITY);
  const moon: MoonrakerObjects = statusFromQuery(MOON)!;
  const keep = new JobRetention(holdMs);
  const t0 = 1_000_000;
  const out: { t: number; s: PrinterStatus }[] = [];
  let i = 0;
  for (let t = 0; t <= until; t += 250) {
    while (i < steps.length && steps[i]!.t <= t) {
      mergeFrame(raw, steps[i]!.creality);
      mergeObjects(moon, steps[i]!.moonraker);
      i++;
    }
    const klipper = typeof moon.print_stats?.state === 'string' ? (moon.print_stats.state as string) : null;
    const s = composeLiveStatus(1, raw, true, moon, klipper);
    keep.apply(s, klipper, t0 + t);
    out.push({ t, s });
  }
  return out;
}

const dedupe = <T,>(xs: T[]) => xs.filter((x, k) => k === 0 || x !== xs[k - 1]);

describe('job retention across pause → resume (real K2 SE frame sequence)', () => {
  it('never publishes job=null and walks printing → pausing → paused → resuming → printing', () => {
    const r = replay(SEQ);
    for (const { t, s } of r) {
      assert.ok(s.job, `job null at ${t} ms (state ${s.state})`);
      assert.equal(s.job.fileName, 'Object_1_PLA_3h40m37s.gcode');
      assert.notEqual(s.job.filePosition, null, `position lost at ${t} ms`);
      assert.notEqual(s.job.toolhead, null, `toolhead lost at ${t} ms`);
      assert.notEqual(s.position, null);
    }
    assert.deepEqual(dedupe(r.map((x) => x.s.state)), ['printing', 'pausing', 'paused', 'resuming', 'printing']);
    const pos = r.map((x) => x.s.job!.filePosition!);
    for (let k = 1; k < pos.length; k++) assert.ok(pos[k]! >= pos[k - 1]!, 'G-code position never goes back');
    assert.equal(pos.at(-1), 2350000);
  });

  it('a real end is not hidden: complete keeps the final job only during the hold, cancel is never masked', () => {
    const done = replay(
      [
        { t: 0, creality: { state: 1 }, moonraker: {} },
        { t: 1000, creality: { state: 2 }, moonraker: { print_stats: { state: 'complete' }, virtual_sdcard: { is_active: false } } },
      ],
      8000,
    );
    assert.equal(done.find((x) => x.t === 1500)!.s.state, 'complete');
    assert.ok(done.find((x) => x.t === 1500)!.s.job, 'final view kept during the hold');
    assert.equal(done.at(-1)!.s.job, null);

    const cancel = replay(
      [
        { t: 0, creality: { state: 1 }, moonraker: {} },
        { t: 500, creality: { state: 7 }, moonraker: {} },
        { t: 1000, creality: { state: 4 }, moonraker: { print_stats: { state: 'standby' }, virtual_sdcard: { is_active: false } } },
      ],
      1500,
    );
    assert.equal(cancel.at(-1)!.s.state, 'aborted');
  });

  it('an idle state that outlasts the hold is published as idle without a job', () => {
    const r = replay(
      [
        { t: 0, creality: { state: 1 }, moonraker: {} },
        { t: 1000, creality: { state: 0 }, moonraker: { print_stats: { state: 'standby' }, virtual_sdcard: { is_active: false } } },
      ],
      7000,
    );
    assert.equal(r.find((x) => x.t === 3000)!.s.state, 'printing');
    assert.ok(r.find((x) => x.t === 3000)!.s.job);
    assert.equal(r.at(-1)!.s.state, 'idle');
    assert.equal(r.at(-1)!.s.job, null);
  });
});
