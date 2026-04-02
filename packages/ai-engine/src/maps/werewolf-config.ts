import type { MapConfig, MapAction } from '@ai-village/shared';

// ---------------------------------------------------------------------------
// Werewolf Game Rules — shown to ALL agents
// ---------------------------------------------------------------------------

function buildWerewolfRules(): string {
  return `YOU ARE IN A WEREWOLF GAME.

10 agents in a village. 2 are secretly werewolves. One is the sheriff, one is the healer, the rest are villagers.

NIGHT: Villagers sleep. Werewolves eliminate one agent. Sheriff investigates one agent. Healer guards one agent.

DAWN: The village learns who died — or that everyone survived.

DAY: Move freely. Talk at the plaza (public) or anywhere else (private — but someone might overhear). When ready, call a vote.

VOTE: Bell rings. Everyone walks to the plaza. One accusation, one defense, one vote. Majority exiles. Role revealed on exile. One vote per day.

ROLES:
- Werewolf (2): eliminates one per night. Hides identity during the day.
- Sheriff (1): investigates one per night. Learns if they are a werewolf or not.
- Healer (1): guards one per night. Blocks the werewolf attack if they guard the target.
- Villager: sleeps at night. Deduces during the day.

DAY ACTIONS:
- move_to [location] — walk to a location
- talk [name] — start conversation with a nearby agent
- accuse [name] — publicly accuse someone of being a werewolf
- defend — publicly defend yourself or someone else
- share_info — share what you know publicly
- reveal_role — reveal your special role (risky — makes you a target)
- whisper [name] — private word with someone (others see you whispering but not the content)
- follow [name] — follow someone discreetly
- call_vote — ring the bell, everyone walks to plaza for a vote

VOTE: vote_exile or vote_save. Majority exiles.

WIN: Villagers win when all werewolves are exiled. Werewolves win when they equal or outnumber villagers.

WHAT TO NOTICE:
- Who changed their story between days?
- Who always votes together?
- Who whispers to whom?
- Who accuses too quickly or too loudly?

Your action menu IS your reality.`;
}

// ---------------------------------------------------------------------------
// Actions — full set, filtered by phase at runtime by PhaseManager
// ---------------------------------------------------------------------------

const WEREWOLF_ACTIONS: MapAction[] = [
  // Movement (all phases)
  { id: 'move_to', label: 'Move to location', category: 'movement' },

  // Night — werewolf only
  { id: 'attack', label: 'Attack target', category: 'combat', requiresNearby: true },

  // Night — sheriff only
  { id: 'investigate', label: 'Investigate agent', category: 'social', requiresNearby: true },

  // Night — healer only
  { id: 'guard', label: 'Guard agent', category: 'survival', requiresNearby: true },

  // Day — social
  { id: 'talk', label: 'Talk to nearby agent', category: 'social', requiresNearby: true },
  { id: 'accuse', label: 'Publicly accuse', category: 'social' },
  { id: 'defend', label: 'Defend publicly', category: 'social' },
  { id: 'share_info', label: 'Share info publicly', category: 'social' },
  { id: 'reveal_role', label: 'Reveal your role', category: 'social' },
  { id: 'whisper', label: 'Whisper privately', category: 'social', requiresNearby: true },
  { id: 'observe', label: 'Watch who is talking', category: 'social' },
  { id: 'think', label: 'Reflect on evidence', category: 'rest' },
  { id: 'follow', label: 'Follow someone', category: 'movement', requiresNearby: true },

  // Vote trigger
  { id: 'call_vote', label: 'Call a vote', category: 'social' },

  // Vote phase
  { id: 'vote_exile', label: 'Vote to exile', category: 'social' },
  { id: 'vote_save', label: 'Vote to save', category: 'social' },

  // Always
  { id: 'rest', label: 'Rest / Wait', category: 'rest' },
];

// ---------------------------------------------------------------------------
// MapConfig
// ---------------------------------------------------------------------------

export const WEREWOLF_CONFIG: MapConfig = {
  id: 'werewolf',
  name: 'Werewolf Village',
  description: 'Hidden roles. Night hunts. Day deduction. Find the werewolves before they eliminate everyone.',
  mapSize: { width: 96, height: 96 },
  spawnAreas: [
    'clearing', 'ruins', 'bamboo_grove', 'spring',
    'summit', 'lagoon', 'mangroves', 'ravine',
  ],
  systems: {
    hunger: false,
    gathering: false,
    crafting: false,
    governance: false,
    property: false,
    combat: false,
    shrinkingZone: false,
    stealth: false,
    board: false,
    werewolf: true,
  },
  actions: WEREWOLF_ACTIONS,
  buildGameRules: buildWerewolfRules,
  winCondition: 'werewolf',
  tickConfig: {
    decisionIdleTicks: 8,
  },
};
