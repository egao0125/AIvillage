import { Router } from 'express';
import type { SimulationEngine } from './simulation/engine.js';

export function createRouter(engine: SimulationEngine): Router {
  const router = Router();

  router.get('/api/agents', (_req, res) => {
    const snapshot = engine.getSnapshot();
    res.json(snapshot.agents);
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

  router.post('/api/config', (req, res) => {
    const { apiKey, model } = req.body;

    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 10) {
      res.status(400).json({ error: 'Valid API key required' });
      return;
    }

    engine.updateApiKey(apiKey.trim(), model);
    res.json({ success: true, model: model || 'claude-sonnet-4-20250514' });
  });

  router.post('/api/agents', (req, res) => {
    const { name, age, occupation, soul, wakeHour, sleepHour } = req.body;

    // Validate
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'Name is required' }); return;
    }
    if (!occupation || typeof occupation !== 'string') {
      res.status(400).json({ error: 'Occupation is required' }); return;
    }

    const config = {
      name: name.trim(),
      age: age || 30,
      occupation: occupation.trim(),
      personality: {
        openness: 0.5,
        conscientiousness: 0.5,
        extraversion: 0.5,
        agreeableness: 0.5,
        neuroticism: 0.5,
      },
      soul: (soul || '').trim().slice(0, 2000),
      backstory: '',
      goal: '',
      spriteId: 'default',
    };

    const agent = engine.addAgent(config, wakeHour, sleepHour);
    res.json({ agent });
  });

  return router;
}
