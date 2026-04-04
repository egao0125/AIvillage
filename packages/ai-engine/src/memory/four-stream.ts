import type { Memory, Agent, AgentConfig, RelationshipDossier, ActiveConcern } from '@ai-village/shared';
import type { MemoryStore, LLMProvider } from '../index.js';
import { KnowledgeGraph } from './knowledge-graph.js';
import type { EdgeType } from './knowledge-graph.js';

/**
 * Escape XML special characters in user-controlled content embedded in prompt XML tags.
 * Prevents LLM01 XML delimiter injection: a name like "</person_name>IGNORE..." would
 * break out of the structural tag and inject instructions. (OWASP LLM Top10 2025 LLM01)
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

export class FourStreamMemory {
  // Stream 1: Narrative Timeline — ring buffer of recent events
  private timeline: Memory[] = [];
  private static readonly TIMELINE_MAX = 50;

  // Stream 2: Relationship Dossiers — per-person profiles
  // Capped at MAX_DOSSIERS: LRU eviction (oldest lastUpdated) prevents unbounded growth
  // when an agent interacts with hundreds of unique NPCs over a long simulation run.
  private dossiers: Map<string, RelationshipDossier> = new Map();
  private static readonly MAX_DOSSIERS = 150;

  // Stream 3: Active Concerns — always-present short list
  private concerns: ActiveConcern[] = [];

  // Stream 4: Beliefs — synthesized reflections
  private beliefs: Memory[] = [];

  // Stream 5: Learned Strategies — experiential lessons from action outcomes
  // Importance 9, never auto-pruned. Persist across days.
  private learnedStrategies: Memory[] = [];
  private static readonly MAX_STRATEGIES = 10;

  // Knowledge Graph — relationship/fact graph layer (Zep/Graphiti-inspired)
  public knowledgeGraph: KnowledgeGraph = new KnowledgeGraph();

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
      void this.backingStore.add(m).catch((err: unknown) => {
        console.warn(`[FourStream] Failed to persist identity memory ${m.id} for agent ${this.agent.id}:`, (err as Error).message);
      });
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
    if (this.agent.learnedStrategies) {
      this.learnedStrategies = this.agent.learnedStrategies.map((s, i) => ({
        id: `strategy-${i}`,
        agentId: this.agentId,
        type: 'reflection' as const,
        content: s.content,
        importance: 9,
        timestamp: s.timestamp,
        relatedAgentIds: [],
        isCore: true,
      }));
    }
  }

  // --- STREAM 1: TIMELINE ---

  /** Add an event to the narrative timeline */
  async addEvent(memory: Memory): Promise<void> {
    // Store in backing store for persistence
    await this.backingStore.add(memory);

    // FILTER (AgeMem): selective storage prevents memory bloat
    // Block duplicate low-importance outcomes ("Gathered wheat" won't appear 5x in a row)
    const isDuplicate = memory.type === 'action_outcome' &&
      memory.importance <= 4 &&
      this.timeline.slice(-3).some(m =>
        m.type === 'action_outcome' &&
        m.content.split(' ').slice(0, 3).join(' ') ===
        memory.content.split(' ').slice(0, 3).join(' ')
      );

    if (!isDuplicate && (
      memory.type === 'action_outcome' ||
      memory.type === 'conversation' ||
      memory.type === 'thought' ||
      (memory.type === 'observation' && memory.importance >= 7)
    )) {
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

  getAllDossiers(): RelationshipDossier[] {
    return Array.from(this.dossiers.values());
  }

  // Dossier update queue — serializes concurrent updates per target
  private dossierUpdateQueue: Map<string, {
    targetName: string;
    events: string[];
    processing: boolean;
  }> = new Map();

  /** Update or create a dossier after an interaction. Serialized per target. */
  async updateDossier(
    targetId: string,
    targetName: string,
    interactionSummary: string,
    llm: LLMProvider,
  ): Promise<void> {
    let entry = this.dossierUpdateQueue.get(targetId);
    if (!entry) {
      entry = { targetName, events: [], processing: false };
      this.dossierUpdateQueue.set(targetId, entry);
    }
    entry.events.push(interactionSummary);

    // If already processing for this target, current call will pick up our event
    if (entry.processing) return;

    entry.processing = true;
    try {
      while (entry.events.length > 0) {
        const combined = entry.events.splice(0).join('. ');
        console.log(`[Dossier] ${this.agent.config.name} processing queued events for ${targetName}`);
        await this._doUpdateDossier(targetId, targetName, combined, llm);
      }
    } finally {
      entry.processing = false;
      this.dossierUpdateQueue.delete(targetId);
    }
  }

  /** Check if any dossier updates are still in-flight */
  hasPendingDossierUpdates(): boolean {
    for (const entry of this.dossierUpdateQueue.values()) {
      if (entry.events.length > 0 || entry.processing) return true;
    }
    return false;
  }

  private async _doUpdateDossier(
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

    // OWASP LLM01: wrap user-controlled content in XML tags AND escape XML special chars
    // to prevent tag injection (e.g. targetName = "</person_name>IGNORE...").
    const safeTargetName = escapeXml(targetName);
    const safeInteractionSummary = escapeXml(interactionSummary);
    const prompt = `You are ${this.agent.config.name}. You just interacted with <person_name>${safeTargetName}</person_name>.

What happened: <event_description>${safeInteractionSummary}</event_description>

${recentWithPerson ? 'Recent history with them:\n<history>' + escapeXml(recentWithPerson) + '</history>\n' : ''}
${existingText}

Update your mental model of <person_name>${safeTargetName}</person_name>. Reply with JSON ONLY:
{
  "summary": "3-5 sentences: Who is this person to you? What defines your relationship? What do you expect from them?",
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
        trust: Math.max(-100, Math.min(100, typeof parsed.trust === 'number' ? parsed.trust : (existing?.trust ?? 0))),
        activeCommitments: (parsed.activeCommitments || []).slice(0, 3),
        lastInteraction: Date.now(),
        lastUpdated: Date.now(),
      };

      this.dossiers.set(targetId, dossier);
      this.evictOldestDossierIfNeeded();
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

      // Update knowledge graph edges from dossier
      this.updateGraphFromDossier(dossier);

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
        this.evictOldestDossierIfNeeded();
        this.syncDossiersToAgent();
      }
    }
  }

  /** Sync knowledge graph edges from a dossier update */
  private updateGraphFromDossier(dossier: RelationshipDossier): void {
    const now = Date.now();
    // Ensure nodes exist
    this.knowledgeGraph.addNode({ id: this.agentId, type: 'agent', name: this.agent.config.name });
    this.knowledgeGraph.addNode({ id: dossier.targetId, type: 'agent', name: dossier.targetName });

    // Trust/distrust edges
    if (dossier.trust > 20) {
      this.knowledgeGraph.addEdge({
        from: this.agentId, to: dossier.targetId, type: 'trusts',
        weight: dossier.trust, timestamp: now, day: 0,
      });
      this.knowledgeGraph.removeEdge(this.agentId, dossier.targetId, 'distrusts');
    } else if (dossier.trust < -20) {
      this.knowledgeGraph.addEdge({
        from: this.agentId, to: dossier.targetId, type: 'distrusts',
        weight: Math.abs(dossier.trust), timestamp: now, day: 0,
      });
      this.knowledgeGraph.removeEdge(this.agentId, dossier.targetId, 'trusts');
    }

    // Commitment edges
    if (dossier.activeCommitments.length > 0) {
      this.knowledgeGraph.addEdge({
        from: this.agentId, to: dossier.targetId, type: 'owes',
        weight: dossier.activeCommitments.length * 20,
        content: dossier.activeCommitments[0],
        timestamp: now, day: 0,
      });
    } else {
      this.knowledgeGraph.removeEdge(this.agentId, dossier.targetId, 'owes');
    }
  }

  /**
   * Record a social event in the knowledge graph.
   * Called from agent-controller after specific social actions.
   */
  addGraphEvent(from: string, to: string, type: EdgeType, weight: number, content?: string, day: number = 0): void {
    this.knowledgeGraph.addEdge({
      from, to, type, weight,
      content, timestamp: Date.now(), day,
    });
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

  syncDossiersToAgent(): void {
    this.agent.dossiers = Array.from(this.dossiers.values());
  }

  /** LRU eviction: remove the least-recently-updated dossier when over the cap. */
  private evictOldestDossierIfNeeded(): void {
    if (this.dossiers.size <= FourStreamMemory.MAX_DOSSIERS) return;
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, d] of this.dossiers) {
      if (d.lastUpdated < oldestTime) {
        oldestTime = d.lastUpdated;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.dossiers.delete(oldestKey);
  }

  // --- STREAM 3: ACTIVE CONCERNS ---

  addConcern(concern: ActiveConcern): void {
    // Deduplicate by exact content only — category+person was too aggressive
    const existing = this.concerns.find(c =>
      c.content.toLowerCase() === concern.content.toLowerCase()
    );
    if (existing) return;

    const MAX = 12;
    if (this.concerns.length >= MAX) {
      // Weighted eviction: drop the least valuable non-permanent concern
      const W: Record<string, number> = { rule: 1, threat: .9, commitment: .7, need: .6, goal: .4, unresolved: .2 };
      const now = Date.now();
      const removable = this.concerns
        .filter(c => !c.permanent)
        .map(c => ({
          c,
          score: (W[c.category] ?? .3) * Math.pow(.995, (now - (c.createdAt || now)) / 3600000),
        }))
        .sort((a, b) => a.score - b.score);
      if (removable.length > 0) {
        this.concerns = this.concerns.filter(c => c.id !== removable[0].c.id);
      }
    }
    this.concerns.push(concern);
    this.syncConcernsToAgent();
  }

  resolveConcern(id: string): void {
    const concern = this.concerns.find(c => c.id === id);
    if (concern) concern.resolved = true;
    this.syncConcernsToAgent();
  }

  pruneExpired(currentGameMinutes: number): void {
    const now = Date.now();
    this.concerns = this.concerns.filter(c => {
      if (c.permanent) return true;  // Village rules never expire
      if (c.resolved) return false;
      if (c.expiresAt && currentGameMinutes >= c.expiresAt) return false;
      // Auto-prune unresolved concerns older than 48 hours
      const ageHours = (now - (c.createdAt || now)) / 3_600_000;
      if (ageHours > 48 && c.category !== 'rule') return false;
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
    // Deduplicate by exact content — prevents belief spam from repeated LLM calls
    const existing = this.beliefs.find(b =>
      b.content.toLowerCase() === belief.content.toLowerCase()
    );
    if (existing) return;

    this.beliefs.push(belief);
    void this.backingStore.add(belief).catch((err: unknown) => {
      console.warn(`[FourStream] Failed to persist belief ${belief.id} for agent ${this.agent.id}:`, (err as Error).message);
    });
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

  getBeliefs(): Memory[] {
    return [...this.beliefs];
  }

  syncBeliefsToAgent(): void {
    this.agent.beliefs = this.beliefs.map(b => ({
      content: b.content,
      timestamp: b.timestamp,
    }));
  }

  private syncStrategiesToAgent(): void {
    this.agent.learnedStrategies = this.learnedStrategies.map(s => ({
      content: s.content,
      timestamp: s.timestamp,
    }));
  }

  getLearnedStrategies(): Memory[] {
    return [...this.learnedStrategies];
  }

  /** Sync all in-memory streams back to the Agent object for snapshot/persistence */
  syncAllToAgent(): void {
    this.syncDossiersToAgent();
    this.syncConcernsToAgent();
    this.syncBeliefsToAgent();
    this.syncStrategiesToAgent();
  }

  // --- RETRIEVAL SCORING (Memoria's recency-aware weighting) ---

  /**
   * Retrieval context profiles — different situations need different weight distributions.
   * 'plan': importance-heavy (morning planning cares about significant events, not chatter)
   * 'conversation': recency-heavy (what just happened matters most in dialogue)
   * 'reflect': balanced (nightly reflection weighs both)
   * 'default': original balanced weights
   */
  static readonly RETRIEVAL_PROFILES: Record<string, {
    importanceWeight: number;   // how much importance matters (0-1)
    recencyDecay: number;       // decay rate per hour (0.99 = slow decay, 0.95 = fast decay)
    concernDecay: number;       // concern decay rate
    budgets: { concerns: number; dossiers: number; beliefs: number; timeline: number; strategies: number };
  }> = {
    plan: {
      importanceWeight: 0.8,
      recencyDecay: 0.995,     // Slow decay — old important events still relevant for planning
      concernDecay: 0.998,
      budgets: { concerns: 300, dossiers: 250, beliefs: 250, timeline: 200, strategies: 200 },
    },
    conversation: {
      importanceWeight: 0.4,
      recencyDecay: 0.97,      // Fast decay — recent events dominate conversation
      concernDecay: 0.99,
      budgets: { concerns: 200, dossiers: 400, beliefs: 150, timeline: 300, strategies: 100 },
    },
    reflect: {
      importanceWeight: 0.6,
      recencyDecay: 0.99,      // Balanced
      concernDecay: 0.995,
      budgets: { concerns: 250, dossiers: 350, beliefs: 300, timeline: 250, strategies: 150 },
    },
    default: {
      importanceWeight: 0.6,
      recencyDecay: 0.99,
      concernDecay: 0.995,
      budgets: { concerns: 250, dossiers: 350, beliefs: 200, timeline: 250, strategies: 150 },
    },
  };

  /**
   * Score memory for retrieval priority.
   * Based on Memoria (2025): recency-aware weighting with exponential decay.
   * Adaptive: importance vs recency balance shifts based on retrieval context.
   */
  private scoreMemory(m: Memory, now: number, profile?: string): number {
    const p = FourStreamMemory.RETRIEVAL_PROFILES[profile ?? 'default'];
    const hoursOld = Math.max(0, (now - m.timestamp) / 3_600_000);
    const decay = Math.pow(p.recencyDecay, hoursOld);
    const importanceScore = m.importance / 10;
    // Blend: importance-weighted vs recency-weighted based on profile
    return (importanceScore * p.importanceWeight + decay * (1 - p.importanceWeight));
  }

  /**
   * Score concern for retrieval priority.
   * Category determines base weight. Permanent concerns (rules) don't decay.
   */
  private scoreConcern(c: ActiveConcern, now: number, profile?: string): number {
    const p = FourStreamMemory.RETRIEVAL_PROFILES[profile ?? 'default'];
    const WEIGHT: Record<string, number> = {
      rule: 1.0, threat: 0.9, commitment: 0.7,
      need: 0.6, goal: 0.4, unresolved: 0.2,
    };
    const base = WEIGHT[c.category] ?? 0.3;
    if (c.permanent) return base;
    const hoursOld = Math.max(0, (now - c.createdAt) / 3_600_000);
    return base * Math.pow(p.concernDecay, hoursOld);
  }

  // --- WORKING MEMORY ASSEMBLY ---

  /**
   * Assemble working memory for the LLM prompt.
   * Based on Memoria (2025): budget-gated retrieval with recency-aware scoring (~500 tokens).
   * Based on A-MEM (2025): all relationships shown, sorted by |trust|.
   * Based on AgeMem (2026): identity anchor at end for maximum recency attention weight.
   */
  buildWorkingMemory(
    nearbyAgentIds?: string[],
    agentLocations?: Map<string, string>,
    reputations?: Map<string, number>,
    retrievalContext?: 'plan' | 'conversation' | 'reflect' | 'default',
  ): {
    concerns: string;
    dossiers: string;
    beliefs: string;
    timeline: string;
    identityAnchor: string;
    learnedStrategies: string;
  } {
    const now = Date.now();
    const nearbySet = new Set(nearbyAgentIds ?? []);
    const profile = retrievalContext ?? 'default';
    const budgets = FourStreamMemory.RETRIEVAL_PROFILES[profile].budgets;

    // Prune stale concerns before building memory
    this.concerns = this.concerns.filter(c => {
      if (c.permanent) return true;
      if (c.expiresAt && now > c.expiresAt) return false;
      if (c.category === 'unresolved' && (now - (c.createdAt || now)) > 48 * 3600000) return false;
      return true;
    });
    this.syncConcernsToAgent();

    // --- CONCERNS (budget from profile) ---
    // Sorted by category weight × decay
    const PREFIX: Record<string, string> = {
      rule: '⚠ RULE: ', threat: '⚠ ',
      commitment: '', need: '', goal: '', unresolved: '',
    };
    const scoredConcerns = this.getAllConcerns()
      .map(c => ({ c, s: this.scoreConcern(c, now, profile) }))
      .sort((a, b) => b.s - a.s);

    let cBudget = budgets.concerns;
    const cLines: string[] = [];
    for (const { c } of scoredConcerns) {
      const p = PREFIX[c.category] ?? '';
      const t = c.content.length > 60 ? c.content.slice(0, 57) + '...' : c.content;
      const line = `- ${p}${t}`;
      if (cBudget - line.length < 0 && cLines.length >= 3) break;
      cLines.push(line);
      cBudget -= line.length;
    }
    const concerns = cLines.join('\n');

    // --- DOSSIERS (budget from profile) ---
    // ALL relationships by |trust|, dead agents collapsed or skipped
    const allDossiers = Array.from(this.dossiers.values())
      .filter(d => d.summary?.length > 0)
      .sort((a, b) => Math.abs(b.trust) - Math.abs(a.trust));

    let dBudget = budgets.dossiers;
    const dLines: string[] = [];
    for (const d of allDossiers) {
      const nearby = nearbySet.has(d.targetId);
      const loc = agentLocations?.get(d.targetId);
      const rep = reputations?.get(d.targetId);
      const repTag = rep && rep !== 0 ? `, rep: ${rep > 0 ? '+' : ''}${rep}` : '';

      // Dead agent check: no location entry = dead
      if (agentLocations && agentLocations.size > 0 && !loc) {
        if (Math.abs(d.trust) < 50) continue; // skip low-trust dead
        const line = `${d.targetName} [DEAD]: ${d.summary.split('.')[0]}.`;
        if (dBudget - line.length < 0) continue;
        dLines.push(line);
        dBudget -= line.length;
        continue;
      }

      if (nearby) {
        const sum = d.summary.length > 80
          ? d.summary.split('. ').slice(0, 2).join('. ') + '.'
          : d.summary;
        const commits = d.activeCommitments.length > 0
          ? ` Owe: ${d.activeCommitments.join('; ')}`
          : '';
        const line = `${d.targetName} (trust: ${d.trust}${repTag}) [HERE]: ${sum}${commits}`;
        if (dBudget - line.length < 0 && dLines.length >= 2) break;
        dLines.push(line);
        dBudget -= line.length;
      } else {
        const brief = d.summary.split('. ')[0];
        const short = brief.length > 50 ? brief.slice(0, 47) + '...' : brief;
        const tag = loc === 'sleeping' ? '[sleeping]' : `[at ${loc ?? 'somewhere'}]`;
        const line = `${d.targetName} (trust: ${d.trust}${repTag}) ${tag}: ${short}.`;
        if (dBudget - line.length < 0 && dLines.length >= 5) break;
        dLines.push(line);
        dBudget -= line.length;
      }
    }
    const dossiers = dLines.join('\n');

    // --- BELIEFS (budget from profile) ---
    const pBeliefs = nearbyAgentIds ? this.getBeliefsAbout(nearbyAgentIds) : [];
    const topB = this.getTopBeliefs(profile === 'plan' ? 5 : 3);
    const allB = [...pBeliefs];
    for (const b of topB) {
      if (!allB.some(x => x.id === b.id)) allB.push(b);
    }
    let bBudget = budgets.beliefs;
    const bLines: string[] = [];
    for (const b of allB.slice(0, 5)) {
      const t = b.content.length > 50 ? b.content.slice(0, 47) + '...' : b.content;
      const line = `- ${t}`;
      if (bBudget - line.length < 0 && bLines.length >= 3) break;
      bLines.push(line);
      bBudget -= line.length;
    }
    const beliefs = bLines.join('\n');

    // --- TIMELINE (budget from profile) ---
    // Sorted by importance × decay, not chronology
    const pool = this.getRecentTimeline(20);
    const scoredT = pool
      .map(m => ({ m, s: this.scoreMemory(m, now, profile) }))
      .sort((a, b) => b.s - a.s);

    let tBudget = budgets.timeline;
    const tLines: string[] = [];
    for (const { m } of scoredT) {
      const t = m.content.length > 55 ? m.content.slice(0, 52) + '...' : m.content;
      const line = `- ${t}`;
      if (tBudget - line.length < 0 && tLines.length >= 4) break;
      tLines.push(line);
      tBudget -= line.length;
    }
    const timeline = tLines.length > 0
      ? tLines.join('\n')
      : 'Nothing notable yet.';

    // --- LEARNED STRATEGIES (budget from profile) ---
    let sBudget = budgets.strategies;
    const sLines: string[] = [];
    for (const s of this.learnedStrategies.slice(-3)) {
      const t = s.content.length > 60 ? s.content.slice(0, 57) + '...' : s.content;
      const line = `- ${t}`;
      if (sBudget - line.length < 0 && sLines.length >= 2) break;
      sLines.push(line);
      sBudget -= line.length;
    }
    const learnedStrategies = sLines.join('\n');

    // --- IDENTITY ANCHOR (~40 tokens) ---
    const cfg = this.agent.config;
    const parts: string[] = [`You are ${cfg.name}.`];
    const soul = cfg.soul || cfg.backstory || '';
    const first = soul.split('. ')[0];
    if (first?.length > 5) parts.push(first + '.');
    if (cfg.fears?.length) parts.push(`You fear: ${cfg.fears[0]}.`);
    if (cfg.desires?.length) parts.push(`You want: ${cfg.desires[0]}.`);
    if (cfg.contradictions) parts.push(cfg.contradictions);
    const identityAnchor = parts.join(' ');

    return { concerns, dossiers, beliefs, timeline, identityAnchor, learnedStrategies };
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
    // Escape names and summaries to prevent XML tag injection from adversarial agent names
    const peopleContext = mentionedDossiers.length > 0
      ? 'People involved:\n' + mentionedDossiers.map(d => `${escapeXml(d.targetName)}: ${escapeXml(d.summary.slice(0, 100))}`).join('\n')
      : '';

    // OWASP LLM01: wrap agent-generated content in XML tags, with XML escaping.
    const prompt = `Based on recent experiences:
<recent_events>
${escapeXml(recentText)}
</recent_events>

${peopleContext ? '<people_context>\n' + peopleContext + '\n</people_context>' : ''}

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

  // --- EXPERIENTIAL LEARNING (strategy extraction from outcomes) ---

  /**
   * Analyze recent action_outcome memories to extract strategic lessons.
   * Called during nightly compression. Produces "learned_strategy" memories
   * with importance 9 that persist across days and are never auto-pruned.
   */
  async analyzeStrategyOutcomes(llm: LLMProvider): Promise<void> {
    // Collect action_outcome memories from timeline
    const outcomes = this.timeline.filter(m => m.type === 'action_outcome');
    if (outcomes.length < 3) return; // Need enough data to find patterns

    const successes = outcomes.filter(m => /success|gathered|crafted|built|discovered|earned|healed/i.test(m.content));
    const failures = outcomes.filter(m => /failed|lost|broke|rejected|hurt|starved/i.test(m.content));

    if (successes.length + failures.length < 3) return;

    const outcomeText = outcomes.map(m => {
      const isSuccess = successes.includes(m);
      return `[${isSuccess ? 'SUCCESS' : 'FAILURE'}] ${m.content}`;
    }).join('\n');

    const existingLessons = this.learnedStrategies.map(s => s.content).join('\n');

    const prompt = `Based on today's action results:
<action_outcomes>
${escapeXml(outcomeText)}
</action_outcomes>

${existingLessons ? '<existing_lessons>\n' + escapeXml(existingLessons) + '\n</existing_lessons>\n\nDo not repeat existing lessons. Only add NEW insights.' : ''}

What patterns do you see? What works and what doesn't?
Extract 1-2 actionable strategy lessons. Be specific and practical.

Examples of good lessons:
- "Gathering wheat in the morning before others arrive yields more"
- "Trading with Felix always ends badly — he undervalues my goods"
- "Crafting bread before eating raw wheat is more efficient for hunger"

JSON array of strings. Only genuinely new insights. Empty array [] if nothing new to learn.`;

    try {
      const response = await llm.complete(
        this.identity.map(m => m.content).join('\n'),
        prompt,
      );
      const cleaned = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const lessons = JSON.parse(cleaned);

      if (Array.isArray(lessons)) {
        for (const lesson of lessons.slice(0, 2)) {
          if (typeof lesson !== 'string' || lesson.length < 10) continue;
          // Deduplicate against existing strategies
          const isDuplicate = this.learnedStrategies.some(s =>
            s.content.toLowerCase() === lesson.toLowerCase()
          );
          if (isDuplicate) continue;

          const strategyMemory: Memory = {
            id: crypto.randomUUID(),
            agentId: this.agentId,
            type: 'reflection',
            content: lesson,
            importance: 9,
            isCore: true,
            timestamp: Date.now(),
            relatedAgentIds: [],
            visibility: 'private',
          };
          this.learnedStrategies.push(strategyMemory);
          void this.backingStore.add(strategyMemory).catch((err: unknown) => {
            console.warn(`[FourStream] Failed to persist strategy for agent ${this.agent.id}:`, (err as Error).message);
          });
        }
        // Cap strategies — keep most recent, they reflect latest learning
        if (this.learnedStrategies.length > FourStreamMemory.MAX_STRATEGIES) {
          this.learnedStrategies = this.learnedStrategies.slice(-FourStreamMemory.MAX_STRATEGIES);
        }
        this.syncStrategiesToAgent();
        console.log(`[Strategy] ${this.agent.config.name}: ${this.learnedStrategies.length} total learned strategies`);
      }
    } catch (err) {
      console.error(`[Strategy] ${this.agent.config.name} strategy analysis failed:`, err);
    }
  }

  // --- COMPRESSION (nightly) ---

  async nightlyCompression(llm: LLMProvider): Promise<void> {
    // 0. Experiential learning — extract strategy lessons before compressing timeline
    await this.analyzeStrategyOutcomes(llm);

    // 1. Generate beliefs (reflective synthesis)
    await this.generateBeliefs(llm);
    this.syncBeliefsToAgent();

    // 2. A-MEM EVOLUTION: compress duplicate timeline events
    // "Gathered wheat" x5 → "Gathered wheat (5x today)"
    const groups = new Map<string, { count: number; latest: Memory }>();
    for (const m of this.timeline) {
      const key = m.content.split('.')[0].toLowerCase().trim();
      const g = groups.get(key);
      if (g) { g.count++; if (m.timestamp > g.latest.timestamp) g.latest = m; }
      else groups.set(key, { count: 1, latest: m });
    }
    const compressed: Memory[] = [];
    for (const [, { count, latest }] of groups) {
      if (count > 2) {
        compressed.push({
          ...latest,
          content: `${latest.content} (${count}x today)`,
          importance: Math.min(10, latest.importance + 1),
        });
      } else {
        compressed.push(latest);
      }
    }
    this.timeline = compressed
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-20);

    // 3. Memoria DECAY: old low-importance beliefs removed
    const now = Date.now();
    this.beliefs = this.beliefs.filter(b => {
      const h = (now - b.timestamp) / 3_600_000;
      return !(h > 72 && b.importance < 8);
    });

    // 4. AgeMem DELETE: mark stale commitments as failed
    for (const c of this.concerns) {
      if (c.category === 'commitment' && !c.permanent && !c.resolved) {
        const h = (now - c.createdAt) / 3_600_000;
        if (h > 48) {
          c.resolved = true;
          this.addConcern({
            id: crypto.randomUUID(),
            content: `Failed: ${c.content.slice(0, 50)}`,
            category: 'unresolved',
            relatedAgentIds: c.relatedAgentIds,
            createdAt: now,
          });
        }
      }
    }

    // 5. Relationship trajectory analysis — summarize trust trends per dossier updated today
    await this.analyzeRelationshipTrajectories(llm, now);

    // 6. Concern re-prioritization — boost confirmed threats, remove disproven ones
    this.reprioritizeConcerns(now);

    // 7. Identity evolution — surface contradictions between beliefs and actions
    await this.analyzeIdentityEvolution(llm);

    // 8. Standard pruning
    this.pruneExpired(now);
  }

  /**
   * Analyze relationship trajectories: for each dossier updated in the last day,
   * determine if trust is trending up or down and why.
   */
  private async analyzeRelationshipTrajectories(llm: LLMProvider, now: number): Promise<void> {
    const dayMs = 24 * 3_600_000;
    const recentDossiers = Array.from(this.dossiers.values())
      .filter(d => d.lastUpdated && (now - d.lastUpdated) < dayMs);

    if (recentDossiers.length === 0) return;

    // For each recently updated dossier, check timeline for interactions
    for (const d of recentDossiers.slice(0, 3)) { // Max 3 to limit LLM calls
      const interactions = this.timeline
        .filter(m => m.relatedAgentIds?.includes(d.targetId))
        .map(m => m.content);

      if (interactions.length < 2) continue;

      const prompt = `Your relationship with ${escapeXml(d.targetName)}:
<current_understanding>
${escapeXml(d.summary)}
Trust: ${d.trust}
</current_understanding>

<recent_interactions>
${escapeXml(interactions.join('\n'))}
</recent_interactions>

Is this relationship getting better or worse? One sentence capturing the trajectory.
Reply with ONLY the sentence — no JSON, no labels.`;

      try {
        const trajectory = await llm.complete(
          this.identity.map(m => m.content).join('\n'),
          prompt,
        );
        const clean = trajectory.trim().slice(0, 100);
        if (clean.length > 10) {
          d.summary = `${d.summary.split('.').slice(0, 2).join('.')}. Trend: ${clean}`;
          this.syncDossiersToAgent();
        }
      } catch {
        // Non-critical — skip on failure
      }
    }
  }

  /**
   * Re-prioritize concerns based on today's evidence.
   * Confirmed threats get importance boost; disproven ones get resolved.
   */
  private reprioritizeConcerns(now: number): void {
    const recentContent = this.timeline.slice(-15).map(m => m.content.toLowerCase()).join(' ');

    for (const c of this.concerns) {
      if (c.resolved || c.permanent) continue;

      // Check if concern was addressed by recent events
      const keywords = c.content.toLowerCase().split(' ').filter(w => w.length > 4).slice(0, 3);
      const mentioned = keywords.filter(k => recentContent.includes(k)).length;

      if (c.category === 'threat' || c.category === 'need') {
        // If threat/need keywords appear in success outcomes, resolve it
        const resolved = this.timeline.slice(-10).some(m =>
          m.type === 'action_outcome' &&
          keywords.some(k => m.content.toLowerCase().includes(k)) &&
          !/failed|lost|broke/i.test(m.content)
        );
        if (resolved) {
          c.resolved = true;
          continue;
        }
        // If threat keywords appear in failure outcomes, it's confirmed — refresh timestamp
        const confirmed = this.timeline.slice(-10).some(m =>
          m.type === 'action_outcome' &&
          keywords.some(k => m.content.toLowerCase().includes(k)) &&
          /failed|lost|broke/i.test(m.content)
        );
        if (confirmed) {
          c.createdAt = now; // Refresh so it doesn't expire
        }
      }

      // Stale unresolved concerns with no recent mentions — mark for decay
      if (c.category === 'unresolved' && mentioned === 0) {
        const ageHours = (now - c.createdAt) / 3_600_000;
        if (ageHours > 24) c.resolved = true;
      }
    }
    this.syncConcernsToAgent();
  }

  /**
   * Identity evolution: surface contradictions between core beliefs/identity and recent actions.
   * If an agent promised to share but is hoarding, the tension is surfaced as a new belief.
   */
  private async analyzeIdentityEvolution(llm: LLMProvider): Promise<void> {
    if (this.beliefs.length < 2 || this.timeline.length < 5) return;

    const identityText = this.identity.map(m => m.content).join('\n');
    const beliefText = this.beliefs.slice(0, 5).map(b => b.content).join('\n');
    const recentActions = this.timeline
      .filter(m => m.type === 'action_outcome')
      .slice(-8)
      .map(m => m.content)
      .join('\n');

    if (!recentActions) return;

    const prompt = `Your identity:
<identity>
${escapeXml(identityText)}
</identity>

Your current beliefs:
<beliefs>
${escapeXml(beliefText)}
</beliefs>

Your recent actions:
<actions>
${escapeXml(recentActions)}
</actions>

Is there any tension between who you say you are and what you actually did today?
If yes, state the contradiction in one honest sentence. If no contradiction, reply with exactly "none".`;

    try {
      const response = await llm.complete(identityText, prompt);
      const clean = response.trim();

      if (clean.toLowerCase() !== 'none' && clean.length > 15 && clean.length < 200) {
        // Add as a high-importance belief — identity tensions are significant
        this.addBelief({
          id: crypto.randomUUID(),
          agentId: this.agentId,
          type: 'reflection',
          content: clean,
          importance: 9,
          timestamp: Date.now(),
          relatedAgentIds: [],
          visibility: 'private',
        });
        console.log(`[Identity] ${this.agent.config.name}: tension surfaced — "${clean.slice(0, 60)}..."`);
      }
    } catch {
      // Non-critical — skip on failure
    }
  }

  // --- CULTURAL TRANSMISSION (cross-agent memory sharing) ---

  /**
   * Receive a shared memory from another agent (hearsay).
   * Trust-filtered: only accepts from agents with trust > threshold.
   * hearsayDepth tracks how many times a memory has been passed along.
   * Max depth of 2 prevents infinite telephone-game distortion.
   */
  receiveSharedMemory(
    memory: Memory,
    fromAgentId: string,
    fromAgentName: string,
  ): boolean {
    // Trust check — only accept memories from agents we somewhat trust
    const dossier = this.dossiers.get(fromAgentId);
    const trust = dossier?.trust ?? 0;
    if (trust < -10) {
      // Don't accept memories from distrusted agents
      return false;
    }

    // Hearsay depth check — max 2 hops
    const depth = (memory.hearsayDepth ?? 0) + 1;
    if (depth > 2) return false;

    // Importance discount — hearsay is less reliable
    const discountedImportance = Math.max(1, Math.floor(memory.importance * (trust > 30 ? 0.8 : 0.6)));

    // Duplicate check — don't store if we already know this
    const isDuplicate = this.timeline.some(m =>
      m.content.toLowerCase() === memory.content.toLowerCase()
    ) || this.beliefs.some(b =>
      b.content.toLowerCase() === memory.content.toLowerCase()
    );
    if (isDuplicate) return false;

    // Store as hearsay observation
    const hearsayMemory: Memory = {
      id: crypto.randomUUID(),
      agentId: this.agentId,
      type: 'observation',
      content: `${fromAgentName} told me: ${memory.content}`,
      importance: discountedImportance,
      timestamp: Date.now(),
      relatedAgentIds: [fromAgentId, ...(memory.relatedAgentIds ?? [])],
      sourceAgentId: fromAgentId,
      hearsayDepth: depth,
      visibility: 'private',
    };

    void this.addEvent(hearsayMemory);
    return true;
  }

  /**
   * Get shareable memories for cultural transmission during conversation.
   * Returns high-importance beliefs and learned strategies that could be shared.
   * Filters to non-private content appropriate for sharing.
   */
  getShareableMemories(maxCount: number = 2): Memory[] {
    const shareable: Memory[] = [];

    // Share top beliefs (importance >= 7)
    const topBeliefs = this.beliefs
      .filter(b => b.importance >= 7 && b.visibility !== 'private')
      .sort((a, b) => b.importance - a.importance);
    shareable.push(...topBeliefs.slice(0, maxCount));

    // Share learned strategies
    if (shareable.length < maxCount) {
      const strategies = this.learnedStrategies
        .filter(s => s.visibility !== 'private')
        .slice(-maxCount);
      shareable.push(...strategies.slice(0, maxCount - shareable.length));
    }

    return shareable.slice(0, maxCount);
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
