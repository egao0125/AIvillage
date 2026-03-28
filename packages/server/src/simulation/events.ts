import type { Server } from 'socket.io';
import type { Agent, Artifact, BoardPost, Building, DriveState, Election, GameTime, Institution, Item, Mood, NarrativeEntry, Position, Property, Skill, SocialLedgerEntry, Technology, VitalState, Weather, WorldSnapshot } from '@ai-village/shared';
import type { VillageNarrator } from './narrator.js';
import type { CharacterTimeline } from './character-timeline.js';
import type { ViewportManager } from './viewport-manager.js';

export class EventBroadcaster {
  private narrator?: VillageNarrator;
  private timeline?: CharacterTimeline;
  private dayGetter?: () => number;
  private viewportManager?: ViewportManager;
  /** Callback to look up an agent's current position by ID */
  private positionLookup?: (agentId: string) => Position | undefined;

  constructor(private io: Server) {}

  setViewportManager(vm: ViewportManager): void {
    this.viewportManager = vm;
  }

  setPositionLookup(fn: (agentId: string) => Position | undefined): void {
    this.positionLookup = fn;
  }

  /**
   * Emit to viewers who can see the given position.
   * Falls back to broadcast-all if no viewports are registered.
   */
  private emitSpatial(event: string, data: any, pos: Position): void {
    if (!this.viewportManager || !this.viewportManager.hasViewports) {
      this.io.emit(event, data);
      return;
    }
    const viewers = this.viewportManager.getViewersAt(pos);
    for (const socketId of viewers) {
      this.io.to(socketId).emit(event, data);
    }
  }

  /**
   * Emit to viewers who can see an agent's current position.
   * Falls back to broadcast-all if position unknown or no viewports.
   */
  private emitForAgent(event: string, data: any, agentId: string): void {
    const pos = this.positionLookup?.(agentId);
    if (!pos || !this.viewportManager || !this.viewportManager.hasViewports) {
      this.io.emit(event, data);
      return;
    }
    const viewers = this.viewportManager.getViewersAt(pos);
    for (const socketId of viewers) {
      this.io.to(socketId).emit(event, data);
    }
  }

  setDayGetter(getter: () => number): void {
    this.dayGetter = getter;
  }

  private get currentDay(): number {
    return this.dayGetter?.() ?? 0;
  }

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
    if (!this.viewportManager || !this.viewportManager.hasViewports) {
      this.io.emit('agent:move', { agentId, from, to });
      return;
    }
    // Send to viewers of both departure and arrival positions
    const toViewers = this.viewportManager.getViewersAt(to);
    const fromViewers = this.viewportManager.getViewersAt(from);
    const allViewers = new Set([...toViewers, ...fromViewers]);
    const data = { agentId, from, to };
    for (const socketId of allViewers) {
      this.io.to(socketId).emit('agent:move', data);
    }
  }

  agentSpeak(agentId: string, name: string, message: string, conversationId: string): void {
    this.emitForAgent('agent:speak', { agentId, name, message, conversationId }, agentId);
    this.narrator?.logEvent(`${name} said: "${message.substring(0, 80)}"`);
    this.timeline?.recordEvent({ id: crypto.randomUUID(), agentId, type: 'conversation', description: `Said: "${message.substring(0, 100)}"`, relatedAgentIds: [], timestamp: Date.now(), day: this.currentDay });
  }

  agentAction(agentId: string, action: string, emoji?: string): void {
    this.emitForAgent('agent:action', { agentId, action, emoji }, agentId);
    this.narrator?.logEvent(`An agent performed action: ${action}`);
    this.timeline?.recordEvent({ id: crypto.randomUUID(), agentId, type: 'action', description: action, relatedAgentIds: [], timestamp: Date.now(), day: this.currentDay });
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

  boardPostUpdate(post: BoardPost): void {
    this.io.emit('board:update', post);
  }

  worldSnapshot(snapshot: WorldSnapshot): void {
    this.io.emit('world:snapshot', snapshot);
  }

  agentWorldView(agentId: string, worldView: string): void {
    this.io.emit('agent:worldView', { agentId, worldView });
  }

  agentMood(agentId: string, mood: string): void {
    // Mood is UI-only. No persistence, no memory, no timeline.
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
    this.emitForAgent('agent:thought', { agentId, thought }, agentId);
    this.narrator?.logEvent(`An agent thought privately: "${thought.substring(0, 60)}"`);
  }

  agentDeath(agentId: string, cause: string): void {
    this.io.emit('agent:death', { agentId, cause });
    this.narrator?.logEvent(`An agent has died: ${cause}`);
    this.timeline?.recordEvent({ id: crypto.randomUUID(), agentId, type: 'death', description: `Died: ${cause}`, relatedAgentIds: [], timestamp: Date.now(), day: this.currentDay });
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

  ledgerUpdate(agentId: string, entry: SocialLedgerEntry): void {
    this.io.emit('ledger:update', { agentId, entry });
  }
}
