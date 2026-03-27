// ============================================================================
// AI Village — Simulation Event Types (Infra 1: Event Bus)
// Typed pub/sub events for internal decoupling.
// ============================================================================

import type { Agent, GameTime, Position } from './index.js';

export type SimEvent =
  // World clock
  | { type: 'tick'; time: GameTime }
  | { type: 'day_started'; day: number }
  | { type: 'midnight'; day: number }
  | { type: 'hour_changed'; hour: number; day: number }

  // Agent spatial
  | { type: 'agent_moved'; agentId: string; from: Position; to: Position }
  | { type: 'agent_entered_area'; agentId: string; areaId: string }
  | { type: 'agent_left_area'; agentId: string; areaId: string }

  // Agent state
  | { type: 'agent_state_changed'; agentId: string; from: string; to: string }
  | { type: 'agent_spawned'; agent: Agent }
  | { type: 'agent_died'; agentId: string; cause: string }

  // Freedom 3: consequence events (reactive think triggers)
  | { type: 'action_completed'; agentId: string; action: string; outcome: string }
  | { type: 'action_failed'; agentId: string; action: string; reason: string }
  | { type: 'vitals_threshold'; agentId: string; vital: string; band: number }

  // Freedom 2: social proximity events
  | { type: 'agents_proximate'; a: string; b: string; distance: number }
  | { type: 'conversation_started'; id: string; participants: string[] }
  | { type: 'conversation_ended'; id: string; participants: string[] }
  | { type: 'speech_audible'; speakerId: string; content: string; location: Position }

  // Freedom 5: world mutation events
  | { type: 'resource_gathered'; areaId: string; resource: string; remaining: number }
  | { type: 'landmark_created'; id: string; name: string; areaId: string; creatorId: string }
  | { type: 'landmark_decayed'; id: string }
  | { type: 'cultural_name_established'; areaId: string; name: string }

  // Fix 4: Gameplay events (witness-based perception)
  | { type: 'theft_occurred'; thiefId: string; victimId: string; item: string; location: Position }
  | { type: 'fight_occurred'; attackerId: string; defenderId: string; outcome: string; location: Position }

  // Fix 5: Institutional enforcement
  | { type: 'rule_violated'; agentId: string; agentName: string; institutionId: string; institutionName: string; rule: string; action: string; location: Position }

  // Perception
  | { type: 'perception_cycle'; tick: number }

  // Board
  | { type: 'board_post_created'; post: import('./index.js').BoardPost }
  | { type: 'rule_proposed'; post: import('./index.js').BoardPost }

  // Persistence
  | { type: 'save_requested' };
