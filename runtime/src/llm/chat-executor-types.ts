/**
 * Type definitions and error classes for ChatExecutor.
 *
 * @module
 */

import type { GatewayMessage } from "../gateway/message.js";
import type { PromptEnvelopeV1 } from "./prompt-envelope.js";
import type {
  LLMMessage,
  LLMProviderEvidence,
  LLMCompactionDiagnostics,
  LLMProviderTraceEvent,
  LLMResponse,
  LLMStructuredOutputRequest,
  LLMStructuredOutputResult,
  LLMUsage,
  LLMRequestMetrics,
  StreamProgressCallback,
  ToolHandler,
  LLMProvider,
} from "./types.js";
import type {
  PromptBudgetConfig,
  PromptBudgetDiagnostics,
  PromptBudgetSection,
} from "./prompt-budget.js";
import type {
  LLMFailureClass,
  LLMPipelineStopReason,
  LLMRetryPolicyRule,
} from "./policy.js";
import type {
  Pipeline,
  PipelineExecutionOptions,
  PipelineResult,
} from "../workflow/pipeline.js";
import type { ArtifactCompactionState } from "../memory/artifact-store.js";
import type { ExecutionEnvelope } from "../workflow/execution-envelope.js";
import type { ImplementationCompletionContract } from "../workflow/completion-contract.js";
import type { WorkflowCompletionState } from "../workflow/completion-state.js";
import type { WorkflowProgressSnapshot } from "../workflow/completion-progress.js";
import type {
  WorkflowVerificationContract,
} from "../workflow/verification-obligations.js";
import type {
  RuntimeEconomicsPolicy,
  RuntimeEconomicsState,
  RuntimeEconomicsSummary,
  RuntimeRunClass,
} from "./run-budget.js";
import {
  createRuntimeEconomicsState,
} from "./run-budget.js";
import type { ModelRoutingPolicy } from "./model-routing-policy.js";
import type {
  DelegationContractSpec,
  DelegationOutputValidationCode,
} from "../utils/delegation-validation.js";
import type { HostToolingProfile } from "../gateway/host-tooling.js";
import type { InteractiveContextRequest } from "../gateway/interactive-context.js";
import type { ActiveTaskContext, TurnExecutionContract } from "./turn-execution-contract-types.js";
import type {
  RuntimeContractFlags,
  RuntimeContractSnapshot,
} from "../runtime-contract/types.js";
import type { StopHookRuntime } from "./hooks/stop-hooks.js";
import { createRuntimeContractSnapshot } from "../runtime-contract/types.js";
import { RuntimeError, RuntimeErrorCodes } from "../types/errors.js";
import {
  createToolProtocolState,
  type ToolProtocolState,
} from "./tool-protocol-state.js";
import {
  createPerIterationCompactionState,
  type PerIterationCompactionState,
} from "./compact/index.js";
import {
  createRequestTaskProgressState,
  type RequestTaskProgressState,
} from "./request-task-progress.js";
import {
  createTurnContinuationState,
  type TurnContinuationState,
} from "./chat-executor-continuation.js";

// ============================================================================
// Error classes
// ============================================================================

/**
 * Error thrown when a session's token budget is exceeded.
 */
export class ChatBudgetExceededError extends RuntimeError {
  public readonly sessionId: string;
  public readonly used: number;
  public readonly limit: number;

  constructor(sessionId: string, used: number, limit: number) {
    super(
      `Token budget exceeded for session "${sessionId}": ${used}/${limit}`,
      RuntimeErrorCodes.CHAT_BUDGET_EXCEEDED,
    );
    this.name = "ChatBudgetExceededError";
    this.sessionId = sessionId;
    this.used = used;
    this.limit = limit;
  }
}

// ============================================================================
// Injection interfaces
// ============================================================================

export interface DetailedSkillInjectionResult {
  readonly content: string | undefined;
  readonly trustedContent?: string;
  readonly untrustedContent?: string;
}

/** Injects skill context into a conversation. */
export interface SkillInjector {
  inject(message: string, sessionId: string): Promise<string | undefined>;
  injectDetailed?(
    message: string,
    sessionId: string,
  ): Promise<DetailedSkillInjectionResult>;
}

/** Retrieves memory context for a conversation. */
export interface MemoryRetriever {
  retrieve(message: string, sessionId: string): Promise<string | undefined>;
}

// ============================================================================
// Core types
// ============================================================================

/** Record of a single tool call execution. */
export interface ToolCallRecord {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly result: string;
  readonly isError: boolean;
  readonly durationMs: number;
  readonly toolCallId?: string;
  readonly synthetic?: boolean;
  readonly protocolRepairReason?: string;
  readonly failureBudgetExempt?: boolean;
}

/**
 * Complete inventory of runtime-emitted chat execution trace event
 * types. Exposed as a readonly tuple so field-inventory snapshot tests
 * can assert the exact set without reflecting on a compile-time-only
 * union. Any event type added to or removed from this list changes
 * the public trace contract; update consumers and tests deliberately.
 */
export const CHAT_EXECUTION_TRACE_EVENT_TYPES = [
  "continuation_evaluated",
  "continuation_started",
  "continuation_stopped",
  "completion_validator_finished",
  "completion_validator_started",
  "completion_validation_finished",
  "completion_validation_started",
  "compaction_triggered",
  "context_injected",
  "model_call_prepared",
  "recovery_hints_injected",
  "route_expanded",
  "runtime_contract_snapshot",
  "stall_escalated",
  "stop_hook_blocked",
  "stop_hook_execution_finished",
  "stop_hook_exhausted",
  "stop_hook_retry_requested",
  "stop_gate_intervention",
  "tool_arguments_invalid",
  "tool_dispatch_finished",
  "tool_dispatch_started",
  "tool_protocol_opened",
  "tool_protocol_repaired",
  "tool_protocol_result_recorded",
  "tool_protocol_violation",
  "tool_rejected",
] as const;

export type ChatExecutionTraceEventType =
  (typeof CHAT_EXECUTION_TRACE_EVENT_TYPES)[number];

export interface ChatExecutionTraceEvent {
  readonly type: ChatExecutionTraceEventType;
  readonly phase?: ChatCallUsageRecord["phase"];
  readonly callIndex?: number;
  readonly payload: Record<string, unknown>;
}

/** Parameters for a single ChatExecutor.execute() call. */
export interface ChatExecuteParams {
  readonly message: GatewayMessage;
  readonly history: readonly LLMMessage[];
  readonly promptEnvelope: PromptEnvelopeV1;
  readonly sessionId: string;
  /** Optional request-scoped structured output contract. */
  readonly structuredOutput?: LLMStructuredOutputRequest;
  /** Runtime-owned execution context resolved before model/planner execution. */
  readonly runtimeContext?: {
    /** Authoritative workspace root for planning/execution when known. */
    readonly workspaceRoot?: string;
    /** Typed active-task carryover used only when the current turn explicitly continues that task. */
    readonly activeTaskContext?: ActiveTaskContext;
    /**
     * Active session workflow stage (idle/plan/implement/review/verify).
     * When `"plan"`, the stop-gate is suppressed because plan-mode answers
     * are inherently text-only — the user asked for a plan, the assistant
     * delivers one as the final reply, and the `narrated_future_tool_work`
     * detector would otherwise misclassify the plan as a checkpoint and
     * force endless `tool_choice: required` recovery rounds.
     */
    readonly workflowStage?: string;
  };
  /** Per-call tool handler — overrides the constructor handler for this call. */
  readonly toolHandler?: ToolHandler;
  /** Per-call stream callback — overrides the constructor callback for this call. */
  readonly onStreamChunk?: StreamProgressCallback;
  /** Abort signal — when aborted, the executor stops after the current tool call. */
  readonly signal?: AbortSignal;
  /** Per-call tool round limit — overrides the constructor default. */
  readonly maxToolRounds?: number;
  /** Per-call total tool-call budget — overrides the constructor default. */
  readonly toolBudgetPerRequest?: number;
  /** Per-call model recall budget (calls after the first) — overrides the constructor default. */
  readonly maxModelRecallsPerRequest?: number;
  /** Per-call failed-tool budget — overrides the constructor default. */
  readonly maxFailureBudgetPerRequest?: number;
  /** Per-call end-to-end timeout in milliseconds — overrides the constructor default. 0 = unlimited. */
  readonly requestTimeoutMs?: number;
  /** Optional explicit per-turn output-token continuation budget. Null disables output-budget continuation. */
  readonly turnOutputTokenBudget?: number | null;
  /** Per-call context injection controls for bounded/system-owned executions. */
  readonly contextInjection?: {
    /** When false, skip skill/system context injection for this call. */
    readonly skills?: boolean;
    /** When false, skip memory/learning/progress retrieval for this call. */
    readonly memory?: boolean;
  };
  /** Optional replay/hydration context for interactive resume/fork parity. */
  readonly interactiveContext?: InteractiveContextRequest;
  /** Optional per-turn tool-routing subset and expansion policy. */
  readonly toolRouting?: {
    /** Effective advertised bundle for this turn before any lexical narrowing. */
    readonly advertisedToolNames?: readonly string[];
    /** Initial routed subset for this turn. */
    readonly routedToolNames?: readonly string[];
    /** One-turn expanded subset used on suspected routing misses. */
    readonly expandedToolNames?: readonly string[];
    /** Enable one-turn expansion retry on routed-tool misses. */
    readonly expandOnMiss?: boolean;
    /** Enable discovery-driven widening for later model recalls in the same turn. */
    readonly persistDiscovery?: boolean;
    /**
     * Optional callback invoked before each follow-up provider call to
     * re-resolve the advertised tool catalog against the current
     * session state. When provided and it returns a list that differs
     * from the initial `advertisedToolNames`, the executor updates
     * `activeRoutedToolNames` for the next call. Primary motivation:
     * workflow-stage changes made by tools mid-turn (e.g.
     * `workflow.enterPlan` flipping stage from `idle` → `plan`) must
     * take effect on the very next provider call, not just on the
     * next user turn. Without this hook the catalog is frozen at turn
     * start and plan mode can't actually gate mutating tools until a
     * follow-up user message.
     */
    readonly resolveAdvertisedToolNames?: () => readonly string[];
  };
  /** Require at least one successful tool call before accepting a final answer. */
  readonly requiredToolEvidence?: {
    /** Optional tighter ceiling for productive continuation recovery loops. */
    readonly maxCorrectionAttempts?: number;
    /** Optional delegated output contract used for phase-specific validation. */
    readonly delegationSpec?: DelegationContractSpec;
    /** When true, delegated contract enforcement is disabled for benchmark-only runs. */
    readonly unsafeBenchmarkMode?: boolean;
    /** Optional workflow-owned verification contract for implementation completion. */
    readonly verificationContract?: WorkflowVerificationContract;
    /** Optional completion contract for implementation-class tasks. */
    readonly completionContract?: ImplementationCompletionContract;
    /** Optional execution envelope used to bound top-level tool access for explicit artifact tasks. */
    readonly executionEnvelope?: ExecutionEnvelope;
  };
  /** Optional provider-payload tracing hooks for incident diagnostics. */
  readonly trace?: {
    readonly includeProviderPayloads?: boolean;
    readonly onProviderTraceEvent?: (event: LLMProviderTraceEvent) => void;
    readonly onExecutionTraceEvent?: (event: ChatExecutionTraceEvent) => void;
  };
}

/** Estimated prompt-shape statistics for one provider call. */
export interface ChatPromptShape {
  readonly messageCount: number;
  readonly systemMessages: number;
  readonly userMessages: number;
  readonly assistantMessages: number;
  readonly toolMessages: number;
  readonly estimatedChars: number;
  readonly systemPromptChars: number;
}

/** Per-provider-call usage attribution for one ChatExecutor execution. */
export interface ChatCallUsageRecord {
  /** 1-based call index within a single execute() invocation. */
  readonly callIndex: number;
  readonly phase:
    | "compaction"
    | "initial"
    | "tool_followup";
  readonly provider: string;
  readonly model?: string;
  readonly finishReason: LLMResponse["finishReason"];
  readonly usage: LLMUsage;
  readonly durationMs: number;
  readonly beforeBudget: ChatPromptShape;
  readonly afterBudget: ChatPromptShape;
  /** Provider-specific request metrics (e.g. toolSchemaChars for Grok). */
  readonly providerRequestMetrics?: LLMRequestMetrics;
  /** Prompt-budget diagnostics (sections dropped/truncated, caps, and totals). */
  readonly budgetDiagnostics?: PromptBudgetDiagnostics;
  /** Provider-native compaction diagnostics for this provider call (when supported). */
  readonly compactionDiagnostics?: LLMCompactionDiagnostics;
}

/** Planner-routing decision and ROI summary for one execute() invocation. */
export interface ChatPlannerSummary {
  readonly enabled: boolean;
  readonly used: boolean;
  readonly routeReason?: string;
  readonly complexityScore: number;
  readonly plannerCalls: number;
  readonly plannedSteps: number;
  readonly deterministicStepsExecuted: number;
  /** Estimated downstream model recalls avoided by deterministic execution. */
  readonly estimatedRecallsAvoided: number;
  /** Structured planner parse/validation/policy diagnostics for this turn. */
  readonly diagnostics?: readonly PlannerDiagnostic[];
}

export interface PlannerDiagnostic {
  readonly category: "parse" | "validation" | "policy" | "runtime";
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

/** Aggregated tool-routing diagnostics for one execute() invocation. */
export interface ChatToolRoutingSummary {
  readonly enabled: boolean;
  readonly initialToolCount: number;
  readonly finalToolCount: number;
  readonly routeMisses: number;
  readonly expanded: boolean;
}

export interface ChatToolDiscoverySummary {
  readonly advertisedToolNames: readonly string[];
  readonly discoveredToolNames: readonly string[];
}

/** Result returned from ChatExecutor.execute(). */
export interface ChatExecutorResult {
  readonly content: string;
  readonly provider: string;
  /** Actual model identifier returned by the provider for the final response. */
  readonly model?: string;
  readonly configuredModel?: string;
  readonly resolvedModel?: string;
  readonly usedFallback: boolean;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly providerEvidence?: LLMProviderEvidence;
  /** Structured output returned by the provider when requested. */
  readonly structuredOutput?: LLMStructuredOutputResult;
  readonly tokenUsage: LLMUsage;
  /** Per-call token and prompt-shape attribution for this execution. */
  readonly callUsage: readonly ChatCallUsageRecord[];
  readonly durationMs: number;
  /** True if conversation history was compacted during this execution. */
  readonly compacted: boolean;
  /** Per-turn dynamic tool-routing diagnostics for this execution. */
  readonly toolRoutingSummary?: ChatToolRoutingSummary;
  /** Discovery-driven deferred-tool state captured for this execution. */
  readonly toolDiscoverySummary?: ChatToolDiscoverySummary;
  /** Planner/executor routing summary and ROI diagnostics. */
  readonly plannerSummary?: ChatPlannerSummary;
  /** Runtime-owned economics summary for routing, ceilings, and downgrades. */
  readonly economicsSummary?: RuntimeEconomicsSummary;
  /** Canonical stop reason for this request execution. */
  readonly stopReason: LLMPipelineStopReason;
  /** Honest terminal state for user-visible and operator-visible completion semantics. */
  readonly completionState: WorkflowCompletionState;
  /** Structured progress snapshot for long-horizon resume/recovery flows. */
  readonly completionProgress?: WorkflowProgressSnapshot;
  /** Runtime-contract telemetry captured during execution. Not consulted for final completion decisions. */
  readonly runtimeContractSnapshot?: RuntimeContractSnapshot;
  /** Resolved workspace root used for this execution, when available. */
  readonly runtimeWorkspaceRoot?: string;
  /** Single preflight execution contract that governed this turn. */
  readonly turnExecutionContract: TurnExecutionContract;
  /** Typed task carryover emitted for the next compatible turn, when applicable. */
  readonly activeTaskContext?: ActiveTaskContext;
  /** Durable SessionStart hook context to replay on resumed turns. */
  readonly sessionStartContextMessages?: readonly LLMMessage[];
  /** Optional detail for non-completed stop reasons. */
  readonly stopReasonDetail?: string;
  /** Optional delegated-output validation code associated with a validation_error stop. */
  readonly validationCode?: DelegationOutputValidationCode;
}

/** Authoritative terminal payload returned from the tool loop. */
export interface ToolLoopTerminalResult {
  readonly content: string;
  readonly stopReason: LLMPipelineStopReason;
  readonly stopReasonDetail?: string;
  readonly validationCode?: DelegationOutputValidationCode;
  readonly completionState?: WorkflowCompletionState;
  readonly runtimeContractSnapshot: RuntimeContractSnapshot;
  readonly mutationDetected: boolean;
}

/** Minimal pipeline executor interface required by ChatExecutor planner path. */
export interface DeterministicPipelineExecutor {
  execute(
    pipeline: Pipeline,
    startFrom?: number,
    options?: PipelineExecutionOptions,
  ): Promise<PipelineResult>;
}

export type LLMRetryPolicyOverrides = Partial<{
  [K in LLMFailureClass]: Partial<LLMRetryPolicyRule>;
}>;

/** Configuration for ChatExecutor construction. */
export interface ChatExecutorConfig {
  /** Ordered providers — first is primary, rest are fallbacks. */
  readonly providers: readonly LLMProvider[];
  readonly toolHandler?: ToolHandler;
  readonly maxToolRounds?: number;
  readonly onStreamChunk?: StreamProgressCallback;
  readonly skillInjector?: SkillInjector;
  readonly memoryRetriever?: MemoryRetriever;
  readonly allowedTools?: readonly string[];
  /**
   * Cut 5.2: optional hook registry. When provided, the chat-executor
   * fires PreToolUse / PostToolUse / PostToolUseFailure hooks at the
   * tool dispatch boundary. With no registry the hook code paths
   * short-circuit and behavior is unchanged.
   */
  readonly hookRegistry?: import("./hooks/index.js").HookRegistry;
  /**
   * Cut 5.7: optional canUseTool seam. When provided, the runtime
   * calls this before every tool dispatch and honors deny/ask/allow
   * with optional updatedInput. Callers can wrap a
   * ToolPermissionEvaluator via `evaluatorToCanUseTool()` to plug the
   * unified policy pipeline through this single hook.
   */
  readonly canUseTool?: import("./can-use-tool.js").CanUseToolFn;
  /**
   * Cut 5.5: optional concurrency-safety predicate. When provided,
   * the tool loop emits a per-round partition trace identifying which
   * batches could have been dispatched in parallel. Dispatch itself
   * remains serial.
   */
  readonly isConcurrencySafe?: import("./tool-orchestration.js").IsConcurrencySafeFn;
  /**
   * Cut 5.3: tool result budget config. When set, oversized tool
   * results are persisted to disk and replaced in the message history
   * with a `<persisted-output>` placeholder pointing at the file
   * path. Per-session ContentReplacementState is owned by the
   * executor; callers only need to supply the budget config.
   */
  readonly toolResultBudget?: import("./tool-result-budget.js").ToolBudgetConfig;
  /**
   * Phase N: optional memory consolidation hook. When set, the
   * per-iteration compaction chain invokes the hook after the
   * autocompact decision layer and appends any synthetic summary
   * message it returns to the boundary list. The executor threads
   * this through to `runPerIterationCompactionBeforeModelCall`
   * and ultimately `applyPerIterationCompaction`. Callers wire
   * `memory/consolidation.ts:consolidateEpisodicSlice` here for
   * deterministic in-memory slice consolidation. Off by default.
   */
  readonly consolidationHook?: (
    messages: readonly import("./types.js").LLMMessage[],
  ) => {
    readonly action: "noop" | "consolidated";
    readonly summaryMessage?: import("./types.js").LLMMessage;
  };
  /**
   * Maximum token budget per session. When cumulative usage meets or exceeds
   * this value, the executor attempts to compact conversation history by
   * summarizing older messages. If compaction fails, falls back to
   * `ChatBudgetExceededError`.
   */
  readonly sessionTokenBudget?: number;
  /**
   * Soft local compaction threshold per session. When cumulative usage meets
   * or exceeds this value, the executor attempts best-effort local history
   * compaction without treating the threshold as a hard failure ceiling.
   */
  readonly sessionCompactionThreshold?: number;
  /** Callback when context compaction occurs (budget recovery). */
  readonly onCompaction?: (sessionId: string, summary: string) => void;
  /** Optional provider that injects self-learning context per message. */
  readonly learningProvider?: MemoryRetriever;
  /** Optional provider that injects cross-session progress context per message. */
  readonly progressProvider?: MemoryRetriever;
  /** Optional provider that injects agent identity/personality context (Phase 5.4). */
  readonly identityProvider?: MemoryRetriever;
  /** Prompt budget allocator configuration (Phase 2). */
  readonly promptBudget?: PromptBudgetConfig;
  /** Base cooldown period for failed providers in ms (default: 60_000). */
  readonly providerCooldownMs?: number;
  /** Maximum cooldown period in ms (default: 300_000). */
  readonly maxCooldownMs?: number;
  /** Maximum tracked sessions before eviction (default: 10_000). */
  readonly maxTrackedSessions?: number;
  /** Enable planner/executor split for high-complexity turns. */
  readonly plannerEnabled?: boolean;
  /** Max output tokens for the planner pass (bounded planning call). */
  readonly plannerMaxTokens?: number;
  /**
   * Current delegation nesting depth (0 = top-level, 1 = first child, etc.).
   * Propagated through the delegation chain so the planner can generate
   * capability-aware plans — e.g. avoiding subagent_task steps that require
   * delegation when the child won't have execute_with_agent available.
   */
  readonly delegationNestingDepth?: number;
  /** Optional deterministic workflow executor used when planner emits executable steps. */
  readonly pipelineExecutor?: DeterministicPipelineExecutor;
  /** Maximum tool calls allowed for a single execute() invocation. */
  readonly toolBudgetPerRequest?: number;
  /** Maximum model recalls (calls after the first) for a single execute() invocation. 0 = unlimited. */
  readonly maxModelRecallsPerRequest?: number;
  /** Maximum total failed tool calls allowed for a single execute() invocation. */
  readonly maxFailureBudgetPerRequest?: number;
  /** Timeout for a single tool execution call in milliseconds. */
  readonly toolCallTimeoutMs?: number;
  /** End-to-end timeout for one execute() invocation in milliseconds. */
  readonly requestTimeoutMs?: number;
  /** Failure-class retry policy overrides (merged with defaults). */
  readonly retryPolicyMatrix?: LLMRetryPolicyOverrides;
  /** Optional live host-tooling profile used to constrain planner output. */
  readonly resolveHostToolingProfile?: () => HostToolingProfile | null;
  /** Optional canonical host workspace root used to ground planner paths. */
  readonly resolveHostWorkspaceRoot?: () => string | null;
  /** Runtime-owned token/latency/spend policy for planner/executor/verifier/child runs. */
  readonly economicsPolicy?: RuntimeEconomicsPolicy;
  /** Runtime-owned provider routing policy derived from provider catalog + economics policy. */
  readonly modelRoutingPolicy?: ModelRoutingPolicy;
  /** Force all calls in this executor instance into one run class (used for child runs). */
  readonly defaultRunClass?: RuntimeRunClass;
  /** Resolved runtime-contract flags active for this executor instance. */
  readonly runtimeContractFlags?: RuntimeContractFlags;
  /** Optional runtime-owned stop-hook chain used by validators and task/worker gates. */
  readonly stopHookRuntime?: StopHookRuntime;
}

// ============================================================================
// Internal types (used by sibling chat-executor-*.ts files)
// ============================================================================

export interface CooldownEntry {
  availableAt: number;
  failures: number;
}

export interface FallbackResult {
  response: LLMResponse;
  providerName: string;
  configuredModel?: string;
  usedFallback: boolean;
  beforeBudget: ChatPromptShape;
  afterBudget: ChatPromptShape;
  budgetDiagnostics: PromptBudgetDiagnostics;
  durationMs: number;
  streamedContent: string;
}

export interface RecoveryHint {
  key: string;
  message: string;
}

export interface PlannerDecision {
  score: number;
  shouldPlan: boolean;
  reason: string;
  artifactTargets?: readonly string[];
}

interface MutablePlannerSummaryState {
  deterministicStepsExecuted: number;
  diagnostics: PlannerDiagnostic[];
}

/** Full planner summary state — extends the subset used by executePlannerPipelineWithVerifier. */
interface FullPlannerSummaryState extends MutablePlannerSummaryState {
  enabled: boolean;
  used: boolean;
  routeReason: string;
  complexityScore: number;
  plannerCalls: number;
  plannedSteps: number;
  estimatedRecallsAvoided: number;
}

/** Loop-local mutable state shared across tool calls within a single round. */
export interface ToolLoopState {
  remainingToolImageChars: number;
  activeRoutedToolSet: Set<string> | null;
  expandAfterRound: boolean;
}

/** Control flow action returned by executeSingleToolCall(). */
export type ToolCallAction =
  | "processed"
  | "skip"
  | "end_round"
  | "abort_round"
  | "abort_loop";

/** Mutable context threaded through all phases of executeRequest(). */
export interface ExecutionContext {
  // --- Immutable request params (set once in init, never mutated) ---
  readonly message: GatewayMessage;
  readonly messageText: string;
  readonly baseSystemPrompt: string;
  promptEnvelope: PromptEnvelopeV1;
  readonly sessionId: string;
  readonly structuredOutput?: ChatExecuteParams["structuredOutput"];
  readonly runtimeWorkspaceRoot?: string;
  /** Active workflow stage at turn start (e.g. "plan"); see ChatExecuteParams.runtimeContext.workflowStage. */
  readonly runtimeWorkflowStage?: string;
  readonly turnExecutionContract: TurnExecutionContract;
  readonly signal?: AbortSignal;
  readonly activeToolHandler?: ToolHandler;
  readonly activeStreamCallback?: StreamProgressCallback;
  readonly effectiveMaxToolRounds: number;
  readonly effectiveToolBudget: number;
  readonly effectiveMaxModelRecalls: number;
  readonly effectiveFailureBudget: number;
  readonly effectiveRequestTimeoutMs: number;
  readonly turnOutputTokenBudget: number | null;
  readonly startTime: number;
  readonly requestDeadlineAt: number;
  readonly initialRoutedToolNames: readonly string[];
  readonly expandedRoutedToolNames: readonly string[];
  readonly defaultAdvertisedToolNames: readonly string[];
  readonly toolDiscoveryEnabled: boolean;
  readonly canExpandOnRoutingMiss: boolean;
  readonly hasHistory: boolean;
  readonly plannerDecision: PlannerDecision;
  readonly toolRouting?: ChatExecuteParams["toolRouting"];
  readonly requiredToolEvidence?: {
    readonly maxCorrectionAttempts: number;
    readonly maxCorrectionAttemptsExplicit: boolean;
    readonly delegationSpec?: DelegationContractSpec;
    readonly unsafeBenchmarkMode?: boolean;
    readonly verificationContract?: WorkflowVerificationContract;
    readonly completionContract?: ImplementationCompletionContract;
    readonly executionEnvelope?: ExecutionEnvelope;
  };
  readonly trace?: ChatExecuteParams["trace"];
  readonly defaultRunClass?: RuntimeRunClass;
  readonly runtimeContractFlags: RuntimeContractFlags;
  // --- Mutable accumulator state ---
  history: readonly LLMMessage[];
  messages: LLMMessage[];
  reconciliationMessages: LLMMessage[];
  messageSections: PromptBudgetSection[];
  cumulativeUsage: LLMUsage;
  callUsage: ChatCallUsageRecord[];
  callIndex: number;
  modelCalls: number;
  allToolCalls: ToolCallRecord[];
  failedToolCalls: number;
  activeRecoveryHintKeys: string[];
  activeRuntimeReminderKeys: Set<string>;
  providerEvidence: LLMProviderEvidence | undefined;
  usedFallback: boolean;
  providerName: string;
  responseModel?: string;
  configuredModel?: string;
  resolvedModel?: string;
  response?: LLMResponse;
  finalContent: string;
  lastModelStreamedContent: string;
  compacted: boolean;
  compactedArtifactContext?: ArtifactCompactionState;
  stopReason: LLMPipelineStopReason;
  completionState: WorkflowCompletionState;
  /** Telemetry-only runtime contract snapshot carried for traces and results. */
  runtimeContractSnapshot: RuntimeContractSnapshot;
  toolProtocolState: ToolProtocolState;
  stopReasonDetail?: string;
  validationCode?: DelegationOutputValidationCode;
  activeRoutedToolNames: readonly string[];
  transientRoutedToolNames: readonly string[] | undefined;
  discoveredToolNames: readonly string[];
  routedToolsExpanded: boolean;
  routedToolMisses: number;
  plannerSummaryState: FullPlannerSummaryState;
  /** Advisory task metadata observed from task tools. */
  requestTaskState: RequestTaskProgressState;
  /** Advisory milestone metadata derived from observed task tools. */
  completedRequestMilestoneIds: readonly string[];
  economicsState: RuntimeEconomicsState;
  continuationState: TurnContinuationState;
  /**
   * Per-iteration compaction state composed across snip, microcompact,
   * and autocompact layers. Replaced on every provider call in
   * `executeToolCallLoop` via `applyPerIterationCompaction`. Persisted
   * across requests via the executor's session state map so cold-
   * session snip and microcompact layers can observe the inter-request
   * idle gap. See `runtime/src/llm/compact/index.ts`.
   */
  perIterationCompaction: PerIterationCompactionState;
}

// ============================================================================
// ExecutionContext builder (extracted from initializeExecutionContext)
// ============================================================================

/** Parameters for building the default ExecutionContext object. */
interface BuildExecutionContextParams {
  readonly message: GatewayMessage;
  readonly messageText: string;
  readonly promptEnvelope: PromptEnvelopeV1;
  readonly sessionId: string;
  readonly structuredOutput?: ChatExecuteParams["structuredOutput"];
  readonly runtimeContext?: ChatExecuteParams["runtimeContext"];
  readonly turnExecutionContract: TurnExecutionContract;
  readonly signal?: AbortSignal;
  readonly history: readonly LLMMessage[];
  readonly plannerDecision: PlannerDecision;
  readonly compacted: boolean;
  readonly toolHandler?: ToolHandler;
  readonly streamCallback?: StreamProgressCallback;
  readonly toolRouting?: ChatExecuteParams["toolRouting"];
  readonly requiredToolEvidence?: ChatExecuteParams["requiredToolEvidence"];
  readonly trace?: ChatExecuteParams["trace"];
  readonly initialRoutedToolNames: readonly string[];
  readonly expandedRoutedToolNames: readonly string[];
}

/** Configuration values from ChatExecutor instance needed for context building. */
interface BuildExecutionContextConfig {
  readonly maxToolRounds: number;
  readonly toolBudgetPerRequest: number;
  readonly maxModelRecallsPerRequest: number;
  readonly maxFailureBudgetPerRequest: number;
  /** End-to-end request timeout in milliseconds. 0 = unlimited. */
  readonly requestTimeoutMs: number;
  readonly turnOutputTokenBudget: number | null;
  readonly providerName: string;
  readonly plannerEnabled: boolean;
  readonly defaultRunClass?: RuntimeRunClass;
  readonly economicsPolicy: RuntimeEconomicsPolicy;
  readonly runtimeContractFlags: RuntimeContractFlags;
}

/** Build the default ExecutionContext object with all mutable state initialized. */
export function buildDefaultExecutionContext(
  params: BuildExecutionContextParams,
  config: BuildExecutionContextConfig,
): ExecutionContext {
  const startTime = Date.now();
  const hasHistory = params.history.length > 0;
  const economicsState = createRuntimeEconomicsState();
  return {
    // --- Immutable request params ---
    message: params.message,
    messageText: params.messageText,
    baseSystemPrompt: params.promptEnvelope.baseSystemPrompt,
    promptEnvelope: params.promptEnvelope,
    sessionId: params.sessionId,
    structuredOutput: params.structuredOutput,
    runtimeWorkspaceRoot:
      params.turnExecutionContract.workspaceRoot ?? params.runtimeContext?.workspaceRoot,
    runtimeWorkflowStage: params.runtimeContext?.workflowStage,
    turnExecutionContract: params.turnExecutionContract,
    signal: params.signal,
    activeToolHandler: params.toolHandler,
    activeStreamCallback: params.streamCallback,
    effectiveMaxToolRounds: config.maxToolRounds,
    effectiveToolBudget: config.toolBudgetPerRequest,
    effectiveMaxModelRecalls: config.maxModelRecallsPerRequest,
    effectiveFailureBudget: config.maxFailureBudgetPerRequest,
    effectiveRequestTimeoutMs: config.requestTimeoutMs,
    turnOutputTokenBudget: config.turnOutputTokenBudget,
    startTime,
    requestDeadlineAt:
      config.requestTimeoutMs > 0
        ? startTime + config.requestTimeoutMs
        : Number.POSITIVE_INFINITY,
    initialRoutedToolNames: params.initialRoutedToolNames,
    expandedRoutedToolNames: params.expandedRoutedToolNames,
    defaultAdvertisedToolNames:
      params.toolRouting?.advertisedToolNames ?? params.initialRoutedToolNames,
    toolDiscoveryEnabled: params.toolRouting?.persistDiscovery === true,
    canExpandOnRoutingMiss: Boolean(
      params.toolRouting?.expandOnMiss &&
      params.expandedRoutedToolNames.length > 0,
    ),
    hasHistory,
    plannerDecision: params.plannerDecision,
    toolRouting: params.toolRouting,
    trace: params.trace,
    defaultRunClass: config.defaultRunClass,
    requiredToolEvidence: params.requiredToolEvidence
      ? {
        maxCorrectionAttempts: Math.max(
          0,
          Math.floor(params.requiredToolEvidence.maxCorrectionAttempts ?? 1),
        ),
        maxCorrectionAttemptsExplicit:
          params.requiredToolEvidence.maxCorrectionAttempts !== undefined,
        delegationSpec: params.requiredToolEvidence.delegationSpec,
        unsafeBenchmarkMode: params.requiredToolEvidence.unsafeBenchmarkMode,
        verificationContract: params.requiredToolEvidence.verificationContract,
        completionContract: params.requiredToolEvidence.completionContract,
        executionEnvelope: params.requiredToolEvidence.executionEnvelope,
      }
      : undefined,
    runtimeContractFlags: config.runtimeContractFlags,
    // --- Mutable accumulator state ---
    history: params.history,
    messages: [],
    reconciliationMessages: [],
    messageSections: [],
    cumulativeUsage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
    callUsage: [],
    callIndex: 0,
    modelCalls: 0,
    allToolCalls: [],
    failedToolCalls: 0,
    activeRecoveryHintKeys: [],
    activeRuntimeReminderKeys: new Set<string>(),
    providerEvidence: undefined,
    usedFallback: false,
    providerName: config.providerName,
    responseModel: undefined,
    configuredModel: undefined,
    resolvedModel: undefined,
    response: undefined,
    finalContent: "",
    lastModelStreamedContent: "",
    compacted: params.compacted,
    compactedArtifactContext: undefined,
    stopReason: "completed",
    completionState: "completed",
    runtimeContractSnapshot: createRuntimeContractSnapshot(
      config.runtimeContractFlags,
    ),
    toolProtocolState: createToolProtocolState(),
    stopReasonDetail: undefined,
    validationCode: undefined,
    activeRoutedToolNames: params.initialRoutedToolNames,
    transientRoutedToolNames: undefined,
    discoveredToolNames: [],
    routedToolsExpanded: false,
    routedToolMisses: 0,
    plannerSummaryState: {
      enabled: config.plannerEnabled,
      used: false,
      routeReason: params.plannerDecision.reason,
      complexityScore: params.plannerDecision.score,
      plannerCalls: 0,
      plannedSteps: 0,
      deterministicStepsExecuted: 0,
      estimatedRecallsAvoided: 0,
      diagnostics: [] as PlannerDiagnostic[],
    },
    requestTaskState: createRequestTaskProgressState(),
    completedRequestMilestoneIds: [],
    economicsState,
    continuationState: createTurnContinuationState(),
    perIterationCompaction: createPerIterationCompactionState(),
  };
}
