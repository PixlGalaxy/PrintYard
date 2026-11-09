import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../../db/client.js';
import type { UserRow } from '../users/users.service.js';

export const SESSION_COOKIE = 'sd_session';
const TOUCH_INTERVAL_MS = 60_000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface SessionPolicy {
  sessionHours: number;
  idleMinutes: number;
}

interface SessionJoinRow extends UserRow {
  s_id: string;
  s_created_at: number;
  s_last_seen_at: number;
  s_expires_at: number;
}

export interface ResolvedSession {
  id: string;
  user: UserRow;
  createdAt: number;
  expiresAt: number;
}

export interface SessionInfo {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

/** Opaque 32-byte tokens; only sha256(token) is stored, so a DB leak does not leak live sessions. */
export class SessionsService {
  constructor(
    private readonly db: Db,
    private readonly policy: () => SessionPolicy,
  ) {}

  create(userId: number, ip: string | null, userAgent: string | null): { token: string; id: string; expiresAt: number } {
    const token = randomBytes(32).toString('base64url');
    const id = hashToken(token);
    const now = Date.now();
    const expiresAt = now + this.policy().sessionHours * 3_600_000;
    this.db
      .prepare(
        'INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, userId, now, now, expiresAt, ip, userAgent?.slice(0, 512) ?? null);
    return { token, id, expiresAt };
  }

  /** Validates the cookie token: absolute expiry, idle timeout, active user. Throttles last_seen updates. */
  resolve(token: string | undefined, ip?: string | null, opts: { touch?: boolean } = {}): ResolvedSession | null {
    if (!token || token.length > 128) return null;
    const id = hashToken(token);
    const row = this.db
      .prepare(
        `SELECT u.*, s.id AS s_id, s.created_at AS s_created_at, s.last_seen_at AS s_last_seen_at, s.expires_at AS s_expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
      )
      .get(id) as SessionJoinRow | undefined;
    if (!row) return null;

    const now = Date.now();
    const { idleMinutes } = this.policy();
    const idleExpired = idleMinutes > 0 && now - row.s_last_seen_at > idleMinutes * 60_000;
    if (now >= row.s_expires_at || idleExpired || row.is_active !== 1) {
      this.revoke(id);
      return null;
    }
    if (opts.touch !== false && now - row.s_last_seen_at >= TOUCH_INTERVAL_MS) {
      this.db.prepare('UPDATE sessions SET last_seen_at = ?, ip = COALESCE(?, ip) WHERE id = ?').run(now, ip ?? null, id);
    }
    const { s_id, s_created_at, s_last_seen_at: _seen, s_expires_at, ...user } = row;
    return { id: s_id, user: user as UserRow, createdAt: s_created_at, expiresAt: s_expires_at };
  }

  revoke(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  revokeAllForUser(userId: number, exceptId?: string): number {
    const r = exceptId
      ? this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, exceptId)
      : this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    return r.changes;
  }

  /** The id handed to clients is a further hash of the stored id, so it cannot be replayed as a token or DB key. */
  publicId(id: string): string {
    return hashToken(`public:${id}`).slice(0, 32);
  }

  listForUser(userId: number, currentId: string): SessionInfo[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC')
      .all(userId, Date.now()) as {
      id: string;
      created_at: number;
      last_seen_at: number;
      expires_at: number;
      ip: string | null;
      user_agent: string | null;
    }[];
    return rows.map((r) => ({
      id: this.publicId(r.id),
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      expiresAt: r.expires_at,
      ip: r.ip,
      userAgent: r.user_agent,
      current: r.id === currentId,
    }));
  }

  /** Revokes the session with this public id; returns its stored id (to disconnect its sockets) or null. */
  revokeByPublicId(userId: number, publicId: string): string | null {
    const ids = this.db.prepare('SELECT id FROM sessions WHERE user_id = ?').all(userId) as { id: string }[];
    const match = ids.find((r) => this.publicId(r.id) === publicId);
    if (!match) return null;
    this.revoke(match.id);
    return match.id;
  }

  purgeExpired(): number {
    return this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now()).changes;
  }
}
