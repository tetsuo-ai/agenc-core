import { describe, expect, it } from 'vitest';
import { createLocationRegistry } from './LocationRegistry';
import type { TiledObject } from '../maps/types';

function makeObject(name: string, x: number, y: number, w: number, h: number): TiledObject {
  return {
    id: 0,
    name,
    type: 'location',
    x,
    y,
    width: w,
    height: h,
    rotation: 0,
    visible: true,
  };
}

const OBJECTS: TiledObject[] = [
  makeObject('market', 100, 100, 80, 60),
  makeObject('smithy', 10, 10, 50, 40),
  makeObject('healing-house', 200, 50, 60, 50),
  makeObject('town-hall', 10, 200, 70, 60),
];

const MAP_W = 320;
const MAP_H = 240;

describe('LocationRegistry', () => {
  it('resolves exact location ID', () => {
    const reg = createLocationRegistry(OBJECTS, MAP_W, MAP_H);
    const region = reg.resolve('market');
    expect(region.locationId).toBe('market');
    expect(region.centerX).toBe(140);
    expect(region.centerY).toBe(130);
  });

  it('resolves fuzzy match with colon separator', () => {
    const reg = createLocationRegistry(OBJECTS, MAP_W, MAP_H);
    const region = reg.resolve('healing:house');
    expect(region.locationId).toBe('healing-house');
  });

  it('resolves fuzzy match with underscore', () => {
    const reg = createLocationRegistry(OBJECTS, MAP_W, MAP_H);
    const region = reg.resolve('town_hall');
    expect(region.locationId).toBe('town-hall');
  });

  it('falls back to scene ID', () => {
    const reg = createLocationRegistry(OBJECTS, MAP_W, MAP_H);
    const region = reg.resolve('nonexistent', 'smithy');
    expect(region.locationId).toBe('smithy');
  });

  it('falls back to zone ID', () => {
    const reg = createLocationRegistry(OBJECTS, MAP_W, MAP_H);
    const region = reg.resolve('nonexistent', 'also-nope', 'market');
    expect(region.locationId).toBe('market');
  });

  it('returns center fallback for unknown IDs', () => {
    const reg = createLocationRegistry(OBJECTS, MAP_W, MAP_H);
    const region = reg.resolve('nowhere');
    expect(region.locationId).toBe('__fallback__');
    expect(region.label).toBe('?');
    expect(region.centerX).toBe(MAP_W / 2);
    expect(region.centerY).toBe(MAP_H / 2);
  });

  it('returns center fallback for null location', () => {
    const reg = createLocationRegistry(OBJECTS, MAP_W, MAP_H);
    const region = reg.resolve(null);
    expect(region.locationId).toBe('__fallback__');
  });

  it('has() returns true for exact and fuzzy matches', () => {
    const reg = createLocationRegistry(OBJECTS, MAP_W, MAP_H);
    expect(reg.has('market')).toBe(true);
    expect(reg.has('town_hall')).toBe(true);
    expect(reg.has('nonexistent')).toBe(false);
  });

  it('randomPointInRegion returns point within region bounds', () => {
    const reg = createLocationRegistry(OBJECTS, MAP_W, MAP_H);
    for (let i = 0; i < 20; i++) {
      const pt = reg.randomPointInRegion('market');
      expect(pt.x).toBeGreaterThanOrEqual(100);
      expect(pt.x).toBeLessThanOrEqual(180);
      expect(pt.y).toBeGreaterThanOrEqual(100);
      expect(pt.y).toBeLessThanOrEqual(160);
    }
  });

  it('strips "the-" prefix during fuzzy match', () => {
    const reg = createLocationRegistry(OBJECTS, MAP_W, MAP_H);
    const region = reg.resolve('the-market');
    expect(region.locationId).toBe('market');
  });
});
