const DEFAULT_ACCENT = '#8fd8ff';
const BRAND_SURFACE = '#2a3b50';

type Rgb = [number, number, number];

function parseHex(color: string): Rgb | null {
  if (!/^#[\da-f]{6}$/i.test(color)) return null;
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
}

function luminance([r, g, b]: Rgb): number {
  const linear = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrastRatio(first: Rgb, second: Rgb): number {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

export function readableTextColor(color: string): '#000000' | '#ffffff' {
  const rgb = parseHex(color);
  if (!rgb) return '#ffffff';
  return contrastRatio(rgb, [0, 0, 0]) >= contrastRatio(rgb, [255, 255, 255]) ? '#000000' : '#ffffff';
}

export function accessibleBrandAccent(color: string): string {
  const brand = parseHex(color);
  const surface = parseHex(BRAND_SURFACE)!;
  if (!brand) return DEFAULT_ACCENT;
  if (contrastRatio(brand, surface) >= 4.5) return color;

  for (let step = 1; step <= 100; step += 1) {
    const amount = step / 100;
    const candidate = brand.map((channel) => Math.round(channel + (255 - channel) * amount)) as Rgb;
    if (contrastRatio(candidate, surface) >= 4.5) {
      return `#${candidate.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
    }
  }
  return '#ffffff';
}
