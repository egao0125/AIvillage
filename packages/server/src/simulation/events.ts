import type { Server } from 'socket.io';
import type { Agent, Artifact, BoardPost, Building, DriveState, Election, GameTime, Institution, Item, Mood, Position, Property, Skill, Technology, VitalState, Weather, WorldEvent, WorldSnapshot } from '@ai-village/shared';

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

  agentLeave(agentId: string): void {
    this.io.emit('agent:leave', { agentId });
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

  agentMood(agentId: string, mood: string): void {
    this.io.emit('agent:mood', { agentId, mood });
  }

  agentInventory(agentId: string, inventory: Item[]): void {
    this.io.emit('agent:inventory', { agentId, inventory });
  }

  agentSkill(agentId: string, skill: Skill): void {
    this.io.emit('agent:skill', { agentId, skill });
  }

  secretShared(fromId: string, toId: string): void {
    this.io.emit('secret:shared', { fromId, toId });
  }

  worldEvent(event: WorldEvent): void {
    this.io.emit('world:event', event);
  }

  electionUpdate(election: Election): void {
    this.io.emit('election:update', election);
  }

  propertyChange(property: Property): void {
    this.io.emit('property:change', property);
  }

  reputationChange(fromId: string, toId: string, score: number): void {
    this.io.emit('reputation:change', { fromId, toId, score });
  }

  agentThought(agentId: string, thought: string): void {
    this.io.emit('agent:thought', { agentId, thought });
  }

  agentDeath(agentId: string, cause: string): void {
    this.io.emit('agent:death', { agentId, cause });
  }

  agentDrives(agentId: string, drives: DriveState): void {
    this.io.emit('agent:drives', { agentId, drives });
  }

  agentVitals(agentId: string, vitals: VitalState): void {
    this.io.emit('agent:vitals', { agentId, vitals });
  }

  weatherChange(weather: Weather): void {
    this.io.emit('world:weather', weather);
  }

  institutionUpdate(institution: Institution): void {
    this.io.emit('institution:update', institution);
  }

  artifactCreated(artifact: Artifact): void {
    this.io.emit('artifact:created', artifact);
  }

  buildingUpdate(building: Building): void {
    this.io.emit('building:update', building);
  }

  technologyDiscovered(technology: Technology): void {
    this.io.emit('technology:discovered', technology);
  }
}
