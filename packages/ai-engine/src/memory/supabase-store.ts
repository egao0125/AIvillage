import type { SupabaseClient } from '@supabase/supabase-js';
import type { Memory } from '@ai-village/shared';
import { TFIDFEmbedder } from './embeddings.js';
import { diversifyResults } from './diversity.js';

interface MemoryStore {
  add(memory: Memory): Promise<void>;
  retrieve(agentId: string, query: string, limit?: number): Promise<Memory[]>;
  getRecent(agentId: string, limit?: number): Promise<Memory[]>;
  getByImportance(agentId: string, minImportance: number): Promise<Memory[]>;
  getOlderThan(agentId: string, timestamp: number): Promise<Memory[]>;
  removeBatch(ids: string[]): Promise<void>;
}

export class SupabaseMemoryStore implements MemoryStore {
  private embedders: Map<string, TFIDFEmbedder> = new Map();
  private bootstrapped: Set<string> = new Set();

  constructor(private supabase: SupabaseClient) {}

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

    const { data } = await this.supabase
      .from('memories')
      .select('content')
      .eq('agent_id', agentId)
      .order('timestamp', { ascending: false })
      .limit(200);

    if (data) {
      for (const row of data) {
        embedder.addDocument(row.content as string);
      }
    }
    this.bootstrapped.add(agentId);
    return embedder;
  }

  async add(memory: Memory): Promise<void> {
    // Build embedding (don't persist to Supabase — recomputed on load)
    const embedder = this.getEmbedder(memory.agentId);
    embedder.addDocument(memory.content);
    memory.embedding = embedder.embed(memory.content);

    try {
      await this.supabase.from('memories').upsert({
        id: memory.id,
        agent_id: memory.agentId,
        type: memory.type,
        content: memory.content,
        importance: memory.importance,
        timestamp: memory.timestamp,
        related_agent_ids: memory.relatedAgentIds ?? [],
        visibility: memory.visibility ?? 'private',
        emotional_valence: memory.emotionalValence ?? 0,
        is_core: memory.isCore ?? false,
      });
    } catch (err) {
      console.error('[SupabaseMemoryStore] add() failed:', err);
      // Don't throw — memory failure shouldn't crash the simulation
    }
  }

  async retrieve(agentId: string, query: string, limit = 10): Promise<Memory[]> {
    // Fetch extra candidates to score locally (same strategy as InMemoryStore)
    const fetchLimit = limit * 5;
    const { data, error } = await this.supabase
      .from('memories')
      .select('*')
      .eq('agent_id', agentId)
      .order('timestamp', { ascending: false })
      .limit(fetchLimit);

    if (error || !data || data.length === 0) return [];

    // Bootstrap embedder lazily
    const embedder = await this.bootstrapEmbedder(agentId);
    const queryEmbedding = embedder.embed(query);

    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    const now = Date.now();

    const scored = data.map(row => {
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
    const { data, error } = await this.supabase
      .from('memories')
      .select('*')
      .eq('agent_id', agentId)
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (error || !data) return [];
    return data.map(row => this.rowToMemory(row));
  }

  async getByImportance(agentId: string, minImportance: number): Promise<Memory[]> {
    const { data, error } = await this.supabase
      .from('memories')
      .select('*')
      .eq('agent_id', agentId)
      .gte('importance', minImportance)
      .order('importance', { ascending: false });

    if (error || !data) return [];
    return data.map(row => this.rowToMemory(row));
  }

  async getOlderThan(agentId: string, timestamp: number): Promise<Memory[]> {
    const { data, error } = await this.supabase
      .from('memories')
      .select('*')
      .eq('agent_id', agentId)
      .lt('timestamp', timestamp)
      .order('timestamp', { ascending: false });

    if (error || !data) return [];
    return data.map(row => this.rowToMemory(row));
  }

  async removeBatch(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      // Supabase .in() supports up to ~300 IDs; batch if needed
      const batchSize = 200;
      for (let i = 0; i < ids.length; i += batchSize) {
        const batch = ids.slice(i, i + batchSize);
        await this.supabase.from('memories').delete().in('id', batch);
      }
    } catch (err) {
      console.error('[SupabaseMemoryStore] removeBatch() failed:', err);
    }
  }

  private rowToMemory(row: Record<string, unknown>): Memory {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      type: row.type as Memory['type'],
      content: row.content as string,
      importance: row.importance as number,
      timestamp: row.timestamp as number,
      relatedAgentIds: (row.related_agent_ids as string[]) ?? [],
      visibility: (row.visibility as Memory['visibility']) ?? 'private',
      emotionalValence: (row.emotional_valence as number) ?? 0,
      isCore: (row.is_core as boolean) ?? false,
    };
  }
}
