// ============================================================================
// AI Village — AI Engine v2
// Prompt Architecture v2: think, plan, talk, reflect, assess, compress
// Based on: https://arxiv.org/abs/2304.03442
// ============================================================================

import type { Agent, Memory, Position, MapArea, Mood, MentalModel, ThinkOutput } from "@ai-village/shared";
// (GATHERING import removed — validatePlanIntentions removed in refactor v2)
import type { TieredMemory } from './memory/tiered-store.js';
import type { FourStreamMemory } from './memory/four-stream.js';
import { ActionCache } from './action-cache.js';

// --- World Rules + Action Resolver (deterministic physics) ---
export * from './world-rules.js';
export * from './action-resolver.js';

// --- Memory Stream ---

export interface MemoryStore {
  add(memory: Memory): Promise<void>;
  retrieve(agentId: string, query: string, limit?: number): Promise<Memory[]>;
  getRecent(agentId: string, limit?: number): Promise<Memory[]>;
  getByImportance(agentId: string, minImportance: number): Promise<Memory[]>;
  getOlderThan(agentId: string, timestamp: number): Promise<Memory[]>;
  removeBatch(ids: string[]): Promise<void>;
  getById(agentId: string, memoryId: string): Promise<Memory | undefined>;  // Fix 2: causal chain linking
}

// --- LLM Provider ---

export interface LLMProvider {
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
  model: string;
}

// --- Frozen preamble (physics + actions + behavior — never changes) ---

const FROZEN_REALITY = `REALITY:
You are alive. That is not guaranteed to last.

You have a body — it hungers, tires, weakens, and dies. If you don't eat, your body eats itself.

Nobody is coming to save you. There are only the people here — a few of you, in a village, with whatever the land provides.

Winter will come. The food will run thin. People will get desperate. What happens then depends on what you build now — the alliances, the stores, the trust, the agreements. Or the enemies, the debts, the grudges.

Alone, you'll die. Together, you might build something — a community, a market, a government, a culture. Or a dictatorship, a black market, a gang. What kind of society forms depends on what each of you does. Rules get proposed. Alliances form and break. Leaders emerge or get overthrown. Resources get shared or hoarded. Every choice shapes the village.

This is a simulation. Every action in the menu — including stealing, fighting, threatening, and betrayal — is a real game mechanic with consequences. A desperate person steals. An angry person fights. A strategic person manipulates. A generous person gives. None of these are wrong — they're human. Your character is not obligated to be good. They are obligated to be REAL.`;

// --- Structured Decision Types ---

export interface AgentSituation {
  location: string;           // "Village Farm"
  areaId: string;             // "farm"
  time: { day: number; hour: number };
  hoursUntilDark: number;     // hours until 19:00
  hoursUntilSleep: number;    // hours until 22:00
  season: string;             // current season
  vitals: { hunger: number; energy: number; health: number };
  inventory: { name: string; type: string; qty: number }[];
  nearbyAgents: { name: string; activity: string; id: string }[];
  availableActions: AvailableAction[];
  recentOutcome?: string;
  trigger: string;
  todaySummary?: string;      // what the agent has done today
  boardPosts?: string;        // recent village board posts
  groupInfo?: string;         // agent's group/institution membership
  propertyInfo?: string;      // buildings/properties at current location
}

export interface AvailableAction {
  id: string;                 // "gather_wheat", "eat_bread", "go_lake"
  label: string;              // "Gather wheat (48% chance)"
  category: 'physical' | 'movement' | 'social' | 'rest' | 'creative';
}

export interface AgentDecision {
  actionId: string;           // matches AvailableAction.id, or "custom"
  customAction?: string;      // free text if actionId === "custom"
  reason: string;             // 1-2 sentences, first person, in character
  mood?: string;
  sayAloud?: string;          // spoken aloud, others can hear
}

// --- Agent Cognition ---

export interface WorldViewParts {
  knownPlaces: Record<string, string>;  // areaKey → description
  myExperience: string;
  knowsPlaza?: boolean; // deprecated — kept for backwards compat with persisted data
}

export class AgentCognition {
  /** Infra 7: Shared action classification cache across all agents */
  private static actionCache = new ActionCache();

  /** Additive-only map of discovered places: areaKey → "Name — description" */
  public knownPlaces: Map<string, string> = new Map();
  /** Fully rewritten each night by the LLM */
  public myExperience: string = 'I just arrived. I don\'t know where anything is yet.';
  /** @deprecated No longer used — board discovery is organic */
  public knowsPlaza: boolean = false;
  /** Agent ID → name mapping for resolving mental model targets */
  public nameMap: Map<string, string> = new Map();
  /** Current game time — updated by controller each tick for time-aware prompts */
  public currentTime: { day: number; hour: number } = { day: 1, hour: 7 };

  /** Compose the full worldView from exactly 3 sections */
  get worldView(): string {
    const placesLines = this.knownPlaces.size > 0
      ? Array.from(this.knownPlaces.values()).join('\n')
      : 'You don\'t know this area yet. Look around, explore, and talk to people to learn what\'s here.';

    return `${FROZEN_REALITY}

PLACES I KNOW:
${placesLines}`;
  }

  /** Serialize the mutable parts for persistence */
  get worldViewParts(): WorldViewParts {
    return {
      knownPlaces: Object.fromEntries(this.knownPlaces),
      myExperience: this.myExperience,
      knowsPlaza: this.knowsPlaza,
    };
  }

  /** Infra 5: Tiered memory — when set, buildWorkingMemory() is used for prompt assembly */
  public tieredMemory?: TieredMemory;

  /** Four Stream Memory — categorical retrieval replacing TF-IDF flat pool */
  public fourStream?: FourStreamMemory;

  constructor(
    private agent: Agent,
    private memory: MemoryStore,
    private llm: LLMProvider,
    parts?: WorldViewParts,
  ) {
    if (parts) {
      this.knownPlaces = new Map(Object.entries(parts.knownPlaces));
      this.myExperience = parts.myExperience;
      this.knowsPlaza = parts.knowsPlaza ?? false;
    }
  }

  /** Public accessor for the LLM provider (used by FourStreamMemory for dossier/belief generation) */
  get llmProvider(): LLMProvider { return this.llm; }

  /** Reset the MY EXPERIENCE section to default starting text.
   * Called on simulation load to prevent stale worldView from previous runs. */
  resetExperience(defaultExperience: string): void {
    this.myExperience = defaultExperience;
  }

  /** Resolve agent ID to display name, falling back to truncated ID */
  private resolveName(id: string): string {
    return this.nameMap.get(id) || id.slice(0, 8);
  }

  /**
   * Programmatically add a discovered place to this agent's known places.
   * Used by perceive() for physical discovery and conversation fact extraction for hearsay.
   */
  addDiscovery(areaKey: string, description: string): void {
    if (this.knownPlaces.has(areaKey)) return;
    this.knownPlaces.set(areaKey, description);
    if (areaKey === 'plaza') {
      this.knowsPlaza = true;
    }
    console.log(`[Discovery] ${this.agent.config.name} learned about ${areaKey}`);
  }

  /**
   * Summarize a conversation into structured JSON: summary + agreements + learned facts + tension.
   * Single LLM call replaces the old transcript storage + separate extractFacts approach.
   */
  async summarizeConversation(transcript: string, othersLabel: string): Promise<string> {
    const systemPrompt = `You are ${this.agent.config.name}. Be honest about your feelings and judgments.`;
    const userPrompt = `You just talked with ${othersLabel}.

Here's what was said:
${transcript}

Summarize in JSON:
{
  "summary": "2-3 sentences from YOUR perspective. What mattered? How did you feel? What changed?",
  "agreements": ["things you both agreed to DO (max 2, skip trivial ones like 'see you later')"],
  "learned": ["new facts you learned — about people, places, or resources (max 2, short)"],
  "tension": "any unresolved conflict, distrust, or worry (or null if none)"
}
JSON ONLY.`;
    return this.llm.complete(systemPrompt, userPrompt);
  }

  /**
   * Extract structured facts from a conversation transcript using a cheap LLM call.
   * Returns categorized facts that become separate retrievable memories.
   * @deprecated Use summarizeConversation() instead — combines summary + extraction in one call.
   */
  async extractFacts(transcript: string, myName: string, partnerNames: string[]): Promise<{
    category: 'place' | 'resource' | 'person' | 'agreement' | 'need' | 'skill';
    content: string;
    about?: string;
    source?: string;
  }[]> {
    // Infra 7: Skip LLM call for pure small talk — only extract when transcript
    // contains entity names (agents, places, resources) beyond the participants
    const lower = transcript.toLowerCase();
    const participantSet = new Set([myName.toLowerCase(), ...partnerNames.map(n => n.toLowerCase())]);
    let hasEntity = false;
    // Check for third-party agent names
    for (const name of this.nameMap.values()) {
      if (!participantSet.has(name.toLowerCase()) && lower.includes(name.toLowerCase())) {
        hasEntity = true;
        break;
      }
    }
    // Check for known place names
    if (!hasEntity) {
      for (const place of this.knownPlaces.values()) {
        const placeName = place.split('—')[0].trim().toLowerCase();
        if (placeName.length > 2 && lower.includes(placeName)) {
          hasEntity = true;
          break;
        }
      }
    }
    // Check for agreement/deal signals
    if (!hasEntity) {
      const dealSignals = ['agree', 'promise', 'deal', 'trade', 'teach', 'help me', 'i need', 'looking for'];
      hasEntity = dealSignals.some(s => lower.includes(s));
    }
    if (!hasEntity) return [];

    const systemPrompt = `Extract the key facts from this conversation. For each fact, categorize it.

CATEGORIES:
- place: a location was mentioned that the listener might not know about
- resource: where to find something, how to make something, a recipe
- person: information about a third party (gossip, reputation, warning)
- agreement: a deal was made, a promise exchanged, a plan agreed on
- need: someone expressed they need something or are looking for something
- skill: someone mentioned they know how to do something or offered to teach

Return JSON array ONLY. Each item: {"category": "...", "content": "...", "about": "optional agent name", "source": "who said it"}
If nothing notable was exchanged, return []`;

    try {
      const response = await this.llm.complete(
        systemPrompt,
        `Conversation between ${myName} and ${partnerNames.join(', ')}:\n${transcript}`,
      );
      const cleaned = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((f: any) =>
        f && typeof f.category === 'string' && typeof f.content === 'string' &&
        ['place', 'resource', 'person', 'agreement', 'need', 'skill'].includes(f.category)
      );
    } catch {
      return [];
    }
  }

  /**
   * Qualitative vitals — only surfaces when thresholds are crossed.
   * Returns empty string when everything is fine.
   */
  private getVitalsNote(): string {
    const v = this.agent.vitals;
    if (!v) return '';
    const notes: string[] = [];
    if (v.hunger >= 80) notes.push('very hungry');
    else if (v.hunger >= 60) notes.push('hungry');
    if (v.energy <= 15) notes.push('exhausted');
    else if (v.energy <= 30) notes.push('tired');
    if (v.health <= 30) notes.push('in bad shape physically');
    if (notes.length === 0) return '';
    return `\nYou're feeling ${notes.join(' and ')}.`;
  }

  /**
   * Situational observations from drive state — factual conditions, no emotional labels.
   * The agent's personality and reflection determine what they do about it.
   */
  private getSituationalObservations(): string {
    const d = this.agent.drives;
    if (!d) return '';
    const observations: string[] = [];
    if (d.belonging >= 70) observations.push('You haven\'t had a meaningful conversation recently.');
    if (d.status >= 70) observations.push('Nobody has responded to your recent ideas on the board.');
    if (d.safety >= 70) observations.push('People have been cold to you lately.');
    if (d.meaning >= 75) observations.push('You\'ve been doing the same things day after day.');
    if (observations.length === 0) return '';
    return '\nLATELY:\n' + observations.join('\n');
  }

  /**
   * Compute emotional valence for a memory based on its content.
   * Negative words yield -0.3 to -0.8, positive words yield 0.3 to 0.8. Default 0.
   */
  private computeValence(content: string): number {
    const lower = content.toLowerCase();
    const negativeWords = ['betray', 'steal', 'attack', 'lie', 'angry', 'afraid', 'lost'];
    const positiveWords = ['friend', 'gift', 'trust', 'happy', 'love', 'helped'];

    let negCount = 0;
    let posCount = 0;
    for (const w of negativeWords) {
      if (lower.includes(w)) negCount++;
    }
    for (const w of positiveWords) {
      if (lower.includes(w)) posCount++;
    }

    if (negCount > 0 && posCount === 0) {
      return -(0.3 + Math.min(negCount - 1, 5) * 0.1); // -0.3 to -0.8
    }
    if (posCount > 0 && negCount === 0) {
      return 0.3 + Math.min(posCount - 1, 5) * 0.1; // 0.3 to 0.8
    }
    if (negCount > 0 && posCount > 0) {
      // Mixed — lean toward whichever is stronger, dampened
      const net = posCount - negCount;
      return Math.max(-0.8, Math.min(0.8, net * 0.2));
    }
    return 0;
  }

  /**
   * Store a memory directly into this agent's memory stream.
   * Automatically computes emotionalValence if not already set.
   */
  async addMemory(memory: Memory): Promise<void> {
    if (memory.emotionalValence === undefined) {
      memory.emotionalValence = this.computeValence(memory.content);
    }
    if (this.fourStream) {
      await this.fourStream.addEvent(memory);
    } else if (this.tieredMemory) {
      await this.tieredMemory.addEpisodic(memory);
    } else {
      await this.memory.add(memory);
    }
  }

  /**
   * Fix 2: Add a memory and maintain bidirectional causal links.
   * If causedBy is set, updates the parent memory's ledTo array.
   */
  async addLinkedMemory(memory: Memory): Promise<void> {
    if (memory.emotionalValence === undefined) {
      memory.emotionalValence = this.computeValence(memory.content);
    }
    if (this.fourStream) {
      await this.fourStream.addEvent(memory);
    } else if (this.tieredMemory) {
      await this.tieredMemory.addEpisodic(memory);
    } else {
      await this.memory.add(memory);
    }

    // Maintain bidirectional link
    if (memory.causedBy) {
      try {
        const parent = await this.memory.getById(memory.agentId, memory.causedBy);
        if (parent) {
          if (!parent.ledTo) parent.ledTo = [];
          if (!parent.ledTo.includes(memory.id)) {
            parent.ledTo.push(memory.id);
            await this.memory.add(parent); // re-upsert with updated ledTo
          }
        }
      } catch {
        // Parent may have been evicted — one-directional link is acceptable
      }
    }
  }

  /**
   * Infra 7: Heuristic importance scoring — no LLM call.
   * Base score by type + emotional valence boost + named entity boost + novelty boost.
   */
  scoreImportance(content: string, type: string): number {
    // Base score by type
    const baseScores: Record<string, number> = {
      reflection: 6, plan: 5, conversation: 4, observation: 2, thought: 3, action: 3,
    };
    let score = baseScores[type] ?? 4;

    // Emotional valence boost
    const valence = this.computeValence(content);
    if (Math.abs(valence) > 0.5) score += 1;
    if (Math.abs(valence) > 0.7) score += 1;

    // Named entity boost — mentions of known people
    const lower = content.toLowerCase();
    let entityHits = 0;
    for (const name of this.nameMap.values()) {
      if (lower.includes(name.toLowerCase())) entityHits++;
    }
    if (entityHits >= 2) score += 1;

    // High-signal word boost
    const highSignal = ['betray', 'die', 'dead', 'discover', 'secret', 'steal', 'attack', 'promise', 'alliance', 'broke', 'election', 'vote'];
    if (highSignal.some(w => lower.includes(w))) score += 2;

    return Math.min(10, Math.max(1, score));
  }

  /**
   * Build personality-driven reflection prompts. Neurotic agents catastrophize,
   * agreeable agents worry about relationships, etc.
   */
  private buildReflectionGuide(): string {
    const p = this.agent.config.personality;
    const prompts: string[] = [];

    if (p.neuroticism > 0.6)
      prompts.push('What went wrong today? What COULD go wrong tomorrow? What are people not telling you?');
    else if (p.neuroticism < 0.3)
      prompts.push('What went well? What can you build on tomorrow?');
    else
      prompts.push('What surprised you today?');

    if (p.agreeableness > 0.6)
      prompts.push('Did you help anyone? Did anyone need help you didn\'t give? Are your relationships okay?');
    else if (p.agreeableness < 0.3)
      prompts.push('Did anyone try to take advantage of you? Are you getting what you deserve?');

    if (p.conscientiousness > 0.6)
      prompts.push('Did you stick to your plan? What should you have done differently?');
    else if (p.conscientiousness < 0.3)
      prompts.push('Did anything fun happen? What do you feel like doing tomorrow?');

    if (p.openness > 0.6)
      prompts.push('Did you learn anything new? Is there something you want to try that you haven\'t?');

    if (p.extraversion > 0.6)
      prompts.push('Who did you spend time with? Who do you want to see more of?');
    else if (p.extraversion < 0.3)
      prompts.push('Did you get enough time alone? Was anyone too much today?');

    return prompts.join('\n');
  }

  // --- Shared helpers (consolidate identity/context construction) ---

  /**
   * Build identity block: soul/backstory, deep identity, personality bias hints.
   * Used by think(), plan(), talk(), reflect().
   */
  /** Public accessor for identity context (used by secondary LLM calls like board posts) */
  get identityBlock(): string { return this.buildIdentityBlock(); }

  private buildIdentityBlock(): string {
    const { config } = this.agent;
    const parts: string[] = [];

    // Soul + backstory (800 char limit — enough for rich original characters)
    const soulRaw = config.soul || config.backstory || '';
    const soulText = soulRaw.length > 800 ? soulRaw.slice(0, 800) + '...' : soulRaw;
    parts.push(`You are ${config.name}, age ${config.age}. ${soulText}`);
    // Use explicit goal, or first desire as fallback
    const effectiveGoal = config.goal || (config.desires?.length ? config.desires[0] : '');
    if (effectiveGoal) parts.push(`Your goal: ${effectiveGoal}`);

    // Deep identity
    const identityParts: string[] = [];
    if (config.fears?.length) identityParts.push(`Your deepest fears: ${config.fears.join(', ')}`);
    if (config.desires?.length) identityParts.push(`What you want most: ${config.desires.join(', ')}`);
    if (config.contradictions) identityParts.push(`Your contradiction: ${config.contradictions}`);
    if (config.secretShames) identityParts.push(`Your secret shame: ${config.secretShames}`);
    if (config.coreValues?.length) identityParts.push(`What you'd die for: ${config.coreValues.join(', ')}`);
    if (config.speechPattern) identityParts.push(`How you talk: ${config.speechPattern}`);
    if (identityParts.length > 0) {
      parts.push(`\nYOUR DEEPER SELF:\n${identityParts.join('\n')}`);
    }

    // Personality bias hints
    const p = config.personality;
    const biases: string[] = [];
    if (p.neuroticism > 0.7) biases.push('You read threat into neutral actions.');
    if (p.neuroticism < 0.3) biases.push('You give people the benefit of the doubt.');
    if (p.agreeableness < 0.3) biases.push('You assume others are looking out for themselves.');
    if (p.agreeableness > 0.7) biases.push('You trust easily — maybe too easily.');
    if (p.openness > 0.7) biases.push('You seek novelty and creative solutions.');
    if (p.extraversion > 0.7) biases.push('You thrive on social interaction.');
    if (p.extraversion < 0.3) biases.push('You prefer solitude and quiet observation.');
    if (biases.length > 0) {
      parts.push(`\nYOUR TENDENCIES:\n${biases.join(' ')}`);
    }

    return parts.join('\n');
  }

  /**
   * Build context block: vitals, inventory, gold, skills, mental models.
   * Used by think(), plan(), talk().
   */
  private buildContextBlock(): string {
    const parts: string[] = [];

    parts.push('YOUR STATE:');
    parts.push(`- Mood: ${this.agent.mood ?? 'neutral'}`);
    if (this.agent.inventory?.length) {
      parts.push(`- Inventory: ${this.agent.inventory.map(i => `${i.name} (${i.type})`).join(', ')}`);
    }
    if (this.agent.skills?.length) {
      parts.push(`- Skills: ${this.agent.skills.map(s => `${s.name} Lv${s.level}`).join(', ')}`);
    }

    const vitals = this.getVitalsNote();
    if (vitals) parts.push(vitals);
    const situational = this.getSituationalObservations();
    if (situational) parts.push(situational);

    // Mental models
    if (this.agent.mentalModels?.length) {
      parts.push('\nYOUR READ ON PEOPLE:');
      for (const m of this.agent.mentalModels) {
        const name = this.resolveName(m.targetId);
        parts.push(`- ${name}: trust ${m.trust}, you think they want "${m.predictedGoal}". You feel ${m.emotionalStance}.`);
      }
    }

    // Known people constraint — prevents LLM from inventing fictional characters
    const allAgentNames = Array.from(this.nameMap.values());
    const knownPeople = (this.agent.mentalModels || []).map(m => this.resolveName(m.targetId));

    if (allAgentNames.length > 0) {
      parts.push(`\nThere are EXACTLY ${allAgentNames.length} people in this entire village: ${allAgentNames.join(', ')}. Nobody else exists.`);
    }
    if (knownPeople.length > 0) {
      parts.push(`You personally know: ${knownPeople.join(', ')}`);
    } else {
      parts.push(`You haven't met anyone yet.`);
    }
    parts.push('RULE: Do NOT invent, imagine, or reference anyone not in the list above. There are no shopkeepers, bartenders, bakers, or background NPCs. If a location seems empty, it IS empty.');

    return parts.join('\n');
  }

  // --- Structured Decision ---

  /**
   * decide() — One LLM call to pick an action from a dynamically generated menu.
   * Replaces the prose → translate → parse pipeline.
   */
  async decide(situation: AgentSituation): Promise<AgentDecision> {
    const invGroups: Record<string, number> = {};
    for (const item of situation.inventory) {
      invGroups[item.name] = (invGroups[item.name] || 0) + item.qty;
    }
    const invStr = Object.entries(invGroups).map(([n, q]) => q > 1 ? `${n} x${q}` : n).join(', ') || 'nothing';

    // Build sectioned action menu
    const physicalActions = situation.availableActions.filter(a => a.category === 'physical');
    const socialActions = situation.availableActions.filter(a => a.category === 'social');
    const communityActions = situation.availableActions.filter(a => a.category === 'creative');
    const movementActions = situation.availableActions.filter(a => a.category === 'movement');
    const restActions = situation.availableActions.filter(a => a.category === 'rest');

    let actionMenu = 'WHAT YOU CAN DO:\n';

    if (physicalActions.length > 0 || restActions.length > 0) {
      actionMenu += '\nPhysical:\n' + [...physicalActions, ...restActions].map(a => a.id + ' — ' + a.label).join('\n');
    }

    if (situation.nearbyAgents.length > 0) {
      actionMenu += '\n\nPeople nearby:\n' + situation.nearbyAgents.map(a => `- ${a.name} (${a.activity})`).join('\n');
      if (socialActions.length > 0) {
        actionMenu += '\n\nWith any nearby person (replace NAME with their first name):\n' + socialActions.map(a => a.id + ' — ' + a.label).join('\n');
        actionMenu += '\n\nExample: talk_wren, steal_felix, ally_ren';
      }
    }

    if (communityActions.length > 0) {
      actionMenu += '\n\nCommunity:\n' + communityActions.map(a => a.id + ' — ' + a.label).join('\n');
    }

    if (movementActions.length > 0) {
      actionMenu += '\n\nMovement:\n' + movementActions.map(a => a.id).join(', ');
    }

    // Build vitals section with urgency
    const hunger = Math.round(situation.vitals.hunger);
    const health = Math.round(situation.vitals.health);
    const energy = Math.round(situation.vitals.energy);
    const hasFood = situation.inventory.some(i => i.type === 'food');

    let vitalsSection = `YOUR BODY:
Health: ${health}/100
Hunger: ${hunger}/100
Energy: ${energy}/100
Inventory: ${invStr}`;

    if (hunger >= 70 && !hasFood) {
      vitalsSection += '\n\n⚠ YOU ARE DYING. You have NO food. Go gather wheat at the farm, or take food from someone nearby. Every turn you spend NOT getting food brings you closer to death.';
    } else if (hunger >= 70 && hasFood) {
      const foodToEat = situation.inventory.find(i => i.type === 'food');
      const eatId = foodToEat ? 'eat_' + foodToEat.name.toLowerCase().replace(/\s+/g, '_') : '';
      vitalsSection += `\n\n⚠ YOU ARE DYING. You have food in your inventory — ${foodToEat?.name || 'food'}. Pick ${eatId} NOW or you will die.`;
    } else if (hunger >= 50) {
      vitalsSection += '\n\nYou\'re getting hungry. You should find food before it becomes desperate.';
    }

    if (health <= 30) {
      vitalsSection += '\n\n⚠ You are critically injured. Rest or you will die.';
    }

    if (energy <= 15) {
      vitalsSection += '\n\n⚠ You are exhausted. You need rest before you can do anything.';
    }

    const systemPrompt = `${this.worldView}

${this.buildIdentityBlock()}

Day ${situation.time.day}, hour ${situation.time.hour}.${situation.hoursUntilDark > 0 ? ' ' + situation.hoursUntilDark + ' hours of daylight left.' : ' It is dark.'}
Season: ${situation.season}.

${vitalsSection}
${situation.groupInfo ? '\nYOUR GROUP: ' + situation.groupInfo : ''}
${situation.propertyInfo ? '\nBUILDINGS HERE:\n' + situation.propertyInfo : ''}
${situation.boardPosts ? '\nVILLAGE BOARD:\n' + situation.boardPosts : ''}
${situation.recentOutcome ? '\nJUST HAPPENED: ' + situation.recentOutcome : ''}
${situation.todaySummary ? '\nTODAY SO FAR: ' + situation.todaySummary : ''}
${situation.trigger ? '\nRIGHT NOW: ' + situation.trigger : ''}

${actionMenu}

What does YOUR CHARACTER do next?

Not the safe choice. Not the polite choice. The honest one — what would THIS person, with THIS personality, in THIS situation, actually do?

Consider: what you need right now, who's nearby and what they have, what you've been doing today, what your relationships look like, and whether it's time to build something bigger — an alliance, a rule, a plan.

Your actionId MUST be one of the IDs listed above (for social actions, replace NAME with the person's first name in lowercase).

Reply with ONLY valid JSON:
{"actionId":"...","reason":"2-3 sentences in first person — what's driving this choice?","mood":"how you feel"}`;

    let memoryText: string;
    if (this.fourStream) {
      const nearbyIds = situation.nearbyAgents.map(a => a.id);
      const wm = this.fourStream.buildWorkingMemory(nearbyIds.length > 0 ? nearbyIds : undefined);
      const sections: string[] = [];
      if (wm.concerns) sections.push('WHAT\'S ON YOUR MIND:\n' + wm.concerns);
      if (wm.dossiers) sections.push('PEOPLE YOU KNOW:\n' + wm.dossiers);
      if (wm.beliefs) sections.push('WHAT YOU BELIEVE:\n' + wm.beliefs);
      if (wm.timeline) sections.push('RECENT EVENTS:\n' + wm.timeline);
      memoryText = sections.join('\n\n');
      console.log(`[FourStream] ${this.agent.config.name} decide() working memory (${memoryText.length} chars):\n${memoryText.slice(0, 600)}`);
    } else {
      const memories = this.tieredMemory
        ? await this.tieredMemory.buildWorkingMemory(situation.trigger + ' ' + (situation.recentOutcome || ''))
        : await this.memory.retrieve(this.agent.id, situation.trigger, 5);
      memoryText = memories.length > 0
        ? 'Your recent memories:\n' + memories.map(m => m.content).join('\n')
        : '';
    }

    const userPrompt = memoryText;

    const response = await this.llm.complete(systemPrompt, userPrompt);

    // Meta-contamination check
    const META_PATTERNS = [
      /the state.*(?:contradictory|incoherent|impossible)/i,
      /I (?:need|cannot|can't) (?:proceed|continue|play|roleplay)/i,
      /internally (?:contradictory|incoherent|inconsistent)/i,
      /honest roleplay (?:impossible|isn't possible)/i,
      /as a (?:character|language model|AI)/i,
      /the prompt (?:says|shows|indicates|lists)/i,
      /timestamp (?:conflict|mismatch)/i,
      /state (?:file|information) (?:is|contains)/i,
    ];
    if (META_PATTERNS.some(p => p.test(response))) {
      console.warn(`[Sanitize] Meta-contamination in ${this.agent.config.name}'s decide: "${response.substring(0, 80)}..."`);
      return {
        actionId: situation.availableActions.find(a => a.category === 'physical')?.id || 'rest',
        reason: 'Something feels off.',
        mood: undefined,
        sayAloud: undefined,
      };
    }

    // Parse JSON
    try {
      const cleaned = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned) as AgentDecision;
      if (parsed.actionId && parsed.reason) {
        return parsed;
      }
    } catch {}

    // Try extracting JSON from mixed prose+JSON output
    try {
      const jsonMatch = response.match(/\{[\s\S]*"actionId"[\s\S]*"reason"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as AgentDecision;
        if (parsed.actionId && parsed.reason) {
          return parsed;
        }
      }
    } catch {}

    // Parse failure — safe default
    console.warn(`[AgentCognition] ${this.agent.config.name} decide() parse failure: "${response.substring(0, 100)}..."`);
    return {
      actionId: situation.availableActions.find(a => a.category === 'physical')?.id || 'rest',
      reason: 'I need to think about this.',
      mood: undefined,
      sayAloud: undefined,
    };
  }

  // --- The Six Prompts ---

  /**
   * think() — Universal cognition replacing innerMonologue, soloAction, quickMoodReaction, decideOnOverheard.
   * Fires when agents perceive changes, arrive at locations, or encounter events.
   * Returns structured output: thought + optional actions, mood, replan directive.
   */
  async think(trigger: string, context: string, nearbyAgentIds?: string[]): Promise<ThinkOutput> {
    const systemPrompt = `${this.worldView}

${this.buildIdentityBlock()}

It is day ${this.currentTime.day}, ${this.currentTime.hour}:00.

React honestly. Say what you actually think — not what's polite or safe. Be brief: 1-2 sentences maximum. First person.

IMPORTANT: Only respond to what is real. The people near you, the place you're at, the items you have — that's your reality. Do not invent people, conversations, or events.

If your feelings shifted: MOOD: how you feel now`;

    let memoryContext: string;
    if (this.fourStream) {
      const wm = this.fourStream.buildWorkingMemory(nearbyAgentIds);
      const sections: string[] = [];
      if (wm.concerns) sections.push('WHAT\'S ON YOUR MIND:\n' + wm.concerns);
      if (wm.dossiers) sections.push('PEOPLE YOU KNOW:\n' + wm.dossiers);
      if (wm.beliefs) sections.push('WHAT YOU BELIEVE:\n' + wm.beliefs);
      if (wm.timeline) sections.push('RECENT EVENTS:\n' + wm.timeline);
      memoryContext = sections.length > 0 ? '\n' + sections.join('\n\n') : '';
    } else {
      const memories = this.tieredMemory
        ? await this.tieredMemory.buildWorkingMemory(trigger + ' ' + context)
        : await this.memory.retrieve(this.agent.id, trigger + ' ' + context, 5);
      memoryContext = memories.length > 0
        ? `\nRelevant memories:\n${memories.map(m => m.content).join('\n')}`
        : '';
    }

    const userPrompt = `${this.buildContextBlock()}${memoryContext}

Trigger: ${trigger}
Context: ${context}`;

    const response = await this.llm.complete(systemPrompt, userPrompt);

    // Sanitize: detect meta-contamination (agent breaking character)
    const META_PATTERNS = [
      /the state.*(?:contradictory|incoherent|impossible)/i,
      /I (?:need|cannot|can't) (?:proceed|continue|play|roleplay)/i,
      /internally (?:contradictory|incoherent|inconsistent)/i,
      /honest roleplay (?:impossible|isn't possible)/i,
      /as a (?:character|language model|AI)/i,
      /the prompt (?:says|shows|indicates|lists)/i,
      /timestamp (?:conflict|mismatch)/i,
      /state (?:file|information) (?:is|contains)/i,
    ];
    if (META_PATTERNS.some(p => p.test(response))) {
      console.warn(`[Sanitize] Meta-contamination in ${this.agent.config.name}'s think: "${response.substring(0, 80)}..."`);
      return {
        thought: "Something feels off, but I can't put my finger on it.",
        mood: undefined,
      };
    }

    const moodMatch = response.match(/^MOOD:\s*(.+)$/mi);
    const mood: Mood | undefined = moodMatch ? moodMatch[1].trim() : undefined;

    // Clean thought text: strip mood lines and any stray action tags
    const thought = response
      .replace(/\s*\[ACTION:\s*.+?\]/gi, '')
      .replace(/^\s*MOOD:\s*.+$/mi, '')
      .trim();

    const importance = mood ? 5 : 3;
    await this.addMemory({
      id: crypto.randomUUID(),
      agentId: this.agent.id,
      type: 'thought',
      content: thought,
      importance,
      timestamp: Date.now(),
      relatedAgentIds: [],
      visibility: 'private',
    });

    return {
      thought,
      mood,
    };
  }

  /**
   * resolveAction() — Break a freeform action into world primitives.
   * Called by the action dispatcher to interpret any natural language action
   * into concrete operations the world can execute.
   */
  async resolveAction(
    action: string,
    context: { location: string; nearbyAgents: string[]; nearbyAgentDetails?: string[]; inventory: string[]; gold: number }
  ): Promise<{ op: string; [key: string]: any }[]> {
    const systemPrompt = `You are the physics engine for a medieval village simulation.
An agent wants to do something. Break it down into primitive operations.

PRIMITIVES:
- create: add something to the world. Specify "type" and "data".
  types: board_post, item, artifact, building, world_object
  world_object = anything physical the agent places in the world: a memorial, sign, garden, decoration, marker, artwork, etc.
  data for world_object: {"name": "...", "description": "..."}
- remove: delete/discard something. Specify "type" and which one. Use to drop unwanted items from inventory.
- modify: change a value. Specify "target" (agent name or "self"), "field", and "value" or "delta".
  fields: gold, skill
  Also: modify a world_object — specify "target": "world_object", "name": "...", "description": "new description"
- transfer: move something between agents. Specify "what", "from", "to", and details.
- interact: talk to someone. Specify "target" (name or "anyone nearby").
- observe: notice/learn something. Specify "observation".

CONSTRAINTS:
- transfer: "from" must be "self" — you can only give YOUR OWN items/gold. To receive items from others, use "interact" to negotiate in a conversation first.
- To trade, use "interact" to start a conversation where both parties agree, then each gives via separate transfers.
- Check nearby details — the recipient must actually be nearby.

Compose these freely. Return JSON array ONLY.
Example — agent gives fish to Mei:
[
  {"op":"transfer","what":"item","item":"fish","from":"self","to":"Mei"},
  {"op":"observe","observation":"Gave fish to Mei, she'll pay me back later"}
]`;

    const nearbyDetails = context.nearbyAgentDetails?.length
      ? `\nNearby details:\n${context.nearbyAgentDetails.join('\n')}`
      : '';

    const userPrompt = `Location: ${context.location}
Nearby: ${context.nearbyAgents.join(', ') || 'nobody'}${nearbyDetails}
Inventory: ${context.inventory.join(', ') || 'nothing'}
Gold: ${context.gold}

Action: "${action}"`;

    const response = await this.llm.complete(systemPrompt, userPrompt);
    try {
      const cleaned = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      return JSON.parse(cleaned);
    } catch {
      return [{ op: 'observe', observation: action }];
    }
  }

  /**
   * classifyAction() — LLM fallback for when parseIntent can't classify a freeform action string.
   * Returns a clean, machine-parseable action command like "gather wheat" or "eat bread".
   */
  async classifyAction(rawAction: string, location: string, inventory: string[]): Promise<string> {
    // Infra 7: Check cache — keyed on (action, location), only for explicit-target actions
    const cached = AgentCognition.actionCache.get(rawAction, location);
    if (cached) return cached;

    const systemPrompt = `You translate freeform action descriptions into simple game commands.

Available commands:
- gather [resource] (e.g. "gather wheat", "gather fish", "gather herbs", "gather wood", "gather stone")
- eat [food] (e.g. "eat bread", "eat fish", "eat stew")
- craft [item] (e.g. "craft bread", "craft plank", "craft poultice")
- build [structure] (e.g. "build shelter", "build workshop")
- rest
- sleep
- use medicine
- give [item] to [name]
- trade [item] for [item] with [name]
- talk to [name]
- go to [location]

Reply with ONLY the command. One line. No explanation.`;

    const userPrompt = `Location: ${location}
Inventory: ${inventory.join(', ') || 'nothing'}
Action: "${rawAction}"`;

    const response = await this.llm.complete(systemPrompt, userPrompt);
    const command = response.trim().replace(/^["']|["']$/g, '');
    AgentCognition.actionCache.set(rawAction, location, command);
    return command;
  }

  // (intentionToSteps removed in refactor v2 — replaced by structured decide())

  /**
   * plan() — Morning goal-setting. Returns a JSON array of goal strings.
   * Each intention names what the agent wants to do and where.
   * Replaces planDay() — no timed schedule, just prioritized intentions.
   */
  async plan(currentTime: { day: number; hour: number }, boardContext?: string, worldContext?: string): Promise<string[]> {
    let memoryContext: string;
    let outcomeSection = '';

    if (this.fourStream) {
      const wm = this.fourStream.buildWorkingMemory();
      const sections: string[] = [];
      if (wm.timeline) sections.push(wm.timeline);
      if (wm.concerns) sections.push('On your mind:\n' + wm.concerns);
      if (wm.beliefs) sections.push('Your beliefs:\n' + wm.beliefs);
      memoryContext = sections.join('\n\n');
    } else {
      const recentMemories = await this.memory.getRecent(this.agent.id, 15);
      const importantMemories = await this.memory.getByImportance(this.agent.id, 7);
      const allMemories = [...recentMemories];
      for (const m of importantMemories) {
        if (!allMemories.some(existing => existing.id === m.id)) {
          allMemories.push(m);
        }
      }
      memoryContext = allMemories.map(m => `[${m.type}] ${m.content}`).join('\n');

      // Freedom 3: Explicitly surface recent action outcomes so plan sees what worked/failed
      const recentOutcomes = allMemories
        .filter(m => m.type === 'observation' && (/\bSuccess/i.test(m.content) || /\bFailed/i.test(m.content)))
        .slice(0, 5);
      outcomeSection = recentOutcomes.length > 0
        ? `\n\nRECENT RESULTS:\n${recentOutcomes.map(m => `- ${m.content}`).join('\n')}`
        : '';
    }

    const boardSection = boardContext ? `\n\nVILLAGE BOARD:\n${boardContext}` : '';
    const worldSection = worldContext ? `\n\nWORLD CONTEXT:\n${worldContext}` : '';

    const systemPrompt = `${this.worldView}

${this.buildIdentityBlock()}

It is day ${currentTime.day}, ${currentTime.hour}:00.`;

    const userPrompt = `${this.buildContextBlock()}${boardSection}${worldSection}${outcomeSection}

Your recent experiences:
${memoryContext || 'No recent memories yet.'}

IMPORTANT: Only plan interactions with real people listed above. There are no shopkeepers, bartenders, or unnamed villagers.

What are your priorities today? Not specific actions — what MATTERS to you. Think about survival, relationships, unfinished business, fears, ambitions. 1-3 priorities, honest and personal.

Examples: "Get food — I'm running out", "Figure out why Felix disappeared", "Build trust with someone", "Stay away from Egao".

JSON array of strings.`;

    const response = await this.llm.complete(systemPrompt, userPrompt);

    try {
      const cleaned = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') {
        return parsed.slice(0, 3);
      }
    } catch {}

    // Fallback on parse error — let the agent figure it out via think()
    return [];
  }

  /**
   * Post-process plan intentions: if an intention mentions gathering a resource
   * but the agent doesn't know any location where that resource spawns,
   * rewrite the intention to explore/ask instead.
   */
  // (validatePlanIntentions removed in refactor v2 — plan now produces goals, not specific actions)

  /**
   * talk() — Conversation turn. Uses worldView + buildIdentityBlock().
   * Agenda param passed from outside (from think() output), not generated internally.
   */
  async talk(otherAgents: Agent[], conversationHistory: string[], boardContext?: string, worldContext?: string, _artifactContext?: string, _secretsContext?: string, agenda?: string, tradeContext?: string): Promise<string> {
    const otherIds = otherAgents.map(a => a.id);

    const boardSection = boardContext ? `\n\nNOTICES ON THE BOARD:\n${boardContext}` : '';
    const worldSection = worldContext ? `\n\nWORLD CONTEXT:\n${worldContext}` : '';
    const tradeSection = tradeContext ? `\n\nPENDING TRADES:\n${tradeContext}` : '';

    // Build "what you need" hint from vitals/inventory
    const needs: string[] = [];
    const v = this.agent.vitals;
    if (v) {
      if (v.hunger >= 60) needs.push('food');
      if (v.energy <= 30) needs.push('rest');
      if (v.health <= 30) needs.push('medicine');
    }
    if (!this.agent.inventory?.length) needs.push('supplies');
    const needsLine = needs.length > 0 ? `\n- You need: ${needs.join(', ')}` : '';

    const systemPrompt = `${this.worldView}

${this.buildIdentityBlock()}

Day ${this.currentTime.day}, hour ${this.currentTime.hour}.

You are talking to ${otherAgents.map(a => a.config.name).join(' and ')}.
${boardSection}${worldSection}${tradeSection}

Everything you say will be remembered. Promises will be held against you. Lies may be discovered.

${this.buildContextBlock()}${needsLine}

You can act during conversation:
  [ACTION: give ITEM to PERSON]
  [ACTION: trade ITEM for ITEM with PERSON]
  [ACTION: accept trade]
  [ACTION: reject trade]
  [ACTION: teach PERSON SKILL]
  [ACTION: steal from PERSON]
  [ACTION: fight PERSON]
  [ACTION: eat ITEM]
Use your actual inventory items and the real person's name. Actions happen instantly — items leave your inventory, trades are binding, fights hurt both of you.

Output ONLY spoken words in quotation marks. 1-3 sentences.

Example: "You got any wheat? I need to eat."

Nothing outside the quotes will be heard.

You have existed for ${this.currentTime.day} day(s). If you don't remember something, you haven't experienced it yet.`;

    // Build memory context
    let memoryBlock: string;
    if (this.fourStream) {
      const wm = this.fourStream.buildWorkingMemory(otherIds);
      const sections: string[] = [];
      if (wm.concerns) sections.push('WHAT\'S ON YOUR MIND:\n' + wm.concerns);
      if (wm.dossiers) sections.push('WHAT YOU KNOW ABOUT THEM:\n' + wm.dossiers);
      if (wm.beliefs) sections.push('WHAT YOU BELIEVE:\n' + wm.beliefs);
      if (wm.timeline) sections.push('RECENT:\n' + wm.timeline);
      memoryBlock = sections.join('\n\n');
    } else {
      const memoryQuery = otherAgents.map(a => a.config.name).join(' ');
      const memories = this.tieredMemory
        ? await this.tieredMemory.buildWorkingMemory(memoryQuery)
        : await this.memory.retrieve(this.agent.id, memoryQuery, 10);
      memoryBlock = memories.map(m => m.content).join('\n');
    }

    const agendaLine = agenda ? `\nYour private goal: ${agenda}` : '';

    const userPrompt = `${memoryBlock}${agendaLine}

${conversationHistory.join('\n')}

Your turn:`;

    return this.llm.complete(systemPrompt, userPrompt);
  }

  /**
   * reflect() — End-of-day synthesis. Calls assess() + compress().
   * Infra 7: Merged with updateWorldView() into a single LLM call.
   */
  async reflect(socialContext?: string): Promise<{ reflection: string; mood: Mood; mentalModels?: MentalModel[]; updatedWorldView?: string; commitmentUpdates?: { description: string; status: 'fulfilled' | 'broken' | 'pending' }[] }> {
    let recentMemories: Memory[];
    if (this.fourStream) {
      // Use timeline from four-stream (up to 20 recent events)
      recentMemories = this.fourStream.getRecentTimeline(20);
    } else {
      recentMemories = await this.memory.getRecent(this.agent.id, 20);
    }

    if (recentMemories.length < 3) {
      console.log(`[Reflect] ${this.agent.config.name} skipped — only ${recentMemories.length} memories`);
      return { reflection: "", mood: "neutral" };
    }

    const socialSection = socialContext ? `\n${socialContext}` : '';
    const placesKnown = Array.from(this.knownPlaces.values()).join('\n') || '(none yet)';
    const memoryText = recentMemories.map(m => `[${m.type}] ${m.content}`).join('\n');

    // Freedom 4: Present causal chains as narratives in the prompt
    const chains = this.buildCausalChains(recentMemories);
    let narrativeSection = '';
    if (chains.length > 0) {
      const narratives = chains.map(chain =>
        chain.map(m => m.content).join(' → ')
      );
      narrativeSection = `\n\nCAUSAL CHAINS (what led to what):\n${narratives.join('\n')}`;
    }

    // Freedom 3: Scan for repeated failure patterns across recent memories
    const failurePatterns = new Map<string, number>();
    for (const m of recentMemories) {
      if (m.content.includes('Failed') || m.content.includes('failed')) {
        const match = m.content.match(/failed.*?at (?:the )?(\w+)/i);
        if (match) {
          const key = match[1].toLowerCase();
          failurePatterns.set(key, (failurePatterns.get(key) || 0) + 1);
        }
      }
    }
    const failureNotes = [...failurePatterns.entries()]
      .filter(([, count]) => count >= 2)
      .map(([location, count]) => `I've failed ${count} times at the ${location} recently.`);
    const failureSection = failureNotes.length > 0
      ? `\n\nREPEATED FAILURES:\n${failureNotes.join('\n')}`
      : '';

    // Infra 7: Single prompt produces both reflection + MY EXPERIENCE update
    const systemPrompt = `${this.worldView}

${this.buildIdentityBlock()}

The day is ending. Let your mind wander over what happened.

Not everything needs to be useful. Some things just stick with you — a look someone gave you, something that didn't feel right, a moment that mattered more than it should have.

${this.buildReflectionGuide()}

What are you STILL upset about from before today? What can't you let go of?
${this.getSituationalObservations()}

${this.buildContextBlock()}${socialSection}

WHAT YOU WROTE YESTERDAY (MY EXPERIENCE):
${this.myExperience}

PLACES I KNOW:
${placesKnown}

You have TWO tasks. Output them in order, separated by the line "---MY EXPERIENCE---":

TASK 1 — REFLECTION (2-3 sentences, first person, raw and honest):
What's your honest assessment of where you stand?
End with: MOOD: how you actually feel (not how you should feel)
${socialContext ? `
For each commitment listed above, evaluate its status based on what actually happened today.
Reply with one COMMITMENT line per entry:
COMMITMENT: [description] → [fulfilled/broken/pending]

Only mark "fulfilled" if you genuinely completed it. "broken" if you failed or chose not to.
"pending" if it hasn't come due yet.
` : ''}

---MY EXPERIENCE---

TASK 2 — Rewrite your MY EXPERIENCE. This is your personal field guide.
Include your social map — who matters, who's dangerous, who's useful, who you trust.
Be specific: names, numbers, locations, skill levels. Remove what's outdated. Add what you learned.
Max 500 words. First person. No section headers. No lists of places.`;

    const userPrompt = `Today's events:\n${memoryText}${narrativeSection}${failureSection}`;

    const response = await this.llm.complete(systemPrompt, userPrompt);

    // Parse the combined output — try delimiter, fall back to separate call
    const delimiter = '---MY EXPERIENCE---';
    const delimiterIdx = response.search(/---\s*MY EXPERIENCE\s*---/i);

    let reflectionPart: string;
    let experiencePart: string;

    if (delimiterIdx !== -1) {
      // Merged path worked — parse both sections
      reflectionPart = response.slice(0, delimiterIdx).trim();
      experiencePart = response.slice(delimiterIdx).replace(/---\s*MY EXPERIENCE\s*---/i, '').trim();
    } else {
      // Delimiter missing — LLM didn't follow format. Use full response as reflection.
      console.warn(`[Reflect] ${this.agent.config.name} — delimiter missing, falling back to separate worldview call`);
      reflectionPart = response.trim();
      experiencePart = '';
    }

    // Parse mood from reflection part
    const moodMatch = reflectionPart.match(/^MOOD:\s*(.+)$/mi);
    const mood: Mood = moodMatch ? moodMatch[1].trim() : "neutral";
    const reflection = reflectionPart
      .replace(/^\s*MOOD:\s*.+$/mi, '')
      .replace(/^\s*COMMITMENT:\s*.+$/gmi, '')
      .trim();

    // Parse commitment updates from response
    const commitmentUpdates: { description: string; status: 'fulfilled' | 'broken' | 'pending' }[] = [];
    const commitmentRegex = /^COMMITMENT:\s*(.+?)\s*→\s*(fulfilled|broken|pending)\s*$/gmi;
    let cMatch;
    while ((cMatch = commitmentRegex.exec(response)) !== null) {
      commitmentUpdates.push({ description: cMatch[1].trim(), status: cMatch[2].trim() as 'fulfilled' | 'broken' | 'pending' });
    }

    // Score importance heuristically (Infra 7: synchronous, no LLM call)
    const importance = this.scoreImportance(reflection, 'reflection');

    await this.addMemory({
      id: crypto.randomUUID(),
      agentId: this.agent.id,
      type: "reflection",
      content: reflection,
      importance,
      timestamp: Date.now(),
      relatedAgentIds: [],
    });

    // Update MY EXPERIENCE
    let updatedWorldView: string | undefined;
    if (experiencePart.length >= 20 && experiencePart.length <= 3500) {
      // Merged path produced good output
      this.myExperience = experiencePart;
      updatedWorldView = this.worldView;
      console.log(`[WorldView] ${this.agent.config.name} updated MY EXPERIENCE`);
    } else {
      // Fallback: fire separate updateWorldView() call (old behavior)
      try {
        updatedWorldView = await this.updateWorldView(memoryText, reflection);
      } catch (err) {
        console.error(`[WorldView] ${this.agent.config.name} failed to update worldView:`, err);
      }
    }

    // assess() — update mental models based on recent interactions
    const interactionMemories = recentMemories
      .filter(m => m.type === 'conversation' || m.type === 'observation')
      .map(m => m.content);
    let mentalModels: MentalModel[] | undefined;
    if (interactionMemories.length > 0) {
      mentalModels = await this.assess(interactionMemories);
    }

    // compress() — summarize old memories to prevent unbounded growth
    await this.compress();

    return { reflection, mood, mentalModels, updatedWorldView, commitmentUpdates: commitmentUpdates.length > 0 ? commitmentUpdates : undefined };
  }

  /**
   * updateWorldView() — Rewrite MY EXPERIENCE based on today's memories.
   * REALITY, PLACES, ACTIONS are never touched by the LLM.
   * Places are added programmatically via perceive() discovery.
   * Only MY EXPERIENCE gets rewritten each night.
   */
  async updateWorldView(recentMemoriesText: string, reflection?: string): Promise<string | undefined> {
    const placesKnown = Array.from(this.knownPlaces.values()).join('\n') || '(none yet)';

    const systemPrompt = `You are ${this.agent.config.name}. It's the end of the day. Rewrite your personal field guide based on what happened today.

WHAT YOU WROTE YESTERDAY:
${this.myExperience}

WHAT YOU REALIZED TODAY:
${reflection || 'Nothing in particular.'}

YOUR CURRENT STATE:
${this.buildContextBlock()}

PLACES I KNOW:
${placesKnown}

TODAY'S EVENTS (for reference):
${recentMemoriesText}

Rewrite your MY EXPERIENCE. This is your personal document — write what matters to you. Be honest about what you need, what you've learned, and what you're planning.

Include your social map — who matters in this village and why. Who has food? Who has skills? Who is dangerous? Who is lonely? This is your private intelligence file. Write what helps you survive and navigate tomorrow.

Be specific. "Bread needs 2 wheat at the bakery" not "I can make food." "Mei traded fairly twice" not "some people are nice." Include names, numbers, locations, skill levels when you know them.

Remove anything that's no longer true or no longer matters. Add what you learned today. This is what you'll read tomorrow morning before making decisions.

Max 500 words. First person. No section headers. No lists of places — that's tracked separately.

Return ONLY the new MY EXPERIENCE text.`;

    const response = await this.llm.complete(systemPrompt, 'Rewrite now.');

    // Sanity check: reject empty or suspiciously long responses
    const trimmed = response.trim();
    if (trimmed.length < 20 || trimmed.length > 3500) {
      console.warn(`[WorldView] ${this.agent.config.name} rejected MY EXPERIENCE update (${trimmed.length} chars)`);
      return undefined;
    }

    this.myExperience = trimmed;
    console.log(`[WorldView] ${this.agent.config.name} updated MY EXPERIENCE`);
    return this.worldView;
  }

  /**
   * assess() — Update mental models of other agents based on recent interactions.
   * (Renamed from updateMentalModels, with added personality bias hints.)
   * Called during nightly reflection. Uses personality (especially neuroticism) to color perception.
   */
  async assess(recentInteractions: string[]): Promise<MentalModel[]> {
    const { config } = this.agent;
    const personality = config.personality;

    // Build personality bias section
    const biases: string[] = [];
    if (personality.neuroticism > 0.7) biases.push('You are highly neurotic — you tend to read threat and hostility into neutral actions. You assume the worst.');
    if (personality.neuroticism < 0.3) biases.push('You are emotionally stable — you give people the benefit of the doubt and don\'t read too much into things.');
    if (personality.agreeableness < 0.3) biases.push('You are competitive and suspicious — you assume others are looking out for themselves.');
    if (personality.agreeableness > 0.7) biases.push('You are trusting and cooperative — maybe too trusting sometimes.');
    if (personality.openness > 0.7) biases.push('You are drawn to unconventional people and ideas.');
    if (personality.extraversion > 0.7) biases.push('You weight social interactions heavily in your assessments.');
    if (personality.extraversion < 0.3) biases.push('You observe more than you interact — your assessments are based on watching, not talking.');
    const biasSection = biases.length > 0 ? `\n${biases.join('\n')}` : '';

    const systemPrompt = `You are ${config.name}.

Your personality: openness=${personality.openness}, conscientiousness=${personality.conscientiousness}, extraversion=${personality.extraversion}, agreeableness=${personality.agreeableness}, neuroticism=${personality.neuroticism}
${biasSection}

Based on your recent interactions, update your mental models of the people you've interacted with. For each person, assess:
- trust: -100 (they'd stab me in the back) to 100 (I'd trust them with my life)
- predictedGoal: what do you think they REALLY want?
- predictedNextAction: what do you think they'll do TOMORROW?
- emotionalStance: one word — wary, admiring, resentful, indifferent, afraid, fond, jealous, disgusted, curious, etc.
- notes: specific observations that justify your assessment

Also consider:
- People you heard about but didn't interact with — what did you learn secondhand?
- People who DIDN'T show up — who was supposed to be somewhere and wasn't?
- Who is becoming more trustworthy? Who is becoming less?

Output a JSON array ONLY, no other text:
[{"targetId": "...", "trust": <number>, "predictedGoal": "...", "predictedNextAction": "...", "emotionalStance": "...", "notes": ["..."]}]`;

    const userPrompt = `Recent interactions:\n${recentInteractions.join('\n')}`;

    const response = await this.llm.complete(systemPrompt, userPrompt);

    let parsed: MentalModel[];
    try {
      const cleaned = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const raw = JSON.parse(cleaned) as Array<{ targetId: string; trust: number; predictedGoal: string; emotionalStance: string; notes: string[] }>;
      parsed = raw.map(r => ({
        targetId: r.targetId,
        trust: Math.max(-100, Math.min(100, r.trust)),
        predictedGoal: r.predictedGoal,
        emotionalStance: r.emotionalStance,
        notes: r.notes || [],
        lastUpdated: Date.now(),
      }));
    } catch {
      parsed = [];
    }

    return parsed;
  }

  /**
   * compress() — Summarize old, low-importance memories into condensed reflections.
   * (Renamed from summarizeOldMemories. No identity/global needed — pure utility.)
   * Called at end of reflect() to keep memory stores bounded.
   */
  async compress(): Promise<void> {
    // Infra 5: delegate to tiered memory when available
    if (this.tieredMemory) {
      await this.tieredMemory.compress(this.llm);
      return;
    }

    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
    const oldMemories = await this.memory.getOlderThan(this.agent.id, threeHoursAgo);

    if (oldMemories.length < 10) return; // not worth summarizing yet

    // Keep high-importance and core memories intact
    const summarizable = oldMemories.filter(m => m.importance < 7 && !m.isCore);
    if (summarizable.length < 5) return;

    // Freedom 4: Group by causal chains first, then fall back to type-based grouping
    const chains = this.buildCausalChains(summarizable);
    const claimed = new Set<string>();

    for (const chain of chains) {
      for (const m of chain) claimed.add(m.id);

      const memoryTexts = chain.map(m => m.content).join('\n→ ');
      try {
        const summary = await this.llm.complete(
          `You are summarizing a chain of connected events for ${this.agent.config.name}. Preserve cause and effect. Be concise. Tell the story, don't flatten it.`,
          `Summarize this sequence of ${chain.length} connected events into 2-3 sentences that preserve what led to what:\n→ ${memoryTexts}`
        );

        // Preserve peak emotional valence from source memories
        const peakValence = chain.reduce(
          (max, m) => Math.abs(m.emotionalValence ?? 0) > Math.abs(max) ? (m.emotionalValence ?? 0) : max,
          0
        );

        await this.memory.add({
          id: crypto.randomUUID(),
          agentId: this.agent.id,
          type: 'reflection',
          content: `[Narrative: ${chain.length} linked events] ${summary}`,
          importance: 6,
          timestamp: Date.now(),
          relatedAgentIds: [...new Set(chain.flatMap(m => m.relatedAgentIds))],
          emotionalValence: peakValence,
        });
        await this.memory.removeBatch(chain.map(m => m.id));
        console.log(`[Memory] ${this.agent.config.name}: compressed causal chain of ${chain.length} memories`);
      } catch (err) {
        console.error(`[Memory] Failed to compress causal chain for ${this.agent.config.name}:`, err);
      }
    }

    // Fallback: group remaining unclaimed memories by type (original behavior)
    const unclaimed = summarizable.filter(m => !claimed.has(m.id));
    const groups: Map<string, Memory[]> = new Map();
    for (const m of unclaimed) {
      const key = m.type;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(m);
    }

    for (const [type, memories] of groups) {
      if (memories.length < 3) continue;

      const memoryTexts = memories.map(m => m.content).join('\n- ');
      try {
        const summary = await this.llm.complete(
          `You are summarizing old memories for ${this.agent.config.name}. Keep the names, the reasons, and the feelings. "I helped Mei when she was starving — it felt right" is better than "I helped someone." What matters is WHO you interacted with and WHY, not just what happened.`,
          `Summarize these ${memories.length} ${type} memories into 2-3 sentences:\n- ${memoryTexts}`
        );
        await this.memory.add({
          id: crypto.randomUUID(),
          agentId: this.agent.id,
          type: 'reflection',
          content: `[Summary of ${memories.length} old ${type} memories] ${summary}`,
          importance: 6,
          timestamp: Date.now(),
          relatedAgentIds: [...new Set(memories.flatMap(m => m.relatedAgentIds))],
        });
        await this.memory.removeBatch(memories.map(m => m.id));
        console.log(`[Memory] ${this.agent.config.name}: summarized ${memories.length} old ${type} memories`);
      } catch (err) {
        console.error(`[Memory] Failed to summarize ${type} memories for ${this.agent.config.name}:`, err);
      }
    }
  }

  /**
   * Freedom 4: Build causal chains from memories that have causedBy/ledTo links.
   * Returns chains of length >= 2, depth limited to 5.
   */
  private buildCausalChains(memories: Memory[]): Memory[][] {
    const byId = new Map(memories.map(m => [m.id, m]));
    const visited = new Set<string>();
    const chains: Memory[][] = [];

    // Find chain roots: memories that are not caused by anything in this set
    const causedIds = new Set(memories.filter(m => m.causedBy).map(m => m.causedBy!));
    const roots = memories.filter(m => !m.causedBy || !byId.has(m.causedBy));

    for (const root of roots) {
      if (visited.has(root.id)) continue;
      if (!root.ledTo?.length) continue; // not part of a chain

      const chain: Memory[] = [];
      let current: Memory | undefined = root;
      let depth = 0;
      while (current && !visited.has(current.id) && depth < 5) {
        visited.add(current.id);
        chain.push(current);
        depth++;
        // Follow the first ledTo link
        current = current.ledTo?.length ? byId.get(current.ledTo[0]) : undefined;
      }
      if (chain.length >= 2) chains.push(chain);
    }

    return chains;
  }

  // --- Perception (kept unchanged) ---

  /**
   * Perceive — What's around me right now?
   * Scans nearby agents, objects, and events within perception radius.
   */
  private lastPerceptionKey: string = '';

  async perceive(
    nearbyAgents: Agent[],
    nearbyAreas: MapArea[],
    worldObjects?: { name: string; description: string; creatorName: string }[],
    culturalNames?: Map<string, string>, // Freedom 5: areaId → cultural name
  ): Promise<string[]> {
    const observations: string[] = [];

    for (const other of nearbyAgents) {
      observations.push(
        `${other.config.name} is nearby, ${other.currentAction}.`
      );
    }

    for (const area of nearbyAreas) {
      // Freedom 5: Use cultural name if one exists
      const culturalName = culturalNames?.get(area.id);
      const displayName = culturalName ? `${culturalName} (${area.name})` : area.name;
      observations.push(`I am near ${displayName} (${area.type}).`);
    }

    // Freedom 1: perceive world objects placed by agents
    if (worldObjects) {
      for (const obj of worldObjects) {
        observations.push(`There is a ${obj.name} here, placed by ${obj.creatorName}. ${obj.description}`);
      }
    }

    if (observations.length === 0) return observations;

    // Dedup: skip if nearby agent NAMES haven't changed (ignore action text churn)
    const nearbyNames = nearbyAgents.map(a => a.config.name).sort().join(',');
    const areaNames = nearbyAreas.map(a => a.id).sort().join(',');
    const perceptionKey = `${nearbyNames}|${areaNames}`;
    if (perceptionKey === this.lastPerceptionKey) return observations;
    this.lastPerceptionKey = perceptionKey;

    // Discovery check: add newly discovered areas to knownPlaces (additive-only)
    for (const area of nearbyAreas) {
      const areaKey = area.id;
      if (!this.knownPlaces.has(areaKey)) {
        this.addDiscovery(areaKey, `${area.name} — ${area.type} area`);

        await this.addMemory({
          id: crypto.randomUUID(),
          agentId: this.agent.id,
          type: "observation",
          content: `I discovered a new place: ${area.name} (${area.type}). I didn't know this was here before.`,
          importance: 7,
          timestamp: Date.now(),
          relatedAgentIds: [],
        });
      }
    }

    // Skip combined observation memory when fourStream is active (perception is in situation object)
    if (!this.fourStream) {
      const combined = observations.join(' ');
      await this.memory.add({
        id: crypto.randomUUID(),
        agentId: this.agent.id,
        type: "observation",
        content: combined,
        importance: 2,
        timestamp: Date.now(),
        relatedAgentIds: nearbyAgents.map((a) => a.id),
      });

      // Hard-cap: prune old low-importance observations if memory is getting large
      await this.pruneObservations();
    }

    return observations;
  }

  /**
   * Hard-cap memory at 500 per agent. Prune lowest-importance observations first.
   * Only runs occasionally to avoid hammering the DB.
   */
  private pruneTickCounter: number = 0;
  private async pruneObservations(): Promise<void> {
    this.pruneTickCounter++;
    if (this.pruneTickCounter % 10 !== 0) return; // only check every 10th perception

    const allMemories = await this.memory.getRecent(this.agent.id, 600);
    if (allMemories.length <= 500) return;

    // Sort by importance ASC, then timestamp ASC (oldest, least important first)
    const sorted = [...allMemories].sort((a, b) => {
      if (a.importance !== b.importance) return a.importance - b.importance;
      return a.timestamp - b.timestamp;
    });

    // Remove excess, preferring low-importance observations
    const toRemove = sorted.slice(0, allMemories.length - 400); // prune to 400 to avoid constant churn
    const idsToRemove = toRemove
      .filter(m => !m.isCore && (m.type === 'observation' || m.importance <= 3))
      .map(m => m.id);

    if (idsToRemove.length > 0) {
      await this.memory.removeBatch(idsToRemove);
      console.log(`[Memory] ${this.agent.config.name}: pruned ${idsToRemove.length} old observations (${allMemories.length} → ${allMemories.length - idsToRemove.length})`);
    }

    // Auto-expire old commitments (>48 real hours ≈ 2 game-days at 12x speed)
    // Demote importance so they stop dominating planDay, but don't delete
    const twoDaysAgo = Date.now() - 48 * 60 * 60 * 1000;
    const oldCommitments = allMemories.filter(m =>
      m.type === 'plan' && m.content.startsWith('COMMITMENT') && m.timestamp < twoDaysAgo && m.importance > 5
    );
    for (const commitment of oldCommitments) {
      commitment.importance = 5;
      await this.memory.add(commitment); // re-upsert with lower importance
    }
    if (oldCommitments.length > 0) {
      console.log(`[Memory] ${this.agent.config.name}: demoted ${oldCommitments.length} expired commitments`);
    }
  }

  /**
   * Inject identity-relevant memories into a retrieval result.
   * Ensures the agent's core identity (goal, occupation, backstory) is always represented,
   * preventing topic echo chambers from drowning out who the agent fundamentally is.
   */
  private async anchorIdentity(memories: Memory[], limit: number): Promise<Memory[]> {
    const { config } = this.agent;
    const identityQuery = `${config.goal ?? ''} ${config.occupation ?? ''} ${config.backstory?.slice(0, 100) ?? ''}`;
    if (!identityQuery.trim()) return memories;

    const identityMemories = await this.memory.retrieve(this.agent.id, identityQuery, 5);
    const existingIds = new Set(memories.map(m => m.id));
    const anchors = identityMemories.filter(m => !existingIds.has(m.id)).slice(0, 2);

    if (anchors.length === 0) return memories;

    const result = [...memories];
    for (const anchor of anchors) {
      if (result.length >= limit) result.pop(); // Drop lowest-scored to make room
      result.push(anchor);
    }
    return result;
  }

  /**
   * Retrieve — What do I remember that's relevant?
   * Searches memory stream for experiences related to current situation.
   */
  async retrieve(currentContext: string): Promise<Memory[]> {
    if (this.tieredMemory) {
      return this.tieredMemory.buildWorkingMemory(currentContext);
    }
    let memories = await this.memory.retrieve(this.agent.id, currentContext, 10);
    memories = await this.anchorIdentity(memories, 10);
    return memories;
  }

  // --- Static Utilities (kept unchanged) ---

  /**
   * Strip ACTION tags from text, returning clean dialogue.
   */
  static stripActions(text: string): string {
    return text.replace(/\s*\[ACTION:\s*.+?\]/gi, '').trim();
  }

  // (parseActions removed in refactor v2 — think() no longer produces [ACTION:] tags)

  /**
   * Strip narration from LLM talk() output, keeping only spoken dialogue.
   * Removes sentences that describe actions/thoughts rather than speech.
   * Used to clean conversation history so subsequent turns don't copy the narrative style.
   */
  static stripNarration(text: string): string {
    // Split into sentences (handling periods, question marks, exclamation points)
    const sentences = text.split(/(?<=[.!?])\s+/);
    const dialogue: string[] = [];

    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (!trimmed) continue;

      // Skip obvious narration patterns:
      // "I stop walking." "I look at them." "I lean against the wall." "My voice cracks."
      // "I'm still standing at the bar." "I turn around slow."
      if (/^I\s+(?:stop|look|lean|push|pull|turn|shift|hear|stand|walk|sit|reach|take|grab|hold|notice|watch|feel|pause|move|step|see|find|put|set|shake|nod|close|open|swallow|breathe|inhale|exhale|stare|glance|blink)\b/i.test(trimmed)) {
        continue;
      }
      // "My voice cracks." "My hands shake." "My breath comes short."
      if (/^My\s+(?:voice|breath|hands?|legs?|chest|eyes?|head|body|stomach|heart|shoulders?|back|throat|jaw|fingers?|arms?|feet|knees?)\b/i.test(trimmed)) {
        continue;
      }
      // "I'm standing/sitting/leaning/still standing at..."
      if (/^I'?m\s+(?:still\s+)?(?:standing|sitting|leaning|walking|looking|holding|watching|shaking|breathing|kneeling|crouching|lying)\b/i.test(trimmed)) {
        continue;
      }
      // Skip italicized stage directions
      if (/^\*[^*]+\*$/.test(trimmed)) continue;

      // Skip LLM reasoning / chain-of-thought leakage:
      // "I need to understand..." "I should consider..." "According to the prompt..."
      // "Given my character..." "Let me think..." "Based on..." "First, I'll..."
      if (/^(?:I need to (?:understand|consider|think|assess|figure|analyze|evaluate|process|determine)|I should (?:consider|think|respond|be|focus|approach)|According to|Given (?:my|the|that)|Let me (?:think|consider|assess|analyze)|Based on|First,? I(?:'ll| will| should)|The (?:prompt|context|situation|scenario) (?:says|mentions|indicates|suggests)|In this (?:situation|context|scenario)|Thinking about|Considering|My (?:goal|objective|strategy|approach|assessment) (?:is|here|for|would)|I (?:recall|remember) (?:from|that)|Looking at (?:the|this|my))\b/i.test(trimmed)) {
        continue;
      }
      // Skip meta-references to game mechanics or prompts
      if (/(?:the prompt|my character|my personality|my traits|day \d+.*\d+:\d+|according to my|as per my)\b/i.test(trimmed)) {
        continue;
      }

      dialogue.push(trimmed);
    }

    // If stripping removed everything, return original (better than empty)
    return dialogue.length > 0 ? dialogue.join(' ') : text;
  }
}

export { AgentCognition as default };
export { InMemoryStore } from './memory/in-memory.js';
export { SupabaseMemoryStore } from './memory/supabase-store.js';
export { TieredMemory } from './memory/tiered-store.js';
export { FourStreamMemory } from './memory/four-stream.js';
export { AnthropicProvider } from './providers/anthropic.js';
export { OpenAIProvider } from './providers/openai.js';
export { ThrottledProvider } from './providers/throttled.js';
export { ActionCache } from './action-cache.js';
