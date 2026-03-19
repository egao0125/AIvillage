# Contributing to AI Village

Thanks for your interest in AI Village! This is an open experiment and we welcome all kinds of contributions.

## Ways to Contribute

### 🎮 Game Client (Phaser.js + React)
- Sprite rendering and animation
- Camera system and viewport management
- UI components (chat log, agent profiles, minimap)
- Performance optimization for large agent counts

### 🧠 AI Engine
- Agent cognition loop (Perceive → Retrieve → Plan → Act → Reflect)
- Memory stream implementation
- Prompt engineering for agent personalities
- Cost optimization (hierarchical thinking modes)

### 🖼️ Pixel Art
- Character sprite sheets (walk cycles, idle animations, emotes)
- Tileset design (buildings, terrain, objects)
- Building interiors
- Seasonal/weather variations

### 🗺️ Map Design
- Tiled map creation (.tmx files)
- World layout and zoning
- Pathfinding-friendly terrain design
- Map expansion templates for population growth

### 🔧 Backend
- Simulation engine (game loop, action coordination)
- WebSocket real-time streaming
- Database schema and state management
- BYOK API key management

### 📊 Observation Tools
- Real-time social graph visualization
- Movement heatmaps
- Conversation log with search
- Data export (JSON/CSV) for researchers

## Getting Started

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Make your changes
4. Run tests: `pnpm test`
5. Submit a PR

## Development Setup

```bash
pnpm install
pnpm dev:server   # Start sim engine + WebSocket
pnpm dev:client   # Start Phaser.js game + React UI
```

## Code Style

- TypeScript everywhere
- ESLint + Prettier (run `pnpm lint`)
- Commit messages: `feat:`, `fix:`, `docs:`, `art:`, `refactor:`

## PR Guidelines

- Keep PRs focused and small
- Include screenshots/recordings for visual changes
- Pixel art contributions: include the source file (.aseprite or .psd)
- AI engine changes: include example agent behavior before/after

## Communication

- GitHub Issues for bugs and feature requests
- GitHub Discussions for ideas and questions
- PRs for code

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
