import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { SimulationEngine } from './simulation/engine.js';
import { createRouter } from './routes.js';
import { createAuthRouter, optionalAuth } from './auth.js';
import { setupRedis, closeRedis } from './redis.js';
import { isEncryptionConfigured } from './crypto.js';
import { createClient } from '@supabase/supabase-js';
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
  console.warn('[Security] ALLOWED_ORIGINS is not set — all cross-origin requests will be rejected.');
}

// Encryption: warn loudly if API key encryption is not configured in production.
if (isProduction && !isEncryptionConfigured()) {
  console.warn(
    '\n[Security] WARNING: ENCRYPTION_KEY is not set.' +
    '\n           User API keys will be stored as plaintext in the database.' +
    '\n           Generate a key: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"' +
    '\n           Then set ENCRYPTION_KEY=<64-hex-chars> in your environment.\n',
  );
}

// Redis: setup pub/sub clients before Socket.IO so the adapter is ready at startup.
// Falls back to in-memory (single-instance) when REDIS_URL is not set.
const redis = setupRedis();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: isProduction
    ? { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'] }
    : { origin: CLIENT_URL, methods: ['GET', 'POST'] },
});

if (redis) {
  io.adapter(createAdapter(redis.pub, redis.sub));
  console.log('[Server] Socket.IO Redis adapter enabled — multi-instance ready');
} else {
  console.log('[Server] Socket.IO using in-memory adapter (single-instance only)');
}

// Limit request body size to prevent abuse
app.use(express.json({ limit: '16kb' }));

const engine = new SimulationEngine(io);

// Auth: mount auth routes + optionalAuth middleware on all /api routes
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (supabaseUrl && supabaseKey) {
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  app.use(createAuthRouter(supabaseUrl, supabaseKey));
  app.use('/api', optionalAuth(supabase));
}

app.use(createRouter(engine));

// In production, serve the built client files
if (isProduction) {
  const clientDist = path.resolve(__dirname, '../../client/dist');
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// Spectator comment rate limit: 1 per 10 seconds per socket
const spectatorLastComment: Map<string, number> = new Map();
// On-demand thought generation: one interval per watching socket
const watchIntervals: Map<string, { interval: NodeJS.Timeout; agentId: string }> = new Map();

// Dev tools: require a secret token to prevent accidental or malicious use in production.
// Set DEV_ADMIN_TOKEN in environment to enable dev commands. Leave unset to disable entirely.
const DEV_ADMIN_TOKEN = process.env.DEV_ADMIN_TOKEN;
function isDevAuthorized(token: unknown): boolean {
  return (
    typeof DEV_ADMIN_TOKEN === 'string' &&
    DEV_ADMIN_TOKEN.length > 0 &&
    token === DEV_ADMIN_TOKEN
  );
}

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // Send initial snapshot
  socket.emit('world:snapshot', engine.getSnapshot());

  socket.on('agent:select', (agentId: string) => {
    console.log(`Client selected agent: ${agentId}`);
  });

  // On-demand thought generation — only when a viewer is watching
  socket.on('agent:watch-thoughts', (agentId: string) => {
    if (typeof agentId !== 'string' || !agentId) return;
    const existing = watchIntervals.get(socket.id);
    if (existing) clearInterval(existing.interval);

    const emit = (thought: string | null) => {
      const current = watchIntervals.get(socket.id);
      if (thought && current && current.agentId === agentId) {
        socket.emit('agent:thought', { agentId, thought });
      }
    };

    // Generate one immediately
    engine.generateThoughtFor(agentId).then(emit);

    // Then every 10 seconds
    const interval = setInterval(() => {
      engine.generateThoughtFor(agentId).then(emit);
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

  // Recap request — generate a catch-up recap for returning viewers
  socket.on('recap:request', async (data: { sinceDay: number }) => {
    if (typeof data?.sinceDay !== 'number') return;
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
    const msg = data.message
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .trim()
      .slice(0, 200);
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
    await engine.freshStart();
    io.emit('world:snapshot', engine.getSnapshot());
    io.emit('dev:status', { paused: !engine.isRunning });
    console.log('[Server] Fresh start complete — snapshot broadcast');
  });

  socket.on('dev:status-request', (token: unknown) => {
    if (!isDevAuthorized(token)) return;
    socket.emit('dev:status', { paused: !engine.isRunning });
  });

  // --- Infra 6: Viewport-aware streaming ---
  socket.on('viewport:update', (data: { x: number; y: number; width: number; height: number }) => {
    if (typeof data?.x !== 'number' || typeof data?.y !== 'number') return;
    engine.viewportManager.setViewport(socket.id, {
      x: data.x,
      y: data.y,
      width: data.width ?? 40,
      height: data.height ?? 30,
      buffer: 10,
    });
    // Send catch-up: agents currently in the new viewport
    const agents = engine.getViewportCatchup(socket.id);
    socket.emit('viewport:catchup', { agents });
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    spectatorLastComment.delete(socket.id);
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
});

// Graceful shutdown — critical for Fly.io which sends SIGTERM before stopping
process.on('SIGTERM', async () => {
  console.log('[Server] SIGTERM — saving state...');
  await engine.stop();
  await closeRedis();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[Server] SIGINT — saving state...');
  await engine.stop();
  await closeRedis();
  process.exit(0);
});
