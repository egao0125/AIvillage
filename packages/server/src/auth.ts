import { Router, Request, Response, NextFunction } from 'express';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminInitiateAuthCommand,
  AdminGetUserCommand,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import { createRemoteJWKSet, jwtVerify } from 'jose';
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

// ---------------------------------------------------------------------------
// Cognito configuration (injected via ESO + ConfigMap in k8s)
// ---------------------------------------------------------------------------
const COGNITO_REGION = process.env.COGNITO_REGION || 'ap-northeast-1';
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID!;
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID!;

const cognitoClient = new CognitoIdentityProviderClient({ region: COGNITO_REGION });

const JWKS = createRemoteJWKSet(
  new URL(
    `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}/.well-known/jwks.json`,
  ),
);

/**
 * Middleware: extract user from Bearer token (non-blocking — sets req.userId or null).
 * Config parameter is kept for interface compatibility but JWKS is resolved internally.
 */
export function optionalAuth(_config?: unknown) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      req.userId = null;
      return next();
    }
    try {
      const { payload } = await jwtVerify(token, JWKS, {
        algorithms: ['RS256'],
        issuer: `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}`,
      });
      req.userId = (payload.sub as string) ?? null;
    } catch (err) {
      console.warn('[Auth] Token verification failed:', (err as Error).message);
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
 * Auth routes: signup, login, logout, me
 */
export function createAuthRouter(_url?: string, _serviceRoleKey?: string): Router {
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

    const normalizedEmail = email.trim().toLowerCase();

    try {
      // 1. AdminCreateUser (suppress welcome email, auto-confirm)
      await cognitoClient.send(new AdminCreateUserCommand({
        UserPoolId: COGNITO_USER_POOL_ID,
        Username: normalizedEmail,
        TemporaryPassword: password,
        MessageAction: 'SUPPRESS',
        UserAttributes: [
          { Name: 'email', Value: normalizedEmail },
          { Name: 'email_verified', Value: 'true' },
        ],
      }));

      // 2. AdminSetUserPassword — make permanent, skip forced change
      await cognitoClient.send(new AdminSetUserPasswordCommand({
        UserPoolId: COGNITO_USER_POOL_ID,
        Username: normalizedEmail,
        Password: password,
        Permanent: true,
      }));

      // 3. AdminInitiateAuth — get tokens immediately after creation
      const authResult = await cognitoClient.send(new AdminInitiateAuthCommand({
        UserPoolId: COGNITO_USER_POOL_ID,
        ClientId: COGNITO_CLIENT_ID,
        AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
        AuthParameters: { USERNAME: normalizedEmail, PASSWORD: password },
      }));

      const token = authResult.AuthenticationResult!.AccessToken!;

      // 4. Retrieve the user's sub
      const userRecord = await cognitoClient.send(new AdminGetUserCommand({
        UserPoolId: COGNITO_USER_POOL_ID,
        Username: normalizedEmail,
      }));
      const sub = userRecord.UserAttributes?.find((a) => a.Name === 'sub')?.Value!;

      res.json({ token, user: { id: sub, email: normalizedEmail } });
    } catch (err) {
      if (err instanceof UsernameExistsException) {
        // Do not confirm whether the email is registered — generic message only
        res.status(409).json({ error: 'Email already registered' });
        return;
      }
      console.error('[Auth] signup error:', (err as Error).message);
      res.status(500).json({ error: 'Authentication failed' });
    }
  });

  // POST /api/auth/login — 10 attempts per 15 minutes per IP
  router.post('/api/auth/login', authRateLimit(10, 15 * 60 * 1_000), async (req: Request, res: Response) => {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password required' });
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();

    try {
      const authResult = await cognitoClient.send(new AdminInitiateAuthCommand({
        UserPoolId: COGNITO_USER_POOL_ID,
        ClientId: COGNITO_CLIENT_ID,
        AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
        AuthParameters: { USERNAME: normalizedEmail, PASSWORD: password },
      }));

      const token = authResult.AuthenticationResult!.AccessToken!;

      const userRecord = await cognitoClient.send(new AdminGetUserCommand({
        UserPoolId: COGNITO_USER_POOL_ID,
        Username: normalizedEmail,
      }));
      const sub = userRecord.UserAttributes?.find((a) => a.Name === 'sub')?.Value!;

      res.json({ token, user: { id: sub, email: normalizedEmail } });
    } catch (err) {
      // Do not distinguish between wrong password and user-not-found
      console.warn('[Auth] login failed:', (err as Error).message);
      res.status(401).json({ error: 'Invalid email or password' });
    }
  });

  // POST /api/auth/logout — Cognito is stateless (AccessToken is a JWT); just 200
  router.post('/api/auth/logout', (_req: Request, res: Response) => {
    res.status(200).json({ message: 'Logged out' });
  });

  // GET /api/auth/me
  router.get('/api/auth/me', async (req: Request, res: Response) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      res.status(401).json({ error: 'Not signed in' });
      return;
    }

    try {
      const { payload } = await jwtVerify(token, JWKS);
      const sub = payload.sub as string;
      const email = (payload['email'] as string | undefined) ??
        (payload['cognito:username'] as string | undefined) ?? '';
      res.json({ user: { id: sub, email } });
    } catch (err) {
      console.warn('[Auth] /me token verification failed:', (err as Error).message);
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  });

  return router;
}
