import type { Db } from '../../db/client.js';
import type { AuditEntry } from '../../types.js';

export interface AuditActor {
  userId?: number | null;
  username?: string | null;
  ip?: string | null;
}

interface AuditRow {
  id: number;
  user_id: number | null;
  username: string | null;
  action: string;
  target: string | null;
  meta: string | null;
  ip: string | null;
  created_at: number;
}

/**
 * Actions: auth.login, auth.login_failed, auth.logout, setup.complete, user.create, user.update, user.delete,
 * user.limits, user.password_reset, account.update, account.password, settings.update,
 * printer.create, printer.update, printer.delete, ip.banned, account.avatar, account.avatar_remove, user.avatar_remove.
 */
/** Audit entries are kept for 90 days. */
export const AUDIT_RETENTION_MS = 90 * 24 * 60 * 60_000;

export type AuditListener = (action: string, actor: AuditActor, target: string | number | null, meta: unknown) => void;

export class AuditService {
  private readonly listeners = new Set<AuditListener>();

  constructor(private readonly db: Db) {}

  /** In-process observers of every logged action (notifications). Listeners must not throw; errors are swallowed. */
  onLog(listener: AuditListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  log(action: string, actor: AuditActor, target?: string | number | null, meta?: unknown): void {
    this.write(action, actor, target, meta);
    for (const l of this.listeners) {
      try {
        l(action, actor, target ?? null, meta);
      } catch {
        /* observers never break the audited action */
      }
    }
  }

  private write(action: string, actor: AuditActor, target?: string | number | null, meta?: unknown): void {
    this.db
      .prepare(
        'INSERT INTO audit_log (user_id, username, action, target, meta, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        actor.userId ?? null,
        actor.username ?? null,
        action,
        target === undefined || target === null ? null : String(target),
        meta === undefined ? null : JSON.stringify(meta),
        actor.ip ?? null,
        Date.now(),
      );
  }

  /** Retention: deletes entries older than `maxAgeMs` (housekeeping uses AUDIT_RETENTION_MS). */
  purgeOlderThan(maxAgeMs: number, now = Date.now()): number {
    return this.db.prepare('DELETE FROM audit_log WHERE created_at < ?').run(now - maxAgeMs).changes;
  }

  /** Newest first; `before` = id cursor for paging back. */
  list(limit: number, before?: number): AuditEntry[] {
    const rows = (
      before
        ? this.db.prepare('SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, limit)
        : this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit)
    ) as AuditRow[];
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      action: r.action,
      target: r.target,
      meta: r.meta === null ? null : safeJson(r.meta),
      ip: r.ip,
      createdAt: r.created_at,
    }));
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
