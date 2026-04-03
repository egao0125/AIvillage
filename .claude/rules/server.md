# Server Rules

Applies to: `packages/server/**`

## Engine (`simulation/engine.ts`)
- `SimulationEngine` is the god object — orchestrates tick loop, all managers, persistence.
- `tick()` runs every 83ms. Clock advances 1 game-minute every 2 ticks.
- Event flow: `tick()` → `bus.emit('tick')` → controllers + phase managers → `EventBroadcaster` → clients.
- Leader election: only 1 pod runs the sim loop. Others serve reads from snapshot.
- Graceful shutdown: save state → close DB → close Redis → hard-kill at 25s.

## Agent Controller (`simulation/agent-controller.ts`)
- Per-agent state machine: idle → planning → moving → conversing → reflecting.
- `buildWerewolfSituation()` provides phase-aware context to the LLM.
- Werewolf actions (`vote_exile`, `vote_save`, `call_vote`, `attack`, etc.) dispatched via switch in `executeWerewolfAction()`.
- Decision queue processes one LLM call at a time per agent — don't bypass the queue.

## Phase Manager (`simulation/werewolf/phase-manager.ts`)
- Clock-based phase transitions: Night (21:00) → Dawn (05:00) → Day (05:01) → Meeting (12:00) → Vote → Afternoon → Night.
- Vote timeout: 300 ticks (~25s). Force-resolves with collected votes if not all agents vote.
- Exile deferred to 17:00 (or immediately if clock already past 17:00).
- `meetingTranscript` captured via `broadcaster.setOnSpeakHook()` during meeting phase.

## Conversations (`simulation/conversation/`)
- `ConversationManager` handles multi-turn dialogue with stall detection.
- Post-conversation processing: update commitments, reputation, dossiers.
- Max turns per conversation configurable per context (casual=6, werewolf_night=4).

## Security Checklist
- All agent IDs validated with UUID v4 regex before use.
- API keys encrypted with AES-256-GCM at rest, decrypted only in cognition loop.
- Rate limiting: Redis-backed (prod) or in-memory (dev), per-IP.
- Input sanitization: strip HTML entities, control chars, SYSTEM/INST markers.
- Never trust client-sent agent IDs for authorization — always verify server-side.

## Socket.IO Events
- Server→Client: through `EventBroadcaster` methods (e.g., `broadcaster.agentSpeak()`).
- Client→Server: handled in `index.ts` socket handlers (e.g., `socket.on('werewolf:start')`).
- Viewport-aware: `emitSpatial()` and `emitForAgent()` only send to viewers in range.
- New events: add method to `EventBroadcaster`, emit in server logic, handle in `client/network/socket.ts`.
