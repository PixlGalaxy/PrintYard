import { join } from 'node:path';
import type { Db } from '../../db/client.js';
import type { SettingsService } from '../../db/settings.js';
import { AppError, badRequest } from '../../errors.js';
import { logger } from '../../logger.js';
import type { Language, Role } from '../../types.js';
import {
  buildRequest,
  isReady,
  scrub,
  secretsOf,
  type ChannelConfigs,
  type MessageContext,
} from './channels.js';
import {
  dedupeKey,
  EVENT_META,
  eventsForRole,
  isNotifyEvent,
  recipientsFor,
  type DeliverableEvent,
  type NotifyEvent,
  type NotifyEventData,
  type NotifyEventType,
  type Recipient,
} from './events.js';
import { renderMessage, type RenderedMessage } from './i18n.js';
import { FloodGuard, heldBackText, sanitizeEventData, type FloodStats } from './flood.js';
import { DeliveryError, postOutbound, type FetchFn, type LookupFn } from './outbound.js';
import { PushService, type PushPayload, type SendPushFn } from './push.js';
import { CHANNELS, type ChannelName } from './settings.js';

const log = logger.channel('notify');

export const DEDUPE_WINDOW_MS = 60_000;
/** Delays before retry 1, 2 and 3 (4 attempts in total). */
export const DEFAULT_RETRY_DELAYS_MS = [5_000, 30_000, 120_000];

export interface ChannelStatus {
  lastEvent: string | null;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

interface StatusRow {
  channel: string;
  last_event: string | null;
  last_attempt_at: number | null;
  last_success_at: number | null;
  last_error: string | null;
  last_error_at: number | null;
}

type Job =
  | { kind: 'channel'; channel: ChannelName; message: RenderedMessage; ctx: MessageContext; attempt: number }
  | { kind: 'push'; deviceId: number; userId: number; payload: PushPayload; urgent: boolean; attempt: number };

export interface NotificationServiceOptions {
  db: Db;
  settings: SettingsService;
  appdataRoot: string;
  fetchImpl?: FetchFn;
  lookup?: LookupFn;
  sendPush?: SendPushFn;
  retryDelaysMs?: number[];
  dedupeMs?: number;
  /** Flood guard for user-triggered events (tests): deliveries per user + event per window. */
  floodMax?: number;
  floodWindowMs?: number;
}

/** `held`: rate-limited (user-triggered event), it will be part of a digest. */
export type EmitResult = 'queued' | 'duplicate' | 'held';

/**
 * Dispatcher: turns internal events into localized deliveries (admin channels + each recipient's Web Push devices),
 * dedupes repeats, and runs every delivery through a small retry queue. Never throws from `emit`.
 */
export class NotificationService {
  readonly push: PushService;
  readonly flood: FloodGuard;
  private readonly recent = new Map<string, number>();
  private readonly active = new Set<Promise<void>>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly retryDelays: number[];
  private stopped = false;

  constructor(private readonly o: NotificationServiceOptions) {
    this.retryDelays = o.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.flood = new FloodGuard({
      ...(o.floodMax !== undefined && { max: o.floodMax }),
      ...(o.floodWindowMs !== undefined && { windowMs: o.floodWindowMs }),
      onDigest: (type, data, held, at) => {
        try {
          this.fanOut({ type, data, at }, held);
        } catch (err) {
          log.error(`Cannot dispatch the ${type} digest`, err);
        }
      },
    });
    this.push = new PushService({
      db: o.db,
      keyFile: join(o.appdataRoot, 'vapid.json'),
      adminEmail: () => o.settings.get('admin.email'),
      ...(o.sendPush && { sendImpl: o.sendPush }),
    });
  }

  /** Server start: make sure the VAPID key pair exists. */
  start(): void {
    try {
      this.push.vapid();
      if (this.push.subject().fallback) log.warn('admin.email is not set: Web Push uses the subject mailto:admin@localhost');
    } catch (err) {
      log.error('Cannot prepare the Web Push keys', err);
    }
  }

  stop(): void {
    this.stopped = true;
    this.flood.stop();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  // ------------------------------------------------------------------ config

  channelConfigs(): ChannelConfigs {
    const s = this.o.settings;
    return {
      discord: {
        enabled: s.get('notify.discord.enabled'),
        webhookUrl: s.get('notify.discord.webhookUrl'),
        mention: s.get('notify.discord.mention'),
        events: s.get('notify.discord.events'),
      },
      telegram: {
        enabled: s.get('notify.telegram.enabled'),
        botToken: s.get('notify.telegram.botToken'),
        chatId: s.get('notify.telegram.chatId'),
        events: s.get('notify.telegram.events'),
      },
      ntfy: {
        enabled: s.get('notify.ntfy.enabled'),
        serverUrl: s.get('notify.ntfy.serverUrl'),
        topic: s.get('notify.ntfy.topic'),
        token: s.get('notify.ntfy.token'),
        localServer: s.get('notify.ntfy.localServer'),
        events: s.get('notify.ntfy.events'),
      },
      webhook: {
        enabled: s.get('notify.webhook.enabled'),
        url: s.get('notify.webhook.url'),
        secret: s.get('notify.webhook.secret'),
        events: s.get('notify.webhook.events'),
      },
    };
  }

  channelStatus(): Record<ChannelName, ChannelStatus> {
    const rows = this.o.db.prepare('SELECT * FROM notification_channel_status').all() as StatusRow[];
    const out = {} as Record<ChannelName, ChannelStatus>;
    for (const c of CHANNELS) {
      const r = rows.find((x) => x.channel === c);
      out[c] = {
        lastEvent: r?.last_event ?? null,
        lastAttemptAt: r?.last_attempt_at ?? null,
        lastSuccessAt: r?.last_success_at ?? null,
        lastError: r?.last_error ?? null,
        lastErrorAt: r?.last_error_at ?? null,
      };
    }
    return out;
  }

  /** Push events a user receives (row, else every event of the role). */
  prefs(userId: number, role: Role): NotifyEventType[] {
    const allowed = eventsForRole(role);
    const row = this.o.db.prepare('SELECT push_events FROM notification_prefs WHERE user_id = ?').get(userId) as { push_events: string } | undefined;
    if (!row) return allowed;
    try {
      const list = JSON.parse(row.push_events) as unknown;
      return Array.isArray(list) ? allowed.filter((e) => list.includes(e)) : allowed;
    } catch {
      return allowed;
    }
  }

  setPrefs(userId: number, role: Role, events: readonly string[]): NotifyEventType[] {
    const allowed = eventsForRole(role);
    const list = allowed.filter((e) => events.includes(e));
    this.o.db
      .prepare(
        'INSERT INTO notification_prefs (user_id, push_events, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET push_events = excluded.push_events, updated_at = excluded.updated_at',
      )
      .run(userId, JSON.stringify(list), Date.now());
    return list;
  }

  state(key: string): string | null {
    return (this.o.db.prepare('SELECT value FROM notification_state WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }

  setState(key: string, value: string): void {
    this.o.db.prepare('INSERT INTO notification_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ------------------------------------------------------------------ dispatch

  /**
   * Fans an event out. Duplicates (same event + subject within 60 s) are dropped; user-triggered events beyond the
   * flood limit are held for a digest. User-controlled text is cleaned and truncated for every channel.
   */
  emit(type: NotifyEventType, rawData: NotifyEventData, at = Date.now()): EmitResult {
    const data = sanitizeEventData(rawData);
    const event: NotifyEvent = { type, data, at };
    const key = dedupeKey(event);
    const window = this.o.dedupeMs ?? DEDUPE_WINDOW_MS;
    for (const [k, t] of this.recent) if (at - t > window) this.recent.delete(k);
    const last = this.recent.get(key);
    if (last !== undefined && at - last <= window) return 'duplicate';
    this.recent.set(key, at);
    if (!this.flood.admit(type, data, at)) return 'held';

    try {
      this.fanOut(event);
    } catch (err) {
      log.error(`Cannot dispatch ${type}`, err);
    }
    return 'queued';
  }

  /** Rate-limit facts for the admin page (users currently held back, totals). */
  floodStats(): FloodStats {
    return this.flood.stats();
  }

  /** `held` > 0: digest delivery, the body ends with "N more…". */
  private fanOut(event: NotifyEvent, held = 0): void {
    const publicUrl = this.o.settings.get('exposure.publicUrl');
    const ctx: MessageContext = { data: event.data, at: event.at };

    // Admin channels speak the instance's default language.
    const cfgs = this.channelConfigs();
    const lang = this.o.settings.get('app.defaultLanguage');
    let channelMsg: RenderedMessage | null = null;
    for (const name of CHANNELS) {
      const cfg = cfgs[name];
      if (!cfg.enabled || !isReady(name, cfgs) || !cfg.events.includes(event.type)) continue;
      channelMsg ??= withHeld(renderMessage(event.type, event.data, lang, publicUrl), held);
      this.enqueue({ kind: 'channel', channel: name, message: channelMsg, ctx, attempt: 0 });
    }

    // Web Push: each recipient in their own language, if they kept this event on.
    for (const r of recipientsFor(event, this.activeUsers())) {
      if (!this.prefs(r.id, r.role).includes(event.type)) continue;
      const devices = this.push.deviceIds(r.id);
      if (devices.length === 0) continue;
      const payload = this.pushPayload(event.type, event.data, r.language, event.at);
      if (held > 0) payload.body = `${payload.body} ${heldBackText(held, r.language)}`;
      const urgent = EVENT_META[event.type].priority === 'high' || EVENT_META[event.type].priority === 'urgent';
      for (const deviceId of devices) this.enqueue({ kind: 'push', deviceId, userId: r.id, payload, urgent, attempt: 0 });
    }
  }

  private activeUsers(): Recipient[] {
    return (this.o.db.prepare('SELECT id, role, language FROM users WHERE is_active = 1').all() as { id: number; role: Role; language: string }[]).map((u) => ({
      id: u.id,
      role: u.role,
      language: (u.language === 'es' ? 'es' : 'en') as Language,
    }));
  }

  pushPayload(event: DeliverableEvent, data: NotifyEventData, language: Language, at = Date.now()): PushPayload {
    const msg = renderMessage(event, data, language, null);
    const subject = data.printId ?? data.printerId ?? data.version ?? '';
    return {
      title: msg.title,
      body: msg.body,
      url: msg.path,
      tag: `${event}:${subject}`,
      // the global skin's icon set (frontend/scripts/gen-icons.mjs); the badge is a white silhouette for every skin
      icon: `/icons/${this.o.settings.get('appearance.defaultSkin')}/icon-192.png`,
      badge: '/icons/badge-96.png',
      event,
      ts: at,
    };
  }

  private enqueue(job: Job): void {
    if (this.stopped) return;
    const p = this.run(job).finally(() => this.active.delete(p));
    this.active.add(p);
  }

  private async run(job: Job): Promise<void> {
    if (this.stopped) return;
    try {
      await this.attempt(job);
    } catch (err) {
      const e = err instanceof DeliveryError ? err : new DeliveryError((err as Error).message);
      const label = job.kind === 'channel' ? job.channel : `push #${job.deviceId}`;
      const event = job.kind === 'channel' ? job.message.event : job.payload.event;
      const message = job.kind === 'channel' ? scrub(e.message, secretsOf(job.channel, this.channelConfigs())) : e.message;
      const scrubDetail = (d: string, j: Job) => (j.kind === 'channel' ? scrub(d, secretsOf(j.channel, this.channelConfigs())) : d);
      const delay = this.retryDelays[job.attempt];
      if (e.retryable && delay !== undefined && !this.stopped) {
        log.warn(`${label}: ${event} failed (${message}); retry ${job.attempt + 1}/${this.retryDelays.length} in ${Math.round(delay / 1000)} s`);
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            this.timers.delete(t);
            resolve();
          }, delay);
          t.unref();
          this.timers.add(t);
        });
        if (this.stopped) return;
        return this.run({ ...job, attempt: job.attempt + 1 });
      }
      log.error(`${label}: ${event} could not be delivered: ${message}${e.detail ? ` (${scrubDetail(e.detail, job)})` : ''}`);
      if (job.kind === 'channel') this.recordFailure(job.channel, event, message);
    }
  }

  private async attempt(job: Job): Promise<void> {
    if (job.kind === 'push') {
      await this.push.deliver(job.deviceId, job.payload, { urgency: job.urgent ? 'high' : 'normal' });
      return;
    }
    const cfgs = this.channelConfigs();
    // Settings may have changed while the job waited for a retry.
    if (!cfgs[job.channel].enabled || !isReady(job.channel, cfgs)) return;
    this.recordAttempt(job.channel, job.message.event);
    await postOutbound(buildRequest(job.channel, cfgs, job.message, job.ctx), this.outboundDeps());
    this.recordSuccess(job.channel);
  }

  private outboundDeps() {
    return { ...(this.o.fetchImpl && { fetchImpl: this.o.fetchImpl }), ...(this.o.lookup && { lookup: this.o.lookup }) };
  }

  /** Resolves once every queued delivery (including retries) finished. Tests and shutdown. */
  async flush(): Promise<void> {
    while (this.active.size > 0) await Promise.allSettled([...this.active]);
  }

  // ------------------------------------------------------------------ tests (admin + account)

  /** Admin "Test" button: one attempt, no retries; throws `notify.test_failed` with the (scrubbed) reason. */
  async testChannel(name: ChannelName): Promise<void> {
    const cfgs = this.channelConfigs();
    if (!isReady(name, cfgs)) throw badRequest('notify.channel_not_configured', 'Fill in and save this channel first');
    const msg = renderMessage('test', {}, this.o.settings.get('app.defaultLanguage'), this.o.settings.get('exposure.publicUrl'));
    this.recordAttempt(name, 'test');
    try {
      await postOutbound(buildRequest(name, cfgs, msg, { data: {}, at: Date.now() }), this.outboundDeps());
    } catch (err) {
      // Status code + a generic reason only: response bodies never reach the client (review 3A #4).
      const e = err instanceof DeliveryError ? err : new DeliveryError('Network error');
      const message = scrub(e.message, secretsOf(name, cfgs));
      this.recordFailure(name, 'test', message);
      log.warn(`${name}: test notification failed: ${message}${e.detail ? ` (${scrub(e.detail, secretsOf(name, cfgs))})` : ''}`);
      throw new AppError(502, 'notify.test_failed', `The channel rejected the message: ${message}`, { error: message, status: e.status });
    }
    this.recordSuccess(name);
  }

  /** Account "Send test": one attempt per device of the user, in their language. */
  async testPush(userId: number, language: Language): Promise<{ sent: number; failed: number; removed: number }> {
    const devices = this.push.deviceIds(userId);
    if (devices.length === 0) throw badRequest('notify.no_devices', 'Enable notifications on a device first');
    const payload = this.pushPayload('test', {}, language);
    let sent = 0;
    let failed = 0;
    let removed = 0;
    for (const id of devices) {
      try {
        if (await this.push.deliver(id, payload)) sent++;
        else removed++;
      } catch {
        failed++;
      }
    }
    return { sent, failed, removed };
  }

  // ------------------------------------------------------------------ status rows

  private upsertStatus(channel: ChannelName, fields: Partial<Omit<StatusRow, 'channel'>>): void {
    const cols = Object.keys(fields);
    this.o.db
      .prepare(
        `INSERT INTO notification_channel_status (channel, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
         ON CONFLICT(channel) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}`,
      )
      .run(channel, ...Object.values(fields));
  }

  private recordAttempt(channel: ChannelName, event: string): void {
    this.upsertStatus(channel, { last_event: event, last_attempt_at: Date.now() });
  }

  private recordSuccess(channel: ChannelName): void {
    this.upsertStatus(channel, { last_success_at: Date.now() });
  }

  private recordFailure(channel: ChannelName, event: string, error: string): void {
    this.upsertStatus(channel, { last_event: event, last_error: error.slice(0, 500), last_error_at: Date.now() });
  }
}

function withHeld(msg: RenderedMessage, held: number): RenderedMessage {
  return held > 0 ? { ...msg, body: `${msg.body}\n${heldBackText(held, msg.language)}` } : msg;
}

export { isNotifyEvent };
