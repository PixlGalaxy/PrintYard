import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `backend/resources` (bundled official profiles, option metadata, sample G-code).
 * Resolved relative to the code, so it works from `src/` (tsx) and `dist/` (build); `RESOURCES_DIR` overrides it.
 * The Docker image must copy `backend/resources` next to `dist/`.
 */
export function resourcesDir(): string {
  return resolve(process.env.RESOURCES_DIR || fileURLToPath(new URL('../../resources', import.meta.url)));
}
