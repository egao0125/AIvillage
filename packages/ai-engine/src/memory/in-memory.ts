import type { Memory } from '@ai-village/shared';
import { TFIDFEmbedder } from './embeddings.js';

interface MemoryStore {
  add(memory: Memory): Promise<void>;
  retrieve(agentId: string, query: string, limit?: number): Promise<Memory[]>;
  getRecent(agentId: string, limit?: number): Promise<Memory[]>;
  getByImportance(agentId: string, minImportance: number): Promise<Memory[]>;
  getOlderThan(agentId: string, timestamp: number): Promise<Memory[]>;
  removeBatch(ids: string[]): Promise<void>;
}

export class InMemoryStore implements MemoryStore {
  private memories: Map<string, Memory[]> = new Map();
  private embedders: Map<string, TFIDFEmbedder> = new Map();

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

  async add(memory: Memory): Promise<void> {
    this.getAgentMemories(memory.agentId).push(memory);

    // Build embedding
    const embedder = this.getEmbedder(memory.agentId);
    embedder.addDocument(memory.content);
    memory.embedding = embedder.embed(memory.content);
  }

  async retrieve(agentId: string, query: string, limit = 10): Promise<Memory[]> {
    const memories = this.getAgentMemories(agentId);
    if (memories.length === 0) return [];

    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    const now = Date.now();

    // Compute query embedding for semantic matching
    const embedder = this.getEmbedder(agentId);
    const queryEmbedding = embedder.embed(query);

    const scored = memories.map(memory => {
      // Keyword matching score (0-1)
      const contentLower = memory.content.toLowerCase();
      const matchCount = queryWords.filter(word => contentLower.includes(word)).length;
      const keywordScore = queryWords.length > 0 ? matchCount / queryWords.length : 0;

      // Semantic similarity score (0-1)
      let semanticScore = 0;
      if (memory.embedding && memory.embedding.length > 0 && queryEmbedding.length > 0) {
        semanticScore = Math.max(0, TFIDFEmbedder.cosineSimilarity(queryEmbedding, memory.embedding));
      }

      // Recency score (0-1) — exponential decay, half-life of 24 hours
      const ageMs = now - memory.timestamp;
      const halfLifeMs = 24 * 60 * 60 * 1000; // 24 hours
      const recencyScore = Math.exp(-ageMs / halfLifeMs);

      // Importance score (0-1) — normalize from 1-10 to 0-1
      const importanceScore = (memory.importance - 1) / 9;

      // Combined score — importance-weighted so significant memories surface over noise
      const hasEmbedding = memory.embedding && memory.embedding.length > 0;
      const score = hasEmbedding
        ? 0.15 * keywordScore + 0.30 * semanticScore + 0.20 * recencyScore + 0.35 * importanceScore
        : 0.25 * keywordScore + 0.25 * recencyScore + 0.50 * importanceScore;

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
}

export default InMemoryStore;
