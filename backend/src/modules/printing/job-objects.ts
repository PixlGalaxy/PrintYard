import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { OBJECT_NAME_RE, objectLabel } from '../../printers/k2se/moonraker.js';
import type { JobObject } from '../../types.js';

/** One `EXCLUDE_OBJECT_DEFINE` from a G-code file. */
export interface GcodeObjectDef {
  name: string;
  label: string;
  center: [number, number] | null;
  polygon: [number, number][];
}

const MAX_OBJECTS = 256;
/** No `EXCLUDE_OBJECT_DEFINE` in the first 8 MB: the file defines none (they precede the first layer). */
const GIVE_UP_BYTES = 8 * 1024 * 1024;

const finite = (n: number) => Number.isFinite(n);
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Parses one `EXCLUDE_OBJECT_DEFINE NAME=Object_1_id_0_copy_0 CENTER=110,107.5 POLYGON=[[100,97],[120,97],...]`
 * line (Creality Print 7.x / Klipper syntax). Returns null for anything else or an invalid name.
 */
export function parseDefineLine(line: string): GcodeObjectDef | null {
  const code = line.split(';')[0]!.trim();
  if (!/^EXCLUDE_OBJECT_DEFINE\b/i.test(code)) return null;
  const name = /\bNAME=("?)([^\s"]+)\1/i.exec(code)?.[2];
  if (!name || !OBJECT_NAME_RE.test(name)) return null;
  const c = /\bCENTER=(-?[\d.]+),(-?[\d.]+)/i.exec(code);
  const center: [number, number] | null = c && finite(Number(c[1])) && finite(Number(c[2])) ? [r3(Number(c[1])), r3(Number(c[2]))] : null;
  const polygon: [number, number][] = [];
  const poly = /\bPOLYGON=(\[\[.*?\]\])/i.exec(code)?.[1];
  if (poly) {
    for (const m of poly.matchAll(/\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]/g)) {
      const x = Number(m[1]);
      const y = Number(m[2]);
      if (finite(x) && finite(y)) polygon.push([r3(x), r3(y)]);
      if (polygon.length >= 512) break;
    }
  }
  return { name, label: objectLabel(name), center, polygon };
}

/** `; printing object Object_1 id:0 copy 0` (Creality Print comment) → label for `Object_1_id_0_copy_0`. */
export function parseLabelComment(line: string): { key: string; label: string } | null {
  const m = /^;\s*printing object\s+(.+?)\s+id:(\d+)\s+copy\s+(\d+)\s*$/i.exec(line.trim());
  if (!m) return null;
  const copy = Number(m[3]);
  const label = copy > 0 ? `${m[1]} (${copy + 1})` : m[1]!;
  return { key: `_id_${m[2]}_copy_${m[3]}`.toUpperCase(), label };
}

/**
 * Streams a G-code file and returns its object definitions. Stops once every defined object has started
 * (`EXCLUDE_OBJECT_START`), or after 8 MB without any definition.
 */
export async function readObjectDefinitions(path: string): Promise<GcodeObjectDef[]> {
  const defs = new Map<string, GcodeObjectDef>();
  const started = new Set<string>();
  const labels = new Map<string, string>();
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 256 * 1024 });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let bytes = 0;
  try {
    for await (const line of rl) {
      bytes += line.length + 1;
      const c = line.charCodeAt(0);
      if (c === 0x45 || c === 0x65) {
        // E…: EXCLUDE_OBJECT_DEFINE / EXCLUDE_OBJECT_START
        const def = parseDefineLine(line);
        if (def && defs.size < MAX_OBJECTS) defs.set(def.name.toUpperCase(), def);
        const start = /^EXCLUDE_OBJECT_START\s+NAME=("?)([^\s"]+)\1/i.exec(line.trim());
        if (start?.[2]) {
          started.add(start[2].toUpperCase());
          if (defs.size > 0 && [...defs.keys()].every((k) => started.has(k))) break;
        }
      } else if (c === 0x3b) {
        const l = parseLabelComment(line);
        if (l) labels.set(l.key, l.label);
      }
      if (defs.size === 0 && bytes > GIVE_UP_BYTES) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return [...defs.values()].map((d) => {
    for (const [suffix, label] of labels) if (d.name.toUpperCase().endsWith(suffix)) return { ...d, label };
    return d;
  });
}

/**
 * The job's objects: the G-code definitions (proper-case names, labels) merged with Klipper's live
 * `exclude_object` status (excluded/current; Klipper upper-cases names). Without definitions, Klipper's own list.
 */
export function mergeObjects(defs: GcodeObjectDef[] | null, live: JobObject[], excludedNames: string[], current: string | null): JobObject[] {
  const excluded = new Set(excludedNames.map((n) => n.toUpperCase()));
  const cur = current?.toUpperCase() ?? null;
  if (!defs || defs.length === 0) {
    return live.map((o) => ({ ...o, excluded: excluded.has(o.name.toUpperCase()), current: cur === o.name.toUpperCase() }));
  }
  const liveByName = new Map(live.map((o) => [o.name.toUpperCase(), o]));
  return defs.map((d) => {
    const key = d.name.toUpperCase();
    const l = liveByName.get(key);
    return {
      name: d.name,
      label: d.label,
      center: d.center ?? l?.center ?? null,
      polygon: d.polygon.length > 0 ? d.polygon : (l?.polygon ?? []),
      excluded: excluded.has(key),
      excludedAt: null,
      current: cur === key,
    };
  });
}
