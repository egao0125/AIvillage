import type { SupabaseClient } from '@supabase/supabase-js';
import type { Memory } from '@ai-village/shared';

interface MemoryStore {
  add(memory: Memory): Promise<void>;
  retrieve(agentId: string, query: string, limit?: number): Promise<Memory[]>;
  getRecent(agentId: string, limit?: number): Promise<Memory[]>;
  getByImportance(agentId: string, minImportance: number): Promise<Memory[]>;
}

export class SupabaseMemoryStore implements MemoryStore {
  constructor(private supabase: SupabaseClient) {}

  async add(memory: Memory): Promise<void> {
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

    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    const now = Date.now();

    const scored = data.map(row => {
      const memory = this.rowToMemory(row);

      // Keyword matching score (0-1)
      const contentLower = memory.content.toLowerCase();
      const matchCount = queryWords.filter(word => contentLower.includes(word)).length;
      const keywordScore = queryWords.length > 0 ? matchCount / queryWords.length : 0;

      // Recency score (0-1) — exponential decay, half-life of 1 hour
      const ageMs = now - memory.timestamp;
      const halfLifeMs = 60 * 60 * 1000;
      const recencyScore = Math.exp(-ageMs / halfLifeMs);

      // Importance score (0-1) — normalize from 1-10 to 0-1
      const importanceScore = (memory.importance - 1) / 9;

      // Combined score (same weights as InMemoryStore)
      const score = 0.4 * keywordScore + 0.3 * recencyScore + 0.3 * importanceScore;

      return { memory, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(s => s.memory);
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
    };
  }
}
