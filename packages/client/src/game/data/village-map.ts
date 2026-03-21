export const TILE_TYPES = {
  GRASS: 0,
  PATH: 1,
  WATER: 2,
  SAND: 3,
  FLOOR: 4,
  WALL: 5,
  FOREST: 6,
  FLOWERS: 7,
  BRIDGE: 8,
  FLOOR_DARK: 9,
} as const;

// Must match server/src/map/village.ts exactly
const MAP_WIDTH = 68;
const MAP_HEIGHT = 45;

function buildTileMap(): number[][] {
  const m: number[][] = Array.from({ length: MAP_HEIGHT }, () => Array(MAP_WIDTH).fill(0));

  const X_OFF = 4; // content offset — 4 extra cols on left for forest
  const fill = (sx: number, sy: number, w: number, h: number, t: number) => {
    for (let y = sy; y < sy + h && y < MAP_HEIGHT; y++)
      for (let x = sx + X_OFF; x < sx + X_OFF + w && x < MAP_WIDTH; x++)
        m[y][x] = t;
  };
  const set = (x: number, y: number, t: number) => {
    const ax = x + X_OFF;
    if (y >= 0 && y < MAP_HEIGHT && ax >= 0 && ax < MAP_WIDTH) m[y][ax] = t;
  };

  // Shape-based building helper: takes multiple overlapping rectangles
  // to create non-rectangular silhouettes (L, T, bump shapes).
  // Automatically calculates perimeter walls from the union of rects.
  const buildShape = (
    rects: {x: number, y: number, w: number, h: number}[],
    walls: [string, number, number, number][],
    dark: number[][], doors: number[][], ents: number[][],
  ) => {
    const inShape = (tx: number, ty: number) =>
      rects.some(r => tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h);

    // Fill all rects with floor
    for (const r of rects) fill(r.x, r.y, r.w, r.h, 4);

    // Draw walls on perimeter (any floor tile with a non-shape neighbor)
    for (const r of rects) {
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          if (!inShape(x - 1, y) || !inShape(x + 1, y) || !inShape(x, y - 1) || !inShape(x, y + 1))
            set(x, y, 5);
        }
      }
    }

    // Interior walls
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
    const edge = 5.0 + wave; // varies ~2.8 to ~7.2
    for (let x = 0; x < Math.min(Math.ceil(edge) + 1, MAP_WIDTH); x++) {
      if (x + 0.5 < edge) m[y][x] = 6;
    }
  }

  // Right river with sinusoidal curves (absolute coords, no X_OFF)
  for (let y = 0; y < MAP_HEIGHT; y++) {
    const wave = Math.sin(y * 0.15) * 0.8 + Math.sin(y * 0.35) * 0.4;
    const cx = 63.5 + wave;
    for (let x = 59; x < MAP_WIDTH; x++) {
      const d = Math.abs(x + 0.5 - cx);
      if (d < 1.5) m[y][x] = 2;       // water
      else if (d < 2.8) m[y][x] = 3;  // sand banks
    }
  }

  // Top border flowers (rows 0-1) — uses set() with auto-offset
  const topFlowers = [
    [4,0],[7,0],[12,1],[15,0],[17,1],[22,1],[26,0],[30,0],
    [33,1],[38,1],[42,1],[45,0],[48,1],[50,0],[52,1],
  ];
  for (const [fx, fy] of topFlowers) set(fx, fy, 7);

  // Bottom outdoor flowers (rows 39-44) — uses set() with auto-offset
  for (let y = 39; y < MAP_HEIGHT; y++)
    for (let x = 2; x < 55; x++) {
      const hash = (x * 7 + y * 13) % 13;
      if (hash === 0 || hash === 4 || hash === 9) set(x, y, 7);
    }

  // Scattered flowers along N-S path edges for color
  for (let y = 2; y < 39; y++) {
    if ((y * 3 + 7) % 11 === 0) set(17, y, 7);
    if ((y * 5 + 3) % 11 === 0) set(20, y, 7);
    if ((y * 7 + 2) % 11 === 0) set(36, y, 7);
    if ((y * 4 + 9) % 11 === 0) set(39, y, 7);
  }

  // ═══ Step 2: Paths (2 tiles wide) ═══

  // E-W paths at rows 13-14 and 26-27
  for (let x = 2; x <= 55; x++) {
    set(x, 13, 1); set(x, 14, 1);
    set(x, 26, 1); set(x, 27, 1);
  }

  // N-S paths at cols 18-19 and 37-38 (full height for connectivity)
  for (let y = 0; y < MAP_HEIGHT; y++) {
    set(18, y, 1); set(19, y, 1);
    set(37, y, 1); set(38, y, 1);
  }

  // ═══ Step 3: Buildings (9 total, 3×3 grid, each with UNIQUE non-rectangular silhouette) ═══

  // ── Row 1 (rows 0-12) ──

  // Church — T-shape: tower (7,0,6×3) + nave (2,2,16×11)
  buildShape(
    [{x:2, y:2, w:16, h:11}, {x:7, y:0, w:6, h:3}],
    [['h', 7, 3, 16]],
    [[3, 3, 14, 4]],
    [[8, 7], [9, 7]],
    [[9, 12], [10, 12]],
  );

  // School — L-shape: main (20,4,11×8) + wing (30,2,7×7)
  buildShape(
    [{x:20, y:4, w:11, h:8}, {x:30, y:2, w:7, h:7}],
    [['v', 30, 5, 11]],
    [[31, 3, 5, 4]],
    [[30, 7], [30, 10], [33, 8]],
    [[27, 12], [28, 12]],
  );

  // Cafe — L-shape with left bump: main (42,2,13×11) + counter bump (39,5,4×7)
  buildShape(
    [{x:42, y:2, w:13, h:11}, {x:39, y:5, w:4, h:7}],
    [['v', 48, 3, 11]],
    [[40, 6, 3, 5]],
    [[48, 5], [48, 9], [44, 7]],
    [[49, 12], [50, 12]],
  );

  // ── Row 2 (rows 15-25) ──

  // Bakery — L-shape with top-right oven: main (2,17,14×8) + oven (12,15,6×4)
  buildShape(
    [{x:2, y:17, w:14, h:8}, {x:12, y:15, w:6, h:4}],
    [['h', 21, 3, 14], ['v', 9, 22, 24]],
    [[3, 22, 6, 3]],
    [[7, 21], [8, 21], [13, 21], [9, 23]],
    [[9, 25], [10, 25]],
  );

  // Town Hall — L-shape: main (20,15,17×8) + wing (20,22,9×4)
  buildShape(
    [{x:20, y:15, w:17, h:8}, {x:20, y:22, w:9, h:4}],
    [['v', 28, 16, 22], ['h', 20, 21, 35]],
    [[29, 16, 7, 4]],
    [[28, 18], [28, 24], [25, 20], [32, 20]],
    [[27, 15], [28, 15]],
  );

  // Workshop — chimney bump: main (39,17,15×8) + forge (44,15,5×3)
  buildShape(
    [{x:39, y:17, w:15, h:8}, {x:44, y:15, w:5, h:3}],
    [['h', 21, 40, 52], ['v', 48, 18, 20]],
    [[49, 18, 4, 3]],
    [[48, 19], [44, 21], [45, 21], [51, 21]],
    [[46, 25], [47, 25]],
  );

  // ── Row 3 (rows 28-38) ──

  // Clinic — bump left: main (4,28,11×10) + bump (2,31,3×5)
  buildShape(
    [{x:4, y:28, w:11, h:10}, {x:2, y:31, w:3, h:5}],
    [['v', 9, 29, 36], ['h', 33, 10, 14]],
    [[10, 29, 4, 4]],
    [[9, 31], [9, 35], [12, 33]],
    [[9, 28], [10, 28]],
  );

  // Tavern — L-shape right: main (20,28,14×10) + wing (33,30,4×8)
  buildShape(
    [{x:20, y:28, w:14, h:10}, {x:33, y:30, w:4, h:8}],
    [['v', 28, 29, 37], ['h', 34, 21, 33]],
    [[21, 29, 7, 5], [29, 35, 7, 3]],
    [[28, 31], [28, 36], [24, 34], [33, 33]],
    [[27, 28], [28, 28]],
  );

  // Market — inverted L: main (39,28,17×8) + storage (47,35,8×4)
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

// Buildings — non-rectangular shapes, bounding boxes for labels/shadows
export const BUILDINGS: {
  x: number; y: number; w: number; h: number;
  type: 'house' | 'cafe' | 'shop';
  label?: string;
}[] = [
  { x: 6,  y: 0,  w: 16, h: 13, type: 'house', label: 'Church' },
  { x: 24, y: 2,  w: 17, h: 10, type: 'house', label: 'School' },
  { x: 43, y: 2,  w: 16, h: 11, type: 'cafe',  label: 'Cafe' },
  { x: 6,  y: 15, w: 16, h: 10, type: 'shop',  label: 'Bakery' },
  { x: 24, y: 15, w: 17, h: 11, type: 'house', label: 'Town Hall' },
  { x: 43, y: 15, w: 16, h: 10, type: 'shop',  label: 'Workshop' },
  { x: 6,  y: 28, w: 13, h: 10, type: 'house', label: 'Clinic' },
  { x: 24, y: 28, w: 17, h: 10, type: 'cafe',  label: 'Tavern' },
  { x: 43, y: 28, w: 17, h: 11, type: 'shop',  label: 'Market' },
];

// ~22 trees — perimeter + accents
export const TREES: { x: number; y: number; type: 'oak' | 'pine' | 'cherry' }[] = [
  // Left forest border (absolute positions in forest zone)
  { x: 1, y: 3, type: 'pine' },
  { x: 2, y: 8, type: 'pine' },
  { x: 1, y: 15, type: 'oak' },
  { x: 3, y: 22, type: 'pine' },
  { x: 1, y: 30, type: 'pine' },
  { x: 2, y: 37, type: 'oak' },
  { x: 4, y: 12, type: 'pine' },
  { x: 3, y: 42, type: 'oak' },

  // Northern meadow
  { x: 14, y: 0, type: 'cherry' },
  { x: 32, y: 1, type: 'oak' },
  { x: 52, y: 0, type: 'cherry' },

  // Southern outdoor
  { x: 9, y: 40, type: 'cherry' },
  { x: 19, y: 42, type: 'oak' },
  { x: 29, y: 41, type: 'cherry' },
  { x: 39, y: 40, type: 'cherry' },
  { x: 49, y: 42, type: 'oak' },
  { x: 56, y: 43, type: 'cherry' },

  // River buffer
  { x: 60, y: 5, type: 'oak' },
  { x: 60, y: 18, type: 'pine' },
  { x: 60, y: 32, type: 'oak' },
  { x: 60, y: 42, type: 'pine' },
  { x: 67, y: 10, type: 'pine' },
  { x: 67, y: 35, type: 'oak' },

  // Path edge accents
  { x: 23, y: 0, type: 'cherry' },
  { x: 42, y: 1, type: 'cherry' },
];

// ~45 decorations — more flowers for color variety
export const DECORATIONS: {
  x: number; y: number;
  type: 'flower_red' | 'flower_blue' | 'rock' | 'mushroom' | 'bench' | 'lantern' | 'sign_cafe' | 'sign_shop';
}[] = [
  // Lanterns at path intersections
  { x: 21, y: 13, type: 'lantern' },
  { x: 24, y: 14, type: 'lantern' },
  { x: 40, y: 13, type: 'lantern' },
  { x: 43, y: 14, type: 'lantern' },
  { x: 21, y: 26, type: 'lantern' },
  { x: 24, y: 27, type: 'lantern' },
  { x: 40, y: 26, type: 'lantern' },
  { x: 43, y: 27, type: 'lantern' },

  // Benches along paths
  { x: 14, y: 13, type: 'bench' },
  { x: 34, y: 14, type: 'bench' },
  { x: 54, y: 13, type: 'bench' },
  { x: 14, y: 26, type: 'bench' },
  { x: 34, y: 27, type: 'bench' },
  { x: 54, y: 26, type: 'bench' },

  // Top meadow flowers (dense)
  { x: 7, y: 0, type: 'flower_red' },
  { x: 10, y: 1, type: 'flower_blue' },
  { x: 18, y: 0, type: 'flower_red' },
  { x: 28, y: 1, type: 'flower_blue' },
  { x: 38, y: 0, type: 'flower_red' },
  { x: 44, y: 1, type: 'flower_blue' },
  { x: 48, y: 0, type: 'flower_red' },
  { x: 56, y: 1, type: 'flower_blue' },
  { x: 13, y: 0, type: 'flower_blue' },
  { x: 34, y: 1, type: 'flower_red' },

  // Bottom outdoor flowers (dense, colorful)
  { x: 8, y: 39, type: 'flower_red' },
  { x: 14, y: 40, type: 'flower_blue' },
  { x: 20, y: 41, type: 'flower_red' },
  { x: 26, y: 39, type: 'flower_blue' },
  { x: 34, y: 40, type: 'flower_red' },
  { x: 42, y: 41, type: 'flower_blue' },
  { x: 48, y: 39, type: 'flower_red' },
  { x: 52, y: 42, type: 'flower_blue' },
  { x: 12, y: 43, type: 'flower_red' },
  { x: 24, y: 44, type: 'flower_blue' },
  { x: 38, y: 43, type: 'flower_red' },
  { x: 50, y: 44, type: 'flower_blue' },

  // Forest border (absolute positions)
  { x: 2, y: 10, type: 'mushroom' },
  { x: 3, y: 20, type: 'rock' },
  { x: 2, y: 34, type: 'mushroom' },
  { x: 3, y: 5, type: 'mushroom' },
  { x: 1, y: 42, type: 'rock' },

  // Signs
  { x: 15, y: 13, type: 'sign_shop' },
  { x: 52, y: 14, type: 'sign_cafe' },
  { x: 33, y: 26, type: 'sign_shop' },
];

// ~215 furniture items — thoughtfully planned per-building interiors
export const FURNITURE: {
  x: number; y: number;
  type: 'table' | 'chair' | 'counter' | 'bookshelf' | 'bed' | 'oven' | 'workbench' | 'barrel' | 'altar' | 'desk' | 'pew' | 'blackboard' | 'anvil' | 'fireplace' | 'crate';
}[] = [
  // ═══ Church (T-shape: tower + nave) ═══
  // Tower vestry
  { x: 12, y: 1, type: 'barrel' },
  { x: 15, y: 1, type: 'bookshelf' },
  // Chancel
  { x: 13, y: 3, type: 'altar' },
  { x: 14, y: 3, type: 'altar' },
  { x: 7, y: 3, type: 'bookshelf' },
  { x: 20, y: 3, type: 'bookshelf' },
  { x: 7, y: 5, type: 'barrel' },
  { x: 20, y: 5, type: 'barrel' },
  { x: 10, y: 5, type: 'desk' },
  { x: 17, y: 5, type: 'desk' },
  // Pew rows — west block
  { x: 8, y: 8, type: 'pew' },
  { x: 9, y: 8, type: 'pew' },
  { x: 10, y: 8, type: 'pew' },
  { x: 11, y: 8, type: 'pew' },
  { x: 8, y: 10, type: 'pew' },
  { x: 9, y: 10, type: 'pew' },
  { x: 10, y: 10, type: 'pew' },
  { x: 11, y: 10, type: 'pew' },
  // Pew rows — east block
  { x: 15, y: 8, type: 'pew' },
  { x: 16, y: 8, type: 'pew' },
  { x: 17, y: 8, type: 'pew' },
  { x: 18, y: 8, type: 'pew' },
  { x: 15, y: 10, type: 'pew' },
  { x: 16, y: 10, type: 'pew' },
  { x: 17, y: 10, type: 'pew' },
  { x: 18, y: 10, type: 'pew' },
  // Side
  { x: 20, y: 9, type: 'bookshelf' },

  // ═══ School (L-shape: main + library wing) ═══
  // Teacher's area
  { x: 25, y: 5, type: 'blackboard' },
  { x: 29, y: 5, type: 'desk' },
  // Student desks (3×2 grid)
  { x: 26, y: 7, type: 'desk' },
  { x: 28, y: 7, type: 'desk' },
  { x: 30, y: 7, type: 'desk' },
  { x: 26, y: 9, type: 'desk' },
  { x: 28, y: 9, type: 'desk' },
  { x: 30, y: 9, type: 'desk' },
  // Student chairs
  { x: 26, y: 8, type: 'chair' },
  { x: 28, y: 8, type: 'chair' },
  { x: 30, y: 8, type: 'chair' },
  { x: 26, y: 10, type: 'chair' },
  { x: 28, y: 10, type: 'chair' },
  { x: 30, y: 10, type: 'chair' },
  // Classroom supplies
  { x: 33, y: 5, type: 'bookshelf' },
  { x: 33, y: 10, type: 'barrel' },
  // Library wing
  { x: 35, y: 3, type: 'bookshelf' },
  { x: 37, y: 3, type: 'bookshelf' },
  { x: 39, y: 3, type: 'bookshelf' },
  { x: 39, y: 5, type: 'bookshelf' },
  { x: 39, y: 7, type: 'bookshelf' },
  { x: 36, y: 5, type: 'desk' },
  { x: 36, y: 7, type: 'desk' },
  { x: 36, y: 6, type: 'chair' },

  // ═══ Cafe (L-shape: main + service bump) ═══
  // Service counter (bump area)
  { x: 44, y: 6, type: 'counter' },
  { x: 45, y: 6, type: 'counter' },
  { x: 44, y: 8, type: 'counter' },
  { x: 45, y: 8, type: 'counter' },
  { x: 44, y: 10, type: 'barrel' },
  // Kitchen
  { x: 47, y: 3, type: 'oven' },
  { x: 49, y: 3, type: 'oven' },
  { x: 51, y: 3, type: 'counter' },
  { x: 47, y: 5, type: 'counter' },
  { x: 49, y: 5, type: 'counter' },
  { x: 47, y: 10, type: 'barrel' },
  { x: 51, y: 10, type: 'barrel' },
  // Dining area
  { x: 53, y: 3, type: 'counter' },
  { x: 55, y: 3, type: 'counter' },
  { x: 54, y: 5, type: 'table' },
  { x: 54, y: 7, type: 'table' },
  { x: 54, y: 9, type: 'table' },
  { x: 57, y: 5, type: 'table' },
  { x: 57, y: 7, type: 'table' },
  { x: 57, y: 9, type: 'table' },
  { x: 55, y: 5, type: 'chair' },
  { x: 55, y: 7, type: 'chair' },
  { x: 55, y: 9, type: 'chair' },

  // ═══ Bakery (L-shape: main + oven room) ═══
  // Oven room
  { x: 17, y: 16, type: 'oven' },
  { x: 19, y: 16, type: 'oven' },
  { x: 17, y: 17, type: 'counter' },
  // Shop floor — display counters
  { x: 7, y: 18, type: 'counter' },
  { x: 8, y: 18, type: 'counter' },
  { x: 10, y: 18, type: 'counter' },
  { x: 11, y: 18, type: 'counter' },
  { x: 14, y: 18, type: 'counter' },
  { x: 16, y: 18, type: 'counter' },
  { x: 18, y: 18, type: 'barrel' },
  // Shop floor — seating
  { x: 8, y: 20, type: 'table' },
  { x: 9, y: 20, type: 'chair' },
  { x: 15, y: 20, type: 'table' },
  { x: 16, y: 20, type: 'chair' },
  // West storage
  { x: 7, y: 22, type: 'barrel' },
  { x: 8, y: 22, type: 'barrel' },
  { x: 7, y: 24, type: 'crate' },
  { x: 8, y: 24, type: 'crate' },
  // East storage
  { x: 14, y: 22, type: 'barrel' },
  { x: 16, y: 22, type: 'barrel' },
  { x: 18, y: 22, type: 'counter' },
  { x: 18, y: 24, type: 'barrel' },

  // ═══ Town Hall (L-shape: main + archive wing) ═══
  // Council chamber
  { x: 25, y: 16, type: 'bookshelf' },
  { x: 27, y: 16, type: 'bookshelf' },
  { x: 28, y: 17, type: 'table' },
  { x: 29, y: 17, type: 'table' },
  { x: 30, y: 17, type: 'table' },
  { x: 28, y: 18, type: 'chair' },
  { x: 29, y: 18, type: 'chair' },
  { x: 30, y: 18, type: 'chair' },
  { x: 25, y: 19, type: 'chair' },
  { x: 27, y: 19, type: 'chair' },
  // Records office
  { x: 34, y: 16, type: 'bookshelf' },
  { x: 36, y: 16, type: 'bookshelf' },
  { x: 38, y: 16, type: 'bookshelf' },
  { x: 35, y: 18, type: 'desk' },
  { x: 35, y: 19, type: 'chair' },
  { x: 38, y: 18, type: 'desk' },
  { x: 38, y: 19, type: 'chair' },
  // Lower hall
  { x: 25, y: 21, type: 'chair' },
  { x: 26, y: 21, type: 'chair' },
  { x: 35, y: 21, type: 'bookshelf' },
  { x: 37, y: 21, type: 'bookshelf' },
  { x: 39, y: 21, type: 'bookshelf' },
  // Archive wing
  { x: 25, y: 23, type: 'bookshelf' },
  { x: 27, y: 23, type: 'bookshelf' },
  { x: 29, y: 23, type: 'bookshelf' },
  { x: 31, y: 23, type: 'bookshelf' },
  { x: 26, y: 24, type: 'desk' },
  { x: 30, y: 24, type: 'crate' },

  // ═══ Workshop (chimney bump: main + forge) ═══
  // Forge
  { x: 49, y: 16, type: 'fireplace' },
  { x: 51, y: 16, type: 'anvil' },
  // Main floor
  { x: 44, y: 18, type: 'workbench' },
  { x: 46, y: 18, type: 'workbench' },
  { x: 48, y: 18, type: 'workbench' },
  { x: 50, y: 18, type: 'workbench' },
  { x: 44, y: 20, type: 'barrel' },
  { x: 46, y: 20, type: 'barrel' },
  { x: 50, y: 20, type: 'crate' },
  // Finishing area
  { x: 54, y: 18, type: 'workbench' },
  { x: 56, y: 18, type: 'workbench' },
  { x: 53, y: 20, type: 'barrel' },
  { x: 56, y: 20, type: 'barrel' },
  // Storage
  { x: 44, y: 22, type: 'crate' },
  { x: 45, y: 22, type: 'crate' },
  { x: 47, y: 22, type: 'barrel' },
  { x: 50, y: 22, type: 'workbench' },
  { x: 53, y: 22, type: 'crate' },
  { x: 55, y: 22, type: 'barrel' },
  { x: 56, y: 22, type: 'barrel' },

  // ═══ Clinic (bump left: main + supply closet) ═══
  // Supply closet
  { x: 7, y: 32, type: 'bookshelf' },
  { x: 7, y: 34, type: 'barrel' },
  // Reception
  { x: 9, y: 29, type: 'bookshelf' },
  { x: 11, y: 29, type: 'bookshelf' },
  { x: 10, y: 31, type: 'desk' },
  { x: 10, y: 32, type: 'chair' },
  { x: 12, y: 31, type: 'counter' },
  { x: 12, y: 33, type: 'counter' },
  { x: 9, y: 35, type: 'barrel' },
  { x: 11, y: 36, type: 'chair' },
  // Exam room
  { x: 14, y: 29, type: 'bookshelf' },
  { x: 16, y: 29, type: 'bed' },
  { x: 17, y: 30, type: 'desk' },
  { x: 15, y: 31, type: 'counter' },
  // Recovery ward
  { x: 14, y: 34, type: 'bed' },
  { x: 16, y: 34, type: 'bed' },
  { x: 17, y: 36, type: 'barrel' },
  { x: 14, y: 36, type: 'counter' },

  // ═══ Tavern (L-shape: main + wing) ═══
  // Bar
  { x: 25, y: 29, type: 'counter' },
  { x: 26, y: 29, type: 'counter' },
  { x: 27, y: 29, type: 'counter' },
  { x: 25, y: 31, type: 'barrel' },
  { x: 27, y: 31, type: 'barrel' },
  { x: 25, y: 33, type: 'barrel' },
  // Dining hall
  { x: 30, y: 29, type: 'fireplace' },
  { x: 29, y: 31, type: 'table' },
  { x: 30, y: 31, type: 'chair' },
  { x: 34, y: 30, type: 'table' },
  { x: 35, y: 30, type: 'chair' },
  { x: 34, y: 32, type: 'table' },
  { x: 35, y: 32, type: 'chair' },
  { x: 29, y: 33, type: 'table' },
  { x: 30, y: 33, type: 'chair' },
  // Wing dining
  { x: 38, y: 31, type: 'table' },
  { x: 38, y: 33, type: 'table' },
  { x: 39, y: 31, type: 'chair' },
  // Kitchen
  { x: 25, y: 35, type: 'oven' },
  { x: 27, y: 35, type: 'counter' },
  { x: 25, y: 37, type: 'barrel' },
  // Back room
  { x: 30, y: 35, type: 'barrel' },
  { x: 34, y: 36, type: 'barrel' },
  { x: 36, y: 36, type: 'crate' },
  { x: 38, y: 35, type: 'barrel' },
  { x: 39, y: 35, type: 'barrel' },
  { x: 38, y: 37, type: 'crate' },

  // ═══ Market (inverted L: main + storage) ═══
  // Market stalls
  { x: 44, y: 29, type: 'counter' },
  { x: 46, y: 29, type: 'counter' },
  { x: 48, y: 29, type: 'counter' },
  { x: 45, y: 31, type: 'table' },
  { x: 48, y: 31, type: 'table' },
  { x: 46, y: 31, type: 'crate' },
  { x: 49, y: 31, type: 'crate' },
  { x: 44, y: 33, type: 'counter' },
  { x: 45, y: 33, type: 'counter' },
  { x: 47, y: 33, type: 'barrel' },
  { x: 49, y: 33, type: 'barrel' },
  { x: 51, y: 29, type: 'crate' },
  { x: 52, y: 29, type: 'crate' },
  // Warehouse
  { x: 54, y: 29, type: 'barrel' },
  { x: 56, y: 29, type: 'barrel' },
  { x: 58, y: 29, type: 'barrel' },
  { x: 55, y: 31, type: 'crate' },
  { x: 57, y: 31, type: 'crate' },
  { x: 54, y: 33, type: 'crate' },
  { x: 56, y: 33, type: 'desk' },
  { x: 57, y: 33, type: 'chair' },
  { x: 58, y: 33, type: 'bookshelf' },
  // Bulk storage
  { x: 52, y: 36, type: 'barrel' },
  { x: 54, y: 36, type: 'barrel' },
  { x: 56, y: 36, type: 'crate' },
  { x: 57, y: 37, type: 'crate' },
];
