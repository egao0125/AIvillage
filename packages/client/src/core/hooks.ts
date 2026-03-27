import { useSyncExternalStore } from 'react';
import { gameStore, type ChatEntry, type ThoughtEntry, type ActionLogEntry } from './GameStore';
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
} from '@ai-village/shared';

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

export function useCharacterPageAgentId(): string | null {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().characterPageAgentId
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

export function useSocialViewOpen(): boolean {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().socialViewOpen
  );
}

const EMPTY_ACTION_LOG: ActionLogEntry[] = [];

export function useActionLog(agentId: string): ActionLogEntry[] {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => gameStore.getState().actionLog.get(agentId) ?? EMPTY_ACTION_LOG
  );
}
