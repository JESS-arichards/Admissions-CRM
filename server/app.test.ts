import { once } from 'node:events';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import type { CentralUser } from '../shared/contracts.js';

const fixtures = vi.hoisted(() => ({
  config: {
    NODE_ENV: 'test', PUBLIC_BASE_URL: 'http://localhost:5174', APPLICATIONS_PORTAL_URL: 'https://portal.example.test',
    ENTRA_CLIENT_ID: '11111111-1111-4111-8111-111111111111', ENTRA_TENANT_ID: '22222222-2222-4222-8222-222222222222',
    SESSION_SECRET: 'test-only-independent-session-secret-123456', PLATFORM_API_KEY: 'test-only-platform-key-123456789012345678',
    TRUST_PROXY_HOPS: 0, emailEnabled: true, LOG_LEVEL: 'silent',
  },
  user: {
    id: 7, email: 'staff@example.test', displayName: 'Admissions Staff', isActive: true, sessionVersion: 3,
    roles: ['Admissions Admin'],
  } as CentralUser,
}));
vi.mock('./config.js', () => ({ config: fixtures.config }));
vi.mock('./db.js', () => ({
  pool: { request: () => ({ query: vi.fn().mockResolvedValue({}) }) },
  createRequest: vi.fn(), getProgress: vi.fn(), setNotifications: vi.fn(), verifyNotifications: vi.fn(),
  listRequests: vi.fn(), getRequest: vi.fn(), updateRequest: vi.fn(), getPages: vi.fn(), updatePage: vi.fn(),
  authorizeDocuments: vi.fn(), listDocuments: vi.fn(), getDocument: vi.fn(), addDocument: vi.fn(),
}));
vi.mock('./documentStorage.js', () => ({
  storageReady: vi.fn(), requireStorage: vi.fn(), uploadBlob: vi.fn(), deleteBlob: vi.fn(), downloadBlob: vi.fn(),
}));
vi.mock('./platform.js', () => ({
  centralUser: vi.fn(), centralSession: vi.fn(), getBrand: vi.fn(), portalFetch: vi.fn(),
}));
import * as db from './db.js';
import * as storage from './documentStorage.js';
import * as platform from './platform.js';
import { createApp } from './app.js';
import { cookieName, sessionToken } from './auth.js';
import { HttpError } from './errors.js';
import { hashSecret } from './secrets.js';

let server: Server;
let base: string;
let cookie: string;
const requestBody = {
  kind: 'Enquiry', parentName: 'Parent', email: 'parent@example.test', phone: '', yearGroup: 'Year 3',
  message: 'Could you tell me about admissions?', emailOptIn: false, privacyAccepted: true, website: '',
};
async function call(route: string, method = 'GET', body?: unknown, staff = false, origin = fixtures.config.PUBLIC_BASE_URL) {
  return fetch(`${base}${route}`, {
    method, headers: {
      'Content-Type': 'application/json', Origin: origin, ...(staff ? { Cookie: cookie } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
beforeAll(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cookie = `${cookieName}=${await sessionToken(fixtures.user)}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => {
  vi.resetAllMocks();
  fixtures.user.roles = ['Admissions Admin']; fixtures.user.isActive = true; fixtures.user.sessionVersion = 3;
  fixtures.config.emailEnabled = true;
  vi.mocked(platform.centralUser).mockImplementation(async () => ({ ...fixtures.user }));
  vi.mocked(platform.centralSession).mockImplementation(async () => ({ ...fixtures.user }));
  vi.mocked(db.getPages).mockResolvedValue([]);
  vi.mocked(db.listRequests).mockResolvedValue({ items: [], hasMore: false });
  vi.mocked(db.authorizeDocuments).mockResolvedValue(4);
  vi.mocked(db.listDocuments).mockResolvedValue([]);
  vi.mocked(storage.storageReady).mockResolvedValue(true);
});
describe('private enquiry documents', () => {
  const code = 'd'.repeat(32), documentId = '11111111-1111-4111-8111-111111111111';
  const bytes = Buffer.from(`%PDF-1.7\noriginal bytes\n${'x'.repeat(4096)}\n%%EOF`);
  async function upload(staff = false, body: Buffer = bytes, extra: Record<string, string> = {}) {
    return fetch(`${base}${staff ? '/api/staff/requests/4/documents' : '/api/tracking/documents'}`, {
      method: 'POST', headers: {
        'Content-Type': 'application/octet-stream', Origin: fixtures.config.PUBLIC_BASE_URL,
        'X-Document-Name': encodeURIComponent('original.pdf'), ...(staff ? { Cookie: cookie } : { 'X-Tracking-Code': code }), ...extra,
      }, body: new Uint8Array(body),
    });
  }
  it('checks parent tracking authorization before storage or parsing', async () => {
    vi.mocked(db.authorizeDocuments).mockRejectedValue(new HttpError(404, 'Request not found.'));
    expect((await upload()).status).toBe(404);
    expect(storage.requireStorage).not.toHaveBeenCalled();
    expect(db.addDocument).not.toHaveBeenCalled();
  });
  it('requires the tracking secret outside the URL and validates the origin', async () => {
    expect((await upload(false, bytes, { 'X-Tracking-Code': '' })).status).toBe(400);
    expect((await upload(false, bytes, { Origin: 'https://evil.example.test' })).status).toBe(403);
    expect(db.addDocument).not.toHaveBeenCalled();
  });
  it('preserves bytes for parent upload and omits code/metadata from its response', async () => {
    const response = await upload();
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(db.authorizeDocuments).toHaveBeenCalledWith({ code });
    const args = vi.mocked(db.addDocument).mock.calls[0];
    expect(args.slice(0, 3)).toEqual([4, { filename: 'original.pdf', mimeType: 'application/pdf', size: bytes.length }, null]);
    await args[3]('private-key');
    expect(storage.uploadBlob).toHaveBeenCalledWith('private-key', bytes, 'application/pdf');
  });
  it('requires current central staff roles for upload, list and download', async () => {
    expect((await call('/api/staff/requests/4/documents')).status).toBe(401);
    fixtures.user.roles = ['Parent'];
    expect((await upload(true)).status).toBe(403);
    expect((await call(`/api/staff/requests/4/documents/${documentId}/download`, 'GET', undefined, true)).status).toBe(403);
    expect(db.authorizeDocuments).not.toHaveBeenCalled();
    fixtures.user.roles = ['Admissions Contributor'];
    expect((await upload(true)).status).toBe(201);
    expect(db.addDocument).toHaveBeenCalledWith(4, expect.anything(), 7, expect.any(Function), expect.any(Function));
  });
  it('enforces size/type limits and never accepts compressed uploads', async () => {
    expect((await upload(false, Buffer.alloc(10 * 1024 * 1024 + 1))).status).toBe(413);
    expect((await upload(false, Buffer.alloc(0))).status).toBe(413);
    expect((await upload(false, Buffer.from('MZ executable'))).status).toBe(415);
    expect((await upload(false, bytes, { 'Content-Encoding': 'gzip' })).status).toBe(415);
    expect(db.addDocument).not.toHaveBeenCalled();
  });
  it('rejects a missing upload body explicitly without touching blob storage', async () => {
    const response = await fetch(`${base}/api/tracking/documents`, {
      method: 'POST', headers: {
        'Content-Type': 'application/octet-stream', Origin: fixtures.config.PUBLIC_BASE_URL,
        'X-Document-Name': 'file.pdf', 'X-Tracking-Code': code,
      },
    });
    expect(response.status).toBe(413);
    expect((await response.json()).error).toContain('non-empty');
    expect(db.addDocument).not.toHaveBeenCalled();
    expect(storage.uploadBlob).not.toHaveBeenCalled();
  });
  it('enforces the binary parser limit even without Content-Length', async () => {
    const response = await fetch(`${base}/api/tracking/documents`, {
      method: 'POST', headers: {
        'Content-Type': 'application/octet-stream', Origin: fixtures.config.PUBLIC_BASE_URL,
        'X-Document-Name': 'file.pdf', 'X-Tracking-Code': code,
      },
      body: Readable.from([Buffer.alloc(10 * 1024 * 1024 + 1)]) as unknown as BodyInit,
      duplex: 'half',
    } as RequestInit & { duplex: string });
    expect(response.status).toBe(413);
    expect(db.addDocument).not.toHaveBeenCalled();
  });
  it('accepts exactly 10,485,760 bytes and sanitizes download metadata filenames', async () => {
    const boundary = Buffer.alloc(10 * 1024 * 1024); bytes.copy(boundary);
    expect((await upload(false, boundary, { 'X-Document-Name': encodeURIComponent('../report\r\n.pdf') })).status).toBe(201);
    expect(db.addDocument).toHaveBeenCalledWith(4,
      { filename: '_report__.pdf', mimeType: 'application/pdf', size: 10485760 }, null, expect.any(Function), expect.any(Function));
  });
  it('reports the shared count limit without attempting another write', async () => {
    vi.mocked(db.addDocument).mockRejectedValue(new HttpError(409, 'This enquiry already has 5 documents.'));
    expect((await upload()).status).toBe(409);
  });
  it('rejects concurrent upload bodies instead of queuing them', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let entered = 0;
    vi.mocked(db.addDocument).mockImplementation(async () => { entered++; await blocked; });
    const first = upload(), second = upload();
    try {
      await vi.waitFor(() => expect(entered).toBe(2));
      expect((await upload()).status).toBe(503);
    } finally { release(); await Promise.all([first, second]); }
  });
  it('keeps existing enquiries working when private storage is unconfigured', async () => {
    vi.mocked(storage.storageReady).mockResolvedValue(false);
    vi.mocked(storage.requireStorage).mockRejectedValue(new HttpError(503, 'Private document storage is unavailable.'));
    expect((await upload()).status).toBe(503);
    const list = await call('/api/tracking/documents/list', 'POST', { code });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ documents: [], ready: false, maxBytes: 10485760, maxCount: 5 });
    expect((await call('/api/requests', 'POST', requestBody)).status).toBe(201);
    expect(await (await call('/api/health')).json()).toMatchObject({ status: 'ok', documents: { ready: false } });
    const configBody = await (await call('/api/config')).text();
    expect(configBody).toContain('"ready":false');
    expect(configBody).not.toContain('AZURE_STORAGE');
  });
  it.each([false, true])('scopes %s downloads to the authorized enquiry and sends private unchanged attachments', async (staff) => {
    vi.mocked(db.getDocument).mockResolvedValue({
      id: documentId, filename: 'original.pdf', mimeType: 'application/pdf', size: bytes.length,
      createdAt: new Date().toISOString(), uploadedBy: 'parent', blobName: 'private-storage-key',
    });
    vi.mocked(storage.downloadBlob).mockResolvedValue(Readable.from([bytes]));
    const response = await call(`${staff ? '/api/staff/requests/4/documents' : '/api/tracking/documents'}/${documentId}/download`,
      staff ? 'GET' : 'POST', staff ? undefined : { code }, staff);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="?original\.pdf"?$/);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(db.getDocument).toHaveBeenCalledWith(4, documentId);
    expect(response.headers.get('location')).toBeNull();
  });
  it('does not download a document belonging to a different enquiry', async () => {
    vi.mocked(db.getDocument).mockRejectedValue(new HttpError(404, 'Document not found.'));
    expect((await call(`/api/tracking/documents/${documentId}/download`, 'POST', { code })).status).toBe(404);
    expect(storage.downloadBlob).not.toHaveBeenCalled();
  });
  it('returns 503 rather than a blob link when download storage is unavailable', async () => {
    vi.mocked(db.getDocument).mockResolvedValue({
      id: documentId, filename: 'file.pdf', mimeType: 'application/pdf', size: bytes.length,
      createdAt: new Date().toISOString(), uploadedBy: 'parent', blobName: 'private-key',
    });
    vi.mocked(storage.downloadBlob).mockRejectedValue(new HttpError(503, 'Private document storage is unavailable.'));
    const response = await call(`/api/tracking/documents/${documentId}/download`, 'POST', { code });
    expect(response.status).toBe(503);
    expect(response.headers.get('location')).toBeNull();
    expect(await response.text()).not.toContain('private-key');
  });
  it.each([false, true])('handles a download stream failure safely (headers sent: %s)', async (afterHeaders) => {
    vi.mocked(db.getDocument).mockResolvedValue({
      id: documentId, filename: 'file.pdf', mimeType: 'application/pdf', size: bytes.length,
      createdAt: new Date().toISOString(), uploadedBy: 'parent', blobName: 'private-key',
    });
    let started = false;
    const stream = new Readable({
      read() {
        if (started) return;
        started = true;
        if (afterHeaders) this.push(bytes.subarray(0, 20));
        setTimeout(() => this.destroy(new Error('private-stream-failure-secret')), afterHeaders ? 30 : 0);
      },
    });
    vi.mocked(storage.downloadBlob).mockResolvedValue(stream);
    await expect((async () => {
      const response = await call(`/api/tracking/documents/${documentId}/download`, 'POST', { code });
      await response.arrayBuffer();
    })()).rejects.toThrow();
    expect((await call('/api/health')).status).toBe(200);
    expect(stream.destroyed).toBe(true);
  });
});
describe('anonymous request flow', () => {
  it('creates a cryptographically random tracking secret and does not expose the database id', async () => {
    const response = await call('/api/requests', 'POST', requestBody);
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result).toEqual({ code: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/), notifications: 'off' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(db.createRequest).toHaveBeenCalledWith(expect.objectContaining({ parentName: 'Parent' }), result.code, null);
    expect(hashSecret(result.code)).not.toContain(result.code);
  });
  it('queues verification only when requested and configured', async () => {
    const response = await call('/api/requests', 'POST', { ...requestBody, emailOptIn: true });
    expect(response.status).toBe(201);
    expect(db.createRequest).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.stringMatching(/^[A-Za-z0-9_-]{32}$/));
    const args = vi.mocked(db.createRequest).mock.calls[0];
    expect(args[1]).not.toBe(args[2]);
  });
  it('fails explicitly rather than claiming unconfigured email will work', async () => {
    fixtures.config.emailEnabled = false;
    expect((await call('/api/requests', 'POST', { ...requestBody, emailOptIn: true })).status).toBe(503);
    expect(db.createRequest).not.toHaveBeenCalled();
  });
  it('rejects missing privacy consent and does not persist', async () => {
    expect((await call('/api/requests', 'POST', { ...requestBody, privacyAccepted: false })).status).toBe(400);
    expect(db.createRequest).not.toHaveBeenCalled();
  });
  it('rejects cross-origin writes', async () => {
    expect((await call('/api/requests', 'POST', requestBody, false, 'https://other.example.test')).status).toBe(403);
    expect(db.createRequest).not.toHaveBeenCalled();
  });
  it('does not expose internal errors or submitted PII', async () => {
    vi.mocked(db.getProgress).mockRejectedValue(new Error('SQL error parent@example.test secret'));
    const response = await call('/api/tracking', 'POST', { code: 'a'.repeat(32) });
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain('parent@example.test');
    expect(body).not.toContain('SQL error');
  });
  it('returns a missing-request error for an unknown code', async () => {
    vi.mocked(db.getProgress).mockRejectedValue(new HttpError(404, 'Request not found.'));
    expect((await call('/api/tracking', 'POST', { code: 'a'.repeat(32) })).status).toBe(404);
  });
});
describe('staff access', () => {
  it('rejects anonymous staff access', async () => {
    expect((await call('/api/staff/requests')).status).toBe(401);
    expect(db.listRequests).not.toHaveBeenCalled();
  });
  it('honours Full Admin without a separate Admissions role', async () => {
    fixtures.user.roles = ['Full Admin'];
    expect((await call('/api/staff/pages', 'GET', undefined, true)).status).toBe(200);
  });
  it('lets contributors manage requests but not administer content', async () => {
    fixtures.user.roles = ['Admissions Contributor'];
    expect((await call('/api/staff/requests', 'GET', undefined, true)).status).toBe(200);
    expect((await call('/api/staff/pages', 'GET', undefined, true)).status).toBe(403);
  });
  it.each(['Staff', 'Learn Admin', 'Parent'])('rejects central users with only %s', async (role) => {
    fixtures.user.roles = [role];
    expect((await call('/api/staff/requests', 'GET', undefined, true)).status).toBe(403);
  });
  it('checks central roles on every authenticated request', async () => {
    expect((await call('/api/staff/requests', 'GET', undefined, true)).status).toBe(200);
    fixtures.user.roles = [];
    expect((await call('/api/staff/requests', 'GET', undefined, true)).status).toBe(403);
    expect(platform.centralUser).toHaveBeenCalledTimes(2);
  });
  it('ends access immediately when the central user is disabled', async () => {
    fixtures.user.isActive = false;
    expect((await call('/api/staff/requests', 'GET', undefined, true)).status).toBe(401);
  });
  it('ends sessions when the central session version changes', async () => {
    fixtures.user.sessionVersion = 4;
    expect((await call('/api/staff/requests', 'GET', undefined, true)).status).toBe(401);
  });
  it('fails closed on central API outage', async () => {
    vi.mocked(platform.centralUser).mockRejectedValue(new HttpError(503, 'Central API unavailable.'));
    expect((await call('/api/staff/requests', 'GET', undefined, true)).status).toBe(503);
    expect(db.listRequests).not.toHaveBeenCalled();
  });
  it('rejects an expired token', async () => {
    const old = cookie;
    const token = await new SignJWT({ sv: 3 }).setProtectedHeader({ alg: 'HS256' }).setSubject('7')
      .setIssuer('jess-admissions').setAudience('admissions-staff').setExpirationTime(1)
      .sign(new TextEncoder().encode(fixtures.config.SESSION_SECRET));
    cookie = `${cookieName}=${token}`;
    try { expect((await call('/api/staff/requests', 'GET', undefined, true)).status).toBe(401); }
    finally { cookie = old; }
    expect(platform.centralUser).not.toHaveBeenCalled();
  });
  it('validates login through the central platform before issuing a separate cookie', async () => {
    const response = await call('/api/auth/session', 'POST', { idToken: 'verified-by-central-platform-token' });
    expect(response.status).toBe(200);
    expect(platform.centralSession).toHaveBeenCalledWith('verified-by-central-platform-token');
    const issued = response.headers.get('set-cookie');
    expect(issued).toContain('admissions_session=');
    expect(issued).toContain('HttpOnly');
    expect(issued).toContain('SameSite=Strict');
  });
  it('rejects sign-in without an Admissions role and issues no cookie', async () => {
    fixtures.user.roles = ['Staff'];
    const response = await call('/api/auth/session', 'POST', { idToken: 'verified-by-central-platform-token' });
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
  it('retains optimistic concurrency conflict errors', async () => {
    vi.mocked(db.updateRequest).mockRejectedValue(new HttpError(409, 'Reload before saving.', 'REVISION_CONFLICT'));
    const response = await call('/api/staff/requests/1', 'PATCH', { revision: 1, stage: 'In progress' }, true);
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('REVISION_CONFLICT');
  });
});
describe('notification endpoints', () => {
  it('requires the complete tracking secret to change preferences', async () => {
    expect((await call('/api/tracking/notifications', 'POST', { code: '123', enabled: true })).status).toBe(400);
    expect(db.setNotifications).not.toHaveBeenCalled();
  });
  describe('public submission limits', () => {
    it('accepts five submissions per IP per hour and rejects the sixth', async () => {
      const limitedServer = createApp().listen(0, '127.0.0.1');
      await once(limitedServer, 'listening');
      const url = `http://127.0.0.1:${(limitedServer.address() as AddressInfo).port}/api/requests`;
      try {
        for (let i = 0; i < 5; i++) {
          const response = await fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Origin: fixtures.config.PUBLIC_BASE_URL },
            body: JSON.stringify(requestBody),
          });
          expect(response.status).toBe(201);
        }
        const blocked = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Origin: fixtures.config.PUBLIC_BASE_URL },
          body: JSON.stringify(requestBody),
        });
        expect(blocked.status).toBe(429);
        expect(await blocked.json()).toMatchObject({ code: 'RATE_LIMITED' });
        expect(db.createRequest).toHaveBeenCalledTimes(5);
      } finally { await new Promise<void>((resolve) => limitedServer.close(() => resolve())); }
    });
  });
  it('allows opt-out even when email is no longer configured', async () => {
    fixtures.config.emailEnabled = false;
    expect((await call('/api/tracking/notifications', 'POST', { code: 'a'.repeat(32), enabled: false })).status).toBe(200);
    expect(db.setNotifications).toHaveBeenCalledWith('a'.repeat(32), false, expect.any(String));
  });
  it('confirms using a separate token without issuing a session', async () => {
    const response = await call('/api/notifications/confirm', 'POST', { token: 'b'.repeat(32) });
    expect(response.status).toBe(200);
    expect(db.verifyNotifications).toHaveBeenCalledWith('b'.repeat(32));
    expect(response.headers.get('set-cookie')).toBeNull();
  });
  it('surfaces expired confirmation links', async () => {
    vi.mocked(db.verifyNotifications).mockRejectedValue(new HttpError(400, 'This confirmation link is expired.'));
    expect((await call('/api/notifications/confirm', 'POST', { token: 'b'.repeat(32) })).status).toBe(400);
  });
});
