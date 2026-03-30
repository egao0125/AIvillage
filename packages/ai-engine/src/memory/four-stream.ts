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

    // OWASP LLM02: wrap user-controlled content (agent names, conversation text) in XML
    // tags to structurally separate untrusted data from instructions.
    const prompt = `You are ${this.agent.config.name}. You just interacted with <person_name>${targetName}</person_name>.

What happened: <event_description>${interactionSummary}</event_description>

${recentWithPerson ? 'Recent history with them:\n<history>' + recentWithPerson + '</history>\n' : ''}
${existingText}

Update your mental model of <person_name>${targetName}</person_name>. Reply with JSON ONLY:
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

  syncDossiersToAgent(): void {
    this.agent.dossiers = Array.from(this.dossiers.values());
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

  /** Sync all in-memory streams back to the Agent object for snapshot/persistence */
  syncAllToAgent(): void {
    this.syncDossiersToAgent();
    this.syncConcernsToAgent();
    this.syncBeliefsToAgent();
  }

  // --- RETRIEVAL SCORING (Memoria's recency-aware weighting) ---

  /**
   * Score memory for retrieval priority.
   * Based on Memoria (2025): recency-aware weighting with exponential decay.
   * Decay rate 0.99/hour: 12h=0.886, 48h=0.617, 72h=0.484
   */
  private scoreMemory(m: Memory, now: number): number {
    const hoursOld = Math.max(0, (now - m.timestamp) / 3_600_000);
    const decay = Math.pow(0.99, hoursOld);
    return (m.importance / 10) * decay;
  }

  /**
   * Score concern for retrieval priority.
   * Category determines base weight. Permanent concerns (rules) don't decay.
   */
  private scoreConcern(c: ActiveConcern, now: number): number {
    const WEIGHT: Record<string, number> = {
      rule: 1.0, threat: 0.9, commitment: 0.7,
      need: 0.6, goal: 0.4, unresolved: 0.2,
    };
    const base = WEIGHT[c.category] ?? 0.3;
    if (c.permanent) return base;
    const hoursOld = Math.max(0, (now - c.createdAt) / 3_600_000);
    return base * Math.pow(0.995, hoursOld);
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
  ): {
    concerns: string;
    dossiers: string;
    beliefs: string;
    timeline: string;
    identityAnchor: string;
  } {
    const now = Date.now();
    const nearbySet = new Set(nearbyAgentIds ?? []);

    // Prune stale concerns before building memory
    this.concerns = this.concerns.filter(c => {
      if (c.permanent) return true;
      if (c.expiresAt && now > c.expiresAt) return false;
      if (c.category === 'unresolved' && (now - (c.createdAt || now)) > 48 * 3600000) return false;
      return true;
    });
    this.syncConcernsToAgent();

    // --- CONCERNS (250 chars) ---
    // Sorted by category weight × decay
    const PREFIX: Record<string, string> = {
      rule: '⚠ RULE: ', threat: '⚠ ',
      commitment: '', need: '', goal: '', unresolved: '',
    };
    const scoredConcerns = this.getAllConcerns()
      .map(c => ({ c, s: this.scoreConcern(c, now) }))
      .sort((a, b) => b.s - a.s);

    let cBudget = 250;
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

    // --- DOSSIERS (350 chars) ---
    // ALL relationships by |trust|, dead agents collapsed or skipped
    const allDossiers = Array.from(this.dossiers.values())
      .filter(d => d.summary?.length > 0)
      .sort((a, b) => Math.abs(b.trust) - Math.abs(a.trust));

    let dBudget = 350;
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

    // --- BELIEFS (200 chars, max 5) ---
    const pBeliefs = nearbyAgentIds ? this.getBeliefsAbout(nearbyAgentIds) : [];
    const topB = this.getTopBeliefs(3);
    const allB = [...pBeliefs];
    for (const b of topB) {
      if (!allB.some(x => x.id === b.id)) allB.push(b);
    }
    let bBudget = 200;
    const bLines: string[] = [];
    for (const b of allB.slice(0, 5)) {
      const t = b.content.length > 50 ? b.content.slice(0, 47) + '...' : b.content;
      const line = `- ${t}`;
      if (bBudget - line.length < 0 && bLines.length >= 3) break;
      bLines.push(line);
      bBudget -= line.length;
    }
    const beliefs = bLines.join('\n');

    // --- TIMELINE (250 chars, max 5) ---
    // Sorted by importance × decay, not chronology
    const pool = this.getRecentTimeline(20);
    const scoredT = pool
      .map(m => ({ m, s: this.scoreMemory(m, now) }))
      .sort((a, b) => b.s - a.s);

    let tBudget = 250;
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

    return { concerns, dossiers, beliefs, timeline, identityAnchor };
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

    // OWASP LLM02: wrap agent-generated content (memory text, dossier summaries) in XML tags.
    const prompt = `Based on recent experiences:
<recent_events>
${recentText}
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

  // --- COMPRESSION (nightly) ---

  async nightlyCompression(llm: LLMProvider): Promise<void> {
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

    // 5. Standard pruning
    this.pruneExpired(now);
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
