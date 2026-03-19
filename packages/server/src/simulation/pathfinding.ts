import type { Position } from '@ai-village/shared';

interface Node {
  x: number;
  y: number;
  g: number; // cost from start
  h: number; // heuristic to end
  f: number; // g + h
  parent: Node | null;
}

/**
 * A* pathfinding on a 2D grid.
 * 4-directional movement. Manhattan distance heuristic.
 * Returns array of positions from start to end (inclusive), or empty array if no path found.
 */
export function findPath(
  start: Position,
  end: Position,
  isWalkable: (x: number, y: number) => boolean,
  mapWidth: number,
  mapHeight: number,
): Position[] {
  // Clamp positions to map bounds
  const sx = Math.max(0, Math.min(mapWidth - 1, Math.round(start.x)));
  const sy = Math.max(0, Math.min(mapHeight - 1, Math.round(start.y)));
  const ex = Math.max(0, Math.min(mapWidth - 1, Math.round(end.x)));
  const ey = Math.max(0, Math.min(mapHeight - 1, Math.round(end.y)));

  // If start equals end, return single position
  if (sx === ex && sy === ey) {
    return [{ x: sx, y: sy }];
  }

  // If end is not walkable, return empty
  if (!isWalkable(ex, ey)) {
    return [];
  }

  const key = (x: number, y: number) => y * mapWidth + x;

  const openSet: Node[] = [];
  const closedSet = new Set<number>();
  const gScores = new Map<number, number>();

  const startNode: Node = {
    x: sx,
    y: sy,
    g: 0,
    h: Math.abs(ex - sx) + Math.abs(ey - sy),
    f: Math.abs(ex - sx) + Math.abs(ey - sy),
    parent: null,
  };

  openSet.push(startNode);
  gScores.set(key(sx, sy), 0);

  const directions = [
    { dx: 0, dy: -1 }, // up
    { dx: 1, dy: 0 },  // right
    { dx: 0, dy: 1 },  // down
    { dx: -1, dy: 0 }, // left
  ];

  while (openSet.length > 0) {
    // Find node with lowest f score
    let lowestIdx = 0;
    for (let i = 1; i < openSet.length; i++) {
      if (openSet[i].f < openSet[lowestIdx].f) {
        lowestIdx = i;
      }
    }

    const current = openSet[lowestIdx];

    // Check if we reached the end
    if (current.x === ex && current.y === ey) {
      // Reconstruct path
      const path: Position[] = [];
      let node: Node | null = current;
      while (node) {
        path.unshift({ x: node.x, y: node.y });
        node = node.parent;
      }
      return path;
    }

    // Move current from open to closed
    openSet.splice(lowestIdx, 1);
    const currentKey = key(current.x, current.y);
    closedSet.add(currentKey);

    // Explore neighbors
    for (const dir of directions) {
      const nx = current.x + dir.dx;
      const ny = current.y + dir.dy;

      // Bounds check
      if (nx < 0 || nx >= mapWidth || ny < 0 || ny >= mapHeight) continue;

      // Walkability check
      if (!isWalkable(nx, ny)) continue;

      const neighborKey = key(nx, ny);

      // Skip if already evaluated
      if (closedSet.has(neighborKey)) continue;

      const tentativeG = current.g + 1;

      const existingG = gScores.get(neighborKey);
      if (existingG !== undefined && tentativeG >= existingG) continue;

      gScores.set(neighborKey, tentativeG);

      const h = Math.abs(ex - nx) + Math.abs(ey - ny);
      const newNode: Node = {
        x: nx,
        y: ny,
        g: tentativeG,
        h,
        f: tentativeG + h,
        parent: current,
      };

      // Check if this neighbor is already in open set
      const existingIdx = openSet.findIndex(n => n.x === nx && n.y === ny);
      if (existingIdx >= 0) {
        openSet[existingIdx] = newNode;
      } else {
        openSet.push(newNode);
      }
    }
  }

  // No path found
  return [];
}
