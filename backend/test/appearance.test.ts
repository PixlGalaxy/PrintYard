import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import supertest from 'supertest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { SKINS } from '../src/types.js';
import { createTestApp, setupBody, type TestApp } from './helpers.js';

describe('appearance: per-user mode/skin + admin defaults', () => {
  let t: TestApp;
  let user: ReturnType<typeof supertest.agent>;

  before(async () => {
    t = createTestApp();
    await t.agent.post('/api/setup/complete').send(setupBody());
    const created = await t.agent
      .post('/api/admin/users')
      .send({ username: 'bob', password: 'bob-password-123', role: 'user' });
    assert.equal(created.status, 201);
    user = supertest.agent(createApp(t.ctx));
    assert.equal((await user.post('/api/auth/login').send({ username: 'bob', password: 'bob-password-123' })).status, 200);
  });
  after(() => t.close());

  it('new users inherit the defaults (system / sky)', async () => {
    const me = await user.get('/api/auth/me');
    assert.equal(me.body.user.themeMode, null);
    assert.equal(me.body.user.skin, null);
    assert.equal(me.body.user.effectiveThemeMode, 'system');
    assert.equal(me.body.user.effectiveSkin, 'sky');
    assert.equal(me.body.user.theme, 'system');
  });

  it('admin defaults validate, show in /api/config and are followed by inheriting users', async () => {
    const bad = await t.agent.patch('/api/admin/settings').send({ 'appearance.defaultSkin': 'rainbow' });
    assert.equal(bad.status, 400);
    const badMode = await t.agent.patch('/api/admin/settings').send({ 'appearance.defaultMode': 'dim' });
    assert.equal(badMode.status, 400);
    const ok = await t.agent
      .patch('/api/admin/settings')
      .send({ 'appearance.defaultMode': 'dark', 'appearance.defaultSkin': 'forest' });
    assert.equal(ok.status, 200);
    const config = await t.request.get('/api/config');
    assert.deepEqual(config.body.appearance, { defaultMode: 'dark', defaultSkin: 'forest' });
    const me = await user.get('/api/auth/me');
    assert.equal(me.body.user.effectiveThemeMode, 'dark');
    assert.equal(me.body.user.effectiveSkin, 'forest');
  });

  it('explicit choices stick across default changes; null goes back to inheriting', async () => {
    const set = await user.patch('/api/account').send({ themeMode: 'light', skin: 'grape' });
    assert.equal(set.status, 200);
    assert.equal(set.body.user.themeMode, 'light');
    assert.equal(set.body.user.skin, 'grape');
    assert.equal(set.body.user.effectiveSkin, 'grape');
    await t.agent.patch('/api/admin/settings').send({ 'appearance.defaultSkin': 'crimson' });
    let me = await user.get('/api/auth/me');
    assert.equal(me.body.user.effectiveThemeMode, 'light');
    assert.equal(me.body.user.effectiveSkin, 'grape');

    const reset = await user.patch('/api/account').send({ skin: null });
    assert.equal(reset.body.user.skin, null);
    assert.equal(reset.body.user.themeMode, 'light'); // untouched
    me = await user.get('/api/auth/me');
    assert.equal(me.body.user.effectiveSkin, 'crimson');

    const resetMode = await user.patch('/api/account').send({ themeMode: null });
    assert.equal(resetMode.body.user.themeMode, null);
    assert.equal(resetMode.body.user.effectiveThemeMode, 'dark');
  });

  it('rejects unknown skins/modes and keeps the legacy `theme` field working', async () => {
    assert.equal((await user.patch('/api/account').send({ skin: 'rainbow' })).status, 400);
    assert.equal((await user.patch('/api/account').send({ themeMode: 'dim' })).status, 400);
    const legacy = await user.patch('/api/account').send({ theme: 'dark' });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.user.themeMode, 'dark');
    assert.equal(legacy.body.user.theme, 'dark');
  });

  it('every skin id is accepted', async () => {
    for (const skin of SKINS) assert.equal((await user.patch('/api/account').send({ skin })).status, 200, skin);
  });
});

describe('0004_appearance migration', () => {
  it('keeps explicit light/dark, maps the old "system" default to inherit', () => {
    const migrations = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
    const before = mkdtempSync(join(tmpdir(), 'slicedock-mig-'));
    for (const f of readdirSync(migrations).filter((f) => /^000[1-3]_/.test(f))) copyFileSync(join(migrations, f), join(before, f));
    const db = openDb(':memory:');
    try {
      runMigrations(db, before);
      const now = Date.now();
      const insert = db.prepare(
        `INSERT INTO users (username, password_hash, role, is_active, language, theme, created_at, updated_at)
         VALUES (?, 'x', 'user', 1, 'en', ?, ?, ?)`,
      );
      insert.run('a', 'dark', now, now);
      insert.run('b', 'system', now, now);
      runMigrations(db, migrations);
      const rows = db.prepare('SELECT username, theme_mode, skin FROM users ORDER BY username').all();
      assert.deepEqual(rows.map((r) => ({ ...(r as object) })), [
        { username: 'a', theme_mode: 'dark', skin: null },
        { username: 'b', theme_mode: null, skin: null },
      ]);
    } finally {
      db.close();
      rmSync(before, { recursive: true, force: true });
    }
  });
});
