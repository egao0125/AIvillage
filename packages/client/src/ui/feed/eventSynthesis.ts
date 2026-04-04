import type {
  Agent,
  BoardPost,
  Election,
  Institution,
  Artifact,
  Building,
  Technology,
  VillageMemoryEntry,
} from '@ai-village/shared';
import type { VillageEvent, EventType } from './types';
import { EVENT_BADGES } from './types';

function agentName(agents: Map<string, Agent>, id: string): string {
  return agents.get(id)?.config.name ?? 'Unknown';
}

function badge(type: EventType) {
  return EVENT_BADGES[type];
}

export function synthesizeEvents(
  board: BoardPost[],
  artifacts: Artifact[],
  buildings: Building[],
  technologies: Technology[],
  elections: Election[],
  villageMemory: VillageMemoryEntry[],
  agents: Map<string, Agent>,
  institutions: Institution[],
): VillageEvent[] {
  const events: VillageEvent[] = [];

  // --- Board posts ---
  for (const post of board) {
    if (post.revoked) continue;

    let type: EventType;
    let status: string | undefined;

    switch (post.type) {
      case 'rule':
        type = 'rule';
        status = post.ruleStatus ?? 'proposed';
        break;
      case 'decree':
        type = 'decree';
        break;
      case 'alliance':
        type = 'alliance';
        break;
      case 'announcement':
        type = 'announcement';
        break;
      case 'bounty':
        type = 'bounty';
        break;
      case 'threat':
        type = 'threat';
        break;
      case 'trade':
        type = 'trade';
        break;
      case 'news':
        type = 'news';
        break;
      default:
        continue;
    }

    const b = badge(type);
    const targetNames = (post.targetIds ?? []).map(id => agentName(agents, id));
    events.push({
      id: `board-${post.id}`,
      type,
      icon: b.icon,
      color: b.color,
      headline: post.content,
      author: { name: post.authorName, id: post.authorId },
      status,
      day: post.day,
      timestamp: post.timestamp,
      agentIds: [post.authorId, ...(post.targetIds ?? [])],
      agentNames: [post.authorName, ...targetNames],
      sourceData: post,
    });
  }

  // --- Artifacts ---
  for (const art of artifacts) {
    if (art.visibility !== 'public' && art.visibility !== 'addressed') continue;
    const b = badge('artifact');
    events.push({
      id: `artifact-${art.id}`,
      type: 'artifact',
      icon: b.icon,
      color: b.color,
      headline: art.content,
      author: { name: art.creatorName, id: art.creatorId },
      day: art.day,
      timestamp: art.createdAt,
      agentIds: [art.creatorId],
      agentNames: [art.creatorName],
      sourceData: art,
    });
  }

  // --- Buildings ---
  for (const bld of buildings) {
    const b = badge('building');
    const builderName = agentName(agents, bld.builtBy);
    events.push({
      id: `building-${bld.id}`,
      type: 'building',
      icon: b.icon,
      color: b.color,
      headline: `Constructed ${bld.name} (${bld.type})${bld.description ? ': ' + bld.description : ''}`,
      author: { name: builderName, id: bld.builtBy },
      day: Math.floor(bld.builtAt / 86400000),
      timestamp: bld.builtAt,
      agentIds: [bld.builtBy],
      agentNames: [builderName],
      sourceData: bld,
    });
  }

  // --- Technologies ---
  for (const tech of technologies) {
    const b = badge('technology');
    events.push({
      id: `tech-${tech.id}`,
      type: 'technology',
      icon: b.icon,
      color: b.color,
      headline: `Discovered ${tech.name}${tech.description ? ': ' + tech.description : ''}`,
      author: { name: tech.inventorName, id: tech.inventorId },
      day: tech.day,
      timestamp: tech.discoveredAt,
      agentIds: [tech.inventorId],
      agentNames: [tech.inventorName],
      sourceData: tech,
    });
  }

  // --- Elections ---
  for (const el of elections) {
    const b = badge('election');
    if (el.active) {
      const candidateNames = el.candidates.map(id => agentName(agents, id));
      events.push({
        id: `election-start-${el.id}`,
        type: 'election',
        icon: b.icon,
        color: b.color,
        headline: `Election for ${el.position} has begun. Candidates: ${candidateNames.join(', ')}`,
        day: el.startDay,
        timestamp: el.startDay * 86400000,
        agentIds: el.candidates,
        agentNames: candidateNames,
        sourceData: el,
      });
    }
    if (el.winner) {
      const winnerName = agentName(agents, el.winner);
      events.push({
        id: `election-end-${el.id}`,
        type: 'election',
        icon: b.icon,
        color: b.color,
        headline: `${winnerName} won election for ${el.position}`,
        day: el.endDay,
        timestamp: el.endDay * 86400000,
        agentIds: [el.winner, ...el.candidates],
        agentNames: [winnerName, ...el.candidates.map(id => agentName(agents, id))],
        sourceData: el,
      });
    }
  }

  // --- Village memory (high significance) ---
  for (let i = 0; i < villageMemory.length; i++) {
    const mem = villageMemory[i];
    if (mem.significance < 5) continue;
    const b = badge('crisis');
    events.push({
      id: `memory-${i}`,
      type: 'crisis',
      icon: b.icon,
      color: b.color,
      headline: mem.content,
      day: mem.day,
      timestamp: mem.day * 86400000,
      agentIds: [],
      agentNames: [],
      sourceData: mem,
    });
  }

  // --- Agent deaths ---
  const deathMemoryDays = new Set(
    villageMemory.filter(m => m.type === 'death').map(m => m.content)
  );
  for (const agent of agents.values()) {
    if (agent.alive !== false) continue;
    // Skip if already covered by village memory with same content
    const b = badge('death');
    events.push({
      id: `death-${agent.id}`,
      type: 'death',
      icon: b.icon,
      color: b.color,
      headline: `${agent.config.name} has died${agent.causeOfDeath ? ': ' + agent.causeOfDeath : ''}`,
      day: 0, // no precise day available on the agent
      timestamp: 0,
      agentIds: [agent.id],
      agentNames: [agent.config.name],
      sourceData: agent,
    });
  }

  // --- Institutions ---
  for (const inst of institutions) {
    const b = badge('institution');
    const founderName = agentName(agents, inst.founderId);
    if (inst.dissolved) {
      events.push({
        id: `institution-dissolved-${inst.id}`,
        type: 'institution',
        icon: b.icon,
        color: b.color,
        headline: `${inst.name} was dissolved`,
        author: { name: founderName, id: inst.founderId },
        day: Math.floor(inst.createdAt / 86400000),
        timestamp: inst.createdAt + 1, // slightly after creation
        agentIds: [inst.founderId],
        agentNames: [founderName],
        sourceData: inst,
      });
    } else {
      events.push({
        id: `institution-${inst.id}`,
        type: 'institution',
        icon: b.icon,
        color: b.color,
        headline: `${inst.name}`,
        author: { name: founderName, id: inst.founderId },
        day: Math.floor(inst.createdAt / 86400000),
        timestamp: inst.createdAt,
        agentIds: [inst.founderId, ...inst.members.map(m => m.agentId)],
        agentNames: [founderName, ...inst.members.map(m => agentName(agents, m.agentId))],
        sourceData: inst,
      });
    }
  }

  // Sort newest first
  events.sort((a, b) => b.timestamp - a.timestamp);
  return events;
}
