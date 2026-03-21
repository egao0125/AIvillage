import type { CharacterTimelineEvent } from '@ai-village/shared';

export class CharacterTimeline {
  private events: Map<string, CharacterTimelineEvent[]> = new Map();

  recordEvent(event: CharacterTimelineEvent): void {
    if (!this.events.has(event.agentId)) {
      this.events.set(event.agentId, []);
    }
    const agentEvents = this.events.get(event.agentId)!;
    agentEvents.push(event);
    // Keep last 100 per agent
    if (agentEvents.length > 100) {
      this.events.set(event.agentId, agentEvents.slice(-100));
    }
  }

  getTimeline(agentId: string, limit: number = 50): CharacterTimelineEvent[] {
    const events = this.events.get(agentId) ?? [];
    return events.slice(-limit);
  }
}
