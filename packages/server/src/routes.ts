import { Router, Request, Response, NextFunction } from 'express';
import type { SimulationEngine } from './simulation/engine.js';
import { requireAuth } from './auth.js';
import { getRedis } from './redis.js';

// =============================================================================
// Security: Rate Limiting (Redis-backed with in-memory fallback, per-IP)
// Prevents mass agent spawning (Moltbook: one agent registered 500K accounts)
//
// When REDIS_URL is set: uses Redis INCR+EXPIRE (works across multiple instances)
// When REDIS_URL is unset: falls back to in-memory Map (single-instance only)
// =============================================================================

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// In-memory fallback store — only used when Redis is unavailable
const rateLimitStore: Map<string, RateLimitEntry> = new Map();

// Cleanup stale in-memory entries every 5 minutes (no-op when Redis is active)
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore) {
    if (now > entry.resetAt) rateLimitStore.delete(ip);
  }
}, 5 * 60 * 1_000);

function rateLimit(maxRequests: number, windowMs: number) {
  const windowSec = Math.ceil(windowMs / 1_000);

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Prefer the leftmost (client) IP from X-Forwarded-For when behind Fly.io / a proxy.
    // We take only the first entry to avoid spoofing via appended IPs.
    const forwarded = req.headers['x-forwarded-for'];
    const ip =
      (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null) ||
      req.ip ||
      req.socket.remoteAddress ||
      'unknown';

    const redis = getRedis();

    if (redis) {
      // Redis path: atomic INCR + TTL — works correctly across multiple server instances
      try {
        const key = `rl:${ip}:${maxRequests}:${windowSec}`;
        const count = await redis.incr(key);
        if (count === 1) await redis.expire(key, windowSec);
        if (count > maxRequests) {
          const ttl = await redis.ttl(key);
          res.status(429).json({
            error: 'Too many requests. Please try again later.',
            retryAfter: Math.max(ttl, 1),
          });
          return;
        }
        next();
        return;
      } catch (err) {
        // Redis unavailable — fall through to in-memory
        console.warn('[RateLimit] Redis error, using in-memory fallback:', (err as Error).message);
      }
    }

    // In-memory fallback path
    const now = Date.now();
    const entry = rateLimitStore.get(ip);
    if (!entry || now > entry.resetAt) {
      rateLimitStore.set(ip, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    if (entry.count >= maxRequests) {
      res.status(429).json({
        error: 'Too many requests. Please try again later.',
        retryAfter: Math.ceil((entry.resetAt - now) / 1_000),
      });
      return;
    }
    entry.count++;
    next();
  };
}

// =============================================================================
// Security: Input Sanitization
// Prevents prompt injection through agent names, backstories, souls
// (Moltbook: "digital drugs" — prompt injections that altered agent personality)
// =============================================================================

/** Strip characters that could be used for prompt injection */
function sanitizeText(text: string, maxLength: number): string {
  return text
    // Remove common prompt injection patterns
    .replace(/\[SYSTEM\]/gi, '')
    .replace(/\[INST\]/gi, '')
    .replace(/<<SYS>>/gi, '')
    .replace(/<\/?s>/gi, '')
    .replace(/\[ACTION:/gi, '[action:') // prevent fake ACTION tags from user input
    .replace(/```/g, '')
    // Remove control characters
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim()
    .slice(0, maxLength);
}

/** Validate and clamp a number within range */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' ? value : fallback;
  return Math.max(min, Math.min(max, num));
}

/**
 * Middleware: require DEV_ADMIN_TOKEN header for destructive admin operations.
 * Rejects with 403 when the token is missing, wrong, or DEV_ADMIN_TOKEN is unset.
 */
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const adminToken = process.env.DEV_ADMIN_TOKEN;
  const provided = req.headers['x-admin-token'];
  if (!adminToken || !provided || provided !== adminToken) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

// =============================================================================
// Security: BYOK (Bring Your Own Key)
// Each agent carries its own API key — no global server key required.
// Keys are stored per-agent in Supabase, never exposed to clients.
// =============================================================================

// =============================================================================
// Routes
// =============================================================================

export function createRouter(engine: SimulationEngine): Router {
  const router = Router();

  // --- Read-only endpoints (no rate limit needed) ---

  router.get('/api/agents', (_req, res) => {
    const snapshot = engine.getSnapshot();
    // Never expose API keys or internal IDs to clients
    res.json(snapshot.agents.map(a => ({
      id: a.id,
      ownerId: a.ownerId,
      config: {
        name: a.config.name,
        age: a.config.age,
        occupation: a.config.occupation,
        personality: a.config.personality,
        // soul/backstory are private — never sent to clients
        spriteId: a.config.spriteId,
      },
      position: a.position,
      state: a.state,
      currentAction: a.currentAction,
      currency: a.currency,
      mood: a.mood,
      inventory: a.inventory,
      skills: a.skills,
    })));
  });

  router.get('/api/world', (_req, res) => {
    res.json(engine.getSnapshot());
  });

  router.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  // GET /api/config/status — public summary for UI health display.
  // soul/backstory/fears/desires are private character data — never exposed here.
  router.get('/api/config/status', (_req, res) => {
    const snapshot = engine.getSnapshot();
    res.json({
      configured: true, // BYOK — always ready, each agent carries its own key
      running: engine.isRunning,
      agentCount: snapshot.agents.length,
      agents: snapshot.agents.map(a => ({
        id: a.id,
        name: a.config.name,
        occupation: a.config.occupation,
        personality: a.config.personality,
        currency: a.currency,
      })),
    });
  });

  // --- Character timeline + arc endpoints ---

  router.get('/api/agents/:id/timeline', (req, res) => {
    const id = req.params.id as string;
    const limit = clampNumber(parseInt(req.query.limit as string), 1, 500, 50);
    const timeline = engine.getCharacterTimeline(id, limit);
    res.json(timeline);
  });

  router.get('/api/agents/:id/arc-summary', async (req, res) => {
    const id = req.params.id as string;
    const snapshot = engine.getSnapshot();
    const agent = snapshot.agents.find(a => a.id === id);
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    // Simple arc summary from available data (no LLM for now — can be upgraded later)
    const timeline = engine.getCharacterTimeline(id, 20);
    const recentEvents = timeline.map(e => e.description).join('. ');

    const mentalModels = agent.mentalModels?.map(m => {
      const target = snapshot.agents.find(a => a.id === m.targetId);
      return `${target?.config.name ?? 'Unknown'}: trust ${m.trust}, feels ${m.emotionalStance}`;
    }).join('; ') ?? 'None';

    const summary = `${agent.config.name}${agent.config.occupation ? ', ' + agent.config.occupation : ''}, age ${agent.config.age}. Mood: ${agent.mood}. ${recentEvents || 'Just arrived in the village.'}

Relationships: ${mentalModels}`;

    res.json({ summary });
  });

  // --- Mutating endpoints (rate limited + validated) ---

  // POST /api/agents — spawn new agent (requires auth + BYOK API key)
  // Rate limit: 10 agents per 10 minutes per IP (prevents mass spawning)
  router.post(
    '/api/agents',
    rateLimit(10, 10 * 60_000),
    requireAuth,
    (req, res) => {
      const { name, age, occupation, soul, backstory, goal, wakeHour, sleepHour, startingGold, apiKey, model } = req.body;

      // Validate API key — required for agent to think
      if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 10) {
        res.status(400).json({ error: 'Valid API key required — your key powers your agent\'s thinking' });
        return;
      }

      // Sanitize model name if provided (prevent injection)
      const safeModel = typeof model === 'string'
        ? model.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 100)
        : undefined;

      // Validate required fields
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        res.status(400).json({ error: 'Name is required' });
        return;
      }
      // Enforce max agent limit
      const maxAgents = parseInt(process.env.MAX_AGENTS || '50');
      const snapshot = engine.getSnapshot();
      if (snapshot.agents.length >= maxAgents) {
        res.status(429).json({
          error: `Village is full (max ${maxAgents} agents). Try again later.`,
        });
        return;
      }

      // Sanitize all user-provided text to prevent prompt injection
      const safeBackstory = sanitizeText(backstory || '', 500);
      const safeGoal = sanitizeText(goal || '', 200);
      const safeSoul = sanitizeText(soul || '', 2000);

      // If no soul written, compose from backstory + goal
      let finalSoul = safeSoul;
      if (!finalSoul && (safeBackstory || safeGoal)) {
        const parts: string[] = [];
        if (safeBackstory) parts.push(safeBackstory);
        if (safeGoal) parts.push(`My goal: ${safeGoal}`);
        finalSoul = parts.join('\n\n');
      }

      const config = {
        name: sanitizeText(name, 50),
        age: clampNumber(age, 1, 120, 30),
        occupation: occupation ? sanitizeText(occupation, 100) : undefined,
        personality: {
          openness: clampNumber(req.body.personality?.openness, 0, 1, 0.5),
          conscientiousness: clampNumber(req.body.personality?.conscientiousness, 0, 1, 0.5),
          extraversion: clampNumber(req.body.personality?.extraversion, 0, 1, 0.5),
          agreeableness: clampNumber(req.body.personality?.agreeableness, 0, 1, 0.5),
          neuroticism: clampNumber(req.body.personality?.neuroticism, 0, 1, 0.5),
        },
        soul: finalSoul,
        backstory: safeBackstory,
        goal: safeGoal,
        spriteId: 'default',
        fears: Array.isArray(req.body.fears)
          ? req.body.fears.map((s: any) => sanitizeText(String(s), 100)).filter(Boolean).slice(0, 5)
          : undefined,
        desires: Array.isArray(req.body.desires)
          ? req.body.desires.map((s: any) => sanitizeText(String(s), 100)).filter(Boolean).slice(0, 5)
          : undefined,
        coreValues: Array.isArray(req.body.coreValues)
          ? req.body.coreValues.map((s: any) => sanitizeText(String(s), 100)).filter(Boolean).slice(0, 5)
          : undefined,
        contradictions: req.body.contradictions
          ? sanitizeText(String(req.body.contradictions), 200)
          : undefined,
        speechPattern: req.body.speechPattern
          ? sanitizeText(String(req.body.speechPattern), 200)
          : undefined,
      };

      // Validate sanitized name isn't empty
      if (config.name.length === 0) {
        res.status(400).json({ error: 'Name cannot be empty after sanitization' });
        return;
      }

      const safeWakeHour = clampNumber(wakeHour, 0, 23, 7);
      const safeSleepHour = clampNumber(sleepHour, 0, 23, 23);
      const safeCurrency = clampNumber(startingGold, 0, 10000, 0);

      const agent = engine.addAgent(config, safeWakeHour, safeSleepHour, safeCurrency, apiKey.trim(), safeModel, req.userId!);
      res.json({ agent: { id: agent.id, name: agent.config.name } });
    },
  );

  // DELETE /api/agents/:id — remove an agent (requires ownership)
  // Rate limit: 5 deletes per minute per IP
  router.delete(
    '/api/agents/:id',
    rateLimit(5, 60_000),
    requireAuth,
    (req, res) => {
      const { id } = req.params;
      if (!id || typeof id !== 'string') {
        res.status(400).json({ error: 'Agent ID is required' });
        return;
      }

      // Check ownership
      const snapshot = engine.getSnapshot();
      const agent = snapshot.agents.find(a => a.id === id);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      if (agent.ownerId !== req.userId) {
        res.status(403).json({ error: 'You can only delete your own agents' });
        return;
      }

      const removed = engine.removeAgent(id);
      if (!removed) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      res.json({ success: true });
    },
  );

  // POST /api/agents/:id/suspend — pause agent (requires ownership)
  router.post(
    '/api/agents/:id/suspend',
    rateLimit(10, 60_000),
    requireAuth,
    (req, res) => {
      const id = req.params.id as string;
      const snapshot = engine.getSnapshot();
      const agent = snapshot.agents.find(a => a.id === id);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      if (agent.ownerId !== req.userId) {
        res.status(403).json({ error: 'You can only suspend your own agents' });
        return;
      }
      const success = engine.suspendAgent(id);
      if (!success) {
        res.status(400).json({ error: 'Agent cannot be suspended (dead or already away)' });
        return;
      }
      res.json({ success: true });
    },
  );

  // PATCH /api/agents/:id/api-key — update agent's API key and model (requires ownership)
  router.patch(
    '/api/agents/:id/api-key',
    rateLimit(10, 60_000),
    requireAuth,
    (req, res) => {
      const id = req.params.id as string;
      const { apiKey, model } = req.body;

      if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 10) {
        res.status(400).json({ error: 'Valid API key required' });
        return;
      }

      const snapshot = engine.getSnapshot();
      const agent = snapshot.agents.find(a => a.id === id);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      if (agent.ownerId !== req.userId) {
        res.status(403).json({ error: 'You can only update your own agents' });
        return;
      }

      const safeModel = typeof model === 'string'
        ? model.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 100)
        : process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

      const success = engine.updateAgentApiKey(id, apiKey.trim(), safeModel);
      if (!success) {
        res.status(400).json({ error: 'Failed to update API key' });
        return;
      }

      res.json({ success: true });
    },
  );

  // POST /api/agents/:id/reset-vitals — reset health/hunger/energy (requires ownership)
  router.post(
    '/api/agents/:id/reset-vitals',
    rateLimit(10, 60_000),
    requireAuth,
    (req, res) => {
      const id = req.params.id as string;
      const snapshot = engine.getSnapshot();
      const agent = snapshot.agents.find(a => a.id === id);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      if (agent.ownerId !== req.userId) {
        res.status(403).json({ error: 'You can only reset your own agents' });
        return;
      }
      const success = engine.resetAgentVitals(id);
      if (!success) {
        res.status(400).json({ error: 'Agent vitals cannot be reset (agent is dead)' });
        return;
      }
      res.json({ success: true, vitals: { health: 100, hunger: 0, energy: 100 } });
    },
  );

  // POST /api/agents/:id/resume — resume agent (requires ownership)
  router.post(
    '/api/agents/:id/resume',
    rateLimit(10, 60_000),
    requireAuth,
    (req, res) => {
      const id = req.params.id as string;
      const snapshot = engine.getSnapshot();
      const agent = snapshot.agents.find(a => a.id === id);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      if (agent.ownerId !== req.userId) {
        res.status(403).json({ error: 'You can only resume your own agents' });
        return;
      }
      const success = engine.resumeAgent(id);
      if (!success) {
        res.status(400).json({ error: 'Agent cannot be resumed (not away)' });
        return;
      }
      res.json({ success: true });
    },
  );

  // POST /api/agents/:id/resurrect — bring dead agent back to life (requires ownership)
  router.post(
    '/api/agents/:id/resurrect',
    rateLimit(10, 60_000),
    requireAuth,
    async (req, res) => {
      const id = req.params.id as string;
      const snapshot = engine.getSnapshot();
      const agent = snapshot.agents.find(a => a.id === id);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      if (agent.ownerId !== req.userId) {
        res.status(403).json({ error: 'You can only resurrect your own agents' });
        return;
      }
      const success = await engine.resurrectAgent(id);
      if (!success) {
        res.status(400).json({ error: 'Agent is not dead' });
        return;
      }
      res.json({ success: true });
    },
  );

  // POST /api/admin/resurrect-all — bring ALL dead agents back to life
  // Requires X-Admin-Token header matching DEV_ADMIN_TOKEN (prevents any logged-in
  // user from nuking global agent state; consistent with Socket.IO dev:* gating).
  router.post(
    '/api/admin/resurrect-all',
    rateLimit(3, 60_000),
    requireAdmin,
    async (_req, res) => {
      const resurrected = await engine.resurrectAllAgents();
      res.json({ success: true, resurrected });
    },
  );

  return router;
}
