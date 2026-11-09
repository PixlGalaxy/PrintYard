import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { boxStl, createB1App, sceneFor, upload, type B1App } from './b1-helpers.js';

describe('admin user deletion (?files=delete|transfer)', () => {
  let t: B1App;
  const adminId = 1;
  const userDir = (id: number) => join(t.ctx.config.dataRoot, 'users', String(id));
  const insertPrint = (userId: number, username: string, state: string) =>
    Number(
      t.ctx.db
        .prepare(`INSERT INTO prints (user_id, username, printer_id, file_id, file_name, state, created_at) VALUES (?, ?, 1, 1, 'x.gcode', ?, ?)`)
        .run(userId, username, state, Date.now()).lastInsertRowid,
    );

  before(async () => {
    t = await createB1App();
    t.ctx.settings.patch({ 'files.retention.keep': 100 });
  });
  after(() => t.close());

  it('transfer: moves files to the acting admin, keeps names unique, keeps print history', async () => {
    await upload(t.admin, boxStl(), 'cube.stl');
    const a1 = (await upload(t.alice, boxStl(), 'cube.stl')).body;
    const a2 = (await upload(t.alice, boxStl(10, 10, 10), 'small.stl', { visibility: 'shared' })).body;
    const project = await t.alice.post('/api/projects').send({ name: 'Alice project', scene: sceneFor([a1.id]) });
    assert.equal(project.status, 201, JSON.stringify(project.body));
    const done = insertPrint(t.aliceId, 'alice', 'done');
    const pending = insertPrint(t.aliceId, 'alice', 'pending');
    assert.ok(existsSync(userDir(t.aliceId)));

    const res = await t.admin.delete(`/api/admin/users/${t.aliceId}?files=transfer`);
    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.ok(!existsSync(userDir(t.aliceId)));

    const mine = (await t.admin.get('/api/files?scope=private')).body as { id: number; name: string; ownerId: number; pinned: boolean }[];
    const moved = mine.find((f) => f.id === a1.id)!;
    assert.equal(moved.name, 'cube (alice).stl');
    assert.equal(moved.ownerId, adminId);
    assert.equal(moved.pinned, true);
    for (const id of [a1.id, a2.id, project.body.id]) {
      const row = t.ctx.files.getRow(id)!;
      assert.equal(row.owner_id, adminId);
      assert.match(row.stored_path, new RegExp(`^users/${adminId}/`));
      assert.ok(existsSync(t.ctx.files.absolutePath(row)), row.stored_path);
    }
    assert.equal(t.ctx.files.getRow(a2.id)!.visibility, 'shared');
    // The project still opens (its scene sidecar moved too) and its download works.
    assert.equal((await t.admin.get(`/api/projects/${project.body.id}`)).status, 200);
    assert.equal((await t.admin.get(`/api/files/${a1.id}/download`)).status, 200);

    const prints = (await t.admin.get('/api/prints?scope=all')).body as { id: number; userId: number | null; username: string; state: string; reason?: string }[];
    const h = prints.find((p) => p.id === done)!;
    assert.equal(h.userId, null);
    assert.equal(h.username, 'alice');
    const p = prints.find((x) => x.id === pending)!;
    assert.equal(p.state, 'cancelled');
    assert.equal(p.reason, 'user_deleted');
    const audit = (t.ctx.audit.list(100) as { action: string; meta: unknown }[]).find((e) => e.action === 'user.delete')!;
    assert.deepEqual(audit.meta, { id: t.aliceId, files: 'transfer', fileCount: 3, cancelledRequests: 1 });
  });

  it('delete: removes the files from disk and the database', async () => {
    const b = (await upload(t.bob, boxStl(), 'bob.stl')).body;
    const abs = t.ctx.files.absolutePath(t.ctx.files.getRow(b.id)!);
    assert.ok(existsSync(abs));
    insertPrint(t.bobId, 'bob', 'done');
    const res = await t.admin.delete(`/api/admin/users/${t.bobId}?files=delete`);
    assert.equal(res.status, 204);
    assert.ok(!existsSync(abs));
    assert.ok(!existsSync(userDir(t.bobId)));
    assert.equal(t.ctx.files.getRow(b.id), undefined);
    const prints = (await t.admin.get('/api/prints?scope=all')).body as { username: string }[];
    assert.ok(prints.some((p) => p.username === 'bob'));
  });

  it('validates the option and the guards', async () => {
    assert.equal((await t.admin.delete(`/api/admin/users/${adminId}?files=delete`)).body.error.code, 'users.cannot_delete_self');
    assert.equal((await t.admin.delete('/api/admin/users/9999?files=delete')).status, 404);
    const u = (await t.admin.post('/api/admin/users').send({ username: 'carol', password: 'carol-password-1', role: 'user' })).body;
    const missing = await t.admin.delete(`/api/admin/users/${u.id}`);
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'users.files_option_required');
    assert.equal((await t.admin.get('/api/admin/users')).body.some((x: { id: number }) => x.id === u.id), true);
  });
});
