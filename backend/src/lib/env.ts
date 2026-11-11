/**
 * App environment variables are `PRINTYARD_<NAME>`. The pre-rename `SLICEDOCK_<NAME>` spelling is still read as a
 * fallback (deprecated: existing containers keep working without edits; it may be dropped in a later release).
 */
export function appEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`PRINTYARD_${name}`] ?? env[`SLICEDOCK_${name}`];
}

/** `appEnv(name) === '1'`. */
export function appEnvFlag(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return appEnv(name, env) === '1';
}
