import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createTestApp, setupBody, type TestApp } from './helpers.js';

describe('brand: manifest, apple-touch-icon and push icons follow the global skin', () => {
  let t: TestApp;

  before(async () => {
    t = createTestApp();
    await t.agent.post('/api/setup/complete').send(setupBody());
  });
  after(() => t.close());

  it('serves the manifest with the default (sky) icon set, uncached', async () => {
    const res = await t.agent.get('/manifest.webmanifest');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] ?? '', /application\/manifest\+json/);
    assert.equal(res.headers['cache-control'], 'no-cache');
    const m = JSON.parse(res.text);
    assert.equal(m.name, 'PrintYard');
    assert.equal(m.theme_color, '#0f172a');
    assert.equal(m.icons.length, 4);
    for (const icon of m.icons) assert.match(icon.src, /^\/icons\/sky\/icon-(maskable-)?(192|512)\.png$/);
  });

  it('picks the skin the admin configured', async () => {
    assert.equal((await t.agent.patch('/api/admin/settings').send({ 'appearance.defaultSkin': 'sunset' })).status, 200);
    const m = JSON.parse((await t.agent.get('/manifest.webmanifest')).text);
    assert.deepEqual(
      m.icons.map((i: { src: string }) => i.src),
      ['/icons/sunset/icon-192.png', '/icons/sunset/icon-512.png', '/icons/sunset/icon-maskable-192.png', '/icons/sunset/icon-maskable-512.png'],
    );
    assert.equal(t.ctx.notifications.pushPayload('test', {}, 'en').icon, '/icons/sunset/icon-192.png');
  });

  it('serves the global skin apple-touch-icon, falling back to sky, 404 without a build', async () => {
    assert.equal((await t.agent.get('/apple-touch-icon.png')).status, 404);
    const icons = join(t.ctx.config.publicDir, 'icons');
    mkdirSync(join(icons, 'sky'), { recursive: true });
    writeFileSync(join(icons, 'sky', 'apple-touch-icon.png'), 'sky');
    const fallback = await t.agent.get('/apple-touch-icon.png').buffer(true);
    assert.equal(fallback.status, 200);
    assert.equal(fallback.body.toString(), 'sky');
    mkdirSync(join(icons, 'sunset'), { recursive: true });
    writeFileSync(join(icons, 'sunset', 'apple-touch-icon.png'), 'sunset');
    const res = await t.agent.get('/apple-touch-icon.png').buffer(true);
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'public, max-age=300');
    assert.equal(res.body.toString(), 'sunset');
  });
});
