import type {
  Agent,
  BoardPost,
  GameTime,
  WorldEvent,
  Election,
  Property,
  ReputationEntry,
  Item,
  Skill,
} from '@ai-village/shared';

interface GameState {
  agents: Map<string, Agent>;
  selectedAgentId: string | null;
  time: GameTime;
  chatLog: ChatEntry[];
  connected: boolean;
  activeConversations: Map<string, string[]>; // conversationId → [agentId1, agentId2]
  board: BoardPost[];
  events: WorldEvent[];
  elections: Election[];
  properties: Property[];
  reputation: ReputationEntry[];
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
    events: [],
    elections: [],
    properties: [],
    reputation: [],
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

  // --- World Events ---

  setEvents(events: WorldEvent[]): void {
    this.state = { ...this.state, events };
    this.notify();
  }

  addWorldEvent(event: WorldEvent): void {
    this.state = {
      ...this.state,
      events: [...this.state.events, event],
    };
    this.notify();
  }

  // --- Elections ---

  setElections(elections: Election[]): void {
    this.state = { ...this.state, elections };
    this.notify();
  }

  updateElection(election: Election): void {
    const existing = this.state.elections.findIndex((e) => e.id === election.id);
    if (existing >= 0) {
      const newElections = [...this.state.elections];
      newElections[existing] = election;
      this.state = { ...this.state, elections: newElections };
    } else {
      this.state = {
        ...this.state,
        elections: [...this.state.elections, election],
      };
    }
    this.notify();
  }

  // --- Properties ---

  setProperties(properties: Property[]): void {
    this.state = { ...this.state, properties };
    this.notify();
  }

  updateProperty(property: Property): void {
    const existing = this.state.properties.findIndex(
      (p) => p.areaId === property.areaId
    );
    if (existing >= 0) {
      const newProperties = [...this.state.properties];
      newProperties[existing] = property;
      this.state = { ...this.state, properties: newProperties };
    } else {
      this.state = {
        ...this.state,
        properties: [...this.state.properties, property],
      };
    }
    this.notify();
  }

  // --- Reputation ---

  setReputation(reputation: ReputationEntry[]): void {
    this.state = { ...this.state, reputation };
    this.notify();
  }

  updateReputation(fromId: string, toId: string, score: number): void {
    const existing = this.state.reputation.findIndex(
      (r) => r.fromAgentId === fromId && r.toAgentId === toId
    );
    if (existing >= 0) {
      const newReputation = [...this.state.reputation];
      newReputation[existing] = {
        ...newReputation[existing],
        score,
        lastUpdated: Date.now(),
      };
      this.state = { ...this.state, reputation: newReputation };
    } else {
      this.state = {
        ...this.state,
        reputation: [
          ...this.state.reputation,
          {
            fromAgentId: fromId,
            toAgentId: toId,
            score,
            reason: '',
            lastUpdated: Date.now(),
          },
        ],
      };
    }
    this.notify();
  }

  // --- Agent sub-field updates ---

  updateAgentMood(agentId: string, mood: string): void {
    const agent = this.state.agents.get(agentId);
    if (!agent) return;
    const newAgents = new Map(this.state.agents);
    newAgents.set(agentId, { ...agent, mood: mood as Agent['mood'] });
    this.state = { ...this.state, agents: newAgents };
    this.notify();
  }

  updateAgentInventory(agentId: string, inventory: Item[]): void {
    const agent = this.state.agents.get(agentId);
    if (!agent) return;
    const newAgents = new Map(this.state.agents);
    newAgents.set(agentId, { ...agent, inventory });
    this.state = { ...this.state, agents: newAgents };
    this.notify();
  }

  updateAgentSkill(agentId: string, skill: Skill): void {
    const agent = this.state.agents.get(agentId);
    if (!agent) return;
    const existingIdx = agent.skills.findIndex((s: Skill) => s.name === skill.name);
    let newSkills: Skill[];
    if (existingIdx >= 0) {
      newSkills = [...agent.skills];
      newSkills[existingIdx] = skill;
    } else {
      newSkills = [...agent.skills, skill];
    }
    const newAgents = new Map(this.state.agents);
    newAgents.set(agentId, { ...agent, skills: newSkills });
    this.state = { ...this.state, agents: newAgents };
    this.notify();
  }
}

export const gameStore = new GameStore();
