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

/**
 * Repository-level `locales/` (`<lang>/ui.json`, `notifications.json`, `slicer.json`), shared with the frontend.
 * `backend/src/lib` and `backend/dist/lib` both sit three levels below it; `LOCALES_DIR` overrides it.
 * The Docker image must copy `locales/` to `/app/locales`.
 */
export function localesDir(): string {
  return resolve(process.env.LOCALES_DIR || fileURLToPath(new URL('../../../locales', import.meta.url)));
}
