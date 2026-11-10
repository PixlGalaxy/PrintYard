import { readFile, rm, writeFile } from 'node:fs/promises';
import { AppError, badRequest, notFound } from '../../errors.js';
import type { LibraryFile, SceneDoc } from '../../types.js';
import type { AuditActor } from '../audit/audit.service.js';
import type { FilesService, FileRow, Viewer } from '../files/files.service.js';
import { cleanName, hashFile } from '../files/files.service.js';
import { loadMesh, MAX_MESH_SOURCE_BYTES, MeshFormatError, readZipEntries, type Mesh } from '../files/mesh.js';
import { pngSize } from '../files/gcode.js';
import type { ProfilesService } from '../profiles/profiles.service.js';
import { buildProjectConfig, sceneSchema } from './scene.js';
import type { BuildProjectInput } from './threemf.js';

import { MAX_PROJECT_BYTES, MAX_SCENE_TRIANGLES, SCENE_ENTRY, type BuildSource } from './build-core.js';
import { BuildPool, type BuildRunOptions } from './build-pool.js';

export { MAX_PROJECT_BYTES, MAX_SCENE_TRIANGLES, SCENE_ENTRY };

interface BuildOptions {
  onlyPlate?: number;
  thumbnail?: Buffer;
  validateBounds?: boolean;
  embedScene?: boolean;
  /** Cancels the build (the worker is terminated). */
  signal?: AbortSignal;
  abortError?: BuildRunOptions['abortError'];
  timeoutMs?: number;
}
type BuildOutput = { size: number; objects: number; plates: number; triangles: number; config: BuildProjectInput['config'] };

export interface ProjectBody {
  name: string;
  scene: SceneDoc;
  thumbnailPng?: string;
}

export { MAX_MESH_SOURCE_BYTES };

/** Scene JSON embedded in an uploaded 3MF. */
const MAX_SCENE_JSON_BYTES = 1024 * 1024;
/** Project builds (POST/PUT /api/projects) per user per window, and builds waiting for the build slot. */
const USER_BUILDS_PER_WINDOW = 20;
const USER_BUILD_WINDOW_MS = 10 * 60_000;
const MAX_WAITING_BUILDS = 8;

/**
 * Library name of a project: cleaned like every other file name (no path separators, control characters or
 * `<>:"|?*`, which uploads and renames already refuse), with a `.3mf` extension.
 */
function projectFileName(raw: string): string {
  const name = cleanName(raw);
  if (!name) throw badRequest('files.invalid_name', 'Invalid file name');
  return /\.3mf$/i.test(name) ? name : `${name}.3mf`;
}

const busy = () => new AppError(429, 'projects.busy', 'Another project is being built; try again in a moment');

export class ProjectsService {
  /** Builds run one at a time (also the slicing path), so parallel requests cannot multiply CPU/disk use. */
  private chain: Promise<void> = Promise.resolve();
  private waiting = 0;
  private readonly activeByUser = new Map<number, number>();
  private readonly recentByUser = new Map<number, number[]>();
  /** Mesh loading + 3MF writing run in this worker (size 1, matching the build gate). */
  readonly pool = new BuildPool();

  constructor(
    private readonly files: FilesService,
    private readonly profiles: ProfilesService,
    private readonly engineVersion: () => string,
  ) {}

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((r) => (release = r));
    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
  }

  /** Per-user gate for project saves: one at a time per user, a rate limit, and a cap on waiting builds. */
  private async userBuild<T>(userId: number, fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const recent = (this.recentByUser.get(userId) ?? []).filter((t) => now - t < USER_BUILD_WINDOW_MS);
    if (recent.length >= USER_BUILDS_PER_WINDOW) {
      const retryAfter = Math.ceil((recent[0]! + USER_BUILD_WINDOW_MS - now) / 1000);
      throw new AppError(429, 'projects.rate_limited', 'Too many project saves; wait a few minutes', { retryAfter });
    }
    if ((this.activeByUser.get(userId) ?? 0) >= 1 || this.waiting >= MAX_WAITING_BUILDS) throw busy();
    recent.push(now);
    this.recentByUser.set(userId, recent);
    this.activeByUser.set(userId, (this.activeByUser.get(userId) ?? 0) + 1);
    this.waiting++;
    try {
      return await this.exclusive(fn);
    } finally {
      this.waiting--;
      const n = (this.activeByUser.get(userId) ?? 1) - 1;
      if (n <= 0) this.activeByUser.delete(userId);
      else this.activeByUser.set(userId, n);
    }
  }

  /** Loads the mesh of a library model the viewer may read. */
  async meshForFile(viewer: Viewer, fileId: number): Promise<{ mesh: Mesh; name: string }> {
    let row: FileRow;
    try {
      row = this.files.getReadable(viewer, fileId);
    } catch {
      throw new AppError(400, 'projects.missing_model', `Model file #${fileId} is not available`, { fileId });
    }
    if (row.kind !== 'model') throw new AppError(400, 'projects.not_a_model', `File #${fileId} is not a model`, { fileId });
    try {
      return { mesh: await loadMesh(this.files.absolutePath(row), row.ext), name: row.name.replace(/\.[^.]+$/, '') };
    } catch (err) {
      if (err instanceof MeshFormatError) throw new AppError(400, 'projects.invalid_model', `${row.name}: ${err.message}`, { fileId });
      throw err;
    }
  }

  /** Builds a 3MF for the scene into `dest` (all plates, or one plate at plate-0 coordinates for slicing). */
  build(viewer: Viewer, scene: SceneDoc, dest: string, opts: BuildOptions = {}): Promise<BuildOutput> {
    return this.exclusive(() => this.buildNow(viewer, scene, dest, opts));
  }

  /**
   * Main thread: resolves the config and authorises every model (same error codes as before), then hands the CPU-heavy
   * part (mesh parsing with all limits, placement, triangle cap, 3MF write) to the build worker.
   */
  private async buildNow(viewer: Viewer, scene: SceneDoc, dest: string, opts: BuildOptions): Promise<BuildOutput> {
    const config = buildProjectConfig(this.profiles, scene, viewer);
    const sources: Record<number, BuildSource> = {};
    for (const o of scene.objects) {
      if (opts.onlyPlate !== undefined && o.plate !== opts.onlyPlate) continue;
      if (sources[o.fileId]) continue;
      let row: FileRow;
      try {
        row = this.files.getReadable(viewer, o.fileId);
      } catch {
        throw new AppError(400, 'projects.missing_model', `Model file #${o.fileId} is not available`, { fileId: o.fileId });
      }
      if (row.kind !== 'model') throw new AppError(400, 'projects.not_a_model', `File #${o.fileId} is not a model`, { fileId: o.fileId });
      sources[o.fileId] = { path: this.files.absolutePath(row), ext: row.ext, name: row.name.replace(/\.[^.]+$/, ''), fileName: row.name };
    }
    const out = await this.pool.run(
      {
        scene,
        config,
        dest,
        sources,
        appVersion: this.engineVersion(),
        ...(opts.onlyPlate !== undefined && { onlyPlate: opts.onlyPlate }),
        ...(opts.validateBounds !== undefined && { validateBounds: opts.validateBounds }),
        ...(opts.embedScene !== undefined && { embedScene: opts.embedScene }),
        ...(opts.thumbnail && { thumbnail: new Uint8Array(opts.thumbnail) }),
      },
      {
        ...(opts.signal && { signal: opts.signal }),
        ...(opts.abortError && { abortError: opts.abortError }),
        ...(opts.timeoutMs !== undefined && { timeoutMs: opts.timeoutMs }),
      },
    );
    return { ...out, config };
  }

  private decodeThumb(b64: string | undefined): Buffer | undefined {
    if (!b64) return undefined;
    const png = Buffer.from(b64.replace(/^data:image\/png;base64,/, ''), 'base64');
    if (!pngSize(png) || png.length > 512 * 1024) throw badRequest('files.invalid_thumbnail', 'thumbnailPng must be a PNG ≤ 512 KB');
    return png;
  }

  async create(owner: { id: number; username: string; role: Viewer['role'] }, body: ProjectBody, actor: AuditActor): Promise<LibraryFile> {
    const thumb = this.decodeThumb(body.thumbnailPng);
    const name = projectFileName(body.name);
    const tmp = await this.files.tempPath('3mf');
    try {
      const built = await this.userBuild(owner.id, () => this.buildNow(owner, body.scene, tmp, { ...(thumb && { thumbnail: thumb }) }));
      const { sha256, size } = await hashFile(tmp);
      const file = await this.files.addFile(
        owner,
        {
          tmpPath: tmp,
          name,
          kind: 'project',
          ext: '3mf',
          visibility: 'private',
          size,
          sha256,
          meta: { project: { plates: built.plates, objects: built.objects } },
          thumbnail: thumb ?? null,
        },
        actor,
      );
      const row = this.files.getRow(file.id)!;
      await writeFile(`${this.files.absolutePath(row)}.scene.json`, JSON.stringify(body.scene));
      this.files.setProjectRefs(file.id, body.scene.objects.map((o) => o.fileId));
      return file;
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async update(viewer: Viewer, id: number, body: ProjectBody, actor: AuditActor): Promise<LibraryFile> {
    const row = this.files.getWritable(viewer, id);
    if (row.kind !== 'project') throw badRequest('projects.not_a_project', 'This file is not a project');
    const thumb = this.decodeThumb(body.thumbnailPng);
    const name = projectFileName(body.name);
    const tmp = await this.files.tempPath('3mf');
    try {
      // Meshes are resolved with the owner's rights, so an admin editing keeps the owner's models.
      const built = await this.userBuild(viewer.id, () =>
        this.buildNow({ id: row.owner_id, role: viewer.role }, body.scene, tmp, { ...(thumb && { thumbnail: thumb }) }),
      );
      const { sha256, size } = await hashFile(tmp);
      await this.files.replaceContent(row, tmp, size, sha256, { project: { plates: built.plates, objects: built.objects } });
      await writeFile(`${this.files.absolutePath(row)}.scene.json`, JSON.stringify(body.scene));
      this.files.setProjectRefs(id, body.scene.objects.map((o) => o.fileId));
      if (name !== row.name) this.files.patch(viewer, id, { name }, actor);
      if (thumb) await this.files.writeThumbnail(id, thumb);
      return this.files.get(id);
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /** The scene sidecar, or the copy embedded in the 3MF. */
  async get(viewer: Viewer, id: number): Promise<{ file: LibraryFile; scene: SceneDoc }> {
    const row = this.files.getReadable(viewer, id);
    if (row.ext !== '3mf') throw notFound();
    const abs = this.files.absolutePath(row);
    let raw: string | null = null;
    try {
      raw = await readFile(`${abs}.scene.json`, 'utf8');
    } catch {
      try {
        const zip = await readZipEntries(abs, (n) => n === SCENE_ENTRY, { maxEntryBytes: MAX_SCENE_JSON_BYTES, maxTotalBytes: MAX_SCENE_JSON_BYTES });
        const entry = zip.get(SCENE_ENTRY);
        if (entry) raw = new TextDecoder().decode(entry);
      } catch {
        /* not a zip we can read */
      }
    }
    if (raw === null) throw new AppError(404, 'projects.no_scene', 'This 3MF was not saved by SliceDock');
    let scene: SceneDoc;
    try {
      scene = sceneSchema.parse(JSON.parse(raw)) as SceneDoc;
    } catch {
      throw new AppError(422, 'projects.invalid_scene', 'The saved scene could not be read');
    }
    return { file: this.files.toLibraryFile(row), scene };
  }
}
