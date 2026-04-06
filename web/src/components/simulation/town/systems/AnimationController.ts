/**
 * Sprite frame ticker state machine.
 * Manages walk/idle/talk animation states for agent sprites.
 */

export type AnimState = 'idle' | 'walk' | 'talk';

export type Direction = 'down' | 'up' | 'left' | 'right';

export interface AnimationFrame {
  state: AnimState;
  direction: Direction;
  frameIndex: number;
}

const FRAMES_PER_DIRECTION = 4;
const ANIMATION_SPEED = 0.12; // frames per tick

export class AnimationController {
  private state: AnimState = 'idle';
  private direction: Direction = 'down';
  private frameProgress = 0;
  private frameIndex = 0;

  setState(state: AnimState): void {
    if (this.state !== state) {
      this.state = state;
      this.frameProgress = 0;
      this.frameIndex = 0;
    }
  }

  setDirection(direction: Direction): void {
    this.direction = direction;
  }

  setDirectionFromMovement(dx: number, dy: number): void {
    if (Math.abs(dx) > Math.abs(dy)) {
      this.direction = dx > 0 ? 'right' : 'left';
    } else if (dy !== 0) {
      this.direction = dy > 0 ? 'down' : 'up';
    }
  }

  update(delta: number): AnimationFrame {
    if (this.state !== 'idle') {
      this.frameProgress += ANIMATION_SPEED * delta;
      if (this.frameProgress >= 1) {
        this.frameProgress -= 1;
        this.frameIndex = (this.frameIndex + 1) % FRAMES_PER_DIRECTION;
      }
    } else {
      this.frameIndex = 0;
      this.frameProgress = 0;
    }

    return {
      state: this.state,
      direction: this.direction,
      frameIndex: this.frameIndex,
    };
  }

  getState(): AnimState {
    return this.state;
  }

  getDirection(): Direction {
    return this.direction;
  }

  static getFrameRect(
    direction: Direction,
    frameIndex: number,
    frameWidth: number,
    frameHeight: number,
  ): { x: number; y: number; width: number; height: number } {
    const dirRow = { down: 0, left: 1, right: 2, up: 3 }[direction];
    return {
      x: frameIndex * frameWidth,
      y: dirRow * frameHeight,
      width: frameWidth,
      height: frameHeight,
    };
  }
}
