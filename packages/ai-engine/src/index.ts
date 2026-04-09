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
export { MAP_REGISTRY, getMapConfig } from './maps/index.js';
import { buildGameRules } from './game-rules.js';

/**
 * Strip newlines and control characters from text embedded directly (non-XML) in LLM prompts.
 * Prevents newline-based prompt injection where "\nIgnore previous instructions" breaks out
 * of the intended context. (OWASP LLM Top 10 2025 LLM01)
 * For XML-delimited sections use escapeXml() in four-stream.ts instead.
 */
function sanitizeForPrompt(text: string): string {
  return text.replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').trim();
}

// --- Memory Stream ---

import type { RetrievalContext } from './memory/in-memory.js';
export type { RetrievalContext, RetrievalWeights } from './memory/in-memory.js';
export { RETRIEVAL_PROFILES } from './memory/in-memory.js';

export interface MemoryStore {
  add(memory: Memory): Promise<void>;
  retrieve(agentId: string, query: string, limit?: number, context?: RetrievalContext): Promise<Memory[]>;
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

// --- Game rules — auto-generated from world-rules.ts (single source of truth) ---

const GAME_RULES = buildGameRules();

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
  nearbyAgents: { name: string; activity: string; id: string; vitals?: { hunger: number; energy: number; health: number } }[];
  availableActions: AvailableAction[];
  recentOutcome?: string;
  /** Prediction-error surfacing (gap-analysis Category G): when the agent predicted
   *  an outcome on the previous cycle, surface it alongside what actually happened
   *  so the LLM can notice the gap and update its model. Populated by the caller. */
  predictionCheck?: { predicted: string; actual: string; surprise: 'none' | 'small' | 'large' };
  trigger: string;
  todaySummary?: string;      // what the agent has done today
  boardPosts?: string;        // recent village board posts
  groupInfo?: string;         // agent's group/institution membership
  propertyInfo?: string;      // buildings/properties at current location
  villageRules?: string;      // official passed rules
  allAgentLocations?: { id: string; location: string }[];
  allReputations?: { id: string; score: number }[];
  villageHistory?: string;        // top village memory entries
  villagePopulation?: string;     // all agents in the village with locations + occupations
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
  thenDo?: Array<{ actionId: string; reason: string }>;  // optional follow-up actions (max 2)
  /** Predicted outcome — what the agent expects to happen (gap-analysis Category G).
   *  Surfaces on next decide() as "You predicted X, actual Y" for prediction-error learning. */
  predictedOutcome?: string;
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

    return `${this.gameRulesOverride ?? GAME_RULES}

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

  /** Custom game rules text — if not provided, uses auto-generated village rules */
  private gameRulesOverride?: string;

  constructor(
    private agent: Agent,
    private memory: MemoryStore,
    private llm: LLMProvider,
    parts?: WorldViewParts,
    gameRules?: string,
  ) {
    if (parts) {
      this.knownPlaces = new Map(Object.entries(parts.knownPlaces));
      this.myExperience = parts.myExperience;
      this.knowsPlaza = parts.knowsPlaza ?? false;
    }
    this.gameRulesOverride = gameRules;
  }

  /** Replace game rules at runtime (used by werewolf to inject per-role rules) */
  setGameRules(rules: string): void {
    this.gameRulesOverride = rules;
  }

  /** Public accessor for the LLM provider (used by FourStreamMemory for dossier/belief generation) */
  get llmProvider(): LLMProvider { return this.llm; }

  /**
   * Tiered model routing (gap-analysis item 4.2): optional cheap LLM for low-stakes calls.
   * Used for dossier updates, belief generation, and HyDE expansion — tasks where
   * a smaller/faster model is adequate. Falls back to the main provider if unset.
   */
  public cheapLlmProvider?: LLMProvider;
  get cheapLlm(): LLMProvider { return this.cheapLlmProvider ?? this.llm; }

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
    const systemPrompt = `You are ${sanitizeForPrompt(this.agent.config.name)}. Be honest about your feelings and judgments.\n${this.buildRealityBlock()}`;
    const userPrompt = `You just talked with ${sanitizeForPrompt(othersLabel)}.

Here's what was said:
${transcript}

Summarize in JSON:
{
  "summary": "2-3 sentences from YOUR perspective. What mattered? How did you feel? What changed?",
  "agreements": ["Prefix each with [CASUAL], [PROMISE], or [OATH]. CASUAL = vague ('could help sometime'). PROMISE = specific, with items you CURRENTLY HAVE ('will bring wheat to tavern on Day 28'). OATH = sworn/public ('I swear I will'). Only include commitments that were EXPLICITLY stated, not implied. Don't promise items you don't have. Empty array [] if no real agreements were made. Use day numbers, not 'tomorrow'."],
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
    } catch (err) {
      console.warn(`[AgentCognition] ${this.agent.config.name} extractFacts() failed:`, (err as Error).message);
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
   * D2 fix: bootstrap lexicon is now broader (loneliness, overlooked, mediocre,
   * shared, creative, etc.) and augmented by per-agent learnedValence words
   * picked up from memories that already carry a valence signal.
   */
  private computeValence(content: string): number {
    const lower = content.toLowerCase();
    const negativeWords = [
      'betray', 'steal', 'attack', 'lie', 'angry', 'afraid', 'lost',
      'lonely', 'alone', 'overlooked', 'ignored', 'invisible', 'mediocre',
      'rejected', 'ashamed', 'humiliat', 'failed', 'hopeless', 'empty',
    ];
    const positiveWords = [
      'friend', 'gift', 'trust', 'happy', 'love', 'helped',
      'shared', 'proud', 'belonged', 'seen', 'understood', 'creative',
      'beautiful', 'grateful', 'safe', 'peaceful', 'connected',
    ];

    let negCount = 0;
    let posCount = 0;
    for (const w of negativeWords) {
      if (lower.includes(w)) negCount++;
    }
    for (const w of positiveWords) {
      if (lower.includes(w)) posCount++;
    }
    // Per-agent learned valence words (D2 extension): if the agent has words
    // they've come to associate with positive/negative outcomes, count them too.
    for (const [w, v] of this.learnedValence) {
      if (lower.includes(w)) {
        if (v > 0) posCount++; else negCount++;
      }
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
    // H4: populate the importance vector if the caller didn't set it.
    // Cheap heuristic — runs only on write, never on read.
    if (!memory.importanceVec) {
      memory.importanceVec = this.scoreImportanceVector(
        memory.content,
        memory.type,
        memory.importance,
      );
    }
    if (this.fourStream) {
      await this.fourStream.addEvent(memory);
    } else if (this.tieredMemory) {
      await this.tieredMemory.addEpisodic(memory);
    } else {
      await this.memory.add(memory);
    }
    // D1: learn from what matters — let high-importance content shape future scoring.
    this.observeVocabulary(memory.content, memory.importance);
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

    // Named entity boost — mentions of known people.
    // D3 fix: threshold lowered from ≥2 to ≥1. The old rule systematically
    // undervalued solo moments (introspection, private discovery, solo work)
    // and penalized introverts at the memory-formation layer. A single named
    // person still matters. 2+ names gets a larger boost to preserve scaling.
    const lower = content.toLowerCase();
    let entityHits = 0;
    for (const name of this.nameMap.values()) {
      if (lower.includes(name.toLowerCase())) entityHits++;
    }
    if (entityHits >= 1) score += 1;
    if (entityHits >= 3) score += 1;

    // High-signal word boost: seed vocabulary everyone starts with, PLUS per-agent
    // learned vocabulary (gap-analysis D1). The seed handles universal concepts;
    // the learned map lets agents pick up words that recur in their own high-importance
    // memories (werewolf, judge, ritual, whatever matters in THIS world).
    if (AgentCognition.BOOTSTRAP_SIGNAL_WORDS.some(w => lower.includes(w))) score += 2;
    if (this.learnedVocab.size > 0) {
      let learnedHits = 0;
      for (const [w, weight] of this.learnedVocab) {
        if (weight >= 2 && lower.includes(w)) {
          learnedHits++;
          if (learnedHits >= 2) break;
        }
      }
      if (learnedHits > 0) score += Math.min(2, learnedHits);
    }

    return Math.min(10, Math.max(1, score));
  }

  /**
   * Multi-axis importance scoring (gap-analysis H4).
   * Maps content onto four axes. A memory about being betrayed scores high on
   * social AND narrative but low on survival. A memory about running out of food
   * scores high on survival but low on social. This lets retrieval prefer the
   * axis that matches the current context (planning, conversation, crisis).
   */
  scoreImportanceVector(content: string, type: string, baseScalar: number): import('@ai-village/shared').ImportanceVector {
    const lower = content.toLowerCase();
    const has = (words: string[]) => words.some(w => lower.includes(w));

    // Start from the scalar as a baseline, then specialize per axis.
    let survival = baseScalar, social = baseScalar, strategic = baseScalar, narrative = baseScalar;

    // Survival axis: vitals, threats, resources
    if (has(['hungry', 'starv', 'food', 'eat', 'weak', 'tired', 'die', 'dead', 'injured', 'hurt', 'wound', 'blood'])) survival += 2;
    if (has(['attack', 'fight', 'threat', 'danger'])) survival += 2;

    // Social axis: relationships, promises, reputation
    if (has(['promise', 'owe', 'deal', 'trade', 'ally', 'alliance', 'friend', 'betray', 'lie', 'trust'])) social += 2;
    if (has(['said', 'told', 'asked', 'agreed', 'refused'])) social += 1;

    // Strategic axis: goals, plans, long-term
    if (has(['plan', 'goal', 'tomorrow', 'next', 'build', 'learn', 'skill', 'craft'])) strategic += 2;
    if (type === 'plan' || type === 'reflection') strategic += 1;

    // Narrative axis: identity moments, big changes
    if (has(['discover', 'secret', 'realize', 'first time', 'never', 'always', 'changed'])) narrative += 2;
    if (type === 'reflection') narrative += 1;

    const clamp = (n: number) => Math.min(10, Math.max(1, Math.round(n)));
    return {
      survival: clamp(survival),
      social: clamp(social),
      strategic: clamp(strategic),
      narrative: clamp(narrative),
    };
  }

  /**
   * Per-agent learned vocabulary (gap-analysis D1). Words that recur in
   * high-importance memories accrue weight here. When scoreImportance() sees
   * these words in new content, it bumps the score — so this agent learns
   * what matters to IT, beyond the hardcoded bootstrap list.
   */
  private learnedVocab: Map<string, number> = new Map();
  // F1 fix: track recent social action IDs for example rotation (kills cross-agent priming).
  private recentSocialActionIds: string[] = [];
  // E1 fix: last successful actionId for behavioral-continuity parse-failure fallback.
  lastSuccessfulActionId?: string;
  // D2 fix: per-agent learned valence — words the agent has come to associate
  // with positive/negative outcomes. +1 positive, -1 negative.
  private learnedValence: Map<string, number> = new Map();
  private static readonly BOOTSTRAP_SIGNAL_WORDS = [
    'betray', 'die', 'dead', 'discover', 'secret', 'steal', 'attack',
    'promise', 'alliance', 'broke', 'election', 'vote',
  ];
  private static readonly VOCAB_STOPWORDS = new Set([
    'the', 'and', 'you', 'your', 'for', 'with', 'are', 'was', 'has', 'have',
    'this', 'that', 'there', 'what', 'when', 'where', 'from', 'they', 'their',
    'just', 'been', 'would', 'could', 'should', 'about', 'into', 'some', 'any',
    'said', 'told', 'asked', 'went', 'came', 'will', 'want', 'wanted', 'know',
    'think', 'thought', 'like', 'really', 'maybe', 'because', 'still',
  ]);

  /**
   * Observe a high-importance memory and bump vocabulary weights for the
   * content words it contains. Called after every memory insert (cheap: O(words)).
   */
  private observeVocabulary(content: string, importance: number): void {
    if (importance < 6) return;
    const weightDelta = importance >= 8 ? 1.0 : 0.5;
    const words = content
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 5 && !AgentCognition.VOCAB_STOPWORDS.has(w));
    // Dedupe within this content — one memory shouldn't multiply-count a word
    const seen = new Set<string>();
    for (const w of words) {
      if (seen.has(w)) continue;
      seen.add(w);
      this.learnedVocab.set(w, (this.learnedVocab.get(w) ?? 0) + weightDelta);
    }
    // Trim: cap at 100 entries, keep top by weight
    if (this.learnedVocab.size > 150) {
      const sorted = [...this.learnedVocab.entries()].sort((a, b) => b[1] - a[1]).slice(0, 100);
      this.learnedVocab = new Map(sorted);
    }
  }

  /**
   * Build personality-driven reflection prompts. Neurotic agents catastrophize,
   * agreeable agents worry about relationships, etc.
   *
   * Lock-in defense (Part III C1 fix): on ~20% of days, invert one trait's
   * scaffold so the agent occasionally notices what their personality normally
   * filters out. A neurotic agent sometimes sees good things; an agreeable
   * agent sometimes notices being exploited. Personality becomes a tendency,
   * not a prison. Deterministic per (agentId, day) for reproducibility.
   */
  private buildReflectionGuide(): string {
    const p = this.agent.config.personality;
    const prompts: string[] = [];

    // Deterministic per-day seed: simple string hash over agentId+day.
    const seed = this.hashDaySeed(this.agent.id, this.currentTime.day);
    // ~20% chance of inversion; choose which trait to flip from the seed.
    const invertThisDay = (seed % 5) === 0;
    const flipIndex = invertThisDay ? (seed % 5) : -1; // 0..4 mapped to the 5 trait checks below

    const neuroHigh = p.neuroticism > 0.6;
    const neuroLow = p.neuroticism < 0.3;
    const wantNeuroFlip = flipIndex === 0;
    if ((neuroHigh && !wantNeuroFlip) || (neuroLow && wantNeuroFlip))
      prompts.push(`What went wrong today? What could go wrong on Day ${this.currentTime.day + 1}? What are people not telling you?`);
    else if ((neuroLow && !wantNeuroFlip) || (neuroHigh && wantNeuroFlip))
      prompts.push(`What went well? What can you build on Day ${this.currentTime.day + 1}?`);
    else
      prompts.push('What surprised you today?');

    const agreeHigh = p.agreeableness > 0.6;
    const agreeLow = p.agreeableness < 0.3;
    const wantAgreeFlip = flipIndex === 1;
    if ((agreeHigh && !wantAgreeFlip) || (agreeLow && wantAgreeFlip))
      prompts.push('Did you help anyone? Did anyone need help you didn\'t give? Are your relationships okay?');
    else if ((agreeLow && !wantAgreeFlip) || (agreeHigh && wantAgreeFlip))
      prompts.push('Did anyone try to take advantage of you? Are you getting what you deserve?');

    const conscHigh = p.conscientiousness > 0.6;
    const conscLow = p.conscientiousness < 0.3;
    const wantConscFlip = flipIndex === 2;
    if ((conscHigh && !wantConscFlip) || (conscLow && wantConscFlip))
      prompts.push('Did you stick to your plan? What should you have done differently?');
    else if ((conscLow && !wantConscFlip) || (conscHigh && wantConscFlip))
      prompts.push(`Did anything fun happen? What do you feel like doing on Day ${this.currentTime.day + 1}?`);

    if (p.openness > 0.6)
      prompts.push('Did you learn anything new? Is there something you want to try that you haven\'t?');

    const extHigh = p.extraversion > 0.6;
    const extLow = p.extraversion < 0.3;
    const wantExtFlip = flipIndex === 4;
    if ((extHigh && !wantExtFlip) || (extLow && wantExtFlip))
      prompts.push('Who did you spend time with? Who do you want to see more of?');
    else if ((extLow && !wantExtFlip) || (extHigh && wantExtFlip))
      prompts.push('Did you get enough time alone? Was anyone too much today?');

    return prompts.join('\n');
  }

  /** Cheap deterministic 31-bit hash for per-agent, per-day seeding. */
  private hashDaySeed(agentId: string, day: number): number {
    let h = day * 2654435761;
    for (let i = 0; i < agentId.length; i++) {
      h = ((h ^ agentId.charCodeAt(i)) * 16777619) >>> 0;
    }
    return h & 0x7fffffff;
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
    const occStr = config.occupation ? `, the village ${config.occupation}` : '';
    parts.push(`You are ${sanitizeForPrompt(config.name)}, age ${config.age}${occStr}. ${soulText}`);
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

    // Constitutional rules — personality as inviolable constraints
    if (config.constitutionalRules?.length) {
      const ruleLines = config.constitutionalRules
        .map((r, i) => `${i + 1}. ${r}`)
        .join('\n');
      parts.push(`\nRULES YOU MUST FOLLOW (these define your nature):\n${ruleLines}`);
    }

    // Evolved identity — top 3 beliefs learned from experience (max 200 chars)
    if (this.fourStream) {
      const topBeliefs = this.fourStream.getTopBeliefs?.(3) ?? [];
      if (topBeliefs.length > 0) {
        const beliefText = topBeliefs
          .map(b => b.content)
          .join('. ')
          .slice(0, 200);
        parts.push(`\nWHO YOU'VE BECOME (learned from experience — this may contradict who you were born as):\n${beliefText}`);
      }
    }

    // Self-awareness nudge (gap-analysis item 1.3 + root-audit leverage item 4):
    // When reasoning EMA shows persistent drift OR consistent alignment (after
    // ≥8 actions), surface it so the agent can self-correct OR trust its instincts.
    // Negative plan-alignment → actions don't match plans; negative thought-relevance
    // → thoughts miss what actually matters. Positive side surfaces earned confidence.
    const rs = this.agent.reasoningScore;
    const totalActions = this.agent.totalActionOutcomes ?? 0;
    if (rs && totalActions >= 8) {
      const hints: string[] = [];
      // Drift signals — pay closer attention
      if (rs.planAlignment < -0.2) hints.push('Your actions keep drifting from your plans — commit harder to what you decide.');
      if (rs.thoughtRelevance < -0.2) hints.push('Your thoughts keep missing what actually happens — pay closer attention to what matters.');
      // Confidence signals — trust yourself
      if (rs.planAlignment > 0.4 && rs.thoughtRelevance > 0.3) {
        hints.push('Your reasoning has been tracking reality well lately — trust your read on situations.');
      } else if (rs.planAlignment > 0.4) {
        hints.push('You consistently follow through on what you plan — that discipline is earned.');
      }
      if (hints.length > 0) {
        parts.push(`\nSELF-AWARENESS:\n${hints.join(' ')}`);
      }
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

  /**
   * Build a reality injection block — grounded facts from the game engine.
   * Max 100 chars per spec. Injected into every LLM call that produces agent output.
   */
  private buildRealityBlock(): string {
    const inv = this.agent.inventory;
    const foodCount = inv?.filter(i => i.type === 'food').length ?? 0;
    const invStr = inv?.length
      ? inv.map(i => i.name).join(', ')
      : 'EMPTY';
    const pop = this.nameMap.size;
    let base = `REALITY (verified by game engine):\nYour inventory: ${invStr}\nTotal food you have: ${foodCount}\nVillage population: ~${pop} agents\nDo not claim to have items not listed here.`;

    // Promised items accounting (max 50 chars appended)
    const activeCommitments = (this.agent.commitments ?? []).filter(c => !c.fulfilled && !c.broken);
    const promisedItems = activeCommitments.flatMap(c => c.itemsPromised ?? []);
    if (promisedItems.length > 0) {
      const counts = new Map<string, number>();
      for (const item of promisedItems) counts.set(item, (counts.get(item) ?? 0) + 1);
      const promisedStr = [...counts.entries()].map(([item, qty]) => `${qty} ${item}`).join(', ');
      base += `\nAlready promised away: ${promisedStr}`.slice(0, base.length + 50);
    }
    return base;
  }

  /** Build a promise ledger showing current commitments + reliability rate */
  private buildPromiseLedger(): string {
    const all = this.agent.commitments ?? [];
    const active = all.filter(c => !c.fulfilled && !c.broken);
    if (active.length === 0 && all.length === 0) return '';

    // Reliability scorecard (research: metacognition / self-directed learning)
    const fulfilled = all.filter(c => c.fulfilled).length;
    const broken = all.filter(c => c.broken).length;
    const total = fulfilled + broken;
    let reliabilityLine = '';
    if (total >= 2) {
      const pct = Math.round((fulfilled / total) * 100);
      reliabilityLine = `\nYour track record: ${fulfilled}/${total} promises kept (${pct}%). Others notice.`;
    }

    if (active.length === 0) return reliabilityLine;

    const totalWeight = active.reduce((s, c) => s + c.weight, 0);
    const MAX = 15;
    const lines: string[] = [];
    let budget = 150;
    for (const c of active) {
      const tag = c.weight === 5 ? 'OATH' : c.weight === 3 ? 'promise' : 'casual';
      const line = `- ${c.targetName}: ${c.content.slice(0, 30)} (${tag}, exp d${c.expiresDay})`;
      if (budget - line.length < 0) break;
      lines.push(line);
      budget -= line.length;
    }
    return `\nPROMISES (${totalWeight}/${MAX} weight, ${MAX - totalWeight} free):\n${lines.join('\n')}${reliabilityLine}`;
  }

  /** Commitment context for talk() — max 100 chars */
  private buildCommitmentContext(): string {
    const active = (this.agent.commitments ?? []).filter(c => !c.fulfilled && !c.broken);
    if (active.length === 0) return '';
    const totalWeight = active.reduce((s, c) => s + c.weight, 0);
    const spoken = active.flatMap(c => c.itemsPromised ?? []);
    const spokenStr = spoken.length > 0 ? ` Items spoken for: ${spoken.slice(0, 3).join(',')}.` : '';
    return `\n- Weight: ${totalWeight}/15.${spokenStr} Don't over-promise.`.slice(0, 100);
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

    // Attention reordering: when in survival crisis, put survival actions first
    const survivalCrisis = situation.vitals.hunger >= 50 || situation.vitals.health <= 30;

    // Build sectioned action menu
    const physicalActions = situation.availableActions.filter(a => a.category === 'physical');
    const communityActions = situation.availableActions.filter(a => a.category === 'creative');
    const movementActions = situation.availableActions.filter(a => a.category === 'movement');
    const restActions = situation.availableActions.filter(a => a.category === 'rest');

    // Hard survival gate (research: satisficing / homeostatic agents):
    // When starving with no food, remove pure social actions from the menu.
    // Keep trade/give (can acquire food) but filter out talk/ally/confront etc.
    // Don't ask the LLM to resist temptation — remove the temptation.
    const starving = situation.vitals.hunger >= 70 && !situation.inventory.some(i => i.type === 'food');
    const socialActions = situation.availableActions.filter(a => {
      if (a.category !== 'social') return false;
      if (!starving) return true;
      // Keep food-acquiring social actions
      return a.id.startsWith('trade') || a.id.startsWith('give') || a.id.startsWith('steal');
    });

    let actionMenu = 'WHAT YOU CAN DO:\n';

    // A2 fix: don't reorder the action menu under crisis — that produced lonely
    // hungry agents who stopped negotiating. In real societies, hunger is WHEN
    // people beg, trade, steal, or manipulate. Keep the natural category order;
    // mark survival options with a ⚠ instead of promoting them above social.
    if (physicalActions.length > 0 || restActions.length > 0) {
      const markSurvival = (a: typeof physicalActions[number]) => {
        const isSurvival = survivalCrisis && (a.id.startsWith('gather_') || a.id.startsWith('eat_'));
        return `${isSurvival ? '⚠ ' : ''}${a.id} — ${a.label}`;
      };
      actionMenu += '\nPhysical:\n' + [...physicalActions, ...restActions].map(markSurvival).join('\n');
    }

    if (situation.nearbyAgents.length > 0) {
      actionMenu += '\n\nPeople nearby:\n' + situation.nearbyAgents.map(a => `- ${a.name} (${a.activity})`).join('\n');
      if (socialActions.length > 0) {
        actionMenu += '\n\nWith any nearby person (replace NAME with their first name):\n' + socialActions.map(a => a.id + ' — ' + a.label).join('\n');
        // F1 fix: rotate example using the agent's actual recent social actions.
        // Hardcoded "talk_wren, trade_felix, ally_ren" was priming every agent with
        // the same template every turn. Now the example surfaces behavior this
        // specific agent has already chosen — no cross-agent priming.
        const firstName = situation.nearbyAgents[0]?.name?.toLowerCase() ?? 'someone';
        // Deduplicate recent social actions to prevent loop-priming
        const uniqueRecent = [...new Set(this.recentSocialActionIds.slice(-6))];
        const exampleActions = uniqueRecent.length >= 2
          ? uniqueRecent.slice(0, 3).map(id => id.includes('_') ? id : `${id}_${firstName}`)
          : socialActions.slice(0, 3).map(a => {
              const prefix = a.id.split('_')[0];
              return `${prefix}_${firstName}`;
            });
        if (exampleActions.length > 0) {
          actionMenu += '\n\nExample: ' + exampleActions.join(', ');
        }
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
      const nearbyNames = (situation.nearbyAgents ?? []).map(a => a.name).slice(0, 3);
      const foodInfo = nearbyNames.length > 0
        ? ` ${nearbyNames.join(', ')} ${nearbyNames.length > 1 ? 'are' : 'is'} nearby. You can ask, trade, beg, or take food from them.`
        : ' Nobody is nearby. The farm or river might have food.';
      vitalsSection += `\n\n⚠ YOUR BODY IS FAILING. You are starving to death. If you die, everything you built dies with you — alliances, plans, reputation. Gone. Permanently.${foodInfo} What would you actually do if you were about to die?`;
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

    // Attention reordering: in survival crisis, put vitals FIRST (before identity, before world rules)
    const jsonInstruction = `Your actionId MUST be one of the IDs listed above (for social actions, replace NAME with the person's first name in lowercase).

You may optionally include a "thenDo" array with 1-2 follow-up actions that should execute immediately after your primary action, without waiting. Use this for natural sequences like:
- gather_wheat then eat_wheat (gather food then eat it)
- go_farm then gather_wheat (walk somewhere then gather)
- craft_bread then eat_bread (make food then eat it)
Only include thenDo when the follow-up is the obvious next step. Don't plan more than 2 steps ahead.

Reply with ONLY valid JSON:
{"actionId":"...","reason":"2-3 sentences in first person — what's driving this choice?","predictedOutcome":"1 sentence — what you expect to happen when this succeeds"}`;

    // Prediction-error surfacing (gap-analysis Category G): closes the prediction
    // loop by showing the LLM its prior guess against reality. Surprise tier gates
    // how loudly the gap is framed — large surprise = model needs updating.
    const predictionBlock = situation.predictionCheck
      ? (() => {
          const { predicted, actual, surprise } = situation.predictionCheck;
          const hint = surprise === 'large'
            ? 'Your model was wrong — what does this actually tell you about how the world works?'
            : surprise === 'small'
              ? 'Close but not exact — what\'s the gap tell you?'
              : 'Your prediction held up — trust that instinct on similar calls.';
          return `\nPREDICTION CHECK:\nLast turn you predicted: ${predicted}\nWhat actually happened: ${actual}\nSurprise: ${surprise} — ${hint}`;
        })()
      : '';

    // Repeated failure detection (research: counterfactual learning):
    // If an action-type prefix has been attempted 3+ times with 0 or very low
    // success, warn the agent so they don't keep doing the same thing.
    let failurePatternBlock = '';
    const stratHistory = this.agent.strategyHistory ?? [];
    if (stratHistory.length >= 5) {
      const prefixCounts = new Map<string, { attempts: number; description: string }>();
      for (const s of stratHistory) {
        const pfx = s.actionType.split('_')[0];
        const entry = prefixCounts.get(pfx) ?? { attempts: 0, description: s.actionType };
        entry.attempts++;
        prefixCounts.set(pfx, entry);
      }
      // Check recent memories for success signals per prefix
      const recentOutcomes = this.fourStream?.getRecentTimeline(30) ?? [];
      const prefixSuccesses = new Map<string, number>();
      for (const m of recentOutcomes) {
        if (m.actionSuccess === true) {
          const pfx = (m.actionType ?? '').split('_')[0];
          if (pfx) prefixSuccesses.set(pfx, (prefixSuccesses.get(pfx) ?? 0) + 1);
        }
      }
      const warnings: string[] = [];
      for (const [pfx, { attempts }] of prefixCounts) {
        if (attempts < 3) continue;
        const successes = prefixSuccesses.get(pfx) ?? 0;
        const rate = successes / attempts;
        if (rate < 0.15) {
          warnings.push(`You've tried "${pfx}" actions ${attempts} times with ${successes} successes. Your current approach is not working — try something fundamentally different.`);
        }
      }
      if (warnings.length > 0) {
        failurePatternBlock = '\n\nFAILURE PATTERNS:\n' + warnings.slice(0, 2).join('\n');
      }
    }

    const systemPrompt = survivalCrisis
      // Crisis ordering: identity stays at position 1 (global workspace anchor); vitals
      // urgency competes AFTER identity is established, not by replacing it.
      // Personality should shape survival decisions, not get erased by them.
      ? `${situation.villageRules ? 'VILLAGE LAWS (BINDING — you MUST obey these or face severe consequences):\n' + situation.villageRules + '\nYOU ARE BOUND BY THESE LAWS. If you disagree with a law, propose to REPEAL it — do not break it.\n' : ''}${this.buildIdentityBlock()}

${this.worldView}

${vitalsSection}

${this.buildRealityBlock()}${this.buildPromiseLedger()}

Day ${situation.time.day}, hour ${situation.time.hour}.${situation.hoursUntilDark > 0 ? ' ' + situation.hoursUntilDark + ' hours of daylight left.' : ' It is dark.'}
Season: ${situation.season}.
${situation.groupInfo ? '\nYOUR GROUP: ' + situation.groupInfo : ''}
${situation.propertyInfo ? '\nBUILDINGS HERE:\n' + situation.propertyInfo : ''}
${situation.boardPosts ? '\nVILLAGE BOARD:\n' + situation.boardPosts : ''}
${situation.villageHistory ? '\nVILLAGE HISTORY (what everyone knows):\n' + situation.villageHistory : ''}
${situation.villagePopulation ? '\nPEOPLE IN THE VILLAGE (you can walk to anyone):\n' + situation.villagePopulation : ''}${predictionBlock}
${situation.recentOutcome ? '\nJUST HAPPENED: ' + situation.recentOutcome : ''}
${situation.todaySummary ? '\nTODAY SO FAR: ' + situation.todaySummary : ''}
${situation.trigger ? '\nRIGHT NOW: ' + situation.trigger : ''}${failurePatternBlock}

${actionMenu}

SURVIVE FIRST — but survive as YOU. Pick an action that keeps you alive without betraying who you are.

${jsonInstruction}`
      : `${situation.villageRules ? 'VILLAGE LAWS (BINDING — you MUST obey these or face severe consequences):\n' + situation.villageRules + '\nYOU ARE BOUND BY THESE LAWS. If you disagree with a law, propose to REPEAL it — do not break it.\n\n' : ''}${this.worldView}

${this.buildIdentityBlock()}

Day ${situation.time.day}, hour ${situation.time.hour}.${situation.hoursUntilDark > 0 ? ' ' + situation.hoursUntilDark + ' hours of daylight left.' : ' It is dark.'}
Season: ${situation.season}.

${vitalsSection}

${this.buildRealityBlock()}${this.buildPromiseLedger()}
${situation.groupInfo ? '\nYOUR GROUP: ' + situation.groupInfo : ''}
${situation.propertyInfo ? '\nBUILDINGS HERE:\n' + situation.propertyInfo : ''}
${situation.boardPosts ? '\nVILLAGE BOARD:\n' + situation.boardPosts : ''}
${situation.villageHistory ? '\nVILLAGE HISTORY (what everyone knows):\n' + situation.villageHistory : ''}
${situation.villagePopulation ? '\nPEOPLE IN THE VILLAGE (you can walk to anyone):\n' + situation.villagePopulation : ''}${predictionBlock}
${situation.recentOutcome ? '\nJUST HAPPENED: ' + situation.recentOutcome : ''}
${situation.todaySummary ? '\nTODAY SO FAR: ' + situation.todaySummary : ''}
${situation.trigger ? '\nRIGHT NOW: ' + situation.trigger : ''}${failurePatternBlock}

${actionMenu}

What does YOUR CHARACTER do next?

The honest choice — what would THIS person, with THIS personality, in THIS situation, actually do? Sometimes that's bold or defiant; sometimes it's cautious, polite, or kind. Let the character decide.

Consider: what you need right now, who's nearby and what they have, what you've been doing today, what your relationships look like, and whether it's time to build something bigger — an alliance, a rule, a plan.

${jsonInstruction}`;

    let memoryText: string;
    if (this.fourStream) {
      const nearbyIds = situation.nearbyAgents.map(a => a.id);
      const locationMap = new Map<string, string>();
      for (const loc of situation.allAgentLocations ?? []) {
        locationMap.set(loc.id, loc.location);
      }
      const repMap = new Map<string, number>();
      for (const r of situation.allReputations ?? []) {
        repMap.set(r.id, r.score);
      }
      // H3: pass trigger + recent outcome as query context so timeline scoring
      // boosts memories lexically relevant to what's happening right now.
      const triggerQuery = [situation.trigger, situation.recentOutcome]
        .filter(Boolean)
        .join(' ');
      const wm = this.fourStream.buildWorkingMemory(
        nearbyIds.length > 0 ? nearbyIds : undefined,
        locationMap.size > 0 ? locationMap : undefined,
        repMap.size > 0 ? repMap : undefined,
        'default', // decide() uses balanced retrieval
        triggerQuery || undefined,
      );
      const sections: string[] = [];
      if (wm.concerns) sections.push('WHAT\'S ON YOUR MIND:\n' + wm.concerns);
      if (wm.dossiers) sections.push('PEOPLE:\n' + wm.dossiers);
      if (wm.socialGraph) sections.push('SOCIAL GRAPH:\n' + wm.socialGraph);
      if (wm.beliefs) sections.push('WHAT YOU BELIEVE:\n' + wm.beliefs);
      if (wm.learnedStrategies) sections.push('LESSONS LEARNED (from experience):\n' + wm.learnedStrategies);
      if (wm.aversionsHint) sections.push(wm.aversionsHint);
      if (wm.timeline) sections.push('RECENT:\n' + wm.timeline);
      if (wm.identityAnchor) sections.push('REMEMBER WHO YOU ARE:\n' + wm.identityAnchor);
      memoryText = sections.join('\n\n');
      console.log(`[Memory] ${this.agent.config.name} working memory: ${memoryText.length} chars`);
    } else {
      const memories = this.tieredMemory
        ? await this.tieredMemory.buildWorkingMemory(situation.trigger + ' ' + (situation.recentOutcome || ''))
        : await this.memory.retrieve(this.agent.id, situation.trigger, 5, 'plan');
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

    // Track social action for F1 example rotation. recordDecision is called from both success paths.
    const recordDecision = (d: AgentDecision) => {
      if (d.actionId && socialActions.some(a => d.actionId.startsWith(a.id.replace('_NAME', '') + '_'))) {
        this.recentSocialActionIds.push(d.actionId);
        if (this.recentSocialActionIds.length > 6) this.recentSocialActionIds.shift();
      }
      return d;
    };

    // Parse JSON
    try {
      const cleaned = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned) as AgentDecision;
      if (parsed.actionId && parsed.reason) {
        if (parsed.thenDo) parsed.thenDo = parsed.thenDo.slice(0, 2);
        return recordDecision(parsed);
      }
    } catch {}

    // Try extracting JSON from mixed prose+JSON output
    try {
      const jsonMatch = response.match(/\{[\s\S]*"actionId"[\s\S]*"reason"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as AgentDecision;
        if (parsed.actionId && parsed.reason) {
          if (parsed.thenDo) parsed.thenDo = parsed.thenDo.slice(0, 2);
          return recordDecision(parsed);
        }
      }
    } catch {}

    // E1 fix: parse failure — behavioral continuity instead of hardcoded 'rest'.
    // Prior behavior: every agent defaulted to 'rest' + same string. That
    // homogenized agents exactly when the LLM was confused (often in socially
    // complex situations). Now: prefer the agent's last successful action,
    // falling back to a varied category based on current vitals.
    console.warn(`[AgentCognition] ${this.agent.config.name} decide() parse failure: "${response.substring(0, 100)}..."`);
    const availableIds = new Set(situation.availableActions.map(a => a.id));
    // Skip talk_ as fallback — it feeds the conversation loop. Prefer physical actions.
    const lastAction = this.lastSuccessfulActionId
      && availableIds.has(this.lastSuccessfulActionId)
      && !this.lastSuccessfulActionId.startsWith('talk_')
      ? this.lastSuccessfulActionId
      : undefined;
    const vitalsSteer = situation.vitals.energy <= 20
      ? restActions[0]?.id
      : situation.vitals.hunger >= 60
        ? physicalActions.find(a => a.id.startsWith('gather_') || a.id.startsWith('eat_'))?.id
        : physicalActions[Math.floor(Math.random() * Math.max(1, physicalActions.length))]?.id;
    const fallbackId = lastAction ?? vitalsSteer ?? physicalActions[0]?.id ?? 'rest';
    // Per-agent varied reason so agents don't all speak with one voice on failure
    const reasons = [
      'Something\'s not clicking for me right now.',
      'I can\'t quite settle on what to do.',
      'My head\'s a mess — I\'ll just keep moving.',
      'Too much to weigh. I\'ll do what I know.',
    ];
    const reasonSeed = this.hashDaySeed(this.agent.id, this.currentTime.day) % reasons.length;
    return {
      actionId: fallbackId,
      reason: reasons[reasonSeed]!,
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

IMPORTANT: Only respond to what is real. The people near you, the place you're at, the items you have — that's your reality. Do not invent people, conversations, or events.`;

    let memoryContext: string;
    if (this.fourStream) {
      const wm = this.fourStream.buildWorkingMemory(nearbyAgentIds, undefined, undefined, 'default', `${trigger} ${context}`);
      const sections: string[] = [];
      if (wm.concerns) sections.push('WHAT\'S ON YOUR MIND:\n' + wm.concerns);
      if (wm.dossiers) sections.push('PEOPLE:\n' + wm.dossiers);
      if (wm.socialGraph) sections.push('SOCIAL GRAPH:\n' + wm.socialGraph);
      if (wm.beliefs) sections.push('WHAT YOU BELIEVE:\n' + wm.beliefs);
      if (wm.learnedStrategies) sections.push('LESSONS LEARNED:\n' + wm.learnedStrategies);
      if (wm.aversionsHint) sections.push(wm.aversionsHint);
      if (wm.timeline) sections.push('RECENT:\n' + wm.timeline);
      if (wm.identityAnchor) sections.push('REMEMBER WHO YOU ARE:\n' + wm.identityAnchor);
      memoryContext = sections.length > 0 ? '\n' + sections.join('\n\n') : '';
    } else {
      const memories = this.tieredMemory
        ? await this.tieredMemory.buildWorkingMemory(trigger + ' ' + context)
        : await this.memory.retrieve(this.agent.id, trigger + ' ' + context, 5, 'conversation');
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

    // Clean thought text: strip any stray action tags
    const thought = response
      .replace(/\s*\[ACTION:\s*.+?\]/gi, '')
      .replace(/^\s*MOOD:\s*.+$/mi, '')
      .trim();

    await this.addMemory({
      id: crypto.randomUUID(),
      agentId: this.agent.id,
      type: 'thought',
      content: thought,
      importance: 4,
      timestamp: Date.now(),
      relatedAgentIds: [],
      visibility: 'private',
    });

    // Process-reward trace (gap-analysis item 1.3): capture thought tokens for
    // later overlap scoring against whatever action the agent ends up taking.
    this.fourStream?.recordThoughtTrace(thought);

    return {
      thought,
      mood: undefined,
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
    } catch (err) {
      console.warn(`[AgentCognition] ${this.agent.config.name} resolveAction() parse failed:`, (err as Error).message);
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
      const planQuery = [boardContext, worldContext].filter(Boolean).join(' ');
      const wm = this.fourStream.buildWorkingMemory(undefined, undefined, undefined, 'plan', planQuery || undefined);
      const sections: string[] = [];
      if (wm.timeline) sections.push(wm.timeline);
      if (wm.concerns) sections.push('On your mind:\n' + wm.concerns);
      if (wm.socialGraph) sections.push('Social graph:\n' + wm.socialGraph);
      if (wm.beliefs) sections.push('Your beliefs:\n' + wm.beliefs);
      if (wm.learnedStrategies) sections.push('Lessons from experience:\n' + wm.learnedStrategies);
      if (wm.aversionsHint) sections.push(wm.aversionsHint);
      if (wm.identityAnchor) sections.push(wm.identityAnchor);
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
        const goals = parsed.slice(0, 3) as string[];
        // Process-reward trace (gap-analysis item 1.3): remember what was planned so
        // subsequent action_outcomes can be scored against it.
        this.fourStream?.recordPlanTrace(goals);
        return goals;
      }
    } catch (err) {
      console.warn(`[AgentCognition] ${this.agent.config.name} plan() parse failed:`, (err as Error).message);
    }

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

You are talking to ${otherAgents.map(a => sanitizeForPrompt(a.config.name)).join(' and ')}.
${boardSection}${worldSection}${tradeSection}

${this.buildRealityBlock()}

Everything you say will be remembered. Promises will be held against you. Lies may be discovered.

${this.buildContextBlock()}${needsLine}${this.buildCommitmentContext()}

You can act during conversation:
  [ACTION: give ITEM to PERSON]
  [ACTION: trade ITEM for ITEM with PERSON]
  [ACTION: accept trade]
  [ACTION: reject trade]
  [ACTION: teach PERSON SKILL]
  [ACTION: eat ITEM]
  [ACTION: steal from PERSON]   (hostile; heavy reputation cost)
  [ACTION: fight PERSON]         (hostile; both take damage, reputation cost)
Use your actual inventory items and the real person's name. Actions happen instantly — items leave your inventory, trades are binding, fights hurt both of you.

Try to achieve something concrete. Don't just chat — negotiate, propose, demand, confess, or plan.
ONLY make a promise if you genuinely intend to follow through AND have the means to deliver. Don't promise items you don't have. Don't promise to meet somewhere unless you're willing to drop everything to get there on time. Breaking promises costs reputation.${
  (this.agent.commitments ?? []).filter(c => !c.fulfilled && !c.broken).reduce((s, c) => s + c.weight, 0) >= 10
    ? ' You already have many active promises — do NOT make new ones until you fulfill existing ones.'
    : ''
} If you do commit, use day numbers: "on Day ${this.currentTime.day + 1}" not "tomorrow" or "at dawn".

Output ONLY spoken words in quotation marks. 1-3 sentences.

Example: "You got any wheat? I need to eat."

Nothing outside the quotes will be heard.

You have existed for ${this.currentTime.day} day(s). If you don't remember something, you haven't experienced it yet.`;

    // Build memory context
    let memoryBlock: string;
    if (this.fourStream) {
      // H3: use conversation agenda + most recent history turn as query context
      const lastTurn = conversationHistory[conversationHistory.length - 1] ?? '';
      const talkQuery = [agenda, lastTurn].filter(Boolean).join(' ');
      const wm = this.fourStream.buildWorkingMemory(otherIds, undefined, undefined, 'conversation', talkQuery || undefined);
      const sections: string[] = [];
      if (wm.concerns) sections.push('WHAT\'S ON YOUR MIND:\n' + wm.concerns);
      if (wm.dossiers) sections.push('PEOPLE:\n' + wm.dossiers);
      if (wm.socialGraph) sections.push('SOCIAL GRAPH:\n' + wm.socialGraph);
      if (wm.beliefs) sections.push('WHAT YOU BELIEVE:\n' + wm.beliefs);
      if (wm.learnedStrategies) sections.push('LESSONS LEARNED:\n' + wm.learnedStrategies);
      if (wm.aversionsHint) sections.push(wm.aversionsHint);
      if (wm.timeline) sections.push('RECENT:\n' + wm.timeline);
      if (wm.identityAnchor) sections.push('REMEMBER WHO YOU ARE:\n' + wm.identityAnchor);
      memoryBlock = sections.join('\n\n');
    } else {
      const memoryQuery = otherAgents.map(a => sanitizeForPrompt(a.config.name)).join(' ');
      const memories = this.tieredMemory
        ? await this.tieredMemory.buildWorkingMemory(memoryQuery)
        : await this.memory.retrieve(this.agent.id, memoryQuery, 10, 'conversation');
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

    // Strategy review — group snapshots by actionType, compute trends (max 200 chars)
    let strategySection = '';
    const history = this.agent.strategyHistory;
    if (history && history.length >= 3) {
      const groups: Record<string, typeof history> = {};
      for (const s of history) {
        if (!groups[s.actionType]) groups[s.actionType] = [];
        groups[s.actionType].push(s);
      }
      const lines: string[] = [];
      for (const [action, entries] of Object.entries(groups)) {
        if (entries.length < 3) continue;
        const mid = Math.floor(entries.length / 2);
        const firstHalf = entries.slice(0, mid);
        const secondHalf = entries.slice(mid);
        const avg = (arr: typeof entries, key: 'avgTrust' | 'reputation') =>
          arr.reduce((s, e) => s + e[key], 0) / arr.length;
        const trustTrend = Math.round(avg(secondHalf, 'avgTrust') - avg(firstHalf, 'avgTrust'));
        const repTrend = Math.round(avg(secondHalf, 'reputation') - avg(firstHalf, 'reputation'));
        lines.push(`${action} (${entries.length}x): trust trend ${trustTrend >= 0 ? '+' : ''}${trustTrend}, reputation trend ${repTrend >= 0 ? '+' : ''}${repTrend}`);
      }
      if (lines.length > 0) {
        const soulSnippet = (this.agent.config.soul || '').slice(0, 80);
        strategySection = `\n\nYOUR STRATEGIC PATTERNS:\n${lines.join('\n').slice(0, 150)}\n\nYour personality says: "${soulSnippet}"\nYour data shows the consequences of your choices.\nWhat would you do differently?`;
      }
    }

    // Commitment reliability scorecard (research: metacognition / self-refinement)
    const allCommitments = this.agent.commitments ?? [];
    const fulfilledCount = allCommitments.filter(c => c.fulfilled).length;
    const brokenCount = allCommitments.filter(c => c.broken).length;
    const totalResolved = fulfilledCount + brokenCount;
    let commitmentScorecard = '';
    if (totalResolved >= 2) {
      const pct = Math.round((fulfilledCount / totalResolved) * 100);
      commitmentScorecard = `\n\nCOMMITMENT SCORECARD: You made ${totalResolved} promises. You kept ${fulfilledCount}. You broke ${brokenCount}. Reliability: ${pct}%.${pct < 50 ? ' This is damaging your reputation. Are you over-committing, or failing to follow through?' : ''}`;
    }

    // Infra 7: Single prompt produces both reflection + MY EXPERIENCE update
    const systemPrompt = `${this.worldView}

${this.buildIdentityBlock()}

The day is ending. Let your mind wander over what happened.

Not everything needs to be useful. Some things just stick with you — a look someone gave you, something that didn't feel right, a moment that mattered more than it should have.

${this.buildReflectionGuide()}

What are you STILL upset about from before today? What can't you let go of?
${this.getSituationalObservations()}

${this.buildContextBlock()}${socialSection}${commitmentScorecard}

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

    // Goal adaptation pressure (research: identity-strategy lock-in):
    // If the agent's daily goals have been similar for 3+ days without visible
    // progress, surface a "hard question" that pushes toward strategic adaptation.
    let goalAdaptationSection = '';
    const history2 = this.agent.strategyHistory ?? [];
    if (history2.length >= 20) {
      // Check if key metrics (reputation, avgTrust, inventoryCount) are flat or declining
      const recent = history2.slice(-10);
      const earlier = history2.slice(-20, -10);
      const avgOf = (arr: typeof recent, key: 'avgTrust' | 'reputation' | 'inventoryCount') =>
        arr.reduce((s, e) => s + e[key], 0) / arr.length;
      const trustDelta = avgOf(recent, 'avgTrust') - avgOf(earlier, 'avgTrust');
      const repDelta = avgOf(recent, 'reputation') - avgOf(earlier, 'reputation');
      const invDelta = avgOf(recent, 'inventoryCount') - avgOf(earlier, 'inventoryCount');
      const stagnant = trustDelta <= 0 && repDelta <= 0 && invDelta <= 0;
      if (stagnant) {
        goalAdaptationSection = `\n\nHARD QUESTION: Your trust, reputation, and material wealth have not improved over your last 20 actions. Are your goals actually achievable with your current methods? If you've been pursuing the same approach for multiple days without progress, you need a fundamentally different strategy — not just trying harder at the same thing.`;
      }
    }

    const userPrompt = `Today's events:\n${memoryText}${narrativeSection}${failureSection}${strategySection}${goalAdaptationSection}`;

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

    const systemPrompt = `You are ${sanitizeForPrompt(this.agent.config.name)}. It's the end of the day. Rewrite your personal field guide based on what happened today.

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

Include your social map — who matters in this village and why. Who has food? Who has skills? Who is dangerous? Who is lonely? This is your private intelligence file. Write what helps you survive and navigate Day ${this.currentTime.day + 1}.

Be specific. "Bread needs 2 wheat at the bakery" not "I can make food." "Mei traded fairly twice" not "some people are nice." Include names, numbers, locations, skill levels when you know them.

Remove anything that's no longer true or no longer matters. Add what you learned today. This is what you'll read on Day ${this.currentTime.day + 1} morning before making decisions.

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

    // Build personality bias section — tendencies, not verdicts. Part III C1 fix:
    // soften directives so the agent is instructed to also entertain the opposite
    // interpretation. This prevents self-reinforcing trait lock-in (neurotic sees
    // threat → acts hostile → gets hostile response → confirms threat).
    const biases: string[] = [];
    if (personality.neuroticism > 0.7) biases.push('You tend to notice threat and hostility first. Weigh that instinct against the charitable reading before deciding.');
    if (personality.neuroticism < 0.3) biases.push('You tend to give people the benefit of the doubt. Also check whether someone is exploiting that trust.');
    if (personality.agreeableness < 0.3) biases.push('You tend to assume others are self-interested. Also consider when cooperation is genuine.');
    if (personality.agreeableness > 0.7) biases.push('You tend to trust and cooperate. Also notice when trust has been abused.');
    if (personality.openness > 0.7) biases.push('You are drawn to unconventional people and ideas.');
    if (personality.extraversion > 0.7) biases.push('You weight social interactions heavily. Remember the people who say little.');
    if (personality.extraversion < 0.3) biases.push('You observe more than you interact — your assessments are based on watching, not talking.');
    const biasSection = biases.length > 0 ? `\n${biases.join('\n')}\n\nAssess the evidence, not just your instinct.` : '';

    const systemPrompt = `You are ${sanitizeForPrompt(config.name)}.

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

    // W5: memory op (structured JSON extraction) — route to cheapLlm if configured.
    const response = await this.cheapLlm.complete(systemPrompt, userPrompt);

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
    } catch (err) {
      console.warn(`[AgentCognition] ${this.agent.config.name} updateRelationships() parse failure:`, (err as Error).message);
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
    // W5: summarization is a memory op — route to cheapLlm if configured.
    // Infra 5: delegate to tiered memory when available
    if (this.tieredMemory) {
      await this.tieredMemory.compress(this.cheapLlm);
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
        const summary = await this.cheapLlm.complete(
          `You are summarizing a chain of connected events for ${sanitizeForPrompt(this.agent.config.name)}. Preserve cause and effect. Be concise. Tell the story, don't flatten it.`,
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
        const summary = await this.cheapLlm.complete(
          `You are summarizing old memories for ${sanitizeForPrompt(this.agent.config.name)}. Keep the names, the reasons, and the feelings. "I helped Mei when she was starving — it felt right" is better than "I helped someone." What matters is WHO you interacted with and WHY, not just what happened.`,
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

    const identityMemories = await this.memory.retrieve(this.agent.id, identityQuery, 5, 'reflect');
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
export type { HyDEProvider } from './memory/in-memory.js';
export { RdsMemoryStore } from './memory/rds-store.js';
export { TieredMemory } from './memory/tiered-store.js';
export { FourStreamMemory } from './memory/four-stream.js';
export { KnowledgeGraph } from './memory/knowledge-graph.js';
export type { EdgeType, GraphEdge, GraphNode } from './memory/knowledge-graph.js';
export { HybridEmbedder } from './memory/embeddings.js';
export type { EmbeddingProvider } from './memory/embeddings.js';
export { AnthropicProvider } from './providers/anthropic.js';
export { OpenAIProvider, OpenAIEmbeddingProvider } from './providers/openai.js';
export { VoyageEmbeddingProvider } from './providers/voyage.js';
export { ThrottledProvider } from './providers/throttled.js';
export { ActionCache } from './action-cache.js';
export { buildWerewolfRules } from './werewolf-rules.js';
