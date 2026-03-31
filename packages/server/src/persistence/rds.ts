import pg from 'pg';
import type { Agent } from '@ai-village/shared';
import type { World } from '../simulation/world.js';
import type { AgentController } from '../simulation/agent-controller.js';
import { encryptApiKey, decryptApiKey } from '../crypto.js';
const { Pool: PgPool } = pg;
type Pool = pg.Pool;

export interface ControllerData {
  controllerState: string;
  currentGoals: string[];
  activityTimer: number;
  conversationCooldown: number;
  wakeHour: number;
  sleepHour: number;
  homeArea: string;
  worldView?: string;
  worldViewParts?: { knownPlaces: Record<string, string>; myExperience: string; knowsPlaza?: boolean };
  apiKey?: string;
  model?: string;
}

export interface WorldStateData {
  time: unknown;
  weather: unknown;
  conversations: Record<string, unknown>;
  board: unknown[];
  elections: Record<string, unknown>;
  properties: Record<string, unknown>;
  reputation: unknown[];
  secrets: unknown[];
  items: Record<string, unknown>;
  institutions: Record<string, unknown>;
  artifacts: unknown[];
  buildings: Record<string, unknown>;
  technologies: unknown[];
  materialSpawns: unknown[];
  worldObjects?: unknown[];
  culturalNames?: Record<string, unknown>;
  resourcePools?: Record<string, number>;
  villageMemory?: unknown[];
  activeBuildProjects?: Record<string, unknown>;
}

export class RdsPersistence {
  public readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new PgPool({
      connectionString,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      // TCP keepalive: detects dead connections early during RDS Multi-AZ failover
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      // Rotate connections after 1 hour — clears stale connections after RDS Multi-AZ failover
      maxLifetimeSeconds: 3600,
      // Amazon Root CA は Node.js 組み込み Mozilla CA ストアに含まれるため証明書検証を有効化
      // (OWASP/AWS Security Best Practices: 本番環境での rejectUnauthorized:false は禁止)
      ssl: process.env.NODE_ENV !== 'test' ? { rejectUnauthorized: true } : undefined,
    });

    // Per-connection session settings (AWS Aurora PostgreSQL Fast Failover BP)
    this.pool.on('connect', (client) => {
      client.query(`
        SET statement_timeout = '30000';
        SET lock_timeout = '10000';
        SET idle_in_transaction_session_timeout = '60000';
        SET tcp_keepalives_idle = 1;
        SET tcp_keepalives_interval = 1;
        SET tcp_keepalives_count = 5;
      `).catch((err: Error) => {
        console.error('[RDS] Failed to apply session settings:', err.message);
      });
    });

    // Log pool errors so idle client failures don't crash the process silently
    this.pool.on('error', (err) => {
      console.error('[RDS] Unexpected idle client error:', (err as Error).message);
    });
  }

  async saveWorldState(world: World): Promise<void> {
    const data: WorldStateData = {
      time: world.time,
      weather: world.weather,
      conversations: mapToRecord(world.conversations),
      board: world.board,
      elections: mapToRecord(world.elections),
      properties: mapToRecord(world.properties),
      reputation: world.reputation,
      secrets: world.secrets,
      items: mapToRecord(world.items),
      institutions: mapToRecord(world.institutions),
      artifacts: world.artifacts,
      buildings: mapToRecord(world.buildings),
      technologies: world.technologies,
      materialSpawns: world.materialSpawns,
      worldObjects: Array.from(world.worldObjects.values()),
      culturalNames: Object.fromEntries(world.culturalNames),
      resourcePools: Object.fromEntries(world.resourcePools),
      villageMemory: world.villageMemory,
      activeBuildProjects: mapToRecord(world.activeBuildProjects),
    };

    try {
      await this.pool.query(
        `INSERT INTO world_state (id, data, updated_at)
         VALUES ('current', $1, NOW())
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
        [JSON.stringify(data)],
      );
    } catch (err) {
      console.error('[RDS] saveWorldState failed:', (err as Error).message);
      throw err;
    }
  }

  async saveAgents(agents: Map<string, Agent>): Promise<void> {
    if (agents.size === 0) return;

    const ids: string[] = [];
    const datas: string[] = [];

    for (const agent of agents.values()) {
      ids.push(agent.id);
      datas.push(JSON.stringify(agent));
    }

    try {
      await this.pool.query(
        `INSERT INTO agents (id, data, updated_at)
         SELECT unnest($1::uuid[]), unnest($2::jsonb[]), NOW()
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
        [ids, datas],
      );
    } catch (err) {
      console.error('[RDS] saveAgents failed:', (err as Error).message);
      throw err;
    }
  }

  async saveAgentControllers(
    controllers: Map<string, AgentController>,
    apiKeys?: Map<string, { apiKey: string; model: string }>,
  ): Promise<void> {
    if (controllers.size === 0) return;

    const agentIds: string[] = [];
    const datas: string[] = [];

    for (const [agentId, ctrl] of controllers.entries()) {
      const keyData = apiKeys?.get(agentId);
      const ctrlData: ControllerData = {
        controllerState: ctrl.state,
        currentGoals: ctrl.currentGoals,
        activityTimer: ctrl.activityTimer,
        conversationCooldown: ctrl.conversationCooldown,
        wakeHour: ctrl.wakeHour,
        sleepHour: ctrl.sleepHour,
        homeArea: ctrl.homeArea,
        worldView: ctrl.cognition.worldView,
        worldViewParts: ctrl.cognition.worldViewParts,
        apiKey: keyData?.apiKey ? encryptApiKey(keyData.apiKey) : undefined,
        model: keyData?.model,
      };
      agentIds.push(agentId);
      datas.push(JSON.stringify(ctrlData));
    }

    try {
      await this.pool.query(
        `INSERT INTO agent_controllers (agent_id, data, updated_at)
         SELECT unnest($1::uuid[]), unnest($2::jsonb[]), NOW()
         ON CONFLICT (agent_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
        [agentIds, datas],
      );
    } catch (err) {
      console.error('[RDS] saveAgentControllers failed:', (err as Error).message);
      throw err;
    }
  }

  async deleteAgent(agentId: string): Promise<void> {
    try {
      await this.pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    } catch (err) {
      console.error('[RDS] deleteAgent failed:', (err as Error).message);
      throw err;
    }
  }

  // Transient error codes that warrant a retry (RDS Multi-AZ failover, momentary connection drops).
  // Permanent errors (e.g. bad SQL, constraint violations) are NOT retried.
  private isTransientError(err: unknown): boolean {
    const code = (err as { code?: string }).code ?? '';
    const msg = (err as Error).message ?? '';
    return (
      code === 'ECONNREFUSED' ||
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === '57P03' || // admin_shutdown (RDS failover)
      msg.includes('Connection terminated') ||
      msg.includes('connection timeout')
    );
  }

  async saveAll(
    world: World,
    controllers: Map<string, AgentController>,
    apiKeys?: Map<string, { apiKey: string; model: string }>,
  ): Promise<void> {
    // Exponential backoff retry for transient RDS errors (Multi-AZ failover window ~60s).
    // AWS Database Blog BP: retry up to 3 times with 1s→2s→4s delays (max 10s cap).
    const MAX_RETRIES = 3;
    let delay = 1_000;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const client = await this.pool.connect();
      try {
        // Single transaction: world_state + agents + agent_controllers must land atomically.
        // Without a transaction, a partial failure (e.g. saveAgents succeeds but
        // saveAgentControllers fails) leaves the DB in an inconsistent state that
        // causes agents to lose their controller context on pod restart.
        await client.query('BEGIN');
        await this.saveWorldStateClient(client, world);
        await this.saveAgentsClient(client, world.agents);
        await this.saveAgentControllersClient(client, controllers, apiKeys);
        await client.query('COMMIT');
        console.log(`[Persistence] Saved: ${world.agents.size} agents, ${controllers.size} controllers`);
        return;
      } catch (err) {
        await client.query('ROLLBACK').catch((rollbackErr: unknown) => {
          console.warn('[RDS] ROLLBACK failed (connection may already be dead):', (rollbackErr as Error).message);
        });
        const transient = this.isTransientError(err);
        if (transient && attempt < MAX_RETRIES) {
          console.warn(`[RDS] saveAll transient error (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms:`, (err as Error).message);
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(delay, 10_000)));
          delay *= 2;
        } else {
          // Non-transient or retries exhausted — throw so caller can detect data loss
          const msg = `Persistence failed after ${MAX_RETRIES} retries: ${(err as Error).message}`;
          console.error('[RDS] saveAll exhausted retries:', msg);
          throw new Error(msg);
        }
      } finally {
        client.release();
      }
    }
  }

  // Client-scoped variants used inside the saveAll transaction.
  // These accept an already-checked-out PoolClient so all writes share a single transaction.
  private async saveWorldStateClient(client: pg.PoolClient, world: World): Promise<void> {
    // Identical serialization to saveWorldState() — uses the same mapToRecord helpers.
    const data: WorldStateData = {
      time: world.time,
      weather: world.weather,
      conversations: mapToRecord(world.conversations),
      board: world.board,
      elections: mapToRecord(world.elections),
      properties: mapToRecord(world.properties),
      reputation: world.reputation,
      secrets: world.secrets,
      items: mapToRecord(world.items),
      institutions: mapToRecord(world.institutions),
      artifacts: world.artifacts,
      buildings: mapToRecord(world.buildings),
      technologies: world.technologies,
      materialSpawns: world.materialSpawns,
      worldObjects: Array.from(world.worldObjects.values()),
      culturalNames: Object.fromEntries(world.culturalNames),
      resourcePools: Object.fromEntries(world.resourcePools),
      villageMemory: world.villageMemory,
      activeBuildProjects: mapToRecord(world.activeBuildProjects),
    };
    await client.query(
      `INSERT INTO world_state (id, data, updated_at)
       VALUES ('current', $1, NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(data)],
    );
  }

  private async saveAgentsClient(client: pg.PoolClient, agents: Map<string, Agent>): Promise<void> {
    if (agents.size === 0) return;
    const ids: string[] = [];
    const datas: string[] = [];
    for (const agent of agents.values()) {
      ids.push(agent.id);
      datas.push(JSON.stringify(agent));
    }
    await client.query(
      `INSERT INTO agents (id, data, updated_at)
       SELECT unnest($1::uuid[]), unnest($2::jsonb[]), NOW()
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
      [ids, datas],
    );
  }

  private async saveAgentControllersClient(
    client: pg.PoolClient,
    controllers: Map<string, AgentController>,
    apiKeys?: Map<string, { apiKey: string; model: string }>,
  ): Promise<void> {
    if (controllers.size === 0) return;
    const agentIds: string[] = [];
    const datas: string[] = [];
    for (const [agentId, ctrl] of controllers.entries()) {
      const keyData = apiKeys?.get(agentId);
      const ctrlData: ControllerData = {
        controllerState: ctrl.state,
        currentGoals: ctrl.currentGoals,
        activityTimer: ctrl.activityTimer,
        conversationCooldown: ctrl.conversationCooldown,
        wakeHour: ctrl.wakeHour,
        sleepHour: ctrl.sleepHour,
        homeArea: ctrl.homeArea,
        worldView: ctrl.cognition.worldView,
        worldViewParts: ctrl.cognition.worldViewParts,
        apiKey: keyData?.apiKey ? encryptApiKey(keyData.apiKey) : undefined,
        model: keyData?.model,
      };
      agentIds.push(agentId);
      datas.push(JSON.stringify(ctrlData));
    }
    await client.query(
      `INSERT INTO agent_controllers (agent_id, data, updated_at)
       SELECT unnest($1::uuid[]), unnest($2::jsonb[]), NOW()
       ON CONFLICT (agent_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
      [agentIds, datas],
    );
  }

  async loadWorldState(): Promise<WorldStateData | null> {
    const result = await this.pool.query<{ data: WorldStateData }>(
      `SELECT data FROM world_state WHERE id = 'current'`,
    );
    if (result.rows.length === 0) return null;
    const worldData = result.rows[0].data;
    if (!worldData || !worldData.time) return null;
    return worldData;
  }

  async loadAgents(): Promise<Agent[]> {
    const result = await this.pool.query<{ data: Agent }>(`SELECT data FROM agents`);
    return result.rows.map(row => row.data);
  }

  async loadAgentControllers(): Promise<Map<string, ControllerData>> {
    const result = await this.pool.query<{ agent_id: string; data: ControllerData }>(
      `SELECT agent_id, data FROM agent_controllers`,
    );
    const map = new Map<string, ControllerData>();
    for (const row of result.rows) {
      const ctrl = row.data;
      if (ctrl.apiKey) {
        ctrl.apiKey = decryptApiKey(ctrl.apiKey);
      }
      map.set(row.agent_id, ctrl);
    }
    return map;
  }

  // ---------------------------------------------------------------------------
  // Additional methods to replace persistence.client direct references
  // ---------------------------------------------------------------------------

  async deleteAllMemories(): Promise<void> {
    try {
      await this.pool.query(`DELETE FROM memories`);
    } catch (err) {
      console.error('[RDS] deleteAllMemories failed:', (err as Error).message);
      throw err;
    }
  }

  async deleteMemoriesForAgent(agentId: string): Promise<void> {
    try {
      await this.pool.query(`DELETE FROM memories WHERE agent_id = $1`, [agentId]);
    } catch (err) {
      console.error('[RDS] deleteMemoriesForAgent failed:', (err as Error).message);
      throw err;
    }
  }

  async resetWorldState(): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO world_state (id, data, updated_at)
         VALUES ('current', '{}', NOW())
         ON CONFLICT (id) DO UPDATE SET data = '{}', updated_at = EXCLUDED.updated_at`,
      );
    } catch (err) {
      console.error('[RDS] resetWorldState failed:', (err as Error).message);
      throw err;
    }
  }

  async deleteAllControllers(): Promise<void> {
    try {
      await this.pool.query(`DELETE FROM agent_controllers`);
    } catch (err) {
      console.error('[RDS] deleteAllControllers failed:', (err as Error).message);
      throw err;
    }
  }
}

function mapToRecord<V>(map: Map<string, V>): Record<string, V> {
  const record: Record<string, V> = {};
  for (const [key, value] of map) {
    record[key] = value;
  }
  return record;
}
