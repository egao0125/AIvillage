import type { Server } from 'socket.io';
import type { Agent, AgentConfig, BoardPostType, WorldSnapshot, Weather, Building, Technology } from '@ai-village/shared';
import { EventBus } from '@ai-village/shared';
import { AgentCognition, InMemoryStore, SupabaseMemoryStore, AnthropicProvider, ThrottledProvider, TieredMemory, SEASONS } from '@ai-village/ai-engine';
import type { WorldViewParts } from '@ai-village/ai-engine';
import { getAreaEntrance } from '../map/village.js';
import { buildStartingWorldViewParts } from '../map/starting-knowledge.js';
import { World } from './world.js';
import { EventBroadcaster } from './events.js';
import { ConversationManager } from './conversation/index.js';
import { AgentController } from './agent-controller.js';
import { DecisionQueue } from './decision-queue.js';
import { ViewportManager } from './viewport-manager.js';
import { STARTER_AGENTS } from '../agents/starter.js';
import { AREAS } from '../map/village.js';
import { SupabasePersistence } from '../persistence/supabase.js';
import type { ControllerState } from './agent-controller.js';
import { VillageNarrator } from './narrator.js';
import { CharacterTimeline } from './character-timeline.js';
import { StorylineDetector } from './storyline-detector.js';
import { RecapGenerator } from './recap-generator.js';

export class SimulationEngine {
  private static readonly SPAWN_AREAS = ['plaza', 'cafe', 'park', 'market', 'garden', 'tavern', 'bakery'];

  private world: World;
  readonly bus: EventBus = new EventBus();
  private controllers: Map<string, AgentController> = new Map();
  private conversationManager!: ConversationManager;
  private broadcaster!: EventBroadcaster;
  private cognitions: Map<string, AgentCognition> = new Map();
  private agentApiKeys: Map<string, { apiKey: string; model: string }> = new Map();
  // Shared throttle per API key — limits concurrent LLM calls to prevent OOM
  private static readonly MAX_CONCURRENT_LLM = 10;
  private throttles: Map<string, ThrottledProvider> = new Map();
  private decisionQueue: DecisionQueue;
  private decisionInterval: NodeJS.Timeout | null = null;
  readonly viewportManager: ViewportManager = new ViewportManager();
  private tickInterval: NodeJS.Timeout | null = null;
  private tickCount: number = 0;
  private persistence: SupabasePersistence | null = null;
  private weatherStableUntil: number = 0;
  private lastConversationPair: Map<string, number> = new Map();
  private narrator!: VillageNarrator;
  private characterTimeline!: CharacterTimeline;
  private storylineDetector!: StorylineDetector;
  recapGenerator!: RecapGenerator;
  private lastWeeklySummaryDay: number = 0;
  private cachedWeeklySummary: string | null = null;
  private weeklySummaryGenerating: boolean = false;

  constructor(private io: Server) {
    this.world = new World();
    this.decisionQueue = new DecisionQueue(SimulationEngine.MAX_CONCURRENT_LLM);

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (supabaseUrl && supabaseKey) {
      this.persistence = new SupabasePersistence(supabaseUrl, supabaseKey);
      console.log('[Engine] Supabase persistence enabled');
    } else {
      console.log('[Engine] Supabase persistence disabled (missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY)');
    }
  }

  async initialize(): Promise<void> {
    // Create broadcaster with viewport-aware filtering
    this.broadcaster = new EventBroadcaster(this.io);
    this.broadcaster.setViewportManager(this.viewportManager);
    this.broadcaster.setPositionLookup((agentId) => this.world.getAgent(agentId)?.position);

    // Create narrator + timeline + storyline systems
    const globalKey = process.env.ANTHROPIC_API_KEY;
    const globalModel = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
    if (globalKey) {
      const narratorLlm = this.getThrottledProvider(globalKey, globalModel);
      this.narrator = new VillageNarrator(narratorLlm, this.world);
      this.broadcaster.setNarrator(this.narrator);

      this.storylineDetector = new StorylineDetector(this.world, narratorLlm);
      this.recapGenerator = new RecapGenerator(this.world, this.narrator, this.storylineDetector, narratorLlm);
    } else {
      // Fallback: create with a dummy provider that will just fail gracefully
      const dummyLlm = this.getThrottledProvider('dummy-key', globalModel);
      this.narrator = new VillageNarrator(dummyLlm, this.world);
      this.storylineDetector = new StorylineDetector(this.world, dummyLlm);
      this.recapGenerator = new RecapGenerator(this.world, this.narrator, this.storylineDetector, dummyLlm);
    }

    this.characterTimeline = new CharacterTimeline();
    this.broadcaster.setTimeline(this.characterTimeline);
    this.broadcaster.setDayGetter(() => this.world.time.day);

    // Create conversation manager
    this.conversationManager = new ConversationManager(this.world, this.broadcaster, this.bus);

    // Restore from Supabase if persistence is enabled
    if (this.persistence) {
      await this.loadFromSupabase();
    }

    // --- Infra 1: Wire event bus subscriptions ---
    // Registration order = execution order within a tick.

    // Midnight: reset counters, decay objects
    this.bus.on('midnight', () => {
      this.world.resetDailyCounters();
      this.world.spoilFood();
      this.decayWorldObjects();
    });

    // Tick controllers
    this.bus.on('tick', (e) => {
      for (const controller of this.controllers.values()) {
        controller.tick(e.time);
      }
    });

    // Hourly resource regeneration (Fix 1: wire resource depletion)
    this.bus.on('hour_changed', () => {
      const seasonIdx = Math.floor((this.world.time.day - 1) / 30) % 4;
      const seasonName = (['spring', 'summer', 'autumn', 'winter'] as const)[seasonIdx];
      const seasonDef = SEASONS[seasonName];
      this.world.regenerateResourcePoolsHourly(seasonDef.gatherMultipliers);
    });

    // Perception
    this.bus.on('perception_cycle', () => this.runPerception());

    // Proximity → conversations (single subscriber preserves ordering)
    this.bus.on('tick', () => {
      this.checkProximityConversations();
      this.advanceConversations();
    });

    // Fix 4: Witness-based perception for theft events
    this.bus.on('theft_occurred', (e) => {
      const nearby = this.world.getNearbyAgents(e.location, 5);
      const thiefName = this.world.getAgent(e.thiefId)?.config.name ?? 'someone';
      const victimName = this.world.getAgent(e.victimId)?.config.name ?? 'someone';

      for (const witness of nearby) {
        if (witness.id === e.thiefId || witness.id === e.victimId) continue;
        if (witness.alive === false) continue;
        const cognition = this.cognitions.get(witness.id);
        if (!cognition) continue;

        void cognition.addMemory({
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
          ).catch(() => {});
        }
      }
      this.broadcaster.agentAction(e.thiefId, `stole ${e.item}`, '\u{1F978}');
    });

    // Fix 4: Witness-based perception for fight events
    this.bus.on('fight_occurred', (e) => {
      const nearby = this.world.getNearbyAgents(e.location, 6);
      const attackerName = this.world.getAgent(e.attackerId)?.config.name ?? 'someone';
      const defenderName = this.world.getAgent(e.defenderId)?.config.name ?? 'someone';

      for (const witness of nearby) {
        if (witness.id === e.attackerId || witness.id === e.defenderId) continue;
        if (witness.alive === false) continue;
        const cognition = this.cognitions.get(witness.id);
        if (!cognition) continue;

        void cognition.addMemory({
          id: crypto.randomUUID(),
          agentId: witness.id,
          type: 'observation',
          content: `I saw ${attackerName} fight ${defenderName}. ${e.outcome}`,
          importance: 7,
          timestamp: Date.now(),
          relatedAgentIds: [e.attackerId, e.defenderId],
        });
      }
    });

    // Fix 5: Institutional rule enforcement — leaders react to violations
    this.bus.on('rule_violated', (e) => {
      const institution = this.world.institutions.get(e.institutionId);
      if (!institution) return;

      // Find institution leaders
      const leaders = (institution.members ?? [])
        .filter((m: any) =>
          m.role === 'leader' || m.role === 'elder' || m.role === 'founder'
        )
        .map((m: any) => m.agentId as string)
        .filter((id: string) => id !== e.agentId); // violator can't judge themselves

      for (const leaderId of leaders) {
        const cognition = this.cognitions.get(leaderId);
        const ctrl = this.controllers.get(leaderId);
        if (!cognition || !ctrl || ctrl.apiExhausted) continue;

        // Leader gets a high-importance memory of the violation
        void cognition.addMemory({
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
        ).catch(() => {});
      }

      console.log(`[Institution] ${e.agentName} violated ${e.institutionName} rule: "${e.rule}"`);
    });

    // Periodic save
    this.bus.on('save_requested', () => {
      if (this.persistence) {
        void this.persistence.saveAll(this.world, this.controllers, this.agentApiKeys).catch(err =>
          console.error('[Persistence] Periodic save failed:', err)
        );
      }
    });

    console.log(`[Engine] AI Village initialized (no starter agents — users create agents via UI)`);
  }

  private async loadFromSupabase(): Promise<void> {
    if (!this.persistence) return;

    try {
      // Load all data in parallel
      const [worldData, agents, controllerDataMap] = await Promise.all([
        this.persistence.loadWorldState(),
        this.persistence.loadAgents(),
        this.persistence.loadAgentControllers(),
      ]);

      if (worldData) {
        this.world.time = worldData.time as typeof this.world.time;
        this.world.weather = worldData.weather as typeof this.world.weather;
        this.world.board = (worldData.board ?? []) as typeof this.world.board;
        this.world.reputation = (worldData.reputation ?? []) as typeof this.world.reputation;
        this.world.secrets = (worldData.secrets ?? []) as typeof this.world.secrets;
        this.world.artifacts = (worldData.artifacts ?? []) as typeof this.world.artifacts;
        this.world.technologies = (worldData.technologies ?? []) as typeof this.world.technologies;
        this.world.materialSpawns = (worldData.materialSpawns ?? this.world.materialSpawns) as typeof this.world.materialSpawns;
        // Reset spawn timers — prevents stale lastGathered from previous sessions blocking all gathering
        for (const spawn of this.world.materialSpawns) {
          spawn.lastGathered = undefined;
        }
        this.world.conversations = recordToMap(worldData.conversations ?? {}) as typeof this.world.conversations;
        this.world.elections = recordToMap(worldData.elections ?? {}) as typeof this.world.elections;
        this.world.properties = recordToMap(worldData.properties ?? {}) as typeof this.world.properties;
        this.world.items = recordToMap(worldData.items ?? {}) as typeof this.world.items;
        this.world.institutions = recordToMap(worldData.institutions ?? {}) as typeof this.world.institutions;
        this.world.buildings = recordToMap(worldData.buildings ?? {}) as typeof this.world.buildings;

        // Fix 3: Restore emergent world state
        if (worldData.worldObjects && Array.isArray(worldData.worldObjects)) {
          for (const obj of worldData.worldObjects as any[]) {
            if (obj && obj.id) this.world.worldObjects.set(obj.id, obj);
          }
        }
        if (worldData.culturalNames) {
          for (const [key, val] of Object.entries(worldData.culturalNames)) {
            this.world.culturalNames.set(key, val as { name: string; mentionCount: number; lastMentionedDay: number });
          }
        }
        if (worldData.resourcePools) {
          for (const [key, val] of Object.entries(worldData.resourcePools)) {
            this.world.resourcePools.set(key, val as number);
          }
        }

        console.log(`[Engine] World state restored (day ${this.world.time.day}, hour ${this.world.time.hour})`);
      }

      if (agents.length === 0) {
        console.log('[Engine] No agents to restore from Supabase');
        return;
      }

      const globalKey = process.env.ANTHROPIC_API_KEY;
      const globalKey2 = process.env.ANTHROPIC_API_KEY_2;
      const forcedModel = 'claude-haiku-4-5-20251001';
      const sharedMemoryStore = new SupabaseMemoryStore(this.persistence.client);

      for (let i = 0; i < agents.length; i++) {
        const agent = agents[i];
        this.world.addAgent(agent);

        // Round-robin agents across two API keys; force Haiku for all existing agents
        const useKey2 = globalKey2 && i % 2 === 1;
        const effectiveKey = useKey2 ? globalKey2 : (globalKey || 'dummy-key');
        const effectiveModel = forcedModel;
        this.agentApiKeys.set(agent.id, { apiKey: effectiveKey, model: effectiveModel });
        const keyLabel = useKey2 ? 'KEY_2' : 'KEY_1';
        console.log(`[Engine] Agent ${agent.config.name} → ${keyLabel} / ${effectiveModel}`);

        // Away agents persist but don't get controller/cognition (no LLM calls)
        if (agent.state === 'away') {
          console.log(`[Engine] Agent ${agent.config.name} is away — skipping controller/cognition`);
          continue;
        }

        // Create cognition with Supabase-backed memory + throttled LLM
        const llmProvider = this.getThrottledProvider(effectiveKey, effectiveModel);
        const ctrlDataForWorldView = controllerDataMap.get(agent.id);
        const savedParts = (ctrlDataForWorldView as any)?.worldViewParts as WorldViewParts | undefined;
        const cognition = new AgentCognition(agent, sharedMemoryStore, llmProvider, savedParts);
        this.wireTieredMemory(cognition, agent, sharedMemoryStore);
        this.cognitions.set(agent.id, cognition);

        // Restore controller
        const ctrlData = controllerDataMap.get(agent.id);
        const wakeHour = ctrlData?.wakeHour ?? 7;
        const sleepHour = ctrlData?.sleepHour ?? 23;
        const homeArea = ctrlData?.homeArea ?? 'plaza';

        const controller = new AgentController(
          agent,
          cognition,
          this.world,
          this.broadcaster,
          wakeHour,
          sleepHour,
          homeArea,
          this.createActionExecutor(),
        );
        controller.onDeath = (id, cause) => this.onControllerDeath(id, cause);
        controller.bus = this.bus;

        // Restore mutable controller state
        if (ctrlData) {
          const restoredState = ctrlData.controllerState as ControllerState;
          // Reset transient states to idle — path/conversation state is not saved across restarts
          controller.state = (restoredState === 'moving' || restoredState === 'performing' || restoredState === 'conversing' || restoredState === 'deciding')
            ? 'idle'
            : restoredState;
          controller.intentions = (ctrlData as any).intentions ??
            (ctrlData as any).dayPlan?.items?.map((i: any) => i.activity) ?? [];
          controller.currentIntentionIndex = (ctrlData as any).currentIntentionIndex ?? (ctrlData as any).currentPlanIndex ?? 0;
          controller.activityTimer = ctrlData.activityTimer ?? 0;
          controller.conversationCooldown = ctrlData.conversationCooldown ?? 0;
        }

        controller.decisionQueue = this.decisionQueue;
        this.controllers.set(agent.id, controller);
      }

      console.log(`[Engine] Restored ${agents.length} agents from Supabase`);
      this.refreshNameMaps();
    } catch (err) {
      console.error('[Engine] Failed to load from Supabase:', err);
    }
  }

  /** Push agent ID→name mapping to all cognitions so prompts show names, not UUIDs */
  private refreshNameMaps(): void {
    const nameMap = new Map<string, string>();
    for (const agent of this.world.agents.values()) {
      nameMap.set(agent.id, agent.config.name);
    }
    for (const cognition of this.cognitions.values()) {
      cognition.nameMap = nameMap;
    }
  }

  addAgent(config: AgentConfig, wakeHour: number = 7, sleepHour: number = 23, startingCurrency: number = 0, apiKey?: string, model?: string, ownerId?: string): Agent {
    const id = crypto.randomUUID();

    // Pick a random spawn position from public areas
    const spawnArea = SimulationEngine.SPAWN_AREAS[
      Math.floor(Math.random() * SimulationEngine.SPAWN_AREAS.length)
    ];
    const spawnPos = getAreaEntrance(spawnArea);

    const agent: Agent = {
      id,
      config,
      position: { ...spawnPos },
      state: 'idle',
      currentAction: 'arriving',
      currency: startingCurrency,
      createdAt: Date.now(),
      joinedDay: this.world.time.day,
      ownerId: ownerId || 'anonymous',
      mood: 'neutral',
      inventory: [],
      skills: [],
    };

    agent.drives = { survival: 50, safety: 60, belonging: 40, status: 30, meaning: 20 };
    agent.vitals = { health: 100, hunger: 0, energy: 100 };
    agent.alive = true;
    agent.mentalModels = [];
    agent.institutionIds = [];

    this.world.addAgent(agent);

    // Create cognition stack with per-agent API key (falls back to global env)
    const effectiveKey = apiKey || process.env.ANTHROPIC_API_KEY;
    const effectiveModel = model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
    if (effectiveKey) {
      this.agentApiKeys.set(id, { apiKey: effectiveKey, model: effectiveModel });
    }
    const memoryStore = this.persistence
      ? new SupabaseMemoryStore(this.persistence.client)
      : new InMemoryStore();
    const llmProvider = this.getThrottledProvider(effectiveKey || 'dummy-key', effectiveModel);
    const startingParts = buildStartingWorldViewParts(spawnArea);
    const cognition = new AgentCognition(agent, memoryStore, llmProvider, startingParts);
    this.wireTieredMemory(cognition, agent, memoryStore);
    this.cognitions.set(id, cognition);

    // Broadcast spawn AFTER cognition is set so getSnapshot() can enrich with worldView
    agent.worldView = cognition.worldView;
    this.broadcaster.agentSpawn(agent);

    // Create controller (homeArea defaults to 'plaza' — just a fallback sleeping spot)
    const controller = new AgentController(
      agent,
      cognition,
      this.world,
      this.broadcaster,
      wakeHour,
      sleepHour,
      'plaza',
      this.createActionExecutor(),
    );
    controller.onDeath = (agentId, cause) => this.onControllerDeath(agentId, cause);
    controller.bus = this.bus;
    controller.decisionQueue = this.decisionQueue;
    this.controllers.set(id, controller);

    console.log(
      `[Engine] Agent created: ${config.name}${config.occupation ? ' (' + config.occupation + ')' : ''} at ${spawnArea}`,
    );

    // Save agent to Supabase FIRST, then seed memories (FK: memories.agent_id → agents.id)
    const seedMemories = () => {
      // Use soul (rich character text) when backstory is empty
      const identityText = config.soul || config.backstory || '';
      void cognition.addMemory({
        id: crypto.randomUUID(), agentId: id, type: 'reflection',
        content: `I am ${config.name}. ${identityText}`,
        importance: 9, isCore: true, timestamp: Date.now(), relatedAgentIds: [],
      });
      // Seed goal from explicit goal field, or first desire as fallback
      const effectiveGoal = config.goal || (config.desires?.length ? config.desires[0] : '');
      if (effectiveGoal) {
        void cognition.addMemory({
          id: crypto.randomUUID(), agentId: id, type: 'reflection',
          content: `My goal: ${effectiveGoal}`,
          importance: 9, isCore: true, timestamp: Date.now(), relatedAgentIds: [],
        });
      }
      void cognition.addMemory({
        id: crypto.randomUUID(), agentId: id, type: 'observation',
        content: `I just arrived at the ${spawnArea}. I should explore to discover what else is in this village.`,
        importance: 5, timestamp: Date.now(), relatedAgentIds: [],
      });
    };

    if (this.persistence) {
      void this.persistence.saveAll(this.world, this.controllers, this.agentApiKeys)
        .then(() => seedMemories())
        .catch(err => {
          console.error('[Persistence] Save after addAgent failed:', err);
          seedMemories(); // still seed in-memory even if DB fails
        });
    } else {
      seedMemories();
    }

    this.refreshNameMaps();
    return agent;
  }

  removeAgent(id: string): boolean {
    const agent = this.world.getAgent(id);
    if (!agent) return false;

    // Stop controller
    const controller = this.controllers.get(id);
    if (controller) {
      this.controllers.delete(id);
    }

    // Remove cognition, API key, and queued decisions
    this.cognitions.delete(id);
    this.agentApiKeys.delete(id);
    this.decisionQueue.removeAgent(id);

    // Remove from any active conversations
    for (const conv of this.world.getActiveConversations()) {
      if (conv.participants.includes(id)) {
        // End the conversation in world state
        this.world.endConversation(conv.id);
        this.broadcaster.conversationEnd(conv.id);
        // Release other participants
        for (const pid of conv.participants) {
          if (pid !== id) {
            const otherController = this.controllers.get(pid);
            if (otherController) {
              otherController.leaveConversation();
            }
          }
        }
      }
    }

    // Remove from world + grid
    this.world.grid.unregister(id);
    this.world.agents.delete(id);

    // Broadcast leave
    this.broadcaster.agentLeave(id);

    // Delete from Supabase (CASCADE removes controller + memories)
    if (this.persistence) {
      void this.persistence.deleteAgent(id).catch(err =>
        console.error('[Persistence] Delete failed:', err)
      );
    }

    console.log(`[Engine] Agent removed: ${agent.config.name}`);
    return true;
  }

  suspendAgent(id: string): boolean {
    const agent = this.world.getAgent(id);
    if (!agent || agent.alive === false || agent.state === 'away') return false;

    // End any active conversations
    for (const conv of this.world.getActiveConversations()) {
      if (conv.participants.includes(id)) {
        this.world.endConversation(conv.id);
        this.broadcaster.conversationEnd(conv.id);
        for (const pid of conv.participants) {
          if (pid !== id) {
            const otherController = this.controllers.get(pid);
            if (otherController) otherController.leaveConversation();
          }
        }
      }
    }

    // Remove controller + cognition (stops LLM calls)
    this.controllers.delete(id);
    this.cognitions.delete(id);

    // Set state to away — agent stays in world.agents + agentApiKeys
    agent.state = 'away';
    agent.currentAction = 'away from village';
    this.world.updateAgentState(id, 'away', 'away from village');
    this.broadcaster.agentAction(id, 'left the village');

    console.log(`[Engine] Agent suspended: ${agent.config.name}`);

    if (this.persistence) {
      void this.persistence.saveAll(this.world, this.controllers, this.agentApiKeys).catch(err =>
        console.error('[Persistence] Save after suspend failed:', err)
      );
    }

    return true;
  }

  resumeAgent(id: string): boolean {
    const agent = this.world.getAgent(id);
    if (!agent || agent.state !== 'away') return false;

    // Recreate cognition
    const keyData = this.agentApiKeys.get(id);
    const effectiveKey = keyData?.apiKey || process.env.ANTHROPIC_API_KEY || 'dummy-key';
    const effectiveModel = keyData?.model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

    const memoryStore = this.persistence
      ? new SupabaseMemoryStore(this.persistence.client)
      : new InMemoryStore();
    const llmProvider = this.getThrottledProvider(effectiveKey, effectiveModel);
    // Preserve worldViewParts from old cognition if available
    const oldCognition = this.cognitions.get(id);
    const cognition = new AgentCognition(agent, memoryStore, llmProvider, oldCognition?.worldViewParts);
    this.wireTieredMemory(cognition, agent, memoryStore);
    this.cognitions.set(id, cognition);

    // Recreate controller with default wake/sleep hours
    const controller = new AgentController(
      agent,
      cognition,
      this.world,
      this.broadcaster,
      7,
      23,
      'plaza',
      this.createActionExecutor(),
    );
    controller.onDeath = (agentId, cause) => this.onControllerDeath(agentId, cause);
    controller.bus = this.bus;
    controller.decisionQueue = this.decisionQueue;
    this.controllers.set(id, controller);

    // Set state to idle and place at plaza
    agent.state = 'idle';
    agent.currentAction = 'returning to village';
    this.world.updateAgentState(id, 'idle', 'returning to village');

    const spawnPos = getAreaEntrance('plaza');
    this.world.updateAgentPosition(id, spawnPos);
    agent.position = { ...spawnPos };

    this.broadcaster.agentAction(id, 'returned to village');

    console.log(`[Engine] Agent resumed: ${agent.config.name}`);

    if (this.persistence) {
      void this.persistence.saveAll(this.world, this.controllers, this.agentApiKeys).catch(err =>
        console.error('[Persistence] Save after resume failed:', err)
      );
    }

    return true;
  }

  resetAgentVitals(id: string): boolean {
    const agent = this.world.getAgent(id);
    if (!agent || agent.alive === false) return false;

    agent.vitals = { health: 100, hunger: 0, energy: 100 };
    this.broadcaster.agentAction(id, 'vitals reset');
    console.log(`[Engine] Agent vitals reset: ${agent.config.name}`);
    return true;
  }

  resurrectAgent(id: string): boolean {
    const agent = this.world.getAgent(id);
    if (!agent || agent.alive !== false) return false;

    // Revive agent state
    agent.alive = true;
    agent.causeOfDeath = undefined;
    agent.state = 'idle';
    agent.vitals = { health: 100, hunger: 0, energy: 100 };
    agent.drives = { survival: 50, safety: 60, belonging: 40, status: 30, meaning: 20 };

    // Give starting food so they don't immediately starve again
    for (let i = 0; i < 3; i++) {
      this.world.addItem({
        id: crypto.randomUUID(),
        name: 'bread',
        description: 'A loaf of bread',
        ownerId: id,
        createdBy: 'system',
        value: 5,
        type: 'food',
      });
    }

    // Recreate cognition
    const keyData = this.agentApiKeys.get(id);
    const effectiveKey = keyData?.apiKey || process.env.ANTHROPIC_API_KEY || 'dummy-key';
    const effectiveModel = keyData?.model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

    const memoryStore = this.persistence
      ? new SupabaseMemoryStore(this.persistence.client)
      : new InMemoryStore();
    const llmProvider = this.getThrottledProvider(effectiveKey, effectiveModel);
    // Preserve worldViewParts — resurrection keeps knowledge
    const oldCognition = this.cognitions.get(id);
    const cognition = new AgentCognition(agent, memoryStore, llmProvider, oldCognition?.worldViewParts);
    this.wireTieredMemory(cognition, agent, memoryStore);
    this.cognitions.set(id, cognition);

    // Recreate controller
    const controller = new AgentController(
      agent,
      cognition,
      this.world,
      this.broadcaster,
      7,
      23,
      'plaza',
      this.createActionExecutor(),
    );
    controller.onDeath = (agentId, cause) => this.onControllerDeath(agentId, cause);
    controller.bus = this.bus;
    controller.decisionQueue = this.decisionQueue;
    this.controllers.set(id, controller);

    // Place at plaza
    const spawnPos = getAreaEntrance('plaza');
    this.world.updateAgentPosition(id, spawnPos);
    agent.position = { ...spawnPos };
    agent.currentAction = 'resurrected';
    this.world.updateAgentState(id, 'idle', 'resurrected');

    this.broadcaster.agentAction(id, 'has been resurrected', '\u2728');

    // Remove stale death notices from board so agents don't obsess over "iterations of death"
    const agentName = agent.config.name;
    const deathPostIndices: number[] = [];
    for (let i = 0; i < this.world.board.length; i++) {
      const post = this.world.board[i];
      if (post.authorId === 'system' && post.content.includes(agentName) && post.content.includes('died')) {
        deathPostIndices.push(i);
      }
    }
    // Remove in reverse order to preserve indices
    for (let i = deathPostIndices.length - 1; i >= 0; i--) {
      this.world.board.splice(deathPostIndices[i], 1);
    }
    if (deathPostIndices.length > 0) {
      // Post recovery notice
      this.world.addBoardPost({
        id: crypto.randomUUID(),
        authorId: 'system',
        authorName: 'Village Notice',
        type: 'announcement' as BoardPostType,
        content: `${agentName} has recovered and returned to the village.`,
        timestamp: Date.now(),
        day: this.world.time.day,
      });
      this.broadcaster.boardPost(this.world.board[this.world.board.length - 1]);
      console.log(`[Engine] Removed ${deathPostIndices.length} death notice(s) for ${agentName}`);
    }

    console.log(`[Engine] Agent resurrected: ${agent.config.name}`);

    this.refreshNameMaps();

    if (this.persistence) {
      void this.persistence.saveAll(this.world, this.controllers, this.agentApiKeys).catch(err =>
        console.error('[Persistence] Save after resurrect failed:', err)
      );
    }

    return true;
  }

  resurrectAllAgents(): string[] {
    const resurrected: string[] = [];
    for (const agent of this.world.agents.values()) {
      if (agent.alive === false) {
        if (this.resurrectAgent(agent.id)) {
          resurrected.push(agent.config.name);
        }
      }
    }
    return resurrected;
  }

  start(): void {
    if (this.tickInterval) return;

    this.tickInterval = setInterval(() => {
      this.tick();
    }, 83); // 12x speed: 1 game minute = 83ms real time (~3x previous)

    // Infra 3: Decision queue processing loop — dequeue and execute cold-path LLM calls
    this.decisionInterval = setInterval(() => {
      const decision = this.decisionQueue.dequeue();
      if (!decision) return;
      const ctrl = this.controllers.get(decision.agentId);
      if (!ctrl || ctrl.apiExhausted) {
        this.decisionQueue.complete(decision.agentId);
        return;
      }
      ctrl.executeQueuedDecision(decision.type, decision.context)
        .finally(() => this.decisionQueue.complete(decision.agentId));
    }, 50);

    console.log('[Engine] Simulation started');
  }

  /** Pause the tick loop without saving state (for dev tools). */
  pause(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    if (this.decisionInterval) {
      clearInterval(this.decisionInterval);
      this.decisionInterval = null;
    }
    console.log('[Engine] Simulation paused');
  }

  /** Execute a single tick (for dev step-through). Only works when paused. */
  singleTick(): void {
    if (!this.tickInterval) {
      this.tick();
    }
  }

  async stop(): Promise<void> {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    if (this.decisionInterval) {
      clearInterval(this.decisionInterval);
      this.decisionInterval = null;
    }
    if (this.persistence) {
      try {
        await this.persistence.saveAll(this.world, this.controllers, this.agentApiKeys);
        console.log('[Engine] Final state saved to Supabase');
      } catch (err) {
        console.error('[Engine] Final save failed:', err);
      }
    }
    console.log('[Engine] Simulation stopped');
  }

  private tick(): void {
    this.tickCount++;
    // Advance game clock every 2 ticks (2x slower days)
    if (this.tickCount % 2 === 0) {
      this.world.advanceTime();
    }
    const time = this.world.time;

    // --- Emit clock events (subscribers handle the rest) ---

    if (time.hour === 0 && time.minute === 0) {
      this.bus.emit({ type: 'midnight', day: time.day });
    }

    if (time.minute === 0) {
      this.bus.emit({ type: 'hour_changed', hour: time.hour, day: time.day });
    }

    // Broadcast time to clients every 15 game minutes
    if (time.minute % 15 === 0) {
      this.broadcaster.worldTime(time);
    }

    // Core tick: controllers + proximity + conversations (via bus subscribers)
    this.bus.emit({ type: 'tick', time });

    // Perception every 120 ticks
    if (this.tickCount % 120 === 0) {
      this.bus.emit({ type: 'perception_cycle', tick: this.tickCount });
    }

    // --- Direct calls for subsystems with complex timing ---

    if (this.tickCount % 10 === 0) this.checkOverhearing();
    this.checkElections();

    if (this.tickCount % 600 === 0) {
      this.updateWeather();
    }

    if (this.tickCount % 1440 === 0) {
      this.checkSeasonAdvance();
      this.weatherDamageBuildings();
    }

    // Auto weekly summary — every 120 ticks (~2 game hours)
    if (this.tickCount % 120 === 0 && time.day >= 7 && time.day - this.lastWeeklySummaryDay >= 7 && !this.weeklySummaryGenerating) {
      console.log(`[WeeklySummary] Triggering for Day ${time.day} (last: ${this.lastWeeklySummaryDay})`);
      this.weeklySummaryGenerating = true;
      void this.generateWeeklySummary().then(summary => {
        if (summary) {
          this.cachedWeeklySummary = summary;
          this.lastWeeklySummaryDay = time.day;
          this.io.emit('weekly-summary:ready', { summary });
          console.log(`[WeeklySummary] Generated for Day ${time.day} (${summary.length} chars)`);
        } else {
          console.log(`[WeeklySummary] Returned null — no API key or empty response`);
        }
        this.weeklySummaryGenerating = false;
      }).catch(err => {
        console.error(`[WeeklySummary] Failed:`, err);
        this.weeklySummaryGenerating = false;
      });
    }

    // Periodic save every 300 ticks
    if (this.tickCount % 300 === 0) {
      this.bus.emit({ type: 'save_requested' });
    }
  }

  /** Freedom 5: Decay world objects not interacted with for 7 game-days */
  private decayWorldObjects(): void {
    const DECAY_MINUTES = 7 * 24 * 60;
    for (const [id, obj] of this.world.worldObjects) {
      if (this.world.time.totalMinutes - obj.lastInteractedAt > DECAY_MINUTES) {
        this.world.removeWorldObject(id);
        console.log(`[Engine] WorldObject decayed: "${obj.name}" (no interaction for 7 days)`);
      }
    }
  }

  /**
   * Fire-and-forget perception for all awake agents.
   * Agents observe nearby agents and areas, storing observations as memories.
   */
  private runPerception(): void {
    for (const [agentId, cognition] of this.cognitions.entries()) {
      const agent = this.world.getAgent(agentId);
      if (!agent || agent.state === 'sleeping' || agent.alive === false) continue;
      const ctrl = this.controllers.get(agentId);
      if (ctrl?.apiExhausted) continue;

      const nearby = this.world.getNearbyAgents(agent.position, 5)
        .filter(a => a.id !== agentId);
      const nearbyAreas = AREAS.filter(area => {
        const cx = area.bounds.x + area.bounds.width / 2;
        const cy = area.bounds.y + area.bounds.height / 2;
        const dx = agent.position.x - cx;
        const dy = agent.position.y - cy;
        return Math.sqrt(dx * dx + dy * dy) < 6;
      });

      // Freedom 1: include world objects at nearby areas
      const nearbyWorldObjects: { name: string; description: string; creatorName: string }[] = [];
      for (const area of nearbyAreas) {
        for (const obj of this.world.getWorldObjectsAt(area.id)) {
          nearbyWorldObjects.push({ name: obj.name, description: obj.description, creatorName: obj.creatorName });
        }
      }
      // Freedom 5: collect cultural names for nearby areas
      const culturalNames = new Map<string, string>();
      for (const area of nearbyAreas) {
        const cName = this.world.getCulturalName(area.id);
        if (cName) culturalNames.set(area.id, cName);
      }
      void cognition.perceive(
        nearby, nearbyAreas,
        nearbyWorldObjects.length > 0 ? nearbyWorldObjects : undefined,
        culturalNames.size > 0 ? culturalNames : undefined,
      ).catch(() => {});
    }
  }

  private checkProximityConversations(): void {
    const agents = Array.from(this.world.agents.values());

    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        const a1 = agents[i];
        const a2 = agents[j];

        // Check distance (within 3 tiles — close enough to visually see the connection)
        const dx = a1.position.x - a2.position.x;
        const dy = a1.position.y - a2.position.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > 3) continue;

        // Skip dead or away agents
        if (a1.alive === false || a2.alive === false) continue;
        if (a1.state === 'away' || a2.state === 'away') continue;

        // Check conversation pair cooldown (1800 ticks ≈ allows ~2 conversations per pair per day)
        const pairKey = [a1.id, a2.id].sort().join(':');
        const lastTick = this.lastConversationPair.get(pairKey);
        if (lastTick !== undefined && (this.tickCount - lastTick) < 1800) continue;

        // Check if both are available (not sleeping, conversing, or API exhausted)
        const c1 = this.controllers.get(a1.id);
        const c2 = this.controllers.get(a2.id);
        if (!c1 || !c2) continue;
        if (!c1.isAvailable || !c2.isAvailable) continue;
        if (c1.apiExhausted || c2.apiExhausted) continue;

        // Check not already in conversation
        if (
          this.conversationManager.isInConversation(a1.id) ||
          this.conversationManager.isInConversation(a2.id)
        ) {
          continue;
        }

        // Intentional: one agent specifically planned to talk to the other
        const c1WantsC2 = c1.pendingConversationTarget === a2.id;
        const c2WantsC1 = c2.pendingConversationTarget === a1.id;

        // Intentional conversation: one agent specifically planned to talk to the other
        if (c1WantsC2 || c2WantsC1) {
          const location = { ...a1.position };
          const purpose = c1WantsC2 ? c1.pendingConversationPurpose : c2.pendingConversationPurpose;
          this.conversationManager.startConversation(a1.id, a2.id, location, purpose ?? undefined);
          this.lastConversationPair.set(pairKey, this.tickCount);
          c1.enterConversation();
          c2.enterConversation();
          console.log(`[Engine] Intentional conversation: ${a1.config.name} <-> ${a2.config.name}${purpose ? ` (purpose: "${purpose.substring(0, 40)}")` : ''}`);
          return;
        }

      }
    }
  }

  private advanceConversations(): void {
    const activeConversations = this.world.getActiveConversations();

    for (const conv of activeConversations) {
      if (!this.conversationManager.isInConversation(conv.participants[0])) continue;

      void this.conversationManager
        .advanceTurn(conv.id, this.cognitions)
        .then((continuing: boolean) => {
          if (!continuing) {
            // Release agents from conversation
            for (const pid of conv.participants) {
              const controller = this.controllers.get(pid);
              if (controller) {
                controller.leaveConversation();
              }
            }
          }
        })
        .catch((err: unknown) => {
          console.error('[Engine] Error advancing conversation:', err);
          // Release agents on error
          for (const pid of conv.participants) {
            const controller = this.controllers.get(pid);
            if (controller) {
              controller.leaveConversation();
            }
          }
        });
    }
  }

  /**
   * Check if nearby agents can overhear an active conversation.
   * Agents within 5 tiles who are not in the conversation get a snippet.
   */
  private checkOverhearing(): void {
    const activeConversations = this.world.getActiveConversations();

    for (const conv of activeConversations) {
      if (conv.messages.length === 0) continue;

      const lastMessage = conv.messages[conv.messages.length - 1];
      const snippet = lastMessage.content.substring(0, 60);

      // Find agents within 5 tiles of conversation location, not in the conversation
      const nearby = this.world.getNearbyAgents(conv.location, 5);
      for (const agent of nearby) {
        if (conv.participants.includes(agent.id)) continue;
        if (agent.state === 'sleeping') continue;
        if (this.conversationManager.isInConversation(agent.id)) continue;

        const cognition = this.cognitions.get(agent.id);
        if (!cognition) continue;

        // Store overheard snippet as a memory
        void cognition.addMemory({
          id: crypto.randomUUID(),
          agentId: agent.id,
          type: 'observation',
          content: `I overheard ${lastMessage.agentName} say: "${snippet}..."`,
          importance: 5,
          timestamp: Date.now(),
          relatedAgentIds: conv.participants,
        }).catch(() => {});

        // think()-driven overhear decision (one think per agent per conversation, with cooldown)
        const controller = this.controllers.get(agent.id);
        if (controller?.isAvailable && !controller.apiExhausted) {
          const cognition = this.cognitions.get(agent.id);
          if (cognition) {
            void cognition.think(
              `overheard ${lastMessage.agentName} say: "${snippet}"`,
              `You weren't part of the conversation — you just caught a snippet.`
            ).then(output => {
              const joinActions = output.actions?.some(a => {
                const lower = a.toLowerCase();
                return lower.includes('approach') || lower.includes('join') || lower.includes('confront');
              });
              if (joinActions && controller.isAvailable) {
                this.conversationManager.addParticipant(conv.id, agent.id);
                controller.enterConversation();
                console.log(`[Engine] ${agent.config.name} overheard and decided to join conversation`);
              }
            }).catch(() => {});
          }
        }
      }
    }
  }

  /**
   * Check if any election's endDay has been reached and resolve it.
   */
  private checkElections(): void {
    for (const election of this.world.elections.values()) {
      if (election.active && election.endDay <= this.world.time.day) {
        const resolved = this.world.resolveElection(election.id);
        if (resolved) {
          this.broadcaster.electionUpdate(resolved);
          const winner = resolved.winner ? this.world.getAgent(resolved.winner) : undefined;
          console.log(
            `[Engine] Election for ${resolved.position} resolved — winner: ${winner?.config.name ?? 'none'}`,
          );
        }
      }
    }
  }

  private updateWeather(): void {
    // Weather must persist for at least 300 ticks before it can change
    if (this.tickCount < this.weatherStableUntil) return;

    const oldWeather = this.world.weather.current;
    const newWeather = this.world.updateWeather();
    if (newWeather !== oldWeather) {
      this.weatherStableUntil = this.tickCount + 300;
      this.broadcaster.weatherChange(this.world.weather);
      console.log(`[Engine] Weather changed: ${oldWeather} → ${newWeather} (${this.world.weather.season})`);
    }
  }

  private checkSeasonAdvance(): void {
    this.world.weather.seasonDay++;
    if (this.world.weather.seasonDay >= 30) {
      this.world.advanceSeason();
      this.broadcaster.weatherChange(this.world.weather);
      console.log(`[Engine] Season changed to ${this.world.weather.season}`);

      const season = this.world.weather.season;
      const seasonDef = SEASONS[season];

      // Board post — agents see this in plan context
      this.world.addBoardPost({
        id: crypto.randomUUID(),
        authorId: 'system',
        authorName: 'Village Notice',
        type: 'announcement' as BoardPostType,
        content: `The season has changed to ${season}. ${seasonDef.description}`,
        timestamp: Date.now(),
        day: this.world.time.day,
      });
      this.broadcaster.boardPost(this.world.board[this.world.board.length - 1]);

      // Inject memory into all living agents
      for (const [id, cognition] of this.cognitions) {
        const agent = this.world.getAgent(id);
        if (!agent || agent.alive === false) continue;
        void cognition.addMemory({
          id: crypto.randomUUID(),
          agentId: id,
          type: 'observation',
          content: `The season changed to ${season}. ${seasonDef.description}`,
          importance: 8,
          timestamp: Date.now(),
          relatedAgentIds: [],
        });
      }
    }
  }

  private weatherDamageBuildings(): void {
    const weather = this.world.weather.current;
    if (weather !== 'storm' && weather !== 'snow') return;

    const damage = weather === 'storm' ? 5 : 2;
    for (const building of this.world.buildings.values()) {
      const updated = this.world.damageBuilding(building.id, damage);
      if (updated) {
        this.broadcaster.buildingUpdate(updated);
        if (updated.durability <= 0) {
          console.log(`[Engine] Building collapsed: ${updated.name}`);
        }
      }
    }
  }

  /**
   * Called by controller onDeath callback — controller already handled world state + broadcast.
   * We handle cleanup (remove controller/cognition) and aftermath (diary + notify agents).
   */
  private onControllerDeath(agentId: string, cause: string): void {
    const agent = this.world.getAgent(agentId);
    if (!agent) return;

    // Cleanup
    this.controllers.delete(agentId);
    this.cognitions.delete(agentId);

    this.handleDeathAftermath(agent, cause);
  }

  killAgent(agentId: string, cause: string): void {
    const agent = this.world.getAgent(agentId);
    if (!agent || agent.alive === false) return;

    const droppedItems = this.world.killAgent(agentId, cause);

    // Stop controller
    this.controllers.delete(agentId);
    this.cognitions.delete(agentId);

    // Broadcast death
    this.broadcaster.agentDeath(agentId, cause);

    this.handleDeathAftermath(agent, cause);
  }

  /**
   * Called after an agent dies — creates diary, board post, and notifies all living agents.
   * Separated so both killAgent() and the controller onDeath callback can use it.
   */
  private handleDeathAftermath(agent: Agent, cause: string): void {
    const agentId = agent.id;
    const name = agent.config.name;
    const areaId = this.world.getAreaAt(agent.position)?.id;
    const areaLabel = areaId?.replace(/_/g, ' ') ?? 'the village';

    // Create diary artifact (their final legacy)
    const artifact = {
      id: crypto.randomUUID(),
      title: `Diary of ${name}`,
      content: `${name}${agent.config.occupation ? ', ' + agent.config.occupation + ',' : ''} lived ${this.world.time.day} days in the village. They died of ${cause}. They had ${agent.currency} gold and ${agent.skills.length} skills.`,
      type: 'diary' as const,
      creatorId: agentId,
      creatorName: name,
      location: areaId,
      visibility: 'public' as const,
      reactions: [],
      createdAt: Date.now(),
      day: this.world.time.day,
    };
    this.world.addArtifact(artifact);
    this.broadcaster.artifactCreated(artifact);

    // Post death notice to village board so agents see it in conversation prompts
    this.world.addBoardPost({
      id: crypto.randomUUID(),
      authorId: 'system',
      authorName: 'Village Notice',
      type: 'announcement' as BoardPostType,
      content: `${name} has died of ${cause} at ${areaLabel}. May they rest in peace.`,
      timestamp: Date.now(),
      day: this.world.time.day,
    });
    this.broadcaster.boardPost(this.world.board[this.world.board.length - 1]);

    // Create a memory for every living agent so they know about the death
    for (const [id, cognition] of this.cognitions) {
      if (id === agentId) continue;
      const livingAgent = this.world.getAgent(id);
      if (!livingAgent || livingAgent.alive === false) continue;

      void cognition.addMemory({
        id: crypto.randomUUID(),
        agentId: id,
        type: 'observation',
        content: `${name} died of ${cause} at ${areaLabel} on day ${this.world.time.day}. Their belongings were scattered on the ground.`,
        importance: 9,
        timestamp: Date.now(),
        relatedAgentIds: [agentId],
      });
    }

    console.log(`[Engine] ${name} has died: ${cause}. Diary created, all agents notified.`);
  }

  getSnapshot(): WorldSnapshot {
    const snapshot = this.world.getSnapshot();
    // Enrich agents with worldView from cognition
    for (const agent of snapshot.agents) {
      const cognition = this.cognitions.get(agent.id);
      if (cognition) {
        agent.worldView = cognition.worldView;
      }
    }
    snapshot.narratives = this.narrator.getRecentNarratives();
    snapshot.storylines = this.storylineDetector.getStorylines();
    snapshot.weeklySummary = this.cachedWeeklySummary;
    return snapshot;
  }

  /** Infra 6: Get agents visible in a client's viewport (for catch-up on scroll) */
  getViewportCatchup(socketId: string): { id: string; position: { x: number; y: number }; state: string; currentAction: string; mood: string; config: any }[] {
    const ids = this.viewportManager.getVisibleAgents(socketId, this.world.grid);
    return ids
      .map(id => this.world.getAgent(id))
      .filter((a): a is NonNullable<typeof a> => !!a && a.alive !== false)
      .map(a => ({
        id: a.id,
        position: a.position,
        state: a.state,
        currentAction: a.currentAction,
        mood: a.mood ?? 'neutral',
        config: a.config,
      }));
  }

  getCharacterTimeline(agentId: string, limit?: number) {
    return this.characterTimeline.getTimeline(agentId, limit);
  }

  async generateThoughtFor(agentId: string): Promise<string | null> {
    const controller = this.controllers.get(agentId);
    if (!controller || controller.apiExhausted) return null;
    const agent = this.world.getAgent(agentId);
    if (!agent || agent.alive === false || agent.state === 'sleeping') return null;

    const cognition = this.cognitions.get(agentId);
    if (!cognition) return null;

    try {
      const output = await cognition.think(
        `reflecting on what I'm doing`,
        `Currently: ${agent.currentAction || 'idle'}. Mood: ${agent.mood}. Location: ${agent.state}.`
      );
      return output.thought || null;
    } catch {
      return null;
    }
  }

  async generateWeeklySummary(): Promise<string | null> {
    const time = this.world.time;
    const weekStart = Math.max(0, time.day - 7);

    // Gather data sources
    const agents = Array.from(this.world.agents.values()).filter(a => a.alive !== false);
    const narratives = this.narrator.getRecentNarratives();
    const storylines = this.storylineDetector.getStorylines();

    // Agent status
    const agentSummaries = agents.map(a => {
      const timeline = this.characterTimeline.getTimeline(a.id, 10);
      const recentActions = timeline.map(e => e.description).join('; ');
      const models = a.mentalModels?.map(m => `${m.targetId}: trust ${m.trust}, feels ${m.emotionalStance}`).join('; ') || 'none';
      return `${a.config.name} (mood: ${a.mood ?? 'neutral'}): ${recentActions || 'quiet week'}. Relationships: ${models}`;
    }).join('\n');

    // Narratives
    const narrativeDump = narratives
      .filter(n => n.gameDay >= weekStart)
      .map(n => `Day ${n.gameDay}: ${n.content}`)
      .join('\n') || 'No narrator entries this week.';

    // Storylines
    const storylineDump = storylines
      .map(s => `"${s.title}" (${s.status}): ${s.summary}`)
      .join('\n') || 'No storylines detected.';

    const globalKey = process.env.ANTHROPIC_API_KEY;
    if (!globalKey) return null;

    // Always use Haiku for cost efficiency
    const llm = this.getThrottledProvider(globalKey, 'claude-haiku-4-5-20251001');

    try {
      const summary = await llm.complete(
        `You are a weekly newspaper editor for a small AI village reality show. Write a compelling weekly recap of Days ${weekStart}-${time.day}. Use agent names. Be dramatic but factual. 3-5 paragraphs. Highlight key events, relationship changes, conflicts, and character development.`,
        `AGENT STATUS:\n${agentSummaries}\n\nNARRATOR LOG:\n${narrativeDump}\n\nSTORYLINES:\n${storylineDump}\n\nCurrent: Day ${time.day}, ${time.hour}:00, ${this.world.weather.season}, ${this.world.weather.current}\n\nWrite the weekly summary:`
      );
      return summary;
    } catch (err) {
      console.error('[Engine] Failed to generate weekly summary:', err);
      return null;
    }
  }

  /**
   * Get or create a throttled LLM provider for a given API key.
   * All agents sharing the same key share the same concurrency limit.
   */
  private getThrottledProvider(apiKey: string, model: string): ThrottledProvider {
    const cacheKey = `${apiKey}:${model}`;
    let throttled = this.throttles.get(cacheKey);
    if (!throttled) {
      const inner = new AnthropicProvider(apiKey, model);
      throttled = new ThrottledProvider(inner, SimulationEngine.MAX_CONCURRENT_LLM);
      this.throttles.set(cacheKey, throttled);
    }
    return throttled;
  }

  /** Infra 5: Wire tiered memory onto a cognition instance */
  private wireTieredMemory(cognition: AgentCognition, agent: Agent, memoryStore: import('@ai-village/ai-engine').MemoryStore): void {
    const tiered = new TieredMemory(agent.id, memoryStore);
    tiered.seedIdentity(agent.config);
    cognition.tieredMemory = tiered;
  }

  private createActionExecutor() {
    const requestConv = (initiatorId: string, targetId: string): boolean => {
        // Block self-conversations
        if (initiatorId === targetId) return false;
        const c1 = this.controllers.get(initiatorId);
        const c2 = this.controllers.get(targetId);
        if (!c1 || !c2) return false;
        if (!c2.isAvailable) return false;
        if (c1.apiExhausted || c2.apiExhausted) return false;
        if (this.conversationManager.isInConversation(initiatorId) ||
            this.conversationManager.isInConversation(targetId)) return false;

        // Check pair cooldown
        const pairKey = [initiatorId, targetId].sort().join(':');
        const lastTick = this.lastConversationPair.get(pairKey);
        if (lastTick !== undefined && (this.tickCount - lastTick) < 3600) return false;

        const a1 = this.world.getAgent(initiatorId);
        if (!a1) return false;

        const purpose = c1.pendingConversationPurpose ?? undefined;
        const convId = this.conversationManager.startConversation(initiatorId, targetId, { ...a1.position }, purpose);
        this.lastConversationPair.set(pairKey, this.tickCount);
        c1.enterConversation();
        c2.enterConversation();
        console.log(`[Engine] Intentional conversation: ${a1.config.name} sought out ${this.world.getAgent(targetId)?.config.name}${purpose ? ` (purpose: "${purpose.substring(0, 40)}")` : ''}`);
        return true;
    };
    // Wire requestConversation so conversation [ACTION:] tags can trigger interactions
    this.conversationManager.setRequestConversation(requestConv);
    return {
      executeSocialAction: (actorId: string, actorName: string, targetId: string, action: string, cognition: AgentCognition) => {
        void this.conversationManager.executeSocialAction(
          actorId, actorName, targetId, action, cognition,
          this.cognitions,
          requestConv,
        ).then((outcomeDesc: string) => {
          const controller = this.controllers.get(actorId);
          if (controller) controller.lastOutcomeDescription = outcomeDesc;
        });
      },
      requestConversation: requestConv,
    };
  }

  updateAgentApiKey(agentId: string, newApiKey: string, newModel: string): boolean {
    const agent = this.world.getAgent(agentId);
    if (!agent || agent.alive === false) return false;

    // Update stored key
    this.agentApiKeys.set(agentId, { apiKey: newApiKey, model: newModel });

    // Create new provider and cognition — preserve worldViewParts
    const llmProvider = this.getThrottledProvider(newApiKey, newModel);
    const memoryStore = this.persistence
      ? new SupabaseMemoryStore(this.persistence.client)
      : new InMemoryStore();
    const oldCognition = this.cognitions.get(agentId);
    const cognition = new AgentCognition(agent, memoryStore, llmProvider, oldCognition?.worldViewParts);
    this.wireTieredMemory(cognition, agent, memoryStore);
    this.cognitions.set(agentId, cognition);

    // Reset controller's API state
    const controller = this.controllers.get(agentId);
    if (controller) {
      controller.resetApiState(cognition);
    }

    // If agent was away, resume them
    if (agent.state === 'away') {
      this.resumeAgent(agentId);
    }

    // Save to persistence
    if (this.persistence) {
      void this.persistence.saveAll(this.world, this.controllers, this.agentApiKeys).catch(err =>
        console.error('[Persistence] Save after API key update failed:', err)
      );
    }

    console.log(`[Engine] API key updated for ${agent.config.name} (model: ${newModel})`);
    return true;
  }

  /**
   * Fresh start: wipe memories + world state, reset agents to day-1 state.
   * Keeps agents (same configs, same API keys) but erases all accumulated state.
   */
  async freshStart(): Promise<void> {
    const wasRunning = this.isRunning;
    this.pause();
    console.log('[Engine] Fresh start — wiping world state and memories');

    // 1. Wipe Supabase data (memories, world_state, agent_controllers) but keep agent rows
    if (this.persistence) {
      // Delete all memories
      const { error: memErr } = await this.persistence.client
        .from('memories')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000'); // delete all rows
      if (memErr) console.error('[FreshStart] Failed to delete memories:', memErr.message);
      else console.log('[FreshStart] All memories deleted');

      // Reset world state to empty
      const { error: wsErr } = await this.persistence.client
        .from('world_state')
        .upsert({ id: 'current', data: {}, updated_at: new Date().toISOString() });
      if (wsErr) console.error('[FreshStart] Failed to reset world_state:', wsErr.message);

      // Delete agent controllers (will be recreated)
      const { error: ctrlErr } = await this.persistence.client
        .from('agent_controllers')
        .delete()
        .neq('agent_id', '00000000-0000-0000-0000-000000000000');
      if (ctrlErr) console.error('[FreshStart] Failed to delete controllers:', ctrlErr.message);
    }

    // 2. Reset world to day 1
    this.world.time = { day: 1, hour: 5, minute: 0, totalMinutes: 5 * 60 };
    this.world.weather = { current: 'clear', season: 'spring', temperature: 50, seasonDay: 0 };
    this.world.board = [];
    this.world.conversations.clear();
    this.world.elections.clear();
    this.world.properties.clear();
    this.world.reputation = [];
    this.world.secrets = [];
    this.world.items.clear();
    this.world.institutions.clear();
    this.world.artifacts = [];
    this.world.buildings.clear();
    this.world.technologies = [];
    this.world.worldObjects.clear();
    this.world.culturalNames.clear();
    this.world.resourcePools.clear();
    this.world.dailyGatherCounts.clear();
    this.world.activeBuildProjects.clear();
    this.world.pendingTrades.clear();
    for (const spawn of this.world.materialSpawns) {
      spawn.lastGathered = undefined;
    }

    // 3. Reset each agent to fresh state, recreate cognition + controller
    this.controllers.clear();
    this.cognitions.clear();
    this.lastConversationPair.clear();
    this.tickCount = 0;

    const sharedMemoryStore = this.persistence
      ? new SupabaseMemoryStore(this.persistence.client)
      : new InMemoryStore();

    for (const agent of this.world.agents.values()) {
      // Reset agent state
      const spawnArea = SimulationEngine.SPAWN_AREAS[
        Math.floor(Math.random() * SimulationEngine.SPAWN_AREAS.length)
      ];
      const spawnPos = getAreaEntrance(spawnArea);
      agent.position = { ...spawnPos };
      agent.state = 'idle';
      agent.currentAction = 'arriving';
      agent.vitals = { health: 100, hunger: 0, energy: 100 };
      agent.drives = { survival: 50, safety: 60, belonging: 40, status: 30, meaning: 20 };
      agent.alive = true;
      agent.causeOfDeath = undefined;
      agent.mood = 'neutral';
      agent.inventory = [];
      agent.skills = [];
      agent.mentalModels = [];
      agent.institutionIds = [];
      agent.joinedDay = 1;

      // Recreate cognition with fresh worldView
      const keyData = this.agentApiKeys.get(agent.id);
      const effectiveKey = keyData?.apiKey || process.env.ANTHROPIC_API_KEY || 'dummy-key';
      const effectiveModel = keyData?.model || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
      const llmProvider = this.getThrottledProvider(effectiveKey, effectiveModel);
      const startingParts = buildStartingWorldViewParts(spawnArea);
      const cognition = new AgentCognition(agent, sharedMemoryStore, llmProvider, startingParts);
      this.wireTieredMemory(cognition, agent, sharedMemoryStore);
      this.cognitions.set(agent.id, cognition);

      // Seed identity memories
      const identityText = agent.config.soul || agent.config.backstory || '';
      void cognition.addMemory({
        id: crypto.randomUUID(), agentId: agent.id, type: 'reflection',
        content: `I am ${agent.config.name}. ${identityText}`,
        importance: 9, isCore: true, timestamp: Date.now(), relatedAgentIds: [],
      });
      const effectiveGoal = agent.config.goal || (agent.config.desires?.length ? agent.config.desires[0] : '');
      if (effectiveGoal) {
        void cognition.addMemory({
          id: crypto.randomUUID(), agentId: agent.id, type: 'reflection',
          content: `My goal: ${effectiveGoal}`,
          importance: 9, isCore: true, timestamp: Date.now(), relatedAgentIds: [],
        });
      }
      void cognition.addMemory({
        id: crypto.randomUUID(), agentId: agent.id, type: 'observation',
        content: `I just arrived at the ${spawnArea}. I should explore to discover what else is in this village.`,
        importance: 5, timestamp: Date.now(), relatedAgentIds: [],
      });

      // Create fresh controller
      const controller = new AgentController(
        agent, cognition, this.world, this.broadcaster, 7, 23, 'plaza',
        this.createActionExecutor(),
      );
      controller.onDeath = (id, cause) => this.onControllerDeath(id, cause);
      controller.bus = this.bus;
      controller.decisionQueue = this.decisionQueue;
      this.controllers.set(agent.id, controller);

      console.log(`[FreshStart] Agent ${agent.config.name} reset at ${spawnArea}`);
    }

    this.refreshNameMaps();

    // 4. Save fresh state to Supabase
    if (this.persistence) {
      try {
        await this.persistence.saveAll(this.world, this.controllers, this.agentApiKeys);
        console.log('[FreshStart] Fresh state saved to Supabase');
      } catch (err) {
        console.error('[FreshStart] Save failed:', err);
      }
    }

    // 5. Resume if was running
    if (wasRunning) {
      this.start();
    }

    console.log('[Engine] Fresh start complete — day 1, all agents reset');
  }

  get isConfigured(): boolean {
    // With BYOK, always allow — each agent carries its own key
    return true;
  }

  get isRunning(): boolean {
    return this.tickInterval !== null;
  }
}

function recordToMap<V>(record: Record<string, V>): Map<string, V> {
  return new Map(Object.entries(record));
}
