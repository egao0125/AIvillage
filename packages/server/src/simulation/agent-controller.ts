import type { Agent, BoardPost, DriveState, GameTime, Institution, Mood, Position, ThinkOutput, VitalState } from '@ai-village/shared';
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
  private askCooldown: number = 0; // ticks remaining before agent can ask again
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
  private lastHungerConcernBand: number = 0;
  public lastOutcomeDescription: string = '';
  decisionQueue?: DecisionQueue;  // Infra 3: injected by engine
  // Refactor v2: structured decision system
  public currentGoals: string[] = [];
  private decidingInProgress: boolean = false;
  lastTrigger: string = 'You just arrived. Look around and decide what to do.';
  private lastOutcome: string | undefined;
  // Four Stream Memory: importance accumulator for belief generation
  private importanceAccum: number = 0;
  // Sequential actions: store why agent is moving so arrival trigger includes intent
  private pendingArrivalIntent: string | null = null;
  private lastBeliefTick: number = 0;

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
    // Only log transitions that matter narratively — skip idle/moving/performing churn
    if (to !== 'sleeping' && to !== 'conversing') return;

    const area = getAreaAt(this.agent.position);
    const location = area?.name ?? 'the village';
    const content = to === 'sleeping'
      ? `I went to sleep at ${location}.`
      : `I started a conversation at ${location}.`;

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
    if (this.askCooldown > 0) this.askCooldown--;

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
          this.world.updateAgentState(this.agent.id, 'idle', '');
          // Action completed → decide immediately
          // The outcome memory is already stored, trigger is set
          if (!this.decidingInProgress && !this.apiExhausted) {
            void this.decideAndAct();
          }
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
        // Fallback: if nothing triggered a decision for 20 ticks,
        // force one. This is a safety net, not the primary trigger.
        if (this.idleTimer >= 20 && !this.decidingInProgress) {
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

    // Four Stream: trigger belief generation when importance accumulates
    if (this.cognition.fourStream &&
        this.importanceAccum >= 100 &&
        this.world.time.totalMinutes - this.lastBeliefTick > 480 &&
        this.state === 'idle' && !this.decidingInProgress) {
      this.importanceAccum = 0;
      this.lastBeliefTick = this.world.time.totalMinutes;
      void this.cognition.fourStream.generateBeliefs(this.cognition.llmProvider);
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
      const areaName = area?.name ?? 'your destination';
      if (this.pendingArrivalIntent) {
        this.lastTrigger = `You arrived at ${areaName}. You came here because: ${this.pendingArrivalIntent}`;
        this.pendingArrivalIntent = null;
      } else {
        this.lastTrigger = `You arrived at ${areaName}. Look around and decide what to do.`;
      }
      this.state = 'idle';
      this.world.updateAgentState(this.agent.id, 'idle', '');
      // Already at destination → decide immediately
      if (!this.decidingInProgress && !this.apiExhausted) {
        void this.decideAndAct();
      }
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
        this.world.updateAgentState(this.agent.id, 'idle', '');
        // Target not found → decide immediately
        if (!this.decidingInProgress && !this.apiExhausted) {
          void this.decideAndAct();
        }
      } else {
        const area = getAreaAt(this.agent.position);
        const areaName = area?.name ?? 'your destination';
        if (this.pendingArrivalIntent) {
          this.lastTrigger = `You arrived at ${areaName}. You came here because: ${this.pendingArrivalIntent}`;
          this.pendingArrivalIntent = null;
        } else {
          this.lastTrigger = `You arrived at ${areaName}. Look around and decide what to do.`;
        }
        this.state = 'idle';
        this.world.updateAgentState(this.agent.id, 'idle', '');
        // Arrived → decide immediately with arrival context
        if (!this.decidingInProgress && !this.apiExhausted) {
          void this.decideAndAct();
        }
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
      this.conversationCooldown = 60; // ~5 seconds before this agent can talk again
      this.lastTrigger = 'You just finished a conversation. What now?';
      this.world.updateAgentState(this.agent.id, 'idle', '');
      // Conversation ended → decide what to do next
      if (!this.decidingInProgress && !this.apiExhausted) {
        void this.decideAndAct();
      }
    }
  }

  // (thinkThenAct, thinkAfterOutcome removed in refactor v2 — replaced by decideAndAct)

  /**
   * Event-driven think — immediate, bypasses the 60-minute cooldown.
   * Used for: witnessing events, vital threshold crossings, conversation endings.
   */
  // thinkOnEvent removed — think() now fires only as board post reactions

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
            this.broadcaster.ledgerUpdate(this.agent.id, entry);
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
      // Four Stream: nightly compression — beliefs + prune timeline + prune concerns
      if (this.cognition.fourStream) {
        await this.cognition.fourStream.nightlyCompression(this.cognition.llmProvider);
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

      // Hunger rate: 1.0/hour awake, 0.3/hour sleeping
      // At 1.0/hour awake: ~19 hunger/day (16 awake + 2.4 sleep)
      // This makes survival possible with effort
      if (this.state === 'sleeping') {
        v.hunger = Math.min(100, v.hunger + 0.3);
      } else {
        v.hunger = Math.min(100, v.hunger + 1.0);
      }

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
      v.health = Math.min(100, v.health + 1);
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
    }
    if (energyBand > this.lastEnergyBand) {
      const vitalsMemId = crypto.randomUUID();
      void this.cognition.addMemory({
        id: vitalsMemId, agentId: this.agent.id, type: 'observation',
        content: `I'm ${energyBand === 2 ? 'completely exhausted' : 'getting tired'}. Energy: ${Math.round(v.energy)}/100.`,
        importance: energyBand === 2 ? 7 : 5,
        timestamp: Date.now(), relatedAgentIds: [],
      });
    }
    if (healthBand > this.lastHealthBand) {
      const vitalsMemId = crypto.randomUUID();
      void this.cognition.addMemory({
        id: vitalsMemId, agentId: this.agent.id, type: 'observation',
        content: `I'm ${healthBand === 2 ? 'critically injured' : 'hurt and need care'}. Health: ${Math.round(v.health)}/100.`,
        importance: healthBand === 2 ? 8 : 6,
        timestamp: Date.now(), relatedAgentIds: [],
      });
    }

    // Four Stream: add vitals as concerns at threshold crossings
    // At 1 hunger/hour: band 1 ~Day 1, band 2 ~Day 2-3, band 3 ~Day 3-4 (desperate enough to steal)
    if (this.cognition.fourStream) {
      const hungerConcernBand = v.hunger >= 85 ? 3 : v.hunger >= 60 ? 2 : v.hunger >= 35 ? 1 : 0;
      if (hungerConcernBand > this.lastHungerConcernBand) {
        const urgency = hungerConcernBand === 3 ? 'I\'m starving. I need food NOW — I\'d do anything to eat.'
          : hungerConcernBand === 2 ? 'I\'m really hungry. I need to find food urgently.'
          : 'I\'m getting hungry. I should look for food.';
        this.cognition.fourStream.addConcern({
          id: crypto.randomUUID(),
          content: urgency,
          category: 'need',
          relatedAgentIds: [],
          createdAt: this.world.time.totalMinutes,
          expiresAt: this.world.time.totalMinutes + 480,
        });
      }
      this.lastHungerConcernBand = hungerConcernBand;

      if (energyBand > this.lastEnergyBand && energyBand >= 1) {
        this.cognition.fourStream.addConcern({
          id: crypto.randomUUID(),
          content: energyBand === 2 ? 'I can barely stand. I need rest desperately.' : 'I\'m getting tired. Should rest soon.',
          category: 'need',
          relatedAgentIds: [],
          createdAt: this.world.time.totalMinutes,
          expiresAt: this.world.time.totalMinutes + 480,
        });
      }
      if (healthBand > this.lastHealthBand && healthBand >= 1) {
        this.cognition.fourStream.addConcern({
          id: crypto.randomUUID(),
          content: healthBand === 2 ? 'I\'m critically injured. I might die.' : 'I\'m hurt and need medicine or rest.',
          category: 'threat',
          relatedAgentIds: [],
          createdAt: this.world.time.totalMinutes,
        });
      }
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

    // PUBLIC: news post for death
    const deathPost: BoardPost = {
      id: crypto.randomUUID(),
      authorId: 'system',
      authorName: 'Village News',
      type: 'news',
      channel: 'all',
      content: `${this.agent.config.name} has died of ${cause}.`,
      timestamp: Date.now(),
      day: this.world.time.day,
    };
    this.world.addBoardPost(deathPost);
    this.broadcaster.boardPost(deathPost);
    if (this.bus) this.bus.emit({ type: 'board_post_created', post: deathPost });

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
  /** Step 3: Build the full situation object for the LLM decide() call */
  private buildSituation(trigger: string, recentOutcome?: string): AgentSituation {
    const area = getAreaAt(this.agent.position);
    const areaId = area?.id ?? 'plaza';
    const seasonIdx = Math.floor((this.world.time.day - 1) / SEASON_LENGTH) % SEASON_ORDER.length;
    const currentSeason = SEASON_ORDER[seasonIdx];
    const hour = this.world.time.hour;

    const actions: AvailableAction[] = [];

    // ========================================
    // 1. PHYSICAL ACTIONS (location + skill + inventory checks)
    // ========================================

    // Gather — filtered by location and skill
    const gatherOpts = getGatherOptions(areaId);
    for (const gDef of gatherOpts) {
      const seasonMod = gDef.seasonModifier?.[currentSeason] ?? 1.0;
      const chance = Math.round(gDef.baseSuccessChance * seasonMod * 100);
      const agentSkillLevel = this.agent.skills?.find(s => s.name === gDef.skill)?.level ?? 0;
      if (agentSkillLevel >= gDef.minSkillLevel && chance > 0) {
        actions.push({
          id: 'gather_' + gDef.yields[0].resource,
          label: 'Gather ' + gDef.yields[0].resource + ' (' + chance + '% chance)',
          category: 'physical',
        });
      }
    }

    // Craft — filtered by location and skill and ingredients
    const agentSkillMap: Record<string, number> = {};
    for (const s of this.agent.skills ?? []) {
      agentSkillMap[s.name] = s.level;
    }
    const recipes = getAvailableRecipes(areaId, agentSkillMap);
    let craftCount = 0;
    for (const recipe of recipes) {
      if (craftCount >= 3) break;
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
        label: recipe.name + (hasAll ? ' (ready)' : ' (need: ' + missing.join(', ') + ')'),
        category: 'physical',
      });
      craftCount++;
    }

    // Eat — filtered by actual food in inventory
    const foodGroups: Record<string, number> = {};
    for (const item of this.agent.inventory.filter(i => i.type === 'food')) {
      foodGroups[item.name] = (foodGroups[item.name] || 0) + 1;
    }
    for (const [name, qty] of Object.entries(foodGroups)) {
      actions.push({
        id: 'eat_' + name.toLowerCase().replace(/\s+/g, '_'),
        label: 'Eat ' + name + (qty > 1 ? ` (${qty} available)` : ''),
        category: 'physical',
      });
    }

    // ========================================
    // 2. SOCIAL ACTIONS — pattern-based, listed ONCE (not per agent)
    //    The LLM fills in the name from the nearby list.
    // ========================================

    const nearby = this.world.getNearbyAgents(this.agent.position, 5)
      .filter(a => a.id !== this.agent.id && a.alive !== false && a.state !== 'sleeping');
    const nearbyForSituation: { name: string; activity: string; id: string }[] = [];

    for (const a of nearby) {
      const otherInv = a.inventory.length > 0
        ? a.inventory.reduce((acc: Record<string, number>, item) => {
            acc[item.name] = (acc[item.name] || 0) + 1;
            return acc;
          }, {} as Record<string, number>)
        : {};
      const otherInvStr = Object.entries(otherInv).length > 0
        ? ' [carrying: ' + Object.entries(otherInv).map(([n, q]) => q > 1 ? `${n} x${q}` : n).join(', ') + ']'
        : ' [carrying nothing]';
      nearbyForSituation.push({
        name: a.config.name,
        activity: (a.currentAction || 'idle') + otherInvStr,
        id: a.id,
      });
    }

    // Social action patterns — listed ONCE, not per agent
    if (nearby.length > 0) {
      if (this.conversationCooldown <= 0) {
        actions.push({ id: 'talk_NAME', label: 'Talk to someone', category: 'social' });
      }
      if (this.agent.inventory.length > 0) {
        actions.push({ id: 'give_NAME', label: 'Give something to someone', category: 'social' });
        actions.push({ id: 'trade_NAME', label: 'Trade with someone', category: 'social' });
      }
      // ask is rate-limited: cooldown after use, hidden when starving
      if (this.askCooldown <= 0 && (this.agent.vitals?.hunger ?? 0) < 70) {
        actions.push({ id: 'ask_NAME', label: 'Ask someone for something', category: 'social' });
      }
      actions.push({ id: 'teach_NAME', label: 'Teach someone a skill', category: 'social' });
      actions.push({ id: 'steal_NAME', label: 'Steal from someone', category: 'social' });
      actions.push({ id: 'confront_NAME', label: 'Confront someone', category: 'social' });
      actions.push({ id: 'threaten_NAME', label: 'Threaten someone', category: 'social' });
      actions.push({ id: 'ally_NAME', label: 'Propose alliance with someone', category: 'social' });
      actions.push({ id: 'betray_NAME', label: 'Break an alliance with someone', category: 'social' });
      actions.push({ id: 'fight_NAME', label: 'Attack someone', category: 'social' });
      actions.push({ id: 'observe_NAME', label: 'Watch someone without interacting', category: 'social' });
    }

    // ========================================
    // 3. COMMUNITY ACTIONS (with cooldowns)
    // ========================================

    // Board post — with cooldown
    let showBoardPost = true;
    if (this.cognition.fourStream) {
      const recentPosts = this.cognition.fourStream.getRecentTimeline(10)
        .filter(m => m.content.includes('posted on the village board'));
      if (recentPosts.length >= 2) showBoardPost = false;
    }
    if (showBoardPost) {
      actions.push({ id: 'post_board', label: 'Write on all-agent chat', category: 'creative' });
    }

    // Group post — only if agent is in an active institution/group
    const myGroupId = this.agent.institutionIds?.[0];
    const myGroup = myGroupId ? this.world.getInstitution(myGroupId) : undefined;
    if (myGroup && !myGroup.dissolved) {
      actions.push({ id: 'post_group', label: `Write in ${myGroup.name} chat`, category: 'creative' });
    }

    // Propose rule — with cooldown
    const recentRules = this.cognition.fourStream
      ?.getRecentTimeline(10)
      .filter(m => m.content.includes('proposed a rule'))
      .length ?? 0;
    if (recentRules < 1) {
      actions.push({ id: 'propose_rule', label: 'Propose a rule for voting', category: 'creative' });
    }

    // Vote on pending rules
    const pendingRules = this.world.getActiveBoard()
      .filter(p => p.type === 'rule' && p.ruleStatus === 'proposed'
        && !p.votes?.some(v => v.agentId === this.agent.id));
    for (const rule of pendingRules.slice(0, 3)) {
      actions.push({
        id: 'vote_like_' + rule.id.slice(0, 8),
        label: `Support rule: "${rule.content.slice(0, 40)}..."`,
        category: 'creative',
      });
      actions.push({
        id: 'vote_dislike_' + rule.id.slice(0, 8),
        label: `Oppose rule: "${rule.content.slice(0, 40)}..."`,
        category: 'creative',
      });
    }

    // Meeting — only with 3+ people nearby, with cooldown
    if (nearby.length >= 2) {
      const recentMeetings = this.cognition.fourStream
        ?.getRecentTimeline(10)
        .filter(m => m.content.includes('called a meeting'))
        .length ?? 0;
      if (recentMeetings < 1) {
        actions.push({ id: 'call_meeting', label: 'Call everyone here to discuss', category: 'creative' });
      }
      actions.push({ id: 'accuse_someone', label: 'Publicly accuse someone', category: 'social' });
    }

    // ========================================
    // 4. MOVEMENT ACTIONS
    // ========================================

    for (const [areaKey, desc] of this.cognition.knownPlaces) {
      if (areaKey === areaId) continue;
      const areaName = desc.split(' — ')[0] || areaKey;
      actions.push({ id: 'go_' + areaKey, label: 'Go to ' + areaName, category: 'movement' });
    }

    // ========================================
    // 5. ALWAYS AVAILABLE
    // ========================================

    actions.push({ id: 'rest', label: 'Rest and recover energy', category: 'rest' });

    // ========================================
    // NO ACTION ORDERING.
    // Actions stay in the order generated above:
    // physical → social (grouped by person) → community → movement → rest
    // The LLM's personality and memory determine what it picks.
    // ========================================

    // Build inventory groups for the situation output
    const invGroups: Record<string, { name: string; type: string; qty: number }> = {};
    for (const item of this.agent.inventory) {
      const key = item.name;
      if (!invGroups[key]) invGroups[key] = { name: item.name, type: item.type, qty: 0 };
      invGroups[key].qty++;
    }

    // Today summary — what the agent has done today
    let todaySummary: string | undefined;
    if (this.cognition.fourStream) {
      const allRecent = this.cognition.fourStream.getRecentTimeline(20);
      if (allRecent.length > 0) {
        todaySummary = allRecent
          .slice(-10) // last 10 events
          .map(m => m.content)
          .join('. ');
      }
    }

    // Time calculations
    const hoursUntilDark = Math.max(0, 19 - hour);
    const hoursUntilSleep = Math.max(0, 22 - hour);

    // Board posts
    let boardPosts: string | undefined;
    if (this.cognition.knownPlaces.has('plaza')) {
      const summary = this.world.getBoardSummary();
      if (summary && summary !== 'The village board is empty.') {
        boardPosts = summary;
      }
    }

    // Build group info from Institution membership
    let groupInfo: string | undefined;
    const gId = this.agent.institutionIds?.[0];
    const grp = gId ? this.world.getInstitution(gId) : undefined;
    if (grp && !grp.dissolved) {
      const memberNames = grp.members
        .map(m => this.world.getAgent(m.agentId)?.config.name ?? 'Unknown')
        .join(', ');
      groupInfo = `${grp.name} (${grp.members.length} members: ${memberNames})`;
      if (grp.description) groupInfo += `\nPurpose: ${grp.description}`;
      if (grp.rules.length > 0) groupInfo += `\nRules: ${grp.rules.join('; ')}`;
    }

    return {
      location: area?.name ?? 'Unknown',
      areaId,
      time: { day: this.world.time.day, hour },
      hoursUntilDark,
      hoursUntilSleep,
      season: currentSeason,
      vitals: {
        hunger: this.agent.vitals?.hunger ?? 0,
        energy: this.agent.vitals?.energy ?? 100,
        health: this.agent.vitals?.health ?? 100,
      },
      inventory: Object.values(invGroups),
      nearbyAgents: nearbyForSituation,
      availableActions: actions,  // NO ordering applied
      recentOutcome,
      trigger,  // No enrichedTrigger — just the raw trigger
      todaySummary,
      boardPosts,
      groupInfo,
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

    // Store outcome as memory — action_outcome so it enters the four-stream timeline
    const outcomeImportance = outcome.success ? 4 : 6;
    void this.cognition.addMemory({
      id: crypto.randomUUID(),
      agentId: actor.id,
      type: 'action_outcome',
      content: outcome.description,
      importance: outcomeImportance,
      timestamp: Date.now(),
      relatedAgentIds: [],
    });
    // Four Stream: accumulate importance for belief generation
    this.importanceAccum += outcomeImportance;

    // Broadcast
    this.broadcaster.agentAction(actor.id, outcome.description);
  }

  /** Step 5: Execute a structured decision — dispatch to game systems */
  private async executeDecision(decision: AgentDecision, situation: AgentSituation): Promise<void> {
    const actionId = decision.actionId;
    // Truncated reason for action broadcasts — "action — reason"
    const shortReason = decision.reason?.length > 80
      ? decision.reason.slice(0, 77) + '...'
      : (decision.reason || '');

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
      this.activityTimer = 5;
      this.world.updateAgentState(this.agent.id, 'active', this.currentPerformingActivity);
      this.broadcaster.agentAction(this.agent.id, `gathering ${resource} — "${shortReason}"`);
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
      this.activityTimer = 3;
      this.world.updateAgentState(this.agent.id, 'active', 'eating');
      this.broadcaster.agentAction(this.agent.id, `eating ${foodName} — "${shortReason}"`);
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
      this.activityTimer = 8;
      this.world.updateAgentState(this.agent.id, 'active', this.currentPerformingActivity);
      this.broadcaster.agentAction(this.agent.id, `crafting ${recipe.name} — "${shortReason}"`);
      return;
    }

    // --- Movement ---
    if (actionId.startsWith('go_')) {
      const targetAreaId = actionId.replace('go_', '');
      const targetPos = getRandomPositionInArea(targetAreaId);
      this.startMoveTo(targetPos);
      // Store the reason for going — so the agent remembers WHY it went there when decide() fires on arrival
      this.pendingArrivalIntent = decision.reason;
      this.broadcaster.agentAction(this.agent.id, `heading to ${targetAreaId} — "${shortReason}"`);
      return;
    }

    // --- Give ---
    if (actionId.startsWith('give_')) {
      const firstName = actionId.replace('give_', '');
      const target = this.findNearbyByFirstName(firstName);
      if (!target || this.agent.inventory.length === 0) {
        this.lastTrigger = 'You wanted to give something but couldn\'t.';
        this.state = 'idle'; this.idleTimer = 0; return;
      }
      // Pick item from decision.reason if mentioned, else first non-food
      const reasonLower = (decision.reason || '').toLowerCase();
      const item = this.agent.inventory.find(i =>
        reasonLower.includes(i.name.toLowerCase())
      ) || this.agent.inventory.find(i => i.type !== 'food') || this.agent.inventory[0];
      const agentState = this.buildAgentStateForResolver(situation);
      const worldState = this.buildWorldState();
      const intent = { type: 'give' as const, resource: item.name.toLowerCase().replace(/\s+/g, '_'), targetAgent: target.config.name.split(' ')[0], quantity: 1, raw: `give ${item.name} to ${target.config.name}` };
      const outcome = executeAction(intent, agentState, worldState);
      this.applyOutcomeToWorld(outcome);
      this.lastOutcome = outcome.description;
      this.lastTrigger = outcome.description;
      // Adjust trust: target trusts giver more
      this.adjustTrust(target, this.agent, 10);
      if (this.cognition.fourStream) {
        void this.cognition.fourStream.updateDossier(target.id, target.config.name, this.lastOutcome || outcome.description, this.cognition.llmProvider);
      }
      this.state = 'performing'; this.activityTimer = 3;
      this.world.updateAgentState(this.agent.id, 'active', `giving ${item.name} to ${target.config.name}`);
      this.broadcaster.agentAction(this.agent.id, `gave ${item.name} to ${target.config.name} — "${shortReason}"`);
      return;
    }

    // --- Social (talk) ---
    if (actionId.startsWith('talk_')) {
      const firstName = actionId.replace('talk_', '');
      for (const agent of this.world.agents.values()) {
        if (agent.id !== this.agent.id &&
            agent.config.name.split(' ')[0].toLowerCase() === firstName) {
          this.pendingConversationTarget = agent.id;
          this.pendingConversationPurpose = decision.reason;
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
      this.lastTrigger = `You looked around but couldn't find who you wanted to talk to.`;
      this.state = 'idle';
      this.idleTimer = 0;
      return;
    }

    // --- Trade ---
    if (actionId.startsWith('trade_')) {
      const firstName = actionId.replace('trade_', '');
      const target = this.findNearbyByFirstName(firstName);
      if (!target || this.agent.inventory.length === 0) {
        this.lastTrigger = 'You wanted to trade but couldn\'t.';
        this.state = 'idle'; this.idleTimer = 0; return;
      }
      // Pick item from decision.reason if mentioned, else first item
      const reasonLower = (decision.reason || '').toLowerCase();
      const item = this.agent.inventory.find(i =>
        reasonLower.includes(i.name.toLowerCase())
      ) || this.agent.inventory[0];

      // Try to extract what the agent wants in return from their reason
      const requestItems: { resource: string; qty: number }[] = [];
      const targetInv = target.inventory || [];
      for (const ti of targetInv) {
        if (reasonLower.includes(ti.name.toLowerCase()) && ti.name.toLowerCase() !== item.name.toLowerCase()) {
          requestItems.push({ resource: ti.name.toLowerCase().replace(/\s+/g, '_'), qty: 1 });
          break;
        }
      }

      const agentState = this.buildAgentStateForResolver(situation);
      const worldState = this.buildWorldState();
      const intent = { type: 'trade_offer' as const, offerItems: [{ resource: item.name.toLowerCase().replace(/\s+/g, '_'), qty: 1 }], requestItems, targetAgent: target.config.name.split(' ')[0], raw: `trade ${item.name} with ${target.config.name}` };
      const outcome = executeAction(intent, agentState, worldState);
      this.applyOutcomeToWorld(outcome);
      this.lastOutcome = outcome.description;
      this.lastTrigger = outcome.description;
      // Dossier update
      if (this.cognition.fourStream) {
        void this.cognition.fourStream.updateDossier(target.id, target.config.name, outcome.description, this.cognition.llmProvider);
      }
      // PUBLIC: trade post if successful
      if (outcome.success) {
        const tradePost: BoardPost = {
          id: crypto.randomUUID(),
          authorId: 'system',
          authorName: 'Village Trades',
          type: 'trade',
          channel: 'all',
          content: `${this.agent.config.name} traded ${item.name} with ${target.config.name}. ${outcome.description}`,
          timestamp: Date.now(),
          day: this.world.time.day,
        };
        this.world.addBoardPost(tradePost);
        this.broadcaster.boardPost(tradePost);
        if (this.bus) this.bus.emit({ type: 'board_post_created', post: tradePost });
      }
      this.state = 'performing'; this.activityTimer = 3;
      this.world.updateAgentState(this.agent.id, 'active', `trading with ${target.config.name}`);
      this.broadcaster.agentAction(this.agent.id, `traded with ${target.config.name} — "${shortReason}"`);
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
      this.state = 'performing'; this.activityTimer = 5;
      this.world.updateAgentState(this.agent.id, 'active', `teaching ${skill.name} to ${target.config.name}`);
      this.broadcaster.agentAction(this.agent.id, `teaching ${skill.name} to ${target.config.name} — "${shortReason}"`);
      return;
    }

    // --- Threaten ---
    if (actionId.startsWith('threaten_')) {
      const firstName = actionId.replace('threaten_', '');
      const target = this.findNearbyByFirstName(firstName);
      if (!target) {
        this.lastTrigger = 'You wanted to threaten someone but they weren\'t here.';
        this.state = 'idle'; this.idleTimer = 0; return;
      }

      const threatText = decision.reason;

      void this.cognition.addMemory({
        id: crypto.randomUUID(), agentId: this.agent.id, type: 'action_outcome',
        content: `I threatened ${target.config.name}: ${threatText}`,
        importance: 8, timestamp: Date.now(), relatedAgentIds: [target.id],
      });

      const targetCog = (this.world as any).cognitions?.get?.(target.id);
      if (targetCog) {
        void targetCog.addMemory({
          id: crypto.randomUUID(), agentId: target.id, type: 'observation',
          content: `${this.agent.config.name} threatened me: ${threatText}`,
          importance: 9, timestamp: Date.now(), relatedAgentIds: [this.agent.id],
        });
        if (targetCog.fourStream) {
          targetCog.fourStream.addConcern({
            id: crypto.randomUUID(),
            content: `${this.agent.config.name} threatened me. I need to decide how to respond.`,
            category: 'threat', relatedAgentIds: [this.agent.id],
            createdAt: this.world.time.totalMinutes,
          });
        }
      }

      this.adjustTrust(this.agent, target, -25);
      this.adjustTrust(target, this.agent, -25);

      if (this.cognition.fourStream) {
        void this.cognition.fourStream.updateDossier(target.id, target.config.name,
          `I threatened ${target.config.name}: ${threatText}`, this.cognition.llmProvider);
      }

      const targetCtrl = (this.world as any).controllers?.get?.(target.id);
      if (targetCtrl) {
        targetCtrl.lastTrigger = `${this.agent.config.name} just threatened you: "${threatText}". What do you do?`;
        targetCtrl.idleTimer = 7;
      }

      this.lastOutcome = `You threatened ${target.config.name}.`;
      this.lastTrigger = this.lastOutcome;
      this.state = 'performing'; this.activityTimer = 3;
      this.world.updateAgentState(this.agent.id, 'active', `threatening ${target.config.name}`);
      this.broadcaster.agentAction(this.agent.id, `threatened ${target.config.name} — "${shortReason}"`);
      return;
    }

    // --- Ask ---
    if (actionId.startsWith('ask_')) {
      const firstName = actionId.replace('ask_', '');
      const target = this.findNearbyByFirstName(firstName);
      if (!target) {
        this.lastTrigger = 'You wanted to ask someone but they weren\'t here.';
        this.state = 'idle'; this.idleTimer = 0; return;
      }

      void this.cognition.addMemory({
        id: crypto.randomUUID(), agentId: this.agent.id, type: 'action_outcome',
        content: `I asked ${target.config.name} for help: ${decision.reason}`,
        importance: 6, timestamp: Date.now(), relatedAgentIds: [target.id],
      });

      const targetCog = (this.world as any).cognitions?.get?.(target.id);
      if (targetCog) {
        void targetCog.addMemory({
          id: crypto.randomUUID(), agentId: target.id, type: 'observation',
          content: `${this.agent.config.name} asked me for help: ${decision.reason}`,
          importance: 6, timestamp: Date.now(), relatedAgentIds: [this.agent.id],
        });
        if (targetCog.fourStream) {
          targetCog.fourStream.addConcern({
            id: crypto.randomUUID(),
            content: `${this.agent.config.name} asked me for something. I should respond.`,
            category: 'unresolved', relatedAgentIds: [this.agent.id],
            createdAt: this.world.time.totalMinutes,
            expiresAt: this.world.time.totalMinutes + 480,
          });
        }
      }

      if (this.cognition.fourStream) {
        void this.cognition.fourStream.updateDossier(target.id, target.config.name,
          `I asked ${target.config.name} for help.`, this.cognition.llmProvider);
      }

      this.lastOutcome = `You asked ${target.config.name} for help. They haven't given you anything yet.`;
      this.lastTrigger = `You asked for help but got nothing yet. If you need food, you'll have to gather it, trade for it, or take it yourself.`;
      this.askCooldown = 8;  // Can't ask again for 8 ticks
      this.state = 'performing'; this.activityTimer = 3;
      this.world.updateAgentState(this.agent.id, 'active', `asking ${target.config.name}`);
      this.broadcaster.agentAction(this.agent.id, `asked ${target.config.name} for something — "${shortReason}"`);
      return;
    }

    // --- Observe ---
    if (actionId.startsWith('observe_')) {
      const firstName = actionId.replace('observe_', '');
      const target = this.findNearbyByFirstName(firstName);
      if (!target) {
        this.lastTrigger = 'You wanted to observe someone but they weren\'t here.';
        this.state = 'idle'; this.idleTimer = 0; return;
      }

      const targetActivity = target.currentAction || 'idle';
      const targetInv = target.inventory.length > 0
        ? target.inventory.map(i => i.name).join(', ') : 'nothing';
      const observation = `I watched ${target.config.name}. They were ${targetActivity}. They were carrying: ${targetInv}.`;

      void this.cognition.addMemory({
        id: crypto.randomUUID(), agentId: this.agent.id, type: 'observation',
        content: observation, importance: 5, timestamp: Date.now(),
        relatedAgentIds: [target.id],
      });

      if (this.cognition.fourStream) {
        void this.cognition.fourStream.updateDossier(target.id, target.config.name,
          observation, this.cognition.llmProvider);
      }

      this.lastOutcome = observation;
      this.lastTrigger = `You observed ${target.config.name}. ${observation}`;
      this.state = 'performing'; this.activityTimer = 4;
      this.world.updateAgentState(this.agent.id, 'active', `observing ${target.config.name}`);
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
      // Memory for confronter
      void this.cognition.addMemory({ id: crypto.randomUUID(), agentId: this.agent.id, type: 'action_outcome', content: `I confronted ${target.config.name}: ${confrontText}`, importance: 7, timestamp: Date.now(), relatedAgentIds: [target.id] });
      // Memory for target
      const targetCognition = (this.world as any).cognitions?.get?.(target.id);
      if (targetCognition) {
        void targetCognition.addMemory({ id: crypto.randomUUID(), agentId: target.id, type: 'action_outcome', content: `${this.agent.config.name} confronted me: ${confrontText}`, importance: 7, timestamp: Date.now(), relatedAgentIds: [this.agent.id] });
      }
      // Witness memories for all nearby
      const nearbyAll = this.world.getNearbyAgents(this.agent.position, 5).filter(a => a.id !== this.agent.id && a.id !== target.id);
      for (const witness of nearbyAll) {
        const wCog = (this.world as any).cognitions?.get?.(witness.id);
        if (wCog) {
          void wCog.addMemory({ id: crypto.randomUUID(), agentId: witness.id, type: 'observation', content: `I saw ${this.agent.config.name} confront ${target.config.name}: "${confrontText}"`, importance: 5, timestamp: Date.now(), relatedAgentIds: [this.agent.id, target.id] });
        }
      }
      this.adjustTrust(target, this.agent, -15);
      this.adjustTrust(this.agent, target, -15);
      if (this.cognition.fourStream) {
        void this.cognition.fourStream.updateDossier(target.id, target.config.name, `I confronted ${target.config.name}: ${confrontText}`, this.cognition.llmProvider);
      }
      // Force target to react
      const targetCtrl = (this.world as any).controllers?.get?.(target.id);
      if (targetCtrl) {
        targetCtrl.lastTrigger = `${this.agent.config.name} just confronted you: "${confrontText}". How do you respond?`;
        targetCtrl.idleTimer = targetCtrl.idleThreshold;
      }
      this.lastOutcome = `You confronted ${target.config.name}.`;
      this.lastTrigger = `You just confronted ${target.config.name}. How do they react?`;
      this.state = 'performing'; this.activityTimer = 3;
      this.world.updateAgentState(this.agent.id, 'active', `confronting ${target.config.name}`);
      this.broadcaster.agentAction(this.agent.id, `confronted ${target.config.name} — "${shortReason}"`);
      return;
    }

    // --- Steal ---
    if (actionId.startsWith('steal_')) {
      const firstName = actionId.replace('steal_', '');
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
      if (this.cognition.fourStream) {
        void this.cognition.fourStream.updateDossier(target.id, target.config.name, outcome.description, this.cognition.llmProvider);
      }
      // PUBLIC: news post + all agents get memory
      const stealPost: BoardPost = {
        id: crypto.randomUUID(),
        authorId: 'system',
        authorName: 'Village News',
        type: 'news',
        channel: 'all',
        content: `${this.agent.config.name} was caught stealing from ${target.config.name}!`,
        timestamp: Date.now(),
        day: this.world.time.day,
      };
      this.world.addBoardPost(stealPost);
      this.broadcaster.boardPost(stealPost);
      if (this.bus) this.bus.emit({ type: 'board_post_created', post: stealPost });
      for (const [id] of this.world.agents) {
        if (id === this.agent.id) continue;
        const cog = (this.world as any).cognitions?.get?.(id);
        if (cog) {
          void cog.addMemory({
            id: crypto.randomUUID(),
            agentId: id,
            type: 'observation',
            content: `${this.agent.config.name} stole from ${target.config.name}.`,
            importance: 8,
            timestamp: Date.now(),
            relatedAgentIds: [this.agent.id, target.id],
          });
        }
      }
      this.state = 'performing'; this.activityTimer = 3;
      this.world.updateAgentState(this.agent.id, 'active', `stealing`);
      return;
    }

    // --- Fight ---
    if (actionId.startsWith('fight_')) {
      const firstName = actionId.replace('fight_', '');
      const target = this.findNearbyByFirstName(firstName);
      if (!target) {
        this.lastTrigger = 'You wanted to fight but the target wasn\'t here.';
        this.state = 'idle'; this.idleTimer = 0; return;
      }
      const agentState = this.buildAgentStateForResolver(situation);
      const worldState = this.buildWorldState();
      const intent = { type: 'fight' as const, targetAgent: target.config.name, raw: 'fight ' + target.config.name };
      const outcome = executeAction(intent, agentState, worldState);

      // Apply effects to SELF (health loss from retaliation, energy spent)
      this.applyOutcomeToWorld(outcome);

      // Apply effects to TARGET (health damage)
      if (outcome.success && outcome.targetAgentId) {
        const targetAgent = this.world.getAgent(outcome.targetAgentId);
        if (targetAgent && targetAgent.vitals && outcome.targetHealthChange) {
          targetAgent.vitals.health = Math.max(0, Math.min(100,
            targetAgent.vitals.health + outcome.targetHealthChange));

          // Check if target died from the fight
          if (targetAgent.vitals.health <= 0) {
            console.log(`[Fight] ${target.config.name} health dropped to 0 from fight with ${this.agent.config.name}`);
          }
        }

        // Target gets a memory of being attacked
        const targetCog = (this as any).world?.cognitions?.get?.(outcome.targetAgentId);
        if (targetCog) {
          void targetCog.addMemory({
            id: crypto.randomUUID(),
            agentId: outcome.targetAgentId,
            type: 'observation',
            content: this.agent.config.name + ' attacked me! I took ' + Math.abs(outcome.targetHealthChange ?? 0) + ' damage.',
            importance: 9,
            timestamp: Date.now(),
            relatedAgentIds: [this.agent.id],
          });
        }

        // Force target to react immediately
        const targetCtrl = (this.world as any).controllers?.get?.(outcome.targetAgentId) as AgentController | undefined;
        if (targetCtrl && targetAgent) {
          targetCtrl.lastTrigger = this.agent.config.name + ' just attacked you! Health: ' + Math.round(targetAgent.vitals?.health ?? 0) + '/100. What do you do?';
          targetCtrl.idleTimer = 7;
        }
      }

      // ALL nearby agents witness the fight
      const witnesses = this.world.getNearbyAgents(this.agent.position, 5)
        .filter(a => a.id !== this.agent.id && a.id !== target.id && a.alive !== false);
      for (const w of witnesses) {
        const wCog = (this as any).world?.cognitions?.get?.(w.id);
        if (wCog) {
          void wCog.addMemory({
            id: crypto.randomUUID(),
            agentId: w.id,
            type: 'observation',
            content: 'I saw ' + this.agent.config.name + ' attack ' + target.config.name + '! ' + outcome.description,
            importance: 8,
            timestamp: Date.now(),
            relatedAgentIds: [this.agent.id, target.id],
          });
        }
        // Force witnesses to react
        const wCtrl = (this.world as any).controllers?.get?.(w.id) as AgentController | undefined;
        if (wCtrl) {
          wCtrl.lastTrigger = this.agent.config.name + ' just attacked ' + target.config.name + ' right in front of you! What do you do?';
          wCtrl.idleTimer = 7;
        }
      }

      // Trust destruction — fighting destroys trust for everyone who saw
      this.adjustTrust(this.agent, target, -40);
      this.adjustTrust(target, this.agent, -40);
      // Witnesses lose trust in the attacker
      for (const w of witnesses) {
        const wCtrl = (this.world as any).controllers?.get?.(w.id) as AgentController | undefined;
        if (wCtrl) {
          wCtrl.adjustTrust(w, this.agent, -20);
        }
      }
      if (this.cognition.fourStream) {
        void this.cognition.fourStream.updateDossier(target.id, target.config.name, outcome.description, this.cognition.llmProvider);
      }

      // Emit fight event for engine-level handling
      if (this.bus) {
        this.bus.emit({
          type: 'fight_occurred',
          attackerId: this.agent.id,
          defenderId: target.id,
          outcome: outcome.description,
          location: this.agent.position,
        });
      }

      // PUBLIC: news post
      const fightPost: BoardPost = {
        id: crypto.randomUUID(),
        authorId: 'system',
        authorName: 'Village News',
        type: 'news',
        channel: 'all',
        content: `${this.agent.config.name} attacked ${target.config.name}! ${outcome.description}`,
        timestamp: Date.now(),
        day: this.world.time.day,
      };
      this.world.addBoardPost(fightPost);
      this.broadcaster.boardPost(fightPost);
      if (this.bus) this.bus.emit({ type: 'board_post_created', post: fightPost });

      this.broadcaster.agentAction(this.agent.id, 'Attacked ' + target.config.name + '! — "' + shortReason + '"', '⚔️');
      this.lastOutcome = outcome.description;
      this.lastTrigger = outcome.success
        ? 'You just fought ' + target.config.name + '. You took damage too. Everyone saw.'
        : 'Fight failed: ' + (outcome.reason || 'too exhausted');
      this.state = 'performing'; this.activityTimer = 5;
      this.world.updateAgentState(this.agent.id, 'active', `fighting ${target.config.name}`);
      return;
    }

    // --- Alliance ---
    if (actionId.startsWith('ally_')) {
      const firstName = actionId.replace('ally_', '');
      const target = this.findNearbyByFirstName(firstName);
      if (!target) {
        this.lastTrigger = 'You wanted to form a group but they weren\'t here.';
        this.state = 'idle'; this.idleTimer = 0; return;
      }

      // Check if I'm already in a group
      const myGroupId = this.agent.institutionIds?.[0];
      const myGroup = myGroupId ? this.world.getInstitution(myGroupId) : undefined;

      // Check if target is already in MY group
      if (myGroup && myGroup.members.some(m => m.agentId === target.id)) {
        this.lastTrigger = `${target.config.name} is already in your group.`;
        this.state = 'idle'; this.idleTimer = 0; return;
      }

      if (myGroup && !myGroup.dissolved) {
        // I'm in a group → INVITE target to join
        this.world.addInstitutionMember(myGroup.id, {
          agentId: target.id, role: 'member', joinedAt: Date.now(),
        });

        void this.cognition.addMemory({
          id: crypto.randomUUID(), agentId: this.agent.id, type: 'action_outcome',
          content: `I invited ${target.config.name} to join ${myGroup.name}. They're now a member.`,
          importance: 7, timestamp: Date.now(), relatedAgentIds: [target.id],
        });
        const targetCog = (this.world as any).cognitions?.get?.(target.id);
        if (targetCog) {
          void targetCog.addMemory({
            id: crypto.randomUUID(), agentId: target.id, type: 'observation',
            content: `${this.agent.config.name} invited me to join ${myGroup.name}. I'm now a member.`,
            importance: 7, timestamp: Date.now(), relatedAgentIds: [this.agent.id],
          });
          if (targetCog.fourStream) {
            targetCog.fourStream.addConcern({
              id: crypto.randomUUID(),
              content: `I joined ${myGroup.name}. I should participate and follow the group's purpose.`,
              category: 'commitment',
              relatedAgentIds: myGroup.members.map((m: any) => m.agentId),
              createdAt: this.world.time.totalMinutes,
              permanent: true,
            });
          }
        }
        this.adjustTrust(this.agent, target, 15);
        this.adjustTrust(target, this.agent, 15);
        if (this.cognition.fourStream) {
          void this.cognition.fourStream.updateDossier(target.id, target.config.name, `${target.config.name} joined ${myGroup.name}.`, this.cognition.llmProvider);
        }

        const newsPost: BoardPost = {
          id: crypto.randomUUID(), authorId: 'system', authorName: 'Village News',
          type: 'news', channel: 'all',
          content: `${target.config.name} joined ${myGroup.name} (now ${myGroup.members.length} members).`,
          timestamp: Date.now(), day: this.world.time.day,
        };
        this.world.addBoardPost(newsPost);
        this.broadcaster.boardPost(newsPost);
        if (this.bus) this.bus.emit({ type: 'board_post_created', post: newsPost });

        this.broadcaster.institutionUpdate(myGroup);
        this.lastOutcome = `${target.config.name} joined ${myGroup.name}.`;
        this.lastTrigger = this.lastOutcome;
        this.state = 'performing'; this.activityTimer = 3;
        this.world.updateAgentState(this.agent.id, 'active', `inviting ${target.config.name} to ${myGroup.name}`);
        this.broadcaster.agentAction(this.agent.id, `invited ${target.config.name} to join ${myGroup.name}`);
        return;

      } else {
        // Neither of us has a group → CREATE new group
        let groupName: string;
        try {
          groupName = await this.cognition.llmProvider.complete(
            'Generate a short group/community name (2-4 words). No quotes, no preamble.',
            `${this.agent.config.name} and ${target.config.name} are forming a group. Reason: ${decision.reason}\n\nWhat would they name it? Examples: "The Farm Collective", "Lakeside Pact", "Builders Guild", "The Survivors". Write ONLY the name.`
          );
          groupName = groupName.replace(/^["']|["']$/g, '').trim();
          if (groupName.length < 3 || groupName.length > 40) {
            groupName = `${this.agent.config.name.split(' ')[0]} & ${target.config.name.split(' ')[0]}'s Alliance`;
          }
        } catch {
          groupName = `${this.agent.config.name.split(' ')[0]} & ${target.config.name.split(' ')[0]}'s Alliance`;
        }

        const group: Institution = {
          id: crypto.randomUUID(),
          name: groupName,
          type: 'community',
          description: decision.reason || 'A group formed for mutual benefit.',
          founderId: this.agent.id,
          members: [
            { agentId: this.agent.id, role: 'founder', joinedAt: Date.now() },
            { agentId: target.id, role: 'member', joinedAt: Date.now() },
          ],
          treasury: 0,
          rules: [],
          createdAt: Date.now(),
        };
        this.world.addInstitution(group);
        if (!this.agent.institutionIds) this.agent.institutionIds = [];
        this.agent.institutionIds.push(group.id);
        if (!target.institutionIds) target.institutionIds = [];
        target.institutionIds.push(group.id);

        void this.cognition.addMemory({
          id: crypto.randomUUID(), agentId: this.agent.id, type: 'action_outcome',
          content: `I founded ${groupName} with ${target.config.name}. ${decision.reason}`,
          importance: 8, timestamp: Date.now(), relatedAgentIds: [target.id],
        });
        const targetCog = (this.world as any).cognitions?.get?.(target.id);
        if (targetCog) {
          void targetCog.addMemory({
            id: crypto.randomUUID(), agentId: target.id, type: 'observation',
            content: `${this.agent.config.name} and I founded ${groupName}. ${decision.reason}`,
            importance: 8, timestamp: Date.now(), relatedAgentIds: [this.agent.id],
          });
        }
        if (this.cognition.fourStream) {
          this.cognition.fourStream.addConcern({
            id: crypto.randomUUID(),
            content: `I founded ${groupName} with ${target.config.name}. I should build this community.`,
            category: 'commitment', relatedAgentIds: [target.id],
            createdAt: this.world.time.totalMinutes, permanent: true,
          });
        }
        if (targetCog?.fourStream) {
          targetCog.fourStream.addConcern({
            id: crypto.randomUUID(),
            content: `I'm part of ${groupName} with ${this.agent.config.name}. I should contribute.`,
            category: 'commitment', relatedAgentIds: [this.agent.id],
            createdAt: this.world.time.totalMinutes, permanent: true,
          });
        }
        this.adjustTrust(this.agent, target, 20);
        this.adjustTrust(target, this.agent, 20);
        if (this.cognition.fourStream) {
          void this.cognition.fourStream.updateDossier(target.id, target.config.name, `We founded ${groupName} together.`, this.cognition.llmProvider);
        }

        const newsPost: BoardPost = {
          id: crypto.randomUUID(), authorId: 'system', authorName: 'Village News',
          type: 'news', channel: 'all',
          content: `${this.agent.config.name} and ${target.config.name} founded "${groupName}".`,
          timestamp: Date.now(), day: this.world.time.day,
        };
        this.world.addBoardPost(newsPost);
        this.broadcaster.boardPost(newsPost);
        if (this.bus) this.bus.emit({ type: 'board_post_created', post: newsPost });

        this.broadcaster.institutionUpdate(group);
        this.lastOutcome = `You founded ${groupName} with ${target.config.name}.`;
        this.lastTrigger = this.lastOutcome;
        this.state = 'performing'; this.activityTimer = 3;
        this.world.updateAgentState(this.agent.id, 'active', `founding ${groupName}`);
        this.broadcaster.agentAction(this.agent.id, `founded "${groupName}" with ${target.config.name}`);
        return;
      }
    }

    // --- Betray ---
    if (actionId.startsWith('betray_')) {
      const firstName = actionId.replace('betray_', '');
      const target = this.findNearbyByFirstName(firstName);
      if (!target) {
        this.lastTrigger = 'You wanted to leave but they weren\'t here.';
        this.state = 'idle'; this.idleTimer = 0; return;
      }

      // Find a shared group
      const sharedGroupId = this.agent.institutionIds?.find(id => {
        const inst = this.world.getInstitution(id);
        return inst && !inst.dissolved && inst.members.some(m => m.agentId === target.id);
      });
      if (!sharedGroupId) {
        this.lastTrigger = `You share no group with ${target.config.name}.`;
        this.state = 'idle'; this.idleTimer = 0; return;
      }

      const group = this.world.getInstitution(sharedGroupId)!;
      this.world.removeInstitutionMember(sharedGroupId, this.agent.id);

      // If only 1 member left, dissolve
      if (group.members.length <= 1) {
        this.world.dissolveInstitution(sharedGroupId);
      }

      // Trust destruction with all remaining members
      for (const member of group.members) {
        if (member.agentId === this.agent.id) continue;
        const memberAgent = this.world.getAgent(member.agentId);
        if (memberAgent) {
          this.adjustTrust(this.agent, memberAgent, -30);
          this.adjustTrust(memberAgent, this.agent, -30);
        }
      }

      void this.cognition.addMemory({
        id: crypto.randomUUID(), agentId: this.agent.id, type: 'action_outcome',
        content: `I left ${group.name}.`,
        importance: 8, timestamp: Date.now(),
        relatedAgentIds: group.members.map(m => m.agentId),
      });

      for (const member of group.members) {
        if (member.agentId === this.agent.id) continue;
        const memberCog = (this.world as any).cognitions?.get?.(member.agentId);
        if (memberCog) {
          void memberCog.addMemory({
            id: crypto.randomUUID(), agentId: member.agentId, type: 'observation',
            content: `${this.agent.config.name} left ${group.name}.${group.dissolved ? ' The group has dissolved.' : ''}`,
            importance: 8, timestamp: Date.now(), relatedAgentIds: [this.agent.id],
          });
          if (memberCog.fourStream) {
            memberCog.fourStream.addConcern({
              id: crypto.randomUUID(),
              content: `${this.agent.config.name} left ${group.name}. ${group.dissolved ? 'The group is gone.' : 'We need to decide what to do.'}`,
              category: 'threat', relatedAgentIds: [this.agent.id],
              createdAt: this.world.time.totalMinutes,
            });
          }
        }
      }

      if (this.cognition.fourStream) {
        void this.cognition.fourStream.updateDossier(target.id, target.config.name,
          `I left ${group.name}.`, this.cognition.llmProvider);
      }

      const betrayPost: BoardPost = {
        id: crypto.randomUUID(), authorId: 'system', authorName: 'Village News',
        type: 'news', channel: 'all',
        content: `${this.agent.config.name} left ${group.name}.${group.dissolved ? ' The group has dissolved.' : ''}`,
        timestamp: Date.now(), day: this.world.time.day,
      };
      this.world.addBoardPost(betrayPost);
      this.broadcaster.boardPost(betrayPost);
      if (this.bus) this.bus.emit({ type: 'board_post_created', post: betrayPost });

      this.broadcaster.institutionUpdate(group);
      this.lastOutcome = `You left ${group.name}.`;
      this.lastTrigger = this.lastOutcome;
      this.state = 'performing'; this.activityTimer = 3;
      this.world.updateAgentState(this.agent.id, 'active', `leaving ${group.name}`);
      this.broadcaster.agentAction(this.agent.id, `left ${group.name} — "${shortReason}"`);
      return;
    }

    // --- Accuse ---
    if (actionId === 'accuse_someone') {
      const accusation = decision.sayAloud || decision.reason || 'I accuse someone.';
      const nearbyAll = this.world.getNearbyAgents(this.agent.position, 5).filter(a => a.id !== this.agent.id && a.alive !== false);
      let accused: typeof nearbyAll[0] | undefined;
      for (const a of nearbyAll) {
        if (accusation.toLowerCase().includes(a.config.name.split(' ')[0].toLowerCase())) {
          accused = a; break;
        }
      }
      for (const witness of nearbyAll) {
        void this.cognition.addMemory({ id: crypto.randomUUID(), agentId: witness.id, type: 'observation', content: `${this.agent.config.name} publicly accused ${accused?.config.name ?? 'someone'}: "${accusation.slice(0, 80)}"`, importance: 7, timestamp: Date.now(), relatedAgentIds: [this.agent.id, ...(accused ? [accused.id] : [])] });
      }
      const post = {
        id: crypto.randomUUID(),
        authorId: this.agent.id,
        authorName: this.agent.config.name,
        type: 'rumor' as const,
        channel: 'all' as const,
        content: accusation,
        timestamp: Date.now(),
        day: this.world.time.day,
        targetIds: accused ? [accused.id] : undefined,
      };
      this.world.addBoardPost(post);
      this.broadcaster.boardPost(post);
      if (this.bus) this.bus.emit({ type: 'board_post_created', post });
      if (accused) {
        this.adjustTrust(this.agent, accused, -15);
        this.adjustTrust(accused, this.agent, -15);
      }
      this.lastOutcome = `You publicly accused ${accused?.config.name ?? 'someone'}.`;
      this.lastTrigger = this.lastOutcome;
      this.state = 'performing'; this.activityTimer = 3;
      this.world.updateAgentState(this.agent.id, 'active', 'accusing');
      this.broadcaster.agentAction(this.agent.id, `accused ${accused?.config.name ?? 'someone'} — "${shortReason}"`);
      return;
    }

    // --- Post Board ---
    if (actionId === 'post_board') {
      // Generate public post content via LLM — decision.reason is private inner thought
      let content: string;
      try {
        const identity = this.cognition.identityBlock;
        const postPrompt = `${identity}

You decided to write a message on the village board.

Your reason for posting: ${decision.reason}

Write the ACTUAL MESSAGE you would post. This is public — other villagers read it. Not your inner thoughts — what you actually write down. Stay in character.

Keep it to 1-2 sentences. Write ONLY the message text, nothing else.`;
        content = await this.cognition.llmProvider.complete(
          `You are ${this.agent.config.name}. Write only the board message. No preamble, no quotes.`,
          postPrompt,
        );
        content = content.replace(/^["']|["']$/g, '').trim();
        if (content.length < 3 || content.length > 300) {
          console.warn(`[PostBoard] ${this.agent.config.name} content length out of range (${content.length}), using reason`);
          content = decision.reason.slice(0, 200);
        }
      } catch (err) {
        console.error(`[PostBoard] ${this.agent.config.name} LLM call failed:`, err);
        content = decision.reason.slice(0, 200);
      }

      const post = {
        id: crypto.randomUUID(),
        authorId: this.agent.id,
        authorName: this.agent.config.name,
        type: 'announcement' as const,
        channel: 'all' as const,
        content,
        timestamp: Date.now(),
        day: this.world.time.day,
      };
      this.world.addBoardPost(post);
      this.broadcaster.boardPost(post);
      if (this.bus) this.bus.emit({ type: 'board_post_created', post });
      void this.cognition.addMemory({ id: crypto.randomUUID(), agentId: this.agent.id, type: 'action_outcome', content: `I posted on the village board: "${content.slice(0, 80)}"`, importance: 4, timestamp: Date.now(), relatedAgentIds: [] });
      this.lastOutcome = `You posted on the village board.`;
      this.lastTrigger = this.lastOutcome;
      this.state = 'performing'; this.activityTimer = 3;
      this.world.updateAgentState(this.agent.id, 'active', 'posting on board');
      this.broadcaster.agentAction(this.agent.id, `posted on village board — "${shortReason}"`);
      return;
    }

    // --- Post Group Chat ---
    if (actionId === 'post_group') {
      const groupId = this.agent.institutionIds?.[0];
      const group = groupId ? this.world.getInstitution(groupId) : undefined;
      if (!group || group.dissolved) {
        this.lastTrigger = 'You have no group to post in.';
        this.state = 'idle'; this.idleTimer = 0; return;
      }

      let content: string;
      try {
        const identity = this.cognition.identityBlock;
        content = await this.cognition.llmProvider.complete(
          `You are ${this.agent.config.name}. Write only the group message. No preamble, no quotes.`,
          `${identity}\n\nWrite a private message for your ${group.name} group chat.\nYour reason: ${decision.reason}\nKeep it to 1-2 sentences. Write ONLY the message text.`
        );
        content = content.replace(/^["']|["']$/g, '').trim();
        if (content.length < 3 || content.length > 300) {
          console.warn(`[PostGroup] ${this.agent.config.name} content length out of range (${content.length}), using reason`);
          content = decision.reason.slice(0, 200);
        }
      } catch (err) {
        console.error(`[PostGroup] ${this.agent.config.name} LLM call failed:`, err);
        content = decision.reason.slice(0, 200);
      }

      const post = {
        id: crypto.randomUUID(),
        authorId: this.agent.id,
        authorName: this.agent.config.name,
        type: 'announcement' as const,
        channel: 'group' as const,
        groupId: group.id,
        content,
        timestamp: Date.now(),
        day: this.world.time.day,
      };
      this.world.addBoardPost(post);
      this.broadcaster.boardPost(post);
      if (this.bus) this.bus.emit({ type: 'board_post_created', post });

      for (const member of group.members) {
        if (member.agentId === this.agent.id) continue;
        const cog = (this.world as any).cognitions?.get?.(member.agentId);
        if (cog) {
          void cog.addMemory({
            id: crypto.randomUUID(),
            agentId: member.agentId,
            type: 'observation',
            content: `${this.agent.config.name} posted in ${group.name}: "${content.slice(0, 60)}"`,
            importance: 5,
            timestamp: Date.now(),
            relatedAgentIds: [this.agent.id],
          });
        }
      }

      void this.cognition.addMemory({
        id: crypto.randomUUID(),
        agentId: this.agent.id,
        type: 'action_outcome',
        content: `I posted in ${group.name}: "${content.slice(0, 60)}"`,
        importance: 4,
        timestamp: Date.now(),
        relatedAgentIds: group.members.map(m => m.agentId).filter(id => id !== this.agent.id),
      });

      this.lastOutcome = `You posted in ${group.name}.`;
      this.lastTrigger = this.lastOutcome;
      this.state = 'performing'; this.activityTimer = 3;
      this.world.updateAgentState(this.agent.id, 'active', `posting in ${group.name}`);
      this.broadcaster.agentAction(this.agent.id, `posted in ${group.name} — "${shortReason}"`);
      return;
    }

    // --- Call Meeting ---
    if (actionId === 'call_meeting') {
      const nearbyAll = this.world.getNearbyAgents(this.agent.position, 5).filter(a => a.id !== this.agent.id && a.alive !== false);
      const names = nearbyAll.map(a => a.config.name).join(', ');
      const meetingTopic = decision.reason || 'something important';

      // Caller gets memory
      void this.cognition.addMemory({ id: crypto.randomUUID(), agentId: this.agent.id, type: 'action_outcome', content: `I called a meeting with ${names}. Topic: ${meetingTopic}`, importance: 6, timestamp: Date.now(), relatedAgentIds: nearbyAll.map(a => a.id) });

      // All nearby agents get notified and forced to react
      for (const a of nearbyAll) {
        const cog = (this.world as any).cognitions?.get?.(a.id);
        if (cog) {
          void cog.addMemory({
            id: crypto.randomUUID(),
            agentId: a.id,
            type: 'observation',
            content: `${this.agent.config.name} called a meeting: "${meetingTopic}"`,
            importance: 6,
            timestamp: Date.now(),
            relatedAgentIds: [this.agent.id, ...nearbyAll.map(n => n.id)],
          });
        }
        // Force nearby agents to react to the meeting
        const ctrl = (this.world as any).controllers?.get?.(a.id) as AgentController | undefined;
        if (ctrl) {
          ctrl.lastTrigger = `${this.agent.config.name} just called a meeting. They said: "${meetingTopic}". ${names} are here. What do you do?`;
          ctrl.idleTimer = 7;
        }
      }

      this.lastOutcome = `You called a meeting. ${names} are listening.`;
      this.lastTrigger = this.lastOutcome;
      this.state = 'performing'; this.activityTimer = 3;
      this.world.updateAgentState(this.agent.id, 'active', 'calling meeting');
      this.broadcaster.agentAction(this.agent.id, `called a meeting — "${shortReason}"`);
      return;
    }

    // --- Propose Rule ---
    if (actionId === 'propose_rule') {
      let ruleContent: string;
      try {
        const identity = this.cognition.identityBlock;
        const rulePrompt = `${identity}

You decided to propose a rule for the village.

Your reason: ${decision.reason}

Write the ACTUAL RULE you would propose. This is a public proposal — other villagers will read and vote on it. Not your inner thoughts — what you actually write down. Stay in character.

Keep it to 1-2 sentences. Write ONLY the rule text, nothing else.`;
        ruleContent = await this.cognition.llmProvider.complete(
          `You are ${this.agent.config.name}. Write only the proposed rule. No preamble, no quotes.`,
          rulePrompt,
        );
        ruleContent = ruleContent.replace(/^["']|["']$/g, '').trim();
        if (ruleContent.length < 3 || ruleContent.length > 300) {
          console.warn(`[ProposeRule] ${this.agent.config.name} content length out of range (${ruleContent.length}), using reason`);
          ruleContent = decision.reason.slice(0, 200);
        }
      } catch (err) {
        console.error(`[ProposeRule] ${this.agent.config.name} LLM call failed:`, err);
        ruleContent = decision.reason.slice(0, 200);
      }

      const post = {
        id: crypto.randomUUID(),
        authorId: this.agent.id,
        authorName: this.agent.config.name,
        type: 'rule' as const,
        channel: 'all' as const,
        content: ruleContent,
        timestamp: Date.now(),
        day: this.world.time.day,
        votes: [] as { agentId: string; vote: 'like' | 'dislike' }[],
        ruleStatus: 'proposed' as const,
      };
      this.world.addBoardPost(post);
      this.broadcaster.boardPost(post);
      if (this.bus) this.bus.emit({ type: 'board_post_created', post });

      // All agents get a memory about the proposed rule
      for (const [id, agent] of this.world.agents) {
        if (id === this.agent.id || agent.alive === false) continue;
        const cog = (this.world as any).cognitions?.get?.(id);
        if (cog) {
          void cog.addMemory({
            id: crypto.randomUUID(),
            agentId: id,
            type: 'observation',
            content: `${this.agent.config.name} proposed a rule: "${ruleContent}"`,
            importance: 7,
            timestamp: Date.now(),
            relatedAgentIds: [this.agent.id],
          });
        }
      }

      void this.cognition.addMemory({ id: crypto.randomUUID(), agentId: this.agent.id, type: 'action_outcome', content: `I proposed a rule: "${ruleContent.slice(0, 80)}"`, importance: 6, timestamp: Date.now(), relatedAgentIds: [] });
      this.lastOutcome = `You proposed a rule for the village.`;
      this.lastTrigger = this.lastOutcome;
      this.state = 'performing'; this.activityTimer = 3;
      this.world.updateAgentState(this.agent.id, 'active', 'proposing rule');
      this.broadcaster.agentAction(this.agent.id, `proposed a village rule — "${shortReason}"`);
      return;
    }

    // --- Vote on Rule ---
    if (actionId.startsWith('vote_like_') || actionId.startsWith('vote_dislike_')) {
      const isLike = actionId.startsWith('vote_like_');
      const ruleIdPrefix = actionId.replace(/^vote_(like|dislike)_/, '');
      const rulePost = this.world.getActiveBoard()
        .find(p => p.id.startsWith(ruleIdPrefix) && p.type === 'rule' && p.ruleStatus === 'proposed');

      if (!rulePost) {
        this.lastTrigger = 'The rule you wanted to vote on is no longer active.';
        this.state = 'idle'; this.idleTimer = 0; return;
      }

      // Add vote
      if (!rulePost.votes) rulePost.votes = [];
      rulePost.votes.push({ agentId: this.agent.id, vote: isLike ? 'like' : 'dislike' });

      // Check if majority reached
      const aliveCount = Array.from(this.world.agents.values()).filter(a => a.alive !== false).length;
      const likeCount = rulePost.votes.filter(v => v.vote === 'like').length;
      const dislikeCount = rulePost.votes.filter(v => v.vote === 'dislike').length;
      const totalVotes = likeCount + dislikeCount;

      if (totalVotes >= Math.ceil(aliveCount / 2)) {
        if (likeCount > dislikeCount) {
          // RULE PASSES
          rulePost.ruleStatus = 'passed';

          // Add permanent rule concern to ALL agents
          for (const [id, agent] of this.world.agents) {
            if (agent.alive === false) continue;
            const cog = (this.world as any).cognitions?.get?.(id);
            if (cog?.fourStream) {
              cog.fourStream.addConcern({
                id: crypto.randomUUID(),
                content: `Village rule: ${rulePost.content}`,
                category: 'rule',
                relatedAgentIds: [],
                createdAt: this.world.time.totalMinutes,
                permanent: true,
              });
            }
            if (cog) {
              void cog.addMemory({
                id: crypto.randomUUID(),
                agentId: id,
                type: 'observation',
                content: `Village rule passed: "${rulePost.content}" (${likeCount} for, ${dislikeCount} against)`,
                importance: 8,
                timestamp: Date.now(),
                relatedAgentIds: [],
              });
            }
          }

          // News post
          const ruleNewsPost: BoardPost = {
            id: crypto.randomUUID(),
            authorId: 'system',
            authorName: 'Village News',
            type: 'news',
            channel: 'all',
            content: `Rule passed: "${rulePost.content}" (${likeCount}-${dislikeCount})`,
            timestamp: Date.now(),
            day: this.world.time.day,
          };
          this.world.addBoardPost(ruleNewsPost);
          this.broadcaster.boardPost(ruleNewsPost);
          if (this.bus) this.bus.emit({ type: 'board_post_created', post: ruleNewsPost });
        } else {
          rulePost.ruleStatus = 'rejected';
        }
      }

      // Broadcast updated rule post (with new vote / status) to clients
      this.broadcaster.boardPostUpdate(rulePost);

      void this.cognition.addMemory({
        id: crypto.randomUUID(),
        agentId: this.agent.id,
        type: 'action_outcome',
        content: `I voted ${isLike ? 'for' : 'against'} the rule: "${rulePost.content.slice(0, 60)}"`,
        importance: 5,
        timestamp: Date.now(),
        relatedAgentIds: [],
      });

      this.broadcaster.agentAction(this.agent.id, `voted ${isLike ? 'for' : 'against'} a rule — "${shortReason}"`);
      this.lastOutcome = `You voted ${isLike ? 'for' : 'against'} the proposed rule.`;
      this.lastTrigger = this.lastOutcome;
      this.state = 'performing'; this.activityTimer = 3;
      return;
    }

    // --- Rest ---
    if (actionId === 'rest') {
      this.state = 'performing';
      this.currentPerformingActivity = 'resting';
      this.activityTimer = 20;
      this.world.updateAgentState(this.agent.id, 'active', 'resting');
      void this.cognition.addMemory({ id: crypto.randomUUID(), agentId: this.agent.id, type: 'action_outcome', content: `I rested to recover energy.`, importance: 2, timestamp: Date.now(), relatedAgentIds: [] });
      this.broadcaster.agentAction(this.agent.id, `resting — "${shortReason}"`);
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
      console.log(`[Decision] ${this.agent.config.name} → ${decision.actionId} | ${decision.reason.slice(0, 120)}`);

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
  adjustTrust(agent: Agent, toward: Agent, delta: number): void {
    if (!agent.mentalModels) agent.mentalModels = [];
    const existing = agent.mentalModels.find(m => m.targetId === toward.id);
    if (existing) {
      existing.trust = Math.max(-100, Math.min(100, existing.trust + delta));
      existing.lastUpdated = Date.now();
    } else {
      agent.mentalModels.push({ targetId: toward.id, trust: delta, predictedGoal: '', emotionalStance: 'neutral', notes: [], lastUpdated: Date.now() });
    }
    // Four Stream: sync trust to dossier (only for this controller's agent)
    if (agent.id === this.agent.id) {
      this.cognition.fourStream?.adjustTrust(toward.id, delta);
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
