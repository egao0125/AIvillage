import type { Agent, BoardPost, GameTime } from '@ai-village/shared';

interface GameState {
  agents: Map<string, Agent>;
  selectedAgentId: string | null;
  time: GameTime;
  chatLog: ChatEntry[];
  connected: boolean;
  activeConversations: Map<string, string[]>; // conversationId → [agentId1, agentId2]
  board: BoardPost[];
}

export interface ChatEntry {
  id: string;
  agentId: string;
  agentName: string;
  message: string;
  timestamp: number;
  conversationId: string;
}

class GameStore {
  private state: GameState = {
    agents: new Map(),
    selectedAgentId: null,
    time: { day: 1, hour: 5, minute: 0, totalMinutes: 300 },
    chatLog: [],
    connected: false,
    activeConversations: new Map(),
    board: [],
  };
  private subscribers: Set<() => void> = new Set();

  getState(): GameState {
    return this.state;
  }

  subscribe(callback: () => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private notify(): void {
    this.subscribers.forEach((cb) => cb());
  }

  setAgents(agents: Agent[]): void {
    this.state = {
      ...this.state,
      agents: new Map(agents.map((a) => [a.id, a])),
    };
    this.notify();
  }

  updateAgent(agent: Agent): void {
    const newAgents = new Map(this.state.agents);
    newAgents.set(agent.id, agent);
    this.state = { ...this.state, agents: newAgents };
    this.notify();
  }

  moveAgent(agentId: string, position: { x: number; y: number }): void {
    const agent = this.state.agents.get(agentId);
    if (!agent) return;
    const newAgents = new Map(this.state.agents);
    newAgents.set(agentId, { ...agent, position });
    this.state = { ...this.state, agents: newAgents };
    this.notify();
  }

  updateAgentAction(agentId: string, action: string): void {
    const agent = this.state.agents.get(agentId);
    if (!agent) return;
    const newAgents = new Map(this.state.agents);
    newAgents.set(agentId, { ...agent, currentAction: action });
    this.state = { ...this.state, agents: newAgents };
    this.notify();
  }

  selectAgent(agentId: string | null): void {
    this.state = { ...this.state, selectedAgentId: agentId };
    this.notify();
  }

  setTime(time: GameTime): void {
    this.state = { ...this.state, time };
    this.notify();
  }

  addChatEntry(entry: ChatEntry): void {
    this.state = {
      ...this.state,
      chatLog: [...this.state.chatLog.slice(-200), entry],
    };
    this.notify();
  }

  updateAgentCurrency(agentId: string, currency: number): void {
    const agent = this.state.agents.get(agentId);
    if (!agent) return;
    const newAgents = new Map(this.state.agents);
    newAgents.set(agentId, { ...agent, currency });
    this.state = { ...this.state, agents: newAgents };
    this.notify();
  }

  setConnected(connected: boolean): void {
    this.state = { ...this.state, connected };
    this.notify();
  }

  addConversation(conversationId: string, participants: string[]): void {
    const newConvos = new Map(this.state.activeConversations);
    newConvos.set(conversationId, participants);
    this.state = { ...this.state, activeConversations: newConvos };
    this.notify();
  }

  removeConversation(conversationId: string): void {
    const newConvos = new Map(this.state.activeConversations);
    newConvos.delete(conversationId);
    this.state = { ...this.state, activeConversations: newConvos };
    this.notify();
  }

  setBoard(board: BoardPost[]): void {
    this.state = { ...this.state, board };
    this.notify();
  }

  addBoardPost(post: BoardPost): void {
    this.state = {
      ...this.state,
      board: [...this.state.board, post],
    };
    this.notify();
  }
}

export const gameStore = new GameStore();
