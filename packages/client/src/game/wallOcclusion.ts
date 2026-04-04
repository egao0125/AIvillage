import { TILE_MAP, TILE_TYPES } from './data/village-map';
import { isoDepth } from './iso';

// Pre-built set of wall tile positions for O(1) lookup
const wallSet = new Set<string>();
for (let y = 0; y < TILE_MAP.length; y++) {
  const row = TILE_MAP[y];
  if (!row) continue;
  for (let x = 0; x < row.length; x++) {
    if (row[x] === TILE_TYPES.WALL) {
      wallSet.add(`${x},${y}`);
    }
  }
}

/**
 * Add wall tile keys ("x,y") that occlude an agent at (ax, ay) into the provided set.
 * A wall occludes if it's directly adjacent in the +x/+y direction
 * (within 2 tiles) and has higher isoDepth.
 */
export function collectOccludingWalls(ax: number, ay: number, out: Set<string>): void {
  const rx = Math.round(ax);
  const ry = Math.round(ay);
  const agentDepth = isoDepth(rx, ry);
  for (let dx = 0; dx <= 2; dx++) {
    for (let dy = 0; dy <= 2; dy++) {
      if (dx === 0 && dy === 0) continue;
      const wx = rx + dx;
      const wy = ry + dy;
      const key = `${wx},${wy}`;
      if (isoDepth(wx, wy) > agentDepth && wallSet.has(key)) {
        out.add(key);
      }
    }
  }
}
