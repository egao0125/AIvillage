import { useMemo, useSyncExternalStore } from 'react';
import { gameStore, type ChatEntry, type ThoughtEntry, type ActionLogEntry, type InspectTarget } from './GameStore';
import type {
  Agent,
  BoardPost,
  GameTime,
  Election,
  Property,
  ReputationEntry,
  Weather,
  Institution,
  Artifact,
  Building,
  Technology,
  NarrativeEntry,
  Storyline,
  Recap,
  VillageMemoryEntry,
  WerewolfGameOverPayload,
} from '@ai-village/shared';
import { synthesizeEvents } from '../ui/feed/eventSynthesis';
import type { VillageEvent } from '../ui/feed/types';

export function useAgents(): Agent[] {
  const state = useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().agents
  );
  return Array.from(state.values());
}

export function useSelectedAgent(): Agent | null {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => {
      const s = gameStore.getState();
      return s.selectedAgentId
        ? s.agents.get(s.selectedAgentId) ?? null
        : null;
    }
  );
}

export function useChatLog(): ChatEntry[] {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().chatLog
  );
}

export function useWorldTime(): GameTime {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().time
  );
}

export function useConnected(): boolean {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().connected
  );
}

export function useBoard(): BoardPost[] {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().board
  );
}

export function useElections(): Election[] {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().elections
  );
}

export function useProperties(): Property[] {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().properties
  );
}

export function useReputation(): ReputationEntry[] {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().reputation
  );
}

export function useThoughts(): ThoughtEntry[] {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().thoughts
  );
}

export function useWeather(): Weather {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().weather
  );
}

export function useInstitutions(): Institution[] {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().institutions
  );
}

export function useArtifacts(): Artifact[] {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().artifacts
  );
}

export function useBuildings(): Building[] {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().buildings
  );
}

export function useTechnologies(): Technology[] {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().technologies
  );
}

export function useNarratives(): NarrativeEntry[] {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().narratives
  );
}

export function useStorylines(): Storyline[] {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().storylines
  );
}

export function useActiveRecap(): Recap | null {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().activeRecap
  );
}

export function useWeeklySummary(): string | null {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().weeklySummary
  );
}

export function useVillageMemory(): VillageMemoryEntry[] {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().villageMemory
  );
}

export function useAgentsMap(): Map<string, Agent> {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().agents
  );
}

export function useEventFeed(): VillageEvent[] {
  const board = useBoard();
  const artifacts = useArtifacts();
  const buildings = useBuildings();
  const technologies = useTechnologies();
  const elections = useElections();
  const villageMemory = useVillageMemory();
  const agentsMap = useAgentsMap();
  const institutions = useInstitutions();

  return useMemo(
    () => synthesizeEvents(board, artifacts, buildings, technologies, elections, villageMemory, agentsMap, institutions),
    [board, artifacts, buildings, technologies, elections, villageMemory, agentsMap, institutions]
  );
}

export function useAgentEvents(agentId: string): VillageEvent[] {
  const allEvents = useEventFeed();
  return useMemo(
    () => allEvents.filter(e => e.agentIds.includes(agentId)),
    [allEvents, agentId]
  );
}

export function useInspectTarget(): InspectTarget | null {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().inspectTarget
  );
}

export function useActiveMode(): 'watch' | 'analyze' {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().activeMode
  );
}

const EMPTY_ACTION_LOG: ActionLogEntry[] = [];

export function useActionLog(agentId: string): ActionLogEntry[] {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().actionLog.get(agentId) ?? EMPTY_ACTION_LOG
  );
}

export function useWerewolfGameOver(): WerewolfGameOverPayload | null {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().werewolfGameOver
  );
}

export function useWerewolfGodMode(): boolean {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().werewolfGodMode
  );
}

// Cached snapshot to avoid creating a new object every call (useSyncExternalStore
// compares by reference — a fresh object each time causes infinite re-renders).
let _phaseCache: { phase: string | null; round: number } = { phase: null, round: 0 };

export function useWerewolfPhase(): { phase: string | null; round: number } {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => {
      const s = gameStore.getState();
      if (s.werewolfPhase !== _phaseCache.phase || s.werewolfRound !== _phaseCache.round) {
        _phaseCache = { phase: s.werewolfPhase, round: s.werewolfRound };
      }
      return _phaseCache;
    }
  );
}

export function useWerewolfRoles(): Map<string, string> {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().werewolfRoles
  );
}

export function useWerewolfKills(): Array<{ agentId: string; saved: boolean; round: number }> {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().werewolfKills
  );
}

export function useWerewolfVotes(): Array<{ round: number; callerId: string; nomineeId: string; votes: Record<string, 'exile' | 'save'>; result: 'exiled' | 'saved' }> {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().werewolfVotes
  );
}

export function useWerewolfNightActions(): Array<{ round: number; type: string; agentId: string; targetId: string; result?: string }> {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().werewolfNightActions
  );
}

export function useWerewolfMeetingTranscripts(): Array<{ round: number; transcript: Array<{ name: string; message: string }> }> {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().werewolfMeetingTranscripts
  );
}
