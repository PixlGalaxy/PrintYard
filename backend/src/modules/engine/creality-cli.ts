import { spawn, spawnSync } from 'node:child_process';
import { constants, existsSync, openSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { setPriority } from 'node:os';
import { join } from 'node:path';
import { Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { logger } from '../../logger.js';
import { parsePipeLine } from '../slicing/progress.js';
import { EngineError, type EngineSliceRequest, type EngineSliceResult, type SlicerEngine } from './engine.types.js';

/** CLI return codes (src/libslic3r/Utils.hpp) → PrintYard error codes. */
const CLI_ERRORS: Record<number, string> = {
  [-2]: 'slice.engine_invalid_params',
  [-3]: 'slice.engine_file_not_found',
  [-6]: 'slice.engine_bad_project',
  [-14]: 'slice.out_of_memory',
  [-17]: 'slice.process_not_compatible',
  [-18]: 'slice.invalid_values',
  [-24]: 'slice.engine_version',
  [-50]: 'slice.no_objects',
  [-51]: 'slice.validate_error',
  [-52]: 'slice.object_outside',
  [-58]: 'slice.timeout',
  [-59]: 'slice.too_many_triangles',
  [-61]: 'slice.filament_bed_mismatch',
  [-62]: 'slice.filament_temperatures',
  [-63]: 'slice.collision',
  [-64]: 'slice.collision',
  [-65]: 'slice.spiral_mode_invalid',
  [-100]: 'slice.engine_error',
  [-101]: 'slice.gcode_path_conflict',
};

/** Path of the engine binary inside an extracted AppImage. */
export function crealityBinary(root: string): string {
  return join(root, 'bin', 'CrealityPrint');
}

/** Environment the AppImage's AppRun would set, plus a private HOME/TMPDIR (the CLI writes to $TMPDIR/crealityprint_model). */
export function engineEnv(root: string, jobDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LD_LIBRARY_PATH: `${join(root, 'bin')}:${join(root, 'usr', 'lib')}`,
    LC_ALL: 'C',
    HOME: join(jobDir, 'home'),
    TMPDIR: join(jobDir, 'tmp'),
    // Headless: the CLI path never opens a display (verified with the 7.3.1 AppImage).
    NO_AT_BRIDGE: '1',
  };
  return env;
}

/** Linux: resident set size of a process in bytes, or null. */
async function readRss(pid: number): Promise<number | null> {
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

let tasksetPath: string | null | undefined;
function taskset(): string | null {
  if (tasksetPath !== undefined) return tasksetPath;
  tasksetPath = ['/usr/bin/taskset', '/bin/taskset'].find((p) => existsSync(p)) ?? null;
  return tasksetPath;
}

/** Parses a kernel CPU list (`0-3,8,10-11`) into CPU ids; null when malformed. */
export function parseCpuList(list: string): number[] | null {
  const out: number[] = [];
  for (const part of list.trim().split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (b < a || b - a > 4096) return null;
    for (let i = a; i <= b; i++) out.push(i);
  }
  return out.length ? out : null;
}

/** CPUs this process may run on (`Cpus_allowed_list`: honours `docker --cpuset-cpus`); null when unknown. */
async function allowedCpus(): Promise<number[] | null> {
  try {
    const status = await readFile('/proc/self/status', 'utf8');
    const m = /^Cpus_allowed_list:\s*(\S+)/m.exec(status);
    return m ? parseCpuList(m[1] ?? '') : null;
  } catch {
    return null;
  }
}

/**
 * Affinity for the engine: every allowed CPU but the last one (left for the web UI), as a `taskset -c` list.
 * The ids come from the real allowed set: a container pinned to CPUs 4-7 must not be asked for CPU 0
 * (`taskset: failed to set pid …'s affinity: Invalid argument`). Null (no taskset) with fewer than 3 CPUs or
 * an unknown set.
 */
export function engineCpuList(cpus: number[] | null): string | null {
  if (!cpus || cpus.length < 3) return null;
  return cpus.slice(0, -1).join(',');
}

/**
 * Opens the progress FIFO read+write and non-blocking, so opening never waits for the engine and we never see EOF
 * between writer reconnects. Lines are JSON: {message, plate_count, plate_index, plate_percent, total_percent}.
 */
async function openProgressPipe(path: string, onLine: (line: string) => void): Promise<(() => void) | null> {
  if (process.platform !== 'linux') return null;
  const mk = spawnSync('mkfifo', ['-m', '600', path]);
  if (mk.status !== 0) return null;
  // A raw fd (not a FileHandle, which would close it on GC): the Socket owns and closes it.
  const fd = openSync(path, constants.O_RDWR | constants.O_NONBLOCK);
  const sock = new Socket({ fd, readable: true, writable: false });
  const rl = createInterface({ input: sock });
  rl.on('line', onLine);
  sock.on('error', () => undefined);
  return () => {
    rl.close();
    sock.destroy();
  };
}

export class CrealityCliEngine implements SlicerEngine {
  readonly id = 'creality' as const;

  constructor(
    readonly root: string,
    readonly version: string,
  ) {}

  async slice(req: EngineSliceRequest): Promise<EngineSliceResult> {
    await mkdir(join(req.jobDir, 'home'), { recursive: true });
    await mkdir(join(req.jobDir, 'tmp'), { recursive: true });
    await mkdir(req.outDir, { recursive: true });
    const logFile = join(req.jobDir, 'engine.log');
    const fifo = join(req.jobDir, 'progress.fifo');
    const warnings: string[] = [];

    let closePipe: (() => void) | null = null;
    try {
      closePipe = await openProgressPipe(fifo, (line) => {
        const u = parsePipeLine(line);
        if (!u) return;
        if (u.warning) warnings.push(u.warning);
        req.onProgress(u);
      });
    } catch (err) {
      logger.warn('Slicer progress pipe unavailable', err);
    }

    const bin = crealityBinary(this.root);
    const args = [
      '--cli',
      '--slice',
      '0',
      '--outputdir',
      req.outDir,
      '--need-gcode-file',
      '--debug',
      '2',
      '--logfile',
      logFile,
      '--mstpp',
      String(Math.max(60, Math.ceil(req.timeoutMs / 1000))),
      '--mtcpp',
      '5000000',
      ...(closePipe ? ['--pipe', fifo] : []),
      req.projectFile,
    ];
    // Leave one core for the web UI (TBB ignores cgroup CPU quotas but honours affinity); fewer threads also
    // lowers peak memory (spike: 24 threads 480 MB vs 2 threads 300 MB on a 250k-triangle sphere with tree supports).
    const ts = taskset();
    const cpus = ts ? engineCpuList(await allowedCpus()) : null;
    const [cmd, cmdArgs] = ts && cpus ? [ts, ['-c', cpus, bin, ...args]] : [bin, args];

    const child = spawn(cmd, cmdArgs, {
      cwd: req.jobDir,
      env: engineEnv(this.root, req.jobDir),
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: false,
    });
    req.onStarted?.();
    let stderrTail = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => {
      stderrTail = (stderrTail + d).slice(-8192);
    });

    let killedFor: 'timeout' | 'memory' | 'cancel' | null = null;
    let peak = 0;
    const kill = (why: 'timeout' | 'memory' | 'cancel') => {
      if (killedFor) return;
      killedFor = why;
      child.kill('SIGKILL');
    };
    const onAbort = () => kill('cancel');
    req.signal.addEventListener('abort', onAbort, { once: true });
    if (req.signal.aborted) kill('cancel');
    const timer = setTimeout(() => kill('timeout'), req.timeoutMs);

    // Make the slicer the preferred OOM victim and lower its priority (no privileges needed for either).
    if (child.pid) {
      writeFile(`/proc/${child.pid}/oom_score_adj`, '1000').catch(() => undefined);
      try {
        setPriority(child.pid, 10);
      } catch {
        /* not permitted */
      }
    }
    const watchdog = setInterval(() => {
      if (!child.pid) return;
      void readRss(child.pid).then((rss) => {
        if (rss === null) return;
        if (rss > peak) peak = rss;
        if (req.maxRssBytes > 0 && rss > req.maxRssBytes) kill('memory');
      });
    }, 500);

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
      child.on('error', (error) => resolve({ code: null, signal: null, error }));
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timer);
    clearInterval(watchdog);
    req.signal.removeEventListener('abort', onAbort);
    closePipe?.();
    await rm(fifo, { force: true });

    if (killedFor === 'cancel') throw new EngineError('slice.cancelled', 'Cancelled');
    if (killedFor === 'timeout') throw new EngineError('slice.timeout', `Slicing took longer than ${Math.round(req.timeoutMs / 60000)} min`);
    if (killedFor === 'memory') {
      throw new EngineError('slice.out_of_memory', `The slicer used more than ${Math.round(req.maxRssBytes / 1048576)} MB and was stopped`);
    }
    if (exit.error) throw new EngineError('slice.engine_failed', `Could not start the slicer: ${exit.error.message}`);

    let result: { return_code?: number; error_string?: string; sliced_plates?: { warning_message?: string }[] } | null = null;
    try {
      result = JSON.parse(await readFile(join(req.outDir, 'result.json'), 'utf8'));
    } catch {
      /* missing on crashes */
    }
    for (const p of result?.sliced_plates ?? []) if (p.warning_message) warnings.push(p.warning_message);
    const rc = result?.return_code ?? (exit.code !== null ? (exit.code > 127 ? exit.code - 256 : exit.code) : null);
    const gcodePath = join(req.outDir, 'plate_1.gcode');
    if (rc === 0 && existsSync(gcodePath)) return { gcodePath, ...(peak && { peakRssBytes: peak }), warnings };

    if (exit.signal === 'SIGKILL' || exit.code === 137) {
      throw new EngineError('slice.out_of_memory', 'The slicer was killed (out of memory?)');
    }
    const code = (rc !== null && CLI_ERRORS[rc]) || 'slice.engine_failed';
    const message = result?.error_string || `Slicer exited with code ${exit.code ?? exit.signal}`;
    logger.warn(`Slicer failed (rc=${rc}): ${message}${stderrTail ? ` | ${stderrTail.split('\n').slice(-3).join(' ')}` : ''}`);
    throw new EngineError(code, message, { returnCode: rc });
  }
}

/** `--cli --help` must exit 0 and print the usage line. */
export async function cliHelpWorks(root: string, jobDir: string): Promise<boolean> {
  await mkdir(join(jobDir, 'home'), { recursive: true });
  await mkdir(join(jobDir, 'tmp'), { recursive: true });
  return new Promise((resolve) => {
    const child = spawn(crealityBinary(root), ['--cli', '--help'], { cwd: jobDir, env: engineEnv(root, jobDir), stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      out = (out + d).slice(-16384);
    });
    const t = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', () => resolve(false));
    child.on('close', (code) => {
      clearTimeout(t);
      resolve(code === 0 && /Usage:\s*CrealityPrint --cli/.test(out));
    });
  });
}
