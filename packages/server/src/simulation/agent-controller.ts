import type { Agent, DayPlan, GameTime, Position } from '@ai-village/shared';
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

// Location-based economics: where agents earn or spend coins
const LOCATION_ECONOMICS: Record<string, { type: 'earn' | 'spend'; min: number; max: number }> = {
  cafe:     { type: 'earn',  min: 5,  max: 12 },
  bakery:   { type: 'earn',  min: 6,  max: 14 },
  workshop: { type: 'earn',  min: 8,  max: 18 },
  farm:     { type: 'earn',  min: 4,  max: 10 },
  hospital: { type: 'earn',  min: 10, max: 20 },
  school:   { type: 'earn',  min: 6,  max: 12 },
  market:   { type: 'spend', min: 3,  max: 15 },
  tavern:   { type: 'spend', min: 5,  max: 12 },
};

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
  }

  get isAvailable(): boolean {
    return (
      this.state !== 'sleeping' &&
      this.state !== 'conversing' &&
      this.conversationCooldown <= 0
    );
  }

  tick(time: GameTime): void {
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
          this.processActivityCurrency();
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
      const boardContext = this.world.getBoardSummary();
      const plan = await this.cognition.planDay({ day: time.day, hour: time.hour }, boardContext);
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
    // Track which area the agent is in for currency processing
    this.currentAreaId = areaId ?? getAreaAt(this.agent.position)?.id ?? null;
    console.log(
      `[Agent] ${this.agent.config.name} starts: ${activity} (${duration} min)`,
    );
  }

  private processActivityCurrency(): void {
    if (!this.currentAreaId) return;
    const econ = LOCATION_ECONOMICS[this.currentAreaId];
    if (!econ) return; // neutral location, no currency change

    const amount = econ.min + Math.floor(Math.random() * (econ.max - econ.min + 1));

    if (econ.type === 'earn') {
      const newBalance = this.world.updateAgentCurrency(this.agent.id, amount);
      this.broadcaster.agentCurrency(this.agent.id, newBalance, amount, `worked at ${this.currentAreaId}`);
      console.log(`[Currency] ${this.agent.config.name} earned ${amount} coins at ${this.currentAreaId} (balance: ${newBalance})`);
    } else {
      // Only spend if agent has enough; if not, spend what they have
      const current = this.agent.currency;
      const spend = Math.min(amount, current);
      if (spend > 0) {
        const newBalance = this.world.updateAgentCurrency(this.agent.id, -spend);
        this.broadcaster.agentCurrency(this.agent.id, newBalance, -spend, `spent at ${this.currentAreaId}`);
        console.log(`[Currency] ${this.agent.config.name} spent ${spend} coins at ${this.currentAreaId} (balance: ${newBalance})`);
      }
    }
    this.currentAreaId = null;
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
  }

  /**
   * Leave conversing state (called externally when conversation ends).
   * Immediately moves to next plan item so agent walks away.
   */
  leaveConversation(): void {
    if (this.state === 'conversing') {
      this.state = 'idle';
      this.idleTimer = 0;
      this.conversationCooldown = 60; // 60 ticks before this agent can talk again
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
      const plan = await this.cognition.planDay({ day: time.day, hour: time.hour }, boardContext);

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
      await this.cognition.reflect();
    } catch (err) {
      console.error(`[Agent] ${this.agent.config.name} failed to reflect:`, err);
    } finally {
      this.reflectingInProgress = false;
      this.goToSleep();
    }
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
