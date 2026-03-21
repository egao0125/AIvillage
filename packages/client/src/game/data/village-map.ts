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
} as const;

// Must match server/src/map/village.ts exactly
// 40 columns x 30 rows
// prettier-ignore
export const TILE_MAP: number[][] = [
  // Row 0: top edge — forest NW, grass center, park/lake NE
  [6,6,6,6,6,6,6,6,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,3,3,2,2,2,3,3],
  // Row 1: forest, church walls, school walls, lake
  [6,6,6,6,6,6,6,6,0,0,5,5,5,5,5,0,0,0,5,5,5,5,5,0,0,0,0,0,0,0,0,0,3,3,2,2,2,2,3,3],
  // Row 2: forest, church interior, school interior, lake
  [6,6,6,0,6,6,6,6,0,0,5,4,4,4,5,0,0,0,5,4,4,4,5,0,0,0,0,0,0,0,0,3,3,2,2,2,2,2,3,3],
  // Row 3: forest, church interior, school interior, lake
  [6,6,0,0,0,6,6,6,0,0,5,4,4,4,5,0,0,0,5,4,4,4,5,0,0,0,0,0,0,0,0,3,2,2,2,2,2,2,3,0],
  // Row 4: forest, church + school entrances on path, park/lake
  [6,6,6,0,6,6,6,6,0,0,5,5,4,5,5,0,0,0,5,5,4,5,5,0,0,0,0,0,0,0,0,0,3,3,2,2,2,3,3,0],
  // Row 5: forest edge, paths from church/school south, park
  [6,6,6,6,6,6,6,6,0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,3,3,3,3,3,0,0],
  // Row 6: grass, paths continue south
  [6,6,6,6,6,6,6,0,0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  // Row 7: grass, paths continue, north-south connector
  [0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  // Row 8: grass, paths merge into main path area
  [0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  // Row 9: bakery top wall, connector path, workshop top wall
  [0,0,0,5,5,5,5,5,0,0,5,5,5,5,5,0,0,0,0,0,1,0,0,0,5,5,5,5,5,0,0,5,5,5,5,5,0,0,0,0],
  // Row 10: cafe top wall, bakery interior, workshop interior, market top wall
  [0,0,0,5,4,4,4,5,0,0,5,4,4,4,5,0,0,0,0,0,1,0,0,0,5,4,4,4,5,0,0,5,4,4,4,5,0,0,0,0],
  // Row 11: cafe interior, bakery interior, path, workshop interior, market interior
  [0,0,0,5,4,4,4,5,0,0,5,4,4,4,5,0,0,0,0,0,1,0,0,0,5,4,4,4,5,0,0,5,4,4,4,5,0,0,0,0],
  // Row 12: MAIN EAST-WEST PATH — all buildings open onto this row
  [1,1,1,1,4,4,4,1,1,1,1,4,4,4,1,1,1,1,1,1,1,1,1,1,1,4,4,4,1,1,1,1,4,4,4,1,1,1,1,1],
  // Row 13: cafe bottom, bakery bottom, workshop bottom, market bottom
  [0,0,0,5,4,4,4,5,0,0,5,5,5,5,5,0,0,0,0,0,1,0,0,0,5,5,5,5,5,0,0,5,4,4,4,5,0,0,0,0],
  // Row 14: cafe bottom wall, path, market bottom wall
  [0,0,0,5,5,5,5,5,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,5,5,5,5,5,0,0,0,0],
  // Row 15: plaza starts, paths to plaza
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  // Row 16: plaza
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  // Row 17: plaza center
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  // Row 18: plaza
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  // Row 19: plaza
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  // Row 20: plaza ends, path south from plaza
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  // Row 21: hospital top, town hall top, tavern top, farm/garden area
  [0,0,5,5,5,5,5,0,0,5,5,5,5,5,0,0,0,0,1,0,5,5,5,5,5,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  // Row 22: hospital interior, town hall interior, tavern interior, garden/farm
  [0,0,5,4,4,4,5,0,0,5,4,4,4,5,0,0,0,0,1,0,5,4,4,4,5,0,0,7,7,7,7,7,7,0,0,0,6,6,6,6],
  // Row 23: hospital interior, town hall interior, tavern interior, garden/farm
  [0,0,5,4,4,4,5,0,0,5,4,4,4,5,0,0,0,0,1,0,5,4,4,4,5,0,0,7,7,0,0,7,7,0,0,0,6,6,6,6],
  // Row 24: hospital + town hall + tavern entrances on path
  [0,0,1,4,4,4,1,1,1,1,4,4,4,1,1,1,1,1,1,1,1,4,4,4,1,1,1,7,7,0,0,7,7,0,0,0,6,6,6,6],
  // Row 25: paths from buildings, garden, farm area, forest south
  [0,0,0,1,0,0,0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,1,0,0,0,0,0,0,7,7,7,7,0,0,0,6,6,6,6,6],
  // Row 26: grass, farm area, forest
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,6,6,6,6,6],
  // Row 27: farm area continues, forest
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,6,6,6,6,6,6],
  // Row 28: farm field tiles
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,7,7,0,7,7,0,7,7,0,0,0,0,0,6,6,6,6,6,6,6],
  // Row 29: bottom edge, farm fields
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,7,7,0,7,7,0,7,7,0,0,0,0,6,6,6,6,6,6,6,6],
];

// Tree positions with type — placed on forest (6) tiles and scattered on grass (0)
export const TREES: { x: number; y: number; type: 'oak' | 'pine' | 'cherry' }[] = [
  // Dense forest top-left (on type 6 tiles)
  { x: 0, y: 0, type: 'pine' },
  { x: 2, y: 0, type: 'pine' },
  { x: 4, y: 0, type: 'oak' },
  { x: 6, y: 0, type: 'pine' },
  { x: 1, y: 1, type: 'oak' },
  { x: 3, y: 1, type: 'pine' },
  { x: 5, y: 1, type: 'pine' },
  { x: 7, y: 1, type: 'oak' },
  { x: 0, y: 2, type: 'pine' },
  { x: 1, y: 2, type: 'oak' },
  { x: 4, y: 2, type: 'pine' },
  { x: 6, y: 2, type: 'pine' },
  { x: 1, y: 3, type: 'pine' },
  { x: 5, y: 3, type: 'oak' },
  { x: 7, y: 3, type: 'pine' },
  { x: 0, y: 4, type: 'pine' },
  { x: 2, y: 4, type: 'oak' },
  { x: 4, y: 4, type: 'pine' },
  { x: 6, y: 4, type: 'oak' },
  { x: 1, y: 5, type: 'oak' },
  { x: 3, y: 5, type: 'pine' },
  { x: 5, y: 5, type: 'pine' },
  { x: 7, y: 5, type: 'pine' },
  { x: 0, y: 6, type: 'pine' },
  { x: 2, y: 6, type: 'pine' },
  { x: 4, y: 6, type: 'oak' },
  { x: 6, y: 6, type: 'pine' },

  // Scattered village trees (on grass tiles)
  { x: 9, y: 0, type: 'cherry' },
  { x: 27, y: 0, type: 'cherry' },
  { x: 9, y: 7, type: 'oak' },
  { x: 27, y: 6, type: 'cherry' },
  { x: 1, y: 9, type: 'oak' },
  { x: 16, y: 7, type: 'oak' },
  { x: 36, y: 9, type: 'oak' },
  { x: 0, y: 15, type: 'cherry' },
  { x: 10, y: 17, type: 'oak' },
  { x: 27, y: 16, type: 'cherry' },
  { x: 36, y: 16, type: 'oak' },
  { x: 0, y: 26, type: 'oak' },
  { x: 10, y: 27, type: 'cherry' },

  // Park area trees (near lake, on sand/grass)
  { x: 30, y: 0, type: 'cherry' },
  { x: 38, y: 5, type: 'cherry' },
  { x: 30, y: 6, type: 'cherry' },

  // Bottom-right forest (on type 6 tiles)
  { x: 36, y: 22, type: 'pine' },
  { x: 38, y: 22, type: 'pine' },
  { x: 37, y: 23, type: 'oak' },
  { x: 39, y: 23, type: 'pine' },
  { x: 36, y: 24, type: 'pine' },
  { x: 38, y: 24, type: 'pine' },
  { x: 37, y: 25, type: 'oak' },
  { x: 39, y: 25, type: 'pine' },
  { x: 35, y: 26, type: 'pine' },
  { x: 37, y: 26, type: 'pine' },
  { x: 36, y: 27, type: 'oak' },
  { x: 38, y: 27, type: 'pine' },
  { x: 34, y: 28, type: 'pine' },
  { x: 36, y: 28, type: 'pine' },
  { x: 38, y: 28, type: 'pine' },
  { x: 33, y: 29, type: 'pine' },
  { x: 35, y: 29, type: 'oak' },
  { x: 37, y: 29, type: 'pine' },
  { x: 39, y: 29, type: 'pine' },
];

// Decorations placed on appropriate tiles
export const DECORATIONS: {
  x: number;
  y: number;
  type:
    | 'flower_red'
    | 'flower_blue'
    | 'rock'
    | 'mushroom'
    | 'bench'
    | 'lantern'
    | 'sign_cafe'
    | 'sign_shop';
}[] = [
  // Forest mushrooms and rocks (on type 6 tiles)
  { x: 3, y: 2, type: 'mushroom' },
  { x: 7, y: 4, type: 'mushroom' },
  { x: 5, y: 6, type: 'rock' },
  { x: 1, y: 5, type: 'mushroom' },
  { x: 3, y: 7, type: 'rock' },

  // Around church (on grass adjacent)
  { x: 9, y: 1, type: 'flower_red' },
  { x: 15, y: 2, type: 'flower_blue' },

  // Around school (on grass adjacent)
  { x: 17, y: 1, type: 'flower_blue' },
  { x: 23, y: 2, type: 'flower_red' },

  // Park area (on grass/sand near lake)
  { x: 31, y: 5, type: 'bench' },
  { x: 38, y: 4, type: 'bench' },
  { x: 30, y: 4, type: 'flower_red' },

  // Cafe area
  { x: 2, y: 9, type: 'sign_cafe' },
  { x: 2, y: 13, type: 'bench' },
  { x: 9, y: 11, type: 'lantern' },

  // Bakery area
  { x: 9, y: 9, type: 'sign_shop' },
  { x: 15, y: 10, type: 'flower_red' },

  // Workshop area
  { x: 23, y: 9, type: 'sign_shop' },
  { x: 29, y: 10, type: 'lantern' },

  // Market area
  { x: 36, y: 9, type: 'sign_shop' },
  { x: 36, y: 13, type: 'lantern' },

  // Plaza lanterns (around plaza edges)
  { x: 15, y: 15, type: 'lantern' },
  { x: 22, y: 15, type: 'lantern' },
  { x: 15, y: 20, type: 'lantern' },
  { x: 22, y: 20, type: 'lantern' },

  // Hospital area
  { x: 1, y: 21, type: 'flower_red' },
  { x: 7, y: 22, type: 'lantern' },

  // Town Hall area
  { x: 8, y: 21, type: 'sign_shop' },
  { x: 14, y: 22, type: 'flower_blue' },

  // Tavern area
  { x: 19, y: 21, type: 'sign_cafe' },
  { x: 25, y: 22, type: 'lantern' },

  // Garden flowers
  { x: 27, y: 25, type: 'flower_red' },
  { x: 31, y: 25, type: 'flower_blue' },

  // Farm area
  { x: 19, y: 27, type: 'rock' },
  { x: 27, y: 27, type: 'rock' },

  // Bottom-right forest decorations
  { x: 36, y: 25, type: 'mushroom' },
  { x: 38, y: 27, type: 'rock' },
  { x: 34, y: 29, type: 'mushroom' },
];

// Buildings for roof rendering — matches server area bounds
export const BUILDINGS: {
  x: number;
  y: number;
  w: number;
  h: number;
  type: 'house' | 'cafe' | 'shop';
  label?: string;
}[] = [
  { x: 10, y: 1, w: 5, h: 4, type: 'house' },
  { x: 18, y: 1, w: 5, h: 4, type: 'house' },
  { x: 3, y: 9, w: 5, h: 6, type: 'cafe' },
  { x: 10, y: 9, w: 5, h: 5, type: 'shop' },
  { x: 24, y: 9, w: 5, h: 5, type: 'shop' },
  { x: 31, y: 9, w: 5, h: 6, type: 'shop' },
  { x: 2, y: 21, w: 5, h: 4, type: 'house' },
  { x: 9, y: 21, w: 5, h: 4, type: 'house' },
  { x: 20, y: 21, w: 5, h: 4, type: 'cafe' },
];
