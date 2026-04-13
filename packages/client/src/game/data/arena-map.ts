// Werewolf arena — simple isometric plane (30×30 tiles) with campfire at center

export const ARENA_MAP_WIDTH = 30;
export const ARENA_MAP_HEIGHT = 30;

// Legacy tile types — kept for arena-tiles.ts compat (unused)
export const ARENA_TILE_TYPES = {
  WATER: 0, SAND: 1, OPEN: 2, JUNGLE: 3, HIGH_GROUND: 4,
  WALL: 5, SHALLOW_WATER: 6, RUIN_FLOOR: 7, MANGROVE: 8, CAVE: 9,
} as const;

// Spawn areas clustered around the campfire (center = tile 15,15)
export const ARENA_LOCATIONS: {
  id: string; name: string;
  x: number; y: number; width: number; height: number;
}[] = [
  { id: 'clearing', name: 'Clearing', x: 12, y: 12, width: 6, height: 6 },
  { id: 'north_camp', name: 'North Camp', x: 13, y: 7, width: 4, height: 4 },
  { id: 'south_camp', name: 'South Camp', x: 13, y: 19, width: 4, height: 4 },
  { id: 'east_camp', name: 'East Camp', x: 20, y: 13, width: 4, height: 4 },
  { id: 'west_camp', name: 'West Camp', x: 6, y: 13, width: 4, height: 4 },
  { id: 'ne_grove', name: 'Northeast Grove', x: 20, y: 7, width: 4, height: 4 },
  { id: 'nw_grove', name: 'Northwest Grove', x: 6, y: 7, width: 4, height: 4 },
  { id: 'se_grove', name: 'Southeast Grove', x: 20, y: 19, width: 4, height: 4 },
  { id: 'sw_grove', name: 'Southwest Grove', x: 6, y: 19, width: 4, height: 4 },
];
