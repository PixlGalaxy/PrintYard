import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';
import { createB1App, makePng, type B1App } from './b1-helpers.js';
import { AVATAR_RATE, sniffImage } from '../src/modules/avatars/avatars.service.js';

/** PUT /api/account/avatar with same-origin proof. */
const put = (agent: B1App['alice'], data: Buffer, type: string) =>
  agent.put('/api/account/avatar').set('Sec-Fetch-Site', 'same-origin').set('Content-Type', type).send(data);

const solid = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 40, b: 90 } } });

describe('avatars', () => {
  let t: B1App;
  let jpegWithExif: Buffer;
  let webp: Buffer;
  let gif: Buffer;

  before(async () => {
    t = await createB1App();
    jpegWithExif = await solid(640, 480).jpeg().withMetadata({ exif: { IFD0: { Copyright: 'secret-camera-owner' } } }).toBuffer();
    webp = await solid(300, 500).webp().toBuffer();
    gif = await solid(64, 64).gif().toBuffer();
  });
  after(() => t.close());

  it('sniffs magic bytes', () => {
    assert.equal(sniffImage(makePng(2, 2)), 'png');
    assert.equal(sniffImage(jpegWithExif), 'jpeg');
    assert.equal(sniffImage(webp), 'webp');
    assert.equal(sniffImage(gif), 'gif');
    assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  });

  it('uploads PNG/JPEG/WebP/GIF, re-encodes to 256x256 WebP without metadata', async () => {
    for (const [data, type] of [
      [makePng(400, 200), 'image/png'],
      [webp, 'image/webp'],
      [gif, 'image/gif'],
      [jpegWithExif, 'image/jpeg'],
    ] as const) {
      const res = await put(t.alice, data, type);
      assert.equal(res.status, 200, `${type}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.user.avatarUrl, new RegExp(`^/api/avatars/${t.aliceId}\\?v=\\d+$`));
    }
    const file = t.ctx.avatars.absolutePath(t.aliceId);
    assert.ok(existsSync(file));
    const meta = await sharp(file).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.width, 256);
    assert.equal(meta.height, 256);
    assert.equal(meta.exif, undefined);
    const me = await t.alice.get('/api/auth/me');
    assert.ok(JSON.stringify(me.body).includes(`/api/avatars/${t.aliceId}?v=`));
  });

  it('serves with private cache headers + ETag, 304 on revalidation, auth required', async () => {
    const url = (await t.alice.get('/api/auth/me')).body.user.avatarUrl as string;
    const res = await t.bob.get(url);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/webp');
    assert.equal(res.headers['cache-control'], 'private, max-age=86400');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    const etag = res.headers.etag as string;
    assert.match(etag, /^"[\w-]+"$/);
    const again = await t.bob.get(url).set('If-None-Match', etag);
    assert.equal(again.status, 304);
    assert.equal((await t.request.get(url)).status, 401);
    assert.equal((await t.bob.get(`/api/avatars/${t.bobId}`)).status, 404);
    const dir = await t.bob.get('/api/avatars');
    assert.equal(dir.status, 200);
    assert.equal(dir.body.avatars[String(t.aliceId)], url);
    assert.equal(dir.body.avatars[String(t.bobId)], undefined);
  });

  it('rejects invalid images, mismatched content, oversize and missing CSRF proof', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    let res = await put(t.bob, svg, 'image/png');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'avatar.invalid_image');
    // Magic bytes say PNG but the rest is garbage.
    res = await put(t.bob, Buffer.concat([makePng(2, 2).subarray(0, 16), Buffer.alloc(200, 7)]), 'image/png');
    assert.equal(res.body.error.code, 'avatar.invalid_image');
    res = await put(t.bob, Buffer.alloc(0), 'image/png');
    assert.equal(res.status, 400);
    res = await put(t.bob, Buffer.alloc(5 * 1024 * 1024 + 10, 1), 'image/png');
    assert.equal(res.status, 413);
    assert.equal(res.body.error.code, 'avatar.too_large');
    res = await t.bob.put('/api/account/avatar').set('Content-Type', 'image/svg+xml').set('Sec-Fetch-Site', 'same-origin').send(svg);
    assert.equal(res.status, 415);
    // Image types still need same-origin proof (no Sec-Fetch-Site / Origin).
    res = await t.bob.put('/api/account/avatar').set('Content-Type', 'image/png').send(makePng(4, 4));
    assert.equal(res.status, 415);
    res = await t.bob.put('/api/account/avatar').set('Sec-Fetch-Site', 'cross-site').set('Content-Type', 'image/png').send(makePng(4, 4));
    assert.equal(res.status, 403);
    assert.equal(t.ctx.users.getUser(t.bobId).avatarUrl, null);
    assert.equal((await t.request.put('/api/account/avatar').set('Sec-Fetch-Site', 'same-origin').set('Content-Type', 'image/png').send(makePng(4, 4))).status, 401);
  });

  it('removes your own avatar', async () => {
    assert.equal((await put(t.bob, makePng(50, 50), 'image/png')).status, 200);
    const res = await t.bob.delete('/api/account/avatar');
    assert.equal(res.status, 200);
    assert.equal(res.body.user.avatarUrl, null);
    assert.ok(!existsSync(t.ctx.avatars.absolutePath(t.bobId)));
    assert.equal((await t.bob.delete('/api/account/avatar')).status, 200);
  });

  it('admin moderation: only admins, audited', async () => {
    assert.equal((await t.bob.delete(`/api/admin/users/${t.aliceId}/avatar`)).status, 403);
    const res = await t.admin.delete(`/api/admin/users/${t.aliceId}/avatar`);
    assert.equal(res.status, 200);
    assert.equal(res.body.avatarUrl, null);
    assert.ok(!existsSync(t.ctx.avatars.absolutePath(t.aliceId)));
    assert.equal((await t.admin.delete('/api/admin/users/9999/avatar')).status, 404);
    const audit = (await t.admin.get('/api/admin/audit?limit=100')).body.items as { action: string; target: string }[];
    assert.ok(audit.some((a) => a.action === 'user.avatar_remove' && a.target === 'alice'));
    assert.ok(audit.some((a) => a.action === 'account.avatar'));
  });

  it('deleting a user deletes the avatar file', async () => {
    assert.equal((await put(t.bob, makePng(50, 50), 'image/png')).status, 200);
    assert.ok(existsSync(t.ctx.avatars.absolutePath(t.bobId)));
    assert.equal((await t.admin.delete(`/api/admin/users/${t.bobId}?files=delete`)).status, 204);
    assert.ok(!existsSync(t.ctx.avatars.absolutePath(t.bobId)));
  });

  it('rate-limits uploads per user', async () => {
    const png = makePng(8, 8);
    const statuses: number[] = [];
    for (let i = 0; i < AVATAR_RATE.max + 2; i++) statuses.push((await put(t.admin, png, 'image/png')).status);
    const limited = await put(t.admin, png, 'image/png');
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, 'avatar.rate_limited');
    assert.ok(limited.headers['retry-after']);
    assert.equal(statuses.filter((s) => s === 200).length, AVATAR_RATE.max);
  });
});
