import { describe, expect, it } from 'vitest';
import { applicationUrl, type JessApplication } from './applicationUrl';

describe('environment-aware application URLs', () => {
  it.each(['apps', 'learn', 'admissions'] as const)('keeps links from %s in the same environment', (source) => {
    for (const target of ['apps', 'learn', 'admissions'] satisfies JessApplication[]) {
      expect(applicationUrl(`${source}.jess.sch.ae`, target)).toBe(`https://${target}.jess.sch.ae/`);
      expect(applicationUrl(`${source}dev.jess.sch.ae`, target)).toBe(`https://${target}dev.jess.sch.ae/`);
    }
  });

  it('matches hostnames case-insensitively', () => {
    expect(applicationUrl('AppsDev.jess.sch.ae', 'learn')).toBe('https://learndev.jess.sch.ae/');
  });

  it.each([
    'localhost', '127.0.0.1', 'jess-application-portal-dev.azurewebsites.net',
    'appsdev.jess.sch.ae.evil.test', 'otherdev.jess.sch.ae', 'appsdev.example.org', '',
  ])('does not guess an environment for %s', (hostname) => {
    expect(applicationUrl(hostname, 'learn')).toBeNull();
  });
});
