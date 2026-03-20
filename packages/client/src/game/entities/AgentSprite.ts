import Phaser from 'phaser';
import { SpeechBubble } from './SpeechBubble';
import { eventBus } from '../../core/EventBus';
import { TILE_SIZE } from '../config';

const LERP_SPEED = 0.08;
const NAME_FONT_SIZE = 6;
const ACTION_FONT_SIZE = 5;

export class AgentSprite extends Phaser.GameObjects.Container {
  private sprite: Phaser.GameObjects.Image;
  private nameLabel: Phaser.GameObjects.Text;
  private actionLabel: Phaser.GameObjects.Text;
  private speechBubble: SpeechBubble;
  private selectionRing: Phaser.GameObjects.Graphics;
  private moodRing: Phaser.GameObjects.Graphics;
  private targetX: number;
  private targetY: number;
  private isLerping: boolean = false;
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
    tileY: number
  ) {
    const worldX = tileX * TILE_SIZE + TILE_SIZE / 2;
    const worldY = tileY * TILE_SIZE + TILE_SIZE / 2;
    super(scene, worldX, worldY);
    scene.add.existing(this);

    this.agentId = agentId;
    this.targetX = worldX;
    this.targetY = worldY;

    // Selection ring (drawn behind sprite)
    this.selectionRing = scene.add.graphics();
    this.selectionRing.setVisible(false);
    this.add(this.selectionRing);
    this.drawSelectionRing();

    // Mood ring (behind sprite, in front of selection ring)
    this.moodRing = scene.add.graphics();
    this.add(this.moodRing);
    this.drawMoodRing('neutral');

    // Sprite
    const textureKey = scene.textures.exists(spriteKey)
      ? spriteKey
      : 'agent_default';
    this.sprite = scene.add.image(0, 0, textureKey);
    this.sprite.setOrigin(0.5, 0.5);
    this.add(this.sprite);

    // Name label
    this.nameLabel = scene.add.text(0, 18, name, {
      fontSize: `${NAME_FONT_SIZE}px`,
      fontFamily: '"Press Start 2P", monospace',
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 2,
      resolution: 2,
    });
    this.nameLabel.setOrigin(0.5, 0);
    this.add(this.nameLabel);

    // Action label
    this.actionLabel = scene.add.text(0, 28, '', {
      fontSize: `${ACTION_FONT_SIZE}px`,
      fontFamily: '"Press Start 2P", monospace',
      color: '#aaaaaa',
      stroke: '#000000',
      strokeThickness: 1,
      resolution: 2,
    });
    this.actionLabel.setOrigin(0.5, 0);
    this.add(this.actionLabel);

    // Speech bubble (positioned above sprite)
    this.speechBubble = new SpeechBubble(scene, 0, -20);
    this.add(this.speechBubble);

    // Make interactive
    this.setSize(TILE_SIZE, TILE_SIZE);
    this.setInteractive({ useHandCursor: true });
    this.on('pointerdown', () => {
      eventBus.emit('agent:select', agentId);
    });

    this.setDepth(tileY + 10);
  }

  private drawSelectionRing(): void {
    this.selectionRing.clear();
    // Golden pulsing ring
    this.selectionRing.lineStyle(2, 0xffd700, 0.9);
    this.selectionRing.strokeEllipse(0, 4, 28, 14);
    this.selectionRing.lineStyle(1, 0xffec80, 0.5);
    this.selectionRing.strokeEllipse(0, 4, 32, 18);
  }

  private drawMoodRing(mood: string): void {
    this.moodRing.clear();
    const color = AgentSprite.MOOD_COLORS[mood] || 0x9ca3af;
    this.moodRing.lineStyle(1.5, color, 0.7);
    this.moodRing.strokeCircle(0, 0, 10);
  }

  setMood(mood: string): void {
    this.drawMoodRing(mood);
  }

  moveTo(tileX: number, tileY: number): void {
    this.targetX = tileX * TILE_SIZE + TILE_SIZE / 2;
    this.targetY = tileY * TILE_SIZE + TILE_SIZE / 2;
    this.isLerping = true;
    // Update depth for proper z-ordering
    this.setDepth(tileY + 10);
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

  update(_time: number, _delta: number): void {
    if (!this.isLerping) return;

    const dx = this.targetX - this.x;
    const dy = this.targetY - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 0.5) {
      this.x = this.targetX;
      this.y = this.targetY;
      this.isLerping = false;
      return;
    }

    // Smooth lerp
    this.x = Phaser.Math.Linear(this.x, this.targetX, LERP_SPEED);
    this.y = Phaser.Math.Linear(this.y, this.targetY, LERP_SPEED);
  }
}
