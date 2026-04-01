-- AI Village Database Migration
-- Run as: psql "postgresql://aivillage_admin:<password>@<host>/aivillage?sslmode=verify-full" -f scripts/db-migrate.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- App role (least-privilege: DML only, no DDL)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aivillage_app') THEN
    CREATE ROLE aivillage_app WITH LOGIN;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS world_state (
  id         TEXT PRIMARY KEY DEFAULT 'current',
  data       JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agents (
  id         UUID PRIMARY KEY,
  data       JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_controllers (
  agent_id   UUID PRIMARY KEY,
  data       JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS memories (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          UUID NOT NULL,
  type              TEXT NOT NULL DEFAULT 'observation',
  content           TEXT NOT NULL,
  importance        FLOAT NOT NULL DEFAULT 5,
  timestamp         BIGINT NOT NULL,
  related_agent_ids TEXT[] NOT NULL DEFAULT '{}',
  visibility        TEXT NOT NULL DEFAULT 'private',
  emotional_valence FLOAT NOT NULL DEFAULT 0,
  caused_by         TEXT,
  led_to            TEXT[],
  is_core           BOOLEAN GENERATED ALWAYS AS (importance >= 9) STORED,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS memories_agent_id_idx ON memories (agent_id);
CREATE INDEX IF NOT EXISTS memories_importance_idx ON memories (importance DESC);

-- ---------------------------------------------------------------------------
-- Grants to app role
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON world_state       TO aivillage_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON agents            TO aivillage_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_controllers TO aivillage_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON memories          TO aivillage_app;

-- Ensure future tables also get grants
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aivillage_app;

COMMIT;
