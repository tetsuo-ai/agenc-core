/**
 * Parse Tiled JSON into structured map data.
 * Custom loader (~200 lines) since pixi-tiledmap is v7 only.
 */

import type {
  TiledMap,
  TiledTileLayer,
  TiledObjectGroup,
  TiledObject,
  ParsedMap,
} from './types';

function isTileLayer(layer: { type: string }): layer is TiledTileLayer {
  return layer.type === 'tilelayer';
}

function isObjectGroup(layer: { type: string }): layer is TiledObjectGroup {
  return layer.type === 'objectgroup';
}

export function parseTiledMap(json: TiledMap): ParsedMap {
  const tileLayers: TiledTileLayer[] = [];
  const objectGroups: TiledObjectGroup[] = [];

  for (const layer of json.layers) {
    if (isTileLayer(layer)) {
      tileLayers.push(layer);
    } else if (isObjectGroup(layer)) {
      objectGroups.push(layer);
    }
  }

  const locationsGroup = objectGroups.find(
    (g) => g.name.toLowerCase() === 'locations',
  );
  const locationObjects = locationsGroup?.objects ?? [];

  const collisionLayer = tileLayers.find(
    (l) => l.name.toLowerCase() === 'collision',
  );
  let collisionGrid: number[][] | null = null;
  if (collisionLayer) {
    collisionGrid = buildCollisionGrid(
      collisionLayer.data,
      json.width,
      json.height,
    );
  }

  return {
    width: json.width,
    height: json.height,
    tileWidth: json.tilewidth,
    tileHeight: json.tileheight,
    pixelWidth: json.width * json.tilewidth,
    pixelHeight: json.height * json.tileheight,
    tileLayers: tileLayers.filter((l) => l.name.toLowerCase() !== 'collision'),
    objectGroups,
    tilesets: json.tilesets,
    collisionGrid,
    locationObjects,
  };
}

function buildCollisionGrid(
  data: number[],
  width: number,
  height: number,
): number[][] {
  const grid: number[][] = [];
  for (let y = 0; y < height; y++) {
    const row: number[] = [];
    for (let x = 0; x < width; x++) {
      row.push(data[y * width + x] !== 0 ? 1 : 0);
    }
    grid.push(row);
  }
  return grid;
}

const MAP_LOAD_TIMEOUT_MS = 10_000;

export async function loadTiledMap(url: string, signal?: AbortSignal): Promise<ParsedMap> {
  // Create a timeout abort if no external signal, or combine with external signal
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MAP_LOAD_TIMEOUT_MS);

  // If the caller provides a signal, forward its abort
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeoutId);
      throw new DOMException('Aborted', 'AbortError');
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Failed to load map: ${response.status} ${url}`);
    }
    const json = (await response.json()) as TiledMap;
    return parseTiledMap(json);
  } finally {
    clearTimeout(timeoutId);
  }
}

export function extractLocationObjects(parsed: ParsedMap): TiledObject[] {
  return parsed.locationObjects;
}
