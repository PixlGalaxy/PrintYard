import type { ParsedGcode, WorkerResponse } from './types'

/** Parses G-code in a Web Worker. `onProgress(0..1)`; abort via `signal` (terminates the worker). */
export function parseGcode(blob: Blob, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<ParsedGcode> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./parser.worker.ts', import.meta.url), { type: 'module' })
    const finish = () => {
      worker.terminate()
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      finish()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const m = ev.data
      if (m.type === 'progress') onProgress?.(m.total ? m.loaded / m.total : 0)
      else if (m.type === 'done') {
        finish()
        onProgress?.(1)
        resolve(m.result)
      } else {
        finish()
        reject(new Error(m.message))
      }
    }
    worker.onerror = (ev) => {
      finish()
      reject(new Error(ev.message || 'G-code worker failed'))
    }
    worker.postMessage({ type: 'parse', blob })
  })
}
