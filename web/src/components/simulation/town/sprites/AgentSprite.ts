/**
 * Individual agent sprite with walk/idle/talk states.
 * Uses animated spritesheet when available, falls back to colored circles.
 */

import { Container, Graphics, Text, TextStyle, Texture, Sprite, Rectangle } from 'pixi.js';
import { AnimationController, type Direction } from '../systems/AnimationController';
import { SpeechBubble } from './SpeechBubble';

const AGENT_RADIUS = 10;
const FRAME_SIZE = 32;

const LABEL_STYLE = new TextStyle({
  fontFamily: 'monospace',
  fontSize: 10,
  fill: 0xffffff,
  stroke: { color: 0x000000, width: 2 },
  align: 'center',
});

export class AgentSpriteDisplay {
  readonly container: Container;
  private circle: Graphics | null = null;
  private sprite: Sprite | null = null;
  private label: Text;
  private animation: AnimationController;
  private speechBubble: SpeechBubble;
  private spritesheet: Texture | null = null;
  readonly agentId: string;

  constructor(agentId: string, name: string, color: number, spritesheet?: Texture) {
    this.agentId = agentId;
    this.container = new Container();
    this.container.label = `agent-${agentId}`;
    this.container.eventMode = 'static';
    this.container.cursor = 'pointer';

    this.animation = new AnimationController();
    this.speechBubble = new SpeechBubble();

    if (spritesheet) {
      this.spritesheet = spritesheet;
      this.sprite = new Sprite(this.getFrameTexture('down', 0));
      this.sprite.anchor.set(0.5, 0.5);
      this.container.addChild(this.sprite);
    } else {
      this.circle = new Graphics();
      this.circle.circle(0, 0, AGENT_RADIUS);
      this.circle.fill(color);
      this.circle.stroke({ width: 2, color: 0xffffff, alpha: 0.8 });
      this.container.addChild(this.circle);
    }

    this.label = new Text({ text: name, style: LABEL_STYLE });
    this.label.anchor.set(0.5, 0);
    this.label.y = (this.sprite ? FRAME_SIZE / 2 : AGENT_RADIUS) + 4;
    this.container.addChild(this.label);

    this.container.addChild(this.speechBubble.container);
  }

  setPosition(x: number, y: number): void {
    this.container.x = x;
    this.container.y = y;
  }

  setMoving(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) {
      this.animation.setState('idle');
    } else {
      this.animation.setState('walk');
      this.animation.setDirectionFromMovement(dx, dy);
    }
  }

  showSpeech(text: string, durationMs: number = 4000): void {
    this.animation.setState('talk');
    this.speechBubble.show(text, durationMs);
  }

  update(delta: number): void {
    // Update animation frame
    const frame = this.animation.update(delta);
    if (this.sprite && this.spritesheet) {
      this.sprite.texture = this.getFrameTexture(frame.direction, frame.frameIndex);
    }

    // Update speech bubble (convert delta ticks to ms approximation)
    this.speechBubble.update(delta * 16.67);

    // Return to idle when speech ends
    if (!this.speechBubble.isActive() && this.animation.getState() === 'talk') {
      this.animation.setState('idle');
    }
  }

  updateName(name: string): void {
    if (this.label.text !== name) {
      this.label.text = name;
    }
  }

  onClick(handler: () => void): void {
    this.container.on('pointertap', handler);
  }

  private getFrameTexture(direction: Direction, frameIndex: number): Texture {
    if (!this.spritesheet) return Texture.EMPTY;

    const rect = AnimationController.getFrameRect(
      direction,
      frameIndex,
      FRAME_SIZE,
      FRAME_SIZE,
    );

    return new Texture({
      source: this.spritesheet.source,
      frame: new Rectangle(rect.x, rect.y, rect.width, rect.height),
    });
  }

  destroy(): void {
    this.speechBubble.destroy();
    this.container.destroy({ children: true });
  }
}
