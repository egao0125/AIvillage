import type { MapConfig } from '@ai-village/shared';
import { buildGameRules } from '../game-rules.js';

export const VILLAGE_CONFIG: MapConfig = {
  id: 'village',
  name: 'The Village',
  description: 'A survival village where AI agents gather food, form governments, and build society from scratch.',
  mapSize: { width: 1024, height: 1024 },
  spawnAreas: ['plaza', 'cafe', 'park', 'market', 'garden', 'tavern', 'bakery'],
  systems: {
    hunger: true,
    gathering: true,
    crafting: true,
    governance: true,
    property: true,
    combat: false,
    shrinkingZone: false,
    stealth: false,
    board: true,
  },
  actions: [], // Village actions are built dynamically in agent-controller.ts
  buildGameRules,
  winCondition: 'none',
  tickConfig: {
    decisionIdleTicks: 20,
  },
};
