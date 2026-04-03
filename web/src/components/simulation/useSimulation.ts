/**
 * React hook for bridge-owned simulation state.
 *
 * Connects to the Concordia bridge's per-simulation APIs:
 * 1. Replay hydration + reconnect catch-up over HTTP
 * 2. Server-sent events for live event streaming
 * 3. Bridge HTTP for agent state and lifecycle control
 *
 * Phase 7 of TODO.MD focuses on stale-async hygiene, explicit reducer actions,
 * and transport lifecycle rules for paused and terminal simulations.
 */

import { useCallback, useEffect, useReducer, useRef } from "react";

export interface SimulationCheckpointStatus {
  checkpoint_id: string;
  checkpoint_path: string;
  schema_version: number;
  created_at: number;
  step: number;
  source: string;
  simulation_id: string;
  lineage_id: string | null;
  world_id: string;
  workspace_id: string;
  runtime_cursor: {
    current_step: number;
    start_step: number;
    max_steps: number | null;
    last_step_outcome: string | null;
  };
}

export interface SimulationSummary {
  simulation_id: string;
  world_id: string;
  workspace_id: string;
  lineage_id: string | null;
  parent_simulation_id: string | null;
  status:
    | "launching"
    | "running"
    | "paused"
    | "stopping"
    | "stopped"
    | "finished"
    | "failed"
    | "archived"
    | "deleted";
  reason: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  ended_at: number | null;
  agent_ids: string[];
  current_alias: boolean;
  pid: number | null;
  last_completed_step: number;
  last_step_outcome: string | null;
  replay_event_count: number;
  checkpoint: SimulationCheckpointStatus | null;
}

export interface SimulationRecord extends SimulationSummary {
  agents: Array<{
    agent_id: string;
    agent_name: string;
    personality: string;
    goal: string;
  }>;
  premise: string;
  max_steps: number | null;
  gm_model?: string;
  gm_provider?: string;
}

export interface SimulationEvent {
  event_id?: string;
  type: string;
  step: number;
  timestamp?: number;
  simulation_id: string;
  world_id: string;
  workspace_id: string;
  agent_name?: string;
  content?: string;
  action_spec?: Record<string, unknown> | null;
  resolved_event?: string | null;
  scene?: string | null;
  metadata?: Record<string, unknown> | null;
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
  simulation_id: string;
  world_id: string;
  workspace_id: string;
  status:
    | "launching"
    | "running"
    | "paused"
    | "stopping"
    | "stopped"
    | "finished"
    | "failed"
    | "archived"
    | "deleted";
  reason: string | null;
  error: string | null;
  step: number;
  max_steps: number | null;
  running: boolean;
  paused: boolean;
  agent_count: number;
  started_at: number | null;
  ended_at: number | null;
  updated_at: number;
  last_step_outcome: string | null;
  terminal_reason: string | null;
  checkpoint: SimulationCheckpointStatus | null;
}

interface SimulationEventsResponse {
  simulation_id: string;
  events: readonly SimulationEvent[];
  next_cursor: string | null;
}

export type SimulationTransportState =
  | "idle"
  | "replay-hydrating"
  | "live"
  | "reconnecting"
  | "disconnected";

export interface SimulationState {
  events: SimulationEvent[];
  agentStates: Record<string, AgentState>;
  status: SimulationStatus;
  connected: boolean;
  error: string | null;
  notFound: boolean;
  transportState: SimulationTransportState;
}

type SimAction =
  | { type: "RESET_SELECTION"; status?: SimulationStatus | null }
  | { type: "HYDRATE_REPLAY"; events: readonly SimulationEvent[] }
  | { type: "CATCH_UP_REPLAY"; events: readonly SimulationEvent[] }
  | { type: "APPEND_LIVE_EVENT"; event: SimulationEvent }
  | { type: "HYDRATE_STATUS"; status: SimulationStatus }
  | { type: "SET_AGENT_STATE"; agentId: string; state: AgentState }
  | { type: "SET_CONNECTED"; connected: boolean }
  | { type: "SET_ERROR"; error: string | null }
  | { type: "SET_NOT_FOUND"; notFound: boolean }
  | { type: "SET_TRANSPORT_STATE"; transportState: SimulationTransportState };

const TERMINAL_STATUSES: ReadonlySet<SimulationStatus["status"]> = new Set([
  "stopped",
  "finished",
  "failed",
  "archived",
  "deleted",
] as const);

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 10_000;
const PAUSED_STATUS_HEARTBEAT_MS = 5_000;
const EVENT_BUFFER_LIMIT = 1_000;

const initialStatus: SimulationStatus = {
  simulation_id: "",
  world_id: "",
  workspace_id: "",
  status: "launching",
  reason: null,
  error: null,
  step: 0,
  max_steps: null,
  running: false,
  paused: false,
  agent_count: 0,
  started_at: null,
  ended_at: null,
  updated_at: 0,
  last_step_outcome: null,
  terminal_reason: null,
  checkpoint: null,
};

function isTerminalStatus(status: SimulationStatus["status"]): boolean {
  return TERMINAL_STATUSES.has(status);
}

function isAbortLikeError(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError";
}

function ignoreHandledAsyncRejection(error: unknown): void {
  if (isAbortLikeError(error)) {
    return;
  }
  console.error(error);
}

function getSelectionInitialState(
  status?: SimulationStatus | null,
): SimulationState {
  return {
    events: [],
    agentStates: {},
    status: status ?? initialStatus,
    connected: false,
    error: null,
    notFound: false,
    transportState:
      status && isTerminalStatus(status.status)
        ? "disconnected"
        : "idle",
  };
}

function buildEventKey(event: SimulationEvent): string {
  return event.event_id
    ?? [
      event.simulation_id,
      event.type,
      event.step,
      event.timestamp ?? 0,
      event.agent_name ?? "",
      event.resolved_event ?? event.content ?? "",
    ].join("::");
}

function mergeReplayEvents(
  existing: readonly SimulationEvent[],
  incoming: readonly SimulationEvent[],
): SimulationEvent[] {
  const merged: SimulationEvent[] = [];
  const seen = new Set<string>();
  for (const event of [...existing, ...incoming]) {
    const key = buildEventKey(event);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(event);
  }
  return merged.slice(-EVENT_BUFFER_LIMIT);
}

function reducer(state: SimulationState, action: SimAction): SimulationState {
  switch (action.type) {
    case "RESET_SELECTION":
      return getSelectionInitialState(action.status ?? null);
    case "HYDRATE_REPLAY":
      return {
        ...state,
        events: mergeReplayEvents([], action.events),
        error: null,
        notFound: false,
      };
    case "CATCH_UP_REPLAY":
      return {
        ...state,
        events: mergeReplayEvents(state.events, action.events),
        error: null,
      };
    case "APPEND_LIVE_EVENT":
      return {
        ...state,
        events: mergeReplayEvents(state.events, [action.event]),
      };
    case "HYDRATE_STATUS":
      return {
        ...state,
        status: action.status,
        notFound: false,
      };
    case "SET_AGENT_STATE":
      return {
        ...state,
        agentStates: { ...state.agentStates, [action.agentId]: action.state },
      };
    case "SET_CONNECTED":
      return { ...state, connected: action.connected };
    case "SET_ERROR":
      return { ...state, error: action.error };
    case "SET_NOT_FOUND":
      return { ...state, notFound: action.notFound };
    case "SET_TRANSPORT_STATE":
      return { ...state, transportState: action.transportState };
    default:
      return state;
  }
}

function getStatusPollInterval(
  status: SimulationStatus["status"],
  baseIntervalMs: number,
): number | null {
  if (isTerminalStatus(status)) {
    return null;
  }
  if (status === "paused") {
    return Math.max(baseIntervalMs * 2, PAUSED_STATUS_HEARTBEAT_MS);
  }
  return baseIntervalMs;
}

function shouldPollAgentStates(status: SimulationStatus["status"]): boolean {
  return !isTerminalStatus(status) && status !== "paused";
}

function shouldMaintainLiveTransport(status: SimulationStatus["status"]): boolean {
  return !isTerminalStatus(status);
}

function updateCursorFromEvents(
  events: readonly SimulationEvent[],
  nextCursor: string | null,
): string | null {
  if (nextCursor) {
    return nextCursor;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const eventId = events[index]?.event_id;
    if (eventId) {
      return eventId;
    }
  }
  return null;
}

export function useSimulation(config: {
  simulationId?: string | null;
  bridgeUrl?: string;
  agentIds?: string[];
  pollIntervalMs?: number;
  active?: boolean;
  initialStatus?: SimulationStatus | null;
}) {
  const {
    simulationId = null,
    bridgeUrl = "http://localhost:3200",
    agentIds = [],
    pollIntervalMs = 2_000,
    active = true,
    initialStatus: seedStatus = null,
  } = config;

  const [state, dispatch] = useReducer(
    reducer,
    seedStatus ?? null,
    (status) => getSelectionInitialState(status),
  );

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectionEpochRef = useRef(0);
  const simulationIdRef = useRef<string | null>(simulationId);
  const seedStatusRef = useRef<SimulationStatus | null>(seedStatus);
  const statusRef = useRef<SimulationStatus>(seedStatus ?? initialStatus);
  const trackedControllersRef = useRef(new Set<AbortController>());
  const lastEventIdRef = useRef<string | null>(null);
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY_MS);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const closeEventStream = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const abortTrackedControllers = useCallback(() => {
    for (const controller of trackedControllersRef.current) {
      controller.abort();
    }
    trackedControllersRef.current.clear();
  }, []);

  const registerController = useCallback(() => {
    const controller = new AbortController();
    trackedControllersRef.current.add(controller);
    return controller;
  }, []);

  const isCurrentSelection = useCallback((epoch: number, targetSimulationId: string | null) => {
    return epoch === selectionEpochRef.current && targetSimulationId === simulationIdRef.current;
  }, []);

  const markEventSeen = useCallback((event: SimulationEvent): void => {
    const eventId = event.event_id;
    if (eventId) {
      lastEventIdRef.current = eventId;
    }
  }, []);

  const hydrateReplay = useCallback(async (
    epoch: number,
    mode: "hydrate" | "catch-up",
  ): Promise<boolean> => {
    if (!simulationId) {
      return false;
    }

    const controller = registerController();
    try {
      const eventsUrl = new URL(
        `/simulations/${encodeURIComponent(simulationId)}/events`,
        bridgeUrl,
      );
      if (mode === "catch-up" && lastEventIdRef.current) {
        eventsUrl.searchParams.set("cursor", lastEventIdRef.current);
      }

      const response = await fetch(eventsUrl.toString(), { signal: controller.signal });
      if (controller.signal.aborted || !isCurrentSelection(epoch, simulationId)) {
        return false;
      }

      if (response.status === 404) {
        dispatch({ type: "SET_NOT_FOUND", notFound: true });
        dispatch({ type: "SET_CONNECTED", connected: false });
        dispatch({ type: "SET_TRANSPORT_STATE", transportState: "disconnected" });
        return false;
      }

      if (!response.ok) {
        throw new Error(`Replay hydration failed: ${response.status}`);
      }

      const payload = (await response.json()) as SimulationEventsResponse;
      payload.events.forEach(markEventSeen);
      lastEventIdRef.current = updateCursorFromEvents(payload.events, payload.next_cursor);

      dispatch({
        type: mode === "hydrate" ? "HYDRATE_REPLAY" : "CATCH_UP_REPLAY",
        events: payload.events,
      });
      dispatch({ type: "SET_ERROR", error: null });
      if (mode === "hydrate") {
        dispatch({
          type: "SET_TRANSPORT_STATE",
          transportState: shouldMaintainLiveTransport(statusRef.current.status)
            ? "replay-hydrating"
            : "disconnected",
        });
      }
      return true;
    } catch (error) {
      if (!controller.signal.aborted && isCurrentSelection(epoch, simulationId)) {
        dispatch({
          type: "SET_ERROR",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return false;
    } finally {
      trackedControllersRef.current.delete(controller);
    }
  }, [bridgeUrl, isCurrentSelection, markEventSeen, registerController, simulationId]);

  useEffect(() => {
    simulationIdRef.current = simulationId;
  }, [simulationId]);

  useEffect(() => {
    seedStatusRef.current = seedStatus;
  }, [seedStatus]);

  useEffect(() => {
    statusRef.current = state.status;
  }, [state.status]);

  useEffect(() => {
    selectionEpochRef.current += 1;
    reconnectDelayRef.current = INITIAL_RECONNECT_DELAY_MS;
    lastEventIdRef.current = null;
    abortTrackedControllers();
    clearReconnectTimer();
    closeEventStream();
    dispatch({ type: "RESET_SELECTION", status: seedStatusRef.current ?? null });

    if (!simulationId) {
      dispatch({ type: "SET_TRANSPORT_STATE", transportState: "idle" });
      dispatch({ type: "SET_CONNECTED", connected: false });
      dispatch({ type: "SET_NOT_FOUND", notFound: false });
      return;
    }

    if (!active) {
      dispatch({ type: "SET_TRANSPORT_STATE", transportState: "disconnected" });
      dispatch({ type: "SET_CONNECTED", connected: false });
      return;
    }

    dispatch({ type: "SET_ERROR", error: null });
    dispatch({
      type: "SET_TRANSPORT_STATE",
      transportState: shouldMaintainLiveTransport((seedStatusRef.current ?? initialStatus).status)
        ? "replay-hydrating"
        : "disconnected",
    });
  }, [
    abortTrackedControllers,
    active,
    clearReconnectTimer,
    closeEventStream,
    simulationId,
  ]);

  useEffect(() => {
    if (!simulationId || !active) {
      return;
    }
    const epoch = selectionEpochRef.current;
    void hydrateReplay(epoch, "hydrate").catch(ignoreHandledAsyncRejection);
  }, [active, hydrateReplay, simulationId]);

  useEffect(() => {
    if (!simulationId || !active) {
      closeEventStream();
      clearReconnectTimer();
      return;
    }

    const epoch = selectionEpochRef.current;
    let disposed = false;

    const scheduleReconnect = () => {
      if (
        disposed ||
        !shouldMaintainLiveTransport(statusRef.current.status) ||
        !isCurrentSelection(epoch, simulationId)
      ) {
        dispatch({ type: "SET_TRANSPORT_STATE", transportState: "disconnected" });
        return;
      }
      clearReconnectTimer();
      reconnectTimerRef.current = setTimeout(() => {
        if (disposed || !isCurrentSelection(epoch, simulationId)) {
          return;
        }
        dispatch({ type: "SET_TRANSPORT_STATE", transportState: "reconnecting" });
        void hydrateReplay(epoch, "catch-up")
          .then((ok) => {
            if (
              !ok ||
              disposed ||
              !shouldMaintainLiveTransport(statusRef.current.status) ||
              !isCurrentSelection(epoch, simulationId)
            ) {
              dispatch({ type: "SET_CONNECTED", connected: false });
              dispatch({ type: "SET_TRANSPORT_STATE", transportState: "disconnected" });
              return;
            }
            openEventStream();
          })
          .catch(ignoreHandledAsyncRejection);
      }, reconnectDelayRef.current);
      reconnectDelayRef.current = Math.min(
        reconnectDelayRef.current * 2,
        MAX_RECONNECT_DELAY_MS,
      );
    };

    const openEventStream = () => {
      if (
        disposed ||
        !shouldMaintainLiveTransport(statusRef.current.status) ||
        !isCurrentSelection(epoch, simulationId)
      ) {
        dispatch({ type: "SET_CONNECTED", connected: false });
        dispatch({ type: "SET_TRANSPORT_STATE", transportState: "disconnected" });
        return;
      }

      const streamUrl = new URL(
        `/simulations/${encodeURIComponent(simulationId)}/events/stream`,
        bridgeUrl,
      );
      if (lastEventIdRef.current) {
        streamUrl.searchParams.set("cursor", lastEventIdRef.current);
      }

      const source = new EventSource(streamUrl.toString());
      eventSourceRef.current = source;

      source.onopen = () => {
        if (!isCurrentSelection(epoch, simulationId) || disposed) {
          return;
        }
        reconnectDelayRef.current = INITIAL_RECONNECT_DELAY_MS;
        dispatch({ type: "SET_CONNECTED", connected: true });
        dispatch({ type: "SET_ERROR", error: null });
        dispatch({ type: "SET_TRANSPORT_STATE", transportState: "live" });
      };

      source.onerror = () => {
        closeEventStream();
        if (!isCurrentSelection(epoch, simulationId) || disposed) {
          return;
        }
        dispatch({ type: "SET_CONNECTED", connected: false });
        if (shouldMaintainLiveTransport(statusRef.current.status)) {
          dispatch({ type: "SET_TRANSPORT_STATE", transportState: "reconnecting" });
          scheduleReconnect();
        } else {
          dispatch({ type: "SET_TRANSPORT_STATE", transportState: "disconnected" });
        }
      };

      source.onmessage = (message) => {
        if (!isCurrentSelection(epoch, simulationId) || disposed) {
          return;
        }
        try {
          const event = JSON.parse(message.data) as SimulationEvent;
          const eventId = event.event_id ?? message.lastEventId ?? null;
          if (event.simulation_id !== simulationId) {
            return;
          }
          if (eventId) {
            event.event_id = eventId;
            lastEventIdRef.current = eventId;
          }
          dispatch({ type: "APPEND_LIVE_EVENT", event });
        } catch {
          // Ignore malformed stream payloads.
        }
      };
    };

    openEventStream();

    return () => {
      disposed = true;
      clearReconnectTimer();
      closeEventStream();
    };
  }, [
    active,
    bridgeUrl,
    clearReconnectTimer,
    closeEventStream,
    hydrateReplay,
    isCurrentSelection,
    simulationId,
  ]);

  useEffect(() => {
    if (!active || !simulationId || shouldMaintainLiveTransport(state.status.status)) {
      return;
    }
    clearReconnectTimer();
    closeEventStream();
    dispatch({ type: "SET_CONNECTED", connected: false });
    dispatch({ type: "SET_TRANSPORT_STATE", transportState: "disconnected" });
  }, [active, clearReconnectTimer, closeEventStream, simulationId, state.status.status]);

  useEffect(() => {
    if (!simulationId || !active) {
      return;
    }

    const epoch = selectionEpochRef.current;
    const controller = registerController();

    const hydrateStatus = async () => {
      try {
        const response = await fetch(
          `${bridgeUrl}/simulations/${encodeURIComponent(simulationId)}/status`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted || !isCurrentSelection(epoch, simulationId)) {
          return;
        }
        if (response.status === 404) {
          dispatch({ type: "SET_NOT_FOUND", notFound: true });
          dispatch({ type: "SET_CONNECTED", connected: false });
          dispatch({ type: "SET_TRANSPORT_STATE", transportState: "disconnected" });
          closeEventStream();
          clearReconnectTimer();
          return;
        }
        if (!response.ok) {
          throw new Error(`Status hydration failed: ${response.status}`);
        }
        const status = (await response.json()) as SimulationStatus;
        dispatch({ type: "HYDRATE_STATUS", status });
        dispatch({ type: "SET_ERROR", error: null });
      } catch (error) {
        if (!controller.signal.aborted && isCurrentSelection(epoch, simulationId)) {
          dispatch({
            type: "SET_ERROR",
            error: error instanceof Error ? error.message : String(error),
          });
          dispatch({ type: "SET_CONNECTED", connected: false });
        }
      } finally {
        trackedControllersRef.current.delete(controller);
      }
    };

    void hydrateStatus().catch(ignoreHandledAsyncRejection);
    return () => controller.abort();
  }, [
    active,
    bridgeUrl,
    clearReconnectTimer,
    closeEventStream,
    isCurrentSelection,
    registerController,
    simulationId,
  ]);

  useEffect(() => {
    if (!simulationId || !active) {
      return;
    }
    const intervalMs = getStatusPollInterval(state.status.status, pollIntervalMs);
    if (intervalMs === null) {
      return;
    }

    const epoch = selectionEpochRef.current;
    let disposed = false;
    const controllers = new Set<AbortController>();

    const pollStatus = async () => {
      const controller = registerController();
      controllers.add(controller);
      try {
        const response = await fetch(
          `${bridgeUrl}/simulations/${encodeURIComponent(simulationId)}/status`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted || disposed || !isCurrentSelection(epoch, simulationId)) {
          return;
        }
        if (response.status === 404) {
          dispatch({ type: "SET_NOT_FOUND", notFound: true });
          dispatch({ type: "SET_CONNECTED", connected: false });
          dispatch({ type: "SET_TRANSPORT_STATE", transportState: "disconnected" });
          closeEventStream();
          clearReconnectTimer();
          return;
        }
        if (!response.ok) {
          throw new Error(`Status poll failed: ${response.status}`);
        }
        const status = (await response.json()) as SimulationStatus;
        dispatch({ type: "HYDRATE_STATUS", status });
      } catch (error) {
        if (!controller.signal.aborted && !disposed && isCurrentSelection(epoch, simulationId)) {
          dispatch({
            type: "SET_ERROR",
            error: error instanceof Error ? error.message : String(error),
          });
          dispatch({ type: "SET_CONNECTED", connected: false });
        }
      } finally {
        controllers.delete(controller);
        trackedControllersRef.current.delete(controller);
      }
    };

    const interval = setInterval(() => {
      void pollStatus().catch(ignoreHandledAsyncRejection);
    }, intervalMs);

    return () => {
      disposed = true;
      clearInterval(interval);
      for (const controller of controllers) {
        controller.abort();
      }
      controllers.clear();
    };
  }, [
    active,
    bridgeUrl,
    clearReconnectTimer,
    closeEventStream,
    isCurrentSelection,
    pollIntervalMs,
    registerController,
    simulationId,
    state.status.status,
  ]);

  useEffect(() => {
    if (!simulationId || !active || agentIds.length === 0) {
      return;
    }
    const epoch = selectionEpochRef.current;
    let disposed = false;
    const controllers = new Set<AbortController>();

    const loadAgentStates = async () => {
      await Promise.all(agentIds.map(async (agentId) => {
        const controller = registerController();
        controllers.add(controller);
        try {
          const response = await fetch(
            `${bridgeUrl}/simulations/${encodeURIComponent(simulationId)}/agents/${encodeURIComponent(agentId)}/state`,
            { signal: controller.signal },
          );
          if (controller.signal.aborted || disposed || !isCurrentSelection(epoch, simulationId)) {
            return;
          }
          if (!response.ok) {
            return;
          }
          const agentState = (await response.json()) as AgentState;
          dispatch({ type: "SET_AGENT_STATE", agentId, state: agentState });
        } finally {
          controllers.delete(controller);
          trackedControllersRef.current.delete(controller);
        }
      }));
    };

    void loadAgentStates().catch(ignoreHandledAsyncRejection);
    return () => {
      disposed = true;
      for (const controller of controllers) {
        controller.abort();
      }
      controllers.clear();
    };
  }, [active, agentIds, bridgeUrl, isCurrentSelection, registerController, simulationId]);

  useEffect(() => {
    if (!simulationId || !active || agentIds.length === 0 || !shouldPollAgentStates(state.status.status)) {
      return;
    }
    const epoch = selectionEpochRef.current;
    let disposed = false;
    const controllers = new Set<AbortController>();

    const pollAgentStates = async () => {
      await Promise.all(agentIds.map(async (agentId) => {
        const controller = registerController();
        controllers.add(controller);
        try {
          const response = await fetch(
            `${bridgeUrl}/simulations/${encodeURIComponent(simulationId)}/agents/${encodeURIComponent(agentId)}/state`,
            { signal: controller.signal },
          );
          if (controller.signal.aborted || disposed || !isCurrentSelection(epoch, simulationId)) {
            return;
          }
          if (!response.ok) {
            return;
          }
          const agentState = (await response.json()) as AgentState;
          dispatch({ type: "SET_AGENT_STATE", agentId, state: agentState });
        } finally {
          controllers.delete(controller);
          trackedControllersRef.current.delete(controller);
        }
      }));
    };

    const interval = setInterval(() => {
      void pollAgentStates().catch(ignoreHandledAsyncRejection);
    }, pollIntervalMs);

    return () => {
      disposed = true;
      clearInterval(interval);
      for (const controller of controllers) {
        controller.abort();
      }
      controllers.clear();
    };
  }, [
    active,
    agentIds,
    bridgeUrl,
    isCurrentSelection,
    pollIntervalMs,
    registerController,
    simulationId,
    state.status.status,
  ]);

  const sendControlCommand = useCallback(async (command: "play" | "pause" | "step" | "stop") => {
    if (!simulationId) {
      return;
    }
    const epoch = selectionEpochRef.current;
    const controller = registerController();
    try {
      const response = await fetch(
        `${bridgeUrl}/simulations/${encodeURIComponent(simulationId)}/${command}`,
        {
          method: "POST",
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted || !isCurrentSelection(epoch, simulationId)) {
        return;
      }
      if (!response.ok) {
        throw new Error(`Control command failed: ${response.status}`);
      }
      const payload = (await response.json()) as { simulation?: SimulationStatus };
      if (payload.simulation && isCurrentSelection(epoch, simulationId)) {
        dispatch({ type: "HYDRATE_STATUS", status: payload.simulation });
      }
      dispatch({ type: "SET_ERROR", error: null });
    } catch (error) {
      if (!controller.signal.aborted && isCurrentSelection(epoch, simulationId)) {
        dispatch({
          type: "SET_ERROR",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      trackedControllersRef.current.delete(controller);
    }
  }, [bridgeUrl, isCurrentSelection, registerController, simulationId]);

  const play = useCallback(async () => {
    await sendControlCommand("play");
  }, [sendControlCommand]);

  const pause = useCallback(async () => {
    await sendControlCommand("pause");
  }, [sendControlCommand]);

  const step = useCallback(async () => {
    await sendControlCommand("step");
  }, [sendControlCommand]);

  const stop = useCallback(async () => {
    await sendControlCommand("stop");
  }, [sendControlCommand]);

  return { state, play, pause, step, stop };
}
