# AI Village — Post-Audit Implementation Plan

## Context

The comprehensive audit scored the simulation at **3/5 overall**: "You'd watch for a few days — the conversations and personality dynamics are genuinely interesting. But you'd lose interest as you notice the economy never evolves, the physical world resets on restart, and agents can't explain WHY they did things."

This document contains the five fixes that move it to **4/5**: "Produces genuine surprises and sustained narrative arcs worth studying."

Each fix is ordered by impact on emergent behavior. Together they take ~12 hours and touch ~8 files.

---

## Fix 1: Wire resource depletion

**Scorecard impact:** Economic complexity 2→4

**Why it matters:** Without scarcity, there's no reason to trade. Without trade, there's no reason to specialize. Without specialization, there's no division of labor. Without division of labor, there are no economic relationships. Without economic relationships, institutions have nothing to govern. Scarcity is the engine that drives every interesting economic and social dynamic in the simulation.

The infrastructure already exists. `world.ts` has `resourcePools` and `depleteResource()`. The gathering system in `world-rules.ts` has `resolveGather()`. The wire between them is missing — gathering never checks pools.

### Changes

**File: action-pipeline.ts (or wherever gather actions are executed)**

Before the gather is granted, check the pool:

```typescript
// Where gather actions are resolved:
const poolKey = `${areaId}:${resource}`;
const poolLevel = world.getResourcePool(poolKey);

// If pool exists and is empty, fail the gather
if (poolLevel !== undefined && poolLevel <= 0) {
  return {
    success: false,
    type: 'gather',
    description: `There's no ${resource} left here. The area has been depleted.`,
    reason: 'resource_depleted',
    remediation: `Try a different area, or wait for resources to regenerate.`,
    energySpent: 2,
    hungerChange: 0,
    healthChange: 0,
    durationMinutes: 5,
  };
}

// Existing gather resolution
const result = resolveGather(gatherDef, agentState, worldState);

// On success, deplete the pool
if (result.success && result.itemsGained) {
  const qty = result.itemsGained[0]?.qty ?? 1;
  world.depleteResource(poolKey, qty);
}
```

**File: world.ts**

Add pool initialization and a getter:

```typescript
// Resource pools: "areaId:resource" → current amount
resourcePools: Map<string, number> = new Map();

// Default max pool per area-resource pair
private static readonly DEFAULT_POOL_SIZE = 20;

getResourcePool(key: string): number | undefined {
  if (!this.resourcePools.has(key)) {
    // Initialize pool on first access
    this.resourcePools.set(key, World.DEFAULT_POOL_SIZE);
  }
  return this.resourcePools.get(key);
}

depleteResource(key: string, amount: number): void {
  const current = this.getResourcePool(key) ?? World.DEFAULT_POOL_SIZE;
  this.resourcePools.set(key, Math.max(0, current - amount));
}
```

**File: engine.ts**

Add hourly regeneration. Subscribe to `hour_changed` or check in the tick loop:

```typescript
regenerateResources(): void {
  const seasonIdx = Math.floor((this.world.time.day - 1) / SEASON_LENGTH) % SEASON_ORDER.length;
  const currentSeason = SEASON_ORDER[seasonIdx];
  const seasonDef = SEASONS[currentSeason];

  for (const spawn of this.world.materialSpawns) {
    const poolKey = `${spawn.areaId}:${spawn.material}`;
    const current = this.world.resourcePools.get(poolKey);
    if (current === undefined) continue;

    const maxPool = 20; // DEFAULT_POOL_SIZE
    if (current >= maxPool) continue;

    // Season multiplier — winter kills farm regen
    const seasonMultiplier = seasonDef.gatherMultipliers?.[spawn.material] ?? 1.0;
    const regenRate = 0.5 * seasonMultiplier; // half unit per game-hour

    const newLevel = Math.min(maxPool, current + regenRate);
    this.world.resourcePools.set(poolKey, newLevel);
  }
}
```

Call `regenerateResources()` when `time.minute === 0` (every game-hour), or subscribe to the `hour_changed` event if the bus is wired.

### What this produces

At 0.5 regen per hour and a pool of 20, a single agent gathering 2 units per attempt can sustain indefinitely. But 4 agents gathering from the same pool will deplete it in ~5 game-hours. The pool takes 40 game-hours (~1.7 game-days) to fully recover from zero. In winter, farm pools don't regenerate at all.

This creates: resource competition → trade necessity → specialization pressure → territorial awareness → institutional justification for resource management.

### Effort: ~2 hours

---

## Fix 2: Populate ledTo and expand causedBy

**Scorecard impact:** Narrative coherence 2→4

**Why it matters:** The entire narrative memory system — `buildCausalChains()`, causal compression in `compress()`, the "CAUSAL CHAINS" section in `reflect()` — is infrastructure waiting for data. `causedBy` is set in 4 of 16 memory creation sites. `ledTo` is set in zero. Since `buildCausalChains()` traverses `ledTo` to build forward chains, it always returns empty arrays.

Without causal chains, agents can't reason about *why* things happened. "I'm hungry because I gave my food to Mei because she was sick because she got caught in the rain" — this kind of narrative is impossible. Agents experience disconnected events, not stories.

### Step 1: Create the addLinkedMemory helper

**File: ai-engine/src/index.ts (AgentCognition class)**

```typescript
/**
 * Add a memory and maintain bidirectional causal links.
 * If causedBy is set, updates the parent memory's ledTo array.
 */
async addLinkedMemory(memory: Memory): Promise<void> {
  if (memory.emotionalValence === undefined) {
    memory.emotionalValence = this.computeValence(memory.content);
  }
  await this.memory.add(memory);

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
      // Parent may have been evicted — link is one-directional, acceptable
    }
  }
}
```

### Step 2: Add getById to memory stores

**File: ai-engine/src/memory/in-memory.ts**

```typescript
async getById(agentId: string, memoryId: string): Promise<Memory | undefined> {
  const memories = this.getAgentMemories(agentId);
  return memories.find(m => m.id === memoryId);
}
```

**File: ai-engine/src/memory/supabase-store.ts**

```typescript
async getById(agentId: string, memoryId: string): Promise<Memory | undefined> {
  const { data, error } = await this.client
    .from('memories')
    .select('data')
    .eq('id', memoryId)
    .eq('agent_id', agentId)
    .single();
  if (error || !data) return undefined;
  return data.data as Memory;
}
```

**File: ai-engine/src/index.ts (MemoryStore interface)**

```typescript
export interface MemoryStore {
  // ... existing methods ...
  getById(agentId: string, memoryId: string): Promise<Memory | undefined>;
}
```

### Step 3: Wire causedBy at all 16 memory creation sites

Each site needs two things: (a) set `causedBy` to the memory ID that triggered this event, and (b) use `addLinkedMemory()` instead of `addMemory()`.

**File: agent-controller.ts**

Site: `followNextIntention()` — store intention as a memory with an ID so outcomes can reference it:

```typescript
followNextIntention(): void {
  const intention = this.intentions[this.currentIntentionIndex];
  this.currentIntentionIndex++;

  // Store intention as memory for causal linking
  const intentionMemoryId = crypto.randomUUID();
  this.currentIntentionMemoryId = intentionMemoryId;
  void this.cognition.addLinkedMemory({
    id: intentionMemoryId,
    agentId: this.agent.id,
    type: 'plan',
    content: `I decided to: ${intention}`,
    importance: 3,
    timestamp: Date.now(),
    relatedAgentIds: [],
    // causedBy: could be the plan() memory ID if tracked
  });

  // ... rest of existing code
}
```

Add `currentIntentionMemoryId: string = ''` as a class field.

Site: `thinkAfterOutcome()` — the outcome memory references the intention:

```typescript
// Where the outcome observation memory is created (~line 681):
void this.cognition.addLinkedMemory({
  id: crypto.randomUUID(),
  agentId: this.agent.id,
  type: 'observation',
  content: outcomeContent,
  importance: 3,
  timestamp: Date.now(),
  relatedAgentIds: [],
  causedBy: this.currentIntentionMemoryId,  // ← link to intention
});
```

Site: `thinkAfterOutcome()` — when new actions are spliced from the outcome:

```typescript
if (output.actions && output.actions.length > 0) {
  const outcomeMemoryId = crypto.randomUUID();
  // Store the think outcome
  void this.cognition.addLinkedMemory({
    id: outcomeMemoryId,
    agentId: this.agent.id,
    type: 'thought',
    content: output.thought,
    importance: 5,
    timestamp: Date.now(),
    relatedAgentIds: [],
    causedBy: this.currentIntentionMemoryId,
  });

  // Store each reactive action linked to the thought
  for (const action of output.actions) {
    void this.cognition.addLinkedMemory({
      id: crypto.randomUUID(),
      agentId: this.agent.id,
      type: 'plan',
      content: `I decided to: ${action}`,
      importance: 4,
      timestamp: Date.now(),
      relatedAgentIds: [],
      causedBy: outcomeMemoryId,  // ← caused by the reactive thought
    });
  }
}
```

Site: `thinkOnEvent()` — vitals threshold observations:

```typescript
// In tickVitals(), when creating the vitals observation:
if (hungerBand > this.lastHungerBand) {
  const vitalsMemId = crypto.randomUUID();
  void this.cognition.addLinkedMemory({
    id: vitalsMemId,
    agentId: this.agent.id,
    type: 'observation',
    content: `I'm getting ${hungerBand === 2 ? 'very hungry' : 'hungry'}. Hunger: ${Math.round(v.hunger)}/100.`,
    importance: hungerBand === 2 ? 7 : 5,
    timestamp: Date.now(),
    relatedAgentIds: [],
    // No causedBy — vitals are root-level triggers
  });
  void this.thinkOnEvent(
    `You're getting hungry.`,
    `Hunger: ${Math.round(v.hunger)}/100. Food: ${foodCount} items.`,
    vitalsMemId,  // pass to thinkOnEvent for downstream linking
  );
}
```

Update `thinkOnEvent` signature to accept optional `causeMemoryId`:

```typescript
async thinkOnEvent(trigger: string, context: string, causeMemoryId?: string): Promise<void> {
  // ... existing code ...
  // When storing the think output as memory:
  await this.cognition.addLinkedMemory({
    // ... existing fields ...
    causedBy: causeMemoryId,
  });
}
```

**File: conversation/post-conversation.ts (or conversation.ts)**

Site: conversation memory — link to the think that initiated the conversation:

```typescript
// The controller should pass the conversation cause ID when entering conversation.
// Store it on the active conversation object.

// When creating conversation memory per participant:
const memory: Memory = {
  id: conversationMemoryId,  // save this ID for downstream linking
  agentId: participantId,
  type: 'conversation',
  content: convContent,
  importance,
  timestamp: Date.now(),
  relatedAgentIds: otherIds,
  causedBy: active.conversationCauseIds?.get(participantId),  // ← from controller
};
await cognition.addLinkedMemory(memory);
```

Site: commitment memory — link to conversation:

```typescript
await cognition.addLinkedMemory({
  // ... existing fields ...
  causedBy: conversationMemoryId,  // ← the conversation that produced the commitment
});
```

Site: hearsay/gossip memory — link to conversation:

```typescript
await listenerCognition.addLinkedMemory({
  // ... existing fields ...
  causedBy: conversationMemoryId,  // ← the conversation the gossip came from
});
```

Site: all six fact extraction memories (place, resource, person, agreement, need, skill) — link to conversation:

```typescript
// In the fact processing loop:
await cognition.addLinkedMemory({
  // ... existing fields ...
  causedBy: conversationMemoryId,
});
```

**File: ai-engine/src/index.ts**

Site: `think()` outcome memory — link to trigger (already has `causedBy` in 4 sites per the audit, just ensure `addLinkedMemory` is used instead of `addMemory`):

```typescript
// In think(), when storing the thought:
await this.addLinkedMemory({
  // ... existing fields ...
  causedBy: triggerMemoryId,  // passed from caller
});
```

Site: `reflect()` — link to the most important recent memory:

```typescript
// In reflect(), after getting recentMemories:
const primaryCause = recentMemories
  .sort((a, b) => b.importance - a.importance)[0];

await this.addLinkedMemory({
  // ... existing reflection memory fields ...
  causedBy: primaryCause?.id,
});
```

Site: `perceive()` observation — no `causedBy` (perceptions are root-level events that start chains). Use `addMemory()` as before — these are leaf nodes.

### Summary of all 16 sites

| Site | File | causedBy source | Use addLinkedMemory? |
|------|------|----------------|---------------------|
| think() outcome | ai-engine/index.ts | trigger memory ID (from caller) | Yes |
| perceive() observation | ai-engine/index.ts | None (root event) | No (addMemory) |
| thinkAfterOutcome() outcome | agent-controller.ts | currentIntentionMemoryId | Yes |
| thinkAfterOutcome() reactive actions | agent-controller.ts | outcome think memory ID | Yes |
| conversation memory | post-conversation.ts | conversation cause ID from controller | Yes |
| commitment memory (self) | post-conversation.ts | conversation memory ID | Yes |
| commitment memory (other) | post-conversation.ts | conversation memory ID | Yes |
| hearsay/gossip memory | post-conversation.ts | conversation memory ID | Yes |
| reflection memory | ai-engine/index.ts | highest-importance recent memory | Yes |
| fact: place | post-conversation.ts | conversation memory ID | Yes |
| fact: resource | post-conversation.ts | conversation memory ID | Yes |
| fact: person | post-conversation.ts | conversation memory ID | Yes |
| fact: agreement | post-conversation.ts | conversation memory ID | Yes |
| fact: need | post-conversation.ts | conversation memory ID | Yes |
| fact: skill | post-conversation.ts | conversation memory ID | Yes |
| vitals threshold observation | agent-controller.ts | None (root event) | No (addLinkedMemory without causedBy) |
| intention/plan memory | agent-controller.ts | plan memory ID (if tracked) or none | Yes |

### What this produces

Agents develop narrative memory: "I'm hungry (vitals) → I went to the farm (intention) → wheat was depleted (outcome) → I asked Mei for help (conversation) → she promised to share (commitment) → she gave me bread (fact)." This chain survives compression because `compress()` groups by causal chain before falling back to type-based grouping. The `reflect()` prompt shows the chain, enabling the LLM to reason about cause and effect across time.

### Effort: ~3 hours

---

## Fix 3: Persist world state to Supabase

**Scorecard impact:** Long-term evolution 2→4

**Why it matters:** The audit found that server restart destroys all world objects, cultural names, resource pool state, and causal memory links. After hours of simulation producing memorials, landmarks, cultural identity, and narrative chains, a restart resets everything. Long-term evolution is impossible without persistence.

### Changes

**File: persistence/supabase.ts**

Expand `WorldStateData`:

```typescript
export interface WorldStateData {
  // ... existing fields (time, weather, conversations, board, elections,
  //     properties, reputation, secrets, items, institutions, artifacts,
  //     buildings, technologies, materialSpawns) ...

  // NEW: persisted world freedom state
  worldObjects: unknown[];
  culturalNames: Record<string, {
    name: string;
    mentionCount: number;
    mentioners: string[];
    lastMentioned: number;
    established: boolean;
  }>;
  resourcePools: Record<string, number>;
}
```

In `saveWorldState()`, add the new fields:

```typescript
async saveWorldState(world: World): Promise<void> {
  const data: WorldStateData = {
    // ... existing serialization ...

    worldObjects: world.worldObjects
      ? Array.from(world.worldObjects.values())
      : [],
    culturalNames: world.culturalNames
      ? Object.fromEntries(world.culturalNames)
      : {},
    resourcePools: world.resourcePools
      ? Object.fromEntries(world.resourcePools)
      : {},
  };

  // ... existing upsert ...
}
```

In `loadWorldState()` (called from `engine.ts:loadFromSupabase`), restore the new fields:

```typescript
// After loading worldData:
if (worldData.worldObjects && Array.isArray(worldData.worldObjects)) {
  for (const obj of worldData.worldObjects) {
    world.addWorldObject(obj as WorldObject);
  }
  console.log(`[Persistence] Restored ${worldData.worldObjects.length} world objects`);
}

if (worldData.culturalNames) {
  world.culturalNames = new Map(Object.entries(worldData.culturalNames));
  const established = [...world.culturalNames.values()].filter(v => v.established).length;
  console.log(`[Persistence] Restored ${world.culturalNames.size} cultural names (${established} established)`);
}

if (worldData.resourcePools) {
  world.resourcePools = new Map(Object.entries(worldData.resourcePools));
  console.log(`[Persistence] Restored ${world.resourcePools.size} resource pools`);
}
```

**File: ai-engine/src/memory/supabase-store.ts**

Persist `causedBy` and `ledTo` on Memory objects. These fields already exist on the Memory interface — they just need to survive the Supabase round-trip.

In the `add()` method (or wherever memories are upserted):

```typescript
async add(memory: Memory): Promise<void> {
  const { error } = await this.client
    .from('memories')
    .upsert({
      id: memory.id,
      agent_id: memory.agentId,
      data: {
        ...memory,
        // Explicitly include causal fields (they may be undefined,
        // which is fine — Supabase stores null)
        causedBy: memory.causedBy ?? null,
        ledTo: memory.ledTo ?? null,
      },
      updated_at: new Date().toISOString(),
    });
  if (error) throw new Error(`Memory add failed: ${error.message}`);
}
```

When loading memories, restore the fields:

```typescript
// In retrieve(), getRecent(), getByImportance(), getOlderThan():
// When mapping Supabase rows to Memory objects:
const memory: Memory = {
  ...(row.data as Memory),
  causedBy: (row.data as any).causedBy ?? undefined,
  ledTo: (row.data as any).ledTo ?? undefined,
};
```

**File: agent-controller.ts (crash recovery)**

Add incremental saves during nightly reflection to prevent crash-induced state loss:

```typescript
private async doReflect(): Promise<void> {
  if (this.reflectingInProgress) return;
  this.reflectingInProgress = true;
  this.state = 'reflecting';

  try {
    // Step 1: Reflect + WorldView (merged call)
    const result = await this.cognition.reflect(socialContext);
    if (result.mood) {
      this.agent.mood = result.mood;
    }
    // Incremental save after reflection
    this.emitSaveIfPersistence();

    // Step 2: Assess (separate call — critical for social dynamics)
    if (result.mentalModels) {
      this.agent.mentalModels = this.mergeMentalModels(
        this.agent.mentalModels ?? [],
        result.mentalModels,
      );
    }
    // Incremental save after assess
    this.emitSaveIfPersistence();

    // Step 3: Compress
    await this.cognition.compress();
    // Incremental save after compress
    this.emitSaveIfPersistence();

    this.goToSleep();
  } catch (err) {
    console.error(`[Reflect] ${this.agent.config.name} failed:`, err);
    this.goToSleep(); // sleep even on failure — don't leave agent stuck
  } finally {
    this.reflectingInProgress = false;
  }
}

private emitSaveIfPersistence(): void {
  // If the event bus is wired, emit save_requested
  // Otherwise, call persistence directly
  this.bus?.emit({ type: 'save_requested' });
}
```

### What this produces

Server restart no longer destroys progress. World objects, cultural names, resource depletion, and causal memory chains all survive. A simulation that ran for 30 game-days before a restart picks up exactly where it left off — memorials still standing, names still established, forests still depleted, agent narratives intact.

### Effort: ~2 hours

---

## Fix 4: Emit gameplay events

**Scorecard impact:** World responsiveness 3→4

**Why it matters:** The event bus has 24 defined event types but only 5 are emitted (all engine-internal timing events). None of the gameplay events fire. This means nearby agents can't perceive fights, thefts, or deaths happening around them. The world is socially deaf — agents only learn about events through conversation after the fact, never by witnessing them.

### Priority events (by impact on emergent behavior)

**Event: theft_occurred**

Most impactful because it enables witness-based social consequences. Currently, theft victims don't even get a memory of being stolen from.

**File: action-pipeline.ts (steal handler)**

```typescript
// After successful theft:
const thiefName = world.getAgent(actorId)?.config.name ?? 'someone';
const victimName = world.getAgent(targetId)?.config.name ?? 'someone';

// Victim gets a memory (fixes the audit finding)
const victimCognition = cognitions.get(targetId);
if (victimCognition) {
  void victimCognition.addLinkedMemory({
    id: crypto.randomUUID(),
    agentId: targetId,
    type: 'observation',
    content: `${thiefName} stole ${stolenItem.name} from me!`,
    importance: 8,
    timestamp: Date.now(),
    relatedAgentIds: [actorId],
  });
}

// Emit event for nearby witnesses
bus.emit({
  type: 'theft_occurred',
  thiefId: actorId,
  victimId: targetId,
  item: stolenItem.name,
  location: actor.position,
});
```

**File: engine.ts (subscriber)**

```typescript
this.bus.on('theft_occurred', (e) => {
  const nearby = this.world.getNearbyAgents(e.location, 5);
  for (const witness of nearby) {
    if (witness.id === e.thiefId || witness.id === e.victimId) continue;
    if (witness.alive === false) continue;
    const cognition = this.cognitions.get(witness.id);
    if (!cognition) continue;

    const thiefName = this.world.getAgent(e.thiefId)?.config.name ?? 'someone';
    const victimName = this.world.getAgent(e.victimId)?.config.name ?? 'someone';

    void cognition.addLinkedMemory({
      id: crypto.randomUUID(),
      agentId: witness.id,
      type: 'observation',
      content: `I saw ${thiefName} steal ${e.item} from ${victimName}.`,
      importance: 8,
      timestamp: Date.now(),
      relatedAgentIds: [e.thiefId, e.victimId],
    });

    // Trigger reactive think — witness decides whether to intervene
    const ctrl = this.controllers.get(witness.id);
    if (ctrl && !ctrl.apiExhausted) {
      void cognition.think(
        `You just saw ${thiefName} steal ${e.item} from ${victimName}.`,
        `You're nearby. They might not have seen you watching.`,
      );
    }
  }

  // Broadcast to clients for UI
  this.broadcaster.agentAction(e.thiefId, `stole ${e.item}`, '\u{1F978}');
});
```

**Event: agent_died**

**File: agent-controller.ts (die method)**

```typescript
private die(cause: string): void {
  // ... existing death code ...

  // Emit event
  this.bus?.emit({
    type: 'agent_died',
    agentId: this.agent.id,
    cause,
    location: this.agent.position,
  });
}
```

**File: engine.ts (subscriber)**

```typescript
this.bus.on('agent_died', (e) => {
  const nearby = this.world.getNearbyAgents(e.location, 8); // wider radius for death
  const deadName = this.world.getAgent(e.agentId)?.config.name ?? 'someone';

  for (const witness of nearby) {
    if (witness.id === e.agentId) continue;
    if (witness.alive === false) continue;
    const cognition = this.cognitions.get(witness.id);
    if (!cognition) continue;

    void cognition.addLinkedMemory({
      id: crypto.randomUUID(),
      agentId: witness.id,
      type: 'observation',
      content: `${deadName} has died. Cause: ${e.cause}. I was nearby when it happened.`,
      importance: 9,
      timestamp: Date.now(),
      relatedAgentIds: [e.agentId],
    });
  }
});
```

**Event: fight_occurred**

**File: action-pipeline.ts (fight handler)**

```typescript
// After fight resolution:
bus.emit({
  type: 'fight_occurred',
  attackerId: actorId,
  defenderId: targetId,
  outcome: fightResult, // 'attacker_won', 'defender_won', 'draw'
  location: actor.position,
});
```

**File: engine.ts (subscriber)**

```typescript
this.bus.on('fight_occurred', (e) => {
  const nearby = this.world.getNearbyAgents(e.location, 6);
  const attackerName = this.world.getAgent(e.attackerId)?.config.name ?? 'someone';
  const defenderName = this.world.getAgent(e.defenderId)?.config.name ?? 'someone';

  for (const witness of nearby) {
    if (witness.id === e.attackerId || witness.id === e.defenderId) continue;
    if (witness.alive === false) continue;
    const cognition = this.cognitions.get(witness.id);
    if (!cognition) continue;

    void cognition.addLinkedMemory({
      id: crypto.randomUUID(),
      agentId: witness.id,
      type: 'observation',
      content: `I saw ${attackerName} fight ${defenderName}. ${e.outcome === 'attacker_won' ? attackerName + ' won.' : defenderName + ' won.'}`,
      importance: 7,
      timestamp: Date.now(),
      relatedAgentIds: [e.attackerId, e.defenderId],
    });
  }
});
```

**Events: conversation_started / conversation_ended**

These are simpler — primarily for client UI rendering and for the perception system to know about active social activity.

**File: conversation manager (startConversation / endConversation)**

```typescript
// In startConversation():
bus.emit({
  type: 'conversation_started',
  id: conversationId,
  participants: agentIds,
  location: loc,
});

// In endConversation():
bus.emit({
  type: 'conversation_ended',
  id: conversationId,
  participants: active.conversation.participants,
});
```

### What this produces

The world becomes socially aware. An agent who steals is seen by witnesses who form their own judgments. An agent who dies is mourned by those nearby. A fight draws attention. The event bus enables emergent event chains: theft → witness memory → gossip in next conversation → reputation damage → social ostracism. These chains are the backbone of social consequence.

### Effort: ~2 hours

---

## Fix 5: Institutional rule enforcement

**Scorecard impact:** Institutional emergence 2→4

**Why it matters:** Agents can create institutions and hold elections, but institutions have no mechanical teeth. A "no stealing" rule exists as text in an institution's description, but nothing checks whether agents follow it, nothing notifies anyone when a rule is broken, and no consequences follow. Institutions are labels, not governance.

### Step 1: Surface institutional rules in planning

**File: agent-controller.ts (doPlan method)**

When building the world context for `plan()`, include institutional rules the agent is bound by:

```typescript
// In doPlan(), alongside existing context building:
let institutionRulesContext = '';
const agentInstitutions = this.agent.institutionIds ?? [];

for (const instId of agentInstitutions) {
  const inst = this.world.institutions.get(instId);
  if (!inst || inst.dissolved) continue;

  // Get the agent's role in this institution
  const membership = inst.members.find(
    (m: InstitutionMember) => m.agentId === this.agent.id
  );
  const roleLabel = membership?.role ? ` (${membership.role})` : '';

  institutionRulesContext += `\nYou are a member of ${inst.name}${roleLabel}.`;

  if (inst.rules && inst.rules.length > 0) {
    institutionRulesContext += ` Rules you follow:\n`;
    institutionRulesContext += inst.rules.map((r: string) => `- ${r}`).join('\n');
  }

  if (inst.description) {
    institutionRulesContext += `\nPurpose: ${inst.description}`;
  }
}

// Add to the worldContext passed to plan()
const worldCtx = (
  institutionContext +
  buildingContext +
  seasonContext +
  ledgerCtx +
  institutionRulesContext  // ← NEW
) || undefined;
```

This gives the LLM the information to make personality-driven choices. A high-conscientiousness agent will plan around the rules. A low-conscientiousness agent might ignore them. The interesting behavior is in the *choice*.

### Step 2: Detect rule violations and emit events

**File: action-pipeline.ts (after action execution)**

After any action is executed, check whether it violates an institutional rule:

```typescript
function checkInstitutionalViolations(
  agent: Agent,
  action: ParsedIntent,
  outcome: ActionOutcome,
  world: World,
  bus: EventBus,
): void {
  if (!outcome.success) return; // failed actions don't violate rules

  for (const instId of agent.institutionIds ?? []) {
    const inst = world.institutions.get(instId);
    if (!inst || inst.dissolved || !inst.rules) continue;

    for (const rule of inst.rules) {
      const ruleLower = rule.toLowerCase();
      let violated = false;

      // Simple keyword matching for common rule types
      if (action.type === 'steal' && ruleLower.includes('no steal')) violated = true;
      if (action.type === 'fight' && ruleLower.includes('no fight')) violated = true;
      if (action.type === 'fight' && ruleLower.includes('no violen')) violated = true;
      if (action.type === 'destroy' && ruleLower.includes('no destroy')) violated = true;
      if (action.type === 'destroy' && ruleLower.includes('no damag')) violated = true;

      // Location-based rules: "no gathering in the sacred grove"
      if (action.type === 'gather' && action.location) {
        const locLower = action.location.toLowerCase();
        if (ruleLower.includes('no gather') && ruleLower.includes(locLower)) {
          violated = true;
        }
      }

      if (violated) {
        bus.emit({
          type: 'rule_violated',
          agentId: agent.id,
          agentName: agent.config.name,
          institutionId: instId,
          institutionName: inst.name,
          rule: rule,
          action: outcome.description,
          location: agent.position,
        });
      }
    }
  }
}
```

Add `rule_violated` to the SimEvent type union in `shared/src/events.ts`:

```typescript
| { type: 'rule_violated'; agentId: string; agentName: string; institutionId: string; institutionName: string; rule: string; action: string; location: Position }
```

### Step 3: Leaders react to violations

**File: engine.ts (subscriber)**

```typescript
this.bus.on('rule_violated', (e) => {
  const institution = this.world.institutions.get(e.institutionId);
  if (!institution) return;

  // Find institution leaders
  const leaders = (institution.members ?? [])
    .filter((m: InstitutionMember) =>
      m.role === 'leader' || m.role === 'elder' || m.role === 'founder'
    )
    .map((m: InstitutionMember) => m.agentId)
    .filter((id: string) => id !== e.agentId); // violator can't judge themselves

  for (const leaderId of leaders) {
    const cognition = this.cognitions.get(leaderId);
    const ctrl = this.controllers.get(leaderId);
    if (!cognition || !ctrl || ctrl.apiExhausted) continue;

    // Leader gets a high-importance memory of the violation
    void cognition.addLinkedMemory({
      id: crypto.randomUUID(),
      agentId: leaderId,
      type: 'observation',
      content: `${e.agentName} violated ${e.institutionName} rule: "${e.rule}" by doing: ${e.action}`,
      importance: 8,
      timestamp: Date.now(),
      relatedAgentIds: [e.agentId],
    });

    // Trigger a reactive think — leader decides how to respond
    void cognition.think(
      `${e.agentName}, a member of ${e.institutionName}, just broke the rule: "${e.rule}". They ${e.action}.`,
      `You are a leader of ${e.institutionName}. You must decide how to respond — warn them, confront them, expel them, or let it slide.`,
    );
  }

  console.log(`[Institution] ${e.agentName} violated ${e.institutionName} rule: "${e.rule}"`);
});
```

### What this produces

Institutions gain social enforcement. A "no stealing" guild rule means that when a member steals, the guild leader gets a memory and a reactive think. The leader might confront the thief in conversation, post about it on the board, or expel them. The thief's mental model of the leader updates based on the confrontation. Other members gossip about the incident. The institution either holds together or fractures.

This doesn't mechanically prevent rule-breaking — it creates *social consequences* for it, which is far more interesting for the simulation's purpose.

### Effort: ~3 hours

---

## Implementation sequence

Do them in this order. Each fix is independently shippable but they compound:

```
Fix 1: Resource depletion          (~2 hours)
  └→ creates scarcity pressure

Fix 4: Emit gameplay events        (~2 hours)
  └→ world becomes socially reactive
  └→ theft victims get memories (depends on no other fix)

Fix 2: Populate ledTo/causedBy     (~3 hours)
  └→ activates narrative memory system
  └→ uses addLinkedMemory which also handles ledTo

Fix 3: Persist world state         (~2 hours)
  └→ persists Fix 1's resource pools
  └→ persists Fix 2's causal links
  └→ persists world objects and cultural names

Fix 5: Institutional enforcement   (~3 hours)
  └→ uses event bus from Fix 4
  └→ uses addLinkedMemory from Fix 2
  └→ rule violations create causal chain memories
```

Total: ~12 hours. After completion, re-run the audit prompt to verify the scorecard moves to 4.

---

## Verification checklist

After all 5 fixes, run 10 agents for 3 full game-days and verify:

- [ ] At least one resource pool reaches zero (Fix 1 working)
- [ ] At least one agent fails to gather due to depletion (Fix 1 → behavior change)
- [ ] At least one agent adjusts their plan after depletion failure (Fix 1 → cascade)
- [ ] Theft victim has a memory of being stolen from (Fix 4 working)
- [ ] At least one nearby agent witnesses a theft or fight (Fix 4 → perception)
- [ ] `buildCausalChains()` returns non-empty arrays (Fix 2 working)
- [ ] Causal chain appears in reflect() prompt content (Fix 2 → narrative)
- [ ] After server restart, world objects still exist (Fix 3 working)
- [ ] After server restart, resource pools are preserved (Fix 3 working)
- [ ] After server restart, causedBy/ledTo fields are present on loaded memories (Fix 3 working)
- [ ] Institutional rule violation triggers leader reactive think (Fix 5 working)
- [ ] Leader confronts rule-breaker in conversation (Fix 5 → social consequence)
