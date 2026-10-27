import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { DOCUMENT_MAX_BYTES, DOCUMENT_MAX_COUNT, DOCUMENT_TYPES } from '../../shared/contracts';
vi.mock('./App', () => ({ Alert: () => null }));
import { Documents, validateSelectedDocument } from './Documents';

describe('enquiry document UI and shared limits', () => {
  it('uses the same 10 MiB and five-document limits', () => {
    expect(DOCUMENT_MAX_BYTES).toBe(10485760); expect(DOCUMENT_MAX_COUNT).toBe(5);
    expect(validateSelectedDocument({ name: 'file.pdf', size: DOCUMENT_MAX_BYTES })).toBe('');
    expect(validateSelectedDocument({ name: 'file.pdf', size: DOCUMENT_MAX_BYTES + 1 })).toContain('10 MB');
    expect(validateSelectedDocument({ name: 'file.pdf', size: 0 })).toContain('non-empty');
  });
  it.each(Object.keys(DOCUMENT_TYPES))('accepts %s and ignores untrusted browser MIME', (ext) => {
    expect(validateSelectedDocument({ name: `file.${ext.toUpperCase()}`, size: 40 })).toBe('');
  });
  it.each(['exe', 'svg', 'docm', 'xlsm', 'pptm', '__proto__'])('rejects %s', (ext) => {
    expect(validateSelectedDocument({ name: `file.${ext}`, size: 40 })).not.toBe('');
  });
  it('shows tracking-code privacy, original-byte and limit guidance without exposing secrets', () => {
    const html = renderToStaticMarkup(createElement(Documents, { code: 'private-tracking-code' }));
    expect(html).toContain('5 documents'); expect(html).toContain('10 MB');
    expect(html).toContain('Anyone with your private tracking code');
    expect(html).toContain('without compression');
    expect(html).not.toContain('private-tracking-code');
  });
});
