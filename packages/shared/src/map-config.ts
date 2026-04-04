// ============================================================================
// Map Configuration — defines what systems and actions each game mode uses.
// One codebase, multiple game modes.
// ============================================================================

export interface MapConfig {
  id: string;
  name: string;
  description: string;
  mapSize: { width: number; height: number };
  spawnAreas: string[];
  systems: {
    hunger: boolean;
    gathering: boolean;
    crafting: boolean;
    governance: boolean;
    property: boolean;
    combat: boolean;
    shrinkingZone: boolean;
    stealth: boolean;
    board: boolean;
    werewolf?: boolean;
  };
  actions: MapAction[];
  buildGameRules: () => string;
  winCondition: 'none' | 'last_standing' | 'werewolf';
  tickConfig: {
    decisionIdleTicks: number;
  };
  shrinkingZone?: {
    initialRadius: number;
    shrinkIntervalMinutes: number;
    shrinkAmount: number;
    damagePerMinute: number;
  };
}

export interface MapAction {
  id: string;
  label: string;
  category: 'physical' | 'movement' | 'social' | 'combat'
    | 'survival' | 'rest' | 'creative';
  requiresNearby?: boolean;
  requiresItem?: string;
  requiresTerrain?: string;
}
