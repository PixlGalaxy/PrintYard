import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import busboy from 'busboy';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { AppError, badRequest, notFound } from '../../errors.js';
import { idParam, parse } from '../../middleware/index.js';
import type { Visibility } from '../../types.js';
import { cleanName, extOf, MAX_THUMBNAIL_BYTES, quotaExceeded, type FileRow } from './files.service.js';
import { pngSize } from './gcode.js';

const listQuery = z.object({
  scope: z.enum(['private', 'shared', 'all']).default('private'),
  kind: z.enum(['model', 'project', 'gcode']).optional(),
});

const patchSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    visibility: z.enum(['private', 'shared']).optional(),
    pinned: z.boolean().optional(),
  })
  .strict();

const thumbnailJson = z.object({ png: z.string().max(Math.ceil((MAX_THUMBNAIL_BYTES * 4) / 3) + 8) });

const tooLarge = (mb: number) => new AppError(413, 'files.too_large', `Files are limited to ${mb} MB`, { maxMb: mb });

const actorOf = (req: Request) => ({ userId: req.session!.user.id, username: req.session!.user.username, ip: req.clientIp });
const viewerOf = (req: Request) => ({ id: req.session!.user.id, role: req.session!.user.role });

/** RFC 6266 attachment header with an ASCII fallback and the UTF-8 name. */
export function contentDisposition(type: 'attachment' | 'inline', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const MIME: Record<string, string> = {
  stl: 'model/stl',
  '3mf': 'model/3mf',
  obj: 'model/obj',
  gcode: 'text/x.gcode',
};

/** Streams `file` (multipart) to a temp file, enforcing `files.maxUploadMb`, then adds it to the library. */
function upload(ctx: AppContext) {
  return (req: Request, res: Response, next: NextFunction) => {
    const type = req.headers['content-type'] ?? '';
    if (!/^multipart\/form-data/i.test(type)) return next(badRequest('files.no_file', 'Send the file as multipart/form-data, field "file"'));
    const maxUpload = ctx.files.maxUploadBytes();
    const mb = ctx.settings.get('files.maxUploadMb');
    const ownerId = req.session!.user.id;
    // Storage quota: stop streaming as soon as the upload would not fit (checked again when the file is added).
    const remaining = ctx.files.storageRemaining(ownerId);
    const quotaError = () => quotaExceeded(ctx.files.storageQuota(ownerId) ?? 0, ctx.files.storageUsed(ownerId));
    const limit = Math.min(maxUpload, remaining);
    const declared = Number(req.headers['content-length']);
    if (remaining <= 0 || (Number.isFinite(declared) && declared > remaining + 1024 * 1024 && remaining < maxUpload)) {
      res.setHeader('Connection', 'close');
      return next(quotaError());
    }
    if (Number.isFinite(declared) && declared > maxUpload + 1024 * 1024) {
      res.setHeader('Connection', 'close');
      return next(tooLarge(mb));
    }
    let parser: busboy.Busboy;
    try {
      parser = busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { fileSize: limit, files: 2, fields: 10, fieldSize: 1024, parts: 12 } });
    } catch {
      return next(badRequest('files.no_file', 'Malformed multipart request'));
    }
    let visibility: Visibility = req.query.visibility === 'shared' ? 'shared' : 'private';
    let failure: unknown = null;
    let write: Promise<void> | null = null;
    let received: { tmpPath: string; name: string; sha256: string; size: number } | null = null;
    let tmpPath: string | null = null;
    let fileStream: Readable | null = null;
    const fail = (err: unknown) => {
      failure ??= err;
    };

    parser.on('field', (name, value) => {
      if (name === 'visibility' && (value === 'shared' || value === 'private')) visibility = value;
    });
    parser.on('file', (field, stream, info) => {
      if (failure || field !== 'file' || write) {
        if (!failure && field === 'file' && write) fail(badRequest('files.too_many', 'Upload one file per request'));
        stream.resume();
        return;
      }
      const name = cleanName(info.filename ?? '');
      const ext = extOf(name);
      if (!name || !['stl', '3mf', 'obj', 'gcode'].includes(ext)) {
        fail(badRequest('files.unsupported_type', 'Only .stl, .3mf, .obj and .gcode files are allowed'));
        stream.resume();
        return;
      }
      fileStream = stream;
      let truncated = false;
      stream.on('limit', () => {
        truncated = true;
        fail(limit < maxUpload ? quotaError() : tooLarge(mb));
      });
      write = (async () => {
        tmpPath = await ctx.files.tempPath(ext);
        const hash = createHash('sha256');
        let size = 0;
        const meter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            hash.update(chunk);
            size += chunk.length;
            cb(null, chunk);
          },
        });
        await pipeline(stream, meter, createWriteStream(tmpPath));
        if (truncated) throw failure;
        received = { tmpPath, name, sha256: hash.digest('hex'), size };
      })().catch((err) => {
        stream.resume();
        fail(err);
      });
    });
    parser.on('error', () => fail(badRequest('files.no_file', 'Malformed multipart request')));
    parser.on('close', () => {
      void (async () => {
        await write;
        if (failure || !received) {
          if (tmpPath) await rm(tmpPath, { force: true });
          return next(failure ?? badRequest('files.no_file', 'No file in the request (field "file")'));
        }
        try {
          const user = req.session!.user;
          const file = await ctx.files.addUpload({ id: user.id, username: user.username }, { ...received, visibility }, actorOf(req));
          res.status(201).json(file);
        } catch (err) {
          next(err);
        }
      })();
    });
    // A client that disconnects mid-upload never ends the multipart body, so busboy never closes and the temp file
    // would stay in DATA_ROOT/.tmp forever (outside any quota). Stop the file stream and remove the temp file.
    req.on('close', () => {
      if (req.complete) return;
      fail(badRequest('files.aborted', 'Upload aborted'));
      req.unpipe(parser);
      fileStream?.destroy(new Error('Upload aborted'));
      void (async () => {
        await write;
        if (tmpPath) await rm(tmpPath, { force: true, maxRetries: 3 }).catch(() => undefined);
      })();
    });
    req.pipe(parser);
  };
}

function sendStored(ctx: AppContext, row: FileRow, res: Response, disposition: 'attachment' | 'inline') {
  res.setHeader('Content-Type', disposition === 'attachment' ? 'application/octet-stream' : (MIME[row.ext] ?? 'application/octet-stream'));
  res.setHeader('Content-Disposition', contentDisposition(disposition, row.name));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'private, no-cache');
  res.sendFile(ctx.files.absolutePath(row), { dotfiles: 'allow', headers: {} }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: { code: 'common.not_found', message: 'Not found' } });
  });
}

/** Mounted at /api/files behind requireAuth. */
export function filesRoutes(ctx: AppContext): Router {
  const router = Router();

  router.post('/', upload(ctx));

  router.get('/', (req, res) => {
    const q = parse(listQuery, req.query);
    res.json(ctx.files.list(viewerOf(req), q.scope, q.kind));
  });

  /** Printer copies PrintYard uploaded for these files (`?ids=1,2,3`): what the delete dialog offers to remove too. */
  router.get('/printer-copies', (req, res) => {
    const ids = String(req.query.ids ?? '')
      .split(',')
      .map((v) => Number(v))
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 500);
    const viewer = viewerOf(req);
    const visible = ids.filter((id) => {
      try {
        ctx.files.getReadable(viewer, id);
        return true;
      } catch {
        return false;
      }
    });
    const copies = ctx.printerRetention.copiesOfFiles(visible);
    res.json({ items: visible.map((id) => ({ fileId: id, copies: (copies.get(id) ?? []).map(({ printerId, printerName, name }) => ({ printerId, printerName, name })) })) });
  });


  router.get('/:id', (req, res) => {
    res.json(ctx.files.toLibraryFile(ctx.files.getReadable(viewerOf(req), idParam(req))));
  });

  router.get('/:id/download', (req, res) => {
    sendStored(ctx, ctx.files.getReadable(viewerOf(req), idParam(req)), res, 'attachment');
  });

  router.get('/:id/content', (req, res) => {
    sendStored(ctx, ctx.files.getReadable(viewerOf(req), idParam(req)), res, 'inline');
  });

  router.get('/:id/thumbnail', (req, res) => {
    const row = ctx.files.getReadable(viewerOf(req), idParam(req));
    if (!row.has_thumbnail) throw notFound();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // The URL carries ?v=<updatedAt>, so a cached copy is never stale.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.sendFile(ctx.files.thumbnailPath(row.id), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: { code: 'common.not_found', message: 'Not found' } });
    });
  });

  // PNG ≤ 512 KB, as a raw image/png body or JSON { png: base64 }.
  router.put(
    '/:id/thumbnail',
    express.raw({ type: 'image/png', limit: MAX_THUMBNAIL_BYTES }),
    async (req, res) => {
      const row = ctx.files.getWritable(viewerOf(req), idParam(req));
      let png: Buffer;
      if (Buffer.isBuffer(req.body)) png = req.body;
      else png = Buffer.from(parse(thumbnailJson, req.body).png.replace(/^data:image\/png;base64,/, ''), 'base64');
      if (png.length > MAX_THUMBNAIL_BYTES) throw new AppError(413, 'files.thumbnail_too_large', 'Thumbnails are limited to 512 KB');
      if (!pngSize(png)) throw badRequest('files.invalid_thumbnail', 'Thumbnail must be a PNG image');
      await ctx.files.writeThumbnail(row.id, png);
      res.json(ctx.files.get(row.id));
    },
  );

  router.patch('/:id', (req, res) => {
    const body = parse(patchSchema, req.body ?? {});
    res.json(ctx.files.patch(viewerOf(req), idParam(req), body, actorOf(req)));
  });

  /**
   * Deletes a library file. `?printer=1` also deletes the copies PrintYard uploaded to printers (verified exact
   * name + size + upload id; never the file being printed/paused or of an open print; offline/read-only → skipped).
   * 200 `{ printer: PrinterCopyResult[] }` with `?printer=1`, else 204.
   */
  router.delete('/:id', async (req, res) => {
    const id = idParam(req);
    const alsoPrinter = req.query.printer === '1' || req.query.printer === 'true';
    const copies = alsoPrinter ? (ctx.printerRetention.copiesOfFiles([id]).get(id) ?? []) : [];
    await ctx.files.delete(viewerOf(req), id, actorOf(req));
    if (!alsoPrinter) return void res.status(204).end();
    const results = copies.length ? await ctx.printerRetention.deleteCopies(copies, actorOf(req)) : [];
    res.json({ printer: results.map(({ printerId, printerName, name, result, reason }) => ({ printerId, printerName, name, result, ...(reason && { reason }) })) });
  });

  return router;
}
