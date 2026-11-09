import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { SettingsService } from '../../db/settings.js';
import { AppError, conflict } from '../../errors.js';
import { logger } from '../../logger.js';
import type { EngineInstall, EngineRelease, EngineState, EngineStatus } from '../../types.js';
import type { AuditActor, AuditService } from '../audit/audit.service.js';
import { boxMesh } from '../files/mesh.js';
import { bundledProfileSource, engineProfileSource, ProfilesService, type ProfileSource } from '../profiles/profiles.service.js';
import { buildProjectConfig, prepareObjects } from '../projects/scene.js';
import { writeProject3mf } from '../projects/threemf.js';
import { cliHelpWorks, CrealityCliEngine } from './creality-cli.js';
import { shortVersion, type SlicerEngine } from './engine.types.js';
import { FakeEngine } from './fake-engine.js';

const RELEASES_API = 'https://api.github.com/repos/CrealityOfficial/CrealityPrint/releases/latest';

interface GithubAsset {
  name: string;
  size: number;
  browser_download_url: string;
  /** "sha256:<hex>" (GitHub API, newer releases) */
  digest?: string | null;
}

/** Release assets must come from the official repository's download path. */
export const ASSET_URL_PREFIX = 'https://github.com/CrealityOfficial/CrealityPrint/releases/download/';
/** Hosts GitHub redirects release downloads to. Every hop must be https and one of these (or the prefix above). */
const DOWNLOAD_HOSTS = new Set(['objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
/** Sanity cap on the AppImage (current releases are ~200 MB). */
export const MAX_ENGINE_BYTES = 1024 * 1024 * 1024;

export function isAllowedAssetUrl(url: string): boolean {
  return url.startsWith(ASSET_URL_PREFIX) && !url.slice(ASSET_URL_PREFIX.length).includes('..');
}

function isAllowedRedirect(url: URL): boolean {
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  return DOWNLOAD_HOSTS.has(url.hostname) || isAllowedAssetUrl(url.href);
}

/** "sha256:abc…" → "abc…" (lower case), else null. */
export function sha256FromDigest(digest: string | null | undefined): string | null {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(digest ?? '');
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Downloads an engine asset to `dest`: follows at most 5 redirects, each to an allowed https host only; the body
 * must be exactly `expected.size` bytes (≤ MAX_ENGINE_BYTES) and, when GitHub published a digest, hash to it.
 * Returns the sha256 of what was written. On any failure the partial file is removed.
 */
export async function downloadEngineAsset(
  fetchImpl: typeof fetch,
  assetUrl: string,
  dest: string,
  expected: { size: number; sha256: string | null },
  onProgress: (got: number, total: number) => void = () => undefined,
): Promise<{ sha256: string; size: number; digestVerified: boolean }> {
  if (!isAllowedAssetUrl(assetUrl)) throw new Error(`Refusing to download the engine from ${assetUrl}`);
  if (!Number.isSafeInteger(expected.size) || expected.size <= 0 || expected.size > MAX_ENGINE_BYTES) {
    throw new Error(`Unexpected engine asset size (${expected.size} bytes)`);
  }
  let url = new URL(assetUrl);
  let res: Response | null = null;
  for (let hop = 0; hop <= 5; hop++) {
    const r = await fetchImpl(url.href, { headers: { 'User-Agent': 'SliceDock-engine-manager' }, redirect: 'manual', signal: AbortSignal.timeout(30 * 60_000) });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      await r.body?.cancel().catch(() => undefined);
      if (!loc) throw new Error(`Download redirect without a location (HTTP ${r.status})`);
      const next = new URL(loc, url);
      if (!isAllowedRedirect(next)) throw new Error(`Refusing to follow a download redirect to ${next.host}`);
      url = next;
      continue;
    }
    res = r;
    break;
  }
  if (!res) throw new Error('Too many download redirects');
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  const declared = res.headers.get('content-length');
  if (declared !== null && Number(declared) !== expected.size) {
    await res.body.cancel().catch(() => undefined);
    throw new Error(`Download size mismatch (server says ${declared}, release says ${expected.size} bytes)`);
  }
  let got = 0;
  const hash = createHash('sha256');
  const meter = new Transform({
    transform: (chunk: Buffer, _e, cb) => {
      got += chunk.length;
      if (got > expected.size) return cb(new Error(`Download is larger than the release asset (${expected.size} bytes)`));
      hash.update(chunk);
      onProgress(got, expected.size);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), meter, createWriteStream(dest));
    if (got !== expected.size) throw new Error(`Download size mismatch (${got} of ${expected.size} bytes)`);
    const sha256 = hash.digest('hex');
    if (expected.sha256 && sha256 !== expected.sha256) throw new Error('Download checksum mismatch (sha256 differs from the GitHub release digest)');
    return { sha256, size: got, digestVerified: !!expected.sha256 };
  } catch (err) {
    await rm(dest, { force: true });
    throw err;
  }
}
interface GithubRelease {
  tag_name: string;
  published_at: string;
  prerelease?: boolean;
  draft?: boolean;
  assets: GithubAsset[];
}

/**
 * Picks the official x86_64 AppImage. Asset names vary between releases (`CrealityPrint-V7.3.1.6378-x86_64-Release.AppImage`,
 * `CrealityPrint_Ubuntu2404-…`), so: x86_64 + Release + .AppImage, never Beta/wayland; prefer the plain name, then the
 * highest build number.
 */
export function pickAppImage(assets: GithubAsset[]): (GithubAsset & { version: string | null }) | null {
  const candidates = assets
    .filter((a) => /x86_64.*Release.*\.AppImage$/i.test(a.name) && !/beta|wayland/i.test(a.name))
    .map((a) => {
      const v = /V?(\d+\.\d+\.\d+(?:\.\d+)?)/i.exec(a.name)?.[1] ?? null;
      const plain = /^CrealityPrint[-_]V?[\d.]+-x86_64-Release\.AppImage$/i.test(a.name);
      const build = v ? Number(v.split('.')[3] ?? 0) : 0;
      return { ...a, version: v, plain, build };
    })
    .sort((a, b) => Number(b.plain) - Number(a.plain) || b.build - a.build);
  const best = candidates[0];
  return best
    ? { name: best.name, size: best.size, browser_download_url: best.browser_download_url, digest: best.digest ?? null, version: best.version }
    : null;
}

/** Numeric compare of dotted versions ("7.3.1.6378" vs "7.3.0"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

interface PersistedInstall extends EngineInstall {
  sha256?: string;
  asset?: string;
  digestVerified?: boolean;
}

interface PersistedState {
  installed: PersistedInstall | null;
  previous: PersistedInstall | null;
  latest: EngineRelease | null;
  lastCheckAt: number | null;
}

export interface EngineManagerOptions {
  appdataRoot: string;
  settings: SettingsService;
  audit: AuditService;
  publish: (progress: { state: EngineState; progress: number; message?: string }) => void;
  /** Use the fake engine (no AppImage): `SLICEDOCK_FAKE_ENGINE=1`. */
  fake?: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * Engine install/update/rollback (contract §Engine manager). Layout under `<appdata>/engine/`:
 * `versions/<version>/squashfs-root/` (extracted AppImage), `.dl/` (downloads), `state.json` (installed/previous
 * pointers; written atomically, which replaces the `current` symlink and also works on Windows dev hosts),
 * `jobs/` (smoke tests).
 */
export class EngineManager {
  private readonly dir: string;
  private persisted: PersistedState;
  private state: EngineState = 'idle';
  private progress = 0;
  private error: string | undefined;
  private busy = false;
  private timer: NodeJS.Timeout | null = null;
  private lastPublish = 0;
  private readonly users = new Map<string, number>();
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: EngineManagerOptions) {
    this.dir = join(opts.appdataRoot, 'engine');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.persisted = this.readState();
  }

  get fake(): boolean {
    return !!this.opts.fake;
  }

  private readState(): PersistedState {
    const empty: PersistedState = { installed: null, previous: null, latest: null, lastCheckAt: null };
    try {
      const s = JSON.parse(readFileSync(join(this.dir, 'state.json'), 'utf8')) as PersistedState;
      // An install whose folder vanished is not installed.
      if (s.installed && !existsSync(s.installed.path)) s.installed = null;
      if (s.previous && !existsSync(s.previous.path)) s.previous = null;
      return { ...empty, ...s };
    } catch {
      return empty;
    }
  }

  private async writeState(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = join(this.dir, 'state.json');
    const tmp = `${file}.${process.pid}.part`;
    await writeFile(tmp, JSON.stringify(this.persisted, null, 2));
    await rename(tmp, file);
  }

  private setPhase(state: EngineState, progress: number, message?: string, force = false): void {
    this.state = state;
    this.progress = Math.round(progress);
    const now = Date.now();
    if (force || now - this.lastPublish > 400) {
      this.lastPublish = now;
      this.opts.publish({ state, progress: this.progress, ...(message && { message }) });
    }
  }

  private publicInstall(i: PersistedInstall | null): EngineInstall | null {
    return i ? { version: i.version, path: i.path, installedAt: i.installedAt, ...(i.sha256 && { sha256: i.sha256 }) } : null;
  }

  status(): EngineStatus {
    const installed = this.fake
      ? (this.persisted.installed ?? { version: '7.3.1.6378-fake', path: '(fake engine)', installedAt: 0 })
      : this.persisted.installed;
    return {
      selected: this.opts.settings.get('engine.selected'),
      installed: this.publicInstall(installed),
      previous: this.publicInstall(this.persisted.previous),
      latest: this.persisted.latest,
      lastCheckAt: this.persisted.lastCheckAt,
      state: this.state,
      progress: this.progress,
      ...(this.error && { error: this.error }),
    };
  }

  /** The engine to slice with, or null when none is installed. */
  current(): SlicerEngine | null {
    if (this.fake) return new FakeEngine(this.persisted.installed?.version ?? '7.3.1.6378-fake');
    const inst = this.persisted.installed;
    if (!inst) return null;
    return new CrealityCliEngine(inst.path, inst.version);
  }

  /** Marks an install root as in use while a job runs, so update cleanup never deletes it. */
  acquire(root: string | null): () => void {
    if (!root) return () => undefined;
    this.users.set(root, (this.users.get(root) ?? 0) + 1);
    return () => {
      const n = (this.users.get(root) ?? 1) - 1;
      if (n <= 0) this.users.delete(root);
      else this.users.set(root, n);
    };
  }

  /** Profiles of the installed engine, else the bundled snapshot. */
  profileSource(): ProfileSource {
    const inst = this.persisted.installed;
    if (inst && !this.fake) {
      const src = engineProfileSource(inst.path, shortVersion(inst.version));
      if (src) return src;
    }
    return bundledProfileSource();
  }

  /** Version stamped into generated 3MF files. */
  appVersion(): string {
    const inst = this.persisted.installed;
    return inst && !this.fake ? shortVersion(inst.version) : '7.3.1';
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'SliceDock-engine-manager' };
    if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    return h;
  }

  async check(actor?: AuditActor): Promise<EngineStatus> {
    let res: Response;
    try {
      res = await this.fetchImpl(RELEASES_API, { headers: this.headers(), signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw new AppError(502, 'engine.check_failed', `Could not reach GitHub: ${(err as Error).message}`);
    }
    if (!res.ok) throw new AppError(502, 'engine.check_failed', `GitHub answered ${res.status}`);
    const rel = (await res.json()) as GithubRelease;
    const asset = pickAppImage(rel.assets ?? []);
    if (asset && !isAllowedAssetUrl(asset.browser_download_url)) {
      throw new AppError(502, 'engine.untrusted_asset', 'The release asset is not hosted by the official CrealityPrint repository');
    }
    this.persisted.lastCheckAt = Date.now();
    this.persisted.latest = asset
      ? {
          version: asset.version ?? rel.tag_name.replace(/^v/i, ''),
          publishedAt: rel.published_at,
          assetUrl: asset.browser_download_url,
          size: asset.size,
          sha256: sha256FromDigest(asset.digest),
        }
      : null;
    await this.writeState();
    if (actor) this.opts.audit.log('engine.check', actor, this.persisted.latest?.version ?? null);
    logger.info(`Engine check: latest ${this.persisted.latest?.version ?? 'none (no x86_64 AppImage)'}`);
    return this.status();
  }

  updateAvailable(): boolean {
    const latest = this.persisted.latest;
    if (!latest) return false;
    const inst = this.persisted.installed;
    return !inst || compareVersions(latest.version, inst.version) > 0;
  }

  /** Starts an update in the background; progress goes to WS `engine.progress`. */
  startUpdate(actor: AuditActor): EngineStatus {
    if (this.busy) throw conflict('engine.busy', 'An engine operation is already running');
    if (!this.fake && (process.platform !== 'linux' || process.arch !== 'x64')) {
      throw new AppError(409, 'engine.unsupported_platform', 'The Creality Print engine only runs on Linux x86_64');
    }
    this.busy = true;
    this.error = undefined;
    this.setPhase('downloading', 0, 'Starting', true);
    void this.runUpdate(actor).finally(() => {
      this.busy = false;
    });
    return this.status();
  }

  private async runUpdate(actor: AuditActor): Promise<void> {
    try {
      if (!this.persisted.latest || Date.now() - (this.persisted.lastCheckAt ?? 0) > 10 * 60_000) await this.check();
      const latest = this.persisted.latest;
      if (!latest) throw new Error('No x86_64 AppImage in the latest release');
      const auto = actor.username === 'system';
      if (auto) logger.warn(`Engine auto-update: installing ${latest.version} (disable with setting engine.autoUpdate)`);
      const info = this.fake ? (await this.fakeInstall(latest), null) : await this.install(latest);
      this.opts.audit.log('engine.update', actor, latest.version, {
        auto,
        asset: latest.assetUrl,
        size: latest.size,
        sha256: info?.sha256 ?? null,
        digestVerified: info?.digestVerified ?? false,
      });
      this.setPhase('idle', 100, `Installed ${latest.version}`, true);
    } catch (err) {
      this.error = (err as Error).message;
      logger.error('Engine update failed', err);
      this.setPhase('error', this.progress, this.error, true);
      this.opts.audit.log('engine.update_failed', actor, this.persisted.latest?.version ?? null, { error: this.error });
    }
  }

  private async fakeInstall(latest: EngineRelease): Promise<void> {
    for (const [state, n] of [['downloading', 10], ['extracting', 4], ['testing', 3]] as const) {
      for (let i = 1; i <= n; i++) {
        this.setPhase(state, (i / n) * 100, state, true);
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    this.persisted.previous = this.persisted.installed;
    this.persisted.installed = { version: `${latest.version}-fake`, path: '(fake engine)', installedAt: Date.now() };
    await this.writeState();
  }

  private async install(latest: EngineRelease): Promise<{ sha256: string; digestVerified: boolean }> {
    const version = latest.version.replace(/[^0-9A-Za-z._-]/g, '');
    if (!version) throw new Error('Invalid version');
    const dlDir = join(this.dir, '.dl');
    const versionsDir = join(this.dir, 'versions');
    await mkdir(dlDir, { recursive: true });
    await mkdir(versionsDir, { recursive: true });
    const appImage = join(dlDir, `${version}.AppImage`);

    // 1) download: official repo only, redirects to GitHub's download hosts only, exact size, sha256 vs digest
    this.setPhase('downloading', 0, `Downloading ${version}`, true);
    const dl = await downloadEngineAsset(this.fetchImpl, latest.assetUrl, `${appImage}.part`, { size: latest.size, sha256: latest.sha256 ?? null }, (got, total) =>
      this.setPhase('downloading', (got / total) * 100, `Downloading ${version}`),
    );
    if (!dl.digestVerified) logger.warn(`Engine ${version}: GitHub published no sha256 digest; only the size was verified`);
    await rename(`${appImage}.part`, appImage);
    await chmod(appImage, 0o755);
    const sha256 = dl.sha256;

    // 2) extract (no FUSE needed)
    this.setPhase('extracting', 0, 'Extracting', true);
    const target = join(versionsDir, version);
    const staging = `${target}.staging`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(appImage, ['--appimage-extract'], { cwd: staging, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } });
      let n = 0;
      child.stdout.on('data', (d: Buffer) => {
        n += d.toString().split('\n').length;
        this.setPhase('extracting', Math.min(99, n / 30), 'Extracting');
      });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`--appimage-extract exited with ${code}`))));
    });
    const root = join(staging, 'squashfs-root');
    if (!existsSync(join(root, 'bin', 'CrealityPrint'))) throw new Error('The AppImage does not contain bin/CrealityPrint');

    // 3) smoke test: --help and a 20 mm cube with this engine's own K2 SE profiles
    this.setPhase('testing', 10, 'Testing the engine', true);
    const testDir = join(this.dir, 'jobs', `smoke-${Date.now()}`);
    try {
      if (!(await cliHelpWorks(root, testDir))) {
        throw new Error('The engine does not start (missing system libraries? see status/b1-notes.md for the apt packages)');
      }
      this.setPhase('testing', 40, 'Slicing a test cube', true);
      await smokeSlice(new CrealityCliEngine(root, version), testDir, engineProfileSource(root, shortVersion(version)) ?? bundledProfileSource(), shortVersion(version));
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }

    // 4) switch: staging → versions/<v>, previous ← installed
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    const install: PersistedInstall = { version, path: join(target, 'squashfs-root'), installedAt: Date.now(), sha256, asset: latest.assetUrl, digestVerified: dl.digestVerified };
    if (this.persisted.installed?.version !== version) this.persisted.previous = this.persisted.installed;
    this.persisted.installed = install;
    await this.writeState();
    await rm(appImage, { force: true });
    await this.cleanup();
    logger.info(`Engine ${version} installed (sha256 ${sha256})`);
    return { sha256, digestVerified: dl.digestVerified };
  }

  /** Removes versions other than installed/previous (and any in use). */
  private async cleanup(): Promise<void> {
    const versionsDir = join(this.dir, 'versions');
    const keep = new Set([this.persisted.installed?.path, this.persisted.previous?.path].filter(Boolean) as string[]);
    for (const name of await readdir(versionsDir).catch(() => [] as string[])) {
      const root = join(versionsDir, name, 'squashfs-root');
      if (keep.has(root) || this.users.has(root)) continue;
      await rm(join(versionsDir, name), { recursive: true, force: true });
    }
  }

  async rollback(actor: AuditActor): Promise<EngineStatus> {
    if (this.busy) throw conflict('engine.busy', 'An engine operation is already running');
    const prev = this.persisted.previous;
    if (!prev) throw conflict('engine.no_previous', 'There is no previous engine version to roll back to');
    this.persisted.previous = this.persisted.installed;
    this.persisted.installed = prev;
    await this.writeState();
    this.opts.audit.log('engine.rollback', actor, prev.version);
    logger.info(`Engine rolled back to ${prev.version}`);
    this.setPhase('idle', 100, `Rolled back to ${prev.version}`, true);
    return this.status();
  }

  /** Auto-update: checks when `engine.checkIntervalHours` elapsed and installs newer releases (or a first engine). */
  startScheduler(isIdle: () => boolean): void {
    if (this.timer) return;
    const tick = async () => {
      try {
        if (!this.opts.settings.get('engine.autoUpdate') || this.busy) return;
        if (!this.fake && (process.platform !== 'linux' || process.arch !== 'x64')) return;
        const interval = this.opts.settings.get('engine.checkIntervalHours') * 3_600_000;
        if (this.persisted.lastCheckAt && Date.now() - this.persisted.lastCheckAt < interval && this.persisted.installed) return;
        await this.check();
        if (this.updateAvailable() && isIdle() && !this.fake) this.startUpdate({ username: 'system' });
      } catch (err) {
        logger.warn(`Engine auto-update check failed: ${(err as Error).message}`);
      }
    };
    const first = setTimeout(() => void tick(), 30_000);
    first.unref();
    this.timer = setInterval(() => void tick(), 15 * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Builds and slices a 20 mm cube with the default K2 SE presets; throws when no G-code comes out. */
export async function smokeSlice(engine: SlicerEngine, jobDir: string, source: ProfileSource, appVersion: string): Promise<void> {
  const profiles = new ProfilesService(() => source);
  const b = profiles.bundle('creality-k2se');
  const pick = (l: { id: string; isDefault?: boolean }[]) => (l.find((x) => x.isDefault) ?? l[0])!.id;
  const scene = {
    version: 1 as const,
    printerModel: 'creality-k2se' as const,
    machinePresetId: pick(b.machine),
    processPresetId: pick(b.process),
    processOverrides: {},
    filaments: [{ slot: 1, presetId: pick(b.filament), color: '#FFFFFF' }],
    plates: [{ index: 0 }],
    objects: [{ id: 'cube', fileId: 1, name: 'cube', plate: 0, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 97.5, 0, 1], filamentSlot: 1, overrides: {} }],
  };
  const cfg = buildProjectConfig(profiles, scene);
  const { objects, plates } = await prepareObjects(scene, cfg, async () => ({ mesh: boxMesh(20, 20, 20), name: 'cube' }), { onlyPlate: 0 });
  await mkdir(jobDir, { recursive: true });
  const project = join(jobDir, 'cube.3mf');
  await writeProject3mf(project, { objects, plates, config: cfg, appVersion, bed: { width: 220, depth: 215 } });
  await engine.slice({
    jobDir,
    projectFile: project,
    outDir: join(jobDir, 'out'),
    timeoutMs: 5 * 60_000,
    maxRssBytes: 0,
    signal: new AbortController().signal,
    onProgress: () => undefined,
  });
}
