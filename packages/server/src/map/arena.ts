import type { MapArea, Position } from '@ai-village/shared';

export const ARENA_TILE_SIZE = 32;
export const ARENA_MAP_WIDTH = 96;
export const ARENA_MAP_HEIGHT = 96;

// Tile types for the arena island:
// 0 = water (unwalkable, deep blue)
// 1 = sand/beach (walkable, tan edge)
// 2 = open ground (walkable, light green)
// 3 = jungle/bush (walkable, dark green — provides stealth)
// 4 = high ground (walkable, gray — elevated)
// 5 = wall/ruins (unwalkable, dark gray — blocks movement + LOS)
// 6 = shallow water (walkable but slow, light blue)

export const ARENA_TILE_TYPES = {
  WATER: 0,
  SAND: 1,
  OPEN: 2,
  JUNGLE: 3,
  HIGH_GROUND: 4,
  WALL: 5,
  SHALLOW_WATER: 6,
} as const;

// ── Arena Area definitions ──────────────────────────────────

export interface ArenaArea {
  id: string;
  name: string;
  x: number;      // top-left tile x
  y: number;      // top-left tile y
  width: number;  // area width in tiles
  height: number; // area height in tiles
  terrain: 'open' | 'bush' | 'wall' | 'high_ground' | 'water';
  description: string;
}

export const ARENA_AREAS: ArenaArea[] = [
  { id: 'summit', name: 'Summit',
    x: 44, y: 22, width: 8, height: 8,
    terrain: 'high_ground',
    description: 'Mountain peak. Best view, no cover.' },
  { id: 'watchtower', name: 'Watchtower',
    x: 40, y: 8, width: 10, height: 6,
    terrain: 'high_ground',
    description: 'North edge. High ground, exposed.' },
  { id: 'cliffs', name: 'Cliffs',
    x: 12, y: 16, width: 8, height: 8,
    terrain: 'high_ground',
    description: 'Northwest. Isolated, one way down.' },
  { id: 'ruins', name: 'Ruins',
    x: 68, y: 20, width: 10, height: 8,
    terrain: 'wall',
    description: 'East. Walls give cover. Only hard cover on map.' },
  { id: 'shipwreck', name: 'Shipwreck',
    x: 6, y: 40, width: 10, height: 8,
    terrain: 'open',
    description: 'West beach. Exposed.' },
  { id: 'bamboo_grove', name: 'Bamboo Grove',
    x: 16, y: 40, width: 12, height: 10,
    terrain: 'bush',
    description: 'West-central. Dense cover.' },
  { id: 'clearing', name: 'Clearing',
    x: 40, y: 40, width: 10, height: 8,
    terrain: 'open',
    description: 'Central. Open ground.' },
  { id: 'spring', name: 'Spring',
    x: 46, y: 32, width: 6, height: 6,
    terrain: 'open',
    description: 'Between Summit and Clearing.' },
  { id: 'ravine', name: 'Ravine',
    x: 56, y: 16, width: 8, height: 6,
    terrain: 'open',
    description: 'Narrow pass between Summit and Ruins.' },
  { id: 'lagoon', name: 'Lagoon',
    x: 64, y: 54, width: 12, height: 10,
    terrain: 'water',
    description: 'Southeast. Slow movement.' },
  { id: 'mangroves', name: 'Mangroves',
    x: 38, y: 66, width: 14, height: 10,
    terrain: 'bush',
    description: 'South coast. Stealth but slow.' },
  { id: 'tidal_caves', name: 'Tidal Caves',
    x: 16, y: 58, width: 10, height: 8,
    terrain: 'bush',
    description: 'Southwest. Hidden but dead end.' },
];

// ── Seeded PRNG for deterministic map generation ────────────

function seededRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s & 0x7fffffff) / 0x7fffffff;
  };
}

// ── Tilemap generation ──────────────────────────────────────

export function generateArenaTilemap(): number[][] {
  const W = ARENA_MAP_WIDTH;
  const H = ARENA_MAP_HEIGHT;
  const rng = seededRng(42);
  const map: number[][] = Array.from({ length: H }, () => Array(W).fill(0));

  const CX = 48, CY = 48;
  const BASE_RADIUS = 40;

  // Pre-compute noise offsets for organic island shape
  const angleNoise: number[] = [];
  for (let i = 0; i < 360; i++) {
    angleNoise.push((rng() - 0.5) * 8); // ±4 tile wobble
  }

  // Step 1: Draw island shape
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - CX;
      const dy = y - CY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx);
      const angleDeg = ((angle * 180 / Math.PI) + 360) % 360;
      const idx = Math.floor(angleDeg) % 360;

      // Smooth noise by interpolating between neighboring angles
      const idx2 = (idx + 1) % 360;
      const frac = angleDeg - Math.floor(angleDeg);
      const noise = angleNoise[idx] * (1 - frac) + angleNoise[idx2] * frac;

      const edgeRadius = BASE_RADIUS + noise;

      if (dist < edgeRadius - 3) {
        map[y][x] = 2; // open ground (interior default)
      } else if (dist < edgeRadius) {
        map[y][x] = 1; // sand/beach ring
      }
      // else stays 0 (water)
    }
  }

  // Step 2: Paint jungle zones across center and south
  const jungleZones = [
    { cx: 30, cy: 45, rx: 14, ry: 10 },  // west-central jungle
    { cx: 55, cy: 50, rx: 12, ry: 8 },   // east-central jungle
    { cx: 40, cy: 60, rx: 18, ry: 10 },  // south jungle
    { cx: 25, cy: 55, rx: 10, ry: 8 },   // southwest jungle
    { cx: 60, cy: 40, rx: 8, ry: 6 },    // east jungle patch
  ];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (map[y][x] !== 2) continue; // only paint on open ground
      for (const zone of jungleZones) {
        const dx = (x - zone.cx) / zone.rx;
        const dy = (y - zone.cy) / zone.ry;
        if (dx * dx + dy * dy < 1.0) {
          map[y][x] = 3; // jungle
          break;
        }
      }
    }
  }

  // Step 3: Paint each named location's terrain
  for (const area of ARENA_AREAS) {
    let tileType: number;
    switch (area.terrain) {
      case 'high_ground': tileType = 4; break;
      case 'bush': tileType = 3; break;
      case 'water': tileType = 6; break; // shallow water
      case 'wall': tileType = 2; break;  // interior is open, walls painted separately
      case 'open': tileType = 2; break;
      default: tileType = 2;
    }

    for (let y = area.y; y < area.y + area.height; y++) {
      for (let x = area.x; x < area.x + area.width; x++) {
        if (x >= 0 && x < W && y >= 0 && y < H && map[y][x] !== 0) {
          map[y][x] = tileType;
        }
      }
    }
  }

  // Step 4: Ruins — paint wall border with open interior (rooms/corridors)
  const ruins = ARENA_AREAS.find(a => a.id === 'ruins')!;
  for (let y = ruins.y; y < ruins.y + ruins.height; y++) {
    for (let x = ruins.x; x < ruins.x + ruins.width; x++) {
      if (x >= 0 && x < W && y >= 0 && y < H) {
        // Outer walls
        const isEdge = x === ruins.x || x === ruins.x + ruins.width - 1 ||
                       y === ruins.y || y === ruins.y + ruins.height - 1;
        // Interior walls forming rooms
        const isInteriorWall = (x === ruins.x + 4 && y >= ruins.y + 1 && y <= ruins.y + 5) ||
                               (y === ruins.y + 4 && x >= ruins.x + 1 && x <= ruins.x + 3);

        if (isEdge || isInteriorWall) {
          map[y][x] = 5; // wall
        } else {
          map[y][x] = 2; // open interior
        }
      }
    }
  }
  // Doorways in ruins walls
  const ruinsDoors = [
    [ruins.x, ruins.y + 2],         // west entrance
    [ruins.x + ruins.width - 1, ruins.y + 2], // east entrance
    [ruins.x + 4, ruins.y + 6],     // south passage through interior wall
    [ruins.x + 5, ruins.y],         // north entrance
  ];
  for (const [dx, dy] of ruinsDoors) {
    if (dx >= 0 && dx < W && dy >= 0 && dy < H) {
      map[dy][dx] = 2;
    }
  }

  return map;
}

// Generate once — deterministic
export const ARENA_TILE_MAP: number[][] = generateArenaTilemap();

// ── Walkability ─────────────────────────────────────────────

export function getArenaWalkable(x: number, y: number): boolean {
  if (x < 0 || x >= ARENA_MAP_WIDTH || y < 0 || y >= ARENA_MAP_HEIGHT) return false;
  const tile = ARENA_TILE_MAP[y][x];
  // Water (0) and walls (5) are not walkable
  return tile !== 0 && tile !== 5;
}

// ── Area lookup ─────────────────────────────────────────────

// Convert ArenaArea to MapArea for engine compatibility
function arenaToMapArea(area: ArenaArea): MapArea {
  return {
    id: area.id,
    name: area.name,
    type: 'park', // generic type for engine compat
    bounds: { x: area.x, y: area.y, width: area.width, height: area.height },
    objects: [],
  };
}

export function getArenaAreaAt(pos: Position): MapArea | undefined {
  const area = ARENA_AREAS.find(a =>
    pos.x >= a.x && pos.x < a.x + a.width &&
    pos.y >= a.y && pos.y < a.y + a.height
  );
  return area ? arenaToMapArea(area) : undefined;
}

export function getArenaAreaEntrance(areaId: string): Position {
  const area = ARENA_AREAS.find(a => a.id === areaId);
  if (!area) return { x: 48, y: 48 }; // center fallback

  // Find a walkable tile near the center of the area
  const cx = Math.floor(area.x + area.width / 2);
  const cy = Math.floor(area.y + area.height / 2);

  // Spiral search for nearest walkable
  for (let r = 0; r < 10; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.abs(dx) === r || Math.abs(dy) === r) {
          const nx = cx + dx, ny = cy + dy;
          if (getArenaWalkable(nx, ny)) {
            return { x: nx, y: ny };
          }
        }
      }
    }
  }
  return { x: cx, y: cy };
}

export function getArenaRandomPositionInArea(areaId: string): Position {
  const area = ARENA_AREAS.find(a => a.id === areaId);
  if (!area) return getArenaAreaEntrance(areaId);

  const walkable: Position[] = [];
  for (let y = area.y; y < area.y + area.height; y++) {
    for (let x = area.x; x < area.x + area.width; x++) {
      if (getArenaWalkable(x, y)) {
        walkable.push({ x, y });
      }
    }
  }

  if (walkable.length === 0) return getArenaAreaEntrance(areaId);
  return walkable[Math.floor(Math.random() * walkable.length)];
}

// All arena areas as MapArea[] for engine compatibility
export const ARENA_MAP_AREAS: MapArea[] = ARENA_AREAS.map(arenaToMapArea);
