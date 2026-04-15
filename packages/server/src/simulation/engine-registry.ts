/**
 * EngineRegistry — owns all per-map SimulationEngine instances for one server process.
 *
 * Design intent:
 *   Each active map (e.g. "village", "werewolf") runs its own SimulationEngine with its
 *   own World, tick loop, persistence row, and agent set. The registry is the single
 *   source of truth for "what maps are live in this process" and owns the cross-cutting
 *   concerns that must NOT be duplicated per engine:
 *
 *     1. **Leader election.** A pod holds exactly one Redis leader lock regardless of
 *        how many maps it hosts. On acquire: all engines run ticks. On loss: all engines
 *        pause. On re-acquire: all engines reload from RDS before resuming.
 *     2. **Lifecycle.** initializeAll / startAll / stopAll apply to every engine.
 *     3. **Lookup.** Socket/HTTP handlers find the right engine by mapId (from the
 *        client handshake) or by agentId (linear scan — O(engines), not O(agents)).
 *
 *   Engines never call LeaderElection APIs directly — they only read `isLeader`.
 *   Active maps are configured via the ACTIVE_MAPS env var (comma-separated map IDs).
 */

import type { Server } from 'socket.io';
import { MAP_REGISTRY } from '@ai-village/ai-engine';
import { SimulationEngine } from './engine.js';
import { createMapProvider } from '../map/map-provider.js';
import { LeaderElection } from '../cluster/leader-election.js';

export class EngineRegistry {
  private readonly engines: Map<string, SimulationEngine> = new Map();
  private readonly leaderElection: LeaderElection;

  constructor(io: Server, activeMapIds: string[]) {
    this.leaderElection = new LeaderElection();

    for (const mapId of activeMapIds) {
      const config = MAP_REGISTRY[mapId];
      if (!config) {
        console.warn(`[Registry] Unknown mapId "${mapId}" in ACTIVE_MAPS — skipping`);
        continue;
      }
      const provider = createMapProvider(mapId);
      const engine = new SimulationEngine(io, config, provider, this.leaderElection);
      this.engines.set(mapId, engine);
      console.log(`[Registry] Registered engine for map "${mapId}" (${config.name})`);
    }

    if (this.engines.size === 0) {
      throw new Error('[Registry] ACTIVE_MAPS resolved to zero valid maps — at least one is required');
    }
  }

  // ---------------------------------------------------------------------------
  // Lookup
  // ---------------------------------------------------------------------------

  get(mapId: string): SimulationEngine | undefined {
    return this.engines.get(mapId);
  }

  getOrThrow(mapId: string): SimulationEngine {
    const engine = this.engines.get(mapId);
    if (!engine) throw new Error(`[Registry] No engine for map "${mapId}"`);
    return engine;
  }

  has(mapId: string): boolean {
    return this.engines.has(mapId);
  }

  mapIds(): string[] {
    return Array.from(this.engines.keys());
  }

  all(): SimulationEngine[] {
    return Array.from(this.engines.values());
  }

  entries(): [string, SimulationEngine][] {
    return Array.from(this.engines.entries());
  }

  /**
   * Find the engine that owns the given agent ID. Linear scan across engines;
   * inside each engine the lookup is a Map.get, so this is O(engines) in practice.
   */
  findByAgentId(agentId: string): SimulationEngine | undefined {
    for (const engine of this.engines.values()) {
      if (engine.hasAgent(agentId)) return engine;
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Leader election (single lock across all engines in this process)
  // ---------------------------------------------------------------------------

  get isLeader(): boolean {
    return this.leaderElection.isLeader;
  }

  /**
   * Acquire the process-level leader lock, wire recovery callbacks, and then
   * initialize every engine. Initialization is sequential to avoid thundering-herd
   * connection churn against Redis and the DB.
   */
  async initializeAll(): Promise<void> {
    const acquired = await this.leaderElection.tryAcquire();
    console.log(
      `[Registry] ${acquired ? 'Leadership acquired' : 'Running as follower'} — podId=${this.leaderElection.podId}, maps=[${this.mapIds().join(',')}]`,
    );

    this.leaderElection.onLeadershipLost = () => {
      console.error('[Registry] Leadership lost — pausing all engines');
      for (const engine of this.engines.values()) {
        engine.pause();
        engine.markReloading();
      }
      this.leaderElection.startRetrying(() => {
        console.log('[Registry] Leadership re-acquired — reloading + restarting all engines');
        void this.reloadAndStartAll();
      });
    };

    if (!acquired) {
      for (const engine of this.engines.values()) engine.markReloading();
      this.leaderElection.startRetrying(() => {
        console.log('[Registry] Follower promoted — reloading + starting all engines');
        void this.reloadAndStartAll();
      });
    }

    for (const [mapId, engine] of this.engines.entries()) {
      try {
        await engine.initialize();
      } catch (err) {
        console.error(`[Registry] Engine "${mapId}" initialize() failed:`, (err as Error).message);
        throw err;
      }
    }
  }

  /** Start tick loops on every engine (no-op on followers). */
  startAll(): void {
    if (!this.leaderElection.isLeader) {
      console.log('[Registry] Running as follower — tick loops deferred until leadership acquired');
      return;
    }
    for (const engine of this.engines.values()) engine.start();
  }

  private async reloadAndStartAll(): Promise<void> {
    for (const engine of this.engines.values()) {
      try {
        await engine.reloadFromPersistence();
        engine.start();
      } catch (err) {
        console.error('[Registry] reloadAndStartAll failed for one engine:', (err as Error).message);
      }
    }
  }

  /**
   * Stop every engine and release the leader lock. Called from graceful shutdown.
   * Engine.stop() saves state + closes its DB pool; this method additionally releases
   * the shared Redis lock so the next pod can acquire it immediately.
   */
  async stopAll(): Promise<void> {
    for (const engine of this.engines.values()) {
      try {
        await engine.stop();
      } catch (err) {
        console.error('[Registry] engine.stop() error:', (err as Error).message);
      }
    }
    try {
      await this.leaderElection.release();
    } catch (err) {
      console.error('[Registry] leaderElection.release() error:', (err as Error).message);
    }
    this.leaderElection.destroy();
  }

  /** Readiness: true only when every engine reports DB healthy. */
  async isReady(): Promise<boolean> {
    for (const engine of this.engines.values()) {
      if (!(await engine.isDbHealthy())) return false;
    }
    return true;
  }
}
