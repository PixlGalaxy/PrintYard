import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ENGINE_END, expectedDurations, parsePipeLine, planBands, POST_BAND, ProgressModel, stageFromMessage } from '../src/modules/slicing/progress.js';

/** Real `--pipe` output of Creality Print 7.3.1 (2M-triangle sphere + cube, tree supports), with ms timestamps. */
const CAPTURE = readFileSync(new URL('./fixtures/engine-pipe-heavy.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as { t: number; line: string });

describe('engine pipe parsing', () => {
  it('parses every captured line (messages and warnings)', () => {
    const parsed = CAPTURE.map((c) => parsePipeLine(c.line));
    assert.ok(parsed.every((p) => p !== null));
    assert.deepEqual(parsed[0], { totalPercent: 1, platePercent: 1, message: 'Start to load files' });
    assert.equal(parsed[2]!.warning, 'The flush multiplier setting is too low, value is 1.00');
    assert.equal(parsed[2]!.message, undefined);
    assert.equal(parsed.at(-1)!.totalPercent, 100);
    assert.equal(parsePipeLine('not json'), null);
    assert.equal(parsePipeLine('{"message":"x"}'), null);
  });

  it('maps engine messages to stage ids', () => {
    const stages = CAPTURE.map((c) => parsePipeLine(c.line)!).filter((u) => u.message).map((u) => stageFromMessage(u.message!, u.totalPercent));
    assert.deepEqual([...new Set(stages)], ['loading', 'slicing', 'walls', 'infill', 'supports', 'toolpath', 'gcode']);
  });
});

describe('progress model', () => {
  const TRIS = 1_957_212;

  /** Longest stretch (ms) without a change in the sampled progress. */
  function longestFlat(s: { t: number; progress: number }[]): number {
    let flat = 0;
    let since = s[0]!.t;
    for (let k = 1; k < s.length; k++) {
      if (s[k]!.progress !== s[k - 1]!.progress) since = s[k]!.t;
      flat = Math.max(flat, s[k]!.t - since);
    }
    return flat;
  }

  /**
   * Replays the capture against the model like the service does (build → engine), sampling every 250 ms like the
   * service's ticker. `stretch` multiplies the silent load (a slower machine than the capture's).
   */
  function replay(stretch = 1) {
    const t0 = 1_000_000;
    const m = new ProgressModel(0, t0 - 400, { supports: true });
    m.building(t0 - 400, 'Building the project', 2_000_000);
    m.setTriangles(TRIS);
    m.engineStarted(t0);
    const events = CAPTURE.map((c, k) => ({ t: k === 0 ? c.t : c.t + (stretch - 1) * (CAPTURE[1]!.t - CAPTURE[0]!.t), line: c.line }));
    const samples: { t: number; progress: number; stage: string }[] = [];
    let i = 0;
    const end = events.at(-1)!.t;
    for (let t = 0; t <= end + 250; t += 50) {
      while (i < events.length && events[i]!.t <= t) m.engine(parsePipeLine(events[i++]!.line)!, t0 + t);
      if (t % 250 === 0) {
        const s = m.tick(t0 + t);
        samples.push({ t, progress: s.progress, stage: s.stage });
      }
    }
    return samples;
  }

  it('gives each phase a band proportional to its measured duration', () => {
    const d = expectedDurations(TRIS, 0, true);
    const plan = planBands(['load', 'stages', 'export'], d, 5);
    const [la, lb] = plan.load!;
    assert.equal(la, 5);
    assert.ok(lb >= 70 && lb <= 78, `load ends at ${lb}`);
    assert.ok(plan.export![1] <= ENGINE_END + 1e-9 && plan.export![1] >= ENGINE_END - 1e-9);
    // Small model: loading still dominates, every phase keeps a visible share.
    const small = planBands(['load', 'stages', 'export'], expectedDurations(10_000, 0), 5);
    for (const p of ['load', 'stages', 'export'] as const) assert.ok(small[p]![1] - small[p]![0] >= 3, p);
  });

  it('moves through the silent 10 s load instead of sticking at ~34 %', () => {
    const s = replay();
    const at = (ms: number) => s.find((x) => x.t >= ms)!;
    assert.equal(at(0).stage, 'loading');
    assert.ok(at(2000).progress > 20, `2 s: ${at(2000).progress}`);
    assert.ok(at(5000).progress > at(2000).progress + 10);
    assert.ok(at(9750).progress >= 60 && at(9750).progress < 90, `9.75 s: ${at(9750).progress}`);
    assert.ok(longestFlat(s) <= 1000, `flat for ${longestFlat(s)} ms`);
  });

  it('is monotonic, covers the stages and ends in the G-code band', () => {
    const s = replay();
    for (let k = 1; k < s.length; k++) assert.ok(s[k]!.progress >= s[k - 1]!.progress, `step ${k}`);
    const distinct = new Set(s.map((x) => x.progress));
    assert.ok(distinct.size >= 30, `only ${distinct.size} distinct values`);
    assert.ok(s.some((x) => x.stage === 'supports'));
    const last = s.at(-1)!;
    assert.equal(last.stage, 'gcode');
    assert.ok(last.progress >= ENGINE_END - 1 && last.progress < POST_BAND[0], String(last.progress));
  });

  it('keeps creeping when loading takes 3x longer than estimated, then fills the rest', () => {
    const s = replay(3);
    const loading = s.filter((x) => x.stage === 'loading');
    assert.ok(loading.at(-1)!.t >= 29_000);
    assert.ok(longestFlat(loading) <= 1000, `flat for ${longestFlat(loading)} ms while loading`);
    assert.ok(loading.at(-1)!.progress < ENGINE_END - 4, `loading capped below the later phases: ${loading.at(-1)!.progress}`);
    for (let k = 1; k < s.length; k++) assert.ok(s[k]!.progress >= s[k - 1]!.progress, `step ${k}`);
    assert.ok(s.at(-1)!.progress >= ENGINE_END - 1);
  });

  it('a repeated engineStarted does not restart the loading creep', () => {
    const m = new ProgressModel(TRIS, 0);
    m.engineStarted(0);
    const a = m.tick(3000).progress;
    m.engineStarted(3000);
    assert.ok(m.tick(3250).progress >= a);
  });

  it('post-processing and done finish at 100', () => {
    const m = new ProgressModel(1000, 0);
    m.engineStarted(0);
    m.engine({ totalPercent: 100, platePercent: 100, message: 'All done, Success' }, 10);
    m.postprocessing('thumbnails', 'Adding thumbnails', 20);
    assert.ok(m.tick(30).progress >= POST_BAND[0]);
    assert.equal(m.tick(30).stage, 'thumbnails');
    m.done();
    assert.equal(m.tick(40).progress, 100);
  });
});
