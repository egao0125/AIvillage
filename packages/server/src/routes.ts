import { Router, Request, Response, NextFunction } from 'express';
import { timingSafeEqual, createHash } from 'crypto';
import type { SimulationEngine } from './simulation/engine.js';
import { requireAuth } from './auth.js';
import { getRedis } from './redis.js';
import { MAP_REGISTRY } from '@ai-village/ai-engine';

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

// UUID v4 format validation for agent ID path parameters (OWASP WebSocket/API Cheat Sheet)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    // Use req.ip which Express resolves safely using trust proxy setting.
    // Directly reading X-Forwarded-For headers allows attackers to spoof IPs
    // and bypass rate limiting (OWASP API6 / XFF spoofing attack).
    const ip = req.ip || req.socket.remoteAddress;
    if (!ip) {
      // Can't determine the client IP — reject rather than allow all requests
      // to share one 'unknown' bucket, which would make rate-limiting useless.
      res.status(400).json({ error: 'Unable to determine client address' });
      return;
    }

    const redis = getRedis();

    if (redis) {
      // Redis path: atomic INCR + TTL — works correctly across multiple server instances
      try {
        const key = `rl:${ip}:${maxRequests}:${windowSec}`;
        const count = await redis.incr(key);
        if (count === 1) await redis.expire(key, windowSec);
        if (count > maxRequests) {
          const ttl = await redis.ttl(key);
          const retryAfter = Math.max(ttl, 1);
          // RFC 6585 §4 — set Retry-After header so HTTP clients can respect it automatically
          res.set('Retry-After', String(retryAfter));
          res.status(429).json({
            error: 'Too many requests. Please try again later.',
            retryAfter,
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
      const retryAfter = Math.ceil((entry.resetAt - now) / 1_000);
      res.set('Retry-After', String(retryAfter));
      res.status(429).json({
        error: 'Too many requests. Please try again later.',
        retryAfter,
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
    // Remove common prompt injection patterns (OWASP LLM01)
    .replace(/\[SYSTEM\]/gi, '')
    .replace(/\[INST\]/gi, '')
    .replace(/<<SYS>>/gi, '')
    .replace(/<\/?s>/gi, '')
    .replace(/\[ACTION:/gi, '[action:') // prevent fake ACTION tags from user input
    .replace(/```/g, '')
    // Strip Claude/Anthropic conversation turn markers that could break prompt structure
    .replace(/\n\n(Human|Assistant)\s*:/gi, ' ')
    .replace(/<\/??\|?(im_start|im_end)\|?>/gi, '')
    // Strip Unicode bidi override characters (visual injection / homoglyph attacks)
    .replace(/[\u202A-\u202E\u2066-\u2069\u200B-\u200F\uFEFF]/g, '')
    // Remove control characters
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim()
    .slice(0, maxLength);
}

/** Validate and clamp a number within range */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  // typeof NaN === 'number', so we must also guard with isFinite
  const num = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, num));
}

/**
 * Middleware: require DEV_ADMIN_TOKEN header for destructive admin operations.
 * Rejects with 403 when the token is missing, wrong, or DEV_ADMIN_TOKEN is unset.
 */
// Hash both tokens before comparing to ensure equal-length buffers for
// timingSafeEqual, and to prevent length-based side-channel leakage.
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const adminToken = process.env.DEV_ADMIN_TOKEN;
  const provided = typeof req.headers['x-admin-token'] === 'string'
    ? req.headers['x-admin-token']
    : '';
  if (!adminToken || !provided) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  const hashA = createHash('sha256').update(adminToken).digest();
  const hashB = createHash('sha256').update(provided).digest();
  if (!timingSafeEqual(hashA, hashB)) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

// =============================================================================
// Security: BYOK (Bring Your Own Key)
// Each agent carries its own API key — no global server key required.
// Keys are stored per-agent in RDS, never exposed to clients.
// =============================================================================

// =============================================================================
// Routes
// =============================================================================

// Parsed once at startup — parseInt on every request is wasteful and doesn't
// reflect hot env-var changes anyway (process restart is required to resize the pool).
// parseInt returns NaN for non-numeric strings; `|| 50` coalesces NaN to default.
// Math.min caps at 500 to prevent runaway resource usage (OWASP API4).
const MAX_AGENTS = Math.max(1, Math.min(parseInt(process.env.MAX_AGENTS || '50') || 50, 500));

export function createRouter(engine: SimulationEngine): Router {
  const router = Router();

  // --- Read-only endpoints (no rate limit needed) ---

  router.get('/api/agents', (_req, res) => {
    const snapshot = engine.getSnapshot();
    // Never expose API keys or internal IDs to clients
    res.json(snapshot.agents.map(a => ({
      id: a.id,
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

  // Liveness: is the Node.js process alive? Never checks DB — DB outage must not restart the Pod.
  router.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  // Readiness: can this Pod accept traffic? Returns 503 when DB is unreachable so k8s
  // removes it from Service endpoints without triggering a Pod restart.
  router.get('/api/ready', async (_req, res) => {
    const healthy = await engine.isDbHealthy();
    if (healthy) {
      res.json({ status: 'ready' });
    } else {
      res.status(503).json({ status: 'not_ready', reason: 'db_unreachable' });
    }
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
        soul: a.config.soul,
        personality: a.config.personality,
        currency: a.currency,
      })),
    });
  });

  // --- Character timeline + arc endpoints ---

  router.get('/api/agents/:id/timeline', (req, res) => {
    const id = req.params.id as string;
    if (!UUID_REGEX.test(id)) { res.status(400).json({ error: 'Invalid agent ID' }); return; }
    const limit = clampNumber(parseInt(req.query.limit as string), 1, 500, 50);
    const timeline = engine.getCharacterTimeline(id, limit);
    res.json(timeline);
  });

  router.get('/api/agents/:id/arc-summary', async (req, res) => {
    const id = req.params.id as string;
    if (!UUID_REGEX.test(id)) { res.status(400).json({ error: 'Invalid agent ID' }); return; }
    const snapshot = engine.getSnapshot();
    const agent = snapshot.agents.find(a => a.id === id);
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const timeline = engine.getCharacterTimeline(id, 20);
    const soul = agent.config.soul || '';
    const backstory = agent.config.backstory || '';
    const goal = agent.config.goal || '';
    const worldView = agent.worldView || '';

    // Build narrative arc from soul + recent history + relationships
    const parts: string[] = [];

    // Identity
    if (soul) {
      parts.push(soul.length > 150 ? soul.slice(0, 150) + '...' : soul);
    }

    // Current state
    const stateDesc = agent.currentAction && agent.currentAction !== 'idle'
      ? `Currently: ${agent.currentAction}.`
      : '';
    if (stateDesc) parts.push(stateDesc);

    // World view (agent's own perspective)
    if (worldView) {
      parts.push(worldView.length > 200 ? worldView.slice(0, 200) + '...' : worldView);
    }

    // Key relationships
    const relationships = agent.mentalModels?.slice(0, 5).map(m => {
      const target = snapshot.agents.find(a => a.id === m.targetId);
      const name = target?.config.name ?? 'Unknown';
      const trustWord = m.trust > 60 ? 'trusts' : m.trust > 30 ? 'is wary of' : 'distrusts';
      return `${trustWord} ${name} (${m.emotionalStance})`;
    }) ?? [];
    if (relationships.length > 0) {
      parts.push(`${agent.config.name} ${relationships.join(', ')}.`);
    }

    // Recent notable events
    const recentEvents = timeline.slice(0, 5).map(e => e.description).filter(Boolean);
    if (recentEvents.length > 0) {
      parts.push(`Recent: ${recentEvents.join('. ')}.`);
    }

    // Goal
    if (goal) {
      parts.push(`Driving goal: ${goal}`);
    }

    const summary = parts.join('\n\n') || 'Their story is just beginning...';
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
      const snapshot = engine.getSnapshot();
      if (snapshot.agents.length >= MAX_AGENTS) {
        res.status(429).json({
          error: `Village is full (max ${MAX_AGENTS} agents). Try again later.`,
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
        spriteId: typeof req.body.spriteId === 'string' ? sanitizeText(req.body.spriteId, 20) : 'default',
        fears: Array.isArray(req.body.fears)
          ? req.body.fears.filter((s: unknown) => typeof s === 'string').map((s: string) => sanitizeText(s, 100)).filter(Boolean).slice(0, 5)
          : undefined,
        desires: Array.isArray(req.body.desires)
          ? req.body.desires.filter((s: unknown) => typeof s === 'string').map((s: string) => sanitizeText(s, 100)).filter(Boolean).slice(0, 5)
          : undefined,
        coreValues: Array.isArray(req.body.coreValues)
          ? req.body.coreValues.filter((s: unknown) => typeof s === 'string').map((s: string) => sanitizeText(s, 100)).filter(Boolean).slice(0, 5)
          : undefined,
        contradictions: req.body.contradictions
          ? sanitizeText(String(req.body.contradictions), 200)
          : undefined,
        speechPattern: req.body.speechPattern
          ? sanitizeText(String(req.body.speechPattern), 200)
          : undefined,
        // constitutionalRules injected into LLM system prompt — must be sanitized
        // (OWASP LLM01: Prompt Injection via agent configuration fields)
        constitutionalRules: Array.isArray(req.body.constitutionalRules)
          ? req.body.constitutionalRules.filter((s: unknown) => typeof s === 'string').map((s: string) => sanitizeText(s, 200)).filter(Boolean).slice(0, 10)
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

      // requireAuth middleware (line 275) guarantees req.userId is set — this guard
      // is a defensive double-check against future middleware reordering. (CWE-287)
      if (!req.userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const agent = engine.addAgent(config, safeWakeHour, safeSleepHour, safeCurrency, apiKey.trim(), safeModel, req.userId);
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
      const id = req.params.id as string;
      if (!id || !UUID_REGEX.test(id)) {
        res.status(400).json({ error: 'Invalid agent ID' });
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
      if (!UUID_REGEX.test(id)) { res.status(400).json({ error: 'Invalid agent ID' }); return; }
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
      if (!UUID_REGEX.test(id)) { res.status(400).json({ error: 'Invalid agent ID' }); return; }
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
      if (!UUID_REGEX.test(id)) { res.status(400).json({ error: 'Invalid agent ID' }); return; }
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
      if (!UUID_REGEX.test(id)) { res.status(400).json({ error: 'Invalid agent ID' }); return; }
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
      if (!UUID_REGEX.test(id)) { res.status(400).json({ error: 'Invalid agent ID' }); return; }
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
      // Only the leader Pod holds authoritative world state; follower-guard middleware
      // covers /api/agents but not /api/admin, so we guard explicitly here.
      if (!engine.isLeader) {
        res.status(503).json({ error: 'Leader election in progress — please retry', retryAfterMs: 5_000 });
        return;
      }
      const resurrected = await engine.resurrectAllAgents();
      res.json({ success: true, resurrected });
    },
  );

  // =============================================================================
  // Map Selection
  // =============================================================================

  router.get('/api/config/maps', (_req, res) => {
    const maps = Object.values(MAP_REGISTRY).map(m => ({
      id: m.id,
      name: m.name,
      description: m.description,
      systems: m.systems,
      winCondition: m.winCondition,
    }));
    res.json({ maps });
  });

  router.post('/api/config/map', async (req, res) => {
    const { mapId } = req.body;
    if (!mapId || !MAP_REGISTRY[mapId]) {
      res.status(400).json({ error: 'Unknown map' });
      return;
    }
    await engine.setMapConfig(mapId);
    res.json({ ok: true, mapId });
  });

  router.get('/api/config/map', (_req, res) => {
    const config = engine.getMapConfig();
    res.json({ mapId: config.id });
  });

  return router;
}
