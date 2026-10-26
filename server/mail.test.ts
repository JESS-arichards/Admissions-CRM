import { describe, expect, it, vi } from 'vitest';
vi.mock('./config.js', () => ({ config: {
  PUBLIC_BASE_URL: 'https://admissions.example.test', emailEnabled: false, LOG_LEVEL: 'silent',
} }));
vi.mock('./db.js', () => ({}));
import { mailContent } from './mail.js';

describe('notification email privacy', () => {
  it('includes a separate verification token in the URL fragment', () => {
    const content = mailContent('confirmation', 'b'.repeat(32));
    expect(content.text).toContain(`https://admissions.example.test/confirm#${'b'.repeat(32)}`);
    expect(content.text).toContain('24 hours');
    expect(content.text).toContain('If you did not request this');
  });
  it('omits all request details and credentials from update emails', () => {
    const content = mailContent('update', null);
    expect(content.text).toContain('https://admissions.example.test/track');
    expect(content.text).toContain('turn off email updates');
    expect(content.text).not.toContain('#');
    expect(content.text).not.toContain('?');
    expect(content.subject).toBe('Your Admissions request has an update');
  });
  it('rejects a confirmation job without a token', () => {
    expect(() => mailContent('confirmation', null)).toThrow('no token');
  });
});
