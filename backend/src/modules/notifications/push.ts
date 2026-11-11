import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import webpush from 'web-push';
import type { Db } from '../../db/client.js';
import { AppError, badRequest, notFound } from '../../errors.js';
import { logger } from '../../logger.js';
import { DeliveryError } from './outbound.js';

const log = logger.channel('notify');

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  icon: string;
  badge: string;
  event: string;
  ts: number;
}

/** A device as the account API returns it (no keys). */
export interface PushDevice {
  id: number;
  userAgent: string | null;
  /** Push service host, e.g. fcm.googleapis.com / web.push.apple.com. */
  service: string;
  /** First 16 hex chars of sha256(endpoint): lets a browser recognise its own device. */
  endpointHash: string;
  createdAt: number;
  lastSuccessAt: number | null;
  failCount: number;
}

interface SubRow {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: number;
  last_success_at: number | null;
  fail_count: number;
}

export type SendPushFn = (
  subscription: webpush.PushSubscription,
  payload: string,
  options: webpush.RequestOptions,
) => Promise<{ statusCode: number }>;

/** Known browser push services. Anything else is refused, so a subscription cannot point the server at any URL. */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^(?:[\w-]+\.)*push\.services\.mozilla\.com$/,
  /^(?:[\w-]+\.)*push\.apple\.com$/,
  /^(?:[\w-]+\.)*notify\.windows\.com$/,
  /^(?:[\w-]+\.)*wns\.windows\.com$/,
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && u.port === '' && !u.username && !u.password && PUSH_HOSTS.some((re) => re.test(u.hostname.toLowerCase()));
}

export const MAX_DEVICES_PER_USER = 20;
/** Dropped after this many consecutive failures (404/410 drop at once). */
export const MAX_FAILS = 10;

export interface PushServiceOptions {
  db: Db;
  /** `<appdata>/vapid.json` */
  keyFile: string;
  /** VAPID subject from settings `admin.email`. */
  adminEmail: () => string | null;
  sendImpl?: SendPushFn;
}

export class PushService {
  private keys: VapidKeys | null = null;
  private readonly send: SendPushFn;

  constructor(private readonly o: PushServiceOptions) {
    this.send = o.sendImpl ?? ((sub, payload, options) => webpush.sendNotification(sub, payload, options));
  }

  /** Loads the VAPID key pair, generating and persisting it (0600) on first use. */
  vapid(): VapidKeys {
    if (this.keys) return this.keys;
    const file = this.o.keyFile;
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<VapidKeys>;
        if (typeof parsed.publicKey === 'string' && typeof parsed.privateKey === 'string') {
          this.keys = { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
          return this.keys;
        }
      } catch {
        /* corrupt: regenerate below */
      }
      log.warn('vapid.json is unreadable: generating a new VAPID key pair (existing push subscriptions stop working)');
    }
    const generated = webpush.generateVAPIDKeys();
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ publicKey: generated.publicKey, privateKey: generated.privateKey, createdAt: Date.now() }), { mode: 0o600 });
    renameSync(tmp, file);
    try {
      chmodSync(file, 0o600);
    } catch {
      /* not supported (Windows) */
    }
    log.info('Generated the Web Push VAPID key pair');
    this.keys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
    // Subscriptions made with another key pair can never be delivered again.
    const dropped = this.o.db.prepare('DELETE FROM push_subscriptions').run().changes;
    if (dropped > 0) log.warn(`Dropped ${dropped} push subscription(s) made with the previous VAPID key`);
    return this.keys;
  }

  /** `mailto:<admin.email>`, or the fallback (the admin UI shows a warning then). */
  subject(): { subject: string; fallback: boolean } {
    const email = this.o.adminEmail();
    return email ? { subject: `mailto:${email}`, fallback: false } : { subject: 'mailto:admin@localhost', fallback: true };
  }

  list(userId: number): PushDevice[] {
    return (this.o.db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC').all(userId) as SubRow[]).map(toDevice);
  }

  count(): number {
    return (this.o.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as { n: number }).n;
  }

  /** Upserts by endpoint: the browser belongs to whoever subscribed on it last. */
  subscribe(userId: number, input: { endpoint: string; p256dh: string; auth: string; userAgent: string | null }): { device: PushDevice; created: boolean } {
    if (!isAllowedPushEndpoint(input.endpoint)) {
      throw badRequest('notify.push_endpoint_invalid', 'This browser uses a push service PrintYard does not know');
    }
    this.vapid(); // never let a later first-time key generation wipe this subscription
    const existing = this.o.db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(input.endpoint) as SubRow | undefined;
    if (!existing) {
      const n = (this.o.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(userId) as { n: number }).n;
      if (n >= MAX_DEVICES_PER_USER) {
        throw new AppError(409, 'notify.too_many_devices', `At most ${MAX_DEVICES_PER_USER} devices per account`);
      }
    }
    const ua = input.userAgent?.slice(0, 300) ?? null;
    const now = Date.now();
    if (existing) {
      this.o.db
        .prepare('UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ?, user_agent = ?, fail_count = 0 WHERE id = ?')
        .run(userId, input.p256dh, input.auth, ua, existing.id);
      return { device: toDevice(this.row(existing.id)!), created: false };
    }
    const id = Number(
      this.o.db
        .prepare('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at, fail_count) VALUES (?, ?, ?, ?, ?, ?, 0)')
        .run(userId, input.endpoint, input.p256dh, input.auth, ua, now).lastInsertRowid,
    );
    return { device: toDevice(this.row(id)!), created: true };
  }

  /** Removes one of the user's devices (404 for someone else's). */
  remove(userId: number, id: number): void {
    const res = this.o.db.prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').run(id, userId);
    if (res.changes === 0) throw notFound();
  }

  /** Removes the subscription of this endpoint if it belongs to the user (unsubscribe from the current browser). */
  removeEndpoint(userId: number, endpoint: string): boolean {
    return this.o.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, userId).changes > 0;
  }

  /** Subscription ids of a user (the dispatcher queues one delivery per device). */
  deviceIds(userId: number): number[] {
    return (this.o.db.prepare('SELECT id FROM push_subscriptions WHERE user_id = ?').all(userId) as { id: number }[]).map((r) => r.id);
  }

  /**
   * Sends to one device. 404/410 → the subscription is deleted (gone for good, no retry). Other failures bump
   * fail_count (dropped after MAX_FAILS) and throw a DeliveryError (retryable for 5xx/429/network).
   * Returns false when the device no longer exists.
   */
  async deliver(id: number, payload: PushPayload, opts: { urgency?: webpush.Urgency } = {}): Promise<boolean> {
    const row = this.row(id);
    if (!row) return false;
    const keys = this.vapid();
    const { subject } = this.subject();
    try {
      await this.send({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, JSON.stringify(payload), {
        vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
        TTL: 6 * 3600,
        timeout: 10_000,
        urgency: opts.urgency ?? 'normal',
      });
    } catch (err) {
      const status = typeof (err as { statusCode?: unknown }).statusCode === 'number' ? (err as { statusCode: number }).statusCode : null;
      if (status === 404 || status === 410) {
        this.o.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id);
        log.info(`Push subscription #${id} expired (HTTP ${status}): removed`);
        return false;
      }
      const fails = row.fail_count + 1;
      if (fails >= MAX_FAILS) {
        this.o.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id);
        log.warn(`Push subscription #${id} failed ${fails} times in a row: removed`);
      } else {
        this.o.db.prepare('UPDATE push_subscriptions SET fail_count = ? WHERE id = ?').run(fails, id);
      }
      const retryable = status === null || status >= 500 || status === 429;
      throw new DeliveryError(status === null ? 'Push service unreachable' : `Push service answered HTTP ${status}`, status, retryable && fails < MAX_FAILS);
    }
    this.o.db.prepare('UPDATE push_subscriptions SET last_success_at = ?, fail_count = 0 WHERE id = ?').run(Date.now(), id);
    return true;
  }

  private row(id: number): SubRow | undefined {
    return this.o.db.prepare('SELECT * FROM push_subscriptions WHERE id = ?').get(id) as SubRow | undefined;
  }
}

function toDevice(r: SubRow): PushDevice {
  let service = '';
  try {
    service = new URL(r.endpoint).hostname;
  } catch {
    /* validated on insert */
  }
  return { id: r.id, userAgent: r.user_agent, service, endpointHash: endpointHash(r.endpoint), createdAt: r.created_at, lastSuccessAt: r.last_success_at, failCount: r.fail_count };
}

export function endpointHash(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex').slice(0, 16);
}
