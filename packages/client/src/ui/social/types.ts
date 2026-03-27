import type { SocialPrimitiveType, SocialEntryStatus, MentalModel, SocialLedgerEntry } from '@ai-village/shared';

export interface SocialNode {
  id: string;
  name: string;
  mood: string;
  state: string;
  alive: boolean;
  x: number;
  y: number;
  // Village map position (for map layout)
  mapX: number;
  mapY: number;
  mentalModels: MentalModel[];
  ledgerEntries: SocialLedgerEntry[];
  institutionIds: string[];
}

export interface SocialEdge {
  id: string;
  source: string;
  target: string;
  // Derived metrics
  interactionCount: number;
  avgReputation: number; // -100 to 100
  thickness: number;     // 1-6px
  color: string;
  types: Set<SocialPrimitiveType>;
  hasDisagreement: boolean;
  // Matched ledger entries for detail view
  sharedEntries: MatchedEntry[];
}

export interface MatchedEntry {
  sourceConversationId: string;
  sourceEntry: SocialLedgerEntry;
  targetEntry: SocialLedgerEntry | null; // null if only one side has it
  disagreement: boolean;
}

export type LayoutMode = 'force' | 'map';

export interface SocialFilter {
  types: Set<SocialPrimitiveType>;
  activeOnly: boolean;
  disagreementsOnly: boolean;
  searchQuery: string;
}

export const DEFAULT_FILTER: SocialFilter = {
  types: new Set(['trade', 'promise', 'meeting', 'task', 'rule', 'alliance']),
  activeOnly: false,
  disagreementsOnly: false,
  searchQuery: '',
};
