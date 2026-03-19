import { useSyncExternalStore } from 'react';
import { gameStore, type ChatEntry } from './GameStore';
import type { Agent, BoardPost, GameTime } from '@ai-village/shared';

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
