# Client Rules

Applies to: `packages/client/**`

## Architecture
- Dual rendering: Phaser.js (game viewport) + React 19 (UI panels/sidebars).
- Entry: `main.tsx` → `AppShell` → map select → socket connect → Phaser init.
- Two scenes: `VillageScene` (village map) and `ArenaScene` (werewolf/battle_royale).
- Tilemap: Fan-Tasy Premium, 32px tiles, 68×45 grid.

## State Management (`core/GameStore.ts`)
- Custom store using `useSyncExternalStore` — NOT Redux, NOT Zustand.
- **Critical**: Hook return values must be referentially stable. If you return a new object/array on every call, React re-renders infinitely. Cache derived values.
- Pattern: `useSyncExternalStore((cb) => gameStore.subscribe(cb), () => gameStore.getState().field)`
- New state fields: add to `GameState` interface, initial state, `clearWerewolfState()`, and create a hook.

## Socket Wiring (`network/socket.ts`)
- All socket events land here first, update `gameStore`, then emit on `eventBus`.
- Pattern for new events:
  1. `socket.on('event:name', (data) => { gameStore.updateX(data); eventBus.emit('event:name', data); })`
  2. Add store method + state field
  3. Create hook in `hooks.ts`
  4. Use hook in component

## React Components
- Inline styles via `COLORS` and `FONTS` from `styles.ts` — no CSS files, no Tailwind.
- `COLORS.textDim` (not `textMuted`) — this is a known gotcha.
- Pixel font: `FONTS.pixel` at small sizes (5-9px). Body: `FONTS.body` at 11-13px.
- Components are function components with explicit `React.FC<Props>` typing.

## Phaser Scenes
- `BootScene` loads assets, creates tilemap layers, then starts game scene.
- `ArenaScene` handles werewolf game: listens to `eventBus` for phase changes, death events.
- Agent sprites: walk cycles (8 dirs), idle, conversation bubble, death animation.
- Camera follows selected agent or free-roam with WASD/arrow keys.

## Event Flow (for werewolf sidebar)
- Server emits → `socket.ts` handler → `gameStore` update + `eventBus.emit()` → React hooks re-render.
- `WerewolfSidebar` subscribes to eventBus in `useEffect` for live events (phase, kill, vote).
- Static data (roles, votes, transcripts) comes from GameStore hooks.
- Filter chips filter the event feed by type. God mode shows night actions.
