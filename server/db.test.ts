import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CentralUser, NewRequest } from '../shared/contracts.js';
import { hashSecret } from './secrets.js';

const state = vi.hoisted(() => ({
  calls: [] as { query: string; inputs: Record<string, unknown> }[],
  results: [] as unknown[],
  commit: vi.fn(), rollback: vi.fn(),
}));
vi.mock('./config.js', () => ({ config: {
  SQL_CONNECTION_STRING: 'test', LOG_LEVEL: 'silent',
} }));
vi.mock('mssql', () => {
  class Request {
    private values: Record<string, unknown> = {};
    input(key: string, _type: unknown, value: unknown) { this.values[key] = value; return this; }
    async query(query: string) {
      state.calls.push({ query, inputs: { ...this.values } });
      return state.results.shift() ?? { recordset: [], rowsAffected: [1] };
    }
  }
  class Transaction { async begin() {} commit = state.commit; rollback = state.rollback; }
  class ConnectionPool { on() {} request() { return new Request(); } }
  return { default: {
    ConnectionPool, Request, Transaction, ISOLATION_LEVEL: { SERIALIZABLE: 4 },
    Char: vi.fn(), VarChar: vi.fn(), NVarChar: vi.fn(), Int: 'int', Bit: 'bit', MAX: 'max',
  } };
});
import * as db from './db.js';
const user: CentralUser = { id: 1, email: 'staff@example.test', displayName: 'Staff', roles: ['Admissions Admin'], isActive: true, sessionVersion: 0 };
beforeEach(() => { state.calls.length = 0; state.results.length = 0; vi.clearAllMocks(); });
describe('persisted request privacy', () => {
  it('stores only a digest of the tracking code and queues confirmation atomically', async () => {
    state.results.push({ recordset: [{ id: 4 }] });
    const request: NewRequest = {
      kind: 'Enquiry', parentName: 'Parent', email: 'parent@example.test', phone: '', yearGroup: '',
      message: 'Admissions question', emailOptIn: true, privacyAccepted: true, website: '',
    };
    await db.createRequest(request, 'a'.repeat(32), 'b'.repeat(32));
    expect(state.calls[0].inputs.hash).toBe(hashSecret('a'.repeat(32)));
    expect(state.calls[0].inputs.verification).toBe(hashSecret('b'.repeat(32)));
    expect(state.calls[0].inputs.notifications).toBe('pending');
    expect(state.calls.at(-1)?.inputs).toMatchObject({ id: 4, kind: 'confirmation', token: 'b'.repeat(32) });
    expect(state.commit).toHaveBeenCalledOnce();
  });
  it('projects public progress explicitly, never contact details or internal notes', async () => {
    const now = new Date();
    state.results.push({ recordset: [{
      id: 4, kind: 'Enquiry', stage: 'New', createdAt: now, updatedAt: now, notifications: 'off',
      parentName: 'Private Parent', email: 'private@example.test',
    }] }, { recordset: [{
      id: 2, stage: 'New', publicMessage: 'Received', createdAt: now,
      internalNote: 'Private note', actorName: 'Private Staff',
    }] });
    const result = await db.getProgress('a'.repeat(32));
    expect(Object.keys(result).sort()).toEqual(['createdAt', 'kind', 'notifications', 'stage', 'timeline', 'updatedAt']);
    expect(result.timeline[0]).toEqual({ id: 2, stage: 'New', publicMessage: 'Received', createdAt: now.toISOString() });
    expect(JSON.stringify(result)).not.toContain('Private');
    expect(state.calls[1].query).toContain('isPublic=1');
  });
});
describe('staff updates and concurrency', () => {
  it('does not publish internal-only notes or queue email', async () => {
    state.results.push({ recordset: [{ stage: 'New' }] });
    await db.updateRequest(4, { revision: 1, stage: 'New', publicMessage: '', internalNote: 'Private', assignment: 'keep' }, user);
    expect(state.calls[2].inputs.visible).toBe(false);
    expect(state.calls).toHaveLength(3);
    expect(state.commit).toHaveBeenCalledOnce();
  });
  it('publishes stage changes and queues updates only for verified recipients', async () => {
    state.results.push({ recordset: [{ stage: 'New' }] });
    await db.updateRequest(4, { revision: 1, stage: 'In progress', publicMessage: '', internalNote: '', assignment: 'me' }, user);
    expect(state.calls[2].inputs.visible).toBe(true);
    expect(state.calls[3].query).toContain("notifications='verified'");
  });
  it('rolls back stale revisions before writing history or mail', async () => {
    state.results.push({ recordset: [{ stage: 'New' }] }, { rowsAffected: [0] });
    await expect(db.updateRequest(4, { revision: 1, stage: 'New', publicMessage: 'Update', internalNote: '', assignment: 'keep' }, user))
      .rejects.toMatchObject({ status: 409 });
    expect(state.calls).toHaveLength(2);
    expect(state.rollback).toHaveBeenCalledOnce();
    expect(state.commit).not.toHaveBeenCalled();
  });
});
describe('verified notification consent', () => {
  it('limits confirmation tokens to one use and enforces expiration in the database', async () => {
    await db.verifyNotifications('b'.repeat(32));
    expect(state.calls[0].inputs.hash).toBe(hashSecret('b'.repeat(32)));
    expect(state.calls[0].query).toContain('verificationHash=NULL');
    expect(state.calls[0].query).toContain('verificationExpires>SYSUTCDATETIME()');
  });
  it('reports already-used or expired confirmation tokens', async () => {
    state.results.push({ rowsAffected: [0] });
    await expect(db.verifyNotifications('b'.repeat(32))).rejects.toMatchObject({ status: 400 });
  });
  it('throttles resending confirmation mail', async () => {
    state.results.push({ recordset: [{ id: 1, notifications: 'pending', verificationSentAt: new Date() }] });
    await expect(db.setNotifications('a'.repeat(32), true, 'b'.repeat(32))).rejects.toMatchObject({ status: 429 });
    expect(state.calls).toHaveLength(1);
  });
  it('cancels pending messages and clears verification on opt-out', async () => {
    state.results.push({ recordset: [{ id: 1, notifications: 'verified', verificationSentAt: null }] });
    await db.setNotifications('a'.repeat(32), false, 'b'.repeat(32));
    expect(state.calls[1].inputs).toMatchObject({ enabled: false, hash: null });
    expect(state.calls[1].query).toContain('cancelledAt=SYSUTCDATETIME(),token=NULL');
    expect(state.calls).toHaveLength(2);
  });
  it('never sends update mail to an unverified or unsubscribed recipient', async () => {
    state.results.push({ recordset: [{ id: 8, requestId: 1, kind: 'update', token: null, attempts: 1 }] },
      { recordset: [{ email: 'parent@example.test', notifications: 'off' }] });
    expect(await db.claimMail()).toBeNull();
    expect(state.calls[2].query).toContain('cancelledAt=SYSUTCDATETIME()');
  });
  it('does not send superseded confirmation links', async () => {
    state.results.push({ recordset: [{ id: 8, requestId: 1, kind: 'confirmation', token: 'b'.repeat(32), attempts: 1 }] },
      { recordset: [{ email: 'parent@example.test', notifications: 'pending',
        verificationHash: hashSecret('c'.repeat(32)), verificationExpires: new Date(Date.now() + 100000) }] });
    expect(await db.claimMail()).toBeNull();
  });
  it('leases mail across workers and removes tokens after sending', async () => {
    state.results.push({ recordset: [{ id: 8, requestId: 1, kind: 'update', token: null, attempts: 1 }] },
      { recordset: [{ email: 'parent@example.test', notifications: 'verified' }] });
    const job = await db.claimMail();
    expect(job).toMatchObject({ id: 8, email: 'parent@example.test' });
    expect(state.calls[0].query).toContain('UPDLOCK,READPAST,READCOMMITTEDLOCK');
    expect(state.calls[0].query).toContain('attempts<8');
    await db.completeMail(job!);
    expect(state.calls.at(-1)?.query).toContain('sentAt=SYSUTCDATETIME(),token=NULL');
  });
  it('bounds retries and clears exhausted confirmation tokens', async () => {
    await db.failMail({ id: 8, requestId: 1, kind: 'confirmation', token: 'b'.repeat(32), email: 'parent@example.test', attempts: 8 });
    expect(state.calls[0].query).toContain('@attempts>=8');
    expect(state.calls[0].inputs.delay).toBeLessThanOrEqual(3600);
  });
});
