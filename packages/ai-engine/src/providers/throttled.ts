import type { LLMProvider } from '../index.js';

/**
 * Wraps any LLMProvider with a concurrency limiter.
 * When max concurrent calls are in-flight, new calls wait in a queue.
 * Prevents OOM and event loop starvation with many agents.
 */
export class ThrottledProvider implements LLMProvider {
  private inFlight = 0;
  private queue: Array<() => void> = [];

  constructor(
    private inner: LLMProvider,
    private maxConcurrent: number = 5,
  ) {}

  get model(): string {
    return this.inner.model;
  }

  set model(value: string) {
    this.inner.model = value;
  }

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    await this.acquire();
    try {
      return await this.inner.complete(systemPrompt, userPrompt);
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  private release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next(); // don't decrement — the slot transfers to the next waiter
    } else {
      this.inFlight--;
    }
  }
}
