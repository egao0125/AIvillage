import OpenAI from 'openai';

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
