import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  config: { LOG_LEVEL: 'silent', AZURE_STORAGE_CONNECTION_STRING: 'account-key-test', AZURE_STORAGE_CONTAINER: 'admissions-files' },
  properties: vi.fn(), upload: vi.fn(), remove: vi.fn(), download: vi.fn(),
  connection: vi.fn(), blob: vi.fn(),
  warn: vi.fn(), error: vi.fn(),
}));
vi.mock('./config.js', () => ({ config: state.config }));
vi.mock('./errors.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./errors.js')>(),
  logger: { warn: state.warn, error: state.error },
}));
vi.mock('@azure/storage-blob', () => ({
  BlobServiceClient: class {
    static fromConnectionString = state.connection;
  },
}));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  state.config.AZURE_STORAGE_CONNECTION_STRING = 'account-key-test';
  state.properties.mockResolvedValue({});
  state.connection.mockReturnValue({ getContainerClient: () => ({
    getProperties: state.properties, getBlockBlobClient: state.blob,
  }) });
  state.blob.mockReturnValue({ uploadData: state.upload, deleteIfExists: state.remove, download: state.download });
});
describe('private Azure-only document storage', () => {
  it('reports missing configuration and explicitly refuses operations', async () => {
    state.config.AZURE_STORAGE_CONNECTION_STRING = '';
    const storage = await import('./documentStorage.js');
    expect(await storage.storageReady()).toBe(false);
    await expect(storage.uploadBlob('name', Buffer.from('bytes'), 'application/pdf')).rejects.toMatchObject({ status: 503 });
    await expect(storage.downloadBlob('name')).rejects.toMatchObject({ status: 503 });
    expect(state.blob).not.toHaveBeenCalled();
    expect(state.warn).toHaveBeenCalledOnce();
    expect(state.warn).toHaveBeenCalledWith({ operation: 'configure', reason: 'not_configured' }, expect.any(String));
  });
  it.each(['blob', 'container'])('refuses public %s access', async (blobPublicAccess) => {
    state.properties.mockResolvedValue({ blobPublicAccess });
    const storage = await import('./documentStorage.js');
    expect(await storage.storageReady()).toBe(false);
    await expect(storage.uploadBlob('name', Buffer.from('bytes'), 'application/pdf')).rejects.toMatchObject({ status: 503 });
    expect(state.upload).not.toHaveBeenCalled();
    expect(state.warn).toHaveBeenCalledWith({ operation: 'readiness', reason: 'public_container' }, expect.any(String));
  });
  it('uploads original bytes with a collision guard and bounded concurrency', async () => {
    const storage = await import('./documentStorage.js');
    const bytes = Buffer.from('original bytes');
    await storage.uploadBlob('private-key', bytes, 'application/pdf');
    expect(state.upload).toHaveBeenCalledWith(bytes, expect.objectContaining({
      concurrency: 1, conditions: { ifNoneMatch: '*' },
      blobHTTPHeaders: { blobContentType: 'application/pdf', blobCacheControl: 'private, no-store' },
    }));
    expect(state.upload.mock.calls[0][0]).toBe(bytes);
  });
  it('streams private download content and deletes known failed writes', async () => {
    const storage = await import('./documentStorage.js');
    const stream = Readable.from([Buffer.from('original')]);
    state.download.mockResolvedValue({ readableStreamBody: stream });
    expect(await storage.downloadBlob('private-key')).toBe(stream);
    await storage.deleteBlob('private-key');
    expect(state.remove).toHaveBeenCalledOnce();
  });
  it('redacts SDK failures and reports readiness false', async () => {
    state.properties.mockRejectedValue(new Error('secret connection'));
    const storage = await import('./documentStorage.js');
    expect(await storage.storageReady()).toBe(false);
    await expect(storage.requireStorage()).rejects.toMatchObject({ status: 503 });
    state.properties.mockResolvedValue({});
    state.upload.mockRejectedValue(new Error('secret connection'));
    await expect(storage.uploadBlob('name', Buffer.from('x'), 'application/pdf')).rejects.toThrow('Private document storage is unavailable.');
    expect(state.error).toHaveBeenCalledWith(expect.objectContaining({ operation: 'readiness', errorType: 'Error' }), expect.any(String));
    expect(state.error).toHaveBeenCalledWith(expect.objectContaining({ operation: 'upload', errorType: 'Error' }), expect.any(String));
    expect(JSON.stringify(state.error.mock.calls)).not.toContain('secret connection');
  });
  it('logs initialization failures without configuration values or raw exceptions', async () => {
    const secret = 'https://account.blob.core.windows.net/private?sig=connection-secret';
    state.connection.mockImplementationOnce(() => { throw new Error(secret); });
    const storage = await import('./documentStorage.js');
    expect(await storage.storageReady()).toBe(false);
    expect(state.error).toHaveBeenCalledWith({ operation: 'configure', statusCode: undefined, errorCode: 'Unknown', errorType: 'Error' }, expect.any(String));
    expect(JSON.stringify(state.error.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(state.error.mock.calls)).not.toContain('account-key-test');
  });
  it.each(['upload', 'delete', 'download'] as const)('safely logs failed %s operations and preserves generic 503s', async (operation) => {
    const secret = 'tracking-secret-https://account.blob.core.windows.net/private?sig=signed-secret';
    const azureError = Object.assign(new Error(secret), {
      name: 'RestError', code: 'AuthorizationPermissionMismatch', statusCode: 403,
      request: { url: secret, headers: { authorization: secret } }, response: { bodyAsText: secret },
    });
    const storage = await import('./documentStorage.js');
    let action: () => Promise<unknown>;
    if (operation === 'upload') {
      state.upload.mockRejectedValueOnce(azureError);
      action = () => storage.uploadBlob(secret, Buffer.from(secret), 'application/pdf');
    } else if (operation === 'delete') {
      state.remove.mockRejectedValueOnce(azureError);
      action = () => storage.deleteBlob(secret);
    } else {
      state.download.mockRejectedValueOnce(azureError);
      action = () => storage.downloadBlob(secret);
    }
    await expect(action()).rejects.toMatchObject({ status: 503, message: 'Private document storage is unavailable. Please contact Admissions.' });
    expect(state.error).toHaveBeenCalledWith({
      operation, statusCode: 403, errorCode: 'AuthorizationPermissionMismatch', errorType: 'RestError',
    }, 'Private document storage operation failed.');
    expect(JSON.stringify([...state.error.mock.calls, ...state.warn.mock.calls])).not.toContain(secret);
    expect(JSON.stringify(state.error.mock.calls)).not.toMatch(/signed-secret|stack|authorization|request|bodyAsText/);
  });
  it('does not trust arbitrary Azure error names, codes or status values', async () => {
    const secret = 'https://secret.example.invalid?sig=tracking-secret';
    state.properties.mockRejectedValue(Object.assign(new Error(secret), { name: secret, code: secret, statusCode: secret }));
    const storage = await import('./documentStorage.js');
    expect(await storage.storageReady()).toBe(false);
    expect(state.error).toHaveBeenCalledWith({
      operation: 'readiness', statusCode: undefined, errorCode: 'Unknown', errorType: 'Unknown',
    }, expect.any(String));
    expect(JSON.stringify(state.error.mock.calls)).not.toContain(secret);
  });
  it('logs download stream failures safely', async () => {
    const storage = await import('./documentStorage.js');
    const stream = new Readable({ read() {} });
    state.download.mockResolvedValue({ readableStreamBody: stream });
    await storage.downloadBlob('private-key');
    stream.emit('error', Object.assign(new Error('signed-url-secret'), { name: 'RestError', code: 'ECONNRESET' }));
    expect(state.error).toHaveBeenCalledWith(expect.objectContaining({ operation: 'download', errorCode: 'ECONNRESET' }), expect.any(String));
    expect(JSON.stringify(state.error.mock.calls)).not.toContain('signed-url-secret');
    stream.destroy();
  });
  it('logs a missing download stream once without leaking Azure response metadata', async () => {
    const storage = await import('./documentStorage.js');
    state.download.mockResolvedValue({ request: { url: 'signed-url-secret' } });
    await expect(storage.downloadBlob('private-key')).rejects.toMatchObject({ status: 503 });
    expect(state.error).toHaveBeenCalledOnce();
    expect(state.error).toHaveBeenCalledWith({ operation: 'download', reason: 'missing_stream' }, expect.any(String));
    expect(JSON.stringify(state.error.mock.calls)).not.toContain('signed-url-secret');
  });
});
