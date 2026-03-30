import type pg from 'pg';
import type { Memory } from '@ai-village/shared';
import { TFIDFEmbedder } from './embeddings.js';
import { diversifyResults } from './diversity.js';

type Pool = pg.Pool;

interface MemoryStore {
  add(memory: Memory): Promise<void>;
  retrieve(agentId: string, query: string, limit?: number): Promise<Memory[]>;
  getRecent(agentId: string, limit?: number): Promise<Memory[]>;
  getByImportance(agentId: string, minImportance: number): Promise<Memory[]>;
  getOlderThan(agentId: string, timestamp: number): Promise<Memory[]>;
  removeBatch(ids: string[]): Promise<void>;
  getById(agentId: string, memoryId: string): Promise<Memory | undefined>;
}

export class RdsMemoryStore implements MemoryStore {
  private embedders: Map<string, TFIDFEmbedder> = new Map();
  private bootstrapped: Set<string> = new Set();

  constructor(private pool: Pool) {}

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
    // Build embedding (not persisted — recomputed on load)
    const embedder = this.getEmbedder(memory.agentId);
    embedder.addDocument(memory.content);
    memory.embedding = embedder.embed(memory.content);

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
      console.error('[RdsMemoryStore] add() failed:', err);
      // Don't throw — memory failure shouldn't crash the simulation
    }
  }

  async retrieve(agentId: string, query: string, limit = 10): Promise<Memory[]> {
    const fetchLimit = limit * 5;
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM memories WHERE agent_id = $1 ORDER BY timestamp DESC LIMIT $2`,
      [agentId, fetchLimit],
    );

    if (result.rows.length === 0) return [];

    // Bootstrap embedder lazily
    const embedder = await this.bootstrapEmbedder(agentId);
    const queryEmbedding = embedder.embed(query);

    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    const now = Date.now();

    const scored = result.rows.map(row => {
      const memory = this.rowToMemory(row);

      // Compute embedding on the fly (not persisted)
      const memEmbedding = embedder.embed(memory.content);

      // Keyword matching score (0-1)
      const contentLower = memory.content.toLowerCase();
      const matchCount = queryWords.filter(word => contentLower.includes(word)).length;
      const keywordScore = queryWords.length > 0 ? matchCount / queryWords.length : 0;

      // Semantic similarity score (0-1)
      let semanticScore = 0;
      if (memEmbedding.length > 0 && queryEmbedding.length > 0) {
        semanticScore = Math.max(0, TFIDFEmbedder.cosineSimilarity(queryEmbedding, memEmbedding));
      }

      // Recency score (0-1) — exponential decay, half-life of 24 hours
      const ageMs = now - memory.timestamp;
      const halfLifeMs = 24 * 60 * 60 * 1000; // 24 hours
      const recencyScore = Math.exp(-ageMs / halfLifeMs);

      // Importance score (0-1) — normalize from 1-10 to 0-1
      const importanceScore = (memory.importance - 1) / 9;

      // Combined score — importance-weighted so significant memories surface over noise
      const baseScore = queryEmbedding.length > 0
        ? 0.15 * keywordScore + 0.30 * semanticScore + 0.20 * recencyScore + 0.35 * importanceScore
        : 0.25 * keywordScore + 0.25 * recencyScore + 0.50 * importanceScore;

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
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM memories WHERE agent_id = $1 ORDER BY timestamp DESC LIMIT $2`,
      [agentId, limit],
    );
    return result.rows.map(row => this.rowToMemory(row));
  }

  async getByImportance(agentId: string, minImportance: number): Promise<Memory[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM memories WHERE agent_id = $1 AND importance >= $2 ORDER BY importance DESC`,
      [agentId, minImportance],
    );
    return result.rows.map(row => this.rowToMemory(row));
  }

  async getOlderThan(agentId: string, timestamp: number): Promise<Memory[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM memories WHERE agent_id = $1 AND timestamp < $2 ORDER BY timestamp DESC`,
      [agentId, timestamp],
    );
    return result.rows.map(row => this.rowToMemory(row));
  }

  async removeBatch(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await this.pool.query(`DELETE FROM memories WHERE id = ANY($1::uuid[])`, [ids]);
    } catch (err) {
      console.error('[RdsMemoryStore] removeBatch() failed:', err);
    }
  }

  async getById(agentId: string, memoryId: string): Promise<Memory | undefined> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM memories WHERE id = $1 AND agent_id = $2`,
      [memoryId, agentId],
    );
    if (result.rows.length === 0) return undefined;
    return this.rowToMemory(result.rows[0]);
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
