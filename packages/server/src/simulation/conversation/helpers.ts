import type { Agent, Institution, SocialPrimitiveType } from '@ai-village/shared';
import type { WorldState as ResolverWorldState } from '@ai-village/ai-engine';
import type { World } from '../world.js';

/** Classify agreement text into a social primitive type via keyword matching */
export function classifyAgreementType(content: string): SocialPrimitiveType {
  const lower = content.toLowerCase();
  if (/\b(trade|exchange|swap|barter|buy|sell)\b/.test(lower)) return 'trade';
  if (/\b(meet|gather at|come to|rendezvous|dawn|dusk|morning|evening|tomorrow)\b/.test(lower)) return 'meeting';
  if (/\b(teach|learn|show|train|mentor)\b/.test(lower)) return 'task';
  if (/\b(rule|law|decree|ban|forbid|must|shall)\b/.test(lower)) return 'rule';
  if (/\b(ally|alliance|pact|unite|together against|side with)\b/.test(lower)) return 'alliance';
  return 'promise';
}

export function findAgentByName(world: World, name: string): Agent | undefined {
  const lower = name.toLowerCase().trim();
  for (const agent of world.agents.values()) {
    const agentName = agent.config.name.toLowerCase();
    if (
      agentName === lower ||
      agentName.includes(lower) ||
      lower.includes(agentName.split(' ')[0].toLowerCase())
    ) {
      return agent;
    }
  }
  return undefined;
}

export function findInstitutionByName(world: World, name: string): Institution | undefined {
  const lower = name.toLowerCase().trim();
  for (const inst of world.institutions.values()) {
    const instName = inst.name.toLowerCase();
    if (
      instName === lower ||
      instName.includes(lower) ||
      lower.includes(instName)
    ) {
      return inst;
    }
  }
  return undefined;
}

export function buildInventoryForResolver(actor: Agent): { resource: string; qty: number }[] {
  const counts = new Map<string, number>();
  for (const item of actor.inventory) {
    const key = item.name.toLowerCase().replace(/\s+/g, '_');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([resource, qty]) => ({ resource, qty }));
}

export function buildSkillsForResolver(actor: Agent): Record<string, { level: number; xp: number }> {
  const skills: Record<string, { level: number; xp: number }> = {};
  for (const s of actor.skills) {
    if (!s.name) continue;
    skills[s.name.toLowerCase()] = { level: s.level, xp: s.xp ?? 0 };
  }
  return skills;
}

export function buildWorldStateForResolver(world: World): ResolverWorldState {
  return {
    season: world.weather.season,
    dailyGatherCounts: world.dailyGatherCounts,
    activeBuildProjects: world.activeBuildProjects,
    pendingTrades: world.pendingTrades,
    getAgentInventory: (agentId: string) => {
      const agent = world.getAgent(agentId);
      if (!agent) return [];
      return buildInventoryForResolver(agent);
    },
  };
}

/** Detect if an agreement implies creating an institution/organization */
export function isInstitutionFormingAgreement(content: string): boolean {
  const lower = content.toLowerCase();
  // "form a council", "create a guild", "establish the trade commission", etc.
  return /\b(form|create|establish|found|start|build|organize|set up)\b.*\b(council|guild|group|organization|committee|society|order|faction|association|coalition|commission|collective|union|syndicate|brotherhood|sisterhood|assembly|league|team)\b/i.test(lower)
    || /\b(council|guild|group|organization|committee|society|order|faction|association|coalition|commission|collective|union|syndicate|brotherhood|sisterhood|assembly|league|team)\b.*\b(form|create|establish|found|start|build|organize|set up)\b/i.test(lower);
}

/** Extract a name for the institution from agreement text */
export function extractInstitutionName(content: string): string {
  // Match "the Food Council", "a Traders Guild", etc.
  const match = content.match(/(?:the|a|an|our|called|named)\s+([\w\s''-]+?(?:council|guild|group|organization|committee|society|order|faction|association|coalition|commission|collective|union|syndicate|brotherhood|sisterhood|assembly|league|team))/i);
  if (match) return match[1].trim();
  // Fallback: just grab any capitalized multi-word name before common org words
  const fallback = content.match(/((?:[A-Z][\w''-]*\s*){1,4}(?:council|guild|group|organization|committee|society|order|faction|association|coalition|commission|collective|union|syndicate|brotherhood|sisterhood|assembly|league|team))/i);
  if (fallback) return fallback[1].trim();
  return 'New Organization';
}

/** Classify commitment weight from agreement text + context */
export function classifyCommitmentWeight(
  agreement: string,
  isPublic: boolean,
  hasWitness: boolean,
): 1 | 3 | 5 {
  const lower = agreement.toLowerCase();
  if (/\b(swear|oath|vow|on my life|sacred|pledge)\b/.test(lower) || (isPublic && hasWitness)) return 5;
  if (/\b(maybe|could|might|try|if i can|when possible|sometime)\b/.test(lower)) return 1;
  if (/\b(promise|will bring|will give|commit|guarantee|i owe|i'll deliver)\b/.test(lower)) return 3;
  return 3; // default to promise
}

/** Extract item names referenced in an agreement */
export function extractItemsPromised(agreement: string): string[] {
  const items: string[] = [];
  const pattern = /(\d+)?\s*(wheat|bread|fish|stew|food|herb|mushroom|wood|stone|planks|medicine|vegetables|clay|flour|tea)/gi;
  let match;
  while ((match = pattern.exec(agreement)) !== null) {
    const qty = match[1] ? parseInt(match[1]) : 1;
    for (let i = 0; i < qty; i++) items.push(match[2].toLowerCase());
  }
  return items;
}

/**
 * Rewrite vague time references ("at dawn", "tomorrow", "this evening") into
 * concrete game-time format ("Day N, hour H"). Prevents agents from making
 * commitments the system can't track or enforce.
 */
export function rewriteVagueTime(text: string, currentDay: number, currentHour: number): string {
  const tomorrow = currentDay + 1;
  const replacements: [RegExp, string][] = [
    [/\bat dawn\b/gi,            `on Day ${currentHour < 7 ? currentDay : tomorrow}, hour 7`],
    [/\bat sunrise\b/gi,         `on Day ${currentHour < 6 ? currentDay : tomorrow}, hour 6`],
    [/\b(this |in the )?morning\b/gi, `on Day ${currentHour < 10 ? currentDay : tomorrow}, hour 9`],
    [/\bat noon\b/gi,            `on Day ${currentHour < 12 ? currentDay : tomorrow}, hour 12`],
    [/\b(this |in the )?afternoon\b/gi, `on Day ${currentHour < 16 ? currentDay : tomorrow}, hour 14`],
    [/\b(this |in the )?evening\b/gi, `on Day ${currentHour < 20 ? currentDay : tomorrow}, hour 19`],
    [/\bat dusk\b/gi,            `on Day ${currentHour < 19 ? currentDay : tomorrow}, hour 19`],
    [/\bat sunset\b/gi,          `on Day ${currentHour < 19 ? currentDay : tomorrow}, hour 19`],
    [/\btonight\b/gi,            `on Day ${currentDay}, hour 21`],
    [/\btomorrow\b/gi,           `on Day ${tomorrow}`],
    [/\blater today\b/gi,        `on Day ${currentDay}, hour ${Math.min(23, currentHour + 2)}`],
    [/\bsoon\b/gi,               `on Day ${currentDay}, hour ${Math.min(23, currentHour + 1)}`],
    [/\bnext time we meet\b/gi,  `when we next meet`], // keep as-is, no fake time
  ];
  let result = text;
  for (const [pattern, replacement] of replacements) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function buildInstitutionContext(world: World, agentId: string): string {
  const institutions = Array.from(world.institutions.values()).filter(i => !i.dissolved);
  if (institutions.length === 0) return '';

  const lines: string[] = ['VILLAGE INSTITUTIONS:'];
  for (const inst of institutions) {
    const myMembership = inst.members.find(m => m.agentId === agentId);
    const memberNames = inst.members
      .map(m => world.getAgent(m.agentId)?.config.name ?? m.agentId.slice(0, 6))
      .join(', ');
    let line = `- ${inst.name} (${inst.type}): ${inst.description || 'no description'}. ${inst.members.length} members [${memberNames}]. Treasury: ${inst.treasury}g.`;
    if (myMembership) {
      line += ` YOU are a ${myMembership.role}.`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}
