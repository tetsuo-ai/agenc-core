/**
 * React hook for real-time simulation state.
 *
 * Connects to:
 * 1. Python EventServer WebSocket (port 3201) for simulation events
 * 2. Bridge HTTP API for agent state and control
 *
 * Phase 4 of the CONCORDIA_TODO.MD implementation plan.
 */

import { useCallback, useEffect, useReducer, useRef } from "react";

// ============================================================================
// Types
// ============================================================================

export interface SimulationEvent {
  type: string;
  step: number;
  timestamp: number;
  agent_name?: string;
  content?: string;
  action_spec?: Record<string, unknown>;
  resolved_event?: string;
  scene?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentState {
  identity: {
    name: string;
    personality: string;
    learnedTraits: string[];
    beliefs: Record<string, { belief: string; confidence: number }>;
  } | null;
  memoryCount: number;
  recentMemories: Array<{ content: string; role: string; timestamp: number }>;
  relationships: Array<{
    otherAgentId: string;
    sentiment: number;
    interactionCount: number;
  }>;
  worldFacts: Array<{ content: string; observedBy: string; confirmations: number }>;
  turnCount: number;
  lastAction: string | null;
}

export interface SimulationStatus {
  step: number;
  max_steps: number;
  running: boolean;
  paused: boolean;
  world_id: string;
  agent_count: number;
}

export interface SimulationState {
  events: SimulationEvent[];
  agentStates: Record<string, AgentState>;
  status: SimulationStatus;
  connected: boolean;
  error: string | null;
}

type SimAction =
  | { type: "ADD_EVENT"; event: SimulationEvent }
  | { type: "SET_AGENT_STATE"; agentId: string; state: AgentState }
  | { type: "SET_STATUS"; status: SimulationStatus }
  | { type: "SET_CONNECTED"; connected: boolean }
  | { type: "SET_ERROR"; error: string | null }
  | { type: "CLEAR" };

// ============================================================================
// Reducer
// ============================================================================

const initialState: SimulationState = {
  events: [],
  agentStates: {},
  status: {
    step: 0,
    max_steps: 0,
    running: false,
    paused: false,
    world_id: "",
    agent_count: 0,
  },
  connected: false,
  error: null,
};

function reducer(state: SimulationState, action: SimAction): SimulationState {
  switch (action.type) {
    case "ADD_EVENT":
      return {
        ...state,
        events: [...state.events.slice(-999), action.event],
      };
    case "SET_AGENT_STATE":
      return {
        ...state,
        agentStates: { ...state.agentStates, [action.agentId]: action.state },
      };
    case "SET_STATUS":
      return { ...state, status: action.status };
    case "SET_CONNECTED":
      return { ...state, connected: action.connected };
    case "SET_ERROR":
      return { ...state, error: action.error };
    case "CLEAR":
      return initialState;
    default:
      return state;
  }
}

// ============================================================================
// Hook
// ============================================================================

export function useSimulation(config: {
  eventWsUrl?: string;
  bridgeUrl?: string;
  controlUrl?: string;
  agentIds?: string[];
  pollIntervalMs?: number;
}) {
  const {
    eventWsUrl = "ws://localhost:3201",
    bridgeUrl = "http://localhost:3200",
    controlUrl = "http://localhost:3202",
    agentIds = [],
    pollIntervalMs = 2000,
  } = config;

  const [state, dispatch] = useReducer(reducer, initialState);
  const wsRef = useRef<WebSocket | null>(null);

  // WebSocket connection for events with auto-reconnect
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let alive = true;

    function connect() {
      if (!alive) return;
      try {
        ws = new WebSocket(eventWsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          dispatch({ type: "SET_CONNECTED", connected: true });
          dispatch({ type: "SET_ERROR", error: null });
        };
        ws.onclose = () => {
          dispatch({ type: "SET_CONNECTED", connected: false });
          // Auto-reconnect after 2s
          if (alive) {
            reconnectTimer = setTimeout(connect, 2000);
          }
        };
        ws.onerror = () => {
          // onclose will fire after onerror, triggering reconnect
        };

        ws.onmessage = (msg) => {
          try {
            const event: SimulationEvent = JSON.parse(msg.data);
            dispatch({ type: "ADD_EVENT", event });
          } catch {
            // Ignore malformed events
          }
        };
      } catch {
        if (alive) {
          reconnectTimer = setTimeout(connect, 2000);
        }
      }
    }

    connect();

    return () => {
      alive = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
      wsRef.current = null;
    };
  }, [eventWsUrl]);

  // Poll agent states
  useEffect(() => {
    if (agentIds.length === 0) return;

    const interval = setInterval(async () => {
      for (const agentId of agentIds) {
        try {
          const resp = await fetch(`${bridgeUrl}/agent/${agentId}/state`);
          if (resp.ok) {
            const agentState: AgentState = await resp.json();
            dispatch({ type: "SET_AGENT_STATE", agentId, state: agentState });
          }
        } catch {
          // Non-blocking
        }
      }
    }, pollIntervalMs);

    return () => clearInterval(interval);
  }, [bridgeUrl, agentIds, pollIntervalMs]);

  // Poll simulation status
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const resp = await fetch(`${controlUrl}/simulation/status`);
        if (resp.ok) {
          const status: SimulationStatus = await resp.json();
          dispatch({ type: "SET_STATUS", status });
        }
      } catch {
        // Non-blocking
      }
    }, pollIntervalMs);

    return () => clearInterval(interval);
  }, [controlUrl, pollIntervalMs]);

  // Control functions
  const play = useCallback(async () => {
    await fetch(`${controlUrl}/simulation/play`, { method: "POST" }).catch(() => {});
  }, [controlUrl]);

  const pause = useCallback(async () => {
    await fetch(`${controlUrl}/simulation/pause`, { method: "POST" }).catch(() => {});
  }, [controlUrl]);

  const step = useCallback(async () => {
    await fetch(`${controlUrl}/simulation/step`, { method: "POST" }).catch(() => {});
  }, [controlUrl]);

  const stop = useCallback(async () => {
    await fetch(`${controlUrl}/simulation/stop`, { method: "POST" }).catch(() => {});
  }, [controlUrl]);

  return { state, play, pause, step, stop };
}
