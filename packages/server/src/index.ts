import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-streams-adapter';
import { timingSafeEqual, createHash } from 'crypto';
import { SimulationEngine } from './simulation/engine.js';
import { createRouter } from './routes.js';
import { createAuthRouter, optionalAuth, verifyToken, stopAuthRateLimitCleaner } from './auth.js';
import { setupRedis, closeRedis } from './redis.js';
import { isEncryptionConfigured } from './crypto.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '4000');
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';
const isProduction = process.env.NODE_ENV === 'production';

// ALLOWED_ORIGINS: comma-separated list of permitted origins in production.
// Example: ALLOWED_ORIGINS=https://aivillage.com,https://www.aivillage.com
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : [];

if (isProduction && ALLOWED_ORIGINS.length === 0) {
  console.error('[Security] FATAL: ALLOWED_ORIGINS is not set in production.');
  process.exit(1);
}

// Encryption: ENCRYPTION_KEY is required in production (protects stored API keys).
if (isProduction && !isEncryptionConfigured()) {
  console.error(
    '[Security] FATAL: ENCRYPTION_KEY is not set in production.' +
    ' User API keys would be stored as plaintext. Set ENCRYPTION_KEY=<64-hex-chars>.',
  );
  process.exit(1);
}

// DEV_ADMIN_TOKEN must never be set in production — it grants unrestricted simulation control.
if (isProduction && process.env.DEV_ADMIN_TOKEN) {
  console.error('[Security] FATAL: DEV_ADMIN_TOKEN must not be set in production.');
  process.exit(1);
}

// Redis: setup client before Socket.IO so the adapter is ready at startup.
// Falls back to in-memory (single-instance) when REDIS_URL is not set.
const redis = setupRedis();

const app = express();
// Trust the ALB as the first proxy so Express correctly reads X-Forwarded-Proto/IP.
// Required for HSTS to work and for req.ip to reflect the real client address.
app.set('trust proxy', 1);
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: isProduction
    ? { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'] }
    : { origin: CLIENT_URL, methods: ['GET', 'POST'] },
  // Reject Socket.IO 2.x (EIO=3) clients — prevents protocol downgrade attacks.
  // Socket.IO 2.x clients bypass middlewares added in later versions.
  allowEIO3: false,
});

if (redis) {
  // Redis Streams adapter: uses XADD/XREAD instead of PubSub.
  // Events are buffered in the stream so they survive temporary Redis disconnections
  // without packet loss — unlike the PubSub adapter which drops messages while offline.
  // maxLen caps stream growth (sliding window of last 10,000 events).
  io.adapter(createAdapter(redis, { maxLen: 10_000 }));
  console.log('[Server] Socket.IO Redis Streams adapter enabled — multi-instance ready');
} else {
  console.log('[Server] Socket.IO using in-memory adapter (single-instance only)');
}

// Security headers (OWASP / Express best practices):
// CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, etc.
//
// connectSrc: include explicit wss:// origins so Safari doesn't block Socket.IO.
// Using bare "wss:" (scheme-only) would allow ANY WebSocket endpoint — too broad.
// In production we derive wss:// from ALLOWED_ORIGINS (e.g. https://foo.com → wss://foo.com).
// In development we allow wss://localhost:* for hot-reload convenience.
const wssOrigins = isProduction
  ? ALLOWED_ORIGINS.map((o) => o.replace(/^https?:\/\//, 'wss://'))
  : [`ws://localhost:${PORT}`, `wss://localhost:${PORT}`];

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      // unsafe-inline is required for Tailwind CSS utility classes in inline styles.
      // TODO: Replace with nonce-based CSP once a nonce middleware is in place (OWASP CSP Cheat Sheet)
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", ...wssOrigins],
      frameAncestors: ["'none'"],
      // Upgrade HTTP to HTTPS automatically in production (HSTS layer 2)
      ...(isProduction && { upgradeInsecureRequests: [] }),
    },
  },
  strictTransportSecurity: isProduction
    ? { maxAge: 63_072_000, includeSubDomains: true, preload: true }
    : false,
  frameguard: { action: 'deny' },
}));

// Permissions-Policy: restrict access to sensitive browser APIs not used by AI Village.
// (OWASP Security Headers Cheat Sheet)
app.use((_req, res, next) => {
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(self)',
  );
  next();
});

// Parse httpOnly cookies (used by refresh-token flow) — must precede auth router.
// No signing secret: refresh tokens are validated against Cognito; cookie integrity
// is guaranteed by Secure+HttpOnly+SameSite flags, not HMAC signing.
app.use(cookieParser());

// Limit request body size to prevent abuse
app.use(express.json({ limit: '16kb' }));

const engine = new SimulationEngine(io);

// Auth: Cognito is required in all environments — without these, JWT verification
// produces invalid JWKS URLs and signup/login fail with cryptic errors at runtime.
if (!process.env.COGNITO_USER_POOL_ID || !process.env.COGNITO_CLIENT_ID) {
  console.error('[Security] FATAL: COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID must be set.');
  process.exit(1);
}
app.use(createAuthRouter());
app.use('/api', optionalAuth());

app.use(createRouter(engine));

// Catch unmatched /api/* routes before the SPA catch-all so they return JSON, not HTML.
// Without this, undefined API endpoints return a 200 HTML response which breaks client error handling.
app.use('/api', (_req: express.Request, res: express.Response) => {
  res.status(404).json({ error: 'Not found' });
});

// In production, serve the built client files
if (isProduction) {
  const clientDist = path.resolve(__dirname, '../../client/dist');
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// Global error handler — must be registered after all routes and middleware.
// Without this, errors thrown inside route handlers produce unhandled-rejection crashes.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Express] Unhandled route error:', err.message);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Spectator comment rate limit: 1 per 10 seconds per socket
const spectatorLastComment: Map<string, number> = new Map();
// On-demand thought generation: one interval per watching socket
const watchIntervals: Map<string, { interval: NodeJS.Timeout; agentId: string }> = new Map();
// Rate limit agent:watch-thoughts switches to prevent LLM cost amplification:
// rapid target-switching causes a new LLM call each time, creating an amplification vector.
const watchSwitchLast: Map<string, number> = new Map();

// Dev tools: require a secret token to prevent accidental or malicious use in production.
// Set DEV_ADMIN_TOKEN in environment to enable dev commands. Leave unset to disable entirely.
const DEV_ADMIN_TOKEN = process.env.DEV_ADMIN_TOKEN;
const DEV_ADMIN_TOKEN_HASH = DEV_ADMIN_TOKEN
  ? createHash('sha256').update(DEV_ADMIN_TOKEN).digest()
  : null;
// Use timingSafeEqual to prevent timing attacks on token comparison (OWASP ASVS 2.9.1).
// Consistent with routes.ts requireAdmin() which also uses timingSafeEqual.
function isDevAuthorized(token: unknown): boolean {
  if (!DEV_ADMIN_TOKEN_HASH || typeof token !== 'string' || token.length === 0) return false;
  const tokenHash = createHash('sha256').update(token).digest();
  return timingSafeEqual(DEV_ADMIN_TOKEN_HASH, tokenHash);
}

// ---------------------------------------------------------------------------
// Socket.IO optional authentication middleware.
// Spectators may connect without auth; token carriers get socket.data.userId set.
// LLM-cost events (agent:watch-thoughts, recap:request) check for socket.data.userId.
// (OWASP API4: Unrestricted Resource Consumption — unauthenticated LLM calls blocked)
// ---------------------------------------------------------------------------
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (typeof token === 'string' && token.length > 0) {
    const userId = await verifyToken(token);
    if (userId) socket.data.userId = userId;
  }
  next(); // always allow connection — spectators are valid users
});

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // Send initial snapshot
  socket.emit('world:snapshot', engine.getSnapshot());

  // UUID v4 format validation for agentId inputs (OWASP WebSocket Security Cheat Sheet)
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  socket.on('agent:select', (agentId: string) => {
    if (typeof agentId !== 'string' || !UUID_REGEX.test(agentId)) return;
    console.log(`Client selected agent: ${agentId}`);
  });

  // On-demand thought generation — only when a viewer is watching
  // Global cap: max 50 concurrent watch streams to prevent LLM cost amplification
  // Switch rate limit: 1 switch per 5s — rapid target-switching triggers a new LLM call
  // each time, allowing a single attacker to generate ~12 calls/min per socket.
  // (OWASP API4: Unrestricted Resource Consumption)
  socket.on('agent:watch-thoughts', (agentId: string) => {
    if (typeof agentId !== 'string' || !UUID_REGEX.test(agentId)) return;
    // LLM-costing event: require an authenticated session to prevent free LLM amplification.
    if (!socket.data.userId) {
      socket.emit('agent:thought', { agentId, thought: null, error: 'Authentication required' });
      return;
    }
    const now = Date.now();
    const lastSwitch = watchSwitchLast.get(socket.id) ?? 0;
    if (now - lastSwitch < 5_000) return;
    watchSwitchLast.set(socket.id, now);
    const existing = watchIntervals.get(socket.id);
    if (existing) clearInterval(existing.interval);
    if (!existing && watchIntervals.size >= 50) {
      socket.emit('agent:thought', { agentId, thought: null, error: 'Server at capacity' });
      return;
    }

    const emit = (thought: string | null) => {
      const current = watchIntervals.get(socket.id);
      if (thought && current && current.agentId === agentId) {
        socket.emit('agent:thought', { agentId, thought });
      }
    };

    // Generate one immediately; if agent doesn't exist, cancel the interval
    engine.generateThoughtFor(agentId).then((thought) => {
      if (thought === null) {
        // Agent not found — clear interval to avoid wasting LLM calls every 10s
        const toCancel = watchIntervals.get(socket.id);
        if (toCancel && toCancel.agentId === agentId) {
          clearInterval(toCancel.interval);
          watchIntervals.delete(socket.id);
        }
        return;
      }
      emit(thought);
    }).catch((err: unknown) => {
      console.warn('[Socket] generateThoughtFor failed:', (err as Error).message);
    });

    // Then every 10 seconds
    const interval = setInterval(() => {
      engine.generateThoughtFor(agentId).then(emit).catch((err: unknown) => {
        console.warn('[Socket] generateThoughtFor failed:', (err as Error).message);
      });
    }, 10_000);
    watchIntervals.set(socket.id, { interval, agentId });
  });

  socket.on('agent:unwatch-thoughts', () => {
    const existing = watchIntervals.get(socket.id);
    if (existing) {
      clearInterval(existing.interval);
      watchIntervals.delete(socket.id);
    }
  });

  // Recap request — generate a catch-up recap for returning viewers.
  // Rate limit: 1 request per 60s per socket to prevent unbounded LLM cost.
  // (OWASP API4: Unrestricted Resource Consumption; NIST SP 800-53 SC-5)
  const recapLastRequest = new Map<string, number>();
  socket.on('recap:request', async (data: { sinceDay: number }) => {
    if (typeof data?.sinceDay !== 'number') return;
    // LLM-costing event: require authenticated session.
    if (!socket.data.userId) {
      socket.emit('recap:error', { error: 'Authentication required' });
      return;
    }
    const now = Date.now();
    const last = recapLastRequest.get(socket.id) ?? 0;
    if (now - last < 60_000) {
      socket.emit('recap:error', { error: 'Rate limited. Try again in a moment.' });
      return;
    }
    recapLastRequest.set(socket.id, now);
    try {
      const recap = await engine.recapGenerator?.generateRecap(data.sinceDay);
      if (recap) socket.emit('recap:ready', recap);
    } catch (err) {
      console.warn('[Recap] generateRecap failed:', (err as Error).message);
    }
  });

  // Spectator chat — relay to all clients
  socket.on('spectator:comment', (data: { message: string }) => {
    if (!data.message || typeof data.message !== 'string') return;
    // Slice first so the 200-char limit applies to raw input, not HTML entities
    // (otherwise &amp; would count as 5 chars and reduce effective limit)
    const msg = data.message
      .trim()
      .slice(0, 200)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
    if (!msg) return;

    // Rate limit: 1 per 10 seconds
    const now = Date.now();
    const last = spectatorLastComment.get(socket.id) ?? 0;
    if (now - last < 10_000) return;
    spectatorLastComment.set(socket.id, now);

    io.emit('spectator:comment', {
      name: `Spectator`,
      message: msg,
      timestamp: now,
    });
  });

  // --- Dev tools (token-gated) ---
  socket.on('dev:pause', (token: unknown) => {
    if (!isDevAuthorized(token)) return;
    engine.pause();
    io.emit('dev:status', { paused: !engine.isRunning });
  });

  socket.on('dev:resume', (token: unknown) => {
    if (!isDevAuthorized(token)) return;
    engine.start();
    io.emit('dev:status', { paused: !engine.isRunning });
  });

  socket.on('dev:step', (token: unknown) => {
    if (!isDevAuthorized(token)) return;
    engine.singleTick();
    io.emit('world:snapshot', engine.getSnapshot());
  });

  socket.on('dev:reset-vitals', (token: unknown) => {
    if (!isDevAuthorized(token)) return;
    const snapshot = engine.getSnapshot();
    for (const agent of snapshot.agents) {
      engine.resetAgentVitals(agent.id);
    }
    io.emit('world:snapshot', engine.getSnapshot());
  });

  socket.on('dev:fresh-start', async (token: unknown) => {
    if (!isDevAuthorized(token)) return;
    console.log('[Server] Fresh start requested');
    try {
      await engine.freshStart();
      io.emit('world:snapshot', engine.getSnapshot());
      io.emit('dev:status', { paused: !engine.isRunning });
      console.log('[Server] Fresh start complete — snapshot broadcast');
    } catch (err) {
      console.error('[Server] Fresh start failed:', (err as Error).message);
    }
  });

  socket.on('dev:status-request', (token: unknown) => {
    if (!isDevAuthorized(token)) return;
    socket.emit('dev:status', { paused: !engine.isRunning });
  });

  // --- Infra 6: Viewport-aware streaming ---
  socket.on('viewport:update', (data: { x: number; y: number; width: number; height: number }) => {
    if (typeof data?.x !== 'number' || typeof data?.y !== 'number') return;
    // Clamp width/height to prevent memory amplification via very large viewport requests
    // (OWASP API4: Unrestricted Resource Consumption)
    engine.viewportManager.setViewport(socket.id, {
      x: data.x,
      y: data.y,
      width: Math.min(data.width ?? 40, 200),
      height: Math.min(data.height ?? 30, 200),
      buffer: 10,
    });
    // Send catch-up: agents currently in the new viewport
    const agents = engine.getViewportCatchup(socket.id);
    socket.emit('viewport:catchup', { agents });
  });

  // Per-socket error handler — prevents an unhandled 'error' event from crashing the process.
  // Without this, a malformed packet triggers an uncaught ERR_UNHANDLED_ERROR and takes down
  // the entire server. (CVE-2024-38355 pattern / Node.js EventEmitter behavior)
  socket.on('error', (err: Error) => {
    console.error(`[Socket] Error on socket ${socket.id}:`, err.message);
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    spectatorLastComment.delete(socket.id);
    recapLastRequest.delete(socket.id);
    watchSwitchLast.delete(socket.id);
    engine.viewportManager.removeClient(socket.id);
    const existing = watchIntervals.get(socket.id);
    if (existing) {
      clearInterval(existing.interval);
      watchIntervals.delete(socket.id);
    }
  });
});

engine.initialize().then(() => {
  engine.start();
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`AI Village server running on port ${PORT}`);
  });
}).catch((err: unknown) => {
  console.error('[Server] Engine initialization failed — aborting:', (err as Error).message);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Graceful shutdown — stop accepting connections, save state, then exit.
// 25s hard-timeout ensures we exit before k8s terminationGracePeriodSeconds
// (120s) kills us forcibly, even if save hangs.
// ---------------------------------------------------------------------------
let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Server] ${signal} — initiating graceful shutdown...`);

  // Hard-kill fallback: exit after 25s regardless of what hangs
  const killer = setTimeout(() => {
    console.error('[Server] Shutdown timeout — forcing exit');
    process.exit(1);
  }, 25_000);
  killer.unref(); // Don't prevent natural exit if everything completes faster

  // Stop accepting new connections; close existing keep-alive connections immediately
  // closeAllConnections() is Node.js 18.2+ — terminates idle keep-alive sockets
  // that httpServer.close() alone would leave open indefinitely (k8s SIGTERM issue)
  // Stop auth rate-limit cleanup interval
  stopAuthRateLimitCleaner();

  httpServer.close(() => console.log('[Server] HTTP server closed'));
  httpServer.closeAllConnections();

  try {
    await engine.stop(); // saves state + closes DB pool
  } catch (err) {
    console.error('[Server] Engine stop error:', (err as Error).message);
  }

  try {
    await closeRedis();
  } catch (err) {
    console.error('[Server] Redis close error:', (err as Error).message);
  }

  console.log('[Server] Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM').catch((err) => {
    console.error('[Server] gracefulShutdown threw unexpectedly:', err);
    process.exit(1);
  });
});
process.on('SIGINT', () => {
  gracefulShutdown('SIGINT').catch((err) => {
    console.error('[Server] gracefulShutdown threw unexpectedly:', err);
    process.exit(1);
  });
});

// ---------------------------------------------------------------------------
// Process stability — prevent silent crashes from unhandled rejections/exceptions
// ---------------------------------------------------------------------------
process.on('uncaughtException', (err) => {
  console.error('[Server] uncaughtException — initiating shutdown:', err);
  gracefulShutdown('uncaughtException').catch((shutdownErr) => {
    console.error('[Server] gracefulShutdown failed during uncaughtException:', shutdownErr);
    process.exit(1);
  });
});

process.on('unhandledRejection', (reason) => {
  // Node.js v15+ treats unhandledRejection the same as uncaughtException (process crash).
  // Initiate graceful shutdown to save state before exit.
  console.error('[Server] unhandledRejection — initiating shutdown:', reason);
  gracefulShutdown('unhandledRejection').catch((shutdownErr) => {
    console.error('[Server] gracefulShutdown failed during unhandledRejection:', shutdownErr);
    process.exit(1);
  });
});
