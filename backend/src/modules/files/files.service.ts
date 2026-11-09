import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Db } from '../../db/client.js';
import type { SettingsService } from '../../db/settings.js';
import { AppError, badRequest, forbidden, notFound } from '../../errors.js';
import { CONTROL_CHARS } from '../../lib/sanitize.js';
import { logger } from '../../logger.js';
import type { FileKind, FileMeta, LibraryFile, Role, Visibility } from '../../types.js';
import type { AuditActor, AuditService } from '../audit/audit.service.js';
import { computeGcodeSummary, extractGcodeThumbnail } from './gcode.js';
import { MeshFormatError, objStats, stlStats } from './mesh.js';

export const ALLOWED_EXTS = ['stl', '3mf', 'obj', 'gcode'] as const;
export type AllowedExt = (typeof ALLOWED_EXTS)[number];

const KIND_DIR: Record<FileKind, string> = { model: 'models', project: 'projects', gcode: 'gcode' };

export const MAX_THUMBNAIL_BYTES = 512 * 1024;

export interface FileRow {
  id: number;
  owner_id: number;
  owner_name: string;
  kind: FileKind;
  visibility: Visibility;
  name: string;
  ext: string;
  stored_path: string;
  size: number;
  sha256: string | null;
  pinned: number;
  meta: string;
  has_thumbnail: number;
  created_at: number;
  updated_at: number;
}

export interface Viewer {
  id: number;
  role: Role;
}

const SELECT = `SELECT f.*, u.username AS owner_name FROM files f JOIN users u ON u.id = f.owner_id`;

/** Display name from a client-supplied filename: last path segment, no control chars, at most 200 chars. */
export function cleanName(raw: string): string {
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  const name = base.replace(CONTROL_CHARS, '').replace(/[<>:"|?*]/g, '_').trim().slice(0, 200);
  return name;
}

export function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1]!.toLowerCase() : '';
}

/** ASCII slug for stored names (the original name stays in the DB). */
export function slugify(name: string): string {
  const stem = name.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  const slug = stem
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'file';
}

/** `name` if free, else "stem (tag).ext", "stem (tag 2).ext", … */
export function uniqueName(name: string, tag: string, isTaken: (n: string) => boolean): string {
  if (!isTaken(name)) return name;
  const m = /^(.*?)(\.[A-Za-z0-9]{1,8})?$/.exec(name)!;
  const stem = m[1] || 'file';
  const ext = m[2] ?? '';
  for (let i = 1; ; i++) {
    const candidate = `${stem} (${tag}${i > 1 ? ` ${i}` : ''})${ext}`;
    if (!isTaken(candidate)) return candidate;
  }
}

/** Light content check: the bytes must look like the extension claims. */
export async function sniffFormat(path: string, ext: string): Promise<boolean> {
  const fh = await open(path, 'r');
  let head: Buffer;
  try {
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    head = buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
  if (head.length === 0) return false;
  switch (ext) {
    case '3mf':
      return head.length >= 4 && head.readUInt32LE(0) === 0x04034b50; // "PK\3\4"
    case 'stl': {
      const { size } = await stat(path);
      if (head.length >= 84 && 84 + 50 * head.readUInt32LE(80) === size) return true; // binary
      return /^\s*solid\b/i.test(head.toString('latin1')) && !head.includes(0);
    }
    case 'obj':
    case 'gcode':
      return !head.includes(0);
    default:
      return false;
  }
}

export class FilesService {
  private readonly thumbsDir: string;
  private readonly tmpDir: string;

  constructor(
    private readonly db: Db,
    private readonly dataRoot: string,
    appdataRoot: string,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {
    this.thumbsDir = join(appdataRoot, 'thumbnails');
    this.tmpDir = join(dataRoot, '.tmp');
  }

  /** A fresh temp path for an incoming upload (same volume as the library, so the final move is a rename). */
  async tempPath(ext: string): Promise<string> {
    await mkdir(this.tmpDir, { recursive: true });
    return join(this.tmpDir, `${randomBytes(12).toString('hex')}.${ext}.part`);
  }

  maxUploadBytes(): number {
    return this.settings.get('files.maxUploadMb') * 1024 * 1024;
  }

  // ---- storage quota (settings files.quotaMb; admins unlimited) ----

  /** Bytes of every file the user owns (private, shared and pinned alike). */
  storageUsed(ownerId: number): number {
    const r = this.db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE owner_id = ?').get(ownerId) as { n: number };
    return r.n;
  }

  /** Quota in bytes, or null when unlimited (admins, or `files.quotaMb` = 0). */
  storageQuota(ownerId: number): number | null {
    const role = (this.db.prepare('SELECT role FROM users WHERE id = ?').get(ownerId) as { role: Role } | undefined)?.role;
    if (role === 'admin') return null;
    const mb = this.settings.get('files.quotaMb');
    return mb > 0 ? mb * 1024 * 1024 : null;
  }

  /** Bytes the user may still add (Infinity when unlimited). */
  storageRemaining(ownerId: number): number {
    const quota = this.storageQuota(ownerId);
    return quota === null ? Infinity : Math.max(0, quota - this.storageUsed(ownerId));
  }

  assertQuota(ownerId: number, addBytes: number): void {
    const quota = this.storageQuota(ownerId);
    if (quota === null) return;
    const used = this.storageUsed(ownerId);
    if (used + addBytes > quota) throw quotaExceeded(quota, used);
  }

  /** Resolves a stored relative path inside DATA_ROOT, refusing anything that escapes it. */
  absolutePath(row: Pick<FileRow, 'stored_path'>): string {
    const root = resolve(this.dataRoot);
    const abs = resolve(root, row.stored_path);
    if (!abs.startsWith(root + sep)) throw new AppError(500, 'common.internal', 'Invalid stored path');
    return abs;
  }

  thumbnailPath(id: number): string {
    return join(this.thumbsDir, `${id}.png`);
  }

  // ---- reads ----

  getRow(id: number): FileRow | undefined {
    return this.db.prepare(`${SELECT} WHERE f.id = ?`).get(id) as FileRow | undefined;
  }

  /** Readable: owner, any shared file, or an admin. Others get 404 (no existence leak). */
  getReadable(viewer: Viewer, id: number): FileRow {
    const row = this.getRow(id);
    if (!row) throw notFound();
    if (row.owner_id !== viewer.id && row.visibility !== 'shared' && viewer.role !== 'admin') throw notFound();
    return row;
  }

  /** Writable: owner or admin. A readable-but-foreign shared file → 403. */
  getWritable(viewer: Viewer, id: number): FileRow {
    const row = this.getReadable(viewer, id);
    if (row.owner_id !== viewer.id && viewer.role !== 'admin') throw forbidden('files.forbidden', 'Only the owner can change this file');
    return row;
  }

  list(viewer: Viewer, scope: 'private' | 'shared' | 'all', kind?: FileKind): LibraryFile[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (scope === 'private') {
      where.push('f.owner_id = ?');
      args.push(viewer.id);
    } else if (scope === 'shared') {
      where.push("f.visibility = 'shared'");
    } else if (viewer.role !== 'admin') {
      throw forbidden();
    }
    if (kind) {
      where.push('f.kind = ?');
      args.push(kind);
    }
    const sql = `${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY f.created_at DESC, f.id DESC LIMIT 5000`;
    return (this.db.prepare(sql).all(...args) as FileRow[]).map((r) => this.toLibraryFile(r));
  }

  toLibraryFile(row: FileRow): LibraryFile {
    let meta: FileMeta = {};
    try {
      meta = JSON.parse(row.meta) as FileMeta;
    } catch {
      /* keep empty */
    }
    return {
      id: row.id,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      kind: row.kind,
      visibility: row.visibility,
      name: row.name,
      ext: row.ext,
      size: row.size,
      pinned: row.pinned === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      thumbnailUrl: row.has_thumbnail ? `/api/files/${row.id}/thumbnail?v=${row.updated_at}` : null,
      meta,
    };
  }

  get(id: number): LibraryFile {
    const row = this.getRow(id);
    if (!row) throw notFound();
    return this.toLibraryFile(row);
  }

  // ---- writes ----

  /**
   * Inspects an uploaded temp file (format sniff, mesh stats / G-code summary) and adds it to the library.
   * The temp file is moved (or removed on failure).
   */
  async addUpload(
    owner: { id: number; username: string },
    input: { tmpPath: string; name: string; visibility: Visibility; sha256: string; size: number },
    actor: AuditActor,
  ): Promise<LibraryFile> {
    const ext = extOf(input.name);
    try {
      if (!(ALLOWED_EXTS as readonly string[]).includes(ext)) throw badRequest('files.unsupported_type', 'Only .stl, .3mf, .obj and .gcode files are allowed');
      if (input.size === 0 || !(await sniffFormat(input.tmpPath, ext))) {
        throw badRequest('files.invalid_format', `The file is not a valid .${ext} file`);
      }
      const meta: FileMeta = {};
      let thumbnail: Buffer | null = null;
      let kind: FileKind = 'model';
      try {
        if (ext === 'stl') Object.assign(meta, await stlStats(input.tmpPath));
        else if (ext === 'obj') Object.assign(meta, await objStats(input.tmpPath));
        else if (ext === 'gcode') {
          kind = 'gcode';
          // Uploaded G-code: usage is computed from the moves; comments are only kept as `declared`.
          meta.gcode = await computeGcodeSummary(input.tmpPath);
          thumbnail = await extractGcodeThumbnail(input.tmpPath);
        }
      } catch (err) {
        if (err instanceof MeshFormatError) throw badRequest('files.invalid_format', err.message);
        throw err;
      }
      return await this.addFile(owner, { ...input, kind, ext, meta, thumbnail }, actor);
    } finally {
      await rm(input.tmpPath, { force: true });
    }
  }

  /**
   * Moves `tmpPath` into the owner's library as `<id>-<slug>.<ext>`, inserts the row, stores an optional thumbnail
   * and applies retention. Used by uploads, projects and slicing results.
   */
  async addFile(
    owner: { id: number; username: string },
    input: {
      tmpPath: string;
      name: string;
      kind: FileKind;
      ext: string;
      visibility: Visibility;
      size: number;
      sha256: string | null;
      meta: FileMeta;
      thumbnail?: Buffer | null;
    },
    actor: AuditActor,
  ): Promise<LibraryFile> {
    this.assertQuota(owner.id, input.size);
    const now = Date.now();
    const placeholder = `.pending/${randomBytes(12).toString('hex')}`;
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO files (owner_id, kind, visibility, name, ext, stored_path, size, sha256, pinned, meta, has_thumbnail, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?)`,
        )
        .run(owner.id, input.kind, input.visibility, input.name, input.ext, placeholder, input.size, input.sha256, JSON.stringify(input.meta), now, now)
        .lastInsertRowid,
    );
    const rel = ['users', String(owner.id), KIND_DIR[input.kind], `${id}-${slugify(input.name)}.${input.ext}`].join('/');
    const abs = this.absolutePath({ stored_path: rel });
    try {
      await mkdir(dirname(abs), { recursive: true });
      await rename(input.tmpPath, abs);
      this.db.prepare('UPDATE files SET stored_path = ? WHERE id = ?').run(rel, id);
    } catch (err) {
      this.db.prepare('DELETE FROM files WHERE id = ?').run(id);
      throw err;
    }
    if (input.thumbnail) await this.writeThumbnail(id, input.thumbnail);
    this.audit.log('file.create', actor, input.name, { id, kind: input.kind, size: input.size });
    logger.info(`File #${id} "${input.name}" (${input.kind}, ${input.size} B) added for "${owner.username}"`);
    if (input.visibility === 'private') await this.applyRetention(owner.id, actor, id);
    return this.get(id);
  }

  /** Overwrites a file's content in place (projects PUT). */
  async replaceContent(row: FileRow, tmpPath: string, size: number, sha256: string | null, meta: FileMeta): Promise<void> {
    if (row.kind === 'gcode') throw new AppError(500, 'common.internal', 'G-code files are immutable');
    if (size > row.size) this.assertQuota(row.owner_id, size - row.size);
    await rename(tmpPath, this.absolutePath(row));
    this.db
      .prepare('UPDATE files SET size = ?, sha256 = ?, meta = ?, updated_at = ? WHERE id = ?')
      .run(size, sha256, JSON.stringify(meta), Math.max(Date.now(), row.updated_at + 1), row.id);
  }

  patch(viewer: Viewer, id: number, patch: { name?: string; visibility?: Visibility; pinned?: boolean }, actor: AuditActor): LibraryFile {
    const row = this.getWritable(viewer, id);
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.name !== undefined) {
      let name = cleanName(patch.name);
      if (!name) throw badRequest('files.invalid_name', 'Invalid file name');
      // Keep the real extension so downloads stay openable.
      if (extOf(name) !== row.ext) name = `${name}.${row.ext}`;
      sets.push('name = ?');
      args.push(name);
    }
    if (patch.visibility !== undefined) {
      sets.push('visibility = ?');
      args.push(patch.visibility);
    }
    if (patch.pinned !== undefined) {
      sets.push('pinned = ?');
      args.push(patch.pinned ? 1 : 0);
    }
    if (sets.length > 0) {
      sets.push('updated_at = ?');
      args.push(Math.max(Date.now(), row.updated_at + 1));
      this.db.prepare(`UPDATE files SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
      this.audit.log('file.update', actor, row.name, { id, ...patch });
    }
    return this.get(id);
  }

  /** True while a print request that is pending, approved or printing references the file. */
  inUse(id: number): boolean {
    const hasPrints = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'prints'").get();
    if (!hasPrints) return false;
    return !!this.db.prepare("SELECT 1 FROM prints WHERE file_id = ? AND state IN ('pending', 'approved', 'printing') LIMIT 1").get(id);
  }

  async delete(viewer: Viewer, id: number, actor: AuditActor): Promise<void> {
    const row = this.getWritable(viewer, id);
    // A pending/approved/running print must keep the exact file it was requested with (review finding #2).
    if (this.inUse(id)) throw new AppError(409, 'files.in_use', 'This file is used by a print request that is pending, approved or printing');
    await this.removeRow(row);
    this.audit.log('file.delete', actor, row.name, { id, ownerId: row.owner_id });
  }

  private async removeRow(row: FileRow): Promise<void> {
    this.db.prepare('DELETE FROM files WHERE id = ?').run(row.id);
    const abs = this.absolutePath(row);
    await rm(abs, { force: true });
    await rm(`${abs}.scene.json`, { force: true });
    await rm(this.thumbnailPath(row.id), { force: true });
  }

  // ---- user deletion ----

  private ownerRows(ownerId: number): FileRow[] {
    return this.db.prepare(`${SELECT} WHERE f.owner_id = ? ORDER BY f.id`).all(ownerId) as FileRow[];
  }

  /** Deletes every file of a user (disk + rows) and their library folder. Returns the number of files removed. */
  async deleteAllOf(ownerId: number): Promise<number> {
    const rows = this.ownerRows(ownerId);
    for (const row of rows) await this.removeRow(row);
    await rm(this.absolutePath({ stored_path: `users/${ownerId}` }), { recursive: true, force: true });
    return rows.length;
  }

  /**
   * Gives every file of `fromId` to `to`: moves them into `users/<to>/…` (stored names keep their unique id prefix)
   * and renames display names that clash with one of the new owner's files ("cube (alice).stl", "cube (alice 2).stl").
   * Transferred files are pinned so the new owner's retention does not delete them on the next upload.
   */
  async transferAllOf(fromId: number, fromName: string, to: { id: number }): Promise<number> {
    const rows = this.ownerRows(fromId);
    const taken = new Set(
      (this.db.prepare('SELECT kind, name FROM files WHERE owner_id = ?').all(to.id) as { kind: string; name: string }[]).map(
        (r) => `${r.kind}|${r.name.toLowerCase()}`,
      ),
    );
    const update = this.db.prepare('UPDATE files SET owner_id = ?, stored_path = ?, name = ?, pinned = 1, updated_at = ? WHERE id = ?');
    for (const row of rows) {
      const file = row.stored_path.split('/').pop()!;
      const rel = ['users', String(to.id), KIND_DIR[row.kind], file].join('/');
      const from = this.absolutePath(row);
      const dest = this.absolutePath({ stored_path: rel });
      await mkdir(dirname(dest), { recursive: true });
      try {
        await rename(from, dest);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        logger.warn(`File #${row.id} is missing on disk; transferring the record only`);
      }
      await rename(`${from}.scene.json`, `${dest}.scene.json`).catch(() => undefined);
      const name = uniqueName(row.name, fromName, (n) => taken.has(`${row.kind}|${n.toLowerCase()}`));
      taken.add(`${row.kind}|${name.toLowerCase()}`);
      update.run(to.id, rel, name, Math.max(Date.now(), row.updated_at + 1), row.id);
    }
    await rm(this.absolutePath({ stored_path: `users/${fromId}` }), { recursive: true, force: true });
    return rows.length;
  }

  /** Records which models a project uses (retention keeps them). */
  setProjectRefs(projectId: number, fileIds: number[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM file_refs WHERE project_id = ?').run(projectId);
      const ins = this.db.prepare('INSERT OR IGNORE INTO file_refs (project_id, file_id) VALUES (?, ?)');
      for (const f of new Set(fileIds)) ins.run(projectId, f);
    })();
  }

  async writeThumbnail(id: number, png: Buffer): Promise<void> {
    await mkdir(this.thumbsDir, { recursive: true });
    const dest = this.thumbnailPath(id);
    const tmp = `${dest}.${randomBytes(4).toString('hex')}.part`;
    await writeFile(tmp, png);
    await rename(tmp, dest);
    const row = this.getRow(id);
    this.db
      .prepare('UPDATE files SET has_thumbnail = 1, updated_at = ? WHERE id = ?')
      .run(Math.max(Date.now(), (row?.updated_at ?? 0) + 1), id);
  }

  /**
   * Retention (contract §Decisions): per user, private library only; pinned and shared files are exempt, and so are
   * G-code files with a pending/approved/running print and models used by a saved project. Keeps the newest
   * `files.retention.keep` of the rest.
   */
  async applyRetention(ownerId: number, actor: AuditActor, justAdded?: number): Promise<number[]> {
    if (!this.settings.get('files.retention.enabled')) return [];
    const keep = this.settings.get('files.retention.keep');
    const hasPrints = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'prints'").get();
    const busy =
      (hasPrints ? "AND f.id NOT IN (SELECT file_id FROM prints WHERE state IN ('pending', 'approved', 'printing')) " : '') +
      'AND f.id NOT IN (SELECT file_id FROM file_refs)';
    const rows = this.db
      .prepare(
        `${SELECT} WHERE f.owner_id = ? AND f.visibility = 'private' AND f.pinned = 0 ${busy}
         ORDER BY f.created_at DESC, f.id DESC LIMIT -1 OFFSET ?`,
      )
      .all(ownerId, keep) as FileRow[];
    const removed: number[] = [];
    for (const row of rows) {
      if (row.id === justAdded) continue;
      try {
        await this.removeRow(row);
        removed.push(row.id);
      } catch (err) {
        logger.error(`Retention could not remove file #${row.id}`, err);
      }
    }
    if (removed.length > 0) {
      this.audit.log('file.retention', actor, String(ownerId), { removed, keep });
      logger.info(`Retention removed ${removed.length} file(s) of user #${ownerId} (keep ${keep})`);
    }
    return removed;
  }
}

export const quotaExceeded = (quota: number, used: number) =>
  new AppError(413, 'files.quota_exceeded', 'Your storage quota is full; delete some files first', {
    quotaBytes: quota,
    usedBytes: used,
  });

/** sha256 + size of a file on disk. */
export async function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: hash.digest('hex'), size };
}

