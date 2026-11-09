import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import supertest from 'supertest';
import { createApp } from '../src/app.js';
import { createExclusive } from '../src/lib/exclusive.js';
import { isProbeableIp, resolveProbeHost } from '../src/lib/probe-host.js';
import { cleanUserText } from '../src/lib/sanitize.js';
import { AUDIT_RETENTION_MS } from '../src/modules/audit/audit.service.js';
import { IpBansService, LoginGuard, type LoginGuardOptions } from '../src/modules/auth/login-guard.js';
import { ADMIN, createTestApp, setupBody } from './helpers.js';

const GUARD: LoginGuardOptions = {
  maxFailures: 5,
  windowMs: 60_000,
  banThreshold: 20,
  banWindowMs: 60_000,
  banDurationMs: 60_000,
  ipMaxFailures: 10,
  userSoftThreshold: 5,
  userMaxFailures: 30,
  userDelayBaseMs: 100,
  userDelayMaxMs: 1000,
};

function withGuard<T>(opts: LoginGuardOptions, fn: (g: LoginGuard, bans: IpBansService) => T): T {
  const t = createTestApp();
  const guard = new LoginGuard(t.ctx.bans, opts);
  try {
    return fn(guard, t.ctx.bans);
  } finally {
    guard.stop();
    t.close();
  }
}

describe('login rate limit (#2): attempts are reserved before the password check', () => {
  it('40 parallel wrong logins: at most 5 reach the password check, the rest get 429', async () => {
    const t = createTestApp();
    try {
      await t.request.post('/api/setup/complete').send(setupBody());
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          t.request.post('/api/auth/login').send({ username: 'admin', password: `wrong-password-${i}` }),
        ),
      );
      const codes = results.map((r) => r.status);
      assert.equal(codes.filter((c) => c === 401).length, 5, codes.join(','));
      assert.equal(codes.filter((c) => c === 429).length, 35);
      assert.equal(t.ctx.audit.list(100).filter((e) => e.action === 'auth.login_failed').length, 5);
    } finally {
      t.close();
    }
  });

  it('a successful login rolls back its reservation and clears the (IP, username) counter', () =>
    withGuard(GUARD, (g) => {
      for (let i = 0; i < 4; i++) {
        const a = g.begin('203.0.113.7', 'admin');
        assert.ok(a.allowed);
        a.failed();
      }
      const ok = g.begin('203.0.113.7', 'admin');
      assert.ok(ok.allowed);
      ok.succeeded();
      for (let i = 0; i < 5; i++) {
        const a = g.begin('203.0.113.7', 'admin');
        assert.ok(a.allowed, `attempt ${i}`);
        a.failed();
      }
      assert.equal(g.begin('203.0.113.7', 'admin').allowed, false);
    }));
});

describe('per-username lockout (#3) and bans (#5)', () => {
  it('failures from many foreign IPs never lock the username out from the LAN or loopback', () =>
    withGuard(GUARD, (g) => {
      for (let i = 1; i <= 40; i++) g.fail(`203.0.113.${i}`, 'admin');
      assert.deepEqual(g.check('192.168.1.50', 'admin'), { allowed: true });
      assert.deepEqual(g.check('127.0.0.1', 'admin'), { allowed: true });
      const lan = g.begin('192.168.1.50', 'Admin');
      assert.ok(lan.allowed);
      assert.equal(lan.delayMs, 0);
      // a fresh public IP is past the hard per-username threshold → 429
      assert.equal(g.check('198.51.100.1', 'admin').allowed, false);
    }));

  it('public IPs get a progressive delay past the soft per-username threshold', () =>
    withGuard(GUARD, (g) => {
      const delays: number[] = [];
      for (let i = 1; i <= 9; i++) {
        const a = g.begin(`203.0.113.${i}`, 'admin');
        assert.ok(a.allowed);
        delays.push(a.delayMs);
        a.failed();
      }
      assert.deepEqual(delays, [0, 0, 0, 0, 0, 100, 200, 400, 800]);
      const capped = g.begin('203.0.113.99', 'admin');
      assert.ok(capped.allowed);
      assert.equal(capped.delayMs, 1000);
    }));

  it('the hard block is keyed on (IP, username); one IP spraying usernames hits the per-IP cap', () =>
    withGuard(GUARD, (g) => {
      for (let i = 0; i < 5; i++) g.fail('203.0.113.5', 'admin');
      assert.equal(g.check('203.0.113.5', 'admin').allowed, false);
      assert.equal(g.check('203.0.113.6', 'admin').allowed, true);
      assert.equal(g.check('203.0.113.5', 'bob').allowed, true);
      for (let i = 0; i < 5; i++) g.fail('203.0.113.5', `user${i}`);
      assert.equal(g.check('203.0.113.5', 'carol').allowed, false);
    }));

  it('private and loopback IPs are rate-limited but never banned', () =>
    withGuard({ ...GUARD, banThreshold: 3, maxFailures: 100, ipMaxFailures: 100 }, (g, bans) => {
      for (const ip of ['172.18.0.2', '192.168.1.9', '10.1.2.3', '127.0.0.1', 'fd00::5']) {
        for (let i = 0; i < 10; i++) g.fail(ip, `u${i}`);
        assert.equal(bans.isBanned(ip), false, ip);
      }
      for (let i = 0; i < 3; i++) g.fail('203.0.113.50', `u${i}`);
      assert.equal(bans.isBanned('203.0.113.50'), true);
    }));
});

describe('proxy headers in exposure mode "none" (#5)', () => {
  it('sets proxyHeadersSeen in /api/admin/system; changing the mode resets it', async () => {
    const t = createTestApp();
    try {
      const setup = await t.agent.post('/api/setup/complete').send(setupBody({ exposure: { mode: 'none' } }));
      assert.equal(setup.status, 200);
      assert.equal((await t.agent.get('/api/admin/system')).body.proxyHeadersSeen, false);
      await t.request.get('/api/health').set('X-Forwarded-For', '203.0.113.9');
      assert.equal((await t.agent.get('/api/admin/system')).body.proxyHeadersSeen, true);
      const patch = await t.agent.patch('/api/admin/settings').send({ 'exposure.mode': 'nginx' });
      assert.equal(patch.status, 200, JSON.stringify(patch.body));
      assert.equal((await t.agent.get('/api/admin/system')).body.proxyHeadersSeen, false);
    } finally {
      t.close();
    }
  });
});

describe('probe targets (#6)', () => {
  it('only RFC 1918 IPv4 is probeable', () => {
    for (const ip of ['10.0.0.1', '172.16.5.5', '172.31.255.254', '192.168.8.230', '::ffff:192.168.1.1']) {
      assert.equal(isProbeableIp(ip), true, ip);
    }
    for (const ip of ['127.0.0.1', '169.254.169.254', '224.0.0.1', '255.255.255.255', '0.0.0.0', '8.8.8.8', '100.64.0.1', '172.32.0.1', '::1', 'fd00::1', 'fe80::1']) {
      assert.equal(isProbeableIp(ip), false, ip);
    }
  });

  it('resolves hostnames once and requires every answer to be private', async () => {
    const lookup = (map: Record<string, string[]>) => async (h: string) => {
      const r = map[h];
      if (!r) throw new Error('ENOTFOUND');
      return r;
    };
    const dns = lookup({ 'k2se.lan': ['192.168.8.230'], 'evil.example': ['192.168.1.1', '93.184.216.34'], 'meta.example': ['169.254.169.254'] });
    assert.equal(await resolveProbeHost('k2se.lan', dns), '192.168.8.230');
    assert.equal(await resolveProbeHost('nowhere.lan', dns), null);
    await assert.rejects(resolveProbeHost('evil.example', dns), { code: 'printers.invalid_host' });
    await assert.rejects(resolveProbeHost('meta.example', dns), { code: 'printers.invalid_host' });
    await assert.rejects(resolveProbeHost('localhost', dns), { code: 'printers.invalid_host' });
    await assert.rejects(resolveProbeHost('127.0.0.1', dns), { code: 'printers.invalid_host' });
  });

  it('test endpoints reject loopback, link-local, multicast and public hosts with printers.invalid_host', async () => {
    const t = createTestApp();
    try {
      for (const host of ['127.0.0.1', '169.254.169.254', '224.0.0.251', '8.8.8.8', 'localhost', '::1']) {
        const r = await t.request.post('/api/setup/test-printer').send({ model: 'creality-k2se', host, staticIp: true });
        assert.equal(r.status, 400, host);
        assert.equal(r.body.error.code, 'printers.invalid_host', host);
      }
      const ok = await t.request.post('/api/setup/test-printer').send({ model: 'creality-k2se', host: '192.168.8.230', staticIp: true });
      assert.equal(ok.body.ok, true);
      await t.agent.post('/api/setup/complete').send(setupBody());
      const admin = await t.agent.post('/api/admin/printers/test').send({ model: 'creality-k2se', host: '169.254.169.254', staticIp: true });
      assert.equal(admin.status, 400);
      assert.equal(admin.body.error.code, 'printers.invalid_host');
    } finally {
      t.close();
    }
  });

  it('only one discovery sweep runs at a time', async () => {
    const run = createExclusive(() => Object.assign(new Error('busy'), { code: 'printers.discovery_busy' }));
    let release!: () => void;
    const first = run(() => new Promise<string>((r) => (release = () => r('done'))));
    await assert.rejects(run(async () => 'second'), { code: 'printers.discovery_busy' });
    release();
    assert.equal(await first, 'done');
    assert.equal(await run(async () => 'third'), 'third');
  });
});

describe('/api/setup/status after setup (#7)', () => {
  it('anonymous and non-admin callers get only { setupComplete: true }; admins get the details', async () => {
    const t = createTestApp();
    try {
      const before = await t.request.get('/api/setup/status');
      assert.equal(before.body.setupComplete, false);
      assert.ok('memoryLimitBytes' in before.body);
      await t.agent.post('/api/setup/complete').send(setupBody());
      assert.deepEqual((await t.request.get('/api/setup/status')).body, { setupComplete: true });
      const asAdmin = await t.agent.get('/api/setup/status');
      assert.equal(asAdmin.body.setupComplete, true);
      for (const k of ['lanAllowed', 'memoryLimitBytes', 'memoryOk', 'hostNetworkLikely']) assert.ok(k in asAdmin.body, k);
      await t.agent.post('/api/admin/users').send({ username: 'bob', password: 'bob-password-12', role: 'user' });
      const bob = supertest.agent(createApp(t.ctx));
      assert.equal((await bob.post('/api/auth/login').send({ username: 'bob', password: 'bob-password-12' })).status, 200);
      assert.deepEqual((await bob.get('/api/setup/status')).body, { setupComplete: true });
    } finally {
      t.close();
    }
  });
});

describe('audit hygiene (#8) and log injection', () => {
  it('purges entries older than 90 days', () => {
    const t = createTestApp();
    try {
      t.ctx.audit.log('auth.login', { username: 'new' });
      t.ctx.db
        .prepare('INSERT INTO audit_log (username, action, created_at) VALUES (?, ?, ?)')
        .run('old', 'auth.login', Date.now() - AUDIT_RETENTION_MS - 60_000);
      assert.equal(t.ctx.audit.purgeOlderThan(AUDIT_RETENTION_MS), 1);
      assert.deepEqual(t.ctx.audit.list(10).map((e) => e.username), ['new']);
    } finally {
      t.close();
    }
  });

  it('failed-login usernames are stripped of control characters and capped at 64 chars', async () => {
    const t = createTestApp();
    try {
      await t.request.post('/api/setup/complete').send(setupBody());
      const forged = 'x\r\n2026-01-01T00:00:00.000Z INFO  [auth] "admin" signed in\u001b[2J\u2028';
      const r = await t.request.post('/api/auth/login').send({ username: forged, password: 'whatever-password' });
      assert.equal(r.status, 401);
      const entry = t.ctx.audit.list(5).find((e) => e.action === 'auth.login_failed')!;
      assert.doesNotMatch(entry.username!, /[\u0000-\u001f\u007f\u2028\u2029]/);
      assert.equal(entry.username, entry.target);
      assert.equal(cleanUserText('a'.repeat(100)).length, 64);
      assert.equal(cleanUserText('ok\n\nname'), 'ok name');
      assert.equal((await t.request.post('/api/auth/login').send({ username: ADMIN.username, password: ADMIN.password })).status, 200);
    } finally {
      t.close();
    }
  });
});
