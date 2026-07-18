import type { JsonObject, JsonValue } from "../app-server/protocol/index.js";
import type { ToolRecoveryCategory } from "../tools/types.js";
import { updateAgentRunStatus } from "./agent-runs.js";
import { writeSessionSnapshotAtomically } from "./atomic-snapshot-writes.js";
import {
  pruneRolloutSessions,
  pruneSessionStateSnapshots,
  type AgentRunRetentionPolicy,
  type RolloutRetentionPolicy,
} from "./pruning.js";
import type { StateSqliteDriver } from "./sqlite-driver.js";
import {
  normalizeToolRecoveryCategory,
  recordInFlightToolCallCompletion,
  recordInFlightToolCallProgress,
  recordInFlightToolCallStart,
  rotateToolOutputForState,
  type ToolOutputRotationPolicy,
} from "./tool-output-rotation.js";
import { asRecord } from "../utils/record.js";

export type SnapshotPolicyTrigger =
  | "agent_status"
  | "message_exchange"
  | "periodic"
  | "tool_call";

export interface SnapshotPolicyOptions {
  readonly periodicIntervalMs?: number;
  readonly maxConversationEvents?: number;
  readonly maxTrackedSessions?: number;
  // OOM fix: bound the in-memory per-session tool state so a single long-lived
  // session (e.g. `agenc --yolo`) cannot grow `completed` / `inFlight` /
  // `statusTransitions` without limit. The authoritative, full tool result is
  // already persisted and size-rotated to SQLite (recordInFlightToolCallStart /
  // recordInFlightToolCallCompletion); the in-memory copy only needs a bounded
  // preview for snapshotting.
  readonly maxCompletedToolCalls?: number;
  // OOM fix: `inFlight` normally drains on tool_call_completed/poisoned, but an
  // orphaned call (cancel / crash / lost completion event) would otherwise pin
  // an entry forever — the sibling leak to `completed`. Cap it the same way.
  readonly maxInFlightToolCalls?: number;
  readonly maxStatusTransitions?: number;
  readonly maxInMemoryToolResultBytes?: number;
  readonly now?: () => string;
  readonly setInterval?: (
    callback: () => void,
    intervalMs: number,
  ) => SnapshotPolicyTimer;
  readonly clearInterval?: (timer: SnapshotPolicyTimer) => void;
  readonly onError?: (error: unknown) => void;
  readonly snapshotRetention?: AgentRunRetentionPolicy;
  // Rollout/session disk-retention sweep config. Disabled unless
  // `rolloutRetention.retention_days` is set AND `rolloutSessionsDir` resolves;
  // runs on the throttled periodic timer (not a tight loop), bounded per pass.
  readonly rolloutRetention?: RolloutRetentionPolicy;
  // Absolute `<projectDir>/sessions` dir the sweep walks. Required for the
  // sweep to do anything; otherwise it is a no-op (conservative default).
  readonly rolloutSessionsDir?: string;
  // Live session id that must never be pruned by the sweep.
  readonly activeSessionId?: string;
  readonly agencHome?: string;
  readonly outputRotation?: ToolOutputRotationPolicy;
}

export interface SnapshotPolicyTimer {
  readonly unref?: () => void;
}

export interface SnapshotPolicyMessageExchange {
  readonly sessionId: string;
  readonly agentId: string;
  readonly content: JsonValue;
  readonly messageId: string;
  readonly streamId: string;
  readonly acceptedAt: string;
}

export interface SnapshotPolicyAgentStatusTransition {
  readonly sessionId: string;
  readonly agentId: string;
  readonly status: string;
  readonly runStatus?: string;
  readonly transitionAt: string;
  readonly reason?: string;
  readonly metadataPatch?: JsonObject;
}

export interface SnapshotPolicySnapshotRecord {
  readonly sessionId: string;
  readonly snapshotAt: string;
  readonly trigger: SnapshotPolicyTrigger;
  readonly conversation: readonly JsonValue[];
  readonly toolState: JsonObject;
  readonly mcpConnectionState: JsonObject;
}

export interface SnapshotPolicySessionHydration {
  readonly sessionId: string;
  readonly snapshotAt?: string;
  readonly conversation?: unknown;
  readonly toolState?: unknown;
  readonly mcpConnectionState?: unknown;
}

interface SessionSnapshotState {
  readonly sessionId: string;
  lastTouchedMs: number;
  conversation: JsonValue[];
  seenConversationKeys: Set<string>;
  toolState: {
    extras: JsonObject;
    inFlight: Record<string, JsonObject>;
    completed: Record<string, JsonObject>;
    statusTransitions: JsonObject[];
    lastTrigger?: SnapshotPolicyTrigger;
  };
  mcpConnectionState: {
    extras: JsonObject;
    status: string;
    events: JsonObject[];
  };
}

interface SnapshotRow {
  readonly snapshot_at: string;
  readonly conversation_json: string;
  readonly tool_state_json: string;
  readonly mcp_connection_state_json: string;
}

const DEFAULT_PERIODIC_INTERVAL_MS = 30_000;
const DEFAULT_MAX_CONVERSATION_EVENTS = 200;
const DEFAULT_MAX_TRACKED_SESSIONS = 1_024;
const DEFAULT_MAX_COMPLETED_TOOL_CALLS = 200;
const DEFAULT_MAX_IN_FLIGHT_TOOL_CALLS = 256;
const DEFAULT_MAX_STATUS_TRANSITIONS = 500;
const DEFAULT_MAX_IN_MEMORY_TOOL_RESULT_BYTES = 4_096;

export class AgenCSessionSnapshotPolicy {
  readonly #driver: StateSqliteDriver;
  readonly #periodicIntervalMs: number;
  readonly #maxConversationEvents: number;
  readonly #maxTrackedSessions: number;
  readonly #maxCompletedToolCalls: number;
  readonly #maxInFlightToolCalls: number;
  readonly #maxStatusTransitions: number;
  readonly #maxInMemoryToolResultBytes: number;
  readonly #now: () => string;
  readonly #setInterval: (
    callback: () => void,
    intervalMs: number,
  ) => SnapshotPolicyTimer;
  readonly #clearInterval: (timer: SnapshotPolicyTimer) => void;
  readonly #onError: (error: unknown) => void;
  #snapshotRetention: AgentRunRetentionPolicy | undefined;
  #rolloutRetention: RolloutRetentionPolicy | undefined;
  readonly #rolloutSessionsDir: string | undefined;
  readonly #activeSessionId: string | undefined;
  readonly #agencHome: string | undefined;
  readonly #outputRotation: ToolOutputRotationPolicy | undefined;
  readonly #sessions = new Map<string, SessionSnapshotState>();
  #periodicTimer: SnapshotPolicyTimer | undefined;
  #lastSnapshotMs = 0;
  #sessionTouchSeq = 0;

  constructor(
    driver: StateSqliteDriver,
    options: SnapshotPolicyOptions = {},
  ) {
    this.#driver = driver;
    this.#periodicIntervalMs =
      options.periodicIntervalMs ?? DEFAULT_PERIODIC_INTERVAL_MS;
    this.#maxConversationEvents =
      options.maxConversationEvents ?? DEFAULT_MAX_CONVERSATION_EVENTS;
    this.#maxTrackedSessions = Math.max(
      1,
      options.maxTrackedSessions ?? DEFAULT_MAX_TRACKED_SESSIONS,
    );
    this.#maxCompletedToolCalls = Math.max(
      1,
      options.maxCompletedToolCalls ?? DEFAULT_MAX_COMPLETED_TOOL_CALLS,
    );
    this.#maxInFlightToolCalls = Math.max(
      1,
      options.maxInFlightToolCalls ?? DEFAULT_MAX_IN_FLIGHT_TOOL_CALLS,
    );
    this.#maxStatusTransitions = Math.max(
      1,
      options.maxStatusTransitions ?? DEFAULT_MAX_STATUS_TRANSITIONS,
    );
    this.#maxInMemoryToolResultBytes = Math.max(
      0,
      options.maxInMemoryToolResultBytes ??
        DEFAULT_MAX_IN_MEMORY_TOOL_RESULT_BYTES,
    );
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#setInterval =
      options.setInterval ??
      ((callback, intervalMs) => setInterval(callback, intervalMs));
    this.#clearInterval =
      options.clearInterval ??
      ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));
    this.#onError = options.onError ?? (() => {});
    this.#snapshotRetention = options.snapshotRetention;
    this.#rolloutRetention = options.rolloutRetention;
    this.#rolloutSessionsDir = options.rolloutSessionsDir;
    this.#activeSessionId = options.activeSessionId;
    this.#agencHome = options.agencHome;
    this.#outputRotation = options.outputRotation;
  }

  // OOM fix: evict the oldest completed tool calls (FIFO by insertion order)
  // once the in-memory map exceeds its cap. The full result lives in the
  // rotated-output SQLite store, so the in-memory `completed` map is a snapshot
  // convenience — dropping the oldest entries is safe and stops a tool-heavy
  // long-lived session from accumulating one entry per tool call forever.
  #boundCompletedToolCalls(state: SessionSnapshotState): void {
    const completed = state.toolState.completed;
    const keys = Object.keys(completed);
    const overflow = keys.length - this.#maxCompletedToolCalls;
    for (let i = 0; i < overflow; i++) {
      delete completed[keys[i] as string];
    }
  }

  // OOM fix: evict the oldest still-tracked in-flight tool calls (FIFO by
  // insertion order) once the in-memory map exceeds its cap. `inFlight` normally
  // drains on tool_call_completed/poisoned, but an orphaned call (cancellation,
  // crash, or a lost completion event) would otherwise pin one entry forever in
  // a long-lived `--yolo` session — the sibling leak to `completed`, which
  // #boundCompletedToolCalls already caps. The full in-flight record is persisted
  // via recordInFlightToolCallStart, so dropping the oldest in-memory entry is
  // safe; a late completion still resolves via its own payload metadata
  // (`previous ?? {}` at every consumer).
  #boundInFlightToolCalls(state: SessionSnapshotState): void {
    const inFlight = state.toolState.inFlight;
    const keys = Object.keys(inFlight);
    const overflow = keys.length - this.#maxInFlightToolCalls;
    for (let i = 0; i < overflow; i++) {
      delete inFlight[keys[i] as string];
    }
  }

  // OOM fix: replace a large tool result with a bounded preview before it is
  // pinned in the in-memory `completed` map. The untruncated result is already
  // persisted (and size-rotated) to SQLite, so the in-memory copy only needs a
  // preview for snapshotting. This is the change that stops a FileRead/Bash-heavy
  // `--yolo` session from pinning MBs per completed call until the heap is gone.
  #boundInMemoryResult(result: JsonValue | null): JsonValue | null {
    const cap = this.#maxInMemoryToolResultBytes;
    if (cap === 0 || typeof result !== "string" || result.length <= cap) {
      return result;
    }
    return `${result.slice(0, cap)}\n…[${
      result.length - cap
    } more chars elided in memory; full result persisted to the snapshot store]`;
  }

  startPeriodic(): void {
    if (this.#periodicTimer !== undefined) return;
    this.#periodicTimer = this.#setInterval(() => {
      try {
        this.flushPeriodic();
      } catch (error) {
        this.#onError(error);
      }
    }, this.#periodicIntervalMs);
    this.#periodicTimer.unref?.();
  }

  stopPeriodic(): void {
    if (this.#periodicTimer === undefined) return;
    this.#clearInterval(this.#periodicTimer);
    this.#periodicTimer = undefined;
  }

  updateSnapshotRetention(
    snapshotRetention: AgentRunRetentionPolicy | undefined,
  ): void {
    this.#snapshotRetention = snapshotRetention;
  }

  updateRolloutRetention(
    rolloutRetention: RolloutRetentionPolicy | undefined,
  ): void {
    this.#rolloutRetention = rolloutRetention;
  }

  /**
   * Run the rollout/session retention sweep once. Driven by the throttled
   * periodic timer (see {@link flushPeriodic}) so it never spins in a tight
   * loop. No-op unless a retention window AND a sessions dir are configured —
   * the conservative default is to delete nothing.
   */
  sweepRolloutRetention(): void {
    const retentionDays = this.#rolloutRetention?.retention_days;
    if (retentionDays === undefined || this.#rolloutSessionsDir === undefined) {
      return;
    }
    try {
      pruneRolloutSessions(this.#driver, {
        sessionsDir: this.#rolloutSessionsDir,
        retention_days: retentionDays,
        ...(this.#activeSessionId !== undefined
          ? { activeSessionId: this.#activeSessionId }
          : {}),
        now: this.#now,
        onError: this.#onError,
      });
    } catch (error) {
      this.#onError(error);
    }
  }

  trackSession(sessionId: string, agentId?: string): void {
    this.#session(sessionId);
    if (agentId !== undefined) {
      this.#rememberSessionAgent(sessionId, agentId);
    }
  }

  forgetSession(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  hydrateSession(hydration: SnapshotPolicySessionHydration): void {
    const state = this.#session(hydration.sessionId);
    state.conversation = normalizeJsonArray(hydration.conversation).slice(
      -this.#maxConversationEvents,
    );
    state.seenConversationKeys = conversationKeysFor(state.conversation);
    state.toolState = normalizeToolState(hydration.toolState);
    state.mcpConnectionState = normalizeMcpConnectionState(
      hydration.mcpConnectionState,
    );
    if (hydration.snapshotAt !== undefined) {
      this.#rememberSnapshotAt(hydration.snapshotAt);
    }
  }

  recordMessageExchange(
    exchange: SnapshotPolicyMessageExchange,
  ): SnapshotPolicySnapshotRecord | undefined {
    this.#rememberSessionAgent(exchange.sessionId, exchange.agentId);
    const state = this.#session(exchange.sessionId);
    const appended = this.#appendConversation(
      state,
      {
        role: "user",
        agentId: exchange.agentId,
        content: exchange.content,
        messageId: exchange.messageId,
        streamId: exchange.streamId,
        acceptedAt: exchange.acceptedAt,
      },
      conversationKey("user", exchange.messageId),
    );
    if (!appended) return undefined;
    return this.#writeSnapshot(state, "message_exchange");
  }

  recordAgentStatusTransition(
    transition: SnapshotPolicyAgentStatusTransition,
  ): SnapshotPolicySnapshotRecord | undefined {
    this.#rememberSessionAgent(transition.sessionId, transition.agentId);
    const runStatus = agentRunStatusForTransition(transition);
    if (runStatus !== undefined) {
      updateAgentRunStatus(this.#driver, {
        id: transition.agentId,
        status: runStatus,
        lastActiveAt: transition.transitionAt,
        currentSessionId: transition.sessionId,
        ...(transition.metadataPatch !== undefined
          ? { metadataPatch: transition.metadataPatch }
          : {}),
      });
    }
    const state = this.#session(transition.sessionId);
    const latest = latestStatusTransition(
      state.toolState.statusTransitions,
      transition.agentId,
    );
    if (latest?.status === transition.status) return undefined;
    state.toolState.statusTransitions.push({
      agentId: transition.agentId,
      status: transition.status,
      transitionAt: transition.transitionAt,
      ...(transition.reason !== undefined ? { reason: transition.reason } : {}),
      ...(transition.metadataPatch !== undefined
        ? { metadataPatch: transition.metadataPatch }
        : {}),
    });
    // OOM fix: cap the status-transition log so a long-lived session can't grow
    // it without bound.
    const transitions = state.toolState.statusTransitions;
    if (transitions.length > this.#maxStatusTransitions) {
      transitions.splice(0, transitions.length - this.#maxStatusTransitions);
    }
    return this.#writeSnapshot(state, "agent_status");
  }

  recordSessionEvent(
    sessionId: string,
    event: JsonObject,
  ): SnapshotPolicySnapshotRecord | undefined {
    const method = event.method;
    const eventParams = asJsonObject(event.params);
    const agentId = stringField(eventParams, "agentId");
    if (agentId !== undefined) this.#rememberSessionAgent(sessionId, agentId);
    if (method === "event.message_chunk") {
      const state = this.#session(sessionId);
      const params = eventParams;
      const appended = this.#appendConversation(
        state,
        {
          role: "assistant",
          agentId: stringField(params, "agentId"),
          delta: stringField(params, "delta") ?? "",
          messageId: stringField(params, "messageId"),
          streamId: stringField(params, "streamId"),
          eventId: stringField(params, "eventId"),
        },
        conversationKey("assistant_chunk", stringField(params, "eventId")),
      );
      if (!appended) return undefined;
      return this.#writeSnapshot(state, "message_exchange");
    }
    if (method === "event.tool_request") {
      const state = this.#session(sessionId);
      const params = eventParams;
      const requestId = stringField(params, "requestId");
      const eventAgentId = stringField(params, "agentId");
      const agentId = eventAgentId ?? this.#sessionAgentId(sessionId) ?? sessionId;
      if (eventAgentId !== undefined) {
        this.#rememberSessionAgent(sessionId, eventAgentId);
      }
      if (requestId !== undefined) {
        const toolName = stringField(params, "toolName") ?? "";
        state.toolState.inFlight[requestId] = {
          requestId,
          toolName,
          input: (params.input as JsonValue | undefined) ?? null,
          eventId: stringField(params, "eventId"),
          recoveryCategory: toolRecoveryCategoryField(params, "recoveryCategory"),
          status: "running",
        };
        this.#boundInFlightToolCalls(state);
        // "flag" mode: this observer runs AFTER dispatch (it reacts to the
        // tool_call event), so it cannot refuse the mutation — but a gate
        // violation must not vanish. It is persisted into the session
        // snapshot alongside the in-flight entry. Pre-dispatch refusal is
        // the admission kernel's job (M3), via checkUnknownOutcomeMutationGate.
        const startOutcome = recordInFlightToolCallStart(this.#driver, {
          sessionId,
          agentId,
          toolCallId: requestId,
          toolName,
          args: (params.input as JsonValue | undefined) ?? null,
          startedAt: this.#now(),
          recoveryCategory: toolRecoveryCategoryField(params, "recoveryCategory"),
          agencHome: this.#agencHome,
          outputRotation: this.#outputRotation,
          unknownOutcomeGate: "flag",
        });
        if (startOutcome.gateViolation !== undefined) {
          state.toolState.inFlight[requestId] = {
            ...state.toolState.inFlight[requestId],
            unknownOutcomeGateViolation: {
              blockedBy: startOutcome.gateViolation.blocking.map((effect) => ({
                toolCallId: effect.toolCallId,
                toolName: effect.toolName,
              })),
            },
          };
        }
      }
      return this.#writeSnapshot(state, "tool_call");
    }
    if (method === "event.agent_status") {
      const params = eventParams;
      const metadataPatch = agentStatusMetadataPatch(params);
      return this.recordAgentStatusTransition({
        sessionId,
        agentId: stringField(params, "agentId") ?? sessionId,
        status: stringField(params, "status") ?? "idle",
        ...(stringField(params, "runStatus") !== undefined
          ? { runStatus: stringField(params, "runStatus") }
          : {}),
        transitionAt: this.#now(),
        ...(stringField(params, "message") !== undefined
          ? { reason: stringField(params, "message") }
          : {}),
        ...(metadataPatch !== undefined ? { metadataPatch } : {}),
      });
    }
    if (method === "event.session_event") {
      return this.#recordNestedSessionEvent(sessionId, eventParams);
    }
    return undefined;
  }

  flushPeriodic(): readonly SnapshotPolicySnapshotRecord[] {
    const records = [...this.#sessions.values()].map((state) =>
      this.#writeSnapshot(state, "periodic"),
    );
    // Piggy-back the disk-retention sweep on the same throttled tick so
    // rollout/session pruning runs on a bounded timer, not a tight loop.
    this.sweepRolloutRetention();
    return records;
  }

  loadLatest(sessionId: string): SnapshotPolicySnapshotRecord | undefined {
    const row = this.#driver
      .prepareState<[string], SnapshotRow>(
        `SELECT
           snapshot_at,
           conversation_json,
           tool_state_json,
           mcp_connection_state_json
         FROM session_state_snapshots
         WHERE session_id = ?
         ORDER BY snapshot_at DESC
         LIMIT 1`,
      )
      .get(sessionId);
    if (row === undefined) return undefined;
    return {
      sessionId,
      snapshotAt: row.snapshot_at,
      trigger: "periodic",
      conversation: JSON.parse(row.conversation_json) as JsonValue[],
      toolState: JSON.parse(row.tool_state_json) as JsonObject,
      mcpConnectionState: JSON.parse(row.mcp_connection_state_json) as JsonObject,
    };
  }

  #recordNestedSessionEvent(
    sessionId: string,
    params: JsonObject,
  ): SnapshotPolicySnapshotRecord | undefined {
    const event = asJsonObject(params.event);
    const type = stringField(event, "type");
    if (type === "tool_call_completed") {
      const state = this.#session(sessionId);
      const payload = asJsonObject(event.payload);
      const callId = stringField(payload, "callId");
      const eventAgentId = stringField(params, "agentId");
      const agentId = eventAgentId ?? this.#sessionAgentId(sessionId) ?? sessionId;
      if (eventAgentId !== undefined) {
        this.#rememberSessionAgent(sessionId, eventAgentId);
      }
      if (callId !== undefined) {
        const previous = state.toolState.inFlight[callId];
        const metadata = asJsonObject(payload.metadata);
        const toolName =
          stringField(previous ?? {}, "toolName") ??
          stringField(metadata, "toolName") ??
          stringField(payload, "toolName");
        recordInFlightToolCallCompletion(this.#driver, {
          sessionId,
          agentId,
          toolCallId: callId,
          ...(toolName !== undefined ? { toolName } : {}),
          result: (payload.result as JsonValue | undefined) ?? null,
          isError: booleanField(payload, "isError"),
          completedAt: this.#now(),
          recoveryCategory: toolRecoveryCategoryField(
            previous ?? {},
            "recoveryCategory",
          ),
          agencHome: this.#agencHome,
          outputRotation: this.#outputRotation,
        });
        delete state.toolState.inFlight[callId];
        state.toolState.completed[callId] = {
          ...(previous ?? {}),
          requestId: callId,
          ...(toolName !== undefined ? { toolName } : {}),
          ...(toolRecoveryCategoryField(previous ?? {}, "recoveryCategory") !== undefined
            ? {
                recoveryCategory: toolRecoveryCategoryField(
                  previous ?? {},
                  "recoveryCategory",
                ),
              }
            : {}),
          status: booleanField(payload, "isError") ? "failed" : "completed",
          result: this.#boundInMemoryResult(
            (payload.result as JsonValue | undefined) ?? null,
          ),
        };
        this.#boundCompletedToolCalls(state);
      }
      return this.#writeSnapshot(state, "tool_call");
    }
    if (type === "tool_call_recovery_poisoned") {
      const state = this.#session(sessionId);
      const payload = asJsonObject(event.payload);
      const callId = stringField(payload, "callId");
      const eventAgentId = stringField(params, "agentId");
      const agentId = eventAgentId ?? this.#sessionAgentId(sessionId) ?? sessionId;
      if (eventAgentId !== undefined) {
        this.#rememberSessionAgent(sessionId, eventAgentId);
      }
      if (callId !== undefined) {
        const previous = state.toolState.inFlight[callId];
        const metadata = asJsonObject(payload.metadata);
        const toolName =
          stringField(previous ?? {}, "toolName") ??
          stringField(metadata, "toolName") ??
          stringField(payload, "toolName");
        const recoveryCategory =
          toolRecoveryCategoryField(metadata, "recoveryCategory") ??
          toolRecoveryCategoryField(previous ?? {}, "recoveryCategory");
        recordRecoveredToolCallPoisoned(this.#driver, {
          sessionId,
          agentId,
          toolCallId: callId,
          ...(toolName !== undefined ? { toolName } : {}),
          result: (payload.result as JsonValue | undefined) ?? null,
          poisonedAt: this.#now(),
          ...(recoveryCategory !== undefined ? { recoveryCategory } : {}),
          agencHome: this.#agencHome,
          outputRotation: this.#outputRotation,
        });
        delete state.toolState.inFlight[callId];
        state.toolState.completed[callId] = {
          ...(previous ?? {}),
          requestId: callId,
          ...(toolName !== undefined ? { toolName } : {}),
          ...(recoveryCategory !== undefined ? { recoveryCategory } : {}),
          recoveryAction: "poison",
          status: "poisoned",
          result: this.#boundInMemoryResult(
            (payload.result as JsonValue | undefined) ?? null,
          ),
        };
        this.#boundCompletedToolCalls(state);
      }
      return this.#writeSnapshot(state, "tool_call");
    }
    if (type === "tool_progress") {
      const state = this.#session(sessionId);
      const payload = asJsonObject(event.payload);
      const callId = stringField(payload, "callId");
      const chunk = stringField(payload, "chunk");
      const eventAgentId = stringField(params, "agentId");
      const agentId = eventAgentId ?? this.#sessionAgentId(sessionId) ?? sessionId;
      if (eventAgentId !== undefined) {
        this.#rememberSessionAgent(sessionId, eventAgentId);
      }
      if (callId !== undefined && chunk !== undefined) {
        const previous = state.toolState.inFlight[callId];
        const toolName =
          stringField(previous ?? {}, "toolName") ??
          stringField(payload, "toolName");
        const observedAt = this.#now();
        recordInFlightToolCallProgress(this.#driver, {
          sessionId,
          agentId,
          toolCallId: callId,
          ...(toolName !== undefined ? { toolName } : {}),
          chunk,
          observedAt,
          recoveryCategory: toolRecoveryCategoryField(
            previous ?? {},
            "recoveryCategory",
          ),
          agencHome: this.#agencHome,
          outputRotation: this.#outputRotation,
        });
        state.toolState.inFlight[callId] = {
          ...(previous ?? {}),
          requestId: callId,
          ...(toolName !== undefined ? { toolName } : {}),
          ...(toolRecoveryCategoryField(previous ?? {}, "recoveryCategory") !== undefined
            ? {
                recoveryCategory: toolRecoveryCategoryField(
                  previous ?? {},
                  "recoveryCategory",
                ),
              }
            : {}),
          status: "running",
          lastProgressAt: stringField(event, "acceptedAt") ?? observedAt,
        };
        this.#boundInFlightToolCalls(state);
      }
      return this.#writeSnapshot(state, "tool_call");
    }
    if (type === "user_message" || type === "agent_message") {
      const state = this.#session(sessionId);
      const role = type === "user_message" ? "user" : "assistant";
      const appended = this.#appendConversation(
        state,
        {
          role,
          eventId: stringField(event, "id"),
          messageId: stringField(event, "messageId"),
          streamId: stringField(event, "streamId"),
          acceptedAt: stringField(event, "acceptedAt"),
          payload: (event.payload as JsonValue | undefined) ?? null,
        },
        conversationKey(
          role,
          stringField(event, "messageId") ?? stringField(event, "id"),
        ),
      );
      if (!appended) return undefined;
      return this.#writeSnapshot(state, "message_exchange");
    }
    return undefined;
  }

  #session(sessionId: string): SessionSnapshotState {
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) {
      existing.lastTouchedMs = this.#sessionTouchSeq++;
      return existing;
    }
    const created: SessionSnapshotState = {
      sessionId,
      lastTouchedMs: this.#sessionTouchSeq++,
      conversation: [],
      seenConversationKeys: new Set(),
      toolState: {
        extras: {},
        inFlight: {},
        completed: {},
        statusTransitions: [],
      },
      mcpConnectionState: {
        extras: {},
        status: "unknown",
        events: [],
      },
    };
    this.#sessions.set(sessionId, created);
    this.#evictStaleSessions();
    return created;
  }

  #evictStaleSessions(): void {
    while (this.#sessions.size > this.#maxTrackedSessions) {
      let oldestId: string | undefined;
      let oldestTouch = Number.POSITIVE_INFINITY;
      for (const state of this.#sessions.values()) {
        if (state.lastTouchedMs < oldestTouch) {
          oldestTouch = state.lastTouchedMs;
          oldestId = state.sessionId;
        }
      }
      if (oldestId === undefined) return;
      this.#sessions.delete(oldestId);
    }
  }

  #rememberSessionAgent(sessionId: string, agentId: string): void {
    if (sessionId.length === 0 || agentId.length === 0) return;
    this.#driver
      .prepareState<[string, string]>(
        `INSERT INTO session_agent_links (
          session_id,
          agent_id
        ) VALUES (?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          agent_id = excluded.agent_id,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .run(sessionId, agentId);
  }

  #sessionAgentId(sessionId: string): string | undefined {
    return this.#driver
      .prepareState<[string], { agent_id: string }>(
        "SELECT agent_id FROM session_agent_links WHERE session_id = ?",
      )
      .get(sessionId)?.agent_id;
  }

  #appendConversation(
    state: SessionSnapshotState,
    entry: JsonObject,
    key?: string,
  ): boolean {
    if (key !== undefined && state.seenConversationKeys.has(key)) {
      return false;
    }
    state.conversation.push(entry);
    if (key !== undefined) state.seenConversationKeys.add(key);
    if (state.conversation.length > this.#maxConversationEvents) {
      state.conversation = state.conversation.slice(-this.#maxConversationEvents);
      state.seenConversationKeys = conversationKeysFor(state.conversation);
    }
    return true;
  }

  #writeSnapshot(
    state: SessionSnapshotState,
    trigger: SnapshotPolicyTrigger,
  ): SnapshotPolicySnapshotRecord {
    const snapshotAt = this.#nextSnapshotAt();
    state.toolState.lastTrigger = trigger;
    const conversation = [...state.conversation];
    const toolState = normalizeJsonObject({
      ...state.toolState.extras,
      ...state.toolState,
      extras: undefined,
      inFlight: { ...state.toolState.inFlight },
      completed: { ...state.toolState.completed },
      statusTransitions: [...state.toolState.statusTransitions],
    });
    const mcpConnectionState = normalizeJsonObject({
      ...state.mcpConnectionState.extras,
      ...state.mcpConnectionState,
      extras: undefined,
      events: [...state.mcpConnectionState.events],
    });
    writeSessionSnapshotAtomically(
      this.#driver,
      {
        sessionId: state.sessionId,
        snapshotAt,
        conversationJson: JSON.stringify(conversation),
        toolStateJson: JSON.stringify(toolState),
        mcpConnectionStateJson: JSON.stringify(mcpConnectionState),
      },
      { updateRunLastSnapshotAt: true, replayOnStartup: true },
    );
    pruneSessionStateSnapshots(
      this.#driver,
      { ...(this.#snapshotRetention ?? {}), now: () => snapshotAt },
      state.sessionId,
    );
    return {
      sessionId: state.sessionId,
      snapshotAt,
      trigger,
      conversation,
      toolState,
      mcpConnectionState,
    };
  }

  #rememberSnapshotAt(snapshotAt: string): void {
    const parsed = Date.parse(snapshotAt);
    if (Number.isFinite(parsed)) {
      this.#lastSnapshotMs = Math.max(this.#lastSnapshotMs, parsed);
    }
  }

  #nextSnapshotAt(): string {
    const parsed = Date.parse(this.#now());
    const nextMs = Number.isFinite(parsed)
      ? Math.max(parsed, this.#lastSnapshotMs + 1)
      : this.#lastSnapshotMs + 1;
    this.#lastSnapshotMs = nextMs;
    return new Date(nextMs).toISOString();
  }
}

function recordRecoveredToolCallPoisoned(
  driver: StateSqliteDriver,
  params: {
    readonly sessionId: string;
    readonly agentId?: string;
    readonly toolCallId: string;
    readonly toolName?: string;
    readonly result: JsonValue;
    readonly poisonedAt: string;
    readonly recoveryCategory?: ToolRecoveryCategory;
    readonly agencHome?: string;
    readonly outputRotation?: ToolOutputRotationPolicy;
  },
): void {
  const rotated = rotateToolOutputForState({
    agencHome: params.agencHome,
    agentId: params.agentId ?? params.sessionId,
    toolCallId: params.toolCallId,
    output: stringifyRecoveryOutput(params.result),
    outputRotation: params.outputRotation,
  });
  const update = driver
    .prepareState<
      [string | null, string | null, number, string | null, string, string]
    >(
      `UPDATE in_flight_tool_calls
       SET status = 'poisoned',
           output_partial = ?,
           output_log_path = ?,
           output_log_bytes = ?,
           recovery_category = COALESCE(?, recovery_category)
       WHERE session_id = ?
         AND tool_call_id = ?`,
    )
    .run(
      rotated.outputPartial,
      rotated.outputLogPath ?? null,
      rotated.outputLogBytes,
      params.recoveryCategory !== undefined
        ? normalizeToolRecoveryCategory(params.recoveryCategory)
        : null,
      params.sessionId,
      params.toolCallId,
    );
  if (update.changes > 0) return;
  driver
    .prepareState<
      [string, string, string, string | null, string | null, number, string, string]
    >(
      `INSERT INTO in_flight_tool_calls (
        session_id,
        tool_call_id,
        tool_name,
        args_json,
        status,
        output_partial,
        output_log_path,
        output_log_bytes,
        started_at,
        recovery_category
      ) VALUES (?, ?, ?, 'null', 'poisoned', ?, ?, ?, ?, ?)`,
    )
    .run(
      params.sessionId,
      params.toolCallId,
      params.toolName ?? "unknown",
      rotated.outputPartial,
      rotated.outputLogPath ?? null,
      rotated.outputLogBytes,
      params.poisonedAt,
      normalizeToolRecoveryCategory(params.recoveryCategory),
    );
}

function stringifyRecoveryOutput(value: JsonValue): string {
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value ?? "") : serialized;
}

function asJsonObject(value: unknown): JsonObject {
  return (asRecord(value) as JsonObject | null) ?? {};
}

function stringField(value: JsonObject, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function booleanField(value: JsonObject, key: string): boolean {
  return value[key] === true;
}

function toolRecoveryCategoryField(
  value: JsonObject,
  key: string,
): ToolRecoveryCategory | undefined {
  const field = value[key];
  return field === "idempotent" ||
    field === "side-effecting" ||
    field === "interactive"
    ? field
    : undefined;
}

function agentStatusMetadataPatch(params: JsonObject): JsonObject | undefined {
  const budgetHalt = asOptionalJsonObject(params.budgetHalt);
  const budgetUsage = asOptionalJsonObject(params.budgetUsage);
  if (budgetHalt === undefined && budgetUsage === undefined) return undefined;
  return {
    ...(budgetHalt !== undefined ? { budgetHalt } : {}),
    ...(budgetUsage !== undefined ? { budgetUsage } : {}),
  };
}

function asOptionalJsonObject(value: unknown): JsonObject | undefined {
  const record = asRecord(value);
  return record === null ? undefined : normalizeJsonObject(record as JsonObject);
}

function latestStatusTransition(
  transitions: readonly JsonObject[],
  agentId: string,
): JsonObject | undefined {
  for (let index = transitions.length - 1; index >= 0; index -= 1) {
    const transition = transitions[index];
    if (transition !== undefined && transition.agentId === agentId) {
      return transition;
    }
  }
  return undefined;
}

function conversationKeysFor(entries: readonly JsonValue[]): Set<string> {
  const keys = new Set<string>();
  for (const entry of entries) {
    const object = asJsonObject(entry);
    const role = stringField(object, "role");
    const id =
      stringField(object, "messageId") ?? stringField(object, "eventId");
    const key = conversationKey(role, id);
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

function conversationKey(
  role: string | undefined,
  id: string | undefined,
): string | undefined {
  if (role === undefined || id === undefined || id.length === 0) {
    return undefined;
  }
  return `${role}:${id}`;
}

function normalizeToolState(value: unknown): SessionSnapshotState["toolState"] {
  const raw = normalizeJsonObjectFromUnknown(value);
  const extras: Record<string, JsonValue | undefined> = { ...raw };
  delete extras.inFlight;
  delete extras.completed;
  delete extras.statusTransitions;
  delete extras.lastTrigger;
  return {
    extras,
    inFlight: normalizeJsonObjectRecord(raw.inFlight),
    completed: normalizeJsonObjectRecord(raw.completed),
    statusTransitions: normalizeJsonObjectArray(raw.statusTransitions),
    ...(isSnapshotPolicyTrigger(raw.lastTrigger)
      ? { lastTrigger: raw.lastTrigger }
      : {}),
  };
}

function normalizeMcpConnectionState(
  value: unknown,
): SessionSnapshotState["mcpConnectionState"] {
  const raw = normalizeJsonObjectFromUnknown(value);
  const extras: Record<string, JsonValue | undefined> = { ...raw };
  delete extras.status;
  delete extras.events;
  return {
    extras,
    status: typeof raw.status === "string" ? raw.status : "unknown",
    events: normalizeJsonObjectArray(raw.events),
  };
}

function agentRunStatusForTransition(
  transition: SnapshotPolicyAgentStatusTransition,
): string | undefined {
  switch (transition.runStatus) {
    case "pending":
    case "running":
    case "working":
    case "paused":
    case "blocked":
    case "suspended":
    case "completed":
    case "errored":
    case "stopped":
      return transition.runStatus;
  }
  switch (transition.status) {
    case "running":
      return "running";
    case "error":
      return "errored";
    case "stopped":
      return "stopped";
    default:
      return undefined;
  }
}

function normalizeJsonArray(value: unknown): JsonValue[] {
  if (!Array.isArray(value)) return [];
  return JSON.parse(JSON.stringify(value)) as JsonValue[];
}

function normalizeJsonObjectArray(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeJsonObjectFromUnknown);
}

function normalizeJsonObjectRecord(
  value: unknown,
): Record<string, JsonObject> {
  const raw = normalizeJsonObjectFromUnknown(value);
  const record: Record<string, JsonObject> = {};
  for (const [key, entry] of Object.entries(raw)) {
    record[key] = normalizeJsonObjectFromUnknown(entry);
  }
  return record;
}

function normalizeJsonObjectFromUnknown(value: unknown): JsonObject {
  const record = asRecord(value);
  return record === null ? {} : normalizeJsonObject(record as JsonObject);
}

function normalizeJsonObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function isSnapshotPolicyTrigger(value: unknown): value is SnapshotPolicyTrigger {
  return (
    value === "agent_status" ||
    value === "message_exchange" ||
    value === "periodic" ||
    value === "tool_call"
  );
}
