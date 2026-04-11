import { describe, expect, it } from 'vitest';
import { computeAgentPositions } from './useTownState';
import { createLocationRegistry } from '../systems/LocationRegistry';
import type { AgentState } from '../../useSimulation';
import type { TiledObject } from '../maps/types';

function makeAgent(locationId: string | null): AgentState {
  return {
    identity: { name: 'TestAgent', personality: '', learnedTraits: [], beliefs: {} },
    memoryCount: 0,
    recentMemories: [],
    relationships: [],
    worldFacts: [],
    turnCount: 0,
    lastAction: null,
    worldProjection: {
      active_location_id: locationId,
    },
  };
}

function makeObject(name: string, x: number, y: number): TiledObject {
  return {
    id: 0, name, type: 'location',
    x, y, width: 80, height: 60,
    rotation: 0, visible: true,
  };
}

const registry = createLocationRegistry(
  [
    makeObject('market', 100, 100),
    makeObject('smithy', 10, 10),
  ],
  320, 240,
);

describe('computeAgentPositions', () => {
  it('places agents at their location region', () => {
    const agents = computeAgentPositions(
      { 'a1': makeAgent('market') },
      registry,
      new Map(),
    );
    expect(agents).toHaveLength(1);
    expect(agents[0].agentId).toBe('a1');
    // Target should be within market bounds (100-180, 100-160)
    expect(agents[0].targetX).toBeGreaterThanOrEqual(100);
    expect(agents[0].targetX).toBeLessThanOrEqual(180);
  });

  it('returns empty when registry is null', () => {
    const agents = computeAgentPositions(
      { 'a1': makeAgent('market') },
      null,
      new Map(),
    );
    expect(agents).toHaveLength(0);
  });

  it('marks agent as moving when location changes', () => {
    const prev = new Map([
      ['a1', { x: 50, y: 50, locationId: 'smithy' }],
    ]);
    const agents = computeAgentPositions(
      { 'a1': makeAgent('market') },
      registry,
      prev,
    );
    expect(agents[0].moving).toBe(true);
    expect(agents[0].currentX).toBe(50);
    expect(agents[0].currentY).toBe(50);
  });

  it('does not mark as moving when location is unchanged', () => {
    const prev = new Map([
      ['a1', { x: 140, y: 130, locationId: 'market' }],
    ]);
    const agents = computeAgentPositions(
      { 'a1': makeAgent('market') },
      registry,
      prev,
    );
    expect(agents[0].moving).toBe(false);
  });

  it('assigns different colors to different agents', () => {
    const agents = computeAgentPositions(
      {
        'a1': makeAgent('market'),
        'a2': makeAgent('smithy'),
      },
      registry,
      new Map(),
    );
    expect(agents[0].color).not.toBe(agents[1].color);
  });

  it('uses fallback position for unknown location', () => {
    const agents = computeAgentPositions(
      { 'a1': makeAgent('unknown-place') },
      registry,
      new Map(),
    );
    expect(agents).toHaveLength(1);
    // Should land near center fallback
    expect(agents[0].targetX).toBeGreaterThan(0);
  });
});
