/**
 * Event log — the discriminated union that every state change in
 * AgenC flows through.
 *
 * Hand-port of agenc runtime `protocol/src/protocol.rs` EventMsg (78 variants)
 * reduced to the 18-variant AgenC subset per `docs/plan/agenc runtime-inventory.md §4`.
 *
 * Invariants wired here:
 *   I-8  (every error site emits a typed event) — `emitError()` helper
 *        is the single entry point for error emissions.
 *   I-26 (forward-compat: unknown event variant skipped, not panicked)
 *        — `isKnownEventType()` + reducer wraps unknown variants in
 *        `{type:'unknown', raw, version}` shim.
 *   I-27 (FIFO + monotonic seq) — `EventLog.emit()` assigns the seq
 *        synchronously before any await; reducer asserts monotonicity.
 *   I-49 (schema version stamped) — every SessionMetaLine carries
 *        `agencVersion` + `rolloutSchemaVersion`.
 *
 * @module
 */

import type { LLMContentPart, LLMMessage, LLMUsage } from "../llm/types.js";
import type { AgentStatus } from "../agents/status.js";
import type { AdmissionJournalEvent } from "../budget/admission-types.js";
import type {
  EffectOutcome,
  RunTerminalStatus,
  RunUsageTotals,
} from "../contracts/run-contracts.js";
import type { ToolRecoveryCategory } from "../tools/types.js";
import type {
  CollaborationMode,
  FileSystemSandboxPolicy,
  Personality,
  TruncationPolicy,
} from "./turn-context.js";
import type { RunInstructionEvidence } from "../prompts/instruction-evidence.js";
import type {
  McpElicitationCompleteEvent,
  McpElicitationRequestEvent,
  RequestUserInputEvent,
} from "../elicitation/types.js";

// ─────────────────────────────────────────────────────────────────────
// Schema version — I-49
// ─────────────────────────────────────────────────────────────────────

/**
 * Incremented on any breaking change to the rollout JSONL format.
 * - v1: initial T6 shape (18 event variants, 6 rollout wrappers).
 * On open, if rollout.schemaVersion > runtime.ROLLOUT_SCHEMA_VERSION,
 * hard-fail with migration message (I-49).
 */
export const ROLLOUT_SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────────────────────────────
// Event envelope: { eventId, id, msg, seq }
// ─────────────────────────────────────────────────────────────────────

/**
 * Per-emit sequence number (monotonic within a session lifetime).
 * Used by the reducer to assert FIFO order (I-27).
 */
export type EventSeq = number;

export interface Event {
  /**
   * Canonical run-journal identity. EventLog assigns `event:<seq>` when a
   * producer does not provide a stable identity. This is deliberately
   * distinct from `id`, which remains the reusable session/subscription
   * correlation envelope used by existing producers.
   */
  readonly eventId?: string;
  readonly id: string;
  readonly msg: EventMsg;
  /**
   * Assigned synchronously at emit time by `EventLog.emit()`. Exposed
   * as optional here because constructors may accept pre-envelope
   * values; the EventLog fills it in.
   */
  readonly seq?: EventSeq;
}

// ─────────────────────────────────────────────────────────────────────
// Event payloads — 18 variants
// ─────────────────────────────────────────────────────────────────────

export interface SessionMetaLine {
  readonly sessionId: string;
  readonly timestamp: string;
  readonly cwd: string;
  readonly originator: string;
  /** `@tetsuo-ai/runtime` version that wrote this rollout. */
  readonly agencVersion: string;
  /** Schema version (I-49). Bump on breaking changes. */
  readonly rolloutSchemaVersion: number;
  readonly cliVersion?: string;
  readonly source?: string;
  readonly model?: string;
  readonly modelProvider?: string;
  /** Upstream thread memory mode persisted by metadata-update rows. */
  readonly memoryMode?: string;
}

export interface TurnStartedEvent {
  readonly turnId: string;
  readonly startedAt?: number;
  readonly modelContextWindow?: number;
  readonly collaborationModeKind?: string;
  /**
   * GOAL #4b Stage 1 — durable turns. The runtime build identifier active
   * when this turn started, stamped here (NOT in the checkpoint) so resume
   * can refuse cross-build replay BEFORE loading any checkpoint. Older
   * rollouts predating durable-turns omit this; resume treats a missing
   * `buildId` as "no build pin available" and falls back to today's
   * process_killed + fresh turn (never a silent cross-build resume).
   */
  readonly buildId?: string;
}

export interface TurnCompleteEvent {
  readonly turnId: string;
  readonly lastAgentMessage?: string;
  readonly completedAt?: number;
  readonly durationMs?: number;
}

export interface TurnAbortedEvent {
  readonly turnId?: string;
  readonly reason: string;
}

/**
 * GOAL #4b Stage 1 — durable iteration checkpoint.
 *
 * Emitted (fsync-durable — see `DURABLE_EVENT_TYPES`) at each consistent
 * iteration boundary (CB-Iteration / CB-PostAssistant) so a daemon crash
 * mid-turn can resume-CONTINUE from the last completed iteration instead of
 * discarding the turn. Carries only what cannot be reconstructed from the
 * durable rollout: a cursor + content hash of the persisted prefix and the
 * in-memory TurnState slice that would otherwise reset on restart.
 *
 * Determinism note (§3.6): `resumableState.taskBudgetRemaining` is the
 * DERIVED budget, never a raw turn-start clock — restoring a stale clock
 * would silently corrupt budget accounting on resume.
 */
export interface TurnCheckpointEvent {
  readonly turnId: string;
  /** Monotonic per-turn iteration index this checkpoint closes. */
  readonly iterationIndex: number;
  /** Which loop boundary emitted it (telemetry / debugging only). */
  readonly boundary: "iteration" | "postAssistant";
  /** Monotonic across a turn; resume restores from the HIGHEST valid one. */
  readonly checkpointSeq: number;
  /** Exact replay-prefix length (`persistedMessageCount`). */
  readonly persistedMessageCount: number;
  /**
   * CONTENT hash (sha256 of the canonicalized persisted prefix), NOT a
   * length — torn-prefix / divergence gate (§5). Resume refuses a
   * checkpoint whose hash != the reconstructed prefix's hash.
   */
  readonly prefixHash: string;
  /** The TurnState subset that is lost today and must survive a crash. */
  readonly resumableState: TurnCheckpointSliceLine;
}

/**
 * Serialized, JSON-safe projection of the resumable `TurnState` counters.
 * The authoritative shape + (de)serialization live in `turn-state.ts`
 * (`toCheckpointSlice` / `restoreFromCheckpoint`). Declared structurally
 * here so the rollout line is self-describing without importing TurnState
 * into the event-log module.
 */
export interface TurnCheckpointSliceLine {
  readonly turnCount: number;
  readonly recoveryReentryCount: number;
  readonly maxOutputTokensRecoveryCount: number;
  readonly continuationNudgeCount: number;
  readonly stopHookBlockingCount: number;
  readonly planToolRequiredRetryCount?: number;
  readonly taskBudgetRemaining?: number;
  readonly autoCompactTracking?: {
    readonly compacted: boolean;
    readonly turnId: string;
    readonly turnCounter: number;
    readonly consecutiveFailures: number;
  };
  readonly transition?: { readonly reason: string };
  readonly pendingBudgetDecision?:
    | { readonly kind: "continue"; readonly remaining: number }
    | { readonly kind: "stop"; readonly reason: string };
}

/**
 * GOAL #4b Stage 1 — emitted (fsync-durable) when a turn is resumed from a
 * checkpoint after a crash, instead of the legacy discard-and-restart.
 * Records which checkpoint/iteration the drain loop re-entered at so the
 * rollout shows a closed-then-reopened turn lifecycle.
 */
export interface TurnResumedEvent {
  readonly turnId: string;
  readonly fromCheckpointSeq: number;
  readonly fromIteration: number;
  /** Tool names whose dangling tool_use forced a safe-policy halt (if any). */
  readonly haltedSideEffectingTools?: ReadonlyArray<string>;
}

export interface AgentMessageEvent {
  readonly message: string;
}

export interface UserMessageEvent {
  readonly message: string | readonly LLMContentPart[];
  readonly displayText?: string;
  readonly images?: ReadonlyArray<string>;
  readonly queuedCommandUuid?: string;
  readonly messageId?: string;
  readonly streamId?: string;
  readonly acceptedAt?: string;
}

export interface TokenCountEvent {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly webSearchRequests?: number;
  /** Optional model override for this usage payload. */
  readonly model?: string;
  /** Optional provider override for this usage payload. */
  readonly provider?: string;
}

export interface McpToolCallBeginEvent {
  readonly callId: string;
  readonly server: string;
  readonly toolName: string;
  readonly args: string;
}

export interface McpToolCallEndEvent {
  readonly callId: string;
  readonly result: string;
  readonly isError: boolean;
  readonly durationMs?: number;
}

export interface ExecCommandBeginEvent {
  readonly callId: string;
  readonly command: string;
  readonly cwd?: string;
  readonly processId?: number;
  readonly sessionId?: number;
  readonly tty?: boolean;
}

export interface ExecCommandEndEvent {
  readonly callId: string;
  readonly exitCode: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly durationMs?: number;
  readonly processId?: number;
  readonly sessionId?: number;
  readonly tty?: boolean;
}

export interface ExecApprovalRequestEvent {
  readonly callId: string;
  readonly command: string;
  readonly reason?: string;
}

export interface RequestPermissionsEvent {
  readonly callId: string;
  readonly toolName: string;
  readonly permissions: ReadonlyArray<string>;
  readonly turnId?: string;
  readonly reason?: string;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly planContent?: string;
  readonly planFilePath?: string;
  readonly recordedAt?: string;
}

/**
 * Fsync-durable answer to a permission request. The request sequence ties the
 * decision to the exact prompt that was shown; the decision kind is the
 * stable, non-secret portion of ReviewDecision.
 */
export interface PermissionDecisionEvent {
  readonly runId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly turnId: string;
  readonly requestEventId: string;
  readonly requestEventSeq: number;
  readonly decision:
    | "approved"
    | "approved_execpolicy_amendment"
    | "approved_for_session"
    | "network_policy_amendment"
    | "denied"
    | "timed_out"
    | "abort";
  /** Which arbiter leg supplied the answer (human resolver, hook, cache, etc.). */
  readonly source?:
    | "hook"
    | "resolver"
    | "default_deny"
    | "permission_hook"
    | "guardian"
    | "cache"
    | "aborted";
  readonly reason?: string;
  readonly recordedAt: string;
}

export interface ContextCompactedEvent {
  readonly turnId?: string;
  readonly summary?: string;
  readonly preCompactTokens?: number;
  readonly postCompactTokens?: number;
}

export interface ThreadRolledBackEvent {
  readonly numTurns: number;
  readonly reason?: string;
}

export interface ErrorEvent {
  readonly cause: string;
  readonly message: string;
  readonly turnId?: string;
  readonly stack?: string;
}

export interface StreamErrorEvent {
  readonly cause: string;
  readonly message: string;
  readonly provider?: string;
  readonly status?: number;
}

export interface WarningEvent {
  readonly cause: string;
  readonly message: string;
}

/**
 * Fsync-durable proof that an approved tool effect is about to cross the
 * physical dispatch boundary. Arguments are represented by a digest so the
 * journal remains bounded and does not become a second secret-bearing input
 * store.
 */
export interface EffectIntentEvent {
  readonly runId: string;
  readonly stepId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly recoveryCategory: ToolRecoveryCategory;
  /** Present only for effects whose contract is explicitly idempotent. */
  readonly idempotencyKey?: string;
  readonly intentDigest: string;
  readonly attempt: number;
  readonly recordedAt: string;
}

/**
 * Fsync-durable acknowledgement of a proven effect outcome. Unknown physical
 * outcomes use {@link EffectUnknownOutcomeEvent} and may not be overwritten by
 * a late result without explicit review.
 */
export interface EffectResultEvent {
  readonly runId: string;
  readonly stepId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly recoveryCategory: ToolRecoveryCategory;
  readonly idempotencyKey?: string;
  readonly intentEventSeq: number;
  readonly outcome: Exclude<EffectOutcome, "unknown_outcome">;
  readonly resultDigest?: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly recordedAt: string;
}

/**
 * Fsync-durable acknowledgement that a non-idempotent effect crossed the
 * dispatch boundary but its physical outcome cannot be proven. This is a
 * review lock, not a retry signal.
 */
export interface EffectUnknownOutcomeEvent {
  readonly runId: string;
  readonly stepId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly recoveryCategory: ToolRecoveryCategory;
  readonly idempotencyKey?: string;
  readonly intentEventSeq: number;
  readonly outcome: "unknown_outcome";
  readonly reason: string;
  readonly requiresReview: true;
  readonly recordedAt: string;
}

/** Fsync-durable human resolution of an unknown effect outcome. */
export interface EffectReviewResolvedEvent {
  readonly runId: string;
  readonly stepId: string;
  readonly callId: string;
  readonly resolution: string;
  readonly reviewedBy: string;
  readonly reviewedAt: string;
}

/**
 * Fsync-durable declaration that an immutable content artifact is about to be
 * published. The digest, byte length, and final target are sufficient to
 * prove or disprove publication after a crash without replaying the producer.
 */
export interface ArtifactIntentEvent {
  readonly runId: string;
  readonly artifactId: string;
  readonly kind: "tool_result";
  readonly sourceCallId: string;
  readonly targetPath: string;
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly recordedAt: string;
}

/** Fsync-durable acknowledgement that immutable artifact bytes are visible. */
export interface ArtifactCommittedEvent extends ArtifactIntentEvent {
  readonly intentEventSeq: number;
  readonly outcome: "committed" | "already_committed" | "recovered";
  readonly committedAt: string;
}

/** Durable terminal result for a root run, queryable after disconnect. */
export interface RunTerminalEvent {
  readonly runId: string;
  readonly epoch: number;
  readonly status: RunTerminalStatus;
  readonly exitCode: number | null;
  readonly stopReason: string | null;
  readonly finalMessage: string | null;
  readonly usage: RunUsageTotals | null;
  /** Highest sequence committed before this terminal event was allocated. */
  readonly lastSequenceBeforeTerminal: number | null;
  readonly finishedAt: string;
}

/** Durable proof that a previously-terminal run entered a new review epoch. */
export interface RunReopenedEvent {
  readonly runId: string;
  readonly previousEpoch: number;
  readonly epoch: number;
  readonly reason: string;
  readonly reopenedAt: string;
}

/**
 * Durable operator intent recorded before cancellation starts quiescing the
 * run. Startup recovery uses this boundary to fail closed when the daemon dies
 * after admission cancellation but before the terminal tail is committed.
 */
export interface RunCancelRequestedEvent {
  readonly runId: string;
  readonly epoch: number;
  readonly reason: string;
  readonly requestedAt: string;
}

/** Durable explanation of a restart decision that intentionally does no work. */
export interface RecoveryDecisionEvent {
  readonly runId: string;
  readonly stepId?: string;
  readonly decision:
    | "retry_safe_deferred"
    | "projection_rebuilt"
    | "artifact_retry_safe_deferred"
    | "artifact_conflict_review_required";
  readonly reason: string;
  readonly evidenceEventId: string;
  readonly evidenceEventSeq: number;
  readonly recordedAt: string;
}

export type GuardianAssessmentStatus =
  "in_progress" | "approved" | "denied" | "timed_out" | "aborted";

export type GuardianAssessmentDecisionSource = "agent";
export type GuardianRiskLevel = "low" | "medium" | "high" | "critical";
export type GuardianUserAuthorization = "unknown" | "low" | "medium" | "high";

export interface GuardianAssessmentEvent {
  readonly id: string;
  readonly targetItemId?: string;
  readonly turnId: string;
  readonly status: GuardianAssessmentStatus;
  readonly riskLevel?: GuardianRiskLevel;
  readonly userAuthorization?: GuardianUserAuthorization;
  readonly rationale?: string;
  readonly decisionSource?: GuardianAssessmentDecisionSource;
  readonly action: string;
}

export type ReviewDelegateVerdict =
  "pass" | "fail" | "partial" | "aborted" | "timeout";

export type ReviewDelegateCompletionReason =
  "completed" | "timeout" | "aborted" | "error";

export interface ReviewDelegateStartedEvent {
  readonly subId: string;
  readonly target: string;
  readonly modelUsed: string;
  readonly reuseKey?: string;
  readonly snapshot_reused: boolean;
  readonly priorFindingCount: number;
  readonly startedAt: number;
}

export interface ReviewDelegateCompletedEvent {
  readonly subId: string;
  readonly target: string;
  readonly modelUsed: string;
  readonly reuseKey?: string;
  readonly snapshot_reused: boolean;
  readonly priorFindingCount: number;
  readonly newFindingCount: number;
  readonly durationMs: number;
  readonly verdict: ReviewDelegateVerdict;
  readonly reason: ReviewDelegateCompletionReason;
  readonly completedAt: number;
  readonly error?: string;
}

export interface PlanApprovalRequestedEvent {
  readonly requestId: string;
  readonly turnId: string;
  readonly planFilePath?: string;
  readonly planLengthChars: number;
  readonly allowedPromptCount: number;
  readonly requestedAt: number;
}

export type PlanApprovalOutcome =
  "approved" | "approved_for_session" | "denied" | "aborted";

export interface PlanApprovalCompletedEvent {
  readonly requestId: string;
  readonly turnId: string;
  readonly planFilePath?: string;
  readonly planLengthChars: number;
  readonly allowedPromptCount: number;
  readonly outcome: PlanApprovalOutcome;
  readonly durationMs: number;
  readonly completedAt: number;
}

export type ProtocolEventFactValue = string | number | boolean;

export interface ProtocolEventFact {
  readonly label: string;
  readonly value: ProtocolEventFactValue;
}

export interface ProtocolClaimEvent {
  readonly taskPda: string;
  readonly claimant?: string;
  readonly escrowLamports?: number;
  readonly stakeLamports?: number;
  readonly deadline?: string;
  readonly signature?: string;
  readonly message?: string;
  readonly facts?: ReadonlyArray<ProtocolEventFact>;
}

export interface ProtocolSettleEvent {
  readonly taskPda: string;
  readonly recipient?: string;
  readonly escrowLamports?: number;
  readonly bonusLamports?: number;
  readonly reputationDelta?: number;
  readonly signature?: string;
  readonly message?: string;
  readonly facts?: ReadonlyArray<ProtocolEventFact>;
}

export interface ProtocolSlashEvent {
  readonly taskPda: string;
  readonly slashedAgent?: string;
  readonly reason: string;
  readonly stakeDeltaLamports?: number;
  readonly reputationDelta?: number;
  readonly signature?: string;
  readonly message?: string;
  readonly facts?: ReadonlyArray<ProtocolEventFact>;
}

export interface ProtocolStakeEvent {
  readonly wallet?: string;
  readonly taskPda?: string;
  readonly stakeLamports?: number;
  readonly stakeDeltaLamports?: number;
  readonly reputationDelta?: number;
  readonly signature?: string;
  readonly message?: string;
  readonly facts?: ReadonlyArray<ProtocolEventFact>;
}

export interface CollabAgentRef {
  readonly threadId: string;
  readonly agentNickname?: string;
  readonly agentRole?: string;
  readonly agentRoleDisplayName?: string;
}

export interface CollabAgentStatusEntry extends CollabAgentRef {
  readonly status: AgentStatus;
}

export interface CollabAgentSpawnBeginEvent {
  readonly callId: string;
  readonly senderThreadId: string;
  readonly prompt: string;
  readonly taskName?: string;
  readonly agentType?: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

export interface CollabAgentSpawnEndEvent {
  readonly callId: string;
  readonly senderThreadId: string;
  readonly newThreadId?: string;
  readonly newAgentPath?: string;
  readonly newAgentNickname?: string;
  readonly newAgentRole?: string;
  readonly newAgentRoleDisplayName?: string;
  readonly prompt: string;
  readonly taskName?: string;
  readonly agentType?: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly status: AgentStatus;
}

export type CollabAgentTaskStatus =
  "pending" | "running" | "completed" | "failed" | "killed";

export interface CollabAgentStatusEvent {
  readonly callId: string;
  readonly senderThreadId: string;
  readonly threadId: string;
  readonly agentPath?: string;
  readonly agentNickname?: string;
  readonly agentRole?: string;
  readonly agentRoleDisplayName?: string;
  readonly prompt?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly status: AgentStatus | CollabAgentTaskStatus;
  /**
   * Live per-agent tool-use count (cumulative tool calls observed on the
   * spawned subagent's transcript). Forwarded to the fan-out rail so a
   * collab-spawned agent shows real activity instead of `tools 0`.
   */
  readonly toolUseCount?: number;
  /**
   * Live per-agent cumulative token usage for the spawned subagent.
   * Forwarded to the fan-out rail so a collab-spawned agent shows real
   * token consumption instead of `tokens 0` — the prerequisite for cost.
   */
  readonly tokenCount?: number;
  readonly error?: string;
}

export interface CollabAgentInteractionBeginEvent {
  readonly callId: string;
  readonly senderThreadId: string;
  readonly receiverThreadId: string;
  readonly prompt: string;
}

export interface CollabAgentInteractionEndEvent {
  readonly callId: string;
  readonly senderThreadId: string;
  readonly receiverThreadId: string;
  readonly receiverAgentNickname?: string;
  readonly receiverAgentRole?: string;
  readonly receiverAgentRoleDisplayName?: string;
  readonly prompt: string;
  readonly status: AgentStatus;
}

export interface CollabWaitingBeginEvent {
  readonly senderThreadId: string;
  readonly receiverThreadIds: ReadonlyArray<string>;
  readonly receiverAgents?: ReadonlyArray<CollabAgentRef>;
  readonly callId: string;
}

export interface CollabWaitingEndEvent {
  readonly senderThreadId: string;
  readonly callId: string;
  readonly timedOut?: boolean;
  readonly agentStatuses?: ReadonlyArray<CollabAgentStatusEntry>;
  readonly statuses: Readonly<Record<string, AgentStatus>>;
}

export interface CollabCloseBeginEvent {
  readonly callId: string;
  readonly senderThreadId: string;
  readonly receiverThreadId: string;
}

export interface CollabCloseEndEvent {
  readonly callId: string;
  readonly senderThreadId: string;
  readonly receiverThreadId: string;
  readonly receiverAgentNickname?: string;
  readonly receiverAgentRole?: string;
  readonly receiverAgentRoleDisplayName?: string;
  readonly status: AgentStatus;
}

export interface CollabResumeBeginEvent {
  readonly callId: string;
  readonly senderThreadId: string;
  readonly receiverThreadId: string;
  readonly receiverAgentNickname?: string;
  readonly receiverAgentRole?: string;
  readonly receiverAgentRoleDisplayName?: string;
}

export interface CollabResumeEndEvent {
  readonly callId: string;
  readonly senderThreadId: string;
  readonly receiverThreadId: string;
  readonly receiverAgentNickname?: string;
  readonly receiverAgentRole?: string;
  readonly receiverAgentRoleDisplayName?: string;
  readonly status: AgentStatus;
}

/**
 * TurnContextItem — emitted once per real user turn after computing
 * that turn's model-visible context updates (and again after
 * mid-turn compaction) so resume/fork replay recovers the latest
 * durable baseline. Port of agenc runtime `TurnContextItem` (protocol.rs:2896).
 *
 * Full-parity shape: every field populated by `toTurnContextItem` in
 * `turn-context.ts` is declared here so downstream readers (notably
 * `rollout-reconstruction.ts`) can consume each field directly
 * without falling back to a typed cast. Keep the field list in sync
 * with `TurnContextItem` in `turn-context.ts`; a rename here without
 * the matching change there silently breaks replay.
 */
export interface TurnContextItem {
  readonly turnId?: string;
  readonly traceId?: string;
  readonly cwd: string;
  readonly currentDate?: string;
  readonly timezone?: string;
  readonly approvalPolicy: string;
  readonly sandboxPolicy: string;
  readonly fileSystemSandboxPolicy?: FileSystemSandboxPolicy;
  readonly model: string;
  readonly modelContextWindow?: number;
  readonly rawModelContextWindow?: number;
  readonly modelEffectiveContextWindowPercent?: number;
  readonly autoCompactTokenLimit?: number;
  readonly modelProviderId?: string;
  readonly personality?: Personality;
  readonly collaborationMode?: CollaborationMode;
  readonly realtimeActive?: boolean;
  readonly effort?: string;
  readonly summary?: string;
  readonly userInstructions?: string;
  readonly developerInstructions?: string;
  readonly finalOutputJsonSchema?: unknown;
  readonly truncationPolicy?: TruncationPolicy;
  /** Content-free provenance for the exact live instruction envelope. */
  readonly instructionEvidence?: RunInstructionEvidence;
}

// ─────────────────────────────────────────────────────────────────────
// EventMsg discriminated union (18 variants)
// ─────────────────────────────────────────────────────────────────────

/**
 * agenc runtime `SessionConfigured` payload. Emitted once at session open.
 * Kept in the canonical union so session.ts can rely on event-log.ts
 * as the single source of truth for event types.
 */
export interface SessionConfiguredEvent {
  readonly sessionId: string;
  readonly forkedFromId?: string;
  readonly threadName?: string;
  readonly model: string;
  readonly modelProviderId: string;
  readonly serviceTier?: string;
  readonly cwd: string;
  readonly historyLogId: number;
  readonly historyEntryCount: number;
  readonly initialMessages: ReadonlyArray<EventMsg>;
  readonly rolloutPath?: string;
}

export type EventMsg =
  | { readonly type: "session_meta"; readonly payload: SessionMetaLine }
  | {
      readonly type: "session_configured";
      readonly payload: SessionConfiguredEvent;
    }
  | { readonly type: "turn_started"; readonly payload: TurnStartedEvent }
  | { readonly type: "turn_context"; readonly payload: TurnContextItem }
  | { readonly type: "agent_message"; readonly payload: AgentMessageEvent }
  | {
      readonly type: "agent_message_delta";
      readonly payload: { readonly delta: string };
    }
  | {
      readonly type: "agent_thinking";
      readonly payload: {
        readonly text: string;
        readonly redacted?: boolean;
        readonly kind?: "thinking" | "reasoning_summary";
      };
    }
  | {
      readonly type: "assistant_thinking_block_start";
      readonly payload: {
        readonly index: number;
        readonly redacted: boolean;
        readonly kind?: "thinking" | "reasoning_summary";
      };
    }
  | {
      readonly type: "assistant_thinking_delta";
      readonly payload: {
        readonly delta: string;
        readonly index: number;
        readonly kind?: "thinking" | "reasoning_summary";
      };
    }
  | {
      readonly type: "assistant_thinking_block_stop";
      readonly payload: {
        readonly index: number;
        readonly kind?: "thinking" | "reasoning_summary";
      };
    }
  | { readonly type: "user_message"; readonly payload: UserMessageEvent }
  | { readonly type: "token_count"; readonly payload: TokenCountEvent }
  | {
      readonly type: "mcp_tool_call_begin";
      readonly payload: McpToolCallBeginEvent;
    }
  | {
      readonly type: "mcp_tool_call_end";
      readonly payload: McpToolCallEndEvent;
    }
  | {
      readonly type: "exec_command_begin";
      readonly payload: ExecCommandBeginEvent;
    }
  | {
      readonly type: "exec_command_end";
      readonly payload: ExecCommandEndEvent;
    }
  | {
      readonly type: "exec_approval_request";
      readonly payload: ExecApprovalRequestEvent;
    }
  | {
      readonly type: "tool_call_started";
      readonly payload: {
        readonly callId: string;
        readonly toolName: string;
        readonly args: string;
      };
    }
  | {
      readonly type: "tool_input_block_start";
      readonly payload: {
        readonly callId: string;
        readonly index: number;
        readonly contentBlock: {
          readonly type: "tool_use";
          readonly id: string;
          readonly name: string;
          readonly input: Record<string, unknown>;
        };
      };
    }
  | {
      readonly type: "tool_input_delta";
      readonly payload: {
        readonly callId: string;
        readonly index: number;
        readonly partialJson: string;
      };
    }
  | {
      readonly type: "tool_call_completed";
      readonly payload: {
        readonly callId: string;
        readonly result: string;
        readonly isError: boolean;
        readonly metadata?: Record<string, unknown>;
      };
    }
  | {
      readonly type: "tool_progress";
      readonly payload: {
        readonly callId: string;
        readonly toolName: string;
        readonly chunk: string;
        readonly stream?: "stdout" | "stderr" | "status";
        readonly processId?: number;
        readonly at?: number;
      };
    }
  | {
      readonly type: "request_permissions";
      readonly payload: RequestPermissionsEvent;
    }
  | {
      readonly type: "permission_decision";
      readonly payload: PermissionDecisionEvent;
    }
  | {
      readonly type: "request_user_input";
      readonly payload: RequestUserInputEvent;
    }
  | {
      readonly type: "mcp_elicitation_request";
      readonly payload: McpElicitationRequestEvent;
    }
  | {
      readonly type: "mcp_elicitation_complete";
      readonly payload: McpElicitationCompleteEvent;
    }
  | {
      readonly type: "context_compacted";
      readonly payload: ContextCompactedEvent;
    }
  | { readonly type: "turn_complete"; readonly payload: TurnCompleteEvent }
  | { readonly type: "turn_aborted"; readonly payload: TurnAbortedEvent }
  | {
      readonly type: "turn_checkpoint";
      readonly payload: TurnCheckpointEvent;
    }
  | { readonly type: "turn_resumed"; readonly payload: TurnResumedEvent }
  | {
      readonly type: "thread_rolled_back";
      readonly payload: ThreadRolledBackEvent;
    }
  | { readonly type: "error"; readonly payload: ErrorEvent }
  | { readonly type: "stream_error"; readonly payload: StreamErrorEvent }
  | { readonly type: "warning"; readonly payload: WarningEvent }
  | { readonly type: "effect_intent"; readonly payload: EffectIntentEvent }
  | { readonly type: "effect_result"; readonly payload: EffectResultEvent }
  | {
      readonly type: "effect_unknown_outcome";
      readonly payload: EffectUnknownOutcomeEvent;
    }
  | {
      readonly type: "effect_review_resolved";
      readonly payload: EffectReviewResolvedEvent;
    }
  | { readonly type: "artifact_intent"; readonly payload: ArtifactIntentEvent }
  | {
      readonly type: "artifact_committed";
      readonly payload: ArtifactCommittedEvent;
    }
  | { readonly type: "run_terminal"; readonly payload: RunTerminalEvent }
  | { readonly type: "run_reopened"; readonly payload: RunReopenedEvent }
  | {
      readonly type: "run_cancel_requested";
      readonly payload: RunCancelRequestedEvent;
    }
  | {
      readonly type: "recovery_decision";
      readonly payload: RecoveryDecisionEvent;
    }
  | {
      /** Durable projection of the daemon-owned M3 admission journal. */
      readonly type: "execution_admission";
      readonly payload: AdmissionJournalEvent;
    }
  | {
      readonly type: "guardian_assessment";
      readonly payload: GuardianAssessmentEvent;
    }
  | {
      readonly type: "review_delegate_started";
      readonly payload: ReviewDelegateStartedEvent;
    }
  | {
      readonly type: "review_delegate_completed";
      readonly payload: ReviewDelegateCompletedEvent;
    }
  | {
      readonly type: "plan_approval_requested";
      readonly payload: PlanApprovalRequestedEvent;
    }
  | {
      readonly type: "plan_approval_completed";
      readonly payload: PlanApprovalCompletedEvent;
    }
  | {
      readonly type: "protocol_claim";
      readonly payload: ProtocolClaimEvent;
    }
  | {
      readonly type: "protocol_settle";
      readonly payload: ProtocolSettleEvent;
    }
  | {
      readonly type: "protocol_slash";
      readonly payload: ProtocolSlashEvent;
    }
  | {
      readonly type: "protocol_stake";
      readonly payload: ProtocolStakeEvent;
    }
  | {
      readonly type: "collab_agent_spawn_begin";
      readonly payload: CollabAgentSpawnBeginEvent;
    }
  | {
      readonly type: "collab_agent_spawn_end";
      readonly payload: CollabAgentSpawnEndEvent;
    }
  | {
      readonly type: "collab_agent_status";
      readonly payload: CollabAgentStatusEvent;
    }
  | {
      readonly type: "collab_agent_interaction_begin";
      readonly payload: CollabAgentInteractionBeginEvent;
    }
  | {
      readonly type: "collab_agent_interaction_end";
      readonly payload: CollabAgentInteractionEndEvent;
    }
  | {
      readonly type: "collab_waiting_begin";
      readonly payload: CollabWaitingBeginEvent;
    }
  | {
      readonly type: "collab_waiting_end";
      readonly payload: CollabWaitingEndEvent;
    }
  | {
      readonly type: "collab_close_begin";
      readonly payload: CollabCloseBeginEvent;
    }
  | {
      readonly type: "collab_close_end";
      readonly payload: CollabCloseEndEvent;
    }
  | {
      readonly type: "collab_resume_begin";
      readonly payload: CollabResumeBeginEvent;
    }
  | {
      readonly type: "collab_resume_end";
      readonly payload: CollabResumeEndEvent;
    }
  | {
      readonly type: "entered_review_mode";
      readonly payload: import("./review.js").ReviewRequest;
    }
  | {
      readonly type: "deprecation_notice";
      readonly payload: DeprecationNoticeEvent;
    }
  | { readonly type: "plan_started"; readonly payload: PlanStartedEvent }
  | { readonly type: "plan_delta"; readonly payload: PlanDeltaEvent }
  | {
      readonly type: "plan_item_completed";
      readonly payload: PlanItemCompletedEvent;
    }
  | { readonly type: "plan_exited"; readonly payload: PlanExitedEvent }
  | {
      readonly type: "exit_review_mode";
      readonly payload: import("./agenc-delegate.js").ExitReviewModePayload;
    };

/**
 * Structured deprecation-notice payload. Emitted whenever the runtime
 * silently rewrites an operator-supplied identifier (model alias,
 * deprecated API field, compatibility config key) to a canonical value so
 * telemetry and the event log can surface the rewrite instead of the
 * operator only discovering the change from downstream behavior.
 *
 *   - `subject`: what got deprecated (e.g. `"grok-4.20-beta-0309-reasoning"`)
 *   - `reason`:  why it was deprecated or what the rewrite is about
 *   - `replacement`: optional canonical identifier the subject resolved to
 *   - `deprecated_since`: optional marker of when the deprecation began
 */
export interface DeprecationNoticeEvent {
  readonly subject: string;
  readonly reason: string;
  readonly replacement?: string;
  readonly deprecated_since?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Plan-mode EventMsg variants (T12 Wave 4-C)
// ─────────────────────────────────────────────────────────────────────

/**
 * Emitted when the streaming pipeline starts a new plan item inside a
 * plan-mode turn. Downstream renderers group `plan_delta`s by
 * `planItemId` until the matching `plan_item_completed` arrives.
 */
export interface PlanStartedEvent {
  readonly turnId: string;
  readonly planItemId: string;
  readonly title: string;
  readonly timestamp: number;
}

/**
 * Emitted for each streamed delta inside an active plan item. The TUI
 * transcript concatenates these to render the in-flight plan body.
 */
export interface PlanDeltaEvent {
  readonly turnId: string;
  readonly planItemId: string;
  readonly delta: string;
  readonly timestamp: number;
}

/**
 * Emitted when a plan item is finalized — carries the fully accumulated
 * plan text for rollout replay and archival rendering.
 */
export interface PlanItemCompletedEvent {
  readonly turnId: string;
  readonly planItemId: string;
  readonly finalText: string;
  readonly timestamp: number;
}

/**
 * Emitted when plan mode exits (either the `ExitPlanMode` tool fires or
 * the user leaves plan mode via the `/plan` slash command). Downstream
 * renderers use this to close the plan-progress surface.
 */
export interface PlanExitedEvent {
  readonly turnId: string;
  readonly timestamp: number;
}

/**
 * All known event-type tags. `isKnownEventType()` checks membership;
 * the reducer wraps unknown tags in an `unknown` shim (I-26).
 */
export const KNOWN_EVENT_TYPES = Object.freeze(
  new Set<string>([
    "session_meta",
    "session_configured",
    "turn_started",
    "turn_context",
    "agent_message",
    "agent_message_delta",
    "agent_thinking",
    "assistant_thinking_block_start",
    "assistant_thinking_delta",
    "assistant_thinking_block_stop",
    "user_message",
    "token_count",
    "mcp_tool_call_begin",
    "mcp_tool_call_end",
    "exec_command_begin",
    "exec_command_end",
    "exec_approval_request",
    "tool_call_started",
    "tool_input_block_start",
    "tool_input_delta",
    "tool_call_completed",
    "tool_progress",
    "request_permissions",
    "request_user_input",
    "mcp_elicitation_request",
    "mcp_elicitation_complete",
    "context_compacted",
    "turn_complete",
    "turn_aborted",
    "turn_checkpoint",
    "turn_resumed",
    "thread_rolled_back",
    "error",
    "stream_error",
    "warning",
    "effect_intent",
    "effect_result",
    "effect_unknown_outcome",
    "effect_review_resolved",
    "permission_decision",
    "artifact_intent",
    "artifact_committed",
    "run_terminal",
    "run_reopened",
    "run_cancel_requested",
    "recovery_decision",
    "execution_admission",
    "guardian_assessment",
    "review_delegate_started",
    "review_delegate_completed",
    "plan_approval_requested",
    "plan_approval_completed",
    "protocol_claim",
    "protocol_settle",
    "protocol_slash",
    "protocol_stake",
    "collab_agent_spawn_begin",
    "collab_agent_spawn_end",
    "collab_agent_status",
    "collab_agent_interaction_begin",
    "collab_agent_interaction_end",
    "collab_waiting_begin",
    "collab_waiting_end",
    "collab_close_begin",
    "collab_close_end",
    "collab_resume_begin",
    "collab_resume_end",
    "entered_review_mode",
    "deprecation_notice",
    "plan_started",
    "plan_delta",
    "plan_item_completed",
    "plan_exited",
    "exit_review_mode",
  ]),
);

export function isKnownEventType(type: string): boolean {
  return KNOWN_EVENT_TYPES.has(type);
}

/**
 * Durable events force an immediate fsync before the phase machine
 * proceeds (I-4). Turn-scoped durability is guaranteed; within a
 * turn, up to 100ms of progress events may be lost on crash.
 */
const DURABLE_EVENT_TYPES = Object.freeze(
  new Set<string>([
    "turn_complete",
    "turn_aborted",
    "error",
    "context_compacted",
    "protocol_claim",
    "protocol_settle",
    "protocol_slash",
    "protocol_stake",
    // GOAL #4b Stage 1: the iteration checkpoint and the resume marker
    // MUST fsync — a checkpoint written <100ms before a crash that rode
    // the 100ms batch path would be lost, defeating resume-continuation.
    "turn_checkpoint",
    "turn_resumed",
    // M4 effect lifecycle records are commit boundaries. The intent must be
    // durable before dispatch, and an acknowledgement must be durable before
    // the caller is allowed to continue.
    "effect_intent",
    "effect_result",
    "effect_unknown_outcome",
    "effect_review_resolved",
    "request_permissions",
    "permission_decision",
    "artifact_intent",
    "artifact_committed",
    "run_terminal",
    "run_reopened",
    "run_cancel_requested",
    "recovery_decision",
  ]),
);

export function isDurableEvent(event: Event): boolean {
  return DURABLE_EVENT_TYPES.has(event.msg.type);
}

// ─────────────────────────────────────────────────────────────────────
// EventLog — synchronous seq-assigning emitter + subscriber fan-out.
// ─────────────────────────────────────────────────────────────────────

export type EventListener = (event: Event) => void;

interface PendingPublication {
  readonly event: Event;
  readonly afterPublish?: EventListener;
}

/**
 * Synchronous, in-process event bus. Emitted events get a monotonic
 * `seq` assigned before any async work (I-27). Listeners receive
 * events in emission order; a listener throwing doesn't affect
 * subsequent listeners (per-sidecar isolation preview — I-43).
 */
export class EventLog {
  private nextSeq: EventSeq = 0;
  private readonly allocatedEventIds = new Set<string>();
  private readonly listeners = new Set<EventListener>();
  private readonly pendingPublications: PendingPublication[] = [];
  private emitDelegate: ((event: Event) => Event) | undefined;
  private publishing = false;
  private closed = false;

  /**
   * Install the owning Session's persist-before-publish path. Legacy runtime
   * producers that still receive only `session.eventLog` then converge on the
   * same rollout append instead of allocating live-only sequence numbers.
   */
  setEmitDelegate(delegate: ((event: Event) => Event) | undefined): void {
    this.emitDelegate = delegate;
  }

  /**
   * Allocate the next sequence without publishing to subscribers. Durable
   * owners use this split phase to persist + fsync the stamped event before
   * any listener can observe it.
   */
  stamp(event: Event): Event {
    if (this.closed) return event;
    const seq = this.nextSeq + 1;
    const suppliedEventId: unknown = event.eventId;
    if (
      suppliedEventId !== undefined &&
      (typeof suppliedEventId !== "string" || suppliedEventId.length === 0)
    ) {
      throw new Error("eventId must be a non-empty string");
    }
    if (
      typeof suppliedEventId === "string" &&
      /^event:[1-9]\d*$/.test(suppliedEventId) &&
      suppliedEventId !== `event:${seq}`
    ) {
      throw new Error(
        `eventId ${suppliedEventId} is reserved for sequence ${suppliedEventId.slice("event:".length)}`,
      );
    }
    const eventId = suppliedEventId ?? `event:${seq}`;
    if (this.allocatedEventIds.has(eventId)) {
      throw new Error(`eventId already allocated: ${eventId}`);
    }
    this.nextSeq = seq;
    this.allocatedEventIds.add(eventId);
    return { ...event, eventId, seq };
  }

  /**
   * Publish an already-stamped event. Re-entrant publications are queued so
   * every listener observes monotonically increasing sequence order.
   */
  publish(event: Event, afterPublish?: EventListener): Event {
    if (this.closed) return event;
    this.pendingPublications.push({ event, afterPublish });
    if (this.publishing) return event;
    this.publishing = true;
    try {
      let next: PendingPublication | undefined;
      while ((next = this.pendingPublications.shift()) !== undefined) {
        for (const listener of this.listeners) {
          try {
            listener(next.event);
          } catch {
            // I-43: per-sidecar isolation — don't let one subscriber's
            // failure prevent the others from receiving the event.
          }
        }
        next.afterPublish?.(next.event);
      }
    } finally {
      this.publishing = false;
    }
    return event;
  }

  /**
   * Compatibility one-shot emit. Durable Session owners use stamp() followed
   * by persistence and publish(); standalone event logs retain this API.
   */
  emit(event: Event): Event {
    if (this.emitDelegate !== undefined) return this.emitDelegate(event);
    return this.publish(this.stamp(event));
  }

  /**
   * Subscribe. Returns an unsubscribe function. Listeners fire in
   * registration order; the set preserves insertion order.
   */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Current next-seq value (useful for tests / telemetry). */
  get lastSeq(): EventSeq {
    return this.nextSeq;
  }

  seedLastSeq(seq: EventSeq): void {
    if (!Number.isSafeInteger(seq) || seq <= this.nextSeq) return;
    this.nextSeq = seq;
  }

  /**
   * Restore canonical coordinates before a resumed session accepts new
   * producers. Sequence alone is insufficient: allowing an old eventId to be
   * reused at a new sequence would permanently corrupt cursor replay.
   */
  seedCanonicalHistory(events: readonly Event[]): void {
    let maxSequence = this.nextSeq;
    const historicalSequences = new Set<number>();
    for (const event of events) {
      if (
        !Number.isSafeInteger(event.seq) ||
        event.seq === undefined ||
        event.seq <= 0
      ) {
        continue;
      }
      const eventId =
        typeof event.eventId === "string" && event.eventId.length > 0
          ? event.eventId
          : `legacy-event:${event.seq}:${event.id}`;
      if (historicalSequences.has(event.seq)) {
        throw new Error(`canonical rollout reuses sequence: ${event.seq}`);
      }
      const reservedSequence = /^event:([1-9]\d*)$/.exec(eventId)?.[1];
      if (
        reservedSequence !== undefined &&
        Number(reservedSequence) !== event.seq
      ) {
        throw new Error(
          `canonical rollout eventId ${eventId} conflicts with sequence ${event.seq}`,
        );
      }
      if (this.allocatedEventIds.has(eventId)) {
        throw new Error(`canonical rollout reuses eventId: ${eventId}`);
      }
      historicalSequences.add(event.seq);
      this.allocatedEventIds.add(eventId);
      maxSequence = Math.max(maxSequence, event.seq);
    }
    this.nextSeq = maxSequence;
  }

  close(): void {
    this.closed = true;
    this.emitDelegate = undefined;
    this.pendingPublications.length = 0;
    this.listeners.clear();
    this.allocatedEventIds.clear();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

// ─────────────────────────────────────────────────────────────────────
// I-8: emitError helper — single entry point for all error sites.
// ─────────────────────────────────────────────────────────────────────

export interface EmitErrorOptions {
  readonly cause: string;
  readonly message: string;
  readonly turnId?: string;
  readonly stack?: string;
  /** Use `stream_error` instead of `error` (for transient provider failures). */
  readonly streamError?: boolean;
  /** Provider label (included when streamError=true). */
  readonly provider?: string;
  readonly status?: number;
}

interface EmitErrorTarget {
  emit(event: Event): Event | void;
}

/**
 * I-8 entry point. Every error site MUST funnel through this helper
 * so post-mortem analysis can distinguish *what kind of failure
 * happened*. Callers pass `streamError: true` for transient
 * provider-layer failures (classified separately so recovery can
 * route on `stream_error` events).
 */
export function emitError(
  log: EmitErrorTarget,
  subId: string,
  options: EmitErrorOptions,
): Event {
  const event: Event = options.streamError
    ? {
        id: subId,
        msg: {
          type: "stream_error",
          payload: {
            cause: options.cause,
            message: options.message,
            ...(options.provider !== undefined
              ? { provider: options.provider }
              : {}),
            ...(options.status !== undefined ? { status: options.status } : {}),
          },
        },
      }
    : {
        id: subId,
        msg: {
          type: "error",
          payload: {
            cause: options.cause,
            message: options.message,
            ...(options.turnId !== undefined ? { turnId: options.turnId } : {}),
            ...(options.stack !== undefined ? { stack: options.stack } : {}),
          },
        },
      };
  return log.emit(event) ?? event;
}

/**
 * I-8: warning helper. Warnings surface to telemetry but don't abort
 * the turn. The existing known-warning sites (from the invariant
 * matrix) include: MCP soft startup failure, mode-race abort, config
 * reload request, stop-hook throw, reactive recovery throw, etc.
 */
export function emitWarning(
  log: EventLog,
  subId: string,
  cause: string,
  message: string,
): Event {
  return log.emit({
    id: subId,
    msg: {
      type: "warning",
      payload: { cause, message },
    },
  });
}

/**
 * Deprecation-notice helper. Single entry point for every runtime site
 * that silently rewrites an operator-supplied identifier to a
 * canonical value. Keeping the emit here (rather than inline at each
 * call site) guarantees every deprecation event carries the same
 * payload shape for downstream consumers and rollout replay.
 */
export function emitDeprecationNotice(
  log: EventLog,
  subId: string,
  notice: DeprecationNoticeEvent,
): Event {
  return log.emit({
    id: subId,
    msg: {
      type: "deprecation_notice",
      payload: notice,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────
// Convenience: build a minimal LLMMessage → EventMsg projection.
// Used by sidecars to shadow assistant/user messages into the event
// log for replay.
// ─────────────────────────────────────────────────────────────────────

export function llmMessageToEvent(message: LLMMessage): EventMsg | null {
  const contentString =
    typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content);
  if (message.role === "user") {
    return {
      type: "user_message",
      payload: {
        message: message.content,
        displayText: contentString,
        ...(Array.isArray(message.content)
          ? {
              images: message.content
                .filter((part) => part.type === "image_url")
                .map((part) => part.image_url.url),
            }
          : {}),
      },
    };
  }
  if (message.role === "assistant") {
    return {
      type: "agent_message",
      payload: { message: contentString },
    };
  }
  return null;
}

export function usageToTokenCountEvent(usage: LLMUsage): EventMsg {
  return {
    type: "token_count",
    payload: {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      ...(usage.cachedInputTokens !== undefined
        ? { cachedInputTokens: usage.cachedInputTokens }
        : {}),
      ...(usage.cacheCreationInputTokens !== undefined
        ? { cacheCreationInputTokens: usage.cacheCreationInputTokens }
        : {}),
      ...(usage.reasoningOutputTokens !== undefined
        ? { reasoningOutputTokens: usage.reasoningOutputTokens }
        : {}),
      ...(usage.webSearchRequests !== undefined
        ? { webSearchRequests: usage.webSearchRequests }
        : {}),
    },
  };
}
