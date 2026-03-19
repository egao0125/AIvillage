import { io, Socket } from 'socket.io-client';
import { gameStore } from '../core/GameStore';
import { eventBus } from '../core/EventBus';
import type { Agent, BoardPost, GameTime, WorldSnapshot } from '@ai-village/shared';

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

  return socket;
}

export function selectAgent(agentId: string): void {
  socket?.emit('agent:select', agentId);
  gameStore.selectAgent(agentId);
}
