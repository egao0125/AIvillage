import type { Agent, DriveState, GameTime, Mood, Position, ThinkOutput, VitalState } from '@ai-village/shared';
import type { EventBus } from '@ai-village/shared';
import { AgentCognition, SEASONS, SEASON_ORDER, SEASON_LENGTH, BUILDINGS, RESOURCES, RECIPES, getGatherOptions, getAvailableRecipes, parseIntent, executeAction, type AgentSituation, type AvailableAction, type AgentDecision, type AgentState, type WorldState, type ActionOutcome } from '@ai-village/ai-engine';
import type { Item } from '@ai-village/shared';
import { getAreaEntrance, getRandomPositionInArea, getAreaAt, getWalkable, MAP_HEIGHT, MAP_WIDTH } from '../map/village.js';
import { findPath } from './pathfinding.js';
import type { World } from './world.js';
import type { EventBroadcaster } from './events.js';
import type { DecisionQueue } from './decision-queue.js';

interface SoloActionExecutor {
  executeSocialAction(actorId: string, actorName: string, targetId: string, action: string, cognition: AgentCognition): void;
  requestConversation(initiatorId: string, targetId: string): boolean;
}

export type ControllerState =
  | 'sleeping'
  | 'waking'
  | 'planning'
  | 'moving'
  | 'performing'
  | 'conversing'
  | 'reflecting'
  | 'deciding'    // Infra 3: waiting for queue-managed LLM call
  | 'idle';

/** Count overlapping words (>3 chars) between two strings */
export function keywordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(w => w.length > 3));
  const wordsB = b.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(w => w.length > 3);
  let overlap = 0;
  for (const w of wordsB) {
    if (wordsA.has(w)) overlap++;
  }
  return overlap;
}

export class AgentController {
  state: ControllerState = 'idle';
  agent: Agent;
  cognition: AgentCognition;
  // (intentions[] and currentIntentionIndex removed in refactor v2 — replaced by currentGoals)
  path: Position[] = [];
  pathIndex: number = 0;
  private moveTick: number = 0;
  private lastHungerHour: number = -1; // guard against double hunger tick
  activityTimer: number = 0;
  idleTimer: number = 0;
  private planningInProgress: boolean = false;
  private reflectingInProgress: boolean = false;
  private currentAreaId: string | null = null; // track where the agent is performing
  conversationCooldown: number = 0; // ticks remaining before agent can converse again
  pendingConversationTarget: string | null = null;
  pendingConversationPurpose: string | null = null; // intention text that triggered the conversation
  private consecutiveApiFailures: number = 0;
  apiExhausted: boolean = false;
  private apiRecoveryTimer: number = 0;
  private apiAuthDead: boolean = false; // true = 401/403, don't auto-recover
  private currentPerformingActivity: string = '';
  onDeath?: (agentId: string, cause: string) => void;
  bus?: EventBus;  // Fix 4: event bus for gameplay events
  private lastHungerBand: number = 0;
  private lastEnergyBand: number = 0;
  private lastHealthBand: number = 0;
  public lastOutcomeDescription: string = '';
  decisionQueue?: DecisionQueue;  // Infra 3: injected by engine
  // Refactor v2: structured decision system
  public currentGoals: string[] = [];
  private decidingInProgress: boolean = false;
  private lastTrigger: string = 'You just arrived. Look around and decide what to do.';
  private lastOutcome: string | undefined;

  readonly wakeHour: number;
  readonly sleepHour: number;
  readonly homeArea: string;

  constructor(
    agent: Agent,
    cognition: AgentCognition,
    private world: World,
    private broadcaster: EventBroadcaster,
    wakeHour: number,
    sleepHour: number,
    homeArea: string = 'plaza',
    private soloActionExecutor?: SoloActionExecutor,
  ) {
    this.agent = agent;
    this.cognition = cognition;
    this.wakeHour = wakeHour;
    this.sleepHour = sleepHour;
    this.homeArea = homeArea;

    // Initialize drives and vitals if not set
    if (!this.agent.drives) {
      this.agent.drives = { survival: 50, safety: 60, belonging: 40, status: 30, meaning: 20 };
    }
    if (!this.agent.vitals) {
      this.agent.vitals = { health: 100, hunger: 0, energy: 100 };
    }
    if (this.agent.alive === undefined) {
      this.agent.alive = true;
    }
    if (!this.agent.socialLedger) {
      this.agent.socialLedger = [];
    }
  }

  private handleApiFailure(err: unknown): void {
    this.consecutiveApiFailures++;

    // Detect auth errors (401/403) — don't auto-recover from bad keys
    const status = (err as any)?.status ?? (err as any)?.response?.status;
    if (status === 401 || status === 403) {
      this.apiAuthDead = true;
    }

    if (this.consecutiveApiFailures >= 3 && !this.apiExhausted) {
      this.apiExhausted = true;
      this.apiRecoveryTimer = 0;
      const recoveryNote = this.apiAuthDead ? 'bad API key — update key to resume' : 'will auto-retry in ~5 min';
      console.log(`[Agent] ${this.agent.config.name} API EXHAUSTED after ${this.consecutiveApiFailures} consecutive failures — ${recoveryNote}`);
      this.broadcaster.agentAction(this.agent.id, `API exhausted — ${recoveryNote}`, '\u26A0\uFE0F');
      this.world.updateAgentState(this.agent.id, 'idle', 'API exhausted');
    }
  }

  private handleApiSuccess(): void {
    this.consecutiveApiFailures = 0;
  }

  /** Truncate verbose intention text to a clean short activity description */
  private shortActivity(raw: string): string {
    // Strip "ACTION: " prefix if present
    let s = raw.replace(/^ACTION:\s*/i, '');
    // Take first sentence or first 80 chars
    const dot = s.indexOf('. ');
    if (dot > 0 && dot < 80) s = s.slice(0, dot);
    if (s.length > 80) s = s.slice(0, 77) + '...';
    return s.toLowerCase();
  }

  private logTransitionMemory(from: ControllerState, to: ControllerState): void {
    if (from === to) return;
    const skip: ControllerState[] = ['waking', 'planning', 'reflecting'];
    if (skip.includes(from) || skip.includes(to)) return;

    const area = getAreaAt(this.agent.position);
    const location = area?.name ?? 'the village';
    let content: string;

    if (to === 'moving') {
      content = `I'm heading somewhere.`;
    } else if (to === 'performing') {
      content = `I started ${this.shortActivity(this.currentPerformingActivity)} at ${location}.`;
    } else if (to === 'idle' && from === 'performing') {
      content = `I finished what I was doing at ${location}.`;
    } else if (to === 'idle' && from === 'moving') {
      content = `I arrived at ${location}.`;
    } else if (to === 'conversing') {
      content = `I started a conversation at ${location}.`;
    } else if (to === 'idle' && from === 'conversing') {
      content = `I finished talking at ${location}.`;
    } else {
      return;
    }

    void this.cognition.addMemory({
      id: crypto.randomUUID(),
      agentId: this.agent.id,
      type: 'observation',
      content,
      importance: 2,
      timestamp: Date.now(),
      relatedAgentIds: [],
    });
  }

  resetApiState(newCognition: AgentCognition): void {
    this.cognition = newCognition;
    this.apiExhausted = false;
    this.consecutiveApiFailures = 0;
    this.state = 'idle';
    console.log(`[Agent] ${this.agent.config.name} API key updated — resuming`);
    this.broadcaster.agentAction(this.agent.id, 'API key updated — resuming', '\u2705');
  }

  /** Infra 3: Execute a queued decision. Called by the engine's processing loop. */
  async executeQueuedDecision(type: string, context: { trigger: string; details: string }): Promise<void> {
    switch (type) {
      case 'think':
        await this.decideAndAct();
        break;
      case 'plan':
        await this.doPlan(this.world.time);
        break;
      case 'reflect':
        await this.doReflect();
        break;
    }
  }

  get isAvailable(): boolean {
    return (
      this.state !== 'sleeping' &&
      this.state !== 'conversing' &&
      this.conversationCooldown <= 0
    );
  }

  tick(time: GameTime): void {
    // Dead agents don't tick
    if (this.agent.alive === false) return;

    // Sync current time so LLM prompts are time-aware
    this.cognition.currentTime = { day: time.day, hour: time.hour };

    // Auto-recover from transient API failures (skip if auth is dead)
    if (this.apiExhausted && !this.apiAuthDead) {
      this.apiRecoveryTimer++;
      if (this.apiRecoveryTimer >= 300) {
        this.apiExhausted = false;
        this.consecutiveApiFailures = 0;
        this.apiRecoveryTimer = 0;
        this.state = 'idle';
        this.idleTimer = 0;
        console.log(`[Agent] ${this.agent.config.name} API auto-recovery — retrying`);
        this.broadcaster.agentAction(this.agent.id, 'API recovered — resuming', '\u2705');
      }
    }

    // Vitals decay every tick (1 game minute)
    this.tickVitals();

    // Recalculate drives every 60 ticks (~1 game hour)
    if (this.world.time.minute === 0) {
      this.recalculateDrives();
      this.checkLedgerExpiry();
    }

    if (this.conversationCooldown > 0) this.conversationCooldown--;

    // Universal sleep check — fires once at exact sleep hour, then winds down gracefully
    if (this.state !== 'sleeping' && this.state !== 'reflecting' && this.state !== 'waking' && this.state !== 'deciding') {
      if (!this.sleepTriggered && this.shouldSleep(time)) {
        this.sleepTriggered = true;
        // Record pre-sleep context for narrative bridge
        const area = getAreaAt(this.agent.position);
        this.preSleepArea = area?.name ?? 'the village';
        this.preSleepActivity = this.state === 'conversing' ? 'having a conversation'
          : this.state === 'performing' ? this.currentPerformingActivity || 'an activity'
          : this.state === 'moving' ? 'walking' : 'resting';

        if (this.state === 'idle' || this.state === 'planning') {
          // Not busy — proceed to reflection immediately
          this.beginSleepSequence(time);
        } else {
          // Busy — set winding down flag, let current activity finish first
          this.windingDown = true;
          console.log(`[Agent] ${this.agent.config.name} is winding down (was ${this.state})`);
        }
        return;
      }
      // If winding down and current activity finished (back to idle), proceed to sleep
      if (this.windingDown && (this.state === 'idle')) {
        this.windingDown = false;
        this.beginSleepSequence(time);
        return;
      }
    }

    const stateBeforeTick = this.state;

    switch (this.state) {
      case 'sleeping': {
        // Check if it's time to wake up
        if (this.shouldWake(time)) {
          this.state = 'waking';
        }
        break;
      }

      case 'waking': {
        void this.wake();
        break;
      }

      case 'planning': {
        // Planning is async; handled by doPlan
        if (!this.planningInProgress) {
          this.state = 'idle';
        }
        break;
      }

      case 'moving': {
        // Move every 3 ticks so agents walk visibly instead of teleporting
        this.moveTick++;
        if (this.moveTick >= 3) {
          this.moveTick = 0;
          this.advanceMovement();
        }
        break;
      }

      case 'performing': {
        this.activityTimer--;
        if (this.activityTimer <= 0) {
          this.currentPerformingActivity = '';
          this.state = 'idle';
          this.idleTimer = 0;
          this.world.updateAgentState(this.agent.id, 'idle', '');
        }
        break;
      }

      case 'conversing': {
        // Managed by ConversationManager — do nothing here
        break;
      }

      case 'reflecting': {
        if (!this.reflectingInProgress) {
          this.goToSleep();
        }
        break;
      }

      case 'deciding': {
        // Infra 3: waiting for queue-managed LLM call — no-op, engine processes queue
        break;
      }

      case 'idle': {
        this.idleTimer++;
        if (this.idleTimer >= 8 && !this.decidingInProgress) {
          this.idleTimer = 0;
          // If no goals yet, plan first
          if (this.currentGoals.length === 0 && !this.planningInProgress) {
            void this.doPlan(time);
          } else {
            void this.decideAndAct();
          }
        }
        break;
      }
    }

    // Log transition memories when state changes (zero LLM cost)
    if (this.state !== stateBeforeTick) {
      this.logTransitionMemory(stateBeforeTick, this.state);
    }
  }

  async wake(): Promise<void> {
    this.state = 'planning';
    this.world.updateAgentState(this.agent.id, 'active', '');
    this.broadcaster.agentAction(this.agent.id, 'waking up', '\u{1F31E}');
    this.sleepTriggered = false; // reset for next night
    console.log(`[Agent] ${this.agent.config.name} wakes up`);

    // Think on waking — include pre-sleep context for narrative continuity
    if (!this.apiExhausted) {
      try {
        const area = getAreaAt(this.agent.position);
        const v = this.agent.vitals;
        const vitalsNote = v ? `Health: ${Math.round(v.health)}, Hunger: ${Math.round(v.hunger)}, Energy: ${Math.round(v.energy)}.` : '';
        const preSleepNote = this.preSleepArea
          ? ` Last night you were ${this.preSleepActivity ?? 'busy'} at ${this.preSleepArea} before heading to bed.`
          : '';
        const output = await this.cognition.think(
          `You just woke up at the ${area?.name ?? 'village'}. It's morning on day ${this.world.time.day}.${preSleepNote}`,
          `Location: ${area?.name ?? 'unknown'}. ${vitalsNote}`
        );
        this.handleApiSuccess();
        if (output.mood) {
          this.agent.mood = output.mood;
          this.broadcaster.agentMood(this.agent.id, output.mood);
        }
        this.broadcaster.agentThought(this.agent.id, output.thought);
      } catch (err) {
        this.handleApiFailure(err);
      }
    }
    // Clear pre-sleep context after use
    this.preSleepArea = null;
    this.preSleepActivity = null;

    // Start planning the day
    void this.doPlan({
      day: this.world.time.day,
      hour: this.world.time.hour,
      minute: this.world.time.minute,
      totalMinutes: this.world.time.totalMinutes,
    });
  }

  async doPlan(time: GameTime): Promise<void> {
    if (this.planningInProgress) return;
    if (this.apiExhausted) {
      this.state = 'idle';
      this.world.updateAgentState(this.agent.id, 'idle', 'API exhausted');
      return;
    }
    this.planningInProgress = true;
    this.state = 'planning';

    try {
      this.world.updateAgentState(this.agent.id, 'active', '');

      // Only show board context if agent has discovered the plaza
      let boardContext: string | undefined;
      if (this.cognition.knownPlaces.has('plaza')) {
        boardContext = this.world.getBoardSummary();

        // Add public artifacts to planning context
        const publicArtifacts = this.world.getPublicArtifacts().slice(-10);
        if (publicArtifacts.length > 0) {
          const artifactText = publicArtifacts.map(a =>
            `- [${a.type.toUpperCase()}] "${a.title}" by ${a.creatorName}: ${a.content.slice(0, 100)}`
          ).join('\n');
          boardContext += `\n\nVILLAGE MEDIA:\n${artifactText}`;
        }
      }

      const institutionContext = this.buildInstitutionContext();

      // Add building context
      const buildings = Array.from(this.world.buildings.values()).filter(b => b.durability > 0);
      let buildingContext = '';
      if (buildings.length > 0) {
        buildingContext = '\nBUILDINGS:\n' + buildings.map(b =>
          `- ${b.name} (${b.type}) at ${b.areaId}, built by ${this.world.getAgent(b.builtBy)?.config.name ?? 'unknown'}`
        ).join('\n');
      }
      // Season context — physical observation only, no warnings
      const seasonIdx = Math.floor((this.world.time.day - 1) / SEASON_LENGTH) % SEASON_ORDER.length;
      const currentSeason = SEASON_ORDER[seasonIdx];
      const seasonDef = SEASONS[currentSeason];
      const daysIntoSeason = ((this.world.time.day - 1) % SEASON_LENGTH);
      const daysLeft = SEASON_LENGTH - daysIntoSeason;
      const nextSeason = SEASON_ORDER[(seasonIdx + 1) % SEASON_ORDER.length];
      const seasonContext = `\nSEASON: ${currentSeason} (day ${daysIntoSeason + 1}/${SEASON_LENGTH}, ${daysLeft} days until ${nextSeason}). ${seasonDef.description}`;

      // Fix 5: Surface institutional rules the agent is bound by
      let institutionRulesContext = '';
      for (const instId of this.agent.institutionIds ?? []) {
        const inst = this.world.institutions.get(instId);
        if (!inst || inst.dissolved) continue;
        const membership = inst.members.find((m: any) => m.agentId === this.agent.id);
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

      const ledgerCtx = this.buildLedgerContext();
      const worldCtx = (institutionContext + buildingContext + seasonContext + ledgerCtx + institutionRulesContext) || undefined;
      const goals = await this.cognition.plan({ day: time.day, hour: time.hour }, boardContext, worldCtx);
      this.currentGoals = goals;
      console.log(
        `[Agent] ${this.agent.config.name} set ${goals.length} goals: ${goals.join('; ')}`,
      );
      this.handleApiSuccess();
      // Don't call followNextIntention — just go idle and let decideAndAct handle it
      this.state = 'idle';
      this.idleTimer = 0;
    } catch (err) {
      console.error(`[Agent] ${this.agent.config.name} failed to plan day:`, (err as Error).message || err);
      this.handleApiFailure(err);
      this.state = 'idle';
    } finally {
      this.planningInProgress = false;
    }
  }

  // (followNextIntention, decomposeIntoSteps, VERB_PREFIX, pendingActivity removed in refactor v2)
  private pendingSleep: string | null = null; // sleep area name, set when walking to bed
  private sleepTriggered: boolean = false; // prevent re-triggering sleep check
  private windingDown: boolean = false; // waiting for current activity to finish before sleep
  private preSleepArea: string | null = null; // where the agent was before going to bed
  private preSleepActivity: string | null = null; // what the agent was doing before bed


  startMoveTo(target: Position): void {
    const path = findPath(this.agent.position, target, getWalkable, MAP_WIDTH, MAP_HEIGHT);

    if (path.length <= 1) {
      // Already there or no path found — go idle so decideAndAct picks up
      const area = getAreaAt(this.agent.position);
      this.lastTrigger = 'You arrived at ' + (area?.name ?? 'your destination') + '.';
      this.state = 'idle';
      this.idleTimer = 6;
      this.world.updateAgentState(this.agent.id, 'idle', '');
      return;
    }

    this.path = path;
    this.pathIndex = 1; // Skip start position (already there)
    this.state = 'moving';
    this.world.updateAgentState(this.agent.id, 'routine', '');
  }

  private advanceMovement(): void {
    if (this.pathIndex >= this.path.length) {
      // Arrived at destination
      if (this.pendingSleep) {
        this.enterSleepState(this.pendingSleep);
        this.pendingSleep = null;
      } else if (this.pendingConversationTarget && this.soloActionExecutor) {
        // Arrived to talk — try to start conversation
        const started = this.soloActionExecutor.requestConversation(this.agent.id, this.pendingConversationTarget);
        if (started) {
          this.pendingConversationTarget = null;
          this.pendingConversationPurpose = null;
          return;
        }
        // Target moved — go idle and re-decide
        this.pendingConversationTarget = null;
        this.pendingConversationPurpose = null;
        const area = getAreaAt(this.agent.position);
        this.lastTrigger = 'You arrived at ' + (area?.name ?? 'your destination') + ' but couldn\'t find who you were looking for.';
        this.state = 'idle';
        this.idleTimer = 6;
        this.world.updateAgentState(this.agent.id, 'idle', '');
      } else {
        const area = getAreaAt(this.agent.position);
        this.lastTrigger = 'You arrived at ' + (area?.name ?? 'your destination') + '.';
        this.state = 'idle';
        this.idleTimer = 6;
        this.world.updateAgentState(this.agent.id, 'idle', '');
      }
      return;
    }

    const from = { ...this.agent.position };
    const to = this.path[this.pathIndex];
    this.pathIndex++;

    this.world.updateAgentPosition(this.agent.id, to);
    this.agent.position = to;
    this.broadcaster.agentMove(this.agent.id, from, to);
  }

  // (startPerforming, PHYSICAL_ACTION, MOVE_ONLY, HAS_ACTION_VERB removed in refactor v2)

  /**
   * Enter conversing state (called externally by ConversationManager).
   */
  enterConversation(): void {
    // Stop any movement — agent halts to talk
    this.path = [];
    this.pathIndex = 0;
    this.pendingSleep = null;
    this.activityTimer = 0;
    this.currentPerformingActivity = '';
    this.state = 'conversing';
    this.world.updateAgentState(this.agent.id, 'active', 'conversing');
  }

  /**
   * Leave conversing state (called externally when conversation ends).
   * Immediately moves to next plan item so agent walks away.
   */
  leaveConversation(): void {
    if (this.state === 'conversing') {
      this.state = 'idle';
      this.idleTimer = 0;
      this.conversationCooldown = 60; // ~5 seconds before this agent can talk again
      this.lastTrigger = 'You just finished a conversation. What now?';
      this.world.updateAgentState(this.agent.id, 'idle', '');
    }
  }

  // (thinkThenAct, thinkAfterOutcome removed in refactor v2 — replaced by decideAndAct)

  /**
   * Event-driven think — immediate, bypasses the 60-minute cooldown.
   * Used for: witnessing events, vital threshold crossings, conversation endings.
   */
  async thinkOnEvent(trigger: string, context: string, causedByMemoryId?: string): Promise<void> {
    if (this.apiExhausted || this.state === 'sleeping' || this.state === 'conversing') return;

    try {
      const output = await this.cognition.think(trigger, context);
      this.handleApiSuccess();

      // Guard: agent may have entered a conversation while we were awaiting the LLM
      if ((this.state as ControllerState) === 'conversing') return;

      if (output.mood) {
        this.agent.mood = output.mood;
        this.broadcaster.agentMood(this.agent.id, output.mood);
      }
      this.broadcaster.agentThought(this.agent.id, output.thought);

      // If the thought suggests urgency, trigger decideAndAct quickly
      this.lastTrigger = trigger;
      this.idleTimer = 6;
    } catch (err) {
      this.handleApiFailure(err);
    }
  }

  // (replanAfterConversation removed in refactor v2)

  async doReflect(): Promise<void> {
    if (this.reflectingInProgress) return;
    if (this.apiExhausted) {
      this.goToSleep(); // skip reflection, go straight to sleep
      return;
    }
    this.reflectingInProgress = true;
    this.state = 'reflecting';

    console.log(`[Agent] ${this.agent.config.name} is reflecting on the day`);
    this.world.updateAgentState(this.agent.id, 'active', '');

    try {
      const socialCtx = this.buildLedgerReflectionContext();
      const result = await this.cognition.reflect(socialCtx || undefined);
      this.handleApiSuccess();

      // Update mental models from reflection
      if (result.mentalModels) {
        this.agent.mentalModels = result.mentalModels;
      }

      // Apply agent's commitment evaluations to their own ledger
      if (result.commitmentUpdates) {
        const ledger = this.agent.socialLedger ?? [];
        for (const update of result.commitmentUpdates) {
          const entry = ledger.find(e =>
            e.status === 'accepted' &&
            keywordOverlap(e.description, update.description) >= 3
          );
          if (entry && (update.status === 'fulfilled' || update.status === 'broken')) {
            entry.status = update.status;
            entry.resolvedAt = this.world.time.totalMinutes;
          }
        }
      }

      // WorldView is updated internally by cognition.reflect() → updateWorldView()
      if (result.updatedWorldView) {
        console.log(`[Agent] ${this.agent.config.name} evolved worldView`);
        this.broadcaster.agentWorldView(this.agent.id, this.cognition.worldView);
      }

      // Use mood from LLM response, fall back to keyword parsing
      const mood = result.mood || this.parseMoodFromReflection(result.reflection);
      if (mood) {
        this.agent.mood = mood;
        this.broadcaster.agentMood(this.agent.id, mood);
        console.log(`[Agent] ${this.agent.config.name} mood: ${mood}`);
      }
    } catch (err) {
      console.error(`[Agent] ${this.agent.config.name} failed to reflect:`, err);
      this.handleApiFailure(err);
    } finally {
      this.reflectingInProgress = false;
      this.goToSleep();
    }
  }

  private tickVitals(): void {
    const v = this.agent.vitals;
    if (!v) return;

    // --- Hourly effects (guard: engine ticks 2x per game minute,
    // so minute===0 is true for 2 consecutive ticks — only apply once per hour)
    const currentHour = this.world.time.day * 24 + this.world.time.hour;
    if (this.world.time.minute === 0 && currentHour !== this.lastHungerHour) {
      this.lastHungerHour = currentHour;

      // Hunger increases every game hour (0.5 per hour — agents last longer)
      v.hunger = Math.min(100, v.hunger + 0.5);

      // Cold damage + building effects
      const seasonIdx = Math.floor((this.world.time.day - 1) / SEASON_LENGTH) % SEASON_ORDER.length;
      const currentSeason = SEASON_ORDER[seasonIdx];
      const seasonDef = SEASONS[currentSeason];

      // Get buildings in agent's area
      const area = this.world.getAreaAt(this.agent.position);
      const buildings = area ? this.world.getBuildingsAt(area.id) : [];

      // Cold damage — mitigated by shelter (degraded when over capacity)
      if (seasonDef.coldDamagePerHour > 0) {
        let bestColdProtection = 0;
        for (const b of buildings) {
          if (b.defId && BUILDINGS[b.defId]) {
            const bDef = BUILDINGS[b.defId];
            const coldEffect = bDef.effects?.find((e: any) => e.type === 'cold_protection');
            if (coldEffect) {
              let protection = coldEffect.value;
              // Enforce shelter capacity — overcrowding degrades protection
              if (area) {
                const agentsHereCount = this.world.getAgentsInArea(area.id).length;
                if (agentsHereCount > bDef.maxCapacity) {
                  const capacityRatio = bDef.maxCapacity / agentsHereCount;
                  protection = coldEffect.value * capacityRatio;
                }
              }
              bestColdProtection = Math.max(bestColdProtection, protection);
            }
          } else if (b.effects.includes('shelter')) {
            bestColdProtection = Math.max(bestColdProtection, 0.5);
          }
        }
        const coldDamage = seasonDef.coldDamagePerHour * (1 - bestColdProtection);
        if (coldDamage > 0) {
          v.health = Math.max(0, v.health - coldDamage);
        }
      }

      // Building effects — energy regen, hunger reduction
      for (const b of buildings) {
        if (!b.defId || !BUILDINGS[b.defId]) continue;
        const bDef = BUILDINGS[b.defId];
        if (!bDef.effects) continue;
        for (const effect of bDef.effects) {
          if (effect.type === 'energy_regen') {
            v.energy = Math.min(100, v.energy + effect.value * 0.1);
          } else if (effect.type === 'hunger_reduction') {
            v.hunger = Math.max(0, v.hunger - effect.value * 0.05);
          }
        }
      }
    }

    // Energy depletes during activity, restores during sleep/rest
    if (this.state === 'performing' || this.state === 'moving') {
      const lower = this.currentPerformingActivity.toLowerCase();
      const isResting = lower.includes('rest') || lower.includes('relax') || lower.includes('nap') || lower.includes('sit') || lower.includes('meditat');
      if (isResting) {
        v.energy = Math.min(100, v.energy + 0.1);
      } else {
        v.energy = Math.max(0, v.energy - 0.03);
      }
    } else if (this.state === 'idle') {
      v.energy = Math.min(100, v.energy + 0.02);
    } else if (this.state === 'sleeping') {
      v.energy = Math.min(100, v.energy + 0.5);
    }

    // Vitals affect health — starvation and exhaustion can kill
    if (v.hunger >= 85) {
      v.health = Math.max(0, v.health - 0.05);
    } else if (v.hunger >= 70) {
      v.health = Math.max(0, v.health - 0.02);
    }
    if (v.energy <= 5) {
      v.health = Math.max(0, v.health - 0.03);
    }
    // Passive health regen when not starving/exhausted
    if (v.hunger < 70 && v.energy > 20) {
      v.health = Math.min(100, v.health + 0.02);
    }

    // Death check — health reaching 0 is fatal
    if (v.health <= 0) {
      const seasonIdx = Math.floor((this.world.time.day - 1) / SEASON_LENGTH) % SEASON_ORDER.length;
      const cause = v.hunger >= 80 ? 'starvation' : v.energy <= 5 ? 'exhaustion' : SEASON_ORDER[seasonIdx] === 'winter' ? 'exposure' : 'exhaustion';
      this.die(cause);
      return;
    }

    // Vital threshold think triggers — immediate, bypasses cooldown
    const hungerBand = v.hunger >= 80 ? 2 : v.hunger >= 50 ? 1 : 0;
    const energyBand = v.energy <= 10 ? 2 : v.energy <= 30 ? 1 : 0;
    const healthBand = v.health <= 25 ? 2 : v.health <= 50 ? 1 : 0;

    if (hungerBand > this.lastHungerBand) {
      const foodCount = this.agent.inventory.filter(i => i.type === 'food').length;
      // Freedom 4: Create vitals observation with tracked ID for causal linking
      const vitalsMemId = crypto.randomUUID();
      void this.cognition.addMemory({
        id: vitalsMemId, agentId: this.agent.id, type: 'observation',
        content: `I'm getting ${hungerBand === 2 ? 'very hungry' : 'hungry'}. Hunger: ${Math.round(v.hunger)}/100.`,
        importance: hungerBand === 2 ? 7 : 5,
        timestamp: Date.now(), relatedAgentIds: [],
      });
      void this.thinkOnEvent(
        `You're getting ${hungerBand === 2 ? 'very hungry — your health is starting to drop' : 'hungry'}.`,
        `Hunger: ${Math.round(v.hunger)}/100. Food in inventory: ${foodCount} items.`,
        vitalsMemId,
      );
    }
    if (energyBand > this.lastEnergyBand) {
      const vitalsMemId = crypto.randomUUID();
      void this.cognition.addMemory({
        id: vitalsMemId, agentId: this.agent.id, type: 'observation',
        content: `I'm ${energyBand === 2 ? 'completely exhausted' : 'getting tired'}. Energy: ${Math.round(v.energy)}/100.`,
        importance: energyBand === 2 ? 7 : 5,
        timestamp: Date.now(), relatedAgentIds: [],
      });
      void this.thinkOnEvent(
        `You're ${energyBand === 2 ? 'completely exhausted' : 'getting tired'}.`,
        `Energy: ${Math.round(v.energy)}/100.`,
        vitalsMemId,
      );
    }
    if (healthBand > this.lastHealthBand) {
      const vitalsMemId = crypto.randomUUID();
      void this.cognition.addMemory({
        id: vitalsMemId, agentId: this.agent.id, type: 'observation',
        content: `I'm ${healthBand === 2 ? 'critically injured' : 'hurt and need care'}. Health: ${Math.round(v.health)}/100.`,
        importance: healthBand === 2 ? 8 : 6,
        timestamp: Date.now(), relatedAgentIds: [],
      });
      void this.thinkOnEvent(
        `You're ${healthBand === 2 ? 'critically injured' : 'hurt and need care'}.`,
        `Health: ${Math.round(v.health)}/100.`,
        vitalsMemId,
      );
    }

    this.lastHungerBand = hungerBand;
    this.lastEnergyBand = energyBand;
    this.lastHealthBand = healthBand;

    // Broadcast vitals every 30 ticks
    if (this.world.time.totalMinutes % 30 === 0) {
      this.broadcaster.agentVitals(this.agent.id, v);
    }
  }

  private recalculateDrives(): void {
    const d = this.agent.drives;
    const v = this.agent.vitals;
    if (!d || !v) return;

    // Survival: heavily hunger-weighted
    d.survival = Math.max(0, Math.min(100,
      v.hunger * 0.85 + (100 - v.health) * 0.15
    ));

    // Safety: based on reputation (are people hostile?) and world events
    const reputations = this.world.reputation.filter(r => r.toAgentId === this.agent.id);
    const avgRep = reputations.length > 0
      ? reputations.reduce((sum, r) => sum + r.score, 0) / reputations.length
      : 0;
    d.safety = Math.max(0, Math.min(100, 50 - avgRep * 0.5));

    // Belonging: decreases with social activity, increases with isolation
    const recentConvos = this.conversationCooldown > 0 ? 1 : 0;
    d.belonging = Math.max(0, Math.min(100,
      d.belonging + (recentConvos > 0 ? -5 : 2)
    ));

    // Status: based on currency relative to average, and skills
    const allAgents = Array.from(this.world.agents.values()).filter(a => a.alive !== false);
    const avgCurrency = allAgents.length > 0
      ? allAgents.reduce((sum, a) => sum + a.currency, 0) / allAgents.length
      : 100;
    const wealthRatio = avgCurrency > 0 ? this.agent.currency / avgCurrency : 1;
    d.status = Math.max(0, Math.min(100,
      100 - (wealthRatio * 50) - (this.agent.skills.length * 5)
    ));

    // Meaning: high when agent has created things, holds positions, has purpose
    const hasInstitution = (this.agent.institutionIds?.length ?? 0) > 0;
    const hasSkills = this.agent.skills.length > 0;
    d.meaning = Math.max(0, Math.min(100,
      70 - (hasInstitution ? 20 : 0) - (hasSkills ? 10 : 0) - (this.agent.config.goal ? 10 : 0)
    ));

    this.broadcaster.agentDrives(this.agent.id, d);
  }

  private die(cause: string): void {
    console.log(`[Agent] ${this.agent.config.name} has DIED: ${cause}`);
    this.agent.alive = false;
    this.agent.causeOfDeath = cause;
    this.agent.state = 'dead';
    this.state = 'idle'; // Stop all controller activity

    // Drop items — they become unclaimed
    const droppedItems = this.world.killAgent(this.agent.id, cause);

    this.broadcaster.agentDeath(this.agent.id, cause);
    this.broadcaster.agentAction(this.agent.id, `died: ${cause}`, '\u{1F480}');

    // Fix 4: Emit agent_died event for nearby witness perception
    if (this.bus) {
      this.bus.emit({
        type: 'agent_died',
        agentId: this.agent.id,
        cause,
      });
    }

    // Notify engine for cleanup + other agent notification
    if (this.onDeath) {
      this.onDeath(this.agent.id, cause);
    }
  }

  /**
   * Infer mood from reflection text based on keyword matching.
   */
  private parseMoodFromReflection(reflection: string): Mood | null {
    if (!reflection) return null;
    const lower = reflection.toLowerCase();

    const moodKeywords: Record<Mood, string[]> = {
      happy: ['happy', 'joy', 'pleased', 'delighted', 'wonderful', 'great day', 'grateful', 'love'],
      angry: ['angry', 'furious', 'rage', 'outraged', 'infuriated', 'livid', 'hate'],
      sad: ['sad', 'lonely', 'depressed', 'heartbroken', 'miss', 'grief', 'sorrow', 'melancholy'],
      anxious: ['anxious', 'worried', 'nervous', 'uneasy', 'dread', 'fear', 'stress', 'tense'],
      excited: ['excited', 'thrilled', 'eager', 'can\'t wait', 'anticipat', 'energized'],
      scheming: ['scheming', 'plotting', 'plan', 'manipulat', 'leverage', 'exploit', 'advantage'],
      afraid: ['afraid', 'terrified', 'scared', 'frighten', 'danger', 'threat'],
      neutral: [],
    };

    let bestMood: Mood = 'neutral';
    let bestCount = 0;

    for (const [mood, keywords] of Object.entries(moodKeywords) as [Mood, string[]][]) {
      if (mood === 'neutral') continue;
      let count = 0;
      for (const kw of keywords) {
        if (lower.includes(kw)) count++;
      }
      if (count > bestCount) {
        bestCount = count;
        bestMood = mood;
      }
    }

    return bestCount > 0 ? bestMood : 'neutral';
  }

  private static readonly SLEEP_AREAS = ['park', 'garden', 'church', 'tavern', 'forest'];

  goToSleep(): void {
    this.currentGoals = [];

    // Deterministic sleep spot based on agent name (no randomness)
    const sleepArea = this.nameHash(AgentController.SLEEP_AREAS);
    const sleepPos = getAreaEntrance(sleepArea);

    const dist = Math.abs(this.agent.position.x - sleepPos.x) + Math.abs(this.agent.position.y - sleepPos.y);
    if (dist <= 1) {
      // Already at sleep spot — sleep immediately
      this.enterSleepState(sleepArea);
    } else {
      // Walk to sleep spot first
      this.pendingSleep = sleepArea;
      console.log(`[Agent] ${this.agent.config.name} walking to ${sleepArea} to sleep`);
      this.startMoveTo(sleepPos);
    }
  }

  private enterSleepState(sleepArea: string): void {
    this.state = 'sleeping';
    this.world.updateAgentState(this.agent.id, 'sleeping', '');
    this.broadcaster.agentAction(this.agent.id, 'sleeping', '\u{1F634}');
    console.log(`[Agent] ${this.agent.config.name} goes to sleep at ${sleepArea}`);

    void this.cognition.addMemory({
      id: crypto.randomUUID(),
      agentId: this.agent.id,
      type: 'observation',
      content: `I arrived at the ${sleepArea} and settled in for the night.`,
      importance: 3,
      timestamp: Date.now(),
      relatedAgentIds: [],
    });
  }

  private nameHash(areas: readonly string[]): string {
    let hash = 0;
    for (const ch of this.agent.config.name) {
      hash = ((hash << 5) - hash) + ch.charCodeAt(0);
      hash |= 0;
    }
    return areas[Math.abs(hash) % areas.length];
  }

  private shouldWake(time: GameTime): boolean {
    return time.hour === this.wakeHour && time.minute === 0;
  }

  private shouldSleep(time: GameTime): boolean {
    // Trigger once at exact sleep hour — sleepTriggered flag prevents re-firing
    return time.hour === this.sleepHour && time.minute === 0;
  }

  /** Begin the sleep sequence: store narrative memory, then reflect, then walk to bed */
  private beginSleepSequence(time: GameTime): void {
    // Store narrative bridge memory so agent knows WHY they're going to bed
    const sleepArea = this.nameHash(AgentController.SLEEP_AREAS);
    void this.cognition.addMemory({
      id: crypto.randomUUID(),
      agentId: this.agent.id,
      type: 'observation',
      content: `It's getting late. I was ${this.preSleepActivity} at ${this.preSleepArea}. Time to head to the ${sleepArea} and get some rest.`,
      importance: 3,
      timestamp: Date.now(),
      relatedAgentIds: [],
    });

    if (this.decisionQueue) {
      this.decisionQueue.enqueue({
        id: crypto.randomUUID(),
        agentId: this.agent.id,
        type: 'reflect',
        priority: 1,
        context: { trigger: 'bedtime', details: `day ${time.day}` },
        enqueuedAt: Date.now(),
        expiresAt: Date.now() + 120000,
      });
      this.state = 'deciding';
    } else {
      void this.doReflect();
    }
  }

  // --- Social Ledger Helpers ---

  /** Build context string of active commitments for think() and plan() */
  private buildLedgerContext(): string {
    const ledger = this.agent.socialLedger ?? [];
    const active = ledger.filter(e => e.status === 'proposed' || e.status === 'accepted');
    if (active.length === 0) return '';
    const lines = active.map(e => {
      const others = (e.targetIds ?? []).map(id => this.world.getAgent(id)?.config.name ?? 'someone').join(', ');
      const tag = e.source === 'secondhand' ? ' (secondhand)' : '';
      return `- [${e.status}] ${e.description}${tag}`;
    });
    return `\nMY COMMITMENTS:\n${lines.join('\n')}`;
  }

  /** Build reflection context of all ledger entries from today + active entries */
  private buildLedgerReflectionContext(): string {
    const ledger = this.agent.socialLedger ?? [];
    const today = ledger.filter(e => e.day === this.world.time.day || e.status === 'accepted');
    if (today.length === 0) return '';
    const lines = today.map(e => {
      const others = (e.targetIds ?? []).map(id => this.world.getAgent(id)?.config.name ?? 'someone').join(', ');
      return `- [${e.status}] ${e.description} (with ${others})`;
    });
    return `\nSOCIAL COMMITMENTS TODAY:\n${lines.join('\n')}`;
  }

  /** Mark expired ledger entries — no penalties, just status change */
  private checkLedgerExpiry(): void {
    const ledger = this.agent.socialLedger;
    if (!ledger) return;
    const now = this.world.time.totalMinutes;
    for (const entry of ledger) {
      if (entry.expiresAt && now >= entry.expiresAt && entry.status === 'accepted') {
        entry.status = 'expired';
        entry.resolvedAt = now;
      }
    }
  }

  /**
   * Build context about institutions for agent cognition.
   */
  buildInstitutionContext(): string {
    const institutions = Array.from(this.world.institutions.values()).filter(i => !i.dissolved);
    if (institutions.length === 0) return '';

    const lines: string[] = ['VILLAGE INSTITUTIONS:'];
    for (const inst of institutions) {
      const myMembership = inst.members.find(m => m.agentId === this.agent.id);
      const memberNames = inst.members
        .map(m => this.world.getAgent(m.agentId)?.config.name ?? m.agentId.slice(0, 6))
        .join(', ');
      let line = `- ${inst.name} (${inst.type}): ${inst.description || 'no description'}. ${inst.members.length} members [${memberNames}]. Treasury: ${inst.treasury}g.`;
      if (myMembership) {
        line += ` YOU are a ${myMembership.role}.`;
      }
      if (inst.rules.length > 0) {
        line += ` Rules: ${inst.rules.join('; ')}`;
      }
      lines.push(line);
    }

    lines.push('\nYou can form groups, propose rules, create organizations, join existing ones, or contribute gold to their treasury.');
    return lines.join('\n');
  }

  private static readonly PUBLIC_AREAS = ['plaza', 'cafe', 'park', 'market', 'garden', 'tavern', 'bakery', 'church', 'hospital', 'school', 'town_hall', 'workshop', 'farm', 'forest'];

  private resolveLocation(intention: string): string {
    const lower = intention.toLowerCase().trim();

    if (lower === 'home' || lower === 'house') {
      return this.nameHash(AgentController.PUBLIC_AREAS);
    }

    // Map common names to area IDs
    const mapping: Record<string, string> = {
      cafe: 'cafe',
      coffee: 'cafe',
      church: 'church',
      temple: 'church',
      chapel: 'church',
      hospital: 'hospital',
      clinic: 'hospital',
      school: 'school',
      library: 'school',
      'town hall': 'town_hall',
      townhall: 'town_hall',
      tavern: 'tavern',
      inn: 'tavern',
      bar: 'tavern',
      pub: 'tavern',
      bakery: 'bakery',
      baker: 'bakery',
      workshop: 'workshop',
      craft: 'workshop',
      farm: 'farm',
      field: 'farm',
      market: 'market',
      shop: 'market',
      store: 'market',
      plaza: 'plaza',
      square: 'plaza',
      park: 'park',
      lake: 'lake',
      forest: 'forest',
      woods: 'forest',
      garden: 'garden',
      'herb garden': 'garden',
      'southern woods': 'forest_south',
      'south forest': 'forest_south',
      cedar: 'forest_south',
      river: 'lake',
      water: 'lake',
      stream: 'lake',
      pond: 'lake',
      trees: 'forest',
      tree: 'forest',
      crops: 'farm',
      fields: 'farm',
      plants: 'garden',
      fountain: 'plaza',
      bench: 'park',
      oven: 'bakery',
      workbench: 'workshop',
      fireplace: 'tavern',
      beds: 'hospital',
      medicine: 'hospital',
      books: 'school',
      altar: 'church',
      desk: 'town_hall',
      stalls: 'market',
      // Resource names → gathering locations
      wheat: 'farm',
      grain: 'farm',
      vegetables: 'farm',
      fish: 'lake',
      fishing: 'lake',
      wood: 'forest',
      lumber: 'forest',
      mushrooms: 'forest',
      mushroom: 'forest',
      herbs: 'garden',
      herb: 'garden',
      flowers: 'garden',
      clay: 'lake',
      stone: 'lake',
    };

    // Sort by key length descending — prefer "herb garden" over "garden", "town hall" over "bar"
    const sorted = Object.entries(mapping).sort((a, b) => b[0].length - a[0].length);

    // Extract location from prepositional phrase: "gather herbs at the garden past the plaza" → "garden past the plaza"
    // Then match against that substring — "garden" appears before "plaza" positionally
    const prepMatch = lower.match(/\b(?:at|to|toward|towards|into|in)\s+(?:the\s+)?(.+)/);
    if (prepMatch) {
      const afterPrep = prepMatch[1]
        .replace(/^(?:the|a|an|my|our|village|town|local|old|new|main)\s+/g, '');
      for (const [key, areaId] of sorted) {
        if (afterPrep.includes(key)) return areaId;
      }
    }

    // Fallback: scan full text
    for (const [key, areaId] of sorted) {
      if (lower.includes(key)) return areaId;
    }

    // Default: plaza
    return 'plaza';
  }

  // =====================================================================
  // Refactor v2: Structured Decision System
  // =====================================================================

  /** Surface unresolved interpersonal dynamics for the decide prompt */
  private buildSocialPressure(): string {
    const lines: string[] = [];

    // Broken/expired promises
    const ledger = this.agent.socialLedger ?? [];
    const broken = ledger.filter(e =>
      e.status === 'broken' ||
      (e.status === 'expired' && e.resolvedAt && this.world.time.totalMinutes - e.resolvedAt < 1440)
    );
    for (const b of broken.slice(0, 3)) {
      lines.push(`UNRESOLVED: ${b.description} — this was ${b.status}`);
    }

    // Commitments due soon (within 2 game hours)
    const due = ledger.filter(e =>
      e.status === 'accepted' && e.expiresAt &&
      e.expiresAt - this.world.time.totalMinutes < 120 &&
      e.expiresAt > this.world.time.totalMinutes
    );
    for (const d of due.slice(0, 2)) {
      lines.push(`DUE SOON: ${d.description}`);
    }

    // Interpersonal tensions and bonds from mental models
    const knownPeople = this.agent.mentalModels ?? [];
    for (const model of knownPeople) {
      const name = this.world.getAgent(model.targetId)?.config.name;
      if (!name) continue;
      if (model.trust < -20) {
        lines.push(`TENSION: You don't trust ${name} (trust: ${model.trust})`);
      } else if (model.trust > 30) {
        lines.push(`BOND: You trust ${name} (trust: ${model.trust})`);
      }
    }

    // Drive pressures (belonging, status, meaning)
    const d = this.agent.drives;
    if (d) {
      if (d.belonging >= 60) lines.push('You feel isolated. You haven\'t connected with anyone recently.');
      if (d.status >= 60) lines.push('Nobody seems to value what you contribute.');
      if (d.meaning >= 70) lines.push('You\'ve been doing the same thing every day. You need purpose.');
    }

    return lines.length > 0 ? '\nWHAT\'S ON YOUR MIND:\n' + lines.join('\n') : '';
  }

  /** Time-of-day trigger — creates natural daily rhythm */
  private getTimeOfDayTrigger(hour: number): string {
    if (hour >= 6 && hour <= 9) return 'It\'s early. A new day. What matters today?';
    if (hour >= 10 && hour <= 14) return 'Middle of the day. How\'s it going?';
    if (hour >= 15 && hour <= 18) return 'Afternoon. Getting toward evening.';
    if (hour >= 19 && hour <= 22) return 'Evening is coming. The day is almost done. Did you do what you set out to? Is there anyone you need to see before dark?';
    return 'What now?';
  }

  /** Step 3: Build the full situation object for the LLM decide() call */
  private buildSituation(trigger: string, recentOutcome?: string): AgentSituation {
    const area = getAreaAt(this.agent.position);
    const areaId = area?.id ?? 'plaza';
    const seasonIdx = Math.floor((this.world.time.day - 1) / SEASON_LENGTH) % SEASON_ORDER.length;
    const currentSeason = SEASON_ORDER[seasonIdx];

    const actions: AvailableAction[] = [];

    // 1. GATHER actions
    const gatherOpts = getGatherOptions(areaId);
    for (const gDef of gatherOpts) {
      const seasonMod = gDef.seasonModifier?.[currentSeason] ?? 1.0;
      const chance = Math.round(gDef.baseSuccessChance * seasonMod * 100);
      const agentSkillLevel = this.agent.skills?.find(s => s.name === gDef.skill)?.level ?? 0;
      if (agentSkillLevel >= gDef.minSkillLevel && chance > 0) {
        actions.push({ id: 'gather_' + gDef.yields[0].resource, label: 'Gather ' + gDef.yields[0].resource + ' (' + chance + '% chance)', category: 'physical' });
      } else if (gDef.minSkillLevel > 0) {
        actions.push({ id: 'gather_' + gDef.yields[0].resource, label: 'Gather ' + gDef.yields[0].resource + ' (need ' + gDef.skill + ' Lv' + gDef.minSkillLevel + ')', category: 'physical' });
      }
    }

    // 2. CRAFT actions
    const agentSkillMap: Record<string, number> = {};
    for (const s of this.agent.skills ?? []) {
      agentSkillMap[s.name] = s.level;
    }
    const recipes = getAvailableRecipes(areaId, agentSkillMap);
    let craftCount = 0;
    for (const recipe of recipes) {
      if (craftCount >= 3) break;
      // Check if agent has at least 1 input or recipe needs 0 skill
      const hasAnyInput = recipe.inputs.some(inp =>
        this.agent.inventory.some(i => i.name.toLowerCase().replace(/\s+/g, '_') === inp.resource)
      );
      if (!hasAnyInput && recipe.minSkillLevel > 0) continue;

      const missing: string[] = [];
      for (const inp of recipe.inputs) {
        const owned = this.agent.inventory.filter(i => i.name.toLowerCase().replace(/\s+/g, '_') === inp.resource).length;
        if (owned < inp.qty) missing.push(`${inp.qty - owned} ${inp.resource}`);
      }
      const hasAll = missing.length === 0;
      actions.push({
        id: 'craft_' + recipe.id,
        label: recipe.name + (hasAll ? ' ✓ ready' : ' (need: ' + missing.join(', ') + ')'),
        category: 'physical',
      });
      craftCount++;
    }

    // 3. EAT actions
    const foodItems = this.agent.inventory.filter(i => i.type === 'food');
    const foodGroups: Record<string, number> = {};
    for (const item of foodItems) {
      foodGroups[item.name] = (foodGroups[item.name] || 0) + 1;
    }
    for (const [name, qty] of Object.entries(foodGroups)) {
      actions.push({
        id: 'eat_' + name.toLowerCase().replace(/\s+/g, '_'),
        label: 'Eat ' + name + (qty > 1 ? ` (${qty} available)` : ''),
        category: 'physical',
      });
    }

    // 4. SOCIAL actions
    const nearby = this.world.getNearbyAgents(this.agent.position, 5)
      .filter(a => a.id !== this.agent.id && a.alive !== false && a.state !== 'sleeping');
    const nearbyForSituation: { name: string; activity: string; id: string }[] = [];
    for (const a of nearby) {
      nearbyForSituation.push({ name: a.config.name, activity: a.currentAction || 'idle', id: a.id });
      const firstName = a.config.name.split(' ')[0].toLowerCase();

      // Talk
      if (this.conversationCooldown <= 0) {
        actions.push({ id: 'talk_' + firstName, label: 'Talk to ' + a.config.name, category: 'social' });
      }

      // Give / Trade (if agent has items)
      if (this.agent.inventory.length > 0) {
        actions.push({ id: 'give_to_' + firstName, label: 'Give something to ' + a.config.name, category: 'social' });
        actions.push({ id: 'trade_with_' + firstName, label: 'Propose a trade with ' + a.config.name, category: 'social' });
      }

      // Teach (if agent has a skill)
      const teachableSkills = this.agent.skills?.filter(s => s.level >= 1) ?? [];
      if (teachableSkills.length > 0) {
        actions.push({ id: 'teach_' + firstName, label: 'Teach ' + teachableSkills[0].name + ' to ' + a.config.name, category: 'social' });
      }

      // Confront (if trust is negative)
      const model = this.agent.mentalModels?.find(m => m.targetId === a.id);
      if (model && model.trust < 0) {
        actions.push({ id: 'confront_' + firstName, label: 'Confront ' + a.config.name, category: 'social' });
      }

      // Steal (always available as dark option)
      actions.push({ id: 'steal_from_' + firstName, label: 'Steal from ' + a.config.name + ' (risky)', category: 'social' });

      // Alliance
      actions.push({ id: 'ally_with_' + firstName, label: 'Propose alliance with ' + a.config.name, category: 'social' });
    }

    // Group actions (3+ agents nearby including self)
    if (nearby.length >= 2) {
      actions.push({ id: 'call_meeting', label: 'Call everyone here to discuss something', category: 'creative' });
      actions.push({ id: 'propose_rule', label: 'Propose a rule for the village', category: 'creative' });
      actions.push({ id: 'accuse_someone', label: 'Publicly accuse someone (everyone hears)', category: 'social' });
    }

    // Always available creative
    actions.push({ id: 'post_board', label: 'Write something on the village board', category: 'creative' });

    // 5. MOVEMENT actions
    for (const [areaKey, desc] of this.cognition.knownPlaces) {
      if (areaKey === areaId) continue;
      const areaName = desc.split(' — ')[0] || areaKey;
      actions.push({ id: 'go_' + areaKey, label: 'Go to ' + areaName, category: 'movement' });
    }

    // 6. ALWAYS available
    actions.push({ id: 'rest', label: 'Rest and recover energy', category: 'rest' });

    // Evening rhythm: put social actions FIRST (before physical) to create natural social time
    const hour = this.world.time.hour;
    let orderedActions: AvailableAction[];
    if (hour >= 19 && hour <= 22) {
      const social = actions.filter(a => a.category === 'social');
      const movement = actions.filter(a => a.category === 'movement');
      const rest = actions.filter(a => a.category === 'rest');
      const physical = actions.filter(a => a.category === 'physical');
      const creative = actions.filter(a => a.category === 'creative');
      orderedActions = [...social, ...movement, ...rest, ...physical, ...creative];
    } else {
      orderedActions = actions;
    }

    // Build inventory groups
    const invGroups: Record<string, { name: string; type: string; qty: number }> = {};
    for (const item of this.agent.inventory) {
      const key = item.name;
      if (!invGroups[key]) invGroups[key] = { name: item.name, type: item.type, qty: 0 };
      invGroups[key].qty++;
    }

    // Enrich trigger with time-of-day rhythm if it's the generic arrival/idle trigger
    const enrichedTrigger = trigger.startsWith('You just arrived')
      || trigger === 'You just finished a conversation. What now?'
      || trigger === 'What now?'
      ? trigger + ' ' + this.getTimeOfDayTrigger(hour)
      : trigger;

    // Social pressure and commitments
    const socialPressure = this.buildSocialPressure();
    const commitments = this.buildLedgerContext();

    return {
      location: area?.name ?? 'Unknown',
      areaId,
      time: { day: this.world.time.day, hour: this.world.time.hour },
      vitals: {
        hunger: this.agent.vitals?.hunger ?? 0,
        energy: this.agent.vitals?.energy ?? 100,
        health: this.agent.vitals?.health ?? 100,
      },
      inventory: Object.values(invGroups),
      nearbyAgents: nearbyForSituation,
      availableActions: orderedActions,
      recentOutcome,
      trigger: enrichedTrigger,
      goals: this.currentGoals.length > 0 ? this.currentGoals : undefined,
      socialPressure: socialPressure || undefined,
      commitments: commitments || undefined,
    };
  }

  /** Step 4: Apply an ActionOutcome to the world (items, vitals, skills, resources) */
  private applyOutcomeToWorld(outcome: ActionOutcome): void {
    const actor = this.agent;

    // Items consumed
    if (outcome.itemsConsumed) {
      for (const consumed of outcome.itemsConsumed) {
        for (let i = 0; i < consumed.qty; i++) {
          const item = actor.inventory.find(it => it.name.toLowerCase().replace(/\s+/g, '_') === consumed.resource);
          if (item) this.world.removeItem(item.id);
        }
      }
      this.broadcaster.agentInventory(actor.id, actor.inventory);
    }

    // Items gained (with building gather_bonus)
    if (outcome.itemsGained) {
      if (outcome.type === 'gather') {
        const area = this.world.getAreaAt(actor.position);
        if (area) {
          let gatherBonus = 0;
          for (const b of this.world.getBuildingsAt(area.id)) {
            if (!b.defId || !BUILDINGS[b.defId]) continue;
            const bDef = BUILDINGS[b.defId];
            const gatherEffect = bDef.effects?.find((e: any) => e.type === 'gather_bonus');
            if (gatherEffect) gatherBonus = Math.max(gatherBonus, gatherEffect.value);
          }
          if (gatherBonus > 0) {
            for (const gained of outcome.itemsGained) {
              const extra = Math.floor(gained.qty * gatherBonus);
              if (extra > 0) gained.qty += extra;
            }
          }
        }
      }
      for (const gained of outcome.itemsGained) {
        const resDef = RESOURCES[gained.resource];
        for (let i = 0; i < gained.qty; i++) {
          const item: Item = {
            id: crypto.randomUUID(),
            name: resDef?.name ?? gained.resource,
            description: `${resDef?.name ?? gained.resource} obtained by ${actor.config.name}`,
            ownerId: actor.id,
            createdBy: actor.id,
            value: resDef?.baseTradeValue ?? 5,
            type: (resDef?.type === 'food' || (resDef?.type === 'raw' && (resDef?.nutritionValue ?? 0) > 0)) ? 'food' : resDef?.type === 'tool' ? 'tool' : resDef?.type === 'medicine' ? 'medicine' : 'material',
          };
          this.world.addItem(item);
        }
      }
      this.broadcaster.agentInventory(actor.id, actor.inventory);

      // Deplete resource pool + daily gather counts
      if (outcome.type === 'gather') {
        const area = this.world.getAreaAt(actor.position);
        const aId = area?.id ?? 'unknown';
        const resource = outcome.itemsGained[0]?.resource;
        if (resource) this.world.depleteResource(aId, resource);
        const options = getGatherOptions(aId);
        for (const gDef of options) {
          if (gDef.yields.some((y: any) => y.resource === resource)) {
            const current = this.world.dailyGatherCounts.get(gDef.id) ?? 0;
            this.world.dailyGatherCounts.set(gDef.id, current + 1);
            break;
          }
        }
      }
    }

    // Skill XP (with building craft_speed bonus)
    if (outcome.skillXpGained) {
      if (outcome.type === 'craft') {
        const area = this.world.getAreaAt(actor.position);
        if (area) {
          let craftSpeed = 1;
          for (const b of this.world.getBuildingsAt(area.id)) {
            if (!b.defId || !BUILDINGS[b.defId]) continue;
            const bDef = BUILDINGS[b.defId];
            const craftEffect = bDef.effects?.find((e: any) => e.type === 'craft_speed');
            if (craftEffect) craftSpeed = Math.min(craftSpeed, craftEffect.value);
          }
          if (craftSpeed < 1) {
            const bonus = 1 - craftSpeed;
            outcome.skillXpGained.xp += Math.round(outcome.skillXpGained.xp * bonus);
          }
        }
      }
      this.world.addSkillXP(actor.id, outcome.skillXpGained.skill, outcome.skillXpGained.xp);
    }

    // Vitals
    if (actor.vitals) {
      if (outcome.energySpent !== 0) {
        actor.vitals.energy = Math.max(0, Math.min(100, actor.vitals.energy - outcome.energySpent));
      }
      if (outcome.hungerChange !== 0) {
        actor.vitals.hunger = Math.max(0, Math.min(100, actor.vitals.hunger + outcome.hungerChange));
      }
      if (outcome.healthChange !== 0) {
        actor.vitals.health = Math.max(0, Math.min(100, actor.vitals.health + outcome.healthChange));
      }
    }

    // Store outcome as memory
    void this.cognition.addMemory({
      id: crypto.randomUUID(),
      agentId: actor.id,
      type: 'observation',
      content: outcome.description,
      importance: outcome.success ? 4 : 6,
      timestamp: Date.now(),
      relatedAgentIds: [],
    });

    // Broadcast
    this.broadcaster.agentAction(actor.id, outcome.description);
  }

  /** Step 5: Execute a structured decision — dispatch to game systems */
  private async executeDecision(decision: AgentDecision, situation: AgentSituation): Promise<void> {
    const actionId = decision.actionId;

    // --- Gather ---
    if (actionId.startsWith('gather_')) {
      const resource = actionId.replace('gather_', '');
      const area = getAreaAt(this.agent.position);
      const areaId = area?.id ?? 'plaza';

      // Build AgentState for action-resolver
      const agentState: AgentState = {
        id: this.agent.id,
        name: this.agent.config.name,
        location: areaId,
        energy: this.agent.vitals?.energy ?? 100,
        hunger: this.agent.vitals?.hunger ?? 0,
        health: this.agent.vitals?.health ?? 100,
        inventory: this.buildInventoryForResolver(),
        skills: this.buildSkillsForResolver(),
        nearbyAgents: situation.nearbyAgents.map(a => ({ id: a.id, name: a.name })),
      };
      const worldState = this.buildWorldState();
      const intent = { type: 'gather' as const, resource, raw: `gather ${resource}` };
      const outcome = executeAction(intent, agentState, worldState);
      this.applyOutcomeToWorld(outcome);
      this.lastOutcome = outcome.description;
      this.lastTrigger = outcome.success
        ? `You just gathered ${resource}. ${outcome.description}`
        : `You tried to gather ${resource} but failed. ${outcome.description}`;
      this.state = 'performing';
      this.currentPerformingActivity = `gathering ${resource}`;
      this.activityTimer = 10;
      this.world.updateAgentState(this.agent.id, 'active', this.currentPerformingActivity);
      return;
    }

    // --- Eat ---
    if (actionId.startsWith('eat_')) {
      const foodName = actionId.replace('eat_', '');
      const agentState: AgentState = {
        id: this.agent.id,
        name: this.agent.config.name,
        location: getAreaAt(this.agent.position)?.id ?? 'plaza',
        energy: this.agent.vitals?.energy ?? 100,
        hunger: this.agent.vitals?.hunger ?? 0,
        health: this.agent.vitals?.health ?? 100,
        inventory: this.buildInventoryForResolver(),
        skills: this.buildSkillsForResolver(),
        nearbyAgents: [],
      };
      const worldState = this.buildWorldState();
      const intent = { type: 'eat' as const, resource: foodName, raw: `eat ${foodName}` };
      const outcome = executeAction(intent, agentState, worldState);
      this.applyOutcomeToWorld(outcome);
      this.lastOutcome = outcome.description;
      this.lastTrigger = outcome.success
        ? `You just ate. ${outcome.description}`
        : `You tried to eat but couldn't. ${outcome.description}`;
      this.state = 'performing';
      this.currentPerformingActivity = 'eating';
      this.activityTimer = 5;
      this.world.updateAgentState(this.agent.id, 'active', 'eating');
      return;
    }

    // --- Craft ---
    if (actionId.startsWith('craft_')) {
      const recipeId = actionId.replace('craft_', '');
      const recipe = RECIPES.find(r => r.id === recipeId);
      if (!recipe) {
        this.lastTrigger = `You wanted to craft something but couldn't figure out how.`;
        this.state = 'idle';
        this.idleTimer = 0;
        return;
      }
      const agentState: AgentState = {
        id: this.agent.id,
        name: this.agent.config.name,
        location: getAreaAt(this.agent.position)?.id ?? 'plaza',
        energy: this.agent.vitals?.energy ?? 100,
        hunger: this.agent.vitals?.hunger ?? 0,
        health: this.agent.vitals?.health ?? 100,
        inventory: this.buildInventoryForResolver(),
        skills: this.buildSkillsForResolver(),
        nearbyAgents: [],
      };
      const worldState = this.buildWorldState();
      const intent = { type: 'craft' as const, recipe: recipeId, raw: `craft ${recipe.name}` };
      const outcome = executeAction(intent, agentState, worldState);
      this.applyOutcomeToWorld(outcome);
      this.lastOutcome = outcome.description;
      this.lastTrigger = outcome.success
        ? `You crafted ${recipe.name}. ${outcome.description}`
        : `You tried to craft ${recipe.name} but failed. ${outcome.description}`;
      this.state = 'performing';
      this.currentPerformingActivity = `crafting ${recipe.name}`;
      this.activityTimer = 15;
      this.world.updateAgentState(this.agent.id, 'active', this.currentPerformingActivity);
      return;
    }

    // --- Movement ---
    if (actionId.startsWith('go_')) {
      const targetAreaId = actionId.replace('go_', '');
      const targetPos = getRandomPositionInArea(targetAreaId);
      this.startMoveTo(targetPos);
      this.broadcaster.agentAction(this.agent.id, `heading to ${targetAreaId}`);
      return;
    }

    // --- Social (talk) ---
    if (actionId.startsWith('talk_')) {
      const firstName = actionId.replace('talk_', '');
      // Find the agent by first name
      for (const agent of this.world.agents.values()) {
        if (agent.id !== this.agent.id &&
            agent.config.name.split(' ')[0].toLowerCase() === firstName) {
          this.pendingConversationTarget = agent.id;
          this.pendingConversationPurpose = decision.reason;
          // Move toward target if far
          const dist = Math.abs(this.agent.position.x - agent.position.x) + Math.abs(this.agent.position.y - agent.position.y);
          if (dist > 3) {
            this.startMoveTo({ ...agent.position });
          } else if (this.soloActionExecutor) {
            const started = this.soloActionExecutor.requestConversation(this.agent.id, agent.id);
            if (started) {
              this.pendingConversationTarget = null;
              this.pendingConversationPurpose = null;
            }
          }
          return;
        }
      }
      // Agent not found — go idle
      this.lastTrigger = `You looked around but couldn't find who you wanted to talk to.`;
      this.state = 'idle';
      this.idleTimer = 0;
      return;
    }

    // --- Rest ---
    if (actionId === 'rest') {
      this.state = 'performing';
      this.currentPerformingActivity = 'resting';
      this.activityTimer = 20;
      this.world.updateAgentState(this.agent.id, 'active', 'resting');
      // Resting energy recovery is handled by tickVitals
      this.broadcaster.agentAction(this.agent.id, 'resting');
      return;
    }

    // --- Give ---
    if (actionId.startsWith('give_to_')) {
      const firstName = actionId.replace('give_to_', '');
      const target = this.findNearbyByFirstName(firstName);
      if (!target || this.agent.inventory.length === 0) {
        this.lastTrigger = 'You wanted to give something but couldn\'t.';
        this.state = 'idle'; this.idleTimer = 0; return;
      }
      // Pick item: first non-food, or first food
      const item = this.agent.inventory.find(i => i.type !== 'food') || this.agent.inventory[0];
      const agentState = this.buildAgentStateForResolver(situation);
      const worldState = this.buildWorldState();
      const intent = { type: 'give' as const, resource: item.name.toLowerCase().replace(/\s+/g, '_'), targetAgent: target.config.name.split(' ')[0], quantity: 1, raw: `give ${item.name} to ${target.config.name}` };
      const outcome = executeAction(intent, agentState, worldState);
      this.applyOutcomeToWorld(outcome);
      this.lastOutcome = outcome.description;
      this.lastTrigger = outcome.description;
      // Adjust trust: target trusts giver more
      this.adjustTrust(target, this.agent, 10);
      this.state = 'performing'; this.activityTimer = 5;
      this.world.updateAgentState(this.agent.id, 'active', `giving ${item.name} to ${target.config.name}`);
      this.broadcaster.agentAction(this.agent.id, `gave ${item.name} to ${target.config.name}`);
      return;
    }

    // --- Trade ---
    if (actionId.startsWith('trade_with_')) {
      const firstName = actionId.replace('trade_with_', '');
      const target = this.findNearbyByFirstName(firstName);
      if (!target || this.agent.inventory.length === 0) {
        this.lastTrigger = 'You wanted to trade but couldn\'t.';
        this.state = 'idle'; this.idleTimer = 0; return;
      }
      const item = this.agent.inventory[0];
      const agentState = this.buildAgentStateForResolver(situation);
      const worldState = this.buildWorldState();
      const intent = { type: 'trade_offer' as const, offerItems: [{ resource: item.name.toLowerCase().replace(/\s+/g, '_'), qty: 1 }], requestItems: [], targetAgent: target.config.name.split(' ')[0], raw: `trade ${item.name} with ${target.config.name}` };
      const outcome = executeAction(intent, agentState, worldState);
      this.applyOutcomeToWorld(outcome);
      this.lastOutcome = outcome.description;
      this.lastTrigger = outcome.description;
      this.state = 'performing'; this.activityTimer = 5;
      this.world.updateAgentState(this.agent.id, 'active', `trading with ${target.config.name}`);
      this.broadcaster.agentAction(this.agent.id, `proposed trade with ${target.config.name}`);
      return;
    }

    // --- Teach ---
    if (actionId.startsWith('teach_')) {
      const firstName = actionId.replace('teach_', '');
      const target = this.findNearbyByFirstName(firstName);
      const skill = this.agent.skills?.find(s => s.level >= 1);
      if (!target || !skill) {
        this.lastTrigger = 'You wanted to teach but couldn\'t.';
        this.state = 'idle'; this.idleTimer = 0; return;
      }
      const agentState = this.buildAgentStateForResolver(situation);
      const worldState = this.buildWorldState();
      const intent = { type: 'teach' as const, skill: skill.name, targetAgent: target.config.name.split(' ')[0], raw: `teach ${skill.name} to ${target.config.name}` };
      const outcome = executeAction(intent, agentState, worldState);
      this.applyOutcomeToWorld(outcome);
      this.lastOutcome = outcome.description;
      this.lastTrigger = outcome.description;
      this.adjustTrust(target, this.agent, 5);
      this.state = 'performing'; this.activityTimer = 10;
      this.world.updateAgentState(this.agent.id, 'active', `teaching ${skill.name} to ${target.config.name}`);
      this.broadcaster.agentAction(this.agent.id, `teaching ${skill.name} to ${target.config.name}`);
      return;
    }

    // --- Confront ---
    if (actionId.startsWith('confront_')) {
      const firstName = actionId.replace('confront_', '');
      const target = this.findNearbyByFirstName(firstName);
      if (!target) {
        this.lastTrigger = 'You wanted to confront someone but they weren\'t here.';
        this.state = 'idle'; this.idleTimer = 0; return;
      }
      const confrontText = decision.sayAloud || decision.reason;
      // Memory for both
      void this.cognition.addMemory({ id: crypto.randomUUID(), agentId: this.agent.id, type: 'action_outcome', content: `I confronted ${target.config.name}: ${confrontText}`, importance: 7, timestamp: Date.now(), relatedAgentIds: [target.id] });
      const targetCognition = this.world.agents.has(target.id) ? (this as any).cognition : null;
      // Witness memories for all nearby
      const nearbyAll = this.world.getNearbyAgents(this.agent.position, 5).filter(a => a.id !== this.agent.id);
      for (const witness of nearbyAll) {
        const wCog = (this as any).world?.cognitions?.get?.(witness.id);
      }
      this.adjustTrust(target, this.agent, -15);
      this.adjustTrust(this.agent, target, -15);
      // Force target to react
      const targetCtrl = (this.world as any).controllers?.get?.(target.id);
      this.lastOutcome = `You confronted ${target.config.name}.`;
      this.lastTrigger = `You just confronted ${target.config.name}. How do they react?`;
      this.state = 'performing'; this.activityTimer = 5;
      this.world.updateAgentState(this.agent.id, 'active', `confronting ${target.config.name}`);
      this.broadcaster.agentAction(this.agent.id, `confronted ${target.config.name}`);
      return;
    }

    // --- Steal ---
    if (actionId.startsWith('steal_from_')) {
      const firstName = actionId.replace('steal_from_', '');
      const target = this.findNearbyByFirstName(firstName);
      if (!target) {
        this.lastTrigger = 'You wanted to steal but the target wasn\'t here.';
        this.state = 'idle'; this.idleTimer = 0; return;
      }
      const agentState = this.buildAgentStateForResolver(situation);
      const worldState = this.buildWorldState();
      const intent = { type: 'steal' as const, targetAgent: target.config.name.split(' ')[0], raw: `steal from ${target.config.name}` };
      const outcome = executeAction(intent, agentState, worldState);
      this.applyOutcomeToWorld(outcome);
      this.lastOutcome = outcome.description;
      this.lastTrigger = outcome.description;
      this.state = 'performing'; this.activityTimer = 5;
      this.world.updateAgentState(this.agent.id, 'active', `stealing`);
      return;
    }

    // --- Alliance ---
    if (actionId.startsWith('ally_with_')) {
      const firstName = actionId.replace('ally_with_', '');
      const target = this.findNearbyByFirstName(firstName);
      if (!target) {
        this.lastTrigger = 'You wanted to form an alliance but they weren\'t here.';
        this.state = 'idle'; this.idleTimer = 0; return;
      }
      // Create ledger entries for both
      const entry = { id: crypto.randomUUID(), type: 'alliance' as const, description: `Alliance between ${this.agent.config.name} and ${target.config.name}`, withAgentId: target.id, status: 'active' as const, createdDay: this.world.time.day };
      if (!this.agent.socialLedger) this.agent.socialLedger = [];
      this.agent.socialLedger.push(entry as any);
      if (!target.socialLedger) target.socialLedger = [];
      target.socialLedger.push({ ...entry, withAgentId: this.agent.id } as any);
      // Memories + trust
      void this.cognition.addMemory({ id: crypto.randomUUID(), agentId: this.agent.id, type: 'action_outcome', content: `I formed an alliance with ${target.config.name}.`, importance: 7, timestamp: Date.now(), relatedAgentIds: [target.id] });
      this.adjustTrust(this.agent, target, 20);
      this.adjustTrust(target, this.agent, 20);
      this.lastOutcome = `You formed an alliance with ${target.config.name}.`;
      this.lastTrigger = this.lastOutcome;
      this.state = 'performing'; this.activityTimer = 5;
      this.world.updateAgentState(this.agent.id, 'active', `forming alliance with ${target.config.name}`);
      this.broadcaster.agentAction(this.agent.id, `formed alliance with ${target.config.name}`);
      return;
    }

    // --- Post Board ---
    if (actionId === 'post_board') {
      const content = decision.sayAloud || decision.reason || 'A message for the village.';
      const post = {
        id: crypto.randomUUID(),
        authorId: this.agent.id,
        authorName: this.agent.config.name,
        type: 'announcement' as const,
        content,
        timestamp: Date.now(),
        day: this.world.time.day,
      };
      this.world.addBoardPost(post);
      this.broadcaster.boardPost(post);
      void this.cognition.addMemory({ id: crypto.randomUUID(), agentId: this.agent.id, type: 'action_outcome', content: `I posted on the village board: "${content.slice(0, 80)}"`, importance: 4, timestamp: Date.now(), relatedAgentIds: [] });
      this.lastOutcome = `You posted on the village board.`;
      this.lastTrigger = this.lastOutcome;
      this.state = 'performing'; this.activityTimer = 5;
      this.world.updateAgentState(this.agent.id, 'active', 'posting on board');
      this.broadcaster.agentAction(this.agent.id, `posted on village board`);
      return;
    }

    // --- Call Meeting ---
    if (actionId === 'call_meeting') {
      const nearbyAll = this.world.getNearbyAgents(this.agent.position, 5).filter(a => a.id !== this.agent.id && a.alive !== false);
      const names = nearbyAll.map(a => a.config.name).join(', ');
      void this.cognition.addMemory({ id: crypto.randomUUID(), agentId: this.agent.id, type: 'action_outcome', content: `I called a meeting with ${names}.`, importance: 6, timestamp: Date.now(), relatedAgentIds: nearbyAll.map(a => a.id) });
      this.lastOutcome = `You called a meeting. ${names} are listening.`;
      this.lastTrigger = this.lastOutcome;
      this.state = 'performing'; this.activityTimer = 5;
      this.world.updateAgentState(this.agent.id, 'active', 'calling meeting');
      this.broadcaster.agentAction(this.agent.id, `called a meeting`);
      return;
    }

    // --- Propose Rule ---
    if (actionId === 'propose_rule') {
      const ruleContent = decision.sayAloud || decision.reason || 'A new rule for the village.';
      const post = {
        id: crypto.randomUUID(),
        authorId: this.agent.id,
        authorName: this.agent.config.name,
        type: 'rule' as const,
        content: ruleContent,
        timestamp: Date.now(),
        day: this.world.time.day,
      };
      this.world.addBoardPost(post);
      this.broadcaster.boardPost(post);
      void this.cognition.addMemory({ id: crypto.randomUUID(), agentId: this.agent.id, type: 'action_outcome', content: `I proposed a rule: "${ruleContent.slice(0, 80)}"`, importance: 6, timestamp: Date.now(), relatedAgentIds: [] });
      this.lastOutcome = `You proposed a rule for the village.`;
      this.lastTrigger = this.lastOutcome;
      this.state = 'performing'; this.activityTimer = 5;
      this.world.updateAgentState(this.agent.id, 'active', 'proposing rule');
      this.broadcaster.agentAction(this.agent.id, `proposed a village rule`);
      return;
    }

    // --- Accuse ---
    if (actionId === 'accuse_someone') {
      const accusation = decision.sayAloud || decision.reason || 'I accuse someone.';
      // Try to parse target name from accusation text
      const nearbyAll = this.world.getNearbyAgents(this.agent.position, 5).filter(a => a.id !== this.agent.id && a.alive !== false);
      let accused: typeof nearbyAll[0] | undefined;
      for (const a of nearbyAll) {
        if (accusation.toLowerCase().includes(a.config.name.split(' ')[0].toLowerCase())) {
          accused = a; break;
        }
      }
      // Memories for all nearby
      for (const witness of nearbyAll) {
        void this.cognition.addMemory({ id: crypto.randomUUID(), agentId: witness.id, type: 'observation', content: `${this.agent.config.name} publicly accused ${accused?.config.name ?? 'someone'}: "${accusation.slice(0, 80)}"`, importance: 7, timestamp: Date.now(), relatedAgentIds: [this.agent.id, ...(accused ? [accused.id] : [])] });
      }
      // Post on board
      const post = {
        id: crypto.randomUUID(),
        authorId: this.agent.id,
        authorName: this.agent.config.name,
        type: 'rumor' as const,
        content: accusation,
        timestamp: Date.now(),
        day: this.world.time.day,
        targetIds: accused ? [accused.id] : undefined,
      };
      this.world.addBoardPost(post);
      this.broadcaster.boardPost(post);
      if (accused) {
        this.adjustTrust(this.agent, accused, -15);
        this.adjustTrust(accused, this.agent, -15);
      }
      this.lastOutcome = `You publicly accused ${accused?.config.name ?? 'someone'}.`;
      this.lastTrigger = this.lastOutcome;
      this.state = 'performing'; this.activityTimer = 5;
      this.world.updateAgentState(this.agent.id, 'active', 'accusing');
      this.broadcaster.agentAction(this.agent.id, `accused ${accused?.config.name ?? 'someone'}`);
      return;
    }

    // Unrecognized — fall back to idle
    console.warn(`[Agent] ${this.agent.config.name} unrecognized actionId: ${actionId}`);
    this.state = 'idle';
    this.idleTimer = 0;
  }

  /** Step 6: The core loop — build situation, ask LLM, execute decision */
  async decideAndAct(): Promise<void> {
    if (this.decidingInProgress || this.apiExhausted) return;
    this.decidingInProgress = true;

    try {
      const situation = this.buildSituation(this.lastTrigger, this.lastOutcome);
      this.lastOutcome = undefined;

      const decision = await this.cognition.decide(situation);
      this.handleApiSuccess();

      // Guard: agent may have entered a conversation while awaiting LLM
      if (this.state === 'conversing') return;

      // Store reason as thought memory
      void this.cognition.addMemory({
        id: crypto.randomUUID(),
        agentId: this.agent.id,
        type: 'observation',
        content: decision.reason,
        importance: 3,
        timestamp: Date.now(),
        relatedAgentIds: [],
      });

      // Update mood
      if (decision.mood) {
        this.agent.mood = decision.mood as any;
        this.broadcaster.agentMood(this.agent.id, decision.mood as any);
      }

      // Broadcast thought
      this.broadcaster.agentThought(this.agent.id, decision.reason);

      await this.executeDecision(decision, situation);

    } catch (err) {
      this.handleApiFailure(err);
      this.state = 'idle';
      this.idleTimer = 0;
    } finally {
      this.decidingInProgress = false;
    }
  }

  /** Helper: build inventory array for action-resolver's AgentState */
  private buildInventoryForResolver(): { resource: string; qty: number }[] {
    const groups: Record<string, number> = {};
    for (const item of this.agent.inventory) {
      const key = item.name.toLowerCase().replace(/\s+/g, '_');
      groups[key] = (groups[key] || 0) + 1;
    }
    return Object.entries(groups).map(([resource, qty]) => ({ resource, qty }));
  }

  /** Helper: build skills map for action-resolver's AgentState */
  private buildSkillsForResolver(): Record<string, { level: number; xp: number }> {
    const skills: Record<string, { level: number; xp: number }> = {};
    for (const s of this.agent.skills ?? []) {
      skills[s.name] = { level: s.level, xp: s.xp ?? 0 };
    }
    return skills;
  }

  /** Helper: build WorldState for action-resolver */
  /** Find a nearby agent by first name (lowercase) */
  private findNearbyByFirstName(firstName: string): Agent | undefined {
    const nearby = this.world.getNearbyAgents(this.agent.position, 5);
    return nearby.find(a => a.id !== this.agent.id && a.config.name.split(' ')[0].toLowerCase() === firstName);
  }

  /** Build AgentState for the action resolver */
  private buildAgentStateForResolver(situation: AgentSituation): AgentState {
    return {
      id: this.agent.id,
      name: this.agent.config.name,
      location: situation.areaId,
      energy: this.agent.vitals?.energy ?? 100,
      hunger: this.agent.vitals?.hunger ?? 0,
      health: this.agent.vitals?.health ?? 100,
      inventory: this.buildInventoryForResolver(),
      skills: this.buildSkillsForResolver(),
      nearbyAgents: situation.nearbyAgents.map(a => ({ id: a.id, name: a.name })),
    };
  }

  /** Adjust one agent's mental model trust toward another */
  private adjustTrust(agent: Agent, toward: Agent, delta: number): void {
    if (!agent.mentalModels) agent.mentalModels = [];
    const existing = agent.mentalModels.find(m => m.targetId === toward.id);
    if (existing) {
      existing.trust = Math.max(-100, Math.min(100, existing.trust + delta));
      existing.lastUpdated = Date.now();
    } else {
      agent.mentalModels.push({ targetId: toward.id, trust: delta, predictedGoal: '', emotionalStance: 'neutral', notes: [], lastUpdated: Date.now() });
    }
  }

  private buildWorldState(): WorldState {
    const seasonIdx = Math.floor((this.world.time.day - 1) / SEASON_LENGTH) % SEASON_ORDER.length;
    return {
      season: SEASON_ORDER[seasonIdx],
      dailyGatherCounts: this.world.dailyGatherCounts,
      activeBuildProjects: this.world.activeBuildProjects,
      pendingTrades: this.world.pendingTrades,
      getAgentInventory: (agentId: string) => {
        const agent = this.world.getAgent(agentId);
        if (!agent) return [];
        const groups: Record<string, number> = {};
        for (const item of agent.inventory) {
          const key = item.name.toLowerCase().replace(/\s+/g, '_');
          groups[key] = (groups[key] || 0) + 1;
        }
        return Object.entries(groups).map(([resource, qty]) => ({ resource, qty }));
      },
    };
  }
}
