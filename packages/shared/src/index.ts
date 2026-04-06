// ============================================================================
// AI Village — Shared Types
// Every type here enables a new dimension of CONSEQUENCE.
// ============================================================================

// --- Infra 1: Event Bus ---
export { EventBus } from './event-bus.js';
export type { SimEvent } from './events.js';

// --- Map Config ---
export type { MapConfig, MapAction } from './map-config.js';

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

  // --- Constitutional Rules ---
  // Personality as inviolable constraints — stronger than soul/backstory because LLMs
  // follow explicit instructions more reliably than character descriptions.
  constitutionalRules?: string[];
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
  mapId: string;       // which map this agent belongs to ('village', 'battle_royale')
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
  beliefs?: { content: string; timestamp: number; validFrom?: number; validUntil?: number }[];
  learnedStrategies?: LearnedStrategy[];
  // Total action_outcome count for UCB exploration (gap-analysis item 1.1).
  totalActionOutcomes?: number;
  // Running EMA of reasoning-step quality (gap-analysis item 1.3).
  reasoningScore?: ProcessRubric;
  // Procedural memory: learned behavioral biases from experience (gap-analysis item 1.2).
  learnedAversions?: LearnedAversion[];
  // How much this agent weighs village norm deviation in decisions (gap-analysis item 1.2).
  // 0 = stoic loner ignores norms; 1 = social climber conforms hard. Default 0.5.
  normWeight?: number;

  // --- Reward System ---
  // Per-agent scalarization weights — turn same reward vector into different personalities.
  // Farmer weights resources+goalProgress; politician weights social; survivor weights hp.
  rewardWeights?: RewardVector;

  // --- Strategy Tracking ---
  strategyHistory?: StrategySnapshot[];

  // --- Commitment System ---
  commitments?: Commitment[];
  archivedCommitments?: Commitment[];

  // --- Werewolf Game Mode ---
  werewolfRole?: 'werewolf' | 'sheriff' | 'healer' | 'villager';
  fellowWolves?: string[];
  investigations?: { targetId: string; targetName: string; result: 'werewolf' | 'not_werewolf'; night: number }[];
  lastGuarded?: string;
  votingHistory?: { day: number; targetId: string; targetName: string }[];
}

// --- Strategy Tracking ---
// Snapshot after each action so agents can see which strategies work/fail over time.
export interface StrategySnapshot {
  actionType: string;
  day: number;
  hungerAt: number;
  healthAt: number;
  inventoryCount: number;
  avgTrust: number;
  reputation: number;
}

// --- Reward Vector ---
// Multi-axis action evaluation. Replaces binary success/failure with rubric scoring.
// Each axis scored -1 to +1 (delta vs. expected). Scalarized against agent rewardWeights.
export interface RewardVector {
  hp: number;             // health / hunger / thirst satisfaction delta
  resources: number;      // material wealth delta (inventory, currency)
  social: number;         // trust-weighted relationship change
  goalProgress: number;   // progress toward long-term goal this action
  exploration: number;    // novelty bonus — discourage rut behavior
  normDeviation: number;  // village-norm deviation cost (negative = violated a negative norm)
  villageImpact?: number; // structural impact on village commons (trust graph, wealth circulation)
}

// --- Learned Strategy ---
// Utility-tracked rule extracted from experience. Ranked by empirical success, not LLM eloquence.
// Evicted by lowest utility (not newest-wins) when cap is hit.
export interface LearnedStrategy {
  content: string;          // the rule-of-thumb (LLM prose)
  createdDay: number;       // game day this strategy was written
  lastAccessedDay: number;  // last day this strategy was read into a prompt
  timesUsed: number;        // how many action outcomes matched this strategy's situation
  timesSuccessful: number;  // how many of those produced positive scalar reward
  avgRewardDelta: number;   // mean scalar reward across matched outcomes
}

// Process rubric (gap-analysis item 1.3): finer-grained credit assignment on
// reasoning steps, separate from terminal action outcomes.
// Each axis scored -1 to +1. Cheap heuristic scoring — no extra LLM calls.
//   planAlignment   — did the executed action match what was planned?
//   thoughtRelevance — did the preceding thought touch entities that showed up in the outcome?
export interface ProcessRubric {
  planAlignment: number;
  thoughtRelevance: number;
}

// Default reward weights: balanced survival (farmer/generalist profile).
// Personality → weighting: farmer heavy on resources+goalProgress, politician on social,
// survivor on hp, explorer on exploration, conformist on normDeviation. Same machinery,
// emergent personality. Weights sum to 1.0 so scalarized reward stays in ~[-1, +1].
export const DEFAULT_REWARD_WEIGHTS: RewardVector = {
  hp: 0.24,
  resources: 0.15,
  social: 0.15,
  goalProgress: 0.15,
  exploration: 0.08,
  normDeviation: 0.15,
  villageImpact: 0.08,
};

// Scalarize a reward vector against an agent's weights. Result in roughly [-1, +1].
// If no weights provided, uses balanced defaults. Legacy agent rewardWeights without
// normDeviation / villageImpact fields fall back to the default weight for each
// axis (norm-aware + village-aware by default).
export function computeScalarReward(rubric: RewardVector, weights?: RewardVector): number {
  const w = weights ?? DEFAULT_REWARD_WEIGHTS;
  const normDevWeight = w.normDeviation ?? DEFAULT_REWARD_WEIGHTS.normDeviation;
  const villageImpactWeight = w.villageImpact ?? DEFAULT_REWARD_WEIGHTS.villageImpact!;
  return (
    rubric.hp * w.hp +
    rubric.resources * w.resources +
    rubric.social * w.social +
    rubric.goalProgress * w.goalProgress +
    rubric.exploration * w.exploration +
    (rubric.normDeviation ?? 0) * normDevWeight +
    (rubric.villageImpact ?? 0) * villageImpactWeight
  );
}

// Utility score for a learned strategy — used for eviction ranking AND selection.
// Higher = keep / prefer. Combines exploit term (success × reward × recency) with
// UCB exploration bonus so under-tried strategies get a fair shake.
// Gap-analysis item 1.1: without UCB, high-utility strategies calcify the book.
//
// totalActions: total action_outcome count for the agent (drives exploration term).
//   When omitted, falls back to pure exploit (use for logging / read-only comparison).
export function strategyUtility(
  s: LearnedStrategy,
  currentDay: number,
  totalActions?: number,
): number {
  const successRate = s.timesUsed > 0 ? s.timesSuccessful / s.timesUsed : 0.5; // prior for unused
  const daysSinceAccess = Math.max(0, currentDay - s.lastAccessedDay);
  const recencyFactor = Math.exp(-daysSinceAccess / 7); // ~1 week half-life
  // Reward delta is roughly [-1, +1], shift to [0, 1] for multiplication
  const normalizedReward = (s.avgRewardDelta + 1) / 2;
  const exploit = successRate * normalizedReward * recencyFactor;

  if (totalActions === undefined || totalActions <= 0) return exploit;

  // UCB1: c·√(ln(N) / n_i). Higher bonus for under-tried strategies.
  // c=0.3 keeps exploration modest — exploit dominates once a strategy has >10 uses.
  // Untried strategies get a large prior bonus to force first-try sampling.
  const c = 0.3;
  const explore = s.timesUsed > 0
    ? c * Math.sqrt(Math.log(totalActions) / s.timesUsed)
    : c * 2; // ~0.6 prior for untried — enough to beat a mediocre exploit score

  return exploit + explore;
}

// --- Commitment System ---
// Weighted promises: casual(1) = 12hr, promise(3) = 24hr, oath(5) = 48hr.
// Weight budget of 15 per agent prevents over-promising.
export interface Commitment {
  id: string;
  targetId: string;
  targetName: string;
  content: string;
  weight: 1 | 3 | 5;
  createdDay: number;
  createdHour: number;
  expiresDay: number;
  itemsPromised?: string[];
  fulfilled: boolean;
  broken: boolean;
  sourceConversationId?: string;
  archivedAt?: number;
}

// --- Village Memory ---
// Collective history shared by all agents — deaths, rules, betrayals, alliances, institutions, elections, discoveries.
export interface VillageMemoryEntry {
  content: string;
  type: 'death' | 'rule' | 'betrayal' | 'alliance' | 'crisis' | 'broken_oath' | 'institution' | 'election' | 'technology' | 'building' | 'prosocial' | 'defection';
  day: number;
  significance: number; // 1-10
  actorId?: string;       // who did it (for prosocial/defection entries)
  actionType?: string;    // canonical action name for norm aggregation (e.g. "theft", "give", "broken_oath")
  witnessIds?: string[];  // agents who saw it happen (drives enforcement detection)
  personalCost?: number;  // scalar reward delta for actor (negative = sacrificed)
  villageBenefit?: number; // scalar reward delta aggregated across other agents
}

// --- Village Norms (gap-analysis item 1.2) ---
// Emergent soft-constraints aggregated from the village memory ledger.
// No constitutional values — morality is a game-theoretic equilibrium, not an axiom.
//
// Aggregated nightly from the last N days of prosocial/defection entries. Feeds
// into per-agent reward calculation as delayed social cost, and per-agent
// decision prompts as soft bias (weighted by Agent.normWeight).
export interface VillageNorm {
  actionType: string;       // e.g. "theft", "give", "broken_oath", "rule_violation"
  observationCount: number; // total times this action was witnessed in the window
  enforcementActions: number; // how many times witnesses responded negatively (trust drops etc)
  acceptanceRate: number;   // [0,1] — 1 - enforcementRate, higher = more tolerated
  enforcementRate: number;  // [0,1] — % of witnesses who act against violators
  severity: number;         // [0,1] — mean normalized |villageBenefit - personalCost|
  windowDays: number;       // aggregation window (typically 7)
  lastUpdated: number;      // timestamp of last recompute
}

// --- Learned Aversions (gap-analysis item 1.2) ---
// Per-agent procedural memory: behaviors the agent has learned to avoid (or prefer)
// through first-person experience. Soft filter on decision-making, not hard veto.
// Confidence grows with evidence; `basis` tracks why the aversion was learned.
export interface LearnedAversion {
  actionType: string;       // canonical action name
  confidence: number;       // [-1, +1] — negative = aversion, positive = preference
  basis: 'victim' | 'witnessed' | 'punished' | 'rewarded';
  evidenceCount: number;    // total reinforcement events
  lastUpdated: number;      // timestamp
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

/**
 * Importance vector (gap-analysis H4): a single scalar importance loses information.
 * A memory can be vital to survival but irrelevant to social life (or vice versa).
 * When present, retrieval scoring uses the axis most relevant to the current context
 * (survival-crisis plan → survival axis; conversation → social; planning → strategic).
 * Falls back to the scalar `importance` field when absent.
 * Each axis: 1-10, same scale as scalar importance.
 */
export interface ImportanceVector {
  survival: number;   // vitals, threats, resource scarcity
  social: number;     // relationships, trust, reputation, promises
  strategic: number;  // goals, long-term plans, identity-aligned ambitions
  narrative: number;  // identity-shaping events, story beats, core memories
}

export interface Memory {
  id: string;
  agentId: string;
  type: "observation" | "conversation" | "reflection" | "plan" | "emotion" | "thought" | "action_outcome";
  content: string;
  importance: number; // 1-10 (scalar — always populated)
  importanceVec?: ImportanceVector; // H4: multi-axis importance, preferred when present
  timestamp: number;
  relatedAgentIds: string[];
  embedding?: number[];
  neuralEmbedding?: number[]; // dense vector from neural model (text-embedding-3-small etc.)

  // --- Phase 4: Memory Enhancements ---
  // Consequence: some memories are private, some public. Emotional weight affects recall.
  visibility?: 'private' | 'shared' | 'public';
  emotionalValence?: number; // -1 (painful) to +1 (joyful). High-valence = recalled more.
  isCore?: boolean; // Core identity memories — never pruned, boosted in retrieval
  actionSuccess?: boolean; // for action_outcome memories (legacy binary signal — kept for backwards compat)
  actionRubric?: RewardVector; // for action_outcome memories: 5-axis rubric scoring
  actionType?: string;      // for action_outcome memories: canonical action name for strategy matching
  processRubric?: ProcessRubric; // gap-analysis 1.3: reasoning-step credit assignment
  sourceAgentId?: string;   // who told them (undefined = firsthand)

  // --- Access tracking (gap-analysis item 5) ---
  // Importance decays on non-access, boosts on retrieval. The "≥ 8 never pruned"
  // rule becomes earned, not granted. undefined = treat as never-accessed.
  lastAccessedAt?: number;
  accessCount?: number;     // total retrievals since creation

  // --- Keyword tagging (gap-analysis item 9) ---
  // A-Mem style: 2-5 keywords per event at ingest. Replaces 4-bin theme clustering
  // (social/economic/survival/political) with emergent keyword-overlap categorization.
  keywords?: string[];
  hearsayDepth?: number;    // 0 = direct, 1 = secondhand

  // --- Freedom 4: Narrative Memory ---
  // Causal linking: enables agents to reason about chains of cause and effect.
  causedBy?: string;        // memory ID that caused this memory
  ledTo?: string[];         // memory IDs that this memory led to

  // --- Bi-temporal modeling (gap-analysis item 3.1) ---
  // Zep/Graphiti-style: track when a belief was true in the world, independently
  // of when the agent learned it. Prevents stale beliefs from corrupting reasoning.
  validFrom?: number;       // game day when this fact became true in the world
  validUntil?: number;      // game day when it stopped being true (undefined = still valid)
  supersededBy?: string;    // memory ID that contradicts and replaces this one

  // --- Structured belief extraction (gap-analysis item 4.3) ---
  // When set, enables programmatic contradiction detection: new belief with same
  // (subject, predicate) but different value auto-invalidates the old one.
  // subject is an agent ID for person-beliefs, a free string for world-beliefs.
  subject?: string;         // who/what the belief is about
  predicate?: string;       // snake_case fact type (e.g. "trustworthiness", "intent")
  value?: string;           // the claimed value ("low", "hostile", "farming")
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
  | { type: "world_object:modified"; worldObject: WorldObject }
  | { type: "werewolf:phase"; phase: string; round: number }
  | { type: "werewolf:kill"; agentId: string; saved: boolean }
  | { type: "werewolf:vote"; exiled: string | null; role: string | null }
  | { type: "werewolf:reveal"; agentId: string; role: string }
  | { type: "werewolf:end"; winner: 'villagers' | 'werewolves' }
  | { type: "werewolf:gameOver"; payload: WerewolfGameOverPayload };

export interface WerewolfGameOverPayload {
  winner: 'villagers' | 'werewolves';
  roles: {
    agentId: string;
    name: string;
    role: 'werewolf' | 'sheriff' | 'healer' | 'villager';
    alive: boolean;
  }[];
  timeline: {
    day: number;
    phase: 'night' | 'dawn' | 'day' | 'meeting' | 'vote';
    event: string;
    agentIds?: string[];
  }[];
  stats: {
    totalDays: number;
    totalKills: number;
    healerSaves: number;
    correctExiles: number;
    wrongExiles: number;
  };
}

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
  ruleAction?: string;      // structured: what specific action the rule requires/prohibits
  ruleAppliesTo?: string;   // structured: who the rule applies to
  ruleConsequence?: string; // structured: what happens on violation
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
  villageMemory?: VillageMemoryEntry[];
  villageNorms?: VillageNorm[]; // gap-analysis item 1.2: aggregated soft-constraints
}
