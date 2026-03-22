/** Client-side area lookup — mirrors server AREAS bounds */

interface AreaDef {
  name: string;
  bounds: { x: number; y: number; width: number; height: number };
}

const AREAS: AreaDef[] = [
  { name: 'Whispering Forest', bounds: { x: 0, y: 0, width: 6, height: 45 } },
  { name: 'Village Church', bounds: { x: 6, y: 0, width: 16, height: 13 } },
  { name: 'Village School', bounds: { x: 24, y: 2, width: 17, height: 10 } },
  { name: 'Village Cafe', bounds: { x: 43, y: 2, width: 16, height: 11 } },
  { name: 'Village Bakery', bounds: { x: 6, y: 15, width: 16, height: 10 } },
  { name: 'Town Hall', bounds: { x: 24, y: 15, width: 17, height: 11 } },
  { name: 'Craftsman Workshop', bounds: { x: 43, y: 15, width: 16, height: 10 } },
  { name: 'Village Clinic', bounds: { x: 6, y: 28, width: 13, height: 10 } },
  { name: 'The Hearthstone Tavern', bounds: { x: 24, y: 28, width: 17, height: 10 } },
  { name: 'Village Market', bounds: { x: 43, y: 28, width: 17, height: 11 } },
  { name: 'Northern Meadow', bounds: { x: 6, y: 0, width: 55, height: 2 } },
  { name: 'Village Crossroads', bounds: { x: 19, y: 13, width: 8, height: 2 } },
  { name: 'Village Garden', bounds: { x: 6, y: 39, width: 25, height: 6 } },
  { name: 'Village Farm', bounds: { x: 31, y: 39, width: 25, height: 6 } },
];

export function getAreaName(x: number, y: number): string {
  for (const area of AREAS) {
    const b = area.bounds;
    if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) {
      return area.name;
    }
  }
  return 'Outdoors';
}
