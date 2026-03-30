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
      ssl: process.env.NODE_ENV !== 'test' ? { rejectUnauthorized: false } : undefined,
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

  async saveAll(
    world: World,
    controllers: Map<string, AgentController>,
    apiKeys?: Map<string, { apiKey: string; model: string }>,
  ): Promise<void> {
    try {
      await Promise.all([
        this.saveWorldState(world),
        this.saveAgents(world.agents),
      ]);
      await this.saveAgentControllers(controllers, apiKeys);
      console.log(`[Persistence] Saved: ${world.agents.size} agents, ${controllers.size} controllers`);
    } catch (err) {
      // Log but don't crash the simulation — next periodic save will retry
      console.error('[RDS] saveAll failed (will retry next cycle):', (err as Error).message);
    }
  }

  async loadWorldState(): Promise<WorldStateData | null> {
    try {
      const result = await this.pool.query<{ data: WorldStateData }>(
        `SELECT data FROM world_state WHERE id = 'current'`,
      );
      if (result.rows.length === 0) return null;
      const worldData = result.rows[0].data;
      if (!worldData || !worldData.time) return null;
      return worldData;
    } catch (err) {
      console.error('[RDS] loadWorldState failed:', (err as Error).message);
      return null;
    }
  }

  async loadAgents(): Promise<Agent[]> {
    try {
      const result = await this.pool.query<{ data: Agent }>(`SELECT data FROM agents`);
      return result.rows.map(row => row.data);
    } catch (err) {
      console.error('[RDS] loadAgents failed:', (err as Error).message);
      return [];
    }
  }

  async loadAgentControllers(): Promise<Map<string, ControllerData>> {
    try {
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
    } catch (err) {
      console.error('[RDS] loadAgentControllers failed:', (err as Error).message);
      return new Map();
    }
  }

  // ---------------------------------------------------------------------------
  // Additional methods to replace persistence.client direct references
  // ---------------------------------------------------------------------------

  async deleteAllMemories(): Promise<void> {
    try {
      await this.pool.query(
        `DELETE FROM memories WHERE id != '00000000-0000-0000-0000-000000000000'`,
      );
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
      await this.pool.query(
        `DELETE FROM agent_controllers WHERE agent_id != '00000000-0000-0000-0000-000000000000'`,
      );
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
