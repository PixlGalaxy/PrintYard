import { readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { AppError } from '../../errors.js';
import { logger } from '../../logger.js';
import type { BuildJobInput, BuildJobOutput } from './build-core.js';

export interface BuildRunOptions {
  signal?: AbortSignal;
  /** Hard limit for one build; the worker is terminated after it (default 10 min). */
  timeoutMs?: number;
  /** Error thrown when `signal` aborts (the slicing path passes its own `slice.cancelled`). */
  abortError?: () => Error;
}

/** Same file in src (tsx: .ts) and dist (.js). The worker inherits the parent's execArgv, so tsx loads it in dev/tests. */
function workerUrl(): URL {
  return new URL(import.meta.url.endsWith('.ts') ? './build.worker.ts' : './build.worker.js', import.meta.url);
}

/** Removes `<dest>.*.part` files a terminated writer left behind. */
async function removePartials(dest: string): Promise<void> {
  const dir = dirname(dest);
  const prefix = `${basename(dest)}.`;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (name.startsWith(prefix) && name.endsWith('.part')) await rm(join(dir, name), { force: true }).catch(() => undefined);
  }
}

/**
 * One build worker thread (pool of size 1; callers already serialise builds). Mesh parsing and 3MF writing run off
 * the main event loop. Cancel/timeout terminate the worker (its heap is freed at once); an idle worker is also
 * terminated after `idleMs`, so the memory of a big build never lingers.
 */
export class BuildPool {
  private worker: Worker | null = null;
  private nextId = 1;
  private idleTimer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly opts: { idleMs?: number; maxHeapMb?: number } = {},
  ) {}

  /** True while a worker thread exists (tests). */
  get alive(): boolean {
    return this.worker !== null;
  }

  private spawn(): Worker {
    const w = new Worker(workerUrl(), {
      resourceLimits: { maxOldGenerationSizeMb: this.opts.maxHeapMb ?? 4096 },
    });
    w.unref();
    w.on('error', (err: Error) => logger.warn(`Build worker error: ${err.message}`));
    w.on('exit', () => {
      if (this.worker === w) this.worker = null;
    });
    return w;
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.terminate(), this.opts.idleMs ?? 15_000);
    this.idleTimer.unref();
  }

  async terminate(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const w = this.worker;
    this.worker = null;
    if (w) await w.terminate().catch(() => undefined);
  }

  run(input: BuildJobInput, opts: BuildRunOptions = {}): Promise<BuildJobOutput> {
    if (this.busy) return Promise.reject(new AppError(429, 'projects.busy', 'Another project is being built; try again in a moment'));
    if (opts.signal?.aborted) return Promise.reject(opts.abortError?.() ?? new AppError(499, 'projects.cancelled', 'Cancelled'));
    this.busy = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const w = (this.worker ??= this.spawn());
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? 10 * 60_000;

    return new Promise<BuildJobOutput>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        w.off('message', onMessage);
        w.off('exit', onExit);
        this.busy = false;
      };
      const kill = (err: Error) => {
        if (settled) return;
        cleanup();
        void this.terminate()
          .then(() => removePartials(input.dest))
          .finally(() => reject(err));
      };
      const onAbort = () => kill(opts.abortError?.() ?? new AppError(499, 'projects.cancelled', 'Cancelled'));
      const onExit = (code: number) => {
        if (settled) return;
        cleanup();
        void removePartials(input.dest).finally(() =>
          reject(
            new AppError(
              500,
              'projects.build_failed',
              code === 1 ? 'The project build ran out of memory' : `The project build stopped (exit ${code})`,
            ),
          ),
        );
      };
      const onMessage = (msg: { id: number; ok: boolean; result?: BuildJobOutput; error?: { status?: number; code?: string; message: string; details?: unknown } }) => {
        if (msg.id !== id || settled) return;
        cleanup();
        this.armIdle();
        if (msg.ok) return resolve(msg.result!);
        const e = msg.error!;
        reject(e.code ? new AppError(e.status ?? 500, e.code, e.message, e.details) : new Error(e.message));
      };
      const timer = setTimeout(
        () => kill(new AppError(504, 'projects.build_timeout', `Building the project took longer than ${Math.round(timeoutMs / 1000)} s`)),
        timeoutMs,
      );
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      w.on('message', onMessage);
      w.on('exit', onExit);
      w.postMessage({ id, input });
    });
  }
}
