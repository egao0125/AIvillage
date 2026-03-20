import type { Agent, AgentState, BoardPost, BoardPostType, Conversation, Election, GameTime, Item, MapArea, MaterialSpawn, Mood, Position, Property, ReputationEntry, Secret, Skill, WorldEvent, WorldSnapshot } from '@ai-village/shared';
import { AREAS, getAreaAt as mapGetAreaAt } from '../map/village.js';

export class World {
  agents: Map<string, Agent> = new Map();
  conversations: Map<string, Conversation> = new Map();
  board: BoardPost[] = [];
  time: GameTime;
  items: Map<string, Item> = new Map();
  secrets: Secret[] = [];
  events: WorldEvent[] = [];
  elections: Map<string, Election> = new Map();
  properties: Map<string, Property> = new Map();
  reputation: ReputationEntry[] = [];
  materialSpawns: MaterialSpawn[] = [];

  constructor() {
    this.time = {
      day: 1,
      hour: 5,
      minute: 0,
      totalMinutes: 5 * 60,
    };

    this.materialSpawns = [
      { areaId: 'forest', material: 'wood', respawnMinutes: 30 },
      { areaId: 'forest', material: 'mushrooms', respawnMinutes: 45 },
      { areaId: 'forest_south', material: 'wood', respawnMinutes: 30 },
      { areaId: 'farm', material: 'wheat', respawnMinutes: 40 },
      { areaId: 'farm', material: 'vegetables', respawnMinutes: 40 },
      { areaId: 'lake', material: 'fish', respawnMinutes: 25 },
      { areaId: 'lake', material: 'clay', respawnMinutes: 60 },
      { areaId: 'garden', material: 'herbs', respawnMinutes: 35 },
      { areaId: 'garden', material: 'flowers', respawnMinutes: 35 },
    ];
  }

  addAgent(agent: Agent): void {
    // Ensure new fields have defaults
    if (!agent.mood) agent.mood = 'neutral';
    if (!agent.inventory) agent.inventory = [];
    if (!agent.skills) agent.skills = [];
    this.agents.set(agent.id, agent);
  }

  getAgent(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  updateAgentPosition(id: string, pos: Position): void {
    const agent = this.agents.get(id);
    if (agent) {
      agent.position = { x: pos.x, y: pos.y };
    }
  }

  updateAgentState(id: string, state: AgentState, action?: string): void {
    const agent = this.agents.get(id);
    if (agent) {
      agent.state = state;
      if (action !== undefined) {
        agent.currentAction = action;
      }
    }
  }

  updateAgentCurrency(id: string, delta: number): number {
    const agent = this.agents.get(id);
    if (!agent) return 0;
    agent.currency = Math.max(0, agent.currency + delta);
    return agent.currency;
  }

  getNearbyAgents(pos: Position, radius: number): Agent[] {
    const nearby: Agent[] = [];
    for (const agent of this.agents.values()) {
      const dx = agent.position.x - pos.x;
      const dy = agent.position.y - pos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= radius) {
        nearby.push(agent);
      }
    }
    return nearby;
  }

  getAreaAt(pos: Position): MapArea | undefined {
    return mapGetAreaAt(pos);
  }

  /**
   * Advance time by 1 game minute. Wraps hours at 24, increments days.
   */
  advanceTime(): GameTime {
    this.time.totalMinutes++;
    this.time.minute++;
    if (this.time.minute >= 60) {
      this.time.minute = 0;
      this.time.hour++;
      if (this.time.hour >= 24) {
        this.time.hour = 0;
        this.time.day++;
      }
    }
    return { ...this.time };
  }

  addBoardPost(post: BoardPost): void {
    this.board.push(post);
    // Keep board manageable — max 50 active posts
    if (this.board.length > 50) {
      this.board = this.board.slice(-50);
    }
    console.log(`[Board] ${post.authorName} posted [${post.type}]: ${post.content}`);
  }

  getActiveBoard(): BoardPost[] {
    return this.board.filter(p => !p.revoked);
  }

  getBoardSummary(): string {
    const active = this.getActiveBoard();
    if (active.length === 0) return 'The village board is empty.';
    return active.map(p => `[${p.type.toUpperCase()}] ${p.authorName}: "${p.content}"`).join('\n');
  }

  revokePost(postId: string): void {
    const post = this.board.find(p => p.id === postId);
    if (post) post.revoked = true;
  }

  getSnapshot(): WorldSnapshot {
    return {
      time: { ...this.time },
      agents: Array.from(this.agents.values()),
      conversations: Array.from(this.conversations.values()).filter(c => !c.endedAt),
      areas: AREAS,
      board: this.getActiveBoard(),
      events: this.events.filter(e => e.active),
      elections: Array.from(this.elections.values()),
      properties: Array.from(this.properties.values()),
      reputation: this.reputation,
    };
  }

  addConversation(conv: Conversation): void {
    this.conversations.set(conv.id, conv);
  }

  getConversation(id: string): Conversation | undefined {
    return this.conversations.get(id);
  }

  endConversation(id: string): void {
    const conv = this.conversations.get(id);
    if (conv) {
      conv.endedAt = Date.now();
    }
  }

  getActiveConversations(): Conversation[] {
    const active: Conversation[] = [];
    for (const conv of this.conversations.values()) {
      if (!conv.endedAt) {
        active.push(conv);
      }
    }
    return active;
  }

  // --- Items ---

  addItem(item: Item): void {
    this.items.set(item.id, item);
    const owner = this.agents.get(item.ownerId);
    if (owner) {
      owner.inventory.push(item);
    }
  }

  removeItem(id: string): void {
    const item = this.items.get(id);
    if (!item) return;
    const owner = this.agents.get(item.ownerId);
    if (owner) {
      owner.inventory = owner.inventory.filter(i => i.id !== id);
    }
    this.items.delete(id);
  }

  transferItem(itemId: string, fromId: string, toId: string): void {
    const item = this.items.get(itemId);
    if (!item) return;
    const from = this.agents.get(fromId);
    const to = this.agents.get(toId);
    if (!from || !to) return;

    from.inventory = from.inventory.filter(i => i.id !== itemId);
    item.ownerId = toId;
    to.inventory.push(item);
  }

  gatherMaterial(agentId: string, areaId: string): Item | null {
    const spawn = this.materialSpawns.find(s => s.areaId === areaId);
    if (!spawn) return null;

    // Check respawn timer
    const now = this.time.totalMinutes;
    if (spawn.lastGathered !== undefined && (now - spawn.lastGathered) < spawn.respawnMinutes) {
      return null;
    }

    spawn.lastGathered = now;

    const item: Item = {
      id: crypto.randomUUID(),
      name: spawn.material,
      description: `${spawn.material} gathered from ${areaId}`,
      ownerId: agentId,
      createdBy: agentId,
      value: 5,
      type: 'material',
    };

    this.addItem(item);
    console.log(`[World] ${this.agents.get(agentId)?.config.name} gathered ${spawn.material} from ${areaId}`);
    return item;
  }

  // --- Secrets ---

  addSecret(secret: Secret): void {
    this.secrets.push(secret);
  }

  getSecretsFor(agentId: string): Secret[] {
    return this.secrets.filter(
      s => s.holderId === agentId || s.aboutAgentId === agentId || s.sharedWith.includes(agentId),
    );
  }

  // --- World Events ---

  addWorldEvent(event: WorldEvent): void {
    this.events.push(event);
  }

  getActiveEvents(): WorldEvent[] {
    return this.events.filter(e => e.active);
  }

  expireEvents(): void {
    const now = Date.now();
    for (const event of this.events) {
      if (event.active && (now - event.startTime) >= event.duration * 60_000) {
        event.active = false;
        console.log(`[World] Event expired: ${event.description}`);
      }
    }
  }

  // --- Elections ---

  startElection(election: Election): void {
    this.elections.set(election.id, election);
    console.log(`[World] Election started for ${election.position} (ends day ${election.endDay})`);
  }

  castVote(electionId: string, voterId: string, candidateId: string): void {
    const election = this.elections.get(electionId);
    if (!election || !election.active) return;
    if (!election.candidates.includes(candidateId)) {
      election.candidates.push(candidateId);
    }
    election.votes[voterId] = candidateId;
    console.log(`[World] ${voterId} voted for ${candidateId} in ${election.position} election`);
  }

  resolveElection(electionId: string): Election | null {
    const election = this.elections.get(electionId);
    if (!election || !election.active) return null;

    // Tally votes
    const tally: Record<string, number> = {};
    for (const candidateId of Object.values(election.votes)) {
      tally[candidateId] = (tally[candidateId] || 0) + 1;
    }

    // Find winner
    let maxVotes = 0;
    let winnerId: string | undefined;
    for (const [candidateId, count] of Object.entries(tally)) {
      if (count > maxVotes) {
        maxVotes = count;
        winnerId = candidateId;
      }
    }

    election.winner = winnerId;
    election.active = false;
    console.log(`[World] Election for ${election.position} resolved — winner: ${winnerId ?? 'none'}`);
    return election;
  }

  // --- Property ---

  claimProperty(areaId: string, agentId: string, day: number): Property | null {
    if (this.properties.has(areaId)) return null; // already owned

    const property: Property = {
      areaId,
      ownerId: agentId,
      acquiredDay: day,
    };
    this.properties.set(areaId, property);
    console.log(`[World] ${this.agents.get(agentId)?.config.name} claimed ${areaId}`);
    return property;
  }

  getPropertyOwner(areaId: string): string | undefined {
    return this.properties.get(areaId)?.ownerId;
  }

  // --- Reputation ---

  getReputation(fromId: string, toId: string): number {
    const entry = this.reputation.find(r => r.fromAgentId === fromId && r.toAgentId === toId);
    return entry?.score ?? 0;
  }

  updateReputation(fromId: string, toId: string, delta: number, reason: string): void {
    const existing = this.reputation.find(r => r.fromAgentId === fromId && r.toAgentId === toId);
    if (existing) {
      existing.score = Math.max(-100, Math.min(100, existing.score + delta));
      existing.reason = reason;
      existing.lastUpdated = Date.now();
    } else {
      this.reputation.push({
        fromAgentId: fromId,
        toAgentId: toId,
        score: Math.max(-100, Math.min(100, delta)),
        reason,
        lastUpdated: Date.now(),
      });
    }
    console.log(`[World] Reputation ${fromId} → ${toId}: ${delta > 0 ? '+' : ''}${delta} (${reason})`);
  }

  // --- Skills ---

  addSkill(agentId: string, skill: Skill): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const existing = agent.skills.find(s => s.name === skill.name);
    if (existing) {
      existing.level = Math.min(10, existing.level + 1);
      if (skill.learnedFrom) existing.learnedFrom = skill.learnedFrom;
    } else {
      agent.skills.push({ ...skill });
    }
    console.log(`[World] ${agent.config.name} skill update: ${skill.name} (level ${existing?.level ?? skill.level})`);
  }
}
