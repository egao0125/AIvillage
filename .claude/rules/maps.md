# Map / Game Mode Rules

Applies to: map configs, game mode code, phase managers

## MapConfig Pattern
Every game mode is defined by a `MapConfig` object in `ai-engine/src/maps/`:

```typescript
export const MY_CONFIG: MapConfig = {
  id: 'my_mode',
  name: 'My Mode',
  description: '...',
  mapSize: { width: 1024, height: 1024 },
  spawnAreas: [...],
  systems: { werewolf: false, hunger: false, governance: false, ... },
  actions: [...],           // Available MapActions per phase
  tickConfig: { ... },      // Decision intervals, cooldowns
  rules: '...',             // LLM system prompt rules
};
```

Register in `ai-engine/src/maps/index.ts` → `MAP_REGISTRY`.

## Adding a New Game Mode
1. Create `ai-engine/src/maps/my-mode-config.ts` with MapConfig
2. Register in MAP_REGISTRY
3. Add map ID to `shared/src/index.ts` types if needed
4. Create phase manager in `server/src/simulation/my-mode/` if needed
5. Wire in `engine.ts` — create manager on map switch, tick in game loop
6. Add scene in `client/src/game/scenes/` or extend ArenaScene
7. Add sidebar/UI in `client/src/ui/components/`
8. Add tilemap assets if new map layout needed

## Isolation Rule
Changes for one game mode must NOT break others:
- Guard server code with `if (this.myModeManager)` or `if (mapConfig.systems?.mySystem)`
- Guard shared type changes with union types, not breaking changes
- Client components: check `phase` or `mapId` before rendering mode-specific UI
- Test: `pnpm --filter @ai-village/server exec tsc --noEmit` must pass

## Current Modes
- **village**: Survival sim. Engine runs AI Village subsystems (hunger, governance, board, elections).
- **werewolf**: Social deduction. `WerewolfPhaseManager` drives night/day/vote cycle. Clock-based phases.
- **battle_royale**: Stub. `BATTLE_ROYALE_CONFIG` exists but no phase manager or game logic.
