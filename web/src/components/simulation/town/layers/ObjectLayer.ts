/**
 * World object container layer.
 * Renders world objects (items, resources, etc.) on the map.
 */

import { Container } from 'pixi.js';
import { WorldObjectSprite } from '../sprites/WorldObjectSprite';
import type { LocationRegistryInstance } from '../systems/LocationRegistry';

interface WorldObject {
  id: string;
  name: string;
  locationId: string;
}

export class ObjectLayerManager {
  readonly container: Container;
  private objects = new Map<string, WorldObjectSprite>();

  constructor() {
    this.container = new Container();
    this.container.label = 'objects';
  }

  updateObjects(
    worldObjects: WorldObject[],
    registry: LocationRegistryInstance | null,
  ): void {
    if (!registry) return;

    const activeIds = new Set<string>();

    for (const obj of worldObjects) {
      activeIds.add(obj.id);

      if (!this.objects.has(obj.id)) {
        const region = registry.resolve(obj.locationId);
        const sprite = new WorldObjectSprite(
          obj.id,
          obj.name,
          region.centerX + (Math.random() - 0.5) * 20,
          region.centerY + (Math.random() - 0.5) * 20,
        );
        this.objects.set(obj.id, sprite);
        this.container.addChild(sprite.container);
      }
    }

    // Remove stale objects
    for (const [id, sprite] of this.objects) {
      if (!activeIds.has(id)) {
        this.container.removeChild(sprite.container);
        sprite.destroy();
        this.objects.delete(id);
      }
    }
  }

  destroy(): void {
    for (const sprite of this.objects.values()) {
      sprite.destroy();
    }
    this.objects.clear();
    this.container.destroy({ children: true });
  }
}
