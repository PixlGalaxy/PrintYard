import type { Db } from '../../db/client.js';
import { logger } from '../../logger.js';
import { isPrivateIp, normalizeIp } from '../../lib/ip.js';

export interface LoginGuardOptions {
  /** Failed attempts allowed per (IP, username) pair inside `windowMs` → 429. */
  maxFailures: number;
  windowMs: number;
  /** Failures from one IP inside `banWindowMs` that turn into a temporary ban (never for private/loopback IPs). */
  banThreshold: number;
  banWindowMs: number;
  banDurationMs: number;
  /** Failed attempts per IP across all usernames inside `windowMs` → 429 (password spraying). Default 2 × maxFailures. */
  ipMaxFailures?: number;
  /** Global per-username failures (all IPs) after which public-IP attempts get a progressive delay. Default maxFailures. */
  userSoftThreshold?: number;
  /** Global per-username failures after which public-IP attempts get 429. Private/loopback IPs are never blocked by it. */
  userMaxFailures?: number;
  /** First progressive delay step, doubled per extra failure, capped at `userDelayMaxMs`. */
  userDelayBaseMs?: number;
  userDelayMaxMs?: number;
}

export const DEFAULT_LOGIN_GUARD: LoginGuardOptions = {
  maxFailures: 5,
  windowMs: 15 * 60_000,
  banThreshold: 20,
  banWindowMs: 60 * 60_000,
  banDurationMs: 60 * 60_000,
  ipMaxFailures: 10,
  userSoftThreshold: 5,
  userMaxFailures: 100,
  userDelayBaseMs: 500,
  userDelayMaxMs: 8000,
};

/**
 * A LAN client talking to us directly: exempt from the per-username delay and 429 (nobody can lock the owner out
 * of the LAN by username). Only the TCP peer counts: a private IP taken from a forwarding header can be anything a
 * client wrote (a LAN machine passes as a "trusted proxy" by default), so rotating forged private IPs must not
 * buy unlimited, undelayed guesses. Bans stay off for every private IP (a forged one must not block a real LAN user).
 */
const lanPeer = (ip: string, forwarded: boolean) => !forwarded && isPrivateIp(ip);

/** In-memory sliding-window failure counter. */
class FailureCounter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly windowMs: number) {}

  private live(key: string, now: number): number[] {
    const kept = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (kept.length === 0) this.hits.delete(key);
    else this.hits.set(key, kept);
    return kept;
  }

  count(key: string, now = Date.now()): number {
    return this.live(key, now).length;
  }

  /** Seconds until the oldest counted failure leaves the window. */
  retryAfter(key: string, now = Date.now()): number {
    const first = this.live(key, now)[0];
    return first === undefined ? 0 : Math.max(1, Math.ceil((first + this.windowMs - now) / 1000));
  }

  add(key: string, now = Date.now()): number {
    const list = this.live(key, now);
    list.push(now);
    this.hits.set(key, list);
    return list.length;
  }

  /** Removes one hit recorded at `at` (rolls back a reservation). */
  remove(key: string, at: number): void {
    const list = this.hits.get(key);
    if (!list) return;
    const i = list.indexOf(at);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) this.hits.delete(key);
  }

  clear(key: string): void {
    this.hits.delete(key);
  }

  sweep(now = Date.now()): void {
    for (const key of [...this.hits.keys()]) this.live(key, now);
  }
}

/** Temporary/permanent IP bans persisted in `ip_bans` (until NULL = permanent). */
export class IpBansService {
  constructor(private readonly db: Db) {}

  isBanned(rawIp: string | null | undefined, now = Date.now()): boolean {
    const ip = normalizeIp(rawIp);
    if (!ip) return false;
    const row = this.db.prepare('SELECT until FROM ip_bans WHERE ip = ?').get(ip) as { until: number | null } | undefined;
    if (!row) return false;
    if (row.until !== null && row.until <= now) {
      this.db.prepare('DELETE FROM ip_bans WHERE ip = ?').run(ip);
      return false;
    }
    return true;
  }

  ban(ip: string, reason: string, until: number | null): void {
    this.db
      .prepare(
        'INSERT INTO ip_bans (ip, reason, until, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, until = excluded.until',
      )
      .run(ip, reason, until, Date.now());
  }

  purgeExpired(now = Date.now()): number {
    return this.db.prepare('DELETE FROM ip_bans WHERE until IS NOT NULL AND until <= ?').run(now).changes;
  }
}

export type GuardVerdict = { allowed: true } | { allowed: false; retryAfter: number };

/** A reserved login attempt: counted as a failure until `succeeded()` rolls it back. */
export interface LoginAttempt {
  allowed: true;
  /** Progressive delay (ms) to wait before verifying the password; always 0 for private/loopback IPs. */
  delayMs: number;
  /** The password was wrong: feeds the ban counter. Returns true when this failure triggered an IP ban. */
  failed(): boolean;
  /** The password was right: rolls back the reservation and clears the (IP, username) counter. */
  succeeded(): void;
}

const pairKey = (ip: string, user: string) => `${ip}\u0000${user}`;

/**
 * Login brute-force protection.
 * - Hard 429: `maxFailures` per (IP, username) and `ipMaxFailures` per IP inside `windowMs`.
 * - Global per-username counter (all IPs): a progressive delay past `userSoftThreshold` and a 429 past
 *   `userMaxFailures`, both for public IPs only, so nobody can lock the owner out of the LAN by username.
 * - `banThreshold` failures from one public IP in `banWindowMs` → ip_bans entry. Private/loopback IPs are never
 *   banned (behind a mis-configured same-host proxy every visitor shares one private IP).
 * Attempts are reserved synchronously in `begin()` (before any await), so parallel requests cannot overshoot.
 */
export class LoginGuard {
  private readonly byPair: FailureCounter;
  private readonly byIp: FailureCounter;
  private readonly byUser: FailureCounter;
  private readonly forBan: FailureCounter;
  private readonly timer: NodeJS.Timeout;
  private readonly o: Required<LoginGuardOptions>;

  constructor(
    private readonly bans: IpBansService,
    opts: LoginGuardOptions = DEFAULT_LOGIN_GUARD,
  ) {
    this.o = {
      ipMaxFailures: opts.ipMaxFailures ?? opts.maxFailures * 2,
      userSoftThreshold: opts.userSoftThreshold ?? opts.maxFailures,
      userMaxFailures: opts.userMaxFailures ?? 100,
      userDelayBaseMs: opts.userDelayBaseMs ?? 500,
      userDelayMaxMs: opts.userDelayMaxMs ?? 8000,
      maxFailures: opts.maxFailures,
      windowMs: opts.windowMs,
      banThreshold: opts.banThreshold,
      banWindowMs: opts.banWindowMs,
      banDurationMs: opts.banDurationMs,
    };
    this.byPair = new FailureCounter(opts.windowMs);
    this.byIp = new FailureCounter(opts.windowMs);
    this.byUser = new FailureCounter(opts.windowMs);
    this.forBan = new FailureCounter(opts.banWindowMs);
    this.timer = setInterval(() => {
      this.byPair.sweep();
      this.byIp.sweep();
      this.byUser.sweep();
      this.forBan.sweep();
    }, 60_000);
    this.timer.unref();
  }

  /** Read-only verdict (reserves nothing). */
  check(ip: string, username: string, now = Date.now(), forwarded = false): GuardVerdict {
    const user = username.toLowerCase();
    const pair = pairKey(ip, user);
    const blocks: number[] = [];
    if (this.byPair.count(pair, now) >= this.o.maxFailures) blocks.push(this.byPair.retryAfter(pair, now));
    if (this.byIp.count(ip, now) >= this.o.ipMaxFailures) blocks.push(this.byIp.retryAfter(ip, now));
    if (!lanPeer(ip, forwarded) && this.byUser.count(user, now) >= this.o.userMaxFailures) {
      blocks.push(this.byUser.retryAfter(user, now));
    }
    return blocks.length > 0 ? { allowed: false, retryAfter: Math.max(...blocks) } : { allowed: true };
  }

  /** Checks and, when allowed, synchronously reserves the attempt (counted as a failure until it succeeds). */
  begin(ip: string, username: string, forwarded = false): LoginAttempt | { allowed: false; retryAfter: number } {
    const now = Date.now();
    const verdict = this.check(ip, username, now, forwarded);
    if (!verdict.allowed) return verdict;
    const user = username.toLowerCase();
    const pair = pairKey(ip, user);
    const prior = this.byUser.count(user, now);
    this.byPair.add(pair, now);
    this.byIp.add(ip, now);
    this.byUser.add(user, now);

    let delayMs = 0;
    if (!lanPeer(ip, forwarded) && prior >= this.o.userSoftThreshold) {
      const steps = Math.min(prior - this.o.userSoftThreshold, 20);
      delayMs = Math.min(this.o.userDelayMaxMs, this.o.userDelayBaseMs * 2 ** steps);
    }

    let settled = false;
    return {
      allowed: true,
      delayMs,
      failed: () => {
        if (settled) return false;
        settled = true;
        return this.recordBanFailure(ip);
      },
      succeeded: () => {
        if (settled) return;
        settled = true;
        this.byPair.clear(pair);
        this.byIp.remove(ip, now);
        this.byUser.remove(user, now);
      },
    };
  }

  /** Records a complete failure outside the request flow (tests, tools). Returns true when it triggered a ban. */
  fail(ip: string, username: string): boolean {
    const user = username.toLowerCase();
    this.byPair.add(pairKey(ip, user));
    this.byIp.add(ip);
    this.byUser.add(user);
    return this.recordBanFailure(ip);
  }

  private recordBanFailure(ip: string): boolean {
    if (isPrivateIp(ip)) return false; // rate-limited, never banned
    const total = this.forBan.add(ip);
    if (total >= this.o.banThreshold) {
      this.bans.ban(ip, 'login brute force', Date.now() + this.o.banDurationMs);
      this.forBan.clear(ip);
      logger.auth.warn(`Banned ${ip} for ${Math.round(this.o.banDurationMs / 60_000)} min after repeated failed logins`);
      return true;
    }
    return false;
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
