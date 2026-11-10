import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';

/** Indexed triangle mesh in file units (mm). */
export interface Mesh {
  /** xyz per vertex */
  positions: Float32Array;
  /** 3 vertex indices per triangle */
  indices: Uint32Array;
}

export interface MeshStats {
  triangles: number;
  /** size along x, y, z (mm) */
  bbox: [number, number, number];
}

/** A file whose content does not match its extension. */
export class MeshFormatError extends Error {}

// ---- resource limits (security review #4/#5) ----
/** Largest mesh source read into memory: an STL/OBJ file, or all `.model` entries of a 3MF after inflating. */
export const MAX_MESH_SOURCE_BYTES = 512 * 1024 * 1024;
/** One inflated 3MF entry (a `.model` XML). Declared sizes can lie, so inflating counts bytes and aborts. */
export const MAX_ZIP_ENTRY_BYTES = 256 * 1024 * 1024;
/** Entries in an archive (3MF from slicers have a few dozen). */
export const MAX_ZIP_ENTRIES = 4096;
/** Triangles one loaded model may produce (after component expansion). */
export const MAX_MESH_TRIANGLES = 5_000_000;
/** Mesh/component instances a 3MF may expand to. */
export const MAX_3MF_INSTANCES = 10_000;
/** Component nesting below a build item. */
export const MAX_3MF_DEPTH = 4;

/**
 * Inflates the entries `want` selects from a ZIP file, streaming the archive and counting inflated bytes so a zip
 * bomb aborts early (per entry and in total) instead of filling memory. Entry count is capped too.
 */
export async function readZipEntries(
  path: string,
  want: (name: string) => boolean,
  limits: { maxEntryBytes?: number; maxTotalBytes?: number; maxEntries?: number } = {},
): Promise<Map<string, Uint8Array>> {
  const maxEntry = limits.maxEntryBytes ?? MAX_ZIP_ENTRY_BYTES;
  const maxTotal = limits.maxTotalBytes ?? MAX_MESH_SOURCE_BYTES;
  const maxEntries = limits.maxEntries ?? MAX_ZIP_ENTRIES;
  const out = new Map<string, Uint8Array>();
  let entries = 0;
  let total = 0;
  let error: Error | null = null;
  const unzip = new Unzip((file) => {
    if (error) return;
    if (++entries > maxEntries) {
      error = new MeshFormatError(`Archive has more than ${maxEntries} entries`);
      return;
    }
    if (!want(file.name)) return; // never started: skipped
    if (file.originalSize !== undefined && file.originalSize > maxEntry) {
      error = new MeshFormatError(`${file.name} is too large once unpacked`);
      return;
    }
    const chunks: Uint8Array[] = [];
    let n = 0;
    file.ondata = (err, data, final) => {
      if (error) return;
      if (err) {
        error = new MeshFormatError(`Cannot unpack ${file.name}: ${err.message}`);
        return;
      }
      n += data.length;
      total += data.length;
      if (n > maxEntry || total > maxTotal) {
        error = new MeshFormatError(`${file.name} is too large once unpacked`);
        try {
          file.terminate();
        } catch {
          /* already finished */
        }
        return;
      }
      if (data.length) chunks.push(data);
      if (final) out.set(file.name, Buffer.concat(chunks));
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  try {
    // Small reads: one deflate chunk inflates to at most ~1000x its size before the counter sees it.
    for await (const chunk of createReadStream(path, { highWaterMark: 16 * 1024 })) {
      unzip.push(chunk as Buffer);
      if (error) break;
    }
    if (!error) unzip.push(new Uint8Array(0), true);
  } catch (err) {
    error ??= new MeshFormatError(`Not a readable ZIP archive: ${(err as Error).message}`);
  }
  if (error) throw error;
  return out;
}

async function assertSourceSize(path: string): Promise<void> {
  const { size } = await stat(path);
  if (size > MAX_MESH_SOURCE_BYTES) throw new MeshFormatError(`The model file is larger than ${MAX_MESH_SOURCE_BYTES / 1048576} MB`);
}

const tooManyTriangles = () => new MeshFormatError(`The model has more than ${MAX_MESH_TRIANGLES.toLocaleString('en')} triangles`);

const round = (n: number) => Math.round(n * 1000) / 1000;

class BBox {
  min = [Infinity, Infinity, Infinity];
  max = [-Infinity, -Infinity, -Infinity];
  add(x: number, y: number, z: number): void {
    if (x < this.min[0]!) this.min[0] = x;
    if (y < this.min[1]!) this.min[1] = y;
    if (z < this.min[2]!) this.min[2] = z;
    if (x > this.max[0]!) this.max[0] = x;
    if (y > this.max[1]!) this.max[1] = y;
    if (z > this.max[2]!) this.max[2] = z;
  }
  size(): [number, number, number] {
    if (this.min[0] === Infinity) return [0, 0, 0];
    return [round(this.max[0]! - this.min[0]!), round(this.max[1]! - this.min[1]!), round(this.max[2]! - this.min[2]!)];
  }
}

/** Binary STL iff the size matches 84 + 50·n for the header's triangle count. */
async function stlIsBinary(path: string): Promise<{ binary: boolean; count: number; size: number }> {
  const { size } = await stat(path);
  const fh = await open(path, 'r');
  try {
    const head = Buffer.alloc(84);
    const { bytesRead } = await fh.read(head, 0, 84, 0);
    if (bytesRead === 84) {
      const count = head.readUInt32LE(80);
      if (84 + 50 * count === size) return { binary: true, count, size };
    }
    return { binary: false, count: 0, size };
  } finally {
    await fh.close();
  }
}

/** Cheap streaming pass over an STL (binary or ASCII). */
export async function stlStats(path: string): Promise<MeshStats> {
  const info = await stlIsBinary(path);
  const box = new BBox();
  if (info.binary) {
    let carry: Buffer = Buffer.alloc(0);
    let offset = 0;
    for await (const chunk of createReadStream(path, { start: 84, highWaterMark: 50 * 4096 })) {
      const buf = carry.length ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer);
      offset = 0;
      while (offset + 50 <= buf.length) {
        for (let v = 0; v < 3; v++) {
          const o = offset + 12 + v * 12;
          box.add(buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8));
        }
        offset += 50;
      }
      carry = buf.subarray(offset);
    }
    return { triangles: info.count, bbox: box.size() };
  }
  let triangles = 0;
  let vertices = 0;
  let first = true;
  const rl = createInterface({ input: createReadStream(path, { encoding: 'latin1' }), crlfDelay: Infinity });
  for await (const raw of rl) {
    const line = raw.trim();
    if (first && line !== '') {
      if (!/^solid\b/i.test(line)) {
        rl.close();
        throw new MeshFormatError('Not an STL file');
      }
      first = false;
      continue;
    }
    if (line.startsWith('vertex')) {
      const p = line.split(/\s+/);
      box.add(Number(p[1]), Number(p[2]), Number(p[3]));
      vertices++;
    } else if (line.startsWith('endfacet')) triangles++;
  }
  if (first || vertices === 0) throw new MeshFormatError('Not an STL file');
  return { triangles, bbox: box.size() };
}

/** Streaming pass over an OBJ: vertex bbox and triangle count (polygons fan-triangulated). */
export async function objStats(path: string): Promise<MeshStats> {
  const box = new BBox();
  let triangles = 0;
  let vertices = 0;
  const rl = createInterface({ input: createReadStream(path, { encoding: 'latin1' }), crlfDelay: Infinity });
  for await (const raw of rl) {
    if (raw.startsWith('v ')) {
      const p = raw.trim().split(/\s+/);
      box.add(Number(p[1]), Number(p[2]), Number(p[3]));
      vertices++;
    } else if (raw.startsWith('f ')) {
      const n = raw.trim().split(/\s+/).length - 1;
      if (n >= 3) triangles += n - 2;
    }
  }
  if (vertices === 0) throw new MeshFormatError('OBJ file has no vertices');
  return { triangles, bbox: box.size() };
}

/** Merges bit-identical vertices so the slicer sees a connected (manifold) mesh. */
class VertexWelder {
  private map = new Map<string, number>();
  private out: number[] = [];
  index(x: number, y: number, z: number): number {
    const key = `${x},${y},${z}`;
    let i = this.map.get(key);
    if (i === undefined) {
      i = this.out.length / 3;
      this.out.push(x, y, z);
      this.map.set(key, i);
    }
    return i;
  }
  positions(): Float32Array {
    return Float32Array.from(this.out);
  }
}

export async function loadStl(path: string): Promise<Mesh> {
  await assertSourceSize(path);
  const info = await stlIsBinary(path);
  if (info.binary && info.count > MAX_MESH_TRIANGLES) throw tooManyTriangles();
  const weld = new VertexWelder();
  const idx: number[] = [];
  if (info.binary) {
    const buf = await readFile(path);
    for (let t = 0; t < info.count; t++) {
      const base = 84 + t * 50 + 12;
      for (let v = 0; v < 3; v++) {
        const o = base + v * 12;
        idx.push(weld.index(buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)));
      }
    }
  } else {
    const rl = createInterface({ input: createReadStream(path, { encoding: 'latin1' }), crlfDelay: Infinity });
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line.startsWith('vertex')) continue;
      const p = line.split(/\s+/);
      // Round-trip through float32 like a binary STL so identical vertices weld.
      idx.push(weld.index(Math.fround(Number(p[1])), Math.fround(Number(p[2])), Math.fround(Number(p[3]))));
      if (idx.length > MAX_MESH_TRIANGLES * 3) {
        rl.close();
        throw tooManyTriangles();
      }
    }
    idx.length -= idx.length % 3;
  }
  return dropDegenerate({ positions: weld.positions(), indices: Uint32Array.from(idx) });
}

export async function loadObj(path: string): Promise<Mesh> {
  await assertSourceSize(path);
  const verts: number[] = [];
  const idx: number[] = [];
  const rl = createInterface({ input: createReadStream(path, { encoding: 'latin1' }), crlfDelay: Infinity });
  for await (const raw of rl) {
    if (raw.startsWith('v ')) {
      const p = raw.trim().split(/\s+/);
      verts.push(Number(p[1]), Number(p[2]), Number(p[3]));
    } else if (raw.startsWith('f ')) {
      const count = verts.length / 3;
      const refs = raw
        .trim()
        .split(/\s+/)
        .slice(1)
        .map((tok) => {
          const n = Number.parseInt(tok.split('/')[0]!, 10);
          return n < 0 ? count + n : n - 1;
        });
      if (refs.some((r) => !Number.isInteger(r) || r < 0 || r >= count)) continue;
      for (let i = 1; i + 1 < refs.length; i++) idx.push(refs[0]!, refs[i]!, refs[i + 1]!);
      if (idx.length > MAX_MESH_TRIANGLES * 3) {
        rl.close();
        throw tooManyTriangles();
      }
    }
  }
  return dropDegenerate({ positions: Float32Array.from(verts), indices: Uint32Array.from(idx) });
}

// ---- 3MF (as a model source) ----

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return m?.[1];
};

/** 3MF 3x4 "m00 m01 m02 m10 … m32" (row vectors) → column-major 4x4. */
export function parse3mfTransform(s: string | undefined): number[] {
  const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (!s) return id;
  const v = s.trim().split(/\s+/).map(Number);
  if (v.length !== 12 || v.some((n) => !Number.isFinite(n))) return id;
  // 3MF: point' = point · M (row vector); columns of our matrix are its first three rows.
  return [v[0]!, v[1]!, v[2]!, 0, v[3]!, v[4]!, v[5]!, 0, v[6]!, v[7]!, v[8]!, 0, v[9]!, v[10]!, v[11]!, 1];
}

export function mulMat(a: number[], b: number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  return out;
}

interface Obj3mf {
  mesh?: { verts: number[]; tris: number[] };
  /** load3mf: vertex index → welded index for the current instance (`stamp === gen`). */
  weldCache?: { stamp: Uint32Array; value: Uint32Array; gen: number };
  components: { path?: string; objectId: string; transform: number[] }[];
}

function parseModelXml(xml: string): { objects: Map<string, Obj3mf>; build: { objectId: string; path?: string; transform: number[] }[] } {
  const objects = new Map<string, Obj3mf>();
  const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  for (let m = objRe.exec(xml); m; m = objRe.exec(xml)) {
    const id = attr(m[1]!, 'id');
    if (!id) continue;
    const body = m[2]!;
    const o: Obj3mf = { components: [] };
    const meshStart = body.indexOf('<mesh');
    if (meshStart >= 0) {
      const verts: number[] = [];
      const tris: number[] = [];
      const vRe = /<vertex\b([^>]*)\/?>/g;
      for (let v = vRe.exec(body); v; v = vRe.exec(body)) {
        verts.push(Number(attr(v[1]!, 'x')), Number(attr(v[1]!, 'y')), Number(attr(v[1]!, 'z')));
      }
      const tRe = /<triangle\b([^>]*)\/?>/g;
      for (let t = tRe.exec(body); t; t = tRe.exec(body)) {
        tris.push(Number(attr(t[1]!, 'v1')), Number(attr(t[1]!, 'v2')), Number(attr(t[1]!, 'v3')));
      }
      o.mesh = { verts, tris };
    }
    const cRe = /<component\b([^>]*)\/?>/g;
    for (let c = cRe.exec(body); c; c = cRe.exec(body)) {
      const objectId = attr(c[1]!, 'objectid');
      if (!objectId) continue;
      const path = attr(c[1]!, 'p:path');
      o.components.push({ objectId, ...(path && { path }), transform: parse3mfTransform(attr(c[1]!, 'transform')) });
    }
    objects.set(id, o);
  }
  const build: { objectId: string; path?: string; transform: number[] }[] = [];
  const iRe = /<item\b([^>]*)\/?>/g;
  const buildSection = /<build\b[\s\S]*?<\/build>/.exec(xml)?.[0] ?? '';
  for (let i = iRe.exec(buildSection); i; i = iRe.exec(buildSection)) {
    const objectId = attr(i[1]!, 'objectid');
    if (!objectId) continue;
    const path = attr(i[1]!, 'p:path');
    build.push({ objectId, ...(path && { path }), transform: parse3mfTransform(attr(i[1]!, 'transform')) });
  }
  return { objects, build };
}

/**
 * Loads every build item of a 3MF as one merged mesh, with build/component transforms applied (what three's
 * 3MFLoader shows). Bounded work: entries are inflated with byte limits, component nesting is limited to
 * MAX_3MF_DEPTH with cycle detection, and the expansion stops with an error past MAX_3MF_INSTANCES instances or
 * MAX_MESH_TRIANGLES triangles (a 544-byte file could otherwise expand to K^8 copies). Yields to the event loop
 * while expanding.
 */
export async function load3mf(path: string): Promise<Mesh> {
  const zip = await readZipEntries(path, (n) => n.toLowerCase().endsWith('.model'));
  const decoder = new TextDecoder();
  const models = new Map<string, ReturnType<typeof parseModelXml>>();
  const modelAt = (p: string) => {
    const key = p.replace(/^\//, '');
    let m = models.get(key);
    if (!m) {
      const entry = [...zip.entries()].find(([n]) => n.toLowerCase() === key.toLowerCase());
      if (!entry) return null;
      m = parseModelXml(decoder.decode(entry[1]));
      models.set(key, m);
    }
    return m;
  };
  const root = modelAt('3D/3dmodel.model');
  if (!root) throw new MeshFormatError('3MF has no 3D/3dmodel.model');
  const weld = new VertexWelder();
  const idx: number[] = [];
  let instances = 0;
  let triangles = 0;
  let workSinceYield = 0;
  const onPath = new Set<string>();
  const emit = async (modelPath: string, objectId: string, m: number[], depth: number): Promise<void> => {
    if (depth > MAX_3MF_DEPTH) throw new MeshFormatError(`3MF components are nested more than ${MAX_3MF_DEPTH} levels deep`);
    const key = `${modelPath.replace(/^\//, '').toLowerCase()}#${objectId}`;
    if (onPath.has(key)) throw new MeshFormatError('3MF components reference themselves');
    const model = modelAt(modelPath);
    const obj = model?.objects.get(objectId);
    if (!obj) return;
    if (++instances > MAX_3MF_INSTANCES) throw new MeshFormatError(`3MF expands to more than ${MAX_3MF_INSTANCES} objects`);
    if (obj.mesh) {
      const { verts, tris } = obj.mesh;
      triangles += tris.length / 3;
      if (triangles > MAX_MESH_TRIANGLES) throw tooManyTriangles();
      // Only vertices a triangle uses are transformed and welded, so the work per instance follows its triangles
      // (bounded by MAX_MESH_TRIANGLES). Welding every listed vertex let a 30 KB file with many unused vertices ×
      // 10 000 instances weld ~18 M unique points (~1.7 GB). The per-object cache is stamped per instance.
      const nVerts = Math.floor(verts.length / 3);
      const cache = (obj.weldCache ??= { stamp: new Uint32Array(nVerts), value: new Uint32Array(nVerts), gen: 0 });
      const gen = ++cache.gen;
      let ok = true;
      for (const t of tris) {
        if (!Number.isInteger(t) || t < 0 || t >= nVerts) {
          ok = false;
          break;
        }
        let v: number;
        if (cache.stamp[t] === gen) v = cache.value[t]!;
        else {
          const x = verts[t * 3]!;
          const y = verts[t * 3 + 1]!;
          const z = verts[t * 3 + 2]!;
          v = weld.index(
            Math.fround(m[0]! * x + m[4]! * y + m[8]! * z + m[12]!),
            Math.fround(m[1]! * x + m[5]! * y + m[9]! * z + m[13]!),
            Math.fround(m[2]! * x + m[6]! * y + m[10]! * z + m[14]!),
          );
          cache.stamp[t] = gen;
          cache.value[t] = v;
        }
        idx.push(v);
      }
      if (!ok) idx.length -= idx.length % 3;
      workSinceYield += tris.length;
      if (workSinceYield > 300_000) {
        workSinceYield = 0;
        await yieldToLoop();
      }
    }
    onPath.add(key);
    try {
      for (const c of obj.components) await emit(c.path ?? modelPath, c.objectId, mulMat(m, c.transform), depth + 1);
    } finally {
      onPath.delete(key);
    }
  };
  for (const item of root.build) await emit(item.path ?? '3D/3dmodel.model', item.objectId, item.transform, 0);
  if (idx.length === 0) throw new MeshFormatError('3MF has no printable mesh');
  return dropDegenerate({ positions: weld.positions(), indices: Uint32Array.from(idx) });
}

function dropDegenerate(mesh: Mesh): Mesh {
  const { indices } = mesh;
  const keep: number[] = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i]!;
    const b = indices[i + 1]!;
    const c = indices[i + 2]!;
    if (a !== b && b !== c && a !== c) keep.push(a, b, c);
  }
  if (keep.length === 0) throw new MeshFormatError('Mesh has no triangles');
  return keep.length === indices.length ? mesh : { positions: mesh.positions, indices: Uint32Array.from(keep) };
}

export async function loadMesh(path: string, ext: string): Promise<Mesh> {
  switch (ext) {
    case 'stl':
      return loadStl(path);
    case 'obj':
      return loadObj(path);
    case '3mf':
      return load3mf(path);
    default:
      throw new MeshFormatError(`Cannot load a mesh from .${ext}`);
  }
}

/** Builds an axis-aligned box mesh (smoke tests, fake engine). */
export function boxMesh(sx: number, sy: number, sz: number): Mesh {
  const positions = Float32Array.from([
    0, 0, 0, sx, 0, 0, sx, sy, 0, 0, sy, 0, 0, 0, sz, sx, 0, sz, sx, sy, sz, 0, sy, sz,
  ]);
  // Outward-facing (counter-clockwise seen from outside).
  const indices = Uint32Array.from([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]);
  return { positions, indices };
}
