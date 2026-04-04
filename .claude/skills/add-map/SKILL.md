# Skill: Add a New Game Mode

Use when the user says "add a new map", "new game mode", or "create a new mode".

## Checklist

### Step 1: Define the MapConfig
- [ ] Create `ai-engine/src/maps/{mode}-config.ts`
- [ ] Define `MapConfig` with: id, name, description, mapSize, spawnAreas, systems, actions, tickConfig, rules
- [ ] Export the config

### Step 2: Register in MAP_REGISTRY
- [ ] Add to `ai-engine/src/maps/index.ts` → `MAP_REGISTRY`
- [ ] Verify: `pnpm --filter @ai-village/ai-engine exec tsc --noEmit`

### Step 3: Update Shared Types
- [ ] Add map ID to any union types in `shared/src/index.ts` if needed
- [ ] Add mode-specific types (roles, phases, state) to shared or server types
- [ ] Verify: `pnpm --filter @ai-village/shared exec tsc --noEmit`

### Step 4: Create Phase Manager (if stateful)
- [ ] Create `server/src/simulation/{mode}/` directory
- [ ] Implement phase manager class with: `startGame()`, `onTick(time)`, `getActionsForAgent()`, `dispose()`
- [ ] Create `types.ts` for mode-specific state
- [ ] Export from `index.ts`

### Step 5: Wire into Engine
- [ ] In `engine.ts`, create manager when map has the mode's system enabled
- [ ] Add `onTick()` call in the tick event handler (before controllers)
- [ ] Guard all mode code with `if (this.{mode}Manager)` — never break other modes
- [ ] Add socket event handlers in `index.ts` for mode-specific client events

### Step 6: Client — Scene
- [ ] Extend `ArenaScene` or create new scene in `client/src/game/scenes/`
- [ ] Handle mode-specific events from `eventBus`
- [ ] Register scene in Phaser config

### Step 7: Client — UI
- [ ] Create sidebar component in `client/src/ui/components/`
- [ ] Add socket event handlers in `network/socket.ts`
- [ ] Add state fields to `GameStore.ts` + hooks in `hooks.ts`
- [ ] Add to `WatchView.tsx` or `AppShell.tsx` layout

### Step 8: Verify
- [ ] `pnpm --filter @ai-village/server exec tsc --noEmit` — server compiles
- [ ] `pnpm --filter @ai-village/client exec tsc --noEmit` — client compiles
- [ ] Start game in the new mode — phases transition correctly
- [ ] Existing modes (village, werewolf) still work — no regressions
