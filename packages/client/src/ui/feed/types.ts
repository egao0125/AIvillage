export type EventType =
  | 'trade'
  | 'alliance'
  | 'rule'
  | 'decree'
  | 'election'
  | 'death'
  | 'artifact'
  | 'building'
  | 'technology'
  | 'institution'
  | 'crisis'
  | 'announcement'
  | 'news'
  | 'bounty'
  | 'threat';

export interface VillageEvent {
  id: string;
  type: EventType;
  icon: string;
  color: string;
  headline: string;
  author?: { name: string; id: string };
  status?: string;
  day: number;
  timestamp: number;
  agentIds: string[];
  agentNames: string[];
  sourceConversationId?: string;
  sourceData?: unknown;
}

export const EVENT_BADGES: Record<EventType, { icon: string; color: string }> = {
  trade:        { icon: '🤝', color: '#a78bfa' },
  alliance:     { icon: '⚔️', color: '#4ade80' },
  rule:         { icon: '⚖️', color: '#fbbf24' },
  decree:       { icon: '👑', color: '#ff6b6b' },
  election:     { icon: '🗳️', color: '#60a5fa' },
  death:        { icon: '💀', color: '#6b7280' },
  artifact:     { icon: '📜', color: '#ec4899' },
  building:     { icon: '🏗️', color: '#f97316' },
  technology:   { icon: '🔬', color: '#06b6d4' },
  institution:  { icon: '🏛️', color: '#8b5cf6' },
  crisis:       { icon: '⚡', color: '#ef4444' },
  announcement: { icon: '📢', color: '#60a5fa' },
  news:         { icon: '📰', color: '#ec4899' },
  bounty:       { icon: '🎯', color: '#f97316' },
  threat:       { icon: '🔥', color: '#ef4444' },
};
