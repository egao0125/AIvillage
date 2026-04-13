import Phaser from 'phaser';
import { ARENA_MAP_WIDTH, ARENA_MAP_HEIGHT } from '../data/arena-map';
import { tileToScreen, isoDepth, isoWorldBounds } from '../iso';
import { AgentSprite, resolveCharacterModel } from '../entities/AgentSprite';
import { eventBus } from '../../core/EventBus';
import { gameStore } from '../../core/GameStore';
import { sendViewportUpdate } from '../../network/socket';
import { generateAgentTexture, agentColorsFromName } from './BootScene';
import { devPause } from '../../network/socket';
import type { Agent, GameTime } from '@ai-village/shared';

const KENNEY_SCALE = 0.25;
const KENNEY_ORIGIN_Y = 0.875;
const DEPTH_MUL = 10;
const CAMPFIRE_FRAMES = 13;

export class ArenaScene extends Phaser.Scene {
  private agentSprites: Map<string, AgentSprite> = new Map();
  private deadAgentIds: Set<string> = new Set();
  private selectedAgentId: string | null = null;
  private dayNightOverlay!: Phaser.GameObjects.Rectangle;
  private conversationGraphics!: Phaser.GameObjects.Graphics;
  private cleanupFns: (() => void)[] = [];
  private lastViewportKey: string = '';
  private viewportThrottleTime: number = 0;
  private cameraLerpTargetId: string | null = null;
  private nightAlpha: number = 0;
  private targetNightAlpha: number = 0;

  constructor() {
    super({ key: 'ArenaScene' });
  }

  create(): void {
    // Use isometric projection (same as VillageScene)
    AgentSprite.tileToWorld = tileToScreen;

    this.drawIsometricPlane();
    this.spawnForest();
    this.spawnCampfire();

    this.conversationGraphics = this.add.graphics();
    this.conversationGraphics.setDepth(9);

    // Day/night overlay — covers isometric diamond
    const wb = isoWorldBounds(ARENA_MAP_WIDTH, ARENA_MAP_HEIGHT);
    this.dayNightOverlay = this.add
      .rectangle(wb.centerX, wb.centerY, wb.width + 400, wb.height + 400, 0x000033, 0)
      .setDepth(5000);

    this.setupCamera();
    this.setupEventListeners();
    this.setupStoreSubscription();
    this.syncInitialState();

    // Pause sim until werewolf game is explicitly started
    devPause();
  }

  // ── Isometric grass plane ─────────────────────────────────
  private drawIsometricPlane(): void {
    const cx = ARENA_MAP_WIDTH / 2;
    const cy = ARENA_MAP_HEIGHT / 2;
    for (let y = 0; y < ARENA_MAP_HEIGHT; y++) {
      for (let x = 0; x < ARENA_MAP_WIDTH; x++) {
        const { x: sx, y: sy } = tileToScreen(x, y);
        // Darken grass near edges for forest floor feel
        const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
        const tint = dist > 10 ? 0x88bb88 : dist > 7 ? 0x99cc99 : 0xbbeebb;
        this.add.image(sx, sy, 'kenney_floor')
          .setScale(KENNEY_SCALE)
          .setOrigin(0.5, KENNEY_ORIGIN_Y)
          .setDepth(isoDepth(x, y) * DEPTH_MUL)
          .setTint(tint);
      }
    }
  }

  // ── Forest ring + scattered objects ──────────────────────
  private spawnForest(): void {
    const cx = ARENA_MAP_WIDTH / 2;
    const cy = ARENA_MAP_HEIGHT / 2;
    // Seeded RNG for deterministic placement
    let seed = 12345;
    const rng = () => { seed = (seed * 16807 + 0) % 2147483647; return (seed & 0x7fffffff) / 0x7fffffff; };

    // Tree frame indices: 0-11 (6 cols x 2 rows).
    // Excluded: 1=willow, 2=palm, 8=yellow/autumn, 10=birch2 (don't match forest vibe)
    const forestTrees = [0, 3, 6, 7, 9]; // pine, birch, pine2, round bush, bonsai
    // Object frame indices: 0-23 (8 cols x 3 rows)
    // Row 0: crates(0-3), chests(4-5), barrels(6-7)
    // Row 1: fences(8-12), bushes(13-14)
    // Row 2: rocks(16-23)
    const scatterObjects = [6, 7, 13, 14, 16, 17, 18, 19, 20]; // barrels, bushes, rocks

    // Dense tree ring: outer zone (dist > 9 from center)
    for (let y = 0; y < ARENA_MAP_HEIGHT; y++) {
      for (let x = 0; x < ARENA_MAP_WIDTH; x++) {
        const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);

        if (dist > 9 && rng() < 0.4) {
          // Dense forest
          const frame = forestTrees[Math.floor(rng() * forestTrees.length)];
          const { x: sx, y: sy } = tileToScreen(x, y);
          this.add.image(sx, sy, 'env_trees', frame)
            .setScale(0.18 + rng() * 0.06)
            .setOrigin(0.5, 0.9)
            .setDepth(isoDepth(x, y) * DEPTH_MUL + 3);
        } else if (dist > 7 && dist <= 9 && rng() < 0.25) {
          // Sparse tree border
          const frame = forestTrees[Math.floor(rng() * forestTrees.length)];
          const { x: sx, y: sy } = tileToScreen(x, y);
          this.add.image(sx, sy, 'env_trees', frame)
            .setScale(0.15 + rng() * 0.05)
            .setOrigin(0.5, 0.9)
            .setDepth(isoDepth(x, y) * DEPTH_MUL + 3);
        } else if (dist > 4 && dist <= 7 && rng() < 0.08) {
          // Scattered objects in mid zone (rocks, bushes, barrels)
          const frame = scatterObjects[Math.floor(rng() * scatterObjects.length)];
          const { x: sx, y: sy } = tileToScreen(x, y);
          this.add.image(sx, sy, 'env_objects', frame)
            .setScale(0.10 + rng() * 0.04)
            .setOrigin(0.5, 0.85)
            .setDepth(isoDepth(x, y) * DEPTH_MUL + 2);
        }
      }
    }
  }

  // ── Animated campfire at map center ──────────────────────
  private spawnCampfire(): void {
    const cx = Math.floor(ARENA_MAP_WIDTH / 2);
    const cy = Math.floor(ARENA_MAP_HEIGHT / 2);
    const { x: sx, y: sy } = tileToScreen(cx, cy);

    this.anims.create({
      key: 'campfire_burn',
      frames: Array.from({ length: CAMPFIRE_FRAMES }, (_, i) => ({ key: `campfire_${i}` })),
      frameRate: 8,
      repeat: -1,
    });

    // Orange glow — soft radial gradient, renders above night overlay as light
    const glowGfx = this.add.graphics();
    const glowRadius = 180;
    const steps = 60;
    for (let i = 0; i < steps; i++) {
      const t = i / steps; // 0 = outer, 1 = center
      const r = glowRadius * (1 - t);
      // Exponential falloff — soft outer edge, warm center
      const alpha = 0.15 * (t * t * t);
      glowGfx.fillStyle(0xff6600, alpha);
      glowGfx.fillCircle(glowRadius, glowRadius, r);
    }
    glowGfx.generateTexture('campfire_glow', glowRadius * 2, glowRadius * 2);
    glowGfx.destroy();

    // Campfire sprite — anchored to tile like other isometric objects
    const campfire = this.add.sprite(sx, sy, 'campfire_0')
      .play('campfire_burn')
      .setScale(0.25)
      .setOrigin(0.5, 0.6) // base of fire sits on tile
      .setDepth(isoDepth(cx, cy) * DEPTH_MUL + 3);

    // Glow centered on the campfire
    const glow = this.add.image(campfire.x, campfire.y, 'campfire_glow')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(5500)
      .setAlpha(0.8);

    this.tweens.add({
      targets: glow,
      alpha: { from: 0.5, to: 0.75 },
      duration: 1500,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }


  update(time: number, delta: number): void {
    for (const sprite of this.agentSprites.values()) {
      sprite.update(time, delta);
    }
    this.lerpNightAlpha();
    this.drawConversationLines();
    // Smooth camera lerp toward focused agent, then hand off to startFollow
    if (this.cameraLerpTargetId) {
      const sprite = this.agentSprites.get(this.cameraLerpTargetId);
      const cam = this.cameras.main;
      if (!sprite) {
        this.cameraLerpTargetId = null;
      } else {
        const sidebarPx = gameStore.getState().sidebarWidth;
        const sidebarOffset = (sidebarPx / 2) / cam.zoom;
        const verticalOffset = 80 / cam.zoom;
        const halfW = cam.width / 2;
        const halfH = cam.height / 2;
        const targetScrollX = sprite.x + sidebarOffset - halfW;
        const targetScrollY = sprite.y - verticalOffset - halfH;
        const dx = targetScrollX - cam.scrollX;
        const dy = targetScrollY - cam.scrollY;
        if (Math.abs(dx) < 2 && Math.abs(dy) < 2) {
          this.cameraLerpTargetId = null;
          cam.startFollow(sprite, true, 0.06, 0.06, -sidebarOffset, verticalOffset);
        } else {
          cam.scrollX = Phaser.Math.Linear(cam.scrollX, targetScrollX, 0.08);
          cam.scrollY = Phaser.Math.Linear(cam.scrollY, targetScrollY, 0.08);
        }
      }
    }
    this.emitViewportUpdate(time);
  }

  private emitViewportUpdate(time: number): void {
    if (time - this.viewportThrottleTime < 500) return;
    const cam = this.cameras.main;
    // Approximate tile viewport for server-side spatial filtering
    const x = Math.floor(cam.scrollX / 32);
    const y = Math.floor(cam.scrollY / 32);
    const width = Math.ceil(cam.width / (32 * cam.zoom));
    const height = Math.ceil(cam.height / (32 * cam.zoom));
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
  // ── Camera ──────────────────────────────────────────────────
  private setupCamera(): void {
    const wb = isoWorldBounds(ARENA_MAP_WIDTH, ARENA_MAP_HEIGHT);
    const cam = this.cameras.main;

    const fitZoom = Math.min(cam.width / wb.width, cam.height / wb.height);
    cam.setZoom(Math.max(fitZoom, 0.5));
    cam.centerOn(wb.centerX, wb.centerY);

    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (pointer.isDown && pointer.button === 0 && !pointer.event.shiftKey) {
        const dx = pointer.x - pointer.prevPosition.x;
        const dy = pointer.y - pointer.prevPosition.y;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          cam.stopFollow();
          this.cameraLerpTargetId = null;
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
        const oldZoom = cam.zoom;
        const newZoom = Phaser.Math.Clamp(oldZoom - deltaY * 0.001, 0.5, 5);
        if (newZoom === oldZoom) return;

        const sprite = this.selectedAgentId ? this.agentSprites.get(this.selectedAgentId) : null;
        if (sprite) {
          cam.setZoom(newZoom);
        } else {
          const midX = cam.scrollX + cam.width / 2;
          const midY = cam.scrollY + cam.height / 2;
          cam.setZoom(newZoom);
          cam.scrollX = midX - cam.width / 2;
          cam.scrollY = midY - cam.height / 2;
        }
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
        // Werewolf: keep dead agents visible in death pose (don't destroy)
        const sprite = this.agentSprites.get(data.agentId);
        if (sprite) {
          sprite.setDead(true);
          this.deadAgentIds.add(data.agentId);
        }
      }),

      eventBus.on('agent:leave', (data: { agentId: string }) => {
        this.despawnAgent(data.agentId);
      }),

      eventBus.on('world:time', (time: GameTime) => {
        this.updateDayNight(time);
      }),

      eventBus.on('agent:thought', (data: { agentId: string; thought: string }) => {
        if (data.agentId !== this.selectedAgentId) return;
        const sprite = this.agentSprites.get(data.agentId);
        if (sprite) sprite.think(data.thought);
      }),

      eventBus.on('agent:select', (agentId: string) => {
        this.selectAgent(agentId);
      }),

      eventBus.on('agent:focus', (agentId: string) => {
        if (this.selectedAgentId) {
          const prev = this.agentSprites.get(this.selectedAgentId);
          if (prev) prev.setSelected(false);
        }
        this.selectedAgentId = agentId;
        const sprite = this.agentSprites.get(agentId);
        if (sprite) {
          sprite.setSelected(true);
          this.cameras.main.stopFollow();
          this.cameraLerpTargetId = agentId;
        }
      }),

      eventBus.on('werewolf:phase', (data: { phase: string; round: number }) => {
        this.updateWerewolfRoleLabels();
        if (data.phase === 'night') {
          // deadAgentIds no longer used — agents despawn immediately on death
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
        // Revive all dead agents for the new game
        for (const sprite of this.agentSprites.values()) {
          sprite.setDead(false);
        }
        this.deadAgentIds.clear();
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
      gameStore.closeDetail();
      this.cameras.main.stopFollow();
      this.cameraLerpTargetId = null;
      return;
    }
    this.selectedAgentId = agentId;
    gameStore.selectAgent(agentId);
    gameStore.openAgentDetail(agentId);
    const sprite = this.agentSprites.get(agentId);
    if (sprite) {
      sprite.setSelected(true);
      this.cameras.main.stopFollow();
      this.cameraLerpTargetId = agentId;
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
    if (h < 5) this.targetNightAlpha = 0.9;
    else if (h < 6.5) this.targetNightAlpha = 0.9 * (1 - (h - 5) / 1.5);
    else if (h < 19) this.targetNightAlpha = 0;
    else if (h < 21) this.targetNightAlpha = 0.9 * ((h - 19) / 2) * 0.6;
    else if (h < 22.5) this.targetNightAlpha = 0.9 * 0.6 + 0.7 * 0.4 * ((h - 21) / 1.5);
    else this.targetNightAlpha = 0.9;
  }

  private lerpNightAlpha(): void {
    const diff = this.targetNightAlpha - this.nightAlpha;
    if (Math.abs(diff) > 0.002) {
      this.nightAlpha += diff * 0.03;
    } else {
      this.nightAlpha = this.targetNightAlpha;
    }
    this.dayNightOverlay.setFillStyle(0x000033, this.nightAlpha);
    this.dayNightOverlay.setAlpha(this.nightAlpha);
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
