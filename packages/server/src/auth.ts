import { createHmac } from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminInitiateAuthCommand,
  AdminGetUserCommand,
  AdminUserGlobalSignOutCommand,
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
    // Use req.ip (Express + trust proxy) — never read X-Forwarded-For directly
    // to prevent XFF spoofing attacks that bypass rate limiting (OWASP API6).
    const ip = req.ip || req.socket.remoteAddress || 'unknown';

    const redis = getRedis();
    if (redis) {
      try {
        const key = `rl:auth:${ip}:${maxRequests}:${windowSec}`;
        const count = await redis.incr(key);
        if (count === 1) await redis.expire(key, windowSec);
        if (count > maxRequests) {
          const ttl = await redis.ttl(key);
          const retryAfter = Math.max(ttl, 1);
          res.set('Retry-After', String(retryAfter));
          res.status(429).json({ error: 'Too many requests. Please try again later.', retryAfter });
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
      const retryAfter = Math.ceil((entry.resetAt - now) / 1_000);
      res.set('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Too many requests. Please try again later.', retryAfter });
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
// COGNITO_CLIENT_SECRET is required when the Cognito app client has generate_secret=true.
// In production, absence means auth will fail — fatal exit.
const COGNITO_CLIENT_SECRET = process.env.COGNITO_CLIENT_SECRET;
const isProduction = process.env.NODE_ENV === 'production';
if (isProduction && !COGNITO_CLIENT_SECRET) {
  console.error('[Security] FATAL: COGNITO_CLIENT_SECRET is not set in production. ' +
    'Required when Cognito app client has generate_secret=true.');
  process.exit(1);
}

const cognitoClient = new CognitoIdentityProviderClient({ region: COGNITO_REGION });

/**
 * Computes the SECRET_HASH required by Cognito when generate_secret=true.
 * Formula: Base64(HMAC-SHA256(username + clientId, clientSecret))
 * Required in AuthParameters for AdminInitiateAuthCommand.
 * AdminCreateUser/AdminSetUserPassword are admin user-management APIs and do NOT need this.
 */
function computeSecretHash(username: string): string {
  if (!COGNITO_CLIENT_SECRET) return '';
  return createHmac('sha256', COGNITO_CLIENT_SECRET)
    .update(username + COGNITO_CLIENT_ID)
    .digest('base64');
}

const JWKS = createRemoteJWKSet(
  new URL(
    `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}/.well-known/jwks.json`,
  ),
  { cacheMaxAge: 10 * 60 * 1_000 }, // Refresh JWKS cache every 10 minutes
);

/**
 * Middleware: extract user from Bearer token (non-blocking — sets req.userId or null).
 * Config parameter is kept for interface compatibility but JWKS is resolved internally.
 */
export function optionalAuth(_config?: unknown) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const authHdr = req.headers.authorization;
    const token = authHdr?.toLowerCase().startsWith('bearer ') ? authHdr.slice(7) : undefined;
    if (!token) {
      req.userId = null;
      return next();
    }
    try {
      const { payload } = await jwtVerify(token, JWKS, {
        algorithms: ['RS256'],
        clockTolerance: '30s',
        issuer: `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}`,
      });
      // Cognito access tokens must carry token_use=access and client_id matching our app
      if (payload['token_use'] !== 'access') {
        console.warn('[Auth] Token rejected: token_use is not "access"');
        req.userId = null;
        return next();
      }
      if (payload['client_id'] !== COGNITO_CLIENT_ID) {
        console.warn('[Auth] Token rejected: client_id mismatch');
        req.userId = null;
        return next();
      }
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

    // RFC 5321 simplified format check (OWASP ASVS 5.1.1 / API2:2023)
    // Ensures local@domain.tld structure before hitting Cognito.
    const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || typeof email !== 'string' || !EMAIL_REGEX.test(email.trim())) {
      res.status(400).json({ error: 'Valid email address required' });
      return;
    }
    // Mirror Cognito User Pool password policy (cognito.tf) so the client gets an
    // accurate error message before the API call reaches Cognito:
    //   minimum_length = 12, require_lowercase, require_uppercase,
    //   require_numbers, require_symbols
    const PWD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()\-_=+[\]{};:'",.<>?/\\|`~])/;
    if (!password || typeof password !== 'string' || password.length < 12 || !PWD_REGEX.test(password)) {
      res.status(400).json({
        error: 'Password must be at least 12 characters and include uppercase, lowercase, number, and symbol',
      });
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
        AuthParameters: {
          USERNAME: normalizedEmail,
          PASSWORD: password,
          ...(COGNITO_CLIENT_SECRET && { SECRET_HASH: computeSecretHash(normalizedEmail) }),
        },
      }));

      const token = authResult.AuthenticationResult?.AccessToken;
      if (!token) {
        console.error('[Auth] signup: Cognito returned no AccessToken');
        res.status(500).json({ error: 'Authentication failed' });
        return;
      }

      // 4. Retrieve the user's sub
      const userRecord = await cognitoClient.send(new AdminGetUserCommand({
        UserPoolId: COGNITO_USER_POOL_ID,
        Username: normalizedEmail,
      }));
      const sub = userRecord.UserAttributes?.find((a) => a.Name === 'sub')?.Value;
      if (!sub) {
        console.error('[Auth] signup: Cognito returned no sub attribute');
        res.status(500).json({ error: 'Authentication failed' });
        return;
      }

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
        AuthParameters: {
          USERNAME: normalizedEmail,
          PASSWORD: password,
          ...(COGNITO_CLIENT_SECRET && { SECRET_HASH: computeSecretHash(normalizedEmail) }),
        },
      }));

      const token = authResult.AuthenticationResult?.AccessToken;
      if (!token) {
        console.error('[Auth] login: Cognito returned no AccessToken');
        res.status(500).json({ error: 'Authentication failed' });
        return;
      }

      const userRecord = await cognitoClient.send(new AdminGetUserCommand({
        UserPoolId: COGNITO_USER_POOL_ID,
        Username: normalizedEmail,
      }));
      const sub = userRecord.UserAttributes?.find((a) => a.Name === 'sub')?.Value;
      if (!sub) {
        console.error('[Auth] login: Cognito returned no sub attribute');
        res.status(500).json({ error: 'Authentication failed' });
        return;
      }

      res.json({ token, user: { id: sub, email: normalizedEmail } });
    } catch (err) {
      // Do not distinguish between wrong password and user-not-found
      console.warn('[Auth] login failed:', (err as Error).message);
      res.status(401).json({ error: 'Invalid email or password' });
    }
  });

  // POST /api/auth/logout — invalidate all refresh tokens for this user (OWASP ASVS V3.3.1).
  // AdminUserGlobalSignOut revokes all refresh tokens immediately.
  // Note: access tokens are JWTs (stateless) and remain valid until expiry (max 60 min).
  // The client must discard the access token locally on logout.
  // Rate limited: 20 requests/hour per IP to prevent Cognito API amplification DoS.
  router.post('/api/auth/logout', authRateLimit(20, 60 * 60 * 1_000), async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    // Case-insensitive Bearer prefix parsing (OWASP ASVS §3.5.3)
    const token = authHeader?.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7)
      : undefined;
    if (token) {
      try {
        const { payload } = await jwtVerify(token, JWKS, {
          algorithms: ['RS256'],
        clockTolerance: '30s',
          issuer: `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}`,
        });
        // Validate token_use=access and client_id before trusting the token for a sign-out action
        // (OWASP ASVS §3.5.2 — validate all claims before trust actions)
        if (payload['token_use'] !== 'access' || payload['client_id'] !== COGNITO_CLIENT_ID) {
          // Invalid token type — still return 200 to avoid leaking information
          res.status(200).json({ message: 'Logged out' });
          return;
        }
        // Revoke all refresh tokens — prevents silent re-auth after logout
        const username = (payload['cognito:username'] as string | undefined) ?? (payload.sub as string | undefined);
        if (username) {
          await cognitoClient.send(new AdminUserGlobalSignOutCommand({
            UserPoolId: COGNITO_USER_POOL_ID,
            Username: username,
          }));
        }
      } catch (err) {
        // Best-effort — don't fail logout if token is already expired or invalid
        console.warn('[Auth] logout token revocation skipped:', (err as Error).message);
      }
    }
    res.status(200).json({ message: 'Logged out' });
  });

  // GET /api/auth/me
  router.get('/api/auth/me', async (req: Request, res: Response) => {
    const authHdr = req.headers.authorization;
    const token = authHdr?.toLowerCase().startsWith('bearer ') ? authHdr.slice(7) : undefined;
    if (!token) {
      res.status(401).json({ error: 'Not signed in' });
      return;
    }

    try {
      const { payload } = await jwtVerify(token, JWKS, {
        algorithms: ['RS256'],
        clockTolerance: '30s',
        issuer: `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}`,
      });
      // Cognito access tokens must carry token_use=access and client_id matching our app
      if (payload['token_use'] !== 'access') {
        res.status(401).json({ error: 'Invalid token type' });
        return;
      }
      if (payload['client_id'] !== COGNITO_CLIENT_ID) {
        res.status(401).json({ error: 'Invalid token audience' });
        return;
      }
      const sub = payload.sub;
      if (!sub) {
        res.status(401).json({ error: 'Invalid token: missing subject' });
        return;
      }
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
