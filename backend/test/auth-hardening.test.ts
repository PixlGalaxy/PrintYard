// Auth / session / access-control regression tests (security audit, phase 4).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import supertest from 'supertest';
import { createApp } from '../src/app.js';
import { ADMIN, createTestApp, setupBody, type TestApp } from './helpers.js';
import { loginCookie, startServer, wsConnect } from './live-helpers.js';

describe('password change cannot be used to brute-force the current password', () => {
  let t: TestApp;
  let alice: ReturnType<typeof supertest.agent>;

  before(async () => {
    t = createTestApp();
    await t.agent.post('/api/setup/complete').send(setupBody());
    const created = await t.agent.post('/api/admin/users').send({ username: 'alice', password: 'alice-password-1', role: 'user' });
    assert.equal(created.status, 201);
    alice = supertest.agent(createApp(t.ctx));
    assert.equal((await alice.post('/api/auth/login').send({ username: 'alice', password: 'alice-password-1' })).status, 200);
  });
  after(() => t.close());

  it('rate-limits wrong current passwords like failed logins', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await alice.post('/api/account/password').send({ currentPassword: `guess-${i}-xxxxx`, newPassword: 'stolen-session-pw-1' });
      statuses.push(r.status);
    }
    assert.ok(statuses.includes(429), `expected a 429 among ${statuses.join(',')}`);
    // Even the right password is refused while limited (no oracle left for the attacker).
    const right = await alice.post('/api/account/password').send({ currentPassword: 'alice-password-1', newPassword: 'stolen-session-pw-1' });
    assert.equal(right.status, 429);
    assert.equal(right.body.error.code, 'auth.rate_limited');
    const audited = t.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'account.password_failed'").get() as { n: number };
    assert.ok(audited.n >= 1);
  });
});

describe('realtime sockets honour IP bans', () => {
  let t: TestApp;
  before(async () => {
    t = createTestApp();
    await t.agent.post('/api/setup/complete').send(setupBody());
  });
  after(() => t.close());

  it('an open socket from an address that gets banned is closed on the next heartbeat', async () => {
    const live = await startServer(t.ctx);
    const cookie = await loginCookie(live.base, ADMIN.username, ADMIN.password);
    const ws = await wsConnect(live.wsUrl, { Origin: live.base, Cookie: cookie });
    try {
      await ws.next('hello');
      const closed = new Promise<number>((r) => ws.ws.once('close', (code) => r(code)));
      // The HTTP API refuses this address from now on; the socket must not keep streaming.
      t.ctx.bans.ban('127.0.0.1', 'test', Date.now() + 60_000);
      assert.equal((await t.request.get('/api/auth/me')).status, 403);
      (t.ctx.hub as unknown as { heartbeat(): void }).heartbeat();
      const timeout = new Promise<string>((r) => setTimeout(() => r('still open'), 1000).unref());
      assert.equal(await Promise.race([closed, timeout]), 4403);
    } finally {
      ws.ws.terminate();
      t.ctx.bans.purgeExpired(Date.now() + 120_000);
      await live.close();
    }
  });
});
