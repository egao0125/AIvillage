import type { Server } from 'socket.io';
import type { Agent, BoardPost, GameTime, Position, WorldSnapshot } from '@ai-village/shared';

export class EventBroadcaster {
  constructor(private io: Server) {}

  agentMove(agentId: string, from: Position, to: Position): void {
    this.io.emit('agent:move', { agentId, from, to });
  }

  agentSpeak(agentId: string, name: string, message: string, conversationId: string): void {
    this.io.emit('agent:speak', { agentId, name, message, conversationId });
  }

  agentAction(agentId: string, action: string, emoji?: string): void {
    this.io.emit('agent:action', { agentId, action, emoji });
  }

  agentSpawn(agent: Agent): void {
    this.io.emit('agent:spawn', { agent });
  }

  agentCurrency(agentId: string, currency: number, delta: number, reason: string): void {
    this.io.emit('agent:currency', { agentId, currency, delta, reason });
  }

  conversationStart(conversationId: string, participants: string[]): void {
    this.io.emit('conversation:start', { conversationId, participants });
  }

  conversationEnd(conversationId: string): void {
    this.io.emit('conversation:end', { conversationId });
  }

  worldTime(time: GameTime): void {
    this.io.emit('world:time', time);
  }

  boardPost(post: BoardPost): void {
    this.io.emit('board:post', post);
  }

  worldSnapshot(snapshot: WorldSnapshot): void {
    this.io.emit('world:snapshot', snapshot);
  }
}
