import type { Memory } from '@ai-village/shared';

interface MemoryStore {
  add(memory: Memory): Promise<void>;
  retrieve(agentId: string, query: string, limit?: number): Promise<Memory[]>;
  getRecent(agentId: string, limit?: number): Promise<Memory[]>;
  getByImportance(agentId: string, minImportance: number): Promise<Memory[]>;
}

export class InMemoryStore implements MemoryStore {
  private memories: Map<string, Memory[]> = new Map();

  private getAgentMemories(agentId: string): Memory[] {
    if (!this.memories.has(agentId)) {
      this.memories.set(agentId, []);
    }
    return this.memories.get(agentId)!;
  }

  async add(memory: Memory): Promise<void> {
    this.getAgentMemories(memory.agentId).push(memory);
  }

  async retrieve(agentId: string, query: string, limit = 10): Promise<Memory[]> {
    const memories = this.getAgentMemories(agentId);
    if (memories.length === 0) return [];

    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    const now = Date.now();

    const scored = memories.map(memory => {
      // Keyword matching score (0-1)
      const contentLower = memory.content.toLowerCase();
      const matchCount = queryWords.filter(word => contentLower.includes(word)).length;
      const keywordScore = queryWords.length > 0 ? matchCount / queryWords.length : 0;

      // Recency score (0-1) — exponential decay, half-life of 1 hour
      const ageMs = now - memory.timestamp;
      const halfLifeMs = 60 * 60 * 1000; // 1 hour
      const recencyScore = Math.exp(-ageMs / halfLifeMs);

      // Importance score (0-1) — normalize from 1-10 to 0-1
      const importanceScore = (memory.importance - 1) / 9;

      // Combined score
      const score = 0.4 * keywordScore + 0.3 * recencyScore + 0.3 * importanceScore;

      return { memory, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(s => s.memory);
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
}

export default InMemoryStore;
