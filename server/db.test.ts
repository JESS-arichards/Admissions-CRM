import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CentralUser, NewRequest } from '../shared/contracts.js';
import { hashSecret } from './secrets.js';
import sql from 'mssql';

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
    UniqueIdentifier: 'uuid', Char: vi.fn(), VarChar: vi.fn(), NVarChar: vi.fn((length: number | string) => {
      if (typeof length === 'number' && length > 4000) throw new Error('SQL Server nvarchar length exceeds 4000.');
      return { length };
    }), Int: 'int', Bit: 'bit', MAX: 'max',
  } };
});
import * as db from './db.js';
const user: CentralUser = { id: 1, email: 'staff@example.test', displayName: 'Staff', roles: ['Admissions Admin'], isActive: true, sessionVersion: 0 };
beforeEach(() => { state.calls.length = 0; state.results.length = 0; vi.clearAllMocks(); });
describe('SQL Server note storage', () => {
  it('uses MAX in the startup schema instead of an invalid fixed length above 4000', async () => {
    await db.migrate();
    const schema = state.calls[0].query;
    expect(schema).toContain("internalNote nvarchar(max) NOT NULL");
    const lengths = [...schema.matchAll(/nvarchar\((\d+)\)/gi)].map((match) => Number(match[1]));
    expect(lengths.length).toBeGreaterThan(0);
    expect(lengths.every((length) => length <= 4000)).toBe(true);
  });
  it('preserves a full-length staff note plus assignment audit text', async () => {
    state.results.push({ recordset: [{ stage: 'New' }] });
    const note = 'x'.repeat(4000);
    await db.updateRequest(4, { revision: 1, stage: 'New', publicMessage: '', internalNote: note, assignment: 'me' }, user);
    expect(sql.NVarChar).toHaveBeenCalledWith(sql.MAX);
    expect(state.calls[2].inputs.internal).toBe(`Assigned to the acting staff member.\n${note}`);
    expect(state.calls[2].inputs.visible).toBe(false);
    expect(state.commit).toHaveBeenCalledOnce();
  });
});
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
  describe('document persistence and cross-instance limits', () => {
    const metadata = { filename: 'file.pdf', mimeType: 'application/pdf', size: 40 };
    it('locks an enquiry across count, upload and metadata insertion', async () => {
      state.results.push({ recordset: [{ id: 4 }] }, { recordset: [{ count: 4 }] });
      const upload = vi.fn(), cleanup = vi.fn();
      await db.addDocument(4, metadata, 7, upload, cleanup);
      expect(state.calls[0].query).toContain('WITH (UPDLOCK,HOLDLOCK)');
      expect(state.calls[1].query).toContain('COUNT(*)');
      expect(state.calls[2].inputs).toMatchObject({ requestId: 4, ...metadata, actorId: 7, uploadedBy: 'staff' });
      expect(upload).toHaveBeenCalledWith(expect.stringMatching(/^enquiries\/4\/[a-f0-9-]+$/));
      expect(cleanup).not.toHaveBeenCalled();
      expect(state.commit).toHaveBeenCalledOnce();
    });
    it('rejects the sixth document before blob upload, including parent/staff combined', async () => {
      state.results.push({ recordset: [{ id: 4 }] }, { recordset: [{ count: 5 }] });
      const upload = vi.fn(), cleanup = vi.fn();
      await expect(db.addDocument(4, metadata, null, upload, cleanup)).rejects.toMatchObject({ status: 409 });
      expect(upload).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled();
      expect(state.rollback).toHaveBeenCalledOnce();
    });
    it('cleans up the uploaded blob after a known insert failure', async () => {
      state.results.push({ recordset: [{ id: 4 }] }, { recordset: [{ count: 0 }] });
      const upload = vi.fn(), cleanup = vi.fn();
      // The metadata binding fails before INSERT, after the successful upload.
      vi.mocked(sql.NVarChar).mockImplementationOnce(() => { throw new Error('known database failure'); });
      await expect(db.addDocument(4, metadata, null, upload, cleanup)).rejects.toThrow('known database failure');
      expect(cleanup).toHaveBeenCalledWith(upload.mock.calls[0][0]);
      expect(state.rollback).toHaveBeenCalledOnce();
    });
    it('does not destroy a blob after an ambiguous commit acknowledgement', async () => {
      state.results.push({ recordset: [{ id: 4 }] }, { recordset: [{ count: 0 }] });
      state.commit.mockRejectedValueOnce(new Error('acknowledgement lost'));
      const upload = vi.fn(), cleanup = vi.fn();
      await expect(db.addDocument(4, metadata, null, upload, cleanup)).rejects.toThrow('acknowledgement lost');
      expect(upload).toHaveBeenCalledOnce(); expect(cleanup).not.toHaveBeenCalled();
    });
    it('authorizes code digests and scopes document queries to an enquiry', async () => {
      state.results.push({ recordset: [{ id: 4 }] }, { recordset: [] });
      expect(await db.authorizeDocuments({ code: 'd'.repeat(32) })).toBe(4);
      expect(state.calls[0].inputs.codeHash).toBe(hashSecret('d'.repeat(32)));
      await expect(db.getDocument(4, '11111111-1111-4111-8111-111111111111')).rejects.toMatchObject({ status: 404 });
      expect(state.calls[1].query).toContain('WHERE requestId=@requestId AND id=@id');
    });
    it('does not expose blob references in metadata lists', async () => {
      state.results.push({ recordset: [{
        id: 'uuid', filename: 'file.pdf', mimeType: 'application/pdf', size: 40, uploadedBy: 'parent',
        createdAt: new Date(), blobName: 'private-key', actorId: 7,
      }] });
      const documents = await db.listDocuments(4);
      expect(documents[0]).not.toHaveProperty('blobName');
      expect(documents[0]).not.toHaveProperty('actorId');
      expect(state.calls[0].query).not.toContain('blobName');
    });
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
