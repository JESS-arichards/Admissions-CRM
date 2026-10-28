import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('lets mobile navigation titles wrap while preserving touch targets', () => {
  const css = readFileSync(new URL('../client/src/navigation/navigation.css', import.meta.url), 'utf8');
  const mobile = css.slice(css.indexOf('@media (max-width: 600px)'));
  expect(mobile).toContain('white-space: normal');
  expect(mobile).toContain('overflow: visible');
  expect(mobile).toContain('overflow-wrap: anywhere');
  expect(mobile).toContain('max-width: 80px');
  expect(mobile).toContain('.jess-nav-actions { display: none; }');
  expect(mobile).toContain('width: 40px; height: 44px');
  expect(mobile).not.toContain('text-overflow: ellipsis');
});
