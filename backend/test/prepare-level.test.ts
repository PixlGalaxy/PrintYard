import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import supertest from 'supertest';
import { createApp } from '../src/app.js';
import { createTestApp, setupBody, type TestApp } from './helpers.js';

describe('Prepare settings level: user preference, admin default, setup', () => {
  const apps: TestApp[] = [];
  after(() => apps.forEach((a) => a.close()));
  const fresh = () => {
    const t = createTestApp();
    apps.push(t);
    return t;
  };

  it('setup without the field (older clients) defaults to basic', async () => {
    const t = fresh();
    assert.equal((await t.agent.post('/api/setup/complete').send(setupBody({ printer: null }))).status, 200);
    assert.equal(t.ctx.settings.get('workspace.defaultLevel'), 'basic');
    assert.deepEqual((await t.request.get('/api/config')).body.workspace, { defaultLevel: 'basic' });
  });

  it('setup stores the chosen default and rejects unknown levels', async () => {
    const t = fresh();
    const bad = await t.agent.post('/api/setup/complete').send(setupBody({ printer: null, workspace: { defaultLevel: 'guru' } }));
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'validation.failed');
    const ok = await t.agent.post('/api/setup/complete').send(setupBody({ printer: null, workspace: { defaultLevel: 'expert' } }));
    assert.equal(ok.status, 200);
    assert.equal(t.ctx.settings.get('workspace.defaultLevel'), 'expert');
    assert.deepEqual((await t.request.get('/api/config')).body.workspace, { defaultLevel: 'expert' });
  });

  it('admin setting validates and is exposed in the public config', async () => {
    const t = fresh();
    assert.equal((await t.agent.post('/api/setup/complete').send(setupBody({ printer: null }))).status, 200);
    assert.equal((await t.agent.get('/api/admin/settings')).body['workspace.defaultLevel'], 'basic');
    const bad = await t.agent.patch('/api/admin/settings').send({ 'workspace.defaultLevel': 'pro' });
    assert.equal(bad.status, 400);
    const ok = await t.agent.patch('/api/admin/settings').send({ 'workspace.defaultLevel': 'advanced' });
    assert.equal(ok.status, 200);
    assert.deepEqual((await t.request.get('/api/config')).body.workspace, { defaultLevel: 'advanced' });
  });

  it('user level defaults to null, stores valid values, clears with null and rejects others', async () => {
    const t = fresh();
    assert.equal((await t.agent.post('/api/setup/complete').send(setupBody({ printer: null }))).status, 200);
    assert.equal((await t.agent.post('/api/admin/users').send({ username: 'bob', password: 'bob-password-123', role: 'user' })).status, 201);
    const user = supertest.agent(createApp(t.ctx));
    assert.equal((await user.post('/api/auth/login').send({ username: 'bob', password: 'bob-password-123' })).status, 200);

    assert.equal((await user.get('/api/auth/me')).body.user.prepareLevel, null);
    for (const level of ['basic', 'advanced', 'expert']) {
      const r = await user.patch('/api/account').send({ prepareLevel: level });
      assert.equal(r.status, 200, level);
      assert.equal(r.body.user.prepareLevel, level);
      assert.equal((await user.get('/api/auth/me')).body.user.prepareLevel, level);
    }
    for (const prepareLevel of ['pro', 'simple', '', 1, true]) {
      const r = await user.patch('/api/account').send({ prepareLevel });
      assert.equal(r.status, 400, JSON.stringify(prepareLevel));
      assert.equal(r.body.error.code, 'validation.failed');
    }
    // The strict schema still refuses unknown neighbours.
    assert.equal((await user.patch('/api/account').send({ prepareLevel: 'basic', level: 'basic' })).status, 400);
    assert.equal((await user.get('/api/auth/me')).body.user.prepareLevel, 'expert');

    const cleared = await user.patch('/api/account').send({ prepareLevel: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.user.prepareLevel, null);
    // Other profile fields leave it untouched.
    await user.patch('/api/account').send({ prepareLevel: 'advanced' });
    await user.patch('/api/account').send({ language: 'es' });
    assert.equal((await user.get('/api/auth/me')).body.user.prepareLevel, 'advanced');
  });
});
