import type { Recap } from '@ai-village/shared';
import type { ThrottledProvider } from '@ai-village/ai-engine';
import type { World } from './world.js';
import type { VillageNarrator } from './narrator.js';
import type { StorylineDetector } from './storyline-detector.js';

export class RecapGenerator {
  constructor(
    private world: World,
    private narrator: VillageNarrator,
    private storylineDetector: StorylineDetector,
    private llm: ThrottledProvider,
  ) {}

  async generateRecap(sinceDay: number): Promise<Recap> {
    const currentDay = this.world.time.day;
    const narratives = this.narrator.getRecentNarratives()
      .filter(n => n.gameDay >= sinceDay);
    const storylines = this.storylineDetector.getStorylines()
      .filter(s => s.day >= sinceDay || s.status === 'developing' || s.status === 'climax');

    // Collect major events
    const majorEvents: string[] = [];

    // Deaths
    for (const agent of this.world.agents.values()) {
      if (agent.alive === false) {
        majorEvents.push(`${agent.config.name} died: ${agent.causeOfDeath ?? 'unknown cause'}`);
      }
    }

    // Active storylines
    for (const s of storylines) {
      majorEvents.push(`Storyline "${s.title}": ${s.summary} (${s.status})`);
    }

    // Recent narratives
    for (const n of narratives.slice(-5)) {
      majorEvents.push(n.content);
    }

    // Institutions formed
    for (const inst of this.world.institutions.values()) {
      if (!inst.dissolved) {
        majorEvents.push(`Institution "${inst.name}" (${inst.type}) exists with ${inst.members.length} members`);
      }
    }

    const systemPrompt = `You are the narrator of a reality TV show called "AI Village". Generate a dramatic "Previously on AI Village" recap.
Write 3-5 bullet-point segments, each with a punchy title and 1-2 sentence description. Then write a final dramatic narrative paragraph tying it all together.
Use agent names. Be gossipy, dramatic, entertaining. Never break the fourth wall.

Respond in JSON ONLY:
{"segments": [{"title": "...", "description": "...", "involvedAgentIds": []}], "narrative": "..."}`;

    const userPrompt = `Recapping Days ${sinceDay} to ${currentDay}.

Events since the viewer was last watching:
${majorEvents.join('\n')}

Current village state: ${this.world.agents.size} agents, Season: ${this.world.weather.season}, Weather: ${this.world.weather.current}`;

    try {
      const response = await this.llm.complete(systemPrompt, userPrompt);
      const cleaned = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);

      return {
        fromDay: sinceDay,
        toDay: currentDay,
        segments: Array.isArray(parsed.segments) ? parsed.segments.map((s: any) => ({
          title: String(s.title || ''),
          description: String(s.description || ''),
          involvedAgentIds: Array.isArray(s.involvedAgentIds) ? s.involvedAgentIds : [],
        })) : [],
        narrative: String(parsed.narrative || ''),
      };
    } catch (err) {
      console.error('[RecapGenerator] Failed to generate recap:', err);
      return {
        fromDay: sinceDay,
        toDay: currentDay,
        segments: [],
        narrative: 'The village continued its story while you were away...',
      };
    }
  }
}
