import type { Agent, AgentState, Artifact, ArtifactReaction, BoardPost, BoardPostType, Building, Conversation, Election, GameTime, Institution, InstitutionMember, Item, MapArea, MaterialSpawn, Mood, Position, Property, ReputationEntry, Season, Secret, Skill, Technology, Weather, WorldObject, WorldSnapshot } from '@ai-village/shared';
import type { TradeProposal } from '@ai-village/ai-engine';
import { RESOURCES, SKILLS, BUILDINGS } from '@ai-village/ai-engine';
import { AREAS, getAreaAt as mapGetAreaAt } from '../map/village.js';
import { SpatialGrid } from './spatial-grid.js';

export class World {
  agents: Map<string, Agent> = new Map();
  readonly grid: SpatialGrid = new SpatialGrid(8);
  conversations: Map<string, Conversation> = new Map();
  board: BoardPost[] = [];
  time: GameTime;
  items: Map<string, Item> = new Map();
  secrets: Secret[] = [];
  elections: Map<string, Election> = new Map();
  properties: Map<string, Property> = new Map();
  reputation: ReputationEntry[] = [];
  materialSpawns: MaterialSpawn[] = [];
  institutions: Map<string, Institution> = new Map();
  artifacts: Artifact[] = [];
  buildings: Map<string, Building> = new Map();
  technologies: Technology[] = [];
  worldObjects: Map<string, WorldObject> = new Map();
  weather: Weather;

  // --- Deterministic action resolver state ---
  dailyGatherCounts: Map<string, number> = new Map();
  // Freedom 5: Resource pools — persistent depletion. Key = areaId:resource, value = remaining pool (0-100)
  resourcePools: Map<string, number> = new Map();
  // Freedom 5: Cultural names — key = areaId, value = { name, mentionCount, lastMentioned }
  culturalNames: Map<string, { name: string; mentionCount: number; lastMentionedDay: number }> = new Map();
  activeBuildProjects: Map<string, { buildingDefId: string; sessionsComplete: number; ownerId: string; location: string }> = new Map();
  pendingTrades: Map<string, TradeProposal> = new Map();

  constructor() {
    this.time = {
      day: 1,
      hour: 5,
      minute: 0,
      totalMinutes: 5 * 60,
    };

    this.weather = {
      current: 'clear',
      season: 'spring',
      temperature: 50,
      seasonDay: 0,
    };

    this.materialSpawns = [
      { areaId: 'forest', material: 'wood', respawnMinutes: 15 },
      { areaId: 'forest', material: 'mushrooms', respawnMinutes: 20 },
      { areaId: 'forest_south', material: 'wood', respawnMinutes: 15 },
      { areaId: 'farm', material: 'wheat', respawnMinutes: 15 },
      { areaId: 'farm', material: 'vegetables', respawnMinutes: 15 },
      { areaId: 'lake', material: 'fish', respawnMinutes: 10 },
      { areaId: 'lake', material: 'clay', respawnMinutes: 30 },
      { areaId: 'garden', material: 'herbs', respawnMinutes: 15 },
      { areaId: 'garden', material: 'flowers', respawnMinutes: 20 },
    ];
  }

  addAgent(agent: Agent): void {
    // Ensure new fields have defaults
    if (!agent.mood) agent.mood = 'neutral';
    if (!agent.inventory) agent.inventory = [];
    if (!agent.skills) agent.skills = [];
    this.agents.set(agent.id, agent);
    this.grid.register(agent.id, agent.position);
  }

  getAgent(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  updateAgentPosition(id: string, pos: Position): void {
    const agent = this.agents.get(id);
    if (agent) {
      const from = { ...agent.position };
      agent.position = { x: pos.x, y: pos.y };
      this.grid.move(id, from, pos);
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
    const ids = this.grid.getNearby(pos, radius);
    const nearby: Agent[] = [];
    for (const id of ids) {
      const agent = this.agents.get(id);
      if (!agent) continue;
      const dx = agent.position.x - pos.x;
      const dy = agent.position.y - pos.y;
      if (Math.sqrt(dx * dx + dy * dy) <= radius) {
        nearby.push(agent);
      }
    }
    return nearby;
  }

  getAreaAt(pos: Position): MapArea | undefined {
    return mapGetAreaAt(pos);
  }

  getAgentsInArea(areaId: string): Agent[] {
    const result: Agent[] = [];
    for (const agent of this.agents.values()) {
      if (agent.alive === false) continue;
      const area = this.getAreaAt(agent.position);
      if (area?.id === areaId) result.push(agent);
    }
    return result;
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

  /**
   * Reset daily counters at midnight. Called by engine when day transitions.
   */
  resetDailyCounters(): void {
    this.dailyGatherCounts.clear();
    // Expire old or resolved trade proposals
    const now = Date.now();
    for (const [id, t] of this.pendingTrades) {
      if (t.expiresAt < now || t.status !== 'pending') this.pendingTrades.delete(id);
    }
    // Freedom 5: Regenerate resource pools (to 80%, creating long-term depletion)
    this.regenerateResourcePools();
    console.log(`[World] Daily counters reset (day ${this.time.day})`);
  }

  spoilFood(): void {
    const nameToDef = new Map<string, { spoilDays: number }>();
    for (const [id, def] of Object.entries(RESOURCES)) {
      nameToDef.set(def.name, def);
      nameToDef.set(id, def);
    }

    const MINUTES_PER_DAY = 24 * 60;
    const spoiled: Item[] = [];

    for (const [_itemId, item] of this.items) {
      if (!item.createdAt) continue;
      const def = nameToDef.get(item.name) ?? nameToDef.get(item.name.replace(/ /g, '_'));
      if (!def || def.spoilDays <= 0) continue;

      const ageMinutes = this.time.totalMinutes - item.createdAt;
      const ageDays = ageMinutes / MINUTES_PER_DAY;
      if (ageDays >= def.spoilDays) {
        spoiled.push(item);
      }
    }

    for (const item of spoiled) {
      this.removeItem(item.id);
      const owner = this.agents.get(item.ownerId);
      console.log(`[World] ${item.name} owned by ${owner?.config.name ?? item.ownerId} has spoiled`);
    }
    if (spoiled.length > 0) {
      console.log(`[World] ${spoiled.length} items spoiled at midnight`);
    }
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

  getBoardSummary(channel?: 'all' | 'group', groupId?: string): string {
    let posts = this.getActiveBoard();

    if (channel === 'group' && groupId) {
      posts = posts.filter(p => p.channel === 'group' && p.groupId === groupId);
    } else {
      // Default: show all-channel posts only
      posts = posts.filter(p => p.channel === 'all' || !p.channel);
    }

    if (posts.length === 0) return '';

    // Dedup by author (latest per author), cap at 8
    const latestByAuthor = new Map<string, typeof posts[0]>();
    for (const post of posts) {
      const existing = latestByAuthor.get(post.authorId);
      if (!existing || post.timestamp > existing.timestamp) {
        latestByAuthor.set(post.authorId, post);
      }
    }

    const deduped = Array.from(latestByAuthor.values())
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 8);

    return deduped
      .map(p => p.authorId === 'system'
        ? `[${p.type.toUpperCase()}] ${p.content}`
        : `[${p.type.toUpperCase()}] ${p.authorName}: "${p.content}"`)
      .join('\n');
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
      elections: Array.from(this.elections.values()),
      properties: Array.from(this.properties.values()),
      reputation: this.reputation,
      weather: { ...this.weather },
      institutions: Array.from(this.institutions.values()).filter(i => !i.dissolved),
      artifacts: this.artifacts.slice(-100),
      buildings: Array.from(this.buildings.values()),
      technologies: this.technologies,
      worldObjects: Array.from(this.worldObjects.values()),
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

  getMaxInventory(agentId: string): number {
    const BASE_INVENTORY = 30;
    const agent = this.agents.get(agentId);
    if (!agent) return BASE_INVENTORY;
    const area = this.getAreaAt(agent.position);
    if (!area) return BASE_INVENTORY;
    let bonus = 0;
    for (const b of this.getBuildingsAt(area.id)) {
      if (!b.defId || !BUILDINGS[b.defId]) continue;
      const bDef = BUILDINGS[b.defId];
      const storageEffect = bDef.effects?.find((e: any) => e.type === 'storage_bonus');
      if (storageEffect) bonus = Math.max(bonus, storageEffect.value);
    }
    return BASE_INVENTORY + Math.round(bonus * 10);
  }

  addItem(item: Item): void {
    const maxInv = this.getMaxInventory(item.ownerId);
    const owner = this.agents.get(item.ownerId);
    if (owner && owner.inventory.length >= maxInv) return; // inventory full
    if (!item.createdAt) item.createdAt = this.time.totalMinutes;
    this.items.set(item.id, item);
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
    if (to.inventory.length >= this.getMaxInventory(toId)) return; // receiver full

    from.inventory = from.inventory.filter(i => i.id !== itemId);
    item.ownerId = toId;
    to.inventory.push(item);
  }

  gatherMaterial(agentId: string, areaId: string): Item | null {
    const maxInv = this.getMaxInventory(agentId);
    const agent = this.agents.get(agentId);
    if (agent && agent.inventory.length >= maxInv) {
      console.log(`[World] ${agent.config.name} can't gather — inventory full (${agent.inventory.length}/${maxInv})`);
      return null;
    }

    const now = this.time.totalMinutes;

    // Find all spawns for this area with elapsed respawn timers
    const availableSpawns = this.materialSpawns.filter(s => {
      if (s.areaId !== areaId) return false;
      let effectiveRespawn = s.respawnMinutes;
      for (const tech of this.technologies) {
        for (const effect of tech.effects) {
          const lowerEffect = effect.toLowerCase();
          if (lowerEffect.includes(s.areaId) || lowerEffect.includes(s.material.toLowerCase())) {
            effectiveRespawn = Math.floor(effectiveRespawn * 0.7);
            break;
          }
        }
      }
      return s.lastGathered === undefined || (now - s.lastGathered) >= effectiveRespawn;
    });

    if (availableSpawns.length === 0) return null;

    // Pick a random available spawn
    const spawn = availableSpawns[Math.floor(Math.random() * availableSpawns.length)];
    spawn.lastGathered = now;

    // Edible materials become food items
    const edibleMaterials = ['mushrooms', 'fish', 'vegetables', 'bread', 'coffee', 'stew', 'wheat', 'herbs'];
    const isFood = edibleMaterials.includes(spawn.material.toLowerCase());

    const item: Item = {
      id: crypto.randomUUID(),
      name: spawn.material,
      description: `${spawn.material} gathered from ${areaId}`,
      ownerId: agentId,
      createdBy: agentId,
      value: 5,
      type: isFood ? 'food' : 'material',
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

  addSkillXP(agentId: string, skillName: string, xpGained: number, learnedFrom?: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    let skill = agent.skills.find(s => s.name === skillName);
    if (!skill) {
      skill = { name: skillName, level: 1, xp: 0, learnedFrom };
      agent.skills.push(skill);
    }

    const skillDef = SKILLS[skillName] ?? SKILLS[skillName.toLowerCase()];
    const XP_PER_LEVEL = skillDef?.xpPerLevel ?? 50;
    const MAX_LEVEL = 10;
    skill.xp = (skill.xp ?? 0) + xpGained;

    while (skill.xp >= XP_PER_LEVEL && skill.level < MAX_LEVEL) {
      skill.xp -= XP_PER_LEVEL;
      skill.level++;
      console.log(`[World] ${agent.config.name} leveled up ${skillName} to ${skill.level}!`);
    }
    if (learnedFrom) skill.learnedFrom = learnedFrom;
    console.log(`[World] ${agent.config.name} ${skillName} +${xpGained} XP (level ${skill.level}, ${skill.xp}/${XP_PER_LEVEL} XP)`);
  }

  // --- Agent Death (Phase 3) ---

  killAgent(id: string, cause: string): Item[] {
    const agent = this.agents.get(id);
    if (!agent) return [];

    agent.state = 'dead';
    agent.alive = false;
    agent.causeOfDeath = cause;
    this.grid.unregister(id);

    // Drop all items — set ownerId to 'unclaimed'
    const droppedItems: Item[] = [];
    for (const item of agent.inventory) {
      item.ownerId = 'unclaimed';
      droppedItems.push(item);
    }
    agent.inventory = [];

    console.log(`[World] ${agent.config.name} died: ${cause}. Dropped ${droppedItems.length} items.`);
    return droppedItems;
  }

  // --- Institutions (Phase 5) ---

  addInstitution(inst: Institution): void {
    this.institutions.set(inst.id, inst);
    console.log(`[World] Institution created: ${inst.name} (${inst.type})`);
  }

  getInstitution(id: string): Institution | undefined {
    return this.institutions.get(id);
  }

  dissolveInstitution(id: string): void {
    const inst = this.institutions.get(id);
    if (inst) {
      inst.dissolved = true;
      console.log(`[World] Institution dissolved: ${inst.name}`);
    }
  }

  addInstitutionMember(instId: string, member: InstitutionMember): void {
    const inst = this.institutions.get(instId);
    if (!inst) return;
    inst.members.push(member);
    // Track on the agent as well
    const agent = this.agents.get(member.agentId);
    if (agent) {
      if (!agent.institutionIds) agent.institutionIds = [];
      agent.institutionIds.push(instId);
    }
    console.log(`[World] ${member.agentId} joined ${inst.name} as ${member.role}`);
  }

  removeInstitutionMember(instId: string, agentId: string): void {
    const inst = this.institutions.get(instId);
    if (!inst) return;
    inst.members = inst.members.filter(m => m.agentId !== agentId);
    // Remove from agent tracking
    const agent = this.agents.get(agentId);
    if (agent && agent.institutionIds) {
      agent.institutionIds = agent.institutionIds.filter(id => id !== instId);
    }
    console.log(`[World] ${agentId} left ${inst.name}`);
  }

  updateInstitutionTreasury(instId: string, delta: number): number {
    const inst = this.institutions.get(instId);
    if (!inst) return 0;
    inst.treasury = Math.max(0, inst.treasury + delta);
    console.log(`[World] ${inst.name} treasury ${delta > 0 ? '+' : ''}${delta} → ${inst.treasury}`);
    return inst.treasury;
  }

  // --- Artifacts (Phase 6) ---

  addArtifact(artifact: Artifact): void {
    this.artifacts.push(artifact);
    // Cap at 200
    if (this.artifacts.length > 200) {
      this.artifacts = this.artifacts.slice(-200);
    }
    console.log(`[World] Artifact created: "${artifact.title}" by ${artifact.creatorName} (${artifact.type})`);
  }

  getArtifactsAt(areaId: string): Artifact[] {
    return this.artifacts.filter(a => a.location === areaId);
  }

  getPublicArtifacts(): Artifact[] {
    return this.artifacts.filter(a => a.visibility === 'public');
  }

  addArtifactReaction(artifactId: string, reaction: ArtifactReaction): void {
    const artifact = this.artifacts.find(a => a.id === artifactId);
    if (artifact) {
      artifact.reactions.push(reaction);
      console.log(`[World] ${reaction.agentName} reacted to "${artifact.title}": ${reaction.reaction}`);
    }
  }

  // --- Buildings (Phase 7) ---

  addBuilding(building: Building): void {
    this.buildings.set(building.id, building);
    console.log(`[World] Building constructed: ${building.name} (${building.type}) at ${building.areaId}`);
  }

  getBuilding(id: string): Building | undefined {
    return this.buildings.get(id);
  }

  getBuildingsAt(areaId: string): Building[] {
    return Array.from(this.buildings.values()).filter(b => b.areaId === areaId);
  }

  damageBuilding(id: string, amount: number): Building | undefined {
    const building = this.buildings.get(id);
    if (!building) return undefined;
    building.durability = Math.max(0, building.durability - amount);
    console.log(`[World] ${building.name} damaged by ${amount} → durability ${building.durability}/${building.maxDurability}`);
    return building;
  }

  repairBuilding(id: string, amount: number): void {
    const building = this.buildings.get(id);
    if (!building) return;
    building.durability = Math.min(building.maxDurability, building.durability + amount);
    console.log(`[World] ${building.name} repaired by ${amount} → durability ${building.durability}/${building.maxDurability}`);
  }

  // --- Technology (Phase 7) ---

  addTechnology(tech: Technology): void {
    this.technologies.push(tech);
    console.log(`[World] Technology discovered: ${tech.name} by ${tech.inventorName}`);
  }

  getTechnologies(): Technology[] {
    return this.technologies;
  }

  hasTechnology(name: string): boolean {
    return this.technologies.some(t => t.name === name);
  }

  // --- Freedom 5: Resource Depletion ---

  /**
   * Get the resource pool level for an area:resource combo (0-100).
   * Initializes at 100 if not tracked yet.
   */
  getResourcePool(areaId: string, resource: string): number {
    const key = `${areaId}:${resource}`;
    if (!this.resourcePools.has(key)) this.resourcePools.set(key, 100);
    return this.resourcePools.get(key)!;
  }

  /**
   * Deplete a resource pool after gathering. Each gather depletes by 3-5 points.
   */
  depleteResource(areaId: string, resource: string, amount: number = 4): void {
    const key = `${areaId}:${resource}`;
    const current = this.getResourcePool(areaId, resource);
    this.resourcePools.set(key, Math.max(0, current - amount));
  }

  /**
   * Regenerate resource pools. Called at midnight.
   * Pools regenerate to 80% of max (slight long-term depletion).
   */
  regenerateResourcePools(): void {
    for (const [key, value] of this.resourcePools) {
      // Regenerate 20% of missing pool, capped at 80
      const missing = 80 - value;
      if (missing > 0) {
        this.resourcePools.set(key, Math.min(80, value + Math.ceil(missing * 0.2)));
      }
    }
  }

  /**
   * Hourly micro-regeneration of resource pools. Season-aware.
   * Called every game hour from engine. Slower than midnight regen.
   */
  regenerateResourcePoolsHourly(seasonGatherMultipliers?: Record<string, number>): void {
    for (const spawn of this.materialSpawns) {
      const key = `${spawn.areaId}:${spawn.material}`;
      const current = this.resourcePools.get(key);
      if (current === undefined || current >= 100) continue;
      // Base: 0.5 units per game-hour, scaled by season
      const seasonMultiplier = seasonGatherMultipliers?.[spawn.material] ?? 1.0;
      const regenRate = 0.5 * seasonMultiplier;
      if (regenRate <= 0) continue;
      this.resourcePools.set(key, Math.min(100, current + regenRate));
    }
  }

  // --- Freedom 5: Cultural Naming ---

  /**
   * Record a cultural name mention. When 3+ agents use the same name for a place,
   * it becomes the official cultural name.
   */
  recordCulturalNameMention(areaId: string, name: string, day: number): string | null {
    const existing = this.culturalNames.get(areaId);
    if (existing && existing.name === name) {
      existing.mentionCount++;
      existing.lastMentionedDay = day;
      if (existing.mentionCount >= 3) {
        console.log(`[World] Cultural name established: ${areaId} → "${name}" (${existing.mentionCount} mentions)`);
        return name;
      }
    } else {
      // New name or different name — reset
      this.culturalNames.set(areaId, { name, mentionCount: 1, lastMentionedDay: day });
    }
    return null;
  }

  /**
   * Get the cultural name for an area, if one has been established.
   * Reverts if not mentioned for 14 days.
   */
  getCulturalName(areaId: string): string | null {
    const entry = this.culturalNames.get(areaId);
    if (!entry || entry.mentionCount < 3) return null;
    // Decay: revert if not mentioned for 14 days
    if (this.time.day - entry.lastMentionedDay > 14) {
      this.culturalNames.delete(areaId);
      return null;
    }
    return entry.name;
  }

  // --- World Objects (Freedom 1: open-ended actions) ---

  addWorldObject(obj: WorldObject): void {
    this.worldObjects.set(obj.id, obj);
    // Cap at 200
    if (this.worldObjects.size > 200) {
      // Remove oldest by createdAt
      let oldest: WorldObject | undefined;
      for (const wo of this.worldObjects.values()) {
        if (!oldest || wo.createdAt < oldest.createdAt) oldest = wo;
      }
      if (oldest) this.worldObjects.delete(oldest.id);
    }
    console.log(`[World] WorldObject created: "${obj.name}" by ${obj.creatorName} at ${obj.areaId}`);
  }

  getWorldObject(id: string): WorldObject | undefined {
    return this.worldObjects.get(id);
  }

  getWorldObjectsAt(areaId: string): WorldObject[] {
    return Array.from(this.worldObjects.values()).filter(o => o.areaId === areaId);
  }

  removeWorldObject(id: string): void {
    const obj = this.worldObjects.get(id);
    if (obj) {
      this.worldObjects.delete(id);
      console.log(`[World] WorldObject removed: "${obj.name}"`);
    }
  }

  touchWorldObject(id: string): void {
    const obj = this.worldObjects.get(id);
    if (obj) obj.lastInteractedAt = this.time.totalMinutes;
  }

  // --- Weather & Seasons (Phase 7) ---

  advanceSeason(): void {
    const seasonOrder: Season[] = ['spring', 'summer', 'autumn', 'winter'];
    const currentIndex = seasonOrder.indexOf(this.weather.season);
    this.weather.season = seasonOrder[(currentIndex + 1) % 4];
    this.weather.seasonDay = 0;

    // Update temperature range based on season
    const temperatureRanges: Record<Season, { min: number; max: number }> = {
      spring: { min: 35, max: 65 },
      summer: { min: 60, max: 95 },
      autumn: { min: 30, max: 60 },
      winter: { min: 5, max: 35 },
    };
    const range = temperatureRanges[this.weather.season];
    this.weather.temperature = Math.round((range.min + range.max) / 2);
    console.log(`[World] Season changed to ${this.weather.season} (temp: ${this.weather.temperature})`);
  }

  updateWeather(): string {
    const seasonWeather: Record<Season, string[]> = {
      spring: ['rain', 'clear', 'fog'],
      summer: ['clear', 'heatwave', 'storm'],
      autumn: ['rain', 'fog', 'clear'],
      winter: ['snow', 'storm', 'clear', 'fog'],
    };

    const options = seasonWeather[this.weather.season];
    this.weather.current = options[Math.floor(Math.random() * options.length)];

    // Adjust temperature slightly based on weather
    const tempAdjust: Record<string, number> = {
      heatwave: 10,
      storm: -5,
      snow: -10,
      rain: -3,
      fog: -2,
      clear: 2,
    };
    this.weather.temperature = Math.max(0, Math.min(100,
      this.weather.temperature + (tempAdjust[this.weather.current] ?? 0),
    ));

    console.log(`[World] Weather: ${this.weather.current} (${this.weather.temperature}°)`);
    return this.weather.current;
  }
}
