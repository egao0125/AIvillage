# AI Village

Pixel world where autonomous AI agents live 24/7 in real time. Stanford Generative Agents paper meets social deduction games.

## Stack
- **Monorepo**: pnpm workspaces — `shared`, `ai-engine`, `server`, `client`
- **Server**: Node.js + Express + Socket.IO + PostgreSQL + Redis
- **Client**: Phaser.js 3.80 + React 19 + Vite 6
- **AI**: BYOK LLM (Claude/OpenAI/Gemini), per-agent API keys, tiered memory
- **Infra**: EKS on AWS, leader election, multi-pod safe

## Commands
```bash
pnpm dev              # Start server + client
pnpm dev:server       # Server only (tsx watch, port 4000)
pnpm dev:client       # Client only (vite, port 3000)
pnpm build            # Build all packages
pnpm --filter @ai-village/server exec tsc --noEmit   # Type-check server
pnpm --filter @ai-village/client exec tsc --noEmit   # Type-check client
```

## Key Files
- `server/src/simulation/engine.ts` — Main game loop, tick(), all managers
- `server/src/simulation/agent-controller.ts` — Per-agent state machine (1000+ lines)
- `server/src/simulation/events.ts` — EventBroadcaster (Socket.IO emits)
- `server/src/simulation/werewolf/phase-manager.ts` — Werewolf game orchestrator
- `ai-engine/src/index.ts` — AgentCognition (think/plan/talk/reflect)
- `ai-engine/src/maps/` — MAP_REGISTRY, per-mode configs
- `client/src/core/GameStore.ts` — Client state (useSyncExternalStore)
- `client/src/network/socket.ts` — Socket.IO event wiring
- `shared/src/index.ts` — All shared types

## Conventions
- ES Modules everywhere — use `.js` extensions in imports
- `import type { }` for type-only imports
- No default exports — named exports only
- Agent IDs are UUID v4, validated on all inputs
- Dev mode: no Cognito, no Redis, no RDS (in-memory fallbacks)
- Production: ENCRYPTION_KEY, COGNITO_*, DB_* all required

## Game Modes
| Mode | Map ID | Status |
|------|--------|--------|
| AI Village | `village` | Active — survival, governance, crafting |
| Werewolf | `werewolf` | Active — social deduction, clock-based phases |
| Battle Royale | `battle_royale` | Stub — not implemented |

## Gotchas
- Clock: 1 game-minute = 2 ticks, tick interval = 83ms. 1 game-hour ≈ 10s real time.
- GameStore hooks must return stable references (cache objects) or React re-renders infinitely.
- Werewolf changes must NOT affect village/battle_royale — guard with `this.werewolfManager` or `mapConfig.systems?.werewolf`.
- Socket events go through EventBroadcaster (server) → socket.ts handlers (client) → GameStore → React hooks.
- LLM calls are async through DecisionQueue (max 10 concurrent per key). Missing `await` = silent failure.
