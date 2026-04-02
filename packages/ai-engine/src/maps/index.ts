import type { MapConfig } from '@ai-village/shared';
import { VILLAGE_CONFIG } from './village-config.js';
import { BATTLE_ROYALE_CONFIG } from './battle-royale-config.js';
import { WEREWOLF_CONFIG } from './werewolf-config.js';

export const MAP_REGISTRY: Record<string, MapConfig> = {
  village: VILLAGE_CONFIG,
  battle_royale: BATTLE_ROYALE_CONFIG,
  werewolf: WEREWOLF_CONFIG,
};

export function getMapConfig(id: string): MapConfig {
  return MAP_REGISTRY[id] || VILLAGE_CONFIG;
}
