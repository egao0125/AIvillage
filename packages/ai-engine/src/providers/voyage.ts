import type { EmbeddingProvider } from '../memory/embeddings.js';

/**
 * Voyage AI Embedding Provider — uses voyage-4-large by default.
 * RTEB #1 for retrieval tasks. $0.12/1M tokens. MRL dims: 256-2048.
 * Uses native fetch — no npm dependency needed.
 */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  dimensions: number;
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model = 'voyage-4-large', dims = 1024) {
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dims;
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: text.slice(0, 32000), // voyage-4-large supports 32K tokens
        input_type: 'document',
        output_dimension: this.dimensions,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Voyage embed failed (${response.status}): ${body.slice(0, 200)}`);
    }

    const json = await response.json() as { data: { embedding: number[] }[] };
    return json.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    // Voyage supports up to 128 inputs per batch
    const truncated = texts.map(t => t.slice(0, 32000));
    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: truncated,
        input_type: 'document',
        output_dimension: this.dimensions,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Voyage embedBatch failed (${response.status}): ${body.slice(0, 200)}`);
    }

    const json = await response.json() as { data: { index: number; embedding: number[] }[] };
    return json.data
      .sort((a, b) => a.index - b.index)
      .map(d => d.embedding);
  }
}
