import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulationViewer } from './SimulationViewer';
import type { SimulationRecord, SimulationStatus } from './useSimulation';

const useSimulationMock = vi.fn();

vi.mock('./useSimulation', () => ({
  useSimulation: (args: unknown) => useSimulationMock(args),
}));

vi.mock('./SimulationControls', () => ({
  SimulationControls: ({ status }: { status: SimulationStatus }) => (
    <div data-testid="simulation-controls">
      <button type="button" disabled={status.status !== 'paused'}>Play</button>
      <button type="button" disabled={status.status !== 'running'}>Pause</button>
      <button type="button" disabled={status.status !== 'running' && status.status !== 'paused'}>Step</button>
      <button
        type="button"
        disabled={['stopped', 'finished', 'failed', 'archived', 'deleted'].includes(status.status)}
      >
        Stop
      </button>
    </div>
  ),
}));

vi.mock('./AgentCard', () => ({ AgentCard: () => <div data-testid="agent-card" /> }));
vi.mock('./EventTimeline', () => ({ EventTimeline: () => <div data-testid="event-timeline" /> }));
vi.mock('./WorldStatePanel', () => ({ WorldStatePanel: () => <div data-testid="world-state" /> }));
vi.mock('./AgentInspector', () => ({ AgentInspector: () => <div data-testid="agent-inspector" /> }));

function makeRecord(overrides: Partial<SimulationRecord> = {}): SimulationRecord {
  return {
    simulation_id: 'sim-1',
    world_id: 'market-town',
    workspace_id: 'ws-1',
    lineage_id: null,
    parent_simulation_id: null,
    status: 'running',
    reason: null,
    error: null,
    created_at: 1,
    updated_at: 2,
    started_at: 1,
    ended_at: null,
    agent_ids: ['agent-a'],
    current_alias: false,
    pid: 11,
    last_completed_step: 1,
    last_step_outcome: 'idle',
    replay_event_count: 1,
    checkpoint: null,
    agents: [{ agent_id: 'agent-a', agent_name: 'Agent A', personality: 'steady', goal: 'watch' }],
    premise: 'A market square',
    max_steps: 10,
    gm_model: 'grok-test',
    gm_provider: 'grok',
    ...overrides,
  };
}

function makeStatus(overrides: Partial<SimulationStatus> = {}): SimulationStatus {
  return {
    simulation_id: 'sim-1',
    world_id: 'market-town',
    workspace_id: 'ws-1',
    status: 'running',
    reason: null,
    error: null,
    step: 1,
    max_steps: 10,
    running: true,
    paused: false,
    agent_count: 1,
    started_at: 1,
    ended_at: null,
    updated_at: 2,
    last_step_outcome: 'idle',
    terminal_reason: null,
    checkpoint: null,
    ...overrides,
  };
}

describe('SimulationViewer', () => {
  beforeEach(() => {
    useSimulationMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows historical detail mode as read-only for archived simulations', () => {
    useSimulationMock.mockReturnValue({
      state: {
        status: makeStatus({
          status: 'archived',
          running: false,
          paused: false,
          terminal_reason: 'archived',
        }),
        events: [],
        agentStates: {},
        connected: false,
        error: null,
        notFound: false,
        transportState: 'disconnected',
      },
      play: vi.fn(),
      pause: vi.fn(),
      step: vi.fn(),
      stop: vi.fn(),
    });

    render(<SimulationViewer simulation={makeRecord({ status: 'archived', ended_at: 5 })} />);

    expect(screen.getByText('historical detail')).toBeTruthy();
    const buttons = Object.fromEntries(
      screen.getAllByRole('button').map((button) => [button.textContent ?? '', button as HTMLButtonElement]),
    );
    expect(buttons.Play.disabled).toBe(true);
    expect(buttons.Pause.disabled).toBe(true);
    expect(buttons.Step.disabled).toBe(true);
    expect(buttons.Stop.disabled).toBe(true);
  });

  it('disables invalid lifecycle actions for paused simulations while keeping valid ones enabled', () => {
    useSimulationMock.mockReturnValue({
      state: {
        status: makeStatus({
          status: 'paused',
          running: false,
          paused: true,
          step: 3,
        }),
        events: [],
        agentStates: {},
        connected: true,
        error: null,
        notFound: false,
        transportState: 'disconnected',
      },
      play: vi.fn(),
      pause: vi.fn(),
      step: vi.fn(),
      stop: vi.fn(),
    });

    render(<SimulationViewer simulation={makeRecord({ status: 'paused', last_completed_step: 3 })} />);

    const buttons = Object.fromEntries(
      screen.getAllByRole('button').map((button) => [button.textContent ?? '', button as HTMLButtonElement]),
    );
    expect(buttons.Play.disabled).toBe(false);
    expect(buttons.Pause.disabled).toBe(true);
    expect(buttons.Step.disabled).toBe(false);
    expect(buttons.Stop.disabled).toBe(false);
  });
});
