import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { hashToken } from '../src/modules/auth/sessions.service.js';
import { ADMIN, createTestApp, setupBody, type TestApp } from './helpers.js';

function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'] as string[] | undefined;
  const c = raw?.find((v) => v.startsWith('sd_session='));
  assert.ok(c, 'sd_session cookie set');
  return c;
}

describe('setup → login → me → logout', () => {
  let t: TestApp;
  before(() => {
    t = createTestApp();
  });
  after(() => t.close());

  it('public endpoints work before setup', async () => {
    const health = await t.request.get('/api/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { ok: true, version: 'test' });

    const config = await t.request.get('/api/config');
    assert.deepEqual(config.body, { appName: 'PrintYard', version: 'test', setupComplete: false, languages: ['en', 'es'], defaultLanguage: 'en', appearance: { defaultMode: 'system', defaultSkin: 'sky' }, workspace: { defaultLevel: 'basic' }, readOnly: false, files: { retentionEnabled: true, retentionKeep: 10 }, printing: { calibrateByDefault: false } });

    const status = await t.request.get('/api/setup/status');
    assert.equal(status.body.setupComplete, false);
    assert.equal(status.body.lanAllowed, true);
    assert.equal(typeof status.body.memoryOk, 'boolean');
    assert.equal(typeof status.body.hostNetworkLikely, 'boolean');

    const models = await t.request.get('/api/printer-models');
    assert.deepEqual(models.body, [{ id: 'creality-k2se', name: 'Creality K2 SE', vendor: 'Creality', bed: { x: 220, y: 215, z: 245 }, kinematics: 'corexy' }]);

    assert.equal((await t.request.get('/api/auth/me')).status, 401);
    assert.equal((await t.request.get('/api/printers')).status, 401);
  });

  it('setup endpoints refuse proxied requests', async () => {
    const res = await t.request.post('/api/setup/complete').set('X-Forwarded-For', '203.0.113.5').send(setupBody());
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'setup.not_lan');
    const res2 = await t.request.post('/api/setup/test-printer').set('Host', 'print.example.com').send({ model: 'creality-k2se', host: '192.168.8.230', staticIp: true });
    assert.equal(res2.status, 403);
  });

  it('test-printer uses the driver probe', async () => {
    const res = await t.request.post('/api/setup/test-printer').send({ model: 'creality-k2se', host: '192.168.8.230', staticIp: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.mac, 'fc:ee:28:13:e2:ed');
    const bad = await t.request.post('/api/setup/test-printer').send({ model: 'creality-k2se', host: 'http://x/y', staticIp: true });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'validation.failed');
  });

  it('validates the setup body', async () => {
    const res = await t.request.post('/api/setup/complete').send(setupBody({ admin: { ...ADMIN, password: 'short' } }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'validation.failed');
    assert.ok(Array.isArray(res.body.error.details));
  });

  it('completes setup, starts a session, and stores settings + printer', async () => {
    const res = await t.agent.post('/api/setup/complete').send(setupBody());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.user.username, 'admin');
    assert.equal(res.body.user.role, 'admin');
    assert.equal(res.body.user.language, 'es');
    assert.equal(res.body.user.isActive, true);
    const cookie = sessionCookie(res);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.match(cookie, /Path=\//);
    assert.doesNotMatch(cookie, /Secure/i); // plain HTTP in tests

    // Only sha256(token) is stored.
    const token = decodeURIComponent(cookie.split(';')[0]!.split('=')[1]!);
    const row = t.ctx.db.prepare('SELECT id FROM sessions').get() as { id: string };
    assert.equal(row.id, hashToken(token));
    assert.notEqual(row.id, token);

    assert.equal(t.ctx.settings.get('exposure.mode'), 'nginx');
    assert.equal(t.ctx.settings.get('exposure.publicUrl'), 'https://print.example.com');
    assert.equal(t.ctx.settings.get('app.defaultLanguage'), 'es');
    assert.equal(t.ctx.settings.get('admin.email'), ADMIN.email);

    const me = await t.agent.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.username, 'admin');

    const printers = await t.agent.get('/api/printers');
    assert.equal(printers.body.length, 1);
    assert.equal(printers.body[0].host, '192.168.8.230');
    assert.deepEqual(printers.body[0].camera, { type: 'none' });

    const audit = await t.agent.get('/api/admin/audit');
    assert.ok(audit.body.items.some((i: { action: string }) => i.action === 'setup.complete'));
  });

  it('refuses a second setup with 409', async () => {
    const res = await t.request.post('/api/setup/complete').send(setupBody());
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'setup.already_complete');
    assert.equal((await t.request.get('/api/config')).body.setupComplete, true);
  });

  it('logout clears the session; login works again', async () => {
    const out = await t.agent.post('/api/auth/logout');
    assert.equal(out.status, 204);
    assert.equal((await t.agent.get('/api/auth/me')).status, 401);

    const bad = await t.agent.post('/api/auth/login').send({ username: 'admin', password: 'wrong-password!' });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error.code, 'auth.invalid_credentials');

    const ok = await t.agent.post('/api/auth/login').send({ username: 'ADMIN', password: ADMIN.password });
    assert.equal(ok.status, 200);
    sessionCookie(ok);
    assert.equal(ok.body.user.username, 'admin');
    assert.equal(typeof ok.body.user.lastLoginAt, 'number');
    assert.equal((await t.agent.get('/api/auth/me')).status, 200);
  });

  it('CSRF: refuses cross-site and non-JSON writes', async () => {
    const cross = await t.agent.post('/api/auth/logout').set('Sec-Fetch-Site', 'cross-site');
    assert.equal(cross.status, 403);
    assert.equal(cross.body.error.code, 'auth.csrf');
    const sameSite = await t.agent.patch('/api/account').set('Sec-Fetch-Site', 'same-site').send({ theme: 'dark' });
    assert.equal(sameSite.status, 403);
    const form = await t.agent.post('/api/auth/login').type('form').send({ username: 'admin', password: ADMIN.password });
    assert.equal(form.status, 415);
    const text = await t.agent.post('/api/auth/login').set('Content-Type', 'text/plain').send('{"username":"admin"}');
    assert.equal(text.status, 415);
    const ok = await t.agent.patch('/api/account').set('Sec-Fetch-Site', 'same-origin').send({ theme: 'dark' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.theme, 'dark');
  });

  it('password change revokes other sessions', async () => {
    const other = createAgentLogin(t);
    const otherAgent = await other;
    assert.equal((await otherAgent.get('/api/auth/me')).status, 200);
    const wrong = await t.agent.post('/api/account/password').send({ currentPassword: 'nope-nope-nope', newPassword: 'another-long-password' });
    assert.equal(wrong.status, 400);
    const res = await t.agent.post('/api/account/password').send({ currentPassword: ADMIN.password, newPassword: 'another-long-password' });
    assert.equal(res.status, 204);
    assert.equal((await t.agent.get('/api/auth/me')).status, 200);
    assert.equal((await otherAgent.get('/api/auth/me')).status, 401);
  });

  it('sets security headers', async () => {
    const res = await t.request.get('/api/health');
    assert.match(String(res.headers['content-security-policy']), /default-src 'self'/);
    assert.match(String(res.headers['content-security-policy']), /script-src 'self'(;|$)/);
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['x-powered-by'], undefined);
  });
});

async function createAgentLogin(t: TestApp) {
  const { default: supertest } = await import('supertest');
  const { createApp } = await import('../src/app.js');
  const agent = supertest.agent(createApp(t.ctx));
  const res = await agent.post('/api/auth/login').send({ username: ADMIN.username, password: ADMIN.password });
  assert.equal(res.status, 200);
  return agent;
}

describe('login rate limiting and bans', () => {
  it('returns 429 with retryAfter after 5 failures for a username', async () => {
    const t = createTestApp();
    try {
      await t.request.post('/api/setup/complete').send(setupBody());
      for (let i = 0; i < 5; i++) {
        const r = await t.request.post('/api/auth/login').send({ username: 'admin', password: `wrong-${i}-xxxxxx` });
        assert.equal(r.status, 401);
      }
      const limited = await t.request.post('/api/auth/login').send({ username: 'admin', password: ADMIN.password });
      assert.equal(limited.status, 429);
      assert.equal(limited.body.error.code, 'auth.rate_limited');
      assert.ok(limited.body.error.details.retryAfter > 0);
      assert.ok(Number(limited.headers['retry-after']) > 0);
      const failed = t.ctx.audit.list(50).filter((e) => e.action === 'auth.login_failed');
      assert.equal(failed.length, 5);
    } finally {
      t.close();
    }
  });

  it('bans a non-loopback IP after repeated abuse', async () => {
    const t = createTestApp({
      loginGuard: { maxFailures: 100, windowMs: 60_000, banThreshold: 3, banWindowMs: 60_000, banDurationMs: 60_000 },
    });
    try {
      for (let i = 0; i < 3; i++) t.ctx.loginGuard.fail('203.0.113.50', `user${i}`);
      assert.equal(t.ctx.bans.isBanned('203.0.113.50'), true);
      // loopback is never banned
      for (let i = 0; i < 5; i++) t.ctx.loginGuard.fail('127.0.0.1', `user${i}`);
      assert.equal(t.ctx.bans.isBanned('127.0.0.1'), false);
      // a ban on the client IP blocks the whole API
      t.ctx.bans.ban('127.0.0.1', 'test', Date.now() + 60_000);
      const res = await t.request.get('/api/health');
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'auth.ip_banned');
      t.ctx.bans.ban('127.0.0.1', 'test', Date.now() - 1);
      assert.equal((await t.request.get('/api/health')).status, 200);
    } finally {
      t.close();
    }
  });
});
