import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { SimulationEngine } from './simulation/engine.js';
import { createRouter } from './routes.js';

const PORT = parseInt(process.env.PORT || '4000');
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: CLIENT_URL, methods: ['GET', 'POST'] },
});

app.use(express.json());

const engine = new SimulationEngine(io);

app.use(createRouter(engine));

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
  httpServer.listen(PORT, () => {
    console.log(`AI Village server running on port ${PORT}`);
  });
});
