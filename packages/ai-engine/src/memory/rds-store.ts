import type pg from 'pg';
import type { Memory } from '@ai-village/shared';
import { TFIDFEmbedder } from './embeddings.js';
import type { EmbeddingProvider } from './embeddings.js';
import { diversifyResults } from './diversity.js';
import type { HyDEProvider, RetrievalContext } from './in-memory.js';
import { RETRIEVAL_PROFILES } from './in-memory.js';

type Pool = pg.Pool;

interface MemoryStore {
  add(memory: Memory): Promise<void>;
  retrieve(agentId: string, query: string, limit?: number, context?: RetrievalContext): Promise<Memory[]>;
  getRecent(agentId: string, limit?: number): Promise<Memory[]>;
  getByImportance(agentId: string, minImportance: number): Promise<Memory[]>;
  getOlderThan(agentId: string, timestamp: number): Promise<Memory[]>;
  removeBatch(ids: string[]): Promise<void>;
  getById(agentId: string, memoryId: string): Promise<Memory | undefined>;
}

export class RdsMemoryStore implements MemoryStore {
  private embedders: Map<string, TFIDFEmbedder> = new Map();
  private bootstrapped: Set<string> = new Set();

  /** Optional HyDE provider — expands queries with hypothetical answers (item 2A) */
  public hydeProvider?: HyDEProvider;
  /** Optional neural embedding provider (OpenAI text-embedding-3-small etc.) */
  public embeddingProvider?: EmbeddingProvider;
  private hydeCache: Map<string, { expanded: string; timestamp: number }> = new Map();
  private neuralQueryCache: Map<string, { vec: number[]; ts: number }> = new Map();
  private static readonly HYDE_CACHE_TTL = 300_000; // 5 minutes
  /** Log once flags — avoid spamming embedding success/failure per memory */
  private _loggedEmbedSuccess = false;
  private _loggedEmbedFailure = false;

  constructor(private pool: Pool) {}

  /**
   * HyDE: expand query with a hypothetical memory answer for better TF-IDF recall.
   * Mirrors InMemoryStore.hydeExpand — see that implementation for design rationale.
   */
  private async hydeExpand(query: string): Promise<string> {
    if (!this.hydeProvider) return query;
    const cacheKey = query.toLowerCase().trim();
    const cached = this.hydeCache.get(cacheKey);
    const now = Date.now();
    if (cached && (now - cached.timestamp) < RdsMemoryStore.HYDE_CACHE_TTL) {
      return cached.expanded;
    }
    try {
      const hypothetical = await this.hydeProvider.complete(
        'You are a memory recall assistant. Given a query, write a short (2-3 sentence) hypothetical memory entry that would answer it. Use specific details, names, and actions. Do not include meta-commentary.',
        `Query: "${query}"\n\nHypothetical memory:`,
      );
      const expanded = `${query} ${hypothetical.trim()}`;
      this.hydeCache.set(cacheKey, { expanded, timestamp: now });
      if (this.hydeCache.size > 100) {
        for (const [k, v] of this.hydeCache) {
          if (now - v.timestamp > RdsMemoryStore.HYDE_CACHE_TTL) this.hydeCache.delete(k);
        }
      }
      return expanded;
    } catch {
      return query;
    }
  }

  private getEmbedder(agentId: string): TFIDFEmbedder {
    if (!this.embedders.has(agentId)) {
      this.embedders.set(agentId, new TFIDFEmbedder());
    }
    return this.embedders.get(agentId)!;
  }

  /**
   * Bootstrap the embedder for an agent by loading existing memories to build vocabulary.
   * Only runs once per agent per server lifetime.
   */
  private async bootstrapEmbedder(agentId: string): Promise<TFIDFEmbedder> {
    const embedder = this.getEmbedder(agentId);
    if (this.bootstrapped.has(agentId)) return embedder;

    const result = await this.pool.query<{ content: string }>(
      `SELECT content FROM memories WHERE agent_id = $1 ORDER BY timestamp DESC LIMIT 200`,
      [agentId],
    );

    for (const row of result.rows) {
      embedder.addDocument(row.content);
    }
    this.bootstrapped.add(agentId);
    return embedder;
  }

  async add(memory: Memory): Promise<void> {
    // Build TF-IDF embedding (not persisted — recomputed on load)
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

    try {
      await this.pool.query(
        `INSERT INTO memories (id, agent_id, type, content, importance, timestamp, related_agent_ids, visibility, emotional_valence, caused_by, led_to)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO UPDATE SET
           content = EXCLUDED.content,
           importance = EXCLUDED.importance,
           timestamp = EXCLUDED.timestamp,
           related_agent_ids = EXCLUDED.related_agent_ids,
           visibility = EXCLUDED.visibility,
           emotional_valence = EXCLUDED.emotional_valence,
           caused_by = EXCLUDED.caused_by,
           led_to = EXCLUDED.led_to`,
        [
          memory.id,
          memory.agentId,
          memory.type,
          memory.content,
          memory.importance,
          memory.timestamp,
          memory.relatedAgentIds ?? [],
          memory.visibility ?? 'private',
          memory.emotionalValence ?? 0,
          memory.causedBy ?? null,
          memory.ledTo ?? null,
        ],
      );
    } catch (err) {
      console.error('[RdsMemoryStore] add() failed:', (err as Error).message);
      // Don't throw — memory failure shouldn't crash the simulation
    }
  }

  async retrieve(
    agentId: string,
    query: string,
    limit = 10,
    context: RetrievalContext = 'balanced',
  ): Promise<Memory[]> {
    // Cap fetchLimit to prevent runaway queries on large memory tables (OOM / pool exhaustion).
    // limit*5 gives enough candidates for TF-IDF re-ranking; 1000 is a hard safety ceiling.
    const fetchLimit = Math.min(limit * 5, 1_000);
    let result: { rows: Record<string, unknown>[] };
    try {
      result = await this.pool.query<Record<string, unknown>>(
        `SELECT * FROM memories WHERE agent_id = $1 ORDER BY timestamp DESC LIMIT $2`,
        [agentId, fetchLimit],
      );
    } catch (err) {
      console.error('[RdsMemoryStore] retrieve() failed:', (err as Error).message);
      return [];
    }

    if (result.rows.length === 0) return [];

    // HyDE expansion: generate hypothetical answer to improve semantic matching (item 2A)
    const expandedQuery = await this.hydeExpand(query);

    // Bootstrap embedder lazily
    const embedder = await this.bootstrapEmbedder(agentId);
    const queryEmbedding = embedder.embed(expandedQuery);

    const queryWords = expandedQuery.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    const now = Date.now();

    // Neural query embedding — one API call per retrieval, cached 5 min.
    let queryNeural: number[] | null = null;
    if (this.embeddingProvider) {
      const cacheKey = expandedQuery.toLowerCase().trim();
      const cached = this.neuralQueryCache.get(cacheKey);
      if (cached && (now - cached.ts) < RdsMemoryStore.HYDE_CACHE_TTL) {
        queryNeural = cached.vec;
      } else {
        try {
          queryNeural = await this.embeddingProvider.embed(expandedQuery);
          this.neuralQueryCache.set(cacheKey, { vec: queryNeural, ts: now });
          if (this.neuralQueryCache.size > 200) {
            for (const [k, v] of this.neuralQueryCache) {
              if (now - v.ts > RdsMemoryStore.HYDE_CACHE_TTL) this.neuralQueryCache.delete(k);
            }
          }
        } catch { /* TF-IDF fallback */ }
      }
    }

    const scored = result.rows.map(row => {
      const memory = this.rowToMemory(row);

      // Compute TF-IDF embedding on the fly (not persisted)
      const memEmbedding = embedder.embed(memory.content);

      // Keyword matching score (0-1)
      const contentLower = memory.content.toLowerCase();
      const matchCount = queryWords.filter(word => contentLower.includes(word)).length;
      const keywordScore = queryWords.length > 0 ? matchCount / queryWords.length : 0;

      // Semantic similarity score (0-1) — hybrid: 0.6 × neural + 0.4 × TF-IDF
      let semanticScore = 0;
      const hasTfidf = memEmbedding.length > 0 && queryEmbedding.length > 0;
      const hasNeural = queryNeural && memory.neuralEmbedding && memory.neuralEmbedding.length > 0;
      if (hasTfidf && hasNeural) {
        const tfidfSim = Math.max(0, TFIDFEmbedder.cosineSimilarity(queryEmbedding, memEmbedding));
        const neuralSim = Math.max(0, TFIDFEmbedder.cosineSimilarity(queryNeural!, memory.neuralEmbedding!));
        semanticScore = 0.6 * neuralSim + 0.4 * tfidfSim;
      } else if (hasTfidf) {
        semanticScore = Math.max(0, TFIDFEmbedder.cosineSimilarity(queryEmbedding, memEmbedding));
      }

      // Recency score (0-1) — exponential decay, half-life of 24 hours
      const ageMs = now - memory.timestamp;
      const halfLifeMs = 24 * 60 * 60 * 1000; // 24 hours
      const recencyScore = Math.exp(-ageMs / halfLifeMs);

      // Importance score (0-1) — normalize from 1-10 to 0-1
      const importanceScore = (memory.importance - 1) / 9;

      // Combined score using profile weights (gap-analysis item 2B).
      // Without any embedding, re-distribute the semantic weight across the remaining signals.
      const w = RETRIEVAL_PROFILES[context];
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
    try {
      const result = await this.pool.query<Record<string, unknown>>(
        `SELECT * FROM memories WHERE agent_id = $1 ORDER BY timestamp DESC LIMIT $2`,
        [agentId, limit],
      );
      return result.rows.map(row => this.rowToMemory(row));
    } catch (err) {
      console.error('[RdsMemoryStore] getRecent() failed:', (err as Error).message);
      return [];
    }
  }

  async getByImportance(agentId: string, minImportance: number): Promise<Memory[]> {
    try {
      const result = await this.pool.query<Record<string, unknown>>(
        `SELECT * FROM memories WHERE agent_id = $1 AND importance >= $2 ORDER BY importance DESC`,
        [agentId, minImportance],
      );
      return result.rows.map((row: Record<string, unknown>) => this.rowToMemory(row));
    } catch (err) {
      console.error('[RdsMemoryStore] getByImportance() failed:', (err as Error).message);
      return [];
    }
  }

  async getOlderThan(agentId: string, timestamp: number): Promise<Memory[]> {
    try {
      const result = await this.pool.query<Record<string, unknown>>(
        `SELECT * FROM memories WHERE agent_id = $1 AND timestamp < $2 ORDER BY timestamp DESC`,
        [agentId, timestamp],
      );
      return result.rows.map((row: Record<string, unknown>) => this.rowToMemory(row));
    } catch (err) {
      console.error('[RdsMemoryStore] getOlderThan() failed:', (err as Error).message);
      return [];
    }
  }

  async removeBatch(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await this.pool.query(`DELETE FROM memories WHERE id = ANY($1::uuid[])`, [ids]);
    } catch (err) {
      console.error('[RdsMemoryStore] removeBatch() failed:', (err as Error).message);
    }
  }

  /**
   * Release in-memory state for a removed agent.
   * Call this when an agent is permanently deleted so the TF-IDF embedder
   * and bootstrap flag for that agent are freed from memory.
   */
  cleanup(agentId: string): void {
    this.embedders.delete(agentId);
    this.bootstrapped.delete(agentId);
  }

  /** Wipe all in-memory caches (embedders, HyDE, neural, bootstrap). Used by freshStart(). */
  clearCaches(): void {
    this.embedders.clear();
    this.bootstrapped.clear();
    this.hydeCache.clear();
    this.neuralQueryCache.clear();
    this._loggedEmbedSuccess = false;
    this._loggedEmbedFailure = false;
  }

  async getById(agentId: string, memoryId: string): Promise<Memory | undefined> {
    try {
      const result = await this.pool.query<Record<string, unknown>>(
        `SELECT * FROM memories WHERE id = $1 AND agent_id = $2`,
        [memoryId, agentId],
      );
      if (result.rows.length === 0) return undefined;
      return this.rowToMemory(result.rows[0]);
    } catch (err) {
      console.error('[RdsMemoryStore] getById() failed:', (err as Error).message);
      return undefined;
    }
  }

  private rowToMemory(row: Record<string, unknown>): Memory {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      type: row.type as Memory['type'],
      content: row.content as string,
      importance: row.importance as number,
      timestamp: typeof row.timestamp === 'bigint'
        ? Number(row.timestamp)
        : row.timestamp as number,
      relatedAgentIds: (row.related_agent_ids as string[]) ?? [],
      visibility: (row.visibility as Memory['visibility']) ?? 'private',
      emotionalValence: (row.emotional_valence as number) ?? 0,
      isCore: (row.importance as number) >= 9,
      causedBy: (row.caused_by as string) ?? undefined,
      ledTo: (row.led_to as string[]) ?? undefined,
    };
  }
}
