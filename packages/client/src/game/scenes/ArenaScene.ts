import Phaser from 'phaser';
import {
  ARENA_MAP_WIDTH,
  ARENA_MAP_HEIGHT,
  ARENA_LOCATIONS,
} from '../data/arena-map';
import { AgentSprite, resolveCharacterModel } from '../entities/AgentSprite';
import { eventBus } from '../../core/EventBus';
import { gameStore } from '../../core/GameStore';
import { sendViewportUpdate } from '../../network/socket';
import { generateAgentTexture, agentColorsFromName } from './BootScene';
import type { Agent, GameTime } from '@ai-village/shared';

const TILE_SIZE = 32; // display size (16px source tiles scaled 2x)

export class ArenaScene extends Phaser.Scene {
  private agentSprites: Map<string, AgentSprite> = new Map();
  private deadAgentIds: Set<string> = new Set();
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
    // Arena uses top-down orthogonal projection, not isometric
    AgentSprite.tileToWorld = (tx, ty) => ({ x: tx * TILE_SIZE + TILE_SIZE / 2, y: ty * TILE_SIZE + TILE_SIZE / 2 });

    this.createTilemap();
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
    this.setupStoreSubscription();
    this.syncInitialState();
  }

  // ── Tilemap — Tiled JSON loaded in BootScene ──────────────
  private createTilemap(): void {
    const map = this.make.tilemap({ key: 'arena-map' });

    const tilesets = [
      map.addTilesetImage('Tileset_Ground', 'Tileset_Ground'),
      map.addTilesetImage('Tileset_Sand', 'Tileset_Sand'),
      map.addTilesetImage('Tileset_Road', 'Tileset_Road'),
      map.addTilesetImage('Atlas_Trees_Bushes', 'Atlas_Trees_Bushes'),
      map.addTilesetImage('Atlas_Rocks', 'Atlas_Rocks'),
      map.addTilesetImage('Tileset_Shadow', 'Tileset_Shadow'),
      map.addTilesetImage('Atlas_Buildings_Blue', 'Atlas_Buildings_Blue'),
      map.addTilesetImage('Atlas_Buildings_Orange', 'Atlas_Buildings_Orange'),
      map.addTilesetImage('Atlas_Buildings_Green', 'Atlas_Buildings_Green'),
      map.addTilesetImage('Atlas_Buildings_Hay', 'Atlas_Buildings_Hay'),
      map.addTilesetImage('Atlas_Buildings_Red', 'Atlas_Buildings_Red'),
    ].filter((ts): ts is Phaser.Tilemaps.Tileset => ts !== null);

    if (tilesets.length === 0) {
      console.error('[ArenaScene] No tilesets loaded — map will be blank');
      return;
    }

    // Create all layers from the TMJ dynamically (user may add more in Tiled)
    // Depth: Ground=0, Vegetation=1, Structures=2 (agents at 10, labels at 2000+)
    for (let i = 0; i < map.layers.length; i++) {
      const layerData = map.layers[i];
      const layer = map.createLayer(layerData.name, tilesets);
      if (layer) {
        layer.setScale(2); // 16px tiles → 32px display
        layer.setDepth(i);
      }
    }

    console.log(`[ArenaScene] Tilemap created: ${map.layers.length} layer(s), ${tilesets.length} tileset(s)`);
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
        const isWerewolf = !!gameStore.getState().werewolfPhase;
        for (const agent of snapshot.agents) {
          if (agent.alive === false && !isWerewolf) continue;
          if (!this.agentSprites.has(agent.id)) {
            this.spawnAgent(agent);
            if (agent.alive === false) {
              const sprite = this.agentSprites.get(agent.id);
              if (sprite) {
                sprite.setDead(true);
                this.deadAgentIds.add(agent.id);
              }
            }
          } else {
            const sprite = this.agentSprites.get(agent.id)!;
            if (agent.state === 'sleeping') {
              sprite.sleep();
            } else {
              sprite.moveToTile(agent.position.x, agent.position.y);
            }
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
        // In werewolf mode, show dead agents as dimmed bodies instead of removing them
        if (gameStore.getState().werewolfPhase) {
          const sprite = this.agentSprites.get(data.agentId);
          if (sprite) {
            sprite.setDead(true);
            this.deadAgentIds.add(data.agentId);
          }
        } else {
          this.despawnAgent(data.agentId);
        }
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
      }),

      eventBus.on('werewolf:phase', (data: { phase: string; round: number }) => {
        this.updateWerewolfRoleLabels();
        // Clear dead bodies at night start
        if (data.phase === 'night') {
          for (const deadId of this.deadAgentIds) {
            this.despawnAgent(deadId);
          }
          this.deadAgentIds.clear();
        }
      }),

      eventBus.on('werewolf:reveal', (_data: { agentId: string; role: string }) => {
        this.updateWerewolfRoleLabels();
      }),

      eventBus.on('werewolf:newGame', () => {
        this.updateWerewolfRoleLabels();
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
    const charModel = resolveCharacterModel(agent.config.spriteId, agent.config.name);
    const agentSprite = new AgentSprite(
      this, agent.id, agent.config.name, texKey,
      agent.position.x, agent.position.y, charModel,
    );
    if (agent.currentAction) agentSprite.setAction(agent.currentAction);
    this.agentSprites.set(agent.id, agentSprite);
  }

  private despawnAgent(agentId: string): void {
    const sprite = this.agentSprites.get(agentId);
    if (!sprite) return;

    sprite.die().then(() => {
      sprite.destroy();
      this.agentSprites.delete(agentId);
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

  // ── Werewolf god mode role labels ────────────────────────────
  private lastGodMode: boolean = false;

  private updateWerewolfRoleLabels(): void {
    const state = gameStore.getState();
    const godMode = state.werewolfGodMode;
    const roles = state.werewolfRoles;

    for (const [agentId, sprite] of this.agentSprites) {
      const role = roles.get(agentId) ?? null;
      sprite.setRole(role, godMode);
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
  private setupStoreSubscription(): void {
    const unsub = gameStore.subscribe(() => {
      const godMode = gameStore.getState().werewolfGodMode;
      if (godMode !== this.lastGodMode) {
        this.lastGodMode = godMode;
        this.updateWerewolfRoleLabels();
      }
    });
    this.cleanupFns.push(unsub);
  }


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
