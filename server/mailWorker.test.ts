import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  config: {
    PUBLIC_BASE_URL: 'https://admissions.example.test', emailEnabled: true, LOG_LEVEL: 'silent',
    SQL_SERVERLESS_ENABLED: true, MAIL_FROM_ADDRESS: 'sender@example.test',
  },
  getToken: vi.fn(), claim: vi.fn(), complete: vi.fn(), fail: vi.fn(),
}));
vi.mock('./config.js', () => ({ config: state.config }));
vi.mock('@azure/identity', () => ({
  ClientSecretCredential: class { getToken = state.getToken; },
}));
vi.mock('./db.js', () => ({ claimMail: state.claim, completeMail: state.complete, failMail: state.fail }));
import { processMailBatch, startMailWorker } from './mail.js';

const job = { id: 1, requestId: 4, kind: 'update', email: 'parent@example.test', token: null, attempts: 1 };
beforeEach(() => {
  vi.resetAllMocks();
  state.config.SQL_SERVERLESS_ENABLED = true;
  state.config.emailEnabled = true;
  state.getToken.mockResolvedValue({ token: 'test-token' });
  state.claim.mockResolvedValue(null);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('manual serverless mail processing', () => {
  it('does not schedule polling or touch SQL in serverless mode', async () => {
    vi.useFakeTimers();
    const stop = startMailWorker();
    await vi.advanceTimersByTimeAsync(60000);
    expect(vi.getTimerCount()).toBe(0);
    expect(state.claim).not.toHaveBeenCalled();
    await stop();
  });
  it('sends and completes actual queued messages with a ten-job batch bound', async () => {
    state.claim.mockResolvedValue(job);
    expect(await processMailBatch()).toEqual({ sent: 10, failed: 0 });
    expect(state.claim).toHaveBeenCalledTimes(10);
    expect(fetch).toHaveBeenCalledTimes(10);
    expect(state.complete).toHaveBeenCalledTimes(10);
    expect(state.fail).not.toHaveBeenCalled();
  });
  it('rejects concurrent in-process runs and releases the lock on errors', async () => {
    let reject!: (error: Error) => void;
    state.claim.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    const first = processMailBatch();
    expect(() => processMailBatch()).toThrow('already running');
    reject(new Error('SQL unavailable'));
    await expect(first).rejects.toThrow('SQL unavailable');
    expect(await processMailBatch()).toEqual({ sent: 0, failed: 0 });
  });
  it('records delivery failures instead of reporting silent success', async () => {
    state.claim.mockResolvedValueOnce(job);
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 429 } as Response);
    expect(await processMailBatch()).toEqual({ sent: 0, failed: 1 });
    expect(state.fail).toHaveBeenCalledWith(job);
    expect(state.complete).not.toHaveBeenCalled();
  });
  it('does not replay an uncertain completion write or immediately requeue delivered mail', async () => {
    state.claim.mockResolvedValueOnce(job);
    state.complete.mockRejectedValueOnce({ code: 'ESOCKET' });
    await expect(processMailBatch()).rejects.toMatchObject({ code: 'ESOCKET' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(state.complete).toHaveBeenCalledOnce();
    expect(state.fail).not.toHaveBeenCalled();
  });
  it('fails explicitly without SQL when email is unconfigured', () => {
    state.config.emailEnabled = false;
    expect(() => processMailBatch()).toThrow('not configured');
    expect(state.claim).not.toHaveBeenCalled();
  });
  it('preserves the five-second polling worker and stop behavior in normal mode', async () => {
    vi.useFakeTimers();
    state.config.SQL_SERVERLESS_ENABLED = false;
    state.claim.mockResolvedValueOnce(job);
    const stop = startMailWorker();
    await vi.advanceTimersByTimeAsync(4999);
    expect(state.claim).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.complete).toHaveBeenCalledWith(job);
    await stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(state.claim).toHaveBeenCalledTimes(2);
  });
});
