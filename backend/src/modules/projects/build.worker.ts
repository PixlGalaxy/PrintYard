import { parentPort } from 'node:worker_threads';
import { AppError } from '../../errors.js';
import { runBuild, type BuildJobInput } from './build-core.js';

/**
 * Project build worker (see build-pool.ts). One message in → one message out:
 * `{ id, input }` → `{ id, ok: true, result }` or `{ id, ok: false, error: { status?, code?, message, details? } }`.
 */
if (!parentPort) throw new Error('build.worker must run as a worker thread');
const port = parentPort;

port.on('message', (msg: { id: number; input: BuildJobInput }) => {
  runBuild(msg.input).then(
    (result) => port.postMessage({ id: msg.id, ok: true, result }),
    (err: unknown) => {
      const error =
        err instanceof AppError
          ? { status: err.status, code: err.code, message: err.message, details: err.details }
          : { message: (err as Error)?.message ?? String(err) };
      port.postMessage({ id: msg.id, ok: false, error });
    },
  );
});
