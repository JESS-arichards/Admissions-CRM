import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime } from './dateFormatting';

describe('UK date display policy', () => {
  it('formats short and long dates in the configured UK forms', () => {
    expect(formatDate('2025-02-01')).toBe('01/02/2025');
    expect(formatDate('2025-02-01', 'long')).toBe('1 February 2025');
  });

  it('keeps date-only values stable and preserves timestamp time zones', () => {
    expect(formatDate('2025-02-01')).toBe('01/02/2025');
    expect(formatDateTime('2025-02-01T13:05:00Z', { timeZone: 'UTC' })).toBe('01/02/2025, 13:05');
  });

  it('keeps client displays on the shared formatter rather than locale APIs', () => {
    const sourceFiles = import.meta.glob('../client/src/**/*.tsx', {
      eager: true, query: '?raw', import: 'default',
    }) as Record<string, string>;
    expect(Object.keys(sourceFiles).length).toBeGreaterThan(0);
    expect(Object.values(sourceFiles).join('\n')).not.toMatch(/\.toLocale(?:DateString|String|TimeString)\s*\(|new Intl\.DateTimeFormat\s*\(/);
  });
});
