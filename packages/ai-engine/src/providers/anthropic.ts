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
    return block.type === 'text' ? block.text : '';
  }
}
