import Phaser from 'phaser';
import { SpeechBubble } from './SpeechBubble';
import { ThoughtBubble } from './ThoughtBubble';
import { eventBus } from '../../core/EventBus';
import { TILE_SIZE } from '../config';
import { tileToScreen, screenToTile, isoDepth } from '../iso';

const LERP_SPEED = 0.08;
const NAME_FONT_SIZE = 6;
const ACTION_FONT_SIZE = 5;

/** Scale astronaut frames (258px) down to roughly tile-sized sprites. */
const ASTRO_DISPLAY_SCALE = 0.3;

/**
 * Map screen-space delta to one of the 5 sprite directions + flipX.
 * Sheet layout: 0=S, 1=SE, 2=E, 3=NE, 4=N.
 * Mirror via flipX: SW=flip(SE), W=flip(E), NW=flip(NE).
 */
function angleToDirFlip(dx: number, dy: number): { dir: number; flip: boolean } {
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return { dir: 0, flip: false };

  const angle = Math.atan2(dy, dx);
  const sector = Math.round(angle / (Math.PI / 4));
  // sector: 0=E, 1=SE, 2=S, 3=SW, 4/-4=W, -3=NW, -2=N, -1=NE

  switch (sector) {
    case 2:  return { dir: 0, flip: false }; // S
    case 1:  return { dir: 1, flip: false }; // SE
    case 0:  return { dir: 2, flip: false }; // E
    case -1: return { dir: 3, flip: false }; // NE
    case -2: return { dir: 4, flip: false }; // N
    case -3: return { dir: 3, flip: true };  // NW → flip NE
    case -4:
    case 4:  return { dir: 2, flip: true };  // W → flip E
    case 3:  return { dir: 1, flip: true };  // SW → flip SE
    default: return { dir: 0, flip: false };
  }
}

export class AgentSprite extends Phaser.GameObjects.Container {
  private sprite: Phaser.GameObjects.Sprite | Phaser.GameObjects.Image;
  private nameLabel: Phaser.GameObjects.Text;
  private actionLabel: Phaser.GameObjects.Text;
  private speechBubble: SpeechBubble;
  private thoughtBubble: ThoughtBubble;
  private selectionRing: Phaser.GameObjects.Graphics;
  private moodRing: Phaser.GameObjects.Graphics;
  private targetX: number;
  private targetY: number;
  private isLerping: boolean = false;
  private currentDir: number = 0;
  private useAstro: boolean = false;
  private targetTileX: number;
  private targetTileY: number;
  agentId: string;

  private static readonly MOOD_COLORS: Record<string, number> = {
    neutral: 0x9ca3af,
    happy: 0x4ade80,
    angry: 0xef4444,
    sad: 0x60a5fa,
    anxious: 0xfbbf24,
    excited: 0xf97316,
    scheming: 0xa855f7,
    afraid: 0x94a3b8,
  };

  constructor(
    scene: Phaser.Scene,
    agentId: string,
    name: string,
    spriteKey: string,
    tileX: number,
    tileY: number,
    tintColor?: number
  ) {
    const { x: worldX, y: worldY } = tileToScreen(tileX, tileY);
    super(scene, worldX, worldY);
    scene.add.existing(this);

    this.agentId = agentId;
    this.targetX = worldX;
    this.targetY = worldY;
    this.targetTileX = tileX;
    this.targetTileY = tileY;

    // Selection ring (drawn behind sprite)
    this.selectionRing = scene.add.graphics();
    this.selectionRing.setVisible(false);
    this.add(this.selectionRing);
    this.drawSelectionRing();

    // Mood ring (behind sprite, in front of selection ring)
    this.moodRing = scene.add.graphics();
    this.add(this.moodRing);
    this.drawMoodRing('neutral');

    // Ground shadow (dark ellipse under the character for contrast)
    const shadow = scene.add.graphics();
    shadow.fillStyle(0x000000, 0.25);
    shadow.fillEllipse(0, -2, 24, 10);
    this.add(shadow);

    // Sprite — prefer astronaut animated sprite, fall back to procedural
    this.useAstro = scene.textures.exists('astro_idle');
    if (this.useAstro) {
      const s = scene.add.sprite(0, -10, 'astro_idle', 0);
      s.setScale(ASTRO_DISPLAY_SCALE);
      s.setOrigin(0.5, 0.5);
      s.play('astro_idle_0');
      this.sprite = s;
    } else {
      const textureKey = scene.textures.exists(spriteKey) ? spriteKey : 'agent_default';
      this.sprite = scene.add.image(0, 0, textureKey);
      this.sprite.setOrigin(0.5, 0.5);
    }
    this.add(this.sprite);

    // Name label (above sprite)
    this.nameLabel = scene.add.text(0, -45, name, {
      fontSize: `${NAME_FONT_SIZE}px`,
      fontFamily: '"Press Start 2P", monospace',
      color: '#222222',
      stroke: '#ffffff',
      strokeThickness: 3,
      resolution: 2,
    });
    this.nameLabel.setOrigin(0.5, 0);
    this.add(this.nameLabel);

    // Action label (below name, still above sprite)
    this.actionLabel = scene.add.text(0, -36, '', {
      fontSize: `${ACTION_FONT_SIZE}px`,
      fontFamily: '"Press Start 2P", monospace',
      color: '#aaaaaa',
      stroke: '#000000',
      strokeThickness: 1,
      resolution: 2,
    });
    this.actionLabel.setOrigin(0.5, 0);
    this.add(this.actionLabel);

    // Thought bubble (positioned above-left, below speech in z-order)
    this.thoughtBubble = new ThoughtBubble(scene, -10, -55);
    this.add(this.thoughtBubble);

    // Speech bubble (positioned above sprite)
    this.speechBubble = new SpeechBubble(scene, 0, -50);
    this.add(this.speechBubble);

    // Make interactive
    this.setSize(TILE_SIZE, TILE_SIZE);
    this.setInteractive({ useHandCursor: true });
    this.on('pointerdown', () => {
      eventBus.emit('agent:select', agentId);
    });

    this.setDepth(isoDepth(tileX, tileY) * 10 + 5);
  }

  private drawSelectionRing(): void {
    this.selectionRing.clear();
    // Golden pulsing ring around character center (not at feet to avoid tile clipping)
    this.selectionRing.lineStyle(2, 0xffd700, 0.9);
    this.selectionRing.strokeEllipse(0, -6, 30, 16);
    this.selectionRing.lineStyle(1, 0xffec80, 0.5);
    this.selectionRing.strokeEllipse(0, -6, 34, 20);
  }

  private drawMoodRing(mood: string): void {
    this.moodRing.clear();
    const color = AgentSprite.MOOD_COLORS[mood] || 0x9ca3af;
    // Small ring around character center
    this.moodRing.lineStyle(1.5, color, 0.7);
    this.moodRing.strokeEllipse(0, -6, 26, 14);
  }

  setMood(mood: string): void {
    this.drawMoodRing(mood);
  }

  moveToTile(tileX: number, tileY: number): void {
    const { x: sx, y: sy } = tileToScreen(tileX, tileY);
    this.targetX = sx;
    this.targetY = sy;
    this.targetTileX = tileX;
    this.targetTileY = tileY;
    this.isLerping = true;

    // Update depth for proper z-ordering
    this.setDepth(isoDepth(tileX, tileY) * 10 + 5);

    // Determine walk direction
    if (this.useAstro && this.sprite instanceof Phaser.GameObjects.Sprite) {
      const dx = sx - this.x;
      const dy = sy - this.y;
      const { dir, flip } = angleToDirFlip(dx, dy);
      this.currentDir = dir;
      this.sprite.setFlipX(flip);
      this.sprite.play(`astro_walk_${dir}`, true);
    }
  }

  setAction(action: string): void {
    // Truncate long action text
    const display =
      action.length > 20 ? action.substring(0, 18) + '..' : action;
    this.actionLabel.setText(display);
  }

  speak(message: string): void {
    this.speechBubble.show(message, 5000);
  }

  think(thought: string): void {
    this.thoughtBubble.show(thought, 6000);
  }

  setSelected(selected: boolean): void {
    this.selectionRing.setVisible(selected);
    if (selected) {
      // Pulse animation
      this.scene.tweens.add({
        targets: this.selectionRing,
        scaleX: 1.1,
        scaleY: 1.1,
        duration: 600,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    } else {
      this.scene.tweens.killTweensOf(this.selectionRing);
      this.selectionRing.setScale(1);
    }
  }

  /** Play death animation then fade out. Returns a promise that resolves when done. */
  die(): Promise<void> {
    this.isLerping = false;
    return new Promise((resolve) => {
      if (this.useAstro && this.sprite instanceof Phaser.GameObjects.Sprite) {
        this.sprite.play(`astro_die_${this.currentDir}`);
        this.sprite.once('animationcomplete', () => {
          this.scene.tweens.add({
            targets: this,
            alpha: 0,
            duration: 800,
            onComplete: () => resolve(),
          });
        });
      } else {
        // Fallback: just fade out
        this.scene.tweens.add({
          targets: this,
          alpha: 0,
          duration: 1500,
          onComplete: () => resolve(),
        });
      }
    });
  }

  update(_time: number, _delta: number): void {
    if (!this.isLerping) return;

    const dx = this.targetX - this.x;
    const dy = this.targetY - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 0.5) {
      this.x = this.targetX;
      this.y = this.targetY;
      this.isLerping = false;
      this.setDepth(isoDepth(this.targetTileX, this.targetTileY) * 10 + 5);

      // Switch to idle animation on arrival
      if (this.useAstro && this.sprite instanceof Phaser.GameObjects.Sprite) {
        this.sprite.play(`astro_idle_${this.currentDir}`, true);
      }
      return;
    }

    // Smooth lerp
    this.x = Phaser.Math.Linear(this.x, this.targetX, LERP_SPEED);
    this.y = Phaser.Math.Linear(this.y, this.targetY, LERP_SPEED);

    // Update depth continuously based on current interpolated screen position
    const curTile = screenToTile(this.x, this.y);
    this.setDepth(isoDepth(curTile.x, curTile.y) * 10 + 5);
  }
}
