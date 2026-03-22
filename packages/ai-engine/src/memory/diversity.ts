import type { Memory } from '@ai-village/shared';
import { TFIDFEmbedder } from './embeddings.js';

export interface ScoredMemory {
  memory: Memory;
  score: number;
}

/**
 * Diversify retrieval results by capping topically similar memories.
 * Greedy single-pass clustering: assign each candidate to the first cluster
 * whose representative has cosine similarity > 0.45. Cap at 3 per cluster.
 * Fill remaining slots from skipped candidates.
 */
export function diversifyResults(
  candidates: ScoredMemory[],
  limit: number,
  embedder: TFIDFEmbedder,
): ScoredMemory[] {
  if (candidates.length <= limit) return candidates;

  // Compute embeddings for all candidates
  const embeddings = candidates.map(c => embedder.embed(c.memory.content));

  // Clusters: each is [representative embedding index, member indices]
  const clusters: { repIdx: number; members: number[] }[] = [];
  const selected: ScoredMemory[] = [];
  const skipped: ScoredMemory[] = [];

  const SIMILARITY_THRESHOLD = 0.45;
  const MAX_PER_CLUSTER = 3;

  for (let i = 0; i < candidates.length; i++) {
    if (selected.length >= limit) {
      break;
    }

    const emb = embeddings[i];
    let assignedCluster: typeof clusters[number] | null = null;

    // Find first cluster this candidate belongs to
    for (const cluster of clusters) {
      const repEmb = embeddings[cluster.repIdx];
      if (emb.length > 0 && repEmb.length > 0) {
        const sim = TFIDFEmbedder.cosineSimilarity(emb, repEmb);
        if (sim > SIMILARITY_THRESHOLD) {
          assignedCluster = cluster;
          break;
        }
      }
    }

    if (assignedCluster) {
      if (assignedCluster.members.length < MAX_PER_CLUSTER) {
        assignedCluster.members.push(i);
        selected.push(candidates[i]);
      } else {
        skipped.push(candidates[i]);
      }
    } else {
      // New cluster
      clusters.push({ repIdx: i, members: [i] });
      selected.push(candidates[i]);
    }
  }

  // Fill remaining slots from skipped candidates (in score order — they're already sorted)
  for (const candidate of skipped) {
    if (selected.length >= limit) break;
    selected.push(candidate);
  }

  return selected;
}
