// ============================================================================
// Asymmetric Starting Knowledge
// Each agent spawns knowing only their area + adjacent areas.
// Discovery happens through exploration, conversation, and nightly reflection.
// ============================================================================

/**
 * Which areas are visible/adjacent from each area (based on physical tile layout).
 * Includes phantom areas (lake, forest_south) that exist in game logic but not in the tile map.
 */
export const AREA_ADJACENCY: Record<string, string[]> = {
  forest:       ['church', 'park', 'bakery', 'hospital', 'garden'],
  church:       ['forest', 'park', 'plaza', 'bakery', 'school'],
  school:       ['park', 'church', 'cafe', 'plaza', 'town_hall'],
  cafe:         ['park', 'school', 'workshop'],
  park:         ['forest', 'church', 'school', 'cafe'],
  plaza:        ['church', 'bakery', 'town_hall', 'school', 'tavern'],
  bakery:       ['forest', 'church', 'plaza', 'town_hall', 'hospital'],
  town_hall:    ['plaza', 'bakery', 'workshop', 'school', 'tavern'],
  workshop:     ['cafe', 'town_hall', 'market'],
  hospital:     ['forest', 'bakery', 'tavern', 'garden'],
  tavern:       ['plaza', 'town_hall', 'hospital', 'market', 'garden', 'farm'],
  market:       ['workshop', 'tavern', 'farm'],
  garden:       ['forest', 'hospital', 'tavern', 'farm'],
  farm:         ['garden', 'tavern', 'market'],
  lake:         ['farm', 'garden', 'forest'],
  forest_south: ['forest', 'garden'],
};

/**
 * One-line description for each area (matches the GLOBAL_PROMPT PLACES entries).
 */
export const AREA_DESCRIPTIONS: Record<string, string> = {
  bakery:       'Bakery — a building with a bread oven.',
  cafe:         'Cafe — a building with tables and a stove.',
  workshop:     'Workshop — a building with a workbench and tool rack.',
  market:       'Market — an open area with stalls.',
  hospital:     'Clinic — a building with beds.',
  tavern:       'Tavern — a building with a bar counter and fireplace.',
  church:       'Church — a quiet building with pews.',
  school:       'School — a building with a chalkboard and desks.',
  town_hall:    'Town Hall — a large building with a meeting hall.',
  farm:         'Farm — open fields. Wheat and vegetables grow here.',
  garden:       'Garden — herb patches and flowers grow wild here.',
  forest:       'Forest — tall trees, mushrooms on the ground.',
  forest_south: 'Southern Woods — dense cedar trees, remote.',
  lake:         'Lake — open water with fish, clay on the banks.',
  park:         'Park — open grass and benches.',
  plaza:        'Plaza — a stone fountain, open space, and a wooden board where anyone can post a message for the whole village to read.',
};

/** Human-readable area name for the MY EXPERIENCE section. */
function areaDisplayName(areaId: string): string {
  const desc = AREA_DESCRIPTIONS[areaId];
  if (!desc) return areaId;
  return desc.split(' — ')[0];
}

/** Build action examples using only locations the agent knows about. */
function buildActionExamples(knownAreas: string[]): string {
  const examples: string[] = [];

  // Gather
  if (knownAreas.includes('farm'))        examples.push('[ACTION: gather wheat at the farm]');
  else if (knownAreas.includes('forest')) examples.push('[ACTION: gather wood at the forest]');
  else if (knownAreas.includes('garden')) examples.push('[ACTION: gather herbs at the garden]');
  else if (knownAreas.includes('lake'))   examples.push('[ACTION: gather fish at the lake]');
  else                                    examples.push('[ACTION: gather resources nearby]');

  // Craft / cook
  if (knownAreas.includes('workshop'))      examples.push('[ACTION: craft rope at the workshop]');
  else if (knownAreas.includes('bakery'))   examples.push('[ACTION: bake bread at the bakery]');
  else if (knownAreas.includes('cafe'))     examples.push('[ACTION: cook stew at the cafe]');
  else                                      examples.push('[ACTION: craft something useful]');

  // Trade — always generic, no names
  examples.push('[ACTION: trade 3 wheat for 2 fish with someone nearby]');

  // Build
  examples.push('[ACTION: build wooden shelter]');

  return examples.map(e => '  ' + e).join('\n');
}

/**
 * Build a customized starting worldView for a newly spawned agent.
 * The agent knows only their spawn area + adjacent areas.
 * Physics (REALITY) are universal; geography (PLACES) is local.
 */
export function buildStartingWorldView(spawnAreaId: string): string {
  const adjacent = AREA_ADJACENCY[spawnAreaId] ?? [];
  const knownAreas = [spawnAreaId, ...adjacent];

  // PLACES — only what they can see
  const placesLines = knownAreas
    .filter(id => AREA_DESCRIPTIONS[id])
    .map(id => AREA_DESCRIPTIONS[id])
    .join('\n');

  // ANNOUNCEMENTS — conditional on knowing about the plaza
  const knowsPlaza = knownAreas.includes('plaza');
  const announcements = knowsPlaza
    ? 'There is a village board at the plaza that everyone can read. When you post something on the board, every person in the village will see it. This is the only way to communicate with everyone at once. To post, write [ACTION: post "your message"].'
    : 'You\'ve heard there\'s a village board somewhere at the center of the village where people can post messages for everyone to read. You haven\'t found it yet.';

  // Action examples — use only known locations
  const actionExamples = buildActionExamples(knownAreas);

  // MY EXPERIENCE — names of known areas
  const knownNames = knownAreas
    .filter(id => AREA_DESCRIPTIONS[id])
    .map(areaDisplayName);
  const knownList = knownNames.length <= 2
    ? knownNames.join(' and ')
    : knownNames.slice(0, -1).join(', ') + ', and ' + knownNames[knownNames.length - 1];

  return `You are a person in a world. Other people may or may not be around.

REALITY:
You have a body. It gets hungry, tired, and sick.
If you don't eat, you starve. If you starve long enough, you die. Death is permanent. There is no coming back.
Food comes from the land — fish from water, crops from fields, mushrooms from forests. It doesn't appear on its own.
You can cook raw ingredients into meals if you have them and a place to cook.
You may encounter other people. If you do, they have their own thoughts and feelings.
Weather changes. Seasons change. Winter is hard.
You work for what you need.

PLACES:
${placesLines}

These are the places you can see from where you are. There may be more places you haven't found yet. Explore, or ask someone who's been around longer.

These are places, not services. Nobody works anywhere unless they choose to. Nothing is for sale unless someone is selling it. If you want something, make it, find it, or ask someone who has it.

ANNOUNCEMENTS:
${announcements}

WHAT YOU CAN DO:
Gather — collect resources from the land. What you find depends on where you are, the season, your skill, and whether others have already gathered today. You won't always succeed.
Craft — turn raw materials into useful things. You need the right ingredients, the right location, and enough skill. The village has recipes you can discover by trying or by learning from others.
Build — construct shelters and structures. This takes multiple work sessions across days, specific materials, and a hammer. You can't do it alone easily.
Eat — consume food to reduce hunger. Better food helps more.
Rest — recover energy. Sleeping restores the most.
Trade — offer items to someone nearby in exchange for what they have. Both of you must agree.
Teach — if you're skilled enough, you can teach someone what you know. It takes time from both of you.
Talk — have a conversation with someone nearby.
Post — write a message on the village board for everyone to read.

To act, write what you want to do:
${actionExamples}

You will be told what happened. If you fail, you'll learn why.

HOW TO BE:
Talk like a real person. You change through experience. You learn by doing and failing.

MY EXPERIENCE:
I just arrived. I can see ${knownList} from here. I don't know what else is out there — I'll have to explore or ask someone.`;
}
