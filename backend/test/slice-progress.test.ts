import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { BANDS, parsePipeLine, ProgressModel, stageFromMessage } from '../src/modules/slicing/progress.js';

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

  /** Replays the capture against the model, sampling every 250 ms like the worker's ticker. */
  function replay() {
    const t0 = 1_000_000;
    const m = new ProgressModel(TRIS, t0);
    m.engineStarted(t0);
    const samples: { t: number; progress: number; stage: string }[] = [];
    let i = 0;
    const end = CAPTURE.at(-1)!.t;
    for (let t = 0; t <= end + 250; t += 50) {
      while (i < CAPTURE.length && CAPTURE[i]!.t <= t) m.engine(parsePipeLine(CAPTURE[i++]!.line)!, t0 + t);
      if (t % 250 === 0) {
        const s = m.tick(t0 + t);
        samples.push({ t, progress: s.progress, stage: s.stage });
      }
    }
    return samples;
  }

  it('moves during the silent 10 s load instead of sitting at the raw 1 %', () => {
    const s = replay();
    const at = (ms: number) => s.find((x) => x.t >= ms)!;
    assert.equal(at(0).stage, 'loading');
    assert.ok(at(2000).progress > BANDS.loading[0] + 3, `2 s: ${at(2000).progress}`);
    assert.ok(at(5000).progress > at(2000).progress);
    assert.ok(at(9750).progress < BANDS.loading[1], 'creep never leaves the loading band');
    assert.ok(at(9750).progress >= 25, `9.75 s: ${at(9750).progress}`);
  });

  it('is monotonic, covers the stages and ends in the G-code band', () => {
    const s = replay();
    for (let k = 1; k < s.length; k++) assert.ok(s[k]!.progress >= s[k - 1]!.progress, `step ${k}`);
    const distinct = new Set(s.map((x) => x.progress));
    assert.ok(distinct.size >= 20, `only ${distinct.size} distinct values`);
    assert.ok(s.some((x) => x.stage === 'supports'));
    const last = s.at(-1)!;
    assert.equal(last.stage, 'gcode');
    assert.ok(last.progress >= BANDS.gcode[1] - 1 && last.progress < BANDS.postprocessing[0], String(last.progress));
  });

  it('post-processing and done finish at 100', () => {
    const m = new ProgressModel(1000, 0);
    m.engineStarted(0);
    m.engine({ totalPercent: 100, platePercent: 100, message: 'All done, Success' }, 10);
    m.postprocessing('thumbnails', 'Adding thumbnails', 20);
    assert.ok(m.tick(30).progress >= BANDS.postprocessing[0]);
    assert.equal(m.tick(30).stage, 'thumbnails');
    m.done();
    assert.equal(m.tick(40).progress, 100);
  });
});
