import type { Agent, DriveState, GameTime, Mood, Position, ThinkOutput, VitalState } from '@ai-village/shared';
import { AgentCognition, SEASONS, SEASON_ORDER, SEASON_LENGTH, BUILDINGS } from '@ai-village/ai-engine';
import { getAreaEntrance, getRandomPositionInArea, getAreaAt, getWalkable, MAP_HEIGHT, MAP_WIDTH } from '../map/village.js';
import { findPath } from './pathfinding.js';
import type { World } from './world.js';
import type { EventBroadcaster } from './events.js';

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
  | 'idle';

export class AgentController {
  state: ControllerState = 'idle';
  agent: Agent;
  cognition: AgentCognition;
  intentions: string[] = [];
  currentIntentionIndex: number = 0;
  path: Position[] = [];
  pathIndex: number = 0;
  activityTimer: number = 0;
  idleTimer: number = 0;
  private planningInProgress: boolean = false;
  private reflectingInProgress: boolean = false;
  private currentAreaId: string | null = null; // track where the agent is performing
  conversationCooldown: number = 0; // ticks remaining before agent can converse again
  private lastSoloActionTick: number = 0;
  pendingConversationTarget: string | null = null;
  private consecutiveApiFailures: number = 0;
  apiExhausted: boolean = false;
  private lastReplanTick: number = 0;
  private currentPerformingActivity: string = '';
  onDeath?: (agentId: string, cause: string) => void;
  private thinkInProgress: boolean = false;
  private lastHungerBand: number = 0;
  private lastEnergyBand: number = 0;
  private lastHealthBand: number = 0;
  public lastOutcomeDescription: string = '';

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
    if (this.consecutiveApiFailures >= 3 && !this.apiExhausted) {
      this.apiExhausted = true;
      console.log(`[Agent] ${this.agent.config.name} API EXHAUSTED after ${this.consecutiveApiFailures} consecutive failures — agent stopped`);
      this.broadcaster.agentAction(this.agent.id, 'API exhausted — update key to resume', '\u26A0\uFE0F');
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
      const dest = this.pendingActivity?.areaId ?? 'somewhere';
      const act = this.pendingActivity?.activity ? this.shortActivity(this.pendingActivity.activity) : 'do something';
      content = `I'm heading to ${dest} to ${act}.`;
    } else if (to === 'performing') {
      content = `I started ${this.shortActivity(this.currentPerformingActivity)} at ${location}.`;
    } else if (to === 'idle' && from === 'performing') {
      return; // handled directly in thinkAfterOutcome's goIdle where activity is available
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

    // Vitals decay every tick (1 game minute)
    this.tickVitals();

    // Recalculate drives every 60 ticks (~1 game hour)
    if (this.world.time.minute === 0) {
      this.recalculateDrives();
      this.checkLedgerExpiry();
    }

    if (this.conversationCooldown > 0) this.conversationCooldown--;

    // Universal sleep check — fires regardless of current state
    if (this.state !== 'sleeping' && this.state !== 'reflecting' && this.state !== 'waking') {
      if (this.shouldSleep(time)) {
        void this.doReflect();
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
        this.advanceMovement();
        break;
      }

      case 'performing': {
        this.activityTimer--;
        if (this.activityTimer <= 0) {
          // Think about what just happened before going idle
          void this.thinkAfterOutcome();
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

      case 'idle': {
        this.idleTimer++;
        if (this.idleTimer >= 30) {
          this.idleTimer = 0;
          const allIntentionsDone = this.currentIntentionIndex >= this.intentions.length;
          if ((this.intentions.length === 0 || allIntentionsDone) && !this.planningInProgress) {
            // No plan or exhausted all intentions — replan
            void this.doPlan(time);
          } else if (!this.thinkInProgress) {
            // Think before acting — let the agent decide whether to follow the plan
            void this.thinkThenAct();
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
    console.log(`[Agent] ${this.agent.config.name} wakes up`);

    // Think on waking — assess situation before planning
    if (!this.apiExhausted) {
      try {
        const area = getAreaAt(this.agent.position);
        const v = this.agent.vitals;
        const vitalsNote = v ? `Health: ${Math.round(v.health)}, Hunger: ${Math.round(v.hunger)}, Energy: ${Math.round(v.energy)}.` : '';
        const output = await this.cognition.think(
          `You just woke up at the ${area?.name ?? 'village'}. It's morning on day ${this.world.time.day}. You slept here last night.`,
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

      const ledgerCtx = this.buildLedgerContext();
      const worldCtx = (institutionContext + buildingContext + seasonContext + ledgerCtx) || undefined;
      const plan = await this.cognition.plan({ day: time.day, hour: time.hour }, boardContext, worldCtx);
      this.intentions = plan;
      this.currentIntentionIndex = 0;
      console.log(
        `[Agent] ${this.agent.config.name} planned ${plan.length} intentions`,
      );
      this.handleApiSuccess();
      this.followNextIntention();
    } catch (err) {
      console.error(`[Agent] ${this.agent.config.name} failed to plan day:`, (err as Error).message || err);
      this.handleApiFailure(err);
      this.state = 'idle';
    } finally {
      this.planningInProgress = false;
    }
  }

  followNextIntention(): void {
    if (this.currentIntentionIndex >= this.intentions.length) {
      this.state = 'idle';
      this.world.updateAgentState(this.agent.id, 'idle', '');
      return;
    }

    const intention = this.intentions[this.currentIntentionIndex];
    this.currentIntentionIndex++;

    // Check if intention mentions talking to a specific agent
    let talkTargetAgent: Agent | null = null;
    const talkMatch = intention.match(/(?:talk|speak|meet|find|converse|visit|see)\s+(?:to|with)?\s*(\w+)/i);
    if (talkMatch) {
      const targetName = talkMatch[1];
      for (const agent of this.world.agents.values()) {
        if (agent.id !== this.agent.id &&
            agent.config.name.toLowerCase().includes(targetName.toLowerCase())) {
          this.pendingConversationTarget = agent.id;
          talkTargetAgent = agent;
          break;
        }
      }
    }

    // Path toward target agent's actual position for talk intentions,
    // otherwise infer location from intention text
    const areaId = this.resolveLocation(intention);
    const targetPos = talkTargetAgent
      ? { ...talkTargetAgent.position }
      : getRandomPositionInArea(areaId);

    console.log(`[Agent] ${this.agent.config.name} → ${intention}`);

    const dist = Math.abs(this.agent.position.x - targetPos.x) + Math.abs(this.agent.position.y - targetPos.y);
    if (dist <= 1) {
      this.startPerforming(intention, 60, areaId);
    } else {
      this.pendingActivity = { activity: intention, duration: 60, areaId };
      this.startMoveTo(targetPos);
    }

    this.broadcaster.agentAction(this.agent.id, intention);
  }

  private pendingActivity: { activity: string; duration: number; areaId: string } | null = null;

  startMoveTo(target: Position): void {
    const path = findPath(this.agent.position, target, getWalkable, MAP_WIDTH, MAP_HEIGHT);

    if (path.length <= 1) {
      // Already there or no path found
      if (this.pendingActivity) {
        this.startPerforming(this.pendingActivity.activity, this.pendingActivity.duration, this.pendingActivity.areaId);
        this.pendingActivity = null;
      } else {
        this.state = 'idle';
      }
      return;
    }

    this.path = path;
    this.pathIndex = 1; // Skip start position (already there)
    this.state = 'moving';
    this.world.updateAgentState(this.agent.id, 'routine', this.pendingActivity?.activity || '');
  }

  private advanceMovement(): void {
    if (this.pathIndex >= this.path.length) {
      // Arrived at destination
      if (this.pendingActivity) {
        this.startPerforming(this.pendingActivity.activity, this.pendingActivity.duration, this.pendingActivity.areaId);
        this.pendingActivity = null;
      } else {
        this.state = 'idle';
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

  startPerforming(activity: string, duration: number, areaId?: string): void {
    // Guard: don't start performing if we entered a conversation during movement
    if (this.state === 'conversing') return;

    // Attempt intentional conversation before doing anything else
    if (this.pendingConversationTarget && this.soloActionExecutor) {
      const started = this.soloActionExecutor.requestConversation(this.agent.id, this.pendingConversationTarget);
      if (started) {
        this.pendingConversationTarget = null;
        return; // Controller is now in 'conversing' state
      }
      // Target not available — proceed with activity, try again later
    }
    this.pendingConversationTarget = null;

    this.state = 'performing';
    this.currentPerformingActivity = activity;
    this.world.updateAgentState(this.agent.id, 'active', activity);
    this.currentAreaId = areaId ?? getAreaAt(this.agent.position)?.id ?? null;

    // Auto-drop lowest-value non-food item when inventory is full
    if (this.agent.inventory.length >= 30) {
      const droppable = this.agent.inventory
        .filter(i => i.type !== 'food')
        .sort((a, b) => a.value - b.value);
      if (droppable.length > 0) {
        const dropped = droppable[0];
        this.world.removeItem(dropped.id);
        this.broadcaster.agentAction(this.agent.id, `dropped ${dropped.name} (inventory full)`, '\u{1F5D1}\uFE0F');
        this.broadcaster.agentInventory(this.agent.id, this.agent.inventory);
        console.log(`[Agent] ${this.agent.config.name} auto-dropped ${dropped.name} — inventory was full`);
      }
    }

    // Route ALL activities through the action executor — no keyword filtering
    if (this.soloActionExecutor) {
      void this.soloActionExecutor.executeSocialAction(
        this.agent.id, this.agent.config.name, '', activity, this.cognition
      );
    }

    // Brief pause then move on
    this.activityTimer = 30;

    // Think is now handled by thinkThenAct (before) and thinkAfterOutcome (after)

    console.log(
      `[Agent] ${this.agent.config.name} starts: ${activity} (${duration} min)`,
    );
  }

  /**
   * Enter conversing state (called externally by ConversationManager).
   */
  enterConversation(): void {
    // Stop any movement and cancel pending activity — agent halts to talk
    this.path = [];
    this.pathIndex = 0;
    this.pendingActivity = null;
    this.activityTimer = 0;
    this.currentPerformingActivity = '';
    this.state = 'conversing';
    this.world.updateAgentState(this.agent.id, 'active', 'conversing');

    // Agenda comes from think() output — no separate LLM call needed
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
      this.world.updateAgentState(this.agent.id, 'idle', '');

      // Think after conversation — process what was discussed (immediate, bypasses cooldown)
      const area = getAreaAt(this.agent.position);
      void this.thinkOnEvent(
        'You just finished a conversation.',
        `Location: ${area?.name ?? 'unknown'}. Time: hour ${this.world.time.hour}.`
      );

      // After a conversation, replan the rest of the day based on new memories
      // This allows agents to react to what was said (e.g. "meet me at the market")
      void this.replanAfterConversation();
    }
  }

  /**
   * Think before acting — the agent considers the next intention and decides what to actually do.
   * This is the core of the think-act-learn loop: plan sets intentions, think decides actions.
   */
  private async thinkThenAct(): Promise<void> {
    if (this.thinkInProgress || this.apiExhausted) return;

    const intention = this.intentions[this.currentIntentionIndex];
    if (!intention) {
      this.followNextIntention();
      return;
    }

    // 60 game-minute cooldown between regular thinks — stay idle if not met
    const ticksSinceLast = this.world.time.totalMinutes - this.lastSoloActionTick;
    if (ticksSinceLast < 60) {
      return; // Wait for cooldown instead of burning through intentions
    }

    this.thinkInProgress = true;
    this.lastSoloActionTick = this.world.time.totalMinutes;

    try {
      const area = getAreaAt(this.agent.position);
      const nearby = this.world.getNearbyAgents(this.agent.position, 5)
        .filter(a => a.id !== this.agent.id && a.alive !== false);
      const nearbyNames = nearby.map(a => a.config.name).join(', ');

      const seasonIdx = Math.floor((this.world.time.day - 1) / SEASON_LENGTH) % SEASON_ORDER.length;
      const currentSeason = SEASON_ORDER[seasonIdx];

      const ledgerCtx = this.buildLedgerContext();
      const output = await this.cognition.think(
        `You're about to: ${intention}`,
        `Location: ${area?.name ?? 'unknown'}. Time: hour ${this.world.time.hour}. Season: ${currentSeason}.${nearbyNames ? ` Nearby: ${nearbyNames}.` : ''}${ledgerCtx}`
      );
      this.handleApiSuccess();

      // Guard: agent may have entered a conversation while we were awaiting the LLM
      if (this.state === 'conversing') return;

      if (output.mood) {
        this.agent.mood = output.mood;
        this.broadcaster.agentMood(this.agent.id, output.mood);
      }
      this.broadcaster.agentThought(this.agent.id, output.thought);

      if (output.actions && output.actions.length > 0) {
        // think() produced specific actions — replace current intention and route through
        // followNextIntention so the agent properly moves to the right location.
        this.intentions.splice(this.currentIntentionIndex, 1, ...output.actions);
        console.log(`[Agent] ${this.agent.config.name} thinkThenAct replaced intention with: ${output.actions.join(', ')}`);
        this.followNextIntention();
      } else {
        // No specific action from think — follow intention as planned
        this.followNextIntention();
      }
    } catch (err) {
      this.handleApiFailure(err);
      this.followNextIntention();
    } finally {
      this.thinkInProgress = false;
    }
  }

  /**
   * Think after an action completes — process the outcome, update mood, decide next steps.
   */
  private async thinkAfterOutcome(): Promise<void> {
    const activity = this.currentPerformingActivity;
    this.currentPerformingActivity = '';

    const goIdle = () => {
      // Log finish-transition here where we still have the activity variable
      if (activity) {
        const area = getAreaAt(this.agent.position);
        const location = area?.name ?? 'the village';
        void this.cognition.addMemory({
          id: crypto.randomUUID(),
          agentId: this.agent.id,
          type: 'observation',
          content: `I finished ${this.shortActivity(activity)} at ${location}.`,
          importance: 2,
          timestamp: Date.now(),
          relatedAgentIds: [],
        });
      }
      this.state = 'idle';
      this.idleTimer = 0;
      const nextIdx = this.currentIntentionIndex;
      const nextIntention = nextIdx < this.intentions.length ? this.intentions[nextIdx] : null;
      this.world.updateAgentState(this.agent.id, 'idle', nextIntention || '');
    };

    // Micro-log: record factual outcome as memory even when think is skipped due to cooldown
    if (activity && this.lastOutcomeDescription) {
      // Clean raw system prefixes into natural agent memory
      let outcomeContent = this.lastOutcomeDescription
        .replace(/^SUCCESS:\s*/i, '')
        .replace(/^FAILED:\s*/i, 'Failed: ')
        .replace(/\s*NEXT STEP:.*$/i, '');
      if (outcomeContent.length > 0) {
        void this.cognition.addMemory({
          id: crypto.randomUUID(),
          agentId: this.agent.id,
          type: 'observation',
          content: outcomeContent,
          importance: 3,
          timestamp: Date.now(),
          relatedAgentIds: [],
        });
      }
    }

    if (this.apiExhausted || !this.soloActionExecutor || !activity) {
      goIdle();
      return;
    }

    // 60 game-minute cooldown
    const ticksSinceLast = this.world.time.totalMinutes - this.lastSoloActionTick;
    if (ticksSinceLast < 60) {
      goIdle();
      return;
    }

    this.lastSoloActionTick = this.world.time.totalMinutes;

    try {
      const area = getAreaAt(this.agent.position);

      // Season for context
      const seasonIdx = Math.floor((this.world.time.day - 1) / SEASON_LENGTH) % SEASON_ORDER.length;
      const currentSeason = SEASON_ORDER[seasonIdx];

      // Inventory snapshot
      const invItems = this.agent.inventory.length > 0
        ? this.agent.inventory.reduce((acc, item) => {
            acc[item.name] = (acc[item.name] || 0) + 1;
            return acc;
          }, {} as Record<string, number>)
        : {};
      const invStr = Object.keys(invItems).length > 0
        ? Object.entries(invItems).map(([name, qty]) => `${name} ×${qty}`).join(', ')
        : 'nothing';

      // Use direct outcome if available, fall back to generic
      const trigger = this.lastOutcomeDescription
        ? `You just tried: ${activity}. Result: ${this.lastOutcomeDescription}`
        : `You just finished: ${activity}.`;
      this.lastOutcomeDescription = '';

      // Check if this activity fulfills any social commitments
      this.checkLedgerFulfillment(activity);

      const ledgerCtx = this.buildLedgerContext();
      const output = await this.cognition.think(
        trigger,
        `Location: ${area?.name ?? 'unknown'}. Time: hour ${this.world.time.hour}. Season: ${currentSeason}. Inventory: ${invStr}.${ledgerCtx}`
      );
      this.handleApiSuccess();

      // Guard: agent may have entered a conversation while we were awaiting the LLM
      if (this.state === 'conversing') return;

      if (output.mood) {
        this.agent.mood = output.mood;
        this.broadcaster.agentMood(this.agent.id, output.mood);
      }
      this.broadcaster.agentThought(this.agent.id, output.thought);

      if (output.actions && output.actions.length > 0) {
        // Insert actions as new intentions so the agent properly moves to the right location.
        // Firing in-place fails when the action needs a different area (e.g. "gather mushrooms" while at park).
        this.intentions.splice(this.currentIntentionIndex, 0, ...output.actions);
        console.log(`[Agent] ${this.agent.config.name} thinkAfterOutcome inserted ${output.actions.length} new intentions: ${output.actions.join(', ')}`);
        this.state = 'idle';
        this.idleTimer = 25; // trigger followNextIntention quickly
        return;
      }
    } catch (err) {
      this.handleApiFailure(err);
    }

    goIdle();
  }

  /**
   * Event-driven think — immediate, bypasses the 60-minute cooldown.
   * Used for: witnessing events, vital threshold crossings, conversation endings.
   */
  async thinkOnEvent(trigger: string, context: string): Promise<void> {
    if (this.apiExhausted || this.state === 'sleeping' || this.state === 'conversing') return;

    try {
      const output = await this.cognition.think(trigger, context);
      this.handleApiSuccess();

      // Guard: agent may have entered a conversation while we were awaiting the LLM
      // (TypeScript narrows state above but can't see that `await` allows state mutation)
      if ((this.state as ControllerState) === 'conversing') return;

      if (output.mood) {
        this.agent.mood = output.mood;
        this.broadcaster.agentMood(this.agent.id, output.mood);
      }
      this.broadcaster.agentThought(this.agent.id, output.thought);

      if (output.actions && this.soloActionExecutor) {
        for (const action of output.actions) {
          this.soloActionExecutor.executeSocialAction(
            this.agent.id, this.agent.config.name, '', action, this.cognition
          );
        }
      }
    } catch (err) {
      this.handleApiFailure(err);
    }
  }

  /**
   * Replan remaining activities after a conversation.
   * The LLM sees recent memories (including the conversation that just ended)
   * and generates new plan items for the rest of the day.
   * Falls back to following the existing plan if replanning fails.
   */
  private async replanAfterConversation(): Promise<void> {
    if (this.planningInProgress || this.apiExhausted) {
      // Already planning or API dead — let idle timer handle next intention
      return;
    }

    // Cooldown: don't replan more than once per 600 ticks (~50s real time)
    const ticksSinceReplan = this.world.time.totalMinutes - this.lastReplanTick;
    if (ticksSinceReplan < 600) return;

    this.planningInProgress = true;
    this.state = 'planning';
    try {
      const time = this.world.time;
      this.world.updateAgentState(this.agent.id, 'active', '');

      const boardContext = this.cognition.knownPlaces.has('plaza') ? this.world.getBoardSummary() : undefined;
      const institutionContext = this.buildInstitutionContext();
      const plan = await this.cognition.plan({ day: time.day, hour: time.hour }, boardContext, institutionContext || undefined);
      this.handleApiSuccess();

      // Replace remaining intentions with new ones
      this.intentions = plan;
      this.currentIntentionIndex = 0;
      this.lastReplanTick = this.world.time.totalMinutes;

      console.log(
        `[Agent] ${this.agent.config.name} replanned after conversation: ${plan.length} new intentions`,
      );
    } catch (err) {
      // Replanning failed — track failure, idle timer will follow existing plan
      console.log(`[Agent] ${this.agent.config.name} couldn't replan, continuing existing plan`);
      this.handleApiFailure(err);
    } finally {
      this.planningInProgress = false;
      // Always return to idle — let the idle timer's 30-tick gap handle next intention
      this.state = 'idle';
      this.idleTimer = 0;
    }
  }

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

    // Hunger increases every game hour
    if (this.world.time.minute === 0) {
      v.hunger = Math.min(100, v.hunger + 0.15);
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
    if (v.hunger >= 90) {
      v.health = Math.max(0, v.health - 0.05);
    } else if (v.hunger >= 80) {
      v.health = Math.max(0, v.health - 0.02);
    }
    if (v.energy <= 5) {
      v.health = Math.max(0, v.health - 0.03);
    }
    // Passive health regen when not starving/exhausted
    if (v.hunger < 70 && v.energy > 20) {
      v.health = Math.min(100, v.health + 0.02);
    }

    // Cold damage + building effects (once per game hour)
    if (this.world.time.minute === 0) {
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
      void this.thinkOnEvent(
        `You're getting ${hungerBand === 2 ? 'very hungry — your health is starting to drop' : 'hungry'}.`,
        `Hunger: ${Math.round(v.hunger)}/100. Food in inventory: ${foodCount} items.`
      );
    }
    if (energyBand > this.lastEnergyBand) {
      void this.thinkOnEvent(
        `You're ${energyBand === 2 ? 'completely exhausted' : 'getting tired'}.`,
        `Energy: ${Math.round(v.energy)}/100.`
      );
    }
    if (healthBand > this.lastHealthBand) {
      void this.thinkOnEvent(
        `You're ${healthBand === 2 ? 'critically injured' : 'hurt and need care'}.`,
        `Health: ${Math.round(v.health)}/100.`
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
    this.state = 'sleeping';
    this.intentions = [];
    this.currentIntentionIndex = 0;
    this.world.updateAgentState(this.agent.id, 'sleeping', '');
    this.broadcaster.agentAction(this.agent.id, 'sleeping', '\u{1F634}');
    console.log(`[Agent] ${this.agent.config.name} goes to sleep`);

    // Deterministic sleep spot based on agent name (no randomness)
    const sleepArea = this.nameHash(AgentController.SLEEP_AREAS);
    const sleepPos = getAreaEntrance(sleepArea);
    this.world.updateAgentPosition(this.agent.id, sleepPos);
    this.agent.position = sleepPos;

    // Explain the transition so agents don't interpret teleportation as existential crisis
    void this.cognition.addMemory({
      id: crypto.randomUUID(),
      agentId: this.agent.id,
      type: 'observation',
      content: `I walked to the ${sleepArea} and settled in for the night. Time to rest.`,
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
    // Use range check instead of exact-tick match so agents don't miss the window
    if (this.sleepHour < this.wakeHour) {
      // Crosses midnight: sleep if hour >= sleepHour OR hour < wakeHour
      return time.hour >= this.sleepHour || time.hour < this.wakeHour;
    }
    return time.hour >= this.sleepHour;
  }

  // --- Social Ledger Helpers ---

  /** Build context string of active commitments for think() and plan() */
  private buildLedgerContext(): string {
    const ledger = this.agent.socialLedger ?? [];
    const active = ledger.filter(e => e.status === 'proposed' || e.status === 'accepted');
    if (active.length === 0) return '';
    const lines = active.map(e => {
      const others = e.targetIds.map(id => this.world.getAgent(id)?.config.name ?? 'someone').join(', ');
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
      const others = e.targetIds.map(id => this.world.getAgent(id)?.config.name ?? 'someone').join(', ');
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

  /** Check if a completed activity fulfills any accepted commitments (keyword overlap heuristic) */
  private checkLedgerFulfillment(activity: string): void {
    const ledger = this.agent.socialLedger;
    if (!ledger) return;
    const activityWords = new Set(
      activity.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(w => w.length > 3)
    );
    const now = this.world.time.totalMinutes;
    for (const entry of ledger) {
      if (entry.status !== 'accepted') continue;
      const descWords = entry.description.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(w => w.length > 3);
      let overlap = 0;
      for (const w of descWords) {
        if (activityWords.has(w)) overlap++;
      }
      if (overlap >= 2) {
        entry.status = 'fulfilled';
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
}
