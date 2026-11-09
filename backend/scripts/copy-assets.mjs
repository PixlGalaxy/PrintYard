// tsc only emits .js: copy the SQL migrations next to the compiled migrate.js.
import { cpSync } from 'node:fs';
cpSync(new URL('../src/db/migrations', import.meta.url), new URL('../dist/db/migrations', import.meta.url), {
  recursive: true,
});
