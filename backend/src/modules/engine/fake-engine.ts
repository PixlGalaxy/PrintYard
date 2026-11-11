import { appendFile, copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appEnv, appEnvFlag } from '../../lib/env.js';
import { resourcesDir } from '../../lib/resources.js';
import { EngineError, type EngineSliceRequest, type EngineSliceResult, type SlicerEngine } from './engine.types.js';

/**
 * The real 7.3.1 pipe sequence (test/fixtures/engine-pipe-heavy.jsonl): [fraction of the run, total_percent, message].
 * Like the real engine, loading is silent for most of the run and slicing arrives in a burst.
 */
const STEPS: [number, number, string][] = [
  [0.0, 1, 'Start to load files'],
  [0.55, 3, 'Prepare slicing'],
  [0.57, 7, 'Slicing mesh'],
  [0.62, 16, 'Generating walls'],
  [0.66, 25, 'Generating infill regions: 1 / 8'],
  [0.7, 34, 'Generating infill toolpath'],
  [0.74, 48, 'Generating support'],
  [0.78, 61, 'Generating support'],
  [0.81, 66, 'Detect overhangs for auto-lift'],
  [0.84, 70, 'Optimizing toolpath'],
  [0.86, 75, 'Generating G-code'],
  [0.99, 93, 'Slicing finished'],
  [1.0, 100, 'All done, Success'],
];

/**
 * Development engine (`PRINTYARD_FAKE_ENGINE=1`, e.g. on Windows): emits progress like the real CLI and returns a
 * real Creality Print 7.3.1 K2 SE G-code (a 20 mm cube) so the UI can be built without the AppImage.
 * `PRINTYARD_FAKE_ENGINE_MS` sets the duration (default 4000 ms); `PRINTYARD_FAKE_ENGINE_FAIL=1` makes every job
 * fail like an engine error, to test the error UI; `PRINTYARD_FAKE_ENGINE_UNSAFE=1` appends `M104 S350`.
 */
export class FakeEngine implements SlicerEngine {
  readonly id = 'fake' as const;
  readonly root = null;

  constructor(
    readonly version = '7.3.1.6378-fake',
    private readonly durationMs = Number(appEnv('FAKE_ENGINE_MS')) || 4000,
  ) {}

  async slice(req: EngineSliceRequest): Promise<EngineSliceResult> {
    await mkdir(req.outDir, { recursive: true });
    const project = await readFile(req.projectFile);
    if (project.length < 22 || project.readUInt32LE(0) !== 0x04034b50) throw new EngineError('slice.engine_bad_project', 'Project is not a 3MF');
    req.onStarted?.();
    let elapsed = 0;
    for (const [at, total, message] of STEPS) {
      const wait = at * this.durationMs - elapsed;
      if (wait > 0) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, wait);
          req.signal.addEventListener('abort', () => {
            clearTimeout(t);
            resolve();
          }, { once: true });
        });
        elapsed += wait;
      }
      if (req.signal.aborted) throw new EngineError('slice.cancelled', 'Cancelled');
      req.onProgress({ totalPercent: total, platePercent: null, message });
    }
    if (req.signal.aborted) throw new EngineError('slice.cancelled', 'Cancelled');
    if (appEnvFlag('FAKE_ENGINE_FAIL')) throw new EngineError('slice.engine_error', 'Simulated engine failure');
    const gcodePath = join(req.outDir, 'plate_1.gcode');
    await copyFile(join(resourcesDir(), 'fake-engine', 'plate_1.gcode'), gcodePath);
    // Tests of the post-slice scan (review 3A #2): an engine emitting an out-of-range temperature.
    if (appEnvFlag('FAKE_ENGINE_UNSAFE')) await appendFile(gcodePath, 'M104 S350\n');
    return { gcodePath, warnings: [] };
  }
}
