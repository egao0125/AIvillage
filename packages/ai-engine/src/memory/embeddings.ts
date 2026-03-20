// TF-IDF Embeddings — zero-cost local embeddings for semantic memory retrieval.
// Upgradeable to real embeddings (OpenAI, Cohere) later.

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
    return text
      .toLowerCase()
      .split(/[^a-zA-Z\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]+/)
      .filter(w => w.length >= 2 && !STOPWORDS.has(w));
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
