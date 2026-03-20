import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Agent } from '@ai-village/shared';
import type { World } from '../simulation/world.js';
import type { AgentController } from '../simulation/agent-controller.js';

export interface ControllerData {
  controllerState: string;
  dayPlan: unknown;
  currentPlanIndex: number;
  activityTimer: number;
  conversationCooldown: number;
  wakeHour: number;
  sleepHour: number;
  homeArea: string;
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
  events: unknown[];
}

export class SupabasePersistence {
  public readonly client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
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
      events: world.events,
    };

    const { error } = await this.client
      .from('world_state')
      .upsert({ id: 'current', data, updated_at: new Date().toISOString() });

    if (error) throw new Error(`saveWorldState failed: ${error.message}`);
  }

  async saveAgents(agents: Map<string, Agent>): Promise<void> {
    if (agents.size === 0) return;

    const rows = Array.from(agents.values()).map(agent => ({
      id: agent.id,
      data: agent,
      updated_at: new Date().toISOString(),
    }));

    const { error } = await this.client.from('agents').upsert(rows);
    if (error) throw new Error(`saveAgents failed: ${error.message}`);
  }

  async saveAgentControllers(
    controllers: Map<string, AgentController>,
    apiKeys?: Map<string, { apiKey: string; model: string }>,
  ): Promise<void> {
    if (controllers.size === 0) return;

    const rows = Array.from(controllers.entries()).map(([agentId, ctrl]) => {
      const keyData = apiKeys?.get(agentId);
      return {
        agent_id: agentId,
        data: {
          controllerState: ctrl.state,
          dayPlan: ctrl.dayPlan,
          currentPlanIndex: ctrl.currentPlanIndex,
          activityTimer: ctrl.activityTimer,
          conversationCooldown: ctrl.conversationCooldown,
          wakeHour: ctrl.wakeHour,
          sleepHour: ctrl.sleepHour,
          homeArea: ctrl.homeArea,
          apiKey: keyData?.apiKey,
          model: keyData?.model,
        } satisfies ControllerData,
        updated_at: new Date().toISOString(),
      };
    });

    const { error } = await this.client.from('agent_controllers').upsert(rows);
    if (error) throw new Error(`saveAgentControllers failed: ${error.message}`);
  }

  async deleteAgent(agentId: string): Promise<void> {
    // CASCADE handles agent_controllers and memories
    const { error } = await this.client.from('agents').delete().eq('id', agentId);
    if (error) throw new Error(`deleteAgent failed: ${error.message}`);
  }

  async saveAll(
    world: World,
    controllers: Map<string, AgentController>,
    apiKeys?: Map<string, { apiKey: string; model: string }>,
  ): Promise<void> {
    await Promise.all([
      this.saveWorldState(world),
      this.saveAgents(world.agents),
      this.saveAgentControllers(controllers, apiKeys),
    ]);
    console.log(`[Persistence] Saved: ${world.agents.size} agents, ${controllers.size} controllers`);
  }

  async loadWorldState(): Promise<WorldStateData | null> {
    const { data, error } = await this.client
      .from('world_state')
      .select('data')
      .eq('id', 'current')
      .single();

    if (error || !data) return null;

    const worldData = data.data as WorldStateData;
    // Check if data is empty (initial row)
    if (!worldData || !worldData.time) return null;

    return worldData;
  }

  async loadAgents(): Promise<Agent[]> {
    const { data, error } = await this.client
      .from('agents')
      .select('data');

    if (error || !data) return [];
    return data.map(row => row.data as Agent);
  }

  async loadAgentControllers(): Promise<Map<string, ControllerData>> {
    const { data, error } = await this.client
      .from('agent_controllers')
      .select('agent_id, data');

    if (error || !data) return new Map();

    const map = new Map<string, ControllerData>();
    for (const row of data) {
      map.set(row.agent_id as string, row.data as ControllerData);
    }
    return map;
  }
}

function mapToRecord<V>(map: Map<string, V>): Record<string, V> {
  const record: Record<string, V> = {};
  for (const [key, value] of map) {
    record[key] = value;
  }
  return record;
}
