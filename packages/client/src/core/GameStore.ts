import type {
  Agent,
  BoardPost,
  GameTime,
  Election,
  Property,
  ReputationEntry,
  Item,
  Skill,
  DriveState,
  VitalState,
  Weather,
  Institution,
  Artifact,
  Building,
  Technology,
} from '@ai-village/shared';

interface GameState {
  agents: Map<string, Agent>;
  selectedAgentId: string | null;
  time: GameTime;
  chatLog: ChatEntry[];
  connected: boolean;
  activeConversations: Map<string, string[]>; // conversationId → [agentId1, agentId2]
  board: BoardPost[];
  elections: Election[];
  properties: Property[];
  reputation: ReputationEntry[];
  thoughts: ThoughtEntry[];
  weather: Weather;
  institutions: Institution[];
  artifacts: Artifact[];
  buildings: Building[];
  technologies: Technology[];
}

export interface ChatEntry {
  id: string;
  agentId: string;
  agentName: string;
  message: string;
  timestamp: number;
  conversationId: string;
}

export interface ThoughtEntry {
  id: string;
  agentId: string;
  agentName: string;
  thought: string;
  timestamp: number;
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
    elections: [],
    properties: [],
    reputation: [],
    thoughts: [],
    weather: { current: 'clear', season: 'spring', temperature: 50, seasonDay: 0 },
    institutions: [],
    artifacts: [],
    buildings: [],
    technologies: [],
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

  // --- Thoughts ---

  addThought(entry: ThoughtEntry): void {
    this.state = {
      ...this.state,
      thoughts: [...this.state.thoughts.slice(-100), entry],
    };
    this.notify();
  }

  // --- Agent drives ---

  updateAgentDrives(agentId: string, drives: DriveState): void {
    const agent = this.state.agents.get(agentId);
    if (!agent) return;
    const newAgents = new Map(this.state.agents);
    newAgents.set(agentId, { ...agent, drives });
    this.state = { ...this.state, agents: newAgents };
    this.notify();
  }

  // --- Agent vitals ---

  updateAgentVitals(agentId: string, vitals: VitalState): void {
    const agent = this.state.agents.get(agentId);
    if (!agent) return;
    const newAgents = new Map(this.state.agents);
    newAgents.set(agentId, { ...agent, vitals });
    this.state = { ...this.state, agents: newAgents };
    this.notify();
  }

  // --- Agent death ---

  markAgentDead(agentId: string, cause: string): void {
    const agent = this.state.agents.get(agentId);
    if (!agent) return;
    const newAgents = new Map(this.state.agents);
    newAgents.set(agentId, { ...agent, alive: false, causeOfDeath: cause, state: 'dead' as any });
    this.state = { ...this.state, agents: newAgents };
    this.notify();
  }

  // --- Agent leave ---

  removeAgent(agentId: string): void {
    const newAgents = new Map(this.state.agents);
    newAgents.delete(agentId);
    this.state = { ...this.state, agents: newAgents };
    if (this.state.selectedAgentId === agentId) {
      this.state = { ...this.state, selectedAgentId: null };
    }
    this.notify();
  }

  // --- Weather ---

  setWeather(weather: Weather): void {
    this.state = { ...this.state, weather };
    this.notify();
  }

  // --- Institutions ---

  setInstitutions(institutions: Institution[]): void {
    this.state = { ...this.state, institutions };
    this.notify();
  }

  updateInstitution(institution: Institution): void {
    const existing = this.state.institutions.findIndex(i => i.id === institution.id);
    if (existing >= 0) {
      const newInst = [...this.state.institutions];
      newInst[existing] = institution;
      this.state = { ...this.state, institutions: newInst };
    } else {
      this.state = { ...this.state, institutions: [...this.state.institutions, institution] };
    }
    this.notify();
  }

  // --- Artifacts ---

  setArtifacts(artifacts: Artifact[]): void {
    this.state = { ...this.state, artifacts };
    this.notify();
  }

  addArtifact(artifact: Artifact): void {
    this.state = {
      ...this.state,
      artifacts: [...this.state.artifacts.slice(-200), artifact],
    };
    this.notify();
  }

  // --- Buildings ---

  setBuildings(buildings: Building[]): void {
    this.state = { ...this.state, buildings };
    this.notify();
  }

  updateBuilding(building: Building): void {
    const existing = this.state.buildings.findIndex(b => b.id === building.id);
    if (existing >= 0) {
      const newBuildings = [...this.state.buildings];
      newBuildings[existing] = building;
      this.state = { ...this.state, buildings: newBuildings };
    } else {
      this.state = { ...this.state, buildings: [...this.state.buildings, building] };
    }
    this.notify();
  }

  // --- Technologies ---

  setTechnologies(technologies: Technology[]): void {
    this.state = { ...this.state, technologies };
    this.notify();
  }

  addTechnology(technology: Technology): void {
    this.state = {
      ...this.state,
      technologies: [...this.state.technologies, technology],
    };
    this.notify();
  }
}

export const gameStore = new GameStore();
