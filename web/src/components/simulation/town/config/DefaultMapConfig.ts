/**
 * Default map configuration for unmapped worlds.
 * Generates a simple grid map with auto-labeled locations based on
 * the locations discovered in agent state.
 */

import type { TiledMap, TiledObject } from '../maps/types';

const BASE = import.meta.env.BASE_URL ?? '/';

export function generateDefaultMap(
  locationIds: string[],
  cols: number = 4,
): TiledMap {
  const count = Math.max(locationIds.length, 4);
  const rows = Math.ceil(count / cols);
  const tileW = 16;
  const tileH = 16;
  const regionW = 4; // tiles per region width
  const regionH = 3; // tiles per region height
  const margin = 1; // tile margin around each region

  const mapW = cols * (regionW + margin) + margin;
  const mapH = rows * (regionH + margin) + margin;

  // Generate ground tile data
  const data: number[] = [];
  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      data.push(isPathTile(x, y, cols, rows, regionW, regionH, margin) ? 2 : 1);
    }
  }

  // Generate location objects
  const locationObjects: TiledObject[] = [];
  for (let i = 0; i < locationIds.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const px = (margin + col * (regionW + margin)) * tileW;
    const py = (margin + row * (regionH + margin)) * tileH;

    locationObjects.push({
      id: i + 1,
      name: locationIds[i],
      type: 'location',
      x: px,
      y: py,
      width: regionW * tileW,
      height: regionH * tileH,
      rotation: 0,
      visible: true,
    });
  }

  return {
    width: mapW,
    height: mapH,
    tilewidth: tileW,
    tileheight: tileH,
    orientation: 'orthogonal',
    renderorder: 'right-down',
    tilesets: [
      {
        firstgid: 1,
        name: 'generated-tiles',
        image: `${BASE}assets/maps/default/tileset.png`,
        imagewidth: 128,
        imageheight: 128,
        tilewidth: tileW,
        tileheight: tileH,
        tilecount: 64,
        columns: 8,
      },
    ],
    layers: [
      {
        id: 1,
        name: 'ground',
        type: 'tilelayer',
        width: mapW,
        height: mapH,
        visible: true,
        opacity: 1,
        x: 0,
        y: 0,
        data,
      },
      {
        id: 2,
        name: 'locations',
        type: 'objectgroup',
        visible: true,
        opacity: 1,
        x: 0,
        y: 0,
        objects: locationObjects,
      },
    ],
  };
}

function isPathTile(
  x: number,
  y: number,
  cols: number,
  rows: number,
  regionW: number,
  regionH: number,
  margin: number,
): boolean {
  const cellW = regionW + margin;
  const cellH = regionH + margin;

  // Check if tile is within any region
  const localX = x % cellW;
  const localY = y % cellH;
  const col = Math.floor(x / cellW);
  const row = Math.floor(y / cellH);

  if (col < cols && row < rows && localX >= margin && localY >= margin) {
    return true;
  }

  return false;
}

export function extractDiscoveredLocations(
  agentStates: Record<string, { worldProjection?: { active_location_id?: string | null } | null }>,
): string[] {
  const locationSet = new Set<string>();

  for (const state of Object.values(agentStates)) {
    const locId = state.worldProjection?.active_location_id;
    if (locId) locationSet.add(locId);
  }

  return [...locationSet].sort();
}
