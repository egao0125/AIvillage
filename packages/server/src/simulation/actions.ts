import type { Position } from '@ai-village/shared';
import { getAreas, getAreaEntrance } from '../map/map-provider.js';
import type { World } from './world.js';

export interface ParsedAction {
  type: 'move' | 'converse' | 'perform' | 'idle';
  target?: string;
  targetPosition?: Position;
  activity?: string;
  duration?: number;
}

// Map of common location name aliases to area IDs
const LOCATION_ALIASES: Record<string, string> = {
  cafe: 'cafe',
  coffee: 'cafe',
  "yuki's cafe": 'cafe',
  church: 'church',
  temple: 'church',
  chapel: 'church',
  hospital: 'hospital',
  clinic: 'hospital',
  'village clinic': 'hospital',
  school: 'school',
  library: 'school',
  'village school': 'school',
  'town hall': 'town_hall',
  'town_hall': 'town_hall',
  townhall: 'town_hall',
  tavern: 'tavern',
  inn: 'tavern',
  bar: 'tavern',
  pub: 'tavern',
  'the hearthstone tavern': 'tavern',
  bakery: 'bakery',
  baker: 'bakery',
  'village bakery': 'bakery',
  workshop: 'workshop',
  craft: 'workshop',
  'craftsman workshop': 'workshop',
  farm: 'farm',
  field: 'farm',
  'village farm': 'farm',
  market: 'market',
  shop: 'market',
  store: 'market',
  'village market': 'market',
  plaza: 'plaza',
  square: 'plaza',
  'village plaza': 'plaza',
  park: 'park',
  'sunrise park': 'park',
  lake: 'lake',
  'mirror lake': 'lake',
  forest: 'forest',
  woods: 'forest',
  'whispering forest': 'forest',
  'southern woods': 'forest_south',
  garden: 'garden',
  'herb garden': 'garden',
  home: '', // resolved per-agent — picks random public area
  house: '', // resolved per-agent
};

function resolveAreaId(name: string): string | undefined {
  const lower = name.toLowerCase().trim();

  // Direct match by area ID
  const areas = getAreas();
  const directMatch = areas.find(a => a.id === lower);
  if (directMatch) return directMatch.id;

  // Check aliases
  if (lower in LOCATION_ALIASES) {
    return LOCATION_ALIASES[lower] || undefined;
  }

  // Fuzzy match by area name
  const fuzzy = areas.find(a => a.name.toLowerCase().includes(lower));
  if (fuzzy) return fuzzy.id;

  return undefined;
}

/**
 * Parse LLM-generated action JSON and resolve to positions.
 * Expected input formats:
 *   {"action": "move_to", "target": "cafe", "reason": "..."}
 *   {"action": "talk_to", "target": "Yuki", "reason": "..."}
 *   {"action": "use_object", "target": "counter", "reason": "..."}
 *   {"action": "wait", "reason": "..."}
 *   {"action": "go_home", "reason": "..."}
 *   {"action": "sleep", "reason": "..."}
 */
export function parseAction(raw: string, world: World): ParsedAction {
  let parsed: Record<string, unknown>;
  try {
    // Strip markdown code fences if present
    const cleaned = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return { type: 'idle', activity: 'thinking', duration: 5 };
  }

  const action = String(parsed.action || '').toLowerCase();
  const target = String(parsed.target || '');
  const reason = String(parsed.reason || '');

  switch (action) {
    case 'move':
    case 'move_to': {
      const areaId = resolveAreaId(target);
      if (areaId) {
        const pos = getAreaEntrance(areaId);
        return {
          type: 'move',
          target: areaId,
          targetPosition: pos,
          activity: reason || `heading to ${target}`,
        };
      }
      // Maybe it's an agent name
      const targetAgent = findAgentByName(target, world);
      if (targetAgent) {
        return {
          type: 'move',
          target: targetAgent.id,
          targetPosition: { ...targetAgent.position },
          activity: reason || `walking toward ${target}`,
        };
      }
      return { type: 'idle', activity: reason || 'looking around', duration: 5 };
    }

    case 'talk':
    case 'talk_to':
    case 'converse': {
      const targetAgent = findAgentByName(target, world);
      if (targetAgent) {
        return {
          type: 'converse',
          target: targetAgent.id,
          targetPosition: { ...targetAgent.position },
          activity: reason || `talking to ${target}`,
        };
      }
      return { type: 'idle', activity: reason || 'looking for someone to talk to', duration: 5 };
    }

    case 'use_object':
    case 'perform': {
      return {
        type: 'perform',
        target,
        activity: reason || target || 'doing something',
        duration: Number(parsed.duration) || 30,
      };
    }

    case 'go_home': {
      // Resolve via agent's homeArea — caller must handle "home" resolution
      return {
        type: 'move',
        target: 'home',
        activity: reason || 'heading home',
      };
    }

    case 'sleep': {
      return {
        type: 'idle',
        activity: 'sleeping',
        duration: 480, // 8 hours
      };
    }

    case 'wait':
    case 'idle':
    default: {
      return {
        type: 'idle',
        activity: reason || 'waiting',
        duration: Number(parsed.duration) || 10,
      };
    }
  }
}

function findAgentByName(name: string, world: World) {
  const lower = name.toLowerCase().trim();
  for (const agent of world.agents.values()) {
    const agentName = agent.config.name.toLowerCase();
    if (agentName === lower || agentName.includes(lower) || lower.includes(agentName.split(' ')[0].toLowerCase())) {
      return agent;
    }
  }
  return undefined;
}
