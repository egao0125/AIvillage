import React, { useRef, useEffect } from 'react';

// ── Color helpers (same as BootScene) ──────────────────────

function darken(c: number, amt: number): number {
  const r = Math.max(0, Math.round(((c >> 16) & 0xff) * (1 - amt)));
  const g = Math.max(0, Math.round(((c >> 8) & 0xff) * (1 - amt)));
  const b = Math.max(0, Math.round((c & 0xff) * (1 - amt)));
  return (r << 16) | (g << 8) | b;
}

function lighten(c: number, amt: number): number {
  const r = Math.min(255, Math.round(((c >> 16) & 0xff) + (255 - ((c >> 16) & 0xff)) * amt));
  const g = Math.min(255, Math.round(((c >> 8) & 0xff) + (255 - ((c >> 8) & 0xff)) * amt));
  const b = Math.min(255, Math.round((c & 0xff) + (255 - (c & 0xff)) * amt));
  return (r << 16) | (g << 8) | b;
}

function blend(a: number, b: number, ratio: number): number {
  const rA = (a >> 16) & 0xff, gA = (a >> 8) & 0xff, bA = a & 0xff;
  const rB = (b >> 16) & 0xff, gB = (b >> 8) & 0xff, bB = b & 0xff;
  const r = Math.round(rA + (rB - rA) * ratio);
  const g = Math.round(gA + (gB - gA) * ratio);
  const bl = Math.round(bA + (bB - bA) * ratio);
  return (r << 16) | (g << 8) | bl;
}

function hexToFill(c: number): string {
  return '#' + ((c >> 16) & 0xff).toString(16).padStart(2, '0')
    + ((c >> 8) & 0xff).toString(16).padStart(2, '0')
    + (c & 0xff).toString(16).padStart(2, '0');
}

// ── Hair palette (same as BootScene) ──────────────────────

const HAIR_PALETTES = [
  0x2a1a0a, 0x6b4020, 0x8a5a30, 0x3a2010, 0xc49a6c,
  0x1a1a2e, 0x8b2020, 0xd4a060, 0x4a3020, 0x5a2a1a,
];

// ── Color from name (same as BootScene) ───────────────────

function colorsFromName(name: string): { shirt: number; hair: number } {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash % 360);
  const s = 60 + Math.abs((hash >> 8) % 30);
  const l = 45 + Math.abs((hash >> 16) % 20);
  const sF = s / 100, lF = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sF * Math.min(lF, 1 - lF);
  const f = (n: number) => lF - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const shirt = (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);

  let h2 = 0;
  for (let i = 0; i < name.length; i++) {
    h2 = name.charCodeAt(i) + ((h2 << 7) - h2);
  }
  const hair = HAIR_PALETTES[Math.abs(h2) % HAIR_PALETTES.length];
  return { shirt, hair };
}

// ── Draw sprite (replicates BootScene generateAgentTexture) ──

function drawSprite(ctx: CanvasRenderingContext2D, shirtColor: number, hairColor: number) {
  const px = (x: number, y: number, c: number) => {
    ctx.fillStyle = hexToFill(c);
    ctx.fillRect(x, y, 1, 1);
  };

  const skin = 0xf0c8a0;
  const skinShadow = 0xd8b088;
  const pantsColor = darken(shirtColor, 0.35);
  const pantsShadow = darken(pantsColor, 0.15);
  const shoeColor = 0x3a2a1a;
  const shoeShadow = 0x2a1a0a;
  const shirtHighlight = lighten(shirtColor, 0.15);
  const shirtShadow = darken(shirtColor, 0.15);

  // Hair
  for (let x = 8; x < 16; x++) { px(x, 2, hairColor); px(x, 3, hairColor); }
  px(7, 3, hairColor); px(7, 4, hairColor);
  px(16, 3, hairColor); px(16, 4, hairColor);
  for (let x = 8; x < 16; x++) px(x, 2, lighten(hairColor, 0.1));
  for (let x = 9; x <= 14; x++) px(x, 1, x === 14 ? lighten(hairColor, 0.08) : hairColor);
  px(10, 2, lighten(hairColor, 0.2)); px(11, 2, lighten(hairColor, 0.15));

  // Head
  for (let y = 4; y <= 9; y++) {
    let sX = 9, eX = 15;
    if (y === 4 || y === 9) { sX = 10; eX = 14; }
    for (let x = sX; x <= eX; x++) {
      let c = skin;
      if (x === sX) c = skinShadow;
      if (y >= 8) c = blend(c, skinShadow, 0.3);
      px(x, y, c);
    }
  }
  px(10, 5, 0xffffff); px(13, 5, 0xffffff);
  px(10, 6, 0x000000); px(13, 6, 0x000000);
  px(11, 8, 0xd09080); px(12, 8, 0xd09080);

  // Neck
  px(11, 10, skin); px(12, 10, skin);
  px(11, 11, skinShadow); px(12, 11, skinShadow);

  // Torso
  for (let y = 12; y <= 19; y++) {
    let sX = 8, eX = 15;
    if (y === 12) { sX = 10; eX = 13; }
    if (y === 13) { sX = 9; eX = 14; }
    for (let x = sX; x <= eX; x++) {
      let c = shirtColor;
      if (x === sX) c = shirtShadow;
      if (x === eX) c = shirtShadow;
      if (y <= 13) c = shirtHighlight;
      if (x === 12 && y >= 14) c = shirtShadow;
      if (y === 12 && (x === 10 || x === 13)) c = lighten(shirtColor, 0.25);
      px(x, y, c);
    }
  }

  // Arms
  for (let y = 13; y <= 18; y++) {
    px(7, y, y >= 17 ? skinShadow : skin);
    px(16, y, y >= 17 ? skinShadow : skin);
  }
  px(7, 19, skin); px(16, 19, skin);

  // Pants
  for (let y = 20; y <= 25; y++) {
    for (let x = 8; x <= 11; x++) px(x, y, x === 8 || (x === 11 && y >= 22) ? pantsShadow : pantsColor);
    for (let x = 12; x <= 15; x++) px(x, y, x === 15 || (x === 12 && y >= 22) ? pantsShadow : pantsColor);
  }
  for (let x = 8; x <= 15; x++) px(x, 20, darken(pantsColor, 0.2));

  // Shoes
  for (let y = 26; y <= 29; y++) {
    for (let x = 7; x <= 11; x++) {
      let c = shoeColor;
      if (y === 26) c = lighten(c, 0.15);
      if (y === 29 && x <= 8) c = shoeShadow;
      if (x === 7) c = shoeShadow;
      px(x, y, c);
    }
    for (let x = 12; x <= 16; x++) {
      let c = shoeColor;
      if (y === 26) c = lighten(c, 0.15);
      if (y === 29 && x >= 15) c = shoeShadow;
      if (x === 16) c = shoeShadow;
      px(x, y, c);
    }
  }
  px(9, 27, lighten(shoeColor, 0.3));
  px(14, 27, lighten(shoeColor, 0.3));
}

// ── React component ──────────────────────────────────────

interface PixelAvatarProps {
  name: string;
  size?: number; // display size in CSS pixels (default 64)
}

export const PixelAvatar: React.FC<PixelAvatarProps> = ({ name, size = 64 }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, 24, 32);
    const { shirt, hair } = colorsFromName(name);
    drawSprite(ctx, shirt, hair);
  }, [name]);

  return (
    <canvas
      ref={canvasRef}
      width={24}
      height={32}
      style={{
        width: size * (24 / 32),
        height: size,
        imageRendering: 'pixelated',
      }}
    />
  );
};
