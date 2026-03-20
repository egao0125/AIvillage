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

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // Send initial snapshot
  socket.emit('world:snapshot', engine.getSnapshot());

  socket.on('agent:select', (agentId: string) => {
    console.log(`Client selected agent: ${agentId}`);
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
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
