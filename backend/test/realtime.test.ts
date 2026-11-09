import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { contextHubAuth, forAdmins, forUser, RealtimeHub } from '../src/realtime/index.js';
import { ADMIN, createTestApp, setupBody, type TestApp } from './helpers.js';
import { loginCookie, startServer, waitFor, wsConnect, type LiveServer } from './live-helpers.js';

describe('realtime hub /api/ws', () => {
  let t: TestApp;
  let live: LiveServer;
  let adminCookie: string;
  let userCookie: string;
  let userId: number;
  let origin: string;

  before(async () => {
    t = createTestApp();
    await t.agent.post('/api/setup/complete').send(setupBody({ printer: null, exposure: { mode: 'none' } }));
    const u = await t.agent.post('/api/admin/users').send({ username: 'bob', password: 'bob-password-1', role: 'user' });
    userId = u.body.id;
    live = await startServer(t.ctx);
    origin = live.base;
    adminCookie = await loginCookie(live.base, ADMIN.username, ADMIN.password);
    userCookie = await loginCookie(live.base, 'bob', 'bob-password-1');
  });
  after(async () => {
    await live.close();
    t.close();
  });

  it('rejects a connection without a session cookie (401)', async () => {
    await assert.rejects(wsConnect(live.wsUrl, { Origin: origin }), (e: { status?: number }) => e.status === 401);
    await assert.rejects(wsConnect(live.wsUrl, { Origin: origin, Cookie: 'sd_session=bogus' }), (e: { status?: number }) => e.status === 401);
  });

  it('rejects cross-origin and Origin-less upgrades (403)', async () => {
    await assert.rejects(wsConnect(live.wsUrl, { Origin: 'http://evil.example', Cookie: userCookie }), (e: { status?: number }) => e.status === 403);
    await assert.rejects(wsConnect(live.wsUrl, { Cookie: userCookie }), (e: { status?: number }) => e.status === 403);
    await assert.rejects(wsConnect(live.wsUrl, { Origin: 'null', Cookie: userCookie }), (e: { status?: number }) => e.status === 403);
  });

  it('accepts the configured public URL as origin', async () => {
    t.ctx.settings.patch({ 'exposure.publicUrl': 'https://print.example.com' });
    const c = await wsConnect(live.wsUrl, { Origin: 'https://print.example.com', Cookie: userCookie });
    await c.next('hello');
    c.close();
    t.ctx.settings.patch({ 'exposure.publicUrl': null });
  });

  it('refuses other upgrade paths', async () => {
    await assert.rejects(wsConnect(live.wsUrl.replace('/api/ws', '/api/other'), { Origin: origin, Cookie: userCookie }), (e: { status?: number }) => e.status === 404);
  });

  it('authenticated clients get hello, pong, and only the messages their filter allows', async () => {
    const admin = await wsConnect(live.wsUrl, { Origin: origin, Cookie: adminCookie });
    const user = await wsConnect(live.wsUrl, { Origin: origin, Cookie: userCookie });
    assert.equal((await user.next('hello')).role, 'user');
    assert.equal((await admin.next('hello')).role, 'admin');
    user.send({ type: 'ping' });
    await user.next('pong');

    t.ctx.hub.publish('engine.progress', { state: 'downloading', progress: 5 }, forAdmins);
    t.ctx.hub.publish('slice.job', { id: 'j1', state: 'queued' }, forUser(userId));
    t.ctx.hub.publish('broadcast.test', { n: 1 });
    assert.equal((await admin.next('engine.progress')).progress, 5);
    assert.equal((await user.next('slice.job')).id, 'j1');
    await user.next('broadcast.test');
    await admin.next('broadcast.test');
    assert.equal(user.messages.some((m) => m.type === 'engine.progress'), false);
    assert.equal(admin.messages.some((m) => m.type === 'slice.job'), false);
    admin.close();
    user.close();
  });

  it('subscribe sends the current printer status; printer.status goes to subscribers only', async () => {
    const p = await t.agent.post('/api/admin/printers').send({ name: 'P', model: 'creality-k2se', host: '192.168.8.240' });
    assert.equal(p.status, 201);
    const sub = await wsConnect(live.wsUrl, { Origin: origin, Cookie: userCookie });
    const other = await wsConnect(live.wsUrl, { Origin: origin, Cookie: userCookie });
    sub.send({ type: 'subscribe', printers: [p.body.id, 'x', -1, 999999] });
    const status = await sub.next('printer.status');
    assert.equal(status.printerId, p.body.id);
    assert.equal(status.state, 'offline'); // manager not started in tests
    assert.equal(status.bedClear, true);
    t.ctx.printerManager.republish(p.body.id);
    await sub.next('printer.status', (d) => d.printerId === p.body.id);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(other.messages.some((m) => m.type === 'printer.status'), false);
    sub.close();
    other.close();
  });

  it('closes sockets whose session was revoked (re-checked on every ping)', async () => {
    const hub = new RealtimeHub(contextHubAuth(t.ctx), { pingIntervalMs: 50 });
    const server = createServer(createApp(t.ctx));
    hub.attach(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    const cookie = await loginCookie(`http://127.0.0.1:${port}`, 'bob', 'bob-password-1');
    const c = await wsConnect(`ws://127.0.0.1:${port}/api/ws`, { Origin: `http://127.0.0.1:${port}`, Cookie: cookie });
    await c.next('hello');
    const closed = new Promise<number>((r) => c.ws.on('close', (code) => r(code)));
    await fetch(`http://127.0.0.1:${port}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(await closed, 4401);
    await waitFor(() => hub.size === 0);
    hub.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(() => r(null)));
  });
});
