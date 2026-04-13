import type { MapArea, Position } from '@ai-village/shared';

export const ARENA_TILE_SIZE = 32;
export const ARENA_MAP_WIDTH = 30;
export const ARENA_MAP_HEIGHT = 30;

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
  { id: 'clearing', name: 'Clearing',
    x: 12, y: 12, width: 6, height: 6,
    terrain: 'open',
    description: 'Central area around the campfire.' },
  { id: 'north_camp', name: 'North Camp',
    x: 13, y: 7, width: 4, height: 4,
    terrain: 'open',
    description: 'North of the campfire.' },
  { id: 'south_camp', name: 'South Camp',
    x: 13, y: 19, width: 4, height: 4,
    terrain: 'open',
    description: 'South of the campfire.' },
  { id: 'east_camp', name: 'East Camp',
    x: 20, y: 13, width: 4, height: 4,
    terrain: 'open',
    description: 'East of the campfire.' },
  { id: 'west_camp', name: 'West Camp',
    x: 6, y: 13, width: 4, height: 4,
    terrain: 'open',
    description: 'West of the campfire.' },
  { id: 'ne_grove', name: 'Northeast Grove',
    x: 20, y: 7, width: 4, height: 4,
    terrain: 'open',
    description: 'Northeast corner.' },
  { id: 'nw_grove', name: 'Northwest Grove',
    x: 6, y: 7, width: 4, height: 4,
    terrain: 'open',
    description: 'Northwest corner.' },
  { id: 'se_grove', name: 'Southeast Grove',
    x: 20, y: 19, width: 4, height: 4,
    terrain: 'open',
    description: 'Southeast corner.' },
  { id: 'sw_grove', name: 'Southwest Grove',
    x: 6, y: 19, width: 4, height: 4,
    terrain: 'open',
    description: 'Southwest corner.' },
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

// Simple flat plane — all tiles are open ground
export function generateArenaTilemap(): number[][] {
  return Array.from({ length: ARENA_MAP_HEIGHT }, () =>
    Array(ARENA_MAP_WIDTH).fill(ARENA_TILE_TYPES.OPEN)
  );
}

// Generate once — deterministic
export const ARENA_TILE_MAP: number[][] = generateArenaTilemap();

// ── Walkability ─────────────────────────────────────────────

// Blocked tiles: campfire + trees/objects (same seeded RNG as client ArenaScene.spawnForest)
const blockedTiles = new Set<string>();
blockedTiles.add('15,15'); // campfire
(() => {
  const cx = ARENA_MAP_WIDTH / 2;
  const cy = ARENA_MAP_HEIGHT / 2;
  let seed = 12345;
  const rng = () => { seed = (seed * 16807 + 0) % 2147483647; return (seed & 0x7fffffff) / 0x7fffffff; };
  // Must match client ArenaScene.spawnForest RNG consumption exactly
  for (let y = 0; y < ARENA_MAP_HEIGHT; y++) {
    for (let x = 0; x < ARENA_MAP_WIDTH; x++) {
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist > 9) {
        if (rng() < 0.4) {
          rng(); rng(); // frame + scale
          blockedTiles.add(`${x},${y}`);
        }
      } else if (dist > 7 && dist <= 9) {
        if (rng() < 0.25) {
          rng(); rng();
          blockedTiles.add(`${x},${y}`);
        }
      } else if (dist > 4 && dist <= 7) {
        if (rng() < 0.08) {
          rng(); rng();
          blockedTiles.add(`${x},${y}`);
        }
      }
    }
  }
})();

export function getArenaWalkable(x: number, y: number): boolean {
  if (x < 0 || x >= ARENA_MAP_WIDTH || y < 0 || y >= ARENA_MAP_HEIGHT) return false;
  if (blockedTiles.has(`${x},${y}`)) return false;
  const tile = ARENA_TILE_MAP[y][x];
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
  if (!area) return { x: 15, y: 15 }; // center fallback

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
