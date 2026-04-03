import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSimulation, type AgentState, type SimulationEvent, type SimulationStatus } from './useSimulation';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function makeStatus(overrides: Partial<SimulationStatus> = {}): SimulationStatus {
  return {
    simulation_id: 'sim-a',
    world_id: 'world-a',
    workspace_id: 'ws-a',
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
    last_step_outcome: 'step_done',
    terminal_reason: null,
    checkpoint: null,
    ...overrides,
  };
}

function makeEvent(eventId: string, overrides: Partial<SimulationEvent> = {}): SimulationEvent {
  return {
    event_id: eventId,
    type: 'world_event',
    step: 1,
    timestamp: 1,
    simulation_id: 'sim-a',
    world_id: 'world-a',
    workspace_id: 'ws-a',
    content: eventId,
    ...overrides,
  };
}

function makeAgentState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    identity: null,
    memoryCount: 0,
    recentMemories: [],
    relationships: [],
    worldFacts: [],
    turnCount: 0,
    lastAction: null,
    ...overrides,
  };
}

class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;

  constructor(url: string | URL) {
    this.url = String(url);
    MockEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  emitOpen() {
    this.onopen?.(new Event('open'));
  }

  emitError() {
    this.onerror?.(new Event('error'));
  }

  emitMessage(event: SimulationEvent) {
    this.onmessage?.({
      data: JSON.stringify(event),
      lastEventId: event.event_id ?? '',
    } as MessageEvent);
  }

  static reset() {
    MockEventSource.instances = [];
  }
}

describe('useSimulation', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    MockEventSource.reset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('ignores late responses from a previously selected simulation', async () => {
    const staleStatus = deferred<Response>();

    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/simulations/sim-1/events')) {
        return jsonResponse({
          simulation_id: 'sim-1',
          events: [makeEvent('evt-1', { simulation_id: 'sim-1', world_id: 'world-1' })],
          next_cursor: 'evt-1',
        });
      }
      if (url.endsWith('/simulations/sim-1/status')) {
        return staleStatus.promise;
      }
      if (url.endsWith('/simulations/sim-2/events')) {
        return jsonResponse({
          simulation_id: 'sim-2',
          events: [makeEvent('evt-2', { simulation_id: 'sim-2', world_id: 'world-2' })],
          next_cursor: 'evt-2',
        });
      }
      if (url.endsWith('/simulations/sim-2/status')) {
        return jsonResponse(
          makeStatus({
            simulation_id: 'sim-2',
            world_id: 'world-2',
            status: 'paused',
            running: false,
            paused: true,
            step: 2,
          }),
        );
      }
      throw new Error('unexpected fetch ' + url);
    });

    const { result, rerender } = renderHook(
      ({ simulationId, initialStatus }) => useSimulation({
        simulationId,
        bridgeUrl: 'http://localhost:3200',
        agentIds: [],
        active: true,
        pollIntervalMs: 1000,
        initialStatus,
      }),
      {
        initialProps: {
          simulationId: 'sim-1',
          initialStatus: makeStatus({
            simulation_id: 'sim-1',
            world_id: 'world-1',
            status: 'running',
            running: true,
          }),
        },
      },
    );

    await waitFor(() => {
      expect(result.current.state.events.map((event) => event.event_id)).toEqual(['evt-1']);
    });

    rerender({
      simulationId: 'sim-2',
      initialStatus: makeStatus({
        simulation_id: 'sim-2',
        world_id: 'world-2',
        status: 'paused',
        running: false,
        paused: true,
        step: 2,
      }),
    });

    await waitFor(() => {
      expect(result.current.state.events.map((event) => event.event_id)).toEqual(['evt-2']);
      expect(result.current.state.status.simulation_id).toBe('sim-2');
    });

    await act(async () => {
      staleStatus.resolve(jsonResponse(makeStatus({
        simulation_id: 'sim-1',
        world_id: 'world-1',
        status: 'running',
        running: true,
        step: 99,
      })));
      await Promise.resolve();
    });

    expect(result.current.state.status.simulation_id).toBe('sim-2');
    expect(result.current.state.status.step).not.toBe(99);
    expect(result.current.state.events.every((event) => event.simulation_id === 'sim-2')).toBe(true);
  });

  it('swallows aborted replay hydration during selection changes', async () => {
    const aborted = deferred<Response>();

    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/simulations/sim-1/events')) {
        return aborted.promise;
      }
      if (url.endsWith('/simulations/sim-1/status')) {
        return jsonResponse(makeStatus({
          simulation_id: 'sim-1',
          world_id: 'world-1',
          status: 'running',
          running: true,
        }));
      }
      if (url.endsWith('/simulations/sim-2/events')) {
        return jsonResponse({
          simulation_id: 'sim-2',
          events: [makeEvent('evt-2', { simulation_id: 'sim-2', world_id: 'world-2' })],
          next_cursor: 'evt-2',
        });
      }
      if (url.endsWith('/simulations/sim-2/status')) {
        return jsonResponse(makeStatus({
          simulation_id: 'sim-2',
          world_id: 'world-2',
          status: 'paused',
          running: false,
          paused: true,
        }));
      }
      throw new Error('unexpected fetch ' + url);
    });

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { result, rerender } = renderHook(
      ({ simulationId, initialStatus }) => useSimulation({
        simulationId,
        bridgeUrl: 'http://localhost:3200',
        agentIds: [],
        active: true,
        pollIntervalMs: 1000,
        initialStatus,
      }),
      {
        initialProps: {
          simulationId: 'sim-1',
          initialStatus: makeStatus({
            simulation_id: 'sim-1',
            world_id: 'world-1',
            status: 'running',
            running: true,
          }),
        },
      },
    );

    rerender({
      simulationId: 'sim-2',
      initialStatus: makeStatus({
        simulation_id: 'sim-2',
        world_id: 'world-2',
        status: 'paused',
        running: false,
        paused: true,
      }),
    });

    await act(async () => {
      aborted.reject(new DOMException('Aborted', 'AbortError'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.state.events.map((event) => event.event_id)).toEqual(['evt-2']);
      expect(result.current.state.status.simulation_id).toBe('sim-2');
    });

    expect(result.current.state.error).toBeNull();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('hydrates replay, catches up after reconnect, and deduplicates repeated live events', async () => {

    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/simulations/sim-live/events')) {
        return jsonResponse({
          simulation_id: 'sim-live',
          events: [
            makeEvent('evt-1', { simulation_id: 'sim-live' }),
            makeEvent('evt-2', { simulation_id: 'sim-live', step: 2 }),
          ],
          next_cursor: 'evt-2',
        });
      }
      if (url.includes('/simulations/sim-live/events?cursor=evt-3')) {
        return jsonResponse({
          simulation_id: 'sim-live',
          events: [makeEvent('evt-4', { simulation_id: 'sim-live', step: 4 })],
          next_cursor: 'evt-4',
        });
      }
      if (url.endsWith('/simulations/sim-live/status')) {
        return jsonResponse(makeStatus({
          simulation_id: 'sim-live',
          status: 'running',
          running: true,
          step: 2,
        }));
      }
      throw new Error('unexpected fetch ' + url);
    });

    const { result } = renderHook(() => useSimulation({
      simulationId: 'sim-live',
      bridgeUrl: 'http://localhost:3200',
      active: true,
      agentIds: [],
      pollIntervalMs: 1000,
      initialStatus: makeStatus({ simulation_id: 'sim-live', status: 'running', running: true }),
    }));

    await waitFor(() => {
      expect(result.current.state.events.map((event) => event.event_id)).toEqual(['evt-1', 'evt-2']);
    });
    expect(MockEventSource.instances).toHaveLength(1);
    vi.useFakeTimers();

    act(() => {
      MockEventSource.instances[0]!.emitOpen();
      MockEventSource.instances[0]!.emitMessage(makeEvent('evt-3', { simulation_id: 'sim-live', step: 3 }));
    });

    await flushAsyncWork();

    expect(result.current.state.transportState).toBe('live');
    expect(result.current.state.events.map((event) => event.event_id)).toEqual(['evt-1', 'evt-2', 'evt-3']);

    await act(async () => {
      MockEventSource.instances[0]!.emitError();
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.state.events.map((event) => event.event_id)).toEqual(['evt-1', 'evt-2', 'evt-3', 'evt-4']);
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1]!.url).toContain('cursor=evt-4');

    act(() => {
      MockEventSource.instances[1]!.emitOpen();
      MockEventSource.instances[1]!.emitMessage(makeEvent('evt-4', { simulation_id: 'sim-live', step: 4 }));
    });

    expect(result.current.state.events.map((event) => event.event_id)).toEqual(['evt-1', 'evt-2', 'evt-3', 'evt-4']);
  });

  it('keeps paused sims on heartbeat status polling while disabling repeated agent polling', async () => {
    vi.useFakeTimers();

    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/simulations/sim-paused/events')) {
        return jsonResponse({ simulation_id: 'sim-paused', events: [], next_cursor: null });
      }
      if (url.endsWith('/simulations/sim-paused/status')) {
        return jsonResponse(makeStatus({
          simulation_id: 'sim-paused',
          status: 'paused',
          running: false,
          paused: true,
        }));
      }
      if (url.endsWith('/simulations/sim-paused/agents/agent-1/state')) {
        return jsonResponse(makeAgentState({ turnCount: 1 }));
      }
      throw new Error('unexpected fetch ' + url);
    });

    renderHook(() => useSimulation({
      simulationId: 'sim-paused',
      bridgeUrl: 'http://localhost:3200',
      active: true,
      agentIds: ['agent-1'],
      pollIntervalMs: 1000,
      initialStatus: makeStatus({
        simulation_id: 'sim-paused',
        status: 'paused',
        running: false,
        paused: true,
      }),
    }));

    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/agents/agent-1/state'))).toBe(true);
    expect(MockEventSource.instances).toHaveLength(1);

    const initialStatusCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/simulations/sim-paused/status')).length;
    const initialAgentCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/agents/agent-1/state')).length;

    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    await Promise.resolve();

    const midStatusCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/simulations/sim-paused/status')).length;
    const midAgentCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/agents/agent-1/state')).length;

    expect(midStatusCalls).toBe(initialStatusCalls);
    expect(midAgentCalls).toBe(initialAgentCalls);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    await Promise.resolve();

    const finalStatusCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/simulations/sim-paused/status')).length;
    const finalAgentCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/agents/agent-1/state')).length;

    expect(finalStatusCalls).toBeGreaterThan(midStatusCalls);
    expect(finalAgentCalls).toBe(initialAgentCalls);
  });

  it('keeps archived sims disconnected after initial hydration', async () => {

    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/simulations/sim-archived/events')) {
        return jsonResponse({
          simulation_id: 'sim-archived',
          events: [makeEvent('evt-archived', { simulation_id: 'sim-archived' })],
          next_cursor: 'evt-archived',
        });
      }
      if (url.endsWith('/simulations/sim-archived/status')) {
        return jsonResponse(makeStatus({
          simulation_id: 'sim-archived',
          status: 'archived',
          running: false,
          paused: false,
        }));
      }
      if (url.endsWith('/simulations/sim-archived/agents/agent-1/state')) {
        return jsonResponse(makeAgentState({ turnCount: 9 }));
      }
      throw new Error('unexpected fetch ' + url);
    });

    const { result } = renderHook(() => useSimulation({
      simulationId: 'sim-archived',
      bridgeUrl: 'http://localhost:3200',
      active: true,
      agentIds: ['agent-1'],
      pollIntervalMs: 1000,
      initialStatus: makeStatus({
        simulation_id: 'sim-archived',
        status: 'archived',
        running: false,
        paused: false,
      }),
    }));

    await waitFor(() => {
      expect(result.current.state.events.map((event) => event.event_id)).toEqual(['evt-archived']);
      expect(result.current.state.transportState).toBe('disconnected');
    });

    expect(MockEventSource.instances).toHaveLength(0);
    vi.useFakeTimers();

    const initialStatusCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/simulations/sim-archived/status')).length;
    const initialAgentCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/agents/agent-1/state')).length;

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    await Promise.resolve();

    const finalStatusCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/simulations/sim-archived/status')).length;
    const finalAgentCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/agents/agent-1/state')).length;

    expect(finalStatusCalls).toBe(initialStatusCalls);
    expect(finalAgentCalls).toBe(initialAgentCalls);
  });
});
