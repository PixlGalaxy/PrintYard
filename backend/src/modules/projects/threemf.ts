import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { AppError } from '../../errors.js';
import type { Mesh } from '../files/mesh.js';
import type { RawPreset } from '../profiles/profiles.service.js';

/**
 * Writes a Creality Print 7.x project (.3mf) that the engine CLI loads as a native project: plates and transforms are
 * kept (no auto-arrange) and `project_settings.config` supplies the settings.
 *
 * Layout follows `src/libslic3r/Format/bbs_3mf.cpp` (exporter, non-split mode):
 * - `3D/3dmodel.model`: one mesh object per volume (vertices untransformed, volume matrix = identity), then one
 *   component object per scene object referencing it, then `<build>` items carrying the instance transform
 *   (3x4, column-major, translation last).
 * - `Metadata/model_settings.config`: per-object name/extruder/overrides, parts, and plates.
 * - `Metadata/project_settings.config`: flat JSON of the full config (machine + process + filament arrays).
 * - `Metadata/creality.config`: Company=Creality, Application=Creality_Print, AppVersion → `bbs_is_creality_3mf`.
 */

export interface BuildObject {
  name: string;
  mesh: Mesh;
  /** 16 numbers, column-major, mesh → plate-local bed coordinates (mm, Z up, origin = bed corner). */
  transform: number[];
  /** 1-based filament slot */
  extruder: number;
  /** per-object process overrides */
  overrides: Record<string, string>;
  /** 0-based plate index */
  plate: number;
}

export interface BuildPlate {
  /** 0-based */
  index: number;
  name?: string;
  bedType?: string;
}

export interface BuildProjectInput {
  objects: BuildObject[];
  plates: BuildPlate[];
  config: RawPreset;
  /** Engine version stamped into the file (major.minor must not exceed the engine's). */
  appVersion: string;
  /** printable width/depth for plate offsets */
  bed: { width: number; depth: number };
  /** Extra files to embed (e.g. `Metadata/plate_1.png`, `Metadata/slicedock_scene.json`). */
  extras?: { path: string; data: Uint8Array; compress?: boolean }[];
  /** Abort with `projects.too_large` once the output exceeds this many bytes. */
  maxBytes?: number;
}

export interface BuildResult {
  size: number;
}

const xmlEscape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

/** Formats a coordinate compactly with up to 6 decimals. */
const num = (n: number) => {
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? '0' : String(r);
};

/** Plate i (0-based) origin in Creality Print's logical bed layout (PartPlate.cpp, gap = 1/5). */
export function plateOrigin(index: number, plateCount: number, bed: { width: number; depth: number }): [number, number] {
  const cols = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, plateCount))));
  return [(index % cols) * bed.width * 1.2, -Math.floor(index / cols) * bed.depth * 1.2];
}

/** column-major 4x4 → `m00 m10 m20 m01 m11 m21 m02 m12 m22 tx ty tz` (bbs_3mf add_transformation). */
export function transformAttr(m: number[], dx = 0, dy = 0): string {
  return [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10], m[12]! + dx, m[13]! + dy, m[14]]
    .map((v) => num(v as number))
    .join(' ');
}

function contentTypes(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
    ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
    ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
    ' <Default Extension="png" ContentType="image/png"/>\n' +
    ' <Default Extension="gcode" ContentType="text/x.gcode"/>\n' +
    '</Types>'
  );
}

function rels(hasThumb: boolean): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
    ' <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n' +
    (hasThumb
      ? ' <Relationship Target="/Metadata/plate_1.png" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>\n'
      : '') +
    '</Relationships>'
  );
}

function crealityConfig(appVersion: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' +
    '    <metadata key="Company" value="Creality"/>\n' +
    '    <metadata key="Application" value="Creality_Print"/>\n' +
    `    <metadata key="AppVersion" value="${xmlEscape(appVersion)}"/>\n` +
    '    <metadata key="AppStage" value="Release"/>\n' +
    '    <metadata key="FileVersion" value="1"/>\n' +
    '</config>\n'
  );
}

/** ids: mesh object = 2k+1, component object = 2k+2 (exporter numbering: volumes first, then the object). */
const meshId = (i: number) => 2 * i + 1;
const objectId = (i: number) => 2 * i + 2;

function modelSettings(input: BuildProjectInput): string {
  let s = '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n';
  input.objects.forEach((o, i) => {
    s += `  <object id="${objectId(i)}">\n`;
    s += `    <metadata key="name" value="${xmlEscape(o.name)}"/>\n`;
    s += `    <metadata key="extruder" value="${o.extruder}"/>\n`;
    for (const [k, v] of Object.entries(o.overrides)) s += `    <metadata key="${xmlEscape(k)}" value="${xmlEscape(v)}"/>\n`;
    s += `    <part id="${meshId(i)}" subtype="normal_part">\n`;
    s += `      <metadata key="name" value="${xmlEscape(o.name)}"/>\n`;
    s += '      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n';
    s += `      <metadata key="extruder" value="${o.extruder}"/>\n`;
    s += '      <mesh_stat edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>\n';
    s += '    </part>\n  </object>\n';
  });
  for (const plate of input.plates) {
    s += '  <plate>\n';
    s += `    <metadata key="plater_id" value="${plate.index + 1}"/>\n`;
    s += `    <metadata key="plater_name" value="${xmlEscape(plate.name ?? '')}"/>\n`;
    s += '    <metadata key="locked" value="false"/>\n';
    if (plate.bedType) s += `    <metadata key="bed_type" value="${xmlEscape(plate.bedType)}"/>\n`;
    input.objects.forEach((o, i) => {
      if (o.plate !== plate.index) return;
      s += '    <model_instance>\n';
      s += `      <metadata key="object_id" value="${objectId(i)}"/>\n`;
      s += '      <metadata key="instance_id" value="0"/>\n';
      s += `      <metadata key="identify_id" value="${100 + i}"/>\n`;
      s += '    </model_instance>\n';
    });
    s += '  </plate>\n';
  }
  s += '</config>\n';
  return s;
}

function projectSettings(config: RawPreset, appVersion: string): string {
  return JSON.stringify({ ...config, name: 'project_settings', from: 'project', version: appVersion }, null, 4) + '\n';
}

/** Streams the 3D model XML in ~1 MB chunks so big meshes never become one giant string. */
function* modelXmlChunks(input: BuildProjectInput): Generator<string> {
  const date = new Date().toISOString().slice(0, 10);
  let s =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">\n' +
    ` <metadata name="Application">Creality_Print V${xmlEscape(input.appVersion)} Release</metadata>\n` +
    ' <metadata name="BambuStudio:3mfVersion">1</metadata>\n' +
    ` <metadata name="CreationDate">${date}</metadata>\n` +
    ` <metadata name="ModificationDate">${date}</metadata>\n` +
    ' <metadata name="Title">SliceDock project</metadata>\n' +
    ' <resources>\n';
  const flushAt = 1 << 20;
  for (let i = 0; i < input.objects.length; i++) {
    const { positions, indices } = input.objects[i]!.mesh;
    s += `  <object id="${meshId(i)}" type="model">\n   <mesh>\n    <vertices>\n`;
    for (let v = 0; v < positions.length; v += 3) {
      s += `     <vertex x="${num(positions[v]!)}" y="${num(positions[v + 1]!)}" z="${num(positions[v + 2]!)}"/>\n`;
      if (s.length > flushAt) {
        yield s;
        s = '';
      }
    }
    s += '    </vertices>\n    <triangles>\n';
    for (let t = 0; t < indices.length; t += 3) {
      s += `     <triangle v1="${indices[t]}" v2="${indices[t + 1]}" v3="${indices[t + 2]}"/>\n`;
      if (s.length > flushAt) {
        yield s;
        s = '';
      }
    }
    s += '    </triangles>\n   </mesh>\n  </object>\n';
    s += `  <object id="${objectId(i)}" type="model">\n   <components>\n`;
    s += `    <component objectid="${meshId(i)}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n`;
    s += '   </components>\n  </object>\n';
  }
  s += ' </resources>\n <build>\n';
  const plateCount = Math.max(1, ...input.plates.map((p) => p.index + 1));
  input.objects.forEach((o, i) => {
    const [dx, dy] = plateOrigin(o.plate, plateCount, input.bed);
    s += `  <item objectid="${objectId(i)}" transform="${transformAttr(o.transform, dx, dy)}" printable="1"/>\n`;
  });
  s += ' </build>\n</model>\n';
  yield s;
}

/** Writes the project to `dest` (via a temp file + rename). */
export async function writeProject3mf(dest: string, input: BuildProjectInput): Promise<BuildResult> {
  const tmp = `${dest}.${process.pid}.${Date.now()}.part`;
  const out = createWriteStream(tmp);
  let size = 0;
  const done = new Promise<void>((resolve, reject) => {
    out.on('error', reject);
    out.on('finish', () => resolve());
  });
  done.catch(() => undefined); // awaited below; never an unhandled rejection when we bail out early
  const closed = new Promise<void>((r) => out.once('close', () => r()));
  let zipError: Error | null = null;
  const zip = new Zip((err, chunk, final) => {
    if (err) {
      zipError = err;
      out.destroy(err);
      return;
    }
    if (zipError) return;
    size += chunk.length;
    if (input.maxBytes !== undefined && size > input.maxBytes) {
      zipError = new AppError(413, 'projects.too_large', 'The project would be too large', { maxBytes: input.maxBytes });
      out.destroy(zipError);
      return;
    }
    out.write(chunk);
    if (final) out.end();
  });
  const enc = new TextEncoder();
  const addText = (path: string, text: string) => {
    const f = new ZipDeflate(path, { level: 6 });
    zip.add(f);
    f.push(enc.encode(text), true);
  };
  try {
    addText('[Content_Types].xml', contentTypes());
    const hasThumb = !!input.extras?.some((e) => e.path === 'Metadata/plate_1.png');
    addText('_rels/.rels', rels(hasThumb));
    const model = new ZipDeflate('3D/3dmodel.model', { level: 6 });
    zip.add(model);
    for (const chunk of modelXmlChunks(input)) {
      if (zipError) throw zipError;
      model.push(enc.encode(chunk));
      // Let the write stream drain between chunks of a big mesh, and other requests run.
      if (out.writableNeedDrain) await new Promise((r) => out.once('drain', r));
      else await yieldToLoop();
    }
    model.push(new Uint8Array(0), true);
    addText('Metadata/model_settings.config', modelSettings(input));
    addText('Metadata/project_settings.config', projectSettings(input.config, input.appVersion));
    addText('Metadata/creality.config', crealityConfig(input.appVersion));
    for (const extra of input.extras ?? []) {
      const f = extra.compress === false ? new ZipPassThrough(extra.path) : new ZipDeflate(extra.path, { level: 6 });
      zip.add(f);
      f.push(extra.data, true);
    }
    zip.end();
    await done;
    if (zipError) throw zipError;
    await rename(tmp, dest);
    return { size };
  } catch (err) {
    out.destroy();
    await closed; // the file may still be opening; remove it only once the stream is gone
    await rm(tmp, { force: true });
    throw err;
  }
}
