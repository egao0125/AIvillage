import type { Agent, DriveState, GameTime, Mood, Position, ThinkOutput, VitalState } from '@ai-village/shared';
import { AgentCognition } from '@ai-village/ai-engine';
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
  onDeath?: (agentId: string, cause: string) => void;
  private thinkCooldown: number = 0;

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
    }

    if (this.conversationCooldown > 0) this.conversationCooldown--;

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
          this.followNextIntention();
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
        // Check survival override before normal idle behavior
        if (this.shouldOverridePlanForSurvival()) break;

        this.idleTimer++;
        if (this.idleTimer >= 30) {
          this.idleTimer = 0;
          if (this.intentions.length === 0 && !this.planningInProgress) {
            // No plan yet — create one (first tick after spawn or new day)
            void this.doPlan(time);
          } else {
            this.followNextIntention();
          }
        }
        // Check if it's time to sleep
        if (this.shouldSleep(time)) {
          void this.doReflect();
        }
        break;
      }
    }
  }

  async wake(): Promise<void> {
    this.state = 'planning';
    this.world.updateAgentState(this.agent.id, 'active', 'waking up');
    this.broadcaster.agentAction(this.agent.id, 'waking up', '\u{1F31E}');
    console.log(`[Agent] ${this.agent.config.name} wakes up`);

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

    try {
      this.world.updateAgentState(this.agent.id, 'active', 'planning the day');
      let boardContext = this.world.getBoardSummary();

      // Add public artifacts to planning context
      const publicArtifacts = this.world.getPublicArtifacts().slice(-10);
      if (publicArtifacts.length > 0) {
        const artifactText = publicArtifacts.map(a =>
          `- [${a.type.toUpperCase()}] "${a.title}" by ${a.creatorName}: ${a.content.slice(0, 100)}`
        ).join('\n');
        boardContext += `\n\nVILLAGE MEDIA:\n${artifactText}`;
      }

      const activeElections = Array.from(this.world.elections.values()).filter(e => e.active);
      if (activeElections.length > 0) {
        const electionsText = activeElections.map(e => {
          const candidateNames = e.candidates.map(cid => this.world.getAgent(cid)?.config.name ?? cid).join(', ');
          return `- Election for ${e.position}: candidates [${candidateNames}], ends day ${e.endDay}`;
        }).join('\n');
        boardContext += `\n\nACTIVE ELECTIONS:\n${electionsText}`;
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
      const hasMaterials = this.agent.inventory.some(i => i.type === 'material');
      if (hasMaterials) {
        buildingContext += '\nYou have materials — you can BUILD structures or CRAFT items at the workshop.';
      }

      const worldCtx = (institutionContext + buildingContext) || undefined;
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
    if (this.shouldOverridePlanForSurvival()) return;

    if (this.currentIntentionIndex >= this.intentions.length) {
      this.state = 'idle';
      this.world.updateAgentState(this.agent.id, 'idle', 'relaxing');
      return;
    }

    const intention = this.intentions[this.currentIntentionIndex];
    this.currentIntentionIndex++;

    // Check if intention mentions talking to a specific agent
    const talkMatch = intention.match(/(?:talk|speak|meet|find|converse|visit|see)\s+(?:to|with)?\s*(\w+)/i);
    if (talkMatch) {
      const targetName = talkMatch[1];
      for (const agent of this.world.agents.values()) {
        if (agent.id !== this.agent.id &&
            agent.config.name.toLowerCase().includes(targetName.toLowerCase())) {
          this.pendingConversationTarget = agent.id;
          break;
        }
      }
    }

    // Infer location from intention text using existing resolveLocation()
    const areaId = this.resolveLocation(intention);
    const targetPos = getRandomPositionInArea(areaId);

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
    this.world.updateAgentState(this.agent.id, 'routine', 'walking');
  }

  private advanceMovement(): void {
    if (this.pathIndex >= this.path.length) {
      // Arrived at destination
      if (this.pendingActivity) {
        this.startPerforming(this.pendingActivity.activity, this.pendingActivity.duration, this.pendingActivity.areaId);
        this.pendingActivity = null;
      } else {
        this.state = 'idle';
        this.world.updateAgentState(this.agent.id, 'idle', 'arrived');
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
    this.activityTimer = duration;
    this.world.updateAgentState(this.agent.id, 'active', activity);
    this.currentAreaId = areaId ?? getAreaAt(this.agent.position)?.id ?? null;

    const lowerActivity = activity.toLowerCase();
    const isGatherActivity = lowerActivity.includes('gather') || lowerActivity.includes('forage') || lowerActivity.includes('harvest') || lowerActivity.includes('fish') || lowerActivity.includes('pick') || lowerActivity.includes('find food') || lowerActivity.includes('get food') || lowerActivity.includes('look for food') || lowerActivity.includes('mushroom') || lowerActivity.includes('wheat') || lowerActivity.includes('wood') || lowerActivity.includes('herb') || lowerActivity.includes('crop') || lowerActivity.includes('vegetable');

    // Auto-gather food at gathering locations (MUST run before eating so gathered food can be consumed)
    const gatherLocations = ['farm', 'garden', 'lake', 'forest', 'forest_south'];
    if (gatherLocations.includes(this.currentAreaId ?? '') && isGatherActivity) {
      const gathered = this.world.gatherMaterial(this.agent.id, this.currentAreaId!);
      if (gathered) {
        this.broadcaster.agentAction(this.agent.id, `gathered ${gathered.name}`, '\u{1FA93}');
        // Emergency: starving agents eat immediately, others keep for trading
        if (gathered.type === 'food' && this.agent.vitals && this.agent.vitals.hunger >= 60) {
          this.world.removeItem(gathered.id);
          this.agent.vitals.hunger = Math.max(0, this.agent.vitals.hunger - 30);
          this.agent.vitals.energy = Math.min(100, this.agent.vitals.energy + 10);
          this.broadcaster.agentAction(this.agent.id, `ate ${gathered.name}`, '🍽️');
          this.broadcaster.agentInventory(this.agent.id, this.agent.inventory);
        }
      }
    }

    // Eating reduces hunger (runs after gathering so freshly gathered food is available)
    const isFoodActivity = lowerActivity.includes('eat') || lowerActivity.includes('food') || lowerActivity.includes('meal') || lowerActivity.includes('lunch') || lowerActivity.includes('dinner') || lowerActivity.includes('breakfast') || lowerActivity.includes('coffee') || lowerActivity.includes('drink');
    const foodLocations = ['cafe', 'bakery', 'tavern'];
    const atFoodLocation = foodLocations.includes(this.currentAreaId ?? '');

    if (isFoodActivity || atFoodLocation || isGatherActivity) {
      const foodItem = this.agent.inventory.find(i => i.type === 'food');
      if (foodItem) {
        // Consume food from inventory
        this.world.removeItem(foodItem.id);
        if (this.agent.vitals) {
          this.agent.vitals.hunger = Math.max(0, this.agent.vitals.hunger - 30);
          this.agent.vitals.energy = Math.min(100, this.agent.vitals.energy + 10);
        }
        this.broadcaster.agentAction(this.agent.id, `ate ${foodItem.name}`, '🍽️');
        console.log(`[Agent] ${this.agent.config.name} ate ${foodItem.name} (hunger: ${this.agent.vitals?.hunger})`);
      }
    }

    // Healing at hospital — requires consuming a medicine/herb item
    const isHealingActivity = lowerActivity.includes('heal') || lowerActivity.includes('medicine') || lowerActivity.includes('treat') || lowerActivity.includes('doctor') || lowerActivity.includes('clinic');
    if ((this.currentAreaId === 'hospital' || isHealingActivity) && this.agent.vitals) {
      const medicineItem = this.agent.inventory.find(i =>
        i.type === 'food' && (i.name.toLowerCase().includes('herb') || i.name.toLowerCase().includes('medicine') || i.name.toLowerCase().includes('potion'))
      );
      if (medicineItem) {
        this.world.removeItem(medicineItem.id);
        this.agent.vitals.health = Math.min(100, this.agent.vitals.health + 20);
        console.log(`[Agent] ${this.agent.config.name} used ${medicineItem.name} to heal (health: ${this.agent.vitals.health})`);
      }
    }

    // Think — let agent react to what they're doing at this location (skip if API exhausted)
    const ticksSinceLast = this.world.time.totalMinutes - this.lastSoloActionTick;
    if (ticksSinceLast >= 30 && !isFoodActivity && !isHealingActivity && !isGatherActivity && this.soloActionExecutor && !this.apiExhausted) {
      this.lastSoloActionTick = this.world.time.totalMinutes;
      void this.cognition.think(
        `doing: ${activity}`,
        `Location: ${this.currentAreaId ?? 'unknown'}. Time: hour ${this.world.time.hour}.`
      ).then(output => {
        this.handleApiSuccess();
        // Execute any actions from think output
        if (output.actions) {
          for (const action of output.actions) {
            this.soloActionExecutor!.executeSocialAction(
              this.agent.id, this.agent.config.name, '', action, this.cognition
            );
          }
        }
        // Update mood if changed
        if (output.mood) {
          this.agent.mood = output.mood;
          this.broadcaster.agentMood(this.agent.id, output.mood);
        }
        // Handle replan
        if (output.replan) {
          void this.replanAfterConversation();
        }
      }).catch((err) => { this.handleApiFailure(err); });
    }

    console.log(
      `[Agent] ${this.agent.config.name} starts: ${activity} (${duration} min)`,
    );
  }

  /**
   * Enter conversing state (called externally by ConversationManager).
   */
  enterConversation(): void {
    // Stop any movement — agent halts to talk
    this.path = [];
    this.pathIndex = 0;
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
      this.conversationCooldown = 120; // ~10 seconds before this agent can talk again
      this.world.updateAgentState(this.agent.id, 'idle', 'finished conversation');

      // After a conversation, replan the rest of the day based on new memories
      // This allows agents to react to what was said (e.g. "meet me at the market")
      void this.replanAfterConversation();
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
      this.followNextIntention();
      return;
    }

    this.planningInProgress = true;
    try {
      const time = this.world.time;
      this.world.updateAgentState(this.agent.id, 'active', 'thinking about what to do next');

      const boardContext = this.world.getBoardSummary();
      const institutionContext = this.buildInstitutionContext();
      const plan = await this.cognition.plan({ day: time.day, hour: time.hour }, boardContext, institutionContext || undefined);
      this.handleApiSuccess();

      // Replace remaining intentions with new ones
      this.intentions = plan;
      this.currentIntentionIndex = 0;

      console.log(
        `[Agent] ${this.agent.config.name} replanned after conversation: ${plan.length} new intentions`,
      );

      this.followNextIntention();
    } catch (err) {
      // Replanning failed — track failure, follow existing plan
      console.log(`[Agent] ${this.agent.config.name} couldn't replan, continuing existing plan`);
      this.handleApiFailure(err);
      this.followNextIntention();
    } finally {
      this.planningInProgress = false;
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
    this.world.updateAgentState(this.agent.id, 'active', 'reflecting');

    try {
      const result = await this.cognition.reflect();
      this.handleApiSuccess();

      // Update mental models from reflection
      if (result.mentalModels) {
        this.agent.mentalModels = result.mentalModels;
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
      v.hunger = Math.min(100, v.hunger + 0.5);
    }

    // Energy depletes during activity, restores during sleep
    // Also slowly restores during idle/performing (resting at tavern, sitting in park, etc.)
    if (this.state === 'performing' || this.state === 'moving') {
      v.energy = Math.max(0, v.energy - 0.05);
    } else if (this.state === 'idle') {
      v.energy = Math.min(100, v.energy + 0.02);
    } else if (this.state === 'sleeping') {
      v.energy = Math.min(100, v.energy + 0.5);
    }

    // Vitals affect health — starvation and exhaustion can kill
    if (v.hunger >= 80) {
      v.health = Math.max(0, v.health - 0.05);
    }
    if (v.energy <= 5) {
      v.health = Math.max(0, v.health - 0.03);
    }
    // Passive health regen when not starving/exhausted
    if (v.hunger < 60 && v.energy > 20) {
      v.health = Math.min(100, v.health + 0.02);
    }

    // Death check — health reaching 0 is fatal
    if (v.health <= 0) {
      const cause = v.hunger >= 80 ? 'starvation' : 'exhaustion';
      this.die(cause);
      return;
    }

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
    this.world.updateAgentState(this.agent.id, 'sleeping', 'sleeping');
    this.broadcaster.agentAction(this.agent.id, 'sleeping', '\u{1F634}');
    console.log(`[Agent] ${this.agent.config.name} goes to sleep`);

    // Deterministic sleep spot based on agent name (no randomness)
    const sleepArea = this.nameHash(AgentController.SLEEP_AREAS);
    const sleepPos = getAreaEntrance(sleepArea);
    this.world.updateAgentPosition(this.agent.id, sleepPos);
    this.agent.position = sleepPos;
  }

  private nameHash(areas: readonly string[]): string {
    let hash = 0;
    for (const ch of this.agent.config.name) {
      hash = ((hash << 5) - hash) + ch.charCodeAt(0);
      hash |= 0;
    }
    return areas[Math.abs(hash) % areas.length];
  }

  private nearestFoodLocation(): string {
    const pos = this.agent.position;
    let nearest = AgentController.FOOD_LOCATIONS[0];
    let minDist = Infinity;
    for (const loc of AgentController.FOOD_LOCATIONS) {
      const entrance = getAreaEntrance(loc);
      const dist = Math.abs(pos.x - entrance.x) + Math.abs(pos.y - entrance.y);
      if (dist < minDist) {
        minDist = dist;
        nearest = loc;
      }
    }
    return nearest;
  }

  private shouldWake(time: GameTime): boolean {
    return time.hour === this.wakeHour && time.minute === 0;
  }

  private shouldSleep(time: GameTime): boolean {
    // Handle sleep hours that cross midnight (e.g., Hana sleeps at 1 AM)
    if (this.sleepHour < this.wakeHour) {
      // Crosses midnight: sleep if hour >= sleepHour AND hour < wakeHour
      return time.hour === this.sleepHour && time.minute === 0;
    }
    return time.hour === this.sleepHour && time.minute === 0;
  }

  // --- Drive-Based Action Filtering ---

  private survivalOverrideActive: boolean = false;
  private static readonly FOOD_LOCATIONS = ['farm', 'garden', 'lake', 'forest'];

  private isFoodActivity(activity: string): boolean {
    const lower = activity.toLowerCase();
    return lower.includes('eat') || lower.includes('food') || lower.includes('meal')
      || lower.includes('lunch') || lower.includes('dinner') || lower.includes('breakfast')
      || lower.includes('cook') || lower.includes('gather') || lower.includes('coffee')
      || lower.includes('buy bread') || lower.includes('stew') || lower.includes('forage')
      || lower.includes('harvest') || lower.includes('fish') || lower.includes('mushroom')
      || lower.includes('wheat') || lower.includes('herb') || lower.includes('crop')
      || lower.includes('vegetable');
  }

  private async forceFoodPlan(): Promise<void> {
    this.survivalOverrideActive = true;

    // Step 1: Eat from inventory immediately if we have food — no walking needed
    const foodItem = this.agent.inventory.find(i => i.type === 'food');
    if (foodItem) {
      this.world.removeItem(foodItem.id);
      if (this.agent.vitals) {
        this.agent.vitals.hunger = Math.max(0, this.agent.vitals.hunger - 30);
        this.agent.vitals.energy = Math.min(100, this.agent.vitals.energy + 10);
      }
      this.broadcaster.agentAction(this.agent.id, `ate ${foodItem.name}`, '🍽️');
      this.broadcaster.agentInventory(this.agent.id, this.agent.inventory);
      console.log(`[Agent] ${this.agent.config.name} SURVIVAL: ate ${foodItem.name} from inventory (hunger: ${this.agent.vitals?.hunger})`);
      this.survivalOverrideActive = false;
      return false as unknown as void; // don't override plan — just ate
    }

    // Step 2: No food in inventory — go gather
    console.log(`[Agent] ${this.agent.config.name} SURVIVAL OVERRIDE: seeking food`);

    try {
      // LLM replan (skip if API exhausted)
      if (!this.apiExhausted) {
        try {
          const urgencyContext = `URGENT: You are starving (hunger: ${this.agent.vitals?.hunger}). You MUST find food immediately or your health will drop. Focus on: gathering food from farm/garden/lake/forest, trading for food, or asking someone who has food.`;
          const plan = await this.cognition.plan(
            { day: this.world.time.day, hour: this.world.time.hour },
            this.world.getBoardSummary(),
            urgencyContext,
          );
          this.handleApiSuccess();
          this.intentions = plan;
          this.currentIntentionIndex = 0;
          this.followNextIntention();
          return;
        } catch (err) {
          this.handleApiFailure(err);
        }
      }

      // Mechanical fallback — go to nearest gathering location (no LLM needed)
      const target = this.nearestFoodLocation();
      this.intentions = [`gathering food at ${target}`];
      this.currentIntentionIndex = 0;
      this.followNextIntention();
    } finally {
      this.survivalOverrideActive = false;
    }
  }

  private async forceHospitalPlan(): Promise<void> {
    console.log(`[Agent] ${this.agent.config.name} HEALTH CRISIS: heading to hospital`);
    this.survivalOverrideActive = true;

    try {
      // LLM replan (skip if API exhausted)
      if (!this.apiExhausted) {
        try {
          const urgencyContext = `URGENT: Your health is critically low (health: ${this.agent.vitals?.health}). You MUST seek medical treatment immediately. Go to the hospital, use medicine/herbs if you have them, or ask someone for help.`;
          const plan = await this.cognition.plan(
            { day: this.world.time.day, hour: this.world.time.hour },
            this.world.getBoardSummary(),
            urgencyContext,
          );
          this.handleApiSuccess();
          this.intentions = plan;
          this.currentIntentionIndex = 0;
          this.followNextIntention();
          return;
        } catch (err) {
          this.handleApiFailure(err);
        }
      }

      // Mechanical fallback — go to hospital (no LLM needed)
      this.intentions = ['seeking medical treatment at hospital'];
      this.currentIntentionIndex = 0;
      this.followNextIntention();
    } finally {
      this.survivalOverrideActive = false;
    }
  }

  /**
   * Check if drives should override the current plan for survival.
   * Returns true if an override was triggered.
   */
  private shouldOverridePlanForSurvival(): boolean {
    if (this.survivalOverrideActive) return false; // prevent recursion
    const d = this.agent.drives;
    const v = this.agent.vitals;
    if (!d || !v) return false;

    // Already executing a food plan — let it finish instead of replanning every tick
    if (this.state === 'moving' || this.state === 'performing') {
      const currentActivity = this.pendingActivity?.activity ?? this.intentions[this.currentIntentionIndex - 1] ?? '';
      if (this.isFoodActivity(currentActivity)) return false;
    }

    // HUNGER ALWAYS CHECKS FIRST — starvation is the #1 killer.
    // Hospital can't fix hunger. Don't send a starving agent to a cardiologist.

    // Emergency hunger: force food-seeking
    if (d.survival > 60 || v.hunger >= 60) {
      void this.forceFoodPlan();
      return true;
    }

    // Urgent hunger: insert food if next plan item isn't food-related
    if (d.survival > 40 || v.hunger >= 40) {
      if (this.currentIntentionIndex < this.intentions.length) {
        const nextItem = this.intentions[this.currentIntentionIndex];
        if (!this.isFoodActivity(nextItem)) {
          void this.forceFoodPlan();
          return true;
        }
      } else {
        void this.forceFoodPlan();
        return true;
      }
    }

    // Health crisis: hospital ONLY if not starving (hunger < 60).
    // If they're starving, food fixes health. Hospital without medicine doesn't.
    if (v.health <= 30 && v.hunger < 60) {
      void this.forceHospitalPlan();
      return true;
    }

    return false;
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

  private resolveLocation(location: string): string {
    const lower = location.toLowerCase().trim();

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

    for (const [key, areaId] of Object.entries(mapping)) {
      if (lower.includes(key)) return areaId;
    }

    // Fallback: plaza
    return 'plaza';
  }
}
