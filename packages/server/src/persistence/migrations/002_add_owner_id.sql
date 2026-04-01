-- Add owner_id to agents table (Cognito sub / user identifier)
-- Note: No FK to auth.users — authentication is handled by Cognito (external to DB).
-- owner_id stores the Cognito user sub (UUID format) for ownership checks in routes.ts.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS owner_id UUID;

-- Index for filtering agents by owner
CREATE INDEX IF NOT EXISTS idx_agents_owner_id ON agents(owner_id);
