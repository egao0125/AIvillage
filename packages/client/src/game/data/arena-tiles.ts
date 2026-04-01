/**
 * Arena tile configuration — maps terrain types to Fan-tasy Tileset spritesheet frames.
 *
 * Each terrain type specifies which spritesheet key to use and which frame indices
 * are valid "fill" tiles (solid interior, no edge pieces). The variant system
 * picks among these frames deterministically per grid position.
 *
 * Frame indices are 0-based local IDs within each spritesheet (16x16 tiles).
 * Tiles are rendered at 2x scale (32px display) to match the existing TILE_SIZE.
 */
import { ARENA_TILE_TYPES } from './arena-map';

// Spritesheet keys (must match keys used in BootScene.preload)
export const TS_GROUND = 'ts_ground';  // Tileset_Ground.png — 48 cols
export const TS_SAND   = 'ts_sand';    // Tileset_Sand.png   — 48 cols
export const TS_ROAD   = 'ts_road';    // Tileset_Road.png   — 18 cols

export interface TileConfig {
  sheet: string;
  frames: number[];
  tint?: number; // optional Phaser tint (0xRRGGBB)
}

/**
 * Fill tile frame indices per terrain type.
 *
 * Source: Wang tile analysis of Fan-tasy Premium TSX files.
 * - Grass fills: Ground local 50,56,62 + probability variants 384-389, 432-437
 * - Dark Grass: Ground local 1394,1400 + variants 1728-1733, 1776-1781
 * - Light Grass: Ground local 722,728,734 + variants 1056-1061, 1104-1109
 * - Winter Grass: Ground local 2066,2072,2078 + variants 2400-2405, 2448-2453
 * - Dirt: Ground local 347
 * - Sand fills: Sand local 50 + variants 384-389, 432-434
 * - Sea fills: Sand local 341, 821, 1781
 * - Road fills: Road local 20 + variants 144-146, 162-164
 * - Brick Road fills: Road local 272 + variants 396-401, 414-419
 * - Dark Brick fills: Road local 524 + variants 648-653, 666-671
 */
export const ARENA_TILE_CONFIG: Record<number, TileConfig> = {
  // Deep ocean — dark dangerous water
  [ARENA_TILE_TYPES.WATER]: {
    sheet: TS_SAND,
    frames: [341, 821, 1781],
    tint: 0x88aacc, // darken water slightly for deep ocean feel
  },

  // Shallow lagoon water — lighter, can see bottom
  [ARENA_TILE_TYPES.SHALLOW_WATER]: {
    sheet: TS_SAND,
    frames: [341, 821, 1781],
    // no tint — natural light blue
  },

  // Beach sand
  [ARENA_TILE_TYPES.SAND]: {
    sheet: TS_SAND,
    frames: [50, 384, 385, 386, 387, 388, 389, 432, 433, 434],
  },

  // Open ground / clearings — standard bright grass
  [ARENA_TILE_TYPES.OPEN]: {
    sheet: TS_GROUND,
    frames: [50, 56, 62, 384, 385, 386, 387, 388, 389, 432, 433, 434, 435, 436, 437],
  },

  // Dense jungle — dark deep green
  [ARENA_TILE_TYPES.JUNGLE]: {
    sheet: TS_GROUND,
    frames: [1394, 1400, 1728, 1729, 1730, 1731, 1732, 1733, 1776, 1777, 1778, 1779, 1780, 1781],
  },

  // High ground / rocky elevation — winter grass (gray-green, muted)
  [ARENA_TILE_TYPES.HIGH_GROUND]: {
    sheet: TS_GROUND,
    frames: [2066, 2072, 2078, 2400, 2401, 2402, 2403, 2404, 2405, 2448, 2449, 2450, 2451, 2452, 2453],
  },

  // Ruin walls — dark brick road pattern (weathered stone)
  [ARENA_TILE_TYPES.WALL]: {
    sheet: TS_ROAD,
    frames: [524, 648, 649, 650, 651, 652, 653, 666, 667, 668, 669, 670, 671],
  },

  // Ruin floor — brick road pattern
  [ARENA_TILE_TYPES.RUIN_FLOOR]: {
    sheet: TS_ROAD,
    frames: [272, 396, 397, 398, 399, 400, 401, 414, 415, 416, 417, 418, 419],
  },

  // Mangrove — dark grass tinted teal (half-water, half-foliage)
  [ARENA_TILE_TYPES.MANGROVE]: {
    sheet: TS_GROUND,
    frames: [1394, 1400, 1728, 1729, 1730, 1731],
    tint: 0x88ccbb, // teal-green tint for swampy water feel
  },

  // Cave interior — dirt tinted very dark
  [ARENA_TILE_TYPES.CAVE]: {
    sheet: TS_GROUND,
    frames: [347, 1394, 1400],
    tint: 0x444455, // near-black with slight blue
  },
};

/**
 * Get the spritesheet key and frame index for a tile at position (x, y).
 * Uses deterministic variant selection based on grid position.
 */
export function getArenaTileConfig(tileType: number, x: number, y: number): { sheet: string; frame: number; tint?: number } {
  const config = ARENA_TILE_CONFIG[tileType];
  if (!config) {
    // Fallback to ocean
    return { sheet: TS_SAND, frame: 341, tint: 0x88aacc };
  }
  const variant = (x * 7 + y * 13) % config.frames.length;
  return {
    sheet: config.sheet,
    frame: config.frames[variant],
    tint: config.tint,
  };
}
