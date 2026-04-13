import Phaser from 'phaser';
import { SpeechBubble } from './SpeechBubble';
import { ThoughtBubble } from './ThoughtBubble';
import { eventBus } from '../../core/EventBus';
import { TILE_SIZE } from '../config';
import { tileToScreen, isoDepth } from '../iso';
import {
  type CharacterModel, CHARACTER_MODELS, modelToPrefix, is8Dir,
  STRIP_DISPLAY_SCALE, FOX_DISPLAY_SCALE, DOG_DISPLAY_SCALE, GIRL_DISPLAY_SCALE,
  MODEL_Y_OFFSET,
} from '../data/sprite-config';

const LERP_SPEED = 0.08;
const NAME_FONT_SIZE = 6;
const ACTION_FONT_SIZE = 5;

export { CharacterModel };

/** Pick a deterministic character model from the agent name (fallback when spriteId is 'default'). */
export function characterModelFromName(name: string): CharacterModel {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return CHARACTER_MODELS[Math.abs(hash) % CHARACTER_MODELS.length];
}

/** Resolve spriteId from agent config to a CharacterModel. */
export function resolveCharacterModel(spriteId: string | undefined, name: string): CharacterModel {
  if (spriteId && spriteId !== 'default' && (CHARACTER_MODELS as string[]).includes(spriteId)) {
    return spriteId as CharacterModel;
  }
  return characterModelFromName(name);
}

// ── Direction helpers ─────────────────────────────────────────────

/**
 * For 5-direction strip characters: map screen delta to dir (0-4) + flipX.
 * Sheet: 0=S, 1=SE, 2=E, 3=NE, 4=N. Mirror: SW=flip(SE), W=flip(E), NW=flip(NE).
 */
function angleTo5Dir(dx: number, dy: number): { dir: number; flip: boolean } {
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return { dir: 0, flip: false };
  const sector = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  switch (sector) {
    case 2:  return { dir: 0, flip: false }; // S
    case 1:  return { dir: 1, flip: false }; // SE
    case 0:  return { dir: 2, flip: false }; // E
    case -1: return { dir: 3, flip: false }; // NE
    case -2: return { dir: 4, flip: false }; // N
    case -3: return { dir: 3, flip: true };  // NW
    case -4: case 4: return { dir: 2, flip: true }; // W
    case 3:  return { dir: 1, flip: true };  // SW
    default: return { dir: 0, flip: false };
  }
}

/**
 * For 8-direction characters (fox, dog): map screen delta to dir (1-8), no flipX.
 * Fox/dog dirs: 1=DL(SW), 2=L(W), 3=UL(NW), 4=U(N), 5=UR(NE), 6=R(E), 7=DR(SE), 8=D(S)
 */
function angleTo8Dir(dx: number, dy: number): number {
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return 8; // default: S (down)
  const sector = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  switch (sector) {
    case 2:  return 8; // S
    case 1:  return 7; // SE
    case 0:  return 6; // E
    case -1: return 5; // NE
    case -2: return 4; // N
    case -3: return 3; // NW
    case -4: case 4: return 2; // W
    case 3:  return 1; // SW
    default: return 8;
  }
}

// ── AgentSprite ───────────────────────────────────────────────────

export class AgentSprite extends Phaser.GameObjects.Container {
  private sprite: Phaser.GameObjects.Sprite | Phaser.GameObjects.Image;
  private nameLabel: Phaser.GameObjects.Text;
  private actionLabel: Phaser.GameObjects.Text;
  private roleLabel: Phaser.GameObjects.Text | null = null;
  private speechBubble: SpeechBubble;
  private thoughtBubble: ThoughtBubble;
  private selectionRing: Phaser.GameObjects.Graphics;
  private moodRing: Phaser.GameObjects.Graphics;
  private targetX: number;
  private targetY: number;
  private isLerping: boolean = false;
  private isSleeping: boolean = false;
  private targetTileX: number;
  private targetTileY: number;
  private sourceTileX: number;
  private sourceTileY: number;
  private movementDepth: number = 0;   // cached depth during lerp
  private labelsDirty: boolean = true; // skip syncLabels when stationary
  private readonly tilePos = { x: 0, y: 0 }; // reusable object for getTilePos
  agentId: string;

  // Character model state
  private charModel: CharacterModel;
  private prefix: string;        // texture prefix (e.g. 'astro', 'fox')
  private useAnimated: boolean;   // whether animated sprite is available
  private isDead: boolean = false; // dead agents ignore movement/action updates
  private uses8Dir: boolean;      // 8-dir system (fox, dog) vs 5-dir+flip
  private currentDir5: number = 0;  // current 5-dir direction (0-4)
  private currentDir8: number = 8;  // current 8-dir direction (1-8)

  /** Override tile→pixel projection (default: isometric). Set before constructing for orthogonal maps. */
  static tileToWorld: (tx: number, ty: number) => { x: number; y: number } = tileToScreen;

  private static readonly MOOD_COLORS: Record<string, number> = {
    neutral: 0x9ca3af, happy: 0x4ade80, angry: 0xef4444, sad: 0x60a5fa,
    anxious: 0xfbbf24, excited: 0xf97316, scheming: 0xa855f7, afraid: 0x94a3b8,
  };

  constructor(
    scene: Phaser.Scene,
    agentId: string,
    name: string,
    spriteKey: string,
    tileX: number,
    tileY: number,
    charModel: CharacterModel,
    _tintColor?: number,
  ) {
    const { x: worldX, y: worldY } = AgentSprite.tileToWorld(tileX, tileY);
    super(scene, worldX, worldY);
    scene.add.existing(this);

    this.agentId = agentId;
    this.targetX = worldX;
    this.targetY = worldY;
    this.targetTileX = tileX;
    this.targetTileY = tileY;
    this.sourceTileX = tileX;
    this.sourceTileY = tileY;
    this.charModel = charModel;
    this.prefix = modelToPrefix(charModel);
    this.uses8Dir = is8Dir(charModel);

    // Selection ring
    this.selectionRing = scene.add.graphics();
    this.selectionRing.setVisible(false);
    this.add(this.selectionRing);
    this.drawSelectionRing();

    // Mood ring
    this.moodRing = scene.add.graphics();
    this.add(this.moodRing);
    this.drawMoodRing('neutral');

    // Ground shadow
    const shadow = scene.add.graphics();
    shadow.fillStyle(0x000000, 0.25);
    shadow.fillEllipse(0, 2, 24, 10);
    this.add(shadow);

    // Determine initial idle animation key and display scale
    const { idleKey, scale } = this.getIdleKeyAndScale();
    this.useAnimated = !!idleKey;

    if (this.useAnimated && idleKey) {
      const yOff = MODEL_Y_OFFSET[this.charModel];
      const s = scene.add.sprite(0, yOff, this.getIdleTexture(), 0);
      s.setScale(scale);
      s.setOrigin(0.5, 0.5);
      s.play(idleKey);
      this.sprite = s;
    } else {
      const textureKey = scene.textures.exists(spriteKey) ? spriteKey : 'agent_default';
      this.sprite = scene.add.image(0, 0, textureKey);
      this.sprite.setOrigin(0.5, 0.5);
    }
    this.add(this.sprite);

    // Name label — standalone scene object (not Container child) so it renders above walls
    this.nameLabel = scene.add.text(worldX, worldY - 45, name, {
      fontSize: `${NAME_FONT_SIZE}px`,
      fontFamily: '"Press Start 2P", monospace',
      color: '#222222',
      stroke: '#ffffff',
      strokeThickness: 3,
      resolution: 2,
    });
    this.nameLabel.setOrigin(0.5, 0);
    this.nameLabel.setDepth(9000);

    // Action label — standalone scene object
    this.actionLabel = scene.add.text(worldX, worldY - 36, '', {
      fontSize: `${ACTION_FONT_SIZE}px`,
      fontFamily: '"Press Start 2P", monospace',
      color: '#aaaaaa',
      stroke: '#000000',
      strokeThickness: 1,
      resolution: 2,
    });
    this.actionLabel.setOrigin(0.5, 0);
    this.actionLabel.setDepth(9000);

    // Thought bubble — standalone scene object (not Container child) so depth renders above night overlay
    this.thoughtBubble = new ThoughtBubble(scene, worldX - 10, worldY - 55);

    // Speech bubble — standalone scene object for same reason
    this.speechBubble = new SpeechBubble(scene, worldX, worldY - 52);

    // Interactive
    this.setSize(TILE_SIZE, TILE_SIZE);
    this.setInteractive({ useHandCursor: true });
    this.on('pointerdown', () => eventBus.emit('agent:select', agentId));

    this.setDepth(this.computeDepth(isoDepth(tileX, tileY)));
  }

  /** Returns standalone UI objects (labels + bubbles) that need camera registration. */
  getUIObjects(): Phaser.GameObjects.GameObject[] {
    const objs: Phaser.GameObjects.GameObject[] = [this.nameLabel, this.actionLabel, this.thoughtBubble, this.speechBubble];
    if (this.roleLabel) objs.push(this.roleLabel);
    return objs;
  }

  destroy(fromScene?: boolean): void {
    this.nameLabel.destroy();
    this.actionLabel.destroy();
    this.thoughtBubble.destroy();
    this.speechBubble.destroy();
    if (this.roleLabel) this.roleLabel.destroy();
    super.destroy(fromScene);
  }

  // ── Helpers ─────────────────────────────────────────────────────

  /** Get the idle texture key (the sheet key, not the animation key). */
  private getIdleTexture(): string {
    if (this.uses8Dir) {
      if (this.charModel === 'fox') return `fox_idle_dir${this.currentDir8}`;
      if (this.charModel === 'girl') return `girl_walk_dir${this.currentDir8}`;
      if (this.charModel === 'dog') return 'dog_sheet';
    }
    return `${this.prefix}_idle`;
  }

  /** Get the initial idle animation key and display scale. */
  private getIdleKeyAndScale(): { idleKey: string | null; scale: number } {
    if (this.uses8Dir) {
      const dir = this.currentDir8;
      const key = `${this.prefix}_idle_${dir}`;
      if (this.scene.anims.exists(key)) {
        const scale = this.charModel === 'dog' ? DOG_DISPLAY_SCALE
          : this.charModel === 'girl' ? GIRL_DISPLAY_SCALE
          : FOX_DISPLAY_SCALE;
        return { idleKey: key, scale };
      }
      return { idleKey: null, scale: 1 };
    }
    const key = `${this.prefix}_idle_${this.currentDir5}`;
    if (this.scene.anims.exists(key)) {
      return { idleKey: key, scale: STRIP_DISPLAY_SCALE };
    }
    return { idleKey: null, scale: 1 };
  }

  /** Get the current direction suffix for animation keys. */
  private dirSuffix(): string {
    return this.uses8Dir ? `${this.currentDir8}` : `${this.currentDir5}`;
  }

  /** Play an animation by composing prefix + type + direction. */
  private playAnim(type: string): void {
    if (!this.useAnimated || !(this.sprite instanceof Phaser.GameObjects.Sprite)) return;
    const key = `${this.prefix}_${type}_${this.dirSuffix()}`;
    if (this.scene.anims.exists(key)) {
      this.sprite.play(key, true);
    }
  }

  /** Update direction from movement delta. */
  private updateDirection(dx: number, dy: number): void {
    if (this.uses8Dir) {
      const dir = angleTo8Dir(dx, dy);
      // Dog sheet is ordered clockwise from S (D,DR,R,UR,U,UL,L,DL = keys 1-8)
      // while angleTo8Dir returns fox order (DL,L,UL,U,UR,R,DR,D = 1-8).
      // Remap: foxDir → 9 - foxDir
      this.currentDir8 = this.charModel === 'dog' ? (9 - dir) : dir;
    } else {
      const { dir, flip } = angleTo5Dir(dx, dy);
      this.currentDir5 = dir;
      if (this.sprite instanceof Phaser.GameObjects.Sprite) {
        this.sprite.setFlipX(flip);
      }
    }
  }

  // ── Drawing ─────────────────────────────────────────────────────

  private drawSelectionRing(): void {
    this.selectionRing.clear();
    this.selectionRing.lineStyle(2, 0xffd700, 0.9);
    this.selectionRing.strokeEllipse(0, -2, 30, 16);
    this.selectionRing.lineStyle(1, 0xffec80, 0.5);
    this.selectionRing.strokeEllipse(0, -2, 34, 20);
  }

  private drawMoodRing(mood: string): void {
    this.moodRing.clear();
    const color = AgentSprite.MOOD_COLORS[mood] || 0x9ca3af;
    this.moodRing.lineStyle(1.5, color, 0.7);
    this.moodRing.strokeEllipse(0, -2, 26, 14);
  }

  // ── Public API ──────────────────────────────────────────────────

  setMood(mood: string): void { this.drawMoodRing(mood); }

  moveToTile(tileX: number, tileY: number): void {
    if (this.isDead) return;
    if (this.isSleeping) this.wake();

    // Capture source tile for depth interpolation
    this.sourceTileX = this.targetTileX;
    this.sourceTileY = this.targetTileY;

    const { x: sx, y: sy } = AgentSprite.tileToWorld(tileX, tileY);
    this.targetX = sx;
    this.targetY = sy;
    this.targetTileX = tileX;
    this.targetTileY = tileY;
    this.isLerping = true;
    this.labelsDirty = true;

    // Cache depth for the entire movement (avoids recomputing each frame)
    this.movementDepth = Math.max(
      isoDepth(this.sourceTileX, this.sourceTileY),
      isoDepth(tileX, tileY),
    ) + 1;
    this.setDepth(this.computeDepth(this.movementDepth));

    const dx = sx - this.x;
    const dy = sy - this.y;
    this.updateDirection(dx, dy);
    this.playAnim('walk');
  }

  setAction(action: string): void {
    if (this.isDead) return;
    const display = action.length > 20 ? action.substring(0, 18) + '..' : action;
    this.actionLabel.setText(display);
  }

  speak(message: string): void { this.speechBubble.show(message, 5000); }
  think(thought: string): void { this.thoughtBubble.show(thought, 6000); }

  private selected: boolean = false;

  setSelected(selected: boolean): void {
    this.selected = selected;
    this.selectionRing.setVisible(selected);
    if (selected) {
      // Recalculate depth with +1 boost so selected agent renders above others on same tile
      this.setDepth(this.computeDepth(isoDepth(this.targetTileX, this.targetTileY)));
      this.scene.tweens.add({
        targets: this.selectionRing,
        scaleX: 1.1, scaleY: 1.1,
        duration: 600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      });
      this.scene.tweens.add({
        targets: this.selectionRing,
        alpha: { from: 0.7, to: 1 },
        duration: 800, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      });
    } else {
      this.setDepth(this.computeDepth(isoDepth(this.targetTileX, this.targetTileY)));
      this.scene.tweens.killTweensOf(this.selectionRing);
      this.selectionRing.setScale(1);
      this.selectionRing.setAlpha(1);
    }
  }

  private static readonly ROLE_COLORS: Record<string, string> = {
    werewolf: '#ef4444',
    sheriff: '#fbbf24',
    healer: '#4ade80',
    villager: '#9ca3af',
  };

  setRole(role: string | null, visible: boolean): void {
    // Destroy old label to avoid text overlap artifacts
    if (this.roleLabel) {
      this.roleLabel.destroy();
      this.roleLabel = null;
    }
    if (!visible || !role) return;

    const color = AgentSprite.ROLE_COLORS[role] ?? '#9ca3af';
    this.roleLabel = this.scene.add.text(this.x, this.y - 54, role.toUpperCase(), {
      fontSize: '5px',
      fontFamily: '"Press Start 2P", monospace',
      color,
      stroke: '#000000',
      strokeThickness: 2,
      resolution: 2,
    });
    this.roleLabel.setOrigin(0.5, 0.5);
    this.roleLabel.setDepth(9000);
    this.labelsDirty = true;
  }

  setDead(dead: boolean): void {
    this.isDead = dead;
    if (dead) {
      this.isLerping = false;
      this.nameLabel.setColor('#666666');
      this.actionLabel.setText('');
      this.moodRing.setVisible(false);

      // Keep tile-based depth but at agent level (+5) so body renders
      // above ground/deco at same position, and living agents walk over it naturally
      this.setDepth(isoDepth(this.targetTileX, this.targetTileY) * 10 + 5);

      // Play death animation to show lying on the ground
      if (this.useAnimated && this.sprite instanceof Phaser.GameObjects.Sprite) {
        const dieKey = `${this.prefix}_die_${this.dirSuffix()}`;
        if (this.scene.anims.exists(dieKey)) {
          this.sprite.play(dieKey);
          return;
        }
      }
    } else {
      this.setAlpha(1);
      this.nameLabel.setColor('#222222');
      this.moodRing.setVisible(true);
      if (this.useAnimated && this.sprite instanceof Phaser.GameObjects.Sprite) {
        this.sprite.setAlpha(1);
      }
      this.playAnim('idle');
    }
  }

  /** Play sleep animation — uses death animation to show lying down, then pulses. */
  sleep(): void {
    if (this.isSleeping || this.isDead) return;
    this.isSleeping = true;
    this.isLerping = false;

    if (this.useAnimated && this.sprite instanceof Phaser.GameObjects.Sprite) {
      const dieKey = `${this.prefix}_die_${this.dirSuffix()}`;
      if (this.scene.anims.exists(dieKey)) {
        this.sprite.play(dieKey);
        this.sprite.once('animationcomplete', () => {
          if (!this.scene) return;
          this.scene.tweens.add({
            targets: this.sprite,
            alpha: 0.5, duration: 1500, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
          });
        });
        return;
      }
    }
    // Fallback: just dim
    this.scene.tweens.add({ targets: this.sprite, alpha: 0.5, duration: 1000 });
  }

  /** Wake from sleep. */
  wake(): void {
    if (!this.isSleeping) return;
    this.isSleeping = false;
    this.scene.tweens.killTweensOf(this.sprite);
    if (this.sprite instanceof Phaser.GameObjects.Sprite || this.sprite instanceof Phaser.GameObjects.Image) {
      this.sprite.setAlpha(1);
    }
    this.playAnim('idle');
  }

  /** Play death animation then fade out. */
  die(): Promise<void> {
    this.isLerping = false;
    this.isSleeping = false;
    this.scene.tweens.killTweensOf(this.sprite);

    return new Promise((resolve) => {
      let resolved = false;
      const done = () => { if (!resolved) { resolved = true; resolve(); } };

      // Safety timeout — resolve even if animation callback never fires
      setTimeout(done, 3000);

      if (this.useAnimated && this.sprite instanceof Phaser.GameObjects.Sprite) {
        this.sprite.setAlpha(1);
        const dieKey = `${this.prefix}_die_${this.dirSuffix()}`;
        if (this.scene.anims.exists(dieKey)) {
          this.sprite.play(dieKey);
          this.sprite.once('animationcomplete', () => {
            if (!this.scene) { done(); return; }
            this.scene.tweens.add({
              targets: this, alpha: 0, duration: 800, onComplete: done,
            });
          });
          return;
        }
      }
      // Fallback: fade out
      this.scene.tweens.add({
        targets: this, alpha: 0, duration: 1500, onComplete: done,
      });
    });
  }

  /** Compute depth for this agent, with +1 boost if selected. */
  private computeDepth(tileDepth: number): number {
    return tileDepth * 10 + 5 + (this.selected ? 1 : 0);
  }

  /** Sync standalone label positions to follow the Container. */
  private syncLabels(): void {
    this.nameLabel.setPosition(this.x, this.y - 45);
    this.actionLabel.setPosition(this.x, this.y - 36);
    if (this.roleLabel) {
      this.roleLabel.setPosition(this.x, this.y - 54);
    }
    this.thoughtBubble.setPosition(this.x - 10, this.y - 55);
    this.speechBubble.setPosition(this.x, this.y - 52);
  }

  /** Current tile position (for wall occlusion checks by the scene). */
  getTilePos(): { x: number; y: number } {
    this.tilePos.x = this.targetTileX;
    this.tilePos.y = this.targetTileY;
    return this.tilePos;
  }

  update(_time: number, _delta: number): void {
    if (!this.isLerping) {
      if (this.labelsDirty) {
        this.syncLabels();
        this.labelsDirty = false;
      }
      return;
    }

    const dx = this.targetX - this.x;
    const dy = this.targetY - this.y;
    const dist = dx * dx + dy * dy; // skip sqrt, compare squared

    if (dist < 0.25) { // 0.5^2
      this.x = this.targetX;
      this.y = this.targetY;
      this.isLerping = false;
      this.setDepth(this.computeDepth(isoDepth(this.targetTileX, this.targetTileY)));
      this.syncLabels();
      this.playAnim('idle');
      return;
    }

    this.x = Phaser.Math.Linear(this.x, this.targetX, LERP_SPEED);
    this.y = Phaser.Math.Linear(this.y, this.targetY, LERP_SPEED);
    this.setDepth(this.computeDepth(this.movementDepth));
    this.syncLabels();
  }
}
