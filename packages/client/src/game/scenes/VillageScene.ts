import Phaser from 'phaser';
import { TILE_SIZE, MAP_WIDTH, MAP_HEIGHT } from '../config';
import {
  TILE_MAP,
  TILE_TYPES,
  TREES,
  DECORATIONS,
  BUILDINGS,
  FURNITURE,
} from '../data/village-map';
import { AgentSprite } from '../entities/AgentSprite';
import { eventBus } from '../../core/EventBus';
import { gameStore } from '../../core/GameStore';
import { sendViewportUpdate } from '../../network/socket';
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
  [TILE_TYPES.FLOOR_DARK]: 'tile_floor_dark',
  [TILE_TYPES.CROP]: 'tile_crop',
};

export class VillageScene extends Phaser.Scene {
  private agentSprites: Map<string, AgentSprite> = new Map();
  private selectedAgentId: string | null = null;
  private dayNightOverlay!: Phaser.GameObjects.Rectangle;
  private conversationGraphics!: Phaser.GameObjects.Graphics;
  private cleanupFns: (() => void)[] = [];
  // Infra 6: Viewport tracking — throttled to avoid spamming server
  private lastViewportKey: string = '';
  private viewportThrottleTime: number = 0;

  constructor() {
    super({ key: 'VillageScene' });
  }

  create(): void {
    this.drawTileMap();
    this.drawBuildingShadows();
    this.drawBuildingLabels();
    this.placeFurniture();
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
    this.emitViewportUpdate(time);
  }

  /** Infra 6: Emit viewport rectangle to server, throttled to max once per 500ms and only on change */
  private emitViewportUpdate(time: number): void {
    if (time - this.viewportThrottleTime < 500) return;
    const cam = this.cameras.main;
    // Convert pixel viewport to tile coordinates
    const x = Math.floor(cam.scrollX / TILE_SIZE);
    const y = Math.floor(cam.scrollY / TILE_SIZE);
    const width = Math.ceil(cam.width / (TILE_SIZE * cam.zoom));
    const height = Math.ceil(cam.height / (TILE_SIZE * cam.zoom));
    const key = `${x},${y},${width},${height}`;
    if (key === this.lastViewportKey) return;
    this.lastViewportKey = key;
    this.viewportThrottleTime = time;
    sendViewportUpdate(x, y, width, height);
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
    // Pre-compute which building index each tile belongs to (for floor tinting)
    const tileBuilding: (number | -1)[][] = Array.from({ length: MAP_HEIGHT }, () =>
      Array(MAP_WIDTH).fill(-1)
    );
    for (let bi = 0; bi < BUILDINGS.length; bi++) {
      const b = BUILDINGS[bi];
      for (let by = b.y; by < b.y + b.h; by++) {
        for (let bx = b.x; bx < b.x + b.w; bx++) {
          if (by >= 0 && by < MAP_HEIGHT && bx >= 0 && bx < MAP_WIDTH) {
            tileBuilding[by][bx] = bi;
          }
        }
      }
    }

    for (let y = 0; y < MAP_HEIGHT; y++) {
      for (let x = 0; x < MAP_WIDTH; x++) {
        const tileType = TILE_MAP[y]?.[x] ?? TILE_TYPES.GRASS;

        // Per-building floor color variant: buildingIndex % 3
        // variant 0 = default texture, 1 = _b1, 2 = _b2
        let texKey: string;
        if (
          (tileType === TILE_TYPES.FLOOR || tileType === TILE_TYPES.FLOOR_DARK) &&
          tileBuilding[y][x] >= 0
        ) {
          const bVariant = tileBuilding[y][x] % 3;
          const baseTex = TILE_TEXTURE_MAP[tileType] ?? 'tile_grass';
          if (bVariant === 0) {
            texKey = baseTex;
          } else {
            const candidateTex = `${baseTex}_b${bVariant}`;
            texKey = this.textures.exists(candidateTex) ? candidateTex : baseTex;
          }
        } else {
          // Non-floor tiles: use standard variant system
          const variant = (x * 7 + y * 13) % 3;
          const baseTex = TILE_TEXTURE_MAP[tileType] ?? 'tile_grass';
          const variantTex = `${baseTex}_${variant}`;
          texKey = this.textures.exists(variantTex) ? variantTex : baseTex;
        }

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

  // ── 2.5D wall depth: front face + side face + ground shadows ──
  private drawBuildingShadows(): void {
    const g = this.add.graphics();
    g.setDepth(1); // above floor, below furniture

    const FRONT_H = 12; // south-facing front face height (px)
    const SIDE_W = 8;   // east-facing side face width (px)
    const FRONT_COLOR = 0x8a7e70;  // warm tan (south face)
    const SIDE_COLOR = 0x9a8e80;   // lighter tan (east face)

    for (let y = 0; y < MAP_HEIGHT; y++) {
      for (let x = 0; x < MAP_WIDTH; x++) {
        const tile = TILE_MAP[y]?.[x];
        if (tile !== TILE_TYPES.WALL) continue;

        const below = TILE_MAP[y + 1]?.[x];
        const right = TILE_MAP[y]?.[x + 1];

        // East side face: darker strip on right edge of wall tile
        if (right !== undefined && right !== TILE_TYPES.WALL) {
          g.fillStyle(SIDE_COLOR, 1);
          g.fillRect(
            (x + 1) * TILE_SIZE - SIDE_W,
            y * TILE_SIZE,
            SIDE_W,
            TILE_SIZE
          );
          // Thin shadow to the right
          g.fillStyle(0x000000, 0.08);
          g.fillRect(
            (x + 1) * TILE_SIZE,
            y * TILE_SIZE,
            3,
            TILE_SIZE
          );
        }

        // South front face: darker strip on bottom edge of wall tile
        // (drawn after east so south wins at corners)
        if (below !== undefined && below !== TILE_TYPES.WALL) {
          // Front face gradient: lighter at top, darker at bottom
          const fr = (FRONT_COLOR >> 16) & 0xff;
          const fg = (FRONT_COLOR >> 8) & 0xff;
          const fb = FRONT_COLOR & 0xff;
          for (let fy = 0; fy < FRONT_H; fy++) {
            const py = (y + 1) * TILE_SIZE - FRONT_H + fy;
            const shade = 1 - (fy / FRONT_H) * 0.15; // darken toward bottom
            const c = (Math.round(fr * shade) << 16) | (Math.round(fg * shade) << 8) | Math.round(fb * shade);
            g.fillStyle(c, 1);
            g.fillRect(x * TILE_SIZE, py, TILE_SIZE, 1);
          }
          // Ground shadow below wall
          g.fillStyle(0x000000, 0.12);
          g.fillRect(
            x * TILE_SIZE,
            (y + 1) * TILE_SIZE,
            TILE_SIZE,
            5
          );
        }
      }
    }
  }

  // ── Building labels (12px, dark background panel, centered) ──
  private drawBuildingLabels(): void {
    for (const building of BUILDINGS) {
      if (!building.label) continue;
      const cx = (building.x + building.w / 2) * TILE_SIZE;
      const cy = (building.y + building.h / 2) * TILE_SIZE;

      // Create label text first to measure it
      const label = this.add.text(cx, cy, building.label, {
        fontSize: '12px',
        fontFamily: '"Press Start 2P", monospace',
        color: '#ffffff',
        resolution: 2,
      });
      label.setOrigin(0.5, 0.5);
      label.setDepth(2001);

      // Semi-transparent dark background panel
      const pad = 6;
      const bg = this.add.rectangle(
        cx, cy,
        label.width + pad * 2,
        label.height + pad * 2,
        0x000000, 0.55
      );
      bg.setOrigin(0.5, 0.5);
      bg.setDepth(2000);
    }
  }

  // ── Furniture ───────────────────────────────────────────
  private placeFurniture(): void {
    const BUILDING_TINTS: Record<string, number> = {
      'Church': 0xffe8c0, 'School': 0xe0e8f0, 'Cafe': 0xfff0d0,
      'Bakery': 0xffe0b0, 'Town Hall': 0xf0e8e0, 'Workshop': 0xd8d0c8,
      'Clinic': 0xf0f5ff, 'Tavern': 0xffd8a0, 'Market': 0xf8f0e0,
    };

    for (const item of FURNITURE) {
      const texKey = `furn_${item.type}`;
      if (!this.textures.exists(texKey)) continue;
      const img = this.add.image(
        item.x * TILE_SIZE + TILE_SIZE / 2,
        item.y * TILE_SIZE + TILE_SIZE / 2,
        texKey
      );
      img.setOrigin(0.5, 0.5);
      img.setDepth(item.y + 1);

      // Per-building tint
      for (const b of BUILDINGS) {
        if (item.x >= b.x && item.x < b.x + b.w && item.y >= b.y && item.y < b.y + b.h && b.label) {
          const tint = BUILDING_TINTS[b.label];
          if (tint) img.setTint(tint);
          break;
        }
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

    // Drag to pan — also stops following selected agent
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (pointer.isDown && pointer.button === 0 && !pointer.event.shiftKey) {
        const dx = pointer.x - pointer.prevPosition.x;
        const dy = pointer.y - pointer.prevPosition.y;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          cam.stopFollow();
        }
        cam.scrollX -= dx / cam.zoom;
        cam.scrollY -= dy / cam.zoom;
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
          // Skip dead agents
          if (agent.alive === false) continue;
          if (!this.agentSprites.has(agent.id)) {
            this.spawnAgent(agent);
          } else {
            const sprite = this.agentSprites.get(agent.id)!;
            sprite.moveToTile(agent.position.x, agent.position.y);
            if (agent.currentAction) sprite.setAction(agent.currentAction);
          }
        }
        if (snapshot.time) this.updateDayNight(snapshot.time);
      }),

      eventBus.on('agent:move', (data: { agentId: string; to: { x: number; y: number } }) => {
        const sprite = this.agentSprites.get(data.agentId);
        if (sprite) sprite.moveToTile(data.to.x, data.to.y);
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

      eventBus.on('agent:death', (data: { agentId: string; cause: string }) => {
        this.despawnAgent(data.agentId);
      }),

      eventBus.on('agent:leave', (data: { agentId: string }) => {
        this.despawnAgent(data.agentId);
      }),

      eventBus.on('world:time', (time: GameTime) => {
        this.updateDayNight(time);
      }),

      eventBus.on('agent:thought', (data: { agentId: string; thought: string }) => {
        const sprite = this.agentSprites.get(data.agentId);
        if (sprite) sprite.think(data.thought);
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
    if (agent.mood) agentSprite.setMood(agent.mood);
    this.agentSprites.set(agent.id, agentSprite);
  }

  private despawnAgent(agentId: string): void {
    const sprite = this.agentSprites.get(agentId);
    if (!sprite) return;

    // Fade out then destroy
    this.tweens.add({
      targets: sprite,
      alpha: 0,
      duration: 1500,
      onComplete: () => {
        sprite.destroy();
        this.agentSprites.delete(agentId);
      },
    });
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
      this.cameras.main.stopFollow();
      return;
    }

    this.selectedAgentId = agentId;
    gameStore.selectAgent(agentId);
    gameStore.inspectAgent(agentId);

    const sprite = this.agentSprites.get(agentId);
    if (sprite) {
      sprite.setSelected(true);
      const cam = this.cameras.main;
      // Offset to center agent in visible area (right of sidebar)
      const sidebarHalf = 210 / cam.zoom;
      cam.stopFollow();
      cam.startFollow(sprite, true, 0.06, 0.06);
      cam.followOffset.set(-sidebarHalf, 0);
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
