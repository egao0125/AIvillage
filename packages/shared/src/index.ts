// ============================================================================
// AI Village — Shared Types
// Every type here enables a new dimension of CONSEQUENCE.
// ============================================================================

// --- Infra 1: Event Bus ---
export { EventBus } from './event-bus.js';
export type { SimEvent } from './events.js';

// --- Agent ---

export interface AgentPersonality {
  openness: number;       // 0-1: conventional ←→ creative
  conscientiousness: number; // 0-1: spontaneous ←→ organized
  extraversion: number;   // 0-1: reserved ←→ outgoing
  agreeableness: number;  // 0-1: competitive ←→ cooperative
  neuroticism: number;    // 0-1: calm ←→ anxious
}

export interface AgentConfig {
  name: string;
  age: number;
  occupation?: string;
  personality: AgentPersonality;
  soul: string;        // Free-form personality description — the raw inner voice
  backstory: string;   // Where they come from, what shaped them
  goal: string;        // What they want — drives all planning
  spriteId: string;

  // --- Phase 2: Deep Identity ---
  // These create consequence: fears make agents avoid, desires make them risk,
  // contradictions make them unpredictable, secrets make them vulnerable.
  fears?: string[];
  desires?: string[];
  contradictions?: string;    // "Claims to value honesty but lies to protect herself"
  secretShames?: string;      // Something they'd do anything to keep hidden
  speechPattern?: string;     // "Short choppy sentences" or "formal, never uses contractions"
  humorStyle?: string;        // "Dry sarcasm" or "nervous laughter" or "never jokes"
  coreValues?: string[];      // What they'd die for
  startingRelationships?: Record<string, string>; // agentName -> "my rival", "secretly in love"
}

export interface Agent {
  id: string;
  config: AgentConfig;
  position: Position;
  state: AgentState;
  currentAction: string;
  currency: number;
  createdAt: number;
  joinedDay?: number;   // game day when agent was added
  ownerId: string;
  mood: Mood;
  inventory: Item[];
  skills: Skill[];

  // --- Phase 3: Drives + Vitals ---
  // Consequence: agents can DIE. They have needs that compete.
  // A starving agent might steal. A lonely agent tolerates abuse.
  drives?: DriveState;
  vitals?: VitalState;
  alive?: boolean;           // defaults true; false = permanent death
  causeOfDeath?: string;

  // --- Social Ledger ---
  // Consequence: subjective agreements, promises, obligations. Each agent's own version.
  socialLedger?: SocialLedgerEntry[];

  // --- Phase 4: Theory of Mind ---
  // Consequence: agents model each other. Deception, paranoia, strategic alliances.
  mentalModels?: MentalModel[];

  // --- Phase 5: Institutions ---
  // Consequence: collective identity. Betray your guild? Lose everything.
  institutionIds?: string[];

  // --- WorldView ---
  worldView?: string;

  // --- Phase 5b: Family ---
  familyId?: string;
  partnerId?: string;
  parentIds?: string[];
  childIds?: string[];

  // --- Four Stream Memory ---
  dossiers?: RelationshipDossier[];
  activeConcerns?: ActiveConcern[];
}

export type AgentState =
  | "active"    // Talking, deciding, reacting — full LLM
  | "routine"   // Commuting, eating, cleaning — rule-based
  | "idle"      // Off-screen, low-frequency thinking
  | "sleeping"  // Nighttime, no LLM calls
  | "dead"      // Permanent. Possessions become unclaimed.
  | "away";     // Dormant — agent left village, no LLM calls, can return

// --- Mood ---

export type Mood = string;

// --- Phase 3: Drives ---
// NOT a Maslow ladder. Dysfunctional patterns create the best drama.
// A status-obsessed agent ignores hunger. A meaning-seeker sacrifices safety.

export interface DriveState {
  survival: number;    // 0-100: food, shelter, health
  safety: number;      // 0-100: physical security, predictability
  belonging: number;   // 0-100: love, friendship, community
  status: number;      // 0-100: respect, influence, recognition
  meaning: number;     // 0-100: purpose, legacy, creation
}

// --- Phase 3: Vitals ---
// Consequence: these tick down. At zero, you die.

export interface VitalState {
  health: number;      // 0-100: damage, disease, injury. 0 = death
  hunger: number;      // 0-100: 100 = starving. >80 drains health
  energy: number;      // 0-100: 0 = collapse. Restored by sleep/food
}

// --- Social Ledger ---
// Consequence: subjective social reality. Each agent tracks their own version of agreements.
// No global truth — disagreements become grounds for conversation and social friction.

export type SocialPrimitiveType = 'trade' | 'promise' | 'meeting' | 'task' | 'rule' | 'alliance';
export type SocialEntryStatus = 'proposed' | 'accepted' | 'rejected' | 'expired' | 'fulfilled' | 'broken';

export interface SocialLedgerEntry {
  id: string;
  type: SocialPrimitiveType;
  status: SocialEntryStatus;
  proposerId: string;
  targetIds: string[];
  description: string;          // this agent's perspective
  agreedBy: string[];
  rejectedBy: string[];
  createdAt: number;            // game totalMinutes
  resolvedAt?: number;
  expiresAt?: number;           // game totalMinutes
  day: number;                  // game day created
  sourceConversationId?: string;
  source?: 'direct' | 'secondhand';
}

// --- Phase 4: Mental Models ---
// Consequence: agents predict each other. Wrong predictions → betrayal, paranoia.
// High neuroticism reads threat into neutral actions.

export interface MentalModel {
  targetId: string;
  trust: number;           // -100 to 100
  predictedGoal: string;   // "I think they want to become village elder"
  emotionalStance: string; // "wary", "admiring", "resentful", "indifferent"
  notes: string[];         // Running log: "Lied to me on day 3", "Shared food when I was starving"
  lastUpdated: number;
}

// --- Four Stream Memory Types ---

/** Per-person synthesized relationship profile */
export interface RelationshipDossier {
  agentId: string;        // who owns this dossier
  targetId: string;       // who it's about
  targetName: string;
  summary: string;        // 3-5 sentences: who they are to me, history, trust
  trust: number;          // -100 to 100
  activeCommitments: string[];
  lastInteraction: number;
  lastUpdated: number;
}

/** Something on the agent's mind right now */
export interface ActiveConcern {
  id: string;
  content: string;        // "I promised Wren 2 wheat by tomorrow"
  category: 'commitment' | 'need' | 'threat' | 'unresolved' | 'goal' | 'rule';
  relatedAgentIds: string[];
  createdAt: number;
  expiresAt?: number;
  resolved?: boolean;
  permanent?: boolean;    // rules and commitments don't expire
}

// --- Items & Materials ---

export type ItemType = 'tool' | 'food' | 'material' | 'art' | 'medicine' | 'document' | 'gift' | 'other';

export interface Item {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  createdBy?: string;
  value: number;
  type: ItemType;
  createdAt?: number;   // world time (totalMinutes) when created
}

export interface MaterialSpawn {
  areaId: string;
  material: string;
  respawnMinutes: number;
  lastGathered?: number;
}

// --- Secrets ---

export interface Secret {
  id: string;
  holderId: string;
  aboutAgentId?: string;
  content: string;
  importance: number;
  sharedWith: string[];
  createdAt: number;
}

// --- Skills ---

export interface Skill {
  name: string;
  level: number;
  xp: number;           // accumulated XP within current level
  learnedFrom?: string;
}

// --- World Events (REMOVED — broken system, never properly expired) ---

// --- Elections ---

export interface Election {
  id: string;
  position: string;
  candidates: string[];
  votes: Record<string, string>;
  startDay: number;
  endDay: number;
  winner?: string;
  active: boolean;
}

// --- Property ---

export interface Property {
  areaId: string;
  ownerId: string;
  acquiredDay: number;
  rentPrice?: number;
}

// --- Reputation ---

export interface ReputationEntry {
  fromAgentId: string;
  toAgentId: string;
  score: number;
  reason: string;
  lastUpdated: number;
}

// --- World ---

export interface Position {
  x: number;
  y: number;
}

export interface MapArea {
  id: string;
  name: string;
  type: "house" | "cafe" | "park" | "shop" | "plaza" | "forest" | "lake";
  bounds: { x: number; y: number; width: number; height: number };
  objects: MapObject[];
}

export interface MapObject {
  id: string;
  name: string;
  position: Position;
  status: string; // e.g. "occupied", "empty", "burning"
}

// --- Memory ---

export interface Memory {
  id: string;
  agentId: string;
  type: "observation" | "conversation" | "reflection" | "plan" | "emotion" | "thought" | "action_outcome";
  content: string;
  importance: number; // 1-10
  timestamp: number;
  relatedAgentIds: string[];
  embedding?: number[];

  // --- Phase 4: Memory Enhancements ---
  // Consequence: some memories are private, some public. Emotional weight affects recall.
  visibility?: 'private' | 'shared' | 'public';
  emotionalValence?: number; // -1 (painful) to +1 (joyful). High-valence = recalled more.
  isCore?: boolean; // Core identity memories — never pruned, boosted in retrieval
  actionSuccess?: boolean; // for action_outcome memories
  sourceAgentId?: string;   // who told them (undefined = firsthand)
  hearsayDepth?: number;    // 0 = direct, 1 = secondhand

  // --- Freedom 4: Narrative Memory ---
  // Causal linking: enables agents to reason about chains of cause and effect.
  causedBy?: string;        // memory ID that caused this memory
  ledTo?: string[];         // memory IDs that this memory led to
}

// --- Conversation ---

export interface ConversationMessage {
  agentId: string;
  agentName: string;
  content: string;
  timestamp: number;
}

export interface Conversation {
  id: string;
  participants: string[];
  messages: ConversationMessage[];
  location: Position;
  startedAt: number;
  endedAt?: number;
}

// --- Phase 5: Institutions ---
// Consequence: collective power, collective vulnerability.
// A guild with treasury can be robbed. A religion shapes beliefs. A secret society conspires.
// No hardcoded categories — agents define what their institution IS.

export interface Institution {
  id: string;
  name: string;
  type: string;          // "guild", "religion", "government", "secret society" — agent-defined
  description: string;
  founderId: string;
  members: InstitutionMember[];
  treasury: number;
  rules: string[];       // Agent-written rules that members should follow
  createdAt: number;
  dissolved?: boolean;
}

export interface InstitutionMember {
  agentId: string;
  role: string;          // "founder", "elder", "member", "initiate" — agent-defined
  joinedAt: number;
}

// --- Phase 5b: Families ---
// Consequence: something to protect. Children inherit blended traits.
// Protective instincts: belonging drive spikes when family threatened.

export interface Family {
  id: string;
  name: string;
  partnerIds: string[];   // The couple
  childIds: string[];
  createdAt: number;
}

// --- Phase 6: Agent-Created Media ---
// Consequence: shapes beliefs, creates propaganda, drives political conflict.
// A newspaper article can turn the village against someone.
// A love letter, if intercepted, destroys a reputation.

export type ArtifactType = 'poem' | 'newspaper' | 'letter' | 'propaganda' | 'diary' | 'painting' | 'law' | 'manifesto' | 'map' | 'recipe';

export interface Artifact {
  id: string;
  title: string;
  content: string;
  type: ArtifactType;
  creatorId: string;
  creatorName: string;
  location?: string;      // area where it was placed/published
  visibility: 'private' | 'public' | 'addressed'; // addressed = letter to specific agent
  addressedTo?: string[];  // agent IDs for letters
  reactions: ArtifactReaction[];
  createdAt: number;
  day: number;
}

export interface ArtifactReaction {
  agentId: string;
  agentName: string;
  reaction: string;  // "agrees", "outraged", "inspired", "amused", "threatened"
  comment?: string;
  timestamp: number;
}

// --- Phase 7: Weather & Seasons ---
// Consequence: environmental pressure. Storms damage buildings. Drought kills crops.
// Winter without shelter = death. Seasons force planning ahead.

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

export interface Weather {
  current: string;       // "clear", "rain", "storm", "snow", "fog", "heatwave"
  season: Season;
  temperature: number;   // Abstract 0-100 (0=freezing, 100=scorching)
  seasonDay: number;     // Day within current season (0-29)
}

// --- World Objects (Freedom 1: open-ended actions) ---
// Consequence: agents can create arbitrary things that persist and are perceivable.
// A memorial, a warning sign, a garden, art — anything the agent imagines.

export interface WorldObject {
  id: string;
  name: string;
  description: string;
  creatorId: string;
  creatorName: string;
  areaId: string;
  position: Position;
  createdAt: number;        // game totalMinutes
  lastInteractedAt: number; // game totalMinutes — decays if not interacted with
}

// --- Phase 7: Buildings ---
// Consequence: something to build, own, lose, defend.
// A house gives shelter (vital for winter). A shop generates income.
// Buildings can be damaged by weather/fire, requiring repair.

export interface Building {
  id: string;
  name: string;
  type: string;          // "house", "shop", "workshop", "shrine" — agent-defined
  description: string;
  ownerId: string;
  areaId: string;
  durability: number;    // 0-100. 0 = collapsed
  maxDurability: number;
  effects: string[];     // "shelter", "crafting_bonus", "healing", "storage"
  builtBy: string;
  builtAt: number;
  materials: string[];   // What was used to build it
  defId?: string;        // maps to BUILDINGS[defId] for effect lookup
}

// --- Phase 7: Technology ---
// Consequence: permanent world change. An invention can't be un-invented.
// Better tools, new crafting recipes, agricultural improvements.

export interface Technology {
  id: string;
  name: string;
  description: string;
  inventorId: string;
  inventorName: string;
  effects: string[];     // "doubles farm output", "enables iron tools"
  requirements: string[]; // Skills/materials needed
  discoveredAt: number;
  day: number;
}

// --- Narrative (Reality TV Layer) ---

export interface NarrativeEntry {
  id: string;
  content: string;
  gameDay: number;
  gameHour: number;
  referencedAgentIds: string[];
  referencedAgentNames: string[];
  timestamp: number;
}

// --- Character Timeline ---

export interface CharacterTimelineEvent {
  id: string;
  agentId: string;
  type: 'conversation' | 'mood_change' | 'action' | 'board_post' | 'artifact' | 'death';
  description: string;
  relatedAgentIds: string[];
  timestamp: number;
  day: number;
}

// --- Storylines ---

export type StorylineStatus = 'developing' | 'climax' | 'resolved' | 'dormant';
export type StorylineTheme = 'conflict' | 'romance' | 'power' | 'alliance' | 'mystery' | 'survival';

export interface StorylineEvent {
  id: string;
  description: string;
  agentIds: string[];
  timestamp: number;
  day: number;
}

export interface Storyline {
  id: string;
  title: string;
  theme: StorylineTheme;
  involvedAgentIds: string[];
  status: StorylineStatus;
  events: StorylineEvent[];
  summary: string;
  createdAt: number;
  lastUpdatedAt: number;
  day: number;
}

// --- Recaps ---

export interface Recap {
  fromDay: number;
  toDay: number;
  segments: { title: string; description: string; involvedAgentIds: string[] }[];
  narrative: string;
}

// --- Events (WebSocket) ---

export type ServerEvent =
  | { type: "agent:move"; agentId: string; position: Position }
  | { type: "agent:speak"; agentId: string; message: string; conversationId: string }
  | { type: "agent:action"; agentId: string; action: string }
  | { type: "agent:spawn"; agent: Agent }
  | { type: "agent:leave"; agentId: string }
  | { type: "agent:thought"; agentId: string; thought: string }
  | { type: "agent:death"; agentId: string; cause: string }
  | { type: "agent:drives"; agentId: string; drives: DriveState }
  | { type: "agent:vitals"; agentId: string; vitals: VitalState }
  | { type: "world:time"; hour: number; minute: number; weather: string }
  | { type: "world:weather"; weather: Weather }
  | { type: "institution:update"; institution: Institution }
  | { type: "artifact:created"; artifact: Artifact }
  | { type: "building:update"; building: Building }
  | { type: "technology:discovered"; technology: Technology }
  | { type: "world_object:created"; worldObject: WorldObject }
  | { type: "world_object:modified"; worldObject: WorldObject };

export type ClientEvent =
  | { type: "viewport:update"; bounds: { x: number; y: number; width: number; height: number } }
  | { type: "agent:select"; agentId: string }
  | { type: "tip:send"; agentId: string; item: string; message?: string };

// --- Game Time & Planning ---

export interface GameTime {
  day: number;
  hour: number;
  minute: number;
  totalMinutes: number;
}

export interface DayPlanItem {
  time: number;
  duration: number;
  activity: string;
  location: string;
  emoji?: string;
}

export interface DayPlan {
  agentId: string;
  day: number;
  items: DayPlanItem[];
}

// --- Think Output (v2 cognition) ---

export interface ThinkOutput {
  thought: string;
  mood?: Mood;          // parsed MOOD: <word>
}

// --- Village Board ---

export type BoardPostType = 'decree' | 'rule' | 'announcement' | 'rumor' | 'threat' | 'alliance' | 'bounty' | 'trade' | 'news';

export interface BoardPost {
  id: string;
  authorId: string;
  authorName: string;
  type: BoardPostType;
  channel?: 'all' | 'group';
  groupId?: string;
  content: string;
  timestamp: number;
  day: number;
  targetIds?: string[];   // agents this post is about
  revoked?: boolean;      // if a rule/decree was revoked
  votes?: { agentId: string; vote: 'like' | 'dislike' }[];
  ruleStatus?: 'proposed' | 'passed' | 'rejected' | 'repealed';
  claimTarget?: { type: 'area' | 'building'; id: string };  // if this is a property claim vote
  comments?: { agentId: string; agentName: string; content: string; timestamp: number }[];
}

export interface WorldSnapshot {
  time: GameTime;
  agents: Agent[];
  conversations: Conversation[];
  areas: MapArea[];
  board: BoardPost[];
  elections: Election[];
  properties: Property[];
  reputation: ReputationEntry[];
  weather: Weather;
  institutions: Institution[];
  artifacts: Artifact[];
  buildings: Building[];
  technologies: Technology[];
  worldObjects: WorldObject[];
  narratives?: NarrativeEntry[];
  storylines?: Storyline[];
  weeklySummary?: string | null;
}
