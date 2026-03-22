import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { SimulationEngine } from './simulation/engine.js';
import { createRouter } from './routes.js';
import { createAuthRouter, optionalAuth } from './auth.js';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '4000');
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';
const isProduction = process.env.NODE_ENV === 'production';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: isProduction
    ? {}
    : { origin: CLIENT_URL, methods: ['GET', 'POST'] },
});

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

  // Recap request — per-viewer
  socket.on('recap:request', async (data: { sinceDay: number }) => {
    if (typeof data?.sinceDay !== 'number' || data.sinceDay < 0) return;
    try {
      const recap = await engine.recapGenerator.generateRecap(data.sinceDay);
      socket.emit('recap:ready', recap);
    } catch (err) {
      console.error('[Recap] Failed to generate recap:', err);
    }
  });

  // Weekly summary — on-demand per-viewer
  socket.on('weekly-summary:request', async () => {
    try {
      const summary = await engine.generateWeeklySummary();
      socket.emit('weekly-summary:ready', { summary });
    } catch (err) {
      console.error('[WeeklySummary] Failed:', err);
    }
  });

  // Spectator chat — relay to all clients
  socket.on('spectator:comment', (data: { message: string }) => {
    if (!data.message || typeof data.message !== 'string') return;
    const msg = data.message.trim().slice(0, 200);
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

  // --- Dev tools ---
  socket.on('dev:pause', () => {
    engine.pause();
    io.emit('dev:status', { paused: !engine.isRunning });
  });

  socket.on('dev:resume', () => {
    engine.start();
    io.emit('dev:status', { paused: !engine.isRunning });
  });

  socket.on('dev:step', () => {
    engine.singleTick();
    io.emit('world:snapshot', engine.getSnapshot());
  });

  socket.on('dev:reset-vitals', () => {
    const snapshot = engine.getSnapshot();
    for (const agent of snapshot.agents) {
      engine.resetAgentVitals(agent.id);
    }
    io.emit('world:snapshot', engine.getSnapshot());
  });

  socket.on('dev:status-request', () => {
    socket.emit('dev:status', { paused: !engine.isRunning });
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    spectatorLastComment.delete(socket.id);
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
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[Server] SIGINT — saving state...');
  await engine.stop();
  process.exit(0);
});
