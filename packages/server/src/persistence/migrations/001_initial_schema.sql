-- AI Village — Initial Supabase Schema
-- Run this in the Supabase SQL Editor before deploying.

-- World state snapshot (singleton row)
CREATE TABLE world_state (
  id TEXT PRIMARY KEY DEFAULT 'current',
  data JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO world_state (id, data) VALUES ('current', '{}')
ON CONFLICT (id) DO NOTHING;

-- Agents
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Agent controller runtime state
CREATE TABLE agent_controllers (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Memories (normalized for querying)
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  importance SMALLINT NOT NULL DEFAULT 5,
  timestamp BIGINT NOT NULL,
  related_agent_ids TEXT[] NOT NULL DEFAULT '{}',
  visibility TEXT DEFAULT 'private',
  emotional_valence REAL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_memories_agent_id ON memories(agent_id);
CREATE INDEX idx_memories_agent_timestamp ON memories(agent_id, timestamp DESC);
CREATE INDEX idx_memories_agent_importance ON memories(agent_id, importance DESC);

-- Row Level Security (defense-in-depth)
-- No policies = no access via anon key. Only service_role can read/write.
ALTER TABLE world_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_controllers ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
