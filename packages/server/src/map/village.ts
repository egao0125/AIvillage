import type { MapArea, Position } from '@ai-village/shared';

export const TILE_SIZE = 32;
export const MAP_WIDTH = 40;
export const MAP_HEIGHT = 30;

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

export const AREAS: MapArea[] = [
  // Forest (top-left / north)
  {
    id: 'forest',
    name: 'Whispering Forest',
    type: 'forest',
    bounds: { x: 0, y: 0, width: 8, height: 8 },
    objects: [
      { id: 'tree_1', name: 'Old Oak', position: { x: 2, y: 2 }, status: 'standing' },
      { id: 'tree_2', name: 'Pine Tree', position: { x: 5, y: 1 }, status: 'standing' },
      { id: 'mushroom_1', name: 'Mushroom Patch', position: { x: 3, y: 5 }, status: 'growing' },
    ],
  },
  // Church (top-center-left)
  {
    id: 'church',
    name: 'Village Church',
    type: 'house',
    bounds: { x: 10, y: 1, width: 5, height: 4 },
    objects: [
      { id: 'altar', name: 'Altar', position: { x: 12, y: 2 }, status: 'consecrated' },
      { id: 'pew_1', name: 'Pew', position: { x: 11, y: 3 }, status: 'empty' },
    ],
  },
  // School (top-center-right)
  {
    id: 'school',
    name: 'Village School',
    type: 'house',
    bounds: { x: 18, y: 1, width: 5, height: 4 },
    objects: [
      { id: 'chalkboard', name: 'Chalkboard', position: { x: 20, y: 2 }, status: 'written on' },
      { id: 'bookshelf', name: 'Library Shelf', position: { x: 19, y: 3 }, status: 'stocked' },
    ],
  },
  // Park (top-right)
  {
    id: 'park',
    name: 'Sunrise Park',
    type: 'park',
    bounds: { x: 30, y: 0, width: 10, height: 7 },
    objects: [
      { id: 'bench_1', name: 'Park Bench', position: { x: 32, y: 5 }, status: 'empty' },
    ],
  },
  // Lake (top-right, inside park area)
  {
    id: 'lake',
    name: 'Mirror Lake',
    type: 'lake',
    bounds: { x: 33, y: 0, width: 6, height: 5 },
    objects: [],
  },
  // Cafe (left-center)
  {
    id: 'cafe',
    name: 'Village Cafe',
    type: 'cafe',
    bounds: { x: 3, y: 9, width: 5, height: 6 },
    objects: [
      { id: 'counter', name: 'Counter', position: { x: 4, y: 10 }, status: 'open' },
      { id: 'table_1', name: 'Table', position: { x: 6, y: 10 }, status: 'empty' },
      { id: 'table_2', name: 'Table', position: { x: 6, y: 13 }, status: 'empty' },
    ],
  },
  // Bakery (center-left, next to cafe)
  {
    id: 'bakery',
    name: 'Village Bakery',
    type: 'shop',
    bounds: { x: 10, y: 9, width: 5, height: 5 },
    objects: [
      { id: 'oven', name: 'Bread Oven', position: { x: 12, y: 10 }, status: 'warm' },
      { id: 'display', name: 'Bread Display', position: { x: 11, y: 11 }, status: 'stocked' },
    ],
  },
  // Workshop (center-right)
  {
    id: 'workshop',
    name: 'Craftsman Workshop',
    type: 'shop',
    bounds: { x: 24, y: 9, width: 5, height: 5 },
    objects: [
      { id: 'workbench', name: 'Workbench', position: { x: 26, y: 10 }, status: 'in use' },
      { id: 'tool_rack', name: 'Tool Rack', position: { x: 25, y: 11 }, status: 'stocked' },
    ],
  },
  // Market (right-center, old shop position)
  {
    id: 'market',
    name: 'Village Market',
    type: 'shop',
    bounds: { x: 31, y: 9, width: 5, height: 6 },
    objects: [
      { id: 'shelf_1', name: 'Supply Shelf', position: { x: 32, y: 10 }, status: 'stocked' },
      { id: 'register', name: 'Register', position: { x: 34, y: 10 }, status: 'open' },
    ],
  },
  // Plaza (center)
  {
    id: 'plaza',
    name: 'Village Plaza',
    type: 'plaza',
    bounds: { x: 16, y: 15, width: 6, height: 6 },
    objects: [
      { id: 'fountain', name: 'Fountain', position: { x: 19, y: 17 }, status: 'flowing' },
      { id: 'notice_board', name: 'Notice Board', position: { x: 16, y: 15 }, status: 'posted' },
    ],
  },
  // Hospital (bottom-left)
  {
    id: 'hospital',
    name: 'Village Clinic',
    type: 'house',
    bounds: { x: 2, y: 21, width: 5, height: 4 },
    objects: [
      { id: 'medical_bed', name: 'Medical Bed', position: { x: 4, y: 22 }, status: 'empty' },
      { id: 'medicine_shelf', name: 'Medicine Shelf', position: { x: 3, y: 23 }, status: 'stocked' },
    ],
  },
  // Town Hall (bottom-center-left)
  {
    id: 'town_hall',
    name: 'Town Hall',
    type: 'house',
    bounds: { x: 9, y: 21, width: 5, height: 4 },
    objects: [
      { id: 'mayor_desk', name: 'Mayor\'s Desk', position: { x: 11, y: 22 }, status: 'occupied' },
      { id: 'town_notice', name: 'Town Notice Board', position: { x: 10, y: 23 }, status: 'posted' },
    ],
  },
  // Tavern (bottom-center)
  {
    id: 'tavern',
    name: 'The Hearthstone Tavern',
    type: 'cafe',
    bounds: { x: 20, y: 21, width: 5, height: 4 },
    objects: [
      { id: 'bar_counter', name: 'Bar Counter', position: { x: 22, y: 22 }, status: 'open' },
      { id: 'tavern_table', name: 'Tavern Table', position: { x: 21, y: 23 }, status: 'empty' },
      { id: 'fireplace', name: 'Fireplace', position: { x: 23, y: 22 }, status: 'burning' },
    ],
  },
  // Garden (bottom-center-right)
  {
    id: 'garden',
    name: 'Herb Garden',
    type: 'park',
    bounds: { x: 27, y: 22, width: 6, height: 4 },
    objects: [
      { id: 'herb_patch', name: 'Herb Patch', position: { x: 28, y: 23 }, status: 'growing' },
      { id: 'flower_bed', name: 'Flower Bed', position: { x: 31, y: 23 }, status: 'blooming' },
    ],
  },
  // Farm (bottom-center, south of path)
  {
    id: 'farm',
    name: 'Village Farm',
    type: 'shop',
    bounds: { x: 18, y: 27, width: 10, height: 3 },
    objects: [
      { id: 'crop_field_1', name: 'Wheat Field', position: { x: 20, y: 28 }, status: 'growing' },
      { id: 'crop_field_2', name: 'Vegetable Patch', position: { x: 24, y: 28 }, status: 'growing' },
      { id: 'scarecrow', name: 'Scarecrow', position: { x: 22, y: 29 }, status: 'standing' },
    ],
  },
  // Forest (bottom-right / south)
  {
    id: 'forest_south',
    name: 'Southern Woods',
    type: 'forest',
    bounds: { x: 34, y: 22, width: 6, height: 8 },
    objects: [
      { id: 'tree_3', name: 'Cedar Tree', position: { x: 37, y: 24 }, status: 'standing' },
    ],
  },
];

// Area entrance positions (walkable tile near each area)
const AREA_ENTRANCES: Record<string, Position> = {
  forest: { x: 3, y: 7 },
  church: { x: 12, y: 5 },
  school: { x: 20, y: 5 },
  park: { x: 32, y: 5 },
  lake: { x: 33, y: 5 },
  cafe: { x: 4, y: 12 },
  bakery: { x: 11, y: 12 },
  workshop: { x: 25, y: 12 },
  market: { x: 32, y: 12 },
  plaza: { x: 18, y: 15 },
  hospital: { x: 3, y: 24 },
  town_hall: { x: 10, y: 24 },
  tavern: { x: 21, y: 24 },
  garden: { x: 27, y: 24 },
  farm: { x: 20, y: 27 },
  forest_south: { x: 36, y: 22 },
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

  // Also include tiles adjacent to the area (±2 tiles) for more spread
  for (let y = area.bounds.y - 2; y < area.bounds.y + area.bounds.height + 2; y++) {
    for (let x = area.bounds.x - 2; x < area.bounds.x + area.bounds.width + 2; x++) {
      if (getWalkable(x, y) && !walkable.some(p => p.x === x && p.y === y)) {
        walkable.push({ x, y });
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
  if (!area) return { x: 20, y: 12 }; // center of map fallback
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
