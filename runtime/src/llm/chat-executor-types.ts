/**
 * Type definitions and error classes for ChatExecutor.
 *
 * @module
 */

import type { GatewayMessage } from "../gateway/message.js";
import type {
  LLMMessage,
  LLMProviderEvidence,
  LLMCompactionDiagnostics,
  LLMProviderTraceEvent,
  LLMResponse,
  LLMUsage,
  LLMRequestMetrics,
  LLMStatefulDiagnostics,
  LLMStatefulFallbackReason,
  LLMStatefulResumeAnchor,
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
import type { DelegationDecision, DelegationDecisionConfig } from "./delegation-decision.js";
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
import type { ArtifactTaskContract } from "./chat-executor-artifact-task.js";
import type { ActiveTaskContext, TurnExecutionContract } from "./turn-execution-contract-types.js";
import type {
  DelegationBanditPolicyTuner,
  DelegationTrajectorySink,
} from "./delegation-learning.js";
import { RuntimeError, RuntimeErrorCodes } from "../types/errors.js";

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
}

export type ChatExecutionTraceEventType =
  | "completion_gate_checked"
  | "contract_guidance_resolved"
  | "context_injected"
  | "model_call_prepared"
  | "planner_path_finished"
  | "planner_pipeline_finished"
  | "planner_synthesis_fallback_applied"
  | "planner_pipeline_started"
  | "planner_plan_parsed"
  | "planner_refinement_requested"
  | "planner_step_state_changed"
  | "planner_verifier_retry_scheduled"
  | "planner_verifier_round_finished"
  | "recovery_hints_injected"
  | "route_expanded"
  | "tool_arguments_invalid"
  | "tool_loop_stuck_detected"
  | "tool_round_budget_finalization_finished"
  | "tool_round_budget_extension_evaluated"
  | "tool_round_budget_extended"
  | "tool_dispatch_finished"
  | "tool_dispatch_started"
  | "tool_rejected";

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
  readonly systemPrompt: string;
  readonly sessionId: string;
  /** Runtime-owned execution context resolved before model/planner execution. */
  readonly runtimeContext?: {
    /** Authoritative workspace root for planning/execution when known. */
    readonly workspaceRoot?: string;
    /** Typed active-task carryover used only when the current turn explicitly continues that task. */
    readonly activeTaskContext?: ActiveTaskContext;
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
  /** Per-call end-to-end timeout in milliseconds — overrides the constructor default. 0 = unlimited. */
  readonly requestTimeoutMs?: number;
  /** Per-call context injection controls for bounded/system-owned executions. */
  readonly contextInjection?: {
    /** When false, skip skill/system context injection for this call. */
    readonly skills?: boolean;
    /** When false, skip memory/learning/progress retrieval for this call. */
    readonly memory?: boolean;
  };
  /** Optional per-turn tool-routing subset and expansion policy. */
  readonly toolRouting?: {
    /** Initial routed subset for this turn. */
    readonly routedToolNames?: readonly string[];
    /** One-turn expanded subset used on suspected routing misses. */
    readonly expandedToolNames?: readonly string[];
    /** Enable one-turn expansion retry on routed-tool misses. */
    readonly expandOnMiss?: boolean;
  };
  /** Require at least one successful tool call before accepting a final answer. */
  readonly requiredToolEvidence?: {
    /** Bounded number of correction recalls before failing the turn. Default: 1. */
    readonly maxCorrectionAttempts?: number;
    /** Optional delegated output contract used for phase-specific validation. */
    readonly delegationSpec?: DelegationContractSpec;
    /** When true, delegated contract enforcement is disabled for benchmark-only runs. */
    readonly unsafeBenchmarkMode?: boolean;
    /** Optional workflow-owned verification contract for implementation completion. */
    readonly verificationContract?: WorkflowVerificationContract;
    /** Optional completion contract for implementation-class tasks. */
    readonly completionContract?: ImplementationCompletionContract;
    /** Optional direct-owner artifact update contract for explicit artifact tasks. */
    readonly artifactTaskContract?: ArtifactTaskContract;
    /** Optional execution envelope used to bound top-level tool access for explicit artifact tasks. */
    readonly executionEnvelope?: ExecutionEnvelope;
  };
  /** Optional provider-managed continuation hints restored by the runtime. */
  readonly stateful?: {
    readonly resumeAnchor?: LLMStatefulResumeAnchor;
    readonly historyCompacted?: boolean;
    readonly artifactContext?: ArtifactCompactionState;
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
    | "planner"
    | "planner_verifier"
    | "planner_synthesis"
    | "tool_followup"
    | "evaluator"
    | "evaluator_retry";
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
  /** Stateful continuation diagnostics for this provider call (when supported). */
  readonly statefulDiagnostics?: LLMStatefulDiagnostics;
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
  /** Sub-agent delegation utility decision for planner-emitted subagent tasks. */
  readonly delegationDecision?: DelegationDecision;
  /** Sub-agent verification/critic pass summary. */
  readonly subagentVerification?: {
    readonly enabled: boolean;
    readonly performed: boolean;
    readonly rounds: number;
    readonly overall: "pass" | "retry" | "fail" | "skipped";
    readonly confidence: number;
    readonly unresolvedItems: readonly string[];
  };
  /** Online policy tuning diagnostics for delegation arm selection. */
  readonly delegationPolicyTuning?: {
    readonly enabled: boolean;
    readonly contextClusterId?: string;
    readonly selectedArmId?: string;
    readonly selectedArmReason?: string;
    readonly tunedThreshold?: number;
    readonly exploration: boolean;
    readonly finalReward?: number;
    readonly usefulDelegation?: boolean;
    readonly usefulDelegationScore?: number;
    readonly rewardProxyVersion?: string;
  };
}

export interface PlannerDiagnostic {
  readonly category: "parse" | "validation" | "policy" | "runtime";
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

/** Aggregated stateful continuation counters for one execute() invocation. */
export interface ChatStatefulSummary {
  readonly enabled: boolean;
  readonly attemptedCalls: number;
  readonly continuedCalls: number;
  readonly fallbackCalls: number;
  readonly fallbackReasons: Readonly<Record<LLMStatefulFallbackReason, number>>;
}

/** Aggregated tool-routing diagnostics for one execute() invocation. */
export interface ChatToolRoutingSummary {
  readonly enabled: boolean;
  readonly initialToolCount: number;
  readonly finalToolCount: number;
  readonly routeMisses: number;
  readonly expanded: boolean;
}

/** Result returned from ChatExecutor.execute(). */
export interface ChatExecutorResult {
  readonly content: string;
  readonly provider: string;
  /** Actual model identifier returned by the provider for the final response. */
  readonly model?: string;
  readonly usedFallback: boolean;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly providerEvidence?: LLMProviderEvidence;
  readonly tokenUsage: LLMUsage;
  /** Per-call token and prompt-shape attribution for this execution. */
  readonly callUsage: readonly ChatCallUsageRecord[];
  readonly durationMs: number;
  /** True if conversation history was compacted during this execution. */
  readonly compacted: boolean;
  /** Aggregated stateful continuation diagnostics for this execution. */
  readonly statefulSummary?: ChatStatefulSummary;
  /** Per-turn dynamic tool-routing diagnostics for this execution. */
  readonly toolRoutingSummary?: ChatToolRoutingSummary;
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
  /** Single preflight execution contract that governed this turn. */
  readonly turnExecutionContract: TurnExecutionContract;
  /** Typed task carryover emitted for the next compatible turn, when applicable. */
  readonly activeTaskContext?: ActiveTaskContext;
  /** Optional detail for non-completed stop reasons. */
  readonly stopReasonDetail?: string;
  /** Optional delegated-output validation code associated with a validation_error stop. */
  readonly validationCode?: DelegationOutputValidationCode;
  /** Result of response evaluation, if evaluator is configured. */
  readonly evaluation?: EvaluationResult;
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

export interface ToolFailureCircuitBreakerConfig {
  /** Enable per-session tool failure circuit breaker (default: true). */
  readonly enabled?: boolean;
  /** Repeated semantic failure threshold before opening breaker (default: 5). */
  readonly threshold?: number;
  /** Rolling window for counting repeated failures in ms (default: 300_000). */
  readonly windowMs?: number;
  /** Breaker open cooldown in ms (default: 120_000). */
  readonly cooldownMs?: number;
}

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
   * Cut 5.4: queryTracking — chainId + depth pair propagated through
   * the sub-agent nesting. Callers plumb the parent tracking in when
   * spawning a child chat-executor; the runtime enforces a hard depth
   * cap to prevent runaway recursive delegation and surfaces the
   * chain on every hook context.
   */
  readonly queryTracking?: import("./query-tracking.js").QueryTracking;
  /**
   * Cut 5.3: tool result budget config. When set, oversized tool
   * results are persisted to disk and replaced in the message history
   * with a `<persisted-output>` placeholder pointing at the file
   * path. Per-session ContentReplacementState is owned by the
   * executor; callers only need to supply the budget config.
   */
  readonly toolResultBudget?: import("./tool-result-budget.js").ToolBudgetConfig;
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
  /** Optional response evaluator/critic configuration. */
  readonly evaluator?: EvaluatorConfig;
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
  /** Delegation utility scoring controls for planner-emitted subagent tasks. */
  readonly delegationDecision?: DelegationDecisionConfig;
  /** Optional live resolver for delegation threshold overrides. */
  readonly resolveDelegationScoreThreshold?: () => number | undefined;
  /** Optional verifier/critic loop for planner-emitted subagent outputs. */
  readonly subagentVerifier?: {
    /** Enable verifier flow for planner-emitted subagent steps. */
    readonly enabled?: boolean;
    /** Enforce verification whenever subagent steps execute. */
    readonly force?: boolean;
    /** Minimum confidence required to accept child outputs. */
    readonly minConfidence?: number;
    /** Max verification rounds (initial verification included). */
    readonly maxRounds?: number;
  };
  /** Optional delegation learning hooks (trajectory sink + online bandit tuner). */
  readonly delegationLearning?: {
    readonly trajectorySink?: DelegationTrajectorySink;
    readonly banditTuner?: DelegationBanditPolicyTuner;
    readonly defaultStrategyArmId?: string;
  };
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
  /** Session-level breaker for repeated failing tool patterns. */
  readonly toolFailureCircuitBreaker?: ToolFailureCircuitBreakerConfig;
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
}

// ============================================================================
// Evaluator types
// ============================================================================

/** Configuration for optional response evaluation/critic. */
export interface EvaluatorConfig {
  readonly rubric?: string;
  /** Minimum score (0.0–1.0) to accept the response. Default: 0.7. */
  readonly minScore?: number;
  /** Maximum retry attempts when score is below threshold. Default: 1. */
  readonly maxRetries?: number;
}

/** Result of a response evaluation. */
export interface EvaluationResult {
  readonly score: number;
  readonly feedback: string;
  readonly passed: boolean;
  readonly retryCount: number;
}

// ============================================================================
// Internal types (used by sibling chat-executor-*.ts files)
// ============================================================================

export interface CooldownEntry {
  availableAt: number;
  failures: number;
}

export interface SessionToolFailurePattern {
  count: number;
  lastAt: number;
}

export interface SessionToolFailureCircuitState {
  openUntil: number;
  reason?: string;
  patterns: Map<string, SessionToolFailurePattern>;
}

export interface FallbackResult {
  response: LLMResponse;
  providerName: string;
  usedFallback: boolean;
  beforeBudget: ChatPromptShape;
  afterBudget: ChatPromptShape;
  budgetDiagnostics: PromptBudgetDiagnostics;
  durationMs: number;
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

export type PlannerStepType = "deterministic_tool" | "subagent_task" | "synthesis";

export type PlannerPlanArtifactIntent =
  | "none"
  | "grounded_plan_generation"
  | "edit_artifact"
  | "implement_from_artifact";

export type SubagentVerifierStepVerdict = "pass" | "retry" | "fail";

export interface SubagentVerifierStepAssessment {
  readonly name: string;
  readonly verdict: SubagentVerifierStepVerdict;
  readonly confidence: number;
  readonly retryable: boolean;
  readonly issues: readonly string[];
  readonly summary: string;
}

export interface SubagentVerifierDecision {
  readonly overall: "pass" | "retry" | "fail";
  readonly confidence: number;
  readonly unresolvedItems: readonly string[];
  readonly steps: readonly SubagentVerifierStepAssessment[];
  readonly source: "deterministic" | "model" | "merged";
}

export interface ResolvedSubagentVerifierConfig {
  readonly enabled: boolean;
  readonly force: boolean;
  readonly minConfidence: number;
  readonly maxRounds: number;
}

export interface MutablePlannerVerificationSummary {
  enabled: boolean;
  performed: boolean;
  rounds: number;
  overall: "pass" | "retry" | "fail" | "skipped";
  confidence: number;
  unresolvedItems: string[];
}

export interface MutablePlannerSummaryState {
  deterministicStepsExecuted: number;
  diagnostics: PlannerDiagnostic[];
  subagentVerification: MutablePlannerVerificationSummary;
  /**
   * Model-emitted plan-artifact intent classification, propagated from
   * `PlannerPlan.planIntent`. Replaces the regex-based pre-call classifier
   * that used to live in `chat-executor-planner.ts`. Downstream contract
   * flow and turn-execution code reads this instead of re-running a regex
   * against the user message.
   */
  plannerPlanIntent?: PlannerPlanArtifactIntent;
}

/** Full planner summary state — extends the subset used by executePlannerPipelineWithVerifier. */
export interface FullPlannerSummaryState extends MutablePlannerSummaryState {
  enabled: boolean;
  used: boolean;
  routeReason: string;
  complexityScore: number;
  plannerCalls: number;
  plannedSteps: number;
  estimatedRecallsAvoided: number;
  delegationDecision: DelegationDecision | undefined;
  delegationPolicyTuning: {
    enabled: boolean;
    contextClusterId: string | undefined;
    selectedArmId: string | undefined;
    selectedArmReason: string | undefined;
    tunedThreshold: number | undefined;
    exploration: boolean;
    finalReward: number | undefined;
    usefulDelegation: boolean | undefined;
    usefulDelegationScore: number | undefined;
    rewardProxyVersion: string | undefined;
  };
}

/** Loop-local mutable state shared across tool calls within a single round. */
export interface ToolLoopState {
  remainingToolImageChars: number;
  activeRoutedToolSet: Set<string> | null;
  expandAfterRound: boolean;
  lastFailKey: string;
  consecutiveFailCount: number;
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
  readonly systemPrompt: string;
  readonly sessionId: string;
  readonly runtimeWorkspaceRoot?: string;
  readonly turnExecutionContract: TurnExecutionContract;
  readonly signal?: AbortSignal;
  readonly activeToolHandler?: ToolHandler;
  readonly activeStreamCallback?: StreamProgressCallback;
  readonly effectiveMaxToolRounds: number;
  readonly effectiveToolBudget: number;
  readonly effectiveMaxModelRecalls: number;
  readonly effectiveFailureBudget: number;
  readonly effectiveRequestTimeoutMs: number;
  readonly startTime: number;
  readonly requestDeadlineAt: number;
  readonly initialRoutedToolNames: readonly string[];
  readonly expandedRoutedToolNames: readonly string[];
  readonly canExpandOnRoutingMiss: boolean;
  readonly hasHistory: boolean;
  readonly plannerDecision: PlannerDecision;
  readonly baseDelegationThreshold: number;
  readonly toolRouting?: ChatExecuteParams["toolRouting"];
  readonly stateful?: ChatExecuteParams["stateful"];
  readonly requiredToolEvidence?: {
    readonly maxCorrectionAttempts: number;
    readonly delegationSpec?: DelegationContractSpec;
    readonly unsafeBenchmarkMode?: boolean;
    readonly verificationContract?: WorkflowVerificationContract;
    readonly completionContract?: ImplementationCompletionContract;
    readonly artifactTaskContract?: ArtifactTaskContract;
    readonly executionEnvelope?: ExecutionEnvelope;
  };
  readonly trace?: ChatExecuteParams["trace"];
  readonly defaultRunClass?: RuntimeRunClass;

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
  providerEvidence: LLMProviderEvidence | undefined;
  usedFallback: boolean;
  providerName: string;
  responseModel?: string;
  response?: LLMResponse;
  evaluation?: EvaluationResult;
  finalContent: string;
  compacted: boolean;
  compactedArtifactContext?: ArtifactCompactionState;
  stopReason: LLMPipelineStopReason;
  completionState: WorkflowCompletionState;
  stopReasonDetail?: string;
  validationCode?: DelegationOutputValidationCode;
  activeRoutedToolNames: readonly string[];
  transientRoutedToolNames: readonly string[] | undefined;
  routedToolsExpanded: boolean;
  routedToolMisses: number;
  plannerSummaryState: FullPlannerSummaryState;
  completedRequestMilestoneIds: readonly string[];
  economicsState: RuntimeEconomicsState;
}

// ============================================================================
// ExecutionContext builder (extracted from initializeExecutionContext)
// ============================================================================

/** Parameters for building the default ExecutionContext object. */
export interface BuildExecutionContextParams {
  readonly message: GatewayMessage;
  readonly messageText: string;
  readonly systemPrompt: string;
  readonly sessionId: string;
  readonly runtimeContext?: ChatExecuteParams["runtimeContext"];
  readonly turnExecutionContract: TurnExecutionContract;
  readonly signal?: AbortSignal;
  readonly history: readonly LLMMessage[];
  readonly plannerDecision: PlannerDecision;
  readonly compacted: boolean;
  readonly toolHandler?: ToolHandler;
  readonly streamCallback?: StreamProgressCallback;
  readonly toolRouting?: ChatExecuteParams["toolRouting"];
  readonly stateful?: ChatExecuteParams["stateful"];
  readonly requiredToolEvidence?: ChatExecuteParams["requiredToolEvidence"];
  readonly trace?: ChatExecuteParams["trace"];
  readonly initialRoutedToolNames: readonly string[];
  readonly expandedRoutedToolNames: readonly string[];
  readonly baseDelegationThreshold: number;
}

/** Configuration values from ChatExecutor instance needed for context building. */
export interface BuildExecutionContextConfig {
  readonly maxToolRounds: number;
  readonly toolBudgetPerRequest: number;
  readonly maxModelRecallsPerRequest: number;
  readonly maxFailureBudgetPerRequest: number;
  /** End-to-end request timeout in milliseconds. 0 = unlimited. */
  readonly requestTimeoutMs: number;
  readonly providerName: string;
  readonly plannerEnabled: boolean;
  readonly subagentVerifierEnabled: boolean;
  readonly delegationBanditTunerEnabled: boolean;
  readonly delegationScoreThreshold: number;
  readonly defaultRunClass?: RuntimeRunClass;
  readonly economicsPolicy: RuntimeEconomicsPolicy;
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
    systemPrompt: params.systemPrompt,
    sessionId: params.sessionId,
    runtimeWorkspaceRoot:
      params.turnExecutionContract.workspaceRoot ?? params.runtimeContext?.workspaceRoot,
    turnExecutionContract: params.turnExecutionContract,
    signal: params.signal,
    activeToolHandler: params.toolHandler,
    activeStreamCallback: params.streamCallback,
    effectiveMaxToolRounds: config.maxToolRounds,
    effectiveToolBudget: config.toolBudgetPerRequest,
    effectiveMaxModelRecalls: config.maxModelRecallsPerRequest,
    effectiveFailureBudget: config.maxFailureBudgetPerRequest,
    effectiveRequestTimeoutMs: config.requestTimeoutMs,
    startTime,
    requestDeadlineAt:
      config.requestTimeoutMs > 0
        ? startTime + config.requestTimeoutMs
        : Number.POSITIVE_INFINITY,
    initialRoutedToolNames: params.initialRoutedToolNames,
    expandedRoutedToolNames: params.expandedRoutedToolNames,
    canExpandOnRoutingMiss: Boolean(
      params.toolRouting?.expandOnMiss &&
      params.expandedRoutedToolNames.length > 0,
    ),
    hasHistory,
    plannerDecision: params.plannerDecision,
    baseDelegationThreshold: params.baseDelegationThreshold,
    toolRouting: params.toolRouting,
    stateful: params.stateful,
    trace: params.trace,
    defaultRunClass: config.defaultRunClass,
    requiredToolEvidence: params.requiredToolEvidence
      ? {
        maxCorrectionAttempts: Math.max(
          0,
          Math.floor(params.requiredToolEvidence.maxCorrectionAttempts ?? 1),
        ),
        delegationSpec: params.requiredToolEvidence.delegationSpec,
        unsafeBenchmarkMode: params.requiredToolEvidence.unsafeBenchmarkMode,
        verificationContract: params.requiredToolEvidence.verificationContract,
        completionContract: params.requiredToolEvidence.completionContract,
        artifactTaskContract: params.requiredToolEvidence.artifactTaskContract,
        executionEnvelope: params.requiredToolEvidence.executionEnvelope,
      }
      : undefined,

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
    providerEvidence: undefined,
    usedFallback: false,
    providerName: config.providerName,
    responseModel: undefined,
    response: undefined,
    evaluation: undefined,
    finalContent: "",
    compacted: params.compacted,
    compactedArtifactContext: params.stateful?.artifactContext,
    stopReason: "completed",
    completionState: "completed",
    stopReasonDetail: undefined,
    validationCode: undefined,
    activeRoutedToolNames: params.initialRoutedToolNames,
    transientRoutedToolNames: undefined,
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
      delegationDecision: undefined as DelegationDecision | undefined,
      subagentVerification: {
        enabled: config.subagentVerifierEnabled,
        performed: false,
        rounds: 0,
        overall: "skipped" as "pass" | "retry" | "fail" | "skipped",
        confidence: 1,
        unresolvedItems: [] as string[],
      },
      delegationPolicyTuning: {
        enabled: config.delegationBanditTunerEnabled,
        contextClusterId: undefined as string | undefined,
        selectedArmId: undefined as string | undefined,
        selectedArmReason: undefined as string | undefined,
        tunedThreshold: undefined as number | undefined,
        exploration: false,
        finalReward: undefined as number | undefined,
        usefulDelegation: undefined as boolean | undefined,
        usefulDelegationScore: undefined as number | undefined,
        rewardProxyVersion: undefined as string | undefined,
      },
    },
    completedRequestMilestoneIds: [],
    economicsState,
  };
}
