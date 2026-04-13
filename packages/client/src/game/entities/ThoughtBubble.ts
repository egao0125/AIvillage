import Phaser from 'phaser';

const PADDING = 6;
const MAX_WIDTH = 220;
const FONT_SIZE = 7;
const BG_COLOR = 0x6b21a8;
const BG_ALPHA = 0.85;
const TEXT_COLOR = '#f3e8ff';
const CORNER_RADIUS = 8;

export class ThoughtBubble extends Phaser.GameObjects.Container {
  private bg: Phaser.GameObjects.Graphics;
  private label: Phaser.GameObjects.Text;
  private fadeTimer?: Phaser.Time.TimerEvent;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y);
    scene.add.existing(this);

    this.bg = scene.add.graphics();
    this.add(this.bg);

    this.label = scene.add.text(0, 0, '', {
      fontSize: `${FONT_SIZE}px`,
      fontFamily: '"Press Start 2P", monospace',
      color: TEXT_COLOR,
      wordWrap: { width: MAX_WIDTH - PADDING * 2 },
      lineSpacing: 2,
      resolution: 2,
    });
    this.label.setOrigin(0.5, 1);
    this.add(this.label);

    this.setAlpha(0);
    this.setDepth(6000);
  }

  show(message: string, duration: number = 12000): void {
    if (this.fadeTimer) {
      this.fadeTimer.destroy();
      this.fadeTimer = undefined;
    }

    this.label.setText(message);

    const textWidth = this.label.width;
    const textHeight = this.label.height;

    const bubbleWidth = textWidth + PADDING * 2;
    const bubbleHeight = textHeight + PADDING * 2;

    // Position text centered above the thought dots
    const DOT_GAP = 8; // space between dots and bubble body
    this.label.setPosition(0, -DOT_GAP - PADDING);

    // Draw background
    this.bg.clear();

    // Shadow
    this.bg.fillStyle(0x000000, 0.2);
    this.bg.fillRoundedRect(
      -bubbleWidth / 2 + 1,
      -bubbleHeight - DOT_GAP + 1,
      bubbleWidth,
      bubbleHeight,
      CORNER_RADIUS,
    );

    // Main bubble
    this.bg.fillStyle(BG_COLOR, BG_ALPHA);
    this.bg.fillRoundedRect(
      -bubbleWidth / 2,
      -bubbleHeight - DOT_GAP,
      bubbleWidth,
      bubbleHeight,
      CORNER_RADIUS,
    );

    // Border
    this.bg.lineStyle(1, 0x9333ea, 0.6);
    this.bg.strokeRoundedRect(
      -bubbleWidth / 2,
      -bubbleHeight - DOT_GAP,
      bubbleWidth,
      bubbleHeight,
      CORNER_RADIUS,
    );

    // Three ascending thought dots — tight connection to bubble
    this.bg.fillStyle(BG_COLOR, BG_ALPHA);
    this.bg.fillCircle(0, -5, 3);   // largest, closest to bubble
    this.bg.fillCircle(2, -2, 2);   // medium
    this.bg.fillCircle(3, 0, 1.5);  // smallest, closest to head

    // Dreamy fade in (400ms)
    this.setAlpha(0);
    this.scene.tweens.add({
      targets: this,
      alpha: 1,
      duration: 400,
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
      duration: 500,
      ease: 'Sine.easeIn',
    });
  }
}
