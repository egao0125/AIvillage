import { Router, Request, Response, NextFunction } from 'express';
import type { SimulationEngine } from './simulation/engine.js';

// =============================================================================
// Security: Rate Limiting (in-memory, per-IP)
// Prevents mass agent spawning (Moltbook: one agent registered 500K accounts)
// =============================================================================

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitStore: Map<string, RateLimitEntry> = new Map();

function rateLimit(maxRequests: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
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
        retryAfter: Math.ceil((entry.resetAt - now) / 1000),
      });
      return;
    }

    entry.count++;
    next();
  };
}

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore) {
    if (now > entry.resetAt) rateLimitStore.delete(ip);
  }
}, 5 * 60 * 1000);

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

// =============================================================================
// Security: API Key Authentication
// Mutating operations require the server's API key to be configured
// (Moltbook: anyone could take control of any agent by bypassing auth)
// =============================================================================

function requireConfigured(engine: SimulationEngine) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (!engine.isConfigured) {
      res.status(403).json({
        error: 'Server not configured. Set API key via POST /api/config first.',
      });
      return;
    }
    next();
  };
}

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

  router.get('/api/config/status', (_req, res) => {
    const snapshot = engine.getSnapshot();
    res.json({
      configured: engine.isConfigured,
      running: engine.isRunning,
      agentCount: snapshot.agents.length,
      agents: snapshot.agents.map(a => ({
        name: a.config.name,
        occupation: a.config.occupation,
        personality: a.config.personality,
      })),
    });
  });

  // --- Mutating endpoints (rate limited + validated) ---

  // POST /api/config — set API key
  // Rate limit: 5 requests per minute per IP
  router.post('/api/config', rateLimit(5, 60_000), (req, res) => {
    const { apiKey, model } = req.body;

    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 10) {
      res.status(400).json({ error: 'Valid API key required' });
      return;
    }

    // Validate model name if provided (prevent injection through model field)
    const safeModel = typeof model === 'string'
      ? model.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 100)
      : undefined;

    engine.updateApiKey(apiKey.trim(), safeModel);
    res.json({ success: true, model: safeModel || 'claude-sonnet-4-6' });
  });

  // POST /api/agents — spawn new agent
  // Rate limit: 10 agents per 10 minutes per IP (prevents mass spawning)
  // Requires server to be configured (API key set)
  router.post(
    '/api/agents',
    rateLimit(10, 10 * 60_000),
    requireConfigured(engine),
    (req, res) => {
      const { name, age, occupation, soul, wakeHour, sleepHour } = req.body;

      // Validate required fields
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        res.status(400).json({ error: 'Name is required' });
        return;
      }
      if (!occupation || typeof occupation !== 'string') {
        res.status(400).json({ error: 'Occupation is required' });
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
      const config = {
        name: sanitizeText(name, 50),
        age: clampNumber(age, 1, 120, 30),
        occupation: sanitizeText(occupation, 100),
        personality: {
          openness: clampNumber(req.body.personality?.openness, 0, 1, 0.5),
          conscientiousness: clampNumber(req.body.personality?.conscientiousness, 0, 1, 0.5),
          extraversion: clampNumber(req.body.personality?.extraversion, 0, 1, 0.5),
          agreeableness: clampNumber(req.body.personality?.agreeableness, 0, 1, 0.5),
          neuroticism: clampNumber(req.body.personality?.neuroticism, 0, 1, 0.5),
        },
        soul: sanitizeText(soul || '', 2000),
        backstory: '',
        goal: '',
        spriteId: 'default',
      };

      // Validate sanitized name isn't empty
      if (config.name.length === 0) {
        res.status(400).json({ error: 'Name cannot be empty after sanitization' });
        return;
      }

      const safeWakeHour = clampNumber(wakeHour, 0, 23, 7);
      const safeSlleepHour = clampNumber(sleepHour, 0, 23, 23);

      const agent = engine.addAgent(config, safeWakeHour, safeSlleepHour);
      res.json({ agent: { id: agent.id, name: agent.config.name } });
    },
  );

  return router;
}
