/**
 * Sentiment-colored dashed line between two agents showing relationship.
 */

import { Graphics } from 'pixi.js';

export class RelationshipLine {
  readonly graphics: Graphics;
  private fromId: string;
  private toId: string;

  constructor(fromId: string, toId: string) {
    this.fromId = fromId;
    this.toId = toId;
    this.graphics = new Graphics();
    this.graphics.label = `rel-${fromId}-${toId}`;
    this.graphics.alpha = 0.4;
  }

  update(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    sentiment: number,
  ): void {
    this.graphics.clear();

    const color = sentimentToColor(sentiment);

    // Draw dashed line
    drawDashedLine(this.graphics, fromX, fromY, toX, toY, color, 8, 4);
  }

  getFromId(): string {
    return this.fromId;
  }

  getToId(): string {
    return this.toId;
  }

  destroy(): void {
    this.graphics.destroy();
  }
}

function sentimentToColor(sentiment: number): number {
  // sentiment: -1 (hostile) to +1 (friendly)
  if (sentiment > 0.3) return 0x2ecc71; // green — friendly
  if (sentiment < -0.3) return 0xe74c3c; // red — hostile
  return 0xf39c12; // yellow — neutral
}

function drawDashedLine(
  g: Graphics,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: number,
  dashLen: number,
  gapLen: number,
): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const nx = dx / dist;
  const ny = dy / dist;

  let drawn = 0;
  let drawing = true;

  while (drawn < dist) {
    const segLen = drawing ? dashLen : gapLen;
    const end = Math.min(drawn + segLen, dist);

    if (drawing) {
      g.moveTo(x1 + nx * drawn, y1 + ny * drawn);
      g.lineTo(x1 + nx * end, y1 + ny * end);
      g.stroke({ width: 1, color, alpha: 0.6 });
    }

    drawn = end;
    drawing = !drawing;
  }
}
