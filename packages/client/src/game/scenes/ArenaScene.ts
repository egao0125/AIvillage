import Phaser from 'phaser';
import {
  ARENA_TILE_MAP,
  ARENA_TILE_TYPES,
  ARENA_MAP_WIDTH,
  ARENA_MAP_HEIGHT,
  ARENA_LOCATIONS,
} from '../data/arena-map';
import { AgentSprite } from '../entities/AgentSprite';
import { eventBus } from '../../core/EventBus';
import { gameStore } from '../../core/GameStore';
import { sendViewportUpdate } from '../../network/socket';
import { generateAgentTexture, agentColorsFromName } from './BootScene';
import type { Agent, GameTime } from '@ai-village/shared';

const TILE_SIZE = 32;

// Base texture names (without variant suffix)
const ARENA_TILE_BASE_TEXTURES: Record<number, string> = {
  [ARENA_TILE_TYPES.WATER]: 'arena_ocean',
  [ARENA_TILE_TYPES.SAND]: 'arena_beach',
  [ARENA_TILE_TYPES.OPEN]: 'arena_ground',
  [ARENA_TILE_TYPES.JUNGLE]: 'arena_jungle',
  [ARENA_TILE_TYPES.HIGH_GROUND]: 'arena_rock',
  [ARENA_TILE_TYPES.WALL]: 'arena_ruin_wall',
  [ARENA_TILE_TYPES.SHALLOW_WATER]: 'arena_shallow',
  [ARENA_TILE_TYPES.RUIN_FLOOR]: 'arena_ruin_floor',
  [ARENA_TILE_TYPES.MANGROVE]: 'arena_mangrove',
  [ARENA_TILE_TYPES.CAVE]: 'arena_cave',
};

function getArenaTileTexture(tileType: number, x: number, y: number): string {
  const base = ARENA_TILE_BASE_TEXTURES[tileType] ?? 'arena_ocean';
  const variant = (x * 7 + y * 13) % 3;
  return `${base}_${variant}`;
}

// ── Color helpers (inlined for ArenaScene use) ──────────────
function darken(c: number, amt: number): number {
  const r = Math.max(0, Math.round(((c >> 16) & 0xff) * (1 - amt)));
  const g = Math.max(0, Math.round(((c >> 8) & 0xff) * (1 - amt)));
  const b = Math.max(0, Math.round((c & 0xff) * (1 - amt)));
  return (r << 16) | (g << 8) | b;
}

function lighten(c: number, amt: number): number {
  const r = Math.min(255, Math.round(((c >> 16) & 0xff) + (255 - ((c >> 16) & 0xff)) * amt));
  const g = Math.min(255, Math.round(((c >> 8) & 0xff) + (255 - ((c >> 8) & 0xff)) * amt));
  const b = Math.min(255, Math.round((c & 0xff) + (255 - (c & 0xff)) * amt));
  return (r << 16) | (g << 8) | b;
}

export class ArenaScene extends Phaser.Scene {
  private agentSprites: Map<string, AgentSprite> = new Map();
  private selectedAgentId: string | null = null;
  private dayNightOverlay!: Phaser.GameObjects.Rectangle;
  private conversationGraphics!: Phaser.GameObjects.Graphics;
  private cleanupFns: (() => void)[] = [];
  private lastViewportKey: string = '';
  private viewportThrottleTime: number = 0;

  constructor() {
    super({ key: 'ArenaScene' });
  }

  create(): void {
    this.drawTileMap();
    this.drawEdgeTransitions();
    this.drawDecorations();
    this.drawLocationLabels();

    this.conversationGraphics = this.add.graphics();
    this.conversationGraphics.setDepth(9);

    this.dayNightOverlay = this.add
      .rectangle(
        (ARENA_MAP_WIDTH * TILE_SIZE) / 2,
        (ARENA_MAP_HEIGHT * TILE_SIZE) / 2,
        ARENA_MAP_WIDTH * TILE_SIZE,
        ARENA_MAP_HEIGHT * TILE_SIZE,
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

  private emitViewportUpdate(time: number): void {
    if (time - this.viewportThrottleTime < 500) return;
    const cam = this.cameras.main;
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

      const midX = (s1.x + s2.x) / 2;
      const midY = Math.min(s1.y, s2.y) - 12;

      this.conversationGraphics.lineStyle(3, 0xffd700, 0.25);
      this.conversationGraphics.beginPath();
      this.conversationGraphics.moveTo(s1.x, s1.y - 10);
      this.conversationGraphics.lineTo(midX, midY);
      this.conversationGraphics.lineTo(s2.x, s2.y - 10);
      this.conversationGraphics.strokePath();

      this.conversationGraphics.lineStyle(1, 0xffd700, 0.6);
      this.conversationGraphics.beginPath();
      this.conversationGraphics.moveTo(s1.x, s1.y - 10);
      this.conversationGraphics.lineTo(midX, midY);
      this.conversationGraphics.lineTo(s2.x, s2.y - 10);
      this.conversationGraphics.strokePath();

      this.conversationGraphics.fillStyle(0xffd700, 0.5);
      this.conversationGraphics.fillCircle(midX, midY, 3);
    }
  }

  // ── Tilemap ─────────────────────────────────────────────────
  private drawTileMap(): void {
    for (let y = 0; y < ARENA_MAP_HEIGHT; y++) {
      for (let x = 0; x < ARENA_MAP_WIDTH; x++) {
        const tileType = ARENA_TILE_MAP[y]?.[x] ?? ARENA_TILE_TYPES.WATER;
        const texKey = getArenaTileTexture(tileType, x, y);

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

  // ── Edge transitions ───────────────────────────────────────
  private drawEdgeTransitions(): void {
    const g = this.add.graphics();
    g.setDepth(1); // just above tiles

    // Define edge colors for each terrain type
    const terrainEdgeColor: Record<number, number> = {
      [ARENA_TILE_TYPES.WATER]: 0x0f2b3e,
      [ARENA_TILE_TYPES.SAND]: 0xc4a060,
      [ARENA_TILE_TYPES.OPEN]: 0x5a7a3a,
      [ARENA_TILE_TYPES.JUNGLE]: 0x1a4a28,
      [ARENA_TILE_TYPES.HIGH_GROUND]: 0x6a6a62,
      [ARENA_TILE_TYPES.WALL]: 0x4a4a42,
      [ARENA_TILE_TYPES.SHALLOW_WATER]: 0x2a6a7a,
      [ARENA_TILE_TYPES.RUIN_FLOOR]: 0x4a4a42,
      [ARENA_TILE_TYPES.MANGROVE]: 0x1a3a20,
      [ARENA_TILE_TYPES.CAVE]: 0x1a1a1e,
    };

    for (let y = 0; y < ARENA_MAP_HEIGHT; y++) {
      for (let x = 0; x < ARENA_MAP_WIDTH; x++) {
        const current = ARENA_TILE_MAP[y]?.[x] ?? 0;

        // Check each neighbor
        const south = y + 1 < ARENA_MAP_HEIGHT ? (ARENA_TILE_MAP[y + 1]?.[x] ?? 0) : current;
        const north = y - 1 >= 0 ? (ARENA_TILE_MAP[y - 1]?.[x] ?? 0) : current;
        const east = x + 1 < ARENA_MAP_WIDTH ? (ARENA_TILE_MAP[y]?.[x + 1] ?? 0) : current;
        const west = x - 1 >= 0 ? (ARENA_TILE_MAP[y]?.[x - 1] ?? 0) : current;

        const baseX = x * TILE_SIZE;
        const baseY = y * TILE_SIZE;

        // Blend 3 pixel rows/cols at terrain boundaries
        if (south !== current) {
          const c = terrainEdgeColor[south] ?? 0x0f2b3e;
          for (let row = 0; row < 3; row++) {
            const alpha = (row + 1) / 4; // 0.25, 0.5, 0.75
            g.fillStyle(c, alpha);
            g.fillRect(baseX, baseY + TILE_SIZE - 3 + row, TILE_SIZE, 1);
          }
        }
        if (north !== current) {
          const c = terrainEdgeColor[north] ?? 0x0f2b3e;
          for (let row = 0; row < 3; row++) {
            const alpha = (3 - row) / 4;
            g.fillStyle(c, alpha);
            g.fillRect(baseX, baseY + row, TILE_SIZE, 1);
          }
        }
        if (east !== current) {
          const c = terrainEdgeColor[east] ?? 0x0f2b3e;
          for (let col = 0; col < 3; col++) {
            const alpha = (col + 1) / 4;
            g.fillStyle(c, alpha);
            g.fillRect(baseX + TILE_SIZE - 3 + col, baseY, 1, TILE_SIZE);
          }
        }
        if (west !== current) {
          const c = terrainEdgeColor[west] ?? 0x0f2b3e;
          for (let col = 0; col < 3; col++) {
            const alpha = (3 - col) / 4;
            g.fillStyle(c, alpha);
            g.fillRect(baseX + col, baseY, 1, TILE_SIZE);
          }
        }
      }
    }
  }

  // ── Decorative objects ────────────────────────────────────
  private drawDecorations(): void {
    // Seeded PRNG for deterministic decoration placement
    let seed = 12345;
    const rand = () => { seed = (seed * 16807) % 2147483647; return (seed & 0x7fffffff) / 0x7fffffff; };

    for (let y = 0; y < ARENA_MAP_HEIGHT; y++) {
      for (let x = 0; x < ARENA_MAP_WIDTH; x++) {
        const tile = ARENA_TILE_MAP[y]?.[x] ?? 0;
        const wx = x * TILE_SIZE;
        const wy = y * TILE_SIZE;

        // Palm trees on beach tiles (10% chance)
        if (tile === ARENA_TILE_TYPES.SAND && rand() < 0.10) {
          this.drawPalmTree(wx + TILE_SIZE / 2, wy + TILE_SIZE / 2);
        }

        // Rocks on high ground (15% chance)
        if (tile === ARENA_TILE_TYPES.HIGH_GROUND && rand() < 0.15) {
          this.drawRockCluster(wx + Math.floor(rand() * 20) + 6, wy + Math.floor(rand() * 20) + 6);
        }

        // Broken columns in ruin floor (8% chance)
        if (tile === ARENA_TILE_TYPES.RUIN_FLOOR && rand() < 0.08) {
          this.drawBrokenColumn(wx + Math.floor(rand() * 18) + 7, wy + Math.floor(rand() * 18) + 7);
        }
      }
    }
  }

  private drawPalmTree(x: number, y: number): void {
    const g = this.add.graphics();
    // Curved trunk (brown arc)
    g.fillStyle(0x6a4a2a);
    for (let i = 0; i < 16; i++) {
      const tx = x + Math.round(Math.sin(i * 0.15) * 3);
      g.fillRect(tx, y - i, 2, 1);
    }
    // Fronds (4 green fan shapes at top)
    const frondColor = 0x2a6a28;
    const topY = y - 16;
    for (let f = 0; f < 4; f++) {
      const angle = (f / 4) * Math.PI * 2 - Math.PI / 2;
      for (let i = 0; i < 8; i++) {
        const fx = x + Math.round(Math.cos(angle) * i * 1.2);
        const fy = topY + Math.round(Math.sin(angle) * i * 0.8);
        g.fillStyle(i < 4 ? frondColor : darken(frondColor, 0.15));
        g.fillRect(fx, fy, 2, 1);
        if (i > 2) g.fillRect(fx, fy + 1, 1, 1); // thicker at tips
      }
    }
    g.setDepth(3);
  }

  private drawRockCluster(x: number, y: number): void {
    const g = this.add.graphics();
    // 2-3 small gray irregular shapes
    const colors = [0x7a7a72, 0x6a6a62, 0x5a5a52];
    for (let i = 0; i < 3; i++) {
      const rx = x + i * 3 - 3;
      const ry = y + (i % 2) * 2;
      const c = colors[i % colors.length];
      g.fillStyle(c);
      g.fillRect(rx, ry, 3 + (i % 2), 2 + (i % 2));
      g.fillStyle(lighten(c, 0.2));
      g.fillRect(rx, ry, 3 + (i % 2), 1); // top highlight
    }
    g.setDepth(3);
  }

  private drawBrokenColumn(x: number, y: number): void {
    const g = this.add.graphics();
    // Short gray rectangle with irregular top
    g.fillStyle(0x6a6a60);
    g.fillRect(x, y, 4, 8);
    g.fillStyle(0x8a8a80); // highlight
    g.fillRect(x, y, 4, 1);
    // Irregular top (broken off)
    g.fillStyle(0x5a5a52);
    g.fillRect(x + 1, y - 1, 2, 1);
    g.fillRect(x + 3, y, 1, 1); // chip
    g.setDepth(3);
  }

  // ── Location labels ─────────────────────────────────────────
  private drawLocationLabels(): void {
    for (const loc of ARENA_LOCATIONS) {
      const cx = (loc.x + loc.width / 2) * TILE_SIZE;
      const cy = (loc.y + loc.height / 2) * TILE_SIZE;

      const label = this.add.text(cx, cy, loc.name, {
        fontSize: '10px',
        fontFamily: '"Press Start 2P", monospace',
        color: '#ffffff',
        resolution: 2,
      });
      label.setOrigin(0.5, 0.5);
      label.setDepth(2001);

      const pad = 4;
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

  // ── Camera ──────────────────────────────────────────────────
  private setupCamera(): void {
    const worldW = ARENA_MAP_WIDTH * TILE_SIZE;
    const worldH = ARENA_MAP_HEIGHT * TILE_SIZE;
    const cam = this.cameras.main;

    const fitZoom = Math.min(cam.width / worldW, cam.height / worldH);
    cam.setZoom(Math.max(fitZoom, 0.5));
    cam.centerOn(worldW / 2, worldH / 2);

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

  // ── Event listeners ─────────────────────────────────────────
  private setupEventListeners(): void {
    this.cleanupFns.push(
      eventBus.on('world:snapshot', (snapshot: { agents: Agent[]; time?: GameTime }) => {
        for (const agent of snapshot.agents) {
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

  // ── Agent management ────────────────────────────────────────
  private spawnAgent(agent: Agent): void {
    if (this.agentSprites.has(agent.id)) return;
    const texKey = `agent_${agent.id}`;
    if (!this.textures.exists(texKey)) {
      const { shirt, hair } = agentColorsFromName(agent.config.name);
      generateAgentTexture(this, texKey, shirt, hair);
    }
    const agentSprite = new AgentSprite(
      this, agent.id, agent.config.name, texKey,
      agent.position.x, agent.position.y
    );
    if (agent.currentAction) agentSprite.setAction(agent.currentAction);
    this.agentSprites.set(agent.id, agentSprite);
  }

  private despawnAgent(agentId: string): void {
    const sprite = this.agentSprites.get(agentId);
    if (!sprite) return;
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
    if (this.selectedAgentId) {
      const prev = this.agentSprites.get(this.selectedAgentId);
      if (prev) prev.setSelected(false);
    }
    if (this.selectedAgentId === agentId) {
      this.selectedAgentId = null;
      gameStore.selectAgent(null);
      this.cameras.main.stopFollow();
      return;
    }
    this.selectedAgentId = agentId;
    gameStore.selectAgent(agentId);
    const sprite = this.agentSprites.get(agentId);
    if (sprite) {
      sprite.setSelected(true);
      const cam = this.cameras.main;
      const sidebarHalf = 210 / cam.zoom;
      cam.stopFollow();
      cam.startFollow(sprite, true, 0.06, 0.06);
      cam.followOffset.set(-sidebarHalf, 0);
    }
  }

  // ── Day/night ───────────────────────────────────────────────
  private updateDayNight(time: GameTime): void {
    const h = time.hour + time.minute / 60;
    let alpha = 0;
    if (h < 5) alpha = 0.3;
    else if (h < 7) alpha = 0.3 - ((h - 5) / 2) * 0.3;
    else if (h < 18) alpha = 0;
    else if (h < 20) alpha = ((h - 18) / 2) * 0.2;
    else alpha = 0.2 + ((h - 20) / 4) * 0.1;

    this.dayNightOverlay.setAlpha(alpha);
    if (h < 5 || h >= 20) this.dayNightOverlay.setFillStyle(0x000033, alpha);
    else if (h < 7) this.dayNightOverlay.setFillStyle(0x331a00, alpha);
    else if (h >= 18) this.dayNightOverlay.setFillStyle(0x1a0033, alpha);
  }

  // ── Initial sync ────────────────────────────────────────────
  private syncInitialState(): void {
    const state = gameStore.getState();
    for (const agent of state.agents.values()) {
      this.spawnAgent(agent);
    }
    if (state.time) this.updateDayNight(state.time);
  }

  shutdown(): void {
    this.cleanupFns.forEach((fn) => fn());
    this.cleanupFns = [];
    this.agentSprites.clear();
  }
}
