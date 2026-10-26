import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler } from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { canWork, pageSchema, pageSlugSchema, requestSchema, STAGES, trackingSchema, updateSchema } from '../shared/contracts.js';
import { administrator, authenticated, cookieName, cookieOptions, sessionToken } from './auth.js';
import { config } from './config.js';
import * as db from './db.js';
import { HttpError, logger } from './errors.js';
import { centralSession, getBrand, portalFetch } from './platform.js';
import { newSecret } from './secrets.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY_HOPS);
  app.use(helmet({
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'], connectSrc: ["'self'", 'https://login.microsoftonline.com'],
      frameSrc: ['https://login.microsoftonline.com'], objectSrc: ["'none'"],
      baseUri: ["'self'"], formAction: ["'self'"], frameAncestors: ["'none'"],
      upgradeInsecureRequests: config.NODE_ENV === 'production' ? [] : null,
    } },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  }));
  app.use(compression());
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use('/api', (req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      if (origin !== config.PUBLIC_BASE_URL) throw new HttpError(403, 'Request origin is not permitted.');
      if (!req.is('application/json')) throw new HttpError(415, 'Use application/json.');
    }
    next();
  });
  app.use(express.json({ limit: '40kb' }));
  app.use(cookieParser());
  const limit = (count: number, minutes: number) => rateLimit({
    windowMs: minutes * 60000, limit: count, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Too many requests. Please try again later.', code: 'RATE_LIMITED' },
  });
  const lookupLimit = limit(40, 15);
  app.get('/api/health', async (_req, res) => {
    await db.pool.request().query('SELECT 1');
    res.json({ status: 'ok' });
  });
  app.get('/api/config', (_req, res) => res.json({
    entra: { enabled: true, clientId: config.ENTRA_CLIENT_ID, authority: `https://login.microsoftonline.com/${config.ENTRA_TENANT_ID}` },
    profileUrl: `${config.APPLICATIONS_PORTAL_URL}/profile`,
    emailEnabled: config.emailEnabled,
  }));
  app.get('/api/branding', async (_req, res) => res.json(await getBrand()));
  app.get('/api/branding/assets/:asset', async (req, res) => {
    const asset = z.string().regex(/^(logo|footerLogo|footer-logo|icon|background|value-[a-z0-9-]{1,40})$/).parse(req.params.asset);
    const response = await portalFetch(`/api/branding/assets/${asset}`);
    const type = response.headers.get('content-type')?.split(';')[0] ?? '';
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon'].includes(type)) {
      throw new HttpError(502, 'The portal returned an unsupported branding asset.');
    }
    res.type(type).send(Buffer.from(await response.arrayBuffer()));
  });
  app.get('/api/pages', async (_req, res) => res.json(await db.getPages()));
  app.post('/api/requests', limit(5, 60), async (req, res) => {
    const data = requestSchema.parse(req.body);
    if (data.emailOptIn && !config.emailEnabled) throw new HttpError(503, 'Email updates are not configured. Submit without email updates or contact Admissions.');
    const code = newSecret();
    await db.createRequest(data, code, data.emailOptIn ? newSecret() : null);
    res.status(201).json({ code, notifications: data.emailOptIn ? 'pending' : 'off' });
  });
  app.post('/api/tracking', lookupLimit, async (req, res) => {
    const { code } = trackingSchema.parse(req.body);
    res.json(await db.getProgress(code));
  });
  app.post('/api/tracking/notifications', lookupLimit, async (req, res) => {
    const { code, enabled } = trackingSchema.extend({ enabled: z.boolean() }).parse(req.body);
    if (enabled && !config.emailEnabled) throw new HttpError(503, 'Email updates are not configured.');
    await db.setNotifications(code, enabled, newSecret());
    res.json({ ok: true });
  });
  app.post('/api/notifications/confirm', lookupLimit, async (req, res) => {
    const { token } = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{32}$/) }).strict().parse(req.body);
    await db.verifyNotifications(token);
    res.json({ ok: true });
  });
  app.post('/api/auth/session', limit(20, 15), async (req, res) => {
    const { idToken } = z.object({ idToken: z.string().min(20).max(20000) }).strict().parse(req.body);
    const user = await centralSession(idToken);
    if (!user.isActive || !canWork(user)) throw new HttpError(403, 'An active Admissions staff role is required. Contact your portal administrator.');
    res.cookie(cookieName, await sessionToken(user), { ...cookieOptions, maxAge: 8 * 3600000 });
    res.json(user);
  });
  app.post('/api/auth/logout', (_req, res) => {
    res.clearCookie(cookieName, cookieOptions);
    res.json({ ok: true });
  });
  app.get('/api/auth/me', authenticated, (req, res) => res.json(req.user));
  app.use('/api/staff', authenticated);
  app.get('/api/staff/requests', async (req, res) => {
    const query = z.object({
      q: z.string().trim().max(120).default(''),
      stage: z.enum(STAGES).optional(),
      offset: z.coerce.number().int().min(0).max(1000000).default(0),
    }).parse(req.query);
    res.json(await db.listRequests(query.q, query.stage, query.offset));
  });
  app.get('/api/staff/requests/:id', async (req, res) => {
    res.json(await db.getRequest(z.coerce.number().int().positive().parse(req.params.id)));
  });
  app.patch('/api/staff/requests/:id', async (req, res) => {
    await db.updateRequest(z.coerce.number().int().positive().parse(req.params.id), updateSchema.parse(req.body), req.user!);
    res.json({ ok: true });
  });
  app.get('/api/staff/pages', administrator, async (_req, res) => res.json(await db.getPages(true)));
  app.put('/api/staff/pages/:slug', administrator, async (req, res) => {
    await db.updatePage(pageSlugSchema.parse(req.params.slug), pageSchema.parse(req.body), req.user!.id);
    res.json({ ok: true });
  });
  app.use('/api', () => { throw new HttpError(404, 'API endpoint not found.'); });
  const clientDir = fileURLToPath(new URL('../client', import.meta.url));
  // In source mode Vite serves the client; compiled server and client are siblings under dist.
  app.use(express.static(clientDir, { index: false, maxAge: '1h' }));
  app.get('/{*path}', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(clientDir, 'index.html'));
  });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Please check the submitted fields.', code: 'VALIDATION_ERROR',
        fields: error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })) });
      return;
    }
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
    if (error instanceof SyntaxError && 'status' in error && error.status === 400) {
      res.status(400).json({ error: 'Invalid JSON.', code: 'INVALID_JSON' }); return;
    }
    if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large') {
      res.status(413).json({ error: 'The request is too large.', code: 'PAYLOAD_TOO_LARGE' }); return;
    }
    logger.error({ errorType: error instanceof Error ? error.name : 'Unknown' }, 'Admissions API request failed');
    res.status(500).json({ error: 'The request could not be completed. Please try again or contact Admissions.', code: 'INTERNAL_ERROR' });
  };
  app.use(errors);
  return app;
}
