import type { Memory } from '@ai-village/shared';
import { TFIDFEmbedder } from './embeddings.js';
import type { EmbeddingProvider } from './embeddings.js';
import { diversifyResults } from './diversity.js';

// Re-declared locally to match MemoryStore contract in index.ts.
// The retrieve() signature takes an optional RetrievalContext (see below).
interface MemoryStore {
  add(memory: Memory): Promise<void>;
  retrieve(agentId: string, query: string, limit?: number, context?: RetrievalContext): Promise<Memory[]>;
  getRecent(agentId: string, limit?: number): Promise<Memory[]>;
  getByImportance(agentId: string, minImportance: number): Promise<Memory[]>;
  getOlderThan(agentId: string, timestamp: number): Promise<Memory[]>;
  removeBatch(ids: string[]): Promise<void>;
  getById(agentId: string, memoryId: string): Promise<Memory | undefined>;
}

/**
 * HyDE (Hypothetical Document Embeddings) provider interface.
 * When set on InMemoryStore, retrieve() generates a hypothetical answer
 * to expand the query before TF-IDF matching. This closes the semantic gap
 * without neural embeddings — a "free" 26%+ improvement per research benchmarks.
 */
export interface HyDEProvider {
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
}

/**
 * Adaptive retrieval weight profile (gap-analysis item 2B).
 * Different cognition contexts benefit from different scoring emphases:
 *   plan — importance-heavy: "what matters most for my next move?"
 *   conversation — recency-heavy: "what just happened with this person?"
 *   reflect — semantic-heavy: "what thematic patterns relate to X?"
 *   balanced — the previous fixed default
 * Weights should sum to ~1.0 (coreBonus of 0.2 is added on top independently).
 */
export interface RetrievalWeights {
  keyword: number;
  semantic: number;
  recency: number;
  importance: number;
}

export type RetrievalContext = 'plan' | 'conversation' | 'reflect' | 'balanced';

export const RETRIEVAL_PROFILES: Record<RetrievalContext, RetrievalWeights> = {
  plan:         { keyword: 0.10, semantic: 0.20, recency: 0.15, importance: 0.55 },
  conversation: { keyword: 0.15, semantic: 0.25, recency: 0.45, importance: 0.15 },
  reflect:      { keyword: 0.10, semantic: 0.50, recency: 0.15, importance: 0.25 },
  balanced:     { keyword: 0.15, semantic: 0.30, recency: 0.20, importance: 0.35 },
};

export class InMemoryStore implements MemoryStore {
  // Hard cap per agent: prevents OOM in long-running simulations.
  // Evicts lowest-importance oldest memories when exceeded.
  private static readonly MAX_MEMORIES_PER_AGENT = 5_000;

  private memories: Map<string, Memory[]> = new Map();
  private embedders: Map<string, TFIDFEmbedder> = new Map();

  /** Optional HyDE provider — when set, retrieve() expands queries with hypothetical answers */
  public hydeProvider?: HyDEProvider;
  /** Optional neural embedding provider (OpenAI text-embedding-3-small etc.) */
  public embeddingProvider?: EmbeddingProvider;
  /** Cache HyDE expansions to avoid redundant LLM calls for the same query */
  private hydeCache: Map<string, { expanded: string; timestamp: number }> = new Map();
  /** Cache neural query embeddings to avoid redundant API calls */
  private neuralQueryCache: Map<string, { vec: number[]; ts: number }> = new Map();
  /** Log once flags — avoid spamming embedding success/failure per memory */
  private _loggedEmbedSuccess = false;
  private _loggedEmbedFailure = false;
  private static readonly HYDE_CACHE_TTL = 300_000; // 5 minutes

  private getAgentMemories(agentId: string): Memory[] {
    if (!this.memories.has(agentId)) {
      this.memories.set(agentId, []);
    }
    return this.memories.get(agentId)!;
  }

  private getEmbedder(agentId: string): TFIDFEmbedder {
    if (!this.embedders.has(agentId)) {
      this.embedders.set(agentId, new TFIDFEmbedder());
    }
    return this.embedders.get(agentId)!;
  }

  async clearByAgent(agentId: string): Promise<void> {
    this.memories.delete(agentId);
    this.embedders.delete(agentId);
  }

  async add(memory: Memory): Promise<void> {
    // Clamp importance to [1,10] to prevent NaN/-Inf in scoring formula (line ~71)
    memory.importance = Math.max(1, Math.min(10, Number(memory.importance) || 5));
    const agentMems = this.getAgentMemories(memory.agentId);
    agentMems.push(memory);

    // Evict excess memories when the per-agent cap is exceeded.
    // Removes the lowest-importance oldest entries first to retain the most
    // significant memories (CWE-400: unbounded memory growth prevention).
    if (agentMems.length > InMemoryStore.MAX_MEMORIES_PER_AGENT) {
      agentMems.sort((a, b) => {
        const imp = a.importance - b.importance;
        return imp !== 0 ? imp : a.timestamp - b.timestamp;
      });
      agentMems.splice(0, agentMems.length - InMemoryStore.MAX_MEMORIES_PER_AGENT);
    }

    // Build TF-IDF embedding (synchronous, always available)
    const embedder = this.getEmbedder(memory.agentId);
    embedder.addDocument(memory.content);
    memory.embedding = embedder.embed(memory.content);

    // Neural embedding — fire-and-forget. TF-IDF is the floor.
    if (this.embeddingProvider && !memory.neuralEmbedding) {
      this.embeddingProvider.embed(memory.content).then(vec => {
        memory.neuralEmbedding = vec;
        if (!this._loggedEmbedSuccess) {
          console.log(`[Embedding] Neural embedding OK (${vec.length}d) for agent ${memory.agentId}`);
          this._loggedEmbedSuccess = true;
        }
      }).catch((err: unknown) => {
        if (!this._loggedEmbedFailure) {
          console.warn(`[Embedding] Neural embedding failed for agent ${memory.agentId}:`, (err as Error).message);
          this._loggedEmbedFailure = true;
        }
      });
    }
  }

  /**
   * HyDE: expand a short query into a hypothetical answer document.
   * The expanded text shares vocabulary with actual memories, improving TF-IDF recall.
   */
  private async hydeExpand(query: string): Promise<string> {
    if (!this.hydeProvider) return query;

    // Check cache first
    const cacheKey = query.toLowerCase().trim();
    const cached = this.hydeCache.get(cacheKey);
    const now = Date.now();
    if (cached && (now - cached.timestamp) < InMemoryStore.HYDE_CACHE_TTL) {
      return cached.expanded;
    }

    try {
      const hypothetical = await this.hydeProvider.complete(
        'You are a memory recall assistant. Given a query, write a short (2-3 sentence) hypothetical memory entry that would answer it. Use specific details, names, and actions. Do not include meta-commentary.',
        `Query: "${query}"\n\nHypothetical memory:`,
      );
      // Combine original query with hypothetical for broader matching
      const expanded = `${query} ${hypothetical.trim()}`;
      this.hydeCache.set(cacheKey, { expanded, timestamp: now });

      // Prune old cache entries
      if (this.hydeCache.size > 100) {
        for (const [k, v] of this.hydeCache) {
          if (now - v.timestamp > InMemoryStore.HYDE_CACHE_TTL) this.hydeCache.delete(k);
        }
      }
      return expanded;
    } catch {
      return query; // Fall back to original query on failure
    }
  }

  async retrieve(
    agentId: string,
    query: string,
    limit = 10,
    context: RetrievalContext = 'balanced',
  ): Promise<Memory[]> {
    const memories = this.getAgentMemories(agentId);
    if (memories.length === 0) return [];

    // HyDE expansion: generate hypothetical answer to improve semantic matching
    const expandedQuery = await this.hydeExpand(query);

    const queryWords = expandedQuery.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    const now = Date.now();

    // Compute query embedding for semantic matching (using expanded query)
    const embedder = this.getEmbedder(agentId);
    const queryEmbedding = embedder.embed(expandedQuery);

    // Neural query embedding — one API call per retrieval, cached 5 min.
    let queryNeural: number[] | null = null;
    if (this.embeddingProvider) {
      const cacheKey = expandedQuery.toLowerCase().trim();
      const cached = this.neuralQueryCache.get(cacheKey);
      if (cached && (now - cached.ts) < InMemoryStore.HYDE_CACHE_TTL) {
        queryNeural = cached.vec;
      } else {
        try {
          queryNeural = await this.embeddingProvider.embed(expandedQuery);
          this.neuralQueryCache.set(cacheKey, { vec: queryNeural, ts: now });
          // Prune stale entries
          if (this.neuralQueryCache.size > 200) {
            for (const [k, v] of this.neuralQueryCache) {
              if (now - v.ts > InMemoryStore.HYDE_CACHE_TTL) this.neuralQueryCache.delete(k);
            }
          }
        } catch { /* TF-IDF fallback */ }
      }
    }

    // Select weight profile for this retrieval context (gap-analysis item 2B)
    const w = RETRIEVAL_PROFILES[context];

    const scored = memories.map(memory => {
      // Keyword matching score (0-1)
      const contentLower = memory.content.toLowerCase();
      const matchCount = queryWords.filter(word => contentLower.includes(word)).length;
      const keywordScore = queryWords.length > 0 ? matchCount / queryWords.length : 0;

      // Semantic similarity score (0-1) — hybrid: 0.6 × neural + 0.4 × TF-IDF when both available
      let semanticScore = 0;
      const hasTfidf = memory.embedding && memory.embedding.length > 0 && queryEmbedding.length > 0;
      const hasNeural = queryNeural && memory.neuralEmbedding && memory.neuralEmbedding.length > 0;
      if (hasTfidf && hasNeural) {
        const tfidfSim = Math.max(0, TFIDFEmbedder.cosineSimilarity(queryEmbedding, memory.embedding!));
        const neuralSim = Math.max(0, TFIDFEmbedder.cosineSimilarity(queryNeural!, memory.neuralEmbedding!));
        semanticScore = 0.6 * neuralSim + 0.4 * tfidfSim;
      } else if (hasTfidf) {
        semanticScore = Math.max(0, TFIDFEmbedder.cosineSimilarity(queryEmbedding, memory.embedding!));
      }

      // Recency score (0-1) — exponential decay, half-life of 24 hours
      const ageMs = now - memory.timestamp;
      const halfLifeMs = 24 * 60 * 60 * 1000; // 24 hours
      const recencyScore = Math.exp(-ageMs / halfLifeMs);

      // Importance score (0-1) — normalize from 1-10 to 0-1
      const importanceScore = (memory.importance - 1) / 9;

      // Combined score using profile weights. Without any embedding, re-distribute the
      // semantic weight proportionally to keyword + recency + importance.
      const hasAnyEmbedding = hasTfidf || hasNeural;
      let baseScore: number;
      if (hasAnyEmbedding) {
        baseScore = w.keyword * keywordScore
          + w.semantic * semanticScore
          + w.recency * recencyScore
          + w.importance * importanceScore;
      } else {
        const total = w.keyword + w.recency + w.importance;
        const scale = total > 0 ? 1 / total : 0;
        baseScore = (w.keyword * scale) * keywordScore
          + (w.recency * scale) * recencyScore
          + (w.importance * scale) * importanceScore;
      }

      // Core identity memories get a retrieval boost
      const coreBonus = memory.isCore ? 0.2 : 0;
      const score = baseScore + coreBonus;

      return { memory, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const candidates = scored.slice(0, limit * 3);
    const diverse = diversifyResults(candidates, limit, embedder);
    return diverse.map(s => s.memory);
  }

  async getRecent(agentId: string, limit = 20): Promise<Memory[]> {
    const memories = this.getAgentMemories(agentId);
    return [...memories]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  async getByImportance(agentId: string, minImportance: number): Promise<Memory[]> {
    const memories = this.getAgentMemories(agentId);
    return memories
      .filter(m => m.importance >= minImportance)
      .sort((a, b) => b.importance - a.importance);
  }

  async getOlderThan(agentId: string, timestamp: number): Promise<Memory[]> {
    const memories = this.getAgentMemories(agentId);
    return memories.filter(m => m.timestamp < timestamp);
  }

  async removeBatch(ids: string[]): Promise<void> {
    const idSet = new Set(ids);
    for (const [agentId, memories] of this.memories) {
      this.memories.set(agentId, memories.filter(m => !idSet.has(m.id)));
    }
  }

  async getById(agentId: string, memoryId: string): Promise<Memory | undefined> {
    const memories = this.getAgentMemories(agentId);
    return memories.find(m => m.id === memoryId);
  }

  /** Wipe all in-memory state (memories, embedders, caches). Used by freshStart(). */
  clearAll(): void {
    this.memories.clear();
    this.embedders.clear();
    this.hydeCache.clear();
    this.neuralQueryCache.clear();
    this._loggedEmbedSuccess = false;
    this._loggedEmbedFailure = false;
  }
}

export default InMemoryStore;
