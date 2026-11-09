import { AppError } from '../../errors.js';
import type { SceneDoc } from '../../types.js';
import { loadMesh, MAX_MESH_TRIANGLES, MeshFormatError } from '../files/mesh.js';
import type { RawPreset } from '../profiles/profiles.service.js';
import { prepareObjects, printableArea } from './scene.js';
import { writeProject3mf, type BuildProjectInput } from './threemf.js';

/** Scene JSON embedded in every SliceDock 3MF so a downloaded project reopens exactly. */
export const SCENE_ENTRY = 'Metadata/slicedock_scene.json';
/** Triangles written into one project/slice (sum over objects: 500 copies of a mesh count 500 times). */
export const MAX_SCENE_TRIANGLES = MAX_MESH_TRIANGLES;
/** Largest project 3MF a build may write. */
export const MAX_PROJECT_BYTES = 1024 * 1024 * 1024;

/** A model file the main thread already authorised for this build (no DB access in the worker). */
export interface BuildSource {
  path: string;
  ext: string;
  /** display name without extension */
  name: string;
  /** original file name, for error messages */
  fileName: string;
}

/** Everything a build needs; structured-clone friendly (sent to the build worker). */
export interface BuildJobInput {
  scene: SceneDoc;
  config: RawPreset;
  dest: string;
  sources: Record<number, BuildSource>;
  appVersion: string;
  onlyPlate?: number;
  validateBounds?: boolean;
  embedScene?: boolean;
  thumbnail?: Uint8Array;
}

export interface BuildJobOutput {
  size: number;
  objects: number;
  plates: number;
  triangles: number;
}

/**
 * The CPU-heavy part of a project build: mesh loading (all mesh.ts limits apply: source/entry bytes, zip entries,
 * 3MF nesting/instances, triangles), placement checks, the scene triangle cap and the 3MF write (size cap).
 * Runs inside the build worker (build.worker.ts), so the main event loop stays free.
 */
export async function runBuild(input: BuildJobInput): Promise<BuildJobOutput> {
  const { scene, config } = input;
  const loadMeshFor = async (fileId: number) => {
    const src = input.sources[fileId];
    if (!src) throw new AppError(400, 'projects.missing_model', `Model file #${fileId} is not available`, { fileId });
    try {
      return { mesh: await loadMesh(src.path, src.ext), name: src.name };
    } catch (err) {
      if (err instanceof MeshFormatError) throw new AppError(400, 'projects.invalid_model', `${src.fileName}: ${err.message}`, { fileId });
      throw err;
    }
  };
  const { objects, plates } = await prepareObjects(scene, config, loadMeshFor, {
    ...(input.onlyPlate !== undefined && { onlyPlate: input.onlyPlate }),
    validateBounds: input.validateBounds ?? false,
  });
  const total = objects.reduce((n, o) => n + o.mesh.indices.length / 3, 0);
  if (total > MAX_SCENE_TRIANGLES) {
    throw new AppError(400, 'projects.too_complex', 'The scene has too many triangles in total (objects × triangles)', {
      triangles: total,
      max: MAX_SCENE_TRIANGLES,
    });
  }
  const area = printableArea(config);
  const extras: NonNullable<BuildProjectInput['extras']> = [];
  if (input.embedScene !== false) extras.push({ path: SCENE_ENTRY, data: new TextEncoder().encode(JSON.stringify(scene)) });
  if (input.thumbnail) extras.push({ path: 'Metadata/plate_1.png', data: new Uint8Array(input.thumbnail), compress: false });
  const result = await writeProject3mf(input.dest, {
    objects,
    plates,
    config,
    appVersion: input.appVersion,
    bed: { width: area.maxX - area.minX, depth: area.maxY - area.minY },
    extras,
    maxBytes: MAX_PROJECT_BYTES,
  });
  return { size: result.size, objects: objects.length, plates: plates.length, triangles: total };
}
