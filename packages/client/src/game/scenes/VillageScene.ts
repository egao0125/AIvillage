import Phaser from 'phaser';
import { TILE_SIZE, MAP_WIDTH, MAP_HEIGHT } from '../config';
import {
  TILE_MAP,
  TILE_TYPES,
  TREES,
  DECORATIONS,
  BUILDINGS,
} from '../data/village-map';
import { AgentSprite } from '../entities/AgentSprite';
import { eventBus } from '../../core/EventBus';
import { gameStore } from '../../core/GameStore';
import { generateAgentTexture, agentColorsFromName } from './BootScene';
import type { Agent, GameTime } from '@ai-village/shared';

const TILE_TEXTURE_MAP: Record<number, string> = {
  [TILE_TYPES.GRASS]: 'tile_grass',
  [TILE_TYPES.PATH]: 'tile_path',
  [TILE_TYPES.WATER]: 'tile_water',
  [TILE_TYPES.SAND]: 'tile_sand',
  [TILE_TYPES.FLOOR]: 'tile_floor',
  [TILE_TYPES.WALL]: 'tile_wall',
  [TILE_TYPES.FOREST]: 'tile_forest',
  [TILE_TYPES.FLOWERS]: 'tile_flowers',
  [TILE_TYPES.BRIDGE]: 'tile_bridge',
};

const ROOF_COLORS: Record<string, { main: number; highlight: number; shadow: number }> = {
  // Fallbacks by type
  house: { main: 0x8b4513, highlight: 0xa05828, shadow: 0x6b3010 },
  cafe: { main: 0xb85c3a, highlight: 0xd07050, shadow: 0x984828 },
  shop: { main: 0x2e5a8b, highlight: 0x4070a0, shadow: 0x1e4070 },
  // Per-building unique colors (keyed by label)
  church: { main: 0x6b4e8a, highlight: 0x8060a0, shadow: 0x4a3568 },
  school: { main: 0x2e6e8b, highlight: 0x4088a8, shadow: 0x1e5068 },
  bakery: { main: 0xc4883a, highlight: 0xd8a050, shadow: 0xa06828 },
  workshop: { main: 0x5a7a5a, highlight: 0x709070, shadow: 0x405a40 },
  market: { main: 0x3a8b6b, highlight: 0x50a880, shadow: 0x2a6850 },
  clinic: { main: 0xc85050, highlight: 0xe06868, shadow: 0xa83838 },
  'town hall': { main: 0x8a7a4a, highlight: 0xa89058, shadow: 0x6a5a30 },
  tavern: { main: 0x7a3a2a, highlight: 0x984a38, shadow: 0x5a2818 },
};

export class VillageScene extends Phaser.Scene {
  private agentSprites: Map<string, AgentSprite> = new Map();
  private selectedAgentId: string | null = null;
  private dayNightOverlay!: Phaser.GameObjects.Rectangle;
  private conversationGraphics!: Phaser.GameObjects.Graphics;
  private cleanupFns: (() => void)[] = [];

  constructor() {
    super({ key: 'VillageScene' });
  }

  create(): void {
    this.drawTileMap();
    this.drawBuildingRoofs();
    this.placeTrees();
    this.placeDecorations();

    // Conversation connector lines (rendered between agents who are talking)
    this.conversationGraphics = this.add.graphics();
    this.conversationGraphics.setDepth(9);

    // Day/night overlay
    this.dayNightOverlay = this.add
      .rectangle(
        (MAP_WIDTH * TILE_SIZE) / 2,
        (MAP_HEIGHT * TILE_SIZE) / 2,
        MAP_WIDTH * TILE_SIZE,
        MAP_HEIGHT * TILE_SIZE,
        0x000033,
        0
      )
      .setDepth(5000);

    this.setupCamera();
    this.setupEventListeners();
    this.syncInitialState();
  }

  update(time: number, delta: number): void {
    for (const sprite of this.agentSprites.values()) {
      sprite.update(time, delta);
    }
    this.drawConversationLines();
  }

  private drawConversationLines(): void {
    this.conversationGraphics.clear();
    const convos = gameStore.getState().activeConversations;

    for (const [_convId, participants] of convos) {
      if (participants.length < 2) continue;
      const s1 = this.agentSprites.get(participants[0]);
      const s2 = this.agentSprites.get(participants[1]);
      if (!s1 || !s2) continue;

      // Draw a dotted arc between the two agents
      const midX = (s1.x + s2.x) / 2;
      const midY = Math.min(s1.y, s2.y) - 12;

      // Soft glow line
      this.conversationGraphics.lineStyle(3, 0xffd700, 0.25);
      this.conversationGraphics.beginPath();
      this.conversationGraphics.moveTo(s1.x, s1.y - 10);
      this.conversationGraphics.lineTo(midX, midY);
      this.conversationGraphics.lineTo(s2.x, s2.y - 10);
      this.conversationGraphics.strokePath();

      // Thinner bright line on top
      this.conversationGraphics.lineStyle(1, 0xffd700, 0.6);
      this.conversationGraphics.beginPath();
      this.conversationGraphics.moveTo(s1.x, s1.y - 10);
      this.conversationGraphics.lineTo(midX, midY);
      this.conversationGraphics.lineTo(s2.x, s2.y - 10);
      this.conversationGraphics.strokePath();

      // Chat icon at midpoint
      this.conversationGraphics.fillStyle(0xffd700, 0.5);
      this.conversationGraphics.fillCircle(midX, midY, 3);
    }
  }

  // ── Tilemap ───────────────────────────────────────────────
  private drawTileMap(): void {
    for (let y = 0; y < MAP_HEIGHT; y++) {
      for (let x = 0; x < MAP_WIDTH; x++) {
        const tileType = TILE_MAP[y]?.[x] ?? TILE_TYPES.GRASS;
        // Check for variant textures
        const variant = (x * 7 + y * 13) % 3;
        const baseTex = TILE_TEXTURE_MAP[tileType] ?? 'tile_grass';
        const variantTex = `${baseTex}_${variant}`;
        const texKey = this.textures.exists(variantTex) ? variantTex : baseTex;

        this.add
          .image(
            x * TILE_SIZE + TILE_SIZE / 2,
            y * TILE_SIZE + TILE_SIZE / 2,
            texKey
          )
          .setDepth(0);
      }
    }
  }

  // ── Building roofs (drawn with Graphics) ──────────────────
  private drawBuildingRoofs(): void {
    for (const building of BUILDINGS) {
      // Use per-building label for unique color, fall back to type
      const labelKey = building.label?.toLowerCase() ?? '';
      const colors = ROOF_COLORS[labelKey] ?? ROOF_COLORS[building.type] ?? ROOF_COLORS.house;
      const roofG = this.add.graphics();

      const rx = building.x * TILE_SIZE;
      const ry = building.y * TILE_SIZE - 10;
      const rw = building.w * TILE_SIZE;
      const rh = 12;
      const overhang = 3;

      // Roof shadow
      roofG.fillStyle(0x000000, 0.2);
      roofG.fillRect(rx - overhang + 1, ry + 1, rw + overhang * 2, rh);

      // Main roof body
      roofG.fillStyle(colors.main);
      roofG.fillRect(rx - overhang, ry, rw + overhang * 2, rh);

      // Highlight strip (top edge)
      roofG.fillStyle(colors.highlight);
      roofG.fillRect(rx - overhang, ry, rw + overhang * 2, 3);

      // Shadow strip (bottom edge)
      roofG.fillStyle(colors.shadow);
      roofG.fillRect(rx - overhang, ry + rh - 2, rw + overhang * 2, 2);

      // Vertical tile lines
      roofG.lineStyle(1, colors.shadow, 0.3);
      for (let lx = rx; lx < rx + rw; lx += 5) {
        roofG.lineBetween(lx, ry + 3, lx, ry + rh - 2);
      }

      // Ridge cap (horizontal line at peak)
      roofG.fillStyle(colors.highlight);
      roofG.fillRect(rx - overhang, ry, rw + overhang * 2, 1);

      roofG.setDepth(building.y + 5);

      // Building label
      if (building.label) {
        const label = this.add.text(
          rx + rw / 2,
          ry - 4,
          building.label,
          {
            fontSize: '8px',
            fontFamily: '"Press Start 2P", monospace',
            color: '#ffffff',
            stroke: '#000000',
            strokeThickness: 3,
            resolution: 2,
          }
        );
        label.setOrigin(0.5, 1);
        label.setDepth(2000);
      }
    }
  }

  // ── Trees ─────────────────────────────────────────────────
  private placeTrees(): void {
    for (const tree of TREES) {
      const texKey = `tree_${tree.type}`;
      if (!this.textures.exists(texKey)) continue;

      const img = this.add.image(
        tree.x * TILE_SIZE + TILE_SIZE / 2,
        tree.y * TILE_SIZE + TILE_SIZE / 2,
        texKey
      );
      img.setOrigin(0.5, 0.85);
      img.setDepth(tree.y + 2);
    }
  }

  // ── Decorations ───────────────────────────────────────────
  private placeDecorations(): void {
    for (const deco of DECORATIONS) {
      const texKey = `deco_${deco.type}`;
      if (!this.textures.exists(texKey)) continue;

      const img = this.add.image(
        deco.x * TILE_SIZE + TILE_SIZE / 2,
        deco.y * TILE_SIZE + TILE_SIZE / 2,
        texKey
      );
      img.setOrigin(0.5, 0.5);
      img.setDepth(deco.y + 1);
    }
  }

  // ── Camera ────────────────────────────────────────────────
  private setupCamera(): void {
    const worldW = MAP_WIDTH * TILE_SIZE;
    const worldH = MAP_HEIGHT * TILE_SIZE;

    // No camera bounds — allow free panning
    const cam = this.cameras.main;

    // Initial zoom: fit the entire map in view
    const fitZoom = Math.min(cam.width / worldW, cam.height / worldH);
    cam.setZoom(Math.max(fitZoom, 0.5));
    cam.centerOn(worldW / 2, worldH / 2);

    // Drag to pan
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (pointer.isDown && pointer.button === 0 && !pointer.event.shiftKey) {
        cam.scrollX -= (pointer.x - pointer.prevPosition.x) / cam.zoom;
        cam.scrollY -= (pointer.y - pointer.prevPosition.y) / cam.zoom;
      }
    });

    // Scroll to zoom — free range from 0.5x to 5x
    this.input.on(
      'wheel',
      (
        _pointer: Phaser.Input.Pointer,
        _gameObjects: Phaser.GameObjects.GameObject[],
        _deltaX: number,
        deltaY: number
      ) => {
        const newZoom = Phaser.Math.Clamp(cam.zoom - deltaY * 0.001, 0.5, 5);
        cam.setZoom(newZoom);
      }
    );
  }

  // ── Event listeners ───────────────────────────────────────
  private setupEventListeners(): void {
    this.cleanupFns.push(
      eventBus.on('world:snapshot', (snapshot: { agents: Agent[]; time?: GameTime }) => {
        for (const agent of snapshot.agents) {
          if (!this.agentSprites.has(agent.id)) {
            this.spawnAgent(agent);
          } else {
            const sprite = this.agentSprites.get(agent.id)!;
            sprite.moveTo(agent.position.x, agent.position.y);
            if (agent.currentAction) sprite.setAction(agent.currentAction);
          }
        }
        if (snapshot.time) this.updateDayNight(snapshot.time);
      }),

      eventBus.on('agent:move', (data: { agentId: string; to: { x: number; y: number } }) => {
        const sprite = this.agentSprites.get(data.agentId);
        if (sprite) sprite.moveTo(data.to.x, data.to.y);
      }),

      eventBus.on('agent:speak', (data: { agentId: string; message: string }) => {
        const sprite = this.agentSprites.get(data.agentId);
        if (sprite) sprite.speak(data.message);
      }),

      eventBus.on('agent:action', (data: { agentId: string; action: string }) => {
        const sprite = this.agentSprites.get(data.agentId);
        if (sprite) sprite.setAction(data.action);
      }),

      eventBus.on('agent:spawn', (agent: Agent) => {
        this.spawnAgent(agent);
      }),

      eventBus.on('world:time', (time: GameTime) => {
        this.updateDayNight(time);
      }),

      eventBus.on('agent:select', (agentId: string) => {
        this.selectAgent(agentId);
      })
    );
  }

  // ── Agent management ──────────────────────────────────────
  private spawnAgent(agent: Agent): void {
    if (this.agentSprites.has(agent.id)) return;

    // Generate a unique texture for this agent based on their name
    const texKey = `agent_${agent.id}`;
    if (!this.textures.exists(texKey)) {
      const { shirt, hair } = agentColorsFromName(agent.config.name);
      generateAgentTexture(this, texKey, shirt, hair);
    }

    const agentSprite = new AgentSprite(
      this,
      agent.id,
      agent.config.name,
      texKey,
      agent.position.x,
      agent.position.y
    );
    if (agent.currentAction) agentSprite.setAction(agent.currentAction);
    this.agentSprites.set(agent.id, agentSprite);
  }

  private selectAgent(agentId: string): void {
    // Deselect previous
    if (this.selectedAgentId) {
      const prev = this.agentSprites.get(this.selectedAgentId);
      if (prev) prev.setSelected(false);
    }

    // Toggle off if same agent
    if (this.selectedAgentId === agentId) {
      this.selectedAgentId = null;
      gameStore.selectAgent(null);
      return;
    }

    this.selectedAgentId = agentId;
    gameStore.selectAgent(agentId);

    const sprite = this.agentSprites.get(agentId);
    if (sprite) {
      sprite.setSelected(true);
      this.cameras.main.pan(sprite.x, sprite.y, 300, 'Sine.easeInOut');
    }
  }

  // ── Day/night cycle ───────────────────────────────────────
  private updateDayNight(time: GameTime): void {
    const h = time.hour + time.minute / 60;
    let alpha = 0;

    if (h < 5) {
      alpha = 0.3;
    } else if (h < 7) {
      alpha = 0.3 - ((h - 5) / 2) * 0.3;
    } else if (h < 18) {
      alpha = 0;
    } else if (h < 20) {
      alpha = ((h - 18) / 2) * 0.2;
    } else {
      alpha = 0.2 + ((h - 20) / 4) * 0.1;
    }

    this.dayNightOverlay.setAlpha(alpha);

    // Tint color: warm at dawn/dusk, blue at night
    if (h < 5 || h >= 20) {
      this.dayNightOverlay.setFillStyle(0x000033, alpha);
    } else if (h < 7) {
      this.dayNightOverlay.setFillStyle(0x331a00, alpha);
    } else if (h >= 18) {
      this.dayNightOverlay.setFillStyle(0x1a0033, alpha);
    }
  }

  // ── Sync initial state ────────────────────────────────────
  private syncInitialState(): void {
    const state = gameStore.getState();
    for (const agent of state.agents.values()) {
      this.spawnAgent(agent);
    }
    if (state.time) this.updateDayNight(state.time);
  }

  // ── Cleanup ───────────────────────────────────────────────
  shutdown(): void {
    this.cleanupFns.forEach((fn) => fn());
    this.cleanupFns = [];
    this.agentSprites.clear();
  }
}
