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
  NarrativeEntry,
  Storyline,
  Recap,
  SocialLedgerEntry,
  VillageMemoryEntry,
} from '@ai-village/shared';

export interface ActionLogEntry {
  action: string;
  emoji?: string;
  time: number;
}

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
  narratives: NarrativeEntry[];
  storylines: Storyline[];
  characterPageAgentId: string | null;
  activeRecap: Recap | null;
  weeklySummary: string | null;
  villageMemory: VillageMemoryEntry[];
  actionLog: Map<string, ActionLogEntry[]>;
  socialViewOpen: boolean;
  activeMode: 'watch' | 'inspect' | 'analyze';
  inspectTarget: InspectTarget | null;
}

export interface InspectTarget {
  type: 'agent' | 'relationship' | 'event' | 'location' | 'institution';
  id: string;
  secondaryId?: string;
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
    narratives: [],
    storylines: [],
    characterPageAgentId: null,
    activeRecap: null,
    weeklySummary: null,
    villageMemory: [],
    actionLog: new Map(),
    socialViewOpen: false,
    activeMode: 'watch',
    inspectTarget: null,
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

  updateAgentAction(agentId: string, action: string, emoji?: string): void {
    const agent = this.state.agents.get(agentId);
    if (!agent) return;
    const newAgents = new Map(this.state.agents);
    newAgents.set(agentId, { ...agent, currentAction: action });

    // Push to action log (cap 5, skip consecutive duplicates)
    const newLog = new Map(this.state.actionLog);
    const existing = newLog.get(agentId) || [];
    const last = existing[0];
    if (!last || last.action !== action) {
      const entry: ActionLogEntry = { action, emoji, time: Date.now() };
      newLog.set(agentId, [entry, ...existing].slice(0, 5));
    }

    this.state = { ...this.state, agents: newAgents, actionLog: newLog };
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

  updateBoardPost(post: BoardPost): void {
    this.state = {
      ...this.state,
      board: this.state.board.map(p => p.id === post.id ? post : p),
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

  updateAgentWorldView(agentId: string, worldView: string): void {
    const agent = this.state.agents.get(agentId);
    if (!agent) return;
    const newAgents = new Map(this.state.agents);
    newAgents.set(agentId, { ...agent, worldView });
    this.state = { ...this.state, agents: newAgents };
    this.notify();
  }

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

  clearThoughts(): void {
    this.state = { ...this.state, thoughts: [] };
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
    newAgents.set(agentId, { ...agent, alive: false, causeOfDeath: cause, state: 'dead' });
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

  // --- Narratives ---

  setNarratives(narratives: NarrativeEntry[]): void {
    this.state = { ...this.state, narratives };
    this.notify();
  }

  addNarrative(narrative: NarrativeEntry): void {
    this.state = {
      ...this.state,
      narratives: [...this.state.narratives.slice(-19), narrative],
    };
    this.notify();
  }

  // --- Storylines ---

  setStorylines(storylines: Storyline[]): void {
    this.state = { ...this.state, storylines };
    this.notify();
  }

  updateStoryline(storyline: Storyline): void {
    const existing = this.state.storylines.findIndex(s => s.id === storyline.id);
    if (existing >= 0) {
      const newStorylines = [...this.state.storylines];
      newStorylines[existing] = storyline;
      this.state = { ...this.state, storylines: newStorylines };
    } else {
      this.state = { ...this.state, storylines: [...this.state.storylines, storyline] };
    }
    this.notify();
  }

  // --- Character Page ---

  openCharacterPage(agentId: string): void {
    this.state = { ...this.state, characterPageAgentId: agentId };
    this.notify();
  }

  closeCharacterPage(): void {
    this.state = { ...this.state, characterPageAgentId: null };
    this.notify();
  }

  // --- Recap ---

  setActiveRecap(recap: Recap | null): void {
    this.state = { ...this.state, activeRecap: recap };
    this.notify();
  }

  setWeeklySummary(summary: string | null): void {
    this.state = { ...this.state, weeklySummary: summary };
    this.notify();
  }

  // --- Ledger ---

  updateAgentLedger(agentId: string, entry: SocialLedgerEntry): void {
    const agent = this.state.agents.get(agentId);
    if (!agent) return;
    const ledger = agent.socialLedger ? [...agent.socialLedger] : [];
    // Update existing entry or append
    const existingIdx = ledger.findIndex(e => e.id === entry.id);
    if (existingIdx >= 0) {
      ledger[existingIdx] = entry;
    } else {
      ledger.push(entry);
    }
    const newAgents = new Map(this.state.agents);
    newAgents.set(agentId, { ...agent, socialLedger: ledger });
    this.state = { ...this.state, agents: newAgents };
    this.notify();
  }

  // --- Social View ---

  openSocialView(): void {
    this.state = { ...this.state, socialViewOpen: true };
    this.notify();
  }

  closeSocialView(): void {
    this.state = { ...this.state, socialViewOpen: false };
    this.notify();
  }

  // --- View Mode ---

  setMode(mode: 'watch' | 'inspect' | 'analyze'): void {
    this.state = { ...this.state, activeMode: mode };
    this.notify();
  }

  inspectAgent(agentId: string): void {
    this.state = {
      ...this.state,
      activeMode: 'inspect',
      inspectTarget: { type: 'agent', id: agentId },
    };
    this.notify();
  }

  inspect(target: InspectTarget): void {
    this.state = { ...this.state, activeMode: 'inspect', inspectTarget: target };
    this.notify();
  }

  inspectRelationship(agentId: string, secondaryId: string): void {
    this.state = { ...this.state, activeMode: 'inspect', inspectTarget: { type: 'relationship', id: agentId, secondaryId } };
    this.notify();
  }

  inspectInstitution(institutionId: string): void {
    this.state = { ...this.state, activeMode: 'inspect', inspectTarget: { type: 'institution', id: institutionId } };
    this.notify();
  }

  inspectLocation(locationId: string): void {
    this.state = { ...this.state, activeMode: 'inspect', inspectTarget: { type: 'location', id: locationId } };
    this.notify();
  }

  backToWatch(): void {
    this.state = { ...this.state, activeMode: 'watch', inspectTarget: null };
    this.notify();
  }

  setVillageMemory(villageMemory: VillageMemoryEntry[]): void {
    this.state = { ...this.state, villageMemory };
    this.notify();
  }
}

export const gameStore = new GameStore();

// Expose for console debugging
(window as any).gameStore = gameStore;
