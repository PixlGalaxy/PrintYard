import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { SettingsValidationError } from '../../db/settings.js';
import { AppError, notFound, validationFailed } from '../../errors.js';
import { idParam, parse } from '../../middleware/index.js';
import { eventsForRole, NOTIFY_EVENTS } from './events.js';
import { USER_TRIGGERED_EVENTS } from './flood.js';
import { CHANNEL_FIELDS, CHANNELS, isChannel, type ChannelName } from './settings.js';

const TEST_COOLDOWN_MS = 5_000;

const subscribeSchema = z.object({
  endpoint: z.string().trim().min(10).max(2048),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,100}={0,2}$/, 'p256dh must be a base64url P-256 key'),
    auth: z.string().regex(/^[A-Za-z0-9_-]{16,24}={0,2}$/, 'auth must be a base64url secret'),
  }),
  expirationTime: z.number().nullable().optional(),
});

const unsubscribeSchema = z.object({ endpoint: z.string().trim().min(10).max(2048) });
const prefsSchema = z.object({ events: z.array(z.enum(NOTIFY_EVENTS)).max(NOTIFY_EVENTS.length) });

/** Per-key cooldown for the Test buttons (they reach external services). */
function cooldown() {
  const last = new Map<string, number>();
  return (key: string) => {
    const now = Date.now();
    const t = last.get(key);
    if (t !== undefined && now - t < TEST_COOLDOWN_MS) {
      const retryAfter = Math.ceil((TEST_COOLDOWN_MS - (now - t)) / 1000);
      throw new AppError(429, 'notify.test_cooldown', 'Wait a few seconds before sending another test', { retryAfter }, { 'Retry-After': String(retryAfter) });
    }
    last.set(key, now);
    if (last.size > 1000) last.clear();
  };
}

/** Admin view of every channel (secrets masked) + last delivery + Web Push facts. */
function adminView(ctx: AppContext) {
  const masked = ctx.settings.getAllMasked();
  const channels = {} as Record<ChannelName, Record<string, unknown>>;
  for (const c of CHANNELS) {
    const obj: Record<string, unknown> = {};
    for (const f of CHANNEL_FIELDS[c]) obj[f] = masked[`notify.${c}.${f}`];
    channels[c] = obj;
  }
  const subject = ctx.notifications.push.subject();
  const flood = ctx.notifications.floodStats();
  const nameOf = ctx.db.prepare('SELECT username FROM users WHERE id = ?');
  return {
    channels,
    status: ctx.notifications.channelStatus(),
    events: [...NOTIFY_EVENTS],
    push: { subject: subject.subject, subjectFallback: subject.fallback, devices: ctx.notifications.push.count() },
    // Review 3A #3: user-triggered events (limit.blocked, approval.requested) are rate-limited per user.
    rateLimit: {
      events: [...USER_TRIGGERED_EVENTS],
      maxPerWindow: flood.maxPerWindow,
      windowMinutes: Math.round(flood.windowMs / 60_000),
      heldTotal: flood.heldTotal,
      digestsSent: flood.digestsSent,
      active: flood.active.map((a) => ({
        ...a,
        username: (nameOf.get(a.userId) as { username: string } | undefined)?.username ?? null,
      })),
    },
  };
}

/** Mounted at /admin/notifications behind requireAdmin. */
export function adminNotificationRoutes(ctx: AppContext): Router {
  const router = Router();
  const testGate = cooldown();
  const actor = (req: Request) => ({ userId: req.session!.user.id, username: req.session!.user.username, ip: req.clientIp });

  router.get('/', (_req, res) => {
    res.json(adminView(ctx));
  });

  // Body: any subset of the channel's fields; secrets sent back as "********" stay unchanged, "" clears.
  router.patch('/:channel', (req, res) => {
    const channel = req.params.channel;
    if (!isChannel(channel)) throw notFound();
    const body = req.body as unknown;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw validationFailed([{ path: '', message: 'Body must be an object' }]);
    const allowed = CHANNEL_FIELDS[channel] as readonly string[];
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (!allowed.includes(k)) throw validationFailed([{ path: k, message: 'Unknown field' }]);
      patch[`notify.${channel}.${k}`] = v;
    }
    let changed: string[];
    try {
      changed = ctx.settings.patch(patch);
    } catch (err) {
      if (err instanceof SettingsValidationError) {
        throw validationFailed(err.issues.map((i) => ({ path: i.key.replace(`notify.${channel}.`, ''), message: i.message })));
      }
      throw err;
    }
    // Key names only: values (secrets) never reach the audit log.
    if (changed.length) ctx.audit.log('notify.channel_update', actor(req), channel, { fields: changed.map((k) => k.split('.').pop()) });
    res.json(adminView(ctx));
  });

  router.post('/:channel/test', async (req, res) => {
    const channel = req.params.channel;
    if (!isChannel(channel)) throw notFound();
    testGate(`${req.session!.user.id}:${channel}`);
    ctx.audit.log('notify.test', actor(req), channel);
    await ctx.notifications.testChannel(channel);
    res.json({ ok: true, status: ctx.notifications.channelStatus()[channel] });
  });

  return router;
}

/** Mounted at /account/notifications behind requireAuth. */
export function accountNotificationRoutes(ctx: AppContext): Router {
  const router = Router();
  const testGate = cooldown();

  const view = (req: Request) => {
    const u = req.session!.user;
    return {
      vapidPublicKey: ctx.notifications.push.vapid().publicKey,
      events: eventsForRole(u.role),
      prefs: { events: ctx.notifications.prefs(u.id, u.role) },
      devices: ctx.notifications.push.list(u.id),
    };
  };

  router.get('/', (req, res) => {
    res.json(view(req));
  });

  router.put('/prefs', (req, res) => {
    const u = req.session!.user;
    const { events } = parse(prefsSchema, req.body);
    ctx.notifications.setPrefs(u.id, u.role, events);
    res.json(view(req));
  });

  router.post('/subscriptions', (req, res) => {
    const u = req.session!.user;
    const body = parse(subscribeSchema, req.body);
    const ua = req.get('user-agent') ?? null;
    const { device, created } = ctx.notifications.push.subscribe(u.id, { endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth, userAgent: ua });
    if (created) ctx.audit.log('notify.push_subscribe', { userId: u.id, username: u.username, ip: req.clientIp }, device.id, { service: device.service });
    res.status(created ? 201 : 200).json(device);
  });

  // Unsubscribe the current browser by endpoint (it knows its endpoint, not our id).
  router.post('/subscriptions/remove', (req, res) => {
    const u = req.session!.user;
    const { endpoint } = parse(unsubscribeSchema, req.body);
    ctx.notifications.push.removeEndpoint(u.id, endpoint);
    res.status(204).end();
  });

  router.delete('/subscriptions/:id', (req, res) => {
    const u = req.session!.user;
    const id = idParam(req);
    ctx.notifications.push.remove(u.id, id);
    ctx.audit.log('notify.push_remove', { userId: u.id, username: u.username, ip: req.clientIp }, id);
    res.status(204).end();
  });

  router.post('/test', async (req, res) => {
    const u = req.session!.user;
    testGate(String(u.id));
    res.json(await ctx.notifications.testPush(u.id, u.language === 'es' ? 'es' : 'en'));
  });

  return router;
}
