// ---------------------------------------------------------------------------
// Werewolf Game — Type Definitions
// ---------------------------------------------------------------------------

export type WerewolfRole = 'werewolf' | 'sheriff' | 'healer' | 'villager';
export type WerewolfPhase = 'setup' | 'night' | 'dawn' | 'day' | 'meeting' | 'vote' | 'ended';

export interface NightActions {
  wolfTarget: string | null;
  healerGuard: string | null;
  sheriffTarget: string | null;
  /** True when both wolves have confirmed their target (or timer expired) */
  wolfTargetConfirmed: boolean;
  sheriffDone: boolean;
  healerDone: boolean;
}

export interface NightResult {
  killed: string | null;
  saved: boolean;
  investigation: { targetId: string; targetName: string; isWolf: boolean } | null;
}

export interface VoteRecord {
  day: number;
  /** voterId → targetId (who they want to exile) */
  votes: Map<string, string>;
  result: 'exiled' | 'no_exile';
  exiledId: string | null;
  roleRevealed: string | null;
}

export interface WerewolfEvent {
  day: number;
  phase: 'night' | 'dawn' | 'day' | 'meeting' | 'vote';
  event: string;
  agentIds?: string[];
}

export interface WerewolfGameState {
  phase: WerewolfPhase;
  round: number;
  roles: Map<string, WerewolfRole>;
  alive: Set<string>;
  dead: string[];
  exiled: string[];
  nightActions: NightActions;
  lastNightResult: NightResult | null;
  winner: 'villagers' | 'werewolves' | null;
  phaseTimer: number;
  /** Sheriff's cumulative investigation history */
  investigations: Array<{ night: number; targetId: string; targetName: string; result: 'werewolf' | 'not_werewolf' }>;
  /** Who the healer guarded last night (cannot guard same person twice) */
  lastGuarded: string | null;
  votingHistory: VoteRecord[];
  /** ID of the wolf private conversation during night */
  wolfConversationId: string | null;
  /** Whether a vote has already been called this day */
  voteCalled: boolean;
  /** ID of the group conversation during town meeting */
  meetingConversationId: string | null;
  /** Agent awaiting execution at 17:00 after vote */
  pendingExileId: string | null;
  /** Chronological event log for game over screen */
  eventLog: WerewolfEvent[];
}

/** Fresh night actions for each new night */
export function freshNightActions(): NightActions {
  return {
    wolfTarget: null,
    healerGuard: null,
    sheriffTarget: null,
    wolfTargetConfirmed: false,
    sheriffDone: false,
    healerDone: false,
  };
}
