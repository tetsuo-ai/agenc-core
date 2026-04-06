/**
 * PixiJS Text bubble as child of agent container.
 * NOT HTML overlay — transforms naturally with camera pan/zoom.
 */

import { Container, Graphics, Text, TextStyle } from 'pixi.js';

const BUBBLE_STYLE = new TextStyle({
  fontFamily: 'monospace',
  fontSize: 9,
  fill: 0x000000,
  wordWrap: true,
  wordWrapWidth: 120,
  align: 'left',
});

const PADDING = 6;
const TAIL_SIZE = 5;
const BUBBLE_ALPHA = 0.92;

export class SpeechBubble {
  readonly container: Container;
  private bg: Graphics;
  private textObj: Text;
  private timer: number = 0;
  private durationMs: number = 0;
  private active = false;

  constructor() {
    this.container = new Container();
    this.container.label = 'speech-bubble';
    this.container.visible = false;

    this.bg = new Graphics();
    this.container.addChild(this.bg);

    this.textObj = new Text({ text: '', style: BUBBLE_STYLE });
    this.container.addChild(this.textObj);
  }

  show(text: string, durationMs: number = 4000): void {
    this.textObj.text = text;
    this.durationMs = durationMs;
    this.timer = 0;
    this.active = true;
    this.container.visible = true;

    // Redraw background to fit text
    const textWidth = this.textObj.width;
    const textHeight = this.textObj.height;
    const bgWidth = textWidth + PADDING * 2;
    const bgHeight = textHeight + PADDING * 2;

    this.bg.clear();
    this.bg.roundRect(0, 0, bgWidth, bgHeight, 4);
    this.bg.fill({ color: 0xffffff, alpha: BUBBLE_ALPHA });
    this.bg.stroke({ width: 1, color: 0x333333 });

    // Small tail pointing down
    this.bg.moveTo(bgWidth / 2 - TAIL_SIZE, bgHeight);
    this.bg.lineTo(bgWidth / 2, bgHeight + TAIL_SIZE);
    this.bg.lineTo(bgWidth / 2 + TAIL_SIZE, bgHeight);
    this.bg.fill({ color: 0xffffff, alpha: BUBBLE_ALPHA });

    this.textObj.x = PADDING;
    this.textObj.y = PADDING;

    // Position bubble above the agent
    this.container.x = -bgWidth / 2;
    this.container.y = -(bgHeight + TAIL_SIZE + 16);
  }

  hide(): void {
    this.active = false;
    this.container.visible = false;
  }

  update(deltaMs: number): void {
    if (!this.active) return;

    this.timer += deltaMs;
    if (this.timer >= this.durationMs) {
      this.hide();
      return;
    }

    // Fade out in last 500ms
    const remaining = this.durationMs - this.timer;
    if (remaining < 500) {
      this.container.alpha = remaining / 500;
    } else {
      this.container.alpha = 1;
    }
  }

  isActive(): boolean {
    return this.active;
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
