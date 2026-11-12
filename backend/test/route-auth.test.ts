// Every API route, discovered from the real Express router (not a hand-kept list), must refuse anonymous callers,
// and every /admin route must refuse a normal user. A new route that forgets its guard fails here.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createRequire } from 'node:module';
import supertest from 'supertest';
import { createApp } from '../src/app.js';
import { ADMIN, createTestApp, setupBody, type TestApp } from './helpers.js';

type Layer = { route?: { path: string; methods: Record<string, boolean> }; handle: { stack?: Layer[] }; __path?: string | string[] };
// Express's own router package (a transitive dependency, untyped)
const Router = createRequire(import.meta.url)('router') as { prototype: unknown };
const proto = Router.prototype as {
  use: (...a: unknown[]) => unknown;
  route: (p: string) => unknown;
  stack: Layer[];
};

// Remember the mount path of every `use` layer (Express 5 does not keep it).
const origUse = proto.use;
proto.use = function (this: { stack: Layer[] }, ...args: unknown[]) {
  const before = this.stack.length;
  const out = origUse.apply(this, args);
  const path = typeof args[0] === 'string' || Array.isArray(args[0]) ? (args[0] as string | string[]) : '/';
  for (let i = before; i < this.stack.length; i++) this.stack[i]!.__path = path;
  return out;
};

interface Endpoint {
  method: string;
  path: string;
}
function collect(stack: Layer[], prefix: string, out: Endpoint[]) {
  for (const l of stack) {
    if (l.route) {
      for (const m of Object.keys(l.route.methods)) if (m !== '_all') out.push({ method: m.toUpperCase(), path: prefix + l.route.path });
    } else if (l.handle.stack) {
      const paths = Array.isArray(l.__path) ? l.__path : [l.__path ?? '/'];
      for (const p of paths) collect(l.handle.stack, prefix + (p === '/' ? '' : p), out);
    }
  }
}

/** Concrete URL: ids → 1, other params → a harmless word. */
const concrete = (p: string) => p.replace(/:(id|userId)\b/g, '1').replace(/:[A-Za-z]+/g, 'x');

/** Routes meant to be reachable without a session (path relative to /api). */
const PUBLIC = new Set([
  'GET /health',
  'GET /config',
  'GET /printer-models',
  'GET /printers',
  'GET /setup/status',
  'POST /setup/complete', // refused once setup is done (asserted below)
  'POST /setup/test-printer', // idem
  'POST /auth/login',
  'POST /auth/logout',
  'GET /auth/me',
]);

describe('route guards (every discovered API route)', () => {
  let t: TestApp;
  let user: ReturnType<typeof supertest.agent>;
  const endpoints: Endpoint[] = [];

  before(async () => {
    t = createTestApp();
    const app = createApp(t.ctx) as unknown as { router: { stack: Layer[] } };
    collect(app.router.stack, '', endpoints);
    await t.request.post('/api/setup/complete').send(setupBody()).expect(200);
    await t.agent.post('/api/auth/login').send({ username: ADMIN.username, password: ADMIN.password }).expect(200);
    await t.agent.post('/api/admin/users').send({ username: 'bob', email: 'bob@example.com', password: 'bob-password-123', role: 'user' }).expect(201);
    user = supertest.agent(createApp(t.ctx));
    await user.post('/api/auth/login').send({ username: 'bob', password: 'bob-password-123' }).expect(200);
  });
  after(() => {
    proto.use = origUse;
    t.close();
  });

  const api = () => endpoints.filter((e) => e.path.startsWith('/api/')).map((e) => ({ ...e, rel: e.path.slice(4) }));

  it('discovers the API routes', () => {
    assert.ok(api().length >= 90, `only ${api().length} routes discovered`);
    if (process.env.ROUTES_DEBUG) console.log(api().length, api().map((e) => `${e.method} ${e.rel}`).join(' | '));
  });

  it('anonymous callers get 401 on every non-public route', async () => {
    const leaks: string[] = [];
    for (const e of api()) {
      if (PUBLIC.has(`${e.method} ${e.rel}`)) continue;
      const res = await t.request[e.method.toLowerCase() as 'get'](concrete(e.path)).set('Content-Type', 'application/json').send(e.method === 'GET' ? undefined : '{}');
      if (res.status !== 401) leaks.push(`${e.method} ${e.path} → ${res.status}`);
    }
    assert.deepEqual(leaks, []);
  });

  it('a normal user gets 403 on every admin route', async () => {
    const leaks: string[] = [];
    for (const e of api()) {
      if (!e.rel.startsWith('/admin') && !/\/(approve|reject|pending)$/.test(e.rel)) continue;
      const res = await user[e.method.toLowerCase() as 'get'](concrete(e.path)).set('Content-Type', 'application/json').send(e.method === 'GET' ? undefined : '{}');
      if (res.status !== 403) leaks.push(`${e.method} ${e.path} → ${res.status}`);
    }
    assert.deepEqual(leaks, []);
  });

  it('setup cannot be run again once complete', async () => {
    await t.request.post('/api/setup/complete').send(setupBody({ admin: { username: 'evil', email: 'e@example.com', password: 'evil-password-1' } })).expect((r) => assert.ok(r.status >= 400, `status ${r.status}`));
    await t.request.post('/api/setup/test-printer').send({ model: 'creality-k2se', host: '10.0.0.1' }).expect((r) => assert.ok(r.status >= 400, `status ${r.status}`));
  });

  it('anonymous public endpoints expose no secrets', async () => {
    for (const p of ['/api/config', '/api/printers', '/api/setup/status', '/api/health']) {
      const body = JSON.stringify((await t.request.get(p)).body);
      assert.doesNotMatch(body, /password|secret|token|hash|192\.168\.8\.230|@example\.com/i, `${p}: ${body.slice(0, 200)}`);
    }
  });
});

describe('large JSON bodies', () => {
  let t: TestApp;
  before(async () => {
    t = createTestApp();
    await t.request.post('/api/setup/complete').send(setupBody()).expect(200);
    await t.agent.post('/api/auth/login').send({ username: ADMIN.username, password: ADMIN.password }).expect(200);
  });
  after(() => t.close());

  it('anonymous multi-MB bodies are not parsed (401, not 413), signed-in ones still are', async () => {
    const big = JSON.stringify({ name: 'x', scene: 'y'.repeat(3 * 1024 * 1024) });
    for (const p of ['/api/projects', '/api/slice', '/api/profile-files/import']) {
      // The server answers before reading the body, so the client may see the socket closed mid-upload
      // (EPIPE/ECONNRESET) instead of the 401: both mean the body was not parsed. A 413 would mean it was.
      const status = await t.request
        .post(p)
        .set('Content-Type', 'application/json')
        .send(big)
        .then(
          (r) => r.status,
          (err: { status?: number; code?: string }) => err.status ?? err.code ?? 'error',
        );
      assert.ok(status === 401 || status === 'EPIPE' || status === 'ECONNRESET', `${p}: ${String(status)}`);
    }
    // a signed-in 3 MB body reaches validation (400), it is not refused by the 1 MB default parser (413)
    const ok = await t.agent.post('/api/projects').set('Content-Type', 'application/json').send(big);
    assert.notEqual(ok.status, 413);
    assert.notEqual(ok.status, 401);
  });
});
