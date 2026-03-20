import { Router, Request, Response, NextFunction } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

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

  // POST /api/auth/signup
  router.post('/api/auth/signup', async (req: Request, res: Response) => {
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

  // POST /api/auth/login
  router.post('/api/auth/login', async (req: Request, res: Response) => {
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
