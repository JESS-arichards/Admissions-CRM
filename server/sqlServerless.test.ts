import { afterEach, describe, expect, it, vi } from 'vitest';
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('./errors.js', () => ({ logger }));
import { connectWithWakeRetry, isTransientSqlError } from './sqlServerless.js';

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
describe('bounded SQL wake connection retries', () => {
  it('recognizes nested driver errors, including database resuming 40613', () => {
    expect(isTransientSqlError({ code: 'ELOGIN', originalError: { info: { number: 40613 } } })).toBe(true);
    expect(isTransientSqlError({ precedingErrors: [{ number: 40197 }] })).toBe(true);
    expect(isTransientSqlError({ cause: { code: 'ECONNRESET' } })).toBe(true);
    expect(isTransientSqlError({ number: 18456, code: 'ELOGIN' })).toBe(false);
    expect(isTransientSqlError({ number: 208 })).toBe(false);
    const circular = { cause: {} };
    circular.cause = circular;
    expect(isTransientSqlError(circular)).toBe(false);
  });
  it('safely rejects malformed or hostile error objects', () => {
    expect(isTransientSqlError({ number: '40613', code: 40613 })).toBe(false);
    expect(isTransientSqlError({ precedingErrors: { some: () => true } })).toBe(false);
    expect(isTransientSqlError({ precedingErrors: [null, 'ETIMEOUT', { number: 40613 }] })).toBe(true);
    const hostile = new Proxy({}, { get() { throw new Error('getter failed'); } });
    expect(isTransientSqlError(hostile)).toBe(false);
    let deep: Record<string, unknown> = { number: 40613 };
    for (let i = 0; i < 20; i++) deep = { cause: deep };
    expect(isTransientSqlError(deep)).toBe(false);
  });
  it('backs off before success and limits each connect attempt to ten seconds', async () => {
    vi.useFakeTimers();
    const pool = { config: {}, connect: vi.fn().mockRejectedValueOnce({ number: 40613 }).mockRejectedValueOnce({ code: 'ETIMEOUT' }).mockResolvedValue(undefined) };
    const promise = connectWithWakeRetry(pool);
    expect(pool.config).toMatchObject({ connectionTimeout: 10000, options: { connectTimeout: 10000 } });
    await vi.advanceTimersByTimeAsync(999);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2001);
    await promise;
    expect(pool.connect).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith({ attempt: 1, retryInMs: 1000, sqlNumber: 40613, sqlCode: undefined }, expect.stringContaining('retrying'));
    expect(logger.warn).toHaveBeenCalledWith({ attempt: 2, retryInMs: 2000, sqlNumber: undefined, sqlCode: 'ETIMEOUT' }, expect.stringContaining('retrying'));
    expect(logger.info).toHaveBeenCalledWith({ attempt: 3 }, expect.stringContaining('established'));
  });
  it('logs only non-secret error fields', async () => {
    const error = Object.assign(new Error('Login failed for user secret-user with password hunter2'), { number: 18456, code: 'ELOGIN' });
    await expect(connectWithWakeRetry({ config: {}, connect: vi.fn().mockRejectedValue(error) })).rejects.toBe(error);
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/secret-user|hunter2/);
    expect(logger.error).toHaveBeenCalledWith({ attempt: 1, transient: false, sqlNumber: 18456, sqlCode: 'ELOGIN' }, expect.any(String));
  });
  it('stops retrying when shutdown starts during warm-up', async () => {
    vi.useFakeTimers();
    let stopping = false;
    const pool = { config: {}, connect: vi.fn().mockRejectedValue({ number: 40613 }) };
    const assertion = expect(connectWithWakeRetry(pool, () => stopping)).rejects.toMatchObject({ number: 40613 });
    await vi.advanceTimersByTimeAsync(0);
    stopping = true;
    await vi.runAllTimersAsync();
    await assertion;
    expect(pool.connect).toHaveBeenCalledOnce();
  });
  it('stops within ninety seconds even when wake errors persist', async () => {
    vi.useFakeTimers();
    const start = Date.now(), error = { number: 40613 };
    const pool = { config: {}, connect: vi.fn().mockRejectedValue(error) };
    const assertion = expect(connectWithWakeRetry(pool)).rejects.toBe(error);
    await vi.runAllTimersAsync();
    await assertion;
    expect(Date.now() - start).toBe(90000);
    expect(pool.connect.mock.calls.length).toBeLessThan(15);
    expect(logger.error).toHaveBeenCalledWith({ attempt: pool.connect.mock.calls.length }, expect.stringContaining('exhausted'));
  });
  it('does not retry authentication, configuration or unknown failures', async () => {
    const error = { code: 'ELOGIN', number: 18456 };
    const pool = { config: {}, connect: vi.fn().mockRejectedValue(error) };
    await expect(connectWithWakeRetry(pool)).rejects.toBe(error);
    expect(pool.connect).toHaveBeenCalledOnce();
  });
  it('includes time spent connecting in its budget and shortens the last attempt', async () => {
    vi.useFakeTimers();
    const start = Date.now(), timeouts: number[] = [];
    const pool = {
      config: { connectionTimeout: 0 },
      connect: vi.fn(async () => {
        timeouts.push(pool.config.connectionTimeout);
        if (timeouts.length > 1) await new Promise((resolve) => setTimeout(resolve, pool.config.connectionTimeout));
        throw { code: 'ETIMEOUT' };
      }),
    };
    const assertion = expect(connectWithWakeRetry(pool)).rejects.toMatchObject({ code: 'ETIMEOUT' });
    await vi.runAllTimersAsync();
    await assertion;
    expect(Date.now() - start).toBe(90000);
    expect(timeouts.at(-1)).toBe(5000);
    expect(pool.config.connectionTimeout).toBe(10000);
  });
});
