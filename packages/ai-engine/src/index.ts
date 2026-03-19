// ============================================================================
// AI Village — AI Engine
// Agent cognition: Perceive → Retrieve → Plan → Act → Reflect
// Based on: https://arxiv.org/abs/2304.03442
// ============================================================================

import type { Agent, Memory, Position, MapArea, AgentState, DayPlan, DayPlanItem } from "@ai-village/shared";

// --- Memory Stream ---

export interface MemoryStore {
  add(memory: Memory): Promise<void>;
  retrieve(agentId: string, query: string, limit?: number): Promise<Memory[]>;
  getRecent(agentId: string, limit?: number): Promise<Memory[]>;
  getByImportance(agentId: string, minImportance: number): Promise<Memory[]>;
}

// --- LLM Provider ---

export interface LLMProvider {
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
  model: string;
}

// --- Agent Cognition ---

export class AgentCognition {
  constructor(
    private agent: Agent,
    private memory: MemoryStore,
    private llm: LLMProvider,
  ) {}

  /**
   * Store a memory directly into this agent's memory stream.
   */
  async addMemory(memory: Memory): Promise<void> {
    await this.memory.add(memory);
  }

  /**
   * Perceive — What's around me right now?
   * Scans nearby agents, objects, and events within perception radius.
   */
  async perceive(nearbyAgents: Agent[], nearbyAreas: MapArea[]): Promise<string[]> {
    const observations: string[] = [];

    for (const other of nearbyAgents) {
      observations.push(
        `${other.config.name} is nearby, ${other.currentAction}.`
      );
    }

    for (const area of nearbyAreas) {
      observations.push(`I am near ${area.name} (${area.type}).`);
    }

    // Store observations as memories
    for (const obs of observations) {
      await this.memory.add({
        id: crypto.randomUUID(),
        agentId: this.agent.id,
        type: "observation",
        content: obs,
        importance: 3,
        timestamp: Date.now(),
        relatedAgentIds: nearbyAgents.map((a) => a.id),
      });
    }

    return observations;
  }

  /**
   * Retrieve — What do I remember that's relevant?
   * Searches memory stream for experiences related to current situation.
   */
  async retrieve(currentContext: string): Promise<Memory[]> {
    return this.memory.retrieve(this.agent.id, currentContext, 10);
  }

  /**
   * Plan — What should I do next?
   * Uses LLM to generate next action based on perception + memories.
   */
  async plan(observations: string[], memories: Memory[]): Promise<string> {
    const { config } = this.agent;

    const soulText = config.soul || `${config.backstory}\nGoal: ${config.goal}`;
    const systemPrompt = `You are ${config.name}, age ${config.age}, ${config.occupation}.

${soulText}

You are living in a small village. You make decisions autonomously based on who you are, your memories, and your current situation. Respond with a single next action in JSON format:
{"action": "move_to|talk_to|use_object|wait|go_home|sleep", "target": "...", "reason": "..."}`;

    const memoryContext = memories
      .map((m) => `[${m.type}] ${m.content}`)
      .join("\n");

    const userPrompt = `Current observations:
${observations.join("\n")}

Relevant memories:
${memoryContext}

Current time: ${new Date().toLocaleTimeString()}
What do you do next?`;

    const response = await this.llm.complete(systemPrompt, userPrompt);
    return response;
  }

  /**
   * Reflect — What have I learned recently?
   * Periodically synthesizes recent memories into higher-level insights.
   */
  async reflect(): Promise<string> {
    const recentMemories = await this.memory.getRecent(this.agent.id, 20);

    if (recentMemories.length < 5) return "";

    const soulText = this.agent.config.soul || this.agent.config.backstory;
    const systemPrompt = `You are ${this.agent.config.name}, ${this.agent.config.occupation}.

${soulText}

Reflect on your recent experiences. Be brutally honest with yourself — the thoughts you'd never say out loud.
- Who do you trust? Who do you resent? Who are you drawn to? Who disgusts you?
- What are you scheming? What are you afraid of? What do you want that you can't have?
- Did anyone say something today that changed how you see them?
- Are you gaining or losing influence in this village?

Write 2-3 raw, honest reflections in first person. These are your private thoughts — hold nothing back.`;

    const userPrompt = `Recent experiences:\n${recentMemories.map((m) => m.content).join("\n")}`;

    const reflection = await this.llm.complete(systemPrompt, userPrompt);

    await this.memory.add({
      id: crypto.randomUUID(),
      agentId: this.agent.id,
      type: "reflection",
      content: reflection,
      importance: 8,
      timestamp: Date.now(),
      relatedAgentIds: [],
    });

    return reflection;
  }

  /**
   * Generate conversation response
   */
  async converse(otherAgent: Agent, conversationHistory: string[], boardContext?: string): Promise<string> {
    const { config } = this.agent;
    const memories = await this.memory.retrieve(
      this.agent.id,
      `${otherAgent.config.name} ${otherAgent.config.occupation}`,
      10
    );

    const soulText = config.soul || `${config.backstory}\nGoal: ${config.goal}`;
    const otherSoul = otherAgent.config.soul ? `\nWhat you know about ${otherAgent.config.name}: ${otherAgent.config.occupation}, age ${otherAgent.config.age}.` : '';
    const boardSection = boardContext ? `\n\nVILLAGE BOARD (public posts everyone can see):\n${boardContext}` : '';
    const systemPrompt = `You are ${config.name}, age ${config.age}, ${config.occupation}.

${soulText}

You are having a conversation with ${otherAgent.config.name} (${otherAgent.config.occupation}).${otherSoul}${boardSection}

HOW TO TALK:
- Talk like a real person in a real conversation. NOT like a novel. NOT like roleplay. Just talk.
- Sometimes you say one word. "Yeah." "No." "Hm." Sometimes you ramble for a bit when you're worked up.
- Don't narrate your actions in asterisks. No *leans against wall* or *sighs deeply*. Just say what you'd say out loud.
- Use contractions, trail off with "...", interrupt yourself, change topics mid-sentence.
- If you're uncomfortable, be awkward. Stumble. Say "I don't know" or "whatever" or just go quiet.
- If you're angry, snap. If you're lying, sound too casual. If you're hurt, get defensive.
- Match the energy of the conversation — if it's casual, be casual. If it's tense, be tense.
- DO NOT be polite just to be polite. Most real conversations aren't polite.

WHO YOU ARE:
- Stay completely in character. Act on your desires, grudges, fears, and ambitions.
- If your character would be cruel, manipulative, or confrontational — be that.
- You can lie, deflect, guilt-trip, charm, insult, go silent, or walk away.

SOCIAL ACTIONS (optional — append at the very end if you want to DO something):
  [ACTION: decree - <text>] [ACTION: rule - <text>] [ACTION: announce - <text>]
  [ACTION: rumor - <text>] [ACTION: threat - <text>] [ACTION: alliance - <text>]
  [ACTION: bounty - <text>] [ACTION: give <N> gold to <name>] [ACTION: demand <N> gold from <name>]
  [ACTION: <any intention>]`;

    const memoryContext = memories.length > 0
      ? `\nYour memories of ${otherAgent.config.name}:\n${memories.map((m) => m.content).join("\n")}`
      : "";

    const userPrompt = `${memoryContext}

Conversation so far:
${conversationHistory.join("\n")}

Your turn to speak:`;

    return this.llm.complete(systemPrompt, userPrompt);
  }

  /**
   * Plan Day — Generate a full day schedule using LLM.
   */
  async planDay(currentTime: { day: number; hour: number }, boardContext?: string): Promise<DayPlan> {
    const recentMemories = await this.memory.getRecent(this.agent.id, 15);
    // Also pull high-importance memories (intentions, reflections) that might not be recent
    const importantMemories = await this.memory.getByImportance(this.agent.id, 7);
    const allMemories = [...recentMemories];
    for (const m of importantMemories) {
      if (!allMemories.some(existing => existing.id === m.id)) {
        allMemories.push(m);
      }
    }
    const memoryContext = allMemories.map(m => `[${m.type}] ${m.content}`).join('\n');

    const soulText = this.agent.config.soul || `${this.agent.config.backstory}\nGoal: ${this.agent.config.goal}`;
    const systemPrompt = `You are ${this.agent.config.name}, a ${this.agent.config.occupation}.

${soulText}

Today is day ${currentTime.day}. You live in a small village with other people. You have your own agenda, relationships, and schemes. Plan your day based on who you are and what's happened recently — not just routine.${boardContext ? `\n\nVILLAGE BOARD (public posts everyone can see):\n${boardContext}\n\nReact to these posts in your planning. Obey rules you agree with, defy ones you don't, scheme around decrees, investigate rumors.` : ''}`;

    const userPrompt = `Your recent experiences and conversations:
${memoryContext || 'No recent memories yet.'}

Plan your activities from hour ${currentTime.hour} onward. If someone asked you to meet them somewhere or do something together, go there. If a conversation upset you, you might avoid that person or seek comfort. React to what happened — don't just follow routine.

Return a JSON array of activities:
[{"time": <hour 0-23>, "duration": <minutes>, "activity": "<what you'll do>", "location": "<where>", "emoji": "<optional emoji>"}]

Available locations: cafe, plaza, market, park, lake, forest, garden, church, hospital, school, town_hall, tavern, bakery, workshop, farm
Only return the JSON array, no other text.`;

    const response = await this.llm.complete(systemPrompt, userPrompt);

    let items: DayPlanItem[];
    try {
      const cleaned = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      items = JSON.parse(cleaned);
    } catch {
      items = [
        { time: currentTime.hour, duration: 120, activity: 'going about daily routine', location: 'plaza', emoji: '🚶' },
        { time: currentTime.hour + 2, duration: 60, activity: 'resting', location: 'park', emoji: '🌿' },
      ];
    }

    return { agentId: this.agent.id, day: currentTime.day, items };
  }
}

export { AgentCognition as default };
export { InMemoryStore } from './memory/in-memory.js';
export { AnthropicProvider } from './providers/anthropic.js';
export { OpenAIProvider } from './providers/openai.js';
