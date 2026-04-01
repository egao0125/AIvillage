// ============================================================================
// AI Village — Tiered Memory (Infra 5)
// Four tiers: identity (immutable), episodic (bounded), semantic (compressed),
// working (transient, rebuilt per LLM call).
// ============================================================================

import type { AgentConfig, Memory } from '@ai-village/shared';
import type { MemoryStore, LLMProvider } from '../index.js';

export class TieredMemory {
  private identity: Memory[] = [];
  private semantic: Memory[] = [];

  constructor(
    private agentId: string,
    private backingStore: MemoryStore,
  ) {}

  /** Called once at agent spawn — seeds identity memories */
  seedIdentity(config: AgentConfig): void {
    const soul = config.soul || config.backstory || '';
    this.identity = [
      {
        id: 'identity-core', agentId: this.agentId, type: 'reflection',
        content: `I am ${config.name}, age ${config.age}. ${soul}`,
        importance: 10, isCore: true, timestamp: 0, relatedAgentIds: [],
      },
    ];
    if (config.goal) {
      this.identity.push({
        id: 'identity-goal', agentId: this.agentId, type: 'reflection',
        content: `My goal: ${config.goal}`,
        importance: 10, isCore: true, timestamp: 0, relatedAgentIds: [],
      });
    }
    // Identity memories also go into backing store for retrieval
    for (const m of this.identity) {
      void this.backingStore.add(m).catch((err: unknown) => {
        console.warn(`[TieredMemory] Failed to persist identity memory ${m.id} for agent ${this.agentId}:`, (err as Error).message);
      });
    }
  }

  /** Add an episodic memory (experiences, conversations, observations) */
  async addEpisodic(memory: Memory): Promise<void> {
    await this.backingStore.add(memory);
  }

  /** Add a semantic memory (compressed knowledge) */
  addSemantic(memory: Memory): void {
    this.semantic.push(memory);
  }

  /** Build working memory for an LLM call */
  async buildWorkingMemory(context: string): Promise<Memory[]> {
    const working: Memory[] = [];

    // Always include identity (3-5 items)
    working.push(...this.identity);

    // Retrieve contextually relevant episodic (7-8 items)
    const episodic = await this.backingStore.retrieve(this.agentId, context, 8);
    working.push(...episodic);

    // Retrieve relevant semantic knowledge (2-3 items)
    const semanticRelevant = this.semantic
      .filter(m => {
        const words = context.toLowerCase().split(/\s+/);
        return words.some(w => w.length > 2 && m.content.toLowerCase().includes(w));
      })
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 3);
    working.push(...semanticRelevant);

    return working;
  }

  /** Nightly compression: promote episodic → semantic */
  async compress(llm: LLMProvider): Promise<void> {
    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
    const old = await this.backingStore.getOlderThan(this.agentId, threeHoursAgo);
    const compressible = old.filter(m => m.importance < 7 && !m.isCore);
    if (compressible.length < 5) return;

    // Group by causal chain root (Freedom 4), fall back to type-based grouping
    const chains = this.buildCausalChains(compressible);

    for (const chain of chains) {
      const chainTexts = chain.map(m => m.content).join('\n');
      const summary = await llm.complete(
        `Summarize this sequence of events as a brief narrative. Preserve cause and effect. Keep names and specifics.`,
        chainTexts,
      );

      // Preserve peak emotional valence from source memories
      const peakValence = chain.reduce(
        (max, m) => Math.abs(m.emotionalValence ?? 0) > Math.abs(max)
          ? (m.emotionalValence ?? 0) : max,
        0,
      );

      this.addSemantic({
        id: crypto.randomUUID(),
        agentId: this.agentId,
        type: 'reflection',
        content: summary,
        importance: 6,
        timestamp: Date.now(),
        relatedAgentIds: [...new Set(chain.flatMap(m => m.relatedAgentIds))],
        emotionalValence: peakValence,
      });

      // Remove originals from episodic
      await this.backingStore.removeBatch(chain.map(m => m.id));
    }
  }

  private buildCausalChains(memories: Memory[]): Memory[][] {
    const byId = new Map(memories.map(m => [m.id, m]));
    const visited = new Set<string>();
    const chains: Memory[][] = [];

    for (const m of memories) {
      if (visited.has(m.id)) continue;
      const chain: Memory[] = [];
      let current: Memory | undefined = m;
      while (current && !visited.has(current.id)) {
        visited.add(current.id);
        chain.push(current);
        current = current.ledTo?.length
          ? byId.get(current.ledTo[0])
          : undefined;
      }
      if (chain.length >= 2) chains.push(chain);
    }

    // Remaining unclaimed memories get grouped by type (fallback)
    const unclaimed = memories.filter(m => !visited.has(m.id));
    const byType = new Map<string, Memory[]>();
    for (const m of unclaimed) {
      visited.add(m.id);
      if (!byType.has(m.type)) byType.set(m.type, []);
      byType.get(m.type)!.push(m);
    }
    for (const group of byType.values()) {
      if (group.length >= 3) chains.push(group);
    }

    return chains;
  }

  /** Expose backing store for code that still needs direct access */
  get store(): MemoryStore {
    return this.backingStore;
  }

  /** Expose identity for serialization */
  get identityMemories(): Memory[] {
    return this.identity;
  }

  /** Expose semantic for serialization */
  get semanticMemories(): Memory[] {
    return this.semantic;
  }
}
