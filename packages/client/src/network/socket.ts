import { io, Socket } from 'socket.io-client';
import { gameStore } from '../core/GameStore';
import { eventBus } from '../core/EventBus';
import { getToken } from '../utils/auth';
import type {
  Agent,
  AgentConfig,
  BoardPost,
  GameTime,
  WorldSnapshot,
  Item,
  Skill,
  Election,
  Property,
  DriveState,
  VitalState,
  Weather,
  Institution,
  Artifact,
  Building,
  Technology,
  NarrativeEntry,
  Storyline,
  Recap,
  SocialLedgerEntry,
} from '@ai-village/shared';

let socket: Socket | null = null;
let lastSeenDayTimer: ReturnType<typeof setInterval> | null = null;

export function connectSocket(): Socket {
  if (socket) return socket;

  // Pass auth token as a callback so it is re-evaluated on every reconnect attempt.
  // This ensures a refreshed token is used if the original expires mid-session.
  socket = io('/', {
    transports: ['websocket', 'polling'],
    auth: (cb) => cb({ token: getToken() ?? '' }),
    // Cap reconnection attempts to prevent a permanently-gone server from causing
    // an infinite background retry loop in the browser tab.
    // 10 attempts × exponential back-off ≈ ~5 minutes of retrying, then the UI
    // shows a "connection lost — reload" state via the 'reconnect_failed' event.
    reconnectionAttempts: 10,
  });

  socket.on('connect', () => {
    console.log('Connected to AI Village server');
    gameStore.setConnected(true);
  });

  socket.on('disconnect', () => {
    console.log('Disconnected from server');
    gameStore.setConnected(false);
    // Clear the last-seen-day timer on disconnect to avoid accumulation on reconnect
    if (lastSeenDayTimer !== null) {
      clearInterval(lastSeenDayTimer);
      lastSeenDayTimer = null;
    }
  });

  // All reconnection attempts exhausted — inform the user so they know to reload.
  socket.on('reconnect_failed', () => {
    console.error('[Socket] Reconnection failed after max attempts. Please reload the page.');
    gameStore.setConnected(false);
  });

  socket.on('world:snapshot', (snapshot: WorldSnapshot) => {
    gameStore.setAgents(snapshot.agents);
    gameStore.setTime(snapshot.time);
    if (snapshot.board) gameStore.setBoard(snapshot.board);
    if (snapshot.elections) gameStore.setElections(snapshot.elections);
    if (snapshot.properties) gameStore.setProperties(snapshot.properties);
    if (snapshot.reputation) gameStore.setReputation(snapshot.reputation);
    if (snapshot.weather) gameStore.setWeather(snapshot.weather);
    if (snapshot.institutions) gameStore.setInstitutions(snapshot.institutions);
    if (snapshot.artifacts) gameStore.setArtifacts(snapshot.artifacts);
    if (snapshot.buildings) gameStore.setBuildings(snapshot.buildings);
    if (snapshot.technologies) gameStore.setTechnologies(snapshot.technologies);
    if (snapshot.narratives) gameStore.setNarratives(snapshot.narratives);
    if (snapshot.storylines) gameStore.setStorylines(snapshot.storylines);
    if (snapshot.weeklySummary) gameStore.setWeeklySummary(snapshot.weeklySummary);
    if (snapshot.villageMemory) gameStore.setVillageMemory(snapshot.villageMemory);

    // Check if we need a recap (returning after 2+ game days absence).
    // sessionStorage is tab-scoped and cleared on tab close — reduces XSS blast radius
    // vs. localStorage which persists across sessions and is readable by all same-origin scripts.
    try {
      const lastSeenDay = parseInt(sessionStorage.getItem('ai-village-last-seen-day') || '0');
      if (lastSeenDay > 0 && snapshot.time.day > lastSeenDay + 2) {
        socket?.emit('recap:request', { sinceDay: lastSeenDay });
      }
      sessionStorage.setItem('ai-village-last-seen-day', String(snapshot.time.day));
    } catch {
      // sessionStorage unavailable (private browsing / storage quota) — skip recap tracking
    }

    eventBus.emit('world:snapshot', snapshot);
  });

  socket.on('board:post', (post: BoardPost) => {
    gameStore.addBoardPost(post);
    eventBus.emit('board:post', post);
  });

  socket.on('board:update', (post: BoardPost) => {
    gameStore.updateBoardPost(post);
  });

  socket.on(
    'agent:move',
    (data: {
      agentId: string;
      from: { x: number; y: number };
      to: { x: number; y: number };
    }) => {
      gameStore.moveAgent(data.agentId, data.to);
      eventBus.emit('agent:move', data);
    }
  );

  socket.on(
    'agent:speak',
    (data: {
      agentId: string;
      name: string;
      message: string;
      conversationId: string;
    }) => {
      gameStore.addChatEntry({
        id: crypto.randomUUID(),
        agentId: data.agentId,
        agentName: data.name,
        message: data.message,
        timestamp: Date.now(),
        conversationId: data.conversationId,
      });
      eventBus.emit('agent:speak', data);
    }
  );

  socket.on(
    'agent:action',
    (data: { agentId: string; action: string; emoji?: string }) => {
      gameStore.updateAgentAction(data.agentId, data.action, data.emoji);
      eventBus.emit('agent:action', data);
    }
  );

  socket.on('agent:spawn', (data: { agent: Agent }) => {
    gameStore.updateAgent(data.agent);
    eventBus.emit('agent:spawn', data.agent);
  });

  socket.on(
    'agent:currency',
    (data: { agentId: string; currency: number; delta: number; reason: string }) => {
      gameStore.updateAgentCurrency(data.agentId, data.currency);
      eventBus.emit('agent:currency', data);
    }
  );

  socket.on('world:time', (time: GameTime) => {
    gameStore.setTime(time);
    eventBus.emit('world:time', time);
  });

  socket.on(
    'conversation:start',
    (data: { conversationId: string; participants: string[] }) => {
      gameStore.addConversation(data.conversationId, data.participants);
      eventBus.emit('conversation:start', data);
    }
  );

  socket.on(
    'conversation:end',
    (data: { conversationId: string }) => {
      gameStore.removeConversation(data.conversationId);
      eventBus.emit('conversation:end', data);
    }
  );

  // --- New event listeners ---

  socket.on('agent:worldView', (data: { agentId: string; worldView: string }) => {
    gameStore.updateAgentWorldView(data.agentId, data.worldView);
  });

  socket.on('agent:mood', (data: { agentId: string; mood: string }) => {
    gameStore.updateAgentMood(data.agentId, data.mood);
  });

  socket.on('agent:inventory', (data: { agentId: string; inventory: Item[] }) => {
    gameStore.updateAgentInventory(data.agentId, data.inventory);
  });

  socket.on('agent:skill', (data: { agentId: string; skill: Skill }) => {
    gameStore.updateAgentSkill(data.agentId, data.skill);
  });

  socket.on('secret:shared', (data: { fromId: string; toId: string }) => {
    // Show as whisper in chat log
    const fromAgent = gameStore.getState().agents.get(data.fromId);
    const toAgent = gameStore.getState().agents.get(data.toId);
    if (fromAgent && toAgent) {
      gameStore.addChatEntry({
        id: crypto.randomUUID(),
        agentId: data.fromId,
        agentName: fromAgent.config.name,
        message: `*whispered something to ${toAgent.config.name}*`,
        timestamp: Date.now(),
        conversationId: '',
      });
    }
  });

  socket.on('election:update', (election: Election) => {
    gameStore.updateElection(election);
  });

  socket.on('property:change', (property: Property) => {
    gameStore.updateProperty(property);
  });

  socket.on('reputation:change', (data: { fromId: string; toId: string; score: number }) => {
    gameStore.updateReputation(data.fromId, data.toId, data.score);
    eventBus.emit('reputation:change', data);
  });

  // --- Phase 2-7 event listeners ---

  socket.on('agent:thought', (data: { agentId: string; thought: string }) => {
    const agent = gameStore.getState().agents.get(data.agentId);
    if (agent) {
      gameStore.addThought({
        id: crypto.randomUUID(),
        agentId: data.agentId,
        agentName: agent.config.name,
        thought: data.thought,
        timestamp: Date.now(),
      });
    }
    eventBus.emit('agent:thought', data);
  });

  socket.on('agent:drives', (data: { agentId: string; drives: DriveState }) => {
    gameStore.updateAgentDrives(data.agentId, data.drives);
  });

  socket.on('agent:vitals', (data: { agentId: string; vitals: VitalState }) => {
    gameStore.updateAgentVitals(data.agentId, data.vitals);
  });

  socket.on('agent:death', (data: { agentId: string; cause: string }) => {
    gameStore.markAgentDead(data.agentId, data.cause);
    const agent = gameStore.getState().agents.get(data.agentId);
    if (agent) {
      gameStore.addChatEntry({
        id: crypto.randomUUID(),
        agentId: data.agentId,
        agentName: agent.config.name,
        message: `*${agent.config.name} has died: ${data.cause}*`,
        timestamp: Date.now(),
        conversationId: '',
      });
    }
    eventBus.emit('agent:death', data);
  });

  socket.on('agent:leave', (data: { agentId: string }) => {
    gameStore.removeAgent(data.agentId);
    eventBus.emit('agent:leave', data);
  });

  socket.on('world:weather', (weather: Weather) => {
    gameStore.setWeather(weather);
    eventBus.emit('world:weather', weather);
  });

  socket.on('institution:update', (institution: Institution) => {
    gameStore.updateInstitution(institution);
    eventBus.emit('institution:update', institution);
  });

  socket.on('artifact:created', (artifact: Artifact) => {
    gameStore.addArtifact(artifact);
    eventBus.emit('artifact:created', artifact);
  });

  socket.on('building:update', (building: Building) => {
    gameStore.updateBuilding(building);
    eventBus.emit('building:update', building);
  });

  socket.on('technology:discovered', (technology: Technology) => {
    gameStore.addTechnology(technology);
    eventBus.emit('technology:discovered', technology);
  });

  // --- Narrative + Storyline + Recap listeners ---

  socket.on('narrative:update', (narrative: NarrativeEntry) => {
    gameStore.addNarrative(narrative);
    eventBus.emit('narrative:update', narrative);
  });

  socket.on('storyline:new', (storyline: Storyline) => {
    gameStore.updateStoryline(storyline);
  });

  socket.on('storyline:update', (storyline: Storyline) => {
    gameStore.updateStoryline(storyline);
  });

  socket.on('recap:ready', (recap: Recap) => {
    gameStore.setActiveRecap(recap);
  });

  socket.on('weekly-summary:ready', (data: { summary: string | null }) => {
    if (data.summary) gameStore.setWeeklySummary(data.summary);
  });

  // --- Ledger real-time updates ---
  socket.on('ledger:update', (data: { agentId: string; entry: SocialLedgerEntry }) => {
    gameStore.updateAgentLedger(data.agentId, data.entry);
    eventBus.emit('ledger:update', data);
  });

  // --- Infra 6: Viewport catch-up ---
  socket.on('viewport:catchup', (data: { agents: Array<{ id: string; position: { x: number; y: number }; state: string; currentAction: string; mood: string; config: AgentConfig }> }) => {
    for (const agent of data.agents) {
      gameStore.moveAgent(agent.id, agent.position);
      gameStore.updateAgentAction(agent.id, agent.currentAction);
      if (agent.mood) gameStore.updateAgentMood(agent.id, agent.mood);
    }
    eventBus.emit('viewport:catchup', data);
  });

  // Update last-seen day periodically. Store the ID so it can be cleared on disconnect.
  lastSeenDayTimer = setInterval(() => {
    const time = gameStore.getState().time;
    if (time.day > 0) {
      try {
        sessionStorage.setItem('ai-village-last-seen-day', String(time.day));
      } catch {
        // sessionStorage unavailable (private browsing / storage quota) — skip
      }
    }
  }, 60_000);

  // --- Spectator chat ---
  socket.on('spectator:comment', (data: { name: string; message: string; timestamp: number }) => {
    eventBus.emit('spectator:comment', data);
  });

  return socket;
}

export function sendSpectatorComment(message: string): void {
  socket?.emit('spectator:comment', { message });
}

// --- Dev tools ---
// Server requires DEV_ADMIN_TOKEN as first argument for all dev:* commands.
// Set VITE_DEV_ADMIN_TOKEN in the client build environment (e.g. .env.local)
// to enable the dev panel. Leave unset to disable dev commands from this client.
const DEV_TOKEN: string = import.meta.env.VITE_DEV_ADMIN_TOKEN ?? '';

// Guard all dev commands: if DEV_TOKEN is not configured, emit nothing.
// The server would reject empty tokens anyway, but this avoids spurious socket events.
export function devPause(): void { if (DEV_TOKEN) socket?.emit('dev:pause', DEV_TOKEN); }
export function devResume(): void { if (DEV_TOKEN) socket?.emit('dev:resume', DEV_TOKEN); }
export function devStep(): void { if (DEV_TOKEN) socket?.emit('dev:step', DEV_TOKEN); }
export function devResetVitals(): void { if (DEV_TOKEN) socket?.emit('dev:reset-vitals', DEV_TOKEN); }
export function devFreshStart(): void { if (DEV_TOKEN) socket?.emit('dev:fresh-start', DEV_TOKEN); }
export function devRequestStatus(): void { if (DEV_TOKEN) socket?.emit('dev:status-request', DEV_TOKEN); }
export function onDevStatus(cb: (data: { paused: boolean }) => void): () => void {
  socket?.on('dev:status', cb);
  return () => { socket?.off('dev:status', cb); };
}

export function selectAgent(agentId: string): void {
  socket?.emit('agent:select', agentId);
  gameStore.selectAgent(agentId);
  eventBus.emit('agent:select', agentId);
}

export function watchThoughts(agentId: string): void {
  socket?.emit('agent:watch-thoughts', agentId);
}

export function unwatchThoughts(): void {
  socket?.emit('agent:unwatch-thoughts');
}

/** Infra 6: Report viewport rectangle to server for spatial event filtering */
export function sendViewportUpdate(x: number, y: number, width: number, height: number): void {
  socket?.emit('viewport:update', { x, y, width, height });
}

