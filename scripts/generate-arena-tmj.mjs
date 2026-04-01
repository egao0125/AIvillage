#!/usr/bin/env node
/**
 * generate-arena-tmj.mjs
 *
 * Generates a Tiled JSON (.tmj) for the arena map with:
 *   - Ground layer: terrain + roads (sandy paths) + building floors
 *   - Vegetation layer: dense trees, bushes, palms, shrubs
 *   - Structures layer: building walls (stone tiles) + rocks
 *
 * Roads connect named locations. Buildings are constructed from wall/floor
 * tiles in the Road tileset (visible interiors, no building PNGs).
 *
 * Usage: node scripts/generate-arena-tmj.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(__dirname, '..', 'packages', 'client', 'public', 'tilesets', 'arena-map.tmj');
const STAMPS_PATH = resolve(__dirname, 'stamps.json');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const W = 96;
const H = 96;

const FIRSTGID = {
  ts_ground: 1,       // 4560 tiles (48 cols × 95 rows)
  ts_sand: 4561,      // 2880 tiles (48 cols × 60 rows)
  ts_road: 7441,      // 1008 tiles (18 cols × 56 rows)
  trees: 8449,        // 6880 tiles (80 cols × 86 rows)
  rocks: 15329,       // 3024 tiles (63 cols × 48 rows)
  shadows: 18353,     // 48 tiles (6 cols × 8 rows)
};

// Terrain types
const WATER = 0, SAND = 1, OPEN = 2, JUNGLE = 3, HIGH_GROUND = 4;
const WALL = 5, SHALLOW_WATER = 6, RUIN_FLOOR = 7, MANGROVE = 8, CAVE = 9;

// Ground terrain → GID mapping
const TILE_CONFIG = {
  [WATER]:          { sheet: 'ts_sand',   frames: [341, 821, 1781] },
  [SAND]:           { sheet: 'ts_sand',   frames: [50, 384, 385, 386, 387, 388, 389, 432, 433, 434] },
  [OPEN]:           { sheet: 'ts_ground', frames: [50, 56, 62, 384, 385, 386, 387, 388, 389, 432, 433, 434, 435, 436, 437] },
  [JUNGLE]:         { sheet: 'ts_ground', frames: [1394, 1400, 1728, 1729, 1730, 1731, 1732, 1733, 1776, 1777, 1778, 1779, 1780, 1781] },
  [HIGH_GROUND]:    { sheet: 'ts_ground', frames: [2066, 2072, 2078, 2400, 2401, 2402, 2403, 2404, 2405, 2448, 2449, 2450, 2451, 2452, 2453] },
  [WALL]:           { sheet: 'ts_road',   frames: [524, 648, 649, 650, 651, 652, 653, 666, 667, 668, 669, 670, 671] },
  [SHALLOW_WATER]:  { sheet: 'ts_sand',   frames: [341, 821, 1781] },
  [RUIN_FLOOR]:     { sheet: 'ts_road',   frames: [272, 396, 397, 398, 399, 400, 401, 414, 415, 416, 417, 418, 419] },
  [MANGROVE]:       { sheet: 'ts_ground', frames: [1394, 1400, 1728, 1729, 1730, 1731] },
  [CAVE]:           { sheet: 'ts_ground', frames: [347, 1394, 1400] },
};

// Road/building tile GIDs (from Road tileset analysis)
const ROAD_FILL_FRAMES = [20, 73, 144, 145, 146, 162, 163, 164]; // sandy solid fill
const FLOOR_FRAMES = [396, 397, 398, 399, 400, 401, 414, 415, 416, 417, 418, 419]; // light stone
const WALL_FRAMES = [648, 649, 650, 651, 652, 653, 666, 667, 668, 669, 670, 671]; // dark stone

const ROAD_GIDS = ROAD_FILL_FRAMES.map(f => f + FIRSTGID.ts_road);
const FLOOR_GIDS = FLOOR_FRAMES.map(f => f + FIRSTGID.ts_road);
const WALL_GIDS = WALL_FRAMES.map(f => f + FIRSTGID.ts_road);

const FALLBACK_GID = 341 + FIRSTGID.ts_sand;

// ---------------------------------------------------------------------------
// Named locations (centers)
// ---------------------------------------------------------------------------

const LOCATIONS = {
  mountain_peak:    { cx: 48, cy: 26 },
  northern_plateau: { cx: 45, cy: 11 },
  western_heights:  { cx: 16, cy: 20 },
  ancient_ruins:    { cx: 73, cy: 24 },
  open_field:       { cx: 11, cy: 44 },
  dense_thicket:    { cx: 22, cy: 45 },
  central_plains:   { cx: 45, cy: 44 },
  high_clearing:    { cx: 49, cy: 35 },
  northern_meadow:  { cx: 60, cy: 19 },
  lagoon:           { cx: 70, cy: 59 },
  mangrove_swamp:   { cx: 45, cy: 71 },
  hidden_cave:      { cx: 21, cy: 62 },
};

// Road network — pairs of location keys to connect
const ROAD_CONNECTIONS = [
  ['central_plains', 'mountain_peak'],
  ['central_plains', 'high_clearing'],
  ['central_plains', 'open_field'],
  ['central_plains', 'lagoon'],
  ['mountain_peak', 'northern_plateau'],
  ['mountain_peak', 'ancient_ruins'],
  ['mountain_peak', 'northern_meadow'],
  ['open_field', 'western_heights'],
  ['open_field', 'dense_thicket'],
  ['dense_thicket', 'hidden_cave'],
  ['hidden_cave', 'mangrove_swamp'],
  ['high_clearing', 'northern_meadow'],
];

// Building definitions — tile-built with wall perimeter + floor interior
const BUILDINGS = [
  // Large central buildings
  { x: 41, y: 40, w: 10, h: 8, door: { side: 'south', offset: 4 }, name: 'Market Hall' },
  { x: 44, y: 22, w: 8, h: 6, door: { side: 'south', offset: 3 }, name: 'Mountain Fortress' },
  { x: 45, y: 10, w: 5, h: 5, door: { side: 'south', offset: 2 }, name: 'Plateau Outpost' },
  // Medium buildings at viable inland spots
  { x: 11, y: 39, w: 5, h: 5, door: { side: 'east', offset: 2 }, name: 'Field House' },
  { x: 57, y: 17, w: 6, h: 5, door: { side: 'south', offset: 2 }, name: 'Meadow Cottage' },
  { x: 46, y: 32, w: 6, h: 5, door: { side: 'south', offset: 2 }, name: 'Clearing Lodge' },
  { x: 20, y: 43, w: 5, h: 5, door: { side: 'east', offset: 2 }, name: 'Thicket Camp' },
  { x: 67, y: 56, w: 6, h: 5, door: { side: 'west', offset: 2 }, name: 'Lagoon Dock' },
  { x: 20, y: 60, w: 5, h: 5, door: { side: 'south', offset: 2 }, name: 'Cave Shelter' },
  // Additional inland buildings for richness
  { x: 36, y: 32, w: 5, h: 5, door: { side: 'south', offset: 2 }, name: 'Traveler Inn' },
  { x: 52, y: 44, w: 6, h: 5, door: { side: 'west', offset: 2 }, name: 'Eastern Post' },
  { x: 32, y: 50, w: 5, h: 5, door: { side: 'north', offset: 2 }, name: 'Jungle Outpost' },
  { x: 55, y: 30, w: 5, h: 4, door: { side: 'south', offset: 2 }, name: 'Hilltop Hut' },
  { x: 30, y: 38, w: 5, h: 4, door: { side: 'east', offset: 1 }, name: 'Forest Cabin' },
  // Ruins interior chambers
  { x: 70, y: 22, w: 4, h: 4, door: { side: 'south', offset: 1 }, name: 'Ruins Chamber A' },
  { x: 74, y: 22, w: 3, h: 4, door: { side: 'west', offset: 1 }, name: 'Ruins Chamber B' },
];

// ---------------------------------------------------------------------------
// Seeded PRNG
// ---------------------------------------------------------------------------

function seededRng(seed) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s & 0x7fffffff) / 0x7fffffff;
  };
}

// ---------------------------------------------------------------------------
// Map generation (exact copy from arena-map.ts, seed=42)
// ---------------------------------------------------------------------------

function generateArenaTilemap() {
  const rng = seededRng(42);
  const map = Array.from({ length: H }, () => Array(W).fill(WATER));

  const CX = 48, CY = 48, BASE_RADIUS = 40;
  const angleNoise = [];
  for (let i = 0; i < 360; i++) angleNoise.push((rng() - 0.5) * 8);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - CX, dy = y - CY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx);
      const angleDeg = ((angle * 180 / Math.PI) + 360) % 360;
      const idx = Math.floor(angleDeg) % 360;
      const frac = angleDeg - Math.floor(angleDeg);
      const noise = angleNoise[idx] * (1 - frac) + angleNoise[(idx + 1) % 360] * frac;
      const edgeRadius = BASE_RADIUS + noise;
      if (dist < edgeRadius - 3) map[y][x] = OPEN;
      else if (dist < edgeRadius) map[y][x] = SAND;
    }
  }

  const jungleZones = [
    { cx: 30, cy: 45, rx: 14, ry: 10 },
    { cx: 55, cy: 50, rx: 12, ry: 8 },
    { cx: 40, cy: 60, rx: 18, ry: 10 },
    { cx: 25, cy: 55, rx: 10, ry: 8 },
    { cx: 60, cy: 40, rx: 8, ry: 6 },
  ];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (map[y][x] !== OPEN) continue;
      for (const zone of jungleZones) {
        const ddx = (x - zone.cx) / zone.rx, ddy = (y - zone.cy) / zone.ry;
        if (ddx * ddx + ddy * ddy < 1.0) { map[y][x] = JUNGLE; break; }
      }
    }
  }

  const areas = [
    { x: 44, y: 22, w: 8, h: 8, terrain: HIGH_GROUND },
    { x: 40, y: 8, w: 10, h: 6, terrain: HIGH_GROUND },
    { x: 12, y: 16, w: 8, h: 8, terrain: HIGH_GROUND },
    { x: 68, y: 20, w: 10, h: 8, terrain: OPEN },
    { x: 6, y: 40, w: 10, h: 8, terrain: OPEN },
    { x: 16, y: 40, w: 12, h: 10, terrain: JUNGLE },
    { x: 40, y: 40, w: 10, h: 8, terrain: OPEN },
    { x: 46, y: 32, w: 6, h: 6, terrain: OPEN },
    { x: 56, y: 16, w: 8, h: 6, terrain: OPEN },
    { x: 64, y: 54, w: 12, h: 10, terrain: SHALLOW_WATER },
    { x: 38, y: 66, w: 14, h: 10, terrain: MANGROVE },
    { x: 16, y: 58, w: 10, h: 8, terrain: CAVE },
  ];
  for (const area of areas) {
    for (let y = area.y; y < area.y + area.h; y++) {
      for (let x = area.x; x < area.x + area.w; x++) {
        if (x >= 0 && x < W && y >= 0 && y < H && map[y][x] !== WATER)
          map[y][x] = area.terrain;
      }
    }
  }

  // Ruins walls
  const ruins = { x: 68, y: 20, w: 10, h: 8 };
  for (let y = ruins.y; y < ruins.y + ruins.h; y++) {
    for (let x = ruins.x; x < ruins.x + ruins.w; x++) {
      if (x >= 0 && x < W && y >= 0 && y < H) {
        const isEdge = x === ruins.x || x === ruins.x + ruins.w - 1 ||
                       y === ruins.y || y === ruins.y + ruins.h - 1;
        const isInteriorWall = (x === ruins.x + 4 && y >= ruins.y + 1 && y <= ruins.y + 5) ||
                               (y === ruins.y + 4 && x >= ruins.x + 1 && x <= ruins.x + 3);
        map[y][x] = (isEdge || isInteriorWall) ? WALL : RUIN_FLOOR;
      }
    }
  }
  const doors = [[ruins.x, ruins.y + 2], [ruins.x + ruins.w - 1, ruins.y + 2],
                  [ruins.x + 4, ruins.y + 6], [ruins.x + 5, ruins.y]];
  for (const [dx, dy] of doors) {
    if (dx >= 0 && dx < W && dy >= 0 && dy < H) map[dy][dx] = RUIN_FLOOR;
  }

  return map;
}

// ---------------------------------------------------------------------------
// Helper: pick GID with deterministic variant
// ---------------------------------------------------------------------------

function pickGid(gids, x, y) {
  return gids[(x * 7 + y * 13) % gids.length];
}

function terrainToGid(tileType, x, y) {
  const config = TILE_CONFIG[tileType];
  if (!config) return FALLBACK_GID;
  return config.frames[(x * 7 + y * 13) % config.frames.length] + FIRSTGID[config.sheet];
}

// ---------------------------------------------------------------------------
// Road drawing
// ---------------------------------------------------------------------------

function drawRoads(groundData, map) {
  // Mark which cells are roads
  const isRoad = Array.from({ length: H }, () => Array(W).fill(false));
  let roadCount = 0;

  for (const [keyA, keyB] of ROAD_CONNECTIONS) {
    const a = LOCATIONS[keyA];
    const b = LOCATIONS[keyB];
    if (!a || !b) continue;

    // Draw L-shaped path (horizontal then vertical), 3 tiles wide
    const x0 = a.cx, y0 = a.cy, x1 = b.cx, y1 = b.cy;

    // Horizontal segment
    const xMin = Math.min(x0, x1), xMax = Math.max(x0, x1);
    for (let x = xMin; x <= xMax; x++) {
      for (let dy = -1; dy <= 1; dy++) {
        const y = y0 + dy;
        if (y >= 0 && y < H && x >= 0 && x < W) {
          if (map[y][x] !== WATER && map[y][x] !== SHALLOW_WATER) {
            isRoad[y][x] = true;
          }
        }
      }
    }

    // Vertical segment
    const yMin = Math.min(y0, y1), yMax = Math.max(y0, y1);
    for (let y = yMin; y <= yMax; y++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = x1 + dx;
        if (y >= 0 && y < H && x >= 0 && x < W) {
          if (map[y][x] !== WATER && map[y][x] !== SHALLOW_WATER) {
            isRoad[y][x] = true;
          }
        }
      }
    }
  }

  // Write road GIDs to ground data
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (isRoad[y][x]) {
        groundData[y * W + x] = pickGid(ROAD_GIDS, x, y);
        roadCount++;
      }
    }
  }

  console.log(`  Roads: ${roadCount} tiles`);
  return isRoad;
}

// ---------------------------------------------------------------------------
// Building construction (wall + floor tiles)
// ---------------------------------------------------------------------------

function drawBuildings(groundData, structData, map, isRoad, occupied) {
  let floorCount = 0, wallCount = 0;

  for (const bldg of BUILDINGS) {
    // Check building fits on land
    let onLand = true;
    for (let r = 0; r < bldg.h && onLand; r++) {
      for (let c = 0; c < bldg.w && onLand; c++) {
        const mx = bldg.x + c, my = bldg.y + r;
        if (mx < 0 || mx >= W || my < 0 || my >= H) { onLand = false; break; }
        if (map[my][mx] === WATER) { onLand = false; break; }
      }
    }
    if (!onLand) {
      console.warn(`  Warning: ${bldg.name} at (${bldg.x},${bldg.y}) overlaps water — skipped`);
      continue;
    }

    for (let r = 0; r < bldg.h; r++) {
      for (let c = 0; c < bldg.w; c++) {
        const mx = bldg.x + c, my = bldg.y + r;
        if (mx < 0 || mx >= W || my < 0 || my >= H) continue;

        const isEdge = r === 0 || r === bldg.h - 1 || c === 0 || c === bldg.w - 1;

        // Check if this is a door position
        let isDoor = false;
        const door = bldg.door;
        if (door.side === 'south' && r === bldg.h - 1 && (c === door.offset || c === door.offset + 1)) isDoor = true;
        if (door.side === 'north' && r === 0 && (c === door.offset || c === door.offset + 1)) isDoor = true;
        if (door.side === 'east' && c === bldg.w - 1 && (r === door.offset || r === door.offset + 1)) isDoor = true;
        if (door.side === 'west' && c === 0 && (r === door.offset || r === door.offset + 1)) isDoor = true;

        // Floor on ground layer (entire building area)
        groundData[my * W + mx] = pickGid(FLOOR_GIDS, mx, my);
        floorCount++;

        // Walls on structures layer (perimeter except doors)
        if (isEdge && !isDoor) {
          structData[my * W + mx] = pickGid(WALL_GIDS, mx, my);
          wallCount++;
        }

        // Mark as occupied so vegetation doesn't overlap
        occupied[my][mx] = true;
        isRoad[my][mx] = true; // prevent road overwrite
      }
    }
  }

  console.log(`  Buildings: ${floorCount} floor + ${wallCount} wall tiles (${BUILDINGS.length} buildings)`);
}

// ---------------------------------------------------------------------------
// Stamp placement (vegetation + rocks)
// ---------------------------------------------------------------------------

function loadStamps() {
  return JSON.parse(readFileSync(STAMPS_PATH, 'utf-8'));
}

function placeStamp(grid, occupied, stamp, ox, oy, atlas) {
  const firstgid = FIRSTGID[atlas];
  const { ids, w, h } = stamp;

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const mx = ox + c, my = oy + r;
      if (mx < 0 || mx >= W || my < 0 || my >= H) return false;
      if (ids[r][c] !== 0 && occupied[my][mx]) return false;
    }
  }

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const localId = ids[r][c];
      if (localId === 0) continue;
      const mx = ox + c, my = oy + r;
      grid[my][mx] = localId + firstgid;
      occupied[my][mx] = true;
    }
  }
  return true;
}

function buildVegetationLayer(map, stamps, occupied) {
  const grid = Array.from({ length: H }, () => Array(W).fill(0));
  const rng = seededRng(1337);

  const jungleStamps = [
    'deciduous_sm_0', 'deciduous_sm_1', 'deciduous_sm_2',
    'tree_med_0', 'tree_med_1', 'tree_med_2',
    'big_tree_0', 'big_tree_1', 'big_tree_2',
    'deciduous_lg_0', 'deciduous_lg_1', 'deciduous_lg_2',
    'shrub_0', 'shrub_1', 'shrub_2',
    'bush_0', 'bush_1', 'bush_2',
    'pine_0', 'pine_1', 'pine_2',
  ];

  const openStamps = [
    'bush_0', 'bush_1', 'bush_2',
    'shrub_0', 'shrub_1', 'shrub_2',
    'tree_med_0', 'tree_med_1', 'tree_med_2',
    'deciduous_sm_0', 'deciduous_sm_1', 'deciduous_sm_2',
  ];

  const sandStamps = [
    'palm_sm_0', 'palm_sm_1', 'palm_sm_2',
    'palm_0', 'palm_1', 'palm_2',
    'bush_0', 'bush_1', 'bush_2',
  ];

  const mangroveStamps = [
    'bonsai_0', 'bonsai_1', 'bonsai_2',
    'deciduous_sm_0', 'deciduous_sm_1', 'deciduous_sm_2',
    'shrub_0', 'shrub_1', 'shrub_2',
    'bush_0', 'bush_1', 'bush_2',
    'tree_med_0', 'tree_med_1', 'tree_med_2',
  ];

  const caveStamps = [
    'pine_0', 'pine_1', 'pine_2',
    'bush_0', 'bush_1', 'bush_2',
    'shrub_0', 'shrub_1', 'shrub_2',
  ];

  const highGroundStamps = [
    'pine_0', 'pine_1', 'pine_2',
    'bush_0', 'bush_1', 'bush_2',
  ];

  // Giant trees in jungle centers
  const giantSpots = [
    { x: 28, y: 43 }, { x: 53, y: 48 }, { x: 38, y: 58 },
    { x: 23, y: 53 }, { x: 35, y: 65 }, { x: 42, y: 62 },
    { x: 30, y: 50 }, { x: 58, y: 42 },
  ];
  for (const spot of giantSpots) {
    const variant = Math.floor(rng() * 2);
    const stamp = stamps[`giant_tree_${variant}`];
    if (stamp) {
      placeStamp(grid, occupied, stamp, spot.x - 3, spot.y - 4, stamp.atlas);
    }
  }

  // Scan and place vegetation — RICH density
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (occupied[y][x]) continue;
      const terrain = map[y][x];
      let pool, chance;

      switch (terrain) {
        case JUNGLE:    pool = jungleStamps;    chance = 0.25; break;
        case OPEN:      pool = openStamps;      chance = 0.08; break;
        case SAND:      pool = sandStamps;      chance = 0.08; break;
        case MANGROVE:  pool = mangroveStamps;  chance = 0.22; break;
        case CAVE:      pool = caveStamps;      chance = 0.14; break;
        case HIGH_GROUND: pool = highGroundStamps; chance = 0.06; break;
        default: continue;
      }

      if (rng() > chance || !pool) continue;

      const stampName = pool[Math.floor(rng() * pool.length)];
      const stamp = stamps[stampName];
      if (!stamp) continue;

      const ox = x - Math.floor(stamp.w / 2);
      const oy = y - Math.floor(stamp.h / 2);

      // Check compatible terrain
      let ok = true;
      for (let r = 0; r < stamp.h && ok; r++) {
        for (let c = 0; c < stamp.w && ok; c++) {
          if (stamp.ids[r][c] === 0) continue;
          const mx = ox + c, my = oy + r;
          if (mx < 0 || mx >= W || my < 0 || my >= H) { ok = false; break; }
          const t = map[my][mx];
          if (t === WATER || t === WALL || t === SHALLOW_WATER) ok = false;
        }
      }

      if (ok) placeStamp(grid, occupied, stamp, ox, oy, stamp.atlas);
    }
  }

  return grid;
}

function buildRocksLayer(map, stamps, occupied, structData) {
  const rng = seededRng(2023);

  const highRocks = [
    'rock_cluster_0', 'rock_cluster_1', 'rock_cluster_2', 'rock_cluster_3',
    'rock_med_0', 'rock_med_1', 'rock_med_2', 'rock_med_3',
    'rock_tiny_0', 'rock_tiny_1', 'rock_tiny_2', 'rock_tiny_3',
    'standing_stone_0', 'standing_stone_1',
  ];

  const caveRocks = [
    'rock_large_0', 'rock_large_1', 'rock_large_2', 'rock_large_3',
    'standing_stone_0', 'standing_stone_1', 'standing_stone_2', 'standing_stone_3',
    'rock_med_0', 'rock_med_1', 'rock_cluster_0', 'rock_cluster_1',
  ];

  const sandRocks = [
    'rock_tiny_0', 'rock_tiny_1', 'rock_tiny_2', 'rock_tiny_3',
    'rock_med_0', 'rock_med_1',
  ];

  let count = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (occupied[y][x]) continue;
      const terrain = map[y][x];
      let pool, chance;

      switch (terrain) {
        case HIGH_GROUND: pool = highRocks;   chance = 0.08; break;
        case CAVE:        pool = caveRocks;   chance = 0.12; break;
        case SAND:        pool = sandRocks;   chance = 0.03; break;
        case RUIN_FLOOR:  pool = highRocks.slice(4); chance = 0.05; break;
        default: continue;
      }

      if (rng() > chance || !pool) continue;

      const stampName = pool[Math.floor(rng() * pool.length)];
      const stamp = stamps[stampName];
      if (!stamp) continue;

      const ox = x - Math.floor(stamp.w / 2);
      const oy = y - Math.floor(stamp.h / 2);

      let ok = true;
      for (let r = 0; r < stamp.h && ok; r++) {
        for (let c = 0; c < stamp.w && ok; c++) {
          if (stamp.ids[r][c] === 0) continue;
          const mx = ox + c, my = oy + r;
          if (mx < 0 || mx >= W || my < 0 || my >= H) { ok = false; break; }
          const t = map[my][mx];
          if (t === WATER || t === WALL || t === SHALLOW_WATER) ok = false;
          if (occupied[my][mx]) ok = false;
        }
      }

      if (ok) {
        const firstgid = FIRSTGID[stamp.atlas];
        for (let r = 0; r < stamp.h; r++) {
          for (let c = 0; c < stamp.w; c++) {
            const lid = stamp.ids[r][c];
            if (lid === 0) continue;
            const mx = ox + c, my = oy + r;
            structData[my * W + mx] = lid + firstgid;
            occupied[my][mx] = true;
            count++;
          }
        }
      }
    }
  }
  console.log(`  Rocks: ${count} tiles`);
}

// ---------------------------------------------------------------------------
// TMJ assembly
// ---------------------------------------------------------------------------

function buildTmj(map, stamps) {
  // Build ground layer
  const groundData = new Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      groundData[y * W + x] = terrainToGid(map[y][x], x, y);

  // Shared occupied mask
  const occupied = Array.from({ length: H }, () => Array(W).fill(false));
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (map[y][x] === WATER || map[y][x] === SHALLOW_WATER)
        occupied[y][x] = true;

  // Structure layer data (walls + rocks)
  const structData = new Array(W * H).fill(0);

  // 1) Draw roads on ground layer
  const isRoad = drawRoads(groundData, map);

  // Mark road tiles as occupied
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (isRoad[y][x]) occupied[y][x] = true;

  // 2) Draw buildings (floors on ground, walls on structures)
  drawBuildings(groundData, structData, map, isRoad, occupied);

  // 3) Vegetation layer (dense)
  const vegGrid = buildVegetationLayer(map, stamps, occupied);

  // 4) Rocks on structures layer
  buildRocksLayer(map, stamps, occupied, structData);

  const vegData = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      vegData.push(vegGrid[y][x]);

  return {
    compressionlevel: -1,
    height: H,
    infinite: false,
    layers: [
      {
        data: groundData,
        height: H, id: 1, name: 'Ground',
        opacity: 1, type: 'tilelayer', visible: true, width: W, x: 0, y: 0,
      },
      {
        data: vegData,
        height: H, id: 2, name: 'Vegetation',
        opacity: 1, type: 'tilelayer', visible: true, width: W, x: 0, y: 0,
      },
      {
        data: structData,
        height: H, id: 3, name: 'Structures',
        opacity: 1, type: 'tilelayer', visible: true, width: W, x: 0, y: 0,
      },
    ],
    nextlayerid: 4,
    nextobjectid: 1,
    orientation: 'orthogonal',
    renderorder: 'right-down',
    tiledversion: '1.11.2',
    tileheight: 16,
    tilesets: [
      {
        columns: 48, firstgid: FIRSTGID.ts_ground,
        image: 'Tileset_Ground.png', imageheight: 1520, imagewidth: 768,
        margin: 0, name: 'Tileset_Ground', spacing: 0,
        tilecount: 4560, tileheight: 16, tilewidth: 16,
      },
      {
        columns: 48, firstgid: FIRSTGID.ts_sand,
        image: 'Tileset_Sand.png', imageheight: 960, imagewidth: 768,
        margin: 0, name: 'Tileset_Sand', spacing: 0,
        tilecount: 2880, tileheight: 16, tilewidth: 16,
      },
      {
        columns: 18, firstgid: FIRSTGID.ts_road,
        image: 'Tileset_Road.png', imageheight: 896, imagewidth: 288,
        margin: 0, name: 'Tileset_Road', spacing: 0,
        tilecount: 1008, tileheight: 16, tilewidth: 16,
      },
      {
        columns: 80, firstgid: FIRSTGID.trees,
        image: 'Atlas_Trees_Bushes.png', imageheight: 1376, imagewidth: 1280,
        margin: 0, name: 'Atlas_Trees_Bushes', spacing: 0,
        tilecount: 6880, tileheight: 16, tilewidth: 16,
      },
      {
        columns: 63, firstgid: FIRSTGID.rocks,
        image: 'Atlas_Rocks.png', imageheight: 768, imagewidth: 1008,
        margin: 0, name: 'Atlas_Rocks', spacing: 0,
        tilecount: 3024, tileheight: 16, tilewidth: 16,
      },
      {
        columns: 6, firstgid: FIRSTGID.shadows,
        image: 'Tileset_Shadow.png', imageheight: 128, imagewidth: 96,
        margin: 0, name: 'Tileset_Shadow', spacing: 0,
        tilecount: 48, tileheight: 16, tilewidth: 16,
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
  console.log('Generating arena tilemap with roads, buildings, and rich vegetation...\n');

  const stamps = loadStamps();
  console.log(`Loaded ${Object.keys(stamps).length} stamp patterns`);

  const map = generateArenaTilemap();

  const terrainNames = {
    [WATER]: 'WATER', [SAND]: 'SAND', [OPEN]: 'OPEN', [JUNGLE]: 'JUNGLE',
    [HIGH_GROUND]: 'HIGH_GROUND', [WALL]: 'WALL', [SHALLOW_WATER]: 'SHALLOW_WATER',
    [RUIN_FLOOR]: 'RUIN_FLOOR', [MANGROVE]: 'MANGROVE', [CAVE]: 'CAVE',
  };
  const counts = {};
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      counts[map[y][x]] = (counts[map[y][x]] || 0) + 1;

  console.log('\nTerrain distribution:');
  for (const [t, n] of Object.entries(counts).sort((a, b) => b[1] - a[1]))
    console.log(`  ${(terrainNames[t] || t).padEnd(16)} ${String(n).padStart(5)} (${(n / (W * H) * 100).toFixed(1)}%)`);

  console.log('\nPlacing features:');
  const tmj = buildTmj(map, stamps);

  const vegTiles = tmj.layers[1].data.filter(g => g !== 0).length;
  const structTiles = tmj.layers[2].data.filter(g => g !== 0).length;
  console.log(`  Vegetation total: ${vegTiles} tiles`);
  console.log(`  Structures total: ${structTiles} tiles`);

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  const json = JSON.stringify(tmj);
  writeFileSync(OUTPUT_PATH, json, 'utf-8');

  console.log(`\nWrote ${OUTPUT_PATH}`);
  console.log(`  Layers: ${tmj.layers.length} | Tilesets: ${tmj.tilesets.length} | Size: ${(Buffer.byteLength(json) / 1024).toFixed(1)} KB`);
}

main();
