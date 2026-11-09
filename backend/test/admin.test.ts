import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import supertest from 'supertest';
import { createApp } from '../src/app.js';
import { ADMIN, createTestApp, setupBody, type TestApp } from './helpers.js';

describe('admin endpoints and guards', () => {
  let t: TestApp;
  let adminId: number;
  let user: ReturnType<typeof supertest.agent>;
  let userId: number;

  before(async () => {
    t = createTestApp();
    const res = await t.agent.post('/api/setup/complete').send(setupBody());
    adminId = res.body.user.id;
    const created = await t.agent
      .post('/api/admin/users')
      .send({ username: 'alice', email: 'alice@example.com', password: 'alice-password-1', role: 'user' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    userId = created.body.id;
    assert.deepEqual(created.body.limits, {
      enabled: false,
      maxGramsPerPrint: null,
      maxGramsPerMonth: null,
      maxHoursPerPrint: null,
      requiresApproval: false,
    });
    assert.equal(created.body.language, 'es'); // falls back to app.defaultLanguage
    user = supertest.agent(createApp(t.ctx));
    const login = await user.post('/api/auth/login').send({ username: 'alice', password: 'alice-password-1' });
    assert.equal(login.status, 200);
  });
  after(() => t.close());

  it('non-admins get 403 and anonymous 401 on /api/admin/*', async () => {
    assert.equal((await user.get('/api/admin/users')).status, 403);
    assert.equal((await user.get('/api/admin/settings')).status, 403);
    assert.equal((await t.request.get('/api/admin/users')).status, 401);
    assert.equal((await user.get('/api/printers')).status, 200);
  });

  it('rejects duplicate usernames (case-insensitive)', async () => {
    const dup = await t.agent.post('/api/admin/users').send({ username: 'ALICE', password: 'alice-password-1', role: 'user' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'users.username_taken');
  });

  it('cannot demote, deactivate or delete yourself / the last admin', async () => {
    const demote = await t.agent.patch(`/api/admin/users/${adminId}`).send({ role: 'user' });
    assert.equal(demote.status, 403);
    assert.equal(demote.body.error.code, 'users.cannot_modify_self');
    const deactivate = await t.agent.patch(`/api/admin/users/${adminId}`).send({ isActive: false });
    assert.equal(deactivate.status, 403);
    const del = await t.agent.delete(`/api/admin/users/${adminId}`);
    assert.equal(del.status, 403);
    assert.equal(del.body.error.code, 'users.cannot_delete_self');

    // Promote alice, then she cannot remove the only *other* admin once she is the last active one.
    const promote = await t.agent.patch(`/api/admin/users/${userId}`).send({ role: 'admin' });
    assert.equal(promote.status, 200);
    assert.equal(promote.body.role, 'admin');
    const aliceDemotesAdmin = await user.patch(`/api/admin/users/${adminId}`).send({ isActive: false });
    assert.equal(aliceDemotesAdmin.status, 200);
    // Now alice is the last active admin: the original admin's session was revoked, so use the store directly.
    assert.throws(() => t.ctx.users.adminUpdate(adminId, userId, { role: 'user' }), /At least one active admin/);
    assert.throws(() => t.ctx.users.delete(adminId, userId), /At least one active admin/);
    // Restore.
    t.ctx.users.adminUpdate(userId, adminId, { isActive: true });
    const back = await t.agent.post('/api/auth/login').send({ username: ADMIN.username, password: ADMIN.password });
    assert.equal(back.status, 200);
    const demoteAlice = await t.agent.patch(`/api/admin/users/${userId}`).send({ role: 'user' });
    assert.equal(demoteAlice.status, 200);
  });

  it('validates PATCH bodies strictly', async () => {
    const res = await t.agent.patch(`/api/admin/users/${userId}`).send({ role: 'root' });
    assert.equal(res.status, 400);
    const unknown = await t.agent.patch(`/api/admin/users/${userId}`).send({ password_hash: 'x' });
    assert.equal(unknown.status, 400);
    assert.equal((await t.agent.patch('/api/admin/users/99999').send({ language: 'en' })).status, 404);
    assert.equal((await t.agent.patch('/api/admin/users/abc').send({ language: 'en' })).status, 404);
  });

  it('updates limits', async () => {
    const limits = { enabled: true, maxGramsPerPrint: 250, maxGramsPerMonth: 1000, maxHoursPerPrint: 8, requiresApproval: true };
    const res = await t.agent.put(`/api/admin/users/${userId}/limits`).send(limits);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.limits, limits);
    const bad = await t.agent.put(`/api/admin/users/${userId}/limits`).send({ ...limits, maxGramsPerPrint: -1 });
    assert.equal(bad.status, 400);
  });

  it('admin password reset revokes that user’s sessions', async () => {
    assert.equal((await user.get('/api/auth/me')).status, 200);
    const res = await t.agent.post(`/api/admin/users/${userId}/password`).send({ newPassword: 'alice-new-password' });
    assert.equal(res.status, 204);
    assert.equal((await user.get('/api/auth/me')).status, 401);
    const relog = await user.post('/api/auth/login').send({ username: 'alice', password: 'alice-new-password' });
    assert.equal(relog.status, 200);
  });

  it('deactivated users are signed out and cannot log in', async () => {
    const res = await t.agent.patch(`/api/admin/users/${userId}`).send({ isActive: false });
    assert.equal(res.status, 200);
    assert.equal((await user.get('/api/auth/me')).status, 401);
    const login = await user.post('/api/auth/login').send({ username: 'alice', password: 'alice-new-password' });
    assert.equal(login.status, 403);
    assert.equal(login.body.error.code, 'auth.account_disabled');
  });

  it('settings: GET merged defaults, PATCH validated', async () => {
    const get = await t.agent.get('/api/admin/settings');
    assert.equal(get.body['exposure.mode'], 'nginx');
    assert.equal(get.body['security.sessionHours'], 168);
    const patch = await t.agent.patch('/api/admin/settings').send({ 'limits.costPerKg': 22.5, 'limits.currency': 'eur' });
    assert.equal(patch.status, 200);
    assert.equal(patch.body['limits.costPerKg'], 22.5);
    assert.equal(patch.body['limits.currency'], 'EUR');
    const bad = await t.agent.patch('/api/admin/settings').send({ 'exposure.mode': 'apache' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'validation.failed');
    assert.equal(bad.body.error.details[0].key, 'exposure.mode');
  });

  it('printers CRUD + test', async () => {
    const created = await t.agent
      .post('/api/admin/printers')
      .send({ name: 'Second', model: 'creality-k2se', host: '192.168.8.231', staticIp: false, mac: 'FC-EE-28-13-E2-EE' });
    assert.equal(created.status, 201);
    assert.equal(created.body.mac, 'fc:ee:28:13:e2:ee');
    assert.equal(created.body.staticIp, false);
    const id = created.body.id;
    const upd = await t.agent.patch(`/api/admin/printers/${id}`).send({ name: 'Renamed' });
    assert.equal(upd.body.name, 'Renamed');
    assert.equal((await t.agent.get('/api/admin/printers')).body.length, 2);
    const test = await t.agent.post('/api/admin/printers/test').send({ model: 'creality-k2se', host: '10.9.9.9', staticIp: true });
    assert.deepEqual(test.body, { ok: false, error: 'printers.unreachable' });
    assert.equal((await t.agent.post('/api/admin/printers').send({ name: 'x', model: 'prusa-mk4', host: '1.2.3.4' })).status, 400);
    assert.equal((await t.agent.delete(`/api/admin/printers/${id}`)).status, 204);
    assert.equal((await t.agent.delete(`/api/admin/printers/${id}`)).status, 404);
  });

  it('system, logs and audit', async () => {
    const sys = await t.agent.get('/api/admin/system');
    assert.equal(sys.status, 200);
    for (const k of ['version', 'node', 'uptimeSec', 'memory', 'appdataRoot', 'dataRoot', 'dbSizeBytes', 'engine']) assert.ok(k in sys.body, k);
    assert.deepEqual(sys.body.engine, { selected: 'creality', installedVersion: null });
    const logs = await t.agent.get('/api/admin/logs?limit=5');
    assert.ok(Array.isArray(logs.body.lines));
    assert.ok(logs.body.lines.length <= 5);
    assert.equal((await t.agent.get('/api/admin/logs?limit=999999')).status, 400);
    const page1 = await t.agent.get('/api/admin/audit?limit=3');
    assert.equal(page1.body.items.length, 3);
    const lastId = page1.body.items[2].id;
    const page2 = await t.agent.get(`/api/admin/audit?limit=3&before=${lastId}`);
    assert.ok(page2.body.items.every((i: { id: number }) => i.id < lastId));
    const actions = new Set((await t.agent.get('/api/admin/audit?limit=1000')).body.items.map((i: { action: string }) => i.action));
    for (const a of ['setup.complete', 'user.create', 'user.update', 'user.limits', 'user.password_reset', 'settings.update', 'printer.create', 'printer.update', 'printer.delete', 'auth.login']) {
      assert.ok(actions.has(a), a);
    }
  });

  it('deleting a user works (not self, not last admin)', async () => {
    const noOption = await t.agent.delete(`/api/admin/users/${userId}`);
    assert.equal(noOption.status, 400);
    assert.equal(noOption.body.error.code, 'users.files_option_required');
    assert.equal((await t.agent.delete(`/api/admin/users/${userId}?files=bogus`)).status, 400);
    assert.equal((await t.agent.delete(`/api/admin/users/${userId}?files=delete`)).status, 204);
    assert.equal((await t.agent.get('/api/admin/users')).body.length, 1);
  });

  it('unknown API routes return the JSON error shape', async () => {
    const res = await t.agent.get('/api/nope');
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: { code: 'common.not_found', message: 'Not found' } });
  });
});
