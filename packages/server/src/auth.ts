import { Router, Request, Response, NextFunction } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getRedis } from './redis.js';

// ---------------------------------------------------------------------------
// Auth-specific rate limiter (Redis-backed with in-memory fallback, per-IP)
// Prevents brute-force password attacks and account enumeration.
// ---------------------------------------------------------------------------

interface RateLimitEntry { count: number; resetAt: number; }
const authRateLimitStore: Map<string, RateLimitEntry> = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of authRateLimitStore) {
    if (now > e.resetAt) authRateLimitStore.delete(ip);
  }
}, 5 * 60 * 1_000);

function authRateLimit(maxRequests: number, windowMs: number) {
  const windowSec = Math.ceil(windowMs / 1_000);
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const forwarded = req.headers['x-forwarded-for'];
    const ip =
      (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null) ||
      req.ip ||
      req.socket.remoteAddress ||
      'unknown';

    const redis = getRedis();
    if (redis) {
      try {
        const key = `rl:auth:${ip}:${maxRequests}:${windowSec}`;
        const count = await redis.incr(key);
        if (count === 1) await redis.expire(key, windowSec);
        if (count > maxRequests) {
          const ttl = await redis.ttl(key);
          res.status(429).json({ error: 'Too many requests. Please try again later.', retryAfter: Math.max(ttl, 1) });
          return;
        }
        next();
        return;
      } catch (err) {
        console.warn('[Auth RateLimit] Redis error, using in-memory fallback:', (err as Error).message);
      }
    }

    const now = Date.now();
    const entry = authRateLimitStore.get(ip);
    if (!entry || now > entry.resetAt) {
      authRateLimitStore.set(ip, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    if (entry.count >= maxRequests) {
      res.status(429).json({ error: 'Too many requests. Please try again later.', retryAfter: Math.ceil((entry.resetAt - now) / 1_000) });
      return;
    }
    entry.count++;
    next();
  };
}

// Extend Express Request to carry userId
declare global {
  namespace Express {
    interface Request {
      userId?: string | null;
    }
  }
}

/**
 * Creates a Supabase client for auth operations.
 * Uses service role key — signUp auto-confirms email (no verification needed for demo).
 */
function createAuthClient(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Middleware: extract user from Bearer token (non-blocking — sets req.userId or null).
 */
export function optionalAuth(supabase: SupabaseClient) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      req.userId = null;
      return next();
    }
    try {
      const { data } = await supabase.auth.getUser(token);
      req.userId = data.user?.id ?? null;
    } catch {
      req.userId = null;
    }
    next();
  };
}

/**
 * Middleware: require valid auth token (rejects with 401 if missing/invalid).
 */
export function requireAuth(_req: Request, res: Response, next: NextFunction): void {
  if (!_req.userId) {
    res.status(401).json({ error: 'Sign in required' });
    return;
  }
  next();
}

/**
 * Auth routes: signup, login, me
 */
export function createAuthRouter(url: string, serviceRoleKey: string): Router {
  const supabase = createAuthClient(url, serviceRoleKey);
  const router = Router();

  // POST /api/auth/signup — 5 attempts per hour per IP
  router.post('/api/auth/signup', authRateLimit(5, 60 * 60 * 1_000), async (req: Request, res: Response) => {
    const { email, password } = req.body;

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      res.status(400).json({ error: 'Valid email required' });
      return;
    }
    if (!password || typeof password !== 'string' || password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters' });
      return;
    }

    // Service role auto-confirms email — no verification step
    const { data, error } = await supabase.auth.admin.createUser({
      email: email.trim().toLowerCase(),
      password,
      email_confirm: true,
    });

    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }

    // Generate a session token for the new user
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });

    if (signInError || !signInData.session) {
      // User created but login failed — they can log in manually
      res.status(201).json({
        user: { id: data.user?.id, email: data.user?.email },
        token: null,
        message: 'Account created. Please log in.',
      });
      return;
    }

    res.json({
      user: { id: data.user?.id, email: data.user?.email },
      token: signInData.session.access_token,
    });
  });

  // POST /api/auth/login — 10 attempts per 15 minutes per IP
  router.post('/api/auth/login', authRateLimit(10, 15 * 60 * 1_000), async (req: Request, res: Response) => {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password required' });
      return;
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });

    if (error) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    res.json({
      user: { id: data.user?.id, email: data.user?.email },
      token: data.session?.access_token,
    });
  });

  // GET /api/auth/me
  router.get('/api/auth/me', async (req: Request, res: Response) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      res.status(401).json({ error: 'Not signed in' });
      return;
    }

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    res.json({ user: { id: data.user.id, email: data.user.email } });
  });

  return router;
}
