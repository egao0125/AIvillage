import type { Agent, AgentState, BoardPost, BoardPostType, Conversation, GameTime, MapArea, Position, WorldSnapshot } from '@ai-village/shared';
import { AREAS, getAreaAt as mapGetAreaAt } from '../map/village.js';

export class World {
  agents: Map<string, Agent> = new Map();
  conversations: Map<string, Conversation> = new Map();
  board: BoardPost[] = [];
  time: GameTime;

  constructor() {
    this.time = {
      day: 1,
      hour: 5,
      minute: 0,
      totalMinutes: 5 * 60,
    };
  }

  addAgent(agent: Agent): void {
    this.agents.set(agent.id, agent);
  }

  getAgent(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  updateAgentPosition(id: string, pos: Position): void {
    const agent = this.agents.get(id);
    if (agent) {
      agent.position = { x: pos.x, y: pos.y };
    }
  }

  updateAgentState(id: string, state: AgentState, action?: string): void {
    const agent = this.agents.get(id);
    if (agent) {
      agent.state = state;
      if (action !== undefined) {
        agent.currentAction = action;
      }
    }
  }

  updateAgentCurrency(id: string, delta: number): number {
    const agent = this.agents.get(id);
    if (!agent) return 0;
    agent.currency = Math.max(0, agent.currency + delta);
    return agent.currency;
  }

  getNearbyAgents(pos: Position, radius: number): Agent[] {
    const nearby: Agent[] = [];
    for (const agent of this.agents.values()) {
      const dx = agent.position.x - pos.x;
      const dy = agent.position.y - pos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= radius) {
        nearby.push(agent);
      }
    }
    return nearby;
  }

  getAreaAt(pos: Position): MapArea | undefined {
    return mapGetAreaAt(pos);
  }

  /**
   * Advance time by 1 game minute. Wraps hours at 24, increments days.
   */
  advanceTime(): GameTime {
    this.time.totalMinutes++;
    this.time.minute++;
    if (this.time.minute >= 60) {
      this.time.minute = 0;
      this.time.hour++;
      if (this.time.hour >= 24) {
        this.time.hour = 0;
        this.time.day++;
      }
    }
    return { ...this.time };
  }

  addBoardPost(post: BoardPost): void {
    this.board.push(post);
    // Keep board manageable — max 50 active posts
    if (this.board.length > 50) {
      this.board = this.board.slice(-50);
    }
    console.log(`[Board] ${post.authorName} posted [${post.type}]: ${post.content}`);
  }

  getActiveBoard(): BoardPost[] {
    return this.board.filter(p => !p.revoked);
  }

  getBoardSummary(): string {
    const active = this.getActiveBoard();
    if (active.length === 0) return 'The village board is empty.';
    return active.map(p => `[${p.type.toUpperCase()}] ${p.authorName}: "${p.content}"`).join('\n');
  }

  revokePost(postId: string): void {
    const post = this.board.find(p => p.id === postId);
    if (post) post.revoked = true;
  }

  getSnapshot(): WorldSnapshot {
    return {
      time: { ...this.time },
      agents: Array.from(this.agents.values()),
      conversations: Array.from(this.conversations.values()).filter(c => !c.endedAt),
      areas: AREAS,
      board: this.getActiveBoard(),
    };
  }

  addConversation(conv: Conversation): void {
    this.conversations.set(conv.id, conv);
  }

  getConversation(id: string): Conversation | undefined {
    return this.conversations.get(id);
  }

  endConversation(id: string): void {
    const conv = this.conversations.get(id);
    if (conv) {
      conv.endedAt = Date.now();
    }
  }

  getActiveConversations(): Conversation[] {
    const active: Conversation[] = [];
    for (const conv of this.conversations.values()) {
      if (!conv.endedAt) {
        active.push(conv);
      }
    }
    return active;
  }
}
