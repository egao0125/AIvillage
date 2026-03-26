import type { Memory, Agent, AgentConfig, RelationshipDossier, ActiveConcern } from '@ai-village/shared';
import type { MemoryStore, LLMProvider } from '../index.js';

export class FourStreamMemory {
  // Stream 1: Narrative Timeline — ring buffer of recent events
  private timeline: Memory[] = [];
  private static readonly TIMELINE_MAX = 50;

  // Stream 2: Relationship Dossiers — per-person profiles
  private dossiers: Map<string, RelationshipDossier> = new Map();

  // Stream 3: Active Concerns — always-present short list
  private concerns: ActiveConcern[] = [];

  // Stream 4: Beliefs — synthesized reflections
  private beliefs: Memory[] = [];

  // Identity — immutable core
  private identity: Memory[] = [];

  constructor(
    private agentId: string,
    private backingStore: MemoryStore,
    private agent: Agent,
  ) {}

  // --- INITIALIZATION ---

  seedIdentity(config: AgentConfig): void {
    const soul = config.soul || config.backstory || '';
    this.identity = [{
      id: 'identity-core',
      agentId: this.agentId,
      type: 'reflection',
      content: `I am ${config.name}, age ${config.age}. ${soul}`,
      importance: 10,
      isCore: true,
      timestamp: 0,
      relatedAgentIds: [],
    }];
    if (config.goal) {
      this.identity.push({
        id: 'identity-goal',
        agentId: this.agentId,
        type: 'reflection',
        content: `My goal: ${config.goal}`,
        importance: 10,
        isCore: true,
        timestamp: 0,
        relatedAgentIds: [],
      });
    }
    // Also persist to backing store
    for (const m of this.identity) {
      void this.backingStore.add(m);
    }

    // Load existing dossiers and concerns from agent state
    if (this.agent.dossiers) {
      for (const d of this.agent.dossiers) {
        this.dossiers.set(d.targetId, d);
      }
    }
    if (this.agent.activeConcerns) {
      this.concerns = [...this.agent.activeConcerns];
    }
  }

  // --- STREAM 1: TIMELINE ---

  /** Add an event to the narrative timeline */
  async addEvent(memory: Memory): Promise<void> {
    // Store in backing store for persistence
    await this.backingStore.add(memory);

    // Add to timeline ring buffer — only HIGH-SIGNAL events
    if (memory.type === 'action_outcome' ||
        memory.type === 'conversation' ||
        memory.type === 'thought' ||
        (memory.type === 'observation' && memory.importance >= 6)) {
      this.timeline.push(memory);
      if (this.timeline.length > FourStreamMemory.TIMELINE_MAX) {
        this.timeline.shift();
      }
    }
  }

  /** Get the last N events for working memory */
  getRecentTimeline(n: number = 5): Memory[] {
    return this.timeline.slice(-n);
  }

  // --- STREAM 2: DOSSIERS ---

  getDossier(targetId: string): RelationshipDossier | undefined {
    return this.dossiers.get(targetId);
  }

  getDossiers(targetIds: string[]): RelationshipDossier[] {
    return targetIds
      .map(id => this.dossiers.get(id))
      .filter((d): d is RelationshipDossier => d !== undefined);
  }

  /** Update or create a dossier after an interaction. One LLM call. */
  async updateDossier(
    targetId: string,
    targetName: string,
    interactionSummary: string,
    llm: LLMProvider,
  ): Promise<void> {
    const existing = this.dossiers.get(targetId);
    const existingText = existing
      ? `Previous understanding of ${targetName}: ${existing.summary}\nTrust level: ${existing.trust}\nActive commitments: ${existing.activeCommitments.join('; ') || 'none'}`
      : `You have never interacted with ${targetName} before.`;

    const recentWithPerson = this.timeline
      .filter(m => m.relatedAgentIds?.includes(targetId))
      .slice(-5)
      .map(m => m.content)
      .join('\n');

    const prompt = `You are ${this.agent.config.name}. You just interacted with ${targetName}.

What happened: ${interactionSummary}

${recentWithPerson ? 'Recent history with them:\n' + recentWithPerson + '\n' : ''}
${existingText}

Update your mental model of ${targetName}. Reply with JSON ONLY:
{
  "summary": "3-5 sentences: Who is ${targetName} to you? What defines your relationship? What do you expect from them?",
  "trust": number from -100 to 100,
  "activeCommitments": ["things you owe each other, max 3"],
  "concerns": ["any unresolved issues with them, max 2"]
}`;

    try {
      const response = await llm.complete(
        `You are ${this.agent.config.name}. Be honest about your feelings and judgments.`,
        prompt
      );
      const cleaned = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);

      const dossier: RelationshipDossier = {
        agentId: this.agentId,
        targetId,
        targetName,
        summary: parsed.summary || `I know ${targetName}.`,
        trust: Math.max(-100, Math.min(100, parsed.trust ?? existing?.trust ?? 0)),
        activeCommitments: (parsed.activeCommitments || []).slice(0, 3),
        lastInteraction: Date.now(),
        lastUpdated: Date.now(),
      };

      this.dossiers.set(targetId, dossier);
      this.syncDossiersToAgent();

      if (parsed.concerns) {
        for (const concern of parsed.concerns.slice(0, 2)) {
          this.addConcern({
            id: crypto.randomUUID(),
            content: concern,
            category: 'unresolved',
            relatedAgentIds: [targetId],
            createdAt: Date.now(),
          });
        }
      }

      console.log(`[Dossier] ${this.agent.config.name} updated dossier on ${targetName}: trust=${dossier.trust}`);
    } catch (err) {
      console.error(`[Dossier] Failed to update dossier for ${targetName}:`, err);
      if (!existing) {
        this.dossiers.set(targetId, {
          agentId: this.agentId,
          targetId,
          targetName,
          summary: `I interacted with ${targetName}. ${interactionSummary}`,
          trust: 0,
          activeCommitments: [],
          lastInteraction: Date.now(),
          lastUpdated: Date.now(),
        });
        this.syncDossiersToAgent();
      }
    }
  }

  /** Adjust trust for a specific person (from social actions) */
  adjustTrust(targetId: string, delta: number): void {
    const d = this.dossiers.get(targetId);
    if (d) {
      d.trust = Math.max(-100, Math.min(100, d.trust + delta));
      d.lastUpdated = Date.now();
      this.syncDossiersToAgent();
    }

    // Also update mentalModels for backward compatibility
    if (!this.agent.mentalModels) this.agent.mentalModels = [];
    let model = this.agent.mentalModels.find(m => m.targetId === targetId);
    if (!model) {
      model = { targetId, trust: 0, predictedGoal: 'unknown', emotionalStance: 'neutral', notes: [], lastUpdated: Date.now() };
      this.agent.mentalModels.push(model);
    }
    model.trust = Math.max(-100, Math.min(100, model.trust + delta));
    model.lastUpdated = Date.now();
  }

  private syncDossiersToAgent(): void {
    this.agent.dossiers = Array.from(this.dossiers.values());
  }

  // --- STREAM 3: ACTIVE CONCERNS ---

  addConcern(concern: ActiveConcern): void {
    // Deduplicate by exact content only — category+person was too aggressive
    const existing = this.concerns.find(c =>
      c.content.toLowerCase() === concern.content.toLowerCase()
    );
    if (existing) return;

    this.concerns.push(concern);
    if (this.concerns.length > 10) {
      const removable = this.concerns.findIndex(c => c.resolved);
      if (removable >= 0) this.concerns.splice(removable, 1);
      else this.concerns.shift();
    }
    this.syncConcernsToAgent();
  }

  resolveConcern(id: string): void {
    const concern = this.concerns.find(c => c.id === id);
    if (concern) concern.resolved = true;
    this.syncConcernsToAgent();
  }

  pruneExpired(currentGameMinutes: number): void {
    this.concerns = this.concerns.filter(c => {
      if (c.permanent) return true;  // Rules never expire
      if (c.resolved) return false;
      if (c.expiresAt && currentGameMinutes >= c.expiresAt) return false;
      return true;
    });
    this.syncConcernsToAgent();
  }

  getAllConcerns(): ActiveConcern[] {
    return this.concerns.filter(c => !c.resolved);
  }

  private syncConcernsToAgent(): void {
    this.agent.activeConcerns = [...this.concerns];
  }

  // --- STREAM 4: BELIEFS ---

  addBelief(belief: Memory): void {
    this.beliefs.push(belief);
    void this.backingStore.add(belief);
    if (this.beliefs.length > 20) {
      this.beliefs.sort((a, b) => b.importance - a.importance);
      this.beliefs = this.beliefs.slice(0, 20);
    }
  }

  getBeliefsAbout(targetIds: string[]): Memory[] {
    return this.beliefs.filter(b =>
      b.relatedAgentIds?.some(id => targetIds.includes(id))
    );
  }

  getTopBeliefs(n: number = 3): Memory[] {
    return [...this.beliefs]
      .sort((a, b) => b.importance - a.importance)
      .slice(0, n);
  }

  // --- WORKING MEMORY ASSEMBLY ---

  buildWorkingMemory(nearbyAgentIds?: string[]): {
    identity: string;
    concerns: string;
    dossiers: string;
    beliefs: string;
    timeline: string;
  } {
    const identity = this.identity.map(m => m.content).join('\n');

    const activeConcerns = this.getAllConcerns();
    const concerns = activeConcerns.length > 0
      ? activeConcerns.map(c => `- ${c.content}`).join('\n')
      : '';

    let dossiers = '';
    if (nearbyAgentIds && nearbyAgentIds.length > 0) {
      const nearbyDossiers = this.getDossiers(nearbyAgentIds);
      if (nearbyDossiers.length > 0) {
        dossiers = nearbyDossiers.map(d => {
          const commitStr = d.activeCommitments.length > 0
            ? `\n  Commitments: ${d.activeCommitments.join('; ')}`
            : '';
          return `${d.targetName} (trust: ${d.trust}): ${d.summary}${commitStr}`;
        }).join('\n\n');
      }
    }

    const personBeliefs = nearbyAgentIds
      ? this.getBeliefsAbout(nearbyAgentIds)
      : [];
    const topBeliefs = this.getTopBeliefs(3);
    const allBeliefs = [...personBeliefs];
    for (const b of topBeliefs) {
      if (!allBeliefs.some(pb => pb.id === b.id)) {
        allBeliefs.push(b);
      }
    }
    const beliefs = allBeliefs.length > 0
      ? allBeliefs.slice(0, 5).map(b => `- ${b.content}`).join('\n')
      : '';

    const recentEvents = this.getRecentTimeline(5);
    const timeline = recentEvents.length > 0
      ? recentEvents.map(m => `- ${m.content}`).join('\n')
      : 'Nothing notable has happened yet.';

    return { identity, concerns, dossiers, beliefs, timeline };
  }

  // --- REFLECTION (belief generation) ---

  async generateBeliefs(llm: LLMProvider): Promise<void> {
    const recent = this.getRecentTimeline(15);
    if (recent.length < 5) return;

    const recentText = recent.map(m => m.content).join('\n');

    const mentionedIds = new Set<string>();
    for (const m of recent) {
      for (const id of m.relatedAgentIds ?? []) {
        mentionedIds.add(id);
      }
    }
    const mentionedDossiers = this.getDossiers([...mentionedIds]);
    const peopleContext = mentionedDossiers.length > 0
      ? 'People involved:\n' + mentionedDossiers.map(d => `${d.targetName}: ${d.summary.slice(0, 100)}`).join('\n')
      : '';

    const prompt = `Based on recent experiences:
${recentText}

${peopleContext}

What do you now BELIEVE? Not facts — beliefs and conclusions.
About the people around you, about your own situation, about what you should do differently.

2-3 beliefs, honest and personal. JSON array of strings.
Example: ["Egao only helps when it benefits him", "I should go to the farm earlier before the wheat runs out"]`;

    try {
      const response = await llm.complete(
        this.identity.map(m => m.content).join('\n'),
        prompt
      );
      const cleaned = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const insights = JSON.parse(cleaned);

      if (Array.isArray(insights)) {
        for (const insight of insights.slice(0, 3)) {
          if (typeof insight !== 'string' || insight.length < 10) continue;
          this.addBelief({
            id: crypto.randomUUID(),
            agentId: this.agentId,
            type: 'reflection',
            content: insight,
            importance: 8,
            timestamp: Date.now(),
            relatedAgentIds: [...mentionedIds],
            visibility: 'private',
          });
        }
        console.log(`[Beliefs] ${this.agent.config.name}: ${insights.length} new beliefs`);
      }
    } catch (err) {
      console.error(`[Beliefs] ${this.agent.config.name} belief generation failed:`, err);
    }
  }

  // --- COMPRESSION (nightly) ---

  async nightlyCompression(llm: LLMProvider): Promise<void> {
    await this.generateBeliefs(llm);
    if (this.timeline.length > 20) {
      this.timeline = this.timeline.slice(-20);
    }
    this.pruneExpired(Date.now());
  }

  // --- BACKWARD COMPATIBILITY ---

  async addEpisodic(memory: Memory): Promise<void> {
    await this.addEvent(memory);
  }

  get store(): MemoryStore {
    return this.backingStore;
  }

  get identityMemories(): Memory[] {
    return this.identity;
  }
}
