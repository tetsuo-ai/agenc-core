/**
 * A* pathfinding on collision grid using EasyStar.js.
 */

import EasyStar from 'easystarjs';

export interface PathPoint {
  x: number;
  y: number;
}

export class PathfindingManager {
  private easystar: EasyStar;
  private tileWidth: number;
  private tileHeight: number;
  private ready = false;

  constructor(
    collisionGrid: number[][] | null,
    tileWidth: number,
    tileHeight: number,
  ) {
    this.easystar = new EasyStar();
    this.tileWidth = tileWidth;
    this.tileHeight = tileHeight;

    if (collisionGrid && collisionGrid.length > 0) {
      this.easystar.setGrid(collisionGrid);
      this.easystar.setAcceptableTiles([0]);
      this.easystar.enableDiagonals();
      this.easystar.setIterationsPerCalculation(100);
      this.ready = true;
    }
  }

  findPath(
    fromPixelX: number,
    fromPixelY: number,
    toPixelX: number,
    toPixelY: number,
  ): Promise<PathPoint[] | null> {
    if (!this.ready) {
      // No collision grid — return straight line
      return Promise.resolve([
        { x: fromPixelX, y: fromPixelY },
        { x: toPixelX, y: toPixelY },
      ]);
    }

    const startTileX = Math.floor(fromPixelX / this.tileWidth);
    const startTileY = Math.floor(fromPixelY / this.tileHeight);
    const endTileX = Math.floor(toPixelX / this.tileWidth);
    const endTileY = Math.floor(toPixelY / this.tileHeight);

    return new Promise((resolve) => {
      this.easystar.findPath(
        startTileX,
        startTileY,
        endTileX,
        endTileY,
        (path) => {
          if (!path) {
            // Fallback to straight line if no path found
            resolve([
              { x: fromPixelX, y: fromPixelY },
              { x: toPixelX, y: toPixelY },
            ]);
            return;
          }
          // Convert tile coordinates back to pixel coordinates
          const pixelPath = path.map((p) => ({
            x: p.x * this.tileWidth + this.tileWidth / 2,
            y: p.y * this.tileHeight + this.tileHeight / 2,
          }));
          resolve(pixelPath);
        },
      );
      this.easystar.calculate();
    });
  }

  isReady(): boolean {
    return this.ready;
  }
}
