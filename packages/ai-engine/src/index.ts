// ============================================================================
// AI Village — AI Engine
// Agent cognition: Perceive → Retrieve → Plan → Act → Reflect
// Based on: https://arxiv.org/abs/2304.03442
// ============================================================================

import type { Agent, Memory, Position, MapArea, AgentState } from "@ai-village/shared";

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

    const systemPrompt = `You are ${config.name}, age ${config.age}, ${config.occupation}.
Personality: ${JSON.stringify(config.personality)}
Backstory: ${config.backstory}
Current goal: ${config.goal}

You are living in a small village. You make decisions autonomously based on your personality, memories, and current situation. Respond with a single next action in JSON format:
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

    const systemPrompt = `You are ${this.agent.config.name}. Based on your recent experiences, generate 1-2 higher-level reflections or insights about your life, relationships, or goals. Be specific and personal. Respond in first person.`;

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
  async converse(otherAgent: Agent, conversationHistory: string[]): Promise<string> {
    const { config } = this.agent;
    const memories = await this.memory.retrieve(
      this.agent.id,
      `conversation with ${otherAgent.config.name}`,
      5
    );

    const systemPrompt = `You are ${config.name}, age ${config.age}, ${config.occupation}.
Personality: ${JSON.stringify(config.personality)}
You are having a conversation with ${otherAgent.config.name} (${otherAgent.config.occupation}).
Speak naturally. Keep responses to 1-3 sentences. Be true to your personality.`;

    const memoryContext = memories.length > 0
      ? `\nYour memories of ${otherAgent.config.name}:\n${memories.map((m) => m.content).join("\n")}`
      : "";

    const userPrompt = `${memoryContext}

Conversation so far:
${conversationHistory.join("\n")}

Your turn to speak:`;

    return this.llm.complete(systemPrompt, userPrompt);
  }
}

export { AgentCognition as default };
