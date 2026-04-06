import { describe, expect, it } from 'vitest';
import { parseTiledMap, extractLocationObjects } from './TiledMapLoader';
import type { TiledMap } from './types';

const FIXTURE: TiledMap = {
  width: 10,
  height: 8,
  tilewidth: 16,
  tileheight: 16,
  orientation: 'orthogonal',
  renderorder: 'right-down',
  tilesets: [
    {
      firstgid: 1,
      name: 'test-tiles',
      image: 'test.png',
      imagewidth: 64,
      imageheight: 64,
      tilewidth: 16,
      tileheight: 16,
      tilecount: 16,
      columns: 4,
    },
  ],
  layers: [
    {
      id: 1,
      name: 'ground',
      type: 'tilelayer' as const,
      width: 10,
      height: 8,
      visible: true,
      opacity: 1,
      x: 0,
      y: 0,
      data: Array(80).fill(1),
    },
    {
      id: 2,
      name: 'collision',
      type: 'tilelayer' as const,
      width: 10,
      height: 8,
      visible: false,
      opacity: 1,
      x: 0,
      y: 0,
      data: [
        0,0,0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,0,0,
        0,0,1,1,0,0,1,1,0,0,
        0,0,1,1,0,0,1,1,0,0,
        0,0,0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,0,0,
      ],
    },
    {
      id: 3,
      name: 'locations',
      type: 'objectgroup' as const,
      visible: true,
      opacity: 1,
      x: 0,
      y: 0,
      objects: [
        { id: 1, name: 'market', type: 'location', x: 0, y: 0, width: 80, height: 64, rotation: 0, visible: true },
        { id: 2, name: 'smithy', type: 'location', x: 80, y: 0, width: 80, height: 64, rotation: 0, visible: true },
      ],
    },
  ],
};

describe('parseTiledMap', () => {
  it('extracts map dimensions', () => {
    const parsed = parseTiledMap(FIXTURE);
    expect(parsed.width).toBe(10);
    expect(parsed.height).toBe(8);
    expect(parsed.tileWidth).toBe(16);
    expect(parsed.tileHeight).toBe(16);
    expect(parsed.pixelWidth).toBe(160);
    expect(parsed.pixelHeight).toBe(128);
  });

  it('separates tile layers from collision', () => {
    const parsed = parseTiledMap(FIXTURE);
    // collision layer is excluded from tileLayers
    expect(parsed.tileLayers).toHaveLength(1);
    expect(parsed.tileLayers[0].name).toBe('ground');
  });

  it('extracts collision grid', () => {
    const parsed = parseTiledMap(FIXTURE);
    expect(parsed.collisionGrid).not.toBeNull();
    expect(parsed.collisionGrid![2][2]).toBe(1); // blocked
    expect(parsed.collisionGrid![0][0]).toBe(0); // walkable
  });

  it('extracts location objects', () => {
    const parsed = parseTiledMap(FIXTURE);
    expect(parsed.locationObjects).toHaveLength(2);
    expect(parsed.locationObjects[0].name).toBe('market');
    expect(parsed.locationObjects[1].name).toBe('smithy');
  });

  it('extractLocationObjects helper works', () => {
    const parsed = parseTiledMap(FIXTURE);
    const locs = extractLocationObjects(parsed);
    expect(locs).toHaveLength(2);
  });

  it('handles map with no collision layer', () => {
    const noCollision: TiledMap = {
      ...FIXTURE,
      layers: [FIXTURE.layers[0], FIXTURE.layers[2]],
    };
    const parsed = parseTiledMap(noCollision);
    expect(parsed.collisionGrid).toBeNull();
    expect(parsed.tileLayers).toHaveLength(1);
  });

  it('handles map with no location objects', () => {
    const noLocations: TiledMap = {
      ...FIXTURE,
      layers: [FIXTURE.layers[0]],
    };
    const parsed = parseTiledMap(noLocations);
    expect(parsed.locationObjects).toHaveLength(0);
  });
});
