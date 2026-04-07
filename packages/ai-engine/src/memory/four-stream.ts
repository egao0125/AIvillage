import type { Memory, Agent, AgentConfig, RelationshipDossier, ActiveConcern, LearnedStrategy, LearnedAversion, RewardVector, ProcessRubric } from '@ai-village/shared';
import { computeScalarReward, strategyUtility } from '@ai-village/shared';
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
  // Utility-tracked: ranked by successRate × avgRewardDelta × recency. Evicted by lowest utility,
  // not newest-wins. This fixes the "can't learn an 11th rule" ceiling in Stanford-style agents.
  private learnedStrategies: LearnedStrategy[] = [];
  private static readonly MAX_STRATEGIES = 16;

  // UCB exploration counter (gap-analysis item 1.1): total action outcomes recorded
  // for this agent. Drives the exploration term in strategyUtility.
  private totalActionOutcomes = 0;

  // Root-audit leverage item 3: pressure-triggered compression timestamp.
  // Lets us skip the silent timeline.shift() in favor of running real compression
  // when memory mass crosses a watermark, even mid-day. Prevents agents from
  // losing important events to the 50-item ring buffer during long crises.
  private lastCompressionAt: number = 0;

  // Stream 6: Learned Aversions (gap-analysis item 1.2) — procedural memory
  // from first-person experience. Soft bias on decisions, not hard veto.
  // confidence: [-1, +1]. Negative = aversion, positive = preference.
  private learnedAversions: LearnedAversion[] = [];
  private static readonly MAX_AVERSIONS = 12;

  // Reasoning-step trace (gap-analysis item 1.3): captures the most recent
  // planning / perception output so we can score alignment at action-outcome time.
  private lastPlanGoalTokens: Set<string> = new Set();
  private lastThoughtTokens: Set<string> = new Set();
  private planRecordedAt = 0;
  private thoughtRecordedAt = 0;

  // Knowledge Graph — relationship/fact graph layer (Zep/Graphiti-inspired)
  public knowledgeGraph: KnowledgeGraph = new KnowledgeGraph();

  // Bi-temporal context (gap-analysis item 3.1): current game day, updated by engine.
  // Used to timestamp validFrom/validUntil on beliefs and KG edges.
  private currentDay = 0;

  // Identity — immutable core
  private identity: Memory[] = [];

  constructor(
    private agentId: string,
    private backingStore: MemoryStore,
    private agent: Agent,
  ) {}

  /** Update the game-day clock (bi-temporal context, item 3.1) */
  setCurrentDay(day: number): void {
    this.currentDay = day;
  }

  getCurrentDay(): number {
    return this.currentDay;
  }

  // --- INITIALIZATION ---

  seedIdentity(config: AgentConfig): void {
    const soul = config.soul || config.backstory || '';
    this.identity = [{
      id: crypto.randomUUID(),
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
        id: crypto.randomUUID(),
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
      // Backfill legacy shape {content, timestamp} into full LearnedStrategy form.
      this.learnedStrategies = this.agent.learnedStrategies.map((s: LearnedStrategy | { content: string; timestamp: number }) => {
        const asLS = s as LearnedStrategy;
        if (typeof asLS.timesUsed === 'number') return asLS; // already new shape
        // Legacy migration: seed with neutral utility so it doesn't get evicted immediately.
        const legacy = s as { content: string; timestamp: number };
        return {
          content: legacy.content,
          createdDay: 0,
          lastAccessedDay: 0,
          timesUsed: 0,
          timesSuccessful: 0,
          avgRewardDelta: 0,
        };
      });
    }
    // UCB counter restoration (gap-analysis item 1.1). Defaults to 0 for new/legacy agents.
    this.totalActionOutcomes = this.agent.totalActionOutcomes ?? 0;
    // Learned aversions restoration (gap-analysis item 1.2).
    if (this.agent.learnedAversions) {
      this.learnedAversions = this.agent.learnedAversions.map(a => ({ ...a }));
    }
  }

  // --- STREAM 1: TIMELINE ---

  /**
   * Extract 2-5 content keywords for emergent clustering (gap-analysis item 9).
   * Cheap, deterministic, no LLM. Replaces hard-coded theme bins.
   * Strategy: lowercase split, drop stopwords, keep distinctive tokens.
   */
  private extractKeywords(content: string, relatedAgentIds?: string[]): string[] {
    const STOP = new Set([
      'about', 'after', 'again', 'asked', 'before', 'being', 'could', 'doing',
      'every', 'going', 'having', 'their', 'there', 'these', 'think', 'thought',
      'today', 'would', 'should', 'because', 'while', 'through', 'other', 'which',
      'someone', 'something', 'nothing', 'anyone', 'everyone',
    ]);
    const tokens = content
      .toLowerCase()
      .split(/\W+/)
      .filter(t => t.length > 3 && !STOP.has(t));
    // Deduplicate preserving order, take up to 5
    const seen = new Set<string>();
    const keywords: string[] = [];
    for (const t of tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      keywords.push(t);
      if (keywords.length >= 5) break;
    }
    // Also include related agent IDs short-form as keyword anchors
    if (relatedAgentIds?.length && keywords.length < 5) {
      for (const id of relatedAgentIds.slice(0, 5 - keywords.length)) {
        keywords.push(`agent:${id.slice(0, 8)}`);
      }
    }
    return keywords;
  }

  /**
   * Tokenize a string for process-reward overlap scoring (gap-analysis item 1.3).
   * Same stopword/length filter as extractKeywords but returns a Set for O(1) lookup.
   */
  private tokenizeForOverlap(text: string): Set<string> {
    const STOP = new Set([
      'about', 'after', 'again', 'before', 'being', 'could', 'doing',
      'every', 'going', 'having', 'their', 'there', 'these', 'today',
      'would', 'should', 'because', 'while', 'through', 'other', 'which',
      'someone', 'something', 'nothing', 'anyone', 'everyone',
    ]);
    const out = new Set<string>();
    for (const t of text.toLowerCase().split(/\W+/)) {
      if (t.length > 3 && !STOP.has(t)) out.add(t);
    }
    return out;
  }

  /**
   * Capture the latest plan output for process-reward scoring (gap-analysis item 1.3).
   * Called from cognition.plan() right after the LLM returns. Keeps a token-set of
   * all goals so we can score "did what the agent actually did match what it planned?"
   */
  recordPlanTrace(goals: string[]): void {
    this.lastPlanGoalTokens = this.tokenizeForOverlap(goals.join(' '));
    this.planRecordedAt = Date.now();
  }

  /**
   * Capture the latest thought output for process-reward scoring (gap-analysis item 1.3).
   * Called from cognition.think() right after the LLM returns.
   */
  recordThoughtTrace(thought: string): void {
    this.lastThoughtTokens = this.tokenizeForOverlap(thought);
    this.thoughtRecordedAt = Date.now();
  }

  /**
   * Score a just-completed action against the most recent plan + thought traces.
   * Cheap heuristic (token overlap) — no LLM calls. Traces older than 10 minutes
   * are treated as stale (scores neutral).
   * Gap-analysis item 1.3: process rewards on reasoning steps.
   */
  private computeProcessRubric(outcomeMemory: Memory): ProcessRubric {
    const now = Date.now();
    const STALE_MS = 10 * 60 * 1000;

    // Build outcome token set: content + actionType
    const outcomeText = [outcomeMemory.content, outcomeMemory.actionType ?? ''].join(' ');
    const outcomeTokens = this.tokenizeForOverlap(outcomeText);

    // Plan alignment: ratio of outcome tokens also in plan-goal tokens.
    let planAlignment = 0;
    if (now - this.planRecordedAt < STALE_MS && this.lastPlanGoalTokens.size > 0 && outcomeTokens.size > 0) {
      let overlap = 0;
      for (const t of outcomeTokens) if (this.lastPlanGoalTokens.has(t)) overlap++;
      const ratio = overlap / outcomeTokens.size;
      // Map [0, 1] ratio to [-0.5, +1] — 0 overlap with existing plan = mild penalty (drift).
      planAlignment = ratio > 0 ? Math.min(1, ratio * 2) : -0.5;
    }

    // Thought relevance: ratio of outcome tokens also present in last thought.
    let thoughtRelevance = 0;
    if (now - this.thoughtRecordedAt < STALE_MS && this.lastThoughtTokens.size > 0 && outcomeTokens.size > 0) {
      let overlap = 0;
      for (const t of outcomeTokens) if (this.lastThoughtTokens.has(t)) overlap++;
      const ratio = overlap / outcomeTokens.size;
      thoughtRelevance = ratio > 0 ? Math.min(1, ratio * 2) : 0; // no penalty — thought can be broader than action
    }

    return { planAlignment, thoughtRelevance };
  }

  /**
   * Update the agent's running EMA of reasoning quality (gap-analysis item 1.3).
   * α = 0.1 — slow adaptation so a single noisy outcome doesn't swing the signal.
   */
  private updateReasoningScoreEMA(rubric: ProcessRubric): void {
    const alpha = 0.1;
    const prev = this.agent.reasoningScore ?? { planAlignment: 0, thoughtRelevance: 0 };
    this.agent.reasoningScore = {
      planAlignment: prev.planAlignment * (1 - alpha) + rubric.planAlignment * alpha,
      thoughtRelevance: prev.thoughtRelevance * (1 - alpha) + rubric.thoughtRelevance * alpha,
    };
  }

  /** Add an event to the narrative timeline */
  async addEvent(memory: Memory): Promise<void> {
    // Gap-analysis item 9: tag with keywords at ingest for emergent clustering.
    if (!memory.keywords) {
      memory.keywords = this.extractKeywords(memory.content, memory.relatedAgentIds);
    }

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

    // UCB counter (gap-analysis item 1.1): count every action the agent actually took.
    // Not filtered by isDuplicate — we want total action pulls, including repeats.
    if (memory.type === 'action_outcome') {
      this.totalActionOutcomes++;
      // Process rubric (gap-analysis item 1.3): score the reasoning chain that led
      // here against the actual outcome tokens. Attach to memory + EMA onto agent.
      if (!memory.processRubric) {
        memory.processRubric = this.computeProcessRubric(memory);
        this.updateReasoningScoreEMA(memory.processRubric);
      }
      // Learned aversion update (gap-analysis item 1.2): first-person reinforcement.
      // Scalar-reduce the rubric; positive → preference, negative → aversion.
      // Social axis carries the village norm violation cost, so it dominates here.
      if (memory.actionType && memory.actionType !== 'unknown' && memory.actionRubric) {
        const weights = this.agent.rewardWeights;
        const scalar = computeScalarReward(memory.actionRubric, weights);
        // Saturate into [-1,+1] then dampen so single events don't dominate.
        const delta = Math.max(-1, Math.min(1, scalar)) * 0.6;
        // Basis: 'punished' when net-negative from social axis specifically
        // (the norm slapped back), otherwise 'rewarded' for gains, 'victim' if hp loss dominant.
        const social = memory.actionRubric.social ?? 0;
        const hp = memory.actionRubric.hp ?? 0;
        let basis: LearnedAversion['basis'];
        if (social < -0.1) basis = 'punished';
        else if (hp < -0.2) basis = 'victim';
        else basis = scalar >= 0 ? 'rewarded' : 'punished';
        this.updateLearnedAversion(memory.actionType, delta, basis);
      }
    }
  }

  /**
   * Cluster timeline events by keyword co-occurrence (gap-analysis item 9).
   * Replaces hard-coded {social, economic, survival, political} themes.
   * Categories emerge from content — "grain" appearing in 5/6 events surfaces
   * a grain-centric causal narrative instead of fragmenting into 3 bins.
   */
  getKeywordClusters(minClusterSize: number = 2): { keyword: string; memories: Memory[] }[] {
    const keywordMap = new Map<string, Memory[]>();
    for (const m of this.timeline) {
      if (!m.keywords) continue;
      for (const k of m.keywords) {
        const bucket = keywordMap.get(k) ?? [];
        bucket.push(m);
        keywordMap.set(k, bucket);
      }
    }
    return Array.from(keywordMap.entries())
      .filter(([, mems]) => mems.length >= minClusterSize)
      .map(([keyword, memories]) => ({ keyword, memories }))
      .sort((a, b) => b.memories.length - a.memories.length);
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
    const day = this.currentDay;
    // Ensure nodes exist
    this.knowledgeGraph.addNode({ id: this.agentId, type: 'agent', name: this.agent.config.name });
    this.knowledgeGraph.addNode({ id: dossier.targetId, type: 'agent', name: dossier.targetName });

    // Trust/distrust edges — bi-temporal: soft-delete on flip preserves history
    if (dossier.trust > 20) {
      this.knowledgeGraph.addEdge({
        from: this.agentId, to: dossier.targetId, type: 'trusts',
        weight: dossier.trust, timestamp: now, day, validFrom: day,
      });
      this.knowledgeGraph.removeEdge(this.agentId, dossier.targetId, 'distrusts', day);
    } else if (dossier.trust < -20) {
      this.knowledgeGraph.addEdge({
        from: this.agentId, to: dossier.targetId, type: 'distrusts',
        weight: Math.abs(dossier.trust), timestamp: now, day, validFrom: day,
      });
      this.knowledgeGraph.removeEdge(this.agentId, dossier.targetId, 'trusts', day);
    }

    // Commitment edges
    if (dossier.activeCommitments.length > 0) {
      this.knowledgeGraph.addEdge({
        from: this.agentId, to: dossier.targetId, type: 'owes',
        weight: dossier.activeCommitments.length * 20,
        content: dossier.activeCommitments[0],
        timestamp: now, day, validFrom: day,
      });
    } else {
      this.knowledgeGraph.removeEdge(this.agentId, dossier.targetId, 'owes', day);
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

  /**
   * Observation-based dossier update (witness, no LLM call).
   * Called when this agent witnesses `actorId` doing something prosocial/defective.
   * Applies a trust delta at reduced confidence (~0.3x) and appends a witness note
   * to the dossier summary. Does NOT trigger knowledge-graph updates or concerns.
   */
  updateDossierFromObservation(
    actorId: string,
    actorName: string,
    observation: string,
    villageBenefit: number, // [-1, 1]
    day: number = 0,
  ): void {
    if (actorId === this.agentId) return; // don't update dossier on self

    // Witness confidence = 0.3x of first-person weight.
    // First-person social actions typically move trust by ~villageBenefit × 30.
    // So witness delta is villageBenefit × 30 × 0.3 = villageBenefit × 9, capped ±9.
    const trustDelta = Math.max(-9, Math.min(9, villageBenefit * 9));
    if (Math.abs(trustDelta) < 0.5) return; // ignore negligible updates

    const existing = this.dossiers.get(actorId);
    const now = Date.now();
    const noteTrimmed = observation.length > 80 ? observation.slice(0, 77) + '...' : observation;
    const witnessNote = `[witnessed day ${day}] ${noteTrimmed}`;

    if (existing) {
      existing.trust = Math.max(-100, Math.min(100, existing.trust + trustDelta));
      // Append witness note to summary (bounded: keep last 2 witness notes inline)
      const lines = existing.summary.split('\n').filter(l => l.trim());
      const nonWitnessLines = lines.filter(l => !l.startsWith('[witnessed'));
      const witnessLines = lines.filter(l => l.startsWith('[witnessed')).slice(-1); // keep latest 1
      existing.summary = [...nonWitnessLines, ...witnessLines, witnessNote].join('\n');
      existing.lastUpdated = now;
    } else {
      // Create minimal dossier from observation alone (no self-interaction history yet)
      this.dossiers.set(actorId, {
        agentId: this.agentId,
        targetId: actorId,
        targetName: actorName,
        summary: `I don't know ${actorName} personally.\n${witnessNote}`,
        trust: trustDelta,
        activeCommitments: [],
        lastInteraction: 0, // never directly interacted
        lastUpdated: now,
      });
      this.evictOldestDossierIfNeeded();
    }
    this.syncDossiersToAgent();
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
    // Deduplicate by exact content — prevents belief spam from repeated LLM calls.
    // Only dedupe against ACTIVE beliefs; historical beliefs are preserved as lineage.
    const existingByContent = this.beliefs.find(b =>
      b.content.toLowerCase() === belief.content.toLowerCase() && b.validUntil === undefined
    );
    if (existingByContent) return;

    // Structured contradiction detection (gap-analysis item 4.3):
    // If this belief has (subject, predicate), auto-invalidate any active belief
    // with the same (subject, predicate) but a different value.
    if (belief.subject && belief.predicate) {
      for (const b of this.beliefs) {
        if (
          b.validUntil === undefined &&
          b.subject === belief.subject &&
          b.predicate === belief.predicate &&
          b.value !== belief.value
        ) {
          b.validUntil = this.currentDay;
          b.supersededBy = belief.id;
        }
      }
    }

    // Bi-temporal (gap-analysis item 3.1): default validFrom to the current game day.
    // Caller may override for beliefs about past events.
    if (belief.validFrom === undefined) {
      belief.validFrom = this.currentDay;
    }

    this.beliefs.push(belief);
    void this.backingStore.add(belief).catch((err: unknown) => {
      console.warn(`[FourStream] Failed to persist belief ${belief.id} for agent ${this.agent.id}:`, (err as Error).message);
    });
    if (this.beliefs.length > 20) {
      // Prefer to evict historical (invalidated) beliefs first, then low-importance.
      this.beliefs.sort((a, b) => {
        const ah = a.validUntil !== undefined ? 1 : 0;
        const bh = b.validUntil !== undefined ? 1 : 0;
        if (ah !== bh) return ah - bh;
        return b.importance - a.importance;
      });
      this.beliefs = this.beliefs.slice(0, 20);
    }
  }

  /**
   * Mark a belief as no longer true in the world (bi-temporal invalidation).
   * Used when new evidence contradicts an existing belief. Preserves the belief
   * as "historical" lineage so agents can reason about how their understanding changed.
   */
  invalidateBelief(beliefId: string, day: number, supersededById?: string): void {
    const b = this.beliefs.find(b => b.id === beliefId);
    if (b && b.validUntil === undefined) {
      b.validUntil = day;
      if (supersededById) b.supersededBy = supersededById;
    }
  }

  getBeliefsAbout(targetIds: string[], includeHistorical: boolean = false): Memory[] {
    return this.beliefs.filter(b =>
      (b.relatedAgentIds?.some(id => targetIds.includes(id)) || (b.subject !== undefined && targetIds.includes(b.subject))) &&
      (includeHistorical || b.validUntil === undefined)
    );
  }

  /**
   * Structured belief query (gap-analysis item 4.3).
   * Find active beliefs matching subject (and optionally predicate).
   */
  getStructuredBeliefs(subject: string, predicate?: string, includeHistorical: boolean = false): Memory[] {
    return this.beliefs.filter(b =>
      b.subject === subject &&
      (!predicate || b.predicate === predicate) &&
      (includeHistorical || b.validUntil === undefined)
    );
  }

  getTopBeliefs(n: number = 3, includeHistorical: boolean = false): Memory[] {
    return this.beliefs
      .filter(b => includeHistorical || b.validUntil === undefined)
      .sort((a, b) => b.importance - a.importance)
      .slice(0, n);
  }

  getBeliefs(includeHistorical: boolean = false): Memory[] {
    return includeHistorical
      ? [...this.beliefs]
      : this.beliefs.filter(b => b.validUntil === undefined);
  }

  syncBeliefsToAgent(): void {
    this.agent.beliefs = this.beliefs.map(b => ({
      content: b.content,
      timestamp: b.timestamp,
      validFrom: b.validFrom,
      validUntil: b.validUntil,
    }));
  }

  private syncStrategiesToAgent(): void {
    // LearnedStrategy shape matches Agent field directly — persist with full utility metadata.
    this.agent.learnedStrategies = this.learnedStrategies.map(s => ({ ...s }));
    // UCB counter persists with strategies (gap-analysis item 1.1).
    this.agent.totalActionOutcomes = this.totalActionOutcomes;
  }

  getLearnedStrategies(): LearnedStrategy[] {
    return [...this.learnedStrategies];
  }

  // --- Stream 6: LEARNED AVERSIONS (gap-analysis item 1.2) ---
  //
  // Per-agent procedural memory. First-person updates only — no broadcast,
  // no shared state. confidence ∈ [-1, +1] with EMA-like update.
  //
  // basis precedence: 'punished' / 'victim' carry more weight than 'witnessed'
  // because direct experience is more informative than observation.

  updateLearnedAversion(
    actionType: string,
    delta: number,
    basis: LearnedAversion['basis']
  ): void {
    if (!actionType || actionType === 'unknown') return;
    // Basis scaling: direct experience hits harder than observation.
    const BASIS_WEIGHT: Record<LearnedAversion['basis'], number> = {
      victim: 1.0,
      punished: 1.0,
      rewarded: 0.8,
      witnessed: 0.4,
    };
    const scaledDelta = delta * BASIS_WEIGHT[basis];
    const existing = this.learnedAversions.find(a => a.actionType === actionType);
    if (existing) {
      // EMA with α that decays as evidence accumulates (softer updates later).
      const alpha = Math.max(0.1, 0.4 / (1 + existing.evidenceCount * 0.1));
      existing.confidence = Math.max(-1, Math.min(1,
        existing.confidence * (1 - alpha) + scaledDelta * alpha
      ));
      existing.evidenceCount++;
      existing.lastUpdated = Date.now();
      // Promote basis toward strongest observed (victim/punished dominate).
      if (BASIS_WEIGHT[basis] > BASIS_WEIGHT[existing.basis]) {
        existing.basis = basis;
      }
    } else {
      this.learnedAversions.push({
        actionType,
        confidence: Math.max(-1, Math.min(1, scaledDelta * 0.5)),
        basis,
        evidenceCount: 1,
        lastUpdated: Date.now(),
      });
    }
    // Cap storage — evict lowest-magnitude entries when full.
    if (this.learnedAversions.length > FourStreamMemory.MAX_AVERSIONS) {
      this.learnedAversions.sort((a, b) => Math.abs(b.confidence) - Math.abs(a.confidence));
      this.learnedAversions = this.learnedAversions.slice(0, FourStreamMemory.MAX_AVERSIONS);
    }
  }

  getAversion(actionType: string): LearnedAversion | undefined {
    return this.learnedAversions.find(a => a.actionType === actionType);
  }

  private syncAversionsToAgent(): void {
    this.agent.learnedAversions = this.learnedAversions.map(a => ({ ...a }));
  }

  /**
   * Build a short prompt hint describing strongly-held aversions/preferences.
   * Weighted by Agent.normWeight: stoic loners (0) get nothing, conformists
   * (1) get the full hint. Returns empty string if no strong signals.
   */
  buildAversionsHint(): string {
    const weight = this.agent.normWeight ?? 0.5;
    if (weight < 0.1 || this.learnedAversions.length === 0) return '';
    // Only surface entries with meaningful confidence + evidence.
    const strong = this.learnedAversions.filter(
      a => Math.abs(a.confidence) > 0.25 && a.evidenceCount >= 2
    );
    if (strong.length === 0) return '';
    strong.sort((a, b) => Math.abs(b.confidence) - Math.abs(a.confidence));
    const items = strong.slice(0, 5).map(a => {
      const verb = a.confidence < 0 ? 'avoid' : 'prefer';
      const mag = Math.abs(a.confidence).toFixed(2);
      return `${verb} ${a.actionType} (${mag}, ${a.basis})`;
    });
    const prefix = weight > 0.7 ? 'Strong habits' : 'Lean toward';
    return `${prefix}: ${items.join(', ')}.`;
  }

  /** Sync all in-memory streams back to the Agent object for snapshot/persistence */
  syncAllToAgent(): void {
    this.syncDossiersToAgent();
    this.syncConcernsToAgent();
    this.syncBeliefsToAgent();
    this.syncStrategiesToAgent();
    this.syncAversionsToAgent();
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
    rewardBiasWeight: number;   // how much past-rubric scalar shapes retrieval (0..0.3)
    budgets: { concerns: number; dossiers: number; beliefs: number; timeline: number; strategies: number };
  }> = {
    plan: {
      importanceWeight: 0.8,
      recencyDecay: 0.995,     // Slow decay — old important events still relevant for planning
      concernDecay: 0.998,
      rewardBiasWeight: 0.25,  // planning benefits most from what's worked before
      budgets: { concerns: 300, dossiers: 250, beliefs: 250, timeline: 200, strategies: 200 },
    },
    conversation: {
      importanceWeight: 0.4,
      recencyDecay: 0.97,      // Fast decay — recent events dominate conversation
      concernDecay: 0.99,
      rewardBiasWeight: 0.10,  // chatter cares less about outcome scoring
      // Rebalanced: dossiers no longer 2.67× beliefs. Agents in conversation
      // should still call on principles, not just relationship data. (Part III A3)
      budgets: { concerns: 200, dossiers: 300, beliefs: 250, timeline: 300, strategies: 100 },
    },
    reflect: {
      importanceWeight: 0.6,
      recencyDecay: 0.99,      // Balanced
      concernDecay: 0.995,
      rewardBiasWeight: 0.20,  // reflection needs both wins and losses in view
      budgets: { concerns: 250, dossiers: 300, beliefs: 300, timeline: 250, strategies: 150 },
    },
    default: {
      importanceWeight: 0.6,
      recencyDecay: 0.99,
      concernDecay: 0.995,
      rewardBiasWeight: 0.15,
      // Rebalanced: dossiers no longer 1.75× beliefs. 1:1 ratio (Part III A3).
      budgets: { concerns: 250, dossiers: 300, beliefs: 300, timeline: 250, strategies: 150 },
    },
  };

  /**
   * H4: resolve which importance axis to use for a given retrieval profile.
   * Plan retrievals lean strategic; conversation leans social; reflect balances
   * narrative + strategic. Falls back to the scalar when vector is absent.
   */
  static selectImportanceAxis(m: Memory, profile: string): number {
    if (!m.importanceVec) return m.importance;
    const v = m.importanceVec;
    switch (profile) {
      case 'plan':
        return 0.6 * v.strategic + 0.2 * v.survival + 0.2 * v.narrative;
      case 'conversation':
        return 0.6 * v.social + 0.2 * v.narrative + 0.2 * v.strategic;
      case 'reflect':
        return 0.4 * v.narrative + 0.3 * v.strategic + 0.2 * v.social + 0.1 * v.survival;
      default:
        // Balanced: average across axes with a slight narrative tilt
        return 0.25 * (v.survival + v.social + v.strategic + v.narrative) + 0.1 * v.narrative;
    }
  }

  /**
   * Adaptive cutoff (gap-analysis H1/H2): walk the sorted scores and cut when
   * the score drops below `ratio × topScore`. Returns the count of items to keep.
   * Guarantees at least `minKeep` items so agents always have context even when
   * scores are low/uniform. Max = scores.length (no artificial upper cap).
   *
   * Example: scores [0.9, 0.85, 0.4, 0.38], ratio=0.5, minKeep=2 → cut=2 (0.4 < 0.45).
   */
  static adaptiveCutoff(scores: number[], minKeep: number, ratio: number): number {
    if (scores.length <= minKeep) return scores.length;
    const top = scores[0];
    if (top <= 0) return Math.min(minKeep, scores.length);
    const threshold = top * ratio;
    let cut = minKeep;
    for (let i = minKeep; i < scores.length; i++) {
      if (scores[i] >= threshold) cut = i + 1;
      else break;
    }
    return cut;
  }

  /**
   * Score memory for retrieval priority.
   * Based on Memoria (2025): recency-aware weighting with exponential decay.
   * Adaptive: importance vs recency balance shifts based on retrieval context.
   * Gap-analysis item 5: factor in access recency — frequently-retrieved memories score higher.
   * Gap-analysis H3: context-sensitive scoring — memories that match the current
   * trigger or involve nearby agents get a relevance bonus [0, 0.25].
   */
  private scoreMemory(
    m: Memory,
    now: number,
    profile?: string,
    queryContext?: { triggerWords?: Set<string>; nearbyIds?: Set<string> },
  ): number {
    const p = FourStreamMemory.RETRIEVAL_PROFILES[profile ?? 'default'];
    const hoursOld = Math.max(0, (now - m.timestamp) / 3_600_000);
    const decay = Math.pow(p.recencyDecay, hoursOld);
    // H4: when the memory has a multi-axis importance vector, pick the axis
    // aligned with the retrieval profile. Falls back to the scalar when absent.
    const axisImportance = FourStreamMemory.selectImportanceAxis(m, profile ?? 'default');
    const importanceScore = axisImportance / 10;
    // Access-recency bonus: memory read in last 24h gets a score boost.
    // H5 fix: raised cap from 0.15 → 0.30 and added access-count ramp so
    // frequently-used memories actually dominate retrieval. Habit formation
    // requires high-use memories to become stickier, not just slightly preferred.
    const accessCountBoost = Math.min(0.15, (m.accessCount ?? 0) * 0.02);
    const accessBonus = m.lastAccessedAt
      ? Math.min(0.30, 0.15 * Math.exp(-(now - m.lastAccessedAt) / (24 * 3_600_000)) + accessCountBoost)
      : 0;
    // Context bonus (H3): lexical overlap with trigger + nearby-agent involvement.
    let contextBonus = 0;
    if (queryContext) {
      if (queryContext.triggerWords && queryContext.triggerWords.size > 0) {
        const contentLower = m.content.toLowerCase();
        let hits = 0;
        for (const w of queryContext.triggerWords) {
          if (contentLower.includes(w)) hits++;
        }
        // Normalize: each hit worth up to +0.05, cap at +0.15
        contextBonus += Math.min(0.15, hits * 0.05);
      }
      if (queryContext.nearbyIds && queryContext.nearbyIds.size > 0) {
        // Memories involving present agents are more actionable
        const related = m.relatedAgentIds ?? [];
        if (related.some(id => queryContext.nearbyIds!.has(id))) {
          contextBonus += 0.10;
        }
      }
    }
    // Reward-bias (root-audit leverage item 1): for action_outcome memories,
    // the stored rubric is a scalar-reducible reward signal. Memories that
    // produced strong positive outcomes float to the top for this agent;
    // strong failures sink. This closes the loop rubric → retrieval without
    // any training infra — it's a per-agent bandit over experience.
    let rewardBias = 0;
    if (m.actionRubric && p.rewardBiasWeight > 0) {
      const scalar = computeScalarReward(m.actionRubric, this.agent.rewardWeights);
      // clamp to [-1, +1] so rubric outliers can't dominate the score
      const clamped = Math.max(-1, Math.min(1, scalar));
      rewardBias = clamped * p.rewardBiasWeight;
    }
    return (importanceScore * p.importanceWeight + decay * (1 - p.importanceWeight)) + accessBonus + contextBonus + rewardBias;
  }

  /**
   * Mark a memory as accessed. Bumps importance (with cap) and updates lastAccessedAt.
   * Call this when a memory is actually surfaced into working memory or a prompt.
   * Gap-analysis item 5: "importance ≥ 8 never pruned" becomes earned, not granted.
   */
  private markAccessed(m: Memory, now: number): void {
    m.lastAccessedAt = now;
    m.accessCount = (m.accessCount ?? 0) + 1;
    // Boost importance by +0.1, capped at 10. Accumulates slowly so a genuinely
    // useful memory drifts upward over many retrievals, not one-shot.
    m.importance = Math.min(10, m.importance + 0.1);
  }

  /**
   * Daily importance decay: memories not accessed in the last 24h lose 0.05 importance.
   * Core memories (isCore) are exempt — identity never decays.
   * Gap-analysis item 5: without decay, one-shot imp-8 beliefs live forever even if invalidated.
   */
  private decayUnusedMemories(now: number): void {
    const dayMs = 24 * 3_600_000;
    const targets: Memory[] = [...this.timeline, ...this.beliefs, ...this.identity];
    let decayed = 0;
    for (const m of targets) {
      if (m.isCore) continue;
      const lastAccess = m.lastAccessedAt ?? m.timestamp;
      if (now - lastAccess > dayMs) {
        m.importance = Math.max(1, m.importance - 0.05);
        decayed++;
      }
    }
    if (decayed > 0) {
      console.log(`[Decay] ${this.agent.config.name}: decayed importance on ${decayed} unused memories`);
    }
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
    triggerQuery?: string,
  ): {
    concerns: string;
    dossiers: string;
    beliefs: string;
    timeline: string;
    identityAnchor: string;
    learnedStrategies: string;
    aversionsHint: string;
    socialGraph: string;
  } {
    const now = Date.now();
    const nearbySet = new Set(nearbyAgentIds ?? []);
    const profile = retrievalContext ?? 'default';
    const budgets = FourStreamMemory.RETRIEVAL_PROFILES[profile].budgets;

    // H3 context-sensitive scoring: tokenize trigger into meaningful query words.
    // Drop stopwords + tokens <3 chars. Only computed once per retrieval.
    let queryContext: { triggerWords?: Set<string>; nearbyIds?: Set<string> } | undefined;
    if (triggerQuery || nearbyAgentIds?.length) {
      const STOPWORDS = new Set([
        'the', 'and', 'you', 'your', 'for', 'with', 'are', 'was', 'has', 'have',
        'this', 'that', 'there', 'what', 'when', 'where', 'from', 'they', 'their',
        'just', 'been', 'would', 'could', 'should', 'about', 'into', 'some', 'any',
      ]);
      const words = (triggerQuery ?? '')
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 3 && !STOPWORDS.has(w));
      queryContext = {
        triggerWords: words.length > 0 ? new Set(words) : undefined,
        nearbyIds: nearbyAgentIds && nearbyAgentIds.length > 0 ? nearbySet : undefined,
      };
    }

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
      rule: '⚠ ', threat: '⚠ ',
      commitment: '', need: '', goal: '', unresolved: '',
    };
    const scoredConcerns = this.getAllConcerns()
      .map(c => ({ c, s: this.scoreConcern(c, now, profile) }))
      .sort((a, b) => b.s - a.s);
    // H1/H2 adaptive sizing: drop concerns that score < 40% of the top concern,
    // but always keep at least the top 3 so agents always see *something*.
    const cAdaptive = FourStreamMemory.adaptiveCutoff(scoredConcerns.map(x => x.s), 3, 0.4);
    const scoredConcernsTrimmed = scoredConcerns.slice(0, cAdaptive);

    let cBudget = budgets.concerns;
    const cLines: string[] = [];
    for (const { c } of scoredConcernsTrimmed) {
      const p = PREFIX[c.category] ?? '';
      // Rules with structured fields (APPLIES TO / CONSEQUENCE) need more room
      const maxLen = c.category === 'rule' ? 250 : 100;
      const t = c.content.length > maxLen ? c.content.slice(0, maxLen - 3) + '...' : c.content;
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
    // B2 fix: equalize belief count across profiles — agents' learned identity
    // shouldn't be throttled at decision-time (was: plan=5, everyone-else=3).
    // B1 fix: widen per-belief char cap to 90 so learned identity isn't
    // compressed 16× harder than birth identity (soul=800 chars).
    const pBeliefs = nearbyAgentIds ? this.getBeliefsAbout(nearbyAgentIds) : [];
    const topB = this.getTopBeliefs(profile === 'plan' ? 5 : 4);
    const allB = [...pBeliefs];
    for (const b of topB) {
      if (!allB.some(x => x.id === b.id)) allB.push(b);
    }
    let bBudget = budgets.beliefs;
    const bLines: string[] = [];
    for (const b of allB.slice(0, 6)) {
      const t = b.content.length > 90 ? b.content.slice(0, 87) + '...' : b.content;
      const line = `- ${t}`;
      if (bBudget - line.length < 0 && bLines.length >= 4) break;
      bLines.push(line);
      bBudget -= line.length;
      this.markAccessed(b, now); // gap-analysis item 5: reward reuse
    }
    const beliefs = bLines.join('\n');

    // --- TIMELINE (budget from profile) ---
    // Sorted by importance × decay, not chronology
    const pool = this.getRecentTimeline(20);
    const scoredT = pool
      .map(m => ({ m, s: this.scoreMemory(m, now, profile, queryContext) }))
      .sort((a, b) => b.s - a.s);
    // H1/H2 adaptive sizing: include items whose score is within 50% of the top,
    // keeping at least 4 so agents always have some recent context.
    const tAdaptive = FourStreamMemory.adaptiveCutoff(scoredT.map(x => x.s), 4, 0.5);
    const scoredTTrimmed = scoredT.slice(0, tAdaptive);

    let tBudget = budgets.timeline;
    const tLines: string[] = [];
    for (const { m } of scoredTTrimmed) {
      const t = m.content.length > 85 ? m.content.slice(0, 82) + '...' : m.content;
      const line = `- ${t}`;
      if (tBudget - line.length < 0 && tLines.length >= 4) break;
      tLines.push(line);
      tBudget -= line.length;
      this.markAccessed(m, now); // gap-analysis item 5: reward reuse
    }
    const timeline = tLines.length > 0
      ? tLines.join('\n')
      : 'Nothing notable yet.';

    // --- LEARNED STRATEGIES (budget from profile) ---
    // Rank by utility (successRate × rewardDelta × recency) — not just "latest 3".
    // A proven strategy from day 2 beats yesterday's unverified hunch.
    const currentDay = this.agent.joinedDay ?? 0; // best-effort day; refined in analyzeStrategyOutcomes
    // UCB-aware selection: under-tried strategies get an exploration bonus so the
    // book doesn't calcify around early wins (gap-analysis item 1.1).
    const rankedStrategies = [...this.learnedStrategies]
      .map(s => ({ s, u: strategyUtility(s, currentDay, this.totalActionOutcomes) }))
      .sort((a, b) => b.u - a.u)
      .slice(0, 3)
      .map(x => x.s);

    let sBudget = budgets.strategies;
    const sLines: string[] = [];
    for (const s of rankedStrategies) {
      const t = s.content.length > 100 ? s.content.slice(0, 97) + '...' : s.content;
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

    // --- AVERSIONS HINT (gap-analysis item 1.2) — soft personality bias from experience ---
    const aversionsHint = this.buildAversionsHint();

    // --- SOCIAL GRAPH (gap-analysis item 3A) — transitive relationships from KG ---
    // Surfaces allies/enemies/betrayals derived from the knowledge graph, which
    // captures relationship topology that flat dossiers can't express.
    const nameMap = new Map<string, string>();
    nameMap.set(this.agentId, this.agent.config.name);
    for (const d of this.dossiers.values()) nameMap.set(d.targetId, d.targetName);
    const socialGraph = this.knowledgeGraph.buildSocialSummary(this.agentId, nameMap, 180);

    return { concerns, dossiers, beliefs, timeline, identityAnchor, learnedStrategies, aversionsHint, socialGraph };
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

    // Pattern extraction (gap-analysis item 1B): surface top keyword clusters so the
    // LLM sees emergent themes in today's activity rather than chronological noise.
    // "grain appeared in 5/6 events" → one grain-centric belief, not 3 fragmented ones.
    const clusters = this.getKeywordClusters(2).slice(0, 4);
    const clusterContext = clusters.length > 0
      ? '<patterns_detected>\n' + clusters
          .map(c => `${escapeXml(c.keyword)} (${c.memories.length}x): ${escapeXml(c.memories.slice(-2).map(m => m.content.slice(0, 60)).join(' | '))}`)
          .join('\n') + '\n</patterns_detected>'
      : '';

    // Name → id map so we can resolve LLM-emitted names to stable subject keys (item 4.3)
    const nameToId = new Map<string, string>();
    for (const d of mentionedDossiers) {
      nameToId.set(d.targetName.toLowerCase(), d.targetId);
    }

    // OWASP LLM01: wrap agent-generated content in XML tags, with XML escaping.
    const prompt = `Based on recent experiences:
<recent_events>
${escapeXml(recentText)}
</recent_events>

${peopleContext ? '<people_context>\n' + peopleContext + '\n</people_context>' : ''}

${clusterContext}

What do you now BELIEVE? Not facts — beliefs and conclusions.
About the people around you, about your own situation, about what you should do differently.

2-3 beliefs, honest and personal. Return JSON array. Each belief is an object:
{
  "content": "natural-language belief (required)",
  "subject": "person name OR short topic (null if purely self-directed)",
  "predicate": "snake_case trait like trustworthiness, intent, reciprocity, reliability (null if not about a specific trait)",
  "value": "short claim like low, hostile, conditional, high (null if predicate is null)"
}
Example: [
  {"content": "Egao only helps when it benefits him", "subject": "Egao", "predicate": "reciprocity", "value": "conditional"},
  {"content": "I should go to the farm earlier before the wheat runs out", "subject": null, "predicate": null, "value": null}
]`;

    try {
      const response = await llm.complete(
        this.identity.map(m => m.content).join('\n'),
        prompt
      );
      const cleaned = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const insights = JSON.parse(cleaned);

      if (Array.isArray(insights)) {
        for (const raw of insights.slice(0, 3)) {
          // Support both legacy string format and new structured object format
          let content: string | undefined;
          let subject: string | undefined;
          let predicate: string | undefined;
          let value: string | undefined;
          if (typeof raw === 'string') {
            content = raw;
          } else if (raw && typeof raw === 'object' && typeof raw.content === 'string') {
            content = raw.content;
            // Resolve subject name → agent ID when possible (falls back to raw name)
            if (typeof raw.subject === 'string' && raw.subject.length > 0) {
              subject = nameToId.get(raw.subject.toLowerCase()) ?? raw.subject;
            }
            if (typeof raw.predicate === 'string' && raw.predicate.length > 0) {
              predicate = raw.predicate;
            }
            if (typeof raw.value === 'string' && raw.value.length > 0) {
              value = raw.value;
            }
          }
          if (!content || content.length < 10) continue;
          this.addBelief({
            id: crypto.randomUUID(),
            agentId: this.agentId,
            type: 'reflection',
            content,
            importance: 8,
            timestamp: Date.now(),
            relatedAgentIds: [...mentionedIds],
            visibility: 'private',
            subject,
            predicate,
            value,
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
  async analyzeStrategyOutcomes(llm: LLMProvider, currentDay: number = 0): Promise<void> {
    // Collect action_outcome memories from timeline
    const outcomes = this.timeline.filter(m => m.type === 'action_outcome');
    if (outcomes.length < 3) return; // Need enough data to find patterns

    // Rubric-based success classification: if actionRubric exists, use scalar reward (0 = threshold).
    // Falls back to actionSuccess bool, then legacy regex for pre-rubric memories.
    const weights = this.agent.rewardWeights;
    const classify = (m: Memory): { success: boolean; reward: number } => {
      if (m.actionRubric) {
        const reward = computeScalarReward(m.actionRubric, weights);
        return { success: reward > 0, reward };
      }
      if (typeof m.actionSuccess === 'boolean') {
        return { success: m.actionSuccess, reward: m.actionSuccess ? 0.5 : -0.5 };
      }
      // Legacy regex fallback
      const isSuccess = /success|gathered|crafted|built|discovered|earned|healed/i.test(m.content);
      const isFailure = /failed|lost|broke|rejected|hurt|starved/i.test(m.content);
      if (isSuccess) return { success: true, reward: 0.5 };
      if (isFailure) return { success: false, reward: -0.5 };
      return { success: false, reward: 0 };
    };

    const classified = outcomes.map(m => ({ m, ...classify(m) }));
    const successes = classified.filter(c => c.success);
    const failures = classified.filter(c => !c.success && c.reward < 0);

    if (successes.length + failures.length < 3) return;

    // --- Update utility stats on EXISTING strategies based on today's outcomes ---
    // Heuristic match: strategy applies if its content shares ≥2 meaningful tokens with outcome content.
    for (const strategy of this.learnedStrategies) {
      const strategyTokens = new Set(
        strategy.content.toLowerCase().split(/\W+/).filter(t => t.length > 4)
      );
      let matched = 0;
      let successfulMatches = 0;
      let rewardSum = 0;
      for (const c of classified) {
        const outcomeTokens = c.m.content.toLowerCase().split(/\W+/).filter(t => t.length > 4);
        const overlap = outcomeTokens.filter(t => strategyTokens.has(t)).length;
        if (overlap >= 2) {
          matched++;
          if (c.success) successfulMatches++;
          rewardSum += c.reward;
        }
      }
      if (matched > 0) {
        strategy.lastAccessedDay = currentDay;
        const prevTotal = strategy.timesUsed;
        const prevReward = strategy.avgRewardDelta * prevTotal;
        strategy.timesUsed += matched;
        strategy.timesSuccessful += successfulMatches;
        strategy.avgRewardDelta = (prevReward + rewardSum) / strategy.timesUsed;
      }
    }

    const outcomeText = classified.map(c => {
      const r = c.reward.toFixed(2);
      return `[${c.success ? 'SUCCESS' : 'FAILURE'} reward=${r}] ${c.m.content}`;
    }).join('\n');

    const existingLessons = this.learnedStrategies
      .map(s => s.content)
      .join('\n');

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
      let lessons: unknown;
      try {
        lessons = JSON.parse(cleaned);
      } catch {
        // Fallback: extract JSON array from prose (LLM sometimes appends explanation after the array)
        const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          lessons = JSON.parse(arrayMatch[0]);
        } else {
          throw new Error(`No JSON array found in response: "${cleaned.substring(0, 120)}..."`);
        }
      }

      if (Array.isArray(lessons)) {
        for (const lesson of lessons.slice(0, 2)) {
          if (typeof lesson !== 'string' || lesson.length < 10) continue;
          // Deduplicate against existing strategies
          const isDuplicate = this.learnedStrategies.some(s =>
            s.content.toLowerCase() === lesson.toLowerCase()
          );
          if (isDuplicate) continue;

          const newStrategy: LearnedStrategy = {
            content: lesson,
            createdDay: currentDay,
            lastAccessedDay: currentDay,
            timesUsed: 0,
            timesSuccessful: 0,
            avgRewardDelta: 0,
          };
          this.learnedStrategies.push(newStrategy);

          // Also persist as Memory for retrieval/search compatibility.
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
          void this.backingStore.add(strategyMemory).catch((err: unknown) => {
            console.warn(`[FourStream] Failed to persist strategy for agent ${this.agent.id}:`, (err as Error).message);
          });
        }

        // Utility-ranked eviction — evict LOWEST utility, not newest. This lets an agent
        // genuinely learn rule #17 by retiring whichever existing rule has stopped earning reward.
        if (this.learnedStrategies.length > FourStreamMemory.MAX_STRATEGIES) {
          // UCB-aware eviction (gap-analysis item 1.1): under-tried strategies keep
          // some protection via the exploration bonus, so we don't evict rule #11
          // before it's had a chance to prove itself.
          this.learnedStrategies.sort((a, b) =>
            strategyUtility(b, currentDay, this.totalActionOutcomes) -
            strategyUtility(a, currentDay, this.totalActionOutcomes)
          );
          this.learnedStrategies = this.learnedStrategies.slice(0, FourStreamMemory.MAX_STRATEGIES);
        }
        this.syncStrategiesToAgent();
        console.log(`[Strategy] ${this.agent.config.name}: ${this.learnedStrategies.length} learned strategies (top utility: ${this.learnedStrategies[0] ? strategyUtility(this.learnedStrategies[0], currentDay, this.totalActionOutcomes).toFixed(2) : 'n/a'})`);
      }
    } catch (err) {
      console.error(`[Strategy] ${this.agent.config.name} strategy analysis failed:`, err);
    }
  }

  /**
   * Failure-mining step (negative sample augmentation, item 8 from gap analysis).
   * Runs BEFORE general strategy extraction in nightly compression.
   * Research basis: BCPG-NSA shows explicit failure mining is worth 1.5-3× sample efficiency.
   * Separate from `analyzeStrategyOutcomes` because lumping wins + losses dilutes the lesson.
   */
  async analyzeFailures(llm: LLMProvider, currentDay: number = 0): Promise<void> {
    const outcomes = this.timeline.filter(m => m.type === 'action_outcome');
    if (outcomes.length < 2) return;

    const weights = this.agent.rewardWeights;
    const failed = outcomes.filter(m => {
      if (m.actionRubric) return computeScalarReward(m.actionRubric, weights) < -0.1;
      if (typeof m.actionSuccess === 'boolean') return !m.actionSuccess;
      return /failed|lost|broke|rejected|hurt|starved/i.test(m.content);
    });

    if (failed.length < 2) return; // Need at least 2 failures to find a pattern

    const failureText = failed.map(m => {
      if (m.actionRubric) {
        const r = computeScalarReward(m.actionRubric, weights).toFixed(2);
        return `[reward=${r}] ${m.content}`;
      }
      return `- ${m.content}`;
    }).join('\n');

    const existingLessons = this.learnedStrategies.map(s => s.content).join('\n');

    const prompt = `You had ${failed.length} failures today. Examine them specifically:
<failures>
${escapeXml(failureText)}
</failures>

${existingLessons ? '<existing_lessons>\n' + escapeXml(existingLessons) + '\n</existing_lessons>\n\nDo not repeat existing lessons.' : ''}

What went wrong? Identify 1 concrete lesson to AVOID future failures.
Focus on what NOT to do, or what conditions made the failure inevitable.

JSON array with at most 1 string. Empty array [] if failures were random/unavoidable.`;

    try {
      const response = await llm.complete(
        this.identity.map(m => m.content).join('\n'),
        prompt,
      );
      const cleaned = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      let lessons: unknown;
      try {
        lessons = JSON.parse(cleaned);
      } catch {
        const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          lessons = JSON.parse(arrayMatch[0]);
        } else {
          throw new Error(`No JSON array found in response: "${cleaned.substring(0, 120)}..."`);
        }
      }
      if (!Array.isArray(lessons) || lessons.length === 0) return;

      const lesson = lessons[0];
      if (typeof lesson !== 'string' || lesson.length < 10) return;

      const isDuplicate = this.learnedStrategies.some(s =>
        s.content.toLowerCase() === lesson.toLowerCase()
      );
      if (isDuplicate) return;

      // Seed with negative reward delta — this lesson was extracted from failure.
      const newStrategy: LearnedStrategy = {
        content: lesson,
        createdDay: currentDay,
        lastAccessedDay: currentDay,
        timesUsed: failed.length,
        timesSuccessful: 0,
        avgRewardDelta: -0.5,
      };
      this.learnedStrategies.push(newStrategy);

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
      void this.backingStore.add(strategyMemory).catch((err: unknown) => {
        console.warn(`[FourStream] Failed to persist failure lesson for agent ${this.agent.id}:`, (err as Error).message);
      });

      console.log(`[Failures] ${this.agent.config.name} learned: "${lesson.slice(0, 60)}..."`);
    } catch (err) {
      console.error(`[Failures] ${this.agent.config.name} failure analysis failed:`, err);
    }
  }

  // --- COMPRESSION (nightly) ---

  /**
   * Novelty score for today (gap-analysis item 6).
   * Higher = more unique events, warranting expensive LLM compression.
   * Lower = repetitive day, skip the heavy nightly LLM pass.
   */
  private computeNoveltyScore(): number {
    const dayMs = 24 * 3_600_000;
    const now = Date.now();
    const todayEvents = this.timeline.filter(m => (now - m.timestamp) < dayMs);
    if (todayEvents.length === 0) return 0;

    // Unique keyword count / total = novelty ratio
    const allKeywords = new Set<string>();
    let tokenTotal = 0;
    for (const m of todayEvents) {
      if (m.keywords) {
        for (const k of m.keywords) allKeywords.add(k);
        tokenTotal += m.keywords.length;
      } else {
        // Fallback: content tokens
        const toks = m.content.toLowerCase().split(/\W+/).filter(t => t.length > 4);
        for (const t of toks) allKeywords.add(t);
        tokenTotal += toks.length;
      }
    }
    const uniqueRatio = tokenTotal > 0 ? allKeywords.size / tokenTotal : 0;
    // Weight by event count: 3 novel events < 10 novel events
    const volumeFactor = Math.min(1, todayEvents.length / 15);
    return uniqueRatio * volumeFactor;
  }

  /**
   * Timeline eviction (gap-analysis Q1 fix): replaces blind `slice(-20)` with
   * importance × causal-membership × concern-reference scoring.
   *
   * Protects:
   *   - Events that caused something (ledTo.length > 0) — chain starts
   *   - Events referenced by open concerns (overlap on relatedAgentIds)
   *   - Causal antecedents of surviving events (causedBy chain-walk)
   *   - High-importance memories (earned ≥ 8)
   */
  private evictTimeline(events: Memory[], maxSize: number): Memory[] {
    if (events.length <= maxSize) return events;

    // Build set of agent IDs referenced by open (unresolved) concerns.
    // Events that touch these agents are more likely to matter tomorrow.
    const openConcernAgents = new Set<string>();
    for (const c of this.concerns) {
      if (c.resolved) continue;
      for (const aid of c.relatedAgentIds) openConcernAgents.add(aid);
    }

    const scoreOf = (m: Memory): number => {
      let score = m.importance;
      if (m.ledTo && m.ledTo.length > 0) score += 3; // causal chain start
      if (m.causedBy) score += 1;                    // downstream effect
      if (m.importance >= 8) score += 2;             // earned high importance
      // Concern reference: any overlap with open concerns' related agents
      if (m.relatedAgentIds?.some(a => openConcernAgents.has(a))) score += 2;
      return score;
    };

    // First pass: top-maxSize by score.
    const byId = new Map<string, Memory>();
    for (const m of events) byId.set(m.id, m);
    const ranked = [...events].sort((a, b) => scoreOf(b) - scoreOf(a));
    const kept = new Set<string>(ranked.slice(0, maxSize).map(m => m.id));

    // Chain-walk: for each kept event, also keep its causedBy antecedent
    // (chains stay intact so credit-assignment can still traverse them).
    const walkBudget = Math.ceil(maxSize * 0.25);
    let walked = 0;
    for (const id of [...kept]) {
      if (walked >= walkBudget) break;
      const m = byId.get(id);
      if (!m?.causedBy) continue;
      if (kept.has(m.causedBy)) continue;
      if (byId.has(m.causedBy)) {
        kept.add(m.causedBy);
        walked++;
      }
    }

    // Return kept events in chronological order (consumers expect this).
    return events
      .filter(m => kept.has(m.id))
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Pressure-triggered compression check (root-audit leverage item 3).
   * Returns true when the timeline has grown past the soft watermark AND enough
   * real time has passed since the last compression to prevent thrashing.
   * Agent-controller polls this on its hourly hook and fires nightlyCompression
   * early when memory mass is building mid-day.
   */
  shouldCompressFromPressure(): boolean {
    const HIGH_WATERMARK = 40;           // 80% of TIMELINE_MAX (50)
    const COOLDOWN_MS = 30 * 60 * 1000;  // 30 real minutes between pressure compacts
    if (this.timeline.length < HIGH_WATERMARK) return false;
    const sinceLast = Date.now() - this.lastCompressionAt;
    return sinceLast > COOLDOWN_MS;
  }

  async nightlyCompression(llm: LLMProvider, currentDay: number = 0): Promise<void> {
    // Stamp for pressure-cooldown (root-audit leverage item 3).
    this.lastCompressionAt = Date.now();
    // Pressure check (gap-analysis item 6): skip expensive LLM steps on boring days.
    // Still run cheap maintenance (decay, prune). Nightly becomes a lower bound, not the trigger.
    const timelineLen = this.timeline.length;
    const novelty = this.computeNoveltyScore();
    const skipLLM = timelineLen < 8 && novelty < 0.35;
    if (skipLLM) {
      console.log(`[Compression] ${this.agent.config.name}: skipping LLM steps (tl=${timelineLen}, novelty=${novelty.toFixed(2)})`);
      this.decayUnusedMemories(Date.now());
      this.reprioritizeConcerns(Date.now());
      this.pruneExpired(Date.now());
      return;
    }

    // 0a. Failure mining — negative sample augmentation (gap-analysis item 8).
    //     Runs FIRST so failures don't get diluted by the general pattern-extraction prompt.
    await this.analyzeFailures(llm, currentDay);

    // 0b. Experiential learning — extract strategy lessons before compressing timeline.
    //     Uses rubric-weighted rewards when actionRubric is present (gap-analysis items 1,2,4).
    await this.analyzeStrategyOutcomes(llm, currentDay);

    // 0c. Causal credit walk — tag earlier events that caused today's bad outcomes (item 3).
    await this.analyzeCausalChains(llm);

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

    // Timeline eviction (gap-analysis item 3, Q1 fix): replace blind slice(-20) with
    // importance × causal-membership scoring. Causal chain members and events
    // referenced by open concerns/commitments are protected from eviction.
    this.timeline = this.evictTimeline(compressed, 20);

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

    // 7b. Contradiction resolution — merge conflicting beliefs about same entity (item 7).
    await this.resolveContradictions(llm);

    // 7c. Importance decay — memories not accessed in 24h lose 0.05 importance (item 5).
    this.decayUnusedMemories(now);

    // 8. Standard pruning
    this.pruneExpired(now);

    // 9. Reasoning-quality log (gap-analysis item 1.3): surface the running EMA so
    // operators can watch an agent's planning/perception skill drift over time.
    const rs = this.agent.reasoningScore;
    if (rs) {
      console.log(
        `[Reasoning] ${this.agent.config.name}: plan-alignment=${rs.planAlignment.toFixed(2)} ` +
        `thought-relevance=${rs.thoughtRelevance.toFixed(2)} (actions=${this.totalActionOutcomes})`
      );
    }
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

  /**
   * Retroactive causal credit assignment (gap-analysis item 3).
   * Walk backward from strongly-negative outcomes to identify 1-3 causal events.
   * Tags causal events via Memory.causedBy / ledTo — surviving the timeline cap via links.
   *
   * Solves: "chopped wood at 09:00 → starved at 18:00" — the 09:00 event gets evicted
   * before agent connects it to the 18:00 consequence. Credit walk preserves the link.
   */
  private async analyzeCausalChains(llm: LLMProvider): Promise<void> {
    // Find strong consequences: very-negative rubric, high-importance failure outcomes, or vitals hits.
    const weights = this.agent.rewardWeights;
    const consequences = this.timeline.filter(m => {
      if (m.type !== 'action_outcome' && m.type !== 'observation') return false;
      if (m.causedBy) return false; // already tagged
      if (m.actionRubric) {
        return computeScalarReward(m.actionRubric, weights) < -0.3;
      }
      // Fallback: importance-7+ outcomes that look like failures
      return m.importance >= 7 && /starved|hurt|injured|lost|broke|betrayed|failed badly/i.test(m.content);
    });

    if (consequences.length === 0) return;

    // Only process up to 2 per nightly to limit LLM calls
    for (const consequence of consequences.slice(0, 2)) {
      // Candidate causes: timeline events BEFORE this consequence (temporal priors)
      const candidates = this.timeline.filter(m =>
        m.id !== consequence.id &&
        m.timestamp < consequence.timestamp &&
        (consequence.timestamp - m.timestamp) < 3 * 24 * 3_600_000 // within 3 days
      ).slice(-15); // up to 15 recent candidates

      if (candidates.length < 2) continue;

      const candidateText = candidates.map((m, i) => `${i}. ${m.content}`).join('\n');

      const prompt = `Something went wrong:
<consequence>
${escapeXml(consequence.content)}
</consequence>

Earlier events that could have contributed:
<candidates>
${escapeXml(candidateText)}
</candidates>

Which 1-3 earlier events most plausibly CAUSED the consequence?
Reply with JSON array of candidate indices (numbers). Empty array [] if no clear cause.
Example: [0, 3]`;

      try {
        const response = await llm.complete(
          this.identity.map(m => m.content).join('\n'),
          prompt,
        );
        const cleaned = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        const indices = JSON.parse(cleaned);
        if (!Array.isArray(indices)) continue;

        for (const idx of indices.slice(0, 3)) {
          if (typeof idx !== 'number' || idx < 0 || idx >= candidates.length) continue;
          const cause = candidates[idx];
          // Bidirectional link via existing Memory fields
          consequence.causedBy = cause.id;
          cause.ledTo = cause.ledTo ?? [];
          if (!cause.ledTo.includes(consequence.id)) cause.ledTo.push(consequence.id);
          // Boost cause importance — it mattered more than it looked at the time
          cause.importance = Math.min(10, cause.importance + 1);
        }
        console.log(`[Causal] ${this.agent.config.name}: linked ${indices.length} causes to "${consequence.content.slice(0, 40)}..."`);
      } catch {
        // Non-critical — skip on failure
      }
    }
  }

  /**
   * Contradiction resolution (gap-analysis item 7).
   * Scans belief pairs for conflicts about the same entity. Emits resolution belief,
   * demotes superseded belief. The Identity Evolution step DETECTS drift but does not RESOLVE it.
   */
  private async resolveContradictions(llm: LLMProvider): Promise<void> {
    if (this.beliefs.length < 2) return;

    // Heuristic: find belief pairs that mention the same entity (agent names, tokens)
    // and contain opposing sentiment keywords.
    const positive = /trust|kind|generous|honest|ally|friend|reliable|helpful/i;
    const negative = /betray|distrust|selfish|liar|enemy|cruel|hostile|dangerous/i;

    type Pair = { a: Memory; b: Memory; overlap: string[] };
    const candidatePairs: Pair[] = [];

    const tokens = (m: Memory) =>
      m.content.toLowerCase().split(/\W+/).filter(t => t.length > 4);

    for (let i = 0; i < this.beliefs.length; i++) {
      for (let j = i + 1; j < this.beliefs.length; j++) {
        const a = this.beliefs[i], b = this.beliefs[j];
        const aPos = positive.test(a.content), aNeg = negative.test(a.content);
        const bPos = positive.test(b.content), bNeg = negative.test(b.content);
        if (!((aPos && bNeg) || (aNeg && bPos))) continue;
        const tA = new Set(tokens(a));
        const overlap = tokens(b).filter(t => tA.has(t));
        if (overlap.length >= 2) {
          candidatePairs.push({ a, b, overlap });
        }
      }
    }

    if (candidatePairs.length === 0) return;

    // Resolve at most 2 contradictions per nightly
    for (const pair of candidatePairs.slice(0, 2)) {
      const olderFirst = pair.a.timestamp < pair.b.timestamp ? [pair.a, pair.b] : [pair.b, pair.a];

      const prompt = `Two of your beliefs contradict each other:
<older_belief>
${escapeXml(olderFirst[0].content)}
</older_belief>

<newer_belief>
${escapeXml(olderFirst[1].content)}
</newer_belief>

Write ONE resolution sentence acknowledging the shift.
Example: "I trusted Bob until day 5, but his betrayal changed that — now I'm wary."
Reply with ONLY the sentence. No labels, no JSON.`;

      try {
        const response = await llm.complete(
          this.identity.map(m => m.content).join('\n'),
          prompt,
        );
        const clean = response.trim().slice(0, 200);
        if (clean.length < 15) continue;

        // Demote the older (superseded) belief AND mark it as historical
        // (bi-temporal invalidation — gap-analysis item 3.1).
        olderFirst[0].importance = Math.max(1, olderFirst[0].importance - 3);
        const resolutionId = crypto.randomUUID();
        olderFirst[0].validUntil = this.currentDay;
        olderFirst[0].supersededBy = resolutionId;
        this.addBelief({
          id: resolutionId,
          agentId: this.agentId,
          type: 'reflection',
          content: clean,
          importance: 9,
          timestamp: Date.now(),
          relatedAgentIds: [],
          visibility: 'private',
        });
        console.log(`[Contradiction] ${this.agent.config.name}: resolved — "${clean.slice(0, 60)}..."`);
      } catch {
        // Non-critical
      }
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

    // Share learned strategies — wrap LearnedStrategy in a Memory shape for transmission.
    // Rank by utility (proven strategies first) rather than newness.
    if (shareable.length < maxCount) {
      const currentDay = this.agent.joinedDay ?? 0;
      const ranked = [...this.learnedStrategies]
        .sort((a, b) => strategyUtility(b, currentDay) - strategyUtility(a, currentDay))
        .slice(0, maxCount - shareable.length);
      const wrapped: Memory[] = ranked.map(s => ({
        id: crypto.randomUUID(),
        agentId: this.agentId,
        type: 'reflection',
        content: s.content,
        importance: 9,
        isCore: true,
        timestamp: Date.now(),
        relatedAgentIds: [],
        visibility: 'shared',
      }));
      shareable.push(...wrapped);
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
