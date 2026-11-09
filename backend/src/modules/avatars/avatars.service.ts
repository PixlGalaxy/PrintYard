import { createHash } from 'node:crypto';
import { mkdirSync, promises as fs, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../../db/client.js';
import { AppError, badRequest, notFound } from '../../errors.js';

/** Upload limit for the original image (the stored avatar is a few KB). */
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
/** Stored avatars are square WebP images of this size. */
export const AVATAR_SIZE = 256;
/** Decompression-bomb guard: refuse inputs above this many pixels (e.g. 8000×5000). */
const MAX_INPUT_PIXELS = 40_000_000;
/** Uploads per user per window (each one decodes an image). */
export const AVATAR_RATE = { max: 10, windowMs: 10 * 60_000 };

export type AvatarFormat = 'png' | 'jpeg' | 'webp' | 'gif';

/** Identifies the image format from its magic bytes; never trusts the Content-Type or a file name. */
export function sniffImage(buf: Buffer): AvatarFormat | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

const invalidImage = () => badRequest('avatar.invalid_image', 'Upload a PNG, JPEG, WebP or GIF image');

type SharpModule = typeof import('sharp');
let sharpModule: Promise<SharpModule['default']> | null = null;
/** Loaded on first use so libvips never costs idle memory. */
function loadSharp(): Promise<SharpModule['default']> {
  sharpModule ??= import('sharp').then((m) => {
    const sharp = m.default;
    // Keep the footprint small: no libvips operation cache, one worker thread.
    sharp.cache(false);
    sharp.concurrency(1);
    return sharp;
  });
  return sharpModule;
}

/**
 * Decodes the upload (first frame only for animated GIF/WebP), applies the EXIF orientation, centre-crops and
 * resizes to 256×256 and re-encodes as WebP. Metadata (EXIF, ICC, XMP) is dropped, so nothing of the original file
 * is ever served back.
 */
export async function processAvatar(input: Buffer): Promise<Buffer> {
  if (input.length === 0) throw badRequest('avatar.no_file', 'No image received');
  if (input.length > MAX_AVATAR_BYTES) throw tooLarge();
  const format = sniffImage(input);
  if (!format) throw invalidImage();
  const sharp = await loadSharp();
  try {
    const image = sharp(input, { animated: false, pages: 1, limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' });
    const meta = await image.metadata();
    // The decoder must agree with the magic bytes (no polyglots, no SVG/TIFF/HEIF sneaking through).
    if (meta.format !== format) throw invalidImage();
    return await image
      .rotate()
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'centre' })
      .webp({ quality: 85, effort: 4 })
      .toBuffer();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw invalidImage();
  }
}

export const tooLarge = () =>
  new AppError(413, 'avatar.too_large', 'Profile pictures are limited to 5 MB', { maxMb: MAX_AVATAR_BYTES / 1024 / 1024 });

/** Files live in `<appdata>/avatars/<userId>.webp`; `users.avatar_path` holds the file name. */
export class AvatarsService {
  private readonly hits = new Map<number, number[]>();

  constructor(
    private readonly db: Db,
    readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private fileName(userId: number): string {
    return `${userId}.webp`;
  }

  absolutePath(userId: number): string {
    return join(this.dir, this.fileName(userId));
  }

  /** 429 after AVATAR_RATE.max uploads in the window. */
  checkRate(userId: number): void {
    const now = this.now();
    const recent = (this.hits.get(userId) ?? []).filter((t) => now - t < AVATAR_RATE.windowMs);
    if (recent.length >= AVATAR_RATE.max) {
      const retry = Math.max(1, Math.ceil((AVATAR_RATE.windowMs - (now - recent[0]!)) / 1000));
      throw new AppError(429, 'avatar.rate_limited', 'Too many uploads, try again later', { retryAfter: retry }, { 'Retry-After': String(retry) });
    }
    recent.push(now);
    this.hits.set(userId, recent);
  }

  /** The stored file + an ETag (content hash), or 404. */
  async read(userId: number): Promise<{ data: Buffer; etag: string }> {
    const row = this.db.prepare('SELECT avatar_path FROM users WHERE id = ?').get(userId) as { avatar_path: string | null } | undefined;
    if (!row?.avatar_path) throw notFound();
    let data: Buffer;
    try {
      data = await fs.readFile(this.absolutePath(userId));
    } catch {
      throw notFound();
    }
    return { data, etag: `"${createHash('sha256').update(data).digest('base64url').slice(0, 27)}"` };
  }

  /** Writes atomically (temp + rename), then points the user at it. */
  async save(userId: number, webp: Buffer): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const target = this.absolutePath(userId);
    const temp = `${target}.${process.pid}.${this.now()}.part`;
    try {
      await fs.writeFile(temp, webp, { mode: 0o640 });
      await fs.rename(temp, target);
    } catch (err) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw err;
    }
    const r = this.db.prepare('UPDATE users SET avatar_path = ?, updated_at = ? WHERE id = ?').run(this.fileName(userId), this.now(), userId);
    if (r.changes === 0) {
      rmSync(target, { force: true });
      throw notFound();
    }
  }

  /** Clears the avatar; returns false when there was none. */
  remove(userId: number): boolean {
    const row = this.db.prepare('SELECT avatar_path FROM users WHERE id = ?').get(userId) as { avatar_path: string | null } | undefined;
    if (!row) throw notFound();
    this.deleteFile(userId);
    if (!row.avatar_path) return false;
    this.db.prepare('UPDATE users SET avatar_path = NULL, updated_at = ? WHERE id = ?').run(this.now(), userId);
    return true;
  }

  /** File only (user deletion: the row is gone already). */
  deleteFile(userId: number): void {
    rmSync(this.absolutePath(userId), { force: true });
  }

  /** `{ userId: avatarUrl }` for every user with a picture (prints/audit lists only carry ids + usernames). */
  directory(): Record<string, string> {
    const rows = this.db.prepare('SELECT id, updated_at FROM users WHERE avatar_path IS NOT NULL').all() as { id: number; updated_at: number }[];
    return Object.fromEntries(rows.map((r) => [String(r.id), avatarUrlFor(r.id, r.updated_at)]));
  }
}

/** Versioned so a new picture is never hidden by the 24 h browser cache. */
export const avatarUrlFor = (userId: number, updatedAt: number) => `/api/avatars/${userId}?v=${updatedAt}`;
