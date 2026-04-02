#!/usr/bin/env node
/**
 * generate-arena-tmj.mjs
 *
 * Generates a professional Tiled JSON (.tmj) for the arena map with:
 *   - Water base layer (deep + shallow fill)
 *   - Ground layer with AUTOTILE transitions:
 *       · Shore autotile (sand↔water) from Sand tileset
 *       · Grass-on-dirt autotile (land↔sand) from Ground tileset
 *       · Road autotile with proper edges
 *       · Building floors
 *   - Shadow layer (light shadows SE-offset under vegetation/buildings)
 *   - Vegetation layer (trees, bushes, palms via stamp patterns)
 *   - Structures layer (building walls, rocks via stamp patterns)
 *
 * Usage: node scripts/generate-arena-tmj.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(__dirname, '..', 'packages', 'client', 'public', 'tilesets', 'arena-map.tmj');
const STAMPS_PATH = resolve(__dirname, 'stamps.json');

// ===========================================================================
// Constants
// ===========================================================================

const W = 96;
const H = 96;

const FIRSTGID = {
  ts_ground: 1,       // 4560 tiles (48 cols × 95 rows)
  ts_sand: 4561,      // 2880 tiles (48 cols × 60 rows)
  ts_road: 7441,      // 1008 tiles (18 cols × 56 rows)
  trees: 8449,        // 6880 tiles (80 cols × 86 rows)
  rocks: 15329,       // 3024 tiles (63 cols × 48 rows)
  shadows: 18353,     // 48 tiles (6 cols × 8 rows)
  buildings_blue: 18401,   // 17160 tiles (132 cols × 130 rows)
  buildings_orange: 35561, // 17160 tiles
  buildings_green: 52721,  // 17160 tiles
  buildings_hay: 69881,    // 17160 tiles
  buildings_red: 87041,    // 17160 tiles
};

// Terrain types
const WATER = 0, SAND = 1, OPEN = 2, JUNGLE = 3, HIGH_GROUND = 4;
const WALL = 5, SHALLOW_WATER = 6, RUIN_FLOOR = 7, MANGROVE = 8, CAVE = 9;

// ===========================================================================
// Autotile block definitions
// ===========================================================================
// Each block is a 6-col × 8-row region within a tileset.
// Layout: edges, inner/outer corners at rows 0-3; composites rows 4-7.
// Fill tiles at rows 8-9 of the same column group (or separate fill arrays).
//
// Standard positions within a 6×8 block:
//   (0,1)=icNW  (0,2)=eN   (0,3)=icNE  (0,4)=ocNE  (0,5)=ocSE
//   (1,1)=eW    (1,2)=FILL (1,3)=eE    (1,4)=ocNW  (1,5)=ocSW
//   (2,0)=eS    (2,1)=icSW (2,2)=eS'   (2,3)=icSE
//   (0,0)=half  (1,0)=half (3,0)=half  (3,1)=half  (3,2)=mid

const SHORE_BLOCK = { baseRow: 10, baseCol: 18, tsCols: 48, ts: 'ts_sand' };
const GRASS_BLOCK = { baseRow: 0,  baseCol: 6,  tsCols: 48, ts: 'ts_ground' };
const JUNGLE_BLOCK = { baseRow: 28, baseCol: 6, tsCols: 48, ts: 'ts_ground' };
const ROAD_BLOCK  = { baseRow: 0,  baseCol: 0,  tsCols: 18, ts: 'ts_road' };

// Fill frames per terrain type (Ground tileset local frames)
const GRASS_FILLS   = [50, 56, 384, 385, 386, 387, 388, 389, 432, 433, 434, 435, 436, 437];
const JUNGLE_FILLS  = [1394, 1400, 1728, 1729, 1730, 1731, 1732, 1733, 1776, 1777, 1778, 1779, 1780, 1781];
const HG_FILLS      = [678, 679, 680, 681, 682, 683, 774, 775, 776, 777, 778, 779, 822, 823, 824, 825, 826, 827];
const CAVE_FILLS    = [347, 1350, 1351, 1398, 1399, 1446, 1447];
const MANGROVE_FILLS = [1394, 1400, 1542, 1543, 1590, 1591, 1638, 1639];

// Sand fill frames (Sand tileset local frames)
const SAND_FILLS = [50, 384, 385, 386, 387, 388, 389, 432, 433, 434];

// Water fill frames (Sand tileset local frames)
const DEEP_WATER_FILLS    = [2400, 2401, 2402, 2403, 2448, 2449, 2450, 2451, 2496, 2497, 2498, 2499];
const SHALLOW_WATER_FILLS = [1920, 1921, 1922, 1923, 1968, 1969, 1970, 1971, 2016, 2017, 2018, 2019];

// Road fill frames (Road tileset local frames)
const ROAD_FILLS = [20, 73, 144, 145, 146, 162, 163, 164];
// Building tiles
const FLOOR_FRAMES = [396, 397, 398, 399, 400, 401, 414, 415, 416, 417, 418, 419];
const WALL_FRAMES  = [648, 649, 650, 651, 652, 653, 666, 667, 668, 669, 670, 671];

// Shadow tileset local frames (light shadows, rows 0-2, 6 cols)
const SHADOW = {
  IC_NW: 1,  EN: 2,  OC_NE: 4,
  EW: 7,     FILL: 8, OC_NW: 10,
  IC_SW: 13, ES: 14, IC_SE: 15, OC_SE: 16, OC_SW: 17,
};

// ===========================================================================
// Locations, roads, buildings
// ===========================================================================

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

const BUILDINGS = [
  { x: 41, y: 40, w: 10, h: 8, door: { side: 'south', offset: 4 }, name: 'Market Hall' },
  { x: 44, y: 22, w: 8, h: 6, door: { side: 'south', offset: 3 }, name: 'Mountain Fortress' },
  { x: 45, y: 10, w: 5, h: 5, door: { side: 'south', offset: 2 }, name: 'Plateau Outpost' },
  { x: 11, y: 39, w: 5, h: 5, door: { side: 'east', offset: 2 }, name: 'Field House' },
  { x: 57, y: 17, w: 6, h: 5, door: { side: 'south', offset: 2 }, name: 'Meadow Cottage' },
  { x: 46, y: 32, w: 6, h: 5, door: { side: 'south', offset: 2 }, name: 'Clearing Lodge' },
  { x: 20, y: 43, w: 5, h: 5, door: { side: 'east', offset: 2 }, name: 'Thicket Camp' },
  { x: 67, y: 56, w: 6, h: 5, door: { side: 'west', offset: 2 }, name: 'Lagoon Dock' },
  { x: 20, y: 60, w: 5, h: 5, door: { side: 'south', offset: 2 }, name: 'Cave Shelter' },
  { x: 36, y: 32, w: 5, h: 5, door: { side: 'south', offset: 2 }, name: 'Traveler Inn' },
  { x: 52, y: 44, w: 6, h: 5, door: { side: 'west', offset: 2 }, name: 'Eastern Post' },
  { x: 32, y: 50, w: 5, h: 5, door: { side: 'north', offset: 2 }, name: 'Jungle Outpost' },
  { x: 55, y: 30, w: 5, h: 4, door: { side: 'south', offset: 2 }, name: 'Hilltop Hut' },
  { x: 30, y: 38, w: 5, h: 4, door: { side: 'east', offset: 1 }, name: 'Forest Cabin' },
  { x: 70, y: 22, w: 4, h: 4, door: { side: 'south', offset: 1 }, name: 'Ruins Chamber A' },
  { x: 77, y: 22, w: 3, h: 4, door: { side: 'west', offset: 1 }, name: 'Ruins Chamber B' },
];

// ===========================================================================
// Building stamp patterns (from stamps.json — tile IDs into building atlases)
// All building atlas PNGs share the same tile layout, just different colors.
// ===========================================================================

const BUILDING_STAMPS = {
  house_small_0: { w: 7, h: 7, ids: [[0,0,0,4,0,0,0],[0,134,135,136,137,138,0],[265,266,267,268,269,270,271],[397,398,399,400,401,402,403],[529,530,531,532,533,534,535],[661,662,663,664,665,666,667],[0,794,795,796,797,798,0]] },
  house_small_1: { w: 7, h: 7, ids: [[0,0,0,12,0,0,0],[0,142,143,144,145,146,0],[273,274,275,276,277,278,279],[405,406,407,408,409,410,411],[537,538,539,540,541,542,543],[669,670,671,672,673,674,675],[0,802,803,804,805,806,0]] },
  house_small_2: { w: 7, h: 7, ids: [[0,0,0,20,0,0,0],[0,150,151,152,153,154,0],[281,282,283,284,285,286,287],[413,414,415,416,417,418,419],[545,546,547,548,549,550,551],[677,678,679,680,681,682,683],[0,810,811,812,813,814,0]] },
  house_small_3: { w: 7, h: 7, ids: [[0,0,0,28,0,0,0],[0,158,159,160,161,162,0],[289,290,291,292,293,294,295],[421,422,423,424,425,426,427],[553,554,555,556,557,558,559],[685,686,687,688,689,690,691],[0,818,819,820,821,822,0]] },
  house_small_4: { w: 7, h: 7, ids: [[0,0,0,36,0,0,0],[0,166,167,168,169,170,0],[297,298,299,300,301,302,303],[429,430,431,432,433,434,435],[561,562,563,564,565,566,567],[693,694,695,696,697,698,699],[0,826,827,828,829,830,0]] },
  house_medium_0: { w: 10, h: 7, ids: [[1453,1454,1455,1456,1457,1458,1459,1460,1461,1462],[1585,1586,1587,1588,1589,1590,1591,1592,1593,1594],[1717,1718,1719,1720,1721,1722,1723,1724,1725,1726],[1849,1850,1851,1852,1853,1854,1855,1856,1857,1858],[1981,1982,1983,1984,1985,1986,1987,1988,1989,1990],[0,0,0,0,2117,2118,2119,2120,2121,2122],[0,0,0,0,2249,2250,2251,2252,2253,2254]] },
  house_medium_1: { w: 12, h: 7, ids: [[1475,1476,1477,1478,1479,1480,1481,1482,1483,1484,1485,1486],[1607,1608,1609,1610,1611,1612,1613,1614,1615,1616,1617,1618],[1739,1740,1741,1742,1743,1744,1745,1746,1747,1748,1749,1750],[1871,1872,1873,1874,1875,1876,1877,1878,1879,1880,1881,1882],[2003,2004,2005,2006,2007,2008,2009,2010,2011,2012,0,2014],[0,0,0,0,2139,2140,2141,2142,2143,2144,0,2146],[0,0,0,0,2271,2272,2273,2274,2275,2276,0,0]] },
};

// Maps each building name → unique (stamp variant, atlas color) combination
const BUILDING_CONFIGS = {
  'Market Hall':      { stamp: 'house_medium_0', atlas: 'buildings_blue' },
  'Mountain Fortress': { stamp: 'house_medium_1', atlas: 'buildings_red' },
  'Plateau Outpost':  { stamp: 'house_small_0',  atlas: 'buildings_orange' },
  'Field House':      { stamp: 'house_small_1',  atlas: 'buildings_green' },
  'Meadow Cottage':   { stamp: 'house_small_2',  atlas: 'buildings_green' },
  'Clearing Lodge':   { stamp: 'house_small_3',  atlas: 'buildings_orange' },
  'Thicket Camp':     { stamp: 'house_small_4',  atlas: 'buildings_hay' },
  'Lagoon Dock':      { stamp: 'house_small_0',  atlas: 'buildings_blue' },
  'Cave Shelter':     { stamp: 'house_small_1',  atlas: 'buildings_hay' },
  'Traveler Inn':     { stamp: 'house_small_2',  atlas: 'buildings_red' },
  'Eastern Post':     { stamp: 'house_small_3',  atlas: 'buildings_blue' },
  'Jungle Outpost':   { stamp: 'house_small_4',  atlas: 'buildings_green' },
  'Hilltop Hut':      { stamp: 'house_small_0',  atlas: 'buildings_hay' },
  'Forest Cabin':     { stamp: 'house_small_1',  atlas: 'buildings_orange' },
  'Ruins Chamber A':  { stamp: 'house_small_2',  atlas: 'buildings_blue' },
  'Ruins Chamber B':  { stamp: 'house_small_3',  atlas: 'buildings_red' },
};

// ===========================================================================
// Seeded PRNG (matches arena-map.ts)
// ===========================================================================

function seededRng(seed) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s & 0x7fffffff) / 0x7fffffff;
  };
}

// ===========================================================================
// Terrain map generation (exact copy from arena-map.ts, seed=42)
// ===========================================================================

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

  smoothCoastline(map);
  return map;
}

// ===========================================================================
// Coastline smoother
// ===========================================================================

function smoothCoastline(map) {
  const isLand = (t) => t !== WATER && t !== SHALLOW_WATER;

  for (let pass = 0; pass < 3; pass++) {
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        if (map[y][x] !== WATER) continue;
        let landCount = 0;
        if (isLand(map[y - 1][x])) landCount++;
        if (isLand(map[y + 1][x])) landCount++;
        if (isLand(map[y][x - 1])) landCount++;
        if (isLand(map[y][x + 1])) landCount++;
        if (landCount >= 3) map[y][x] = SAND;
      }
    }
  }

  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (map[y][x] !== SAND) continue;
      let waterCount = 0;
      if (map[y - 1][x] === WATER) waterCount++;
      if (map[y + 1][x] === WATER) waterCount++;
      if (map[y][x - 1] === WATER) waterCount++;
      if (map[y][x + 1] === WATER) waterCount++;
      if (waterCount >= 3) map[y][x] = WATER;
    }
  }

  const toShallow = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (map[y][x] !== WATER) continue;
      if (isLand(map[y-1][x]) || isLand(map[y+1][x]) ||
          isLand(map[y][x-1]) || isLand(map[y][x+1]))
        toShallow.push([x, y]);
    }
  }
  for (const [x, y] of toShallow) map[y][x] = SHALLOW_WATER;

  const toShallow2 = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (map[y][x] !== WATER) continue;
      if (map[y-1][x] === SHALLOW_WATER || map[y+1][x] === SHALLOW_WATER ||
          map[y][x-1] === SHALLOW_WATER || map[y][x+1] === SHALLOW_WATER)
        toShallow2.push([x, y]);
    }
  }
  for (const [x, y] of toShallow2) map[y][x] = SHALLOW_WATER;
}

// ===========================================================================
// Autotile engine
// ===========================================================================

/**
 * Compute autotile offset [row, col] within a 6-col autotile block.
 * Returns null if position is interior FILL (use fill frames instead).
 *
 * @param {number} x
 * @param {number} y
 * @param {(x:number, y:number) => boolean} isSame - returns true if neighbor is same terrain group
 */
function computeAutoOffset(x, y, isSame) {
  const n = isSame(x, y - 1);
  const s = isSame(x, y + 1);
  const e = isSame(x + 1, y);
  const w = isSame(x - 1, y);

  // All 4 cardinals same → check diagonals for outer corners
  if (n && s && e && w) {
    const ne = isSame(x + 1, y - 1);
    const nw = isSame(x - 1, y - 1);
    const se = isSame(x + 1, y + 1);
    const sw = isSame(x - 1, y + 1);

    const missing = (!ne ? 1 : 0) | (!nw ? 2 : 0) | (!se ? 4 : 0) | (!sw ? 8 : 0);

    if (missing === 0) return null; // True FILL

    // Single outer corner
    if (missing === 1)  return [0, 4]; // ocNE
    if (missing === 2)  return [1, 4]; // ocNW
    if (missing === 4)  return [0, 5]; // ocSE
    if (missing === 8)  return [1, 5]; // ocSW

    // Two corners — use composite tiles (rows 4-5)
    if (missing === 3)  return [4, 3]; // NE+NW (top two)
    if (missing === 12) return [4, 1]; // SE+SW (bottom two)
    if (missing === 5)  return [5, 4]; // NE+SE (right two)
    if (missing === 10) return [4, 5]; // NW+SW (left two)
    if (missing === 9)  return [5, 0]; // NE+SW (diagonal)
    if (missing === 6)  return [5, 2]; // NW+SE (diagonal)

    // Three corners — use T-junctions (rows 6-7)
    if (missing === 7)  return [6, 0]; // NE+NW+SE
    if (missing === 11) return [6, 2]; // NE+NW+SW
    if (missing === 13) return [7, 0]; // NE+SE+SW
    if (missing === 14) return [7, 2]; // NW+SE+SW

    // All 4 corners
    return [7, 4]; // cross
  }

  // Single edge
  if (!n &&  s &&  e &&  w) return [0, 2]; // eN
  if ( n && !s &&  e &&  w) return [2, 0]; // eS
  if ( n &&  s && !e &&  w) return [1, 3]; // eE
  if ( n &&  s &&  e && !w) return [1, 1]; // eW

  // Inner corners (two adjacent cardinals different)
  if (!n &&  s &&  e && !w) return [0, 1]; // icNW
  if (!n &&  s && !e &&  w) return [0, 3]; // icNE
  if ( n && !s &&  e && !w) return [2, 1]; // icSW
  if ( n && !s && !e &&  w) return [2, 3]; // icSE

  // Thin strips (opposite sides different)
  if (!n && !s &&  e &&  w) return [0, 0]; // horizontal strip
  if ( n &&  s && !e && !w) return [1, 0]; // vertical strip

  // Dead ends (3 sides different)
  if ( n && !s && !e && !w) return [3, 0]; // N peninsula
  if (!n &&  s && !e && !w) return [0, 0]; // S peninsula
  if (!n && !s &&  e && !w) return [1, 0]; // E peninsula
  if (!n && !s && !e &&  w) return [3, 1]; // W peninsula

  // Isolated
  return [3, 2];
}

/** Get GID from an autotile block at a given offset */
function blockGid(block, dr, dc) {
  const frame = (block.baseRow + dr) * block.tsCols + (block.baseCol + dc);
  return frame + FIRSTGID[block.ts];
}

/** Pick from an array deterministically */
function pickVariant(arr, x, y) {
  return arr[(x * 7 + y * 13) % arr.length];
}

// ===========================================================================
// Layer builders
// ===========================================================================

function isWater(t) { return t === WATER || t === SHALLOW_WATER; }
function isLand(t) { return !isWater(t); }

// --- Layer 0: Water base fill ---
function buildWaterLayer(map) {
  const data = new Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = map[y][x];
      const fills = (t === SHALLOW_WATER) ? SHALLOW_WATER_FILLS : DEEP_WATER_FILLS;
      data[y * W + x] = pickVariant(fills, x, y) + FIRSTGID.ts_sand;
    }
  }
  return data;
}

// --- Layer 1: Ground (shore autotile + grass autotile + roads + floors) ---
function buildGroundLayer(map, isRoad, buildingMask) {
  const data = new Array(W * H).fill(0);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = map[y][x];

      // Water cells → transparent (show water base below)
      if (isWater(t)) continue;

      // Building floor overrides terrain
      if (buildingMask[y][x]) {
        data[y * W + x] = pickVariant(FLOOR_FRAMES, x, y) + FIRSTGID.ts_road;
        continue;
      }

      // Road positions → paint terrain fill (road tiles are on a separate overlay layer
      // because road autotile edges have transparency that would show the water base)
      if (isRoad[y][x]) {
        const fills = getTerrainFills(t);
        if (t === WALL || t === RUIN_FLOOR) {
          data[y * W + x] = pickVariant(fills, x, y) + FIRSTGID.ts_road;
        } else {
          data[y * W + x] = pickVariant(fills, x, y) + FIRSTGID.ts_ground;
        }
        continue;
      }

      // SAND terrain → shore autotile (sand-on-water transition)
      if (t === SAND) {
        const shoreOffset = computeAutoOffset(x, y, (tx, ty) => {
          if (tx < 0 || tx >= W || ty < 0 || ty >= H) return false;
          return isLand(map[ty][tx]);
        });
        if (shoreOffset === null) {
          data[y * W + x] = pickVariant(SAND_FILLS, x, y) + FIRSTGID.ts_sand;
        } else {
          data[y * W + x] = blockGid(SHORE_BLOCK, shoreOffset[0], shoreOffset[1]);
        }
        continue;
      }

      // All other land → grass/jungle autotile
      // "Same" = any non-water, non-sand terrain (grass group)
      const grassOffset = computeAutoOffset(x, y, (tx, ty) => {
        if (tx < 0 || tx >= W || ty < 0 || ty >= H) return false;
        const nt = map[ty][tx];
        return nt !== WATER && nt !== SHALLOW_WATER && nt !== SAND;
      });

      if (grassOffset === null) {
        // Interior FILL → use terrain-specific fill tiles
        const fills = getTerrainFills(t);
        data[y * W + x] = pickVariant(fills, x, y) + FIRSTGID.ts_ground;
      } else {
        // Edge/corner → use grass-on-dirt autotile (A2 block)
        // For jungle terrain at edges, use jungle-on-dirt (C2) for consistent look
        const block = isJungleGroup(t) ? JUNGLE_BLOCK : GRASS_BLOCK;
        data[y * W + x] = blockGid(block, grassOffset[0], grassOffset[1]);
      }
    }
  }

  return data;
}

function isJungleGroup(t) {
  return t === JUNGLE || t === MANGROVE || t === CAVE;
}

function getTerrainFills(t) {
  switch (t) {
    case OPEN:        return GRASS_FILLS;
    case HIGH_GROUND: return HG_FILLS;
    case JUNGLE:      return JUNGLE_FILLS;
    case MANGROVE:    return MANGROVE_FILLS;
    case CAVE:        return CAVE_FILLS;
    case WALL:        return WALL_FRAMES; // Road tileset — handle separately
    case RUIN_FLOOR:  return FLOOR_FRAMES;
    default:          return GRASS_FILLS;
  }
}

// --- Layer 2b: Jungle edge overlay (smooth jungle↔grass transitions) ---
function buildJungleEdgeLayer(map, isRoad, buildingMask) {
  const data = new Array(W * H).fill(0);
  let count = 0;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = map[y][x];
      if (!isJungleGroup(t)) continue;
      if (isRoad[y][x] || buildingMask[y][x]) continue;

      // "Same" = jungle group + water + sand + road + building
      // Edges only appear at jungle↔grass/open/highground boundaries
      const offset = computeAutoOffset(x, y, (tx, ty) => {
        if (tx < 0 || tx >= W || ty < 0 || ty >= H) return false;
        const nt = map[ty][tx];
        if (isJungleGroup(nt)) return true;
        if (isWater(nt) || nt === SAND) return true;
        if (isRoad[ty][tx] || buildingMask[ty][tx]) return true;
        return false;
      });

      if (offset === null) continue; // interior — Ground layer has jungle fill

      data[y * W + x] = blockGid(JUNGLE_BLOCK, offset[0], offset[1]);
      count++;
    }
  }

  console.log(`  Jungle edges: ${count} overlay tiles`);
  return data;
}

// --- Road overlay layer (separate from Ground to avoid water bleed-through) ---
function buildRoadLayer(isRoad, buildingMask) {
  const data = new Array(W * H).fill(0);
  let count = 0;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!isRoad[y][x]) continue;

      const rOffset = computeAutoOffset(x, y, (tx, ty) => {
        if (tx < 0 || tx >= W || ty < 0 || ty >= H) return false;
        return isRoad[ty][tx] || buildingMask[ty][tx];
      });

      if (rOffset === null) {
        data[y * W + x] = pickVariant(ROAD_FILLS, x, y) + FIRSTGID.ts_road;
      } else {
        data[y * W + x] = blockGid(ROAD_BLOCK, rOffset[0], rOffset[1]);
      }
      count++;
    }
  }

  console.log(`  Road overlay: ${count} tiles`);
  return data;
}

// --- Road network ---
function computeRoadMask(map) {
  const isRoad = Array.from({ length: H }, () => Array(W).fill(false));

  for (const [keyA, keyB] of ROAD_CONNECTIONS) {
    const a = LOCATIONS[keyA];
    const b = LOCATIONS[keyB];
    if (!a || !b) continue;

    const x0 = a.cx, y0 = a.cy, x1 = b.cx, y1 = b.cy;
    const xMin = Math.min(x0, x1), xMax = Math.max(x0, x1);
    for (let x = xMin; x <= xMax; x++) {
      for (let dy = -1; dy <= 1; dy++) {
        const y = y0 + dy;
        if (y >= 0 && y < H && x >= 0 && x < W && isLand(map[y][x])) {
          isRoad[y][x] = true;
        }
      }
    }
    const yMin = Math.min(y0, y1), yMax = Math.max(y0, y1);
    for (let y = yMin; y <= yMax; y++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = x1 + dx;
        if (y >= 0 && y < H && x >= 0 && x < W && isLand(map[y][x])) {
          isRoad[y][x] = true;
        }
      }
    }
  }

  // Plaza around the high clearing — paved stone area
  const plaza = LOCATIONS.high_clearing;
  const PLAZA_RX = 6, PLAZA_RY = 4; // half-widths
  for (let y = plaza.cy - PLAZA_RY; y <= plaza.cy + PLAZA_RY; y++) {
    for (let x = plaza.cx - PLAZA_RX; x <= plaza.cx + PLAZA_RX; x++) {
      if (x >= 0 && x < W && y >= 0 && y < H && isLand(map[y][x])) {
        isRoad[y][x] = true;
      }
    }
  }

  return isRoad;
}

// --- Building construction ---
function computeBuildingMask(map, isRoad, occupied) {
  const mask = Array.from({ length: H }, () => Array(W).fill(false));
  const wallData = new Array(W * H).fill(0);
  let floorCount = 0, stampCount = 0;

  for (const bldg of BUILDINGS) {
    // Check building footprint is on land
    let onLand = true;
    for (let r = 0; r < bldg.h && onLand; r++) {
      for (let c = 0; c < bldg.w && onLand; c++) {
        const mx = bldg.x + c, my = bldg.y + r;
        if (mx < 0 || mx >= W || my < 0 || my >= H || map[my][mx] === WATER) onLand = false;
      }
    }
    if (!onLand) {
      console.warn(`  Warning: ${bldg.name} at (${bldg.x},${bldg.y}) overlaps water — skipped`);
      continue;
    }

    // Mark footprint mask (for floor fills, road borders, collision)
    for (let r = 0; r < bldg.h; r++) {
      for (let c = 0; c < bldg.w; c++) {
        const mx = bldg.x + c, my = bldg.y + r;
        if (mx < 0 || mx >= W || my < 0 || my >= H) continue;
        mask[my][mx] = true;
        floorCount++;
        isRoad[my][mx] = false;
        occupied[my][mx] = true;
      }
    }

    // Place 2.5D building stamp (larger than footprint — roof extends above)
    const config = BUILDING_CONFIGS[bldg.name];
    if (!config) {
      console.warn(`  Warning: No stamp config for "${bldg.name}" — using fallback walls`);
      continue;
    }
    const stamp = BUILDING_STAMPS[config.stamp];
    const firstgid = FIRSTGID[config.atlas];

    // Center stamp horizontally over footprint, align bottom edges
    const stampX = bldg.x + Math.floor((bldg.w - stamp.w) / 2);
    const stampY = bldg.y + bldg.h - stamp.h;

    let placed = 0;
    for (let r = 0; r < stamp.h; r++) {
      for (let c = 0; c < stamp.w; c++) {
        const tileId = stamp.ids[r][c];
        if (tileId === 0) continue; // transparent
        const mx = stampX + c;
        const my = stampY + r;
        if (mx < 0 || mx >= W || my < 0 || my >= H) continue;
        wallData[my * W + mx] = tileId + firstgid;
        placed++;
      }
    }
    stampCount += placed;
    console.log(`  ${bldg.name}: ${config.stamp} (${config.atlas}) at (${stampX},${stampY}) — ${placed} tiles`);
  }

  // Add 1-tile path border around each building (so they don't float on grass)
  for (const bldg of BUILDINGS) {
    for (let r = -1; r <= bldg.h; r++) {
      for (let c = -1; c <= bldg.w; c++) {
        if (r >= 0 && r < bldg.h && c >= 0 && c < bldg.w) continue; // skip interior
        const mx = bldg.x + c, my = bldg.y + r;
        if (mx < 0 || mx >= W || my < 0 || my >= H) continue;
        if (mask[my][mx]) continue; // already building
        if (!isLand(map[my][mx])) continue;
        isRoad[my][mx] = true;
        occupied[my][mx] = true;
      }
    }
  }

  console.log(`  Buildings: ${floorCount} floor + ${stampCount} stamp tiles (${BUILDINGS.length} buildings)`);
  return { mask, wallData };
}

// ===========================================================================
// Shadow layer
// ===========================================================================

function buildShadowLayer(vegGrid, structData, occupied, map) {
  const data = new Array(W * H).fill(0);
  const shadowMask = Array.from({ length: H }, () => Array(W).fill(false));

  // Mark shadow positions: 1 tile SE offset from each vegetation/structure tile
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const hasVeg = vegGrid[y][x] !== 0;
      const hasStruct = structData[y * W + x] !== 0;
      if (!hasVeg && !hasStruct) continue;

      // Cast shadow SE (1 down, 1 right)
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const sx = x + dx, sy = y + dy;
          if (sx >= 0 && sx < W && sy >= 0 && sy < H && isLand(map[sy][sx])) {
            shadowMask[sy][sx] = true;
          }
        }
      }
    }
  }

  // Place shadow tiles with autotile edges
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!shadowMask[y][x]) continue;

      const isSame = (tx, ty) => {
        if (tx < 0 || tx >= W || ty < 0 || ty >= H) return false;
        return shadowMask[ty][tx];
      };

      const n = isSame(x, y - 1);
      const s = isSame(x, y + 1);
      const e = isSame(x + 1, y);
      const w = isSame(x - 1, y);

      let frame;
      if (n && s && e && w) {
        frame = SHADOW.FILL;
      } else if (!n && s && e && w) {
        frame = SHADOW.EN;
      } else if (n && !s && e && w) {
        frame = SHADOW.ES;
      } else if (n && s && e && !w) {
        frame = SHADOW.EW;
      } else if (!n && s && e && !w) {
        frame = SHADOW.IC_NW;
      } else if (!n && s && !e && w) {
        frame = SHADOW.IC_SW; // approximate
      } else if (n && !s && e && !w) {
        frame = SHADOW.IC_SW;
      } else if (n && !s && !e && w) {
        frame = SHADOW.IC_SE;
      } else {
        frame = SHADOW.FILL;
      }

      data[y * W + x] = frame + FIRSTGID.shadows;
    }
  }

  return data;
}

// ===========================================================================
// Vegetation + Rocks (stamp-based, same as before)
// ===========================================================================

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
    if (stamp) placeStamp(grid, occupied, stamp, spot.x - 3, spot.y - 4, stamp.atlas);
  }

  // Scan and place vegetation
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (occupied[y][x]) continue;
      const terrain = map[y][x];
      let pool, chance;
      switch (terrain) {
        case JUNGLE:      pool = jungleStamps;    chance = 0.25; break;
        case OPEN:        pool = openStamps;      chance = 0.08; break;
        case SAND:        pool = sandStamps;      chance = 0.08; break;
        case MANGROVE:    pool = mangroveStamps;  chance = 0.22; break;
        case CAVE:        pool = caveStamps;      chance = 0.14; break;
        case HIGH_GROUND: pool = highGroundStamps; chance = 0.06; break;
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
        }
      }
      if (ok) placeStamp(grid, occupied, stamp, ox, oy, stamp.atlas);
    }
  }
  return grid;
}

function buildRocksOnStructLayer(map, stamps, occupied, structData) {
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
        case HIGH_GROUND: pool = highRocks;        chance = 0.08; break;
        case CAVE:        pool = caveRocks;        chance = 0.12; break;
        case SAND:        pool = sandRocks;        chance = 0.03; break;
        case RUIN_FLOOR:  pool = highRocks.slice(4); chance = 0.05; break;
        case OPEN:        pool = sandRocks;              chance = 0.015; break;
        case JUNGLE:      pool = caveRocks.slice(4, 8);  chance = 0.02; break;
        case MANGROVE:    pool = sandRocks;              chance = 0.02; break;
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

// ===========================================================================
// WALL/RUIN terrain tile handling
// ===========================================================================

function getTerrainFillGid(terrain, x, y) {
  if (terrain === WALL) return pickVariant(WALL_FRAMES, x, y) + FIRSTGID.ts_road;
  if (terrain === RUIN_FLOOR) return pickVariant(FLOOR_FRAMES, x, y) + FIRSTGID.ts_road;
  return pickVariant(getTerrainFills(terrain), x, y) + FIRSTGID.ts_ground;
}

// ===========================================================================
// TMJ assembly
// ===========================================================================

function buildTmj(map, stamps) {
  // Shared state
  const occupied = Array.from({ length: H }, () => Array(W).fill(false));
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (isWater(map[y][x])) occupied[y][x] = true;

  // 1) Compute road mask
  const isRoad = computeRoadMask(map);
  let roadCount = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (isRoad[y][x]) { occupied[y][x] = true; roadCount++; }
    }
  console.log(`  Roads: ${roadCount} tiles`);

  // 2) Compute buildings (modifies occupied + isRoad)
  const { mask: buildingMask, wallData } = computeBuildingMask(map, isRoad, occupied);

  // 3) Build layers
  console.log('  Building water layer...');
  const waterData = buildWaterLayer(map);

  console.log('  Building ground layer with autotile...');
  const groundData = buildGroundLayer(map, isRoad, buildingMask);

  console.log('  Building road overlay...');
  const roadData = buildRoadLayer(isRoad, buildingMask);

  console.log('  Building jungle edge overlay...');
  const jungleEdgeData = buildJungleEdgeLayer(map, isRoad, buildingMask);

  // 4) Vegetation
  console.log('  Placing vegetation...');
  const vegGrid = buildVegetationLayer(map, stamps, occupied);

  // 5) Rocks on structure layer
  const structData = [...wallData]; // start with building walls
  buildRocksOnStructLayer(map, stamps, occupied, structData);

  // 6) Shadows
  console.log('  Computing shadows...');
  const shadowData = buildShadowLayer(vegGrid, structData, occupied, map);

  // Flatten veg grid
  const vegData = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      vegData.push(vegGrid[y][x]);

  // Stats
  const groundNonZero = groundData.filter(g => g !== 0).length;
  const jungleEdgeTiles = jungleEdgeData.filter(g => g !== 0).length;
  const vegTiles = vegData.filter(g => g !== 0).length;
  const structTiles = structData.filter(g => g !== 0).length;
  const shadowTiles = shadowData.filter(g => g !== 0).length;
  console.log(`  Ground: ${groundNonZero} tiles (${W*H - groundNonZero} transparent → water)`);
  console.log(`  Jungle edges: ${jungleEdgeTiles} overlay tiles`);
  console.log(`  Vegetation: ${vegTiles} tiles`);
  console.log(`  Structures: ${structTiles} tiles`);
  console.log(`  Shadows: ${shadowTiles} tiles`);

  return {
    compressionlevel: -1,
    height: H,
    infinite: false,
    layers: [
      { data: waterData,      height: H, id: 1, name: 'Water',        opacity: 1, type: 'tilelayer', visible: true, width: W, x: 0, y: 0 },
      { data: groundData,     height: H, id: 2, name: 'Ground',       opacity: 1, type: 'tilelayer', visible: true, width: W, x: 0, y: 0 },
      { data: roadData,       height: H, id: 3, name: 'Roads',        opacity: 1, type: 'tilelayer', visible: true, width: W, x: 0, y: 0 },
      { data: jungleEdgeData, height: H, id: 4, name: 'Jungle Edges', opacity: 1, type: 'tilelayer', visible: true, width: W, x: 0, y: 0 },
      { data: shadowData,     height: H, id: 5, name: 'Shadows',      opacity: 0.3, type: 'tilelayer', visible: true, width: W, x: 0, y: 0 },
      { data: vegData,        height: H, id: 6, name: 'Vegetation',   opacity: 1, type: 'tilelayer', visible: true, width: W, x: 0, y: 0 },
      { data: structData,     height: H, id: 7, name: 'Structures',   opacity: 1, type: 'tilelayer', visible: true, width: W, x: 0, y: 0 },
    ],
    nextlayerid: 8,
    nextobjectid: 1,
    orientation: 'orthogonal',
    renderorder: 'right-down',
    tiledversion: '1.11.2',
    tileheight: 16,
    tilesets: [
      { columns: 48, firstgid: FIRSTGID.ts_ground, image: 'Tileset_Ground.png', imageheight: 1520, imagewidth: 768, margin: 0, name: 'Tileset_Ground', spacing: 0, tilecount: 4560, tileheight: 16, tilewidth: 16 },
      { columns: 48, firstgid: FIRSTGID.ts_sand, image: 'Tileset_Sand.png', imageheight: 960, imagewidth: 768, margin: 0, name: 'Tileset_Sand', spacing: 0, tilecount: 2880, tileheight: 16, tilewidth: 16 },
      { columns: 18, firstgid: FIRSTGID.ts_road, image: 'Tileset_Road.png', imageheight: 896, imagewidth: 288, margin: 0, name: 'Tileset_Road', spacing: 0, tilecount: 1008, tileheight: 16, tilewidth: 16 },
      { columns: 80, firstgid: FIRSTGID.trees, image: 'Atlas_Trees_Bushes.png', imageheight: 1376, imagewidth: 1280, margin: 0, name: 'Atlas_Trees_Bushes', spacing: 0, tilecount: 6880, tileheight: 16, tilewidth: 16 },
      { columns: 63, firstgid: FIRSTGID.rocks, image: 'Atlas_Rocks.png', imageheight: 768, imagewidth: 1008, margin: 0, name: 'Atlas_Rocks', spacing: 0, tilecount: 3024, tileheight: 16, tilewidth: 16 },
      { columns: 6, firstgid: FIRSTGID.shadows, image: 'Tileset_Shadow.png', imageheight: 128, imagewidth: 96, margin: 0, name: 'Tileset_Shadow', spacing: 0, tilecount: 48, tileheight: 16, tilewidth: 16 },
      { columns: 132, firstgid: FIRSTGID.buildings_blue, image: 'Atlas_Buildings_Wood_Blue.png', imageheight: 2080, imagewidth: 2112, margin: 0, name: 'Atlas_Buildings_Blue', spacing: 0, tilecount: 17160, tileheight: 16, tilewidth: 16 },
      { columns: 132, firstgid: FIRSTGID.buildings_orange, image: 'Atlas_Buildings_Wood_Orange.png', imageheight: 2080, imagewidth: 2112, margin: 0, name: 'Atlas_Buildings_Orange', spacing: 0, tilecount: 17160, tileheight: 16, tilewidth: 16 },
      { columns: 132, firstgid: FIRSTGID.buildings_green, image: 'Atlas_Buildings_Wood_Green.png', imageheight: 2080, imagewidth: 2112, margin: 0, name: 'Atlas_Buildings_Green', spacing: 0, tilecount: 17160, tileheight: 16, tilewidth: 16 },
      { columns: 132, firstgid: FIRSTGID.buildings_hay, image: 'Atlas_Buildings_Hay.png', imageheight: 2080, imagewidth: 2112, margin: 0, name: 'Atlas_Buildings_Hay', spacing: 0, tilecount: 17160, tileheight: 16, tilewidth: 16 },
      { columns: 132, firstgid: FIRSTGID.buildings_red, image: 'Atlas_Buildings_Wood_Red.png', imageheight: 2080, imagewidth: 2112, margin: 0, name: 'Atlas_Buildings_Red', spacing: 0, tilecount: 17160, tileheight: 16, tilewidth: 16 },
    ],
    tilewidth: 16,
    type: 'map',
    version: '1.10',
    width: W,
  };
}

// ===========================================================================
// Main
// ===========================================================================

function main() {
  console.log('Generating arena tilemap with autotile transitions...\n');

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

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  const json = JSON.stringify(tmj);
  writeFileSync(OUTPUT_PATH, json, 'utf-8');

  console.log(`\nWrote ${OUTPUT_PATH}`);
  console.log(`  Layers: ${tmj.layers.length} | Tilesets: ${tmj.tilesets.length} | Size: ${(Buffer.byteLength(json) / 1024).toFixed(1)} KB`);
}

main();
