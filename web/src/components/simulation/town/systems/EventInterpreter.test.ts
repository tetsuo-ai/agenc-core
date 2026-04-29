import { describe, expect, it } from 'vitest';
import { interpretEvent, interpretEvents } from './EventInterpreter';
import type { SimulationEvent } from '../../useSimulation';

function makeEvent(overrides: Partial<SimulationEvent>): SimulationEvent {
  return {
    type: 'action',
    step: 1,
    simulation_id: 'sim-1',
    world_id: 'test',
    workspace_id: 'ws-1',
    agent_name: 'Alice',
    ...overrides,
  };
}

describe('EventInterpreter', () => {
  it('returns null for events without agent_name', () => {
    const result = interpretEvent(makeEvent({ agent_name: undefined }));
    expect(result).toBeNull();
  });

  it('interprets action with destination as move command', () => {
    const result = interpretEvent(
      makeEvent({
        type: 'action',
        content: 'walking to market',
        intent: { destination: 'market' },
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('move');
    expect(result!.destination).toBe('market');
    expect(result!.agentName).toBe('Alice');
  });

  it('interprets action without destination as action command', () => {
    const result = interpretEvent(
      makeEvent({
        type: 'action',
        content: 'crafting a sword',
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('action');
    expect(result!.text).toBe('crafting a sword');
  });

  it('interprets observation as speech', () => {
    const result = interpretEvent(
      makeEvent({
        type: 'observation',
        content: 'The market is bustling with activity today.',
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('speech');
    expect(result!.text).toBe('The market is bustling with activity today.');
  });

  it('interprets resolution as speech', () => {
    const result = interpretEvent(
      makeEvent({
        type: 'resolution',
        resolved_event: 'Trade completed successfully.',
      }),
    );
    expect(result!.type).toBe('speech');
    expect(result!.text).toBe('Trade completed successfully.');
  });

  it('interprets scene_change as move', () => {
    const result = interpretEvent(
      makeEvent({
        type: 'scene_change',
        scene: 'town-hall',
      }),
    );
    expect(result!.type).toBe('move');
    expect(result!.destination).toBe('town-hall');
  });

  it('returns null for unknown event types', () => {
    const result = interpretEvent(
      makeEvent({ type: 'step' }),
    );
    expect(result).toBeNull();
  });

  it('truncates long text', () => {
    const longText = 'A'.repeat(100);
    const result = interpretEvent(
      makeEvent({
        type: 'observation',
        content: longText,
      }),
    );
    expect(result!.text!.length).toBeLessThanOrEqual(60);
    expect(result!.text!.endsWith('...')).toBe(true);
  });

  it('extracts destination from action_spec', () => {
    const result = interpretEvent(
      makeEvent({
        type: 'action',
        action_spec: { destination: 'smithy' },
      }),
    );
    expect(result!.type).toBe('move');
    expect(result!.destination).toBe('smithy');
  });

  it('interprets reflection as speech', () => {
    const result = interpretEvent(
      makeEvent({
        type: 'reflection',
        content: 'I should visit the market.',
      }),
    );
    expect(result!.type).toBe('speech');
    expect(result!.text).toBe('I should visit the market.');
  });

  it('interpretEvents processes array of events', () => {
    const events = [
      makeEvent({ type: 'observation', content: 'Hello' }),
      makeEvent({ type: 'step', agent_name: undefined }),
      makeEvent({ type: 'action', content: 'walking', intent: { destination: 'market' } }),
    ];
    const commands = interpretEvents(events);
    expect(commands).toHaveLength(2);
    expect(commands[0].type).toBe('speech');
    expect(commands[1].type).toBe('move');
  });
});
