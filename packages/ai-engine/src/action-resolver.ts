// ============================================================================
// AI Village — Action Resolver v2
// Maps agent intent (free-text [ACTION: ...]) to world-rules functions.
// No LLM involved. Pattern matching + world state → deterministic outcome.
// ============================================================================

import {
  GATHERING, RECIPES, BUILDINGS, RESOURCES, SKILLS,
  resolveGather, resolveCraft, resolveTeach, validateTrade,
  getGatherOptions, getAvailableRecipes, getBuildableStructures, getResourceDef,
  type GatherDef, type RecipeDef, type BuildingDef, type Season, type TradeProposal,
} from './world-rules.js';

// --- Types ---

export type ActionType =
  | 'gather' | 'craft' | 'build' | 'repair' | 'eat' | 'rest' | 'sleep'
  | 'trade_offer' | 'trade_accept' | 'trade_reject'
  | 'teach' | 'give' | 'steal' | 'destroy' | 'fight' | 'post'
  | 'move' | 'talk'
  | 'use_medicine'
  | 'social' | 'intent'
  | 'unknown';

export interface ParsedIntent {
  type: ActionType;
  resource?: string;          // "wheat", "fish", "bread"
  recipe?: string;            // "bake_bread", "cook_stew"
  building?: string;          // "wood_shelter", "stone_house"
  location?: string;          // "farm", "lake", "bakery"
  targetAgent?: string;       // "Mei", "Koji"
  skill?: string;             // "fishing", "cooking"
  quantity?: number;
  offerItems?: { resource: string; qty: number }[];
  requestItems?: { resource: string; qty: number }[];
  message?: string;           // for board posts
  raw: string;                // original text
  remainder?: string;         // unparsed text after conjunction split (compound actions)
}

export interface ActionOutcome {
  success: boolean;
  type: ActionType;
  description: string;        // human-readable result for the agent's memory
  reason?: string;            // why it failed (if it did)
  itemsGained?: { resource: string; qty: number }[];
  itemsConsumed?: { resource: string; qty: number }[];
  skillXpGained?: { skill: string; xp: number };
  energySpent: number;
  hungerChange: number;       // negative = less hungry
  healthChange: number;
  durationMinutes: number;
  tradeProposal?: TradeProposal;
  buildProgress?: { buildingId: string; session: number; total: number; complete: boolean };
  teachResult?: { skill: string; studentNewLevel: number };
  witnesses?: string[];  // names of agents who perceived a social act
  socialMeaning?: string; // what the social act means in context
  remediation?: string;   // actionable hint when action fails
  deferredAction?: string; // remainder text from compound action split
  targetAgentId?: string;      // agent affected by this action (fight/steal/give/teach target)
  targetHealthChange?: number; // health change applied to the target (negative = damage)
  targetItemsRemoved?: { resource: string; qty: number }[]; // items removed from target (steal)
}

// --- Agent State Interface (what the resolver needs to know) ---

export interface AgentState {
  id: string;
  name: string;
  location: string;           // current area ID
  energy: number;
  hunger: number;
  health: number;
  inventory: { resource: string; qty: number }[];
  skills: Record<string, { level: number; xp: number }>;
  nearbyAgents: { id: string; name: string }[];
}

// --- World State Interface (what the resolver needs to check) ---

export interface WorldState {
  season: Season;
  dailyGatherCounts: Map<string, number>;  // gatherDef.id → times gathered today
  activeBuildProjects: Map<string, { buildingDefId: string; sessionsComplete: number; ownerId: string; location: string }>;
  pendingTrades: Map<string, TradeProposal>;
  getAgentInventory(agentId: string): { resource: string; qty: number }[];
}

// --- Intent Parser ---

const GATHER_PATTERNS = [
  /gather\s+(\w+)/i,
  /harvest\s+(\w+)/i,
  /collect\s+(\w+)/i,
  /pick\s+(\w+)/i,
  /forage\s+(?:for\s+)?(\w+)/i,
  /fish(?:ing)?(?:\s+at|\s+in)?/i,
  /chop\s+(\w+)/i,
  /dig\s+(\w+)/i,
  /get\s+(\w+)\s+(?:at|from)/i,
  /find\s+(\w+)\s+(?:at|from)/i,
];

const CRAFT_PATTERNS = [
  /(?:cook|bake|make|craft|brew|prepare|create|fire|cut|dry|pickle)\s+(.+?)(?:\s+at\s+|$)/i,
];

const BUILD_PATTERNS = [
  /build\s+(?:a\s+)?(.+?)(?:\s+at\s+|$)/i,
  /construct\s+(?:a\s+)?(.+?)(?:\s+at\s+|$)/i,
  /continue\s+building/i,
  /work\s+on\s+(?:the\s+)?(?:building|shelter|house|construction)/i,
];

const REPAIR_PATTERNS = [
  /repair\s+(?:the\s+)?(.+)/i,
  /fix\s+(?:the\s+)?(.+)/i,
  /restore\s+(?:the\s+)?(.+)/i,
  /patch\s+(?:the\s+)?(.+)/i,
];

const STEAL_PATTERNS = [
  /steal\s+(?:(\d+)\s+)?(\w[\w\s]*?)\s+from\s+(\w+)/i,
  /take\s+(?:(\d+)\s+)?(\w[\w\s]*?)\s+from\s+(\w+)/i,
  /pickpocket\s+(\w+)/i,
  /rob\s+(\w+)/i,
];

const DESTROY_PATTERNS = [
  /^destroy\s+(?:the\s+)?(.+)/i,
  /^break\s+(?:the\s+)?(?!me\b|my\b|it\b|you\b|him\b|her\b|us\b|them\b|free\b|even\b|down\b|through\b|away\b|out\b|off\b|up\b|into\b)(.+)/i,
  /^smash\s+(?:the\s+)?(.+)/i,
  /^burn\s+(?:the\s+)?(.+)/i,
  /^tear\s+down\s+(?:the\s+)?(.+)/i,
  /^demolish\s+(?:the\s+)?(.+)/i,
];

const FIGHT_PATTERNS = [
  /(?:fight|attack|hit|punch|strike|kick)\s+(\w+)/i,
  /(?:assault|ambush)\s+(\w+)/i,
  /pick\s+a\s+fight\s+with\s+(\w+)/i,
];

const SLEEP_PATTERNS = [
  /sleep\b/i,
  /go\s+to\s+(?:bed|sleep)/i,
  /turn\s+in\s+for\s+the\s+night/i,
  /call\s+it\s+a\s+(?:day|night)/i,
];

const TRADE_PATTERNS = [
  /(?:offer|trade|give)\s+(\d+)\s+(\w+)\s+(?:for|to)\s+(?:(\d+)\s+)?(\w+)\s+(?:with|to|from)\s+(\w+)/i,
  /trade\s+(\w+)\s+(?:for|with)\s+(\w+)\s+(?:with|to)\s+(\w+)/i,
];

const TEACH_PATTERNS = [
  /teach\s+(\w+)\s+(?:to\s+)?(\w+)/i,
  /show\s+(\w+)\s+how\s+to\s+(\w+)/i,
  /teach\s+(\w+)\s+(\w+)/i,
];

const EAT_PATTERNS = [
  /\beat\s+(?:some\s+)?(\w[\w\s]*)/i,
  /\bconsume\s+(\w+)/i,
  /\bhave\s+(?:a\s+)?(?:meal|breakfast|lunch|dinner)/i,
  /\beat\b/i,
];

const MEDICINE_PATTERNS = [
  /(?:use|apply|take)\s+(?:the\s+)?(?:medicine|poultice)/i,
  /heal\s+(?:myself|self)/i,
  /treat\s+(?:my\s+)?(?:wounds?|injuries?|sickness)/i,
];

const GIVE_PATTERNS = [
  /give\s+(?:(\d+)\s+)?(\w[\w\s]*?)\s+to\s+(\w+)/i,
];

const POST_PATTERNS = [
  /post\s+["""](.+?)["""](?:\s+on\s+(?:the\s+)?board)?/i,
  /post\s+(?:on\s+(?:the\s+)?board\s+)?["""](.+?)["""]/i,
  /write\s+(?:on\s+(?:the\s+)?board)\s+["""](.+?)["""]/i,
  /post\s+(.+)/i,
];

const REST_PATTERNS = [
  /\brest\b/i,
  /relax\b/i,
  /sit\s+down/i,
  /take\s+a\s+(?:break|nap)/i,
  /meditat/i,
];

const MOVE_PATTERNS = [
  /(?:go|walk|head|move|travel)\s+(?:to\s+)?(?:the\s+)?(\w[\w\s]*)/i,
  /visit\s+(?:the\s+)?(\w+)/i,
];

const TALK_PATTERNS = [
  /(?:talk|speak|chat)\s+(?:to|with)\s+(\w+)/i,
  /(?:approach|find|meet)\s+(\w+)/i,
];


const ACTION_VERBS = /^(?:go|walk|head|move|travel|gather|harvest|collect|pick|forage|fish|chop|dig|craft|cook|bake|make|brew|prepare|create|build|construct|eat|consume|rest|relax|sleep|trade|offer|give|steal|rob|destroy|break|smash|burn|fight|attack|hit|repair|fix|teach|show|post|write|talk|speak|chat|approach|find|meet|visit|attempt|try|start|begin|continue|keep|explore|search|examine|look|check|inspect)\b/i;

// Allowlist of resources that actually appear as GATHERING yields
const GATHERABLE = new Set(
  GATHERING.flatMap(g => g.yields.map(y => y.resource))
);

export function parseIntent(raw: string, agentState: AgentState): ParsedIntent {
  const text = raw.trim();

  // --- Conjunction split: extract remainder for compound actions ---
  let mainText = text;
  let remainder: string | undefined;

  // Try unambiguous conjunctions first: "and then", "then", "after that"
  const conjMatch = text.match(/^(.+?)\s+(?:and then|then|after that)\s+(.+)$/i);
  if (conjMatch) {
    const part2 = conjMatch[2].trim();
    if (ACTION_VERBS.test(part2)) {
      mainText = conjMatch[1].trim();
      remainder = part2;
    }
  }
  // Try "and" only if part2 starts with an action verb (avoids splitting "gather wood and stone")
  if (!remainder) {
    const andMatch = text.match(/^(.+?)\s+and\s+(.+)$/i);
    if (andMatch) {
      const part2 = andMatch[2].trim();
      if (ACTION_VERBS.test(part2)) {
        mainText = andMatch[1].trim();
        remainder = part2;
      }
    }
  }

  const base: ParsedIntent = { type: 'unknown', raw: text, remainder };

  // --- Reject statements & conditionals (not executable actions) ---
  // "I have nothing to eat" / "I don't know where to go" → internal thought, not a command
  if (/^I\s+(?:have|don't|can't|couldn't|won't|didn't|cannot|am\s+not)\b/i.test(mainText)) {
    return { ...base, type: 'intent', message: mainText };
  }
  // "eat whatever food I gather before dark" → conditional, not an immediate action
  if (/\b(?:whatever|whichever)\b/i.test(mainText)) {
    return { ...base, type: 'intent', message: mainText };
  }

  // --- Strip conditional clauses ---
  // "If nothing appears, I gather firewood instead" → "I gather firewood instead"
  mainText = mainText.replace(/^if\s+.+?,\s*/i, '');
  // "... if I can" / "... if nothing works" → strip trailing conditional
  mainText = mainText.replace(/\s+if\s+(?:I|nothing|we|there|it)\b.*$/i, '');

  // --- Handle first-person "I [verb]" prefix ---
  const iMatch = mainText.match(/^I\s+(\w+.*)/i);
  if (iMatch) {
    const afterI = iMatch[1];
    // Clear command verbs: strip "I" and parse normally
    if (/^(?:go|walk|head|move|travel|gather|harvest|collect|pick|forage|fish|chop|dig|craft|cook|bake|make|brew|prepare|create|build|construct|eat|consume|rest|relax|sleep|trade|offer|give|steal|rob|destroy|break|smash|burn|fight|attack|hit|repair|fix|teach|show|post|write|talk|speak|chat|visit)\b/i.test(afterI)) {
      mainText = afterI;
    } else if (/^(?:need|should|want|plan|hope|wish|intend|ought|decide|resolve|choose)\s+to\b/i.test(afterI) ||
               /^(?:'m|am|'ll|will)\s+/i.test(afterI)) {
      // "I need to..." / "I'm going to..." — let INTENT_PATTERNS at bottom handle these
    } else {
      // "I meet her eyes" / "I step closer" / "I kneel to examine" — narrative, not a command
      return { ...base, type: 'intent', message: mainText };
    }
  }

  // --- Eat ---
  for (const p of EAT_PATTERNS) {
    const m = mainText.match(p);
    if (m) {
      const foodName = m[1]?.toLowerCase().trim().replace(/\s+/g, '_');
      return { ...base, type: 'eat', resource: foodName || undefined };
    }
  }

  // --- Use medicine ---
  for (const p of MEDICINE_PATTERNS) {
    if (p.test(mainText)) {
      return { ...base, type: 'use_medicine' };
    }
  }

  // --- Sleep ---
  for (const p of SLEEP_PATTERNS) {
    if (p.test(mainText)) {
      return { ...base, type: 'sleep' };
    }
  }

  // --- Rest ---
  for (const p of REST_PATTERNS) {
    if (p.test(mainText)) {
      return { ...base, type: 'rest' };
    }
  }

  // --- Steal ---
  for (const p of STEAL_PATTERNS) {
    const m = mainText.match(p);
    if (m) {
      // "steal 3 wheat from Mei" or "rob Mei"
      if (m.length >= 4) {
        return { ...base, type: 'steal', quantity: parseInt(m[1]) || 1, resource: m[2]?.toLowerCase().trim().replace(/\s+/g, '_'), targetAgent: m[3] };
      }
      // "pickpocket Mei" / "rob Mei"
      return { ...base, type: 'steal', targetAgent: m[1] };
    }
  }

  // --- Destroy ---
  for (const p of DESTROY_PATTERNS) {
    const m = mainText.match(p);
    if (m) {
      return { ...base, type: 'destroy', resource: m[1]?.toLowerCase().trim() };
    }
  }

  // --- Fight ---
  for (const p of FIGHT_PATTERNS) {
    const m = mainText.match(p);
    if (m) {
      return { ...base, type: 'fight', targetAgent: m[1] };
    }
  }

  // --- Repair ---
  for (const p of REPAIR_PATTERNS) {
    const m = mainText.match(p);
    if (m) {
      const target = m[1]?.toLowerCase().trim().replace(/\s+/g, '_') || '';
      return { ...base, type: 'repair', building: target };
    }
  }

  // --- Trade ---
  for (const p of TRADE_PATTERNS) {
    const m = mainText.match(p);
    if (m) {
      // Pattern 1: "offer 3 wheat for 2 fish with Mei"
      if (m.length >= 5) {
        return {
          ...base, type: 'trade_offer',
          offerItems: [{ resource: m[2]?.toLowerCase(), qty: parseInt(m[1]) || 1 }],
          requestItems: [{ resource: m[4]?.toLowerCase(), qty: parseInt(m[3]) || 1 }],
          targetAgent: m[5],
        };
      }
      // Pattern 2: "trade wheat for fish with Mei"
      if (m.length >= 4) {
        return {
          ...base, type: 'trade_offer',
          offerItems: [{ resource: m[1]?.toLowerCase(), qty: 1 }],
          requestItems: [{ resource: m[2]?.toLowerCase(), qty: 1 }],
          targetAgent: m[3],
        };
      }
    }
  }

  // --- Trade accept/reject (during conversation) ---
  if (/accept\s+(?:the\s+)?(?:trade|offer|deal)/i.test(mainText)) {
    return { ...base, type: 'trade_accept' };
  }
  if (/reject\s+(?:the\s+)?(?:trade|offer|deal)/i.test(mainText) || /decline\s+(?:the\s+)?(?:trade|offer|deal)/i.test(mainText)) {
    return { ...base, type: 'trade_reject' };
  }

  // --- Teach ---
  for (const p of TEACH_PATTERNS) {
    const m = mainText.match(p);
    if (m) {
      // Could be "teach fishing to Koji" or "teach Koji fishing"
      const word1 = m[1]?.toLowerCase();
      const word2 = m[2]?.toLowerCase();
      const isSkill1 = word1 in SKILLS;
      const isSkill2 = word2 in SKILLS;

      if (isSkill1) {
        return { ...base, type: 'teach', skill: word1, targetAgent: m[2] };
      } else if (isSkill2) {
        return { ...base, type: 'teach', skill: word2, targetAgent: m[1] };
      }
      // Fuzzy: assume first word is skill-like
      return { ...base, type: 'teach', skill: word1, targetAgent: m[2] };
    }
  }

  // --- Give ---
  for (const p of GIVE_PATTERNS) {
    const m = mainText.match(p);
    if (m) {
      const qty = parseInt(m[1]) || 1;
      const resource = m[2]?.toLowerCase().trim().replace(/\s+/g, '_');
      const target = m[3];
      return { ...base, type: 'give', resource, quantity: qty, targetAgent: target };
    }
  }

  // --- Post on board ---
  for (const p of POST_PATTERNS) {
    const m = mainText.match(p);
    if (m) {
      return { ...base, type: 'post', message: m[1]?.trim() };
    }
  }

  // --- Build ---
  for (const p of BUILD_PATTERNS) {
    const m = mainText.match(p);
    if (m) {
      const buildingName = m[1]?.toLowerCase().trim().replace(/\s+/g, '_') || '';
      // Match against building definitions
      const buildDef = findBuilding(buildingName);
      return { ...base, type: 'build', building: buildDef?.id || buildingName };
    }
  }

  // --- Craft ---
  for (const p of CRAFT_PATTERNS) {
    const m = mainText.match(p);
    if (m) {
      const recipeName = m[1]?.toLowerCase().trim().replace(/\s+/g, '_') || '';
      const recipe = findRecipe(recipeName);
      if (recipe) {
        return { ...base, type: 'craft', recipe: recipe.id };
      }
      // Even if we can't match a recipe, record the intent
      return { ...base, type: 'craft', recipe: recipeName };
    }
  }

  // --- Gather (check after craft since "pick herbs" could be either) ---
  // Special case: "fish" / "go fishing"
  if (/\bfish(?:ing)?\b/i.test(mainText) && !/\bdried?\s+fish\b/i.test(mainText)) {
    return { ...base, type: 'gather', resource: 'fish', location: 'lake' };
  }

  for (const p of GATHER_PATTERNS) {
    const m = mainText.match(p);
    if (m) {
      let resource = m[1]?.toLowerCase().trim() || '';
      if (resource && !GATHERABLE.has(resource)) {
        // First word isn't a real resource — scan full text for one
        const found = [...GATHERABLE].find(r => mainText.toLowerCase().includes(r));
        resource = found || '';
      }
      return { ...base, type: 'gather', resource: resource || undefined };
    }
  }

  // --- Talk ---
  for (const p of TALK_PATTERNS) {
    const m = mainText.match(p);
    if (m) {
      return { ...base, type: 'talk', targetAgent: m[1] };
    }
  }

  // --- Move ---
  for (const p of MOVE_PATTERNS) {
    const m = mainText.match(p);
    if (m) {
      return { ...base, type: 'move', location: m[1]?.toLowerCase().trim() };
    }
  }

  // --- Intent vs Social (everything that didn't match a physical action) ---
  // Intent language: internal plans that feed the next think/plan cycle
  const INTENT_PATTERNS = /^(?:I (?:need|should|want|plan|hope|wish|intend|ought|decide|resolve|choose) to|we (?:need|should|must) |I(?:'m| am) going to|I(?:'ll| will) )/i;
  if (INTENT_PATTERNS.test(mainText)) {
    return { ...base, type: 'intent', message: mainText };
  }

  // Short imperatives without a clear target or audience are self-talk, not declarations
  // "speak directly, no preamble" / "be honest" / "stay calm" / "offer to work"
  const words = mainText.split(/\s+/);
  if (words.length <= 6 && !/\b(?:post|write|announce|declare|proclaim)\b/i.test(mainText)) {
    // No board-posting language → treat as internal resolve, not public declaration
    return { ...base, type: 'intent', message: mainText };
  }

  // Everything else is a social act — declarations, announcements, promises, threats, etc.
  return { ...base, type: 'social', message: mainText };
}


// --- Action Executor ---

export function executeAction(
  intent: ParsedIntent,
  agent: AgentState,
  world: WorldState,
): ActionOutcome {
  let outcome: ActionOutcome;
  switch (intent.type) {
    case 'gather': outcome = executeGather(intent, agent, world); break;
    case 'craft': outcome = executeCraft(intent, agent, world); break;
    case 'build': outcome = executeBuild(intent, agent, world); break;
    case 'repair': outcome = executeRepair(intent, agent, world); break;
    case 'eat': outcome = executeEat(intent, agent); break;
    case 'use_medicine': outcome = executeUseMedicine(agent); break;
    case 'rest': outcome = executeRest(agent); break;
    case 'sleep': outcome = executeSleep(agent); break;
    case 'give': outcome = executeGive(intent, agent, world); break;
    case 'steal': outcome = executeSteal(intent, agent, world); break;
    case 'destroy': outcome = executeDestroy(intent, agent, world); break;
    case 'fight': outcome = executeFight(intent, agent, world); break;
    case 'trade_offer': outcome = executeTradeOffer(intent, agent, world); break;
    case 'trade_accept': outcome = executeTradeAccept(agent, world); break;
    case 'trade_reject': outcome = executeTradeReject(agent, world); break;
    case 'teach': outcome = executeTeach(intent, agent, world); break;
    case 'post': outcome = executePost(intent, agent); break;
    case 'move': outcome = { success: true, type: 'move', description: `heading to ${intent.location}`, energySpent: 0, hungerChange: 0, healthChange: 0, durationMinutes: 0 }; break;
    case 'talk': {
      const talkTarget = intent.targetAgent ? agent.nearbyAgents.find(a => a.name.toLowerCase().includes(intent.targetAgent!.toLowerCase())) : undefined;
      outcome = { success: true, type: 'talk', description: `wants to talk to ${intent.targetAgent}`, energySpent: 0, hungerChange: 0, healthChange: 0, durationMinutes: 0, targetAgentId: talkTarget?.id }; break;
    }
    case 'intent': outcome = executeSocialIntent(intent); break;
    case 'social': outcome = executeSocialAct(intent, agent); break;
    default:
      outcome = {
        success: false, type: 'unknown',
        description: `I'm not sure how to "${intent.raw}".`,
        reason: 'unrecognized action',
        remediation: 'Try a specific action: gather, craft, build, eat, rest, give, trade.',
        energySpent: 0, hungerChange: 0, healthChange: 0, durationMinutes: 0,
      };
  }

  // Carry forward remainder for compound action handling
  if (intent.remainder) {
    outcome.deferredAction = intent.remainder;
  }

  return outcome;
}


// --- Individual executors ---

function executeGather(intent: ParsedIntent, agent: AgentState, world: WorldState): ActionOutcome {
  const base: Partial<ActionOutcome> = { type: 'gather', hungerChange: 0, healthChange: 0 };

  // Find matching gather definition for this location + resource
  const options = getGatherOptions(agent.location);
  let gatherDef: GatherDef | undefined;

  if (intent.resource) {
    gatherDef = options.find(g => g.yields.some(y => y.resource === intent.resource));
  }

  // If no specific resource requested, pick the first available option at this location
  if (!gatherDef && !intent.resource && options.length > 0) {
    gatherDef = options[0];
  }

  if (!gatherDef) {
    let remediation: string;
    if (intent.resource) {
      // Find all locations where this specific resource spawns
      const sources = GATHERING.filter(g => g.yields.some(y => y.resource === intent.resource));
      if (sources.length > 0) {
        const locations = [...new Set(sources.map(s => s.location))];
        remediation = `${intent.resource} can be found at: ${locations.map(l => `the ${l}`).join(', ')}.`;
      } else {
        remediation = `${intent.resource} isn't a gatherable resource. Try crafting it instead, or check available resources at: farm (wheat, vegetables), lake (fish, clay, stone), forest (wood, mushrooms), garden (herbs).`;
      }
    } else {
      // Generic - list what's available at nearby locations
      remediation = 'Try the farm for crops, the lake for fish/clay/stone, the forest for wood/mushrooms, or the garden for herbs.';
    }
    return {
      ...base, success: false,
      description: `There's nothing to gather ${intent.resource ? `(${intent.resource}) ` : ''}here at ${agent.location}. Go to: [ACTION: go to farm] for wheat, [ACTION: go to lake] for fish, [ACTION: go to forest] for wood, [ACTION: go to garden] for herbs.`,
      reason: 'wrong location',
      remediation,
      energySpent: 0, durationMinutes: 0,
    } as ActionOutcome;
  }

  // Check daily stock
  const gatheredToday = world.dailyGatherCounts.get(gatherDef.id) ?? 0;
  const remaining = gatherDef.dailyStock - gatheredToday;

  // Check if agent has the tool
  const hasTool = gatherDef.toolBonus ? agent.inventory.some(i => i.resource === gatherDef!.toolBonus) : false;

  // Get agent's skill level
  const skillLevel = agent.skills[gatherDef.skill]?.level ?? 0;

  const result = resolveGather(gatherDef, skillLevel, agent.energy, hasTool, world.season, remaining);

  if (!result.success) {
    let remediation: string | undefined;
    if (result.reason?.includes('not enough energy')) remediation = 'Rest or sleep to recover energy first.';
    else if (result.reason?.includes('need')) remediation = `Practice ${gatherDef.skill} by gathering simpler resources, or find someone to teach you.`;
    else if (result.reason?.includes('nothing left')) remediation = 'Try a different resource here, or come back tomorrow.';
    else if (result.reason?.includes('nothing grows')) remediation = 'Not available this season. Try a different resource or location.';
    else if (result.reason === 'found nothing this time') remediation = `Try again — higher ${gatherDef.skill} skill improves chances.`;
    return {
      ...base, success: false,
      description: `Tried to ${gatherDef.description.toLowerCase()} but ${result.reason}.`,
      reason: result.reason,
      remediation,
      energySpent: result.energySpent,
      durationMinutes: result.durationMinutes,
      skillXpGained: result.skillXpGained > 0 ? { skill: gatherDef.skill, xp: result.skillXpGained } : undefined,
    } as ActionOutcome;
  }

  const itemNames = result.itemsGained.map(i => `${i.qty} ${i.resource}`).join(', ');
  return {
    ...base, success: true,
    description: `Gathered ${itemNames}. ${hasTool ? `(${gatherDef.toolBonus} helped!) ` : ''}${gatherDef.skill} skill improving.`,
    itemsGained: result.itemsGained,
    skillXpGained: { skill: gatherDef.skill, xp: result.skillXpGained },
    energySpent: result.energySpent,
    durationMinutes: result.durationMinutes,
  } as ActionOutcome;
}


function executeCraft(intent: ParsedIntent, agent: AgentState, world: WorldState): ActionOutcome {
  const base: Partial<ActionOutcome> = { type: 'craft', hungerChange: 0, healthChange: 0 };

  // Find recipe
  let recipe: RecipeDef | undefined;
  if (intent.recipe) {
    recipe = RECIPES.find(r => r.id === intent.recipe);
    if (!recipe) recipe = findRecipe(intent.recipe);
  }

  // If no recipe found by name, try to find any recipe available at this location
  if (!recipe) {
    const agentSkills: Record<string, number> = {};
    for (const [k, v] of Object.entries(agent.skills)) agentSkills[k] = v.level;
    const available = getAvailableRecipes(agent.location, agentSkills);
    if (available.length === 0) {
      return { ...base, success: false, description: `I don't know how to make that here.`, reason: 'no matching recipe', remediation: 'Visit the workshop, bakery, cafe, or garden to see available recipes.', energySpent: 0, durationMinutes: 0 } as ActionOutcome;
    }
    // Try to match the intent text against available recipe names
    recipe = available.find(r => intent.raw.toLowerCase().includes(r.name.toLowerCase().split(' ').pop()!));
    if (!recipe) {
      return { ...base, success: false, description: `I don't know a recipe for that. I could try: ${available.map(r => r.name).join(', ')}.`, reason: 'unknown recipe', remediation: `Try one of these instead: ${available.map(r => r.name).join(', ')}.`, energySpent: 0, durationMinutes: 0 } as ActionOutcome;
    }
  }

  // Check location
  if (recipe.location !== agent.location) {
    return { ...base, success: false, description: `I need to be at the ${recipe.location} to ${recipe.name}.`, reason: `wrong location (need ${recipe.location})`, remediation: `Go to the ${recipe.location} to make ${recipe.name}.`, energySpent: 0, durationMinutes: 0 } as ActionOutcome;
  }

  const skillLevel = agent.skills[recipe.skill]?.level ?? 0;
  const hasTool = recipe.toolRequired ? agent.inventory.some(i => i.resource === recipe!.toolRequired) : true;

  const result = resolveCraft(recipe, skillLevel, agent.energy, agent.inventory, hasTool);

  if (!result.success) {
    let remediation: string | undefined;
    if (result.reason?.includes('not enough energy')) remediation = 'Rest or sleep to recover energy first.';
    else if (result.reason?.includes('need') && result.reason?.includes('level')) remediation = `Practice ${recipe.skill} or find someone with the required level to teach you.`;
    else if (result.reason?.includes('need a ')) remediation = `Craft a ${recipe.toolRequired} at the workshop first.`;
    else if (result.reason?.includes('need')) {
      const match = result.reason.match(/need \d+ (\w+)/);
      if (match) remediation = `Gather ${match[1]} at ${getResourceLocation(match[1])}.`;
    }
    return { ...base, success: false, description: `Tried to ${recipe.name} but ${result.reason}.`, reason: result.reason, remediation, energySpent: result.energySpent, durationMinutes: result.durationMinutes } as ActionOutcome;
  }

  const outputNames = result.itemsProduced.map(i => `${i.qty} ${RESOURCES[i.resource]?.name || i.resource}`).join(', ');
  return {
    ...base, success: true,
    description: `Made ${outputNames}. ${recipe.skill} skill improving.`,
    itemsConsumed: result.itemsConsumed,
    itemsGained: result.itemsProduced,
    skillXpGained: { skill: recipe.skill, xp: result.skillXpGained },
    energySpent: result.energySpent,
    durationMinutes: result.durationMinutes,
  } as ActionOutcome;
}


function executeBuild(intent: ParsedIntent, agent: AgentState, world: WorldState): ActionOutcome {
  const base: Partial<ActionOutcome> = { type: 'build', hungerChange: 0, healthChange: 0 };

  // Check if agent is continuing an existing build project
  const existingProject = Array.from(world.activeBuildProjects.entries())
    .find(([_, p]) => p.ownerId === agent.id || p.location === agent.location);

  if (existingProject || /continue|work on/i.test(intent.raw)) {
    const [projectId, project] = existingProject || [null, null];
    if (!project) {
      return { ...base, success: false, description: 'No building project to continue here.', reason: 'no active project', remediation: 'Start a new build project. Check building skill level and available materials.', energySpent: 0, durationMinutes: 0 } as ActionOutcome;
    }

    const buildDef = BUILDINGS[project.buildingDefId];
    if (!buildDef) {
      return { ...base, success: false, description: 'Building plan is corrupted.', reason: 'invalid building def', energySpent: 0, durationMinutes: 0 } as ActionOutcome;
    }

    const skillLevel = agent.skills['building']?.level ?? 0;
    if (agent.energy < buildDef.energyPerSession) {
      return { ...base, success: false, description: `Too tired to work on the ${buildDef.name}. Need to rest.`, reason: 'not enough energy', remediation: 'Rest or sleep to recover energy first.', energySpent: 0, durationMinutes: 0 } as ActionOutcome;
    }

    const newSession = project.sessionsComplete + 1;
    const complete = newSession >= buildDef.sessionsRequired;

    return {
      ...base, success: true,
      description: complete
        ? `Finished building the ${buildDef.name}! (session ${newSession}/${buildDef.sessionsRequired})`
        : `Worked on the ${buildDef.name}. (session ${newSession}/${buildDef.sessionsRequired})`,
      energySpent: buildDef.energyPerSession,
      durationMinutes: 60,
      skillXpGained: { skill: 'building', xp: SKILLS.building.xpPerSuccess },
      buildProgress: { buildingId: projectId!, session: newSession, total: buildDef.sessionsRequired, complete },
    } as ActionOutcome;
  }

  // Starting a new build
  const buildDef = intent.building ? BUILDINGS[intent.building] || findBuilding(intent.building) : undefined;
  if (!buildDef) {
    const available = getBuildableStructures(agent.skills['building']?.level ?? 0);
    const suggestions = available.map(b => {
      const mats = b.materials.map(m => `${m.qty} ${m.resource}`).join(' + ');
      return `${b.name} (needs ${mats} — gather at ${b.materials.map(m => getResourceLocation(m.resource)).join(', ')})`;
    }).join('; ');
    return { ...base, success: false, description: `Don't know how to build that.${suggestions ? ` I could try: ${suggestions}.` : ' Need building skill first.'}`, reason: 'unknown building', remediation: suggestions || 'Practice building simpler structures first.', energySpent: 0, durationMinutes: 0 } as ActionOutcome;
  }

  const skillLevel = agent.skills['building']?.level ?? 0;
  if (skillLevel < buildDef.minBuildingSkill) {
    return { ...base, success: false, description: `Need building level ${buildDef.minBuildingSkill} to build a ${buildDef.name}. I'm at level ${skillLevel}.`, reason: 'skill too low', remediation: `Practice building simpler structures, or find someone with building level ${buildDef.minBuildingSkill}+ to teach you.`, energySpent: 0, durationMinutes: 0 } as ActionOutcome;
  }

  // Check tool
  if (buildDef.toolRequired !== 'none' && !agent.inventory.some(i => i.resource === buildDef.toolRequired)) {
    return { ...base, success: false, description: `Need a ${buildDef.toolRequired} to build a ${buildDef.name}.`, reason: `missing ${buildDef.toolRequired}`, remediation: `Craft a ${buildDef.toolRequired} at the workshop (wood + stone + crafting skill).`, energySpent: 0, durationMinutes: 0 } as ActionOutcome;
  }

  // Check materials
  for (const mat of buildDef.materials) {
    const have = agent.inventory.find(i => i.resource === mat.resource);
    if (!have || have.qty < mat.qty) {
      return { ...base, success: false, description: `Need ${mat.qty} ${mat.resource} to start building a ${buildDef.name}. Have ${have?.qty ?? 0}.`, reason: `need ${mat.qty} ${mat.resource}`, remediation: `Gather ${mat.resource} at ${getResourceLocation(mat.resource)}.`, energySpent: 0, durationMinutes: 0 } as ActionOutcome;
    }
  }

  if (agent.energy < buildDef.energyPerSession) {
    return { ...base, success: false, description: `Too tired to start building. Need to rest first.`, reason: 'not enough energy', remediation: 'Rest or sleep to recover energy first.', energySpent: 0, durationMinutes: 0 } as ActionOutcome;
  }

  const complete = buildDef.sessionsRequired <= 1;
  return {
    ...base, success: true,
    description: complete
      ? `Built a ${buildDef.name}! Used ${buildDef.materials.map(m => `${m.qty} ${m.resource}`).join(', ')}.`
      : `Started building a ${buildDef.name}. Session 1/${buildDef.sessionsRequired}. Used ${buildDef.materials.map(m => `${m.qty} ${m.resource}`).join(', ')}.`,
    itemsConsumed: buildDef.materials.map(m => ({ resource: m.resource, qty: m.qty })),
    energySpent: buildDef.energyPerSession,
    durationMinutes: 60,
    skillXpGained: { skill: 'building', xp: SKILLS.building.xpPerSuccess },
    buildProgress: { buildingId: 'new_' + buildDef.id, session: 1, total: buildDef.sessionsRequired, complete },
  } as ActionOutcome;
}


function executeEat(intent: ParsedIntent, agent: AgentState): ActionOutcome {
  const base: Partial<ActionOutcome> = { type: 'eat', energySpent: 0, healthChange: 0, durationMinutes: 5 };

  // Find food in inventory
  let food: { resource: string; qty: number } | undefined;

  if (intent.resource) {
    food = agent.inventory.find(i => i.resource === intent.resource && (RESOURCES[i.resource]?.nutritionValue ?? 0) > 0);
  }

  // If no specific food requested, eat the most nutritious available
  if (!food) {
    const edibles = agent.inventory
      .filter(i => (RESOURCES[i.resource]?.nutritionValue ?? 0) > 0)
      .sort((a, b) => (RESOURCES[b.resource]?.nutritionValue ?? 0) - (RESOURCES[a.resource]?.nutritionValue ?? 0));
    food = edibles[0];
  }

  if (!food) {
    return { ...base, success: false, description: 'I have nothing to eat.', reason: 'no food in inventory', remediation: 'Gather food at the farm, garden, lake, or forest. Or trade with someone who has food.', hungerChange: 0 } as ActionOutcome;
  }

  const resDef = RESOURCES[food.resource];
  if (!resDef) {
    return { ...base, success: false, description: `I don't know how to eat ${food.resource}.`, reason: 'unknown food', remediation: 'Try eating something else from your inventory.', hungerChange: 0 } as ActionOutcome;
  }

  return {
    ...base, success: true,
    description: `Ate ${resDef.name}. ${resDef.nutritionValue > 15 ? 'Very filling.' : resDef.nutritionValue > 8 ? 'Satisfying.' : 'A light snack.'}`,
    itemsConsumed: [{ resource: food.resource, qty: 1 }],
    hungerChange: -resDef.nutritionValue,
    healthChange: resDef.healValue > 0 ? resDef.healValue : 0,
  } as ActionOutcome;
}


function executeUseMedicine(agent: AgentState): ActionOutcome {
  const base: Partial<ActionOutcome> = { type: 'use_medicine', energySpent: 0, hungerChange: 0, durationMinutes: 10 };

  const med = agent.inventory.find(i => RESOURCES[i.resource]?.type === 'medicine');
  if (!med) {
    return { ...base, success: false, description: 'I have no medicine.', reason: 'no medicine', remediation: 'Craft a poultice at the garden (1 herb) or medicine at the hospital (3 herbs + mortar). Gather herbs at the garden.', healthChange: 0 } as ActionOutcome;
  }

  const resDef = RESOURCES[med.resource]!;
  return {
    ...base, success: true,
    description: `Used ${resDef.name}. Feeling ${resDef.healValue >= 20 ? 'much' : 'a little'} better.`,
    itemsConsumed: [{ resource: med.resource, qty: 1 }],
    healthChange: resDef.healValue,
  } as ActionOutcome;
}


function executeRest(agent: AgentState): ActionOutcome {
  return {
    success: true, type: 'rest',
    description: 'Resting and recovering energy.',
    energySpent: -15, // negative = gaining energy
    hungerChange: 1,  // resting makes you slightly hungrier
    healthChange: 1,
    durationMinutes: 30,
  };
}


function executeGive(intent: ParsedIntent, agent: AgentState, world: WorldState): ActionOutcome {
  const base: Partial<ActionOutcome> = { type: 'give', energySpent: 0, hungerChange: 0, healthChange: 0, durationMinutes: 2 };

  if (!intent.targetAgent) {
    return { ...base, success: false, description: 'Give to whom?', reason: 'no target specified' } as ActionOutcome;
  }

  const nearby = agent.nearbyAgents.find(a => a.name.toLowerCase().includes(intent.targetAgent!.toLowerCase()));
  if (!nearby) {
    return { ...base, success: false, description: `${intent.targetAgent} isn't nearby.`, reason: 'target not nearby', remediation: `Find ${intent.targetAgent} first — check around the village.` } as ActionOutcome;
  }

  const resource = intent.resource;
  const qty = intent.quantity || 1;
  if (!resource) {
    return { ...base, success: false, description: 'Give what?', reason: 'no resource specified' } as ActionOutcome;
  }

  const have = agent.inventory.find(i => i.resource === resource);
  if (!have || have.qty < qty) {
    return { ...base, success: false, description: `I don't have ${qty} ${resource}.`, reason: `insufficient ${resource}`, remediation: `Gather more ${resource} at ${getResourceLocation(resource)}.` } as ActionOutcome;
  }

  return {
    ...base, success: true,
    description: `Gave ${qty} ${resource} to ${nearby.name}.`,
    itemsConsumed: [{ resource, qty }],
    targetAgentId: nearby.id,
  } as ActionOutcome;
}


function executeTradeOffer(intent: ParsedIntent, agent: AgentState, world: WorldState): ActionOutcome {
  const base: Partial<ActionOutcome> = { type: 'trade_offer', energySpent: 0, hungerChange: 0, healthChange: 0, durationMinutes: 5 };

  if (!intent.targetAgent || !intent.offerItems || !intent.requestItems) {
    return { ...base, success: false, description: 'Unclear trade proposal.', reason: 'incomplete trade' } as ActionOutcome;
  }

  const nearby = agent.nearbyAgents.find(a => a.name.toLowerCase().includes(intent.targetAgent!.toLowerCase()));
  if (!nearby) {
    return { ...base, success: false, description: `${intent.targetAgent} isn't nearby to trade with.`, reason: 'target not nearby', remediation: `Find ${intent.targetAgent} first.` } as ActionOutcome;
  }

  // Check I have what I'm offering
  for (const item of intent.offerItems) {
    const have = agent.inventory.find(i => i.resource === item.resource);
    if (!have || have.qty < item.qty) {
      return { ...base, success: false, description: `I don't have ${item.qty} ${item.resource} to offer.`, reason: `insufficient ${item.resource}`, remediation: `Gather more ${item.resource} at ${getResourceLocation(item.resource)}.` } as ActionOutcome;
    }
  }

  const proposal: TradeProposal = {
    id: crypto.randomUUID(),
    fromAgentId: agent.id,
    toAgentId: nearby.id,
    offering: intent.offerItems,
    requesting: intent.requestItems,
    status: 'pending',
    createdAt: Date.now(),
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 real minutes
  };

  const offerStr = intent.offerItems.map(i => `${i.qty} ${i.resource}`).join(', ');
  const requestStr = intent.requestItems.map(i => `${i.qty} ${i.resource}`).join(', ');

  return {
    ...base, success: true,
    description: `Offered ${nearby.name} a trade: my ${offerStr} for their ${requestStr}.`,
    tradeProposal: proposal,
  } as ActionOutcome;
}


function executeTradeAccept(agent: AgentState, world: WorldState): ActionOutcome {
  const base: Partial<ActionOutcome> = { type: 'trade_accept', energySpent: 0, hungerChange: 0, healthChange: 0, durationMinutes: 2 };

  // Find pending trade proposal where this agent is the recipient
  const pending = Array.from(world.pendingTrades.values())
    .find(t => t.toAgentId === agent.id && t.status === 'pending');

  if (!pending) {
    return { ...base, success: false, description: 'No trade offer to accept.', reason: 'no pending trade' } as ActionOutcome;
  }

  const fromInventory = world.getAgentInventory(pending.fromAgentId);
  const toInventory = agent.inventory;
  const result = validateTrade(pending, fromInventory, toInventory);

  if (!result.success) {
    return { ...base, success: false, description: `Trade failed: ${result.reason}`, reason: result.reason } as ActionOutcome;
  }

  const gaveStr = pending.requesting.map(i => `${i.qty} ${i.resource}`).join(', ');
  const gotStr = pending.offering.map(i => `${i.qty} ${i.resource}`).join(', ');

  return {
    ...base, success: true,
    description: `Trade completed! Gave ${gaveStr}, received ${gotStr}.`,
    itemsConsumed: pending.requesting, // what this agent gives
    itemsGained: pending.offering,     // what this agent receives
    tradeProposal: { ...pending, status: 'accepted' },
  } as ActionOutcome;
}


function executeTradeReject(agent: AgentState, world: WorldState): ActionOutcome {
  const pending = Array.from(world.pendingTrades.values())
    .find(t => t.toAgentId === agent.id && t.status === 'pending');

  return {
    success: true, type: 'trade_reject',
    description: pending ? 'Declined the trade offer.' : 'No trade to decline.',
    energySpent: 0, hungerChange: 0, healthChange: 0, durationMinutes: 1,
    tradeProposal: pending ? { ...pending, status: 'rejected' } : undefined,
  };
}


function executeTeach(intent: ParsedIntent, agent: AgentState, world: WorldState): ActionOutcome {
  const base: Partial<ActionOutcome> = { type: 'teach', energySpent: 5, hungerChange: 0, healthChange: 0 };

  if (!intent.skill || !intent.targetAgent) {
    return { ...base, success: false, description: 'Teach what to whom?', reason: 'incomplete', durationMinutes: 0 } as ActionOutcome;
  }

  const nearby = agent.nearbyAgents.find(a => a.name.toLowerCase().includes(intent.targetAgent!.toLowerCase()));
  if (!nearby) {
    return { ...base, success: false, description: `${intent.targetAgent} isn't nearby.`, reason: 'target not nearby', remediation: `Find ${intent.targetAgent} first.`, durationMinutes: 0 } as ActionOutcome;
  }

  const teacherLevel = agent.skills[intent.skill]?.level ?? 0;
  // Student level would be fetched from world — we return 0 as default, caller adjusts
  const result = resolveTeach(intent.skill, teacherLevel, 0);

  if (!result.success) {
    return { ...base, success: false, description: `Can't teach ${intent.skill}: ${result.reason}`, reason: result.reason, remediation: result.reason?.includes('teacher') ? `Practice ${intent.skill} more before trying to teach it.` : 'They may already know this skill.', durationMinutes: 0 } as ActionOutcome;
  }

  return {
    ...base, success: true,
    description: `Taught ${nearby.name} the basics of ${intent.skill}. They're now level ${result.studentNewLevel}.`,
    durationMinutes: result.durationMinutes,
    teachResult: { skill: intent.skill, studentNewLevel: result.studentNewLevel },
    targetAgentId: nearby.id,
  } as ActionOutcome;
}


function executePost(intent: ParsedIntent, agent: AgentState): ActionOutcome {
  if (!intent.message) {
    return { success: false, type: 'post', description: 'Nothing to post.', reason: 'empty message', energySpent: 0, hungerChange: 0, healthChange: 0, durationMinutes: 0 };
  }

  return {
    success: true, type: 'post',
    description: `Posted on the village board: "${intent.message}"`,
    energySpent: 0, hungerChange: 0, healthChange: 0, durationMinutes: 5,
  };
}


function executeSleep(agent: AgentState): ActionOutcome {
  return {
    success: true, type: 'sleep',
    description: 'Settled down to sleep.',
    energySpent: -40, // big energy recovery
    hungerChange: 3,  // sleeping makes you hungrier
    healthChange: 3,
    durationMinutes: 480, // 8 game hours
  };
}


function executeRepair(intent: ParsedIntent, agent: AgentState, world: WorldState): ActionOutcome {
  const base: Partial<ActionOutcome> = { type: 'repair', hungerChange: 0, healthChange: 0 };

  if (!intent.building) {
    return { ...base, success: false, description: 'Repair what?', reason: 'no target', remediation: 'Specify what building or structure to repair.', energySpent: 0, durationMinutes: 0 } as ActionOutcome;
  }

  // Check for hammer
  const hasHammer = agent.inventory.some(i => i.resource === 'hammer');
  if (!hasHammer) {
    return { ...base, success: false, description: 'Need a hammer to repair.', reason: 'missing hammer', remediation: 'Craft a hammer at the workshop (wood + stone, crafting level 2).', energySpent: 0, durationMinutes: 0 } as ActionOutcome;
  }

  if (agent.energy < 15) {
    return { ...base, success: false, description: 'Too tired to repair anything.', reason: 'not enough energy', remediation: 'Rest or sleep to recover energy first.', energySpent: 0, durationMinutes: 0 } as ActionOutcome;
  }

  return {
    ...base, success: true,
    description: `Repaired the ${intent.building.replace(/_/g, ' ')}.`,
    energySpent: 15,
    durationMinutes: 45,
    skillXpGained: { skill: 'building', xp: 2 },
  } as ActionOutcome;
}


function executeSteal(intent: ParsedIntent, agent: AgentState, world: WorldState): ActionOutcome {
  const base: Partial<ActionOutcome> = { type: 'steal', hungerChange: 0, healthChange: 0, durationMinutes: 5 };

  if (!intent.targetAgent) {
    return { ...base, success: false, description: 'Steal from whom?', reason: 'no target', energySpent: 0 } as ActionOutcome;
  }

  const nearby = agent.nearbyAgents.find(a => a.name.toLowerCase().includes(intent.targetAgent!.toLowerCase()));
  if (!nearby) {
    return { ...base, success: false, description: `${intent.targetAgent} isn't nearby.`, reason: 'target not nearby', remediation: `Find ${intent.targetAgent} first — check around the village.`, energySpent: 0 } as ActionOutcome;
  }

  // Steal has a chance of failure based on no skill system yet — flat 40% success
  const succeeded = Math.random() < 0.4;

  if (!succeeded) {
    return {
      ...base, success: false,
      description: `Tried to steal from ${nearby.name} but got caught!`,
      reason: 'caught',
      remediation: 'You were spotted. Witnesses may remember this. Lay low for a while.',
      energySpent: 5,
      targetAgentId: nearby.id,  // victim knows even on failed attempt
    } as ActionOutcome;
  }

  // Pick a random item from target's inventory
  const targetInventory = world.getAgentInventory(nearby.id);
  if (targetInventory.length === 0) {
    return { ...base, success: false, description: `${nearby.name} has nothing to steal.`, reason: 'target has nothing', remediation: 'Try someone else, or wait until they have items.', energySpent: 3 } as ActionOutcome;
  }

  const stolen = intent.resource
    ? targetInventory.find(i => i.resource === intent.resource)
    : targetInventory[Math.floor(Math.random() * targetInventory.length)];

  if (!stolen) {
    return { ...base, success: false, description: `${nearby.name} doesn't have that.`, reason: 'item not found', remediation: `${nearby.name} doesn't have that. Try stealing something else.`, energySpent: 3 } as ActionOutcome;
  }

  const qty = Math.min(intent.quantity || 1, stolen.qty);
  return {
    ...base, success: true,
    description: `Stole ${qty} ${stolen.resource} from ${nearby.name}.`,
    itemsGained: [{ resource: stolen.resource, qty }],
    targetAgentId: nearby.id,
    targetItemsRemoved: [{ resource: stolen.resource, qty }],
    energySpent: 5,
  } as ActionOutcome;
}


function executeDestroy(intent: ParsedIntent, agent: AgentState, world: WorldState): ActionOutcome {
  const base: Partial<ActionOutcome> = { type: 'destroy', hungerChange: 0, healthChange: 0, durationMinutes: 10 };

  if (!intent.resource) {
    return { ...base, success: false, description: 'Destroy what?', reason: 'no target', energySpent: 0 } as ActionOutcome;
  }

  if (agent.energy < 10) {
    return { ...base, success: false, description: 'Too tired.', reason: 'not enough energy', remediation: 'Rest or sleep to recover energy first.', energySpent: 0 } as ActionOutcome;
  }

  // Check if it's an item in own inventory
  const ownItem = agent.inventory.find(i => i.resource.includes(intent.resource!));
  if (ownItem) {
    return {
      ...base, success: true,
      description: `Destroyed ${ownItem.resource}.`,
      itemsConsumed: [{ resource: ownItem.resource, qty: 1 }],
      energySpent: 5,
    } as ActionOutcome;
  }

  // Otherwise it's a structure/building/environmental target
  return {
    ...base, success: true,
    description: `Damaged the ${intent.resource.replace(/_/g, ' ')}.`,
    energySpent: 10,
  } as ActionOutcome;
}


function executeFight(intent: ParsedIntent, agent: AgentState, world: WorldState): ActionOutcome {
  const base: Partial<ActionOutcome> = { type: 'fight', hungerChange: 0, durationMinutes: 10 };

  if (!intent.targetAgent) {
    return { ...base, success: false, description: 'Fight whom?', reason: 'no target', energySpent: 0, healthChange: 0 } as ActionOutcome;
  }

  const nearby = agent.nearbyAgents.find(a => a.name.toLowerCase().includes(intent.targetAgent!.toLowerCase()));
  if (!nearby) {
    return { ...base, success: false, description: `${intent.targetAgent} isn't nearby.`, reason: 'target not nearby', remediation: `Find ${intent.targetAgent} first.`, energySpent: 0, healthChange: 0 } as ActionOutcome;
  }

  if (agent.energy < 10) {
    return { ...base, success: false, description: 'Too exhausted to fight.', reason: 'not enough energy', remediation: 'Rest or sleep to recover energy first.', energySpent: 0, healthChange: 0 } as ActionOutcome;
  }

  // Both sides take damage, attacker has slight advantage
  const attackerDamage = Math.floor(Math.random() * 10) + 5;  // 5-14 damage dealt TO defender
  const defenderDamage = Math.floor(Math.random() * 12) + 3;  // 3-14 retaliation damage taken BY attacker

  return {
    ...base, success: true,
    description: `Fought ${nearby.name}. Dealt ${attackerDamage} damage, took ${defenderDamage} damage.`,
    energySpent: 15,
    healthChange: -defenderDamage,          // attacker takes retaliation damage
    targetHealthChange: -attackerDamage,     // defender takes the attack damage
    targetAgentId: nearby.id,                // who got hit
  } as ActionOutcome;
}


function executeSocialIntent(intent: ParsedIntent): ActionOutcome {
  // Intent is internal — stored as thought, not broadcast
  return {
    success: true, type: 'intent',
    description: intent.message || intent.raw,
    energySpent: 0, hungerChange: 0, healthChange: 0, durationMinutes: 0,
  };
}


function executeSocialAct(intent: ParsedIntent, agent: AgentState): ActionOutcome {
  // Social acts always succeed as speech acts. The agent said the words.
  // Whether anyone respects it depends on witnesses and their reactions.
  const witnessNames = agent.nearbyAgents.map(a => a.name);
  const whoHeard = witnessNames.length > 0
    ? `${witnessNames.join(', ')} heard you.`
    : 'Nobody was around to hear you.';
  const meaning = witnessNames.length > 0
    ? 'This is a claim, not a fact. Whether anyone respects it depends on whether they agree.'
    : 'A declaration with no audience is just words to yourself.';

  return {
    success: true, type: 'social',
    description: `You declared: "${intent.message || intent.raw}"`,
    energySpent: 3,
    hungerChange: 0, healthChange: 0,
    durationMinutes: 5,
    witnesses: witnessNames,
    socialMeaning: meaning,
  };
}


// --- Resource location helper ---

function getResourceLocation(resource: string): string {
  const sources = GATHERING.filter(g => g.yields.some(y => y.resource === resource));
  if (sources.length > 0) {
    return [...new Set(sources.map(s => s.location))].map(l => `the ${l}`).join(' or ');
  }
  return 'a gathering location, or trade with someone';
}

// --- Fuzzy matchers ---

function findRecipe(text: string): RecipeDef | undefined {
  const lower = text.toLowerCase().replace(/[_-]/g, ' ');
  return RECIPES.find(r =>
    r.id === text ||
    r.name.toLowerCase() === lower ||
    r.name.toLowerCase().includes(lower) ||
    lower.includes(r.name.toLowerCase().split(' ').pop()!)
  );
}

function findBuilding(text: string): BuildingDef | undefined {
  const lower = text.toLowerCase().replace(/[_-]/g, ' ');
  return Object.values(BUILDINGS).find(b =>
    b.id === text ||
    b.name.toLowerCase() === lower ||
    b.name.toLowerCase().includes(lower) ||
    lower.includes(b.name.toLowerCase().split(' ').pop()!)
  );
}
