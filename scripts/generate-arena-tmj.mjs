#!/usr/bin/env node
/**
 * generate-arena-tmj.mjs
 *
 * Generates a valid Tiled JSON (.tmj) file for the arena map.
 * Duplicates the seeded PRNG and map generation algorithm from arena-map.ts,
 * maps terrain types to tileset GIDs via arena-tiles.ts config,
 * and writes the result to packages/client/public/tilesets/arena-map.tmj.
 *
 * Usage: node scripts/generate-arena-tmj.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(__dirname, '..', 'packages', 'client', 'public', 'tilesets', 'arena-map.tmj');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ARENA_MAP_WIDTH = 96;
const ARENA_MAP_HEIGHT = 96;

// Tileset firstgid offsets
const FIRSTGID = {
  ts_ground: 1,
  ts_sand: 4561,
  ts_road: 7441,
};

// Terrain type → tile config (sheet + local frame indices)
const TILE_CONFIG = {
  0: { sheet: 'ts_sand',   frames: [341, 821, 1781] },
  1: { sheet: 'ts_sand',   frames: [50, 384, 385, 386, 387, 388, 389, 432, 433, 434] },
  2: { sheet: 'ts_ground', frames: [50, 56, 62, 384, 385, 386, 387, 388, 389, 432, 433, 434, 435, 436, 437] },
  3: { sheet: 'ts_ground', frames: [1394, 1400, 1728, 1729, 1730, 1731, 1732, 1733, 1776, 1777, 1778, 1779, 1780, 1781] },
  4: { sheet: 'ts_ground', frames: [2066, 2072, 2078, 2400, 2401, 2402, 2403, 2404, 2405, 2448, 2449, 2450, 2451, 2452, 2453] },
  5: { sheet: 'ts_road',   frames: [524, 648, 649, 650, 651, 652, 653, 666, 667, 668, 669, 670, 671] },
  6: { sheet: 'ts_sand',   frames: [341, 821, 1781] },
  7: { sheet: 'ts_road',   frames: [272, 396, 397, 398, 399, 400, 401, 414, 415, 416, 417, 418, 419] },
  8: { sheet: 'ts_ground', frames: [1394, 1400, 1728, 1729, 1730, 1731] },
  9: { sheet: 'ts_ground', frames: [347, 1394, 1400] },
};

// Fallback GID for unknown terrain types (WATER: frame 341 on ts_sand)
const FALLBACK_GID = 341 + FIRSTGID.ts_sand; // 4902

// ---------------------------------------------------------------------------
// Seeded PRNG (exact copy from arena-map.ts)
// ---------------------------------------------------------------------------

function seededRng(seed) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s & 0x7fffffff) / 0x7fffffff;
  };
}

// ---------------------------------------------------------------------------
// Map generation (exact copy from arena-map.ts)
// ---------------------------------------------------------------------------

function generateArenaTilemap() {
  const W = ARENA_MAP_WIDTH;
  const H = ARENA_MAP_HEIGHT;
  const rng = seededRng(42);
  const map = Array.from({ length: H }, () => Array(W).fill(0));

  const CX = 48, CY = 48;
  const BASE_RADIUS = 40;

  const angleNoise = [];
  for (let i = 0; i < 360; i++) {
    angleNoise.push((rng() - 0.5) * 8);
  }

  // Step 1: Island shape
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - CX;
      const dy = y - CY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx);
      const angleDeg = ((angle * 180 / Math.PI) + 360) % 360;
      const idx = Math.floor(angleDeg) % 360;
      const idx2 = (idx + 1) % 360;
      const frac = angleDeg - Math.floor(angleDeg);
      const noise = angleNoise[idx] * (1 - frac) + angleNoise[idx2] * frac;
      const edgeRadius = BASE_RADIUS + noise;

      if (dist < edgeRadius - 3) {
        map[y][x] = 2; // OPEN
      } else if (dist < edgeRadius) {
        map[y][x] = 1; // SAND
      }
    }
  }

  // Step 2: Jungle zones
  const jungleZones = [
    { cx: 30, cy: 45, rx: 14, ry: 10 },
    { cx: 55, cy: 50, rx: 12, ry: 8 },
    { cx: 40, cy: 60, rx: 18, ry: 10 },
    { cx: 25, cy: 55, rx: 10, ry: 8 },
    { cx: 60, cy: 40, rx: 8, ry: 6 },
  ];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (map[y][x] !== 2) continue;
      for (const zone of jungleZones) {
        const ddx = (x - zone.cx) / zone.rx;
        const ddy = (y - zone.cy) / zone.ry;
        if (ddx * ddx + ddy * ddy < 1.0) {
          map[y][x] = 3; // JUNGLE
          break;
        }
      }
    }
  }

  // Step 3: Named location terrain
  const areas = [
    { x: 44, y: 22, w: 8, h: 8, terrain: 'high_ground' },
    { x: 40, y: 8, w: 10, h: 6, terrain: 'high_ground' },
    { x: 12, y: 16, w: 8, h: 8, terrain: 'high_ground' },
    { x: 68, y: 20, w: 10, h: 8, terrain: 'wall' },
    { x: 6, y: 40, w: 10, h: 8, terrain: 'open' },
    { x: 16, y: 40, w: 12, h: 10, terrain: 'bush' },
    { x: 40, y: 40, w: 10, h: 8, terrain: 'open' },
    { x: 46, y: 32, w: 6, h: 6, terrain: 'open' },
    { x: 56, y: 16, w: 8, h: 6, terrain: 'open' },
    { x: 64, y: 54, w: 12, h: 10, terrain: 'water' },
    { x: 38, y: 66, w: 14, h: 10, terrain: 'mangrove' },
    { x: 16, y: 58, w: 10, h: 8, terrain: 'cave' },
  ];

  for (const area of areas) {
    let tileType;
    switch (area.terrain) {
      case 'high_ground': tileType = 4; break;
      case 'bush':        tileType = 3; break;
      case 'water':       tileType = 6; break;
      case 'wall':        tileType = 2; break;
      case 'open':        tileType = 2; break;
      case 'mangrove':    tileType = 8; break;
      case 'cave':        tileType = 9; break;
      default:            tileType = 2;
    }
    for (let y = area.y; y < area.y + area.h; y++) {
      for (let x = area.x; x < area.x + area.w; x++) {
        if (x >= 0 && x < W && y >= 0 && y < H && map[y][x] !== 0) {
          map[y][x] = tileType;
        }
      }
    }
  }

  // Step 4: Ruins walls
  const ruins = areas[3];
  for (let y = ruins.y; y < ruins.y + ruins.h; y++) {
    for (let x = ruins.x; x < ruins.x + ruins.w; x++) {
      if (x >= 0 && x < W && y >= 0 && y < H) {
        const isEdge = x === ruins.x || x === ruins.x + ruins.w - 1 ||
                       y === ruins.y || y === ruins.y + ruins.h - 1;
        const isInteriorWall = (x === ruins.x + 4 && y >= ruins.y + 1 && y <= ruins.y + 5) ||
                               (y === ruins.y + 4 && x >= ruins.x + 1 && x <= ruins.x + 3);
        if (isEdge || isInteriorWall) {
          map[y][x] = 5; // WALL
        } else {
          map[y][x] = 7; // RUIN_FLOOR
        }
      }
    }
  }
  // Doorways
  const ruinsDoors = [
    [ruins.x, ruins.y + 2],
    [ruins.x + ruins.w - 1, ruins.y + 2],
    [ruins.x + 4, ruins.y + 6],
    [ruins.x + 5, ruins.y],
  ];
  for (const [dx, dy] of ruinsDoors) {
    if (dx >= 0 && dx < W && dy >= 0 && dy < H) {
      map[dy][dx] = 7; // RUIN_FLOOR doorways
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// Terrain type → GID conversion
// ---------------------------------------------------------------------------

function terrainToGid(tileType, x, y) {
  const config = TILE_CONFIG[tileType];
  if (!config) return FALLBACK_GID;

  const variantIndex = (x * 7 + y * 13) % config.frames.length;
  const localFrame = config.frames[variantIndex];
  return localFrame + FIRSTGID[config.sheet];
}

// ---------------------------------------------------------------------------
// TMJ generation
// ---------------------------------------------------------------------------

function buildTmj(map) {
  const W = ARENA_MAP_WIDTH;
  const H = ARENA_MAP_HEIGHT;

  // Build row-major GID data array (y then x)
  const data = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      data.push(terrainToGid(map[y][x], x, y));
    }
  }

  return {
    compressionlevel: -1,
    height: H,
    infinite: false,
    layers: [
      {
        data,
        height: H,
        id: 1,
        name: 'Ground',
        opacity: 1,
        type: 'tilelayer',
        visible: true,
        width: W,
        x: 0,
        y: 0,
      },
    ],
    nextlayerid: 2,
    nextobjectid: 1,
    orientation: 'orthogonal',
    renderorder: 'right-down',
    tiledversion: '1.11.2',
    tileheight: 16,
    tilesets: [
      {
        columns: 48,
        firstgid: 1,
        image: 'Tileset_Ground.png',
        imageheight: 1520,
        imagewidth: 768,
        margin: 0,
        name: 'Tileset_Ground',
        spacing: 0,
        tilecount: 4560,
        tileheight: 16,
        tilewidth: 16,
      },
      {
        columns: 48,
        firstgid: 4561,
        image: 'Tileset_Sand.png',
        imageheight: 960,
        imagewidth: 768,
        margin: 0,
        name: 'Tileset_Sand',
        spacing: 0,
        tilecount: 2880,
        tileheight: 16,
        tilewidth: 16,
      },
      {
        columns: 18,
        firstgid: 7441,
        image: 'Tileset_Road.png',
        imageheight: 896,
        imagewidth: 288,
        margin: 0,
        name: 'Tileset_Road',
        spacing: 0,
        tilecount: 1008,
        tileheight: 16,
        tilewidth: 16,
      },
    ],
    tilewidth: 16,
    type: 'map',
    version: '1.10',
    width: W,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log('Generating arena tilemap...');

  const map = generateArenaTilemap();

  // Count terrain types
  const counts = {};
  const terrainNames = {
    0: 'WATER (ocean)',
    1: 'SAND',
    2: 'OPEN',
    3: 'JUNGLE',
    4: 'HIGH_GROUND',
    5: 'WALL',
    6: 'SHALLOW_WATER',
    7: 'RUIN_FLOOR',
    8: 'MANGROVE',
    9: 'CAVE',
  };

  for (let y = 0; y < ARENA_MAP_HEIGHT; y++) {
    for (let x = 0; x < ARENA_MAP_WIDTH; x++) {
      const t = map[y][x];
      counts[t] = (counts[t] || 0) + 1;
    }
  }

  console.log('\nTerrain type counts:');
  for (const [type, count] of Object.entries(counts).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const name = terrainNames[type] || `UNKNOWN(${type})`;
    const pct = ((count / (ARENA_MAP_WIDTH * ARENA_MAP_HEIGHT)) * 100).toFixed(1);
    console.log(`  ${name.padEnd(20)} ${String(count).padStart(5)} tiles  (${pct}%)`);
  }

  const tmj = buildTmj(map);
  const json = JSON.stringify(tmj);

  // Ensure output directory exists
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, json, 'utf-8');

  console.log(`\nWrote ${OUTPUT_PATH}`);
  console.log(`  Total tiles: ${tmj.layers[0].data.length}`);
  console.log(`  File size: ${(Buffer.byteLength(json) / 1024).toFixed(1)} KB`);
}

main();
