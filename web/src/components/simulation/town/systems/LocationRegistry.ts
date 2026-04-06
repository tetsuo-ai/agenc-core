/**
 * Maps Concordia string location IDs to pixel regions on the Tiled map.
 * Resolution chain: exact → fuzzy → scene → zone → center fallback.
 */

import type { TiledObject } from '../maps/types';

export interface TileRegion {
  locationId: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

export interface LocationRegistryInstance {
  regions: ReadonlyMap<string, TileRegion>;
  resolve(
    locationId: string | null,
    sceneId?: string | null,
    zoneId?: string | null,
  ): TileRegion;
  randomPointInRegion(locationId: string): { x: number; y: number };
  has(locationId: string): boolean;
}

function normalizeId(id: string): string {
  return id
    .toLowerCase()
    .replace(/[:\s_]/g, '-')
    .replace(/^the-/, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function buildRegion(obj: TiledObject): TileRegion {
  return {
    locationId: obj.name,
    label: obj.name,
    x: obj.x,
    y: obj.y,
    width: obj.width,
    height: obj.height,
    centerX: obj.x + obj.width / 2,
    centerY: obj.y + obj.height / 2,
  };
}

export function createLocationRegistry(
  locationObjects: TiledObject[],
  mapPixelWidth: number,
  mapPixelHeight: number,
): LocationRegistryInstance {
  const regions = new Map<string, TileRegion>();
  const normalizedIndex = new Map<string, TileRegion>();

  for (const obj of locationObjects) {
    const region = buildRegion(obj);
    regions.set(obj.name, region);
    normalizedIndex.set(normalizeId(obj.name), region);
  }

  const fallback: TileRegion = {
    locationId: '__fallback__',
    label: '?',
    x: mapPixelWidth / 4,
    y: mapPixelHeight / 4,
    width: mapPixelWidth / 2,
    height: mapPixelHeight / 2,
    centerX: mapPixelWidth / 2,
    centerY: mapPixelHeight / 2,
  };

  function resolve(
    locationId: string | null,
    sceneId?: string | null,
    zoneId?: string | null,
  ): TileRegion {
    // 1. Exact match
    if (locationId && regions.has(locationId)) {
      return regions.get(locationId)!;
    }

    // 2. Fuzzy match
    if (locationId) {
      const normalized = normalizeId(locationId);
      if (normalizedIndex.has(normalized)) {
        return normalizedIndex.get(normalized)!;
      }
    }

    // 3. Scene match
    if (sceneId) {
      if (regions.has(sceneId)) return regions.get(sceneId)!;
      const normScene = normalizeId(sceneId);
      if (normalizedIndex.has(normScene)) return normalizedIndex.get(normScene)!;
    }

    // 4. Zone match
    if (zoneId) {
      if (regions.has(zoneId)) return regions.get(zoneId)!;
      const normZone = normalizeId(zoneId);
      if (normalizedIndex.has(normZone)) return normalizedIndex.get(normZone)!;
    }

    // 5. Fallback to center
    return fallback;
  }

  function randomPointInRegion(locationId: string): { x: number; y: number } {
    const region = resolve(locationId);

    // Guard: if region has zero or negative dimensions, return center
    if (region.width <= 0 || region.height <= 0) {
      return { x: region.centerX, y: region.centerY };
    }

    const margin = Math.min(region.width, region.height) * 0.2;
    const innerW = region.width - 2 * margin;
    const innerH = region.height - 2 * margin;

    // If margins consume the entire region, just return center
    if (innerW <= 0 || innerH <= 0) {
      return { x: region.centerX, y: region.centerY };
    }

    return {
      x: region.x + margin + Math.random() * innerW,
      y: region.y + margin + Math.random() * innerH,
    };
  }

  function has(locationId: string): boolean {
    return regions.has(locationId) || normalizedIndex.has(normalizeId(locationId));
  }

  return { regions, resolve, randomPointInRegion, has };
}
