/**
 * Internal types, interfaces, and run-conversion functions for the BackgroundRunSupervisor.
 *
 * Extracted from background-run-supervisor.ts to separate type definitions
 * from orchestration logic.
 *
 * @module
 */

import type { ChatExecutor } from "../llm/chat-executor.js";
import type {
  ChatExecuteParams,
  ChatExecutorResult,
} from "../llm/chat-executor-types.js";
import type { PromptEnvelopeV1 } from "../llm/prompt-envelope.js";
import type { LLMMessage, LLMProvider, ToolHandler } from "../llm/types.js";
import type { GatewayMessage } from "./message.js";
import type { Logger } from "../utils/logger.js";
import type {
  WorkflowProgressRequirement,
  WorkflowProgressSnapshot,
} from "../workflow/completion-progress.js";
import type { ToolRoutingDecision } from "./tool-routing.js";
import type { ProgressTracker } from "./progress.js";
import type { PolicyEvaluationScope, PolicyEngine } from "../policy/index.js";
import type { TelemetryCollector } from "../telemetry/types.js";
import type { RuntimeIncidentDiagnostics } from "../telemetry/incident-diagnostics.js";
import type { BackgroundRunNotifier } from "./background-run-notifier.js";
import type { EffectLedger } from "../workflow/effect-ledger.js";
import type { RuntimeFaultInjector } from "../eval/fault-injection.js";
import type { StopHookRuntime } from "../llm/hooks/stop-hooks.js";
import type { SessionShellProfile } from "./shell-profile.js";
import {
  AGENT_RUN_SCHEMA_VERSION,
} from "./agent-run-contract.js";
import {
  type BackgroundRunContinuationMode,
  type BackgroundRunApprovalState,
  type BackgroundRunBlockerState,
  type BackgroundRunBudgetState,
  type BackgroundRunCarryForwardState,
  type BackgroundRunCompactionState,
  type BackgroundRunContract,
  type BackgroundRunLastWakeReason,
  type BackgroundRunObservedTarget,
  type BackgroundRunRecentSnapshot,
  type BackgroundRunSignal,
  type BackgroundRunState,
  type BackgroundRunWatchRegistration,
  type BackgroundRunWorkerPool,
  type PersistedBackgroundRun,
  BackgroundRunStore,
} from "./background-run-store.js";
import type { InteractiveContextState } from "./interactive-context.js";
import type { BackgroundRunLineage } from "./subrun-contract.js";
import type {
  BackgroundRunEventRecord,
} from "./background-run-operator.js";
import { MAX_RUN_HISTORY_MESSAGES } from "./background-run-supervisor-constants.js";
import { cloneSignals } from "./background-run-supervisor-helpers.js";

export interface BackgroundRunStatusSnapshot {
  readonly id: string;
  readonly sessionId: string;
  readonly objective: string;
  readonly state: BackgroundRunState;
  readonly completionState?: WorkflowProgressSnapshot["completionState"];
  readonly remainingRequirements?: readonly WorkflowProgressRequirement[];
  readonly cycleCount: number;
  readonly lastVerifiedAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly nextCheckAt?: number;
  readonly nextHeartbeatAt?: number;
  readonly lastUserUpdate?: string;
  readonly lastWakeReason?: BackgroundRunLastWakeReason;
  readonly pendingSignals: number;
  readonly carryForwardSummary?: string;
  readonly blockerSummary?: string;
  readonly watchCount: number;
  readonly fenceToken: number;
  readonly continuationMode?: BackgroundRunContinuationMode;
  readonly verifierSessionId?: string;
  readonly verifierStage?:
    | "inactive"
    | "pending"
    | "running"
    | "passed"
    | "retry"
    | "failed"
    | "skipped";
}

export interface BackgroundRunAlert {
  readonly id: string;
  readonly severity: "info" | "warn" | "error";
  readonly code: string;
  readonly message: string;
  readonly createdAt: number;
  readonly sessionId?: string;
  readonly runId?: string;
}

export interface BackgroundRunFleetStatusSnapshot {
  readonly activeTotal: number;
  readonly stateCounts: Record<BackgroundRunState, number>;
  readonly queuedSignalsTotal: number;
  readonly recentAlerts: readonly BackgroundRunAlert[];
}

export interface BackgroundRunDecision {
  readonly state: Exclude<BackgroundRunState, "pending" | "running" | "suspended">;
  readonly userUpdate: string;
  readonly internalSummary: string;
  readonly nextCheckMs?: number;
  readonly shouldNotifyUser: boolean;
}

/**
 * Snapshot of a user-referenced file that the run keeps pinned across
 * cycles, independent of rolling-history compaction.
 *
 * Populated from `@mention` resolution (`source: "user_mention"`) and
 * refreshed by the supervisor between cycles when the file's mtime
 * changes. Oversized files are stored as a truncated preview plus a
 * side-car at `~/.agenc/anchors/<sessionId>/<sha>.txt` that the actor
 * can re-read via `system.readFile`.
 */
export interface AnchorFileSnapshot {
  readonly path: string;
  readonly mtimeMs: number;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly source: "user_mention";
  readonly lineStart?: number;
  readonly lineEnd?: number;
  readonly content: string;
  readonly truncated: boolean;
  readonly diskPath?: string;
  readonly snapshotTakenAt: number;
}

export interface ActiveBackgroundRun {
  version: typeof AGENT_RUN_SCHEMA_VERSION;
  id: string;
  sessionId: string;
  objective: string;
  shellProfile?: SessionShellProfile;
  policyScope?: PolicyEvaluationScope;
  contract: BackgroundRunContract;
  state: BackgroundRunState;
  fenceToken: number;
  createdAt: number;
  updatedAt: number;
  cycleCount: number;
  stableWorkingCycles: number;
  consecutiveErrorCycles: number;
  /**
   * Runtime counters backing the `verify_reminder` trigger. These are
   * persisted state rather than scan-derived from history because their
   * anchors are singular past events — a verifier spawn, a prior
   * reminder emission — that history compaction can summarize away.
   * Separation of "runtime bookkeeping state" from "model-visible
   * context" matches the reference runtime's `AppState.pendingPlanVerification`
   * pattern and the SOTA position from ESAA / LangGraph / OpenAI
   * Assistants runs. Read by `collectAttachments` at the start of the
   * next cycle; written at the end of the current cycle after
   * `recordToolEvidence`.
   */
  mutatingEditsSinceLastVerifierSpawn: number;
  assistantTurnsSinceLastVerifyReminder: number;
  cyclesSinceTaskTool: number;
  consecutiveNudgeCycles: number;
  anchorFiles: AnchorFileSnapshot[];
  nextCheckAt?: number;
  nextHeartbeatAt?: number;
  lastVerifiedAt?: number;
  lastUserUpdate?: string;
  lastToolEvidence?: string;
  lastHeartbeatContent?: string;
  lastWakeReason?: BackgroundRunLastWakeReason;
  completionProgress?: WorkflowProgressSnapshot;
  carryForward?: BackgroundRunCarryForwardState;
  interactiveContextState?: InteractiveContextState;
  continuationMode?: BackgroundRunContinuationMode;
  verifierSessionId?: string;
  verifierStage?:
    | "inactive"
    | "pending"
    | "running"
    | "passed"
    | "retry"
    | "failed"
    | "skipped";
  blocker?: BackgroundRunBlockerState;
  approvalState: BackgroundRunApprovalState;
  budgetState: BackgroundRunBudgetState;
  compaction: BackgroundRunCompactionState;
  pendingSignals: BackgroundRunSignal[];
  observedTargets: BackgroundRunObservedTarget[];
  watchRegistrations: BackgroundRunWatchRegistration[];
  internalHistory: LLMMessage[];
  lineage?: BackgroundRunLineage;
  preferredWorkerId?: string;
  workerAffinityKey?: string;
  leaseOwnerId?: string;
  leaseExpiresAt?: number;
  timer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
  abortController: AbortController | null;
}

export interface BackgroundRunSupervisorConfig {
  readonly chatExecutor: ChatExecutor;
  readonly supervisorLlm: LLMProvider;
  /**
   * Optional fast provider for short JSON-only supervisor calls
   * (`evaluateDecision`, `refreshCarryForwardState`). Compaction
   * intentionally continues to use `supervisorLlm` to match the
   * upstream reference runtime, which preserves same-model continuity
   * between the actor prompt and its summaries.
   *
   * Falls back to `supervisorLlm` when undefined.
   */
  readonly supervisorFastLlm?: LLMProvider;
  /**
   * Token threshold at which the supervisor compacts `internalHistory`
   * before the next actor turn. Matches the upstream reference
   * runtime's `effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS`
   * trigger. When undefined, the supervisor falls back to the legacy
   * message-count heuristic.
   */
  readonly compactionThresholdTokens?: number;
  /**
   * Char-to-token ratio for the cheap prompt-size estimate used by the
   * compaction gate. Mirrors `llm.promptCharPerToken` from gateway
   * config (default 4).
   */
  readonly compactionCharPerToken?: number;
  readonly getSystemPrompt: () => string;
  readonly createToolHandler: (params: {
    sessionId: string;
    runId: string;
    cycleIndex: number;
    shellProfile: SessionShellProfile;
  }) => ToolHandler;
  readonly resolveExecutionContext?: (params: {
    readonly sessionId: string;
    readonly objective: string;
    readonly shellProfile: SessionShellProfile;
    readonly history: readonly LLMMessage[];
  }) => Promise<{
    readonly runtimeContext?: ChatExecuteParams["runtimeContext"];
    readonly requiredToolEvidence?: ChatExecuteParams["requiredToolEvidence"];
    readonly anchorRegistrations?: readonly import("./at-mention-attachments.js").AnchorFileRegistration[];
  } | undefined>;
  readonly buildToolRoutingDecision?: (
    sessionId: string,
    messageText: string,
    history: readonly LLMMessage[],
    shellProfile: SessionShellProfile,
  ) => ToolRoutingDecision | undefined;
  readonly resolveAdvertisedToolNames?: (
    sessionId: string,
    shellProfile: SessionShellProfile,
    discoveredToolNames?: readonly string[],
  ) => readonly string[];
  readonly seedHistoryForSession?: (sessionId: string) => readonly LLMMessage[];
  /**
   * Optional callback returning the session's current TodoWrite list.
   * Used by the shared attachment-injection hook to render the
   * 10-turn reminder with the right list contents. When absent, the
   * reminder still fires on cadence but with an empty list payload.
   */
  readonly readTodosForSession?: (
    sessionId: string,
  ) => Promise<
    readonly import("../tools/system/todo-store.js").TodoItem[]
  >;
  /**
   * Optional callback returning the session's current task list. Used by
   * the shared attachment-injection hook to render the `task_reminder`.
   * Returns the minimal `ReminderTaskView` shape (`id`, `subject`,
   * `status`) so both `Task` (TaskStore) and `SessionTask` values are
   * structurally assignable.
   */
  readonly readTasksForSession?: (
    sessionId: string,
  ) => Promise<
    readonly import("../llm/task-reminder.js").ReminderTaskView[]
  >;
  /**
   * Optional hook returning the session's currently-open tasks, used by
   * the cross-cycle task-staleness reminder in
   * `background-run-continuation.ts`. When absent the task-staleness
   * reminder is silently skipped (no half-working state).
   */
  readonly readOpenTasksForSession?: (
    sessionId: string,
    limit: number,
  ) => Promise<
    readonly import("./background-run-continuation.js").OpenTaskSummary[]
  >;
  readonly isSessionBusy?: (sessionId: string) => boolean;
  readonly onStatus?: (
    sessionId: string,
    payload: { phase: string; detail?: string },
  ) => void;
  readonly publishUpdate: (sessionId: string, content: string) => Promise<void>;
  readonly progressTracker?: ProgressTracker;
  readonly runStore: BackgroundRunStore;
  readonly policyEngine?: PolicyEngine;
  readonly resolvePolicyScope?: (params: {
    sessionId: string;
    runId: string;
  }) => PolicyEvaluationScope | undefined;
  readonly telemetry?: TelemetryCollector;
  readonly logger?: Logger;
  readonly instanceId?: string;
  readonly now?: () => number;
  readonly workerPools?: readonly BackgroundRunWorkerPool[];
  readonly workerMaxConcurrentRuns?: number;
  readonly notifier?: BackgroundRunNotifier;
  readonly resolveStopHookRuntime?: () => StopHookRuntime | undefined;
  readonly traceProviderPayloads?: boolean;
  readonly effectLedger?: EffectLedger;
  readonly incidentDiagnostics?: RuntimeIncidentDiagnostics;
  readonly faultInjector?: RuntimeFaultInjector;
}

export interface StartBackgroundRunParams {
  readonly sessionId: string;
  readonly objective: string;
  readonly options?: {
    readonly silent?: boolean;
    readonly contract?: BackgroundRunContract;
    readonly seedHistory?: readonly LLMMessage[];
    readonly lineage?: BackgroundRunLineage;
    readonly shellProfile?: SessionShellProfile;
  };
}

export interface PreparedCycleContext {
  readonly run: ActiveBackgroundRun;
  readonly sessionId: string;
  readonly cycleToolHandler: ToolHandler;
  readonly actorPrompt: string;
  readonly actorPromptEnvelope: PromptEnvelopeV1;
}

export interface ResolvedCycleOutcome {
  readonly run: ActiveBackgroundRun;
  readonly sessionId: string;
  readonly actorResult?: ChatExecutorResult;
  readonly decision: BackgroundRunDecision;
  readonly heartbeatMs?: number;
  /**
   * Carry-forward refresh started in parallel with `evaluateDecision`
   * during non-parity cycle resolution. Downstream branches (working /
   * finishing) await this instead of firing a fresh refresh, so the
   * two LLM calls run concurrently rather than serially.
   *
   * Undefined when we took the parity path (synchronous fallback) or
   * a deterministic domain decision short-circuited the LLM path.
   */
  readonly carryForwardRefreshPromise?: Promise<void>;
}

export interface NativeManagedProcessCycleResult {
  readonly actorResult: ChatExecutorResult;
  readonly decision: BackgroundRunDecision;
}

export interface ManagedProcessCommandSpec {
  readonly command: string;
  readonly args: readonly string[];
}

export type CarryForwardRefreshReason =
  | "history_threshold"
  | "milestone"
  | "forced"
  | "repair";

export function trimHistory(history: LLMMessage[]): LLMMessage[] {
  if (history.length <= MAX_RUN_HISTORY_MESSAGES) return history;
  return history.slice(history.length - MAX_RUN_HISTORY_MESSAGES);
}

export function toStatusSnapshot(params: {
  readonly run: ActiveBackgroundRun;
  readonly pendingSignals: number;
}): BackgroundRunStatusSnapshot {
  const { run, pendingSignals } = params;
  return {
    id: run.id,
    sessionId: run.sessionId,
    objective: run.objective,
    state: run.state,
    completionState: run.completionProgress?.completionState,
    remainingRequirements: run.completionProgress?.remainingRequirements,
    cycleCount: run.cycleCount,
    lastVerifiedAt: run.lastVerifiedAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    nextCheckAt: run.nextCheckAt,
    nextHeartbeatAt: run.nextHeartbeatAt,
    lastUserUpdate: run.lastUserUpdate,
    lastWakeReason: run.lastWakeReason,
    pendingSignals,
    carryForwardSummary: run.carryForward?.summary,
    blockerSummary: run.blocker?.summary,
    watchCount: run.watchRegistrations.length,
    fenceToken: run.fenceToken,
    continuationMode: run.continuationMode,
    verifierSessionId: run.verifierSessionId,
    verifierStage: run.verifierStage,
  };
}

export function toPersistedRun(run: ActiveBackgroundRun): PersistedBackgroundRun {
  return {
    version: AGENT_RUN_SCHEMA_VERSION,
    id: run.id,
    sessionId: run.sessionId,
    objective: run.objective,
    shellProfile: run.shellProfile,
    policyScope: run.policyScope,
    contract: run.contract,
    state: run.state,
    fenceToken: run.fenceToken,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    cycleCount: run.cycleCount,
    stableWorkingCycles: run.stableWorkingCycles,
    consecutiveErrorCycles: run.consecutiveErrorCycles,
    mutatingEditsSinceLastVerifierSpawn:
      run.mutatingEditsSinceLastVerifierSpawn,
    assistantTurnsSinceLastVerifyReminder:
      run.assistantTurnsSinceLastVerifyReminder,
    cyclesSinceTaskTool: run.cyclesSinceTaskTool,
    consecutiveNudgeCycles: run.consecutiveNudgeCycles,
    anchorFiles: [...run.anchorFiles],
    nextCheckAt: run.nextCheckAt,
    nextHeartbeatAt: run.nextHeartbeatAt,
    lastVerifiedAt: run.lastVerifiedAt,
    lastUserUpdate: run.lastUserUpdate,
    lastToolEvidence: run.lastToolEvidence,
    lastHeartbeatContent: run.lastHeartbeatContent,
    lastWakeReason: run.lastWakeReason,
    completionProgress: run.completionProgress,
    carryForward: run.carryForward,
    interactiveContextState: run.interactiveContextState,
    continuationMode: run.continuationMode,
    verifierSessionId: run.verifierSessionId,
    verifierStage: run.verifierStage,
    blocker: run.blocker,
    approvalState: run.approvalState,
    budgetState: run.budgetState,
    compaction: run.compaction,
    pendingSignals: cloneSignals(run.pendingSignals),
    observedTargets: [...run.observedTargets],
    watchRegistrations: [...run.watchRegistrations],
    internalHistory: trimHistory([...run.internalHistory]),
    lineage: run.lineage,
    preferredWorkerId: run.preferredWorkerId,
    workerAffinityKey: run.workerAffinityKey,
    leaseOwnerId: run.leaseOwnerId,
    leaseExpiresAt: run.leaseExpiresAt,
  };
}

export function toRecentSnapshot(
  run: ActiveBackgroundRun,
  queuedWakeCount = 0,
): BackgroundRunRecentSnapshot {
  return {
    version: AGENT_RUN_SCHEMA_VERSION,
    runId: run.id,
    sessionId: run.sessionId,
    objective: run.objective,
    shellProfile: run.shellProfile,
    policyScope: run.policyScope,
    state: run.state,
    contractKind: run.contract.kind,
    cycleCount: run.cycleCount,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    lastVerifiedAt: run.lastVerifiedAt,
    nextCheckAt: run.nextCheckAt,
    nextHeartbeatAt: run.nextHeartbeatAt,
    lastUserUpdate: run.lastUserUpdate,
    lastToolEvidence: run.lastToolEvidence,
    lastWakeReason: run.lastWakeReason,
    pendingSignals: run.pendingSignals.length + queuedWakeCount,
    carryForwardSummary: run.carryForward?.summary,
    blockerSummary: run.blocker?.summary,
    completionState: run.completionProgress?.completionState,
    remainingRequirements: run.completionProgress?.remainingRequirements,
    watchCount: run.watchRegistrations.length,
    fenceToken: run.fenceToken,
    preferredWorkerId: run.preferredWorkerId,
    workerAffinityKey: run.workerAffinityKey,
    continuationMode: run.continuationMode,
    verifierSessionId: run.verifierSessionId,
    verifierStage: run.verifierStage,
  };
}

export function toActiveRun(run: PersistedBackgroundRun): ActiveBackgroundRun {
  return {
    version: AGENT_RUN_SCHEMA_VERSION,
    id: run.id,
    sessionId: run.sessionId,
    objective: run.objective,
    shellProfile: run.shellProfile,
    policyScope: run.policyScope,
    contract: run.contract,
    state: run.state,
    fenceToken: run.fenceToken,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    cycleCount: run.cycleCount,
    stableWorkingCycles: run.stableWorkingCycles,
    consecutiveErrorCycles: run.consecutiveErrorCycles,
    // Explicit defaults for runs persisted before the counters landed:
    //   - edit counter defaults to 0 so only post-upgrade mutating
    //     tool calls accrue toward the verify_reminder threshold.
    //   - turn counter defaults to Infinity so the first reminder
    //     fires as soon as the edit threshold hits after an upgrade
    //     (no spurious 10-turn delay on first boot after this PR).
    mutatingEditsSinceLastVerifierSpawn:
      typeof run.mutatingEditsSinceLastVerifierSpawn === "number"
        ? run.mutatingEditsSinceLastVerifierSpawn
        : 0,
    assistantTurnsSinceLastVerifyReminder:
      typeof run.assistantTurnsSinceLastVerifyReminder === "number"
        ? run.assistantTurnsSinceLastVerifyReminder
        : Number.POSITIVE_INFINITY,
    cyclesSinceTaskTool:
      typeof run.cyclesSinceTaskTool === "number"
        ? run.cyclesSinceTaskTool
        : 0,
    consecutiveNudgeCycles:
      typeof run.consecutiveNudgeCycles === "number"
        ? run.consecutiveNudgeCycles
        : 0,
    anchorFiles: [...run.anchorFiles],
    nextCheckAt: run.nextCheckAt,
    nextHeartbeatAt: run.nextHeartbeatAt,
    lastVerifiedAt: run.lastVerifiedAt,
    lastUserUpdate: run.lastUserUpdate,
    lastToolEvidence: run.lastToolEvidence,
    lastHeartbeatContent: run.lastHeartbeatContent,
    lastWakeReason: run.lastWakeReason,
    completionProgress: run.completionProgress,
    carryForward: run.carryForward,
    interactiveContextState: run.interactiveContextState,
    continuationMode: run.continuationMode,
    verifierSessionId: run.verifierSessionId,
    verifierStage: run.verifierStage,
    blocker: run.blocker,
    approvalState: run.approvalState,
    budgetState: run.budgetState,
    compaction: run.compaction,
    pendingSignals: cloneSignals(run.pendingSignals),
    observedTargets: [...run.observedTargets],
    watchRegistrations: [...run.watchRegistrations],
    internalHistory: [...run.internalHistory],
    lineage: run.lineage,
    preferredWorkerId: run.preferredWorkerId,
    workerAffinityKey: run.workerAffinityKey,
    leaseOwnerId: run.leaseOwnerId,
    leaseExpiresAt: run.leaseExpiresAt,
    timer: null,
    heartbeatTimer: null,
    abortController: null,
  };
}

export function toRunMessage(content: string, sessionId: string, runId: string, cycleIndex: number): GatewayMessage {
  return {
    id: `background-run:${runId}:${cycleIndex}:${Date.now()}`,
    channel: "webchat",
    senderId: `background-run:${runId}`,
    senderName: "Background Supervisor",
    sessionId,
    content,
    scope: "dm",
    attachments: [],
    timestamp: Date.now(),
  } as GatewayMessage;
}

export function toOperatorEventRecords(
  entries: readonly import("../memory/types.js").MemoryEntry[],
): BackgroundRunEventRecord[] {
  return entries.map((entry) => ({
    summary: entry.content,
    timestamp: entry.timestamp,
    eventType:
      typeof entry.metadata?.eventType === "string"
        ? entry.metadata.eventType
        : undefined,
    data:
      entry.metadata && typeof entry.metadata === "object"
        ? { ...entry.metadata }
        : {},
  }));
}
