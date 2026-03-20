import type { Server } from 'socket.io';
import type { Agent, AgentConfig, WorldEvent, WorldSnapshot } from '@ai-village/shared';
import { AgentCognition, InMemoryStore, AnthropicProvider } from '@ai-village/ai-engine';
import { getAreaEntrance } from '../map/village.js';
import { World } from './world.js';
import { EventBroadcaster } from './events.js';
import { ConversationManager } from './conversation.js';
import { AgentController } from './agent-controller.js';
import { STARTER_AGENTS } from '../agents/starter.js';
import { AREAS } from '../map/village.js';

export class SimulationEngine {
  private static readonly SPAWN_AREAS = ['plaza', 'cafe', 'park', 'market', 'garden', 'tavern', 'bakery'];

  private world: World;
  private controllers: Map<string, AgentController> = new Map();
  private conversationManager!: ConversationManager;
  private broadcaster!: EventBroadcaster;
  private cognitions: Map<string, AgentCognition> = new Map();
  private tickInterval: NodeJS.Timeout | null = null;
  private tickCount: number = 0;

  constructor(private io: Server) {
    this.world = new World();
  }

  async initialize(): Promise<void> {
    // Create broadcaster
    this.broadcaster = new EventBroadcaster(this.io);

    // Create conversation manager
    this.conversationManager = new ConversationManager(this.world, this.broadcaster);

    // Get Anthropic API key
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn(
        '[Engine] ANTHROPIC_API_KEY not set — LLM calls will fail. Set it in .env for full AI functionality.',
      );
    }

    // Spawn starter agents
    for (const starter of STARTER_AGENTS) {
      this.addAgent(starter.config, starter.wakeHour, starter.sleepHour);
    }

    console.log(`[Engine] AI Village initialized with ${this.world.agents.size} agents`);
  }

  addAgent(config: AgentConfig, wakeHour: number = 7, sleepHour: number = 23): Agent {
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
      currency: 100,
      createdAt: Date.now(),
      ownerId: 'user',
      mood: 'neutral',
      inventory: [],
      skills: [],
    };

    this.world.addAgent(agent);
    this.broadcaster.agentSpawn(agent);

    // Create cognition stack
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
    const memoryStore = new InMemoryStore();
    const llmProvider = apiKey
      ? new AnthropicProvider(apiKey, model)
      : new AnthropicProvider('dummy-key', model); // will fail on actual calls
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

    return agent;
  }

  start(): void {
    if (this.tickInterval) return;

    this.tickInterval = setInterval(() => {
      this.tick();
    }, 250); // 4x speed: 1 game minute = 250ms real time

    console.log('[Engine] Simulation started');
  }

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
      console.log('[Engine] Simulation stopped');
    }
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
  }

  /**
   * Fire-and-forget perception for all awake agents.
   * Agents observe nearby agents and areas, storing observations as memories.
   */
  private runPerception(): void {
    for (const [agentId, cognition] of this.cognitions.entries()) {
      const agent = this.world.getAgent(agentId);
      if (!agent || agent.state === 'sleeping') continue;

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

  getSnapshot(): WorldSnapshot {
    return this.world.getSnapshot();
  }

  get isConfigured(): boolean {
    return !!process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'dummy-key';
  }

  get isRunning(): boolean {
    return this.tickInterval !== null;
  }

  updateApiKey(apiKey: string, model?: string): void {
    const m = model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
    process.env.ANTHROPIC_API_KEY = apiKey;

    // Rebuild all LLM providers with the new key
    for (const [agentId, cognition] of this.cognitions.entries()) {
      const provider = new AnthropicProvider(apiKey, m);
      // Replace the provider on the cognition instance
      (cognition as any).llm = provider;
    }

    console.log(`[Engine] API key updated, model: ${m}`);
  }
}
