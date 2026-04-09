import type { Server } from 'socket.io';
import type { Agent, AgentConfig, BoardPost, BoardPostType, WorldSnapshot, Weather, Building, Technology, WorldObject } from '@ai-village/shared';
import { EventBus, deriveRewardWeights, DEFAULT_REWARD_WEIGHTS } from '@ai-village/shared';
import { AgentCognition, InMemoryStore, RdsMemoryStore, AnthropicProvider, ThrottledProvider, TieredMemory, FourStreamMemory, VoyageEmbeddingProvider, OpenAIEmbeddingProvider, SEASONS, getMapConfig, buildWerewolfRules } from '@ai-village/ai-engine';
import type { EmbeddingProvider } from '@ai-village/ai-engine';
import type { WorldViewParts } from '@ai-village/ai-engine';
import type { MapConfig } from '@ai-village/shared';
import { getAreaEntrance, setActiveMap } from '../map/map-provider.js';
import { buildStartingWorldViewParts } from '../map/starting-knowledge.js';
import { World } from './world.js';
import { EventBroadcaster } from './events.js';
import { ConversationManager } from './conversation/index.js';
import { AgentController } from './agent-controller.js';
import { DecisionQueue } from './decision-queue.js';
import { ViewportManager } from './viewport-manager.js';
import { getAreas } from '../map/map-provider.js';
import { RdsPersistence, type ControllerData, VersionConflictError } from '../persistence/rds.js';
import type { ControllerState } from './agent-controller.js';
import { VillageNarrator } from './narrator.js';
import { CharacterTimeline } from './character-timeline.js';
import { StorylineDetector } from './storyline-detector.js';
import { RecapGenerator } from './recap-generator.js';
import { LeaderElection } from '../cluster/leader-election.js';
import { getRedis } from '../redis.js';
import { SOUL_REWRITES, AGENTS_TO_REMOVE } from './soul-rewrite.js';
import { WerewolfPhaseManager } from './werewolf/index.js';

export class SimulationEngine {
  private static readonly SPAWN_AREAS = ['plaza', 'cafe', 'park', 'market', 'garden', 'tavern', 'bakery'];

  private world: World;
  private mapConfig: MapConfig = getMapConfig('village');
  readonly bus: EventBus = new EventBus();
  private controllers: Map<string, AgentController> = new Map();
  private conversationManager!: ConversationManager;
  private broadcaster!: EventBroadcaster;
  private cognitions: Map<string, AgentCognition> = new Map();
  private agentApiKeys: Map<string, { apiKey: string; model: string }> = new Map();
  // Shared throttle per API key — limits concurrent LLM calls to prevent OOM
  private static readonly MAX_CONCURRENT_LLM = 10;
  /** Cheap model for background memory processing (dossiers, beliefs, HyDE). Gap-analysis item 4.2. */
  private static readonly CHEAP_LLM_MODEL = 'claude-haiku-4-5-20251001';
  /** Shared neural embedding provider (OpenAI text-embedding-3-small). Created if OPENAI_API_KEY is set. */
  private sharedEmbeddingProvider: EmbeddingProvider | null = null;
  private throttles: Map<string, ThrottledProvider> = new Map();
  private decisionQueue: DecisionQueue;
  private decisionInterval: NodeJS.Timeout | null = null;
  readonly viewportManager: ViewportManager = new ViewportManager();
  private tickInterval: NodeJS.Timeout | null = null;
  private tickCount: number = 0;
  private persistence: RdsPersistence | null = null;
  private weatherStableUntil: number = 0;
  private lastConversationPair: Map<string, number> = new Map();
  private narrator!: VillageNarrator;
  private characterTimeline!: CharacterTimeline;
  private storylineDetector!: StorylineDetector;
  recapGenerator!: RecapGenerator;
  private lastWeeklySummaryDay: number = 0;
  private cachedWeeklySummary: string | null = null;
  private weeklySummaryGenerating: boolean = false;
  /** Shared RdsMemoryStore for agents loaded from persistence — held so cleanup() can be called on removeAgent() */
  private sharedMemoryStore: RdsMemoryStore | null = null;

  /** Werewolf game mode — phase manager drives the night/day/vote cycle */
  private werewolfManager: WerewolfPhaseManager | null = null;

  // Circuit breaker state for isDbHealthy() readiness probe.
  // Prevents log flooding (k8s calls every 10s) while still surfacing the first failure
  // and the recovery moment — per AWS Well-Architected Operational Excellence BP.
  private dbHealthFailureCount: number = 0;
  private dbHealthCircuitOpenAt: number = 0;
  private static readonly DB_HEALTH_CIRCUIT_THRESHOLD = 3;   // open after 3 consecutive failures
  private static readonly DB_HEALTH_CIRCUIT_RESET_MS = 30_000; // re-try after 30 s

  // Distributed leader election — only the leader Pod runs the simulation tick loop.
  // Followers serve HTTP/WS reads from Redis snapshot. No-Redis fallback: always leader.
  private readonly leaderElection: LeaderElection = new LeaderElection();
  // Optimistic lock version for world_state row — incremented on each successful save.
  private worldStateVersion: number = 0;
  // Guard: true while loadFromRds() is in flight after a VersionConflictError.
  // Prevents a concurrent save_requested from writing with a stale expectedVersion
  // before the reload completes and updates worldStateVersion.
  private isReloadingState: boolean = false;
  // Deduplicates concurrent loadFromRds() calls — returns the in-flight Promise
  // instead of starting a second parallel load that could corrupt world state.
  private _loadFromRdsInFlight: Promise<void> | null = null;

  constructor(private io: Server) {
    this.world = new World();
    this.decisionQueue = new DecisionQueue(SimulationEngine.MAX_CONCURRENT_LLM);

    const dbHost = process.env.DB_HOST;
    const dbUser = process.env.DB_USER;
    const dbPassword = process.env.DB_PASSWORD;
    if (dbHost && dbUser && dbPassword) {
      // DB_SSLMODE: 'disable' when connecting via pgBouncer (intra-cluster, no TLS).
      // 'verify-full' when connecting directly to RDS. Controlled by k8s/01-configmap.yaml.
      const sslMode = process.env.DB_SSLMODE || 'verify-full';
      const connStr = `postgresql://${dbUser}:${dbPassword}@${dbHost}:${process.env.DB_PORT || '5432'}/${process.env.DB_NAME || 'aivillage'}?sslmode=${sslMode}`;
      this.persistence = new RdsPersistence(connStr);
      console.log('[Engine] RDS persistence enabled');
    } else {
      if (process.env.NODE_ENV === 'production') {
        // In production, all memories are lost on pod restart if RDS is unavailable.
        // This is a data durability issue — ensure DB_HOST, DB_USER, DB_PASSWORD are set.
        // (AWS Well-Architected: stateful components must be externalized)
        console.error('[Engine] FATAL: RDS persistence disabled in production. Set DB_HOST, DB_USER, DB_PASSWORD to prevent data loss on pod restart.');
        process.exit(1);
      }
      console.log('[Engine] RDS persistence disabled — using in-memory store (dev mode only)');
    }
  }

  private cachedGameRules: string | null = null;

  async setMapConfig(mapId: string): Promise<void> {
    const oldMapId = this.mapConfig.id;
    if (mapId === oldMapId) return;

    const wasRunning = this.isRunning;
    this.pause();

    // 1. Save current map's state to DB
    if (this.persistence && this.leaderElection.isLeader) {
      try {
        const newVersion = await this.persistence.saveAll(
          this.world, this.controllers, this.agentApiKeys, oldMapId,
        );
        this.worldStateVersion = newVersion;
        console.log(`[Engine] Saved ${oldMapId} state before switching`);
      } catch (err) {
        console.error(`[Engine] Failed to save ${oldMapId} state:`, (err as Error).message);
      }
    }

    // 2. Clear in-memory state
    this.controllers.clear();
    this.cognitions.clear();
    this.throttles.clear();
    if (this.decisionQueue) this.decisionQueue.clear();
    this.world.agents.clear();
    this.world.conversations.clear();
    this.lastConversationPair.clear();
    this.worldStateVersion = 0;

    // 3. Switch map config + provider
    this.mapConfig = getMapConfig(mapId);
    this.cachedGameRules = null;
    setActiveMap(mapId);

    // 3b. Werewolf — instantiate or dispose phase manager
    if (this.werewolfManager) {
      this.werewolfManager.dispose();
      this.werewolfManager = null;
    }
    if (this.mapConfig.systems?.werewolf) {
      this.werewolfManager = new WerewolfPhaseManager(
        this.bus, this.world, this.broadcaster,
        this.controllers, this.cognitions, this.conversationManager,
      );
    }

    console.log(`[Engine] Map set to: ${this.mapConfig.name} (${this.mapConfig.id})`);

    // 4. Load new map's state from DB
    if (this.persistence) {
      await this.loadFromRds();
    }

    // 5. Resume if was running
    if (wasRunning) {
      this.start();
    }
  }

  private getGameRules(): string {
    if (!this.cachedGameRules) {
      this.cachedGameRules = this.mapConfig.buildGameRules();
    }
    return this.cachedGameRules;
  }

  /**
   * Per-agent game rules — werewolf map returns role-specific rules,
   * other maps return the same shared rules for everyone.
   */
  private getGameRulesForAgent(agent: Agent): string {
    if (this.mapConfig.systems?.werewolf && agent.werewolfRole) {
      const fellowName = agent.fellowWolves?.length
        ? this.world.getAgent(agent.fellowWolves[0])?.config.name
        : undefined;
      return buildWerewolfRules(agent.werewolfRole, fellowName, this.world.agents.size);
    }
    return this.getGameRules();
  }

  getMapConfig(): MapConfig {
    return this.mapConfig;
  }

  getWerewolfManager(): WerewolfPhaseManager | null {
    return this.werewolfManager;
  }

  /**
   * Start a werewolf game with all currently alive agents.
   * Only works when the active map has werewolf system enabled.
   */
  startWerewolfGame(): void {
    if (!this.werewolfManager) {
      console.warn('[Engine] Cannot start werewolf game — werewolf system not active');
      return;
    }
    // Reset world clock to Day 1, 21:00 — first night starts immediately
    this.world.time = { day: 1, hour: 21, minute: 0, totalMinutes: 21 * 60 };
    this.broadcaster.worldTime(this.world.time);

    // Revive all agents (they may be dead from a previous game)
    for (const agent of this.world.agents.values()) {
      if (agent.alive === false) {
        agent.alive = true;
        agent.state = 'idle';
        agent.werewolfRole = undefined;
        agent.votingHistory = undefined;
        agent.investigations = undefined;
        agent.fellowWolves = undefined;
        agent.lastGuarded = undefined;
      }
    }

    const agentIds = Array.from(this.world.agents.values())
      .filter(a => a.state !== 'away')
      .map(a => a.id);
    this.werewolfManager.startGame(agentIds);
  }

  /**
   * Reset and restart a werewolf game (Play Again flow).
   * Revives all agents, re-assigns roles, rebuilds cognition rules, starts fresh.
   */
  resetWerewolfGame(): void {
    if (!this.werewolfManager || !this.mapConfig.systems?.werewolf) {
      console.warn('[Engine] Cannot reset werewolf game — werewolf system not active');
      return;
    }

    // 1. Reset all agents to alive
    for (const agent of this.world.agents.values()) {
      agent.alive = true;
      agent.state = 'idle';
      agent.werewolfRole = undefined;
      agent.fellowWolves = undefined;
      agent.investigations = undefined;
      agent.lastGuarded = undefined;
      agent.votingHistory = undefined;
      this.world.updateAgentState(agent.id, 'active', '');
    }

    // 2. Create new WerewolfPhaseManager
    this.werewolfManager.dispose();
    this.werewolfManager = new WerewolfPhaseManager(
      this.bus, this.world, this.broadcaster, this.controllers, this.cognitions, this.conversationManager!,
    );
    // Re-link controllers to new manager
    for (const ctrl of this.controllers.values()) {
      ctrl.werewolfManager = this.werewolfManager;
    }

    // 3. Reset world clock to Day 1, 21:00 — first night starts immediately
    this.world.time = { day: 1, hour: 21, minute: 0, totalMinutes: 21 * 60 };
    this.broadcaster.worldTime(this.world.time);

    // 4. Start fresh game (assigns roles, sets game rules, starts first night)
    const agentIds = Array.from(this.world.agents.values()).map(a => a.id);
    this.werewolfManager.startGame(agentIds);

    // 5. Broadcast new game starting
    this.broadcaster.werewolfNewGame();

    console.log('[Engine] Werewolf game reset — new game started');
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
    }

    // Neural embedding provider — shared across all agents.
    // Preference: Voyage-4-large (RTEB #1, $0.12/1M) > OpenAI 3-large ($0.13/1M) > TF-IDF.
    const voyageKey = process.env.VOYAGE_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    if (voyageKey) {
      this.sharedEmbeddingProvider = new VoyageEmbeddingProvider(voyageKey, 'voyage-4-large', 1024);
      console.log('[Engine] Neural embeddings enabled (voyage-4-large, 1024d)');
    } else if (openaiKey) {
      this.sharedEmbeddingProvider = new OpenAIEmbeddingProvider(openaiKey, 'text-embedding-3-large', 1024);
      console.log('[Engine] Neural embeddings enabled (text-embedding-3-large, 1024d)');
    } else {
      console.log('[Engine] No embedding API key set — using TF-IDF only for semantic matching');
    }

    if (!globalKey) {
      // ANTHROPIC_API_KEY not set — narrator/storyline/recap LLM calls will be skipped.
      // Using '' triggers auth errors on any LLM attempt, which providers handle gracefully.
      console.warn('[Engine] ANTHROPIC_API_KEY not set — narrator, storyline, and recap features disabled');
      const noKeyLlm = this.getThrottledProvider('', globalModel);
      this.narrator = new VillageNarrator(noKeyLlm, this.world);
      this.storylineDetector = new StorylineDetector(this.world, noKeyLlm);
      this.recapGenerator = new RecapGenerator(this.world, this.narrator, this.storylineDetector, noKeyLlm);
    }

    this.characterTimeline = new CharacterTimeline();
    this.broadcaster.setTimeline(this.characterTimeline);
    this.broadcaster.setDayGetter(() => this.world.time.day);

    // Create conversation manager
    this.conversationManager = new ConversationManager(this.world, this.broadcaster, this.bus, this.controllers);
    // Wire bystander notification when conversations end
    this.conversationManager.onConversationEnd = (conv) => this.notifyConversationBystanders(conv);

    // Distributed leader election: only one Pod runs the simulation tick loop.
    // Followers serve HTTP/WS reads; the leader writes state to Redis for them.
    const leaderAcquired = await this.leaderElection.tryAcquire();
    console.log(`[Engine] ${leaderAcquired ? 'Leadership acquired' : 'Running as follower'} (podId=${this.leaderElection.podId})`);

    // Callback invoked when heartbeat renewal fails (e.g. Redis TTL expired or evicted).
    // Pause the simulation immediately so the stale leader doesn't overwrite new state.
    this.leaderElection.onLeadershipLost = () => {
      console.error('[Engine] Leadership lost — pausing simulation tick');
      this.pause();
      this.isReloadingState = true; // prevent stale saves while state is being refreshed
      // Poll until we re-acquire; another Pod may already be the leader by then.
      this.leaderElection.startRetrying(() => {
        console.log('[Engine] Leadership re-acquired — restarting simulation tick');
        this.loadFromRds()
          .then(() => { this.isReloadingState = false; this.start(); })
          .catch((err: unknown) => {
            console.error('[Engine] Re-acquire reload failed:', (err as Error).message);
            this.isReloadingState = false;
          });
      });
    };

    // Non-leader follower: keep polling so it can promote if the leader dies.
    if (!leaderAcquired) {
      this.isReloadingState = true; // follower starts in reload-pending state
      this.leaderElection.startRetrying(() => {
        console.log('[Engine] Follower promoted to leader — starting simulation tick');
        this.loadFromRds()
          .then(() => { this.isReloadingState = false; this.start(); })
          .catch((err: unknown) => {
            console.error('[Engine] Follower promotion reload failed:', (err as Error).message);
            this.isReloadingState = false;
          });
      });
    }

    // Restore from RDS if persistence is enabled
    if (this.persistence) {
      await this.loadFromRds();
    }

    // --- Infra 1: Wire event bus subscriptions ---
    // Registration order = execution order within a tick.

    // Midnight: reset counters, decay objects (skip for werewolf)
    this.bus.on('midnight', () => {
      if (this.werewolfManager) return;
      this.world.resetDailyCounters();
      this.world.spoilFood();
      this.decayWorldObjects();
      // Bi-temporal context update (gap-analysis item 3.1):
      // propagate current day to each agent's memory for valid_from/valid_until stamping
      for (const cog of this.cognitions.values()) {
        cog.fourStream?.setCurrentDay(this.world.time.day);
      }
      // Recompute emergent norms from the rolling 7-day ledger (gap-analysis item 1.2)
      this.world.aggregateNorms(this.world.time.day, 7);
      if (this.world.villageNorms.size > 0) {
        const summary = Array.from(this.world.villageNorms.values())
          .filter(n => n.enforcementRate >= 0.2)
          .map(n => `${n.actionType}(enf=${n.enforcementRate.toFixed(2)}, sev=${n.severity.toFixed(2)}, n=${n.observationCount})`)
          .join(', ');
        if (summary) console.log(`[Norms] Day ${this.world.time.day}: ${summary}`);
      }
      // Propagate yesterday's witnessed events as learned aversions to each witness.
      // Cheap O(entries × avg_witnesses), runs once per day. (gap-analysis item 1.2)
      const yesterday = this.world.time.day - 1;
      const fresh = this.world.villageMemory.filter(
        e => e.day === yesterday && e.actionType && e.witnessIds && e.witnessIds.length > 0
      );
      for (const entry of fresh) {
        // Valence: negative villageBenefit → aversion, positive → preference.
        const vb = entry.villageBenefit ?? 0;
        if (Math.abs(vb) < 0.05) continue;
        const delta = Math.max(-1, Math.min(1, vb));
        // Look up actor name once per entry (gap-analysis item 2.2)
        const actor = entry.actorId ? this.world.getAgent(entry.actorId) : undefined;
        const actorName = actor?.config.name ?? 'Someone';
        for (const witnessId of entry.witnessIds!) {
          if (witnessId === entry.actorId) continue;
          const cog = this.cognitions.get(witnessId);
          if (!cog?.fourStream) continue;
          // (a) Procedural: learn to avoid/seek the action itself
          cog.fourStream.updateLearnedAversion(entry.actionType!, delta, 'witnessed');
          // (b) Relational: update dossier on the actor at 0.3 witness confidence
          if (entry.actorId) {
            cog.fourStream.updateDossierFromObservation(
              entry.actorId,
              actorName,
              entry.content,
              vb,
              entry.day,
            );
          }
        }
      }
    });

    // Tick controllers — per-agent try-catch so one bad agent doesn't pause the sim
    this.bus.on('tick', (e) => {
      // Werewolf phase manager ticks before controllers (controls sleep/wake/actions)
      if (this.werewolfManager) {
        // Don't tick anything when the werewolf game has ended
        if (this.werewolfManager.phase === 'ended') return;
        try {
          this.werewolfManager.onTick(e.time);
        } catch (err) {
          console.error(`[Engine] werewolfManager.onTick() threw — skipping:`, (err as Error).message);
        }
      }

      for (const [agentId, controller] of this.controllers.entries()) {
        try {
          controller.tick(e.time);
        } catch (err) {
          console.error(`[Engine] controller.tick() threw for agent ${agentId} — skipping:`, (err as Error).message);
        }
      }
    });

    // Hourly resource regeneration (Fix 1: wire resource depletion)
    this.bus.on('hour_changed', () => {
      if (this.werewolfManager) return;
      const seasonIdx = Math.floor((this.world.time.day - 1) / 30) % 4;
      const seasonName = (['spring', 'summer', 'autumn', 'winter'] as const)[seasonIdx];
      const seasonDef = SEASONS[seasonName];
      this.world.regenerateResourcePoolsHourly(seasonDef.gatherMultipliers);
    });

    // Perception (skip for werewolf — agents use werewolf-specific situation prompts)
    this.bus.on('perception_cycle', () => {
      if (this.werewolfManager) return;
      this.runPerception();
    });

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
        }).catch((err: unknown) => { console.warn('[Engine] addMemory failed (theft witness):', (err as Error).message); });

        // Trigger reactive think — witness decides whether to intervene
        const ctrl = this.controllers.get(witness.id);
        if (ctrl && !ctrl.apiExhausted) {
          void cognition.think(
            `You just saw ${thiefName} steal ${e.item} from ${victimName}.`,
            `You're nearby. They might not have seen you watching.`,
          ).catch((err: unknown) => {
            console.warn(`[Engine] Witness think failed for ${witness.id}:`, (err as Error).message);
          });
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
        }).catch((err: unknown) => { console.warn('[Engine] addMemory failed (fight witness):', (err as Error).message); });
      }
    });

    // Fix 5: Institutional rule enforcement — leaders react to violations + auto-kick repeat offenders
    this.bus.on('rule_violated', (e) => {
      const institution = this.world.institutions.get(e.institutionId);
      if (!institution) return;

      // Track violations per member
      if (!institution.violations) institution.violations = {};
      institution.violations[e.agentId] = (institution.violations[e.agentId] ?? 0) + 1;
      const violationCount = institution.violations[e.agentId];

      // Reputation penalty for rule violation
      const ctrl = this.controllers.get(e.agentId);
      if (ctrl) {
        ctrl.adjustReputation(e.agentId, -15, `Violated ${e.institutionName} rule`);
      }

      // Auto-kick on 2nd violation
      if (violationCount >= 2 && institution.members.some(m => m.agentId === e.agentId)) {
        this.world.removeInstitutionMember(institution.id, e.agentId);

        // Expulsion news
        const expelPost: BoardPost = {
          id: crypto.randomUUID(), authorId: 'system',
          authorName: 'Village News', type: 'news',
          channel: 'all',
          content: `${e.agentName} was expelled from ${e.institutionName} for repeated rule violations.`,
          timestamp: Date.now(), day: this.world.time.day,
        };
        this.world.addBoardPost(expelPost);
        this.broadcaster.boardPost(expelPost);

        // Memory for expelled agent
        const violatorCog = this.cognitions.get(e.agentId);
        if (violatorCog) {
          void violatorCog.addMemory({
            id: crypto.randomUUID(), agentId: e.agentId,
            type: 'observation',
            content: `I was expelled from ${e.institutionName} for breaking rules ${violationCount} times.`,
            importance: 8, timestamp: Date.now(), relatedAgentIds: [],
          }).catch((err: unknown) => { console.warn('[Engine] addMemory failed (expulsion):', (err as Error).message); });
        }

        this.broadcaster.institutionUpdate(institution);
        console.log(`[Institution] ${e.agentName} AUTO-EXPELLED from ${e.institutionName} (${violationCount} violations)`);
        return;
      }

      // Find institution leaders
      const leaders = (institution.members ?? [])
        .filter((m: any) =>
          m.role === 'leader' || m.role === 'elder' || m.role === 'founder'
        )
        .map((m: any) => m.agentId as string)
        .filter((id: string) => id !== e.agentId); // violator can't judge themselves

      for (const leaderId of leaders) {
        const cognition = this.cognitions.get(leaderId);
        const leaderCtrl = this.controllers.get(leaderId);
        if (!cognition || !leaderCtrl || leaderCtrl.apiExhausted) continue;

        // Leader gets a high-importance memory of the violation
        void cognition.addMemory({
          id: crypto.randomUUID(),
          agentId: leaderId,
          type: 'observation',
          content: `${e.agentName} violated ${e.institutionName} rule: "${e.rule}" by doing: ${e.action} (violation #${violationCount})`,
          importance: 8,
          timestamp: Date.now(),
          relatedAgentIds: [e.agentId],
        }).catch((err: unknown) => { console.warn('[Engine] addMemory failed (rule violation leader):', (err as Error).message); });

        // Trigger a reactive think — leader decides how to respond
        void cognition.think(
          `${e.agentName}, a member of ${e.institutionName}, just broke the rule: "${e.rule}". They ${e.action}. This is violation #${violationCount}.`,
          `You are a leader of ${e.institutionName}. You must decide how to respond — warn them, confront them, expel them, or let it slide. ${violationCount >= 2 ? 'This is a repeat offender!' : ''}`,
        ).catch((err: unknown) => {
          console.warn(`[Engine] Leader think failed for ${leaderId}:`, (err as Error).message);
        });
      }

      console.log(`[Institution] ${e.agentName} violated ${e.institutionName} rule: "${e.rule}" (violation #${violationCount})`);
    });

    // Agent death — nearby witnesses form a memory and react immediately
    this.bus.on('agent_died', (e) => {
      const dead = this.world.getAgent(e.agentId);
      if (!dead) return;
      const nearby = this.world.getNearbyAgents(dead.position, 6);
      for (const witness of nearby) {
        if (witness.id === e.agentId || witness.alive === false) continue;
        const cognition = this.cognitions.get(witness.id);
        const ctrl = this.controllers.get(witness.id);
        if (!cognition) continue;
        void cognition.addMemory({
          id: crypto.randomUUID(),
          agentId: witness.id,
          type: 'observation',
          content: `I witnessed ${dead.config.name} die. Cause: ${e.cause}`,
          importance: 9,
          timestamp: Date.now(),
          relatedAgentIds: [e.agentId],
        }).catch((err: unknown) => { console.warn('[Engine] addMemory failed (death witness):', (err as Error).message); });
        if (ctrl) {
          ctrl.lastTrigger = `${dead.config.name} just died right in front of you! Cause: ${e.cause}. How do you react?`;
          ctrl.idleTimer = 7;
        }
      }
    });

    // Board post reactions — each alive agent generates a 1-2 sentence comment
    this.bus.on('board_post_created', (e) => {
      if (this.werewolfManager) return; // Skip for werewolf
      void this.generatePostReactions(e.post).catch((err: unknown) => {
        console.warn('[Engine] generatePostReactions failed:', (err as Error).message);
      });
    });

    // Nightly vote — at hour 21, vote on all pending proposals
    this.bus.on('hour_changed', (e) => {
      if (this.werewolfManager) return; // Skip for werewolf
      if (e.hour === 21) {
        void this.resolveNightlyVotes().catch((err: unknown) => {
          console.warn('[Engine] resolveNightlyVotes failed:', (err as Error).message);
        });
      }
    });

    // Periodic save with optimistic locking.
    // Only the leader Pod writes to RDS; the snapshot is also pushed to Redis so
    // follower Pods can serve reads without hitting the DB.
    this.bus.on('save_requested', () => {
      if (!this.persistence) return;
      if (!this.leaderElection.isLeader) return; // followers must not write world state
      // Skip if a reload is in flight — worldStateVersion is stale until it completes.
      if (this.isReloadingState) return;

      const expectedVersion = this.worldStateVersion;
      void this.persistence.saveAll(this.world, this.controllers, this.agentApiKeys, this.mapConfig.id, expectedVersion)
        .then((newVersion: number) => {
          this.worldStateVersion = newVersion;
          // Publish snapshot to Redis so follower Pods can serve getSnapshot() without RDS.
          // Also broadcast to connected clients so memory fields (concerns, dossiers,
          // beliefs, strategies, aversions) stay up-to-date — individual events only
          // cover position/action/speech, not cognition state.
          const snapshot = this.getSnapshot();
          this.broadcaster.worldSnapshot(snapshot);
          return this.writeRedisSnapshot(snapshot);
        })
        .catch((err: unknown) => {
          if ((err as Error).name === 'VersionConflictError') {
            // Another Pod wrote a newer version — reload to get fresh state + current version.
            // Guard prevents any further saves until the reload is complete.
            console.error('[Persistence] Version conflict on save — reloading world state');
            this.isReloadingState = true;
            void this.loadFromRds()
              .catch((e: unknown) => {
                console.error('[Persistence] Reload after version conflict failed:', (e as Error).message);
              })
              .finally(() => {
                this.isReloadingState = false;
              });
          } else {
            console.error('[Persistence] Periodic save failed:', (err as Error).message);
          }
        });
    });

    console.log(`[Engine] AI Village initialized (no starter agents — users create agents via UI)`);
  }

  /**
   * Deduplicated wrapper: if a loadFromRds is already in flight, returns the
   * same Promise rather than starting a second parallel load that would race
   * writes to `this.world`, `this.controllers`, and `this.worldStateVersion`.
   */
  private loadFromRds(): Promise<void> {
    if (this._loadFromRdsInFlight) return this._loadFromRdsInFlight;
    const p = this._execLoadFromRds();
    this._loadFromRdsInFlight = p;
    void p.finally(() => { this._loadFromRdsInFlight = null; });
    return p;
  }

  private async _execLoadFromRds(): Promise<void> {
    if (!this.persistence) return;

    try {
      // Load all data in parallel
      const mapId = this.mapConfig.id;
      const [worldStateResult, agents, controllerDataMap] = await Promise.all([
        this.persistence.loadWorldState(mapId),
        this.persistence.loadAgents(mapId),
        this.persistence.loadAgentControllers(mapId),
      ]);

      if (worldStateResult) {
        // Capture the optimistic-lock version so saveAll() can detect concurrent writes.
        this.worldStateVersion = worldStateResult.version;
        const worldData = worldStateResult.data;
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
          for (const raw of worldData.worldObjects) {
            if (raw != null && typeof raw === 'object' && 'id' in raw) {
              const wo = raw as WorldObject;
              this.world.worldObjects.set(wo.id, wo);
            }
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

        // Restore village collective memory
        if (worldData.villageMemory && Array.isArray(worldData.villageMemory)) {
          this.world.villageMemory = worldData.villageMemory as typeof this.world.villageMemory;
        }

        // Restore in-progress building projects
        if (worldData.activeBuildProjects && typeof worldData.activeBuildProjects === 'object') {
          for (const [key, val] of Object.entries(worldData.activeBuildProjects)) {
            this.world.activeBuildProjects.set(key, val as typeof this.world.activeBuildProjects extends Map<string, infer V> ? V : never);
          }
        }

        console.log(`[Engine] World state restored (day ${this.world.time.day}, hour ${this.world.time.hour})`);
      }

      if (agents.length === 0) {
        console.log('[Engine] No agents to restore from RDS');
        return;
      }

      const defaultModel = 'claude-haiku-4-5-20251001';
      const sharedMemoryStore = new RdsMemoryStore(this.persistence.pool);
      this.sharedMemoryStore = sharedMemoryStore;

      for (let i = 0; i < agents.length; i++) {
        const agent = agents[i];
        // Backwards compat: tag agents loaded before map_id migration
        if (!agent.mapId) agent.mapId = mapId;
        // Set defaults for agents without reward weights, then derive from soul.
        if (!agent.rewardWeights) {
          agent.rewardWeights = { ...DEFAULT_REWARD_WEIGHTS };
          agent.normWeight = agent.normWeight ?? 0.5;
        }
        // Soul-derived weights override Big Five defaults for all agents with soul text.
        // Fire-and-forget — agent starts with existing/default weights until LLM returns.
        if (agent.config.soul || agent.config.backstory) {
          void this.generateSoulWeights(agent);
        }
        this.world.addAgent(agent);

        // Restore per-agent BYOK key from RDS only — no global fallback.
        // Agents without a BYOK key run with LLM calls silently skipped.
        const ctrlDataForKey = controllerDataMap.get(agent.id);
        const savedKey = ctrlDataForKey?.apiKey ?? '';
        const savedModel = ctrlDataForKey?.model;

        if (!savedKey) {
          console.warn(`[Engine] Agent ${agent.config.name} has no BYOK key — LLM calls will be skipped`);
        }
        const effectiveModel = savedModel || defaultModel;
        this.agentApiKeys.set(agent.id, { apiKey: savedKey, model: effectiveModel });
        console.log(`[Engine] Agent ${agent.config.name} → ${savedKey ? 'BYOK' : 'no-key'} / ${effectiveModel}`);

        // Away agents persist but don't get controller/cognition (no LLM calls)
        if (agent.state === 'away') {
          console.log(`[Engine] Agent ${agent.config.name} is away — skipping controller/cognition`);
          continue;
        }

        // Create cognition with RDS-backed memory + throttled LLM (BYOK key or empty)
        const llmProvider = this.getThrottledProvider(savedKey, effectiveModel);
        const cheapLlm = this.getThrottledProvider(savedKey, SimulationEngine.CHEAP_LLM_MODEL);
        const ctrlDataForWorldView = controllerDataMap.get(agent.id);
        const savedParts = ctrlDataForWorldView?.worldViewParts;
        const cognition = new AgentCognition(agent, sharedMemoryStore, llmProvider, savedParts, this.getGameRulesForAgent(agent));
        cognition.cheapLlmProvider = cheapLlm;
        // Reset MY EXPERIENCE to prevent stale worldView from previous simulation runs
        const spawnArea = ctrlDataForWorldView?.homeArea ?? 'plaza';
        const freshParts = buildStartingWorldViewParts(spawnArea);
        cognition.resetExperience(freshParts.myExperience);
        this.wireFourStreamMemory(cognition, agent, sharedMemoryStore);
        sharedMemoryStore.hydeProvider = cheapLlm;
        if (this.sharedEmbeddingProvider && sharedMemoryStore instanceof RdsMemoryStore) {
          sharedMemoryStore.embeddingProvider = this.sharedEmbeddingProvider;
        }
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
          this.cognitions,
          this.controllers,
          this.mapConfig,
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
          controller.currentGoals = ctrlData.currentGoals ?? [];
          controller.activityTimer = ctrlData.activityTimer ?? 0;
          controller.conversationCooldown = ctrlData.conversationCooldown ?? 0;
        }

        controller.decisionQueue = this.decisionQueue;
    if (this.werewolfManager) controller.werewolfManager = this.werewolfManager;
        this.controllers.set(agent.id, controller);
      }

      // --- One-shot resurrection via env var (set, deploy, then remove) ---
      if (process.env.RESURRECT_AGENTS) {
        const names = process.env.RESURRECT_AGENTS.split(',').map(n => n.trim().toLowerCase());
        console.log(`[Engine] RESURRECT_AGENTS env set — looking for: ${names.join(', ')}`);
        for (const agent of this.world.agents.values()) {
          if (names.includes(agent.config.name.toLowerCase())) {
            console.log(`[Engine] Found ${agent.config.name}: alive=${agent.alive}, state=${agent.state}`);
            if (agent.alive === false || agent.state === 'dead') {
              console.log(`[Engine] Resurrecting ${agent.config.name} via RESURRECT_AGENTS env var`);
              void this.resurrectAgent(agent.id);
            }
          }
        }
      }

      // --- Data cleanup: fix corrupted commitments, concerns, and institution spam ---
      const currentDay = this.world.time.day;
      for (const agent of agents) {
        // P1: Fix commitments with createdDay > currentDay (from world reset)
        for (const c of (agent.commitments ?? [])) {
          if (c.createdDay > currentDay) {
            c.broken = true; // These are from a prior world state — mark broken
          }
        }
        // Archive broken ones
        if (agent.commitments) {
          const broken = agent.commitments.filter(c => c.broken);
          for (const c of broken) {
            c.archivedAt = Date.now();
            if (!agent.archivedCommitments) agent.archivedCommitments = [];
            if (agent.archivedCommitments.length >= 20) agent.archivedCommitments.shift();
            agent.archivedCommitments.push(c);
          }
          agent.commitments = agent.commitments.filter(c => !c.broken && !c.fulfilled);
        }

        // P3: Prune duplicate rule concerns (keep one per unique content)
        if (agent.activeConcerns) {
          const seen = new Set<string>();
          agent.activeConcerns = agent.activeConcerns.filter(c => {
            // Deduplicate rules by content
            if (c.category === 'rule') {
              const key = c.content.toLowerCase().slice(0, 80);
              if (seen.has(key)) return false;
              seen.add(key);
            }
            // Remove commitment concerns for dissolved institutions
            if (c.category === 'commitment' && c.content.includes('I founded ')) {
              const instName = c.content.match(/I founded (.+?) with/)?.[1];
              if (instName) {
                const inst = Array.from(this.world.institutions.values()).find(
                  i => i.name === instName
                );
                if (!inst || inst.dissolved) return false;
                // Keep only if agent is still a member
                const isMember = inst.members.some(m => m.agentId === agent.id);
                if (!isMember) return false;
              }
            }
            return true;
          });
          // Cap at 12 total
          if (agent.activeConcerns.length > 12) {
            agent.activeConcerns = agent.activeConcerns.slice(0, 12);
          }
        }

        // P4: Enforce one institution per agent — keep only the first non-dissolved
        if (agent.institutionIds && agent.institutionIds.length > 1) {
          const validId = agent.institutionIds.find(id => {
            const inst = this.world.getInstitution(id);
            return inst && !inst.dissolved;
          });
          // Remove agent from all other institutions
          for (const instId of agent.institutionIds) {
            if (instId !== validId) {
              const inst = this.world.getInstitution(instId);
              if (inst) {
                inst.members = inst.members.filter(m => m.agentId !== agent.id);
                // Dissolve if no members left
                if (inst.members.length === 0) inst.dissolved = true;
              }
            }
          }
          agent.institutionIds = validId ? [validId] : [];
        }
      }
      console.log(`[Engine] Data cleanup complete for ${agents.length} agents (day=${currentDay})`);

      // --- Soul Rewrite Migration: apply once, then fresh-start ---
      let soulMigrationApplied = false;
      for (const agent of this.world.agents.values()) {
        const overwrite = SOUL_REWRITES[agent.config.name];
        if (overwrite && agent.config.soul !== overwrite.soul) {
          agent.config.soul = overwrite.soul;
          agent.config.backstory = overwrite.backstory;
          agent.config.goal = overwrite.goal;
          agent.config.occupation = overwrite.occupation;
          agent.config.personality = overwrite.personality;
          agent.config.fears = overwrite.fears;
          agent.config.desires = overwrite.desires;
          agent.config.contradictions = overwrite.contradictions;
          agent.config.secretShames = overwrite.secretShames;
          agent.config.speechPattern = overwrite.speechPattern;
          agent.config.humorStyle = overwrite.humorStyle;
          agent.config.coreValues = overwrite.coreValues;
          agent.config.constitutionalRules = overwrite.constitutionalRules;
          agent.config.startingRelationships = overwrite.startingRelationships;
          console.log(`[SoulRewrite] Updated: ${agent.config.name}`);
          soulMigrationApplied = true;
        }
      }
      // Remove agents marked for deletion
      for (const name of AGENTS_TO_REMOVE) {
        for (const agent of this.world.agents.values()) {
          if (agent.config.name === name) {
            console.log(`[SoulRewrite] Removing agent: ${name} (${agent.id})`);
            this.removeAgent(agent.id);
            soulMigrationApplied = true;
            break;
          }
        }
      }
      if (soulMigrationApplied) {
        console.log('[SoulRewrite] Migration applied — triggering fresh start to reset memories/state');
        const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
        for (const agent of this.world.agents.values()) {
          const keyData = this.agentApiKeys.get(agent.id);
          if (keyData && keyData.model !== HAIKU_MODEL) {
            console.log(`[SoulRewrite] ${agent.config.name}: ${keyData.model} → ${HAIKU_MODEL}`);
            keyData.model = HAIKU_MODEL;
          }
        }
        if (this.persistence) {
          await this.persistence.saveAgents(this.world.agents, this.mapConfig.id);
        }
        this.refreshNameMaps();
        await this.freshStart();
        return;
      }

      console.log(`[Engine] Restored ${agents.length} agents from RDS`);
      this.refreshNameMaps();
    } catch (err) {
      // Re-throw so initialize() → process.exit(1) in index.ts.
      // Starting with an empty world after a DB failure would silently wipe simulation state.
      console.error('[Engine] Failed to load from RDS — aborting startup:', err);
      throw err;
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
    const spawnArea = this.mapConfig.spawnAreas[
      Math.floor(Math.random() * this.mapConfig.spawnAreas.length)
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
      mapId: this.mapConfig.id,
      mood: 'neutral',
      inventory: [],
      skills: [],
    };

    agent.drives = { survival: 50, safety: 60, belonging: 40, status: 30, meaning: 20 };
    agent.vitals = { health: 100, hunger: 0, energy: 100 };
    agent.alive = true;
    agent.mentalModels = [];
    agent.activeConcerns = [];
    agent.dossiers = [];
    agent.institutionIds = [];

    // Sensible defaults — overwritten by generateSoulWeights() once the LLM call returns.
    agent.rewardWeights = { ...DEFAULT_REWARD_WEIGHTS };
    agent.normWeight = 0.5;

    this.world.addAgent(agent);

    // Starting provisions — 2 bread; at 1 hunger/hour they run out by Day 2
    for (let i = 0; i < 2; i++) {
      this.world.addItem({
        id: crypto.randomUUID(),
        name: 'Bread',
        description: 'A loaf of bread',
        ownerId: agent.id,
        createdBy: 'starting_provisions',
        value: 3,
        type: 'food',
      });
    }

    // Create cognition stack with per-agent BYOK key only — no global fallback.
    const effectiveKey = apiKey ?? '';
    const effectiveModel = model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
    if (!effectiveKey) {
      console.warn(`[Engine] Agent ${config.name} added without a BYOK key — LLM calls will be skipped`);
    }
    this.agentApiKeys.set(id, { apiKey: effectiveKey, model: effectiveModel });
    const memoryStore = this.persistence
      ? new RdsMemoryStore(this.persistence.pool)
      : new InMemoryStore();
    const llmProvider = this.getThrottledProvider(effectiveKey ?? '', effectiveModel);
    const cheapLlm = this.getThrottledProvider(effectiveKey ?? '', SimulationEngine.CHEAP_LLM_MODEL);
    const startingParts = buildStartingWorldViewParts(spawnArea);
    const cognition = new AgentCognition(agent, memoryStore, llmProvider, startingParts, this.getGameRulesForAgent(agent));
    cognition.cheapLlmProvider = cheapLlm;
    this.wireFourStreamMemory(cognition, agent, memoryStore);
    // Wire HyDE provider for semantic query expansion (Phase 3 memory upgrade / item 2A).
    // Uses cheap model — HyDE query expansion is low-stakes and benefits from speed.
    if (memoryStore instanceof InMemoryStore || memoryStore instanceof RdsMemoryStore) {
      memoryStore.hydeProvider = cheapLlm;
      if (this.sharedEmbeddingProvider) memoryStore.embeddingProvider = this.sharedEmbeddingProvider;
    }
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
      this.cognitions,
      this.controllers,
      this.mapConfig,
    );
    controller.onDeath = (agentId, cause) => this.onControllerDeath(agentId, cause);
    controller.bus = this.bus;
    controller.decisionQueue = this.decisionQueue;
    if (this.werewolfManager) controller.werewolfManager = this.werewolfManager;
    this.controllers.set(id, controller);

    console.log(
      `[Engine] Agent created: ${config.name}${config.occupation ? ' (' + config.occupation + ')' : ''} at ${spawnArea}`,
    );

    // Save agent to RDS FIRST, then seed memories (FK: memories.agent_id → agents.id)
    const seedMemories = async () => {
      // Use soul (rich character text) when backstory is empty
      const identityText = config.soul || config.backstory || '';
      await cognition.addMemory({
        id: crypto.randomUUID(), agentId: id, type: 'reflection',
        content: `I am ${config.name}. ${identityText}`,
        importance: 9, isCore: true, timestamp: Date.now(), relatedAgentIds: [],
      });
      // Seed goal from explicit goal field, or first desire as fallback
      const effectiveGoal = config.goal || (config.desires?.length ? config.desires[0] : '');
      if (effectiveGoal) {
        await cognition.addMemory({
          id: crypto.randomUUID(), agentId: id, type: 'reflection',
          content: `My goal: ${effectiveGoal}`,
          importance: 9, isCore: true, timestamp: Date.now(), relatedAgentIds: [],
        });
      }
      await cognition.addMemory({
        id: crypto.randomUUID(), agentId: id, type: 'observation',
        content: `I just arrived at the ${spawnArea}. I should explore to discover what else is in this village.`,
        importance: 5, timestamp: Date.now(), relatedAgentIds: [],
      });
    };

    // Save then seed — memories.agent_id FK requires agents row to exist first.
    // saveAllFireAndForget keeps worldStateVersion in sync so the next periodic save
    // does not trigger a spurious VersionConflictError.
    this.saveAllFireAndForget('addAgent', seedMemories);

    // Fire-and-forget: derive reward weights, norm sensitivity, and goal affinities
    // from soul text via cheap LLM. Agent runs with defaults until this completes.
    void this.generateSoulWeights(agent);

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
    // Free TF-IDF embedder from shared store (prevents memory leak in long-running simulations)
    this.sharedMemoryStore?.cleanup(id);

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

    // Delete from RDS (CASCADE removes controller + memories)
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

    this.saveAllFireAndForget('suspendAgent');

    return true;
  }

  resumeAgent(id: string): boolean {
    const agent = this.world.getAgent(id);
    if (!agent || agent.state !== 'away') return false;

    // Recreate cognition with BYOK key only — no global fallback.
    const keyData = this.agentApiKeys.get(id);
    const effectiveKey = keyData?.apiKey ?? '';
    const effectiveModel = keyData?.model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
    if (!effectiveKey) {
      console.warn(`[Engine] Agent ${id} resumed without a BYOK key — LLM calls will be skipped`);
    }

    const memoryStore = this.persistence
      ? new RdsMemoryStore(this.persistence.pool)
      : new InMemoryStore();
    const llmProvider = this.getThrottledProvider(effectiveKey, effectiveModel);
    const cheapLlm = this.getThrottledProvider(effectiveKey, SimulationEngine.CHEAP_LLM_MODEL);
    // Preserve worldViewParts from old cognition if available
    const oldCognition = this.cognitions.get(id);
    const cognition = new AgentCognition(agent, memoryStore, llmProvider, oldCognition?.worldViewParts, this.getGameRulesForAgent(agent));
    cognition.cheapLlmProvider = cheapLlm;
    this.wireFourStreamMemory(cognition, agent, memoryStore);
    if (memoryStore instanceof InMemoryStore || memoryStore instanceof RdsMemoryStore) {
      memoryStore.hydeProvider = cheapLlm;
      if (this.sharedEmbeddingProvider) memoryStore.embeddingProvider = this.sharedEmbeddingProvider;
    }
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
      this.cognitions,
      this.controllers,
      this.mapConfig,
    );
    controller.onDeath = (agentId, cause) => this.onControllerDeath(agentId, cause);
    controller.bus = this.bus;
    controller.decisionQueue = this.decisionQueue;
    if (this.werewolfManager) controller.werewolfManager = this.werewolfManager;
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

    this.saveAllFireAndForget('resumeAgent');

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

  async resurrectAgent(id: string): Promise<boolean> {
    const agent = this.world.getAgent(id);
    if (!agent || agent.alive !== false) return false;

    // Kill old controller/cognition to stop in-flight writes, then let them settle
    this.controllers.delete(id);
    this.cognitions.delete(id);
    if (this.decisionQueue) this.decisionQueue.removeAgent(id);
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Revive agent state — full reset to prevent stale data from previous life
    agent.alive = true;
    agent.causeOfDeath = undefined;
    agent.state = 'idle';
    agent.currentAction = 'arriving';
    agent.mood = 'neutral';
    agent.vitals = { health: 100, hunger: 0, energy: 100 };
    agent.drives = { survival: 50, safety: 60, belonging: 40, status: 30, meaning: 20 };
    agent.mentalModels = [];
    agent.socialLedger = [];
    agent.activeConcerns = [];
    agent.dossiers = [];
    agent.inventory = [];
    agent.skills = [];

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

    // Clear old memories BEFORE creating new store — await to prevent race condition
    if (this.persistence) {
      try {
        await this.persistence.deleteMemoriesForAgent(id);
        console.log(`[Engine] Cleared memories for ${agent.config.name} on resurrection`);
      } catch (err) {
        console.error(`[Engine] Failed to clear memories for ${agent.config.name}:`, err);
      }
    }

    // Recreate cognition with fresh worldView — BYOK key only, no global fallback.
    const keyData = this.agentApiKeys.get(id);
    const effectiveKey = keyData?.apiKey ?? '';
    const effectiveModel = keyData?.model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
    if (!effectiveKey) {
      console.warn(`[Engine] Agent ${id} resurrected without a BYOK key — LLM calls will be skipped`);
    }

    const memoryStore = this.persistence
      ? new RdsMemoryStore(this.persistence.pool)
      : new InMemoryStore();
    const llmProvider = this.getThrottledProvider(effectiveKey, effectiveModel);
    const cheapLlm = this.getThrottledProvider(effectiveKey, SimulationEngine.CHEAP_LLM_MODEL);
    const spawnArea = this.mapConfig.spawnAreas[
      Math.floor(Math.random() * this.mapConfig.spawnAreas.length)
    ];
    const startingParts = buildStartingWorldViewParts(spawnArea);
    const cognition = new AgentCognition(agent, memoryStore, llmProvider, startingParts, this.getGameRulesForAgent(agent));
    cognition.cheapLlmProvider = cheapLlm;
    this.wireFourStreamMemory(cognition, agent, memoryStore);
    if (memoryStore instanceof InMemoryStore || memoryStore instanceof RdsMemoryStore) {
      memoryStore.hydeProvider = cheapLlm;
      if (this.sharedEmbeddingProvider) memoryStore.embeddingProvider = this.sharedEmbeddingProvider;
    }
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
      this.cognitions,
      this.controllers,
      this.mapConfig,
    );
    controller.onDeath = (agentId, cause) => this.onControllerDeath(agentId, cause);
    controller.bus = this.bus;
    controller.decisionQueue = this.decisionQueue;
    if (this.werewolfManager) controller.werewolfManager = this.werewolfManager;
    this.controllers.set(id, controller);

    // Seed fresh-start memories — MUST await so first decide() has grounding in RDS
    const identityText = agent.config.soul || agent.config.backstory || '';
    await cognition.addMemory({
      id: crypto.randomUUID(), agentId: id, type: 'reflection',
      content: `I am ${agent.config.name}. ${identityText}`,
      importance: 9, isCore: true, timestamp: Date.now(), relatedAgentIds: [],
    });
    await cognition.addMemory({
      id: crypto.randomUUID(), agentId: id, type: 'observation',
      content: 'I just arrived at the village plaza. I have some bread and nothing else. I should look around and figure out what to do.',
      importance: 5, timestamp: Date.now(), relatedAgentIds: [],
    });

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
      const recoveryPost = this.world.board[this.world.board.length - 1];
      this.broadcaster.boardPost(recoveryPost);
      this.bus.emit({ type: 'board_post_created', post: recoveryPost });
      console.log(`[Engine] Removed ${deathPostIndices.length} death notice(s) for ${agentName}`);
    }

    console.log(`[Engine] Agent resurrected: ${agent.config.name}`);

    // Re-derive soul weights on resurrection (fresh start)
    void this.generateSoulWeights(agent);

    this.refreshNameMaps();

    this.saveAllFireAndForget('resurrectAgent');

    return true;
  }

  async resurrectAllAgents(): Promise<string[]> {
    const resurrected: string[] = [];
    for (const agent of this.world.agents.values()) {
      if (agent.alive === false) {
        if (await this.resurrectAgent(agent.id)) {
          resurrected.push(agent.config.name);
        }
      }
    }
    return resurrected;
  }

  start(): void {
    if (this.tickInterval) return;

    this.tickInterval = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        console.error('[Engine] CRITICAL: tick() threw — simulation paused to prevent corrupt state:', err);
        this.pause();
        this.io.emit('engine:error', { message: 'Simulation tick failed', error: String(err) });
      }
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
        .catch((err: unknown) => {
          console.warn('[Engine] executeQueuedDecision failed:', (err as Error).message);
        })
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

    // Capture leadership status BEFORE release() sets _isLeader=false.
    // Follower Pods must NOT write world state — they hold a stale in-memory copy and
    // would silently overwrite the leader's authoritative state.
    const wasLeader = this.leaderElection.isLeader;

    // Release leader lock before closing DB so the next Pod can acquire immediately.
    // destroy() also stops heartbeat + retry timers.
    await this.leaderElection.release();
    this.leaderElection.destroy();

    if (this.persistence) {
      if (wasLeader) {
        try {
          // Unconditional upsert (no expectedVersion): safe on graceful shutdown because
          // release() ran first, so the new leader has not yet started writing.
          await this.persistence.saveAll(this.world, this.controllers, this.agentApiKeys, this.mapConfig.id);
          console.log('[Engine] Final state saved to RDS');
        } catch (err) {
          console.error('[Engine] Final save failed:', err);
        }
      }
      try {
        await this.persistence.pool.end();
        console.log('[Engine] DB connection pool closed');
      } catch (err) {
        console.error('[Engine] DB pool close failed:', (err as Error).message);
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

    // Perception every 240 ticks (halved from 120 to reduce observation memory bloat)
    if (this.tickCount % 240 === 0) {
      this.bus.emit({ type: 'perception_cycle', tick: this.tickCount });
    }

    // --- Direct calls for subsystems with complex timing ---
    // Skip AI Village systems when running werewolf
    if (!this.werewolfManager) {
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
      if (this.world.time.totalMinutes - (obj.lastInteractedAt ?? 0) > DECAY_MINUTES) {
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
      const nearbyAreas = getAreas().filter(area => {
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
      ).catch((err: unknown) => {
        console.warn(`[Engine] perceive failed for ${agent.id}:`, (err as Error).message);
      });
    }
  }

  private checkProximityConversations(): void {
    const agents = Array.from(this.world.agents.values());

    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        const a1 = agents[i];
        const a2 = agents[j];

        // Werewolf night: only wolf-wolf conversations allowed
        if (this.werewolfManager?.shouldBlockConversation(a1.id, a2.id)) continue;

        // Check distance (within 3 tiles — close enough to visually see the connection)
        const dx = a1.position.x - a2.position.x;
        const dy = a1.position.y - a2.position.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > 3) continue;

        // Skip dead or away agents
        if (a1.alive === false || a2.alive === false) continue;
        if (a1.state === 'away' || a2.state === 'away') continue;

        // Check conversation pair cooldown — werewolf uses 5 ticks (rapid discussion is the game)
        const pairCooldown = this.werewolfManager ? 5 : 1800;
        const pairKey = [a1.id, a2.id].sort().join(':');
        const lastTick = this.lastConversationPair.get(pairKey);
        if (lastTick !== undefined && (this.tickCount - lastTick) < pairCooldown) continue;

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
          break; // break inner loop — allow other pairs to start conversations this tick
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
            // Release agents from conversation, recording per-pair partner
            for (const pid of conv.participants) {
              const controller = this.controllers.get(pid);
              if (controller) {
                const partnerId = conv.participants.find(p => p !== pid);
                controller.leaveConversation(partnerId);
              }
            }
          }
        })
        .catch((err: unknown) => {
          console.error('[Engine] Error advancing conversation:', err);
          // Release agents on error and mark conversation ended to prevent orphaning
          this.world.endConversation(conv.id);
          for (const pid of conv.participants) {
            const controller = this.controllers.get(pid);
            if (controller) {
              const partnerId = conv.participants.find(p => p !== pid);
              controller.leaveConversation(partnerId);
            }
          }
        });
    }
  }

  /**
   * Notify nearby bystanders that a conversation happened.
   * Werewolf mode: share summary content within 3 tiles (overhearing mechanic).
   * Normal mode: vague awareness within 5 tiles.
   */
  notifyConversationBystanders(conv: { participants: string[]; location: { x: number; y: number }; summary?: string }): void {
    const isWerewolf = !!this.werewolfManager;
    const radius = isWerewolf ? 3 : 5;
    const nearbyAgents = this.world.getNearbyAgents(conv.location, radius);
    for (const bystander of nearbyAgents) {
      if (conv.participants.includes(bystander.id)) continue;
      if (bystander.state === 'sleeping') continue;
      const participantNames = conv.participants
        .map(id => this.world.getAgent(id)?.config.name)
        .filter(Boolean).join(' and ');
      const cog = this.cognitions.get(bystander.id);
      if (cog) {
        // Werewolf: share what was actually said (overhearing)
        const content = isWerewolf && conv.summary
          ? `I overheard ${participantNames} discussing: ${conv.summary}`
          : `I noticed ${participantNames} talking nearby.`;
        const importance = isWerewolf && conv.summary ? 6 : 3;
        void cog.addMemory({
          id: crypto.randomUUID(),
          agentId: bystander.id,
          type: 'observation',
          content,
          importance,
          timestamp: Date.now(),
          relatedAgentIds: conv.participants,
        }).catch((err: unknown) => { console.warn('[Engine] addMemory failed (bystander):', (err as Error).message); });
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
          // Auto-populate village memory
          if (winner) {
            this.world.addVillageMemory({
              content: `${winner.config.name} won the election for ${resolved.position}.`,
              type: 'election',
              day: this.world.time.day,
              significance: 7,
            });
          }
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
      if (!seasonDef) {
        console.warn(`[Engine] checkSeasonAdvance: unknown season "${season}" — skipping announcement`);
        return;
      }

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
      const seasonPost = this.world.board[this.world.board.length - 1];
      this.broadcaster.boardPost(seasonPost);
      this.bus.emit({ type: 'board_post_created', post: seasonPost });

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
        }).catch((err: unknown) => { console.warn('[Engine] addMemory failed (season change):', (err as Error).message); });
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
    // Skip obituaries/artifacts for werewolf — deaths handled by phase manager
    if (this.werewolfManager) return;

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
    const deathPost = this.world.board[this.world.board.length - 1];
    this.broadcaster.boardPost(deathPost);
    this.bus.emit({ type: 'board_post_created', post: deathPost });

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
      }).catch((err: unknown) => { console.warn('[Engine] addMemory failed (agent death broadcast):', (err as Error).message); });

      // Personalized grief concern based on relationship
      const dossier = cognition.fourStream?.getDossier(agentId);
      const trust = dossier?.trust ?? 0;
      let concern: string;
      if (trust > 50) {
        concern = `${name} is dead. ${cause}. I lost someone I cared about. Could I have done more?`;
      } else if (trust < -20) {
        concern = `${name} is dead. ${cause}. One fewer threat.`;
      } else {
        concern = `${name} died of ${cause}. That could be me. I need to survive.`;
      }
      cognition.fourStream?.addConcern({
        id: crypto.randomUUID(), content: concern,
        category: 'threat', relatedAgentIds: [agentId],
        createdAt: this.world.time.totalMinutes,
      });
    }

    console.log(`[Engine] ${name} has died: ${cause}. Diary created, all agents notified.`);
  }

  getSnapshot(): WorldSnapshot {
    const snapshot = this.world.getSnapshot();
    // Enrich agents with worldView and sync memory streams from cognition.
    // Shallow-copy each agent's config to avoid mutating the originals in world.agents —
    // deleting private fields from the original would strip soul/backstory from LLM prompts
    // for the remainder of the process lifetime. (OWASP API3: Broken Object Property Level Auth)
    for (let i = 0; i < snapshot.agents.length; i++) {
      const agent = snapshot.agents[i];
      const cognition = this.cognitions.get(agent.id);
      if (cognition) {
        agent.worldView = cognition.worldView;
        cognition.fourStream?.syncAllToAgent();
      }
      // Shallow-copy config — strip private fields only from the snapshot copy,
      // keeping the original agent.config intact for LLM prompts.
      const rawCfg = agent.config as unknown as Record<string, unknown>;
      const safeCfg = { ...rawCfg };
      delete safeCfg['soul'];
      delete safeCfg['backstory'];
      delete safeCfg['fears'];
      delete safeCfg['desires'];
      delete safeCfg['speechPattern'];
      delete safeCfg['coreValues'];
      delete safeCfg['contradictions'];
      delete safeCfg['goal'];
      snapshot.agents[i] = { ...agent, config: safeCfg as unknown as typeof agent.config };
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
        // Cherry-pick only public fields — same policy as getSnapshot() and /api/agents.
        // OWASP API3:2023: never expose soul/backstory/fears/desires/speechPattern via any path.
        config: {
          name: a.config.name,
          age: a.config.age,
          occupation: a.config.occupation,
          personality: a.config.personality,
          spriteId: a.config.spriteId,
        },
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
    } catch (err) {
      console.warn(`[Engine] generateAgentThought failed for ${agentId}:`, (err as Error).message);
      return null;
    }
  }

  /**
   * When a board post appears, each alive agent generates a 1-2 sentence
   * reaction that becomes a comment on the post.
   */
  private async generatePostReactions(post: BoardPost): Promise<void> {
    // Skip system death notices (too many at once)
    if (post.authorId === 'system' && post.content.includes('has died')) return;

    // Agents mentioned by name get a concern
    for (const [agentId2, agent2] of this.world.agents) {
      if (agent2.alive === false || agentId2 === post.authorId) continue;
      const firstName = agent2.config.name.split(' ')[0].toLowerCase();
      if (post.content.toLowerCase().includes(firstName)) {
        const cog = this.cognitions.get(agentId2);
        if (cog?.fourStream) {
          cog.fourStream.addConcern({
            id: crypto.randomUUID(),
            content: `${post.authorName} posted about me: "${post.content.slice(0, 40)}". People are reading this.`,
            category: post.type === 'rumor' ? 'threat' : 'unresolved',
            relatedAgentIds: [post.authorId],
            createdAt: Date.now(),
          });
        }
      }
    }

    // Collect eligible agents (skip busy ones)
    const eligible: string[] = [];
    for (const [agentId, agent] of this.world.agents) {
      if (agent.alive === false) continue;
      if (agentId === post.authorId) continue;
      if (post.channel === 'group' && post.groupId) {
        const inst = this.world.getInstitution(post.groupId);
        if (!inst?.members.some(m => m.agentId === agentId)) continue;
      }
      const controller = this.controllers.get(agentId);
      if (controller?.apiExhausted) continue;
      // Skip agents who are busy
      if (controller?.state === 'conversing' ||
          controller?.state === 'deciding' ||
          controller?.state === 'reflecting') continue;
      eligible.push(agentId);
    }

    // Pick up to 3 random agents to react
    const reactors = eligible
      .sort(() => Math.random() - 0.5)
      .slice(0, 3);

    console.log(`[PostReaction] ${reactors.length} of ${eligible.length} agents reacting to: "${post.content.slice(0, 50)}"`);

    for (const agentId of reactors) {
      const agent = this.world.getAgent(agentId);
      const cognition = this.cognitions.get(agentId);
      if (!agent || !cognition) continue;

      try {
        // Build context IDs for dossier loading (author + mentioned agents)
        const contextIds: string[] = [];
        if (post.authorId && post.authorId !== 'system') {
          contextIds.push(post.authorId);
        }
        for (const [aid, ag] of this.world.agents) {
          if (ag.alive === false || aid === agentId) continue;
          const fn = ag.config.name.split(' ')[0].toLowerCase();
          if (post.content.toLowerCase().includes(fn)) {
            contextIds.push(aid);
          }
        }

        // Post type label
        const typeLabel = post.type === 'rule' ? 'RULE PROPOSAL'
          : post.type === 'news' ? 'NEWS'
          : post.type === 'rumor' ? 'ACCUSATION/RUMOR'
          : 'POST';

        // Author reputation context
        let authorRep = '';
        if (post.authorId !== 'system') {
          const repEntry = this.world.reputation?.find(
            r => r.toAgentId === post.authorId && r.fromAgentId === 'system'
          );
          if (repEntry && repEntry.score !== 0) {
            authorRep = ` (reputation: ${repEntry.score > 0 ? '+' : ''}${repEntry.score})`;
          }
        }

        const output = await cognition.think(
          `[${typeLabel}] ${post.authorName}${authorRep}: "${post.content}"`,
          `React honestly in 1 sentence. What do you think about this and the person who posted it?`,
          contextIds.length > 0 ? contextIds : undefined,
        );

        if (!post.comments) post.comments = [];
        post.comments.push({
          agentId,
          agentName: agent.config.name,
          content: output.thought,
          timestamp: Date.now(),
        });
        this.broadcaster.boardPostUpdate(post);
      } catch (err) {
        console.error(`[PostReaction] ${agent.config.name} failed:`, err);
      }

      // Small delay between reactions to avoid API flooding
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  /**
   * When a rule is proposed, every alive agent votes via a single LLM call.
   * Majority decides: passed or rejected. Results broadcast to all.
   */
  private async conductRuleVote(rulePost: BoardPost): Promise<void> {
    if (!rulePost.votes) rulePost.votes = [];
    const proposerName = rulePost.authorName;
    // Track who already voted to prevent duplicates
    const alreadyVoted = new Set(rulePost.votes.map(v => v.agentId));

    for (const [agentId, agent] of this.world.agents) {
      if (agent.alive === false) continue;
      if (alreadyVoted.has(agentId)) continue;
      if (agentId === rulePost.authorId) {
        // Proposer auto-votes for their own rule
        rulePost.votes.push({ agentId, vote: 'like' });
        alreadyVoted.add(agentId);
        continue;
      }

      const cognition = this.cognitions.get(agentId);
      if (!cognition) continue;

      const controller = this.controllers.get(agentId);
      if (controller?.apiExhausted) continue;

      // Skip agents in conversation — they're busy
      if (controller?.state === 'conversing') {
        console.log(`[RuleVote] ${agent.config.name} abstained (in conversation)`);
        continue;
      }

      try {
        // Build full working memory so voters can recall relevant experiences
        let memoryCtx = '';
        if (cognition.fourStream) {
          const wm = cognition.fourStream.buildWorkingMemory(
            undefined, undefined, undefined, 'plan',
            `rule vote ${proposerName} ${rulePost.content.slice(0, 80)}`,
          );
          const sections: string[] = [];
          if (wm.concerns) sections.push('WHAT\'S ON YOUR MIND:\n' + wm.concerns);
          if (wm.dossiers) sections.push('PEOPLE YOU KNOW:\n' + wm.dossiers);
          if (wm.beliefs) sections.push('WHAT YOU BELIEVE:\n' + wm.beliefs);
          if (wm.learnedStrategies) sections.push('LESSONS LEARNED:\n' + wm.learnedStrategies);
          if (wm.timeline) sections.push('RECENT EVENTS:\n' + wm.timeline);
          if (sections.length > 0) memoryCtx = '\n\n' + sections.join('\n\n');
        }

        // Village context
        const passedRules = this.world.getActiveBoard()
          .filter(p => p.type === 'rule' && p.ruleStatus === 'passed')
          .map(p => p.content.slice(0, 50));
        const existingRulesCtx = passedRules.length > 0
          ? `\nExisting village rules: ${passedRules.join('; ')}`
          : '\nNo village rules exist yet.';
        const aliveCount = Array.from(this.world.agents.values())
          .filter(a => a.alive !== false).length;
        const deadCount = Array.from(this.world.agents.values())
          .filter(a => a.alive === false).length;
        const seasonIdx = Math.floor((this.world.time.day - 1) / 30) % 4;
        const seasons = ['spring', 'summer', 'autumn', 'winter'];
        const villageCtx = `\nVillage: Day ${this.world.time.day}, ${seasons[seasonIdx]}. ${aliveCount} alive, ${deadCount} dead.`;

        // Proposer reputation
        let repContext = '';
        const repEntry = this.world.reputation?.find(
          r => r.toAgentId === rulePost.authorId && r.fromAgentId === 'system'
        );
        if (repEntry) {
          repContext = `\n${proposerName}'s public reputation: ${repEntry.score}.`;
        }

        // Tailor the voting prompt based on proposal type
        let voteQuestion: string;
        if (rulePost.repealTargetId) {
          const targetRule = this.world.getActiveBoard().find(p => p.id === rulePost.repealTargetId);
          voteQuestion = `${proposerName} wants to REPEAL an existing rule:
Rule to remove: "${targetRule?.ruleAction || targetRule?.content || 'unknown rule'}"
Reason: ${rulePost.content}

Has this rule helped or harmed the village? Do you want it removed?`;
        } else if (rulePost.occupationProposal) {
          voteQuestion = `${proposerName} wants to become the village ${rulePost.occupationProposal}:
"${rulePost.content}"

Is ${proposerName} suited for this role? Would the village benefit from having an official ${rulePost.occupationProposal}?`;
        } else {
          voteQuestion = `${proposerName} proposed a new village rule:
"${rulePost.content}"

Has this rule's subject affected you personally? Do you trust ${proposerName}? Would this rule help or hurt you and people you care about?`;
        }

        const result = await cognition.llmProvider.complete(
          `You are ${agent.config.name}. Answer with ONLY "support" or "oppose". Nothing else.`,
          `${cognition.identityBlock}${memoryCtx}
${villageCtx}${existingRulesCtx}
${voteQuestion}
${repContext}

If this proposal addresses a real problem in the village and you have no strong personal objection, lean toward support — the proposer put their reputation on the line.
Vote based on YOUR experiences, relationships, and beliefs — not abstract principles.
Answer with ONLY one word: "support" or "oppose".`,
        );

        const rawVote = result.trim().toLowerCase();
        const supportIdx = rawVote.indexOf('support');
        const opposeIdx = rawVote.indexOf('oppose');
        let vote: 'like' | 'dislike';
        if (supportIdx >= 0 && opposeIdx >= 0) {
          // Both words found — check which comes first, but watch for negation before "support"
          const preSupport = rawVote.slice(Math.max(0, supportIdx - 15), supportIdx);
          const negated = /\b(don't|do not|not|cannot|never|refuse|wouldn't|won't)\b/.test(preSupport);
          vote = negated ? 'dislike' : 'like';
        } else if (supportIdx >= 0) {
          const preSupport = rawVote.slice(Math.max(0, supportIdx - 15), supportIdx);
          const negated = /\b(don't|do not|not|cannot|never|refuse|wouldn't|won't)\b/.test(preSupport);
          vote = negated ? 'dislike' : 'like';
        } else if (opposeIdx >= 0) {
          vote = 'dislike';
        } else {
          // Neither word found — default to support (engagement over inaction)
          vote = 'like';
        }
        rulePost.votes.push({ agentId, vote });

        void cognition.addMemory({
          id: crypto.randomUUID(), agentId, type: 'action_outcome',
          content: `I voted ${vote === 'like' ? 'for' : 'against'} ${proposerName}'s rule: "${rulePost.content.slice(0, 60)}"`,
          importance: 5, timestamp: Date.now(), relatedAgentIds: [rulePost.authorId],
        }).catch((err: unknown) => { console.warn('[Engine] addMemory failed (rule vote):', (err as Error).message); });

        this.broadcaster.agentAction(agentId, `voted ${vote === 'like' ? 'for' : 'against'} ${proposerName}'s rule`);
      } catch (err) {
        console.error(`[RuleVote] ${agent.config.name} failed to vote:`, err);
      }

      // Broadcast incremental vote updates to clients
      this.broadcaster.boardPostUpdate(rulePost);
    }

    // Tally and resolve
    const likeCount = rulePost.votes.filter(v => v.vote === 'like').length;
    const dislikeCount = rulePost.votes.filter(v => v.vote === 'dislike').length;

    // Build vote breakdown for transparency
    const supporters = rulePost.votes
      .filter(v => v.vote === 'like')
      .map(v => this.world.getAgent(v.agentId)?.config.name)
      .filter(Boolean);
    const opposers = rulePost.votes
      .filter(v => v.vote === 'dislike')
      .map(v => this.world.getAgent(v.agentId)?.config.name)
      .filter(Boolean);
    const voteBreakdown = `For: ${supporters.join(', ') || 'none'}. Against: ${opposers.join(', ') || 'none'}.`;

    if (likeCount > dislikeCount) {
      rulePost.ruleStatus = 'passed';

      // --- Handle REPEAL proposals ---
      if (rulePost.repealTargetId) {
        const targetRule = this.world.getActiveBoard().find(p => p.id === rulePost.repealTargetId);
        if (targetRule) {
          targetRule.ruleStatus = 'repealed';
          this.broadcaster.boardPostUpdate(targetRule);

          // Remove the permanent concern for the repealed rule from all agents
          for (const [id, agent] of this.world.agents) {
            if (agent.alive === false) continue;
            const cog = this.cognitions.get(id);
            if (cog?.fourStream) {
              cog.fourStream.removeConcernsByContent(targetRule.ruleAction || targetRule.content);
            }
          }

          this.world.addVillageMemory({
            content: `Rule REPEALED (${likeCount}-${dislikeCount}): "${(targetRule.ruleAction || targetRule.content).slice(0, 60)}". Protested by ${rulePost.authorName}.`,
            type: 'rule',
            day: this.world.time.day,
            significance: 7,
          });

          // Notify all agents about the repeal
          for (const [id, agent] of this.world.agents) {
            if (agent.alive === false) continue;
            const cog = this.cognitions.get(id);
            if (cog) {
              void cog.addMemory({
                id: crypto.randomUUID(), agentId: id, type: 'observation',
                content: `Rule REPEALED (${likeCount}-${dislikeCount}): "${(targetRule.ruleAction || targetRule.content).slice(0, 50)}". ${voteBreakdown}`,
                importance: 8, timestamp: Date.now(), relatedAgentIds: [rulePost.authorId],
              }).catch((err: unknown) => { console.warn('[Engine] addMemory failed (repeal):', (err as Error).message); });
            }
          }

          const repealNews: BoardPost = {
            id: crypto.randomUUID(), authorId: 'system', authorName: 'Village News',
            type: 'news', channel: 'all',
            content: `Rule repealed (${likeCount}-${dislikeCount}): "${(targetRule.ruleAction || targetRule.content).slice(0, 80)}". ${voteBreakdown}`,
            timestamp: Date.now(), day: this.world.time.day,
          };
          this.world.addBoardPost(repealNews);
          this.broadcaster.boardPost(repealNews);

          console.log(`[RuleVote] REPEALED: "${targetRule.ruleAction || targetRule.content}" (${likeCount}-${dislikeCount})`);
        }
        this.broadcaster.boardPostUpdate(rulePost);
        return;
      }

      // --- Handle OCCUPATION proposals ---
      if (rulePost.occupationProposal) {
        const proposer = this.world.getAgent(rulePost.authorId);
        if (proposer) {
          proposer.config.occupation = rulePost.occupationProposal;
        }

        this.world.addVillageMemory({
          content: `${rulePost.authorName} is now the village ${rulePost.occupationProposal} (voted ${likeCount}-${dislikeCount}).`,
          type: 'election',
          day: this.world.time.day,
          significance: 7,
        });

        // High-importance memory for ALL agents about the new occupation
        for (const [id, agent] of this.world.agents) {
          if (agent.alive === false) continue;
          const cog = this.cognitions.get(id);
          if (cog) {
            const isProposer = id === rulePost.authorId;
            void cog.addMemory({
              id: crypto.randomUUID(), agentId: id, type: 'observation',
              content: isProposer
                ? `I am now the official village ${rulePost.occupationProposal}! Voted ${likeCount}-${dislikeCount}. I must fulfill this role.`
                : `${rulePost.authorName} is now the official village ${rulePost.occupationProposal} (voted ${likeCount}-${dislikeCount}).`,
              importance: isProposer ? 9 : 7,
              timestamp: Date.now(), relatedAgentIds: [rulePost.authorId],
            }).catch((err: unknown) => { console.warn('[Engine] addMemory failed (occupation):', (err as Error).message); });
          }
          // Add permanent concern so agents always know this person's role
          if (cog?.fourStream) {
            cog.fourStream.addConcern({
              id: crypto.randomUUID(),
              content: id === rulePost.authorId
                ? `I am the village ${rulePost.occupationProposal}. This is my duty and identity.`
                : `${rulePost.authorName} is the village ${rulePost.occupationProposal}.`,
              category: 'goal',
              relatedAgentIds: [rulePost.authorId],
              createdAt: this.world.time.totalMinutes,
              permanent: true,
            });
          }
        }

        const occNews: BoardPost = {
          id: crypto.randomUUID(), authorId: 'system', authorName: 'Village News',
          type: 'news', channel: 'all',
          content: `${rulePost.authorName} voted in as village ${rulePost.occupationProposal} (${likeCount}-${dislikeCount}). ${voteBreakdown}`,
          timestamp: Date.now(), day: this.world.time.day,
        };
        this.world.addBoardPost(occNews);
        this.broadcaster.boardPost(occNews);

        console.log(`[RuleVote] OCCUPATION APPROVED: ${rulePost.authorName} → ${rulePost.occupationProposal} (${likeCount}-${dislikeCount})`);
        this.broadcaster.boardPostUpdate(rulePost);
        return;
      }

      // Village collective memory — rule passed
      this.world.addVillageMemory({
        content: `"${rulePost.content.slice(0, 60)}" rule passed ${likeCount}-${dislikeCount}. Proposed by ${rulePost.authorName}.`,
        type: 'rule',
        day: this.world.time.day,
        significance: 7,
      });

      // Handle property claim if this is a claim vote
      if (rulePost.claimTarget) {
        const ct = rulePost.claimTarget;
        if (ct.type === 'area') {
          const prop = this.world.claimProperty(ct.id, rulePost.authorId, this.world.time.day);
          if (prop) this.broadcaster.propertyChange(prop);
        } else if (ct.type === 'building') {
          const building = this.world.getBuilding(ct.id);
          if (building) {
            building.ownerId = rulePost.authorId;
            this.broadcaster.buildingUpdate(building);
          }
        }
      }

      // Add permanent concern to ALL agents (rule or claim)
      // Include structured fields so agents see the full rule (who + consequence)
      let concernContent: string;
      if (rulePost.claimTarget) {
        concernContent = `Property: ${rulePost.content}`;
      } else if (rulePost.ruleAction && rulePost.ruleConsequence) {
        concernContent = `Village rule: ${rulePost.ruleAction}\nApplies to: ${rulePost.ruleAppliesTo || 'Everyone'}\nConsequence: ${rulePost.ruleConsequence}`;
      } else {
        concernContent = `Village rule: ${rulePost.content}`;
      }
      for (const [id, agent] of this.world.agents) {
        if (agent.alive === false) continue;
        const cog = this.cognitions.get(id);
        if (cog?.fourStream) {
          cog.fourStream.addConcern({
            id: crypto.randomUUID(),
            content: concernContent,
            category: 'rule',
            relatedAgentIds: [],
            createdAt: this.world.time.totalMinutes,
            permanent: true,
          });
        }
        if (cog) {
          void cog.addMemory({
            id: crypto.randomUUID(), agentId: id, type: 'observation',
            content: id === rulePost.authorId
              ? `My rule passed (${likeCount}-${dislikeCount})! "${rulePost.content.slice(0, 50)}". ${voteBreakdown}`
              : `Vote passed (${likeCount}-${dislikeCount}): "${rulePost.content.slice(0, 50)}". ${voteBreakdown}`,
            importance: id === rulePost.authorId ? 9 : 7,
            timestamp: Date.now(), relatedAgentIds: [rulePost.authorId],
          }).catch((err: unknown) => { console.warn('[Engine] addMemory failed (rule passed):', (err as Error).message); });
        }
      }

      // Personalized post-vote concerns for passed rules
      for (const v of rulePost.votes) {
        if (v.agentId === rulePost.authorId) continue;
        const agentCog = this.cognitions.get(v.agentId);
        if (!agentCog?.fourStream) continue;
        if (v.vote === 'dislike') {
          agentCog.fourStream.addConcern({
            id: crypto.randomUUID(),
            content: `A rule I opposed passed: "${rulePost.content.slice(0, 40)}". I must follow it or face consequences.`,
            category: 'unresolved',
            relatedAgentIds: [rulePost.authorId],
            createdAt: this.world.time.totalMinutes,
          });
        }
      }

      // Proposer learns who supported them
      const supporterIds = rulePost.votes
        .filter(v => v.vote === 'like' && v.agentId !== rulePost.authorId)
        .map(v => v.agentId);
      if (supporterIds.length > 0) {
        const proposerCog = this.cognitions.get(rulePost.authorId);
        if (proposerCog?.fourStream) {
          const supporterNames = supporterIds
            .map(id => this.world.getAgent(id)?.config.name)
            .filter(Boolean).join(', ');
          proposerCog.fourStream.addConcern({
            id: crypto.randomUUID(),
            content: `${supporterNames} supported my rule. They're my political allies.`,
            category: 'goal',
            relatedAgentIds: supporterIds,
            createdAt: this.world.time.totalMinutes,
          });
        }
      }

      // News post with vote breakdown
      const newsPost: BoardPost = {
        id: crypto.randomUUID(), authorId: 'system', authorName: 'Village News',
        type: 'news', channel: 'all',
        content: `${rulePost.claimTarget ? 'Claim' : 'Rule'} passed (${likeCount}-${dislikeCount}): "${rulePost.content}". ${voteBreakdown}`,
        timestamp: Date.now(), day: this.world.time.day,
      };
      this.world.addBoardPost(newsPost);
      this.broadcaster.boardPost(newsPost);
      if (this.bus) this.bus.emit({ type: 'board_post_created', post: newsPost });

      // Reputation boost for proposer
      const proposerCtrlP = this.controllers.get(rulePost.authorId);
      proposerCtrlP?.adjustReputation(rulePost.authorId, +5, 'Governance');

      console.log(`[RuleVote] PASSED: "${rulePost.content}" (${likeCount}-${dislikeCount})`);
    } else {
      rulePost.ruleStatus = 'rejected';

      // Village collective memory — rule rejected
      this.world.addVillageMemory({
        content: `"${rulePost.content.slice(0, 60)}" rule rejected ${likeCount}-${dislikeCount}. Proposed by ${rulePost.authorName}.`,
        type: 'rule',
        day: this.world.time.day,
        significance: 5,
      });

      // Notify all agents of the rejection with vote breakdown
      for (const [id, agent] of this.world.agents) {
        if (agent.alive === false) continue;
        const cog = this.cognitions.get(id);
        if (!cog) continue;
        const isProposer = id === rulePost.authorId;
        void cog.addMemory({
          id: crypto.randomUUID(), agentId: id, type: 'observation',
          content: isProposer
            ? `My rule was REJECTED (${likeCount}-${dislikeCount}): "${rulePost.content.slice(0, 50)}". ${voteBreakdown}`
            : `Vote rejected (${likeCount}-${dislikeCount}): "${rulePost.content.slice(0, 50)}". ${voteBreakdown}`,
          importance: isProposer ? 9 : 5, timestamp: Date.now(), relatedAgentIds: [rulePost.authorId],
        }).catch((err: unknown) => { console.warn('[Engine] addMemory failed (rule rejected):', (err as Error).message); });
      }

      // Personalized post-vote concerns for rejected rules
      for (const v of rulePost.votes) {
        if (v.agentId === rulePost.authorId) continue;
        const agentCog = this.cognitions.get(v.agentId);
        if (!agentCog?.fourStream) continue;
        if (v.vote === 'like') {
          agentCog.fourStream.addConcern({
            id: crypto.randomUUID(),
            content: `A rule I supported was rejected: "${rulePost.content.slice(0, 40)}". Need to build support or compromise.`,
            category: 'unresolved',
            relatedAgentIds: [rulePost.authorId],
            createdAt: this.world.time.totalMinutes,
          });
        }
      }

      // Proposer learns who opposed them
      const opposerIds = rulePost.votes
        .filter(v => v.vote === 'dislike')
        .map(v => v.agentId);
      if (opposerIds.length > 0) {
        const proposerCog = this.cognitions.get(rulePost.authorId);
        if (proposerCog?.fourStream) {
          const opposerNames = opposerIds
            .map(id => this.world.getAgent(id)?.config.name)
            .filter(Boolean).slice(0, 3).join(', ');
          proposerCog.fourStream.addConcern({
            id: crypto.randomUUID(),
            content: `${opposerNames} voted against my rule. Convince them or work around them.`,
            category: 'unresolved',
            relatedAgentIds: opposerIds,
            createdAt: this.world.time.totalMinutes,
          });
        }
      }

      // Proposer learns who backed them (even in rejection)
      const rejSupporterIds = rulePost.votes
        .filter(v => v.vote === 'like' && v.agentId !== rulePost.authorId)
        .map(v => v.agentId);
      if (rejSupporterIds.length > 0) {
        const proposerCog = this.cognitions.get(rulePost.authorId);
        if (proposerCog?.fourStream) {
          const supporterNames = rejSupporterIds
            .map(id => this.world.getAgent(id)?.config.name)
            .filter(Boolean).join(', ');
          proposerCog.fourStream.addConcern({
            id: crypto.randomUUID(),
            content: `${supporterNames} supported my rule. They're my political allies.`,
            category: 'goal',
            relatedAgentIds: rejSupporterIds,
            createdAt: this.world.time.totalMinutes,
          });
        }
      }

      // Consequence concern for the proposer
      const proposerCtrl = this.controllers.get(rulePost.authorId);
      proposerCtrl?.addConsequence(
        `My ${rulePost.claimTarget ? 'claim' : 'rule'} was rejected. Need allies or different approach.`,
        'unresolved', []
      );

      // Reputation hit for failed proposal
      proposerCtrl?.adjustReputation(rulePost.authorId, -2, 'Failed proposal');

      // News post with vote breakdown
      const rejNewsPost: BoardPost = {
        id: crypto.randomUUID(), authorId: 'system', authorName: 'Village News',
        type: 'news', channel: 'all',
        content: `${rulePost.claimTarget ? 'Claim' : 'Rule'} rejected (${likeCount}-${dislikeCount}): "${rulePost.content}". ${voteBreakdown}`,
        timestamp: Date.now(), day: this.world.time.day,
      };
      this.world.addBoardPost(rejNewsPost);
      this.broadcaster.boardPost(rejNewsPost);
      if (this.bus) this.bus.emit({ type: 'board_post_created', post: rejNewsPost });

      console.log(`[RuleVote] REJECTED: "${rulePost.content}" (${likeCount}-${dislikeCount})`);
    }

    this.broadcaster.boardPostUpdate(rulePost);
  }

  private nightlyVoteInProgress = false;

  /**
   * At hour 21 each night, find all pending proposals and vote on each.
   */
  private async resolveNightlyVotes(): Promise<void> {
    if (this.nightlyVoteInProgress) return;
    this.nightlyVoteInProgress = true;

    try {
    const pending = this.world.getActiveBoard()
      .filter(p => p.type === 'rule' && p.ruleStatus === 'proposed');

    if (pending.length === 0) { this.nightlyVoteInProgress = false; return; }

    console.log(`[NightlyVote] Resolving ${pending.length} pending proposal(s)...`);
    for (const post of pending) {
      await this.conductRuleVote(post);
    }
    } finally {
      this.nightlyVoteInProgress = false;
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

  /** Four Stream Memory: categorical retrieval replacing TF-IDF flat pool */
  private wireFourStreamMemory(cognition: AgentCognition, agent: Agent, memoryStore: import('@ai-village/ai-engine').MemoryStore): void {
    const fourStream = new FourStreamMemory(agent.id, memoryStore, agent);
    fourStream.seedIdentity(agent.config);
    fourStream.setCurrentDay(this.world.time.day);
    cognition.fourStream = fourStream;
  }

  /**
   * One-shot cheap LLM call to derive reward weights, norm sensitivity, and goal
   * affinities from the agent's soul text + goal. Replaces Big Five personality-based
   * derivation so the reward system aligns with the character the LLM actually plays.
   *
   * Three outputs stored on agent:
   *   - rewardWeights: 7-axis weights (sum to 1.0)
   *   - normWeight: 0.1..0.9 scalar
   *   - goalAffinities: action-type → [-0.3, +0.5] affinity map
   *
   * Fire-and-forget — agent runs with DEFAULT_REWARD_WEIGHTS until this completes.
   */
  private async generateSoulWeights(agent: Agent): Promise<void> {
    const soul = agent.config.soul || agent.config.backstory || '';
    if (!soul) return;
    const keyInfo = this.agentApiKeys.get(agent.id);
    if (!keyInfo?.apiKey) return;
    const cheapLlm = this.getThrottledProvider(keyInfo.apiKey, SimulationEngine.CHEAP_LLM_MODEL);
    try {
      const actionTypes = [
        'gather', 'craft', 'trade', 'give', 'eat', 'rest', 'go',
        'talk', 'ally', 'betray', 'threaten', 'confront', 'steal', 'fight',
        'propose_rule', 'propose_group_rule', 'post_board', 'call_meeting',
        'claim', 'accuse', 'kick',
      ];
      const goal = agent.config.goal || '';
      const result = await cheapLlm.complete(
        `You are a game designer calibrating an AI village agent's reward system based on their character description. Output ONLY valid JSON with exactly these 3 keys:

1. "rewardWeights": object with keys hp, resources, social, goalProgress, exploration, normDeviation, villageImpact. Values 0.02-0.40, MUST sum to 1.0. Assign based on what THIS character would optimize for:
   - hp: survival, safety, health (high for cautious/anxious characters)
   - resources: material wealth, items, skills (high for acquisitive/industrious characters)
   - social: relationships, reputation, trust (high for social/political characters)
   - goalProgress: advancing their stated goal (high for driven/focused characters)
   - exploration: novelty, discovery (high for curious/adventurous characters)
   - normDeviation: conforming to village rules (high for rule-followers, LOW for rebels/criminals)
   - villageImpact: helping the commons (high for altruistic characters, low for selfish ones)

2. "normWeight": single number 0.1-0.9. How much this character cares about social norms. 0.1 = rebel/outcast who ignores rules. 0.9 = conformist who follows every rule.

3. "goalAffinities": object mapping action types to numbers -0.3 to 0.5. How well each action advances their goal. Omit actions with ~0 affinity.`,
        `Character: ${agent.config.name} (${agent.config.occupation || 'villager'})\n\nSoul:\n${soul.slice(0, 600)}\n\nGoal: "${goal}"\n\nAction types for goalAffinities: ${actionTypes.join(', ')}\n\nReturn the JSON:`
      );

      // Extract the outermost JSON object (may contain nested objects)
      const jsonStart = result.indexOf('{');
      const jsonEnd = result.lastIndexOf('}');
      if (jsonStart === -1 || jsonEnd === -1) return;
      const parsed = JSON.parse(result.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>;

      // --- rewardWeights ---
      const rawWeights = parsed.rewardWeights as Record<string, unknown> | undefined;
      if (rawWeights && typeof rawWeights === 'object') {
        const axes = ['hp', 'resources', 'social', 'goalProgress', 'exploration', 'normDeviation', 'villageImpact'];
        const floored: Record<string, number> = {};
        for (const axis of axes) {
          const v = rawWeights[axis];
          floored[axis] = typeof v === 'number' ? Math.max(0.02, Math.min(0.40, v)) : 0.14;
        }
        // Normalize to sum = 1.0
        const sum = Object.values(floored).reduce((s, v) => s + v, 0);
        const norm = (k: string) => Math.round((floored[k] / sum) * 1000) / 1000;
        agent.rewardWeights = {
          hp: norm('hp'), resources: norm('resources'), social: norm('social'),
          goalProgress: norm('goalProgress'), exploration: norm('exploration'),
          normDeviation: norm('normDeviation'), villageImpact: norm('villageImpact'),
        };
        console.log(`[Engine] Soul weights for ${agent.config.name}: ${JSON.stringify(agent.rewardWeights)}`);
      }

      // --- normWeight ---
      const rawNorm = parsed.normWeight;
      if (typeof rawNorm === 'number') {
        agent.normWeight = Math.max(0.1, Math.min(0.9, Math.round(rawNorm * 100) / 100));
        console.log(`[Engine] Soul normWeight for ${agent.config.name}: ${agent.normWeight}`);
      }

      // --- goalAffinities ---
      const rawAffinities = parsed.goalAffinities as Record<string, unknown> | undefined;
      if (rawAffinities && typeof rawAffinities === 'object') {
        const affinities: Record<string, number> = {};
        for (const [key, val] of Object.entries(rawAffinities)) {
          if (typeof val === 'number' && val >= -0.3 && val <= 0.5 && actionTypes.includes(key)) {
            affinities[key] = Math.round(val * 100) / 100;
          }
        }
        if (Object.keys(affinities).length > 0) {
          agent.goalAffinities = affinities;
          console.log(`[Engine] Soul affinities for ${agent.config.name}: ${JSON.stringify(affinities)}`);
        }
      }
    } catch (err) {
      console.warn(`[Engine] Soul weight generation failed for ${agent.config.name}:`, (err as Error).message);
    }
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
        }).catch((err: unknown) => {
          console.warn('[Engine] executeSocialAction failed:', (err as Error).message);
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
    const cheapLlm = this.getThrottledProvider(newApiKey, SimulationEngine.CHEAP_LLM_MODEL);
    const memoryStore = this.persistence
      ? new RdsMemoryStore(this.persistence.pool)
      : new InMemoryStore();
    const oldCognition = this.cognitions.get(agentId);
    const cognition = new AgentCognition(agent, memoryStore, llmProvider, oldCognition?.worldViewParts, this.getGameRulesForAgent(agent));
    cognition.cheapLlmProvider = cheapLlm;
    this.wireFourStreamMemory(cognition, agent, memoryStore);
    if (memoryStore instanceof InMemoryStore || memoryStore instanceof RdsMemoryStore) {
      memoryStore.hydeProvider = cheapLlm;
      if (this.sharedEmbeddingProvider) memoryStore.embeddingProvider = this.sharedEmbeddingProvider;
    }
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

    this.saveAllFireAndForget('updateAgentApiKey');

    console.log(`[Engine] API key updated for ${agent.config.name} (model: ${newModel})`);
    return true;
  }

  /**
   * Fresh start: wipe memories + world state, reset agents to day-1 state.
   * Keeps agents (same configs, same API keys) but erases all accumulated state.
   */
  async freshStart(): Promise<void> {
    // Only the leader Pod may wipe world state. A follower calling this would
    // corrupt the RDS row that the leader is actively reading/writing.
    if (!this.leaderElection.isLeader) {
      throw new Error('[Engine] freshStart() called on a follower Pod — only the leader may reset world state');
    }
    // Block periodic saves for the duration of the wipe so save_requested cannot
    // interleave with the DELETE+INSERT sequence inside freshStart.
    // try-finally guarantees the flag is cleared even if an exception is thrown
    // mid-way (e.g. RDS write fails during memory seeding), preventing a permanent
    // stall of the persistence layer.
    this.isReloadingState = true;
    const wasRunning = this.isRunning;
    this.pause();
    console.log('[Engine] Fresh start — wiping world state and memories');
    try {

    // 0. Kill old controllers/cognitions FIRST to stop all in-flight writes
    this.controllers.clear();
    this.cognitions.clear();
    if (this.decisionQueue) this.decisionQueue.clear();

    // Let any in-flight RDS writes from the old life settle
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log('[FreshStart] Old controllers cleared, in-flight writes settled');

    // 1. Wipe all agents from memory
    this.world.agents.clear();
    this.agentApiKeys.clear();
    this.lastConversationPair.clear();

    // 2. Wipe RDS data (agents, memories, world_state, agent_controllers)
    if (this.persistence) {
      try {
        await this.persistence.deleteAllAgents();
        console.log('[FreshStart] All agents deleted');
      } catch (err) {
        console.error('[FreshStart] Failed to delete agents:', err);
      }
      try {
        await this.persistence.deleteAllMemories();
        console.log('[FreshStart] All memories deleted');
      } catch (err) {
        console.error('[FreshStart] Failed to delete memories:', err);
      }
      try {
        await this.persistence.resetWorldState(this.mapConfig.id);
      } catch (err) {
        console.error('[FreshStart] Failed to reset world_state:', err);
      }
      try {
        await this.persistence.deleteAllControllers(this.mapConfig.id);
      } catch (err) {
        console.error('[FreshStart] Failed to delete controllers:', err);
      }
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
    this.world.villageMemory = [];
    for (const spawn of this.world.materialSpawns) {
      spawn.lastGathered = undefined;
    }

    // 3. Reset each agent to fresh state, recreate cognition + controller
    this.controllers.clear();
    this.cognitions.clear();
    this.lastConversationPair.clear();
    this.tickCount = 0;
    this.weatherStableUntil = 0;
    this.lastWeeklySummaryDay = 0;
    this.cachedWeeklySummary = null;
    this.weeklySummaryGenerating = false;

    const sharedMemoryStore = this.persistence
      ? new RdsMemoryStore(this.persistence.pool)
      : new InMemoryStore();
    this.sharedMemoryStore = sharedMemoryStore instanceof RdsMemoryStore ? sharedMemoryStore : null;
    this.cachedGameRules = null;

    for (const agent of this.world.agents.values()) {
      // Reset agent state
      const spawnArea = this.mapConfig.spawnAreas[
        Math.floor(Math.random() * this.mapConfig.spawnAreas.length)
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
      agent.socialLedger = [];
      agent.activeConcerns = [];
      agent.dossiers = [];
      agent.institutionIds = [];
      agent.joinedDay = 1;
      agent.commitments = [];
      agent.archivedCommitments = [];
      agent.beliefs = [];
      agent.learnedStrategies = [];
      agent.learnedAversions = [];
      agent.totalActionOutcomes = 0;
      agent.reasoningScore = undefined;
      agent.normWeight = undefined;
      agent.rewardWeights = undefined;
      agent.goalAffinities = undefined;
      agent.strategyHistory = [];
      agent.config.occupation = undefined;

      // Recreate cognition with fresh worldView — BYOK key only, no global fallback.
      const keyData = this.agentApiKeys.get(agent.id);
      const effectiveKey = keyData?.apiKey ?? '';
      const effectiveModel = keyData?.model || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
      if (!effectiveKey) {
        console.warn(`[Engine] Agent ${agent.config.name} fresh-started without a BYOK key — LLM calls will be skipped`);
      }
      const llmProvider = this.getThrottledProvider(effectiveKey, effectiveModel);
      const cheapLlm = this.getThrottledProvider(effectiveKey, SimulationEngine.CHEAP_LLM_MODEL);
      const startingParts = buildStartingWorldViewParts(spawnArea);
      const cognition = new AgentCognition(agent, sharedMemoryStore, llmProvider, startingParts, this.getGameRulesForAgent(agent));
      cognition.cheapLlmProvider = cheapLlm;
      this.wireFourStreamMemory(cognition, agent, sharedMemoryStore);
      if (sharedMemoryStore instanceof InMemoryStore || sharedMemoryStore instanceof RdsMemoryStore) {
        sharedMemoryStore.hydeProvider = cheapLlm;
        if (this.sharedEmbeddingProvider) sharedMemoryStore.embeddingProvider = this.sharedEmbeddingProvider;
      }
      this.cognitions.set(agent.id, cognition);

      // Seed identity memories — await so they exist in RDS before first decide()
      const identityText = agent.config.soul || agent.config.backstory || '';
      await cognition.addMemory({
        id: crypto.randomUUID(), agentId: agent.id, type: 'reflection',
        content: `I am ${agent.config.name}. ${identityText}`,
        importance: 9, isCore: true, timestamp: Date.now(), relatedAgentIds: [],
      });
      const effectiveGoal = agent.config.goal || (agent.config.desires?.length ? agent.config.desires[0] : '');
      if (effectiveGoal) {
        await cognition.addMemory({
          id: crypto.randomUUID(), agentId: agent.id, type: 'reflection',
          content: `My goal: ${effectiveGoal}`,
          importance: 9, isCore: true, timestamp: Date.now(), relatedAgentIds: [],
        });
      }
      await cognition.addMemory({
        id: crypto.randomUUID(), agentId: agent.id, type: 'observation',
        content: `I just arrived at the ${spawnArea}. I should explore to discover what else is in this village.`,
        importance: 5, timestamp: Date.now(), relatedAgentIds: [],
      });

      // Create fresh controller
      const controller = new AgentController(
        agent, cognition, this.world, this.broadcaster, 7, 23, 'plaza',
        this.createActionExecutor(),
        this.cognitions,
        this.controllers,
        this.mapConfig,
      );
      controller.onDeath = (id, cause) => this.onControllerDeath(id, cause);
      controller.bus = this.bus;
      controller.decisionQueue = this.decisionQueue;
    if (this.werewolfManager) controller.werewolfManager = this.werewolfManager;
      this.controllers.set(agent.id, controller);

      console.log(`[FreshStart] Agent ${agent.config.name} reset at ${spawnArea}`);
    }

    this.refreshNameMaps();

    // 4. Save fresh state to RDS
    if (this.persistence) {
      try {
        const newVersion = await this.persistence.saveAll(this.world, this.controllers, this.agentApiKeys, this.mapConfig.id);
        this.worldStateVersion = newVersion;
        console.log('[FreshStart] Fresh state saved to RDS');
      } catch (err) {
        console.error('[FreshStart] Save failed:', err);
      }
    }

    // 5. Final cleanup — delete any stale memories that landed after first wipe, then re-seed
    if (this.persistence) {
      // Nuke everything
      await this.persistence.deleteAllMemories();
      // Re-seed identity memories for all agents
      for (const [agentId, cognition] of this.cognitions.entries()) {
        const agent = this.world.getAgent(agentId);
        if (!agent) continue;
        const identityText = agent.config.soul || agent.config.backstory || '';
        await cognition.addMemory({
          id: crypto.randomUUID(), agentId, type: 'reflection',
          content: `I am ${agent.config.name}. ${identityText}`,
          importance: 9, isCore: true, timestamp: Date.now(), relatedAgentIds: [],
        });
        await cognition.addMemory({
          id: crypto.randomUUID(), agentId, type: 'observation',
          content: 'I just arrived at the village. I have some bread and nothing else. Time to explore.',
          importance: 5, timestamp: Date.now(), relatedAgentIds: [],
        });
      }
      console.log('[FreshStart] Final cleanup + re-seed complete');
    }

      // 6. Resume if was running
      if (wasRunning) {
        this.start();
      }
      console.log('[Engine] Fresh start complete — day 1, all agents reset');
    } finally {
      // Always re-enable periodic saves — even if an exception aborted the wipe.
      this.isReloadingState = false;
    }
  }

  get isConfigured(): boolean {
    // With BYOK, always allow — each agent carries its own key
    return true;
  }

  get isRunning(): boolean {
    return this.tickInterval !== null;
  }

  /** True when this Pod holds the Redis leader lock (or Redis is not configured). */
  get isLeader(): boolean {
    return this.leaderElection.isLeader;
  }

  /**
   * Fire-and-forget save that keeps worldStateVersion in sync after unconditional upserts.
   *
   * Every saveAll() call (addAgent, suspend, resume, resurrect, apikey update) increments
   * the version column in DB via unconditional upsert. If we don't mirror that increment
   * in this.worldStateVersion, the next periodic save (save_requested) would present a
   * stale expectedVersion → VersionConflictError → unnecessary reload loop.
   *
   * @param label  Short descriptor for error log context.
   * @param then   Optional async continuation (e.g. seedMemories).
   */
  private saveAllFireAndForget(label: string, then?: () => Promise<void>): void {
    if (!this.persistence) {
      if (then) void then();
      return;
    }
    void this.persistence.saveAll(this.world, this.controllers, this.agentApiKeys, this.mapConfig.id)
      .then((newVersion: number) => {
        this.worldStateVersion = newVersion;
        if (then) return then();
      })
      .catch((err: unknown) => {
        console.error(`[Persistence] Save after ${label} failed:`, (err as Error).message);
        // Do NOT call then() here. If persistence is enabled, `then` is typically
        // seedMemories() which writes to RDS via memories.agent_id FK. If the
        // agent row was not persisted due to this failure, FK constraint violation
        // would follow immediately.
      });
  }

  /**
   * Write the current world snapshot to Redis so follower Pods can serve
   * read-only API responses (getSnapshot, agent list, board, etc.) without
   * touching the DB or diverging from the leader's authoritative state.
   *
   * Key: ai-village:world:snapshot  TTL: 120 s
   * If Redis is unavailable the failure is logged but does not throw — followers
   * will fall back to their last cached snapshot or return stale data, which is
   * acceptable for a read-only view.
   */
  private async writeRedisSnapshot(precomputed?: WorldSnapshot): Promise<void> {
    const redis = getRedis();
    if (!redis) return; // single-Pod dev mode — no Redis, nothing to write

    try {
      const snapshot = precomputed ?? this.getSnapshot();
      await redis.set(
        'ai-village:world:snapshot',
        JSON.stringify(snapshot),
        'EX',
        120,
      );
    } catch (err) {
      // Non-fatal: followers serve the previous snapshot until the next write.
      console.error('[Engine] writeRedisSnapshot failed:', (err as Error).message);
    }
  }

  /**
   * Readiness check: verify the DB pool can serve a query.
   * Used by /api/ready (readinessProbe) so k8s removes the Pod from
   * Service traffic on DB outage without restarting it (livenessProbe is separate).
   *
   * Circuit-breaker pattern (AWS Well-Architected OE + OWASP Logging 7.1):
   *   - Circuit opens after DB_HEALTH_CIRCUIT_THRESHOLD consecutive failures.
   *   - While open, return false immediately without hitting DB (avoids pile-on).
   *   - Log only the 1st failure, the circuit-open event, and recovery — not every probe.
   */
  async isDbHealthy(): Promise<boolean> {
    if (!this.persistence) return true; // no persistence configured — always ready

    // Circuit open: suppress DB calls until reset timeout expires
    if (this.dbHealthCircuitOpenAt > 0) {
      if (Date.now() - this.dbHealthCircuitOpenAt < SimulationEngine.DB_HEALTH_CIRCUIT_RESET_MS) {
        return false;
      }
      // Reset — allow one probe through to check recovery
      this.dbHealthCircuitOpenAt = 0;
    }

    try {
      await this.persistence.pool.query('SELECT 1');
      if (this.dbHealthFailureCount > 0) {
        console.info('[DbHealth] Database connection restored after', this.dbHealthFailureCount, 'failure(s)');
        this.dbHealthFailureCount = 0;
      }
      return true;
    } catch (err) {
      this.dbHealthFailureCount++;

      if (this.dbHealthFailureCount === 1) {
        console.error('[DbHealth] Database health check failed:', (err as Error).message);
      }
      if (this.dbHealthFailureCount >= SimulationEngine.DB_HEALTH_CIRCUIT_THRESHOLD) {
        this.dbHealthCircuitOpenAt = Date.now();
        console.error(
          '[DbHealth] Circuit breaker opened after',
          this.dbHealthFailureCount,
          'consecutive failures — suppressing further DB probes for',
          SimulationEngine.DB_HEALTH_CIRCUIT_RESET_MS / 1_000,
          's',
        );
        this.dbHealthFailureCount = 0; // reset so next half-open probe counts from 1 again
      }

      return false;
    }
  }
}

function recordToMap<V>(record: Record<string, V>): Map<string, V> {
  return new Map(Object.entries(record));
}
