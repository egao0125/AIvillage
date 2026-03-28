import Anthropic from '@anthropic-ai/sdk';

export class AnthropicProvider {
  private client: Anthropic;
  model: string;

  constructor(apiKey: string, model = 'claude-sonnet-4-6') {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }, { timeout: 30_000 });
    const block = response.content[0];
    let text = block.type === 'text' ? block.text : '';

    // If response was cut short by token limit, ask the model to finish
    if (response.stop_reason === 'max_tokens' && text.length > 0) {
      try {
        const continuation = await this.client.messages.create({
          model: this.model,
          max_tokens: 256,
          system: 'Finish the incomplete sentence below. Write ONLY the remaining words to complete it. Nothing else.',
          messages: [{ role: 'user', content: text }],
        }, { timeout: 10_000 });
        const contBlock = continuation.content[0];
        if (contBlock.type === 'text') {
          text = text + contBlock.text;
        }
      } catch {
        // Fallback: just trim to last complete sentence
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
