-- Add owner_id to agents table (links to Supabase Auth users)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES auth.users(id);

-- Index for filtering agents by owner
CREATE INDEX IF NOT EXISTS idx_agents_owner_id ON agents(owner_id);
