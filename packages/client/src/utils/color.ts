export function nameToColor(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  // Generate warm, saturated colors (avoid dark/dull)
  const h = Math.abs(hash % 360);
  const s = 60 + Math.abs((hash >> 8) % 30); // 60-90%
  const l = 45 + Math.abs((hash >> 16) % 20); // 45-65%
  return hslToHex(h, s, l);
}

function hslToHex(h: number, s: number, l: number): number {
  // convert HSL to hex number for Phaser
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const r = Math.round(f(0) * 255);
  const g = Math.round(f(8) * 255);
  const b = Math.round(f(4) * 255);
  return (r << 16) | (g << 8) | b;
}

export function hexToString(hex: number): string {
  return '#' + hex.toString(16).padStart(6, '0');
}
