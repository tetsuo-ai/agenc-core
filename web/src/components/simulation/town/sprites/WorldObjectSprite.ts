/**
 * World object sprite: renders world objects at locations on the map.
 * Uses PixiJS Graphics for simple shapes with labels.
 */

import { Container, Graphics, Text, TextStyle } from 'pixi.js';

const OBJECT_STYLE = new TextStyle({
  fontFamily: 'monospace',
  fontSize: 8,
  fill: 0xcccccc,
  stroke: { color: 0x000000, width: 1 },
  align: 'center',
});

export class WorldObjectSprite {
  readonly container: Container;
  private icon: Graphics;
  private label: Text;
  readonly objectId: string;

  constructor(objectId: string, name: string, x: number, y: number) {
    this.objectId = objectId;
    this.container = new Container();
    this.container.label = `object-${objectId}`;
    this.container.x = x;
    this.container.y = y;

    // Simple diamond shape for world objects
    this.icon = new Graphics();
    this.icon.moveTo(0, -6);
    this.icon.lineTo(6, 0);
    this.icon.lineTo(0, 6);
    this.icon.lineTo(-6, 0);
    this.icon.closePath();
    this.icon.fill({ color: 0xf1c40f, alpha: 0.8 });
    this.icon.stroke({ width: 1, color: 0xe67e22 });
    this.container.addChild(this.icon);

    this.label = new Text({ text: name, style: OBJECT_STYLE });
    this.label.anchor.set(0.5, 0);
    this.label.y = 8;
    this.container.addChild(this.label);
  }

  setPosition(x: number, y: number): void {
    this.container.x = x;
    this.container.y = y;
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
