import Phaser from 'phaser';

// Arena tileset assets — served from public/ directory (no Vite hashing).
// Loaded as images (not spritesheets) for Phaser's tilemap renderer.
const ARENA_MAP_URL = '/tilesets/arena-map.tmj';
const TILESET_GROUND_URL = '/tilesets/Tileset_Ground.png';
const TILESET_SAND_URL = '/tilesets/Tileset_Sand.png';
const TILESET_ROAD_URL = '/tilesets/Tileset_Road.png';
const ATLAS_TREES_URL = '/tilesets/Atlas_Trees_Bushes.png';
const ATLAS_ROCKS_URL = '/tilesets/Atlas_Rocks.png';
const TILESET_SHADOW_URL = '/tilesets/Tileset_Shadow.png';
const ATLAS_BUILDINGS_BLUE_URL = '/tilesets/Atlas_Buildings_Wood_Blue.png';
const ATLAS_BUILDINGS_ORANGE_URL = '/tilesets/Atlas_Buildings_Wood_Orange.png';
const ATLAS_BUILDINGS_GREEN_URL = '/tilesets/Atlas_Buildings_Wood_Green.png';
const ATLAS_BUILDINGS_HAY_URL = '/tilesets/Atlas_Buildings_Hay.png';
const ATLAS_BUILDINGS_RED_URL = '/tilesets/Atlas_Buildings_Wood_Red.png';

const T = 32; // tile size

// ── Helpers ──────────────────────────────────────────────────
function px(g: Phaser.GameObjects.Graphics, x: number, y: number, color: number): void {
  g.fillStyle(color);
  g.fillRect(x, y, 1, 1);
}

function rect(g: Phaser.GameObjects.Graphics, x: number, y: number, w: number, h: number, color: number): void {
  g.fillStyle(color);
  g.fillRect(x, y, w, h);
}

/** Simple seeded pseudo-random for deterministic patterns */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s & 0x7fffffff) / 0x7fffffff;
  };
}

/** Blend two hex colors by ratio (0 = a, 1 = b) */
function blend(a: number, b: number, ratio: number): number {
  const rA = (a >> 16) & 0xff, gA = (a >> 8) & 0xff, bA = a & 0xff;
  const rB = (b >> 16) & 0xff, gB = (b >> 8) & 0xff, bB = b & 0xff;
  const r = Math.round(rA + (rB - rA) * ratio);
  const g = Math.round(gA + (gB - gA) * ratio);
  const bl = Math.round(bA + (bB - bA) * ratio);
  return (r << 16) | (g << 8) | bl;
}

/** Darken a color by amount (0-1) */
function darken(c: number, amt: number): number {
  const r = Math.max(0, Math.round(((c >> 16) & 0xff) * (1 - amt)));
  const g = Math.max(0, Math.round(((c >> 8) & 0xff) * (1 - amt)));
  const b = Math.max(0, Math.round((c & 0xff) * (1 - amt)));
  return (r << 16) | (g << 8) | b;
}

/** Lighten a color by amount (0-1) */
function lighten(c: number, amt: number): number {
  const r = Math.min(255, Math.round(((c >> 16) & 0xff) + (255 - ((c >> 16) & 0xff)) * amt));
  const g = Math.min(255, Math.round(((c >> 8) & 0xff) + (255 - ((c >> 8) & 0xff)) * amt));
  const b = Math.min(255, Math.round((c & 0xff) + (255 - (c & 0xff)) * amt));
  return (r << 16) | (g << 8) | b;
}

/** Extract RGB components */
function rgb(c: number): [number, number, number] {
  return [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
}

// ── Color Palettes ───────────────────────────────────────────
const GRASS_COLORS = [0x2d5a1e, 0x357024, 0x3a7a2a, 0x4a8c38, 0x3e8030, 0x468a34];
const GRASS_HIGHLIGHT = 0x5ca048;
const GRASS_DARK = 0x1e4416;
const PATH_STONES = [0x9b7b5e, 0xa8876a, 0xb09070, 0x8a7058, 0x9c8264];
const PATH_MORTAR = 0x7a6044;
const WATER_DEEP = 0x1a4b7c;
const WATER_MID = 0x2a6ba8;
const WATER_LIGHT = 0x3a7bc8;
const WATER_HIGHLIGHT = 0x5a9be8;
const WATER_SHIMMER = 0x7ab8f0;
const SAND_BASE = 0xd4b896;
const SAND_DARK = 0xc4a882;
const SAND_LIGHT = 0xe0c8a8;
const SAND_SPEC = 0xb09870;
const FLOOR_PLANK = 0xb89070;
const FLOOR_DARK = 0x9a7050;
const FLOOR_LIGHT = 0xd0a880;
const FLOOR_KNOT = 0x7a5830;
const WALL_STONE1 = 0xa09080;
const WALL_STONE2 = 0xb0a090;
const WALL_STONE3 = 0xbcb0a0;
const WALL_MORTAR = 0x8a8070;
const WALL_SHADOW = 0x7a7060;
const FOREST_BASE = 0x1a3a12;
const FOREST_DARK = 0x142e0e;
const FOREST_MOSS = 0x2a4a18;
const FOREST_LEAF = 0x8b5a20;
const BRIDGE_PLANK = 0x7a5c3a;
const BRIDGE_DARK = 0x5a4020;
const BRIDGE_LIGHT = 0x9a7c5a;
const BRIDGE_ROPE = 0x6b5030;

// ── Hair color palette for agent variety ──────────────────
const HAIR_PALETTES = [
  0x2a1a0a, 0x6b4020, 0x8a5a30, 0x3a2010, 0xc49a6c,
  0x1a1a2e, 0x8b2020, 0xd4a060, 0x4a3020, 0x5a2a1a,
];

/**
 * Generate a unique agent sprite texture. Callable from any Phaser scene.
 */
export function generateAgentTexture(scene: Phaser.Scene, key: string, shirtColor: number, hairColor: number): void {
  if (scene.textures.exists(key)) return; // already generated

  const W = 24;
  const H = 32;
  const g = scene.add.graphics();
  const rng = seeded(shirtColor + hairColor);

  const skin = 0xf0c8a0;
  const skinShadow = 0xd8b088;
  const pantsColor = darken(shirtColor, 0.35);
  const pantsShadow = darken(pantsColor, 0.15);
  const shoeColor = 0x3a2a1a;
  const shoeShadow = 0x2a1a0a;
  const shirtHighlight = lighten(shirtColor, 0.15);
  const shirtShadow = darken(shirtColor, 0.15);

  // Hair
  for (let x = 8; x < 16; x++) { px(g, x, 2, hairColor); px(g, x, 3, hairColor); }
  px(g, 7, 3, hairColor); px(g, 7, 4, hairColor);
  px(g, 16, 3, hairColor); px(g, 16, 4, hairColor);
  for (let x = 8; x < 16; x++) px(g, x, 2, lighten(hairColor, 0.1));
  for (let x = 9; x <= 14; x++) px(g, x, 1, x === 14 ? lighten(hairColor, 0.08) : hairColor);
  px(g, 10, 2, lighten(hairColor, 0.2)); px(g, 11, 2, lighten(hairColor, 0.15));

  // Head
  for (let y = 4; y <= 9; y++) {
    let sX = 9, eX = 15;
    if (y === 4 || y === 9) { sX = 10; eX = 14; }
    for (let x = sX; x <= eX; x++) {
      let c = skin;
      if (x === sX) c = skinShadow;
      if (y >= 8) c = blend(c, skinShadow, 0.3);
      px(g, x, y, c);
    }
  }
  px(g, 10, 5, 0xffffff); px(g, 13, 5, 0xffffff);
  px(g, 10, 6, 0x000000); px(g, 13, 6, 0x000000);
  px(g, 11, 8, 0xd09080); px(g, 12, 8, 0xd09080);

  // Neck
  px(g, 11, 10, skin); px(g, 12, 10, skin);
  px(g, 11, 11, skinShadow); px(g, 12, 11, skinShadow);

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
      px(g, x, y, c);
    }
  }

  // Arms
  for (let y = 13; y <= 18; y++) {
    px(g, 7, y, y >= 17 ? skinShadow : skin);
    px(g, 16, y, y >= 17 ? skinShadow : skin);
  }
  px(g, 7, 19, skin); px(g, 16, 19, skin);

  // Pants
  for (let y = 20; y <= 25; y++) {
    for (let x = 8; x <= 11; x++) px(g, x, y, x === 8 || (x === 11 && y >= 22) ? pantsShadow : pantsColor);
    for (let x = 12; x <= 15; x++) px(g, x, y, x === 15 || (x === 12 && y >= 22) ? pantsShadow : pantsColor);
  }
  for (let x = 8; x <= 15; x++) px(g, x, 20, darken(pantsColor, 0.2));

  // Shoes
  for (let y = 26; y <= 29; y++) {
    for (let x = 7; x <= 11; x++) {
      let c = shoeColor;
      if (y === 26) c = lighten(c, 0.15);
      if (y === 29 && x <= 8) c = shoeShadow;
      if (x === 7) c = shoeShadow;
      px(g, x, y, c);
    }
    for (let x = 12; x <= 16; x++) {
      let c = shoeColor;
      if (y === 26) c = lighten(c, 0.15);
      if (y === 29 && x >= 15) c = shoeShadow;
      if (x === 16) c = shoeShadow;
      px(g, x, y, c);
    }
  }
  px(g, 9, 27, lighten(shoeColor, 0.3));
  px(g, 14, 27, lighten(shoeColor, 0.3));

  g.generateTexture(key, W, H);
  g.destroy();
}

/**
 * Get unique shirt + hair colors for an agent name.
 */
export function agentColorsFromName(name: string): { shirt: number; hair: number } {
  // Shirt: warm saturated color from name hash
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

  // Hair: pick from palette based on different hash
  let h2 = 0;
  for (let i = 0; i < name.length; i++) {
    h2 = name.charCodeAt(i) + ((h2 << 7) - h2);
  }
  const hair = HAIR_PALETTES[Math.abs(h2) % HAIR_PALETTES.length];

  return { shirt, hair };
}

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BootScene' });
  }

  preload(): void {
    const activeMap = this.registry.get('activeMap');
    console.log('[BootScene] preload — activeMap:', activeMap);

    if (activeMap === 'battle_royale' || activeMap === 'werewolf') {
      this.load.on('loaderror', (file: { key: string; url: string }) => {
        console.error('[BootScene] Failed to load asset:', file.key, file.url);
      });
      // Load Tiled JSON map + tileset images (Phaser tilemap handles frame slicing)
      this.load.tilemapTiledJSON('arena-map', ARENA_MAP_URL);
      this.load.image('Tileset_Ground', TILESET_GROUND_URL);
      this.load.image('Tileset_Sand', TILESET_SAND_URL);
      this.load.image('Tileset_Road', TILESET_ROAD_URL);
      this.load.image('Atlas_Trees_Bushes', ATLAS_TREES_URL);
      this.load.image('Atlas_Rocks', ATLAS_ROCKS_URL);
      this.load.image('Tileset_Shadow', TILESET_SHADOW_URL);
      this.load.image('Atlas_Buildings_Blue', ATLAS_BUILDINGS_BLUE_URL);
      this.load.image('Atlas_Buildings_Orange', ATLAS_BUILDINGS_ORANGE_URL);
      this.load.image('Atlas_Buildings_Green', ATLAS_BUILDINGS_GREEN_URL);
      this.load.image('Atlas_Buildings_Hay', ATLAS_BUILDINGS_HAY_URL);
      this.load.image('Atlas_Buildings_Red', ATLAS_BUILDINGS_RED_URL);
      this.load.on('complete', () => {
        console.log('[BootScene] Arena tilemap + tilesets loaded');
      });
    }
  }

  create(): void {
    this.generateTileTextures();
    this.generateTreeTextures();
    this.generateDecorationTextures();
    this.generateFurnitureTextures();
    this.generateAgentTextures();
    this.generateUITextures();

    // Decide which scene to start based on active map
    const activeMap = this.registry.get('activeMap');
    const targetScene = (activeMap === 'battle_royale' || activeMap === 'werewolf')
      ? 'ArenaScene'
      : 'VillageScene';
    this.scene.start(targetScene);
  }

  // ═══════════════════════════════════════════════════════════
  // TILE TEXTURES (32x32)
  // ═══════════════════════════════════════════════════════════
  private generateTileTextures(): void {
    this.generateGrassTile();
    this.generatePathTile();
    this.generateWaterTile();
    this.generateSandTile();
    this.generateFloorTile();
    this.generateFloorVariants();
    this.generateFloorDarkTile();
    this.generateFloorDarkVariants();
    this.generateWallTile();
    this.generateForestFloorTile();
    this.generateFlowerTile();
    this.generateBridgeTile();
    this.generateCropTile();
  }

  // ── Grass ──────────────────────────────────────────────────
  private generateGrassTile(): void {
    const g = this.add.graphics();
    const rng = seeded(42);

    // Base layer: varied green fill
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const colorIdx = Math.floor(rng() * GRASS_COLORS.length);
        let color = GRASS_COLORS[colorIdx];
        // Subtle diagonal gradient for depth
        const gradientBias = (x + y) / (T * 2);
        color = blend(color, GRASS_DARK, gradientBias * 0.2);
        px(g, x, y, color);
      }
    }

    // Individual grass blade strokes (vertical 2-4px lines with slight lean)
    for (let i = 0; i < 35; i++) {
      const bx = Math.floor(rng() * 30) + 1;
      const by = Math.floor(rng() * 24) + 6;
      const bladeH = 2 + Math.floor(rng() * 3);
      const lean = rng() > 0.5 ? 1 : (rng() > 0.5 ? -1 : 0);
      const bladeColor = rng() > 0.6 ? GRASS_HIGHLIGHT : GRASS_COLORS[Math.floor(rng() * GRASS_COLORS.length)];
      for (let h = 0; h < bladeH; h++) {
        const lx = bx + (h === bladeH - 1 ? lean : 0);
        if (lx >= 0 && lx < T && by - h >= 0) {
          px(g, lx, by - h, h === 0 ? darken(bladeColor, 0.15) : bladeColor);
        }
      }
    }

    // Tiny wildflower dots (sparse)
    for (let i = 0; i < 3; i++) {
      const fx = Math.floor(rng() * 28) + 2;
      const fy = Math.floor(rng() * 28) + 2;
      const flowerColors = [0xf0e040, 0xe06060, 0x8080e0];
      px(g, fx, fy, flowerColors[Math.floor(rng() * flowerColors.length)]);
    }

    // Small dirt patches
    for (let i = 0; i < 2; i++) {
      const dx = Math.floor(rng() * 26) + 3;
      const dy = Math.floor(rng() * 26) + 3;
      const patchColor = 0x5a4a2a;
      px(g, dx, dy, patchColor);
      if (rng() > 0.4) px(g, dx + 1, dy, blend(patchColor, GRASS_DARK, 0.5));
    }

    g.generateTexture('tile_grass', T, T);
    g.destroy();
  }

  // ── Path (cobblestone) ────────────────────────────────────
  private generatePathTile(): void {
    const g = this.add.graphics();
    const rng = seeded(137);

    // Base mortar fill
    rect(g, 0, 0, T, T, PATH_MORTAR);

    // Draw individual cobblestones in a staggered grid
    const stoneW = [5, 6, 7, 8];
    const stoneH = [4, 5, 6];
    let cy = 0;
    let row = 0;
    while (cy < T) {
      const sh = stoneH[row % stoneH.length];
      let cx = row % 2 === 0 ? 0 : -3; // stagger
      while (cx < T) {
        const sw = stoneW[Math.floor(rng() * stoneW.length)];
        const stoneColor = PATH_STONES[Math.floor(rng() * PATH_STONES.length)];

        // Stone fill
        for (let sy = 0; sy < sh - 1; sy++) {
          for (let sx = 0; sx < sw - 1; sx++) {
            const ry = cy + sy;
            const rx = cx + sx;
            if (rx >= 0 && rx < T && ry >= 0 && ry < T) {
              // Slight variation within each stone
              let c = stoneColor;
              if (sy === 0) c = lighten(c, 0.1); // top highlight
              if (sy === sh - 2) c = darken(c, 0.08); // bottom shadow
              if (sx === 0 && sy > 0) c = darken(c, 0.05); // left shadow
              px(g, rx, ry, c);
            }
          }
        }

        cx += sw + 1; // +1 for mortar gap
      }
      cy += sh;
      row++;
    }

    // A few cracks
    for (let i = 0; i < 3; i++) {
      const crx = Math.floor(rng() * 28) + 2;
      const cry = Math.floor(rng() * 28) + 2;
      px(g, crx, cry, darken(PATH_MORTAR, 0.2));
      px(g, crx + 1, cry + 1, darken(PATH_MORTAR, 0.15));
    }

    g.generateTexture('tile_path', T, T);
    g.destroy();
  }

  // ── Water ─────────────────────────────────────────────────
  private generateWaterTile(): void {
    const g = this.add.graphics();
    const rng = seeded(256);

    // Depth gradient: deeper = darker
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        // Radial-ish gradient toward center
        const cx = Math.abs(x - T / 2) / (T / 2);
        const cy = Math.abs(y - T / 2) / (T / 2);
        const edgeDist = Math.max(cx, cy);
        let color = blend(WATER_DEEP, WATER_MID, edgeDist * 0.4);
        // Add some noise
        if (rng() > 0.85) {
          color = lighten(color, 0.05);
        }
        px(g, x, y, color);
      }
    }

    // Ripple highlights: wavy horizontal lines
    for (let wy = 4; wy < T; wy += 6) {
      const waveOffset = Math.floor(rng() * 4);
      for (let wx = 0; wx < T; wx++) {
        const waveY = wy + Math.round(Math.sin((wx + waveOffset) * 0.8) * 0.8);
        if (waveY >= 0 && waveY < T) {
          px(g, wx, waveY, WATER_HIGHLIGHT);
          // Softer highlight pixel adjacent
          if (waveY + 1 < T) {
            px(g, wx, waveY + 1, blend(WATER_MID, WATER_HIGHLIGHT, 0.3));
          }
        }
      }
    }

    // Shimmer specks
    for (let i = 0; i < 6; i++) {
      const sx = Math.floor(rng() * T);
      const sy = Math.floor(rng() * T);
      px(g, sx, sy, WATER_SHIMMER);
    }

    g.generateTexture('tile_water', T, T);
    g.destroy();
  }

  // ── Sand ──────────────────────────────────────────────────
  private generateSandTile(): void {
    const g = this.add.graphics();
    const rng = seeded(888);

    // Base fill with grain
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        let color = SAND_BASE;
        const r = rng();
        if (r < 0.15) color = SAND_DARK;
        else if (r < 0.25) color = SAND_LIGHT;
        else if (r < 0.30) color = SAND_SPEC;
        px(g, x, y, color);
      }
    }

    // Subtle wind ripple lines
    for (let wy = 6; wy < T; wy += 8) {
      for (let wx = 0; wx < T; wx++) {
        const ry = wy + Math.round(Math.sin(wx * 0.4) * 0.5);
        if (ry >= 0 && ry < T && rng() > 0.3) {
          px(g, wx, ry, blend(SAND_BASE, SAND_DARK, 0.3));
        }
      }
    }

    // Tiny shells/pebbles
    for (let i = 0; i < 2; i++) {
      const sx = Math.floor(rng() * 28) + 2;
      const sy = Math.floor(rng() * 28) + 2;
      px(g, sx, sy, 0xe8e0d0);
      px(g, sx + 1, sy, 0xd8d0c0);
    }

    g.generateTexture('tile_sand', T, T);
    g.destroy();
  }

  // ── Floor (wooden planks) ─────────────────────────────────
  private generateFloorTile(): void {
    const g = this.add.graphics();
    const rng = seeded(555);

    // Draw horizontal planks
    const plankHeights = [5, 6, 5, 6, 5, 5];
    let py = 0;
    for (let p = 0; p < plankHeights.length && py < T; p++) {
      const ph = plankHeights[p];
      for (let y = 0; y < ph && py + y < T; y++) {
        for (let x = 0; x < T; x++) {
          let color = FLOOR_PLANK;
          // Wood grain: horizontal streaks
          const grain = Math.sin(x * 1.5 + (py + y) * 0.3 + p * 20) * 0.15;
          color = grain > 0 ? lighten(color, grain) : darken(color, -grain);
          // Plank separation line
          if (y === 0) color = FLOOR_DARK;
          // Slight variation per plank
          if (p % 2 === 0) color = darken(color, 0.05);
          px(g, x, py + y, color);
        }
      }
      py += ph;
    }

    // Wood knots
    for (let i = 0; i < 2; i++) {
      const kx = Math.floor(rng() * 26) + 3;
      const ky = Math.floor(rng() * 26) + 3;
      px(g, kx, ky, FLOOR_KNOT);
      px(g, kx + 1, ky, darken(FLOOR_KNOT, 0.1));
      px(g, kx, ky + 1, lighten(FLOOR_KNOT, 0.1));
    }

    // Nail heads
    for (let i = 0; i < 3; i++) {
      const nx = Math.floor(rng() * 28) + 2;
      const ny = Math.floor(rng() * 28) + 2;
      px(g, nx, ny, 0x444444);
    }

    g.generateTexture('tile_floor', T, T);
    g.destroy();
  }

  // ── Floor Variants (per-building wood tones) ───────────────
  private generateFloorVariants(): void {
    const tones = [
      { base: 0x7a6b5e, dark: 0x5a4a3e, light: 0x8a7b6e, knot: 0x4a3a2e, seed: 5551 }, // cool ash
      { base: 0x8b5f48, dark: 0x6b3f28, light: 0x9b7f68, knot: 0x5b2f18, seed: 5552 }, // reddish cedar
    ];
    for (let v = 0; v < tones.length; v++) {
      const t = tones[v];
      const g = this.add.graphics();
      const rng = seeded(t.seed);
      const plankHeights = [5, 6, 5, 6, 5, 5];
      let py = 0;
      for (let p = 0; p < plankHeights.length && py < T; p++) {
        const ph = plankHeights[p];
        for (let y = 0; y < ph && py + y < T; y++) {
          for (let x = 0; x < T; x++) {
            let color = t.base;
            const grain = Math.sin(x * 1.5 + (py + y) * 0.3 + p * 20) * 0.15;
            color = grain > 0 ? lighten(color, grain) : darken(color, -grain);
            if (y === 0) color = t.dark;
            if (p % 2 === 0) color = darken(color, 0.05);
            px(g, x, py + y, color);
          }
        }
        py += ph;
      }
      for (let i = 0; i < 2; i++) {
        const kx = Math.floor(rng() * 26) + 3;
        const ky = Math.floor(rng() * 26) + 3;
        px(g, kx, ky, t.knot);
        px(g, kx + 1, ky, darken(t.knot, 0.1));
        px(g, kx, ky + 1, lighten(t.knot, 0.1));
      }
      for (let i = 0; i < 3; i++) {
        const nx = Math.floor(rng() * 28) + 2;
        const ny = Math.floor(rng() * 28) + 2;
        px(g, nx, ny, 0x444444);
      }
      g.generateTexture(`tile_floor_b${v + 1}`, T, T);
      g.destroy();
    }
  }

  // ── Floor Dark (darker stone/tile for select rooms) ──────
  private generateFloorDarkTile(): void {
    const g = this.add.graphics();
    const rng = seeded(556);

    const DARK_BASE = 0x9a9080;
    const DARK_LIGHT = 0xaaa090;
    const DARK_SHADOW = 0x8a8070;
    const DARK_GROUT = 0x787060;

    // Draw stone tile grid (8x8 tiles within the 32x32 texture)
    const tileSize = 8;
    for (let ty = 0; ty < T; ty += tileSize) {
      for (let tx = 0; tx < T; tx += tileSize) {
        // Grout lines
        for (let x = tx; x < tx + tileSize && x < T; x++) {
          if (ty < T) px(g, x, ty, DARK_GROUT);
        }
        for (let y = ty; y < ty + tileSize && y < T; y++) {
          if (tx < T) px(g, tx, y, DARK_GROUT);
        }
        // Fill tile interior
        for (let y = ty + 1; y < ty + tileSize - 0 && y < T; y++) {
          for (let x = tx + 1; x < tx + tileSize - 0 && x < T; x++) {
            let c = DARK_BASE;
            if (rng() < 0.15) c = DARK_LIGHT;
            else if (rng() < 0.1) c = DARK_SHADOW;
            // Subtle top-left highlight
            if (y === ty + 1) c = lighten(c, 0.08);
            if (x === tx + 1) c = lighten(c, 0.04);
            px(g, x, y, c);
          }
        }
      }
    }

    // A few scuff marks
    for (let i = 0; i < 3; i++) {
      const sx = Math.floor(rng() * 26) + 3;
      const sy = Math.floor(rng() * 26) + 3;
      px(g, sx, sy, darken(DARK_BASE, 0.15));
      px(g, sx + 1, sy, darken(DARK_BASE, 0.12));
    }

    g.generateTexture('tile_floor_dark', T, T);
    g.destroy();
  }

  // ── Floor Dark Variants (per-building stone tones) ─────────
  private generateFloorDarkVariants(): void {
    const tones = [
      { base: 0x8a9488, light: 0x9aa498, shadow: 0x7a8478, grout: 0x687468, seed: 5561 }, // sage
      { base: 0xa09480, light: 0xb0a490, shadow: 0x908470, grout: 0x787060, seed: 5562 }, // warm cream
    ];
    for (let v = 0; v < tones.length; v++) {
      const t = tones[v];
      const g = this.add.graphics();
      const rng = seeded(t.seed);
      const tileSize = 8;
      for (let ty = 0; ty < T; ty += tileSize) {
        for (let tx = 0; tx < T; tx += tileSize) {
          for (let x = tx; x < tx + tileSize && x < T; x++) {
            if (ty < T) px(g, x, ty, t.grout);
          }
          for (let y = ty; y < ty + tileSize && y < T; y++) {
            if (tx < T) px(g, tx, y, t.grout);
          }
          for (let y = ty + 1; y < ty + tileSize && y < T; y++) {
            for (let x = tx + 1; x < tx + tileSize && x < T; x++) {
              let c = t.base;
              if (rng() < 0.15) c = t.light;
              else if (rng() < 0.1) c = t.shadow;
              if (y === ty + 1) c = lighten(c, 0.08);
              if (x === tx + 1) c = lighten(c, 0.04);
              px(g, x, y, c);
            }
          }
        }
      }
      for (let i = 0; i < 3; i++) {
        const sx = Math.floor(rng() * 26) + 3;
        const sy = Math.floor(rng() * 26) + 3;
        px(g, sx, sy, darken(t.base, 0.15));
        px(g, sx + 1, sy, darken(t.base, 0.12));
      }
      g.generateTexture(`tile_floor_dark_b${v + 1}`, T, T);
      g.destroy();
    }
  }

  // ── Wall top face (smooth stone cap viewed from above — 2.5D) ──
  private generateWallTile(): void {
    const g = this.add.graphics();
    const rng = seeded(777);

    // Top face of wall: lighter warm stone, subtle block grid
    const TOP_BASE = 0xc0b8a8;
    const TOP_LIGHT = 0xd0c8b8;
    const TOP_DARK = 0xb0a898;

    // Smooth fill with subtle grain
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        let c = TOP_BASE;
        const r = rng();
        if (r < 0.15) c = TOP_LIGHT;
        else if (r < 0.28) c = TOP_DARK;
        // Edge highlight (north/west edges lighter — light from top-left)
        if (y < 2) c = lighten(c, 0.10);
        if (x < 2) c = lighten(c, 0.06);
        if (y >= T - 2) c = darken(c, 0.06);
        if (x >= T - 2) c = darken(c, 0.04);
        px(g, x, y, c);
      }
    }

    // Faint block grid lines (barely visible — suggests stone slabs)
    for (let by = 0; by < T; by += 8) {
      for (let x = 0; x < T; x++) {
        if (rng() > 0.25) px(g, x, by, darken(TOP_BASE, 0.10));
      }
    }
    for (let bx = 0; bx < T; bx += 10) {
      const off = (Math.floor(bx / 10) % 2) * 4; // stagger
      for (let y = 0; y < T; y++) {
        if (rng() > 0.35) px(g, bx + off < T ? bx + off : bx, y, darken(TOP_BASE, 0.08));
      }
    }

    g.generateTexture('tile_wall', T, T);
    g.destroy();
  }

  // ── Forest floor ──────────────────────────────────────────
  private generateForestFloorTile(): void {
    const g = this.add.graphics();
    const rng = seeded(333);

    // Dark green base
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const r = rng();
        let color = FOREST_BASE;
        if (r < 0.2) color = FOREST_DARK;
        else if (r < 0.35) color = FOREST_MOSS;
        px(g, x, y, color);
      }
    }

    // Fallen leaves
    const leafColors = [FOREST_LEAF, 0x9b6a28, 0x7a4a18, 0xa07030];
    for (let i = 0; i < 8; i++) {
      const lx = Math.floor(rng() * 30) + 1;
      const ly = Math.floor(rng() * 30) + 1;
      const lc = leafColors[Math.floor(rng() * leafColors.length)];
      px(g, lx, ly, lc);
      if (rng() > 0.5) px(g, lx + 1, ly, darken(lc, 0.15));
    }

    // Small twigs
    for (let i = 0; i < 3; i++) {
      const tx = Math.floor(rng() * 26) + 3;
      const ty = Math.floor(rng() * 26) + 3;
      const twigColor = 0x4a3a1a;
      px(g, tx, ty, twigColor);
      px(g, tx + 1, ty + 1, twigColor);
      if (rng() > 0.5) px(g, tx + 2, ty + 1, twigColor);
    }

    // Moss patches
    for (let i = 0; i < 4; i++) {
      const mx = Math.floor(rng() * 28) + 2;
      const my = Math.floor(rng() * 28) + 2;
      px(g, mx, my, 0x2a5a18);
      px(g, mx + 1, my, 0x2a5a18);
    }

    g.generateTexture('tile_forest', T, T);
    g.destroy();
  }

  // ── Flowers ───────────────────────────────────────────────
  private generateFlowerTile(): void {
    const g = this.add.graphics();
    const rng = seeded(999);

    // Green base (similar to grass but slightly different)
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const r = rng();
        let color = r < 0.5 ? 0x3a7a2a : 0x357024;
        if (r < 0.1) color = GRASS_HIGHLIGHT;
        px(g, x, y, color);
      }
    }

    // Flower clusters
    const flowerPalettes = [
      [0xe04040, 0xf06060, 0xd03030], // red
      [0xf0d040, 0xf0e060, 0xe0c030], // yellow
      [0x8050c0, 0xa070e0, 0x7040b0], // purple
      [0xe07090, 0xf090b0, 0xd06080], // pink
      [0x4080e0, 0x60a0f0, 0x3070d0], // blue
    ];

    for (let i = 0; i < 7; i++) {
      const fx = Math.floor(rng() * 26) + 3;
      const fy = Math.floor(rng() * 24) + 4;
      const palette = flowerPalettes[Math.floor(rng() * flowerPalettes.length)];

      // Stem
      px(g, fx, fy + 1, 0x2a5a18);
      px(g, fx, fy + 2, 0x2a5a18);

      // Petals (cross pattern)
      px(g, fx, fy, palette[0]);       // center
      px(g, fx - 1, fy, palette[1]);   // left
      px(g, fx + 1, fy, palette[1]);   // right
      px(g, fx, fy - 1, palette[1]);   // top
      // Center dot
      px(g, fx, fy, palette[2]);
    }

    // Small leaf clusters
    for (let i = 0; i < 3; i++) {
      const lx = Math.floor(rng() * 28) + 2;
      const ly = Math.floor(rng() * 28) + 2;
      px(g, lx, ly, 0x2d5a1e);
      px(g, lx + 1, ly, 0x3a7a2a);
    }

    g.generateTexture('tile_flowers', T, T);
    g.destroy();
  }

  // ── Bridge ────────────────────────────────────────────────
  private generateBridgeTile(): void {
    const g = this.add.graphics();
    const rng = seeded(444);

    // Water underneath (visible through gaps)
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        px(g, x, y, blend(WATER_MID, WATER_DEEP, rng() * 0.3));
      }
    }

    // Wooden planks running horizontally with gaps
    const plankW = T;
    const plankH = 4;
    for (let py = 2; py < T - 2; py += plankH + 1) {
      for (let y = 0; y < plankH; y++) {
        for (let x = 3; x < plankW - 3; x++) {
          let c = BRIDGE_PLANK;
          // Wood grain
          const grain = Math.sin(x * 0.8 + py * 0.2) * 0.1;
          c = grain > 0 ? lighten(c, grain) : darken(c, -grain);
          if (y === 0) c = BRIDGE_LIGHT;
          if (y === plankH - 1) c = BRIDGE_DARK;
          if (rng() > 0.92) c = darken(c, 0.15);
          px(g, x, py + y, c);
        }
      }
    }

    // Side railings/rope
    for (let y = 0; y < T; y++) {
      // Left rope
      px(g, 2, y, BRIDGE_ROPE);
      px(g, 1, y, darken(BRIDGE_ROPE, 0.2));
      // Right rope
      px(g, T - 3, y, BRIDGE_ROPE);
      px(g, T - 2, y, darken(BRIDGE_ROPE, 0.2));
    }

    // Rope texture variation
    for (let y = 0; y < T; y += 3) {
      px(g, 2, y, lighten(BRIDGE_ROPE, 0.15));
      px(g, T - 3, y, lighten(BRIDGE_ROPE, 0.15));
    }

    g.generateTexture('tile_bridge', T, T);
    g.destroy();
  }

  // ── Crop (farm soil with planted rows) ─────────────────────
  private generateCropTile(): void {
    const g = this.add.graphics();
    const rng = seeded(555);

    const SOIL_BASE = 0x5a3e1e;
    const SOIL_DARK = 0x4a3018;
    const SOIL_LIGHT = 0x6a4e2e;
    const CROP_GREEN = 0x3a8a28;
    const CROP_LIGHT = 0x4ca838;
    const CROP_DARK = 0x2a6a1a;
    const WHEAT_TOP = 0xc8a840;

    // Base soil fill
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const noise = rng() * 0.3;
        const c = noise > 0.2 ? SOIL_LIGHT : noise > 0.1 ? SOIL_BASE : SOIL_DARK;
        px(g, x, y, c);
      }
    }

    // Furrow lines (horizontal dark grooves every 8px)
    for (let row = 0; row < 4; row++) {
      const fy = row * 8 + 3;
      for (let x = 0; x < T; x++) {
        px(g, x, fy, SOIL_DARK);
        px(g, x, fy + 1, darken(SOIL_DARK, 0.1));
      }
    }

    // Crop sprouts growing from furrows
    for (let row = 0; row < 4; row++) {
      const baseY = row * 8 + 2; // just above furrow
      for (let cx = 2; cx < T - 1; cx += 3 + Math.floor(rng() * 2)) {
        const height = 2 + Math.floor(rng() * 3);
        const isWheat = rng() > 0.4;

        // Stem
        for (let h = 0; h < height; h++) {
          const lean = h === height - 1 && rng() > 0.6 ? (rng() > 0.5 ? 1 : -1) : 0;
          const sx = cx + lean;
          const sy = baseY - h;
          if (sy >= 0 && sy < T && sx >= 0 && sx < T) {
            px(g, sx, sy, h === 0 ? CROP_DARK : CROP_GREEN);
          }
        }

        // Top — wheat grain or leaf
        const topY = baseY - height;
        if (topY >= 0 && topY < T) {
          if (isWheat) {
            px(g, cx, topY, WHEAT_TOP);
            if (cx + 1 < T) px(g, cx + 1, topY, darken(WHEAT_TOP, 0.1));
          } else {
            px(g, cx, topY, CROP_LIGHT);
            if (cx - 1 >= 0) px(g, cx - 1, topY + 1, CROP_LIGHT);
          }
        }
      }
    }

    // Scattered soil crumbs for texture
    for (let i = 0; i < 8; i++) {
      const sx = Math.floor(rng() * 30) + 1;
      const sy = Math.floor(rng() * 30) + 1;
      px(g, sx, sy, lighten(SOIL_BASE, 0.15));
    }

    g.generateTexture('tile_crop', T, T);
    g.destroy();
  }

  // ═══════════════════════════════════════════════════════════
  // TREE TEXTURES
  // ═══════════════════════════════════════════════════════════
  private generateTreeTextures(): void {
    this.generateOakTree();
    this.generatePineTree();
    this.generateCherryTree();
  }

  private generateOakTree(): void {
    const W = 32;
    const H = 48;
    const g = this.add.graphics();
    const rng = seeded(1234);

    // Trunk: centered, 6px wide, from bottom up to canopy
    const trunkX = 13;
    const trunkW = 6;
    const trunkTop = 20;
    const trunkBot = H - 1;

    // Shadow on ground
    for (let x = trunkX - 4; x < trunkX + trunkW + 4; x++) {
      if (x >= 0 && x < W) {
        px(g, x, H - 1, 0x1a3a12);
        px(g, x, H - 2, blend(0x1a3a12, 0x000000, 0.0));
      }
    }

    // Trunk with bark texture
    for (let y = trunkTop; y <= trunkBot; y++) {
      for (let x = trunkX; x < trunkX + trunkW; x++) {
        let c = 0x5a3a1a;
        // Bark vertical lines
        if ((x - trunkX) % 2 === 0) c = 0x4a2a10;
        // Horizontal bark rings
        if (y % 4 === 0) c = darken(c, 0.1);
        // Edge highlight/shadow
        if (x === trunkX) c = darken(c, 0.15);
        if (x === trunkX + trunkW - 1) c = darken(c, 0.1);
        if (x === trunkX + 1) c = lighten(c, 0.08);
        // Random bark spots
        if (rng() > 0.88) c = darken(c, 0.12);
        px(g, x, y, c);
      }
    }

    // Branch stubs
    px(g, trunkX - 1, trunkTop + 3, 0x4a2a10);
    px(g, trunkX - 2, trunkTop + 2, 0x4a2a10);
    px(g, trunkX + trunkW, trunkTop + 5, 0x4a2a10);
    px(g, trunkX + trunkW + 1, trunkTop + 4, 0x4a2a10);

    // Canopy: layered circular leaf masses
    const canopyLayers = [
      { cx: 16, cy: 14, rx: 12, ry: 10, shade: 0 },    // main mass
      { cx: 10, cy: 11, rx: 8, ry: 7, shade: -0.05 },   // left cluster
      { cx: 22, cy: 11, rx: 8, ry: 7, shade: -0.05 },   // right cluster
      { cx: 16, cy: 7, rx: 9, ry: 6, shade: 0.08 },     // top highlight cluster
    ];

    const leafGreens = [0x2a6a1a, 0x3a8a2a, 0x348028, 0x2e7020];
    const leafHighlight = 0x50a840;
    const leafShadow = 0x1a4a10;

    for (const layer of canopyLayers) {
      for (let y = layer.cy - layer.ry; y <= layer.cy + layer.ry; y++) {
        for (let x = layer.cx - layer.rx; x <= layer.cx + layer.rx; x++) {
          if (x < 0 || x >= W || y < 0 || y >= H) continue;
          // Ellipse check
          const dx = (x - layer.cx) / layer.rx;
          const dy = (y - layer.cy) / layer.ry;
          if (dx * dx + dy * dy > 1) continue;

          // Edge roughness for natural look
          if (dx * dx + dy * dy > 0.75 && rng() > 0.6) continue;

          let c = leafGreens[Math.floor(rng() * leafGreens.length)];

          // Top = lighter (sunlit), bottom = darker
          if (y < layer.cy - layer.ry * 0.3) c = lighten(c, 0.1);
          if (y > layer.cy + layer.ry * 0.3) c = darken(c, 0.12);

          // Left highlight, right shadow (light from top-left)
          if (x < layer.cx - layer.rx * 0.3) c = lighten(c, 0.06);
          if (x > layer.cx + layer.rx * 0.3) c = darken(c, 0.06);

          // Layer shade adjustment
          if (layer.shade > 0) c = lighten(c, layer.shade);
          else if (layer.shade < 0) c = darken(c, -layer.shade);

          // Individual leaf cluster texture
          if (rng() > 0.85) c = leafHighlight;
          if (rng() > 0.92) c = leafShadow;

          px(g, x, y, c);
        }
      }
    }

    // Leaf edge detail: scattered individual dark/bright pixels on edges
    for (let i = 0; i < 15; i++) {
      const angle = rng() * Math.PI * 2;
      const dist = 10 + rng() * 3;
      const ex = Math.round(16 + Math.cos(angle) * dist);
      const ey = Math.round(12 + Math.sin(angle) * (dist * 0.7));
      if (ex >= 0 && ex < W && ey >= 0 && ey < H) {
        px(g, ex, ey, rng() > 0.5 ? leafHighlight : leafShadow);
      }
    }

    g.generateTexture('tree_oak', W, H);
    g.destroy();
  }

  private generatePineTree(): void {
    const W = 32;
    const H = 48;
    const g = this.add.graphics();
    const rng = seeded(5678);

    // Shadow on ground
    for (let x = 10; x < 22; x++) {
      px(g, x, H - 1, 0x1a3a12);
    }

    // Trunk
    const trunkX = 14;
    const trunkW = 4;
    for (let y = 32; y < H; y++) {
      for (let x = trunkX; x < trunkX + trunkW; x++) {
        let c = 0x4a2a10;
        if (x === trunkX) c = 0x3a1a08;
        if (x === trunkX + trunkW - 1) c = 0x3a1a08;
        if (y % 3 === 0) c = darken(c, 0.08);
        px(g, x, y, c);
      }
    }

    // Triangular pine layers (3 tiers)
    const pineGreen = [0x1a4a1a, 0x1e5a1e, 0x225a22, 0x164016];
    const pineBright = 0x2a6a2a;
    const pineDark = 0x0e3010;

    const tiers = [
      { tipY: 2, baseY: 18, halfW: 12 },  // top tier
      { tipY: 12, baseY: 26, halfW: 14 },  // middle tier
      { tipY: 22, baseY: 34, halfW: 13 },  // bottom tier
    ];

    for (const tier of tiers) {
      for (let y = tier.tipY; y <= tier.baseY; y++) {
        const progress = (y - tier.tipY) / (tier.baseY - tier.tipY);
        const rowHalf = Math.floor(progress * tier.halfW);
        for (let dx = -rowHalf; dx <= rowHalf; dx++) {
          const x = 16 + dx;
          if (x < 0 || x >= W) continue;

          let c = pineGreen[Math.floor(rng() * pineGreen.length)];

          // Edge roughness
          if (Math.abs(dx) === rowHalf && rng() > 0.5) continue;

          // Top lighter
          if (y < tier.tipY + (tier.baseY - tier.tipY) * 0.3) c = lighten(c, 0.08);
          // Bottom darker
          if (y > tier.tipY + (tier.baseY - tier.tipY) * 0.7) c = darken(c, 0.1);
          // Left highlight
          if (dx < -rowHalf * 0.4) c = lighten(c, 0.05);

          // Snow-like bright spots on top edge
          if (y === tier.tipY || y === tier.tipY + 1) c = pineBright;

          // Branch texture
          if (rng() > 0.88) c = pineBright;
          if (rng() > 0.93) c = pineDark;

          px(g, x, y, c);
        }
      }
    }

    g.generateTexture('tree_pine', W, H);
    g.destroy();
  }

  private generateCherryTree(): void {
    const W = 32;
    const H = 48;
    const g = this.add.graphics();
    const rng = seeded(9012);

    // Shadow
    for (let x = 8; x < 24; x++) {
      px(g, x, H - 1, 0x1a3a12);
    }

    // Trunk (slightly curved)
    for (let y = 22; y < H; y++) {
      const curve = Math.round(Math.sin((y - 22) * 0.1) * 0.5);
      for (let dx = 0; dx < 5; dx++) {
        const x = 14 + dx + curve;
        if (x < 0 || x >= W) continue;
        let c = 0x5a3020;
        if (dx === 0) c = 0x4a2018;
        if (dx === 4) c = 0x4a2018;
        if (y % 4 === 0) c = darken(c, 0.06);
        if (dx === 1) c = lighten(c, 0.06);
        px(g, x, y, c);
      }
    }

    // Branch stubs
    px(g, 12, 24, 0x4a2018);
    px(g, 11, 23, 0x4a2018);
    px(g, 20, 25, 0x4a2018);
    px(g, 21, 24, 0x4a2018);

    // Canopy: softer, rounder shape with blossoms
    const cherryGreens = [0x3a7a2a, 0x348028, 0x2e7020];
    const blossomPink = [0xf0a0b0, 0xf8b8c8, 0xe890a0, 0xffc8d8];
    const blossomWhite = [0xf8f0f0, 0xf0e8e8, 0xffe8f0];

    const layers = [
      { cx: 16, cy: 14, rx: 13, ry: 11 },
      { cx: 10, cy: 12, rx: 8, ry: 7 },
      { cx: 22, cy: 12, rx: 8, ry: 7 },
      { cx: 16, cy: 8, rx: 10, ry: 7 },
    ];

    for (const layer of layers) {
      for (let y = layer.cy - layer.ry; y <= layer.cy + layer.ry; y++) {
        for (let x = layer.cx - layer.rx; x <= layer.cx + layer.rx; x++) {
          if (x < 0 || x >= W || y < 0 || y >= H) continue;
          const dx = (x - layer.cx) / layer.rx;
          const dy = (y - layer.cy) / layer.ry;
          if (dx * dx + dy * dy > 1) continue;
          if (dx * dx + dy * dy > 0.75 && rng() > 0.55) continue;

          // Mix of green leaves and pink/white blossoms
          let c: number;
          const r = rng();
          if (r < 0.35) {
            // Blossom
            c = blossomPink[Math.floor(rng() * blossomPink.length)];
          } else if (r < 0.45) {
            c = blossomWhite[Math.floor(rng() * blossomWhite.length)];
          } else {
            c = cherryGreens[Math.floor(rng() * cherryGreens.length)];
            if (y < layer.cy) c = lighten(c, 0.08);
            if (y > layer.cy) c = darken(c, 0.08);
          }

          px(g, x, y, c);
        }
      }
    }

    g.generateTexture('tree_cherry', W, H);
    g.destroy();
  }

  // ═══════════════════════════════════════════════════════════
  // DECORATION TEXTURES
  // ═══════════════════════════════════════════════════════════
  private generateDecorationTextures(): void {
    this.generateFlowerDecor('deco_flower_red', 0xe04040, 0xf06060);
    this.generateFlowerDecor('deco_flower_blue', 0x4060e0, 0x6080f0);
    this.generateRock();
    this.generateMushroom();
    this.generateBench();
    this.generateLantern();
    this.generateSign('deco_sign_cafe', 'CAFE');
    this.generateSign('deco_sign_shop', 'SHOP');
  }

  private generateFlowerDecor(key: string, petalDark: number, petalLight: number): void {
    const g = this.add.graphics();
    const S = 16;

    // Stem
    px(g, 7, 10, 0x2a5a18);
    px(g, 7, 11, 0x2a5a18);
    px(g, 7, 12, 0x2a5a18);
    px(g, 7, 13, 0x2a5a18);
    px(g, 8, 14, 0x2a5a18);
    // Small leaf on stem
    px(g, 8, 12, 0x3a8a2a);
    px(g, 9, 11, 0x3a8a2a);

    // Petals (5-petal flower)
    px(g, 7, 8, petalLight);   // top
    px(g, 6, 9, petalDark);    // left
    px(g, 8, 9, petalDark);    // right
    px(g, 6, 10, petalLight);  // bottom-left
    px(g, 8, 10, petalLight);  // bottom-right
    // Center
    px(g, 7, 9, 0xf0e040);

    // Second smaller flower
    px(g, 11, 10, petalDark);
    px(g, 10, 11, petalLight);
    px(g, 12, 11, petalLight);
    px(g, 11, 11, 0xf0e040);
    px(g, 11, 12, 0x2a5a18);
    px(g, 11, 13, 0x2a5a18);

    g.generateTexture(key, S, S);
    g.destroy();
  }

  private generateRock(): void {
    const g = this.add.graphics();
    const S = 16;
    const rng = seeded(2468);

    // Rock shape: irregular blob
    const rockPixels = [
      // Row 9-10: top
      [6, 9], [7, 9], [8, 9], [9, 9],
      // Row 10: wider
      [5, 10], [6, 10], [7, 10], [8, 10], [9, 10], [10, 10],
      // Row 11: widest
      [4, 11], [5, 11], [6, 11], [7, 11], [8, 11], [9, 11], [10, 11], [11, 11],
      // Row 12: base
      [4, 12], [5, 12], [6, 12], [7, 12], [8, 12], [9, 12], [10, 12], [11, 12],
      // Row 13: bottom
      [5, 13], [6, 13], [7, 13], [8, 13], [9, 13], [10, 13],
    ];

    for (const [x, y] of rockPixels) {
      let c = 0x808080;
      // Highlight on top
      if (y <= 10) c = 0x9a9a9a;
      if (y === 9) c = 0xaaaaaa;
      // Shadow on bottom
      if (y >= 12) c = 0x6a6a6a;
      // Left highlight
      if (x <= 5) c = lighten(c, 0.06);
      // Surface texture
      if (rng() > 0.8) c = darken(c, 0.1);
      if (rng() > 0.9) c = lighten(c, 0.1);
      px(g, x, y, c);
    }

    // Moss spots
    px(g, 5, 11, 0x4a7a3a);
    px(g, 6, 12, 0x4a7a3a);

    g.generateTexture('deco_rock', S, S);
    g.destroy();
  }

  private generateMushroom(): void {
    const g = this.add.graphics();
    const S = 16;

    // Stem
    px(g, 7, 12, 0xe8e0d0);
    px(g, 8, 12, 0xe8e0d0);
    px(g, 7, 13, 0xd8d0c0);
    px(g, 8, 13, 0xd8d0c0);
    px(g, 7, 14, 0xc8c0b0);
    px(g, 8, 14, 0xc8c0b0);

    // Cap (red with white dots)
    const capPixels = [
      [6, 9], [7, 9], [8, 9], [9, 9],
      [5, 10], [6, 10], [7, 10], [8, 10], [9, 10], [10, 10],
      [5, 11], [6, 11], [7, 11], [8, 11], [9, 11], [10, 11],
      [6, 12], [9, 12],
    ];

    for (const [x, y] of capPixels) {
      let c = 0xc03030;
      if (y === 9) c = 0xd04040; // top lighter
      if (y === 11 && (x === 5 || x === 10)) c = 0xa02020; // edge shadow
      px(g, x, y, c);
    }

    // White dots on cap
    px(g, 7, 9, 0xf0f0f0);
    px(g, 6, 10, 0xf0f0f0);
    px(g, 9, 10, 0xf0f0f0);
    px(g, 8, 11, 0xf0f0f0);

    g.generateTexture('deco_mushroom', S, S);
    g.destroy();
  }

  private generateBench(): void {
    const g = this.add.graphics();
    const S = 16;

    // Bench seat (horizontal plank)
    for (let x = 2; x < 14; x++) {
      let c = 0x7a5c3a;
      if (x % 4 === 0) c = 0x6a4c2a; // plank separation
      px(g, x, 9, lighten(c, 0.1));
      px(g, x, 10, c);
    }

    // Back rest
    for (let x = 2; x < 14; x++) {
      let c = 0x7a5c3a;
      if (x % 4 === 0) c = 0x6a4c2a;
      px(g, x, 7, lighten(c, 0.08));
      px(g, x, 8, c);
    }

    // Legs
    const legColor = 0x5a3a1a;
    px(g, 3, 11, legColor);
    px(g, 3, 12, legColor);
    px(g, 3, 13, legColor);
    px(g, 12, 11, legColor);
    px(g, 12, 12, legColor);
    px(g, 12, 13, legColor);

    // Arm rests
    px(g, 2, 8, 0x6a4c2a);
    px(g, 2, 9, 0x6a4c2a);
    px(g, 13, 8, 0x6a4c2a);
    px(g, 13, 9, 0x6a4c2a);

    g.generateTexture('deco_bench', S, S);
    g.destroy();
  }

  private generateLantern(): void {
    const g = this.add.graphics();
    const S = 16;

    // Post
    px(g, 7, 8, 0x4a4a4a);
    px(g, 8, 8, 0x4a4a4a);
    px(g, 7, 9, 0x4a4a4a);
    px(g, 8, 9, 0x4a4a4a);
    px(g, 7, 10, 0x555555);
    px(g, 8, 10, 0x555555);
    px(g, 7, 11, 0x555555);
    px(g, 8, 11, 0x555555);
    px(g, 7, 12, 0x555555);
    px(g, 8, 12, 0x555555);
    px(g, 7, 13, 0x606060);
    px(g, 8, 13, 0x606060);
    px(g, 7, 14, 0x606060);
    px(g, 8, 14, 0x606060);

    // Lantern top (cap)
    px(g, 6, 5, 0x3a3a3a);
    px(g, 7, 5, 0x3a3a3a);
    px(g, 8, 5, 0x3a3a3a);
    px(g, 9, 5, 0x3a3a3a);

    // Glowing body
    const glowColor = 0xf0d060;
    const glowBright = 0xf8e880;
    px(g, 6, 6, glowColor);
    px(g, 7, 6, glowBright);
    px(g, 8, 6, glowBright);
    px(g, 9, 6, glowColor);
    px(g, 6, 7, glowColor);
    px(g, 7, 7, 0xfff0a0);
    px(g, 8, 7, 0xfff0a0);
    px(g, 9, 7, glowColor);

    // Bottom cap
    px(g, 6, 8, 0x3a3a3a);
    px(g, 9, 8, 0x3a3a3a);

    // Glow aura (subtle)
    px(g, 5, 6, darken(glowColor, 0.5));
    px(g, 10, 6, darken(glowColor, 0.5));
    px(g, 5, 7, darken(glowColor, 0.5));
    px(g, 10, 7, darken(glowColor, 0.5));

    g.generateTexture('deco_lantern', S, S);
    g.destroy();
  }

  private generateSign(key: string, label: string): void {
    const g = this.add.graphics();
    const S = 16;

    // Post
    px(g, 7, 8, 0x5a3a1a);
    px(g, 8, 8, 0x5a3a1a);
    px(g, 7, 9, 0x5a3a1a);
    px(g, 8, 9, 0x5a3a1a);
    px(g, 7, 10, 0x5a3a1a);
    px(g, 8, 10, 0x5a3a1a);
    px(g, 7, 11, 0x5a3a1a);
    px(g, 8, 11, 0x5a3a1a);
    px(g, 7, 12, 0x5a3a1a);
    px(g, 8, 12, 0x5a3a1a);
    px(g, 7, 13, 0x4a2a10);
    px(g, 8, 13, 0x4a2a10);
    px(g, 7, 14, 0x4a2a10);
    px(g, 8, 14, 0x4a2a10);

    // Sign board
    const boardColor = 0x8b6b4a;
    const boardDark = 0x6b5030;
    for (let y = 3; y < 8; y++) {
      for (let x = 2; x < 14; x++) {
        let c = boardColor;
        if (y === 3 || y === 7) c = boardDark; // top/bottom border
        if (x === 2 || x === 13) c = boardDark; // side border
        px(g, x, y, c);
      }
    }

    // Simple text indication (just a few pixels to suggest letters)
    if (label === 'CAFE') {
      // C
      px(g, 4, 5, 0x2a1a0a); px(g, 4, 4, 0x2a1a0a); px(g, 4, 6, 0x2a1a0a); px(g, 5, 4, 0x2a1a0a); px(g, 5, 6, 0x2a1a0a);
      // A
      px(g, 7, 6, 0x2a1a0a); px(g, 7, 5, 0x2a1a0a); px(g, 7, 4, 0x2a1a0a); px(g, 8, 4, 0x2a1a0a); px(g, 8, 5, 0x2a1a0a); px(g, 8, 6, 0x2a1a0a);
      // F
      px(g, 10, 4, 0x2a1a0a); px(g, 10, 5, 0x2a1a0a); px(g, 10, 6, 0x2a1a0a); px(g, 11, 4, 0x2a1a0a); px(g, 11, 5, 0x2a1a0a);
    } else {
      // S
      px(g, 4, 4, 0x2a1a0a); px(g, 5, 4, 0x2a1a0a); px(g, 4, 5, 0x2a1a0a); px(g, 5, 6, 0x2a1a0a); px(g, 4, 6, 0x2a1a0a);
      // H
      px(g, 7, 4, 0x2a1a0a); px(g, 7, 5, 0x2a1a0a); px(g, 7, 6, 0x2a1a0a); px(g, 8, 5, 0x2a1a0a); px(g, 9, 4, 0x2a1a0a); px(g, 9, 5, 0x2a1a0a); px(g, 9, 6, 0x2a1a0a);
      // P
      px(g, 11, 4, 0x2a1a0a); px(g, 11, 5, 0x2a1a0a); px(g, 11, 6, 0x2a1a0a); px(g, 12, 4, 0x2a1a0a); px(g, 12, 5, 0x2a1a0a);
    }

    g.generateTexture(key, S, S);
    g.destroy();
  }

  // ═══════════════════════════════════════════════════════════
  // FURNITURE TEXTURES (32x32)
  // ═══════════════════════════════════════════════════════════
  private generateFurnitureTextures(): void {
    this.generateFurnTable();
    this.generateFurnChair();
    this.generateFurnCounter();
    this.generateFurnBookshelf();
    this.generateFurnBed();
    this.generateFurnOven();
    this.generateFurnWorkbench();
    this.generateFurnBarrel();
    this.generateFurnAltar();
    this.generateFurnDesk();
    this.generateFurnPew();
    this.generateFurnBlackboard();
    this.generateFurnAnvil();
    this.generateFurnFireplace();
    this.generateFurnCrate();
  }

  private generateFurnTable(): void {
    const g = this.add.graphics();
    const S = 32;
    const rng = seeded(3001);
    const wood = 0x7a5c3a;
    const woodDark = darken(wood, 0.2);
    const woodLight = lighten(wood, 0.12);

    // Table surface (top-down rectangle with rounded corners)
    for (let y = 4; y < 28; y++) {
      for (let x = 3; x < 29; x++) {
        if ((y === 4 || y === 27) && (x <= 4 || x >= 27)) continue;
        let c = wood;
        const grain = Math.sin(x * 0.6 + y * 0.15) * 0.08;
        c = grain > 0 ? lighten(c, grain) : darken(c, -grain);
        if (y === 4 || y === 5) c = woodLight;
        if (y >= 26) c = woodDark;
        if (x === 3 || x === 4) c = lighten(c, 0.05);
        if (x >= 27) c = woodDark;
        if (rng() > 0.88) c = darken(c, 0.08);
        px(g, x, y, c);
      }
    }

    // Table legs at corners
    for (const [lx, ly] of [[5, 6], [26, 6], [5, 25], [26, 25]]) {
      px(g, lx, ly, darken(wood, 0.3));
      px(g, lx + 1, ly, darken(wood, 0.28));
      px(g, lx, ly + 1, darken(wood, 0.28));
    }

    // Wood grain knots
    px(g, 13, 14, darken(wood, 0.15));
    px(g, 14, 14, darken(wood, 0.12));
    px(g, 14, 15, darken(wood, 0.1));
    px(g, 15, 15, darken(wood, 0.08));
    px(g, 20, 20, darken(wood, 0.13));
    px(g, 21, 20, darken(wood, 0.1));

    g.generateTexture('furn_table', S, S);
    g.destroy();
  }

  private generateFurnChair(): void {
    const g = this.add.graphics();
    const S = 32;
    const wood = 0x6a4c2a;
    const woodDark = darken(wood, 0.2);
    const woodLight = lighten(wood, 0.12);

    // Seat (top-down square)
    for (let y = 14; y < 26; y++) {
      for (let x = 10; x < 22; x++) {
        let c = wood;
        if (y === 14) c = woodLight;
        if (y === 25) c = woodDark;
        if (x === 10) c = lighten(c, 0.05);
        if (x === 21) c = darken(c, 0.08);
        px(g, x, y, c);
      }
    }

    // Backrest (strip above seat)
    for (let x = 10; x < 22; x++) {
      for (let y = 8; y < 13; y++) {
        let c = lighten(wood, 0.06);
        if (x === 10 || x === 21) c = woodDark;
        if (y === 12) c = darken(wood, 0.1);
        px(g, x, y, c);
      }
    }

    // Chair legs at corners
    for (const [lx, ly] of [[10, 14], [21, 14], [10, 25], [21, 25]]) {
      px(g, lx, ly, woodDark);
      px(g, lx + 1, ly, darken(wood, 0.25));
    }

    // Backrest supports
    for (let y = 8; y < 13; y++) {
      px(g, 10, y, darken(wood, 0.25));
      px(g, 21, y, darken(wood, 0.25));
    }

    g.generateTexture('furn_chair', S, S);
    g.destroy();
  }

  private generateFurnCounter(): void {
    const g = this.add.graphics();
    const S = 32;
    const rng = seeded(3003);
    const top = 0x8b6b4a;
    const front = 0x5a4020;

    // Counter top surface
    for (let y = 6; y < 18; y++) {
      for (let x = 2; x < 30; x++) {
        let c = top;
        const grain = Math.sin(x * 0.45 + y * 0.1) * 0.07;
        c = grain > 0 ? lighten(c, grain) : darken(c, -grain);
        if (y === 6 || y === 7) c = lighten(top, 0.12);
        if (y === 17) c = front;
        if (x <= 3) c = lighten(c, 0.06);
        if (x >= 28) c = darken(c, 0.08);
        if (rng() > 0.9) c = darken(c, 0.06);
        px(g, x, y, c);
      }
    }

    // Front face
    for (let y = 18; y < 28; y++) {
      for (let x = 2; x < 30; x++) {
        let c = front;
        if (y === 18 || y === 19) c = darken(front, 0.15);
        if (y >= 26) c = darken(front, 0.1);
        if (x === 10 || x === 20) c = darken(front, 0.2);
        if (rng() > 0.92) c = lighten(c, 0.06);
        px(g, x, y, c);
      }
    }

    // Edge lip shadow
    for (let x = 2; x < 30; x++) px(g, x, 18, darken(front, 0.2));

    g.generateTexture('furn_counter', S, S);
    g.destroy();
  }

  private generateFurnBookshelf(): void {
    const g = this.add.graphics();
    const S = 32;
    const rng = seeded(3004);
    const frame = 0x5a3a1a;
    const frameDark = darken(frame, 0.2);
    const shelfPlank = 0x6a4a2a;

    // Outer frame
    for (let y = 2; y < 30; y++) {
      px(g, 3, y, frame); px(g, 4, y, frame);
      px(g, 27, y, frameDark); px(g, 28, y, frameDark);
    }
    for (let x = 3; x < 29; x++) {
      px(g, x, 2, lighten(frame, 0.1)); px(g, x, 3, lighten(frame, 0.08));
      px(g, x, 28, frameDark); px(g, x, 29, frameDark);
    }

    // Shelf planks (4 shelves)
    for (const sy of [8, 14, 20, 25]) {
      for (let x = 5; x < 27; x++) {
        px(g, x, sy, shelfPlank);
        px(g, x, sy + 1, darken(shelfPlank, 0.1));
      }
    }

    // Books on shelves
    const bookColors = [0xc03030, 0x3050b0, 0x2a8a40, 0xb08020, 0x8040a0, 0x206080, 0xa05030, 0x508040];
    const rows = [
      { y1: 4, y2: 7 },
      { y1: 10, y2: 13 },
      { y1: 16, y2: 19 },
      { y1: 22, y2: 24 },
      { y1: 27, y2: 28 },
    ];

    for (const row of rows) {
      let bx = 5;
      while (bx < 27) {
        const bw = 1 + Math.floor(rng() * 3);
        const bc = bookColors[Math.floor(rng() * bookColors.length)];
        for (let by = row.y1; by <= row.y2; by++) {
          for (let dx = 0; dx < bw && bx + dx < 27; dx++) {
            let c = bc;
            if (dx === 0 && bw > 1) c = darken(bc, 0.1);
            if (by === row.y1) c = lighten(c, 0.08);
            px(g, bx + dx, by, c);
          }
        }
        bx += bw + (rng() > 0.7 ? 1 : 0);
      }
    }

    g.generateTexture('furn_bookshelf', S, S);
    g.destroy();
  }

  private generateFurnBed(): void {
    const g = this.add.graphics();
    const S = 32;
    const frame = 0x6a4c2a;
    const frameDark = darken(frame, 0.2);
    const pillow = 0xe8e8e8;
    const pillowShadow = darken(pillow, 0.12);
    const blanket = 0x4060a0;
    const blanketLight = lighten(blanket, 0.15);
    const blanketDark = darken(blanket, 0.15);

    // Bed frame outline
    for (let y = 3; y < 29; y++) {
      px(g, 3, y, frame); px(g, 4, y, frame);
      px(g, 27, y, frameDark); px(g, 28, y, frameDark);
    }
    for (let x = 3; x < 29; x++) {
      px(g, x, 3, lighten(frame, 0.1)); px(g, x, 4, lighten(frame, 0.08));
      px(g, x, 27, frameDark); px(g, x, 28, frameDark);
    }

    // Headboard
    for (let x = 5; x < 27; x++) {
      px(g, x, 3, lighten(frame, 0.15));
      px(g, x, 4, lighten(frame, 0.12));
      px(g, x, 5, frame);
      px(g, x, 6, darken(frame, 0.05));
    }

    // Pillow
    for (let y = 7; y < 11; y++) {
      for (let x = 7; x < 25; x++) {
        let c = pillow;
        if (x <= 8 || x >= 23) c = pillowShadow;
        if (x === 15 || x === 16) c = pillowShadow;
        if (y === 7) c = lighten(c, 0.05);
        px(g, x, y, c);
      }
    }

    // Blanket
    for (let y = 11; y < 27; y++) {
      for (let x = 5; x < 27; x++) {
        let c = blanket;
        if (y <= 12) c = blanketLight;
        if (y === 13) c = lighten(blanket, 0.08);
        if (y >= 24) c = blanketDark;
        if (x <= 6) c = darken(c, 0.08);
        if (x >= 25) c = darken(c, 0.1);
        if (y <= 12 && x >= 9 && x <= 22) c = lighten(blanket, 0.2);
        px(g, x, y, c);
      }
    }

    // Frame posts
    px(g, 3, 3, lighten(frame, 0.2)); px(g, 4, 3, lighten(frame, 0.18));
    px(g, 27, 3, lighten(frame, 0.1)); px(g, 28, 3, lighten(frame, 0.08));
    px(g, 3, 28, darken(frame, 0.1)); px(g, 28, 28, darken(frame, 0.25));

    g.generateTexture('furn_bed', S, S);
    g.destroy();
  }

  private generateFurnOven(): void {
    const g = this.add.graphics();
    const S = 32;
    const rng = seeded(3006);
    const stone = 0x6b6b6b;
    const stoneDark = darken(stone, 0.2);
    const stoneLight = lighten(stone, 0.12);
    const fire = 0xf08030;
    const fireGlow = 0xf0a050;
    const fireBright = 0xf8c060;

    // Oven body
    for (let y = 5; y < 28; y++) {
      for (let x = 5; x < 27; x++) {
        let c = stone;
        if (y <= 6) c = stoneLight;
        if (y === 7) c = lighten(stone, 0.06);
        if (y >= 26) c = stoneDark;
        if (x <= 6) c = lighten(c, 0.05);
        if (x >= 25) c = darken(c, 0.08);
        if (rng() > 0.85) c = darken(c, 0.08);
        if (rng() > 0.92) c = lighten(c, 0.06);
        px(g, x, y, c);
      }
    }

    // Oven opening
    for (let y = 13; y < 24; y++) {
      for (let x = 9; x < 23; x++) {
        let c = 0x1a1010;
        if (y >= 18) {
          const intensity = rng();
          if (intensity > 0.5) c = fire;
          if (intensity > 0.7) c = fireGlow;
          if (intensity > 0.85) c = fireBright;
        }
        if (y === 13 || y === 14) c = blend(0x1a1010, fire, 0.25);
        if (y === 15 || y === 16) c = blend(0x1a1010, fire, 0.15);
        px(g, x, y, c);
      }
    }

    // Opening border (stone arch)
    for (let x = 9; x < 23; x++) {
      px(g, x, 11, stoneDark); px(g, x, 12, stoneDark);
    }
    for (let y = 13; y < 24; y++) {
      px(g, 7, y, stoneDark); px(g, 8, y, stoneDark);
      px(g, 23, y, stoneDark); px(g, 24, y, stoneDark);
    }

    // Chimney hint
    rect(g, 14, 1, 4, 4, stone);
    rect(g, 14, 3, 4, 2, stoneDark);
    // Smoke
    px(g, 15, 0, blend(stone, 0xaaaaaa, 0.5));
    px(g, 16, 0, blend(stone, 0xaaaaaa, 0.3));

    g.generateTexture('furn_oven', S, S);
    g.destroy();
  }

  private generateFurnWorkbench(): void {
    const g = this.add.graphics();
    const S = 32;
    const rng = seeded(3007);
    const wood = 0x5a3a1a;
    const woodLight = lighten(wood, 0.15);
    const woodDark = darken(wood, 0.15);
    const metal = 0x888888;
    const metalDark = darken(metal, 0.2);

    // Heavy workbench top
    for (let y = 7; y < 19; y++) {
      for (let x = 2; x < 30; x++) {
        let c = wood;
        const grain = Math.sin(x * 0.35 + y * 0.2) * 0.1;
        c = grain > 0 ? lighten(c, grain) : darken(c, -grain);
        if (y <= 8) c = woodLight;
        if (y >= 17) c = woodDark;
        if (x <= 3) c = lighten(c, 0.06);
        if (x >= 28) c = darken(c, 0.08);
        if (rng() > 0.9) c = lighten(c, 0.1);
        px(g, x, y, c);
      }
    }

    // Legs
    for (let y = 19; y < 28; y++) {
      rect(g, 4, y, 3, 1, woodDark);
      rect(g, 25, y, 3, 1, woodDark);
    }

    // Cross brace
    for (let x = 7; x < 25; x++) px(g, x, 24, darken(wood, 0.25));

    // Hammer on surface
    for (let x = 6; x < 13; x++) px(g, x, 12, 0x6a4a2a);
    rect(g, 13, 10, 3, 4, metal);
    rect(g, 14, 11, 2, 3, metalDark);

    // Wrench
    px(g, 20, 13, metal); px(g, 21, 13, metal); px(g, 22, 13, metal);
    px(g, 23, 14, metalDark); px(g, 24, 14, metalDark);

    // Scratch marks
    px(g, 9, 9, lighten(wood, 0.2));
    px(g, 10, 9, lighten(wood, 0.18));
    px(g, 18, 10, lighten(wood, 0.15));

    g.generateTexture('furn_workbench', S, S);
    g.destroy();
  }

  private generateFurnBarrel(): void {
    const g = this.add.graphics();
    const S = 32;
    const rng = seeded(3008);
    const wood = 0x7a5c3a;
    const woodDark = darken(wood, 0.15);
    const band = 0x4a4a4a;
    const bandLight = lighten(band, 0.15);

    const cx = 15.5;
    const cy = 15.5;
    const radius = 11.5;

    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > radius + 0.5) continue;

        // Outer band
        if (dist > radius - 1.5) {
          let c = band;
          if (dx < 0 && dy < 0) c = bandLight;
          px(g, x, y, c);
          continue;
        }

        // Inner band
        if (dist > 6.5 && dist < 8.0) {
          let c = band;
          if (dx < 0 && dy < 0) c = bandLight;
          px(g, x, y, c);
          continue;
        }

        const angle = Math.atan2(dy, dx);
        const staveIdx = Math.floor((angle + Math.PI) / (Math.PI / 5));
        let c = staveIdx % 2 === 0 ? wood : woodDark;

        if (dist < 3.5) c = lighten(c, 0.12);
        else if (dist < 7) c = lighten(c, 0.05);

        if (rng() > 0.88) c = darken(c, 0.08);
        px(g, x, y, c);
      }
    }

    // Center bung
    rect(g, 14, 14, 4, 4, darken(wood, 0.3));
    px(g, 15, 15, darken(wood, 0.35));
    px(g, 16, 15, darken(wood, 0.35));

    g.generateTexture('furn_barrel', S, S);
    g.destroy();
  }

  private generateFurnAltar(): void {
    const g = this.add.graphics();
    const S = 32;
    const rng = seeded(3009);
    const stone = 0x9a9a9a;
    const stoneDark = darken(stone, 0.15);
    const stoneLight = lighten(stone, 0.1);
    const gold = 0xd4a040;
    const goldBright = lighten(gold, 0.2);
    const goldDark = darken(gold, 0.2);

    // Stone slab base
    for (let y = 7; y < 26; y++) {
      for (let x = 3; x < 29; x++) {
        let c = stone;
        if (y <= 8) c = stoneLight;
        if (y === 9) c = lighten(stone, 0.05);
        if (y >= 24) c = stoneDark;
        if (x <= 4) c = lighten(c, 0.05);
        if (x >= 27) c = darken(c, 0.08);
        if (rng() > 0.87) c = darken(c, 0.06);
        if (rng() > 0.93) c = lighten(c, 0.06);
        px(g, x, y, c);
      }
    }

    // Step below
    for (let x = 2; x < 30; x++) {
      px(g, x, 26, darken(stone, 0.2));
      px(g, x, 27, darken(stone, 0.25));
      px(g, x, 28, darken(stone, 0.3));
    }

    // Golden cloth
    for (let y = 9; y < 20; y++) {
      for (let x = 7; x < 25; x++) {
        let c = gold;
        if (y <= 10) c = goldBright;
        if (y >= 18) c = goldDark;
        if (x === 15 || x === 16) c = goldBright;
        if (y === 14 && x >= 11 && x <= 20) c = goldBright;
        if (y === 19 && (x <= 8 || x >= 23)) c = darken(gold, 0.25);
        px(g, x, y, c);
      }
    }

    // Cross symbol
    px(g, 15, 12, 0xf0d870); px(g, 16, 12, 0xf0d870);
    px(g, 14, 13, 0xf0d870); px(g, 15, 13, 0xf0d870); px(g, 16, 13, 0xf0d870); px(g, 17, 13, 0xf0d870);
    px(g, 14, 14, 0xf0d870); px(g, 15, 14, 0xf0d870); px(g, 16, 14, 0xf0d870); px(g, 17, 14, 0xf0d870);
    px(g, 15, 15, 0xf0d870); px(g, 16, 15, 0xf0d870);
    px(g, 15, 16, 0xf0d870); px(g, 16, 16, 0xf0d870);

    // Candles
    for (const cx of [5, 26]) {
      px(g, cx, 8, 0xe8e0d0); px(g, cx, 7, 0xe8e0d0);
      px(g, cx, 6, 0xf0c040); px(g, cx, 5, 0xf0e080);
      px(g, cx + 1, 8, 0xd8d0c0); px(g, cx + 1, 7, 0xd8d0c0);
    }

    g.generateTexture('furn_altar', S, S);
    g.destroy();
  }

  private generateFurnDesk(): void {
    const g = this.add.graphics();
    const S = 32;
    const rng = seeded(3010);
    const wood = 0x7a5c3a;
    const woodDark = darken(wood, 0.18);
    const woodLight = lighten(wood, 0.12);
    const paper = 0xe8e0d0;
    const paperShadow = darken(paper, 0.1);

    // Desk surface
    for (let y = 5; y < 27; y++) {
      for (let x = 3; x < 29; x++) {
        let c = wood;
        const grain = Math.sin(x * 0.5 + y * 0.12) * 0.08;
        c = grain > 0 ? lighten(c, grain) : darken(c, -grain);
        if (y <= 6) c = woodLight;
        if (y >= 25) c = woodDark;
        if (x <= 4) c = lighten(c, 0.05);
        if (x >= 27) c = darken(c, 0.08);
        if (rng() > 0.9) c = darken(c, 0.06);
        px(g, x, y, c);
      }
    }

    // Drawer
    for (let y = 16; y < 24; y++) {
      for (let x = 18; x < 27; x++) {
        let c = woodDark;
        if (y === 16) c = darken(wood, 0.25);
        if (x === 18) c = darken(wood, 0.22);
        px(g, x, y, c);
      }
    }
    px(g, 21, 20, 0x888888); px(g, 22, 20, 0x888888);
    px(g, 21, 21, 0x777777); px(g, 22, 21, 0x777777);

    // Paper on desk
    for (let y = 7; y < 17; y++) {
      for (let x = 6; x < 17; x++) {
        let c = paper;
        if (y <= 7 || y >= 16) c = paperShadow;
        if (x <= 6 || x >= 16) c = paperShadow;
        px(g, x, y, c);
      }
    }

    // Writing lines
    const ink = 0x2a2a3a;
    for (const ly of [9, 11, 13]) {
      for (let x = 8; x < 15; x++) {
        if (rng() > 0.3) px(g, x, ly, ink);
      }
    }

    // Quill
    px(g, 20, 9, 0x2a1a0a); px(g, 21, 8, 0x2a1a0a);
    px(g, 22, 7, 0x2a1a0a); px(g, 23, 6, 0xe8e8e8); px(g, 24, 5, 0xe8e8e8);

    // Ink pot
    rect(g, 5, 20, 4, 4, 0x1a1a2a);
    px(g, 6, 21, 0x2a2a4a); px(g, 7, 21, 0x2a2a4a);

    g.generateTexture('furn_desk', S, S);
    g.destroy();
  }

  // ── New furniture types ──────────────────────────────────

  private generateFurnPew(): void {
    const g = this.add.graphics();
    const S = 32;
    const rng = seeded(3011);
    const wood = 0x6a4a28;
    const woodDark = darken(wood, 0.2);
    const woodLight = lighten(wood, 0.12);

    // Seat plank (long horizontal bench, top-down)
    for (let y = 12; y < 22; y++) {
      for (let x = 2; x < 30; x++) {
        let c = wood;
        const grain = Math.sin(x * 0.3 + y * 0.15) * 0.08;
        c = grain > 0 ? lighten(c, grain) : darken(c, -grain);
        if (y <= 13) c = woodLight;
        if (y >= 20) c = woodDark;
        if (x <= 3) c = lighten(c, 0.04);
        if (x >= 28) c = darken(c, 0.06);
        if (rng() > 0.9) c = darken(c, 0.06);
        px(g, x, y, c);
      }
    }

    // Back rest (strip above seat)
    for (let y = 5; y < 12; y++) {
      for (let x = 2; x < 30; x++) {
        let c = lighten(wood, 0.04);
        if (y <= 6) c = woodLight;
        if (y === 11) c = darken(wood, 0.1);
        if (x <= 3 || x >= 28) c = woodDark;
        px(g, x, y, c);
      }
    }

    // Plank separations on seat
    for (let x = 2; x < 30; x++) {
      if (x === 10 || x === 20) {
        for (let y = 12; y < 22; y++) px(g, x, y, woodDark);
      }
    }

    // Support legs
    for (let y = 22; y < 28; y++) {
      rect(g, 4, y, 2, 1, woodDark);
      rect(g, 15, y, 2, 1, woodDark);
      rect(g, 26, y, 2, 1, woodDark);
    }

    // End supports for backrest
    for (let y = 5; y < 22; y++) {
      px(g, 2, y, darken(wood, 0.25));
      px(g, 29, y, darken(wood, 0.25));
    }

    g.generateTexture('furn_pew', S, S);
    g.destroy();
  }

  private generateFurnBlackboard(): void {
    const g = this.add.graphics();
    const S = 32;
    const rng = seeded(3012);
    const boardColor = 0x2a4a2a;
    const boardLight = lighten(boardColor, 0.08);
    const frame = 0x6a4a28;
    const frameDark = darken(frame, 0.2);
    const chalk = 0xe8e8e0;
    const chalkFaint = darken(chalk, 0.3);

    // Wood frame
    for (let x = 2; x < 30; x++) {
      rect(g, x, 2, 1, 2, lighten(frame, 0.1));
      rect(g, x, 26, 1, 2, frameDark);
    }
    for (let y = 2; y < 28; y++) {
      rect(g, 2, y, 2, 1, frame);
      rect(g, 28, y, 2, 1, frameDark);
    }

    // Board surface (dark green)
    for (let y = 4; y < 26; y++) {
      for (let x = 4; x < 28; x++) {
        let c = boardColor;
        if (rng() > 0.85) c = boardLight;
        if (rng() > 0.95) c = darken(boardColor, 0.08);
        px(g, x, y, c);
      }
    }

    // Chalk writing marks (scattered lines suggesting text)
    for (let row = 0; row < 4; row++) {
      const ry = 7 + row * 5;
      let cx = 7;
      while (cx < 25) {
        const wordLen = 2 + Math.floor(rng() * 5);
        for (let i = 0; i < wordLen && cx + i < 25; i++) {
          if (rng() > 0.2) px(g, cx + i, ry, rng() > 0.3 ? chalk : chalkFaint);
          if (rng() > 0.6) px(g, cx + i, ry + 1, chalkFaint);
        }
        cx += wordLen + 1 + Math.floor(rng() * 2);
      }
    }

    // Chalk tray at bottom of frame
    for (let x = 6; x < 26; x++) {
      px(g, x, 26, lighten(frame, 0.05));
      px(g, x, 27, frame);
    }
    // Chalk pieces on tray
    rect(g, 8, 26, 3, 1, 0xf0f0e8);
    rect(g, 15, 26, 2, 1, 0xf0e8a0);
    rect(g, 21, 26, 2, 1, 0xe0e0d8);

    g.generateTexture('furn_blackboard', S, S);
    g.destroy();
  }

  private generateFurnAnvil(): void {
    const g = this.add.graphics();
    const S = 32;
    const rng = seeded(3013);
    const iron = 0x5a5a5a;
    const ironDark = darken(iron, 0.2);
    const ironLight = lighten(iron, 0.15);
    const stump = 0x6a4a28;
    const stumpDark = darken(stump, 0.2);

    // Wooden stump base (circular, bottom half)
    const scx = 15.5;
    const scy = 22;
    for (let y = 18; y < 30; y++) {
      for (let x = 6; x < 26; x++) {
        const dx = x - scx;
        const dy = (y - scy) * 0.8;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 10) continue;
        let c = stump;
        if (dist > 8) c = stumpDark;
        if (y <= 19) c = lighten(stump, 0.08);
        if (rng() > 0.88) c = darken(c, 0.08);
        px(g, x, y, c);
      }
    }

    // Anvil body (T-shape from above)
    // Main body (narrow center)
    for (let y = 8; y < 20; y++) {
      for (let x = 10; x < 22; x++) {
        let c = iron;
        if (y <= 9) c = ironLight;
        if (y >= 18) c = ironDark;
        if (x <= 11) c = lighten(c, 0.05);
        if (x >= 20) c = darken(c, 0.08);
        if (rng() > 0.85) c = darken(c, 0.06);
        px(g, x, y, c);
      }
    }

    // Horn (left extension)
    for (let y = 11; y < 17; y++) {
      for (let x = 4; x < 10; x++) {
        const taper = (10 - x) * 0.3;
        if (y < 11 + taper || y > 17 - taper) continue;
        let c = iron;
        if (y <= 12) c = ironLight;
        if (x <= 5) c = ironLight;
        px(g, x, y, c);
      }
    }

    // Heel (right extension)
    for (let y = 10; y < 18; y++) {
      for (let x = 22; x < 28; x++) {
        let c = iron;
        if (y <= 11) c = ironLight;
        if (x >= 26) c = ironDark;
        px(g, x, y, c);
      }
    }

    // Top surface highlight
    for (let x = 10; x < 22; x++) {
      px(g, x, 8, lighten(iron, 0.2));
      px(g, x, 9, lighten(iron, 0.12));
    }

    // Tool marks (dents)
    px(g, 14, 12, lighten(iron, 0.15));
    px(g, 17, 14, lighten(iron, 0.12));
    px(g, 15, 16, darken(iron, 0.1));

    g.generateTexture('furn_anvil', S, S);
    g.destroy();
  }

  private generateFurnFireplace(): void {
    const g = this.add.graphics();
    const S = 32;
    const rng = seeded(3014);
    const stone = 0x7a7a7a;
    const stoneDark = darken(stone, 0.2);
    const stoneLight = lighten(stone, 0.1);
    const fire = 0xf08030;
    const fireGlow = 0xf0a050;
    const fireBright = 0xf8c060;
    const ember = 0xc04020;
    const ash = 0x4a4a4a;
    const logBrown = 0x5a3a1a;

    // Stone U-hearth walls
    // Left wall
    for (let y = 2; y < 28; y++) {
      for (let x = 2; x < 8; x++) {
        let c = stone;
        if (x <= 3) c = stoneLight;
        if (x >= 6) c = stoneDark;
        if (rng() > 0.85) c = darken(c, 0.1);
        px(g, x, y, c);
      }
    }
    // Right wall
    for (let y = 2; y < 28; y++) {
      for (let x = 24; x < 30; x++) {
        let c = stone;
        if (x <= 25) c = stoneDark;
        if (x >= 28) c = stoneLight;
        if (rng() > 0.85) c = darken(c, 0.1);
        px(g, x, y, c);
      }
    }
    // Back wall
    for (let y = 2; y < 8; y++) {
      for (let x = 8; x < 24; x++) {
        let c = stone;
        if (y <= 3) c = stoneLight;
        if (y >= 6) c = stoneDark;
        if (rng() > 0.85) c = darken(c, 0.1);
        px(g, x, y, c);
      }
    }

    // Interior floor (dark ash)
    for (let y = 8; y < 28; y++) {
      for (let x = 8; x < 24; x++) {
        let c = 0x2a2020;
        if (rng() > 0.8) c = ash;
        px(g, x, y, c);
      }
    }

    // Logs
    for (let x = 10; x < 22; x++) {
      px(g, x, 18, logBrown);
      px(g, x, 19, darken(logBrown, 0.15));
    }
    for (let x = 12; x < 20; x++) {
      px(g, x, 16, lighten(logBrown, 0.1));
      px(g, x, 17, logBrown);
    }

    // Fire
    for (let y = 10; y < 18; y++) {
      for (let x = 11; x < 21; x++) {
        const intensity = rng();
        if (intensity < 0.3) continue;
        let c = fire;
        if (intensity > 0.6) c = fireGlow;
        if (intensity > 0.8) c = fireBright;
        if (y >= 16) c = ember;
        if (y <= 11 && intensity > 0.5) c = 0xf8e080;
        px(g, x, y, c);
      }
    }

    // Ember glow on walls
    for (let y = 10; y < 20; y++) {
      px(g, 8, y, blend(stoneDark, fire, 0.2));
      px(g, 23, y, blend(stoneDark, fire, 0.2));
    }

    // Ash at bottom
    for (let x = 9; x < 23; x++) {
      if (rng() > 0.4) px(g, x, 22, ash);
      if (rng() > 0.5) px(g, x, 23, darken(ash, 0.15));
    }

    g.generateTexture('furn_fireplace', S, S);
    g.destroy();
  }

  private generateFurnCrate(): void {
    const g = this.add.graphics();
    const S = 32;
    const rng = seeded(3015);
    const wood = 0x8a6a40;
    const woodDark = darken(wood, 0.18);
    const woodLight = lighten(wood, 0.1);
    const nail = 0x5a5a5a;

    // Crate top (planked lid from above)
    for (let y = 3; y < 29; y++) {
      for (let x = 3; x < 29; x++) {
        let c = wood;
        const grain = Math.sin(x * 0.4 + y * 0.08) * 0.06;
        c = grain > 0 ? lighten(c, grain) : darken(c, -grain);
        // Plank divisions (horizontal)
        const plank = Math.floor((y - 3) / 5);
        if ((y - 3) % 5 === 0) c = woodDark;
        if (plank % 2 === 0) c = darken(c, 0.04);
        // Edges
        if (x <= 4) c = lighten(c, 0.04);
        if (x >= 27) c = woodDark;
        if (y <= 4) c = woodLight;
        if (y >= 27) c = woodDark;
        if (rng() > 0.9) c = darken(c, 0.06);
        px(g, x, y, c);
      }
    }

    // X-brace on lid
    for (let i = 0; i < 24; i++) {
      const x1 = 4 + i;
      const y1 = 4 + i;
      const y2 = 27 - i;
      if (x1 < 28 && y1 < 28) px(g, x1, y1, darken(wood, 0.2));
      if (x1 < 28 && y2 >= 4) px(g, x1, y2, darken(wood, 0.2));
    }

    // Frame edges (thicker border planks)
    for (let x = 3; x < 29; x++) {
      px(g, x, 3, woodDark); px(g, x, 28, darken(wood, 0.25));
    }
    for (let y = 3; y < 29; y++) {
      px(g, 3, y, woodDark); px(g, 28, y, darken(wood, 0.25));
    }

    // Nail heads at corners and X-brace intersections
    for (const [nx, ny] of [[5, 5], [26, 5], [5, 26], [26, 26], [15, 15], [16, 16]]) {
      px(g, nx, ny, nail);
      px(g, nx + 1, ny, darken(nail, 0.15));
    }

    g.generateTexture('furn_crate', S, S);
    g.destroy();
  }

  // ═══════════════════════════════════════════════════════════
  // AGENT SPRITE TEXTURES (24x32 humanoid)
  // ═══════════════════════════════════════════════════════════
  private generateAgentTextures(): void {
    // Default agent (fallback)
    generateAgentTexture(this, 'agent_default', 0x4488cc, 0x6b4020);
  }

  private generateAgentSprite(key: string, shirtColor: number, hairColor: number): void {
    const W = 24;
    const H = 32;
    const g = this.add.graphics();
    const rng = seeded(shirtColor + hairColor);

    const skin = 0xf0c8a0;
    const skinShadow = 0xd8b088;
    const pantsColor = darken(shirtColor, 0.35);
    const pantsShadow = darken(pantsColor, 0.15);
    const shoeColor = 0x3a2a1a;
    const shoeShadow = 0x2a1a0a;
    const shirtHighlight = lighten(shirtColor, 0.15);
    const shirtShadow = darken(shirtColor, 0.15);

    // ── Hair (top of head) ─── y: 2-6
    // Back hair behind head
    for (let x = 8; x < 16; x++) {
      px(g, x, 2, hairColor);
      px(g, x, 3, hairColor);
    }
    // Side hair
    px(g, 7, 3, hairColor);
    px(g, 7, 4, hairColor);
    px(g, 16, 3, hairColor);
    px(g, 16, 4, hairColor);
    // Top hair with highlights
    for (let x = 8; x < 16; x++) {
      px(g, x, 2, lighten(hairColor, 0.1));
    }
    px(g, 9, 1, hairColor);
    px(g, 10, 1, hairColor);
    px(g, 11, 1, hairColor);
    px(g, 12, 1, hairColor);
    px(g, 13, 1, hairColor);
    px(g, 14, 1, lighten(hairColor, 0.08));
    // Hair highlight
    px(g, 10, 2, lighten(hairColor, 0.2));
    px(g, 11, 2, lighten(hairColor, 0.15));

    // ── Head (face) ─── y: 4-9
    // Face oval
    for (let y = 4; y <= 9; y++) {
      let startX = 9;
      let endX = 15;
      if (y === 4 || y === 9) { startX = 10; endX = 14; }
      for (let x = startX; x <= endX; x++) {
        let c = skin;
        if (x === startX) c = skinShadow; // left shadow
        if (y >= 8) c = blend(c, skinShadow, 0.3); // chin shadow
        px(g, x, y, c);
      }
    }

    // Eyes
    px(g, 10, 6, 0x1a1a2e);
    px(g, 13, 6, 0x1a1a2e);
    // Eye whites
    px(g, 10, 5, 0xffffff);
    px(g, 13, 5, 0xffffff);
    // Tiny pupils
    px(g, 10, 6, 0x000000);
    px(g, 13, 6, 0x000000);

    // Mouth
    px(g, 11, 8, 0xd09080);
    px(g, 12, 8, 0xd09080);

    // ── Neck ─── y: 10-11
    px(g, 11, 10, skin);
    px(g, 12, 10, skin);
    px(g, 11, 11, skinShadow);
    px(g, 12, 11, skinShadow);

    // ── Torso (shirt) ─── y: 12-19
    for (let y = 12; y <= 19; y++) {
      let startX = 8;
      let endX = 15;
      if (y === 12) { startX = 10; endX = 13; } // shoulders narrow at top
      if (y === 13) { startX = 9; endX = 14; }
      for (let x = startX; x <= endX; x++) {
        let c = shirtColor;
        // Highlights and shadows
        if (x === startX) c = shirtShadow;
        if (x === startX + 1) c = shirtColor;
        if (x === endX) c = shirtShadow;
        if (y <= 13) c = shirtHighlight;
        // Center crease
        if (x === 12 && y >= 14) c = shirtShadow;
        // Collar
        if (y === 12 && (x === 10 || x === 13)) c = lighten(shirtColor, 0.25);
        px(g, x, y, c);
      }
    }

    // Arms (skin tone extending from sides of torso)
    for (let y = 13; y <= 18; y++) {
      // Left arm
      px(g, 7, y, skin);
      if (y >= 17) px(g, 7, y, skinShadow); // hand shadow
      // Right arm
      px(g, 16, y, skin);
      if (y >= 17) px(g, 16, y, skinShadow);
    }
    // Hands
    px(g, 7, 19, skin);
    px(g, 16, 19, skin);

    // ── Pants ─── y: 20-25
    for (let y = 20; y <= 25; y++) {
      // Left leg
      for (let x = 8; x <= 11; x++) {
        let c = pantsColor;
        if (x === 8) c = pantsShadow;
        if (x === 11 && y >= 22) c = pantsShadow; // inner leg shadow
        px(g, x, y, c);
      }
      // Right leg
      for (let x = 12; x <= 15; x++) {
        let c = pantsColor;
        if (x === 12 && y >= 22) c = pantsShadow; // inner leg shadow
        if (x === 15) c = pantsShadow;
        px(g, x, y, c);
      }
    }

    // Belt line
    for (let x = 8; x <= 15; x++) {
      px(g, x, 20, darken(pantsColor, 0.2));
    }

    // ── Shoes ─── y: 26-29
    for (let y = 26; y <= 29; y++) {
      // Left shoe
      for (let x = 7; x <= 11; x++) {
        let c = shoeColor;
        if (y === 26) c = lighten(c, 0.15); // top highlight
        if (y === 29 && x <= 8) c = shoeShadow; // sole
        if (x === 7) c = shoeShadow;
        px(g, x, y, c);
      }
      // Right shoe
      for (let x = 12; x <= 16; x++) {
        let c = shoeColor;
        if (y === 26) c = lighten(c, 0.15);
        if (y === 29 && x >= 15) c = shoeShadow;
        if (x === 16) c = shoeShadow;
        px(g, x, y, c);
      }
    }

    // Shoe detail: lace dots
    px(g, 9, 27, lighten(shoeColor, 0.3));
    px(g, 14, 27, lighten(shoeColor, 0.3));

    g.generateTexture(key, W, H);
    g.destroy();

    // ── Walking frame (slight leg offset) ───
    const g2 = this.add.graphics();
    const rng2 = seeded(shirtColor + hairColor + 1);

    // Copy everything the same except legs and shoes
    // Hair
    for (let x = 8; x < 16; x++) {
      px(g2, x, 2, hairColor);
      px(g2, x, 3, hairColor);
    }
    px(g2, 7, 3, hairColor);
    px(g2, 7, 4, hairColor);
    px(g2, 16, 3, hairColor);
    px(g2, 16, 4, hairColor);
    for (let x = 8; x < 16; x++) px(g2, x, 2, lighten(hairColor, 0.1));
    px(g2, 9, 1, hairColor);
    px(g2, 10, 1, hairColor);
    px(g2, 11, 1, hairColor);
    px(g2, 12, 1, hairColor);
    px(g2, 13, 1, hairColor);
    px(g2, 14, 1, lighten(hairColor, 0.08));
    px(g2, 10, 2, lighten(hairColor, 0.2));
    px(g2, 11, 2, lighten(hairColor, 0.15));

    // Head
    for (let y = 4; y <= 9; y++) {
      let startX = 9;
      let endX = 15;
      if (y === 4 || y === 9) { startX = 10; endX = 14; }
      for (let x = startX; x <= endX; x++) {
        let c = skin;
        if (x === startX) c = skinShadow;
        if (y >= 8) c = blend(c, skinShadow, 0.3);
        px(g2, x, y, c);
      }
    }
    px(g2, 10, 6, 0x000000);
    px(g2, 13, 6, 0x000000);
    px(g2, 10, 5, 0xffffff);
    px(g2, 13, 5, 0xffffff);
    px(g2, 11, 8, 0xd09080);
    px(g2, 12, 8, 0xd09080);

    // Neck
    px(g2, 11, 10, skin);
    px(g2, 12, 10, skin);
    px(g2, 11, 11, skinShadow);
    px(g2, 12, 11, skinShadow);

    // Torso (same)
    for (let y = 12; y <= 19; y++) {
      let startX = 8;
      let endX = 15;
      if (y === 12) { startX = 10; endX = 13; }
      if (y === 13) { startX = 9; endX = 14; }
      for (let x = startX; x <= endX; x++) {
        let c = shirtColor;
        if (x === startX) c = shirtShadow;
        if (x === endX) c = shirtShadow;
        if (y <= 13) c = shirtHighlight;
        if (x === 12 && y >= 14) c = shirtShadow;
        if (y === 12 && (x === 10 || x === 13)) c = lighten(shirtColor, 0.25);
        px(g2, x, y, c);
      }
    }

    // Arms swinging (opposite positions)
    for (let y = 13; y <= 18; y++) {
      px(g2, 7, y, skin);
      px(g2, 16, y, skin);
    }
    px(g2, 7, 19, skin);
    px(g2, 16, 19, skin);

    // Walking legs: left leg forward, right leg back
    for (let y = 20; y <= 25; y++) {
      // Left leg (forward = shifted left by 1)
      for (let x = 7; x <= 10; x++) {
        let c = pantsColor;
        if (x === 7) c = pantsShadow;
        px(g2, x, y, c);
      }
      // Right leg (back = shifted right by 1)
      for (let x = 13; x <= 16; x++) {
        let c = pantsColor;
        if (x === 16) c = pantsShadow;
        px(g2, x, y, c);
      }
    }
    // Belt
    for (let x = 7; x <= 16; x++) {
      if (x >= 7 && x <= 10) px(g2, x, 20, darken(pantsColor, 0.2));
      if (x >= 13 && x <= 16) px(g2, x, 20, darken(pantsColor, 0.2));
    }

    // Walking shoes
    for (let y = 26; y <= 29; y++) {
      // Left shoe (forward)
      for (let x = 6; x <= 10; x++) {
        let c = shoeColor;
        if (y === 26) c = lighten(c, 0.15);
        if (x === 6) c = shoeShadow;
        px(g2, x, y, c);
      }
      // Right shoe (back)
      for (let x = 13; x <= 17; x++) {
        let c = shoeColor;
        if (y === 26) c = lighten(c, 0.15);
        if (x === 17) c = shoeShadow;
        px(g2, x, y, c);
      }
    }

    g2.generateTexture(`${key}_walk`, W, H);
    g2.destroy();
  }

  // ═══════════════════════════════════════════════════════════
  // UI TEXTURES
  // ═══════════════════════════════════════════════════════════
  private generateUITextures(): void {
    // Selection ring
    const g = this.add.graphics();
    g.lineStyle(2, 0xffd700, 0.9);
    g.strokeEllipse(16, 16, 28, 14);
    g.generateTexture('ui_selection_ring', 32, 32);
    g.destroy();
  }
}
