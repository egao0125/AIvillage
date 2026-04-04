// Embedding system — TF-IDF baseline with pluggable neural embedding support.
// TF-IDF enhanced with bigram support for better phrase matching.
// Optional EmbeddingProvider interface for external embeddings (OpenAI, etc).

/**
 * External embedding provider interface.
 * Implementations call an embedding API and return dense vectors.
 */
export interface EmbeddingProvider {
  /** Generate embedding for a single text. Returns dense vector. */
  embed(text: string): Promise<number[]>;
  /** Generate embeddings for multiple texts (batched for efficiency). */
  embedBatch(texts: string[]): Promise<number[][]>;
  /** Dimensionality of the output vectors */
  dimensions: number;
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
  'where', 'why', 'how', 'all', 'both', 'each', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'not', 'only', 'own', 'same', 'so',
  'than', 'too', 'very', 'just', 'because', 'but', 'and', 'or', 'if',
  'while', 'about', 'up', 'it', 'its', 'he', 'she', 'they', 'them',
  'his', 'her', 'their', 'this', 'that', 'these', 'those', 'what',
  'which', 'who', 'whom', 'my', 'your', 'we', 'me', 'him', 'i',
]);

const MAX_DIMS = 500;

export class TFIDFEmbedder {
  private vocabulary: Map<string, number> = new Map(); // token -> index
  private documentFrequency: Map<string, number> = new Map(); // token -> doc count
  private documentCount: number = 0;

  tokenize(text: string): string[] {
    const unigrams = text
      .toLowerCase()
      .split(/[^a-zA-Z\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]+/)
      .filter(w => w.length >= 2 && !STOPWORDS.has(w));

    // Add bigrams for better phrase matching ("traded wheat" vs just "traded" + "wheat")
    const tokens = [...unigrams];
    for (let i = 0; i < unigrams.length - 1; i++) {
      tokens.push(`${unigrams[i]}_${unigrams[i + 1]}`);
    }
    return tokens;
  }

  addDocument(text: string): void {
    this.documentCount++;
    const tokens = this.tokenize(text);
    const uniqueTokens = new Set(tokens);

    for (const token of uniqueTokens) {
      this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1);

      if (!this.vocabulary.has(token) && this.vocabulary.size < MAX_DIMS) {
        this.vocabulary.set(token, this.vocabulary.size);
      }
    }
  }

  embed(text: string): number[] {
    const tokens = this.tokenize(text);
    if (tokens.length === 0 || this.vocabulary.size === 0) return [];

    // Compute term frequency
    const tf: Map<string, number> = new Map();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }

    // Build TF-IDF vector
    const vector = new Array(this.vocabulary.size).fill(0);
    for (const [token, count] of tf) {
      const idx = this.vocabulary.get(token);
      if (idx === undefined) continue;

      const termFreq = count / tokens.length;
      const docFreq = this.documentFrequency.get(token) ?? 0;
      const idf = docFreq > 0
        ? Math.log((this.documentCount + 1) / (docFreq + 1)) + 1
        : 1;

      vector[idx] = termFreq * idf;
    }

    // L2 normalize
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] /= norm;
      }
    }

    return vector;
  }

  static cosineSimilarity(a: number[], b: number[]): number {
    if (a.length === 0 || b.length === 0) return 0;
    const len = Math.min(a.length, b.length);
    let dot = 0;
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
    }
    // Vectors are already L2-normalized, so dot product = cosine similarity
    return dot;
  }
}

/**
 * HybridEmbedder — uses neural embeddings when an EmbeddingProvider is available,
 * falls back to TF-IDF otherwise. Combines both signals when both are present.
 *
 * Neural embeddings capture semantic meaning ("starving" ≈ "hungry"),
 * while TF-IDF captures exact term matches. The hybrid approach gets the best of both.
 */
export class HybridEmbedder {
  private tfidf: TFIDFEmbedder = new TFIDFEmbedder();
  private neuralCache: Map<string, number[]> = new Map();
  private static readonly CACHE_MAX = 2_000;

  constructor(private provider?: EmbeddingProvider) {}

  /** Set or replace the neural embedding provider */
  setProvider(provider: EmbeddingProvider): void {
    this.provider = provider;
  }

  get hasNeuralProvider(): boolean {
    return !!this.provider;
  }

  addDocument(text: string): void {
    this.tfidf.addDocument(text);
  }

  /** Get TF-IDF embedding (synchronous, always available) */
  embedLocal(text: string): number[] {
    return this.tfidf.embed(text);
  }

  /** Get neural embedding (async, may return null if no provider) */
  async embedNeural(text: string): Promise<number[] | null> {
    if (!this.provider) return null;

    const cached = this.neuralCache.get(text);
    if (cached) return cached;

    try {
      const embedding = await this.provider.embed(text);
      this.neuralCache.set(text, embedding);
      // Prune cache if too large
      if (this.neuralCache.size > HybridEmbedder.CACHE_MAX) {
        const keys = this.neuralCache.keys();
        for (let i = 0; i < 500; i++) {
          const key = keys.next().value;
          if (key !== undefined) this.neuralCache.delete(key);
        }
      }
      return embedding;
    } catch {
      return null;
    }
  }

  /**
   * Compute hybrid similarity between two texts.
   * When neural embeddings are available: 0.6 * neural + 0.4 * tfidf
   * When only TF-IDF: 1.0 * tfidf
   */
  computeSimilarity(
    queryTfidf: number[],
    memoryTfidf: number[],
    queryNeural?: number[] | null,
    memoryNeural?: number[] | null,
  ): number {
    const tfidfScore = TFIDFEmbedder.cosineSimilarity(queryTfidf, memoryTfidf);

    if (queryNeural && memoryNeural && queryNeural.length > 0 && memoryNeural.length > 0) {
      const neuralScore = TFIDFEmbedder.cosineSimilarity(queryNeural, memoryNeural);
      // Neural embeddings get more weight when available — they capture semantics
      return 0.6 * neuralScore + 0.4 * tfidfScore;
    }

    return tfidfScore;
  }

  /** Expose tokenizer for diversity checks */
  tokenize(text: string): string[] {
    return this.tfidf.tokenize(text);
  }
}
