import { createReadStream, statSync } from 'node:fs';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';

/**
 * Called while the body is written: bytes of the FILE handed to the socket so far (multipart framing excluded), its
 * size, and `done` once the printer answered. Also called once a second while nothing moved (so ETAs stay fresh).
 */
export type UploadProgress = (sentBytes: number, totalBytes: number, done: boolean) => void;

export interface MultipartUploadOptions {
  host: string;
  port: number;
  /** Path incl. query, already encoded. */
  path: string;
  /** Multipart field name (Creality: `file`). */
  field: string;
  fileName: string;
  localPath: string;
  timeoutMs: number;
  onProgress?: UploadProgress;
}

/**
 * Streams `localPath` as a `multipart/form-data` POST with an explicit Content-Length (the printer's upload handler
 * is not guaranteed to accept chunked bodies) and reports the file bytes written to the socket. The file is read in
 * 64 KiB chunks and writes honour backpressure, so progress follows what the printer actually accepts, minus what
 * the kernel socket buffers hold (several MB on a loopback, far less over Wi-Fi). Because of those buffers "all bytes
 * written" is not "received": `done` (100 %) is only reported once the printer has answered.
 */
export function postMultipartFile(o: MultipartUploadOptions): Promise<{ status: number; body: string }> {
  const total = statSync(o.localPath).size;
  const boundary = `----SliceDock${randomBytes(12).toString('hex')}`;
  const safeName = o.fileName.replace(/["\r\n\\]/g, '_');
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${o.field}"; filename="${safeName}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(beat);
      file.destroy();
      req.destroy();
      reject(err);
    };
    const req = request(
      {
        host: o.host,
        port: o.port,
        method: 'POST',
        path: o.path,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(head.length + total + tail.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          if (size < 4096) chunks.push(c);
          size += c.length;
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearInterval(beat);
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) o.onProgress?.(total, total, true);
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8').slice(0, 4096) });
        });
        res.on('error', fail);
      },
    );
    const timer = setTimeout(() => fail(new Error('upload timed out')), o.timeoutMs);
    req.on('error', fail);
    const file = createReadStream(o.localPath, { highWaterMark: 64 * 1024 });
    let sent = 0;
    o.onProgress?.(0, total, false);
    const beat = setInterval(() => o.onProgress?.(sent, total, false), 1000);
    req.write(head);
    file.on('data', (chunk) => {
      const buf = chunk as Buffer;
      const ok = req.write(buf, () => {
        sent += buf.length;
        o.onProgress?.(Math.min(sent, total), total, false);
      });
      if (!ok) {
        file.pause();
        req.once('drain', () => file.resume());
      }
    });
    file.on('error', fail);
    file.on('end', () => {
      req.end(tail);
    });
  });
}
