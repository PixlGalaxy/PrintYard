import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import supertest from 'supertest';
import { createApp } from '../src/app.js';
import { SECRET_MASK } from '../src/db/settings.js';
import {
  discordPayload,
  headerSafe,
  ntfyRequest,
  SIGNATURE_HEADER,
  telegramPayload,
  webhookRequest,
} from '../src/modules/notifications/channels.js';
import { dedupeKey, eventsForRole, recipientsFor, type NotifyEvent, type Recipient } from '../src/modules/notifications/events.js';
import { formatDuration, renderMessage } from '../src/modules/notifications/i18n.js';
import { DeliveryError, postOutbound } from '../src/modules/notifications/outbound.js';
import { isAllowedPushEndpoint, type SendPushFn } from '../src/modules/notifications/push.js';
import { NotificationSources } from '../src/modules/notifications/sources.js';
import type { PrinterStatus, PrintJob } from '../src/types.js';
import { ADMIN, createTestApp, setupBody, type TestApp } from './helpers.js';

// Fake values only: every outbound request goes to the stubs below, never to the network.
const DISCORD_URL = 'https://discord.com/api/webhooks/1234567890/fake-token-abcdefghijklmnopqrstuvwxyz';
const FCM = (n: number) => `https://fcm.googleapis.com/fcm/send/fake-endpoint-${n}`;
const KEYS = { p256dh: `B${'A'.repeat(86)}`, auth: 'AAAAAAAAAAAAAAAAAAAAAA' };

interface FetchCall {
  url: string;
  init: RequestInit;
}

function fetchStub(responder: (call: FetchCall, n: number) => Response | Promise<Response> = () => new Response(null, { status: 204 })) {
  const calls: FetchCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return responder(call, calls.length);
  }) as typeof fetch;
  return { calls, impl };
}

function pushStub() {
  const sent: { endpoint: string; payload: any }[] = [];
  let fail: ((endpoint: string) => number | null) | null = null;
  const impl: SendPushFn = async (sub, payload) => {
    const status = fail?.(sub.endpoint) ?? null;
    if (status !== null) throw Object.assign(new Error(`HTTP ${status}`), { statusCode: status });
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    return { statusCode: 201 };
  };
  return {
    sent,
    impl,
    failWith(fn: ((endpoint: string) => number | null) | null) {
      fail = fn;
    },
  };
}

const job = (over: Partial<PrintJob> = {}): PrintJob => ({
  id: 7,
  userId: 2,
  username: 'alice',
  printerId: 1,
  fileId: 1,
  fileName: 'Benchy.gcode',
  grams: 12.5,
  seconds: 3600,
  costEstimate: null,
  state: 'printing',
  createdAt: 1,
  startedAt: 1_000,
  endedAt: null,
  ...over,
});

// ---------------------------------------------------------------- pure helpers

describe('notifications: payload builders', () => {
  const msg = renderMessage('print.finished', { fileName: 'cube_@everyone.gcode', printerName: 'K2 SE', durationSec: 5400, grams: 12.34 }, 'en', 'https://print.example.com');

  it('builds a Discord embed with the event colour, fields and a safe mention policy', () => {
    const p = discordPayload({ mention: null }, msg, 0);
    assert.equal(p.embeds[0]!.color, 0x22c55e);
    assert.match(p.embeds[0]!.title, /Print finished/);
    assert.equal(p.embeds[0]!.url, 'https://print.example.com/');
    assert.ok(!p.embeds[0]!.description.includes('@everyone'), 'mentions inside names are neutralised');
    assert.deepEqual(p.allowed_mentions, { parse: [] });
    assert.equal(p.content, undefined);
    assert.deepEqual(p.embeds[0]!.fields.map((f) => f.name), ['Printer', 'Duration', 'Filament']);
    const withMention = discordPayload({ mention: '<@&123456789>' }, msg, 0);
    assert.equal(withMention.content, '<@&123456789>');
    assert.ok(withMention.allowed_mentions.parse.length > 0);
    assert.equal(discordPayload({ mention: '<@&123456789>' }, renderMessage('test', {}, 'en'), 0).content, undefined, 'tests never ping');
  });

  it('builds an HTML-escaped Telegram message', () => {
    const m = renderMessage('print.failed', { fileName: '<b>x</b>.gcode', printerName: 'K2' }, 'en');
    const p = telegramPayload({ chatId: '-100123' }, m);
    assert.equal(p.chat_id, '-100123');
    assert.equal(p.parse_mode, 'HTML');
    assert.ok(p.text.includes('&lt;b&gt;x&lt;/b&gt;.gcode'));
    assert.ok(!p.text.includes('<b>x</b>'));
  });

  it('builds an ntfy request with priority, tags, click link, token and an RFC 2047 title for non-ASCII', () => {
    const es = renderMessage('print.failed', { fileName: 'a.gcode' }, 'es', 'https://print.example.com');
    const r = ntfyRequest({ serverUrl: 'https://ntfy.example.com/', topic: 'my-topic', token: 'tk_secret' }, es);
    assert.equal(r.url, 'https://ntfy.example.com/my-topic');
    assert.equal(r.headers.Priority, 'high');
    assert.equal(r.headers.Tags, 'x');
    assert.equal(r.headers.Authorization, 'Bearer tk_secret');
    assert.equal(r.headers.Click, 'https://print.example.com/');
    assert.match(r.headers.Title!, /^=\?UTF-8\?B\?/);
    assert.equal(Buffer.from(r.headers.Title!.slice(10, -2), 'base64').toString('utf8'), 'PrintYard: La impresión falló');
    assert.equal(headerSafe('plain'), 'plain');
    // Private destinations only for a server explicitly marked as on the LAN (review 3A #4).
    assert.equal(r.allowHttpPrivate, false);
    assert.equal(ntfyRequest({ serverUrl: 'http://192.168.1.20', topic: 't', token: null, localServer: true }, es).allowHttpPrivate, true);
  });

  it('signs the generic webhook body with HMAC-SHA256', () => {
    const r = webhookRequest({ url: 'https://hooks.example.com/x', secret: 's3cret' }, msg, { data: { printId: 7 }, at: 0 });
    const expected = `sha256=${createHmac('sha256', 's3cret').update(r.body).digest('hex')}`;
    assert.equal(r.headers[SIGNATURE_HEADER], expected);
    assert.equal(r.headers['X-PrintYard-Event'], 'print.finished');
    // Deprecated pre-rename headers are still sent with the same values (existing receivers keep verifying).
    assert.equal(r.headers['X-SliceDock-Signature'], expected);
    assert.equal(r.headers['X-SliceDock-Event'], 'print.finished');
    const body = JSON.parse(r.body);
    assert.equal(body.event, 'print.finished');
    assert.equal(body.data.printId, 7);
    assert.equal(webhookRequest({ url: 'https://hooks.example.com/x', secret: null }, msg, { data: {}, at: 0 }).headers[SIGNATURE_HEADER], undefined);
    assert.equal(webhookRequest({ url: 'https://hooks.example.com/x', secret: null }, msg, { data: {}, at: 0 }).headers['X-SliceDock-Signature'], undefined);
  });
});

describe('notifications: localization', () => {
  it('renders each recipient language, with the bed reminder on finish', () => {
    const data = { fileName: 'cube.gcode', printerName: 'K2 SE', durationSec: 3720, grams: 1234.5 };
    const en = renderMessage('print.finished', data, 'en');
    const es = renderMessage('print.finished', data, 'es');
    assert.equal(en.title, 'Print finished');
    assert.equal(es.title, 'Impresión terminada');
    assert.match(en.body, /Remember to remove the print/);
    assert.match(es.body, /Recuerda retirar la pieza/);
    assert.equal(en.fields.find((f) => f.name === 'Duration')?.value, '1 h 2 min');
    assert.equal(es.fields.find((f) => f.name === 'Filamento')?.value, '1235 g');
    assert.equal(renderMessage('print.finished', { grams: 12345.6 }, 'es').fields[0]?.value, '12.346 g');
  });

  it('explains limit codes and reasons', () => {
    assert.match(renderMessage('limit.blocked', { fileName: 'a.gcode', code: 'prints.limit_month' }, 'es').body, /límite mensual/);
    const c = renderMessage('print.cancelled', { fileName: 'a', reason: 'cancelled_by:bob' }, 'en');
    assert.equal(c.fields.find((f) => f.name === 'Reason')?.value, 'Cancelled by bob');
    assert.equal(formatDuration(30), '1 min');
    assert.equal(formatDuration(7200), '2 h');
  });
});

describe('notifications: routing and dedupe keys', () => {
  const users: Recipient[] = [
    { id: 1, role: 'admin', language: 'es' },
    { id: 2, role: 'user', language: 'en' },
    { id: 3, role: 'user', language: 'en' },
  ];
  const ev = (type: NotifyEvent['type'], userId: number | null = 2): NotifyEvent => ({ type, data: { userId, printId: 7 }, at: 0 });
  const ids = (e: NotifyEvent) => recipientsFor(e, users).map((u) => u.id);

  it('sends print events to the owner and admins, approvals and limits to the right side', () => {
    assert.deepEqual(ids(ev('print.finished')), [1, 2]);
    assert.deepEqual(ids(ev('print.paused', null)), [1]);
    assert.deepEqual(ids(ev('approval.requested')), [1]);
    assert.deepEqual(ids(ev('approval.approved')), [2]);
    assert.deepEqual(ids(ev('approval.rejected')), [2]);
    assert.deepEqual(ids(ev('limit.blocked')), [2]);
    assert.deepEqual(ids(ev('printer.error')), [1, 2]);
    assert.deepEqual(ids(ev('printer.offline')), [1]);
    assert.deepEqual(ids(ev('engine.updated', null)), [1]);
  });

  it('limits the toggles of regular users to the events they can receive', () => {
    assert.ok(!eventsForRole('user').includes('approval.requested'));
    assert.ok(!eventsForRole('user').includes('engine.updated'));
    assert.equal(eventsForRole('admin').length, 15);
  });

  it('keys duplicates on event + print', () => {
    assert.equal(dedupeKey(ev('print.started')), dedupeKey(ev('print.started')));
    assert.notEqual(dedupeKey(ev('print.started')), dedupeKey(ev('print.finished')));
    assert.notEqual(dedupeKey(ev('print.started')), dedupeKey({ ...ev('print.started'), data: { printId: 8 } }));
  });
});

describe('notifications: outbound requests', () => {
  const publicDns = async () => ['93.184.216.34'];

  it('allows https, refuses plain http unless ntfy on a private address', async () => {
    const f = fetchStub();
    await postOutbound({ url: 'https://hooks.example.com/a', body: '{}', headers: {} }, { fetchImpl: f.impl, lookup: publicDns });
    await assert.rejects(postOutbound({ url: 'http://hooks.example.com/a', body: '{}', headers: {} }, { fetchImpl: f.impl }), DeliveryError);
    await assert.rejects(
      postOutbound({ url: 'http://ntfy.example.com/t', body: 'x', headers: {}, allowHttpPrivate: true }, { fetchImpl: f.impl, lookup: publicDns }),
      /private network/,
    );
    await postOutbound({ url: 'http://192.168.1.20:8080/t', body: 'x', headers: {}, allowHttpPrivate: true }, { fetchImpl: f.impl });
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0]!.init.redirect, 'manual');
    assert.ok(f.calls[0]!.init.signal, 'every request has a timeout');
  });

  it('follows redirects only to public https targets', async () => {
    const toPrivate = fetchStub(() => new Response(null, { status: 302, headers: { location: 'https://10.0.0.5/steal' } }));
    await assert.rejects(postOutbound({ url: 'https://hooks.example.com/a', body: '{}', headers: {} }, { fetchImpl: toPrivate.impl, lookup: publicDns }), /private/);
    const toHttp = fetchStub(() => new Response(null, { status: 301, headers: { location: 'http://hooks.example.com/b' } }));
    await assert.rejects(postOutbound({ url: 'https://hooks.example.com/a', body: '{}', headers: {} }, { fetchImpl: toHttp.impl, lookup: publicDns }), /non-https/);
    const ok = fetchStub((_c, n) => (n === 1 ? new Response(null, { status: 307, headers: { location: 'https://other.example.com/b' } }) : new Response('ok')));
    await postOutbound({ url: 'https://hooks.example.com/a', body: '{}', headers: {} }, { fetchImpl: ok.impl, lookup: publicDns });
    assert.equal(ok.calls[1]!.url, 'https://other.example.com/b');
  });

  it('marks 4xx as final and 5xx as retryable', async () => {
    const e400 = await postOutbound({ url: 'https://h.example.com', body: '', headers: {} }, { fetchImpl: fetchStub(() => new Response('bad', { status: 400 })).impl, lookup: publicDns }).catch((e) => e);
    assert.equal(e400.retryable, false);
    const e503 = await postOutbound({ url: 'https://h.example.com', body: '', headers: {} }, { fetchImpl: fetchStub(() => new Response('', { status: 503 })).impl, lookup: publicDns }).catch((e) => e);
    assert.equal(e503.retryable, true);
  });

  it('only accepts known browser push services as endpoints', () => {
    assert.ok(isAllowedPushEndpoint(FCM(1)));
    assert.ok(isAllowedPushEndpoint('https://web.push.apple.com/QGx'));
    assert.ok(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'));
    assert.ok(!isAllowedPushEndpoint('https://192.168.8.1/x'));
    assert.ok(!isAllowedPushEndpoint('http://fcm.googleapis.com/x'));
    assert.ok(!isAllowedPushEndpoint('https://fcm.googleapis.com.evil.example/x'));
  });
});

// ---------------------------------------------------------------- integration (API + dispatcher)

describe('notifications: API, dispatcher and push lifecycle', () => {
  let t: TestApp;
  let alice: ReturnType<typeof supertest.agent>;
  let aliceId: number;
  const push = pushStub();
  let fetchResponder: (call: FetchCall, n: number) => Response | Promise<Response> = () => new Response(null, { status: 204 });
  const net = fetchStub((c, n) => fetchResponder(c, n));

  before(async () => {
    t = createTestApp({
      context: { notifications: { fetchImpl: net.impl, sendPush: push.impl, retryDelaysMs: [0, 0, 0], lookup: async () => ['93.184.216.34'] } },
    });
    await t.agent.post('/api/setup/complete').send(setupBody({ printer: null, exposure: { mode: 'none' } }));
    aliceId = (await t.agent.post('/api/admin/users').send({ username: 'alice', password: 'alice-password-1', role: 'user', language: 'en' })).body.id;
    alice = supertest.agent(createApp(t.ctx));
    assert.equal((await alice.post('/api/auth/login').send({ username: 'alice', password: 'alice-password-1' })).status, 200);
  });
  after(() => {
    t.ctx.notifications.stop();
    t.ctx.notificationSources.stop();
    t.close();
  });
  beforeEach(() => {
    push.sent.length = 0;
    net.calls.length = 0;
    push.failWith(null);
    fetchResponder = () => new Response(null, { status: 204 });
  });

  it('manages devices: validation, upsert, listing, removal', async () => {
    const bad = await alice.post('/api/account/notifications/subscriptions').send({ endpoint: 'https://10.0.0.1/push', keys: KEYS });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'notify.push_endpoint_invalid');
    const a = await alice.post('/api/account/notifications/subscriptions').set('User-Agent', 'Mozilla/5.0 (iPhone)').send({ endpoint: FCM(1), keys: KEYS });
    assert.equal(a.status, 201);
    assert.equal(a.body.service, 'fcm.googleapis.com');
    assert.equal((await alice.post('/api/account/notifications/subscriptions').send({ endpoint: FCM(1), keys: KEYS })).status, 200, 'same endpoint = upsert');
    const extra = await alice.post('/api/account/notifications/subscriptions').send({ endpoint: FCM(99), keys: KEYS });
    const view = await alice.get('/api/account/notifications');
    assert.equal(view.status, 200);
    assert.equal(view.body.devices.length, 2);
    assert.match(view.body.vapidPublicKey, /^[A-Za-z0-9_-]{80,}$/);
    assert.ok(!view.body.events.includes('approval.requested'));
    assert.equal((await t.agent.delete(`/api/account/notifications/subscriptions/${extra.body.id}`)).status, 404, "an admin cannot remove someone else's device here");
    assert.equal((await alice.delete(`/api/account/notifications/subscriptions/${extra.body.id}`)).status, 204);
    assert.equal((await t.agent.post('/api/account/notifications/subscriptions').send({ endpoint: FCM(2), keys: KEYS })).status, 201);
    assert.equal((await alice.get('/api/account/notifications')).body.devices.length, 1);
  });

  it('sends a test push in the user language', async () => {
    const r = await alice.post('/api/account/notifications/test');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { sent: 1, failed: 0, removed: 0 });
    assert.equal(push.sent[0]!.payload.title, 'Test notification');
    assert.equal((await alice.post('/api/account/notifications/test')).status, 429, 'cooldown');
  });

  it('routes a print to owner + admins, each in their language, and channels in the default language', async () => {
    const patch = await t.agent.patch('/api/admin/notifications/discord').send({ enabled: true, webhookUrl: DISCORD_URL });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));
    t.ctx.hub.publish('print.update', job({ id: 70, userId: aliceId, state: 'printing' }));
    await t.ctx.notifications.flush();
    const byEndpoint = Object.fromEntries(push.sent.map((s) => [s.endpoint, s.payload]));
    assert.equal(byEndpoint[FCM(1)]?.title, 'Print started', 'alice (en)');
    assert.equal(byEndpoint[FCM(2)]?.title, 'Impresión iniciada', 'admin (es, from setup)');
    assert.equal(byEndpoint[FCM(1)]?.tag, 'print.started:70');
    assert.equal(net.calls.length, 1);
    assert.equal(net.calls[0]!.url, DISCORD_URL);
    const body = JSON.parse(String(net.calls[0]!.init.body));
    assert.equal(body.embeds[0].color, 0x0ea5e9);
    assert.match(body.embeds[0].title, /Impresión iniciada/, 'app.defaultLanguage is es');
    const status = (await t.agent.get('/api/admin/notifications')).body.status.discord;
    assert.ok(status.lastSuccessAt > 0);
    assert.equal(status.lastEvent, 'print.started');
  });

  it('drops duplicates within 60 s', async () => {
    assert.equal(t.ctx.notifications.emit('print.paused', { printId: 71, userId: aliceId }), 'queued');
    assert.equal(t.ctx.notifications.emit('print.paused', { printId: 71, userId: aliceId }), 'duplicate');
    assert.equal(t.ctx.notifications.emit('print.paused', { printId: 72, userId: aliceId }), 'queued');
    await t.ctx.notifications.flush();
    assert.equal(push.sent.length, 4);
  });

  it('honours per-user event toggles and per-channel events', async () => {
    const r = await alice.put('/api/account/notifications/prefs').send({ events: ['print.started', 'approval.requested'] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.prefs.events, ['print.started'], 'events the role cannot get are ignored');
    await t.agent.patch('/api/admin/notifications/discord').send({ events: ['print.failed'] });
    t.ctx.notifications.emit('print.finished', { printId: 73, userId: aliceId });
    await t.ctx.notifications.flush();
    assert.deepEqual(push.sent.map((s) => s.endpoint), [FCM(2)]);
    assert.equal(net.calls.length, 0);
    await alice.put('/api/account/notifications/prefs').send({ events: eventsForRole('user') });
    await t.agent.patch('/api/admin/notifications/discord').send({ events: eventsForRole('admin') });
  });

  it('notifies limits and approvals from the audit log to the right people', async () => {
    t.ctx.audit.log('print.refused', { userId: aliceId, username: 'alice' }, 'big.gcode', { code: 'prints.limit_month', printerId: 1 });
    await t.ctx.notifications.flush();
    assert.equal(push.sent.length, 1);
    assert.equal(push.sent[0]!.endpoint, FCM(1));
    assert.match(push.sent[0]!.payload.body, /monthly filament limit/);
    push.sent.length = 0;
    t.ctx.hub.publish('approval.pending', job({ id: 74, userId: aliceId, state: 'pending' }));
    await t.ctx.notifications.flush();
    assert.deepEqual(push.sent.map((s) => s.endpoint), [FCM(2)]);
  });

  it('retries failed channel deliveries with backoff and records the last error without secrets', async () => {
    fetchResponder = (_c, n) => (n < 3 ? new Response(`boom ${DISCORD_URL}`, { status: 502 }) : new Response(null, { status: 204 }));
    t.ctx.notifications.emit('print.failed', { printId: 75, userId: aliceId });
    await t.ctx.notifications.flush();
    assert.equal(net.calls.length, 3);
    net.calls.length = 0;
    fetchResponder = () => new Response(`still broken ${DISCORD_URL}`, { status: 500 });
    t.ctx.notifications.emit('print.failed', { printId: 76, userId: aliceId });
    await t.ctx.notifications.flush();
    assert.equal(net.calls.length, 4, '1 attempt + 3 retries');
    const status = (await t.agent.get('/api/admin/notifications')).body.status.discord;
    assert.match(status.lastError, /HTTP 500/);
    assert.ok(!status.lastError.includes('fake-token'), 'the webhook token is scrubbed');
  });

  it('removes subscriptions the push service reports gone (410)', async () => {
    push.failWith((ep) => (ep === FCM(1) ? 410 : null));
    t.ctx.notifications.emit('print.cancelled', { printId: 77, userId: aliceId });
    await t.ctx.notifications.flush();
    assert.equal((await alice.get('/api/account/notifications')).body.devices.length, 0);
    assert.deepEqual(push.sent.map((s) => s.endpoint), [FCM(2)]);
  });

  it('masks channel secrets everywhere and keeps them when the mask is sent back', async () => {
    const got = (await t.agent.get('/api/admin/notifications')).body;
    assert.equal(got.channels.discord.webhookUrl, SECRET_MASK);
    assert.equal((await t.agent.get('/api/admin/settings')).body['notify.discord.webhookUrl'], SECRET_MASK);
    await t.agent.patch('/api/admin/notifications/discord').send({ webhookUrl: SECRET_MASK, mention: '@here' });
    assert.equal(t.ctx.settings.get('notify.discord.webhookUrl'), DISCORD_URL);
    const tg = await t.agent.patch('/api/admin/notifications/telegram').send({ botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ', chatId: '-1001234' });
    assert.equal(tg.body.channels.telegram.botToken, SECRET_MASK);
    const audits = JSON.stringify(t.ctx.audit.list(200));
    assert.ok(!audits.includes('fake-token') && !audits.includes('ABCDEFGHIJ'), 'audit stores field names only');
    const invalid = await t.agent.patch('/api/admin/notifications/discord').send({ webhookUrl: 'https://evil.example.com/api/webhooks/1/x' });
    assert.equal(invalid.status, 400);
    assert.equal((await t.agent.patch('/api/admin/notifications/ntfy').send({ serverUrl: 'http://8.8.8.8' })).status, 400);
    assert.equal((await t.agent.patch('/api/admin/notifications/ntfy').send({ serverUrl: 'http://192.168.1.5:8080' })).status, 200);
    assert.equal((await t.agent.patch('/api/admin/notifications/nope').send({})).status, 404);
    assert.equal((await alice.get('/api/admin/notifications')).status, 403);
  });

  it('runs the channel Test button against the saved config', async () => {
    assert.equal((await t.agent.post('/api/admin/notifications/webhook/test')).body.error.code, 'notify.channel_not_configured');
    const ok = await t.agent.post('/api/admin/notifications/telegram/test');
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(net.calls[0]!.url, 'https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ/sendMessage');
    fetchResponder = () => new Response('Unauthorized', { status: 401 });
    const bad = await t.agent.post('/api/admin/notifications/discord/test');
    assert.equal(bad.status, 502);
    assert.equal(bad.body.error.code, 'notify.test_failed');
    assert.ok(!JSON.stringify(bad.body).includes('fake-token'));
  });

  it('reports the VAPID subject fallback when admin.email is unset', async () => {
    assert.equal((await t.agent.get('/api/admin/notifications')).body.push.subject, `mailto:${ADMIN.email}`);
    await t.agent.patch('/api/admin/settings').send({ 'admin.email': '' });
    const push2 = (await t.agent.get('/api/admin/notifications')).body.push;
    assert.equal(push2.subject, 'mailto:admin@localhost');
    assert.equal(push2.subjectFallback, true);
  });
});

// ---------------------------------------------------------------- printer-status and engine sources

describe('notifications: printer status and engine sources', () => {
  let t: TestApp;
  const emitted: { type: string; data: any }[] = [];
  let listener: ((s: PrinterStatus, prev: PrinterStatus | null) => void) | null = null;
  let online = false;
  let sources: NotificationSources;
  let engine = { available: false, version: null as string | null };

  const status = (over: Partial<PrinterStatus>): PrinterStatus =>
    ({ printerId: 1, online: true, state: 'printing', errorCode: null, fileName: 'x.gcode', ...over }) as PrinterStatus;

  before(() => {
    t = createTestApp();
    t.ctx.notificationSources.stop();
    const svc = t.ctx.notifications;
    const fakeSvc = Object.assign(Object.create(svc), {
      emit: (type: string, data: unknown) => {
        emitted.push({ type, data });
        return 'queued';
      },
    });
    sources = new NotificationSources(fakeSvc, {
      db: t.ctx.db,
      settings: t.ctx.settings,
      hub: t.ctx.hub,
      audit: t.ctx.audit,
      manager: { onStatus: (cb: typeof listener) => ((listener = cb), () => undefined), status: () => ({ online }) } as never,
      printerName: () => 'K2 SE',
      engine: { updateAvailable: () => engine.available, latestVersion: () => engine.version },
      offlineAfterMs: 30,
    });
    sources.attach();
  });
  after(() => {
    sources.stop();
    t.close();
  });
  beforeEach(() => {
    emitted.length = 0;
  });

  it('emits pause and printer errors once per change', () => {
    listener!(status({ state: 'paused' }), status({ state: 'printing' }));
    listener!(status({ state: 'paused' }), status({ state: 'paused' }));
    listener!(status({ state: 'error', errorCode: 2001 }), status({ state: 'paused' }));
    listener!(status({ state: 'error', errorCode: 2001 }), status({ state: 'error', errorCode: 2001 }));
    assert.deepEqual(emitted.map((e) => e.type), ['print.paused', 'printer.error']);
    assert.equal(emitted[1]!.data.code, 2001);
  });

  it('reports a printer that stays offline during a print, not one that comes back', async () => {
    listener!(status({ online: false, state: 'offline' }), status({ state: 'printing' }));
    listener!(status({ online: true }), status({ online: false, state: 'offline' }));
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(emitted.length, 0);
    online = false;
    listener!(status({ online: false, state: 'offline' }), status({ state: 'printing' }));
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(emitted.map((e) => e.type), ['printer.offline']);
  });

  it('turns print.update transitions into events (ignoring withdrawn requests)', () => {
    t.ctx.hub.publish('print.update', job({ id: 90, state: 'printing' }));
    t.ctx.hub.publish('print.update', job({ id: 90, state: 'printing' }));
    t.ctx.hub.publish('print.update', job({ id: 90, state: 'done', endedAt: 1_000 + 7_200_000 }));
    t.ctx.hub.publish('print.update', job({ id: 91, state: 'cancelled', startedAt: null, reason: 'withdrawn' }));
    assert.deepEqual(emitted.map((e) => e.type), ['print.started', 'print.finished']);
    assert.equal(emitted[1]!.data.durationSec, 7200);
  });

  it('maps engine audit entries and announces an available version once (auto-update off)', () => {
    t.ctx.audit.log('engine.update', { username: 'system' }, '7.4.0', { auto: true });
    t.ctx.audit.log('engine.update_failed', { username: 'system' }, '7.4.1', { error: 'disk full' });
    engine = { available: true, version: '7.5.0' };
    sources.checkEngine();
    assert.deepEqual(emitted.map((e) => e.type), ['engine.updated', 'engine.update_failed'], 'auto-update on: no "available" event');
    t.ctx.settings.patch({ 'engine.autoUpdate': false });
    sources.checkEngine();
    sources.checkEngine();
    assert.deepEqual(emitted.map((e) => e.type), ['engine.updated', 'engine.update_failed', 'engine.update_available']);
  });
});
