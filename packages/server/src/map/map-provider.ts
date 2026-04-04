/**
 * Map-agnostic function provider.
 * All simulation code imports from here instead of village.ts or arena.ts directly.
 * The engine calls setActiveMap() to switch between implementations.
 */
import type { MapArea, Position } from '@ai-village/shared';
import * as village from './village.js';
import * as arena from './arena.js';

export interface MapFunctions {
  getAreaAt: (pos: Position) => MapArea | undefined;
  getAreaEntrance: (areaId: string) => Position;
  getRandomPositionInArea: (areaId: string) => Position;
  getWalkable: (x: number, y: number) => boolean;
  areas: MapArea[];
  mapWidth: number;
  mapHeight: number;
}

const villageFunctions: MapFunctions = {
  getAreaAt: village.getAreaAt,
  getAreaEntrance: village.getAreaEntrance,
  getRandomPositionInArea: village.getRandomPositionInArea,
  getWalkable: village.getWalkable,
  areas: village.AREAS,
  mapWidth: village.MAP_WIDTH,
  mapHeight: village.MAP_HEIGHT,
};

const arenaFunctions: MapFunctions = {
  getAreaAt: arena.getArenaAreaAt,
  getAreaEntrance: arena.getArenaAreaEntrance,
  getRandomPositionInArea: arena.getArenaRandomPositionInArea,
  getWalkable: arena.getArenaWalkable,
  areas: arena.ARENA_MAP_AREAS,
  mapWidth: arena.ARENA_MAP_WIDTH,
  mapHeight: arena.ARENA_MAP_HEIGHT,
};

let active: MapFunctions = villageFunctions;

export function setActiveMap(mapId: string): void {
  if (mapId === 'battle_royale' || mapId === 'werewolf') {
    active = arenaFunctions;
    console.log('[MapProvider] Switched to arena map');
  } else {
    active = villageFunctions;
    console.log('[MapProvider] Switched to village map');
  }
}

// Re-export current active map functions as module-level bindings
// These delegate to `active` so they respect setActiveMap() calls
export function getAreaAt(pos: Position): MapArea | undefined { return active.getAreaAt(pos); }
export function getAreaEntrance(areaId: string): Position { return active.getAreaEntrance(areaId); }
export function getRandomPositionInArea(areaId: string): Position { return active.getRandomPositionInArea(areaId); }
export function getWalkable(x: number, y: number): boolean { return active.getWalkable(x, y); }
export function getAreas(): MapArea[] { return active.areas; }
export function getMapWidth(): number { return active.mapWidth; }
export function getMapHeight(): number { return active.mapHeight; }

// For backward compatibility — constants that delegate
export const MAP_WIDTH_FN = () => active.mapWidth;
export const MAP_HEIGHT_FN = () => active.mapHeight;
