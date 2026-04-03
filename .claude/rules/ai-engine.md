# AI Engine Rules

Applies to: `packages/ai-engine/**`

## Architecture
- `AgentCognition` is the core class — think/plan/talk/reflect loop (Stanford Generative Agents).
- Providers (`anthropic.ts`, `openai.ts`) are pluggable LLM backends. Anthropic auto-continues on `max_tokens`.
- Memory stores are pluggable: `InMemoryStore` (dev), `RdsMemoryStore` (prod), `TieredMemory` (hybrid).
- `FourStreamMemory` adds relationship dossiers + active concerns on top of base memory.

## Prompt Design
- System prompts must stay under 4000 tokens. Agent personality + world rules + situation = system prompt.
- Use `buildWerewolfRules()` for per-role game rules — never leak wolf identity to villagers.
- Working memory is the agent's "scratchpad" — updated after each cognition cycle, max ~2000 chars.
- Importance scores: 1-3 routine, 4-6 notable, 7-8 significant, 9-10 critical (death/exile/role reveal).

## Memory Budgets
- `addMemory()` with importance < 3 gets auto-pruned after 500 memories per agent.
- Core memories (importance >= 8) are never pruned.
- Reflection triggers after every 10 new memories — synthesizes patterns into insights.
- Embeddings are optional (Chroma) — semantic search degrades gracefully to recency-based.

## Key Constraints
- Never log API keys or full prompts in production — use truncated previews.
- `AgentCognition.plan()` returns JSON — parse failures are common. Always catch and log, never crash.
- `ThrottledProvider` enforces per-key rate limits — don't bypass it.
- Game rules override (`cognition.setGameRules()`) replaces shared rules with role-specific ones.

## Map Configs
- Each map has a `MapConfig` in `maps/` — defines systems, actions, spawn areas, rules.
- `MAP_REGISTRY` is the canonical list. New maps must be registered here.
- `werewolf-config.ts` defines werewolf-specific actions and phases.
