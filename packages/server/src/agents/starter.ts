import type { AgentConfig } from '@ai-village/shared';

export interface StarterAgent {
  config: AgentConfig;
  wakeHour: number;
  sleepHour: number;
}

export const STARTER_AGENTS: StarterAgent[] = [];
