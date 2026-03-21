import type { NarrativeEntry, GameTime } from '@ai-village/shared';
import type { ThrottledProvider } from '@ai-village/ai-engine';
import type { World } from './world.js';

export class VillageNarrator {
  private eventLog: { text: string; timestamp: number }[] = [];
  private narratives: NarrativeEntry[] = [];
  private lastNarrateMinute: number = 0;

  constructor(
    private llm: ThrottledProvider,
    private world: World,
  ) {}

  logEvent(description: string): void {
    this.eventLog.push({ text: description, timestamp: Date.now() });
    // Ring buffer: keep last 100 events
    if (this.eventLog.length > 100) {
      this.eventLog = this.eventLog.slice(-100);
    }
  }

  async maybeNarrate(time: GameTime): Promise<NarrativeEntry | null> {
    const totalMinutes = time.day * 1440 + time.hour * 60 + time.minute;

    // Every 180 game minutes (3 game hours) AND at least 5 events
    if (totalMinutes - this.lastNarrateMinute < 180) return null;
    if (this.eventLog.length < 5) return null;

    this.lastNarrateMinute = totalMinutes;

    // Drain events for this narration
    const events = this.eventLog.splice(0);
    const eventDump = events.map(e => e.text).join('\n');

    // Collect agent moods
    const agents = Array.from(this.world.agents.values()).filter(a => a.alive !== false && a.state !== 'away');
    const moodSummary = agents.map(a => `${a.config.name}: ${a.mood ?? 'neutral'}`).join(', ');

    const systemPrompt = `You are the narrator of a reality TV show set in a small AI village. Dramatic, gossipy, entertaining. Observe everything, influence nothing. Highlight conflicts, budding relationships, betrayals, unlikely alliances. Use agent names. 2-4 sentences. Never break the fourth wall.`;

    const userPrompt = `Game time: Day ${time.day}, ${time.hour}:${String(time.minute).padStart(2, '0')}
Weather: ${this.world.weather.current} (${this.world.weather.season})

Agent moods: ${moodSummary}

Recent events:
${eventDump}

Narrate what's been happening:`;

    try {
      const content = await this.llm.complete(systemPrompt, userPrompt);

      // Extract agent names referenced in the narrative
      const referencedAgentIds: string[] = [];
      const referencedAgentNames: string[] = [];
      for (const agent of agents) {
        if (content.includes(agent.config.name)) {
          referencedAgentIds.push(agent.id);
          referencedAgentNames.push(agent.config.name);
        }
      }

      const narrative: NarrativeEntry = {
        id: crypto.randomUUID(),
        content,
        gameDay: time.day,
        gameHour: time.hour,
        referencedAgentIds,
        referencedAgentNames,
        timestamp: Date.now(),
      };

      this.narratives.push(narrative);
      // Keep last 20 narratives
      if (this.narratives.length > 20) {
        this.narratives = this.narratives.slice(-20);
      }

      return narrative;
    } catch (err) {
      console.error('[Narrator] Failed to generate narrative:', err);
      return null;
    }
  }

  getRecentNarratives(): NarrativeEntry[] {
    return [...this.narratives];
  }
}
