import OpenAI from 'openai';
import type { EmbeddingProvider } from '../memory/embeddings.js';

/**
 * OpenAI Embedding Provider — uses text-embedding-3-small by default.
 * Shared server-level resource (not per-agent). Cost: ~$0.02 / 1M tokens.
 * Implements the EmbeddingProvider interface from embeddings.ts.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private client: OpenAI;
  dimensions: number;

  constructor(apiKey: string, private model = 'text-embedding-3-small', dims = 1536) {
    this.client = new OpenAI({ apiKey });
    this.dimensions = dims;
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text.slice(0, 8000), // safety truncate
      dimensions: this.dimensions,
    });
    return response.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    // OpenAI supports up to 2048 inputs per batch
    const truncated = texts.map(t => t.slice(0, 8000));
    const response = await this.client.embeddings.create({
      model: this.model,
      input: truncated,
      dimensions: this.dimensions,
    });
    return response.data
      .sort((a, b) => a.index - b.index)
      .map(d => d.embedding);
  }
}

export class OpenAIProvider {
  private client: OpenAI;
  model: string;

  constructor(apiKey: string, model = 'gpt-4o-mini') {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }, { timeout: 30_000 });
    let text = response.choices[0]?.message?.content ?? '';

    // If response was cut short by token limit, ask the model to finish
    if (response.choices[0]?.finish_reason === 'length' && text.length > 0) {
      try {
        const continuation = await this.client.chat.completions.create({
          model: this.model,
          max_tokens: 256,
          messages: [
            { role: 'system', content: 'Finish the incomplete sentence below. Write ONLY the remaining words to complete it. Nothing else.' },
            { role: 'user', content: text },
          ],
        }, { timeout: 10_000 });
        const contText = continuation.choices[0]?.message?.content;
        if (contText) text = text + contText;
      } catch {
        const lastEnd = Math.max(text.lastIndexOf('. '), text.lastIndexOf('! '), text.lastIndexOf('? '));
        if (lastEnd > text.length * 0.3) {
          text = text.slice(0, lastEnd + 1);
        } else if (!/[.!?]$/.test(text.trim())) {
          text = text.trim() + '.';
        }
      }
    }

    return text;
  }
}
