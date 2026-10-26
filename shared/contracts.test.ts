import { describe, expect, it } from 'vitest';
import { canAdminister, canWork, pageSchema, requestSchema, trackingSchema, updateSchema, type CentralUser } from './contracts';

const user = (roles: string[]): CentralUser => ({
  id: 1, email: 'staff@example.test', displayName: 'Staff', isActive: true, sessionVersion: 0, roles,
});
const request = {
  kind: 'Enquiry', parentName: 'Parent Name', email: 'Parent@example.test', phone: '', yearGroup: '',
  message: 'Please tell me about entry requirements.', privacyAccepted: true, emailOptIn: false, website: '',
};
describe('Admissions permissions', () => {
  it.each(['Full Admin', 'Admissions Admin'])('%s administers Admissions', (role) => {
    expect(canAdminister(user([role]))).toBe(true);
    expect(canWork(user([role]))).toBe(true);
  });
  it('limits contributors to operational access', () => {
    expect(canWork(user(['Admissions Contributor']))).toBe(true);
    expect(canAdminister(user(['Admissions Contributor']))).toBe(false);
  });
  it.each(['Learn Admin', 'Staff', 'Parent', 'Student'])('does not grant Admissions access to %s', (role) => {
    expect(canWork(user([role]))).toBe(false);
  });
});
describe('public input', () => {
  it('normalizes contact email', () => expect(requestSchema.parse(request).email).toBe('parent@example.test'));
  it.each([
    { privacyAccepted: false }, { email: 'bad' }, { message: 'short' }, { website: 'bot' },
    { stage: 'Resolved' }, { ownerId: 1 }, { emailOptIn: 'true' }, { message: 'x'.repeat(4001) },
  ])('rejects invalid data and privileged fields: %j', (change) => {
    expect(requestSchema.safeParse({ ...request, ...change }).success).toBe(false);
  });
  it('requires explicit privacy acceptance and opt-in choice', () => {
    const { privacyAccepted: _privacy, emailOptIn: _email, ...rest } = request;
    expect(requestSchema.safeParse(rest).success).toBe(false);
  });
  it('keeps tracking codes case-sensitive and requires the full secret', () => {
    const code = 'Aa12_-'.repeat(5) + 'bb';
    expect(trackingSchema.parse({ code }).code).toBe(code);
    for (const invalid of ['', '12345', ' '.repeat(32), 'a'.repeat(33)]) {
      expect(trackingSchema.safeParse({ code: invalid }).success).toBe(false);
    }
  });
});
describe('staff input', () => {
  it('requires an optimistic concurrency revision', () => {
    expect(updateSchema.safeParse({ stage: 'New' }).success).toBe(false);
    expect(pageSchema.safeParse({ title: 'Welcome', body: 'School admissions.', published: true }).success).toBe(false);
  });
  it('rejects arbitrary stages and arbitrary user assignment', () => {
    expect(updateSchema.safeParse({ revision: 1, stage: 'Approved' }).success).toBe(false);
    expect(updateSchema.safeParse({ revision: 1, stage: 'New', ownerId: 7 }).success).toBe(false);
  });
});
