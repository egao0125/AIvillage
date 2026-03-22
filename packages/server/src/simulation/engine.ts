import type { Server } from 'socket.io';
import type { Agent, AgentConfig, WorldSnapshot, Weather, Building, Technology } from '@ai-village/shared';
import { AgentCognition, InMemoryStore, SupabaseMemoryStore, AnthropicProvider, ThrottledProvider } from '@ai-village/ai-engine';
import { getAreaEntrance } from '../map/village.js';
import { World } from './world.js';
import { EventBroadcaster } from './events.js';
import { ConversationManager } from './conversation.js';
import { AgentController } from './agent-controller.js';
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
  private controllers: Map<string, AgentController> = new Map();
  private conversationManager!: ConversationManager;
  private broadcaster!: EventBroadcaster;
  private cognitions: Map<string, AgentCognition> = new Map();
  private agentApiKeys: Map<string, { apiKey: string; model: string }> = new Map();
  // Shared throttle per API key — limits concurrent LLM calls to prevent OOM
  private static readonly MAX_CONCURRENT_LLM = 5;
  private throttles: Map<string, ThrottledProvider> = new Map();
  private tickInterval: NodeJS.Timeout | null = null;
  private tickCount: number = 0;
  private persistence: SupabasePersistence | null = null;
  private weatherStableUntil: number = 0;
  private lastConversationPair: Map<string, number> = new Map();
  private narrator!: VillageNarrator;
  private characterTimeline!: CharacterTimeline;
  private storylineDetector!: StorylineDetector;
  recapGenerator!: RecapGenerator;

  constructor(private io: Server) {
    this.world = new World();

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
    // Create broadcaster
    this.broadcaster = new EventBroadcaster(this.io);

    // Create narrator + timeline + storyline systems
    const globalKey = process.env.ANTHROPIC_API_KEY;
    const globalModel = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
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

    // Create conversation manager
    this.conversationManager = new ConversationManager(this.world, this.broadcaster);

    // Restore from Supabase if persistence is enabled
    if (this.persistence) {
      await this.loadFromSupabase();
    }

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
        this.world.conversations = recordToMap(worldData.conversations ?? {}) as typeof this.world.conversations;
        this.world.elections = recordToMap(worldData.elections ?? {}) as typeof this.world.elections;
        this.world.properties = recordToMap(worldData.properties ?? {}) as typeof this.world.properties;
        this.world.items = recordToMap(worldData.items ?? {}) as typeof this.world.items;
        this.world.institutions = recordToMap(worldData.institutions ?? {}) as typeof this.world.institutions;
        this.world.buildings = recordToMap(worldData.buildings ?? {}) as typeof this.world.buildings;
        console.log(`[Engine] World state restored (day ${this.world.time.day}, hour ${this.world.time.hour})`);
      }

      if (agents.length === 0) {
        console.log('[Engine] No agents to restore from Supabase');
        return;
      }

      const globalKey = process.env.ANTHROPIC_API_KEY;
      const globalModel = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
      const sharedMemoryStore = new SupabaseMemoryStore(this.persistence.client);

      for (const agent of agents) {
        this.world.addAgent(agent);

        // Restore per-agent API key (fall back to global env)
        const ctrlDataForKey = controllerDataMap.get(agent.id);
        const effectiveKey = ctrlDataForKey?.apiKey || globalKey || 'dummy-key';
        const effectiveModel = ctrlDataForKey?.model || globalModel;
        if (ctrlDataForKey?.apiKey) {
          this.agentApiKeys.set(agent.id, { apiKey: ctrlDataForKey.apiKey, model: effectiveModel });
        }

        // Away agents persist but don't get controller/cognition (no LLM calls)
        if (agent.state === 'away') {
          console.log(`[Engine] Agent ${agent.config.name} is away — skipping controller/cognition`);
          continue;
        }

        // Create cognition with Supabase-backed memory + throttled LLM
        const llmProvider = this.getThrottledProvider(effectiveKey, effectiveModel);
        const cognition = new AgentCognition(agent, sharedMemoryStore, llmProvider);
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

        // Restore mutable controller state
        if (ctrlData) {
          const restoredState = ctrlData.controllerState as ControllerState;
          // Reset transient states to idle — path/conversation state is not saved across restarts
          controller.state = (restoredState === 'moving' || restoredState === 'performing' || restoredState === 'conversing')
            ? 'idle'
            : restoredState;
          controller.dayPlan = ctrlData.dayPlan as typeof controller.dayPlan;
          controller.currentPlanIndex = ctrlData.currentPlanIndex ?? 0;
          controller.activityTimer = ctrlData.activityTimer ?? 0;
          controller.conversationCooldown = ctrlData.conversationCooldown ?? 0;
        }

        this.controllers.set(agent.id, controller);
      }

      console.log(`[Engine] Restored ${agents.length} agents from Supabase`);
    } catch (err) {
      console.error('[Engine] Failed to load from Supabase:', err);
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
    this.broadcaster.agentSpawn(agent);

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
    const cognition = new AgentCognition(agent, memoryStore, llmProvider);
    this.cognitions.set(id, cognition);

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
    this.controllers.set(id, controller);

    console.log(
      `[Engine] Agent created: ${config.name}${config.occupation ? ' (' + config.occupation + ')' : ''} at ${spawnArea}`,
    );

    // Save immediately so agents survive restarts
    if (this.persistence) {
      void this.persistence.saveAll(this.world, this.controllers, this.agentApiKeys).catch(err =>
        console.error('[Persistence] Save after addAgent failed:', err)
      );
    }

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

    // Remove cognition and API key
    this.cognitions.delete(id);
    this.agentApiKeys.delete(id);

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

    // Remove from world
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
    const cognition = new AgentCognition(agent, memoryStore, llmProvider);
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

  start(): void {
    if (this.tickInterval) return;

    this.tickInterval = setInterval(() => {
      this.tick();
    }, 83); // 12x speed: 1 game minute = 83ms real time (~3x previous)

    console.log('[Engine] Simulation started');
  }

  async stop(): Promise<void> {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
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

    // 1. Advance game time
    const time = this.world.advanceTime();

    // 2. Broadcast time every 15 game minutes
    if (time.minute % 15 === 0) {
      this.broadcaster.worldTime(time);
    }

    // 3. Tick each agent controller
    for (const controller of this.controllers.values()) {
      controller.tick(time);
    }

    // 4. Run perception every 120 ticks — agents notice their surroundings
    if (this.tickCount % 120 === 0) {
      this.runPerception();
    }

    // 5. Check proximity for conversations
    this.checkProximityConversations();

    // 6. Advance active conversations (fire-and-forget)
    this.advanceConversations();

    // 7. Every 10 ticks: check overhearing
    if (this.tickCount % 10 === 0) this.checkOverhearing();

    // 8. Every tick: check election deadlines
    this.checkElections();

    // 9. Every 600 ticks (~10 game hours): update weather (was 60 — too frequent)
    if (this.tickCount % 600 === 0) {
      this.updateWeather();
    }

    // 12. Every 1440 ticks (~1 game day): advance season check, damage buildings
    if (this.tickCount % 1440 === 0) {
      this.checkSeasonAdvance();
      this.weatherDamageBuildings();
    }

    // 13. Narrator check every 60 ticks
    if (this.tickCount % 60 === 0) {
      void this.narrator.maybeNarrate(time).then(narrative => {
        if (narrative) {
          this.broadcaster.narrativeUpdate(narrative);
          console.log(`[Narrator] Day ${time.day} ${time.hour}:${String(time.minute).padStart(2, '0')}: ${narrative.content.substring(0, 80)}...`);
        }
      }).catch(() => {});
    }

    // 14. Storyline detection every 1440 ticks (~1 game day)
    if (this.tickCount % 1440 === 0) {
      void this.storylineDetector.detectAndUpdate().then(storylines => {
        for (const s of storylines) {
          this.broadcaster.storylineUpdate(s);
        }
      }).catch(() => {});
    }

    // 15. Periodic save every 300 ticks (~5 game hours)
    if (this.tickCount % 300 === 0 && this.persistence) {
      void this.persistence.saveAll(this.world, this.controllers, this.agentApiKeys).catch(err =>
        console.error('[Persistence] Periodic save failed:', err)
      );
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

      void cognition.perceive(nearby, nearbyAreas).catch(() => {});
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

        // Check conversation pair cooldown (min 600 ticks between same pair)
        const pairKey = [a1.id, a2.id].sort().join(':');
        const lastTick = this.lastConversationPair.get(pairKey);
        if (lastTick !== undefined && (this.tickCount - lastTick) < 3600) continue;

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

        // Reduced probability — intentional conversations supplement this
        const prob = 0.08;

        if (Math.random() < prob) {
          // Start conversation
          const location = { ...a1.position };
          const convId = this.conversationManager.startConversation(a1.id, a2.id, location);

          // Record pair cooldown
          this.lastConversationPair.set(pairKey, this.tickCount);

          // Put both controllers into conversing state
          c1.enterConversation();
          c2.enterConversation();

          console.log(
            `[Engine] Proximity conversation started: ${a1.config.name} <-> ${a2.config.name}`,
          );

          // Only start one conversation per tick
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
        .then(continuing => {
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
        .catch(err => {
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

        // Small chance the agent decides to join the conversation
        if (Math.random() < 0.1) {
          const controller = this.controllers.get(agent.id);
          if (controller?.isAvailable) {
            this.conversationManager.addParticipant(conv.id, agent.id);
            controller.enterConversation();
            console.log(`[Engine] ${agent.config.name} overheard and joined conversation`);
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

  killAgent(agentId: string, cause: string): void {
    const agent = this.world.getAgent(agentId);
    if (!agent || agent.alive === false) return;

    const droppedItems = this.world.killAgent(agentId, cause);

    // Stop controller
    this.controllers.delete(agentId);
    this.cognitions.delete(agentId);

    // Broadcast death
    this.broadcaster.agentDeath(agentId, cause);

    // Create diary artifact from agent's memories (their final legacy)
    const artifact = {
      id: crypto.randomUUID(),
      title: `Diary of ${agent.config.name}`,
      content: `${agent.config.name}${agent.config.occupation ? ', ' + agent.config.occupation + ',' : ''} lived ${this.world.time.day} days in the village. They died of ${cause}. They had ${agent.currency} gold and ${agent.skills.length} skills.`,
      type: 'diary' as const,
      creatorId: agentId,
      creatorName: agent.config.name,
      location: this.world.getAreaAt(agent.position)?.id,
      visibility: 'public' as const,
      reactions: [],
      createdAt: Date.now(),
      day: this.world.time.day,
    };
    this.world.addArtifact(artifact);
    this.broadcaster.artifactCreated(artifact);

    console.log(`[Engine] ${agent.config.name} has died: ${cause}. Diary created.`);
  }

  getSnapshot(): WorldSnapshot {
    const snapshot = this.world.getSnapshot();
    snapshot.narratives = this.narrator.getRecentNarratives();
    snapshot.storylines = this.storylineDetector.getStorylines();
    return snapshot;
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
      const thought = await cognition.innerMonologue(
        `reflecting on what I'm doing`,
        `Currently: ${agent.currentAction || 'idle'}. Mood: ${agent.mood}. Location: ${agent.state}.`
      );
      return thought || null;
    } catch {
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

  private createActionExecutor() {
    return {
      executeSocialAction: (actorId: string, actorName: string, targetId: string, action: string, cognition: AgentCognition) => {
        this.conversationManager.executeSocialAction(actorId, actorName, targetId, action, cognition);
      },
      requestConversation: (initiatorId: string, targetId: string): boolean => {
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

        const convId = this.conversationManager.startConversation(initiatorId, targetId, { ...a1.position });
        this.lastConversationPair.set(pairKey, this.tickCount);
        c1.enterConversation();
        c2.enterConversation();
        console.log(`[Engine] Intentional conversation: ${a1.config.name} sought out ${this.world.getAgent(targetId)?.config.name}`);
        return true;
      },
    };
  }

  updateAgentApiKey(agentId: string, newApiKey: string, newModel: string): boolean {
    const agent = this.world.getAgent(agentId);
    if (!agent || agent.alive === false) return false;

    // Update stored key
    this.agentApiKeys.set(agentId, { apiKey: newApiKey, model: newModel });

    // Create new provider and cognition
    const llmProvider = this.getThrottledProvider(newApiKey, newModel);
    const memoryStore = this.persistence
      ? new SupabaseMemoryStore(this.persistence.client)
      : new InMemoryStore();
    const cognition = new AgentCognition(agent, memoryStore, llmProvider);
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
