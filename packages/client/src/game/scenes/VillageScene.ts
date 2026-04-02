import Phaser from 'phaser';
import { MAP_WIDTH, MAP_HEIGHT } from '../config';
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
import { tileToScreen, screenToTile, isoDepth, isoWorldBounds } from '../iso';
import type { Agent, GameTime } from '@ai-village/shared';

/** Kenney tile key + tint per terrain type.
 *  Tiles are 256×512 PNGs; we scale to 0.25 to match our 64×32 iso grid.
 *  Origin (0.5, 0.875) aligns the diamond base center with the tile position.
 *
 *  Depth layering (multiply isoDepth by 10 to create interleave slots):
 *    floor:      isoDepth * 10
 *    furniture:  isoDepth * 10 + 2
 *    trees/deco: isoDepth * 10 + 3
 *    agents:     isoDepth * 10 + 5
 *    walls:      isoDepth * 10 + 7  (occlude agents behind them)
 */
const KENNEY_SCALE = 0.25;
const KENNEY_ORIGIN_Y = 0.875;
const DEPTH_MUL = 10;

/** Parse CSS hex color to Phaser number */
const hex = (css: string) => parseInt(css.replace('#', ''), 16);

interface KenneyTileDef { key: string; tint?: number; yOffset?: number; depthBoost?: number }
const KENNEY_TILE_MAP: Record<number, KenneyTileDef> = {
  [TILE_TYPES.GRASS]:      { key: 'kenney_floor', tint: hex('#bbeebb') },
  [TILE_TYPES.PATH]:       { key: 'kenney_floor', tint: hex('#eeeadd') },
  [TILE_TYPES.WATER]:      { key: 'kenney_floor', tint: hex('#aaddee'), yOffset: 8 },
  [TILE_TYPES.SAND]:       { key: 'kenney_floor', tint: hex('#ffeeaa') },
  [TILE_TYPES.FLOOR]:      { key: 'kenney_floor', tint: hex('#faf5ee') },
  [TILE_TYPES.WALL]:       { key: 'kenney_block', tint: hex('#fffaf2'), depthBoost: 7 },
  [TILE_TYPES.FOREST]:     { key: 'kenney_floor', tint: hex('#99ddaa') },
  [TILE_TYPES.FLOWERS]:    { key: 'kenney_floor', tint: hex('#cceecc') },
  [TILE_TYPES.BRIDGE]:     { key: 'kenney_floor', tint: hex('#eeddaa') },
  [TILE_TYPES.FLOOR_DARK]: { key: 'kenney_floor', tint: hex('#e0d8cc') },
  [TILE_TYPES.CROP]:       { key: 'kenney_floor', tint: hex('#ccee88') },
};

export class VillageScene extends Phaser.Scene {
  private agentSprites: Map<string, AgentSprite> = new Map();
  private selectedAgentId: string | null = null;
  private agentClickedThisFrame = false;
  private dayNightOverlay!: Phaser.GameObjects.Rectangle;
  private conversationGraphics!: Phaser.GameObjects.Graphics;
  private cleanupFns: (() => void)[] = [];
  /** Objects rendered on a separate no-bloom camera */
  private uiObjects: Phaser.GameObjects.GameObject[] = [];
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
    this.conversationGraphics.setDepth(9999);

    // Day/night overlay — sized to isometric world bounds
    const wb = isoWorldBounds(MAP_WIDTH, MAP_HEIGHT);
    this.dayNightOverlay = this.add
      .rectangle(
        wb.centerX,
        wb.centerY,
        wb.width + 200, // extra padding so edges aren't visible
        wb.height + 200,
        0x000033,
        0
      )
      .setDepth(5000);

    this.setupCamera();
    this.setupEventListeners();
    this.syncInitialState();

    // Subtle bloom glow — main camera only (excludes UI text)
    if (this.cameras.main.postFX) {
      this.cameras.main.postFX.addBloom(0xffffff, 0.85, 0.15, 0.6, 1.5);
    }

    // No-bloom camera for text/agents: renders on top with transparent bg
    const main = this.cameras.main;
    const uiCam = this.cameras.add(0, 0, main.width, main.height);
    uiCam.transparent = true;
    uiCam.setScroll(main.scrollX, main.scrollY);
    uiCam.setZoom(main.zoom);

    // Main camera (bloom): hide UI text objects
    for (const obj of this.uiObjects) {
      main.ignore(obj);
    }

    // UI camera (clean): hide everything except UI text + agents
    // We hide all current children, then agents get added to uiCam as they spawn
    this.children.list.forEach((child) => {
      if (!this.uiObjects.includes(child)) {
        uiCam.ignore(child);
      }
    });
  }

  update(time: number, delta: number): void {
    for (const sprite of this.agentSprites.values()) {
      sprite.update(time, delta);
    }
    // Keep UI camera synced with main camera
    const uiCam = this.cameras.cameras[1];
    if (uiCam) {
      const main = this.cameras.main;
      uiCam.setScroll(main.scrollX, main.scrollY);
      uiCam.setZoom(main.zoom);
    }
    this.drawConversationLines();
    this.emitViewportUpdate(time);
  }

  /** Infra 6: Emit viewport rectangle to server, throttled to max once per 500ms and only on change */
  private emitViewportUpdate(time: number): void {
    if (time - this.viewportThrottleTime < 500) return;
    const cam = this.cameras.main;
    // Convert pixel viewport to tile coordinates via isometric inverse
    const topLeft = screenToTile(cam.scrollX, cam.scrollY);
    const botRight = screenToTile(
      cam.scrollX + cam.width / cam.zoom,
      cam.scrollY + cam.height / cam.zoom
    );
    const x = Math.floor(topLeft.x);
    const y = Math.floor(topLeft.y);
    const width = Math.ceil(botRight.x - topLeft.x);
    const height = Math.ceil(botRight.y - topLeft.y);
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
        const def = KENNEY_TILE_MAP[tileType] ?? { key: 'kenney_floor', tint: 0x88cc88 };
        const { x: sx, y: sy } = tileToScreen(x, y);
        const yOff = def.yOffset ?? 0;
        const depthBoost = def.depthBoost ?? 0;

        const img = this.add
          .image(sx, sy + yOff, def.key)
          .setScale(KENNEY_SCALE)
          .setOrigin(0.5, KENNEY_ORIGIN_Y)
          .setDepth(isoDepth(x, y) * DEPTH_MUL + depthBoost);

        if (def.tint) img.setTint(def.tint);
      }
    }
  }

  // ── Building shadows (disabled for isometric MVP) ──
  private drawBuildingShadows(): void {
    // TODO: Implement isometric wall extrusion / shadow rendering
  }

  // ── Building labels (12px, dark background panel, centered) ──
  private drawBuildingLabels(): void {
    for (const building of BUILDINGS) {
      if (!building.label) continue;
      const centerTileX = building.x + building.w / 2;
      const centerTileY = building.y + building.h / 2;
      const { x: cx, y: cy } = tileToScreen(centerTileX, centerTileY);

      // Create label text first to measure it
      const label = this.add.text(cx, cy, building.label, {
        fontSize: '12px',
        fontFamily: '"Press Start 2P", monospace',
        color: '#222222',
        stroke: '#ffffff',
        strokeThickness: 3,
        resolution: 2,
      });
      label.setOrigin(0.5, 0.5);
      label.setDepth(2001);

      // Semi-transparent background panel
      const pad = 6;
      const bg = this.add.rectangle(
        cx, cy,
        label.width + pad * 2,
        label.height + pad * 2,
        0xffffff, 0.6
      );
      bg.setOrigin(0.5, 0.5);
      bg.setDepth(2000);
      // Track for no-bloom camera
      this.uiObjects.push(label, bg);
    }
  }

  // ── Furniture (Kenney iso tiles) ─────────────────────────
  private placeFurniture(): void {
    // Map old furniture types → Kenney tile + tint
    const FURN_MAP: Record<string, { key: string; tint?: number }> = {
      table:      { key: 'kenney_slab',      tint: 0xcc9966 },
      chair:      { key: 'kenney_blockHalf',  tint: 0xbb8855 },
      counter:    { key: 'kenney_slab',      tint: 0xaa8866 },
      bookshelf:  { key: 'kenney_block',     tint: 0x886644 },
      bed:        { key: 'kenney_slab',      tint: 0x8899cc },
      oven:       { key: 'kenney_block',     tint: 0x666666 },
      workbench:  { key: 'kenney_slab',      tint: 0xaa8855 },
      barrel:     { key: 'kenney_crate',     tint: 0x886644 },
      altar:      { key: 'kenney_slab',      tint: 0xddddcc },
      desk:       { key: 'kenney_slab',      tint: 0xbb9966 },
      pew:        { key: 'kenney_blockHalf',  tint: 0x997755 },
      blackboard: { key: 'kenney_block',     tint: 0x334433 },
      anvil:      { key: 'kenney_crate',     tint: 0x555555 },
      fireplace:  { key: 'kenney_block',     tint: 0x884422 },
      crate:      { key: 'kenney_crate' },
    };

    for (const item of FURNITURE) {
      const def = FURN_MAP[item.type] ?? { key: 'kenney_crate' };
      const { x: sx, y: sy } = tileToScreen(item.x, item.y);
      const img = this.add.image(sx, sy, def.key);
      img.setScale(KENNEY_SCALE * 0.6);
      img.setOrigin(0.5, KENNEY_ORIGIN_Y);
      img.setDepth(isoDepth(item.x, item.y) * DEPTH_MUL + 2);
      if (def.tint) img.setTint(def.tint);
    }
  }

  // ── Trees (Kenney iso columns, tinted green) ──────────────
  private placeTrees(): void {
    const TREE_TINTS: Record<string, number> = {
      oak: 0x558833,
      pine: 0x336622,
      cherry: 0xcc6688,
    };

    for (const tree of TREES) {
      const { x: sx, y: sy } = tileToScreen(tree.x, tree.y);
      const img = this.add.image(sx, sy, 'kenney_column');
      img.setScale(KENNEY_SCALE * 0.8);
      img.setOrigin(0.5, KENNEY_ORIGIN_Y);
      img.setDepth(isoDepth(tree.x, tree.y) * DEPTH_MUL + 3);
      img.setTint(TREE_TINTS[tree.type] ?? 0x558833);
    }
  }

  // ── Decorations (Kenney iso crates/fences) ─────────────────
  private placeDecorations(): void {
    const DECO_MAP: Record<string, { key: string; tint?: number }> = {
      rock:     { key: 'kenney_crate',     tint: 0x888888 },
      mushroom: { key: 'kenney_crate',     tint: 0xcc6644 },
      bench:    { key: 'kenney_slab',      tint: 0x997755 },
      lantern:  { key: 'kenney_fence',     tint: 0xffcc44 },
    };

    for (const deco of DECORATIONS) {
      const def = DECO_MAP[deco.type] ?? { key: 'kenney_crate', tint: 0x888888 };
      const { x: sx, y: sy } = tileToScreen(deco.x, deco.y);
      const img = this.add.image(sx, sy, def.key);
      img.setScale(KENNEY_SCALE * 0.5);
      img.setOrigin(0.5, KENNEY_ORIGIN_Y);
      img.setDepth(isoDepth(deco.x, deco.y) * DEPTH_MUL + 3);
      if (def.tint) img.setTint(def.tint);
    }
  }

  // ── Camera ────────────────────────────────────────────────
  private setupCamera(): void {
    const wb = isoWorldBounds(MAP_WIDTH, MAP_HEIGHT);

    // No camera bounds — allow free panning
    const cam = this.cameras.main;

    // Initial zoom: fit the entire isometric diamond in view
    const fitZoom = Math.min(cam.width / wb.width, cam.height / wb.height);
    cam.setZoom(Math.max(fitZoom, 0.5));
    cam.centerOn(wb.centerX, wb.centerY);

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

    // Click background to deselect agent
    this.input.on('pointerup', (pointer: Phaser.Input.Pointer) => {
      // Skip if an agent was clicked in this same event cycle
      if (this.agentClickedThisFrame) {
        this.agentClickedThisFrame = false;
        return;
      }
      // Only deselect on short clicks (not drags), left button
      if (pointer.button !== 0) return;
      const dx = Math.abs(pointer.x - pointer.downX);
      const dy = Math.abs(pointer.y - pointer.downY);
      if (dx > 5 || dy > 5) return; // was a drag, not a click
      if (this.selectedAgentId) {
        const prev = this.agentSprites.get(this.selectedAgentId);
        if (prev) prev.setSelected(false);
        this.selectedAgentId = null;
        gameStore.selectAgent(null);
        gameStore.closeDetail();
        this.cameras.main.stopFollow();
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

    // Generate a unique texture for this agent based on their name (fallback)
    const texKey = `agent_${agent.id}`;
    const { shirt, hair } = agentColorsFromName(agent.config.name);
    if (!this.textures.exists(texKey)) {
      generateAgentTexture(this, texKey, shirt, hair);
    }

    const agentSprite = new AgentSprite(
      this,
      agent.id,
      agent.config.name,
      texKey,
      agent.position.x,
      agent.position.y,
      shirt // tint color for astronaut sprite differentiation
    );
    if (agent.currentAction) agentSprite.setAction(agent.currentAction);
    if (agent.mood) agentSprite.setMood(agent.mood);
    this.agentSprites.set(agent.id, agentSprite);

  }

  private despawnAgent(agentId: string): void {
    const sprite = this.agentSprites.get(agentId);
    if (!sprite) return;

    // Play death animation then destroy
    sprite.die().then(() => {
      sprite.destroy();
      this.agentSprites.delete(agentId);
    });
  }

  private selectAgent(agentId: string): void {
    this.agentClickedThisFrame = true;

    // Deselect previous
    if (this.selectedAgentId) {
      const prev = this.agentSprites.get(this.selectedAgentId);
      if (prev) prev.setSelected(false);
    }

    // Toggle off if same agent
    if (this.selectedAgentId === agentId) {
      this.selectedAgentId = null;
      gameStore.selectAgent(null);
      gameStore.closeDetail();
      this.cameras.main.stopFollow();
      return;
    }

    this.selectedAgentId = agentId;
    gameStore.selectAgent(agentId);
    gameStore.openAgentDetail(agentId);

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
