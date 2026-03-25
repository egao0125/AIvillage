import type { MapArea, Position } from '@ai-village/shared';

export const TILE_SIZE = 32;
export const MAP_WIDTH = 68;
export const MAP_HEIGHT = 45;

// Tile types:
// 0 = grass
// 1 = path
// 2 = water
// 3 = sand
// 4 = floor (inside buildings)
// 5 = wall
// 6 = forest_floor
// 7 = flowers
// 8 = bridge
// 9 = floor_dark (darker stone/tile floor)

/**
 * Build the 60x45 tile map with 3x larger buildings in a 3×3 grid.
 * Must match client/src/game/data/village-map.ts exactly.
 */
function buildTileMap(): number[][] {
  const m: number[][] = Array.from({ length: MAP_HEIGHT }, () => Array(MAP_WIDTH).fill(0));

  const X_OFF = 4;
  const fill = (sx: number, sy: number, w: number, h: number, t: number) => {
    for (let y = sy; y < sy + h && y < MAP_HEIGHT; y++)
      for (let x = sx + X_OFF; x < sx + X_OFF + w && x < MAP_WIDTH; x++)
        m[y][x] = t;
  };
  const set = (x: number, y: number, t: number) => {
    const ax = x + X_OFF;
    if (y >= 0 && y < MAP_HEIGHT && ax >= 0 && ax < MAP_WIDTH) m[y][ax] = t;
  };

  const buildShape = (
    rects: {x: number, y: number, w: number, h: number}[],
    walls: [string, number, number, number][],
    dark: number[][], doors: number[][], ents: number[][],
  ) => {
    const inShape = (tx: number, ty: number) =>
      rects.some(r => tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h);

    for (const r of rects) fill(r.x, r.y, r.w, r.h, 4);

    for (const r of rects) {
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          if (!inShape(x - 1, y) || !inShape(x + 1, y) || !inShape(x, y - 1) || !inShape(x, y + 1))
            set(x, y, 5);
        }
      }
    }

    for (const [t, pos, from, to] of walls) {
      if (t === 'v') for (let y = from; y <= to; y++) set(pos, y, 5);
      else for (let x = from; x <= to; x++) set(x, pos, 5);
    }
    for (const d of dark) fill(d[0], d[1], d[2], d[3], 9);
    for (const d of doors) set(d[0], d[1], 4);
    for (const e of ents) set(e[0], e[1], 4);
  };

  // ═══ Step 1: Borders ═══
  // Left forest — organic wavy edge (absolute coords, no X_OFF)
  for (let y = 0; y < MAP_HEIGHT; y++) {
    const wave = Math.sin(y * 0.2) * 1.0 + Math.sin(y * 0.5) * 0.5 + Math.cos(y * 0.13) * 0.7;
    const edge = 5.0 + wave;
    for (let x = 0; x < Math.min(Math.ceil(edge) + 1, MAP_WIDTH); x++) {
      if (x + 0.5 < edge) m[y][x] = 6;
    }
  }
  for (let y = 0; y < MAP_HEIGHT; y++) {
    const wave = Math.sin(y * 0.15) * 0.8 + Math.sin(y * 0.35) * 0.4;
    const cx = 63.5 + wave;
    for (let x = 59; x < MAP_WIDTH; x++) {
      const d = Math.abs(x + 0.5 - cx);
      if (d < 1.5) m[y][x] = 2;
      else if (d < 2.8) m[y][x] = 3;
    }
  }
  const topFlowers = [
    [4,0],[7,0],[12,1],[15,0],[17,1],[22,1],[26,0],[30,0],
    [33,1],[38,1],[42,1],[45,0],[48,1],[50,0],[52,1],
  ];
  for (const [fx, fy] of topFlowers) set(fx, fy, 7);

  for (let y = 39; y < MAP_HEIGHT; y++)
    for (let x = 2; x < 55; x++) {
      const hash = (x * 7 + y * 13) % 13;
      if (hash === 0 || hash === 4 || hash === 9) set(x, y, 7);
    }

  // Scattered flowers along N-S path edges
  for (let y = 2; y < 39; y++) {
    if ((y * 3 + 7) % 11 === 0) set(17, y, 7);
    if ((y * 5 + 3) % 11 === 0) set(20, y, 7);
    if ((y * 7 + 2) % 11 === 0) set(36, y, 7);
    if ((y * 4 + 9) % 11 === 0) set(39, y, 7);
  }

  // ═══ Step 2: Paths ═══
  for (let x = 2; x <= 55; x++) {
    set(x, 13, 1); set(x, 14, 1);
    set(x, 26, 1); set(x, 27, 1);
  }
  for (let y = 0; y < MAP_HEIGHT; y++) {
    set(18, y, 1); set(19, y, 1);
    set(37, y, 1); set(38, y, 1);
  }

  // ═══ Step 3: Buildings (non-rectangular shapes) ═══

  // Church — T-shape: tower + nave
  buildShape(
    [{x:2, y:2, w:16, h:11}, {x:7, y:0, w:6, h:3}],
    [['h', 7, 3, 16]],
    [[3, 3, 14, 4]],
    [[8, 7], [9, 7]],
    [[9, 12], [10, 12]],
  );

  // School — L-shape: main + wing
  buildShape(
    [{x:20, y:4, w:11, h:8}, {x:30, y:2, w:7, h:7}],
    [['v', 30, 5, 11]],
    [[31, 3, 5, 4]],
    [[30, 7], [30, 10], [33, 8]],
    [[27, 12], [28, 12]],
  );

  // Cafe — L-shape with left bump
  buildShape(
    [{x:42, y:2, w:13, h:11}, {x:39, y:5, w:4, h:7}],
    [['v', 48, 3, 11]],
    [[40, 6, 3, 5]],
    [[48, 5], [48, 9], [44, 7]],
    [[49, 12], [50, 12]],
  );

  // Bakery — L-shape with top-right oven
  buildShape(
    [{x:2, y:17, w:14, h:8}, {x:12, y:15, w:6, h:4}],
    [['h', 21, 3, 14], ['v', 9, 22, 24]],
    [[3, 22, 6, 3]],
    [[7, 21], [8, 21], [13, 21], [9, 23]],
    [[9, 25], [10, 25]],
  );

  // Town Hall — L-shape with bottom wing
  buildShape(
    [{x:20, y:15, w:17, h:8}, {x:20, y:22, w:9, h:4}],
    [['v', 28, 16, 22], ['h', 20, 21, 35]],
    [[29, 16, 7, 4]],
    [[28, 18], [28, 24], [25, 20], [32, 20]],
    [[27, 15], [28, 15]],
  );

  // Workshop — chimney bump
  buildShape(
    [{x:39, y:17, w:15, h:8}, {x:44, y:15, w:5, h:3}],
    [['h', 21, 40, 52], ['v', 48, 18, 20]],
    [[49, 18, 4, 3]],
    [[48, 19], [44, 21], [45, 21], [51, 21]],
    [[46, 25], [47, 25]],
  );

  // Clinic — bump left
  buildShape(
    [{x:4, y:28, w:11, h:10}, {x:2, y:31, w:3, h:5}],
    [['v', 9, 29, 36], ['h', 33, 10, 14]],
    [[10, 29, 4, 4]],
    [[9, 31], [9, 35], [12, 33]],
    [[9, 28], [10, 28]],
  );

  // Tavern — L-shape right
  buildShape(
    [{x:20, y:28, w:14, h:10}, {x:33, y:30, w:4, h:8}],
    [['v', 28, 29, 37], ['h', 34, 21, 33]],
    [[21, 29, 7, 5], [29, 35, 7, 3]],
    [[28, 31], [28, 36], [24, 34], [33, 33]],
    [[27, 28], [28, 28]],
  );

  // Market — inverted L
  buildShape(
    [{x:39, y:28, w:17, h:8}, {x:47, y:35, w:8, h:4}],
    [['v', 49, 29, 35]],
    [[50, 29, 5, 6]],
    [[49, 32], [49, 37]],
    [[46, 28], [47, 28]],
  );

  return m;
}

// prettier-ignore
export const TILE_MAP: number[][] = buildTileMap();

export const AREAS: MapArea[] = [
  {
    id: 'forest',
    name: 'Whispering Forest',
    type: 'forest',
    bounds: { x: 0, y: 0, width: 6, height: 45 },
    objects: [
      { id: 'tree_1', name: 'Old Oak', position: { x: 2, y: 15 }, status: 'standing' },
      { id: 'mushroom_1', name: 'Mushroom Patch', position: { x: 2, y: 10 }, status: 'growing' },
    ],
  },
  {
    id: 'church',
    name: 'Village Church',
    type: 'house',
    bounds: { x: 6, y: 0, width: 16, height: 13 },
    objects: [
      { id: 'altar', name: 'Altar', position: { x: 10, y: 4 }, status: 'consecrated' },
      { id: 'pew_1', name: 'Pew', position: { x: 10, y: 7 }, status: 'empty' },
    ],
  },
  {
    id: 'school',
    name: 'Village School',
    type: 'house',
    bounds: { x: 24, y: 2, width: 17, height: 10 },
    objects: [
      { id: 'chalkboard', name: 'Chalkboard', position: { x: 26, y: 4 }, status: 'written on' },
      { id: 'bookshelf', name: 'Library Shelf', position: { x: 35, y: 3 }, status: 'stocked' },
    ],
  },
  {
    id: 'cafe',
    name: 'Village Cafe',
    type: 'cafe',
    bounds: { x: 43, y: 2, width: 16, height: 11 },
    objects: [
      { id: 'counter', name: 'Counter', position: { x: 44, y: 10 }, status: 'open' },
      { id: 'table_1', name: 'Table', position: { x: 45, y: 4 }, status: 'empty' },
    ],
  },
  {
    id: 'bakery',
    name: 'Village Bakery',
    type: 'shop',
    bounds: { x: 6, y: 15, width: 16, height: 10 },
    objects: [
      { id: 'oven', name: 'Bread Oven', position: { x: 17, y: 16 }, status: 'warm' },
      { id: 'display', name: 'Bread Display', position: { x: 8, y: 16 }, status: 'stocked' },
    ],
  },
  {
    id: 'town_hall',
    name: 'Town Hall',
    type: 'house',
    bounds: { x: 24, y: 15, width: 17, height: 11 },
    objects: [
      { id: 'mayor_desk', name: 'Mayor\'s Desk', position: { x: 28, y: 17 }, status: 'occupied' },
      { id: 'town_notice', name: 'Town Notice Board', position: { x: 25, y: 16 }, status: 'posted' },
    ],
  },
  {
    id: 'workshop',
    name: 'Craftsman Workshop',
    type: 'shop',
    bounds: { x: 43, y: 15, width: 16, height: 10 },
    objects: [
      { id: 'workbench', name: 'Workbench', position: { x: 46, y: 17 }, status: 'in use' },
      { id: 'tool_rack', name: 'Tool Rack', position: { x: 44, y: 20 }, status: 'stocked' },
    ],
  },
  {
    id: 'hospital',
    name: 'Village Clinic',
    type: 'house',
    bounds: { x: 6, y: 28, width: 13, height: 10 },
    objects: [
      { id: 'medical_bed', name: 'Medical Bed', position: { x: 16, y: 30 }, status: 'empty' },
      { id: 'medicine_shelf', name: 'Medicine Shelf', position: { x: 16, y: 35 }, status: 'stocked' },
    ],
  },
  {
    id: 'tavern',
    name: 'The Hearthstone Tavern',
    type: 'cafe',
    bounds: { x: 24, y: 28, width: 17, height: 10 },
    objects: [
      { id: 'bar_counter', name: 'Bar Counter', position: { x: 26, y: 29 }, status: 'open' },
      { id: 'tavern_table', name: 'Tavern Table', position: { x: 27, y: 33 }, status: 'empty' },
    ],
  },
  {
    id: 'market',
    name: 'Village Market',
    type: 'shop',
    bounds: { x: 43, y: 28, width: 17, height: 11 },  // includes storage extension
    objects: [
      { id: 'shelf_1', name: 'Supply Shelf', position: { x: 45, y: 30 }, status: 'stocked' },
      { id: 'register', name: 'Register', position: { x: 56, y: 35 }, status: 'open' },
    ],
  },
  {
    id: 'park',
    name: 'Northern Meadow',
    type: 'park',
    bounds: { x: 6, y: 0, width: 55, height: 2 },
    objects: [
      { id: 'bench_1', name: 'Meadow Bench', position: { x: 32, y: 1 }, status: 'empty' },
    ],
  },
  {
    id: 'plaza',
    name: 'Village Crossroads',
    type: 'plaza',
    bounds: { x: 19, y: 13, width: 8, height: 2 },
    objects: [
      { id: 'notice_board', name: 'Notice Board', position: { x: 22, y: 13 }, status: 'posted' },
    ],
  },
  {
    id: 'garden',
    name: 'Village Garden',
    type: 'park',
    bounds: { x: 6, y: 39, width: 25, height: 6 },
    objects: [
      { id: 'flower_bed', name: 'Flower Bed', position: { x: 16, y: 40 }, status: 'blooming' },
    ],
  },
  {
    id: 'farm',
    name: 'Village Farm',
    type: 'shop',
    bounds: { x: 31, y: 39, width: 25, height: 6 },
    objects: [
      { id: 'crop_field_1', name: 'Wheat Field', position: { x: 39, y: 41 }, status: 'growing' },
    ],
  },
];

// Area entrance positions (walkable tile near each area)
const AREA_ENTRANCES: Record<string, Position> = {
  forest: { x: 3, y: 15 },
  church: { x: 13, y: 12 },       // nave south door
  school: { x: 31, y: 12 },      // main south door
  cafe: { x: 53, y: 12 },        // main south door
  bakery: { x: 13, y: 25 },       // main south door
  town_hall: { x: 31, y: 15 },   // main north entrance
  workshop: { x: 50, y: 25 },    // main south door
  hospital: { x: 13, y: 28 },     // main north entrance
  tavern: { x: 31, y: 28 },      // main north entrance
  market: { x: 50, y: 28 },      // main north entrance
  park: { x: 23, y: 0 },
  plaza: { x: 22, y: 13 },
  garden: { x: 23, y: 40 },
  farm: { x: 41, y: 40 },
};

/**
 * Check if a tile is walkable. Walls (5) and water (2) are NOT walkable.
 */
export function getWalkable(x: number, y: number): boolean {
  if (x < 0 || x >= MAP_WIDTH || y < 0 || y >= MAP_HEIGHT) return false;
  const tile = TILE_MAP[y][x];
  return tile !== 5 && tile !== 2;
}

/**
 * Find the area at a given position.
 */
export function getAreaAt(pos: Position): MapArea | undefined {
  return AREAS.find(area => {
    const b = area.bounds;
    return pos.x >= b.x && pos.x < b.x + b.width &&
           pos.y >= b.y && pos.y < b.y + b.height;
  });
}

/**
 * Get a random walkable tile within an area's bounds.
 * Spreads agents out instead of piling them on one entrance tile.
 */
export function getRandomPositionInArea(areaId: string): Position {
  const area = AREAS.find(a => a.id === areaId);
  if (!area) return getAreaEntrance(areaId);

  const walkable: Position[] = [];
  for (let y = area.bounds.y; y < area.bounds.y + area.bounds.height; y++) {
    for (let x = area.bounds.x; x < area.bounds.x + area.bounds.width; x++) {
      if (getWalkable(x, y)) {
        walkable.push({ x, y });
      }
    }
  }

  // Also include tiles adjacent to the area (±2 tiles) for more spread,
  // but only if they don't belong to a different area
  for (let y = area.bounds.y - 2; y < area.bounds.y + area.bounds.height + 2; y++) {
    for (let x = area.bounds.x - 2; x < area.bounds.x + area.bounds.width + 2; x++) {
      if (getWalkable(x, y) && !walkable.some(p => p.x === x && p.y === y)) {
        const posArea = getAreaAt({ x, y });
        if (!posArea || posArea.id === areaId) {
          walkable.push({ x, y });
        }
      }
    }
  }

  if (walkable.length === 0) return getAreaEntrance(areaId);
  return walkable[Math.floor(Math.random() * walkable.length)];
}

/**
 * Get the walkable entrance tile for an area.
 */
export function getAreaEntrance(areaId: string): Position {
  const entrance = AREA_ENTRANCES[areaId];
  if (entrance) return entrance;
  // Fallback: find center of area bounds and search for nearest walkable
  const area = AREAS.find(a => a.id === areaId);
  if (!area) return { x: 30, y: 22 }; // center of map fallback
  const cx = Math.floor(area.bounds.x + area.bounds.width / 2);
  const cy = Math.floor(area.bounds.y + area.bounds.height / 2);
  // Spiral search for nearest walkable
  for (let r = 0; r < 10; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.abs(dx) === r || Math.abs(dy) === r) {
          if (getWalkable(cx + dx, cy + dy)) {
            return { x: cx + dx, y: cy + dy };
          }
        }
      }
    }
  }
  return { x: cx, y: cy };
}
