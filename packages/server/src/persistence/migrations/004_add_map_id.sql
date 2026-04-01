-- Per-map isolation: agents and controllers are partitioned by map_id.
-- world_state rows are keyed by map id (e.g., 'village', 'battle_royale')
-- instead of the singleton 'current'.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS map_id TEXT NOT NULL DEFAULT 'village';
CREATE INDEX IF NOT EXISTS idx_agents_map_id ON agents(map_id);

ALTER TABLE agent_controllers ADD COLUMN IF NOT EXISTS map_id TEXT NOT NULL DEFAULT 'village';
CREATE INDEX IF NOT EXISTS idx_agent_controllers_map_id ON agent_controllers(map_id);

-- Migrate existing world_state row from id='current' to id='village'
UPDATE world_state SET id = 'village' WHERE id = 'current';
