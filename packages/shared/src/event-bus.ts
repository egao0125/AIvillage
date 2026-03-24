// ============================================================================
// AI Village — Event Bus (Infra 1)
// Typed pub/sub bus for internal simulation decoupling.
// ============================================================================

import type { SimEvent } from './events.js';

type Handler<T> = (event: T) => void;
type EventOfType<K extends SimEvent['type']> = Extract<SimEvent, { type: K }>;

export class EventBus {
  private handlers = new Map<string, Set<Handler<any>>>();

  on<K extends SimEvent['type']>(type: K, handler: Handler<EventOfType<K>>): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
    return () => { this.handlers.get(type)?.delete(handler); };
  }

  emit(event: SimEvent): void {
    const handlers = this.handlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) handler(event);
    }
  }
}
