import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import supertest from 'supertest';
import { createApp } from '../src/app.js';
import { parseNav3d } from '../src/modules/account/nav3d.js';
import { readBedSurfaces } from '../src/modules/printers/printers.service.js';
import { createTestApp, setupBody, type TestApp } from './helpers.js';

const body = () => {
  const b = setupBody() as Record<string, unknown> & { printer: Record<string, unknown> };
  return { ...b, printer: { ...b.printer, host: '10.0.0.250' } };
};

describe('PREP-UX: 3D navigation prefs + owned bed surfaces', () => {
  let t: TestApp;
  let user: ReturnType<typeof supertest.agent>;
  let printerId: number;

  before(async () => {
    t = createTestApp();
    assert.equal((await t.agent.post('/api/setup/complete').send(body())).status, 200);
    const created = await t.agent.post('/api/admin/users').send({ username: 'bob', password: 'bob-password-123', role: 'user' });
    assert.equal(created.status, 201);
    user = supertest.agent(createApp(t.ctx));
    assert.equal((await user.post('/api/auth/login').send({ username: 'bob', password: 'bob-password-123' })).status, 200);
    printerId = (await t.agent.get('/api/admin/printers')).body[0].id;
  });
  after(() => t.close());

  it('nav3d defaults to null and stores a preset', async () => {
    assert.equal((await user.get('/api/auth/me')).body.user.nav3d, null);
    const r = await user.patch('/api/account').send({ nav3d: { preset: 'blender', orbitSpeed: 1.5, invertWheel: true } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.user.nav3d, { preset: 'blender', orbitSpeed: 1.5, invertWheel: true });
    assert.deepEqual((await user.get('/api/auth/me')).body.user.nav3d.preset, 'blender');
  });

  it('nav3d validates presets, custom mappings and ranges', async () => {
    const bad = [
      { preset: 'maya' },
      { preset: 'custom' },
      { preset: 'slicedock', orbitSpeed: 9 },
      { preset: 'slicedock', defaultView: 'bottom' },
      { preset: 'slicedock', extra: 1 },
      {
        preset: 'custom',
        custom: { orbit: { button: 'left', modifier: 'none' }, pan: { button: 'left', modifier: 'none' }, zoom: null, zoomToCursor: true },
      },
      {
        preset: 'custom',
        custom: { orbit: { button: 'left', modifier: 'meta' }, pan: { button: 'right', modifier: 'none' }, zoom: null, zoomToCursor: true },
      },
    ];
    for (const nav3d of bad) {
      const r = await user.patch('/api/account').send({ nav3d });
      assert.equal(r.status, 400, JSON.stringify(nav3d));
    }
    const custom = {
      preset: 'custom',
      custom: {
        orbit: { button: 'middle', modifier: 'none' },
        pan: { button: 'middle', modifier: 'shift' },
        zoom: { button: 'middle', modifier: 'ctrl' },
        zoomToCursor: false,
      },
      defaultView: 'top',
    };
    const ok = await user.patch('/api/account').send({ nav3d: custom });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.user.nav3d, custom);
    const reset = await user.patch('/api/account').send({ nav3d: null });
    assert.equal(reset.body.user.nav3d, null);
  });

  it('unreadable stored nav3d falls back to defaults', () => {
    assert.equal(parseNav3d('{oops'), null);
    assert.equal(parseNav3d('{"preset":"maya"}'), null);
    assert.deepEqual(parseNav3d('{"preset":"cad"}'), { preset: 'cad' });
  });

  it('printers default to the profile bed surface', async () => {
    const p = (await t.agent.get('/api/admin/printers')).body[0];
    assert.deepEqual(p.bedSurfaces, ['Epoxy Resin Plate']);
    assert.equal(p.defaultBedSurface, 'Epoxy Resin Plate');
    const pub = (await user.get('/api/printers')).body;
    assert.deepEqual((Array.isArray(pub) ? pub : pub.printers)[0].bedSurfaces, ['Epoxy Resin Plate']);
  });

  it('admin sets owned surfaces + default (validated, canonical order)', async () => {
    const r = await t.agent
      .patch(`/api/admin/printers/${printerId}`)
      .send({ bedSurfaces: ['Textured PEI Plate', 'Epoxy Resin Plate'], defaultBedSurface: 'Textured PEI Plate' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.bedSurfaces, ['Epoxy Resin Plate', 'Textured PEI Plate']);
    assert.equal(r.body.defaultBedSurface, 'Textured PEI Plate');

    // Removing the default surface moves the default to the first owned one
    const r2 = await t.agent.patch(`/api/admin/printers/${printerId}`).send({ bedSurfaces: ['Cool Plate', 'Epoxy Resin Plate'] });
    assert.deepEqual(r2.body.bedSurfaces, ['Epoxy Resin Plate', 'Cool Plate']);
    assert.equal(r2.body.defaultBedSurface, 'Epoxy Resin Plate');

    const bad = [
      { bedSurfaces: [] },
      { bedSurfaces: ['Glass'] },
      { bedSurfaces: ['Cool Plate', 'Cool Plate'] },
      { defaultBedSurface: 'High Temp Plate' }, // not owned
    ];
    for (const b of bad) assert.equal((await t.agent.patch(`/api/admin/printers/${printerId}`).send(b)).status, 400, JSON.stringify(b));
    assert.equal((await user.patch(`/api/admin/printers/${printerId}`).send({ bedSurfaces: ['Cool Plate'] })).status, 403);
  });

  it('readBedSurfaces tolerates bad stored data', () => {
    assert.deepEqual(readBedSurfaces('nope', null), { bedSurfaces: ['Epoxy Resin Plate'], defaultBedSurface: 'Epoxy Resin Plate' });
    assert.deepEqual(readBedSurfaces('["Glass","Cool Plate"]', 'Glass'), { bedSurfaces: ['Cool Plate'], defaultBedSurface: 'Cool Plate' });
    assert.deepEqual(readBedSurfaces(null, 'High Temp Plate'), { bedSurfaces: ['High Temp Plate'], defaultBedSurface: 'High Temp Plate' });
  });
});
