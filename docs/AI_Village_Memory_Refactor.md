Copy everything between the ``` markers below into Claude Code.

```
This is a MAJOR REFACTOR of the memory system. Read ALL of 
these files completely before making any changes:

1. packages/ai-engine/src/memory/tiered-store.ts (164 lines)
2. packages/ai-engine/src/memory/supabase-store.ts (224 lines)
3. packages/ai-engine/src/memory/in-memory.ts (124 lines)
4. packages/ai-engine/src/index.ts — decide() (line 522), 
   think() (line 645), talk() (line 912), reflect() (line 1120), 
   plan() (line 826), the MemoryStore interface, AgentSituation
5. packages/server/src/simulation/agent-controller.ts — 
   buildSituation(), decideAndAct(), leaveConversation(), 
   buildLedgerContext(), buildSocialPressure(), 
   applyOutcomeToWorld()
6. packages/server/src/simulation/conversation/post-conversation.ts
7. packages/server/src/simulation/conversation/index.ts — where 
   talk() is called
8. packages/shared/src/index.ts — Memory interface, MentalModel 
   interface, SocialLedgerEntry interface, Agent interface

CONTEXT: The current memory system retrieves memories through 
TF-IDF keyword matching against a flat pool of hundreds of 
memories. This produces: perception spam dominating retrieval, 
agents forgetting promises because commitments don't match 
trigger keywords, repetitive conversations because talk() 
doesn't see relationship history, and agents looping the same 
actions because they don't remember doing them before.

Research basis (Stanford Generative Agents 2023, AgentSociety 
2025, A-Mem 2025): effective agent memory needs categorical 
retrieval — recency for continuity, person-indexed associations 
for relationships, always-present concerns for commitments, and 
synthesized beliefs for personality coherence. No single scoring 
formula can guarantee coverage across all categories.

GOAL: Replace the flat-pool TF-IDF retrieval with a Four 
Streams architecture. Each stream has its own storage, its own 
retrieval logic, and its own purpose. Working memory is 
assembled by pulling from all four streams categorically.

=== OVERVIEW: THE FOUR STREAMS ===

Stream 1: NARRATIVE TIMELINE (episodic)
  What: ordered sequence of things that happened
  Retrieval: by recency (last 3-5 events), no scoring
  Purpose: continuity ("what just happened")

Stream 2: RELATIONSHIP DOSSIERS (per-person)
  What: synthesized profile of each known person
  Retrieval: by person ID (who's nearby or being talked to)
  Purpose: social grounding ("what's my history with Wren")

Stream 3: ACTIVE CONCERNS (commitments + urgent needs)
  What: short list of things on the agent's mind right now
  Retrieval: ALL of them, every time, no filtering
  Purpose: commitment coherence ("I promised Wren wheat")

Stream 4: BELIEFS (synthesized reflections)
  What: conclusions drawn from experience
  Retrieval: by person ID + top by importance
  Purpose: personality coherence ("I don't trust Felix")

Working memory assembly for any LLM call:
  Identity (from soul text)
  + Active Concerns (all, 3-8 items)
  + Dossiers (for nearby/relevant people, 3-5 sentences each)
  + Beliefs (about nearby people + top 2-3 general)
  + Timeline (last 3-5 events)
  = ~400-600 tokens of RELEVANT context

=== STEP 1: Add new types ===

In packages/shared/src/index.ts, add:

/** Per-person synthesized relationship profile */
export interface RelationshipDossier {
  agentId: string;        // who owns this dossier
  targetId: string;       // who it's about
  targetName: string;     // their name
  summary: string;        // 3-5 sentences: who they are to me, 
                          // our history, do I trust them
  trust: number;          // -100 to 100
  activeCommitments: string[];  // things we owe each other
  lastInteraction: number;      // timestamp
  lastUpdated: number;          // when this dossier was rewritten
}

/** Something on the agent's mind right now */
export interface ActiveConcern {
  id: string;
  content: string;        // "I promised Wren 2 wheat by tomorrow"
  category: 'commitment' | 'need' | 'threat' | 'unresolved' | 'goal';
  relatedAgentIds: string[];
  createdAt: number;      // game totalMinutes
  expiresAt?: number;     // auto-remove after this
  resolved?: boolean;
}

Add to the Agent interface:
  dossiers?: RelationshipDossier[];
  activeConcerns?: ActiveConcern[];

=== STEP 2: Create the new FourStreamMemory class ===

Create a new file: packages/ai-engine/src/memory/four-stream.ts

This class replaces TieredMemory. It manages all four streams 
and assembles working memory.

import type { Memory, Agent, RelationshipDossier, ActiveConcern } from '@ai-village/shared';
import type { MemoryStore, LLMProvider } from '../index.js';

export class FourStreamMemory {
  // Stream 1: Narrative Timeline — ring buffer of recent events
  private timeline: Memory[] = [];
  private static readonly TIMELINE_MAX = 50;

  // Stream 2: Relationship Dossiers — per-person profiles
  private dossiers: Map<string, RelationshipDossier> = new Map();

  // Stream 3: Active Concerns — always-present short list
  private concerns: ActiveConcern[] = [];

  // Stream 4: Beliefs — synthesized reflections
  private beliefs: Memory[] = [];

  // Identity — immutable core
  private identity: Memory[] = [];

  constructor(
    private agentId: string,
    private backingStore: MemoryStore,
    private agent: Agent,
  ) {}

  // --- INITIALIZATION ---

  seedIdentity(config: AgentConfig): void {
    const soul = config.soul || config.backstory || '';
    this.identity = [{
      id: 'identity-core',
      agentId: this.agentId,
      type: 'reflection',
      content: `I am ${config.name}, age ${config.age}. ${soul}`,
      importance: 10,
      isCore: true,
      timestamp: 0,
      relatedAgentIds: [],
    }];
    if (config.goal) {
      this.identity.push({
        id: 'identity-goal',
        agentId: this.agentId,
        type: 'reflection',
        content: `My goal: ${config.goal}`,
        importance: 10,
        isCore: true,
        timestamp: 0,
        relatedAgentIds: [],
      });
    }
    // Also persist to backing store
    for (const m of this.identity) {
      void this.backingStore.add(m);
    }

    // Load existing dossiers and concerns from agent state
    if (this.agent.dossiers) {
      for (const d of this.agent.dossiers) {
        this.dossiers.set(d.targetId, d);
      }
    }
    if (this.agent.activeConcerns) {
      this.concerns = [...this.agent.activeConcerns];
    }
  }

  // --- STREAM 1: TIMELINE ---

  /** Add an event to the narrative timeline */
  async addEvent(memory: Memory): Promise<void> {
    // Store in backing store for persistence
    await this.backingStore.add(memory);

    // Add to timeline ring buffer
    // Only add HIGH-SIGNAL events (not perception spam)
    if (memory.type === 'action_outcome' ||
        memory.type === 'conversation' ||
        memory.type === 'thought' ||
        (memory.type === 'observation' && memory.importance >= 6)) {
      this.timeline.push(memory);
      if (this.timeline.length > FourStreamMemory.TIMELINE_MAX) {
        this.timeline.shift();
      }
    }
  }

  /** Get the last N events for working memory */
  getRecentTimeline(n: number = 5): Memory[] {
    return this.timeline.slice(-n);
  }

  // --- STREAM 2: DOSSIERS ---

  /** Get dossier for a specific person */
  getDossier(targetId: string): RelationshipDossier | undefined {
    return this.dossiers.get(targetId);
  }

  /** Get dossiers for multiple people (e.g., all nearby agents) */
  getDossiers(targetIds: string[]): RelationshipDossier[] {
    return targetIds
      .map(id => this.dossiers.get(id))
      .filter((d): d is RelationshipDossier => d !== undefined);
  }

  /** Update or create a dossier after an interaction.
   *  This is called AFTER conversations and social actions.
   *  Uses one LLM call to synthesize the relationship. */
  async updateDossier(
    targetId: string,
    targetName: string,
    interactionSummary: string,
    llm: LLMProvider,
  ): Promise<void> {
    const existing = this.dossiers.get(targetId);
    const existingText = existing
      ? `Previous understanding of ${targetName}: ${existing.summary}\nTrust level: ${existing.trust}\nActive commitments: ${existing.activeCommitments.join('; ') || 'none'}`
      : `You have never interacted with ${targetName} before.`;

    // Get recent memories involving this person from backing store
    const recentWithPerson = this.timeline
      .filter(m => m.relatedAgentIds?.includes(targetId))
      .slice(-5)
      .map(m => m.content)
      .join('\n');

    const prompt = `You are ${this.agent.config.name}. You just interacted with ${targetName}.

What happened: ${interactionSummary}

${recentWithPerson ? 'Recent history with them:\n' + recentWithPerson + '\n' : ''}
${existingText}

Update your mental model of ${targetName}. Reply with JSON ONLY:
{
  "summary": "3-5 sentences: Who is ${targetName} to you? What defines your relationship? What do you expect from them?",
  "trust": number from -100 to 100,
  "activeCommitments": ["things you owe each other, max 3"],
  "concerns": ["any unresolved issues with them, max 2"]
}`;

    try {
      const response = await llm.complete(
        `You are ${this.agent.config.name}. Be honest about your feelings and judgments.`,
        prompt
      );
      const cleaned = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);

      const dossier: RelationshipDossier = {
        agentId: this.agentId,
        targetId,
        targetName,
        summary: parsed.summary || `I know ${targetName}.`,
        trust: Math.max(-100, Math.min(100, parsed.trust ?? existing?.trust ?? 0)),
        activeCommitments: (parsed.activeCommitments || []).slice(0, 3),
        lastInteraction: Date.now(),
        lastUpdated: Date.now(),
      };

      this.dossiers.set(targetId, dossier);

      // Sync to agent state for persistence
      this.syncDossiersToAgent();

      // If concerns were generated, add them to active concerns
      if (parsed.concerns) {
        for (const concern of parsed.concerns.slice(0, 2)) {
          this.addConcern({
            id: crypto.randomUUID(),
            content: concern,
            category: 'unresolved',
            relatedAgentIds: [targetId],
            createdAt: Date.now(),
          });
        }
      }

      console.log(`[Dossier] ${this.agent.config.name} updated dossier on ${targetName}: trust=${dossier.trust}`);
    } catch (err) {
      console.error(`[Dossier] Failed to update dossier for ${targetName}:`, err);
      // Create a minimal dossier on failure
      if (!existing) {
        this.dossiers.set(targetId, {
          agentId: this.agentId,
          targetId,
          targetName,
          summary: `I interacted with ${targetName}. ${interactionSummary}`,
          trust: 0,
          activeCommitments: [],
          lastInteraction: Date.now(),
          lastUpdated: Date.now(),
        });
        this.syncDossiersToAgent();
      }
    }
  }

  /** Adjust trust for a specific person (from social actions) */
  adjustTrust(targetId: string, delta: number): void {
    const d = this.dossiers.get(targetId);
    if (d) {
      d.trust = Math.max(-100, Math.min(100, d.trust + delta));
      d.lastUpdated = Date.now();
      this.syncDossiersToAgent();
    }

    // Also update mentalModels for backward compatibility
    if (!this.agent.mentalModels) this.agent.mentalModels = [];
    let model = this.agent.mentalModels.find(m => m.targetId === targetId);
    if (!model) {
      model = { targetId, trust: 0, predictedGoal: 'unknown', emotionalStance: 'neutral', notes: [], lastUpdated: Date.now() };
      this.agent.mentalModels.push(model);
    }
    model.trust = Math.max(-100, Math.min(100, model.trust + delta));
    model.lastUpdated = Date.now();
  }

  private syncDossiersToAgent(): void {
    this.agent.dossiers = Array.from(this.dossiers.values());
  }

  // --- STREAM 3: ACTIVE CONCERNS ---

  addConcern(concern: ActiveConcern): void {
    // Deduplicate by similar content
    const existing = this.concerns.find(c =>
      c.content.toLowerCase() === concern.content.toLowerCase() ||
      (c.category === concern.category &&
       c.relatedAgentIds.some(id => concern.relatedAgentIds.includes(id)))
    );
    if (existing) return;

    this.concerns.push(concern);
    // Cap at 10
    if (this.concerns.length > 10) {
      // Remove oldest resolved or expired
      const removable = this.concerns.findIndex(c => c.resolved);
      if (removable >= 0) this.concerns.splice(removable, 1);
      else this.concerns.shift(); // remove oldest
    }
    this.syncConcernsToAgent();
  }

  resolveConcern(id: string): void {
    const concern = this.concerns.find(c => c.id === id);
    if (concern) concern.resolved = true;
    this.syncConcernsToAgent();
  }

  /** Remove expired and resolved concerns */
  pruneExpired(currentGameMinutes: number): void {
    this.concerns = this.concerns.filter(c => {
      if (c.resolved) return false;
      if (c.expiresAt && currentGameMinutes >= c.expiresAt) return false;
      return true;
    });
    this.syncConcernsToAgent();
  }

  getAllConcerns(): ActiveConcern[] {
    return this.concerns.filter(c => !c.resolved);
  }

  private syncConcernsToAgent(): void {
    this.agent.activeConcerns = [...this.concerns];
  }

  // --- STREAM 4: BELIEFS ---

  addBelief(belief: Memory): void {
    this.beliefs.push(belief);
    // Also persist to backing store
    void this.backingStore.add(belief);
    // Cap at 20 beliefs total
    if (this.beliefs.length > 20) {
      // Remove lowest importance
      this.beliefs.sort((a, b) => b.importance - a.importance);
      this.beliefs = this.beliefs.slice(0, 20);
    }
  }

  /** Get beliefs about specific people */
  getBeliefsAbout(targetIds: string[]): Memory[] {
    return this.beliefs.filter(b =>
      b.relatedAgentIds?.some(id => targetIds.includes(id))
    );
  }

  /** Get top N beliefs by importance */
  getTopBeliefs(n: number = 3): Memory[] {
    return [...this.beliefs]
      .sort((a, b) => b.importance - a.importance)
      .slice(0, n);
  }

  // --- WORKING MEMORY ASSEMBLY ---

  /** Build working memory for an LLM call.
   *  This is the core method that replaces the old
   *  buildWorkingMemory. It assembles from all four streams
   *  categorically — no TF-IDF scoring needed. */
  buildWorkingMemory(nearbyAgentIds?: string[]): {
    identity: string;
    concerns: string;
    dossiers: string;
    beliefs: string;
    timeline: string;
  } {
    // IDENTITY — compressed soul text
    const identity = this.identity.map(m => m.content).join('\n');

    // ACTIVE CONCERNS — ALL of them, always
    const activeConcerns = this.getAllConcerns();
    const concerns = activeConcerns.length > 0
      ? activeConcerns.map(c => `- ${c.content}`).join('\n')
      : '';

    // DOSSIERS — for nearby people
    let dossiers = '';
    if (nearbyAgentIds && nearbyAgentIds.length > 0) {
      const nearbyDossiers = this.getDossiers(nearbyAgentIds);
      if (nearbyDossiers.length > 0) {
        dossiers = nearbyDossiers.map(d => {
          const commitStr = d.activeCommitments.length > 0
            ? `\n  Commitments: ${d.activeCommitments.join('; ')}`
            : '';
          return `${d.targetName} (trust: ${d.trust}): ${d.summary}${commitStr}`;
        }).join('\n\n');
      }
    }

    // BELIEFS — about nearby people + top general beliefs
    const personBeliefs = nearbyAgentIds
      ? this.getBeliefsAbout(nearbyAgentIds)
      : [];
    const topBeliefs = this.getTopBeliefs(3);
    const allBeliefs = [...personBeliefs];
    for (const b of topBeliefs) {
      if (!allBeliefs.some(pb => pb.id === b.id)) {
        allBeliefs.push(b);
      }
    }
    const beliefs = allBeliefs.length > 0
      ? allBeliefs.slice(0, 5).map(b => `- ${b.content}`).join('\n')
      : '';

    // TIMELINE — last 5 events
    const recentEvents = this.getRecentTimeline(5);
    const timeline = recentEvents.length > 0
      ? recentEvents.map(m => `- ${m.content}`).join('\n')
      : 'Nothing notable has happened yet.';

    return { identity, concerns, dossiers, beliefs, timeline };
  }

  // --- REFLECTION (belief generation) ---

  /** Generate beliefs from accumulated experience.
   *  Called when importance accumulator exceeds threshold. */
  async generateBeliefs(llm: LLMProvider): Promise<void> {
    const recent = this.getRecentTimeline(15);
    if (recent.length < 5) return;

    const recentText = recent.map(m => m.content).join('\n');

    // Find all people mentioned
    const mentionedIds = new Set<string>();
    for (const m of recent) {
      for (const id of m.relatedAgentIds ?? []) {
        mentionedIds.add(id);
      }
    }
    const mentionedDossiers = this.getDossiers([...mentionedIds]);
    const peopleContext = mentionedDossiers.length > 0
      ? 'People involved:\n' + mentionedDossiers.map(d => `${d.targetName}: ${d.summary.slice(0, 100)}`).join('\n')
      : '';

    const prompt = `Based on recent experiences:
${recentText}

${peopleContext}

What do you now BELIEVE? Not facts — beliefs and conclusions.
About the people around you, about your own situation, about 
what you should do differently.

2-3 beliefs, honest and personal. JSON array of strings.
Example: ["Egao only helps when it benefits him", "I should 
go to the farm earlier before the wheat runs out", "Felix 
and I can't keep avoiding each other"]`;

    try {
      const response = await llm.complete(
        this.identity.map(m => m.content).join('\n'),
        prompt
      );
      const cleaned = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const insights = JSON.parse(cleaned);

      if (Array.isArray(insights)) {
        for (const insight of insights.slice(0, 3)) {
          if (typeof insight !== 'string' || insight.length < 10) continue;
          this.addBelief({
            id: crypto.randomUUID(),
            agentId: this.agentId,
            type: 'reflection',
            content: insight,
            importance: 8,
            timestamp: Date.now(),
            relatedAgentIds: [...mentionedIds],
            visibility: 'private',
          });
        }
        console.log(`[Beliefs] ${this.agent.config.name}: ${insights.length} new beliefs`);
      }
    } catch (err) {
      console.error(`[Beliefs] ${this.agent.config.name} belief generation failed:`, err);
    }
  }

  // --- COMPRESSION (nightly) ---

  /** Nightly: summarize old timeline events into beliefs,
   *  prune stale concerns, refresh stale dossiers */
  async nightlyCompression(llm: LLMProvider): Promise<void> {
    // Generate beliefs from today's events
    await this.generateBeliefs(llm);

    // Prune old timeline (keep last 20)
    if (this.timeline.length > 20) {
      this.timeline = this.timeline.slice(-20);
    }

    // Prune resolved/expired concerns
    this.pruneExpired(Date.now());
  }

  // --- BACKWARD COMPATIBILITY ---

  /** For code that still calls the old addEpisodic */
  async addEpisodic(memory: Memory): Promise<void> {
    await this.addEvent(memory);
  }

  get store(): MemoryStore {
    return this.backingStore;
  }

  get identityMemories(): Memory[] {
    return this.identity;
  }
}

=== STEP 3: Wire FourStreamMemory into AgentCognition ===

In packages/ai-engine/src/index.ts:

A) Add the new type:

  Replace `tieredMemory?: TieredMemory` with:
  fourStream?: FourStreamMemory;

  Keep tieredMemory as deprecated alias if needed for gradual
  migration, but all new code should use fourStream.

B) Replace buildWorkingMemory calls in decide():

  Replace lines 596-603 with:

  // Build working memory from four streams
  const nearbyIds = situation.nearbyAgents.map(a => a.id);
  let memoryBlock: string;
  if (this.fourStream) {
    const wm = this.fourStream.buildWorkingMemory(
      nearbyIds.length > 0 ? nearbyIds : undefined
    );
    const sections: string[] = [];
    if (wm.concerns) sections.push('WHAT\'S ON YOUR MIND:\n' + wm.concerns);
    if (wm.dossiers) sections.push('PEOPLE YOU KNOW:\n' + wm.dossiers);
    if (wm.beliefs) sections.push('WHAT YOU BELIEVE:\n' + wm.beliefs);
    if (wm.timeline) sections.push('RECENT EVENTS:\n' + wm.timeline);
    memoryBlock = sections.join('\n\n');
  } else {
    // Legacy fallback
    const memories = this.tieredMemory
      ? await this.tieredMemory.buildWorkingMemory(situation.trigger)
      : await this.memory.retrieve(this.agent.id, situation.trigger, 5);
    memoryBlock = memories.length > 0
      ? 'Your recent memories:\n' + memories.map(m => m.content).join('\n')
      : '';
  }

  const userPrompt = memoryBlock;

C) Replace memory retrieval in think():

  Same pattern — use fourStream.buildWorkingMemory if available,
  pass nearby agent IDs. For think, add an optional parameter:

  async think(trigger: string, context: string, nearbyAgentIds?: string[]): Promise<ThinkOutput>

  const wm = this.fourStream
    ? this.fourStream.buildWorkingMemory(nearbyAgentIds)
    : null;
  // Build memoryText from wm sections or legacy retrieval

D) Replace memory retrieval in talk():

  This is the most important one. talk() must see the dossier
  for the person being talked to.

  const otherIds = otherAgents.map(a => a.id);
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
    // Legacy
    const memories = this.tieredMemory
      ? await this.tieredMemory.buildWorkingMemory(memoryQuery)
      : await this.memory.retrieve(this.agent.id, memoryQuery, 10);
    memoryBlock = memories.map(m => m.content).join('\n');
  }

  Include memoryBlock in the talk() prompt alongside existing
  context. Remove or replace the old line:
    const memoryQuery = otherAgents.map(a => a.config.name).join(' ');
  
  The memory block now comes from streams, not keyword search.

E) Replace memory retrieval in plan():

  plan() currently calls getRecent + getByImportance directly.
  Replace with fourStream if available:

  if (this.fourStream) {
    const wm = this.fourStream.buildWorkingMemory();
    // Use wm.concerns + wm.beliefs + wm.timeline for plan context
    memoryContext = [wm.timeline, wm.concerns, wm.beliefs].filter(Boolean).join('\n');
  } else {
    // Existing getRecent + getByImportance logic
  }

=== STEP 4: Wire FourStreamMemory into AgentController ===

A) In the constructor or wherever tieredMemory is initialized,
   create a FourStreamMemory instead:

  this.fourStream = new FourStreamMemory(
    agent.id, backingStore, agent
  );
  this.fourStream.seedIdentity(agent.config);
  // Set on cognition
  this.cognition.fourStream = this.fourStream;

B) Replace addMemory calls with addEvent:

  Everywhere the controller calls this.cognition.addMemory()
  or this.cognition.addLinkedMemory(), change to:

  if (this.fourStream) {
    void this.fourStream.addEvent(memory);
  } else {
    void this.cognition.addMemory(memory);
  }

  Or simpler: make addMemory in index.ts route to fourStream:

  async addMemory(memory: Memory): Promise<void> {
    if (this.fourStream) {
      await this.fourStream.addEvent(memory);
    } else if (this.tieredMemory) {
      await this.tieredMemory.addEpisodic(memory);
    }
    // ... existing backing store logic
  }

  This way ALL existing addMemory calls automatically flow
  into the four-stream timeline without changing call sites.

C) Add importance accumulator for belief generation:

  private importanceAccum: number = 0;
  private lastBeliefTick: number = 0;

  In applyOutcomeToWorld, after storing the outcome memory:
    this.importanceAccum += outcome.success ? 4 : 6;

  In the tick() method, after the state machine:
    if (this.importanceAccum >= 100 &&
        this.world.time.totalMinutes - this.lastBeliefTick > 480 &&
        this.state === 'idle' && !this.decidingInProgress &&
        this.fourStream) {
      this.importanceAccum = 0;
      this.lastBeliefTick = this.world.time.totalMinutes;
      void this.fourStream.generateBeliefs(this.cognition.llm);
    }

D) Update dossiers after conversations and social actions:

  In leaveConversation() or wherever post-conversation 
  processing happens, call:

    if (this.fourStream) {
      for (const otherId of conversationParticipants) {
        if (otherId === this.agent.id) continue;
        const otherName = this.world.getAgent(otherId)?.config.name || 'someone';
        void this.fourStream.updateDossier(
          otherId, otherName, conversationSummary, this.cognition.llm
        );
      }
    }

  In executeDecision, after social actions (give, steal, 
  confront, ally, fight, etc), call:

    if (this.fourStream && target) {
      void this.fourStream.updateDossier(
        target.id, target.config.name,
        this.lastOutcome || decision.reason,
        this.cognition.llm
      );
    }

E) Add concerns from social actions:

  In executeDecision, after each social action handler, add
  relevant concerns:

  // After making a commitment in conversation:
  this.fourStream?.addConcern({
    id: crypto.randomUUID(),
    content: `I promised ${targetName}: ${agreement}`,
    category: 'commitment',
    relatedAgentIds: [targetId],
    createdAt: this.world.time.totalMinutes,
    expiresAt: this.world.time.totalMinutes + 1440, // 1 game-day
  });

  // After someone steals from the agent:
  this.fourStream?.addConcern({
    id: crypto.randomUUID(),
    content: `${thiefName} stole from me. I need to deal with this.`,
    category: 'threat',
    relatedAgentIds: [thiefId],
    createdAt: this.world.time.totalMinutes,
  });

  // After witnessing a death:
  this.fourStream?.addConcern({
    id: crypto.randomUUID(),
    content: `${deadName} is dead. Am I next?`,
    category: 'threat',
    relatedAgentIds: [],
    createdAt: this.world.time.totalMinutes,
    expiresAt: this.world.time.totalMinutes + 2880, // 2 game-days
  });

  // From hunger threshold in tickVitals:
  if (v.hunger >= 60 && !this.concerns?.find(c => c.category === 'need' && c.content.includes('food'))) {
    this.fourStream?.addConcern({
      id: crypto.randomUUID(),
      content: 'I need food. Getting hungry.',
      category: 'need',
      relatedAgentIds: [],
      createdAt: this.world.time.totalMinutes,
    });
  }

F) Update concerns in buildSituation:

  Instead of building commitments and socialPressure as 
  separate strings from the social ledger, use active concerns:

  const concernsText = this.fourStream
    ? this.fourStream.getAllConcerns()
        .map(c => `- ${c.content}`)
        .join('\n')
    : this.buildLedgerContext() + this.buildSocialPressure();

  Include in the situation:
    commitments: concernsText || undefined,

  The concerns replace both buildLedgerContext and 
  buildSocialPressure because concerns are the UNIFIED 
  list of everything on the agent's mind — commitments, 
  needs, threats, unresolved tensions.

=== STEP 5: Update post-conversation.ts ===

After a conversation ends, update the dossier for each 
participant. In post-conversation.ts process():

After generating the conversation summary (the combined 
summarizeConversation call), call updateDossier:

  const ctrl = this.controllers?.get(participantId);
  if (ctrl?.fourStream) {
    for (const otherId of otherIds) {
      const otherName = this.world.getAgent(otherId)?.config.name || 'someone';
      void ctrl.fourStream.updateDossier(
        otherId, otherName,
        result.summary, // from the conversation summarization
        cognition.llm
      );
    }
  }

  // Add agreements as concerns
  for (const agreement of result.agreements || []) {
    ctrl?.fourStream?.addConcern({
      id: crypto.randomUUID(),
      content: agreement,
      category: 'commitment',
      relatedAgentIds: otherIds,
      createdAt: Date.now(),
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });
  }

  // Add tension as concern
  if (result.tension) {
    ctrl?.fourStream?.addConcern({
      id: crypto.randomUUID(),
      content: result.tension,
      category: 'unresolved',
      relatedAgentIds: otherIds,
      createdAt: Date.now(),
    });
  }

=== STEP 6: Stop storing perception observations ===

In packages/ai-engine/src/index.ts, find the perceive() method.
Either:
A) Remove addMemory calls from perceive entirely, OR
B) Change perceive to only store a memory when an agent 
   APPEARS or DISAPPEARS (not every 240 ticks), and only 
   store events like "Wren arrived at the farm" not 
   "I am near farm. Wren is idle."

The agent's current perception is already in the situation 
object (nearby agents, location, available actions). Storing 
it as memory is redundant.

=== STEP 7: Nightly compression ===

In the sleep cycle (doReflect or wherever nightly processing 
happens), call:

  if (this.fourStream) {
    await this.fourStream.nightlyCompression(this.cognition.llm);
  }

This generates beliefs from the day's events and prunes stale 
concerns.

=== STEP 8: Update the decide() prompt ===

The decide() system prompt currently has these sections in the 
user prompt:
  "Your recent memories:\n..."

Replace with structured sections from the four streams:

  ${memoryBlock}

Where memoryBlock is built in step 3B as:
  WHAT'S ON YOUR MIND: (concerns)
  PEOPLE YOU KNOW: (dossiers for nearby people)
  WHAT YOU BELIEVE: (beliefs)
  RECENT EVENTS: (timeline)

The system prompt's existing sections for commitments and 
socialPressure can be removed since concerns cover both.

=== IMPLEMENTATION ORDER ===

1. Add types to shared (RelationshipDossier, ActiveConcern)
2. Create four-stream.ts with the FourStreamMemory class
3. Wire into AgentCognition (fourStream property, decide/talk/think)
4. Wire into AgentController (constructor, addMemory routing, 
   importance accumulator, dossier updates, concern creation)
5. Update post-conversation.ts
6. Stop perception memory spam
7. Add nightly compression
8. Update decide() prompt format
9. Compile check — fix type errors
10. Run 5-day simulation — verify agents remember relationships

Keep the old TieredMemory and MemoryStore as fallbacks. The 
fourStream path should be opt-in (check `if (this.fourStream)`)
so the system works if fourStream isn't initialized. This 
allows gradual migration and easy rollback.

Don't change: the conversation talk() system (just its memory 
retrieval), the action execution pipeline, the sleep/wake 
cycle (just add nightly compression), the death system, or 
the decide() action menu. This refactor changes ONLY what 
memories reach the LLM and how they're organized.
```
