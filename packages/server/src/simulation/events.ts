import type { Server } from 'socket.io';
import type { Agent, Artifact, BoardPost, Building, DriveState, Election, GameTime, Institution, Item, Mood, NarrativeEntry, Position, Property, Skill, Technology, VitalState, Weather, WorldSnapshot } from '@ai-village/shared';
import type { VillageNarrator } from './narrator.js';
import type { CharacterTimeline } from './character-timeline.js';

export class EventBroadcaster {
  private narrator?: VillageNarrator;
  private timeline?: CharacterTimeline;

  constructor(private io: Server) {}

  setNarrator(narrator: VillageNarrator): void {
    this.narrator = narrator;
  }

  setTimeline(timeline: CharacterTimeline): void {
    this.timeline = timeline;
  }

  narrativeUpdate(narrative: NarrativeEntry): void {
    this.io.emit('narrative:update', narrative);
  }

  storylineNew(storyline: any): void {
    this.io.emit('storyline:new', storyline);
  }

  storylineUpdate(storyline: any): void {
    this.io.emit('storyline:update', storyline);
  }

  agentMove(agentId: string, from: Position, to: Position): void {
    this.io.emit('agent:move', { agentId, from, to });
  }

  agentSpeak(agentId: string, name: string, message: string, conversationId: string): void {
    this.io.emit('agent:speak', { agentId, name, message, conversationId });
    this.narrator?.logEvent(`${name} said: "${message.substring(0, 80)}"`);
    this.timeline?.recordEvent({ id: crypto.randomUUID(), agentId, type: 'conversation', description: `Said: "${message.substring(0, 100)}"`, relatedAgentIds: [], timestamp: Date.now(), day: 0 });
  }

  agentAction(agentId: string, action: string, emoji?: string): void {
    this.io.emit('agent:action', { agentId, action, emoji });
    this.narrator?.logEvent(`An agent performed action: ${action}`);
    this.timeline?.recordEvent({ id: crypto.randomUUID(), agentId, type: 'action', description: action, relatedAgentIds: [], timestamp: Date.now(), day: 0 });
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
    this.narrator?.logEvent(`A conversation ended`);
  }

  worldTime(time: GameTime): void {
    this.io.emit('world:time', time);
  }

  boardPost(post: BoardPost): void {
    this.io.emit('board:post', post);
    this.narrator?.logEvent(`${post.authorName} posted a ${post.type}: "${post.content.substring(0, 60)}"`);
    this.timeline?.recordEvent({ id: crypto.randomUUID(), agentId: post.authorId, type: 'board_post', description: `Posted ${post.type}: ${post.content.substring(0, 80)}`, relatedAgentIds: post.targetIds ?? [], timestamp: Date.now(), day: post.day });
  }

  worldSnapshot(snapshot: WorldSnapshot): void {
    this.io.emit('world:snapshot', snapshot);
  }

  agentMood(agentId: string, mood: string): void {
    this.io.emit('agent:mood', { agentId, mood });
    this.narrator?.logEvent(`An agent's mood changed to ${mood}`);
    this.timeline?.recordEvent({ id: crypto.randomUUID(), agentId, type: 'mood_change', description: `Mood changed to ${mood}`, relatedAgentIds: [], timestamp: Date.now(), day: 0 });
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
    this.narrator?.logEvent(`An agent thought privately: "${thought.substring(0, 60)}"`);
  }

  agentDeath(agentId: string, cause: string): void {
    this.io.emit('agent:death', { agentId, cause });
    this.narrator?.logEvent(`An agent has died: ${cause}`);
    this.timeline?.recordEvent({ id: crypto.randomUUID(), agentId, type: 'death', description: `Died: ${cause}`, relatedAgentIds: [], timestamp: Date.now(), day: 0 });
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
    this.narrator?.logEvent(`Institution "${institution.name}" (${institution.type}) was updated — ${institution.members.length} members`);
  }

  artifactCreated(artifact: Artifact): void {
    this.io.emit('artifact:created', artifact);
    this.narrator?.logEvent(`${artifact.creatorName} created a ${artifact.type}: "${artifact.title}"`);
    this.timeline?.recordEvent({ id: crypto.randomUUID(), agentId: artifact.creatorId, type: 'artifact', description: `Created ${artifact.type}: "${artifact.title}"`, relatedAgentIds: artifact.addressedTo ?? [], timestamp: Date.now(), day: artifact.day });
  }

  buildingUpdate(building: Building): void {
    this.io.emit('building:update', building);
  }

  technologyDiscovered(technology: Technology): void {
    this.io.emit('technology:discovered', technology);
    this.narrator?.logEvent(`${technology.inventorName} discovered a new technology: "${technology.name}" — ${technology.description}`);
  }
}
