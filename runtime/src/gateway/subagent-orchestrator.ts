/**
 * SubAgentOrchestrator — planner DAG execution with sub-agent scheduling.
 *
 * Executes planner-emitted DAGs through the existing pipeline executor contract.
 * Supports deterministic tool nodes, subagent task nodes, and synthesis
 * handoff nodes while preserving PipelineResult semantics.
 *
 * @module
 */

import type { DeterministicPipelineExecutor } from "../llm/chat-executor-types.js";
import type {
  Pipeline,
  PipelineExecutionOptions,
  PipelinePlannerDeterministicStep,
  PipelinePlannerStep,
  PipelinePlannerSubagentStep,
  PipelineResult,
  PipelineStep,
} from "../workflow/pipeline.js";
import { canonicalizePipelinePlannerExecutionContexts } from "../workflow/migrations.js";
import type {
  SubAgentConfig,
  SubAgentResult,
} from "./sub-agent.js";
import type { HostToolingProfile } from "./host-tooling.js";
import {
  type PromptBudgetConfig,
} from "../llm/prompt-budget.js";
import type {
  LLMProviderExecutionProfile,
  LLMUsage,
} from "../llm/types.js";
import {
  DEFAULT_SUBAGENT_VERIFIER_MAX_ROUNDS,
} from "../llm/chat-executor-constants.js";
import {
  hasRuntimeLimit,
  normalizeRuntimeLimit,
} from "../llm/runtime-limit-policy.js";
import type {
  SubAgentLifecycleEmitter,
} from "./delegation-runtime.js";
import {
  assessDelegationScope,
} from "./delegation-scope.js";
import { sleep } from "../utils/async.js";
import {
  type DelegationOutputValidationCode,
  DELEGATION_OUTPUT_VALIDATION_CODES,
  resolveDelegatedChildToolScope,
  specRequiresSuccessfulToolEvidence,
} from "../utils/delegation-validation.js";
import { safeStringify } from "../tools/types.js";
import {
  computeDelegationFinalReward,
  deriveDelegationContextClusterId,
  type DelegationTrajectorySink,
} from "../llm/delegation-learning.js";
/* ---- Extracted sub-modules ---- */
import {
  type SubagentFailureOutcome,
  type SubagentContextDiagnostics,
  toPipelineStopReasonHint,
  summarizeSubagentFailureHistory,
  SUBAGENT_RETRY_POLICY,
  SUBAGENT_FAILURE_STOP_REASON,
} from "./subagent-orchestrator-types.js";
import {
  sanitizeExecutionPromptText,
  truncateText,
  buildRelevanceTerms,
  extractTerms,
  allocateContextGroupBudgets,
  resolveSubagentPromptBudgetCaps,
  curateHistorySection,
  curateMemorySection,
  curateToolOutputSection,
  curateDependencyArtifactSection,
  curateArtifactReferenceSection,
  collectDependencyArtifactCandidates,
  collectWorkspaceArtifactCandidates,
} from "./subagent-context-curation.js";
import {
  parseBudgetHintMs as parseBudgetHintMsFn,
  resolveSubagentToolBudgetPerRequest as resolveSubagentToolBudgetPerRequestFn,
  createRetryAttemptTracker,
  computeRetryDelayMs,
  classifySpawnFailure,
  classifySubagentFailureResult,
  isAnchoredDelegatedWorkingDirectory,
  resolvePlannerStepWorkingDirectory,
  buildEffectiveContextRequirements,
  hasHighRiskCapabilities,
  stepRequiresStructuredDelegatedFilesystemScope,
} from "./subagent-failure-classification.js";
import { preflightDelegatedLocalFileScope } from "./delegated-scope-preflight.js";
import {
  materializePlannerSynthesisResult,
  summarizeDependencyResultForPrompt,
  resolveParentSessionId,
} from "./subagent-dependency-summarization.js";
import {
  buildSubagentAcceptanceProbePlans,
  renderDeterministicCommandSummary,
  buildWorkspaceStateGuidanceLines,
} from "./subagent-workspace-probes.js";
import {
  buildDelegatedIncompleteReason,
  buildDelegatedRuntimeResult,
  mapPlannerVerifierSnapshotToRuntimeVerdict,
} from "./delegated-runtime-result.js";
import {
  summarizeParentRequestForSubagent,
  collectDependencyContexts,
  buildArtifactRelevanceTerms,
  buildDownstreamRequirementLines,
  buildWorkspaceVerificationContractLines,
  buildEffectiveDelegationSpec,
  buildEffectiveAcceptanceCriteria,
  buildRetryTaskPrompt as buildRetryTaskPromptFn,
  buildHostToolingPromptSection as buildHostToolingPromptSectionFn,
  resolveParentPolicyAllowlist as resolveParentPolicyAllowlistFn,
} from "./subagent-prompt-builder.js";
import {
  assessDelegationAdmission,
  buildDelegationStepAdmission,
  type DelegationAdmissionReason,
  type DelegationStepAdmission,
} from "./delegation-admission.js";
import {
  deriveDelegatedExecutionEnvelopeFromParent,
  type DelegatedExecutionEnvelopeDerivationResult,
} from "../utils/delegation-execution-context.js";
import { CanonicalExecutionKernel } from "../workflow/execution-kernel.js";
import {
  assessPlannerDependencySatisfaction,
  mapDeterministicPipelineResultToNodeOutcome,
} from "../workflow/execution-kernel-policy.js";
import type { ExecutionKernelNodeOutcome } from "../workflow/execution-kernel-types.js";

interface ExecuteSubagentAttemptParams {
  readonly subAgentManager: SubAgentExecutionManager;
  readonly step: PipelinePlannerSubagentStep;
  readonly pipeline: Pipeline;
  readonly parentSessionId: string;
  readonly parentRequest?: string;
  readonly lastValidationCode?: DelegationOutputValidationCode;
  readonly timeoutMs: number;
  readonly toolBudgetPerRequest: number;
  readonly taskPrompt: string;
  readonly diagnostics: SubagentContextDiagnostics;
  readonly tools: readonly string[];
  readonly stepAdmission?: DelegationStepAdmission;
  readonly delegatedWorkingDirectory?: PreparedPlannerDelegatedWorkingDirectory;
  readonly lifecycleEmitter: SubAgentLifecycleEmitter | null;
  readonly signal?: AbortSignal;
}

interface PreparedPlannerDelegatedWorkingDirectory {
  readonly path: string;
  readonly anchored: boolean;
  readonly source: "execution_envelope";
}

interface PreparedPlannerDelegatedStepContext {
  readonly step: PipelinePlannerSubagentStep;
  readonly derivation: DelegatedExecutionEnvelopeDerivationResult;
  readonly delegatedWorkingDirectory?: PreparedPlannerDelegatedWorkingDirectory;
}

type ExecuteSubagentAttemptOutcome =
  | {
    readonly status: "completed";
    readonly subagentSessionId: string;
    readonly output: string;
    readonly durationMs: number;
    readonly toolCalls: SubAgentResult["toolCalls"];
    readonly tokenUsage?: LLMUsage;
    readonly providerName?: string;
    readonly completionState?: SubAgentResult["completionState"];
    readonly completionProgress?: SubAgentResult["completionProgress"];
    readonly verifierSnapshot?: SubAgentResult["verifierSnapshot"];
    readonly contractFingerprint?: SubAgentResult["contractFingerprint"];
    readonly stopReason?: SubAgentResult["stopReason"];
    readonly stopReasonDetail?: SubAgentResult["stopReasonDetail"];
    readonly validationCode?: SubAgentResult["validationCode"];
  }
  | {
    readonly status: "failed";
    readonly failure: SubagentFailureOutcome;
  };

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_MAX_PARALLEL_SUBTASKS = 4;
const DEFAULT_SUBAGENT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_SUBAGENT_DEPTH = 4;
const DEFAULT_MAX_SUBAGENT_FANOUT_PER_TURN = 8;
const DEFAULT_MAX_TOTAL_SUBAGENTS_PER_REQUEST = 32;
const DEFAULT_MAX_CUMULATIVE_TOOL_CALLS_PER_REQUEST_TREE = 256;
const DEFAULT_MAX_CUMULATIVE_TOKENS_PER_REQUEST_TREE = 0;
const DEFAULT_MIN_TOKENS_PER_PLANNED_SUBAGENT_STEP = 150_000;
const DEFAULT_PLANNED_SUBAGENT_TOKENS_PER_MS =
  DEFAULT_MIN_TOKENS_PER_PLANNED_SUBAGENT_STEP /
  DEFAULT_SUBAGENT_TIMEOUT_MS;
const DEFAULT_REQUEST_TREE_SUBAGENT_PASSES = Math.max(
  1,
  DEFAULT_SUBAGENT_VERIFIER_MAX_ROUNDS,
);
const DEFAULT_FALLBACK_BEHAVIOR = "fail_request" as const;
const HARD_PLANNER_ADMISSION_REASONS = new Set<DelegationAdmissionReason>([
  "shared_artifact_writer_inline",
  "fanout_exceeded",
  "depth_exceeded",
]);

function isPlannerChildDelegationToolName(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalized === "execute_with_agent" ||
    normalized.startsWith("subagent.") ||
    normalized.startsWith("agenc.subagent.");
}

function shouldRejectPlannedDelegationAtExecutionTime(
  reason: DelegationAdmissionReason,
): boolean {
  return HARD_PLANNER_ADMISSION_REASONS.has(reason);
}

function didSubagentReachCompletedState(result: SubAgentResult): boolean {
  return result.completionState === "completed";
}

interface SubAgentExecutionManager {
  spawn(config: SubAgentConfig): Promise<string>;
  getResult(sessionId: string): SubAgentResult | null;
  cancel(sessionId: string): boolean;
}

interface ResolvedChildPromptBudget {
  readonly promptBudget?: PromptBudgetConfig;
  readonly providerProfile?: LLMProviderExecutionProfile;
}

interface SubAgentOrchestratorConfig {
  readonly fallbackExecutor: DeterministicPipelineExecutor;
  readonly resolveSubAgentManager: () => SubAgentExecutionManager | null;
  readonly resolveLifecycleEmitter?: () => SubAgentLifecycleEmitter | null;
  readonly resolveTrajectorySink?: () => DelegationTrajectorySink | null;
  readonly resolveAvailableToolNames?: () => readonly string[] | null;
  readonly resolveHostToolingProfile?: () => HostToolingProfile | null;
  readonly resolveHostWorkspaceRoot?: () => string | null;
  readonly childPromptBudget?: PromptBudgetConfig;
  readonly resolveChildPromptBudget?: (params: {
    task: string;
    tools?: readonly string[];
    requiredCapabilities?: readonly string[];
  }) =>
    | Promise<ResolvedChildPromptBudget | undefined>
    | ResolvedChildPromptBudget
    | undefined;
  readonly allowParallelSubtasks?: boolean;
  readonly maxParallelSubtasks?: number;
  readonly pollIntervalMs?: number;
  readonly defaultSubagentTimeoutMs?: number;
  readonly maxDepth?: number;
  readonly maxFanoutPerTurn?: number;
  readonly maxTotalSubagentsPerRequest?: number;
  readonly maxCumulativeToolCallsPerRequestTree?: number;
  readonly maxCumulativeTokensPerRequestTree?: number;
  readonly maxCumulativeTokensPerRequestTreeExplicitlyConfigured?: boolean;
  readonly childToolAllowlistStrategy?: "inherit_intersection" | "explicit_only";
  readonly allowedParentTools?: readonly string[];
  readonly forbiddenParentTools?: readonly string[];
  readonly fallbackBehavior?: "continue_without_delegation" | "fail_request";
  readonly unsafeBenchmarkMode?: boolean;
}

class RequestTreeBudgetTracker {
  private spawnedChildren = 0;
  private reservedSpawns = 0;
  private cumulativeToolCalls = 0;
  private cumulativeTokens = 0;
  private circuitBreakerReason: string | null = null;

  constructor(
    private readonly maxTotalSubagentsPerRequest: number,
    private readonly maxCumulativeToolCallsPerRequestTree: number,
    private readonly maxCumulativeTokensPerRequestTree: number,
  ) {}

  snapshot(): {
    readonly spawnedChildren: number;
    readonly reservedSpawns: number;
    readonly cumulativeToolCalls: number;
    readonly cumulativeTokens: number;
    readonly maxTotalSubagentsPerRequest: number;
    readonly maxCumulativeToolCallsPerRequestTree: number;
    readonly maxCumulativeTokensPerRequestTree: number;
  } {
    return {
      spawnedChildren: this.spawnedChildren,
      reservedSpawns: this.reservedSpawns,
      cumulativeToolCalls: this.cumulativeToolCalls,
      cumulativeTokens: this.cumulativeTokens,
      maxTotalSubagentsPerRequest: this.maxTotalSubagentsPerRequest,
      maxCumulativeToolCallsPerRequestTree:
        this.maxCumulativeToolCallsPerRequestTree,
      maxCumulativeTokensPerRequestTree:
        this.maxCumulativeTokensPerRequestTree,
    };
  }

  reserveSpawn(): RequestTreeBudgetBreach | null {
    if (this.circuitBreakerReason) {
      return {
        reason: this.circuitBreakerReason,
        limitKind: "spawns",
        attemptedSpawnCount: this.spawnedChildren + this.reservedSpawns + 1,
        state: this.snapshot(),
      };
    }
    const projected = this.spawnedChildren + this.reservedSpawns + 1;
    if (
      hasRuntimeLimit(this.maxTotalSubagentsPerRequest) &&
      projected > this.maxTotalSubagentsPerRequest
    ) {
      this.circuitBreakerReason =
        `max spawned children per request exceeded (${this.maxTotalSubagentsPerRequest})`;
      return {
        reason: this.circuitBreakerReason,
        limitKind: "spawns",
        attemptedSpawnCount: projected,
        state: this.snapshot(),
      };
    }
    this.reservedSpawns += 1;
    return null;
  }

  commitSpawnResult(spawned: boolean): void {
    this.reservedSpawns = Math.max(0, this.reservedSpawns - 1);
    if (spawned) this.spawnedChildren += 1;
  }

  recordUsage(
    toolCallCount: number,
    tokenCount: number,
  ): RequestTreeBudgetBreach | null {
    const normalizedToolCalls = Math.max(0, Math.floor(toolCallCount));
    const normalizedTokens = Math.max(0, Math.floor(tokenCount));
    if (this.circuitBreakerReason) {
      return {
        reason: this.circuitBreakerReason,
        limitKind: "tokens",
        stepToolCalls: normalizedToolCalls,
        stepTokens: normalizedTokens,
        state: this.snapshot(),
      };
    }
    this.cumulativeToolCalls += normalizedToolCalls;
    this.cumulativeTokens += normalizedTokens;
    if (
      this.maxCumulativeToolCallsPerRequestTree > 0 &&
      this.cumulativeToolCalls > this.maxCumulativeToolCallsPerRequestTree
    ) {
      this.circuitBreakerReason =
        `max cumulative child tool calls per request tree exceeded (${this.maxCumulativeToolCallsPerRequestTree})`;
      return {
        reason: this.circuitBreakerReason,
        limitKind: "tool_calls",
        stepToolCalls: normalizedToolCalls,
        stepTokens: normalizedTokens,
        state: this.snapshot(),
      };
    }
    if (
      this.maxCumulativeTokensPerRequestTree > 0 &&
      this.cumulativeTokens > this.maxCumulativeTokensPerRequestTree
    ) {
      this.circuitBreakerReason =
        `max cumulative child tokens per request tree exceeded (${this.maxCumulativeTokensPerRequestTree})`;
      return {
        reason: this.circuitBreakerReason,
        limitKind: "tokens",
        stepToolCalls: normalizedToolCalls,
        stepTokens: normalizedTokens,
        state: this.snapshot(),
      };
    }
    return null;
  }
}

interface RequestTreeBudgetSnapshot {
  readonly spawnedChildren: number;
  readonly reservedSpawns: number;
  readonly cumulativeToolCalls: number;
  readonly cumulativeTokens: number;
  readonly maxTotalSubagentsPerRequest: number;
  readonly maxCumulativeToolCallsPerRequestTree: number;
  readonly maxCumulativeTokensPerRequestTree: number;
}

type RequestTreeBudgetBreach =
  | {
    readonly reason: string;
    readonly limitKind: "spawns";
    readonly attemptedSpawnCount: number;
    readonly state: RequestTreeBudgetSnapshot;
  }
  | {
    readonly reason: string;
    readonly limitKind: "tool_calls" | "tokens";
    readonly stepToolCalls: number;
    readonly stepTokens: number;
    readonly state: RequestTreeBudgetSnapshot;
  };

export class SubAgentOrchestrator implements DeterministicPipelineExecutor {
  private readonly fallbackExecutor: DeterministicPipelineExecutor;
  private readonly kernel: CanonicalExecutionKernel;
  private readonly requestTreeBudgetTrackers = new Map<string, RequestTreeBudgetTracker>();
  private readonly resolveSubAgentManager: () => SubAgentExecutionManager | null;
  private readonly resolveLifecycleEmitter: () => SubAgentLifecycleEmitter | null;
  private readonly resolveTrajectorySink: () => DelegationTrajectorySink | null;
  private readonly resolveAvailableToolNames: () => readonly string[] | null;
  private readonly resolveHostToolingProfile: () => HostToolingProfile | null;
  private readonly resolveHostWorkspaceRoot: () => string | null;
  private readonly childPromptBudget?: PromptBudgetConfig;
  private readonly resolveChildPromptBudget?:
    SubAgentOrchestratorConfig["resolveChildPromptBudget"];
  private readonly allowParallelSubtasks: boolean;
  private readonly maxParallelSubtasks: number;
  private readonly pollIntervalMs: number;
  private readonly defaultSubagentTimeoutMs: number;
  private readonly maxDepth: number;
  private readonly maxFanoutPerTurn: number;
  private readonly maxTotalSubagentsPerRequest: number;
  private readonly maxCumulativeToolCallsPerRequestTree: number;
  private readonly maxCumulativeTokensPerRequestTree: number;
  private readonly maxCumulativeTokensPerRequestTreeExplicitlyConfigured: boolean;
  private readonly childToolAllowlistStrategy:
    | "inherit_intersection"
    | "explicit_only";
  private readonly allowedParentTools: ReadonlySet<string>;
  private readonly forbiddenParentTools: ReadonlySet<string>;
  private readonly fallbackBehavior:
    | "continue_without_delegation"
    | "fail_request";
  private readonly unsafeBenchmarkMode: boolean;

  constructor(config: SubAgentOrchestratorConfig) {
    this.fallbackExecutor = config.fallbackExecutor;
    this.resolveSubAgentManager = config.resolveSubAgentManager;
    this.resolveLifecycleEmitter =
      config.resolveLifecycleEmitter ?? (() => null);
    this.resolveTrajectorySink = config.resolveTrajectorySink ?? (() => null);
    this.resolveAvailableToolNames = config.resolveAvailableToolNames ?? (() => null);
    this.resolveHostToolingProfile =
      config.resolveHostToolingProfile ?? (() => null);
    this.resolveHostWorkspaceRoot =
      config.resolveHostWorkspaceRoot ?? (() => null);
    this.childPromptBudget = config.childPromptBudget;
    this.resolveChildPromptBudget = config.resolveChildPromptBudget;
    this.allowParallelSubtasks = config.allowParallelSubtasks !== false;
    this.maxParallelSubtasks = Math.max(
      1,
      Math.floor(config.maxParallelSubtasks ?? DEFAULT_MAX_PARALLEL_SUBTASKS),
    );
    this.pollIntervalMs = Math.max(
      25,
      Math.floor(config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
    );
    this.defaultSubagentTimeoutMs = normalizeRuntimeLimit(
      config.defaultSubagentTimeoutMs,
      DEFAULT_SUBAGENT_TIMEOUT_MS,
    );
    this.maxDepth = normalizeRuntimeLimit(
      config.maxDepth,
      DEFAULT_MAX_SUBAGENT_DEPTH,
    );
    this.maxFanoutPerTurn = normalizeRuntimeLimit(
      config.maxFanoutPerTurn,
      DEFAULT_MAX_SUBAGENT_FANOUT_PER_TURN,
    );
    this.maxTotalSubagentsPerRequest = normalizeRuntimeLimit(
      config.maxTotalSubagentsPerRequest,
      DEFAULT_MAX_TOTAL_SUBAGENTS_PER_REQUEST,
    );
    this.maxCumulativeToolCallsPerRequestTree = normalizeRuntimeLimit(
      config.maxCumulativeToolCallsPerRequestTree,
      DEFAULT_MAX_CUMULATIVE_TOOL_CALLS_PER_REQUEST_TREE,
    );
    this.maxCumulativeTokensPerRequestTree = normalizeRuntimeLimit(
      config.maxCumulativeTokensPerRequestTree,
      DEFAULT_MAX_CUMULATIVE_TOKENS_PER_REQUEST_TREE,
    );
    this.maxCumulativeTokensPerRequestTreeExplicitlyConfigured =
      config.maxCumulativeTokensPerRequestTreeExplicitlyConfigured === true;
    this.childToolAllowlistStrategy =
      config.childToolAllowlistStrategy ?? "inherit_intersection";
    this.allowedParentTools = new Set(
      (config.allowedParentTools ?? []).map((name) => name.trim()).filter((name) => name.length > 0),
    );
    this.forbiddenParentTools = new Set(
      (config.forbiddenParentTools ?? []).map((name) => name.trim()).filter((name) => name.length > 0),
    );
    this.fallbackBehavior = config.fallbackBehavior ?? DEFAULT_FALLBACK_BEHAVIOR;
    this.unsafeBenchmarkMode = config.unsafeBenchmarkMode === true;
    this.kernel = new CanonicalExecutionKernel({
      deterministicExecutor: this.fallbackExecutor,
      plannerDelegate: {
        executeNode: (step, pipeline, results, options, signal) =>
          this.executeNode(step, pipeline, results, options, signal),
        assessDependencySatisfaction: (step, result) =>
          assessPlannerDependencySatisfaction(step, result),
        isExclusiveNode: (step) => this.isExclusiveNode(step),
        resolveTraceToolName: (step) => this.resolvePipelineTraceToolName(step),
        buildTraceArgs: (step) => this.buildPipelineTraceArgs(step),
        onStepDependencyBlocked: ({ step, pipeline, blockedDependencies, error }) => {
          if (step.stepType !== "subagent_task") return;
          const parentSessionId = resolveParentSessionId(pipeline.id);
          this.resolveLifecycleEmitter()?.emit({
            type: "subagents.failed",
            timestamp: Date.now(),
            sessionId: parentSessionId,
            parentSessionId,
            toolName: "execute_with_agent",
            payload: {
              stepName: step.name,
              stage: "dependency_blocked",
              reason: error,
              unmetDependencies: blockedDependencies.map((dependency) => ({
                stepName: dependency.stepName,
                reason: dependency.reason,
                stopReasonHint: dependency.stopReasonHint,
              })),
            },
          });
        },
        validatePipeline: (pipeline) =>
          this.validateSubagentHardCaps(pipeline),
        resolveMaxParallelism: (pipeline) =>
          this.resolveMaxParallelism(pipeline.maxParallelism),
      },
    });
  }

  async execute(
    pipeline: Pipeline,
    startFrom = 0,
    options?: PipelineExecutionOptions,
  ): Promise<PipelineResult> {
    const normalizedPipeline = canonicalizePipelinePlannerExecutionContexts(
      pipeline,
    );
    const plannerSteps = normalizedPipeline.plannerSteps ?? [];
    const effectiveMaxCumulativeTokensPerRequestTree =
      this.resolveEffectiveMaxCumulativeTokensPerRequestTree(plannerSteps);
    const budgetTracker = new RequestTreeBudgetTracker(
      this.maxTotalSubagentsPerRequest,
      this.maxCumulativeToolCallsPerRequestTree,
      effectiveMaxCumulativeTokensPerRequestTree,
    );
    this.requestTreeBudgetTrackers.set(normalizedPipeline.id, budgetTracker);
    try {
      return await this.kernel.execute(normalizedPipeline, startFrom, options);
    } finally {
      this.requestTreeBudgetTrackers.delete(normalizedPipeline.id);
    }
  }

  private resolveMaxParallelism(pipelineMaxParallelism?: number): number {
    if (!this.allowParallelSubtasks) return 1;
    const pipelineCap =
      typeof pipelineMaxParallelism === "number" &&
      Number.isFinite(pipelineMaxParallelism)
        ? Math.max(1, Math.floor(pipelineMaxParallelism))
        : this.maxParallelSubtasks;
    return Math.max(1, Math.min(this.maxParallelSubtasks, pipelineCap));
  }

  private validateSubagentHardCaps(
    pipeline: Pick<Pipeline, "plannerSteps" | "edges" | "plannerContext">,
  ): string | null {
    const subagentSteps = (pipeline.plannerSteps ?? []).filter(
      (step): step is PipelinePlannerSubagentStep =>
        step.stepType === "subagent_task",
    );
    if (subagentSteps.length === 0) return null;
    if (
      hasRuntimeLimit(this.maxFanoutPerTurn) &&
      subagentSteps.length > this.maxFanoutPerTurn
    ) {
      return (
        `Planner emitted ${subagentSteps.length} subagent tasks but maxFanoutPerTurn ` +
        `is ${this.maxFanoutPerTurn}`
      );
    }

    const subagentNames = new Set(subagentSteps.map((step) => step.name));
    const dependencies = new Map<string, Set<string>>();
    for (const step of subagentSteps) {
      const fromDependsOn = (step.dependsOn ?? []).filter((dep) =>
        subagentNames.has(dep),
      );
      dependencies.set(step.name, new Set(fromDependsOn));
    }
    for (const edge of pipeline.edges ?? []) {
      if (!subagentNames.has(edge.from) || !subagentNames.has(edge.to)) continue;
      dependencies.get(edge.to)?.add(edge.from);
    }

    const visiting = new Set<string>();
    const memo = new Map<string, number>();
    const visit = (node: string): number => {
      if (memo.has(node)) return memo.get(node)!;
      if (visiting.has(node)) return Number.POSITIVE_INFINITY;
      visiting.add(node);
      let maxDepth = 1;
      for (const dep of dependencies.get(node) ?? []) {
        const depDepth = visit(dep);
        if (!Number.isFinite(depDepth)) {
          visiting.delete(node);
          return Number.POSITIVE_INFINITY;
        }
        maxDepth = Math.max(maxDepth, depDepth + 1);
      }
      visiting.delete(node);
      memo.set(node, maxDepth);
      return maxDepth;
    };

    let observedDepth = 1;
    for (const step of subagentSteps) {
      observedDepth = Math.max(observedDepth, visit(step.name));
      if (!Number.isFinite(observedDepth)) {
        return "Planner subagent dependency graph contains a cycle";
      }
    }
    return null;
  }

  private isExclusiveNode(step: PipelinePlannerStep): boolean {
    if (!this.allowParallelSubtasks) return true;
    if (step.stepType === "subagent_task") {
      return !step.canRunParallel;
    }
    return false;
  }

  private resolvePipelineTraceToolName(
    step: PipelinePlannerStep,
  ): string | undefined {
    if (step.stepType === "subagent_task") {
      return "execute_with_agent";
    }
    return undefined;
  }

  private buildPipelineTraceArgs(
    step: PipelinePlannerStep,
  ): Record<string, unknown> | undefined {
    if (step.stepType !== "subagent_task") {
      return undefined;
    }
    const effectiveContextRequirements = buildEffectiveContextRequirements(
      step,
    );
    return {
      objective: step.objective,
      inputContract: step.inputContract,
      acceptanceCriteria: [...step.acceptanceCriteria],
      requiredToolCapabilities: [...step.requiredToolCapabilities],
      contextRequirements: [...effectiveContextRequirements],
      ...(step.executionContext ? { executionContext: step.executionContext } : {}),
      maxBudgetHint: step.maxBudgetHint,
      canRunParallel: step.canRunParallel,
    };
  }

  private preparePlannerDelegatedStepContext(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
  ): PreparedPlannerDelegatedStepContext {
    const parentWorkspaceRoot =
      pipeline.plannerContext?.workspaceRoot ?? this.resolveHostWorkspaceRoot();
    const derivation = deriveDelegatedExecutionEnvelopeFromParent({
      parentWorkspaceRoot,
      requestedExecutionContext: step.executionContext,
      requiresStructuredExecutionContext:
        stepRequiresStructuredDelegatedFilesystemScope(step),
      source: "internal_planner_path",
    });
    const effectiveStep = {
      ...step,
      contextRequirements: buildEffectiveContextRequirements(step),
      executionContext: derivation.ok ? derivation.executionContext : undefined,
    } satisfies PipelinePlannerSubagentStep;
    const delegatedWorkingDirectory =
      derivation.ok && derivation.workingDirectory
        ? {
            path: derivation.workingDirectory,
            anchored: isAnchoredDelegatedWorkingDirectory(
              derivation.workingDirectory,
            ),
            source: "execution_envelope" as const,
          }
        : undefined;
    return {
      step: effectiveStep,
      derivation,
      delegatedWorkingDirectory,
    };
  }

  private async executeNode(
    step: PipelinePlannerStep,
    pipeline: Pipeline,
    results: Record<string, string>,
    options?: PipelineExecutionOptions,
    signal?: AbortSignal,
  ): Promise<ExecutionKernelNodeOutcome> {
    const budgetTracker = this.requestTreeBudgetTrackers.get(pipeline.id);
    if (!budgetTracker) {
      return {
        status: "failed",
        error: `Execution budget tracker missing for planner pipeline "${pipeline.id}"`,
        stopReasonHint: "validation_error",
      };
    }
    if (signal?.aborted) {
      return { status: "failed", error: "Step cancelled (sibling failure)", stopReasonHint: "cancelled" };
    }
    if (step.stepType === "deterministic_tool") {
      return this.executeDeterministicStep(step, pipeline, results, options);
    }
    if (step.stepType === "subagent_task") {
      return this.executeSubagentStep(step, pipeline, results, budgetTracker, signal);
    }
    // Synthesis nodes materialize explicit handoff artifacts for downstream
    // child phases instead of relying on transcript-only context.
    return {
      status: "completed",
      result: materializePlannerSynthesisResult(step, results),
    };
  }

  private async executeDeterministicStep(
    step: PipelinePlannerDeterministicStep,
    pipeline: Pipeline,
    results: Record<string, string>,
    options?: PipelineExecutionOptions,
  ): Promise<ExecutionKernelNodeOutcome> {
    const singleStep: PipelineStep = {
      name: step.name,
      tool: step.tool,
      args: step.args,
      onError: step.onError,
      maxRetries: step.maxRetries,
    };
    const stepPipeline: Pipeline = {
      id: `${pipeline.id}:${step.name}`,
      createdAt: pipeline.createdAt,
      context: { results: { ...results } },
      steps: [singleStep],
    };
    const outcome = await this.fallbackExecutor.execute(
      stepPipeline,
      0,
      options,
    );
    return mapDeterministicPipelineResultToNodeOutcome(step.name, outcome);
  }

  private async executeSubagentStep(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
    results: Record<string, string>,
    budgetTracker: RequestTreeBudgetTracker,
    signal?: AbortSignal,
  ): Promise<ExecutionKernelNodeOutcome> {
    const subAgentManager = this.resolveSubAgentManager();
    if (!subAgentManager) {
      return {
        status: "failed",
        error:
          `Sub-agent manager unavailable for planner step "${step.name}"`,
        stopReasonHint: "tool_error",
      };
    }

    const parentSessionId = resolveParentSessionId(pipeline.id);
    const lifecycleEmitter = this.resolveLifecycleEmitter();
    lifecycleEmitter?.emit({
      type: "subagents.planned",
      timestamp: Date.now(),
      sessionId: parentSessionId,
      parentSessionId,
      toolName: "execute_with_agent",
      payload: {
        stepName: step.name,
        objective: step.objective,
      },
    });

    const plannerSteps = pipeline.plannerSteps ?? [];
    const subagentSteps = plannerSteps.filter(
      (plannerStep): plannerStep is PipelinePlannerSubagentStep =>
        plannerStep.stepType === "subagent_task",
    );
    const preparedSubagentSteps = subagentSteps.map((plannerStep) =>
      this.preparePlannerDelegatedStepContext(plannerStep, pipeline)
    );
    const preparedStepContext =
      preparedSubagentSteps.find((entry) => entry.step.name === step.name) ??
      this.preparePlannerDelegatedStepContext(step, pipeline);
    const preparedStep = preparedStepContext.step;
    const synthesisStepCount = plannerSteps.filter(
      (plannerStep) => plannerStep.stepType === "synthesis",
    ).length;
    const delegationAdmission = assessDelegationAdmission({
      messageText:
        pipeline.plannerContext?.parentRequest?.trim().length
          ? pipeline.plannerContext.parentRequest
          : preparedStep.objective,
      totalSteps: plannerSteps.length,
      synthesisSteps: synthesisStepCount,
      steps: preparedSubagentSteps.map((entry) => entry.step),
      edges: pipeline.edges ?? [],
      threshold: 0,
      maxFanoutPerTurn: this.maxFanoutPerTurn,
      maxDepth: this.maxDepth,
      explicitDelegationRequested: true,
    });
    const stepAdmission =
      delegationAdmission.stepAdmissions.find((entry) => entry.stepName === preparedStep.name) ??
      buildDelegationStepAdmission({
        analysis: delegationAdmission.economics.stepAnalyses.find((analysis) =>
          analysis.step.name === preparedStep.name
        )!,
        shape: delegationAdmission.shape,
      });

    if (
      !preparedStepContext.derivation.ok &&
      stepRequiresStructuredDelegatedFilesystemScope(step)
    ) {
      return {
        status: "failed",
        error:
          `Refusing delegated step "${preparedStep.name}" before child execution: ${preparedStepContext.derivation.error}`,
        stopReasonHint: "validation_error",
      };
    }
    if (
      !this.unsafeBenchmarkMode &&
      !delegationAdmission.allowed &&
      shouldRejectPlannedDelegationAtExecutionTime(delegationAdmission.reason)
    ) {
      lifecycleEmitter?.emit({
        type: "subagents.failed",
        timestamp: Date.now(),
        sessionId: parentSessionId,
        parentSessionId,
        toolName: "execute_with_agent",
        payload: {
          stepName: preparedStep.name,
          stage: "admission",
          reason: delegationAdmission.reason,
          diagnostics: delegationAdmission.diagnostics,
        },
      });
      return {
        status: "failed",
        error:
          `Refusing delegated step "${preparedStep.name}" because delegation admission rejected the plan: ${delegationAdmission.reason}`,
        stopReasonHint: "validation_error",
      };
    }

    const budgetHintTimeoutMs = parseBudgetHintMsFn(
      preparedStep.maxBudgetHint,
      this.defaultSubagentTimeoutMs,
    );
    const toolScope = this.deriveChildToolAllowlist(preparedStep, pipeline);
    if (toolScope.blockedReason) {
      lifecycleEmitter?.emit({
        type: "subagents.failed",
        timestamp: Date.now(),
        sessionId: parentSessionId,
        parentSessionId,
        toolName: "execute_with_agent",
        payload: {
          stepName: preparedStep.name,
          stage: "validation",
          reason: toolScope.blockedReason,
          removedLowSignalBrowserTools: toolScope.removedLowSignalBrowserTools,
          removedByPolicy: toolScope.removedByPolicy,
          removedAsDelegationTools: toolScope.removedAsDelegationTools,
          removedAsUnknownTools: toolScope.removedAsUnknownTools,
          semanticFallback: toolScope.semanticFallback,
        },
      });
      return {
        status: "failed",
        error: toolScope.blockedReason,
        stopReasonHint: "validation_error",
      };
    }
    if (toolScope.allowedTools.length === 0 && !toolScope.allowsToollessExecution) {
      const error =
        `No permitted child tools remain for step "${preparedStep.name}" after policy scoping`;
      lifecycleEmitter?.emit({
        type: "subagents.failed",
        timestamp: Date.now(),
        sessionId: parentSessionId,
        parentSessionId,
        toolName: "execute_with_agent",
        payload: {
          stepName: preparedStep.name,
          stage: "validation",
          reason: error,
          removedLowSignalBrowserTools: toolScope.removedLowSignalBrowserTools,
          removedByPolicy: toolScope.removedByPolicy,
          removedAsDelegationTools: toolScope.removedAsDelegationTools,
          removedAsUnknownTools: toolScope.removedAsUnknownTools,
          semanticFallback: toolScope.semanticFallback,
        },
      });
      return {
        status: "failed",
        error,
        stopReasonHint: "validation_error",
      };
    }
    const subagentTask = await this.buildSubagentTaskPrompt(
      preparedStep,
      pipeline,
      results,
      toolScope,
      stepAdmission,
    );
    const subagentStepCount = plannerSteps.filter(
      (plannerStep) => plannerStep.stepType === "subagent_task",
    ).length;
    const deterministicStepCount = plannerSteps.filter(
      (plannerStep) => plannerStep.stepType === "deterministic_tool",
    ).length;
    const stepComplexityScore = Math.min(
      10,
      Math.max(
        1,
        1 +
          preparedStep.acceptanceCriteria.length +
          preparedStep.requiredToolCapabilities.length +
          Math.min(
            3,
            preparedStep.contextRequirements.length,
          ),
      ),
    );
    const childContextClusterId = deriveDelegationContextClusterId({
      complexityScore: stepComplexityScore,
      subagentStepCount: Math.max(1, subagentStepCount),
      hasHistory: (pipeline.plannerContext?.history.length ?? 0) > 0,
      highRiskPlan: hasHighRiskCapabilities(
        preparedStep.requiredToolCapabilities,
      ),
    });
    const parentTurnId = `parent:${parentSessionId}:${pipeline.createdAt}`;
    const trajectoryTraceId = `trace:${parentSessionId}:${pipeline.createdAt}`;
    const retryAttempts = createRetryAttemptTracker();
    let attempt = 0;
    let lastFailure: SubagentFailureOutcome | null = null;
    let previousFailureMessage: string | undefined;
    const failureHistory: SubagentFailureOutcome[] = [];
    let taskPrompt = subagentTask.taskPrompt;

    while (true) {
      if (signal?.aborted) {
        return { status: "failed", error: "Step cancelled (sibling failure)", stopReasonHint: "cancelled" };
      }
      attempt += 1;
      const reservationBreach = budgetTracker.reserveSpawn();
      if (reservationBreach) {
        const breakerMessage =
          this.formatRequestTreeBudgetBreach(reservationBreach);
        lifecycleEmitter?.emit({
          type: "subagents.failed",
          timestamp: Date.now(),
          sessionId: parentSessionId,
          parentSessionId,
          toolName: "execute_with_agent",
          payload: this.buildRequestTreeBudgetBreachPayload({
            stepName: preparedStep.name,
            attempt,
            breach: reservationBreach,
          }),
        });
        return {
          status: "failed",
          error:
            `Sub-agent circuit breaker opened for step "${preparedStep.name}": ${breakerMessage}`,
          stopReasonHint: "budget_exceeded",
        };
      }
      let attemptOutcome: ExecuteSubagentAttemptOutcome =
        await this.executeSubagentAttempt({
        subAgentManager,
        step: preparedStep,
        pipeline,
        parentSessionId,
        parentRequest: pipeline.plannerContext?.parentRequest,
        lastValidationCode: lastFailure?.validationCode,
        timeoutMs: 0,
        toolBudgetPerRequest: resolveSubagentToolBudgetPerRequestFn({
          timeoutMs: budgetHintTimeoutMs,
          priorFailureClass: lastFailure?.failureClass,
          step: preparedStep,
        }),
        taskPrompt,
        diagnostics: subagentTask.diagnostics,
        tools: toolScope.allowedTools,
        stepAdmission,
        delegatedWorkingDirectory: preparedStepContext.delegatedWorkingDirectory,
        lifecycleEmitter,
        signal,
      });
      if (attemptOutcome.status === "completed") {
        const acceptanceProbeFailure =
          await this.runCompletedSubagentAcceptanceProbes({
            step: preparedStep,
            pipeline,
            results,
            parentSessionId,
            subagentSessionId: attemptOutcome.subagentSessionId,
            toolCalls: attemptOutcome.toolCalls,
            tokenUsage: attemptOutcome.tokenUsage,
            durationMs: attemptOutcome.durationMs,
            lifecycleEmitter,
          });
        if (acceptanceProbeFailure) {
          attemptOutcome = {
            status: "failed",
            failure: {
              ...acceptanceProbeFailure,
              message: `${acceptanceProbeFailure.message} (original output preserved for diagnostics)`,
              originalOutput: attemptOutcome.output,
            },
          };
        }
      }
      const spawnedChild =
        attemptOutcome.status === "completed"
          ? true
          : Boolean(attemptOutcome.failure.childSessionId);
      budgetTracker.commitSpawnResult(spawnedChild);
      if (attemptOutcome.status === "completed") {
        this.recordSubagentTrajectory({
          traceId: trajectoryTraceId,
          turnId:
            `child:${preparedStep.name}:${attempt}:${attemptOutcome.subagentSessionId}`,
          parentTurnId,
          parentSessionId,
          subagentSessionId: attemptOutcome.subagentSessionId,
          step: preparedStep,
          stepComplexityScore,
          contextClusterId: childContextClusterId,
          plannerStepCount: plannerSteps.length,
          subagentStepCount,
          deterministicStepCount,
          synthesisStepCount,
          dependencyDepth: Math.max(
            1,
            (preparedStep.dependsOn?.length ?? 0) + 1,
          ),
          fanout: Math.max(1, subagentStepCount),
          tools: toolScope.allowedTools,
          timeoutMs: 0,
          delegated: true,
          strategyArmId: "balanced",
          qualityProxy: 0.9,
          tokenCost: attemptOutcome.tokenUsage?.totalTokens ?? 0,
          latencyMs: attemptOutcome.durationMs,
          errorCount: 0,
          metadata: {
            success: true,
            attempt,
            pipelineId: pipeline.id,
            toolCalls: attemptOutcome.toolCalls.length,
            stepName: preparedStep.name,
            providerName: attemptOutcome.providerName ?? "unknown",
          },
        });
        const usageBreach = budgetTracker.recordUsage(
          attemptOutcome.toolCalls.length,
          attemptOutcome.tokenUsage?.totalTokens ?? 0,
        );
        if (usageBreach) {
          const breakerMessage = this.formatRequestTreeBudgetBreach(usageBreach);
          this.recordSubagentTrajectory({
            traceId: trajectoryTraceId,
            turnId:
              `child:${preparedStep.name}:${attempt}:${attemptOutcome.subagentSessionId}:budget`,
            parentTurnId,
            parentSessionId,
            subagentSessionId: attemptOutcome.subagentSessionId,
            step: preparedStep,
            stepComplexityScore,
            contextClusterId: childContextClusterId,
            plannerStepCount: plannerSteps.length,
            subagentStepCount,
            deterministicStepCount,
            synthesisStepCount,
            dependencyDepth: Math.max(
              1,
              (preparedStep.dependsOn?.length ?? 0) + 1,
            ),
            fanout: Math.max(1, subagentStepCount),
            tools: toolScope.allowedTools,
            timeoutMs: 0,
            delegated: true,
            strategyArmId: "balanced",
            qualityProxy: 0.2,
            tokenCost: attemptOutcome.tokenUsage?.totalTokens ?? 0,
            latencyMs: attemptOutcome.durationMs,
            errorCount: 1,
            errorClass: "budget_exceeded",
            metadata: {
              success: false,
              attempt,
              pipelineId: pipeline.id,
              stepName: preparedStep.name,
              stage: "circuit_breaker",
            },
          });
          lifecycleEmitter?.emit({
            type: "subagents.failed",
            timestamp: Date.now(),
            sessionId: parentSessionId,
            parentSessionId,
            subagentSessionId: attemptOutcome.subagentSessionId,
            toolName: "execute_with_agent",
            payload: this.buildRequestTreeBudgetBreachPayload({
              stepName: preparedStep.name,
              attempt,
              breach: usageBreach,
            }),
          });
          return {
            status: "failed",
            error:
              `Sub-agent circuit breaker opened for step "${preparedStep.name}": ${breakerMessage}`,
            stopReasonHint: "budget_exceeded",
          };
        }
        lifecycleEmitter?.emit({
          type: "subagents.completed",
          timestamp: Date.now(),
          sessionId: parentSessionId,
          parentSessionId,
          subagentSessionId: attemptOutcome.subagentSessionId,
          toolName: "execute_with_agent",
          payload: {
            stepName: preparedStep.name,
            durationMs: attemptOutcome.durationMs,
            toolCalls: attemptOutcome.toolCalls.length,
            providerName: attemptOutcome.providerName,
          },
        });
        return {
          status: "completed",
          result: safeStringify({
            status: "completed",
            subagentSessionId: attemptOutcome.subagentSessionId,
            output: attemptOutcome.output,
            success: true,
            completionState: attemptOutcome.completionState ?? "completed",
            completionProgress: attemptOutcome.completionProgress ?? null,
            durationMs: attemptOutcome.durationMs,
            toolCalls: attemptOutcome.toolCalls,
            tokenUsage: attemptOutcome.tokenUsage ?? null,
            providerName: attemptOutcome.providerName ?? null,
            stopReason: attemptOutcome.stopReason ?? null,
            stopReasonDetail: attemptOutcome.stopReasonDetail ?? null,
            validationCode: attemptOutcome.validationCode ?? null,
            runtimeResult: buildDelegatedRuntimeResult({
              surface: "planner_child",
              workerSessionId: attemptOutcome.subagentSessionId,
              status: "completed",
              completionState: attemptOutcome.completionState ?? "completed",
              stopReason: attemptOutcome.stopReason,
              stopReasonDetail: attemptOutcome.stopReasonDetail,
              validationCode: attemptOutcome.validationCode,
              verifierVerdict: mapPlannerVerifierSnapshotToRuntimeVerdict(
                attemptOutcome.verifierSnapshot,
              ),
              executionEnvelopeFingerprint:
                attemptOutcome.contractFingerprint,
              continuationSessionId: attemptOutcome.subagentSessionId,
              outputReady: true,
            }),
            attempts: attempt,
            retryPolicy: retryAttempts,
          }),
        };
      }

      lastFailure = attemptOutcome.failure;
      failureHistory.push(lastFailure);
      if (spawnedChild) {
        const usageBreach = budgetTracker.recordUsage(
          lastFailure.toolCallCount ?? 0,
          lastFailure.tokenUsage?.totalTokens ?? 0,
        );
        if (usageBreach) {
          const breakerMessage = this.formatRequestTreeBudgetBreach(usageBreach);
          this.recordSubagentTrajectory({
            traceId: trajectoryTraceId,
            turnId:
              `child:${preparedStep.name}:${attempt}:${lastFailure.childSessionId ?? "unknown"}:budget`,
            parentTurnId,
            parentSessionId,
            subagentSessionId: lastFailure.childSessionId,
            step: preparedStep,
            stepComplexityScore,
            contextClusterId: childContextClusterId,
            plannerStepCount: plannerSteps.length,
            subagentStepCount,
            deterministicStepCount,
            synthesisStepCount,
            dependencyDepth: Math.max(
              1,
              (preparedStep.dependsOn?.length ?? 0) + 1,
            ),
            fanout: Math.max(1, subagentStepCount),
            tools: toolScope.allowedTools,
            timeoutMs: 0,
            delegated: true,
            strategyArmId: "balanced",
            qualityProxy: 0.1,
            tokenCost: lastFailure.tokenUsage?.totalTokens ?? 0,
            latencyMs: lastFailure.durationMs ?? budgetHintTimeoutMs,
            errorCount: 1,
            errorClass: "budget_exceeded",
            metadata: {
              success: false,
              attempt,
              pipelineId: pipeline.id,
              stepName: preparedStep.name,
              stage: "circuit_breaker",
            },
          });
          lifecycleEmitter?.emit({
            type: "subagents.failed",
            timestamp: Date.now(),
            sessionId: parentSessionId,
            parentSessionId,
            subagentSessionId: lastFailure.childSessionId,
            toolName: "execute_with_agent",
            payload: this.buildRequestTreeBudgetBreachPayload({
              stepName: preparedStep.name,
              attempt,
              breach: usageBreach,
            }),
          });
          return {
            status: "failed",
            error:
              `Sub-agent circuit breaker opened for step "${preparedStep.name}": ${breakerMessage}`,
            stopReasonHint: "budget_exceeded",
          };
        }
      }
      const isRepeatedFailure =
        previousFailureMessage !== undefined &&
        lastFailure.message === previousFailureMessage;
      previousFailureMessage = lastFailure.message;
      const retryRule = SUBAGENT_RETRY_POLICY[lastFailure.failureClass];
      const retriesUsed = retryAttempts[lastFailure.failureClass];
      const shouldRetry =
        !isRepeatedFailure &&
        lastFailure.validationCode !== "blocked_phase_output" &&
        retriesUsed < retryRule.maxRetries;
      const retryAttempt = retriesUsed + 1;
      const retryDelayMs = shouldRetry
        ? computeRetryDelayMs(retryRule, retryAttempt)
        : 0;

      this.recordSubagentTrajectory({
        traceId: trajectoryTraceId,
        turnId:
          `child:${preparedStep.name}:${attempt}:${lastFailure.childSessionId ?? "unknown"}`,
        parentTurnId,
        parentSessionId,
        subagentSessionId: lastFailure.childSessionId,
        step: preparedStep,
        stepComplexityScore,
        contextClusterId: childContextClusterId,
        plannerStepCount: plannerSteps.length,
        subagentStepCount,
        deterministicStepCount,
        synthesisStepCount,
        dependencyDepth: Math.max(
          1,
          (preparedStep.dependsOn?.length ?? 0) + 1,
        ),
        fanout: Math.max(1, subagentStepCount),
        tools: toolScope.allowedTools,
        timeoutMs: 0,
        delegated: true,
        strategyArmId: "balanced",
        qualityProxy: shouldRetry ? 0.3 : 0.15,
        tokenCost: lastFailure.tokenUsage?.totalTokens ?? 0,
        latencyMs: lastFailure.durationMs ?? budgetHintTimeoutMs,
        errorCount: 1,
        errorClass: lastFailure.failureClass,
        metadata: {
          success: false,
          attempt,
          retrying: shouldRetry,
          pipelineId: pipeline.id,
          stepName: preparedStep.name,
        },
      });

      if (shouldRetry) {
        retryAttempts[lastFailure.failureClass] = retryAttempt;
        taskPrompt = buildRetryTaskPromptFn(
          taskPrompt,
          preparedStep,
          toolScope.allowedTools,
          lastFailure,
          retryAttempt,
        );
        lifecycleEmitter?.emit({
          type: "subagents.progress",
          timestamp: Date.now(),
          sessionId: parentSessionId,
          parentSessionId,
          subagentSessionId: lastFailure.childSessionId,
          toolName: "execute_with_agent",
          payload: {
            stepName: preparedStep.name,
            phase: "retry_backoff",
            output: lastFailure.message,
            durationMs: lastFailure.durationMs,
            failureClass: lastFailure.failureClass,
            validationCode: lastFailure.validationCode,
            decomposition: lastFailure.decomposition,
            attempt,
            retrying: true,
            retryAttempt,
            maxRetries: retryRule.maxRetries,
            delayMs: retryDelayMs,
            nextRetryDelayMs: retryDelayMs,
          },
        });
        if (retryDelayMs > 0) {
          await sleep(retryDelayMs);
        }
        continue;
      }

      lifecycleEmitter?.emit({
        type:
          lastFailure.failureClass === "cancelled"
            ? "subagents.cancelled"
            : "subagents.failed",
        timestamp: Date.now(),
        sessionId: parentSessionId,
        parentSessionId,
        subagentSessionId: lastFailure.childSessionId,
        toolName: "execute_with_agent",
        payload: {
          stepName: preparedStep.name,
          output: lastFailure.message,
          durationMs: lastFailure.durationMs,
          failureClass: lastFailure.failureClass,
          validationCode: lastFailure.validationCode,
          decomposition: lastFailure.decomposition,
          attempt,
          retrying: false,
          retryAttempt,
          maxRetries: retryRule.maxRetries,
          nextRetryDelayMs: retryDelayMs,
        },
      });

      if (
        lastFailure.failureClass === "needs_decomposition" &&
        lastFailure.decomposition
      ) {
        return {
          status: "failed",
          error:
            `Sub-agent step "${preparedStep.name}" requires decomposition: ${lastFailure.message}`,
          stopReasonHint: lastFailure.stopReasonHint,
          decomposition: lastFailure.decomposition,
          result: safeStringify({
            status: "needs_decomposition",
            success: false,
            delegated: false,
            recoveredViaParentFallback: false,
            failureClass: lastFailure.failureClass,
            error: lastFailure.message,
            stopReasonHint: lastFailure.stopReasonHint,
            failureHistory: failureHistory.map((failure) => ({
              failureClass: failure.failureClass,
              validationCode: failure.validationCode ?? null,
              message: failure.message,
            })),
            runtimeResult: buildDelegatedRuntimeResult({
              surface: "planner_child",
              workerSessionId: lastFailure.childSessionId,
              status: "failed",
              completionState:
                lastFailure.validationCode ? "needs_verification" : "blocked",
              stopReason: lastFailure.stopReasonHint,
              validationCode: lastFailure.validationCode,
              continuationSessionId: lastFailure.childSessionId,
              outputReady: true,
            }),
            decomposition: lastFailure.decomposition,
            attempts: attempt,
            retryPolicy: retryAttempts,
            subagentSessionId: lastFailure.childSessionId ?? null,
          }),
        };
      }

      if (this.fallbackBehavior === "continue_without_delegation") {
        return {
          status: "failed",
          error: lastFailure.message,
          stopReasonHint: lastFailure.stopReasonHint,
          fallback: {
            satisfied: true,
            reason:
              `Recovered via parent fallback after delegated failure (${lastFailure.failureClass})`,
            stopReasonHint: lastFailure.stopReasonHint,
            result: safeStringify({
              status: "delegation_fallback",
              success: false,
              delegated: false,
              recoveredViaParentFallback: true,
              failureClass: lastFailure.failureClass,
              error: lastFailure.message,
              stopReasonHint: lastFailure.stopReasonHint,
              failureHistory: failureHistory.map((failure) => ({
                failureClass: failure.failureClass,
                validationCode: failure.validationCode ?? null,
                message: failure.message,
              })),
              runtimeResult: buildDelegatedRuntimeResult({
                surface: "planner_child",
                workerSessionId: lastFailure.childSessionId,
                status: "failed",
                completionState:
                  lastFailure.validationCode ? "needs_verification" : "blocked",
                stopReason: lastFailure.stopReasonHint,
                validationCode: lastFailure.validationCode,
                continuationSessionId: lastFailure.childSessionId,
                outputReady: true,
              }),
              attempts: attempt,
              retryPolicy: retryAttempts,
              subagentSessionId: lastFailure.childSessionId ?? null,
            }),
          },
        };
      }

      return {
        status: "failed",
        error: summarizeSubagentFailureHistory(preparedStep.name, failureHistory),
        stopReasonHint: lastFailure.stopReasonHint,
      };
    }
  }

  private recordSubagentTrajectory(input: {
    traceId: string;
    turnId: string;
    parentTurnId: string;
    parentSessionId: string;
    subagentSessionId?: string;
    step: PipelinePlannerSubagentStep;
    stepComplexityScore: number;
    contextClusterId: string;
    plannerStepCount: number;
    subagentStepCount: number;
    deterministicStepCount: number;
    synthesisStepCount: number;
    dependencyDepth: number;
    fanout: number;
    tools: readonly string[];
    timeoutMs: number;
    delegated: boolean;
    strategyArmId: string;
    qualityProxy: number;
    tokenCost: number;
    latencyMs: number;
    errorCount: number;
    errorClass?: string;
    metadata?: Readonly<Record<string, string | number | boolean>>;
  }): void {
    const sink = this.resolveTrajectorySink();
    if (!sink) return;

    const reward = computeDelegationFinalReward({
      qualityProxy: input.qualityProxy,
      tokenCost: input.tokenCost,
      latencyMs: input.latencyMs,
      errorCount: input.errorCount,
    });

    sink.record({
      schemaVersion: 1,
      traceId: input.traceId,
      turnId: input.turnId,
      parentTurnId: input.parentTurnId,
      turnType: "child",
      timestampMs: Date.now(),
      stateFeatures: {
        sessionId: input.subagentSessionId ?? input.parentSessionId,
        contextClusterId: input.contextClusterId,
        complexityScore: input.stepComplexityScore,
        plannerStepCount: input.plannerStepCount,
        subagentStepCount: input.subagentStepCount,
        deterministicStepCount: input.deterministicStepCount,
        synthesisStepCount: input.synthesisStepCount,
        dependencyDepth: Math.max(1, input.dependencyDepth),
        fanout: Math.max(1, input.fanout),
      },
      action: {
        delegated: input.delegated,
        strategyArmId: input.strategyArmId,
        threshold: 0,
        selectedTools: [...input.tools],
        childConfig: {
          maxDepth: this.maxDepth,
          maxFanoutPerTurn: this.maxFanoutPerTurn,
          timeoutMs: input.timeoutMs,
        },
      },
      immediateOutcome: {
        qualityProxy: input.qualityProxy,
        tokenCost: input.tokenCost,
        latencyMs: input.latencyMs,
        errorCount: input.errorCount,
        ...(input.errorClass ? { errorClass: input.errorClass } : {}),
      },
      finalReward: reward,
      metadata: {
        stepName: input.step.name,
        objectiveChars: input.step.objective.length,
        ...(input.metadata ?? {}),
      },
    });
  }

  private async executeSubagentAttempt(
    input: ExecuteSubagentAttemptParams,
  ): Promise<ExecuteSubagentAttemptOutcome> {
    const scopeAssessment = assessDelegationScope({
      objective: input.step.objective,
      inputContract: input.step.inputContract,
      acceptanceCriteria: input.step.acceptanceCriteria,
      requiredToolCapabilities: input.step.requiredToolCapabilities,
    });
    if (!scopeAssessment.ok) {
      return {
        status: "failed",
        failure: {
          failureClass: "needs_decomposition",
          message:
            `Refusing overloaded subagent step "${input.step.name}": ${scopeAssessment.error}`,
          decomposition: scopeAssessment.decomposition,
          stopReasonHint: "validation_error",
        },
      };
    }

    const delegatedWorkingDirectory =
      input.delegatedWorkingDirectory ??
      resolvePlannerStepWorkingDirectory(input.step, input.pipeline);
    if (
      stepRequiresStructuredDelegatedFilesystemScope(input.step) &&
      !input.step.executionContext
    ) {
      return {
        status: "failed",
        failure: {
          failureClass: "invalid_input",
          message:
            `Refusing delegated step "${input.step.name}" before child execution: delegated local-file steps must arrive with a canonical execution envelope; raw context requirements are not executable runtime truth.`,
          stopReasonHint: "validation_error",
        },
      };
    }
    const delegatedScopePreflight = preflightDelegatedLocalFileScope({
      executionContext: input.step.executionContext,
      workingDirectory: delegatedWorkingDirectory?.path,
      allowedTools: input.tools,
    });
    if (!delegatedScopePreflight.ok) {
      input.lifecycleEmitter?.emit({
        type: "subagents.failed",
        timestamp: Date.now(),
        sessionId: input.parentSessionId,
        parentSessionId: input.parentSessionId,
        toolName: "execute_with_agent",
        payload: {
          stepName: input.step.name,
          stage: "validation",
          reason: delegatedScopePreflight.error,
          issues: delegatedScopePreflight.issues,
        },
      });
      return {
        status: "failed",
        failure: {
          failureClass: "invalid_input",
          message:
            `Refusing delegated step "${input.step.name}" before child execution: ${delegatedScopePreflight.error}`,
          stopReasonHint: "validation_error",
        },
      };
    }
    const effectiveDelegationSpec = buildEffectiveDelegationSpec(
      input.step,
      input.pipeline,
      {
        parentRequest: input.parentRequest,
        lastValidationCode: input.lastValidationCode,
        delegatedWorkingDirectory: delegatedWorkingDirectory?.path,
        admission: input.stepAdmission,
        results: input.pipeline.context.results,
        resolveHostToolingProfile: this.resolveHostToolingProfile,
      },
    );
    let childSessionId: string;
    try {
      const workingDirectory = delegatedWorkingDirectory?.path;
      childSessionId = await input.subAgentManager.spawn({
        parentSessionId: input.parentSessionId,
        task: input.taskPrompt,
        timeoutMs: input.timeoutMs,
        toolBudgetPerRequest: input.toolBudgetPerRequest,
        ...(workingDirectory ? { workingDirectory } : {}),
        ...(delegatedWorkingDirectory
          ? { workingDirectorySource: delegatedWorkingDirectory.source }
          : {}),
        tools: input.tools,
        requiredCapabilities: input.step.requiredToolCapabilities,
        requireToolCall: specRequiresSuccessfulToolEvidence({
            objective: input.step.objective,
            inputContract: input.step.inputContract,
            acceptanceCriteria:
              effectiveDelegationSpec.acceptanceCriteria,
            requiredToolCapabilities: input.step.requiredToolCapabilities,
            tools: input.tools,
          }),
        delegationSpec: effectiveDelegationSpec,
        unsafeBenchmarkMode: this.unsafeBenchmarkMode,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failureClass = classifySpawnFailure(message);
      return {
        status: "failed",
        failure: {
          failureClass,
          message:
            `Failed to spawn subagent for step "${input.step.name}": ${message}`,
          stopReasonHint: SUBAGENT_FAILURE_STOP_REASON[failureClass],
        },
      };
    }

    input.lifecycleEmitter?.emit({
      type: "subagents.spawned",
      timestamp: Date.now(),
      sessionId: input.parentSessionId,
      parentSessionId: input.parentSessionId,
      subagentSessionId: childSessionId,
      toolName: "execute_with_agent",
      payload: {
        stepName: input.step.name,
        timeoutMs: input.timeoutMs,
        toolBudgetPerRequest: input.toolBudgetPerRequest,
        contextCuration: input.diagnostics,
        ...(this.unsafeBenchmarkMode ? { unsafeBenchmarkMode: true } : {}),
        ...(delegatedWorkingDirectory
          ? {
            workingDirectory: delegatedWorkingDirectory.path,
            workingDirectorySource: delegatedWorkingDirectory.source,
          }
          : {}),
      },
    });
    input.lifecycleEmitter?.emit({
      type: "subagents.started",
      timestamp: Date.now(),
      sessionId: input.parentSessionId,
      parentSessionId: input.parentSessionId,
      subagentSessionId: childSessionId,
      toolName: "execute_with_agent",
      payload: {
        stepName: input.step.name,
      },
    });

    while (true) {
      if (input.signal?.aborted) {
        // Sibling step failed — cancel this child sub-agent and bail
        input.subAgentManager.cancel(childSessionId);
        return {
          status: "failed",
          failure: {
            failureClass: "cancelled",
            message: `Sub-agent for step "${input.step.name}" cancelled (sibling failure)`,
            stopReasonHint: "cancelled",
          },
        };
      }
      const result = input.subAgentManager.getResult(childSessionId);
      if (!result) {
        await sleep(this.pollIntervalMs);
        continue;
      }

      if (didSubagentReachCompletedState(result)) {
        return {
          status: "completed",
          subagentSessionId: childSessionId,
          output: result.output,
          durationMs: result.durationMs,
          toolCalls: result.toolCalls,
          tokenUsage: result.tokenUsage,
          providerName: result.providerName,
          completionState: result.completionState,
          completionProgress: result.completionProgress,
          verifierSnapshot: result.verifierSnapshot,
          contractFingerprint: result.contractFingerprint,
          stopReason: result.stopReason,
          stopReasonDetail: result.stopReasonDetail,
          validationCode: result.validationCode,
        };
      }

      const completionStateFailure = buildDelegatedIncompleteReason({
        completionState: result.completionState,
        completionProgress: result.completionProgress,
        stopReasonDetail: result.stopReasonDetail,
        verifierVerdict: mapPlannerVerifierSnapshotToRuntimeVerdict(
          result.verifierSnapshot,
        ),
      });
      const message = completionStateFailure ??
        (
          typeof result.stopReasonDetail === "string" &&
            result.stopReasonDetail.trim().length > 0
            ? result.stopReasonDetail
            : (
                typeof result.output === "string" && result.output.length > 0
                  ? result.output
                  : "unknown sub-agent failure"
              )
        );
      const initialFailureClass = classifySubagentFailureResult(result);
      const validationCode = result.validationCode;
      const isKnownValidationError =
        validationCode !== undefined &&
        (DELEGATION_OUTPUT_VALIDATION_CODES as readonly string[]).includes(
          validationCode,
        );
      const failureClass =
        isKnownValidationError ||
          initialFailureClass === "malformed_result_contract"
          ? "malformed_result_contract"
          : initialFailureClass;
      const inheritedStopReasonHint = toPipelineStopReasonHint(result.stopReason);
      const completionStateStopReasonHint =
        result.completionState && result.completionState !== "completed"
          ? "validation_error"
          : undefined;
      return {
        status: "failed",
        failure: {
          failureClass,
          message,
          validationCode,
          stopReasonHint:
            inheritedStopReasonHint ??
            completionStateStopReasonHint ??
            SUBAGENT_FAILURE_STOP_REASON[failureClass],
          childSessionId,
          durationMs: result.durationMs,
          toolCallCount: result.toolCalls.length,
          tokenUsage: result.tokenUsage,
        },
      };
    }
  }

  private async runCompletedSubagentAcceptanceProbes(params: {
    readonly step: PipelinePlannerSubagentStep;
    readonly pipeline: Pipeline;
    readonly results: Record<string, string>;
    readonly parentSessionId: string;
    readonly subagentSessionId: string;
    readonly toolCalls: SubAgentResult["toolCalls"];
    readonly tokenUsage?: LLMUsage;
    readonly durationMs: number;
    readonly lifecycleEmitter: SubAgentLifecycleEmitter | null;
  }): Promise<SubagentFailureOutcome | undefined> {
    const probes = buildSubagentAcceptanceProbePlans(
      params.step,
      params.pipeline,
      params.toolCalls,
    );
    if (probes.length === 0) {
      return undefined;
    }

    for (const probe of probes) {
      const probeArgs = probe.step.args as {
        readonly command?: string;
        readonly args?: readonly string[];
        readonly cwd?: string;
      };
      params.lifecycleEmitter?.emit({
        type: "subagents.acceptance_probe.started",
        timestamp: Date.now(),
        sessionId: params.parentSessionId,
        parentSessionId: params.parentSessionId,
        subagentSessionId: params.subagentSessionId,
        toolName: probe.step.tool,
        payload: {
          stepName: params.step.name,
          probeName: probe.name,
          category: probe.category,
          command: probeArgs.command ?? null,
          args: probeArgs.args ?? [],
          cwd: probeArgs.cwd ?? null,
        },
      });

      const startedAt = Date.now();
      const outcome = await this.executeDeterministicStep(
        probe.step,
        params.pipeline,
        params.results,
      );
      const durationMs = Date.now() - startedAt;

      if (outcome.status === "completed") {
        params.lifecycleEmitter?.emit({
          type: "subagents.acceptance_probe.completed",
          timestamp: Date.now(),
          sessionId: params.parentSessionId,
          parentSessionId: params.parentSessionId,
          subagentSessionId: params.subagentSessionId,
          toolName: probe.step.tool,
          payload: {
            stepName: params.step.name,
            probeName: probe.name,
            category: probe.category,
            durationMs,
            result: outcome.result,
          },
        });
        continue;
      }

      const commandSummary = renderDeterministicCommandSummary(probe.step);
      const cwdSummary =
        typeof probeArgs.cwd === "string" && probeArgs.cwd.trim().length > 0
          ? ` in \`${sanitizeExecutionPromptText(probeArgs.cwd, {
            preserveAbsolutePathsWithin: [probeArgs.cwd],
          })}\``
          : "";
      const failureMessage =
        `Parent-side deterministic acceptance probe failed for step "${params.step.name}" ` +
        `(${probe.category})${cwdSummary}: ${commandSummary}. ${outcome.error}`;
      const probeStopReasonHint =
        outcome.status === "failed" ? outcome.stopReasonHint : undefined;
      params.lifecycleEmitter?.emit({
        type: "subagents.acceptance_probe.failed",
        timestamp: Date.now(),
        sessionId: params.parentSessionId,
        parentSessionId: params.parentSessionId,
        subagentSessionId: params.subagentSessionId,
        toolName: probe.step.tool,
        payload: {
          stepName: params.step.name,
          probeName: probe.name,
          category: probe.category,
          durationMs,
          command: probeArgs.command ?? null,
          args: probeArgs.args ?? [],
          cwd: probeArgs.cwd ?? null,
          error: outcome.error,
        },
      });
      return {
        failureClass: "malformed_result_contract",
        message: failureMessage,
        validationCode: "acceptance_probe_failed",
        stopReasonHint: probeStopReasonHint ?? "validation_error",
        childSessionId: params.subagentSessionId,
        durationMs: params.durationMs,
        toolCallCount: params.toolCalls.length,
        tokenUsage: params.tokenUsage,
      };
    }

    return undefined;
  }

  private async buildSubagentTaskPrompt(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
    results: Readonly<Record<string, string>>,
    toolScope: {
      allowedTools: readonly string[];
      allowsToollessExecution: boolean;
      semanticFallback: readonly string[];
      removedLowSignalBrowserTools: readonly string[];
      removedByPolicy: readonly string[];
      removedAsDelegationTools: readonly string[];
      removedAsUnknownTools: readonly string[];
      parentPolicyAllowed: readonly string[];
    },
    stepAdmission?: DelegationStepAdmission,
  ): Promise<{
    taskPrompt: string;
    diagnostics: SubagentContextDiagnostics;
  }> {
    const preparedStep = this.preparePlannerDelegatedStepContext(
      step,
      pipeline,
    ).step;
    const plannerContext = pipeline.plannerContext;
    let resolvedChildPromptBudget: ResolvedChildPromptBudget | undefined;
    try {
      resolvedChildPromptBudget =
        await this.resolveChildPromptBudget?.({
          task: preparedStep.objective,
          tools: toolScope.allowedTools,
          requiredCapabilities: preparedStep.requiredToolCapabilities,
        });
    } catch {
      resolvedChildPromptBudget = undefined;
    }
    const effectivePromptBudget =
      resolvedChildPromptBudget?.promptBudget ?? this.childPromptBudget;
    const promptBudgetCaps = resolveSubagentPromptBudgetCaps(
      effectivePromptBudget,
    );
    const parentRequest = plannerContext?.parentRequest?.trim();
    const summarizedParentRequest = parentRequest
      ? summarizeParentRequestForSubagent(parentRequest, preparedStep)
      : undefined;
    const effectiveStep = preparedStep;
    const effectiveContextRequirements = effectiveStep.contextRequirements;
    const relevanceTerms = buildRelevanceTerms(effectiveStep);
    const artifactRelevanceTerms = buildArtifactRelevanceTerms(effectiveStep);
    const delegatedWorkingDirectory = resolvePlannerStepWorkingDirectory(
      effectiveStep,
      pipeline,
    );
    const requirementTerms = extractTerms(
      effectiveStep.contextRequirements.join(" "),
    );
    const dependencies = collectDependencyContexts(
      effectiveStep,
      pipeline,
      results,
    );
    const dependencyArtifactCandidates = collectDependencyArtifactCandidates(
      dependencies,
      artifactRelevanceTerms,
      delegatedWorkingDirectory?.path,
    );
    const workspaceArtifactCandidates =
      dependencyArtifactCandidates.length === 0 &&
        delegatedWorkingDirectory?.path
        ? collectWorkspaceArtifactCandidates(
          delegatedWorkingDirectory.path,
          artifactRelevanceTerms,
          promptBudgetCaps.toolOutputChars,
        )
        : [];
    const promptArtifactCandidates =
      dependencyArtifactCandidates.length > 0
        ? dependencyArtifactCandidates
        : workspaceArtifactCandidates;
    const plannerArtifactContext = pipeline.plannerContext?.artifactContext ?? [];
    const toolContextBudgets = allocateContextGroupBudgets(
      promptBudgetCaps.toolOutputChars,
      [
        {
          key: "toolOutputs",
          active:
            dependencies.length > 0 ||
            (plannerContext?.toolOutputs?.length ?? 0) > 0,
        },
        { key: "dependencyArtifacts", active: promptArtifactCandidates.length > 0 },
        { key: "artifactContext", active: plannerArtifactContext.length > 0 },
      ],
    );
    const trustedExecutionRoots = [
      delegatedWorkingDirectory?.path,
      effectiveStep.executionContext?.workspaceRoot,
    ].filter((value): value is string =>
      typeof value === "string" && value.trim().length > 0
    );

    const historySection = curateHistorySection(
      plannerContext?.history ?? [],
      relevanceTerms,
      promptBudgetCaps.historyChars,
      trustedExecutionRoots,
    );
    const memorySection = curateMemorySection(
      plannerContext?.memory ?? [],
      effectiveContextRequirements,
      relevanceTerms,
      promptBudgetCaps.memoryChars,
      trustedExecutionRoots,
    );
    const toolOutputSection = curateToolOutputSection(
      effectiveStep,
      plannerContext?.toolOutputs ?? [],
      dependencies,
      relevanceTerms,
      requirementTerms,
      toolContextBudgets.toolOutputs ?? 0,
      summarizeDependencyResultForPrompt,
      trustedExecutionRoots,
    );
    const dependencyArtifactSection = curateDependencyArtifactSection(
      promptArtifactCandidates,
      toolContextBudgets.dependencyArtifacts ?? 0,
      trustedExecutionRoots,
    );
    const artifactContextSection = curateArtifactReferenceSection(
      plannerArtifactContext,
      `${effectiveStep.objective} ${effectiveStep.inputContract} ${effectiveContextRequirements.join(" ")}`,
      toolContextBudgets.artifactContext ?? 0,
      trustedExecutionRoots,
    );
    const workspaceStateGuidanceLines = buildWorkspaceStateGuidanceLines(
      effectiveStep,
      pipeline,
      promptArtifactCandidates,
      delegatedWorkingDirectory?.path,
    );
    const hostToolingSection = buildHostToolingPromptSectionFn(
      effectiveStep,
      pipeline,
      dependencyArtifactCandidates,
      this.resolveHostToolingProfile,
    );
    const downstreamRequirementLines = buildDownstreamRequirementLines(
      effectiveStep,
      pipeline,
    );
    const workspaceVerificationContractLines =
      buildWorkspaceVerificationContractLines(effectiveStep, pipeline);
    const effectiveAcceptanceCriteria = buildEffectiveAcceptanceCriteria(
      effectiveStep,
      pipeline,
      delegatedWorkingDirectory?.path,
      this.resolveHostToolingProfile,
    );

    const buildPrompt = (diagnostics: SubagentContextDiagnostics): string => {
      const sections: string[] = [];
      const sanitizePromptField = (value: string): string =>
        sanitizeExecutionPromptText(value, {
          preserveAbsolutePathsWithin: trustedExecutionRoots,
        });
      const allowsStructuredShell = toolScope.allowedTools.some((toolName) =>
        toolName === "system.bash" || toolName === "desktop.bash"
      );
      const allowsDirectFileWrite = toolScope.allowedTools.some((toolName) =>
        toolName === "system.writeFile" ||
        toolName === "system.appendFile" ||
        toolName === "desktop.text_editor"
      );
      sections.push(
        `Execution rules:
- Execute only the assigned phase \`${effectiveStep.name}\`.
- Do not create a new multi-step plan for the broader parent request.
- Do not attempt sibling phases or synthesize the final deliverable.
- If the task requires tool-grounded evidence, you must use one or more allowed tools before answering.
- If the input contract or context requirements name source files or current workspace artifacts, inspect those sources before writing derived files.
- If a source artifact describes intended or planned structure, label it as intended/planned unless you directly confirmed the files currently exist.
- If the task is complete but sibling or next-phase work remains, say it is out of scope for this phase; do not describe the completed phase itself as blocked or incomplete.
- The per-call tool JSON is authoritative for the current recall. The phase allowlist below is broader policy scope, and the runtime may attach only a routed subset on a given turn.
- If you cannot complete the phase with the currently attached tools, state that you are blocked and explain exactly why.`,
      );
      sections.push(`Objective: ${sanitizePromptField(effectiveStep.objective)}`);
      sections.push(
        `Input contract: ${sanitizePromptField(effectiveStep.inputContract)}`,
      );
      if (summarizedParentRequest && summarizedParentRequest.length > 0) {
        sections.push(
          `Parent request summary: ${sanitizePromptField(summarizedParentRequest)}`,
        );
      }
      if (effectiveAcceptanceCriteria.length > 0) {
        sections.push(
          `Acceptance criteria:\n${effectiveAcceptanceCriteria.map((item) => `- ${sanitizePromptField(item)}`).join("\n")}`,
        );
      }
      if (stepAdmission?.isolationReason) {
        sections.push(
          `Delegation isolation:\n- ${sanitizePromptField(stepAdmission.isolationReason)}`,
        );
      }
      if (stepAdmission && stepAdmission.ownedArtifacts.length > 0) {
        sections.push(
          `Owned artifacts:\n${stepAdmission.ownedArtifacts.map((item) => `- ${sanitizePromptField(item)}`).join("\n")}`,
        );
      }
      if (stepAdmission && stepAdmission.verifierObligations.length > 0) {
        sections.push(
          `Verifier obligations:\n${stepAdmission.verifierObligations.map((item) => `- ${sanitizePromptField(item)}`).join("\n")}`,
        );
      }
      if (effectiveContextRequirements.length > 0) {
        sections.push(
          `Context requirements:\n${effectiveContextRequirements.map((item) => `- ${sanitizePromptField(item)}`).join("\n")}`,
        );
      }
      if (delegatedWorkingDirectory) {
        sections.push(
          "Runtime-approved workspace scope:\n" +
            `- The runtime has already pinned this phase to \`${sanitizePromptField(delegatedWorkingDirectory.path)}\`.\n` +
            "- Filesystem tools are validated against that approved scope at execution time.\n" +
            "- Treat any free-form cwd or workspace-root text elsewhere as informational only; do not invent alternate roots.",
        );
      }
      if (toolScope.allowedTools.length > 0) {
        sections.push(
          `Allowed tools (policy-scoped):\n${
            toolScope.allowedTools.map((item) => `- ${item}`).join("\n")
          }`,
        );
      } else if (toolScope.allowsToollessExecution) {
        sections.push(
          "Allowed tools (policy-scoped): none. Complete this phase from curated parent context, memory, and dependency outputs only.",
        );
      }
      if (allowsStructuredShell || allowsDirectFileWrite) {
        const toolUsageRules: string[] = [];
        if (allowsStructuredShell) {
          toolUsageRules.push(
            "- For `system.bash`/`desktop.bash` direct mode, `command` must be exactly one executable token. Put flags and operands in `args`.",
          );
          toolUsageRules.push(
            "- Use shell mode only when you need pipes, redirects, chaining, or subshells. In shell mode, set `command` to the full shell string and omit `args`.",
          );
          toolUsageRules.push(
            "- Verification commands must be non-interactive and exit on their own. Do not use watch/dev mode for tests or validation. Prefer runner-native single-run invocations. For Vitest use `vitest run`/`vitest --run`. For Jest use `CI=1 npm test` or `jest --runInBand`. Only pass extra npm `--` flags when the underlying runner supports them.",
          );
        }
        if (allowsDirectFileWrite) {
          toolUsageRules.push(
            "- Use file-write tools for file contents instead of shell heredocs or inline shell-generated source files when those tools are allowed.",
          );
        }
        sections.push(`Tool usage rules:\n${toolUsageRules.join("\n")}`);
      }
      if (!allowsDirectFileWrite) {
        sections.push(
          "Output contract:\n" +
            "- If this phase needs a design document, summary, JSON payload, notes, or other textual artifact and no file-write tools are allowed, return that artifact inline in your response.\n" +
            "- Do not block solely because you cannot persist a workspace file unless the acceptance criteria explicitly require a file on disk.",
        );
      }
      if (toolOutputSection.lines.length > 0) {
        sections.push(
          `Relevant tool outputs:\n${
            toolOutputSection.lines.map((line) => `- ${line}`).join("\n")
          }`,
        );
      }
      if (dependencyArtifactSection.lines.length > 0) {
        sections.push(
          "Dependency-derived workspace context:\n" +
            "- Use these file snapshots as the starting point for this phase.\n" +
            "- Do not spend tool rounds re-listing directories or re-reading the same files unless you need fresh verification after a mutation.\n" +
            dependencyArtifactSection.lines.map((line) => `- ${line}`).join("\n"),
        );
      }
      if (artifactContextSection.lines.length > 0) {
        sections.push(
          "Compacted session artifact context:\n" +
            "- These are durable references from earlier work. Prefer them over re-reading old transcript text.\n" +
            artifactContextSection.lines.map((line) => `- ${line}`).join("\n"),
        );
      }
      if (workspaceStateGuidanceLines.length > 0) {
        sections.push(
          "Observed workspace state:\n" +
            workspaceStateGuidanceLines.map((line) => `- ${line}`).join("\n"),
        );
      }
      if (historySection.lines.length > 0) {
        sections.push(
          `Curated parent history slice:\n${
            historySection.lines.map((line) => `- ${line}`).join("\n")
          }`,
        );
      }
      if (memorySection.lines.length > 0) {
        sections.push(
          `Required memory retrievals:\n${
            memorySection.lines.map((line) => `- ${line}`).join("\n")
          }`,
        );
      }
      if (hostToolingSection.lines.length > 0) {
        sections.push(
          `Host tooling constraints:\n${
            hostToolingSection.lines.map((line) => `- ${line}`).join("\n")
          }`,
        );
      }
      const allDownstreamRequirementLines = [
        ...downstreamRequirementLines,
        ...workspaceVerificationContractLines,
      ];
      if (allDownstreamRequirementLines.length > 0) {
        sections.push(
          "Downstream execution requirements:\n" +
            allDownstreamRequirementLines.map((line) => `- ${line}`).join("\n"),
        );
      }
      sections.push(`Budget hint: ${step.maxBudgetHint}`);
      sections.push(
        `Context curation diagnostics:\n${sanitizePromptField(safeStringify(diagnostics))}`,
      );
      return sections.join("\n\n");
    };

    let diagnostics: SubagentContextDiagnostics = {
      executionBudget: {
        provider: resolvedChildPromptBudget?.providerProfile?.provider,
        model: resolvedChildPromptBudget?.providerProfile?.model,
        contextWindowTokens:
          resolvedChildPromptBudget?.providerProfile?.contextWindowTokens ??
          effectivePromptBudget?.contextWindowTokens,
        contextWindowSource:
          resolvedChildPromptBudget?.providerProfile?.contextWindowSource,
        maxOutputTokens:
          resolvedChildPromptBudget?.providerProfile?.maxOutputTokens ??
          effectivePromptBudget?.maxOutputTokens,
        historyChars: promptBudgetCaps.historyChars,
        memoryChars: promptBudgetCaps.memoryChars,
        toolOutputChars: promptBudgetCaps.toolOutputChars,
        totalPromptChars: promptBudgetCaps.totalPromptChars,
      },
      history: {
        selected: historySection.selected,
        available: historySection.available,
        omitted: historySection.omitted,
        truncated: historySection.truncated,
      },
      memory: {
        selected: memorySection.selected,
        available: memorySection.available,
        omitted: memorySection.omitted,
        truncated: memorySection.truncated,
      },
      toolOutputs: {
        selected: toolOutputSection.selected,
        available: toolOutputSection.available,
        omitted: toolOutputSection.omitted,
        truncated: toolOutputSection.truncated,
      },
      dependencyArtifacts: {
        selected: dependencyArtifactSection.selected,
        available: promptArtifactCandidates.length,
        omitted: Math.max(
          0,
          promptArtifactCandidates.length - dependencyArtifactSection.selected,
        ),
        truncated: dependencyArtifactSection.truncated,
      },
      artifactContext: {
        selected: artifactContextSection.selected,
        available: plannerArtifactContext.length,
        omitted: Math.max(
          0,
          plannerArtifactContext.length - artifactContextSection.selected,
        ),
        truncated: artifactContextSection.truncated,
      },
      hostTooling: hostToolingSection.diagnostics,
      promptTruncated: false,
      toolScope: {
        strategy: this.childToolAllowlistStrategy,
        unsafeBenchmarkMode: this.unsafeBenchmarkMode,
        required: [...step.requiredToolCapabilities],
        parentPolicyAllowed: [...toolScope.parentPolicyAllowed],
        parentPolicyForbidden: [...this.forbiddenParentTools],
        resolved: [...toolScope.allowedTools],
        allowsToollessExecution: toolScope.allowsToollessExecution,
        semanticFallback: [...toolScope.semanticFallback],
        removedLowSignalBrowserTools: [
          ...toolScope.removedLowSignalBrowserTools,
        ],
        removedByPolicy: [...toolScope.removedByPolicy],
        removedAsDelegationTools: [...toolScope.removedAsDelegationTools],
        removedAsUnknownTools: [...toolScope.removedAsUnknownTools],
      },
    };

    let taskPrompt = buildPrompt(diagnostics);
    if (taskPrompt.length > promptBudgetCaps.totalPromptChars) {
      diagnostics = {
        ...diagnostics,
        promptTruncated: true,
      };
      taskPrompt = truncateText(
        buildPrompt(diagnostics),
        promptBudgetCaps.totalPromptChars,
      );
    }

    return { taskPrompt, diagnostics };
  }

  private deriveChildToolAllowlist(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
  ): {
    allowedTools: readonly string[];
    allowsToollessExecution: boolean;
    semanticFallback: readonly string[];
    removedLowSignalBrowserTools: readonly string[];
    blockedReason?: string;
    removedByPolicy: readonly string[];
    removedAsDelegationTools: readonly string[];
    removedAsUnknownTools: readonly string[];
    parentPolicyAllowed: readonly string[];
  } {
    const parentPolicyAllowed = resolveParentPolicyAllowlistFn(pipeline, this.allowedParentTools);
    const availableTools = this.resolveAvailableToolNames();
    const requestedTools =
      step.executionContext?.allowedTools &&
        step.executionContext.allowedTools.length > 0
        ? step.executionContext.allowedTools
        : step.requiredToolCapabilities;
    const resolvedScope = resolveDelegatedChildToolScope({
      spec: {
        task: step.name,
        objective: step.objective,
        parentRequest: pipeline.plannerContext?.parentRequest,
        inputContract: step.inputContract,
        acceptanceCriteria: step.acceptanceCriteria,
        requiredToolCapabilities: step.requiredToolCapabilities,
      },
      requestedTools,
      parentAllowedTools: parentPolicyAllowed,
      availableTools: availableTools ?? undefined,
      forbiddenTools: [...this.forbiddenParentTools],
      enforceParentIntersection:
        this.childToolAllowlistStrategy === "inherit_intersection",
      unsafeBenchmarkMode: this.unsafeBenchmarkMode,
    });
    if (resolvedScope.blockedReason && resolvedScope.allowedTools.length === 0) {
      return {
        allowedTools: [],
        allowsToollessExecution: resolvedScope.allowsToollessExecution,
        semanticFallback: resolvedScope.semanticFallback,
        removedLowSignalBrowserTools: resolvedScope.removedLowSignalBrowserTools,
        blockedReason: resolvedScope.blockedReason,
        removedByPolicy: resolvedScope.removedByPolicy,
        removedAsDelegationTools: resolvedScope.removedAsDelegationTools,
        removedAsUnknownTools: resolvedScope.removedAsUnknownTools,
        parentPolicyAllowed,
      };
    }
    const strippedDelegationTools = resolvedScope.allowedTools.filter(
      isPlannerChildDelegationToolName,
    );
    const allowedTools = strippedDelegationTools.length > 0
      ? resolvedScope.allowedTools.filter(
        (toolName) => !isPlannerChildDelegationToolName(toolName),
      )
      : resolvedScope.allowedTools;
    const removedAsDelegationTools = [
      ...resolvedScope.removedAsDelegationTools,
      ...strippedDelegationTools.filter((toolName) =>
        !resolvedScope.removedAsDelegationTools.includes(toolName)
      ),
    ];

    return {
      allowedTools,
      allowsToollessExecution: resolvedScope.allowsToollessExecution,
      semanticFallback: resolvedScope.semanticFallback,
      removedLowSignalBrowserTools: resolvedScope.removedLowSignalBrowserTools,
      blockedReason:
        resolvedScope.blockedReason ??
        (!resolvedScope.allowsToollessExecution && allowedTools.length === 0
          ? "No permitted child tools remain after policy scoping"
          : undefined),
      removedByPolicy: resolvedScope.removedByPolicy,
      removedAsDelegationTools,
      removedAsUnknownTools: resolvedScope.removedAsUnknownTools,
      parentPolicyAllowed,
    };
  }

  private resolveEffectiveMaxCumulativeTokensPerRequestTree(
    plannerSteps: readonly PipelinePlannerStep[],
  ): number {
    if (this.maxCumulativeTokensPerRequestTree <= 0) {
      return 0;
    }
    if (this.maxCumulativeTokensPerRequestTreeExplicitlyConfigured) {
      return this.maxCumulativeTokensPerRequestTree;
    }
    const plannedSubagentSteps = plannerSteps.filter(
      (step) => step.stepType === "subagent_task",
    ) as readonly PipelinePlannerSubagentStep[];
    if (plannedSubagentSteps.length <= 0) {
      return this.maxCumulativeTokensPerRequestTree;
    }
    const derivedBudget = plannedSubagentSteps.reduce(
      (total, step) =>
        total + this.estimatePlannedSubagentStepTokenBudget(step),
      0,
    );
    return Math.max(
      this.maxCumulativeTokensPerRequestTree,
      derivedBudget * DEFAULT_REQUEST_TREE_SUBAGENT_PASSES,
    );
  }

  private estimatePlannedSubagentStepTokenBudget(
    step: PipelinePlannerSubagentStep,
  ): number {
    const timeoutMs = parseBudgetHintMsFn(step.maxBudgetHint, this.defaultSubagentTimeoutMs);
    return Math.max(
      DEFAULT_MIN_TOKENS_PER_PLANNED_SUBAGENT_STEP,
      Math.ceil(timeoutMs * DEFAULT_PLANNED_SUBAGENT_TOKENS_PER_MS),
    );
  }

  private formatRequestTreeBudgetBreach(
    breach: RequestTreeBudgetBreach,
  ): string {
    const { state } = breach;
    const usageSummary =
      `cumulativeToolCalls=${state.cumulativeToolCalls}/${state.maxCumulativeToolCallsPerRequestTree}; ` +
      `cumulativeTokens=${state.cumulativeTokens}/${state.maxCumulativeTokensPerRequestTree}; ` +
      `spawnedChildren=${state.spawnedChildren}; reservedSpawns=${state.reservedSpawns}`;
    if (breach.limitKind === "spawns") {
      return `${breach.reason}; attemptedSpawnCount=${breach.attemptedSpawnCount}; ${usageSummary}`;
    }
    return (
      `${breach.reason}; ` +
      `stepToolCalls=${breach.stepToolCalls}; ` +
      `stepTokens=${breach.stepTokens}; ` +
      usageSummary
    );
  }

  private buildRequestTreeBudgetBreachPayload(params: {
    readonly stepName: string;
    readonly attempt: number;
    readonly breach: RequestTreeBudgetBreach;
  }): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      stepName: params.stepName,
      stage: "circuit_breaker",
      reason: params.breach.reason,
      limitKind: params.breach.limitKind,
      attempt: params.attempt,
      ...params.breach.state,
    };
    if (params.breach.limitKind === "spawns") {
      payload.attemptedSpawnCount = params.breach.attemptedSpawnCount;
    } else {
      payload.stepToolCalls = params.breach.stepToolCalls;
      payload.stepTokens = params.breach.stepTokens;
    }
    return payload;
  }

  /* ---- Thin wrappers for test access to extracted standalone functions ---- */
  buildRetryTaskPrompt(
    currentTaskPrompt: string,
    step: PipelinePlannerSubagentStep,
    allowedTools: readonly string[],
    failure: SubagentFailureOutcome,
    retryAttempt: number,
  ): string {
    return buildRetryTaskPromptFn(currentTaskPrompt, step, allowedTools, failure, retryAttempt);
  }

  buildEffectiveDelegationSpec(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
    options: {
      readonly parentRequest?: string;
      readonly lastValidationCode?: DelegationOutputValidationCode;
      readonly delegatedWorkingDirectory?: string;
      readonly admission?: DelegationStepAdmission;
      readonly results?: Readonly<Record<string, string>>;
    } = {},
  ) {
    const preparedStep = this.preparePlannerDelegatedStepContext(
      step,
      pipeline,
    ).step;
    return buildEffectiveDelegationSpec(preparedStep, pipeline, {
      ...options,
      resolveHostToolingProfile: this.resolveHostToolingProfile,
    });
  }

  summarizeDependencyResultForPrompt(result: string | null): string {
    return summarizeDependencyResultForPrompt(result);
  }
}
