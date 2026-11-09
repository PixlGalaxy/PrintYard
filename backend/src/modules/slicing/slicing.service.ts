import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SettingsService } from '../../db/settings.js';
import { AppError, notFound } from '../../errors.js';
import { readMemoryLimit } from '../../lib/memory.js';
import { logger } from '../../logger.js';
import type { Role, SceneDoc, SliceJob, SliceJobState } from '../../types.js';
import type { AuditActor } from '../audit/audit.service.js';
import type { EngineManager } from '../engine/engine.service.js';
import { EngineError } from '../engine/engine.types.js';
import { hashFile, type FilesService } from '../files/files.service.js';
import { injectThumbnails, parseGcodeSummary, pngSize, type Thumbnail } from '../files/gcode.js';
import type { ProfilesService } from '../profiles/profiles.service.js';
import { buildProjectConfig } from '../projects/scene.js';
import { ProgressModel, type ProgressSnapshot } from './progress.js';
import type { ProjectsService } from '../projects/projects.service.js';

export interface SliceUser {
  id: number;
  username: string;
  role: Role;
}

export interface SliceSubmit {
  scene: SceneDoc;
  plate: number;
  thumbnails?: { small?: string; large?: string };
  /** Optional base name for the resulting G-code file. */
  name?: string;
}

interface Job extends SliceJob {
  userId: number;
  username: string;
  role: Role;
  scene: SceneDoc;
  name: string;
  thumbs: Thumbnail[];
  abort: AbortController;
  finishedAt?: number;
  ip: string | null;
}

const MAX_QUEUED_PER_USER = 3;
const MAX_QUEUED = 20;
const KEEP_FINISHED_MS = 60 * 60_000;
const TERMINAL: SliceJobState[] = ['done', 'failed', 'cancelled'];

/** Error codes the client can show; anything else becomes `slice.failed` with the message. */
function errorOf(err: unknown): { code: string; message: string } {
  if (err instanceof EngineError) return { code: err.code, message: err.message };
  if (err instanceof AppError) return { code: err.code, message: err.message };
  return { code: 'slice.failed', message: (err as Error)?.message ?? String(err) };
}

export class SlicingService {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: string[] = [];
  private running: Job | null = null;
  private readonly lastSent = new Map<string, { at: number; sig: string }>();
  private readonly pendingSend = new Map<string, NodeJS.Timeout>();
  private readonly jobsDir: string;

  constructor(
    private readonly deps: {
      appdataRoot: string;
      settings: SettingsService;
      engine: EngineManager;
      files: FilesService;
      profiles: ProfilesService;
      projects: ProjectsService;
      publish: (userId: number, job: SliceJob) => void;
    },
  ) {
    this.jobsDir = join(deps.appdataRoot, 'jobs');
  }

  /** True when nothing is queued or running (engine updates wait for this). */
  idle(): boolean {
    return !this.running && this.queue.length === 0;
  }

  private view(j: Job): SliceJob {
    return {
      id: j.id,
      state: j.state,
      progress: Math.round(j.progress),
      ...(j.message && { message: j.message }),
      ...(j.stage && { stage: j.stage }),
      plate: j.plate,
      createdAt: j.createdAt,
      ...(j.result && { result: j.result }),
      ...(j.error && { error: j.error }),
    };
  }

  /**
   * Publishes `slice.job` at most every 250 ms (≤ 4/s) with a trailing send, so the newest state of a burst is never
   * lost; identical consecutive views are skipped. State changes and terminal states go out immediately.
   */
  private emit(j: Job, force = false): void {
    const now = Date.now();
    const last = this.lastSent.get(j.id);
    const send = () => {
      const t = this.pendingSend.get(j.id);
      if (t) clearTimeout(t);
      this.pendingSend.delete(j.id);
      const view = this.view(j);
      const sig = `${view.state}|${view.progress}|${view.stage ?? ''}|${view.message ?? ''}`;
      if (last?.sig === sig && !TERMINAL.includes(view.state)) return;
      this.lastSent.set(j.id, { at: Date.now(), sig });
      this.deps.publish(j.userId, view);
    };
    if (force || !last || now - last.at >= 250) return send();
    if (!this.pendingSend.has(j.id)) {
      const t = setTimeout(send, 250 - (now - last.at));
      t.unref?.();
      this.pendingSend.set(j.id, t);
    }
  }

  /** Applies a progress snapshot (monotonic) and maps the stage onto the job state. */
  private apply(j: Job, snap: ProgressSnapshot): void {
    const state: SliceJobState =
      snap.stage === 'building' ? 'preparing' : snap.stage === 'thumbnails' || snap.stage === 'saving' ? 'postprocessing' : 'slicing';
    const changed = j.state !== state;
    j.state = state;
    j.stage = snap.stage;
    j.progress = Math.max(j.progress, Math.min(99, snap.progress));
    if (snap.message !== undefined) j.message = snap.message;
    this.emit(j, changed);
  }

  private set(j: Job, state: SliceJobState, progress: number, message?: string): void {
    const changed = j.state !== state;
    j.state = state;
    j.progress = Math.max(j.progress, Math.min(100, progress));
    if (message !== undefined) j.message = message;
    this.emit(j, changed || TERMINAL.includes(state));
  }

  private decodeThumb(b64: string | undefined): Thumbnail | null {
    if (!b64) return null;
    const png = Buffer.from(b64.replace(/^data:image\/png;base64,/, ''), 'base64');
    const size = pngSize(png);
    if (!size || png.length > 512 * 1024) throw new AppError(400, 'slice.invalid_thumbnail', 'Thumbnails must be PNG images ≤ 512 KB');
    return { width: size.width, height: size.height, png };
  }

  submit(user: SliceUser, body: SliceSubmit, ip: string | null): SliceJob {
    this.evict();
    if (!this.deps.engine.current()) throw new AppError(409, 'engine.not_installed', 'No slicing engine is installed yet');
    const { scene, plate } = body;
    if (!scene.plates.some((p) => p.index === plate) && !scene.objects.some((o) => o.plate === plate)) {
      throw new AppError(400, 'slice.invalid_plate', `Plate ${plate} does not exist`);
    }
    if (!scene.objects.some((o) => o.plate === plate)) throw new AppError(400, 'slice.empty_plate', 'This plate has no objects');
    // Fail fast on what can be checked now: presets, overrides, readable model files.
    buildProjectConfig(this.deps.profiles, scene, { id: user.id, role: user.role });
    for (const o of scene.objects.filter((x) => x.plate === plate)) {
      try {
        const row = this.deps.files.getReadable({ id: user.id, role: user.role }, o.fileId);
        if (row.kind !== 'model') throw new Error('not a model');
      } catch {
        throw new AppError(400, 'projects.missing_model', `Model file #${o.fileId} is not available`, { fileId: o.fileId });
      }
    }
    const thumbs = [this.decodeThumb(body.thumbnails?.small), this.decodeThumb(body.thumbnails?.large)].filter((t): t is Thumbnail => !!t);
    thumbs.sort((a, b) => a.width * a.height - b.width * b.height);

    const pending = [...this.jobs.values()].filter((j) => !TERMINAL.includes(j.state));
    if (pending.length >= MAX_QUEUED || pending.filter((j) => j.userId === user.id).length >= MAX_QUEUED_PER_USER) {
      throw new AppError(429, 'slice.queue_full', 'Too many slicing jobs are waiting; try again when one finishes');
    }
    const firstName = scene.objects.find((o) => o.plate === plate)?.name ?? 'plate';
    const base = (body.name?.trim() || (scene.objects.filter((o) => o.plate === plate).length > 1 ? 'plate' : firstName)).replace(/\.[^.]+$/, '');
    const job: Job = {
      id: randomUUID(),
      state: 'queued',
      stage: 'queued',
      progress: 0,
      plate,
      createdAt: Date.now(),
      userId: user.id,
      username: user.username,
      role: user.role,
      scene,
      name: `${base.slice(0, 120)}_plate${plate + 1}.gcode`,
      thumbs,
      abort: new AbortController(),
      ip,
    };
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    const ahead = this.queue.length - 1 + (this.running ? 1 : 0);
    if (ahead > 0) job.message = `Waiting (${ahead} ahead)`;
    this.emit(job, true);
    queueMicrotask(() => this.pump());
    return this.view(job);
  }

  get(user: SliceUser, id: string): SliceJob {
    const j = this.jobs.get(id);
    if (!j || (j.userId !== user.id && user.role !== 'admin')) throw notFound();
    return this.view(j);
  }

  cancel(user: SliceUser, id: string): SliceJob {
    const j = this.jobs.get(id);
    if (!j || (j.userId !== user.id && user.role !== 'admin')) throw notFound();
    if (TERMINAL.includes(j.state)) return this.view(j);
    const qi = this.queue.indexOf(id);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      this.finish(j, 'cancelled', 'Cancelled');
    } else {
      j.abort.abort();
    }
    return this.view(j);
  }

  private finish(j: Job, state: 'done' | 'failed' | 'cancelled', message?: string): void {
    j.finishedAt = Date.now();
    if (state === 'done') {
      j.progress = 100;
      j.stage = 'done';
    }
    this.set(j, state, j.progress, message);
    const t = this.pendingSend.get(j.id);
    if (t) clearTimeout(t);
    this.pendingSend.delete(j.id);
    this.lastSent.delete(j.id);
  }

  private evict(): void {
    const now = Date.now();
    for (const [id, j] of this.jobs) if (j.finishedAt && now - j.finishedAt > KEEP_FINISHED_MS) this.jobs.delete(id);
  }

  private maxRssBytes(): number {
    const mb = this.deps.settings.get('slicing.maxMemoryMb');
    if (mb > 0) return mb * 1024 * 1024;
    const limit = readMemoryLimit();
    return limit ? Math.floor(limit * 0.75) : 4096 * 1024 * 1024;
  }

  private pump(): void {
    if (this.running) return;
    const id = this.queue.shift();
    if (!id) return;
    const job = this.jobs.get(id);
    if (!job) return this.pump();
    this.running = job;
    void this.run(job).finally(() => {
      this.running = null;
      // Tell the others they moved up.
      this.queue.forEach((qid, i) => {
        const q = this.jobs.get(qid);
        if (q) {
          q.stage = 'queued';
          this.set(q, 'queued', 0, i === 0 ? 'Starting soon' : `Waiting (${i} ahead)`);
        }
      });
      this.pump();
    });
  }

  private async run(job: Job): Promise<void> {
    const engine = this.deps.engine.current();
    const jobDir = join(this.jobsDir, job.id);
    const release = this.deps.engine.acquire(engine?.root ?? null);
    const started = Date.now();
    let ticker: NodeJS.Timeout | undefined;
    try {
      if (!engine) throw new AppError(409, 'engine.not_installed', 'No slicing engine is installed');
      const model = new ProgressModel(0);
      const sourceBytes = [...new Set(job.scene.objects.filter((o) => o.plate === job.plate).map((o) => o.fileId))].reduce(
        (n, id) => n + (this.deps.files.getRow(id)?.size ?? 0),
        0,
      );
      model.building(Date.now(), 'Building the project', sourceBytes);
      this.apply(job, model.tick());
      ticker = setInterval(() => this.apply(job, model.tick()), 250);
      ticker.unref?.();
      await mkdir(jobDir, { recursive: true });
      const project = join(jobDir, 'project.3mf');
      const built = await this.deps.projects.build({ id: job.userId, role: job.role }, job.scene, project, {
        onlyPlate: job.plate,
        validateBounds: true,
        embedScene: false,
        // Cancel and the job timeout terminate the build worker too.
        signal: job.abort.signal,
        abortError: () => new EngineError('slice.cancelled', 'Cancelled'),
        timeoutMs: this.deps.settings.get('slicing.timeoutMinutes') * 60_000,
      });
      model.setTriangles(built.triangles);
      if (job.abort.signal.aborted) throw new EngineError('slice.cancelled', 'Cancelled');
      model.engineStarted();
      this.apply(job, model.tick());
      const result = await engine.slice({
        jobDir,
        projectFile: project,
        outDir: join(jobDir, 'out'),
        timeoutMs: this.deps.settings.get('slicing.timeoutMinutes') * 60_000,
        maxRssBytes: this.maxRssBytes(),
        signal: job.abort.signal,
        onStarted: () => {
          model.engineStarted();
          this.apply(job, model.tick());
        },
        onProgress: (u) => {
          model.engine(u);
          this.apply(job, model.tick());
        },
      });
      model.postprocessing('thumbnails', 'Adding thumbnails');
      this.apply(job, model.tick());
      const finalTmp = await this.deps.files.tempPath('gcode');
      if (job.thumbs.length > 0) await injectThumbnails(result.gcodePath, finalTmp, job.thumbs);
      else await rename(result.gcodePath, finalTmp);
      // Server-trusted: SliceDock produced this file (overrides are CR/LF-free, G-code templates refused), so its
      // own summary is used for limits. G-code files are never rewritten; sha256 is re-checked before printing.
      const summary = { ...(await parseGcodeSummary(finalTmp)), estimateSource: 'slicer' as const };
      const { sha256, size } = await hashFile(finalTmp);
      const file = await this.deps.files.addFile(
        { id: job.userId, username: job.username },
        {
          tmpPath: finalTmp,
          name: job.name,
          kind: 'gcode',
          ext: 'gcode',
          visibility: 'private',
          size,
          sha256,
          meta: { gcode: summary, trusted: true },
          thumbnail: job.thumbs[job.thumbs.length - 1]?.png ?? null,
        },
        { userId: job.userId, username: job.username, ip: job.ip } satisfies AuditActor,
      );
      job.result = { fileId: file.id, summary };
      const peak = result.peakRssBytes ? `, peak ${Math.round(result.peakRssBytes / 1048576)} MB` : '';
      logger.info(`Slice ${job.id} done in ${((Date.now() - started) / 1000).toFixed(1)} s (file #${file.id}${peak})`);
      this.finish(job, 'done', result.warnings[0] ?? 'Done');
    } catch (err) {
      const e = errorOf(err);
      if (e.code === 'slice.cancelled') {
        this.finish(job, 'cancelled', 'Cancelled');
      } else {
        job.error = e.code;
        logger.warn(`Slice ${job.id} failed: ${e.code} ${e.message}`);
        this.finish(job, 'failed', e.message);
      }
    } finally {
      if (ticker) clearInterval(ticker);
      release();
      if (process.env.SLICEDOCK_KEEP_JOBS !== '1') await rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Cancels everything (shutdown). */
  stop(): void {
    for (const id of this.queue.splice(0)) {
      const j = this.jobs.get(id);
      if (j) this.finish(j, 'cancelled', 'Server shutting down');
    }
    this.running?.abort.abort();
  }
}
