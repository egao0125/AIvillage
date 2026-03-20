import type { Server } from 'socket.io';
import type { Agent, AgentConfig, WorldEvent, WorldSnapshot, Weather, Building, Technology } from '@ai-village/shared';
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
        this.world.events = (worldData.events ?? []) as typeof this.world.events;
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
        );

        // Restore mutable controller state
        if (ctrlData) {
          const restoredState = ctrlData.controllerState as ControllerState;
          // Reset moving/performing to idle — path is not saved, agent needs to replan
          controller.state = (restoredState === 'moving' || restoredState === 'performing')
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

  addAgent(config: AgentConfig, wakeHour: number = 7, sleepHour: number = 23, startingCurrency: number = 100, apiKey?: string, model?: string, ownerId?: string): Agent {
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
    );
    this.controllers.set(id, controller);

    console.log(
      `[Engine] Agent created: ${config.name} (${config.occupation}) at ${spawnArea}`,
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

    // 4. Run perception every 30 ticks — agents notice their surroundings
    if (this.tickCount % 30 === 0) {
      this.runPerception();
    }

    // 5. Check proximity for conversations
    this.checkProximityConversations();

    // 6. Advance active conversations (fire-and-forget)
    this.advanceConversations();

    // 7. Every 10 ticks: check overhearing
    if (this.tickCount % 10 === 0) this.checkOverhearing();

    // 8. Every 300 ticks (~5 game hours): random world event chance
    if (this.tickCount % 300 === 0) this.checkRandomEvents();

    // 9. Every tick: check election deadlines
    this.checkElections();

    // 10. Every tick: expire world events
    this.world.expireEvents();

    // 11. Every 60 ticks (~1 game hour): update weather
    if (this.tickCount % 60 === 0) {
      this.updateWeather();
    }

    // 12. Every 1440 ticks (~1 game day): advance season check, damage buildings
    if (this.tickCount % 1440 === 0) {
      this.checkSeasonAdvance();
      this.weatherDamageBuildings();
    }

    // 13. Periodic save every 300 ticks (~5 game hours)
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

        // Skip dead agents
        if (a1.alive === false || a2.alive === false) continue;

        // Check if both are available (not sleeping or already conversing)
        const c1 = this.controllers.get(a1.id);
        const c2 = this.controllers.get(a2.id);
        if (!c1 || !c2) continue;
        if (!c1.isAvailable || !c2.isAvailable) continue;

        // Check not already in conversation
        if (
          this.conversationManager.isInConversation(a1.id) ||
          this.conversationManager.isInConversation(a2.id)
        ) {
          continue;
        }

        // Moderate probability — conversations should happen but not constantly
        const prob = 0.15;

        if (Math.random() < prob) {
          // Start conversation
          const location = { ...a1.position };
          const convId = this.conversationManager.startConversation(a1.id, a2.id, location);

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
   * 20% chance to trigger a random world event.
   */
  private checkRandomEvents(): void {
    if (Math.random() > 0.2) return;

    const eventTypes: WorldEvent['type'][] = [
      'storm', 'festival', 'fire', 'drought', 'harvest',
      'plague', 'earthquake', 'market_boom', 'bandit_sighting', 'miracle',
    ];

    const descriptions: Record<WorldEvent['type'], string> = {
      storm: 'A fierce storm sweeps through the village!',
      festival: 'A spontaneous festival breaks out in the village!',
      fire: 'A fire has broken out in the village!',
      drought: 'A drought is affecting the village crops.',
      harvest: 'A bountiful harvest has arrived!',
      plague: 'A mysterious illness spreads through the village.',
      earthquake: 'The ground trembles beneath the village!',
      market_boom: 'Trade is booming at the market!',
      bandit_sighting: 'Bandits have been spotted near the village!',
      miracle: 'Something miraculous has occurred in the village!',
    };

    const allAreaIds = Array.from(this.world.agents.values())
      .map(a => this.world.getAreaAt(a.position)?.id)
      .filter(Boolean) as string[];
    const uniqueAreas = [...new Set(allAreaIds)];
    const affectedCount = Math.min(1 + Math.floor(Math.random() * 3), uniqueAreas.length);
    const affectedAreas: string[] = [];
    const shuffled = [...uniqueAreas].sort(() => Math.random() - 0.5);
    for (let i = 0; i < affectedCount; i++) {
      affectedAreas.push(shuffled[i]);
    }

    const type = eventTypes[Math.floor(Math.random() * eventTypes.length)];
    const event: WorldEvent = {
      id: crypto.randomUUID(),
      type,
      description: descriptions[type],
      startTime: Date.now(),
      duration: 60 + Math.floor(Math.random() * 120), // 1-3 game hours
      affectedAreas,
      active: true,
    };

    this.world.addWorldEvent(event);
    this.broadcaster.worldEvent(event);
    console.log(`[Engine] World event: ${event.description} (affects: ${affectedAreas.join(', ')})`);
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
    const oldWeather = this.world.weather.current;
    const newWeather = this.world.updateWeather();
    if (newWeather !== oldWeather) {
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
      content: `${agent.config.name}, ${agent.config.occupation}, lived ${this.world.time.day} days in the village. They died of ${cause}. They had ${agent.currency} gold and ${agent.skills.length} skills.`,
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
    return this.world.getSnapshot();
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
