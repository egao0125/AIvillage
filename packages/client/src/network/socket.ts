import { io, Socket } from 'socket.io-client';
import { gameStore } from '../core/GameStore';
import { eventBus } from '../core/EventBus';
import type {
  Agent,
  BoardPost,
  GameTime,
  WorldSnapshot,
  Item,
  Skill,
  WorldEvent,
  Election,
  Property,
  DriveState,
  VitalState,
  Weather,
  Institution,
  Artifact,
  Building,
  Technology,
} from '@ai-village/shared';

let socket: Socket | null = null;

export function connectSocket(): Socket {
  if (socket) return socket;

  socket = io('/', { transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    console.log('Connected to AI Village server');
    gameStore.setConnected(true);
  });

  socket.on('disconnect', () => {
    console.log('Disconnected from server');
    gameStore.setConnected(false);
  });

  socket.on('world:snapshot', (snapshot: WorldSnapshot) => {
    gameStore.setAgents(snapshot.agents);
    gameStore.setTime(snapshot.time);
    if (snapshot.board) gameStore.setBoard(snapshot.board);
    if (snapshot.events) gameStore.setEvents(snapshot.events);
    if (snapshot.elections) gameStore.setElections(snapshot.elections);
    if (snapshot.properties) gameStore.setProperties(snapshot.properties);
    if (snapshot.reputation) gameStore.setReputation(snapshot.reputation);
    if (snapshot.weather) gameStore.setWeather(snapshot.weather);
    if (snapshot.institutions) gameStore.setInstitutions(snapshot.institutions);
    if (snapshot.artifacts) gameStore.setArtifacts(snapshot.artifacts);
    if (snapshot.buildings) gameStore.setBuildings(snapshot.buildings);
    if (snapshot.technologies) gameStore.setTechnologies(snapshot.technologies);
    eventBus.emit('world:snapshot', snapshot);
  });

  socket.on('board:post', (post: BoardPost) => {
    gameStore.addBoardPost(post);
    eventBus.emit('board:post', post);
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
      gameStore.updateAgentAction(data.agentId, data.action);
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

  socket.on('world:event', (event: WorldEvent) => {
    gameStore.addWorldEvent(event);
  });

  socket.on('election:update', (election: Election) => {
    gameStore.updateElection(election);
  });

  socket.on('property:change', (property: Property) => {
    gameStore.updateProperty(property);
  });

  socket.on('reputation:change', (data: { fromId: string; toId: string; score: number }) => {
    gameStore.updateReputation(data.fromId, data.toId, data.score);
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

  return socket;
}

export function selectAgent(agentId: string): void {
  socket?.emit('agent:select', agentId);
  gameStore.selectAgent(agentId);
}
