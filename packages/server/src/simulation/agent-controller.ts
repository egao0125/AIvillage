import type { Agent, DayPlan, DriveState, GameTime, Mood, Position, VitalState } from '@ai-village/shared';
import type { AgentCognition } from '@ai-village/ai-engine';
import { getAreaEntrance, getRandomPositionInArea, getAreaAt, getWalkable, MAP_HEIGHT, MAP_WIDTH } from '../map/village.js';
import { findPath } from './pathfinding.js';
import type { World } from './world.js';
import type { EventBroadcaster } from './events.js';

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
  dayPlan: DayPlan | null = null;
  currentPlanIndex: number = 0;
  path: Position[] = [];
  pathIndex: number = 0;
  activityTimer: number = 0;
  idleTimer: number = 0;
  private planningInProgress: boolean = false;
  private reflectingInProgress: boolean = false;
  private currentAreaId: string | null = null; // track where the agent is performing
  conversationCooldown: number = 0; // ticks remaining before agent can converse again

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
          this.followNextPlanItem();
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
          if (!this.dayPlan && !this.planningInProgress) {
            // No plan yet — create one (first tick after spawn or new day)
            void this.doPlan(time);
          } else {
            this.followNextPlanItem();
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
      const worldCtx = institutionContext || undefined;
      const plan = await this.cognition.planDay({ day: time.day, hour: time.hour }, boardContext, worldCtx);
      this.dayPlan = plan;
      this.currentPlanIndex = 0;
      console.log(
        `[Agent] ${this.agent.config.name} planned ${plan.items.length} activities for the day`,
      );
      this.followNextPlanItem();
    } catch (err) {
      console.error(`[Agent] ${this.agent.config.name} failed to plan day:`, (err as Error).message || err);
      // Fallback plan — send agents to social hubs so they meet each other
      const socialHubs = ['plaza', 'cafe', 'tavern', 'park', 'market'];
      const pick = () => socialHubs[Math.floor(Math.random() * socialHubs.length)];
      const hour = time.hour;
      this.dayPlan = {
        agentId: this.agent.id,
        day: time.day,
        items: [
          { time: hour, duration: 40, activity: 'heading to the plaza', location: 'plaza', emoji: '🚶' },
          { time: hour + 1, duration: 50, activity: 'looking around', location: pick(), emoji: '👀' },
          { time: hour + 2, duration: 40, activity: 'taking a break', location: pick(), emoji: '☕' },
          { time: hour + 3, duration: 50, activity: 'socializing', location: 'plaza', emoji: '💬' },
          { time: hour + 4, duration: 40, activity: 'wandering', location: pick(), emoji: '🚶' },
          { time: hour + 5, duration: 50, activity: 'hanging out', location: 'plaza', emoji: '🌟' },
        ],
      };
      this.currentPlanIndex = 0;
      this.followNextPlanItem();
    } finally {
      this.planningInProgress = false;
    }
  }

  followNextPlanItem(): void {
    // Drive-based override: survival needs trump all plans
    if (this.shouldOverridePlanForSurvival()) return;

    if (!this.dayPlan || this.currentPlanIndex >= this.dayPlan.items.length) {
      this.state = 'idle';
      this.world.updateAgentState(this.agent.id, 'idle', 'relaxing');
      return;
    }

    const item = this.dayPlan.items[this.currentPlanIndex];
    this.currentPlanIndex++;

    // Resolve location to a random walkable tile within the area (avoids stacking)
    const areaId = this.resolveLocation(item.location);
    const targetPos = getRandomPositionInArea(areaId);

    // Inner monologue — what are they REALLY thinking?
    void this.cognition.innerMonologue(
      `about to ${item.activity}`,
      `Going to ${item.location}. Mood: ${this.agent.mood}. Gold: ${this.agent.currency}.`
    ).then(thought => {
      if (thought) this.broadcaster.agentThought(this.agent.id, thought);
    }).catch(() => {});

    console.log(
      `[Agent] ${this.agent.config.name} → ${item.activity} at ${item.location}${item.emoji ? ' ' + item.emoji : ''}`,
    );

    // If already at the target, start performing
    const dist = Math.abs(this.agent.position.x - targetPos.x) + Math.abs(this.agent.position.y - targetPos.y);
    if (dist <= 1) {
      this.startPerforming(item.activity, item.duration, areaId);
    } else {
      // Move to the target, then perform
      this.pendingActivity = { activity: item.activity, duration: item.duration, areaId };
      this.startMoveTo(targetPos);
    }

    this.broadcaster.agentAction(this.agent.id, item.activity, item.emoji);
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
    this.state = 'performing';
    this.activityTimer = duration;
    this.world.updateAgentState(this.agent.id, 'active', activity);
    this.currentAreaId = areaId ?? getAreaAt(this.agent.position)?.id ?? null;

    // Eating reduces hunger
    const lowerActivity = activity.toLowerCase();
    const isFoodActivity = lowerActivity.includes('eat') || lowerActivity.includes('food') || lowerActivity.includes('meal') || lowerActivity.includes('lunch') || lowerActivity.includes('dinner') || lowerActivity.includes('breakfast') || lowerActivity.includes('coffee') || lowerActivity.includes('drink');
    const foodLocations = ['cafe', 'bakery', 'tavern'];
    const atFoodLocation = foodLocations.includes(this.currentAreaId ?? '');

    if (isFoodActivity || atFoodLocation) {
      const foodItem = this.agent.inventory.find(i => i.type === 'food');
      if (foodItem) {
        // Consume food from inventory
        this.world.removeItem(foodItem.id);
        if (this.agent.vitals) {
          this.agent.vitals.hunger = Math.max(0, this.agent.vitals.hunger - 30);
          this.agent.vitals.energy = Math.min(100, this.agent.vitals.energy + 10);
        }
      } else if (atFoodLocation && this.agent.currency >= 5) {
        // Buy food at commercial location
        this.world.updateAgentCurrency(this.agent.id, -5);
        if (this.agent.vitals) {
          this.agent.vitals.hunger = Math.max(0, this.agent.vitals.hunger - 30);
          this.agent.vitals.energy = Math.min(100, this.agent.vitals.energy + 10);
        }
        this.broadcaster.agentCurrency(this.agent.id, this.agent.currency, -5, `bought food at ${this.currentAreaId}`);
        console.log(`[Agent] ${this.agent.config.name} bought food at ${this.currentAreaId} for 5g`);
      } else if (this.agent.vitals) {
        // No food and no gold — still reduces hunger slightly from location ambiance
        this.agent.vitals.hunger = Math.max(0, this.agent.vitals.hunger - 10);
      }
    }

    // Healing at hospital
    const isHealingActivity = lowerActivity.includes('heal') || lowerActivity.includes('medicine') || lowerActivity.includes('treat') || lowerActivity.includes('doctor') || lowerActivity.includes('clinic');
    if ((this.currentAreaId === 'hospital' || isHealingActivity) && this.agent.vitals) {
      this.agent.vitals.health = Math.min(100, this.agent.vitals.health + 20);
      console.log(`[Agent] ${this.agent.config.name} healed at hospital (health: ${this.agent.vitals.health})`);
    }

    // Auto-gather food at gathering locations
    const gatherLocations = ['farm', 'garden', 'lake', 'forest'];
    const isGatherActivity = lowerActivity.includes('gather') || lowerActivity.includes('forage') || lowerActivity.includes('harvest') || lowerActivity.includes('fish') || lowerActivity.includes('pick');
    if (gatherLocations.includes(this.currentAreaId ?? '') && isGatherActivity) {
      const gathered = this.world.gatherMaterial(this.agent.id, this.currentAreaId!);
      if (gathered) {
        this.broadcaster.agentAction(this.agent.id, `gathered ${gathered.name}`, '\u{1FA93}');
      }
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

    // Think before speaking
    void this.cognition.innerMonologue(
      'entering a conversation',
      `About to talk to someone. Mood: ${this.agent.mood}.`
    ).then(thought => {
      if (thought) this.broadcaster.agentThought(this.agent.id, thought);
    }).catch(() => {});
  }

  /**
   * Leave conversing state (called externally when conversation ends).
   * Immediately moves to next plan item so agent walks away.
   */
  leaveConversation(): void {
    if (this.state === 'conversing') {
      this.state = 'idle';
      this.idleTimer = 0;
      this.conversationCooldown = 20; // 20 ticks before this agent can talk again
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
    if (this.planningInProgress) {
      this.followNextPlanItem();
      return;
    }

    this.planningInProgress = true;
    try {
      const time = this.world.time;
      this.world.updateAgentState(this.agent.id, 'active', 'thinking about what to do next');

      const boardContext = this.world.getBoardSummary();
      const institutionContext = this.buildInstitutionContext();
      const plan = await this.cognition.planDay({ day: time.day, hour: time.hour }, boardContext, institutionContext || undefined);

      // Replace remaining plan items with new ones
      this.dayPlan = plan;
      this.currentPlanIndex = 0;

      console.log(
        `[Agent] ${this.agent.config.name} replanned after conversation: ${plan.items.length} new activities`,
      );

      this.followNextPlanItem();
    } catch {
      // Replanning failed — just follow existing plan
      console.log(`[Agent] ${this.agent.config.name} couldn't replan, continuing existing plan`);
      this.followNextPlanItem();
    } finally {
      this.planningInProgress = false;
    }
  }

  async doReflect(): Promise<void> {
    if (this.reflectingInProgress) return;
    this.reflectingInProgress = true;
    this.state = 'reflecting';

    console.log(`[Agent] ${this.agent.config.name} is reflecting on the day`);
    this.world.updateAgentState(this.agent.id, 'active', 'reflecting');

    try {
      const result = await this.cognition.reflect();

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
    } finally {
      this.reflectingInProgress = false;
      this.goToSleep();
    }
  }

  private tickVitals(): void {
    const v = this.agent.vitals;
    if (!v) return;

    // Hunger increases slowly (1 per 4 game hours)
    if (this.world.time.minute === 0 && this.world.time.hour % 4 === 0) {
      v.hunger = Math.min(100, v.hunger + 1);
    }

    // Energy depletes during activity, restores during sleep
    if (this.state === 'performing' || this.state === 'moving') {
      v.energy = Math.max(0, v.energy - 0.05);
    } else if (this.state === 'sleeping') {
      v.energy = Math.min(100, v.energy + 0.5);
      v.hunger = Math.max(0, v.hunger - 0.1);
    }

    // Vitals affect mood but never kill — health floors at 10
    if (v.hunger >= 80) {
      v.health = Math.max(10, v.health - 0.05);
    }
    if (v.energy <= 5) {
      v.health = Math.max(10, v.health - 0.03);
    }
    // Passive health regen when not starving/exhausted
    if (v.hunger < 60 && v.energy > 20) {
      v.health = Math.min(100, v.health + 0.02);
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

    // Survival: inverse of health and hunger satisfaction
    d.survival = Math.max(0, Math.min(100,
      (100 - v.health) * 0.4 + v.hunger * 0.6
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
    this.dayPlan = null;
    this.currentPlanIndex = 0;
    this.world.updateAgentState(this.agent.id, 'sleeping', 'sleeping');
    this.broadcaster.agentAction(this.agent.id, 'sleeping', '\u{1F634}');
    console.log(`[Agent] ${this.agent.config.name} goes to sleep`);

    // Pick a random quiet spot to sleep — agents spread out at night
    const sleepArea = AgentController.SLEEP_AREAS[
      Math.floor(Math.random() * AgentController.SLEEP_AREAS.length)
    ];
    const sleepPos = getAreaEntrance(sleepArea);
    this.world.updateAgentPosition(this.agent.id, sleepPos);
    this.agent.position = sleepPos;
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
  private static readonly FOOD_LOCATIONS = ['cafe', 'bakery', 'tavern'];

  private isFoodActivity(activity: string): boolean {
    const lower = activity.toLowerCase();
    return lower.includes('eat') || lower.includes('food') || lower.includes('meal')
      || lower.includes('lunch') || lower.includes('dinner') || lower.includes('breakfast')
      || lower.includes('cook') || lower.includes('gather') || lower.includes('coffee')
      || lower.includes('buy bread') || lower.includes('stew');
  }

  private forceFoodPlan(): void {
    const target = AgentController.FOOD_LOCATIONS[
      Math.floor(Math.random() * AgentController.FOOD_LOCATIONS.length)
    ];
    console.log(`[Agent] ${this.agent.config.name} SURVIVAL OVERRIDE: seeking food at ${target}`);
    this.dayPlan = {
      agentId: this.agent.id,
      day: this.world.time.day,
      items: [
        { time: this.world.time.hour, duration: 30, activity: 'desperately looking for food', location: target, emoji: '\u{1F35E}' },
      ],
    };
    this.currentPlanIndex = 0;
    this.survivalOverrideActive = true;
    this.followNextPlanItem();
    this.survivalOverrideActive = false;
  }

  private forceHospitalPlan(): void {
    console.log(`[Agent] ${this.agent.config.name} HEALTH CRISIS: heading to hospital`);
    this.dayPlan = {
      agentId: this.agent.id,
      day: this.world.time.day,
      items: [
        { time: this.world.time.hour, duration: 40, activity: 'seeking medical treatment', location: 'hospital', emoji: '\u{1F3E5}' },
      ],
    };
    this.currentPlanIndex = 0;
    this.survivalOverrideActive = true;
    this.followNextPlanItem();
    this.survivalOverrideActive = false;
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

    // Health crisis: force hospital visit
    if (v.health <= 30) {
      this.forceHospitalPlan();
      return true;
    }

    // Emergency hunger: force food-seeking
    if (d.survival > 80 || v.hunger >= 80) {
      this.forceFoodPlan();
      return true;
    }

    // Urgent hunger: insert food if next plan item isn't food-related
    if (d.survival > 60 || v.hunger >= 60) {
      if (this.dayPlan && this.currentPlanIndex < this.dayPlan.items.length) {
        const nextItem = this.dayPlan.items[this.currentPlanIndex];
        if (!this.isFoodActivity(nextItem.activity)) {
          this.forceFoodPlan();
          return true;
        }
      } else {
        // No plan items left
        this.forceFoodPlan();
        return true;
      }
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
      // No fixed home — pick a random public area
      return AgentController.PUBLIC_AREAS[
        Math.floor(Math.random() * AgentController.PUBLIC_AREAS.length)
      ];
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
    };

    for (const [key, areaId] of Object.entries(mapping)) {
      if (lower.includes(key)) return areaId;
    }

    // Fallback: plaza
    return 'plaza';
  }
}
