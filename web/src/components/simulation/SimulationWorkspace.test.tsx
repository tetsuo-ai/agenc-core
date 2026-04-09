import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulationWorkspace } from './SimulationWorkspace';
import type { SimulationWorkspaceRoute } from './navigation';

let viewerSimulationId: string | null = null;
let setupUnmountCount = 0;

const launchConfig = {
  worldId: 'draft-world',
  premise: 'Draft premise',
  maxSteps: 10,
  gmModel: 'grok-test',
  gmProvider: 'grok',
  engineType: 'simultaneous' as const,
  agents: [
    { id: 'a', name: 'Agent A', personality: 'steady', goal: 'watch' },
    { id: 'b', name: 'Agent B', personality: 'curious', goal: 'move' },
  ],
};

vi.mock('./SimulationViewer', () => ({
  SimulationViewer: ({ simulation }: { simulation: { simulation_id: string; world_id: string } }) => {
    viewerSimulationId = simulation.simulation_id;
    return <div data-testid="simulation-viewer">viewer:{simulation.world_id}</div>;
  },
}));

vi.mock('./SimulationSetup', () => ({
  SimulationSetup: ({ onLaunch }: { onLaunch: (config: typeof launchConfig) => void }) => {
    const [draft, setDraft] = React.useState('fresh draft');
    React.useEffect(() => () => {
      setupUnmountCount += 1;
    }, []);
    return (
      <div data-testid="simulation-setup">
        <div data-testid="setup-draft">{draft}</div>
        <button type="button" onClick={() => setDraft('persisted draft')}>Persist Draft</button>
        <button type="button" onClick={() => onLaunch(launchConfig)}>Launch Draft</button>
      </div>
    );
  },
}));

function makeSummary(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    simulation_id: 'sim-running',
    world_id: 'world-running',
    workspace_id: 'ws',
    lineage_id: 'lineage-1',
    parent_simulation_id: null,
    status: 'running',
    reason: null,
    error: null,
    created_at: 1,
    updated_at: 2,
    started_at: 1,
    ended_at: null,
    agent_ids: ['a', 'b'],
    current_alias: true,
    pid: 42,
    last_completed_step: 3,
    last_step_outcome: 'step_done',
    replay_event_count: 12,
    checkpoint: null,
    ...overrides,
  };
}

function makeRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ...makeSummary(),
    agents: [
      { agent_id: 'a', agent_name: 'Agent A', personality: 'steady', goal: 'watch' },
      { agent_id: 'b', agent_name: 'Agent B', personality: 'curious', goal: 'move' },
    ],
    premise: 'A premise',
    max_steps: 10,
    gm_model: 'grok-test',
    gm_provider: 'grok',
    ...overrides,
  };
}

describe('SimulationWorkspace', () => {
  const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();

  beforeEach(() => {
    viewerSimulationId = null;
    setupUnmountCount = 0;
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the explicit no-sims-yet dashboard state', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ simulations: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    render(
      <SimulationWorkspace
        active
        bridgeUrl="http://localhost:3200"
        route={{ mode: 'dashboard', simulationId: null }}
        onRouteChange={() => {}}
      />,
    );

    await screen.findByText('No sims yet. Launch one to populate the dashboard.');
  });

  it('re-discovers active simulations after a workspace remount', async () => {
    fetchMock.mockImplementation(async () => (
      new Response(JSON.stringify({
        simulations: [makeSummary()],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    ));

    const first = render(
      <SimulationWorkspace
        active
        bridgeUrl="http://localhost:3200"
        route={{ mode: 'dashboard', simulationId: null }}
        onRouteChange={() => {}}
      />,
    );

    expect((await screen.findAllByText('world-running')).length).toBeGreaterThan(0);
    first.unmount();

    render(
      <SimulationWorkspace
        active
        bridgeUrl="http://localhost:3200"
        route={{ mode: 'dashboard', simulationId: null }}
        onRouteChange={() => {}}
      />,
    );

    expect((await screen.findAllByText('world-running')).length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('hydrates detail mode from the selected simulation record and lists active/recent cards', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/simulations')) {
        return new Response(JSON.stringify({
          simulations: [
            makeSummary(),
            makeSummary({
              simulation_id: 'sim-archived',
              world_id: 'world-archived',
              status: 'archived',
              current_alias: false,
              updated_at: 5,
            }),
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/simulations/sim-running')) {
        return new Response(JSON.stringify(makeRecord()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error('unexpected fetch ' + url);
    });

    const onRouteChange = vi.fn();
    render(
      <SimulationWorkspace
        active
        bridgeUrl="http://localhost:3200"
        route={{ mode: 'detail', simulationId: 'sim-running' }}
        onRouteChange={onRouteChange}
      />,
    );

    await screen.findByTestId('simulation-viewer');
    expect(viewerSimulationId).toBe('sim-running');
    expect(screen.getByText('Active Sims')).toBeTruthy();
    expect(screen.getByText('Recent Sims')).toBeTruthy();

    fireEvent.click(screen.getAllByText('world-archived')[0]!);
    expect(onRouteChange).toHaveBeenCalledWith({ mode: 'detail', simulationId: 'sim-archived' });
  });

  it('shows sim-not-found state when the selected simulation disappears', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/simulations')) {
        return new Response(JSON.stringify({ simulations: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/simulations/sim-missing')) {
        return new Response(JSON.stringify({ error: 'missing' }), { status: 404 });
      }
      throw new Error('unexpected fetch ' + url);
    });

    const onRouteChange = vi.fn();
    render(
      <SimulationWorkspace
        active
        bridgeUrl="http://localhost:3200"
        route={{ mode: 'detail', simulationId: 'sim-missing' }}
        onRouteChange={onRouteChange}
      />,
    );

    await screen.findByText(/Simulation not found/i);
    fireEvent.click(screen.getByText('Return to Dashboard'));
    expect(onRouteChange).toHaveBeenCalledWith({ mode: 'dashboard', simulationId: null });
  });

  it('keeps setup drafts mounted across route changes', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ simulations: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const route: SimulationWorkspaceRoute = { mode: 'setup', simulationId: null };
    const { rerender } = render(
      <SimulationWorkspace
        active
        bridgeUrl="http://localhost:3200"
        route={route}
        onRouteChange={() => {}}
      />,
    );

    await screen.findByTestId('simulation-setup');
    fireEvent.click(screen.getByText('Persist Draft'));
    expect(screen.getByTestId('setup-draft').textContent).toBe('persisted draft');

    rerender(
      <SimulationWorkspace
        active
        bridgeUrl="http://localhost:3200"
        route={{ mode: 'dashboard', simulationId: null }}
        onRouteChange={() => {}}
      />,
    );

    rerender(
      <SimulationWorkspace
        active
        bridgeUrl="http://localhost:3200"
        route={{ mode: 'setup', simulationId: null }}
        onRouteChange={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('setup-draft').textContent).toBe('persisted draft');
      expect(setupUnmountCount).toBe(0);
    });
  });
});
