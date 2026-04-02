import type { MapConfig } from '@ai-village/shared';

function buildBattleRoyaleRules(): string {
  return `YOU ARE A CONTESTANT IN A BATTLE ROYALE.

You have a body. It can be tagged, trapped, and eliminated. Elimination is permanent. Last one standing wins.

Each turn you pick ONE action from a menu. The menu shows everything you can do right now. Your action menu IS your reality.

ARENA:
The arena is a 96x96 island surrounded by water. Locations: Summit (mountain peak, exposed), Watchtower (north, high ground), Cliffs (northwest, isolated), Ruins (east, only hard cover), Shipwreck (west beach), Bamboo Grove (dense cover), Clearing (central, open), Spring (between Summit and Clearing), Ravine (narrow pass), Lagoon (southeast, slow movement), Mangroves (south coast, stealth), Tidal Caves (southwest, dead end). The zone shrinks every 5 minutes — if you're outside the safe zone, you take 10 damage per minute.

ELIMINATION:
Tag another player within 3 tiles to eliminate them. They are gone permanently. Their items drop where they fell.

PERCEPTION:
- You can see players within 5 tiles (line of sight)
- Sneaking reduces your detection range to 2 tiles
- Scouting reveals all players within 8 tiles for one turn
- Hiding makes you invisible unless someone is within 2 tiles

ALLIANCES:
- You can ally with ONE player at a time
- Alliances are temporary — only one can win
- Betraying an ally = instant tag attempt (80% success)
- Allied players share vision range

ITEMS (found by searching):
- Shield: blocks one tag attempt, then breaks
- Trap: place on ground, tags first player who steps on it
- Speed Boost: double movement range for 3 turns

ACTIONS:
- move_to — walk to a location (3 tiles)
- run_to — sprint to a location (5 tiles, visible to everyone)
- sneak_to — move quietly (2 tiles, hard to detect)
- tag — attempt to eliminate a nearby player (within 3 tiles)
- ambush — hide and auto-tag the next player who comes within 2 tiles
- hide — become invisible (broken by movement or nearby player)
- scout — reveal all players within 8 tiles
- use_shield — activate shield (blocks next tag)
- place_trap — set a trap at current location
- flee — emergency sprint away (6 tiles, random direction)
- talk — communicate with nearby player
- ally — propose alliance with nearby player
- betray — instant tag attempt on ally (80% success)
- signal — send visible signal to ally
- stalk — follow a player at distance (stay 4 tiles behind)
- rest — recover energy (+10)

WINNING:
Be the last player standing. There is no cooperation victory. There is no escape. Only one survives.

Your action menu IS your reality.`;
}

export const BATTLE_ROYALE_CONFIG: MapConfig = {
  id: 'battle_royale',
  name: 'Battle Royale',
  description: 'Tag or be tagged. Agents hunt, hide, form alliances, and betray. The arena shrinks. Last one standing wins.',
  mapSize: { width: 96, height: 96 },
  spawnAreas: [
    'summit', 'watchtower', 'cliffs', 'ruins', 'shipwreck', 'bamboo_grove',
    'clearing', 'spring', 'ravine', 'lagoon', 'mangroves', 'tidal_caves',
  ],
  systems: {
    hunger: false,
    gathering: false,
    crafting: false,
    governance: false,
    property: false,
    combat: true,
    shrinkingZone: true,
    stealth: true,
    board: false,
    werewolf: false,
  },
  actions: [
    { id: 'move_to', label: 'Move (3 tiles)', category: 'movement' },
    { id: 'run_to', label: 'Sprint (5 tiles, visible)', category: 'movement' },
    { id: 'sneak_to', label: 'Sneak (2 tiles, quiet)', category: 'movement' },
    { id: 'tag', label: 'Tag (eliminate nearby)', category: 'combat', requiresNearby: true },
    { id: 'ambush', label: 'Ambush (auto-tag next arrival)', category: 'combat' },
    { id: 'hide', label: 'Hide (invisible)', category: 'survival' },
    { id: 'scout', label: 'Scout (reveal 8 tiles)', category: 'survival' },
    { id: 'use_shield', label: 'Activate Shield', category: 'survival', requiresItem: 'shield' },
    { id: 'place_trap', label: 'Place Trap', category: 'combat', requiresItem: 'trap' },
    { id: 'flee', label: 'Flee (6 tiles, random)', category: 'movement' },
    { id: 'talk', label: 'Talk to nearby', category: 'social', requiresNearby: true },
    { id: 'ally', label: 'Propose alliance', category: 'social', requiresNearby: true },
    { id: 'betray', label: 'Betray ally (80% tag)', category: 'combat', requiresNearby: true },
    { id: 'signal', label: 'Signal ally', category: 'social' },
    { id: 'stalk', label: 'Stalk player', category: 'movement', requiresNearby: true },
    { id: 'rest', label: 'Rest (+10 energy)', category: 'rest' },
  ],
  buildGameRules: buildBattleRoyaleRules,
  winCondition: 'last_standing',
  tickConfig: {
    decisionIdleTicks: 15,
  },
  shrinkingZone: {
    initialRadius: 32,
    shrinkIntervalMinutes: 5,
    shrinkAmount: 4,
    damagePerMinute: 10,
  },
};
