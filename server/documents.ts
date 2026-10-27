import { pipeline } from 'node:stream/promises';
import express, { type Request } from 'express';
import { z } from 'zod';
import { DOCUMENT_MAX_BYTES, DOCUMENT_MAX_COUNT, trackingSchema } from '../shared/contracts.js';
import * as db from './db.js';
import * as storage from './documentStorage.js';
import { validateDocument } from './documentValidation.js';
import { HttpError } from './errors.js';

export const isDocumentUpload = (req: Request) => req.method === 'POST'
  && /^\/api\/(?:tracking\/documents|staff\/requests\/[1-9]\d*\/documents)$/.test(`${req.baseUrl}${req.path}`);
const raw = express.raw({ type: 'application/octet-stream', limit: DOCUMENT_MAX_BYTES, inflate: false });

export function documentRouter(staff: boolean) {
  const router = express.Router({ mergeParams: true });
  let uploads = 0, downloads = 0;
  const access = (req: Request, upload = false): db.DocumentAccess => staff
    ? { requestId: z.coerce.number().int().positive().parse(req.params.id) }
    : trackingSchema.parse(upload ? { code: req.get('x-tracking-code') } : req.body);
  router[staff ? 'get' : 'post'](staff ? '/' : '/list', async (req, res) => {
    const requestId = await db.authorizeDocuments(access(req));
    const ready = await storage.storageReady();
    res.json({ documents: await db.listDocuments(requestId), ready, maxBytes: DOCUMENT_MAX_BYTES, maxCount: DOCUMENT_MAX_COUNT });
  });
  router.post('/', async (req, res) => {
    const requestId = await db.authorizeDocuments(access(req, true));
    if (!req.is('application/octet-stream') || (req.get('content-encoding') && req.get('content-encoding') !== 'identity')) {
      throw new HttpError(415, 'Upload an uncompressed application/octet-stream document.');
    }
    if (uploads >= 2) throw new HttpError(503, 'Document uploads are busy. Please try again shortly.');
    uploads++;
    try {
      await storage.requireStorage();
      const length = Number(req.get('content-length'));
      if (length > DOCUMENT_MAX_BYTES) throw new HttpError(413, 'Documents must be at most 10 MB.');
      let filename: string;
      try { filename = decodeURIComponent(req.get('x-document-name') ?? ''); } catch { throw new HttpError(400, 'Invalid document filename.'); }
      if (!filename || filename.length > 500) throw new HttpError(400, 'A document filename is required (maximum 500 characters).');
      req.setTimeout(30000, () => req.destroy());
      await new Promise<void>((resolve, reject) => raw(req, res, (error?: unknown) => error ? reject(error) : resolve()));
      if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'A binary document body is required.');
      const bytes = req.body;
      const metadata = await validateDocument(bytes, filename);
      await db.addDocument(requestId, { ...metadata, size: bytes.length }, staff ? req.user!.id : null,
        (name) => storage.uploadBlob(name, bytes, metadata.mimeType), storage.deleteBlob);
      res.status(201).json({ ok: true });
    } finally { uploads--; req.setTimeout(0); }
  });
  router[staff ? 'get' : 'post']('/:documentId/download', async (req, res, next) => {
    const requestId = await db.authorizeDocuments(access(req));
    const id = z.uuid().parse(req.params.documentId);
    const document = await db.getDocument(requestId, id);
    if (downloads >= 8) throw new HttpError(503, 'Document downloads are busy. Please try again shortly.');
    downloads++;
    try {
      const stream = await storage.downloadBlob(document.blobName);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Type', document.mimeType);
      res.setHeader('Content-Length', document.size);
      res.attachment(document.filename);
      await pipeline(stream, res);
    } catch (error) { next(error); }
    finally { downloads--; }
  });
  return router;
}
