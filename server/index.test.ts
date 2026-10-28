import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  config: { SQL_SERVERLESS_ENABLED: false, PORT: 8081 },
  connect: vi.fn(), migrate: vi.fn(), close: vi.fn(), startMail: vi.fn(),
  createApp: vi.fn(), listen: vi.fn(), serverClose: vi.fn(), fatal: vi.fn(),
  readiness: undefined as (() => boolean) | undefined,
}));
vi.mock('./config.js', () => ({ config: state.config }));
vi.mock('./db.js', () => ({
  pool: { connect: state.connect, close: state.close, config: {} }, migrate: state.migrate,
}));
vi.mock('./mail.js', () => ({ startMailWorker: state.startMail }));
vi.mock('./errors.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: state.fatal } }));
vi.mock('./app.js', () => ({ createApp: state.createApp }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  state.config.SQL_SERVERLESS_ENABLED = false;
  state.readiness = undefined;
  state.createApp.mockImplementation((isReady?: () => boolean) => {
    state.readiness = isReady;
    return { listen: state.listen };
  });
  state.listen.mockReturnValue({ close: state.serverClose });
  state.serverClose.mockImplementation((callback: () => void) => callback());
  state.startMail.mockReturnValue(vi.fn());
  vi.spyOn(process, 'on').mockReturnValue(process);
});
afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; });

describe('startup sequencing', () => {
  it('preserves normal connect, migrate, worker, then listen startup order', async () => {
    await import('./index.js');
    expect(state.connect.mock.invocationCallOrder[0]).toBeLessThan(state.migrate.mock.invocationCallOrder[0]);
    expect(state.migrate.mock.invocationCallOrder[0]).toBeLessThan(state.startMail.mock.invocationCallOrder[0]);
    expect(state.startMail.mock.invocationCallOrder[0]).toBeLessThan(state.listen.mock.invocationCallOrder[0]);
    expect(state.listen.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(process.on).mock.invocationCallOrder[0]);
    expect(state.readiness).toBeUndefined();
  });
  it('listens before waking SQL but is only ready after migration finishes', async () => {
    state.config.SQL_SERVERLESS_ENABLED = true;
    state.connect.mockImplementation(async () => {
      expect(state.listen).toHaveBeenCalledOnce();
      expect(state.readiness?.()).toBe(false);
    });
    state.migrate.mockImplementation(async () => { expect(state.readiness?.()).toBe(false); });
    await import('./index.js');
    expect(state.readiness?.()).toBe(true);
    expect(state.migrate).toHaveBeenCalledOnce();
  });
  it('fails and closes the early listener on permanent connect errors without migration', async () => {
    state.config.SQL_SERVERLESS_ENABLED = true;
    state.connect.mockRejectedValue({ code: 'ELOGIN', number: 18456 });
    await import('./index.js');
    expect(state.connect).toHaveBeenCalledOnce();
    expect(state.migrate).not.toHaveBeenCalled();
    expect(state.serverClose).toHaveBeenCalledOnce();
    expect(state.close).toHaveBeenCalledOnce();
    expect(state.readiness?.()).toBe(false);
    expect(process.exitCode).toBe(1);
  });
  it('never retries a migration write even if its acknowledgement is transient', async () => {
    state.config.SQL_SERVERLESS_ENABLED = true;
    state.migrate.mockRejectedValue({ code: 'ESOCKET' });
    await import('./index.js');
    expect(state.migrate).toHaveBeenCalledOnce();
    expect(state.connect).toHaveBeenCalledOnce();
    expect(state.readiness?.()).toBe(false);
    expect(state.serverClose).toHaveBeenCalledOnce();
    expect(state.startMail).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
  it('registers shutdown before warming and cancels startup on SIGTERM', async () => {
    state.config.SQL_SERVERLESS_ENABLED = true;
    state.connect.mockImplementation(async () => {
      const sigterm = vi.mocked(process.on).mock.calls.find(([signal]) => signal === 'SIGTERM')?.[1] as (() => void) | undefined;
      expect(sigterm).toBeDefined();
      sigterm!();
      throw { number: 40613 };
    });
    await import('./index.js');
    expect(state.connect).toHaveBeenCalledOnce();
    expect(state.migrate).not.toHaveBeenCalled();
    expect(state.startMail).not.toHaveBeenCalled();
    expect(state.serverClose).toHaveBeenCalled();
    expect(state.close).toHaveBeenCalled();
    expect(state.fatal).not.toHaveBeenCalled();
    expect(process.exitCode).not.toBe(1);
  });
  it('does not open a normal listener after a startup failure', async () => {
    state.connect.mockRejectedValue(new Error('offline'));
    await import('./index.js');
    expect(state.listen).not.toHaveBeenCalled();
    expect(state.startMail).not.toHaveBeenCalled();
    expect(state.close).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });
});
