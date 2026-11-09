/**
 * Single-flight guard: at most one `fn` runs at a time; a concurrent caller gets `onBusy()` thrown immediately
 * instead of queueing.
 */
export function createExclusive(onBusy: () => Error): <T>(fn: () => Promise<T>) => Promise<T> {
  let busy = false;
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (busy) throw onBusy();
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  };
}
