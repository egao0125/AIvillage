import type { Agent, BoardPost, DriveState, GameTime, Institution, Position, ThinkOutput, VitalState } from '@ai-village/shared';
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
  private postConversationPending: boolean = false;
  private postConvWaitTimer: number = 0;
  private lastObligationText: string = '';
  private obligationCooldown: number = 0;

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
    // Shared engine maps — required for cross-agent memory/controller operations.
    // Passed by reference so new agents added after construction are visible.
    private agentCognitions?: Map<string, AgentCognition>,
    private agentControllers?: Map<string, AgentController>,
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

  /** Add a hard-coded consequence concern (no LLM call needed) */
  addConsequence(text: string, cat: 'threat' | 'commitment' | 'unresolved', ids: string[]): void {
    this.cognition.fourStream?.addConcern({
      id: crypto.randomUUID(),
      content: text,
      category: cat,
      relatedAgentIds: ids,
      createdAt: this.world.time.totalMinutes,
    });
  }

  /** Add a consequence concern to another agent by ID */
  private addConsequenceToAgent(agentId: string, text: string, cat: 'threat' | 'commitment' | 'unresolved', ids: string[]): void {
    const cog = this.agentCognitions?.get(agentId);
    cog?.fourStream?.addConcern({
      id: crypto.randomUUID(),
      content: text,
      category: cat,
      relatedAgentIds: ids,
      createdAt: this.world.time.totalMinutes,
    });
  }

  /** Adjust public reputation score for an agent */
  adjustReputation(agentId: string, change: number, reason: string): void {
    if (!this.world.reputation) this.world.reputation = [];
    let entry = this.world.reputation.find(
      r => r.toAgentId === agentId && r.fromAgentId === 'system'
    );
    if (!entry) {
      entry = {
        fromAgentId: 'system', toAgentId: agentId,
        score: 0, reason: '', lastUpdated: Date.now(),
      };
      this.world.reputation.push(entry);
    }
    entry.score += change;
    entry.reason = reason;
    entry.lastUpdated = Date.now();
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
    }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });
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
      this.processCommitmentExpiry();
    }

    if (this.conversationCooldown > 0) this.conversationCooldown--;
    if (this.obligationCooldown > 0) this.obligationCooldown--;

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
        // Don't decide while post-conversation processing is pending
        if (this.postConversationPending) {
          this.postConvWaitTimer++;
          // Safety: if post-processing takes too long (30 ticks), proceed anyway
          if (this.postConvWaitTimer > 30) {
            this.postConversationPending = false;
            this.postConvWaitTimer = 0;
            this.lastTrigger = 'You just finished a conversation. What now?';
          } else {
            break;
          }
        }
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
        this.state === 'idle' && !this.decidingInProgress &&
        !this.postConversationPending) {
      this.importanceAccum = 0;
      this.lastBeliefTick = this.world.time.totalMinutes;
      void this.cognition.fourStream.generateBeliefs(this.cognition.llmProvider).catch((err: unknown) => { console.warn('[Controller] generateBeliefs failed:', (err as Error).message); });
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
      this.conversationCooldown = 60;
      this.postConversationPending = true;
      this.postConvWaitTimer = 0;
      // DON'T call decideAndAct() — wait for post-processing to finish
      this.world.updateAgentState(this.agent.id, 'idle', '');
    }
  }

  /** Called by ConversationManager after post-processing completes */
  onPostConversationComplete(summary: string): void {
    this.postConversationPending = false;
    this.postConvWaitTimer = 0;
    this.lastTrigger = `You just finished a conversation. ${summary}`;
    if (!this.decidingInProgress && !this.apiExhausted) {
      void this.decideAndAct();
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

      // Update mood from reflection
      if (result.mood) {
        this.agent.mood = result.mood;
      }

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

      // Four Stream: nightly compression — beliefs + prune timeline + prune concerns
      if (this.cognition.fourStream) {
        // Clean up concerns involving dead agents
        for (const c of this.cognition.fourStream.getAllConcerns()) {
          if (c.relatedAgentIds?.length) {
            const allDead = c.relatedAgentIds.every(id => {
              const a = this.world.getAgent(id);
              return a && a.alive === false;
            });
            if (allDead) {
              this.cognition.fourStream.resolveConcern(c.id);
            }
          }
        }

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

      // Hunger rate: 1.0/hour awake, 0.3/hour sleeping (0 if sleeping in owned property)
      if (this.state === 'sleeping') {
        const sleepArea = this.world.getAreaAt(this.agent.position);
        const ownsProperty = sleepArea && this.world.getPropertyOwner(sleepArea.id) === this.agent.id;
        if (!ownsProperty) {
          v.hunger = Math.min(100, v.hunger + 0.3);
        }
        // Property owners sleep comfortably — no hunger loss overnight
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

      // Passive health regen — 2/hour, only when fed and rested
      if (v.hunger < 70 && v.energy > 20 && v.health < 100) {
        v.health = Math.min(100, v.health + 2);
      }
    }

    // Energy depletes during activity, restores during sleep/rest
    if (this.state === 'performing' || this.state === 'moving') {
      const lower = this.currentPerformingActivity.toLowerCase();
      const isResting = lower.includes('rest') || lower.includes('relax') || lower.includes('nap') || lower.includes('sit') || lower.includes('meditat');
      if (isResting) {
        v.energy = Math.min(100, v.energy + 0.3);
      } else {
        v.energy = Math.max(0, v.energy - 0.03);
      }
    } else if (this.state === 'idle') {
      v.energy = Math.min(100, v.energy + 0.02);
    } else if (this.state === 'sleeping') {
      v.energy = Math.min(100, v.energy + 0.5);
    }

    // Vitals affect health — starvation and exhaustion can kill (per tick)
    if (v.hunger >= 85) {
      v.health = Math.max(0, v.health - 0.05);
    } else if (v.hunger >= 70) {
      v.health = Math.max(0, v.health - 0.02);
    }
    if (v.energy <= 5) {
      v.health = Math.max(0, v.health - 0.03);
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
      }).catch((err: unknown) => { console.warn('[Controller] vitals addMemory failed:', (err as Error).message); });
    }
    if (energyBand > this.lastEnergyBand) {
      const vitalsMemId = crypto.randomUUID();
      void this.cognition.addMemory({
        id: vitalsMemId, agentId: this.agent.id, type: 'observation',
        content: `I'm ${energyBand === 2 ? 'completely exhausted' : 'getting tired'}. Energy: ${Math.round(v.energy)}/100.`,
        importance: energyBand === 2 ? 7 : 5,
        timestamp: Date.now(), relatedAgentIds: [],
      }).catch((err: unknown) => { console.warn('[Controller] vitals addMemory failed:', (err as Error).message); });
    }
    if (healthBand > this.lastHealthBand) {
      const vitalsMemId = crypto.randomUUID();
      void this.cognition.addMemory({
        id: vitalsMemId, agentId: this.agent.id, type: 'observation',
        content: `I'm ${healthBand === 2 ? 'critically injured' : 'hurt and need care'}. Health: ${Math.round(v.health)}/100.`,
        importance: healthBand === 2 ? 8 : 6,
        timestamp: Date.now(), relatedAgentIds: [],
      }).catch((err: unknown) => { console.warn('[Controller] vitals addMemory failed:', (err as Error).message); });
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

    // Village collective memory — death is always significant
    this.world.addVillageMemory({
      content: `${this.agent.config.name} died of ${cause}.`,
      type: 'death',
      day: this.world.time.day,
      significance: 9,
    });

    // Fix 4: Emit agent_died event for nearby witness perception
    if (this.bus) {
      this.bus.emit({
        type: 'agent_died',
        agentId: this.agent.id,
        cause,
      });
    }

    // Clean up dossiers: collapse dead agent's entry for all living agents
    for (const [id, agent] of this.world.agents) {
      if (id === this.agent.id || agent.alive === false) continue;
      const cog = this.agentCognitions?.get(id);
      const dossier = cog?.fourStream?.getDossier(this.agent.id);
      if (dossier) {
        dossier.summary = `Died of ${cause} on day ${this.world.time.day}.`;
        dossier.activeCommitments = [];
        dossier.lastUpdated = Date.now();
      }
      cog?.fourStream?.syncDossiersToAgent?.();
    }

    // Notify engine for cleanup + other agent notification
    if (this.onDeath) {
      this.onDeath(this.agent.id, cause);
    }
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
    }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });
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
    }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });

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
    const lines: string[] = [];

    // Weighted commitments (primary source of truth)
    const commitments = (this.agent.commitments ?? []).filter(c => !c.fulfilled && !c.broken);
    for (const c of commitments) {
      const weightLabel = c.weight === 5 ? 'OATH' : c.weight === 3 ? 'PROMISE' : 'casual';
      const daysLeft = c.expiresDay - this.world.time.day;
      const urgency = daysLeft < 0 ? ' OVERDUE' : daysLeft === 0 ? ' due today' : '';
      lines.push(`- [${weightLabel}${urgency}] ${c.content} (to ${c.targetName})`);
    }

    // Non-promise social ledger entries (trades, meetings, alliances, rules)
    const ledger = this.agent.socialLedger ?? [];
    const active = ledger.filter(e =>
      (e.status === 'proposed' || e.status === 'accepted') &&
      e.type !== 'promise' && e.type !== 'task'
    );
    for (const e of active) {
      const tag = e.source === 'secondhand' ? ' (secondhand)' : '';
      lines.push(`- [${e.status}] ${e.description}${tag}`);
    }

    if (lines.length === 0) return '';
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

  /** Process weighted commitment expiry — scaled penalties by weight */
  private processCommitmentExpiry(): void {
    const commitments = this.agent.commitments;
    if (!commitments || commitments.length === 0) return;
    const day = this.world.time.day;

    for (const c of commitments) {
      if (c.fulfilled || c.broken) continue;
      if (day <= c.expiresDay) continue;

      c.broken = true;
      const repPenalty = c.weight === 1 ? -1 : c.weight === 3 ? -3 : -8;
      this.adjustReputation(this.agent.id, repPenalty, `Broke ${c.weight === 5 ? 'oath' : 'promise'} to ${c.targetName}`);
      console.log(`[Commitment] ${this.agent.config.name} broke ${c.weight === 5 ? 'OATH' : 'promise'} to ${c.targetName}: ${c.content.slice(0, 50)} (rep ${repPenalty})`);

      // Oaths become village memory
      if (c.weight >= 5) {
        this.world.addVillageMemory({
          content: `${this.agent.config.name} broke oath to ${c.targetName}: "${c.content.slice(0, 60)}"`,
          type: 'broken_oath',
          day,
          significance: 8,
        });
      }

      // Archive broken commitment
      if (!this.agent.archivedCommitments) this.agent.archivedCommitments = [];
      c.archivedAt = this.world.time.totalMinutes;
      this.agent.archivedCommitments.push(c);
      if (this.agent.archivedCommitments.length > 20) {
        this.agent.archivedCommitments = this.agent.archivedCommitments.slice(-20);
      }
    }

    // Remove fulfilled/broken from active
    this.agent.commitments = commitments.filter(c => !c.fulfilled && !c.broken);
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
      const resKey = name.toLowerCase().replace(/\s+/g, '_');
      const resDef = RESOURCES[resKey];
      const nutrition = resDef?.nutritionValue ?? 0;
      const hint = nutrition >= 25 ? 'very filling' : nutrition >= 15 ? 'filling' : nutrition >= 8 ? 'light meal' : 'snack';
      actions.push({
        id: 'eat_' + resKey,
        label: `Eat ${name} (${hint}${qty > 1 ? `, ${qty} left` : ''})`,
        category: 'physical',
      });
    }

    // ========================================
    // 2. SOCIAL ACTIONS — pattern-based, listed ONCE (not per agent)
    //    The LLM fills in the name from the nearby list.
    // ========================================

    const nearby = this.world.getNearbyAgents(this.agent.position, 5)
      .filter(a => a.id !== this.agent.id && a.alive !== false && a.state !== 'sleeping');
    const nearbyForSituation: { name: string; activity: string; id: string; vitals?: { hunger: number; energy: number; health: number } }[] = [];

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

      // Spatial context: distance and direction
      const dx = a.position.x - this.agent.position.x;
      const dy = a.position.y - this.agent.position.y;
      const dist = Math.round(Math.sqrt(dx * dx + dy * dy));
      const dir = dist < 2 ? 'right here' : (
        (Math.abs(dy) > Math.abs(dx)
          ? (dy < 0 ? 'north' : 'south')
          : (dx < 0 ? 'west' : 'east'))
      );
      const otherArea = getAreaAt(a.position);
      const spatialStr = dist < 2 ? '' : `, ${dist} tiles ${dir}${otherArea ? ' at ' + otherArea.name : ''}`;

      nearbyForSituation.push({
        name: a.config.name,
        activity: (a.currentAction || 'idle') + otherInvStr + spatialStr,
        id: a.id,
        vitals: a.vitals,
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
      actions.push({ id: 'steal_NAME', label: 'Steal from someone', category: 'social' });
      actions.push({ id: 'confront_NAME', label: 'Confront someone', category: 'social' });
      actions.push({ id: 'threaten_NAME', label: 'Threaten someone', category: 'social' });
      actions.push({ id: 'ally_NAME', label: 'Propose alliance with someone', category: 'social' });
      actions.push({ id: 'betray_NAME', label: 'Break an alliance with someone', category: 'social' });
      actions.push({ id: 'fight_NAME', label: 'Attack someone', category: 'social' });
    }

    // ========================================
    // 3. COMMUNITY ACTIONS (with cooldowns)
    // ========================================

    // Board post — max 2 per agent per day
    const todayBoardPosts = this.world.getActiveBoard()
      .filter(p => p.authorId === this.agent.id && p.day === this.world.time.day && p.type !== 'rule');
    if (todayBoardPosts.length < 2) {
      actions.push({ id: 'post_board', label: 'Write on all-agent chat', category: 'creative' });
    }

    // Group post — only if agent is in an active institution/group
    const myGroupId = this.agent.institutionIds?.[0];
    const myGroup = myGroupId ? this.world.getInstitution(myGroupId) : undefined;
    if (myGroup && !myGroup.dissolved) {
      actions.push({ id: 'post_group', label: `Write in ${myGroup.name} chat`, category: 'creative' });
    }

    // Propose rule / claim — max 1 per day (claims also count)
    const hasProposedToday = this.world.getActiveBoard()
      .some(p => p.type === 'rule' && p.authorId === this.agent.id && p.day === this.world.time.day);
    if (!hasProposedToday) {
      actions.push({ id: 'propose_rule', label: 'Propose a rule or claim (voted tonight)', category: 'creative' });
    }

    // Group rule — only founders/leaders can set rules directly
    if (myGroup && !myGroup.dissolved && !hasProposedToday) {
      const myRole = myGroup.members.find(m => m.agentId === this.agent.id)?.role;
      if (myRole === 'founder' || myRole === 'leader') {
        actions.push({ id: 'propose_group_rule', label: `Set a rule for ${myGroup.name}`, category: 'creative' });
      }
    }

    // Kick — leaders can kick non-founder members
    if (myGroup && !myGroup.dissolved) {
      const myRole = myGroup.members.find(m => m.agentId === this.agent.id)?.role;
      if (myRole === 'founder' || myRole === 'leader') {
        for (const member of myGroup.members) {
          if (member.agentId === this.agent.id) continue;
          if (member.role === 'founder') continue;
          const memberAgent = this.world.getAgent(member.agentId);
          if (memberAgent && memberAgent.alive !== false) {
            const firstName = memberAgent.config.name.split(' ')[0].toLowerCase();
            actions.push({ id: `kick_${firstName}`, label: `Kick ${memberAgent.config.name.split(' ')[0]} from ${myGroup.name}`, category: 'social' });
          }
        }
      }
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

    // Build property/building info for current location
    // Claims also count toward 1-proposal-per-day limit
    const canPropose = this.world.getActiveBoard()
      .filter(p => p.type === 'rule' && p.authorId === this.agent.id && p.day === this.world.time.day)
      .length < 1;
    const lines: string[] = [];
    const areaOwner = this.world.getPropertyOwner(areaId);
    if (areaOwner) {
      const ownerAgent = this.world.getAgent(areaOwner);
      lines.push(`This area is owned by ${ownerAgent?.config.name ?? 'someone'}.`);
    } else {
      lines.push(`This area is unclaimed.`);
      if (canPropose) {
        actions.push({ id: `claim_area_${areaId}`, label: `Claim ${area?.name ?? areaId} (voted tonight)`, category: 'creative' });
      }
    }

    const buildingsHere = this.world.getBuildingsAt(areaId);
    for (const b of buildingsHere) {
      const owner = b.ownerId ? this.world.getAgent(b.ownerId) : undefined;
      const ownerName = owner ? owner.config.name : 'unclaimed';
      const effects = b.effects.length > 0 ? ` (${b.effects.join(', ')})` : '';
      lines.push(`- ${b.name} [${b.type}]${effects} — ${ownerName === 'unclaimed' ? 'UNCLAIMED' : `owned by ${ownerName}`}`);

      if ((!b.ownerId || b.ownerId === '') && canPropose) {
        actions.push({ id: `claim_${b.id}`, label: `Claim ${b.name} (voted tonight)`, category: 'creative' });
      }
    }
    const propertyInfo = lines.join('\n');

    // Build village rules from passed board posts
    let villageRules: string | undefined;
    const passedRules = this.world.getActiveBoard()
      .filter(p => p.type === 'rule' && p.ruleStatus === 'passed');
    if (passedRules.length > 0) {
      villageRules = passedRules.map((r, i) => `${i + 1}. ${r.content}`).join('\n');
    }

    // Build group info from Institution membership
    let groupInfo: string | undefined;
    const gId = this.agent.institutionIds?.[0];
    const grp = gId ? this.world.getInstitution(gId) : undefined;
    if (grp && !grp.dissolved) {
      const memberNames = grp.members
        .map(m => this.world.getAgent(m.agentId)?.config.name ?? 'Unknown')
        .join(', ');
      const myRole = grp.members.find(m => m.agentId === this.agent.id)?.role ?? 'member';
      groupInfo = `${grp.name} — you are the ${myRole.toUpperCase()}. Members: ${memberNames}.`;
      if (myRole === 'founder' || myRole === 'leader') {
        groupInfo += '\nAs leader you can: set group rules, kick members, and distribute resources.';
      }
      if (grp.description) groupInfo += `\nPurpose: ${grp.description}`;
      if (grp.rules.length > 0) groupInfo += `\nRules: ${grp.rules.join('; ')}`;
    }

    // Build all agent locations for dossier display
    const allAgentLocations: { id: string; location: string }[] = [];
    for (const [id, agent] of this.world.agents) {
      if (id === this.agent.id) continue;
      if (agent.alive === false) continue;
      const agentArea = getAreaAt(agent.position);
      allAgentLocations.push({
        id,
        location: agent.state === 'sleeping'
          ? 'sleeping'
          : (agentArea?.name ?? 'somewhere'),
      });
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
      propertyInfo,
      villageRules,
      allAgentLocations,
      allReputations: (this.world.reputation ?? [])
        .filter(r => r.fromAgentId === 'system' && r.score !== 0)
        .map(r => ({ id: r.toAgentId, score: r.score })),
      villageHistory: this.world.getTopVillageMemory(5) || undefined,
    };
  }

  /** Step 3b: Check if any obligations should override the trigger */
  private checkObligations(situation: AgentSituation): string | undefined {
    if (this.obligationCooldown > 0) return undefined;

    const nearbyIds = new Set(situation.nearbyAgents.map(a => a.id));

    // 1. Check weighted commitments — promises/oaths from conversations
    const activeCommitments = (this.agent.commitments ?? []).filter(c => !c.fulfilled && !c.broken);

    for (const c of activeCommitments) {
      // Is the commitment target nearby?
      if (!nearbyIds.has(c.targetId)) continue;

      const targetAgent = this.world.getAgent(c.targetId);
      if (!targetAgent || targetAgent.alive === false) continue;
      const firstName = targetAgent.config.name.split(' ')[0];

      const text = c.content.toLowerCase();
      const weightLabel = c.weight === 5 ? 'OATH' : c.weight === 3 ? 'PROMISE' : 'casual promise';
      const daysLeft = c.expiresDay - this.world.time.day;
      const urgency = daysLeft < 0 ? ' OVERDUE!' : daysLeft === 0 ? ' Due TODAY!' : '';

      // Check if promised items are involved
      if (c.itemsPromised && c.itemsPromised.length > 0) {
        const itemCounts = new Map<string, number>();
        for (const item of c.itemsPromised) itemCounts.set(item, (itemCounts.get(item) ?? 0) + 1);

        // Check which promised items we have
        const canFulfill: string[] = [];
        const missing: string[] = [];
        for (const [item, needed] of itemCounts) {
          const have = this.agent.inventory.filter(i => i.name.toLowerCase().includes(item)).length;
          if (have >= needed) canFulfill.push(`${needed} ${item}`);
          else missing.push(`${item} (have ${have}/${needed})`);
        }

        if (canFulfill.length > 0 && missing.length === 0) {
          // Have everything — fulfill
          return `YOUR ${weightLabel}: "${c.content}".${urgency} ${firstName} is RIGHT HERE and you have everything. Honor it: give_${firstName.toLowerCase()}.`;
        } else if (canFulfill.length > 0) {
          // Have some — offer partial or renegotiate
          return `YOUR ${weightLabel}: "${c.content}".${urgency} ${firstName} is here. You have ${canFulfill.join(', ')} but missing ${missing.join(', ')}. Options: give what you have (give_${firstName.toLowerCase()}), talk to renegotiate (talk_${firstName.toLowerCase()}), or break it (rep ${c.weight === 5 ? '-8' : c.weight === 3 ? '-3' : '-1'}).`;
        } else {
          // Have nothing — renegotiate or work toward it
          if (daysLeft <= 0) {
            return `YOUR ${weightLabel} to ${firstName} is OVERDUE: "${c.content}". You lack ${missing.join(', ')}. ${firstName} is here — renegotiate now (talk_${firstName.toLowerCase()}) or it breaks automatically (rep ${c.weight === 5 ? '-8' : c.weight === 3 ? '-3' : '-1'}).`;
          }
          continue; // Still time — don't interrupt, let them gather
        }
      }

      // Non-item commitments (meet, talk, teach, etc.)
      const talkMatch = text.match(/meet|talk|discuss|tell|warn|teach|show|confess|report|present/);
      if (talkMatch) {
        return `YOUR ${weightLabel}: "${c.content}".${urgency} ${firstName} is RIGHT HERE. Follow through: talk_${firstName.toLowerCase()}.`;
      }

      // Generic: target is nearby
      return `YOUR ${weightLabel}: "${c.content}".${urgency} ${firstName} is right here. Act on it or renegotiate.`;
    }

    // 2. Ally in crisis — trusted person nearby dying
    for (const nearby of situation.nearbyAgents) {
      const dossier = this.cognition.fourStream?.getDossier?.(nearby.id);
      const trust = dossier?.trust ?? 0;
      if (trust > 30 && nearby.vitals) {
        if (nearby.vitals.hunger >= 70 || nearby.vitals.health <= 20) {
          const firstName = nearby.name.split(' ')[0];
          const hasFood = this.agent.inventory.some(i => i.type === 'food');
          if (hasFood) {
            return `${firstName.toUpperCase()} IS DYING (hunger:${nearby.vitals.hunger} health:${nearby.vitals.health}). You trust them (${trust}). You have food. Give it: give_${firstName.toLowerCase()}. They will die if you don't act.`;
          } else {
            return `${firstName.toUpperCase()} IS DYING (hunger:${nearby.vitals.hunger} health:${nearby.vitals.health}). You trust them (${trust}). You have no food — go gather some immediately.`;
          }
        }
      }
    }

    // 3. Recent threat — person who wronged you is nearby
    const threats = this.cognition.fourStream?.getAllConcerns()
      .filter(c => c.category === 'threat') ?? [];
    for (const t of threats) {
      const threatSource = t.relatedAgentIds?.find(id => nearbyIds.has(id));
      if (!threatSource) continue;
      const person = this.world.getAgent(threatSource);
      if (!person || person.alive === false) continue;
      const ageMinutes = this.world.time.totalMinutes - (t.createdAt || 0);
      if (ageMinutes < 120) {
        const firstName = person.config.name.split(' ')[0];
        return `${firstName} threatened/wronged you recently: "${t.content.slice(0, 80)}". They're right here. Confront them? Avoid them? Your choice.`;
      }
    }

    return undefined;
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
    }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });
    // Four Stream: accumulate importance for belief generation
    this.importanceAccum += outcomeImportance;

    // Strategy snapshot tracking — record state after every action
    if (!actor.strategyHistory) actor.strategyHistory = [];
    const dossiers = this.cognition.fourStream?.getAllDossiers?.() ?? [];
    const avgTrust = dossiers.length > 0
      ? Math.round(dossiers.reduce((s, d) => s + (d.trust ?? 0), 0) / dossiers.length)
      : 0;
    const repEntry = (this.world.reputation ?? []).find(
      r => r.toAgentId === actor.id && r.fromAgentId === 'system'
    );
    actor.strategyHistory.push({
      actionType: outcome.type || 'unknown',
      day: this.world.time.day,
      hungerAt: actor.vitals?.hunger ?? 0,
      healthAt: actor.vitals?.health ?? 100,
      inventoryCount: actor.inventory.length,
      avgTrust,
      reputation: repEntry?.score ?? 0,
    });
    // Cap at 100 entries
    if (actor.strategyHistory.length > 100) {
      actor.strategyHistory = actor.strategyHistory.slice(-100);
    }

    // Consequence concern on failure
    if (!outcome.success) {
      this.addConsequence(
        `Failed: ${outcome.description.slice(0, 40)}. Try different approach.`,
        'unresolved', []
      );
    }

    // Broadcast
    this.broadcaster.agentAction(actor.id, outcome.description);
  }

  /** Step 5: Execute a structured decision — dispatch to game systems */
  private async executeDecision(decision: AgentDecision, situation: AgentSituation): Promise<void> {
    const actionId = decision.actionId;
    // Truncated reason for action broadcasts — "action — reason"
    const shortReason = decision.reason?.length > 80
      ? this.truncateAtSentence(decision.reason, 80)
      : (decision.reason || '');

    // --- Gather ---
    if (actionId.startsWith('gather_')) {
      const resource = actionId.replace('gather_', '');
      const area = getAreaAt(this.agent.position);
      const areaId = area?.id ?? 'plaza';

      // Check area ownership — trespassing creates consequences but doesn't block
      if (area) {
        const areaOwner = this.world.getPropertyOwner(area.id);
        if (areaOwner && areaOwner !== this.agent.id) {
          const ownerAgent = this.world.getAgent(areaOwner);
          const ownerGroupId = ownerAgent?.institutionIds?.[0];
          const iAmMember = ownerGroupId && this.agent.institutionIds?.includes(ownerGroupId);
          if (!iAmMember) {
            this.addConsequence(
              `I gathered on ${ownerAgent?.config.name ?? 'someone'}'s land without permission. They may confront me.`,
              'threat', [areaOwner]
            );
            this.addConsequenceToAgent(areaOwner,
              `${this.agent.config.name} gathered on my land without permission. Confront them or set a rule.`,
              'threat', [this.agent.id]
            );
            this.adjustReputation(this.agent.id, -3, 'Trespassing');
          }
        }
      }

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
        void this.cognition.fourStream.updateDossier(target.id, target.config.name, this.lastOutcome || outcome.description, this.cognition.llmProvider).catch((err: unknown) => { console.warn('[Controller] updateDossier failed:', (err as Error).message); });
      }
      this.adjustReputation(this.agent.id, +3, 'Generosity');

      // --- Commitment fulfillment: check if this give fulfills an active promise ---
      const givenName = item.name.toLowerCase().replace(/\s+/g, '_');
      for (const commit of (this.agent.commitments ?? [])) {
        if (commit.fulfilled || commit.broken) continue;
        if (commit.targetId !== target.id) continue;
        let matched = false;
        if (commit.itemsPromised?.length) {
          matched = commit.itemsPromised.some(p => {
            const pn = p.toLowerCase().replace(/\s+/g, '_');
            return givenName.includes(pn) || pn.includes(givenName);
          });
        } else if (/give|bring|deliver|share|provide/.test(commit.content.toLowerCase())) {
          matched = true;
        }
        if (matched) {
          commit.fulfilled = true;
          commit.archivedAt = Date.now();
          if (!this.agent.archivedCommitments) this.agent.archivedCommitments = [];
          if (this.agent.archivedCommitments.length >= 20) this.agent.archivedCommitments.shift();
          this.agent.archivedCommitments.push(commit);
          this.adjustReputation(this.agent.id, +2, `Kept promise to ${target.config.name}`);
          console.log(`[Commitment] ${this.agent.config.name} FULFILLED promise to ${target.config.name}: "${commit.content.slice(0, 60)}"`);
          break; // Only fulfill one commitment per give
        }
      }
      if (this.agent.commitments) {
        this.agent.commitments = this.agent.commitments.filter(c => !c.fulfilled && !c.broken);
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
          // Fulfill talk/meet commitments targeting this person
          for (const commit of (this.agent.commitments ?? [])) {
            if (commit.fulfilled || commit.broken) continue;
            if (commit.targetId !== agent.id) continue;
            if (/meet|talk|discuss|tell|warn|teach|show|confess|report|present|testify/.test(commit.content.toLowerCase())) {
              commit.fulfilled = true;
              commit.archivedAt = Date.now();
              if (!this.agent.archivedCommitments) this.agent.archivedCommitments = [];
              if (this.agent.archivedCommitments.length >= 20) this.agent.archivedCommitments.shift();
              this.agent.archivedCommitments.push(commit);
              this.adjustReputation(this.agent.id, +2, `Kept promise to ${agent.config.name}`);
              console.log(`[Commitment] ${this.agent.config.name} FULFILLED talk commitment to ${agent.config.name}: "${commit.content.slice(0, 60)}"`);
              break;
            }
          }
          if (this.agent.commitments) {
            this.agent.commitments = this.agent.commitments.filter(c => !c.fulfilled && !c.broken);
          }

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
        void this.cognition.fourStream.updateDossier(target.id, target.config.name, outcome.description, this.cognition.llmProvider).catch((err: unknown) => { console.warn('[Controller] updateDossier failed:', (err as Error).message); });
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
      if (outcome.success) {
        this.adjustReputation(this.agent.id, +2, 'Fair trade');
        this.adjustReputation(target.id, +2, 'Fair trade');
      }
      this.state = 'performing'; this.activityTimer = 3;
      this.world.updateAgentState(this.agent.id, 'active', `trading with ${target.config.name}`);
      this.broadcaster.agentAction(this.agent.id, `traded with ${target.config.name} — "${shortReason}"`);
      return;
    }

    // --- Teach ---
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
      }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });

      const targetCog = this.agentCognitions?.get(target.id);
      if (targetCog) {
        void targetCog.addMemory({
          id: crypto.randomUUID(), agentId: target.id, type: 'observation',
          content: `${this.agent.config.name} threatened me: ${threatText}`,
          importance: 9, timestamp: Date.now(), relatedAgentIds: [this.agent.id],
        }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });
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
          `I threatened ${target.config.name}: ${threatText}`, this.cognition.llmProvider).catch((err: unknown) => { console.warn('[Controller] updateDossier failed:', (err as Error).message); });
      }

      const targetCtrl = this.agentControllers?.get(target.id);
      if (targetCtrl) {
        targetCtrl.lastTrigger = `${this.agent.config.name} just threatened you: "${threatText}". What do you do?`;
        targetCtrl.idleTimer = 7;
      }

      // PUBLIC: news post for threat
      const threatPost: BoardPost = {
        id: crypto.randomUUID(), authorId: 'system',
        authorName: 'Village News', type: 'news',
        channel: 'all',
        content: `${this.agent.config.name} threatened ${target.config.name}: "${threatText.slice(0, 100)}"`,
        timestamp: Date.now(), day: this.world.time.day,
      };
      this.world.addBoardPost(threatPost);
      this.broadcaster.boardPost(threatPost);
      if (this.bus) this.bus.emit({ type: 'board_post_created', post: threatPost });

      // Threatener gets follow-through commitment
      if (this.cognition.fourStream) {
        this.cognition.fourStream.addConcern({
          id: crypto.randomUUID(),
          content: `I threatened ${target.config.name}: "${threatText.slice(0, 40)}". Follow through or lose credibility.`,
          category: 'commitment',
          relatedAgentIds: [target.id],
          createdAt: this.world.time.totalMinutes,
          expiresAt: this.world.time.totalMinutes + (24 * 60),
        });
      }
      this.adjustReputation(this.agent.id, -3, 'Threatening');

      this.lastOutcome = `You threatened ${target.config.name}.`;
      this.lastTrigger = this.lastOutcome;
      this.state = 'performing'; this.activityTimer = 3;
      this.world.updateAgentState(this.agent.id, 'active', `threatening ${target.config.name}`);
      this.broadcaster.agentAction(this.agent.id, `threatened ${target.config.name} — "${shortReason}"`);
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
      void this.cognition.addMemory({ id: crypto.randomUUID(), agentId: this.agent.id, type: 'action_outcome', content: `I confronted ${target.config.name}: ${confrontText}`, importance: 7, timestamp: Date.now(), relatedAgentIds: [target.id] }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });
      // Memory for target
      const targetCognition = this.agentCognitions?.get(target.id);
      if (targetCognition) {
        void targetCognition.addMemory({ id: crypto.randomUUID(), agentId: target.id, type: 'action_outcome', content: `${this.agent.config.name} confronted me: ${confrontText}`, importance: 7, timestamp: Date.now(), relatedAgentIds: [this.agent.id] }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });
      }
      // Witness memories for all nearby
      const nearbyAll = this.world.getNearbyAgents(this.agent.position, 5).filter(a => a.id !== this.agent.id && a.id !== target.id);
      for (const witness of nearbyAll) {
        const wCog = this.agentCognitions?.get(witness.id);
        if (wCog) {
          void wCog.addMemory({ id: crypto.randomUUID(), agentId: witness.id, type: 'observation', content: `I saw ${this.agent.config.name} confront ${target.config.name}: "${confrontText}"`, importance: 5, timestamp: Date.now(), relatedAgentIds: [this.agent.id, target.id] }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });
        }
      }
      this.adjustTrust(target, this.agent, -15);
      this.adjustTrust(this.agent, target, -15);
      if (this.cognition.fourStream) {
        void this.cognition.fourStream.updateDossier(target.id, target.config.name, `I confronted ${target.config.name}: ${confrontText}`, this.cognition.llmProvider).catch((err: unknown) => { console.warn('[Controller] updateDossier failed:', (err as Error).message); });
      }
      // Force target to react
      const targetCtrl = this.agentControllers?.get(target.id);
      if (targetCtrl) {
        targetCtrl.lastTrigger = `${this.agent.config.name} just confronted you: "${confrontText}". How do you respond?`;
        targetCtrl.idleTimer = 20; // trigger decision on next tick (threshold is 20)
      }
      // PUBLIC: news post for confrontation
      const confrontPost: BoardPost = {
        id: crypto.randomUUID(), authorId: 'system',
        authorName: 'Village News', type: 'news',
        channel: 'all',
        content: `${this.agent.config.name} confronted ${target.config.name}: "${confrontText.slice(0, 100)}"`,
        timestamp: Date.now(), day: this.world.time.day,
      };
      this.world.addBoardPost(confrontPost);
      this.broadcaster.boardPost(confrontPost);
      if (this.bus) this.bus.emit({ type: 'board_post_created', post: confrontPost });

      // Confronter needs resolution
      if (this.cognition.fourStream) {
        this.cognition.fourStream.addConcern({
          id: crypto.randomUUID(),
          content: `I confronted ${target.config.name}: "${confrontText.slice(0, 40)}". Need resolution.`,
          category: 'unresolved',
          relatedAgentIds: [target.id],
          createdAt: this.world.time.totalMinutes,
        });
      }
      // Target must address it
      if (targetCognition?.fourStream) {
        targetCognition.fourStream.addConcern({
          id: crypto.randomUUID(),
          content: `${this.agent.config.name} publicly confronted me: "${confrontText.slice(0, 40)}". Others saw. Must respond.`,
          category: 'unresolved',
          relatedAgentIds: [this.agent.id],
          createdAt: this.world.time.totalMinutes,
        });
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
        void this.cognition.fourStream.updateDossier(target.id, target.config.name, outcome.description, this.cognition.llmProvider).catch((err: unknown) => { console.warn('[Controller] updateDossier failed:', (err as Error).message); });
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
        const cog = this.agentCognitions?.get(id);
        if (cog) {
          void cog.addMemory({
            id: crypto.randomUUID(),
            agentId: id,
            type: 'observation',
            content: `${this.agent.config.name} stole from ${target.config.name}.`,
            importance: 8,
            timestamp: Date.now(),
            relatedAgentIds: [this.agent.id, target.id],
          }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });
        }
      }
      // Consequence concerns: thief fears retaliation, victim feels threatened
      this.addConsequence(
        `I stole from ${target.config.name}. They may retaliate.`,
        'threat', [target.id]
      );
      const vCog = this.agentCognitions?.get(target.id);
      vCog?.fourStream?.addConcern({
        id: crypto.randomUUID(),
        content: `${this.agent.config.name} stole from me. Guard my food. Consider confronting.`,
        category: 'threat',
        relatedAgentIds: [this.agent.id],
        createdAt: this.world.time.totalMinutes,
      });

      this.adjustReputation(this.agent.id, -10, 'Theft');

      // Check village rule violations
      const stealRulePosts = this.world.getActiveBoard()
        .filter(p => p.type === 'rule' && p.ruleStatus === 'passed');
      for (const rp of stealRulePosts) {
        const rl = rp.content.toLowerCase();
        if (rl.includes('no steal') || rl.includes('no theft') || rl.includes('stealing')) {
          const vPost: BoardPost = {
            id: crypto.randomUUID(), authorId: 'system',
            authorName: 'Village News', type: 'news',
            channel: 'all',
            content: `RULE VIOLATION: ${this.agent.config.name} broke village rule "${rp.content.slice(0, 60)}"!`,
            timestamp: Date.now(), day: this.world.time.day,
          };
          this.world.addBoardPost(vPost);
          this.broadcaster.boardPost(vPost);
          if (this.bus) this.bus.emit({ type: 'board_post_created', post: vPost });
          this.adjustReputation(this.agent.id, -10, 'Broke village rule');
          break;
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
        const targetCog = this.agentCognitions?.get(outcome.targetAgentId);
        if (targetCog) {
          void targetCog.addMemory({
            id: crypto.randomUUID(),
            agentId: outcome.targetAgentId,
            type: 'observation',
            content: this.agent.config.name + ' attacked me! I took ' + Math.abs(outcome.targetHealthChange ?? 0) + ' damage.',
            importance: 9,
            timestamp: Date.now(),
            relatedAgentIds: [this.agent.id],
          }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });
        }

        // Force target to react immediately
        const targetCtrl = this.agentControllers?.get(outcome.targetAgentId) as AgentController | undefined;
        if (targetCtrl && targetAgent) {
          targetCtrl.lastTrigger = this.agent.config.name + ' just attacked you! Health: ' + Math.round(targetAgent.vitals?.health ?? 0) + '/100. What do you do?';
          targetCtrl.idleTimer = 7;
        }
      }

      // ALL nearby agents witness the fight
      const witnesses = this.world.getNearbyAgents(this.agent.position, 5)
        .filter(a => a.id !== this.agent.id && a.id !== target.id && a.alive !== false);
      for (const w of witnesses) {
        const wCog = this.agentCognitions?.get(w.id);
        if (wCog) {
          void wCog.addMemory({
            id: crypto.randomUUID(),
            agentId: w.id,
            type: 'observation',
            content: 'I saw ' + this.agent.config.name + ' attack ' + target.config.name + '! ' + outcome.description,
            importance: 8,
            timestamp: Date.now(),
            relatedAgentIds: [this.agent.id, target.id],
          }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });
        }
        // Force witnesses to react
        const wCtrl = this.agentControllers?.get(w.id) as AgentController | undefined;
        if (wCtrl) {
          wCtrl.lastTrigger = this.agent.config.name + ' just attacked ' + target.config.name + ' right in front of you! What do you do?';
          wCtrl.idleTimer = 7;
        }
      }

      // Trust destruction — fighting destroys trust for everyone who saw
      this.adjustTrust(this.agent, target, -40);
      this.adjustTrust(target, this.agent, -40);
      // Contextual witness trust — witnesses who already distrusted the target see justice, not violence
      for (const w of witnesses) {
        const wCtrl = this.agentControllers?.get(w.id) as AgentController | undefined;
        if (wCtrl) {
          const wDossier = (this.agentCognitions?.get(w.id))
            ?.fourStream?.getDossier?.(target.id);
          const wTrustTarget = wDossier?.trust ?? 0;
          if (wTrustTarget < -20) {
            // Witness distrusts the target — this fight looks like justice
            wCtrl.adjustTrust(w, this.agent, +10);
          } else {
            wCtrl.adjustTrust(w, this.agent, -20);
          }
        }
      }
      if (this.cognition.fourStream) {
        void this.cognition.fourStream.updateDossier(target.id, target.config.name, outcome.description, this.cognition.llmProvider).catch((err: unknown) => { console.warn('[Controller] updateDossier failed:', (err as Error).message); });
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

      // Winner takes up to 2 items from loser (loot)
      const looted: string[] = [];
      if (outcome.success && target.inventory && target.inventory.length > 0) {
        const lootCount = Math.min(2, target.inventory.length);
        for (let i = 0; i < lootCount; i++) {
          const item = target.inventory[0];
          target.inventory.splice(0, 1);
          this.agent.inventory.push(item);
          looted.push(item.name);
        }
        if (looted.length > 0) {
          this.broadcaster.agentInventory(this.agent.id, this.agent.inventory);
          this.broadcaster.agentInventory(target.id, target.inventory);
        }
      }

      // PUBLIC: news post
      const lootInfo = looted.length > 0 ? ` ${this.agent.config.name} took ${looted.join(', ')}.` : '';
      const fightPost: BoardPost = {
        id: crypto.randomUUID(),
        authorId: 'system',
        authorName: 'Village News',
        type: 'news',
        channel: 'all',
        content: `${this.agent.config.name} attacked ${target.config.name}! ${outcome.description}${lootInfo}`,
        timestamp: Date.now(),
        day: this.world.time.day,
      };
      this.world.addBoardPost(fightPost);
      this.broadcaster.boardPost(fightPost);
      if (this.bus) this.bus.emit({ type: 'board_post_created', post: fightPost });

      // Consequence concerns
      this.addConsequence(
        `I attacked ${target.config.name}. Others saw. They may turn against me or demand justice.`,
        'threat', [target.id]
      );
      this.addConsequenceToAgent(target.id,
        `${this.agent.config.name} beat me${looted.length ? ' and took my ' + looted.join(', ') : ''}. I need allies or revenge.`,
        'threat', [this.agent.id]
      );
      for (const w of witnesses) {
        this.addConsequenceToAgent(w.id,
          `${this.agent.config.name} attacked ${target.config.name}. Violence is escalating.`,
          'unresolved', [this.agent.id, target.id]
        );
      }

      this.adjustReputation(this.agent.id, -8, 'Violence');

      // Check village rule violations
      const fightRulePosts = this.world.getActiveBoard()
        .filter(p => p.type === 'rule' && p.ruleStatus === 'passed');
      for (const rp of fightRulePosts) {
        const rl = rp.content.toLowerCase();
        if (rl.includes('no fight') || rl.includes('no violen') || rl.includes('no attack')) {
          const vPost: BoardPost = {
            id: crypto.randomUUID(), authorId: 'system',
            authorName: 'Village News', type: 'news',
            channel: 'all',
            content: `RULE VIOLATION: ${this.agent.config.name} broke village rule "${rp.content.slice(0, 60)}"!`,
            timestamp: Date.now(), day: this.world.time.day,
          };
          this.world.addBoardPost(vPost);
          this.broadcaster.boardPost(vPost);
          if (this.bus) this.bus.emit({ type: 'board_post_created', post: vPost });
          this.adjustReputation(this.agent.id, -10, 'Broke village rule');
          break;
        }
      }

      this.broadcaster.agentAction(this.agent.id, 'Attacked ' + target.config.name + '! — "' + shortReason + '"', '⚔️');
      this.lastOutcome = outcome.description + (looted.length > 0 ? ` Took ${looted.join(', ')}.` : '');
      this.lastTrigger = outcome.success
        ? 'You just fought ' + target.config.name + '. You took damage too. Everyone saw.' + (looted.length > 0 ? ' You took their ' + looted.join(', ') + '.' : '')
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

      // Check if target already has a group (one institution per agent)
      const targetGroupId = target.institutionIds?.[0];
      const targetGroup = targetGroupId ? this.world.getInstitution(targetGroupId) : undefined;
      if (targetGroup && !targetGroup.dissolved && myGroup && targetGroup.id !== myGroup.id) {
        this.lastTrigger = `${target.config.name} is already in ${targetGroup.name}. They must leave first.`;
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
        }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });
        const targetCog = this.agentCognitions?.get(target.id);
        if (targetCog) {
          void targetCog.addMemory({
            id: crypto.randomUUID(), agentId: target.id, type: 'observation',
            content: `${this.agent.config.name} invited me to join ${myGroup.name}. I'm now a member.`,
            importance: 7, timestamp: Date.now(), relatedAgentIds: [this.agent.id],
          }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });
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
          void this.cognition.fourStream.updateDossier(target.id, target.config.name, `${target.config.name} joined ${myGroup.name}.`, this.cognition.llmProvider).catch((err: unknown) => { console.warn('[Controller] updateDossier failed:', (err as Error).message); });
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
        } catch (err) {
          console.warn(`[AgentController] Group name LLM failed for ${this.agent.config.name}:`, (err as Error).message);
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
        // One institution per agent — replace, don't push
        this.agent.institutionIds = [group.id];
        target.institutionIds = [group.id];

        void this.cognition.addMemory({
          id: crypto.randomUUID(), agentId: this.agent.id, type: 'action_outcome',
          content: `I founded ${groupName} with ${target.config.name}. ${decision.reason}`,
          importance: 8, timestamp: Date.now(), relatedAgentIds: [target.id],
        }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });
        const targetCog = this.agentCognitions?.get(target.id);
        if (targetCog) {
          void targetCog.addMemory({
            id: crypto.randomUUID(), agentId: target.id, type: 'observation',
            content: `${this.agent.config.name} and I founded ${groupName}. ${decision.reason}`,
            importance: 8, timestamp: Date.now(), relatedAgentIds: [this.agent.id],
          }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });
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
          void this.cognition.fourStream.updateDossier(target.id, target.config.name, `We founded ${groupName} together.`, this.cognition.llmProvider).catch((err: unknown) => { console.warn('[Controller] updateDossier failed:', (err as Error).message); });
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

        // Village collective memory — alliance formed
        this.world.addVillageMemory({
          content: `${this.agent.config.name} and ${target.config.name} founded "${groupName}".`,
          type: 'alliance',
          day: this.world.time.day,
          significance: 6,
        });

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
      }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });

      for (const member of group.members) {
        if (member.agentId === this.agent.id) continue;
        const memberCog = this.agentCognitions?.get(member.agentId);
        if (memberCog) {
          void memberCog.addMemory({
            id: crypto.randomUUID(), agentId: member.agentId, type: 'observation',
            content: `${this.agent.config.name} left ${group.name}.${group.dissolved ? ' The group has dissolved.' : ''}`,
            importance: 8, timestamp: Date.now(), relatedAgentIds: [this.agent.id],
          }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });
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
          `I left ${group.name}.`, this.cognition.llmProvider).catch((err: unknown) => { console.warn('[Controller] updateDossier failed:', (err as Error).message); });
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

      // Village collective memory — betrayal
      this.world.addVillageMemory({
        content: `${this.agent.config.name} left ${group.name}.${group.dissolved ? ' The group dissolved.' : ''}`,
        type: 'betrayal',
        day: this.world.time.day,
        significance: 7,
      });

      this.lastOutcome = `You left ${group.name}.`;
      this.lastTrigger = this.lastOutcome;
      this.state = 'performing'; this.activityTimer = 3;
      this.world.updateAgentState(this.agent.id, 'active', `leaving ${group.name}`);
      this.broadcaster.agentAction(this.agent.id, `left ${group.name} — "${shortReason}"`);
      return;
    }

    // --- Claim Area (goes to village vote) ---
    if (actionId.startsWith('claim_area_')) {
      const claimAreaId = actionId.replace('claim_area_', '');
      const areaName = this.world.getAreaAt(this.agent.position)?.name ?? claimAreaId;
      if (this.world.getPropertyOwner(claimAreaId)) {
        this.lastOutcome = `${areaName} is already owned by someone.`;
        this.lastTrigger = this.lastOutcome;
        this.state = 'performing'; this.activityTimer = 2;
        return;
      }
      const post: BoardPost = {
        id: crypto.randomUUID(), authorId: this.agent.id, authorName: this.agent.config.name,
        type: 'rule' as const, channel: 'all' as const,
        content: `${this.agent.config.name} wants to claim ${areaName} as their property.`,
        timestamp: Date.now(), day: this.world.time.day,
        votes: [] as { agentId: string; vote: 'like' | 'dislike' }[],
        ruleStatus: 'proposed' as const,
        claimTarget: { type: 'area', id: claimAreaId },
      };
      this.world.addBoardPost(post);
      this.broadcaster.boardPost(post);
      if (this.bus) {
        this.bus.emit({ type: 'board_post_created', post });

      }
      void this.cognition.addMemory({ id: crypto.randomUUID(), agentId: this.agent.id, type: 'action_outcome', content: `I proposed claiming ${areaName}. The village will vote.`, importance: 6, timestamp: Date.now(), relatedAgentIds: [] }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });
      this.lastOutcome = `You proposed claiming ${areaName}. The village will vote on it.`;
      this.lastTrigger = this.lastOutcome;
      this.state = 'performing'; this.activityTimer = 3;
      this.world.updateAgentState(this.agent.id, 'active', 'proposing claim');
      this.broadcaster.agentAction(this.agent.id, `proposed claiming ${areaName}`);
      return;
    }

    // --- Claim Building (goes to village vote) ---
    if (actionId.startsWith('claim_') && !actionId.startsWith('claim_area_')) {
      const buildingId = actionId.replace('claim_', '');
      const building = this.world.getBuilding(buildingId);
      if (!building) {
        this.lastOutcome = `That building doesn't exist anymore.`;
        this.lastTrigger = this.lastOutcome;
        this.state = 'performing'; this.activityTimer = 2;
        return;
      }
      if (building.ownerId && building.ownerId !== '') {
        const owner = this.world.getAgent(building.ownerId);
        this.lastOutcome = `${building.name} is already owned by ${owner?.config.name ?? 'someone'}.`;
        this.lastTrigger = this.lastOutcome;
        this.state = 'performing'; this.activityTimer = 2;
        return;
      }
      const post: BoardPost = {
        id: crypto.randomUUID(), authorId: this.agent.id, authorName: this.agent.config.name,
        type: 'rule' as const, channel: 'all' as const,
        content: `${this.agent.config.name} wants to claim ${building.name} (${building.type}).`,
        timestamp: Date.now(), day: this.world.time.day,
        votes: [] as { agentId: string; vote: 'like' | 'dislike' }[],
        ruleStatus: 'proposed' as const,
        claimTarget: { type: 'building', id: buildingId },
      };
      this.world.addBoardPost(post);
      this.broadcaster.boardPost(post);
      if (this.bus) {
        this.bus.emit({ type: 'board_post_created', post });

      }
      void this.cognition.addMemory({ id: crypto.randomUUID(), agentId: this.agent.id, type: 'action_outcome', content: `I proposed claiming ${building.name}. The village will vote.`, importance: 6, timestamp: Date.now(), relatedAgentIds: [] }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });
      this.lastOutcome = `You proposed claiming ${building.name}. The village will vote on it.`;
      this.lastTrigger = this.lastOutcome;
      this.state = 'performing'; this.activityTimer = 3;
      this.world.updateAgentState(this.agent.id, 'active', 'proposing claim');
      this.broadcaster.agentAction(this.agent.id, `proposed claiming ${building.name}`);
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
        void this.cognition.addMemory({ id: crypto.randomUUID(), agentId: witness.id, type: 'observation', content: `${this.agent.config.name} publicly accused ${accused?.config.name ?? 'someone'}: "${accusation.slice(0, 80)}"`, importance: 7, timestamp: Date.now(), relatedAgentIds: [this.agent.id, ...(accused ? [accused.id] : [])] }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });
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
        this.adjustReputation(accused.id, -3, 'Publicly accused');
        this.adjustReputation(this.agent.id, -2, 'Made accusation');

        const accusedCog = this.agentCognitions?.get(accused.id);
        if (accusedCog?.fourStream) {
          accusedCog.fourStream.addConcern({
            id: crypto.randomUUID(),
            content: `${this.agent.config.name} publicly accused me: "${accusation.slice(0, 40)}". My reputation is at stake.`,
            category: 'threat',
            relatedAgentIds: [this.agent.id],
            createdAt: this.world.time.totalMinutes,
          });
        }
        if (this.cognition.fourStream) {
          this.cognition.fourStream.addConcern({
            id: crypto.randomUUID(),
            content: `I accused ${accused.config.name}. Must back it up or lose credibility.`,
            category: 'commitment',
            relatedAgentIds: [accused.id],
            createdAt: this.world.time.totalMinutes,
            expiresAt: this.world.time.totalMinutes + (24 * 60),
          });
        }
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
        const inv = this.agent.inventory;
        const invStr = inv.length ? inv.map(i => i.name).join(', ') : 'EMPTY';
        const foodCount = inv.filter(i => i.type === 'food').length;
        const realityBlock = `REALITY (verified by game engine):\nYour inventory: ${invStr}\nTotal food you have: ${foodCount}\nDo not claim to have items not listed here.`;
        const postPrompt = `${identity}

${realityBlock}

You are writing a PUBLIC message on the village board for everyone to read.

Your motivation: ${decision.reason}

Write what you would ACTUALLY PIN on the board — a short, concrete message directed at the village. NOT your inner thoughts or feelings. What would you write on a notice board for others to read?

Examples of good posts: "Looking for someone to trade wheat for fish." / "Meeting at the plaza tomorrow morning." / "Stay away from the forest at night."

1-2 sentences max. Write ONLY the message.`;
        content = await this.cognition.llmProvider.complete(
          `You are ${this.agent.config.name}. Write ONLY a short public notice (1-2 sentences). No inner monologue. No quotes around it.`,
          postPrompt,
        );
        content = content.replace(/^["']|["']$/g, '').trim();
        content = this.ensureCompleteSentence(content);
        if (content.length < 3 || content.length > 300) {
          console.warn(`[PostBoard] ${this.agent.config.name} content length out of range (${content.length}), using reason`);
          content = this.truncateAtSentence(decision.reason, 200);
        }
      } catch (err) {
        console.error(`[PostBoard] ${this.agent.config.name} LLM call failed:`, err);
        content = this.truncateAtSentence(decision.reason, 200);
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
      void this.cognition.addMemory({ id: crypto.randomUUID(), agentId: this.agent.id, type: 'action_outcome', content: `I posted on the village board: "${content.slice(0, 80)}"`, importance: 4, timestamp: Date.now(), relatedAgentIds: [] }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });
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
        content = this.ensureCompleteSentence(content);
        if (content.length < 3 || content.length > 300) {
          console.warn(`[PostGroup] ${this.agent.config.name} content length out of range (${content.length}), using reason`);
          content = this.truncateAtSentence(decision.reason, 200);
        }
      } catch (err) {
        console.error(`[PostGroup] ${this.agent.config.name} LLM call failed:`, err);
        content = this.truncateAtSentence(decision.reason, 200);
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
        const cog = this.agentCognitions?.get(member.agentId);
        if (cog) {
          void cog.addMemory({
            id: crypto.randomUUID(),
            agentId: member.agentId,
            type: 'observation',
            content: `${this.agent.config.name} posted in ${group.name}: "${content.slice(0, 60)}"`,
            importance: 5,
            timestamp: Date.now(),
            relatedAgentIds: [this.agent.id],
          }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });
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
      }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });

      this.lastOutcome = `You posted in ${group.name}.`;
      this.lastTrigger = this.lastOutcome;
      this.state = 'performing'; this.activityTimer = 3;
      this.world.updateAgentState(this.agent.id, 'active', `posting in ${group.name}`);
      this.broadcaster.agentAction(this.agent.id, `posted in ${group.name} — "${shortReason}"`);
      return;
    }

    // --- Call Meeting ---
    if (actionId === 'call_meeting') {
      const nearbyAll = this.world.getNearbyAgents(this.agent.position, 5)
        .filter(a => a.id !== this.agent.id && a.alive !== false);

      if (nearbyAll.length === 0) {
        this.lastTrigger = 'Nobody was around to meet with.';
        this.state = 'idle'; this.idleTimer = 0; return;
      }

      const meetingTopic = decision.reason || 'something important';
      const names = nearbyAll.map(a => a.config.name).join(', ');

      // Start actual conversations with nearby agents (turns meeting into real dialogue)
      if (this.soloActionExecutor) {
        const maxConversations = Math.min(2, nearbyAll.length);
        for (let i = 0; i < maxConversations; i++) {
          this.soloActionExecutor.requestConversation(this.agent.id, nearbyAll[i].id);
        }
      }

      // Caller gets memory
      void this.cognition.addMemory({
        id: crypto.randomUUID(), agentId: this.agent.id,
        type: 'action_outcome',
        content: `I called a meeting about: ${meetingTopic}. ${names} were present.`,
        importance: 6, timestamp: Date.now(),
        relatedAgentIds: nearbyAll.map(a => a.id),
      }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });

      // All nearby agents get notified and forced to react
      for (const a of nearbyAll) {
        const cog = this.agentCognitions?.get(a.id);
        if (cog) {
          void cog.addMemory({
            id: crypto.randomUUID(), agentId: a.id,
            type: 'observation',
            content: `${this.agent.config.name} called a meeting about: "${meetingTopic}". ${names} are here.`,
            importance: 6, timestamp: Date.now(),
            relatedAgentIds: [this.agent.id],
          }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });
        }
        const ctrl = this.agentControllers?.get(a.id) as AgentController | undefined;
        if (ctrl) {
          ctrl.lastTrigger = `${this.agent.config.name} called a meeting: "${meetingTopic}". Respond to their topic.`;
          ctrl.idleTimer = 7;
        }
      }

      // PUBLIC: news post so whole village knows
      const meetingPost: BoardPost = {
        id: crypto.randomUUID(), authorId: 'system',
        authorName: 'Village News', type: 'news',
        channel: 'all',
        content: `${this.agent.config.name} called a meeting about "${meetingTopic}" with ${names}.`,
        timestamp: Date.now(), day: this.world.time.day,
      };
      this.world.addBoardPost(meetingPost);
      this.broadcaster.boardPost(meetingPost);
      if (this.bus) this.bus.emit({ type: 'board_post_created', post: meetingPost });

      // Meeting caller gets follow-up commitment
      if (this.cognition.fourStream) {
        this.cognition.fourStream.addConcern({
          id: crypto.randomUUID(),
          content: `I called a meeting about: "${meetingTopic.slice(0, 40)}". Follow up with attendees.`,
          category: 'commitment',
          relatedAgentIds: nearbyAll.map(a => a.id),
          createdAt: this.world.time.totalMinutes,
          expiresAt: this.world.time.totalMinutes + (24 * 60),
        });
      }

      this.lastOutcome = `You called a meeting. Speaking with ${names}.`;
      this.lastTrigger = this.lastOutcome;
      this.state = 'performing'; this.activityTimer = 3;
      this.world.updateAgentState(this.agent.id, 'active', 'leading meeting');
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
        ruleContent = this.ensureCompleteSentence(ruleContent);
        if (ruleContent.length < 3 || ruleContent.length > 300) {
          console.warn(`[ProposeRule] ${this.agent.config.name} content length out of range (${ruleContent.length}), using reason`);
          ruleContent = this.truncateAtSentence(decision.reason, 200);
        }
      } catch (err) {
        console.error(`[ProposeRule] ${this.agent.config.name} LLM call failed:`, err);
        ruleContent = this.truncateAtSentence(decision.reason, 200);
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
      if (this.bus) {
        this.bus.emit({ type: 'board_post_created', post });

      }

      // All agents get a memory about the proposed rule
      for (const [id, agent] of this.world.agents) {
        if (id === this.agent.id || agent.alive === false) continue;
        const cog = this.agentCognitions?.get(id);
        if (cog) {
          void cog.addMemory({
            id: crypto.randomUUID(),
            agentId: id,
            type: 'observation',
            content: `${this.agent.config.name} proposed a rule: "${ruleContent}"`,
            importance: 7,
            timestamp: Date.now(),
            relatedAgentIds: [this.agent.id],
          }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });
        }
      }

      void this.cognition.addMemory({ id: crypto.randomUUID(), agentId: this.agent.id, type: 'action_outcome', content: `I proposed a rule: "${ruleContent.slice(0, 80)}"`, importance: 6, timestamp: Date.now(), relatedAgentIds: [] }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });
      this.lastOutcome = `You proposed a rule for the village.`;
      this.lastTrigger = this.lastOutcome;
      this.state = 'performing'; this.activityTimer = 3;
      this.world.updateAgentState(this.agent.id, 'active', 'proposing rule');
      this.broadcaster.agentAction(this.agent.id, `proposed a village rule — "${shortReason}"`);
      return;
    }

    // --- Propose Group Rule (leaders set rules directly, no vote) ---
    if (actionId === 'propose_group_rule') {
      const groupId = this.agent.institutionIds?.[0];
      const group = groupId ? this.world.getInstitution(groupId) : undefined;
      if (!group || group.dissolved) {
        this.lastTrigger = 'You have no group.';
        this.state = 'idle'; this.idleTimer = 0; return;
      }

      let ruleContent: string;
      try {
        ruleContent = await this.cognition.llmProvider.complete(
          `Write only the rule. No preamble, no quotes. 1 sentence.`,
          `${this.cognition.identityBlock}\n\nYou are setting a rule for ${group.name}. Reason: ${decision.reason}\n\nWrite the RULE that members must follow. Keep to 1 sentence.`
        );
        ruleContent = ruleContent.replace(/^["']|["']$/g, '').trim();
        if (ruleContent.length < 3 || ruleContent.length > 200) {
          ruleContent = decision.reason.slice(0, 150);
        }
      } catch (err) {
        console.warn(`[AgentController] Rule content LLM failed for ${this.agent.config.name}:`, (err as Error).message);
        ruleContent = decision.reason.slice(0, 150);
      }

      if (!group.rules) group.rules = [];
      group.rules.push(ruleContent);

      // Notify all members with memory + permanent concern
      for (const member of group.members) {
        const cog = this.agentCognitions?.get(member.agentId);
        if (cog) {
          void cog.addMemory({
            id: crypto.randomUUID(), agentId: member.agentId,
            type: 'observation',
            content: `${this.agent.config.name} set a rule for ${group.name}: "${ruleContent}"`,
            importance: 7, timestamp: Date.now(),
            relatedAgentIds: [this.agent.id],
          }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });
          cog.fourStream?.addConcern({
            id: crypto.randomUUID(),
            content: `${group.name} rule: ${ruleContent}`,
            category: 'rule' as any,
            relatedAgentIds: group.members.map((m: any) => m.agentId),
            createdAt: this.world.time.totalMinutes,
            permanent: true,
          });
        }
      }

      const rulePost: BoardPost = {
        id: crypto.randomUUID(), authorId: 'system',
        authorName: 'Village News', type: 'news',
        channel: 'all',
        content: `${this.agent.config.name} set a rule for ${group.name}: "${ruleContent}"`,
        timestamp: Date.now(), day: this.world.time.day,
      };
      this.world.addBoardPost(rulePost);
      this.broadcaster.boardPost(rulePost);
      if (this.bus) this.bus.emit({ type: 'board_post_created', post: rulePost });

      this.lastOutcome = `You set a rule for ${group.name}.`;
      this.lastTrigger = this.lastOutcome;
      this.state = 'performing'; this.activityTimer = 3;
      this.broadcaster.agentAction(this.agent.id, `set a ${group.name} rule`);
      return;
    }

    // --- Kick member from group ---
    if (actionId.startsWith('kick_')) {
      const firstName = actionId.replace('kick_', '');
      const groupId = this.agent.institutionIds?.[0];
      const group = groupId ? this.world.getInstitution(groupId) : undefined;
      if (!group) {
        this.lastTrigger = 'You have no group.';
        this.state = 'idle'; this.idleTimer = 0; return;
      }

      const myRole = group.members.find(m => m.agentId === this.agent.id)?.role;
      if (myRole !== 'founder' && myRole !== 'leader') {
        this.lastTrigger = 'Only leaders can kick members.';
        this.state = 'idle'; this.idleTimer = 0; return;
      }

      const targetMember = group.members.find(m => {
        const a = this.world.getAgent(m.agentId);
        return a && a.config.name.split(' ')[0].toLowerCase() === firstName.toLowerCase();
      });
      if (!targetMember || targetMember.role === 'founder') {
        this.lastTrigger = 'Can\'t kick that person.';
        this.state = 'idle'; this.idleTimer = 0; return;
      }

      const targetAgent = this.world.getAgent(targetMember.agentId);
      const targetName = targetAgent?.config.name ?? firstName;

      // Remove from group
      group.members = group.members.filter(m => m.agentId !== targetMember.agentId);
      if (targetAgent?.institutionIds) {
        targetAgent.institutionIds = targetAgent.institutionIds.filter(id => id !== group.id);
      }

      // Memories
      void this.cognition.addMemory({
        id: crypto.randomUUID(), agentId: this.agent.id,
        type: 'action_outcome',
        content: `I kicked ${targetName} out of ${group.name}.`,
        importance: 8, timestamp: Date.now(),
        relatedAgentIds: [targetMember.agentId],
      }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });
      const targetCog = this.agentCognitions?.get(targetMember.agentId);
      if (targetCog) {
        void targetCog.addMemory({
          id: crypto.randomUUID(), agentId: targetMember.agentId,
          type: 'observation',
          content: `${this.agent.config.name} kicked me out of ${group.name}!`,
          importance: 9, timestamp: Date.now(),
          relatedAgentIds: [this.agent.id],
        }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });
        targetCog.fourStream?.addConcern({
          id: crypto.randomUUID(),
          content: `I was expelled from ${group.name} by ${this.agent.config.name}. I need a new group or revenge.`,
          category: 'threat',
          relatedAgentIds: [this.agent.id],
          createdAt: this.world.time.totalMinutes,
        });
      }

      // Trust impact
      if (targetAgent) {
        this.adjustTrust(this.agent, targetAgent, -30);
        this.adjustTrust(targetAgent, this.agent, -40);
      }

      const kickPost: BoardPost = {
        id: crypto.randomUUID(), authorId: 'system',
        authorName: 'Village News', type: 'news',
        channel: 'all',
        content: `${targetName} was expelled from ${group.name} by ${this.agent.config.name}.`,
        timestamp: Date.now(), day: this.world.time.day,
      };
      this.world.addBoardPost(kickPost);
      this.broadcaster.boardPost(kickPost);
      if (this.bus) this.bus.emit({ type: 'board_post_created', post: kickPost });

      this.adjustReputation(targetMember.agentId, -5, 'Expelled from group');
      this.broadcaster.institutionUpdate(group);

      this.lastOutcome = `You kicked ${targetName} from ${group.name}.`;
      this.lastTrigger = this.lastOutcome;
      this.state = 'performing'; this.activityTimer = 3;
      this.broadcaster.agentAction(this.agent.id, `kicked ${targetName} from ${group.name}`);
      return;
    }

    // --- Rest ---
    if (actionId === 'rest') {
      this.state = 'performing';
      this.currentPerformingActivity = 'resting';
      // Rest longer when more exhausted — 20 ticks base, up to 60 when nearly depleted
      const energy = this.agent.vitals?.energy ?? 50;
      this.activityTimer = energy < 20 ? 60 : energy < 40 ? 40 : 20;
      this.world.updateAgentState(this.agent.id, 'active', 'resting');
      void this.cognition.addMemory({ id: crypto.randomUUID(), agentId: this.agent.id, type: 'action_outcome', content: `I rested to recover energy.`, importance: 2, timestamp: Date.now(), relatedAgentIds: [] }).catch((err: unknown) => { console.warn('[Controller] addMemory failed:', (err as Error).message); });
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

    // Wait for pending dossier updates to finish — stale reads cause disconnected behavior
    if (this.cognition.fourStream?.hasPendingDossierUpdates?.()) return;

    this.decidingInProgress = true;

    try {
      const situation = this.buildSituation(this.lastTrigger, this.lastOutcome);
      this.lastOutcome = undefined;

      // Check if any obligations should be surfaced as the trigger
      const obligationPrompt = this.checkObligations(situation);
      if (obligationPrompt && obligationPrompt !== this.lastObligationText) {
        situation.trigger = obligationPrompt;
        this.lastObligationText = obligationPrompt;
        this.obligationCooldown = 5; // Don't repeat same obligation for 5 ticks
        console.log(`[Obligation] ${this.agent.config.name}: ${obligationPrompt.slice(0, 100)}`);
      }

      const decision = await this.cognition.decide(situation);
      this.handleApiSuccess();
      console.log(`[Decision] ${this.agent.config.name} → ${decision.actionId} | ${decision.reason.slice(0, 120)}`);

      // Guard: agent may have entered a conversation while awaiting LLM
      if (this.state === 'conversing') return;

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

  /** If text doesn't end with sentence-ending punctuation, cut to last complete sentence */
  private ensureCompleteSentence(text: string): string {
    const trimmed = text.trim();
    if (/[.!?]$/.test(trimmed)) return trimmed;
    // Find last sentence boundary
    const lastEnd = Math.max(trimmed.lastIndexOf('. '), trimmed.lastIndexOf('! '), trimmed.lastIndexOf('? '));
    if (lastEnd > trimmed.length * 0.3) return trimmed.slice(0, lastEnd + 1).trim();
    // No sentence boundary — just add a period
    return trimmed + '.';
  }

  /** Truncate text at the last complete sentence within maxLen */
  private truncateAtSentence(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    const cut = text.slice(0, maxLen);
    // Find last sentence-ending punctuation
    const lastPeriod = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    if (lastPeriod > maxLen * 0.3) return cut.slice(0, lastPeriod + 1).trim();
    // Fallback: cut at last space
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > maxLen * 0.3) return cut.slice(0, lastSpace).trim() + '...';
    return cut.trim() + '...';
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
