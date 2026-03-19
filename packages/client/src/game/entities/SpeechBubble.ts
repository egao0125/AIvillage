import Phaser from 'phaser';

const PADDING = 6;
const POINTER_HEIGHT = 5;
const MAX_WIDTH = 140;
const FONT_SIZE = 7;
const BG_COLOR = 0xffffff;
const BG_ALPHA = 0.92;
const SHADOW_COLOR = 0x000000;
const SHADOW_ALPHA = 0.15;
const TEXT_COLOR = '#1a1a2e';
const CORNER_RADIUS = 4;

export class SpeechBubble extends Phaser.GameObjects.Container {
  private bg: Phaser.GameObjects.Graphics;
  private label: Phaser.GameObjects.Text;
  private fadeTimer?: Phaser.Time.TimerEvent;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    message: string = '',
    _maxWidth?: number
  ) {
    super(scene, x, y);
    scene.add.existing(this);

    this.bg = scene.add.graphics();
    this.add(this.bg);

    this.label = scene.add.text(0, 0, '', {
      fontSize: `${FONT_SIZE}px`,
      fontFamily: '"Press Start 2P", monospace',
      color: TEXT_COLOR,
      wordWrap: { width: (_maxWidth ?? MAX_WIDTH) - PADDING * 2 },
      lineSpacing: 2,
      resolution: 2,
    });
    this.label.setOrigin(0.5, 1);
    this.add(this.label);

    this.setAlpha(0);
    this.setDepth(1000);

    if (message) {
      this.show(message);
    }
  }

  show(message: string, duration: number = 4000): void {
    // Cancel any existing fade
    if (this.fadeTimer) {
      this.fadeTimer.destroy();
      this.fadeTimer = undefined;
    }

    // Truncate very long messages
    const truncated =
      message.length > 80 ? message.substring(0, 77) + '...' : message;
    this.label.setText(truncated);

    // Measure text bounds
    const textWidth = this.label.width;
    const textHeight = this.label.height;

    const bubbleWidth = textWidth + PADDING * 2;
    const bubbleHeight = textHeight + PADDING * 2;
    const totalHeight = bubbleHeight + POINTER_HEIGHT;

    // Position text centered above the pointer
    this.label.setPosition(0, -POINTER_HEIGHT - PADDING);

    // Draw background
    this.bg.clear();

    // Shadow
    this.bg.fillStyle(SHADOW_COLOR, SHADOW_ALPHA);
    this.bg.fillRoundedRect(
      -bubbleWidth / 2 + 1,
      -totalHeight + 1,
      bubbleWidth,
      bubbleHeight,
      CORNER_RADIUS
    );

    // Main bubble
    this.bg.fillStyle(BG_COLOR, BG_ALPHA);
    this.bg.fillRoundedRect(
      -bubbleWidth / 2,
      -totalHeight,
      bubbleWidth,
      bubbleHeight,
      CORNER_RADIUS
    );

    // Border
    this.bg.lineStyle(1, 0x888888, 0.6);
    this.bg.strokeRoundedRect(
      -bubbleWidth / 2,
      -totalHeight,
      bubbleWidth,
      bubbleHeight,
      CORNER_RADIUS
    );

    // Pointer triangle
    this.bg.fillStyle(BG_COLOR, BG_ALPHA);
    this.bg.fillTriangle(
      -4,
      -POINTER_HEIGHT,
      4,
      -POINTER_HEIGHT,
      0,
      0
    );

    // Fade in
    this.setAlpha(0);
    this.scene.tweens.add({
      targets: this,
      alpha: 1,
      duration: 200,
      ease: 'Sine.easeOut',
    });

    // Auto-fade after duration
    this.fadeTimer = this.scene.time.delayedCall(duration, () => {
      this.hide();
    });
  }

  hide(): void {
    if (this.fadeTimer) {
      this.fadeTimer.destroy();
      this.fadeTimer = undefined;
    }

    this.scene.tweens.add({
      targets: this,
      alpha: 0,
      duration: 300,
      ease: 'Sine.easeIn',
    });
  }
}
