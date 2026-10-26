import { describe, expect, it } from 'vitest';
import { accessibleBrandAccent, readableTextColor } from './colorTokens';

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/g)!.map((channel) => Number.parseInt(channel, 16) / 255);
  const [r, g, b] = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrastRatio(first: string, second: string): number {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

describe('branding color tokens', () => {
  it('chooses a readable foreground for light and dark brand colors', () => {
    for (const brand of ['#002454', '#f5d000', '#ffffff', '#000000']) {
      expect(contrastRatio(readableTextColor(brand), brand)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('lightens brand accents until they meet 4.5:1 contrast on the dark surface', () => {
    const accent = accessibleBrandAccent('#002454');
    expect(accent).toMatch(/^#[\da-f]{6}$/i);
    expect(contrastRatio(accent, '#2a3b50')).toBeGreaterThanOrEqual(4.5);
    expect(accessibleBrandAccent('#f5d000')).toBe('#f5d000');
  });

  it('uses safe defaults for invalid values', () => {
    expect(readableTextColor('invalid')).toBe('#ffffff');
    expect(accessibleBrandAccent('invalid')).toBe('#8fd8ff');
  });
});
