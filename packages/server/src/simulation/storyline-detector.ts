import type { Storyline, StorylineEvent, StorylineTheme } from '@ai-village/shared';
import type { ThrottledProvider } from '@ai-village/ai-engine';
import type { World } from './world.js';

interface StorylineCandidate {
  agentIds: string[];
  events: { description: string; day: number; timestamp: number }[];
}

export class StorylineDetector {
  private storylines: Storyline[] = [];

  constructor(
    private world: World,
    private llm: ThrottledProvider,
  ) {}

  async detectAndUpdate(): Promise<Storyline[]> {
    // 1. Age existing storylines: mark dormant if no new events in 3+ days
    const currentDay = this.world.time.day;
    for (const storyline of this.storylines) {
      if (storyline.status === 'developing' || storyline.status === 'climax') {
        if (currentDay - storyline.day > 3) {
          storyline.status = 'dormant';
          storyline.lastUpdatedAt = Date.now();
        }
      }
    }

    // 2. Find candidates from recent interactions
    const candidates = this.findCandidates();
    if (candidates.length === 0) return this.storylines;

    // 3. Generate metadata for new storylines (limit to 5 LLM calls)
    let newCount = 0;
    for (const candidate of candidates) {
      if (newCount >= 5) break;

      // Check if this pair/cluster already has an active storyline
      const existingIdx = this.storylines.findIndex(s => {
        const overlap = s.involvedAgentIds.filter(id => candidate.agentIds.includes(id));
        return overlap.length >= 2 && (s.status === 'developing' || s.status === 'climax');
      });

      if (existingIdx >= 0) {
        // Update existing storyline with new events
        const existing = this.storylines[existingIdx];
        for (const evt of candidate.events) {
          const alreadyHas = existing.events.some(e => e.description === evt.description);
          if (!alreadyHas) {
            existing.events.push({
              id: crypto.randomUUID(),
              description: evt.description,
              agentIds: candidate.agentIds,
              timestamp: evt.timestamp,
              day: evt.day,
            });
          }
        }
        existing.lastUpdatedAt = Date.now();
        existing.day = currentDay;
        // Promote to climax if 8+ events
        if (existing.events.length >= 8 && existing.status === 'developing') {
          existing.status = 'climax';
        }
        continue;
      }

      // New storyline — generate metadata via LLM
      try {
        const metadata = await this.generateMetadata(candidate);
        const storyline: Storyline = {
          id: crypto.randomUUID(),
          title: metadata.title,
          theme: metadata.theme,
          involvedAgentIds: candidate.agentIds,
          status: 'developing',
          events: candidate.events.map(e => ({
            id: crypto.randomUUID(),
            description: e.description,
            agentIds: candidate.agentIds,
            timestamp: e.timestamp,
            day: e.day,
          })),
          summary: metadata.summary,
          createdAt: Date.now(),
          lastUpdatedAt: Date.now(),
          day: currentDay,
        };
        this.storylines.push(storyline);
        newCount++;
      } catch (err) {
        console.error('[StorylineDetector] Failed to generate metadata:', err);
      }
    }

    // Keep last 20 storylines
    if (this.storylines.length > 20) {
      // Keep active ones, trim oldest dormant/resolved
      const active = this.storylines.filter(s => s.status === 'developing' || s.status === 'climax');
      const inactive = this.storylines.filter(s => s.status === 'dormant' || s.status === 'resolved');
      this.storylines = [...active, ...inactive.slice(-Math.max(0, 20 - active.length))];
    }

    return this.storylines;
  }

  private findCandidates(): StorylineCandidate[] {
    const currentDay = this.world.time.day;
    const pairEvents: Map<string, StorylineCandidate> = new Map();

    // Scan recent conversations (last 2 game days)
    for (const conv of this.world.conversations.values()) {
      if (conv.participants.length < 2) continue;

      const convDay = Math.floor((conv.startedAt - Date.now()) / (1440 * 83)) + currentDay;
      if (currentDay - convDay > 2 && conv.endedAt) continue;

      const key = [...conv.participants].sort().join(':');
      if (!pairEvents.has(key)) {
        pairEvents.set(key, { agentIds: [...conv.participants].sort(), events: [] });
      }
      const agent1 = this.world.getAgent(conv.participants[0]);
      const agent2 = this.world.getAgent(conv.participants[1]);
      const name1 = agent1?.config.name ?? 'Unknown';
      const name2 = agent2?.config.name ?? 'Unknown';
      const lastMsg = conv.messages[conv.messages.length - 1];
      const snippet = lastMsg ? lastMsg.content.substring(0, 80) : 'had a conversation';
      pairEvents.get(key)!.events.push({
        description: `${name1} and ${name2}: ${snippet}`,
        day: currentDay,
        timestamp: lastMsg?.timestamp ?? Date.now(),
      });
    }

    // Scan board posts involving specific agents
    for (const post of this.world.board) {
      if (!post.targetIds?.length) continue;
      if (currentDay - post.day > 2) continue;

      const agentIds = [post.authorId, ...post.targetIds].sort();
      const key = agentIds.join(':');
      if (!pairEvents.has(key)) {
        pairEvents.set(key, { agentIds, events: [] });
      }
      const author = this.world.getAgent(post.authorId);
      pairEvents.get(key)!.events.push({
        description: `${author?.config.name ?? 'Unknown'} posted ${post.type}: ${post.content.substring(0, 60)}`,
        day: post.day,
        timestamp: post.timestamp,
      });
    }

    // Filter: need 3+ events to be a candidate
    return Array.from(pairEvents.values()).filter(c => c.events.length >= 3);
  }

  private async generateMetadata(candidate: StorylineCandidate): Promise<{ title: string; summary: string; theme: StorylineTheme }> {
    const agentNames = candidate.agentIds
      .map(id => this.world.getAgent(id)?.config.name ?? 'Unknown')
      .join(', ');

    const eventDump = candidate.events.map(e => e.description).join('\n');

    const systemPrompt = `You are a reality TV show writer analyzing storylines in an AI village. Generate a catchy title, 1-sentence summary, and theme for this developing storyline.

Respond in JSON ONLY: {"title": "...", "summary": "...", "theme": "<conflict|romance|power|alliance|mystery|survival>"}`;

    const userPrompt = `Characters involved: ${agentNames}

Recent events:
${eventDump}`;

    const response = await this.llm.complete(systemPrompt, userPrompt);
    try {
      const cleaned = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      const validThemes: StorylineTheme[] = ['conflict', 'romance', 'power', 'alliance', 'mystery', 'survival'];
      return {
        title: String(parsed.title || 'Untitled').substring(0, 80),
        summary: String(parsed.summary || '').substring(0, 200),
        theme: validThemes.includes(parsed.theme) ? parsed.theme : 'mystery',
      };
    } catch {
      return { title: 'Developing Story', summary: 'A storyline is forming...', theme: 'mystery' };
    }
  }

  getStorylines(): Storyline[] {
    return [...this.storylines];
  }
}
