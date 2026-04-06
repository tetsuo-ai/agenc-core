/**
 * Renders Tiled map tile layers into a PixiJS Container.
 * Uses imperative PixiJS API (no @pixi/react).
 */

import { Container, Sprite, Texture, Rectangle } from 'pixi.js';
import type { TiledTileLayer, TiledTileset, ParsedMap } from '../maps/types';

export function createTilemapContainer(
  parsed: ParsedMap,
  tilesetTextures: Map<string, Texture>,
): Container {
  const container = new Container();
  container.label = 'tilemap';

  for (const layer of parsed.tileLayers) {
    if (!layer.visible) continue;
    const layerContainer = renderTileLayer(layer, parsed, tilesetTextures);
    layerContainer.label = layer.name;
    layerContainer.alpha = layer.opacity;
    container.addChild(layerContainer);
  }

  return container;
}

function renderTileLayer(
  layer: TiledTileLayer,
  parsed: ParsedMap,
  tilesetTextures: Map<string, Texture>,
): Container {
  const container = new Container();
  const { tileWidth, tileHeight, tilesets } = parsed;

  for (let y = 0; y < layer.height; y++) {
    for (let x = 0; x < layer.width; x++) {
      const rawGid = layer.data[y * layer.width + x];
      if (rawGid === 0) continue;

      // Strip flip flags (bits 29-31)
      const gid = rawGid & 0x1fffffff;

      const tileset = findTileset(gid, tilesets);
      if (!tileset) continue;

      const texture = tilesetTextures.get(tileset.name);
      if (!texture) continue;

      const localId = gid - tileset.firstgid;
      const cols = tileset.columns;
      if (cols <= 0) continue; // Guard: avoid division by zero from malformed tilesets
      const margin = tileset.margin ?? 0;
      const spacing = tileset.spacing ?? 0;

      const srcX = margin + (localId % cols) * (tileset.tilewidth + spacing);
      const srcY = margin + Math.floor(localId / cols) * (tileset.tileheight + spacing);

      const tileTexture = new Texture({
        source: texture.source,
        frame: new Rectangle(srcX, srcY, tileset.tilewidth, tileset.tileheight),
      });

      const sprite = new Sprite(tileTexture);
      sprite.x = x * tileWidth;
      sprite.y = y * tileHeight;
      container.addChild(sprite);
    }
  }

  return container;
}

function findTileset(
  gid: number,
  tilesets: readonly TiledTileset[],
): TiledTileset | null {
  let result: TiledTileset | null = null;
  for (const ts of tilesets) {
    if (ts.firstgid <= gid) {
      if (!result || ts.firstgid > result.firstgid) {
        result = ts;
      }
    }
  }
  return result;
}
