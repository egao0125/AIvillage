// ============================================================================
// AI Village — Shared Types
// ============================================================================

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
  occupation: string;
  personality: AgentPersonality;
  soul: string;        // Free-form personality description (Moltbook SOUL.md style)
  backstory: string;   // Legacy — prefer soul
  goal: string;        // Legacy — prefer soul
  spriteId: string;
}

export interface Agent {
  id: string;
  config: AgentConfig;
  position: Position;
  state: AgentState;
  currentAction: string;
  currency: number;
  createdAt: number;
  ownerId: string;
}

export type AgentState =
  | "active"    // Talking, deciding, reacting — full LLM
  | "routine"   // Commuting, eating, cleaning — rule-based
  | "idle"      // Off-screen, low-frequency thinking
  | "sleeping"; // Nighttime, no LLM calls

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
  type: "observation" | "conversation" | "reflection" | "plan" | "emotion";
  content: string;
  importance: number; // 1-10
  timestamp: number;
  relatedAgentIds: string[];
  embedding?: number[];
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

// --- Events (WebSocket) ---

export type ServerEvent =
  | { type: "agent:move"; agentId: string; position: Position }
  | { type: "agent:speak"; agentId: string; message: string; conversationId: string }
  | { type: "agent:action"; agentId: string; action: string }
  | { type: "agent:spawn"; agent: Agent }
  | { type: "agent:leave"; agentId: string }
  | { type: "world:time"; hour: number; minute: number; weather: string }
  | { type: "world:event"; description: string };

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

// --- Village Board ---

export type BoardPostType = 'decree' | 'rule' | 'announcement' | 'rumor' | 'threat' | 'alliance' | 'bounty';

export interface BoardPost {
  id: string;
  authorId: string;
  authorName: string;
  type: BoardPostType;
  content: string;
  timestamp: number;
  day: number;
  targetIds?: string[];   // agents this post is about
  revoked?: boolean;      // if a rule/decree was revoked
}

export interface WorldSnapshot {
  time: GameTime;
  agents: Agent[];
  conversations: Conversation[];
  areas: MapArea[];
  board: BoardPost[];
}
