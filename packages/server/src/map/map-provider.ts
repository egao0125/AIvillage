/**
 * Map-agnostic function provider.
 *
 * Instance-based: each SimulationEngine creates its own MapFunctions via
 * createMapProvider(mapId). There is no module-level "active map" — that
 * would prevent two maps from coexisting in one process.
 */
import type { MapArea, Position } from '@ai-village/shared';
import * as village from './village.js';
import * as arena from './arena.js';

export interface MapFunctions {
  readonly mapId: string;
  getAreaAt: (pos: Position) => MapArea | undefined;
  getAreaEntrance: (areaId: string) => Position;
  getRandomPositionInArea: (areaId: string) => Position;
  getWalkable: (x: number, y: number) => boolean;
  getAreas: () => MapArea[];
  getMapWidth: () => number;
  getMapHeight: () => number;
}

const villageFunctions: Omit<MapFunctions, 'mapId'> = {
  getAreaAt: village.getAreaAt,
  getAreaEntrance: village.getAreaEntrance,
  getRandomPositionInArea: village.getRandomPositionInArea,
  getWalkable: village.getWalkable,
  getAreas: () => village.AREAS,
  getMapWidth: () => village.MAP_WIDTH,
  getMapHeight: () => village.MAP_HEIGHT,
};

const arenaFunctions: Omit<MapFunctions, 'mapId'> = {
  getAreaAt: arena.getArenaAreaAt,
  getAreaEntrance: arena.getArenaAreaEntrance,
  getRandomPositionInArea: arena.getArenaRandomPositionInArea,
  getWalkable: arena.getArenaWalkable,
  getAreas: () => arena.ARENA_MAP_AREAS,
  getMapWidth: () => arena.ARENA_MAP_WIDTH,
  getMapHeight: () => arena.ARENA_MAP_HEIGHT,
};

export function createMapProvider(mapId: string): MapFunctions {
  if (mapId === 'battle_royale' || mapId === 'werewolf') {
    return { mapId, ...arenaFunctions };
  }
  return { mapId, ...villageFunctions };
}
