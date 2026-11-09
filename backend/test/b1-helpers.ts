import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import supertest from 'supertest';
import { createApp } from '../src/app.js';
import type { ContextOptions } from '../src/context.js';
import { createTestApp, setupBody, type TestApp } from './helpers.js';

export interface B1App extends TestApp {
  admin: ReturnType<typeof supertest.agent>;
  alice: ReturnType<typeof supertest.agent>;
  bob: ReturnType<typeof supertest.agent>;
  aliceId: number;
  bobId: number;
}

/** Setup + users alice and bob, each with a signed-in agent. */
export async function createB1App(context: ContextOptions = {}): Promise<B1App> {
  const t = createTestApp({ context });
  const setup = await t.agent.post('/api/setup/complete').send(setupBody());
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  const ids: number[] = [];
  const agents: ReturnType<typeof supertest.agent>[] = [];
  for (const name of ['alice', 'bob']) {
    const created = await t.agent.post('/api/admin/users').send({ username: name, password: `${name}-password-1`, role: 'user' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    ids.push(created.body.id);
    const agent = supertest.agent(createApp(t.ctx));
    const login = await agent.post('/api/auth/login').send({ username: name, password: `${name}-password-1` });
    assert.equal(login.status, 200);
    agents.push(agent);
  }
  return { ...t, admin: t.agent, alice: agents[0]!, bob: agents[1]!, aliceId: ids[0]!, bobId: ids[1]! };
}

/** Binary STL of an axis-aligned box from (0,0,0) to (sx,sy,sz). */
export function boxStl(sx = 20, sy = 20, sz = 20): Buffer {
  const v = [
    [0, 0, 0], [sx, 0, 0], [sx, sy, 0], [0, sy, 0], [0, 0, sz], [sx, 0, sz], [sx, sy, sz], [0, sy, sz],
  ];
  const tris = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  const buf = Buffer.alloc(84 + 50 * tris.length);
  buf.write('binary stl', 0);
  buf.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => {
    const o = 84 + i * 50;
    t.forEach((vi, k) => {
      const p = v[vi]!;
      buf.writeFloatLE(p[0]!, o + 12 + k * 12);
      buf.writeFloatLE(p[1]!, o + 16 + k * 12);
      buf.writeFloatLE(p[2]!, o + 20 + k * 12);
    });
  });
  return buf;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** A real (solid colour) RGB PNG of the given size. */
export function makePng(w: number, h: number, rgb: [number, number, number] = [56, 189, 248]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Uploads a buffer as `file` with same-origin proof. */
export function upload(agent: ReturnType<typeof supertest.agent>, data: Buffer, name: string, fields: Record<string, string> = {}) {
  let req = agent.post('/api/files').set('Sec-Fetch-Site', 'same-origin');
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  return req.attach('file', data, name);
}

export const IDENTITY_AT = (x: number, y: number, z = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

export function sceneFor(fileIds: number[], opts: { plate?: number[]; at?: [number, number][] } = {}) {
  return {
    version: 1 as const,
    printerModel: 'creality-k2se' as const,
    machinePresetId: 'Creality K2 SE 0.4 nozzle',
    processPresetId: '0.20mm Standard @Creality K2 SE 0.4 nozzle',
    processOverrides: { layer_height: '0.16' },
    filaments: [{ slot: 1, presetId: 'Hyper PLA @Creality K2 SE 0.4 nozzle', color: '#38BDF8' }],
    plates: [{ index: 0 }, { index: 1 }],
    objects: fileIds.map((fileId, i) => ({
      id: `o${i}`,
      fileId,
      name: `obj${i}`,
      plate: opts.plate?.[i] ?? 0,
      transform: IDENTITY_AT(...(opts.at?.[i] ?? [50 + i * 30, 50])),
      filamentSlot: 1,
      overrides: {},
    })),
  };
}
