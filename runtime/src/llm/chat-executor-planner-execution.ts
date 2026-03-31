/**
 * Planner execution pipeline extracted from ChatExecutor.executePlannerPath.
 *
 * @module
 */

import { basename as pathBasename, resolve as resolvePath } from "node:path";

import type { PromptBudgetSection } from "./prompt-budget.js";
import type {
  Pipeline,
  PipelineResult,
} from "../workflow/pipeline.js";
import type { HostToolingProfile } from "../gateway/host-tooling.js";
import type { ResolvedDelegationDecisionConfig } from "./delegation-decision.js";
import {
  computePlannerGraphDepth,
  isPipelineStopReasonHint,
  buildPlannerSynthesisMessages,
  buildPlannerSynthesisFallbackContent,
  ensureSubagentProvenanceCitations,
  resolveDelegationBanditArm,
  assessAndRecordDelegationDecision,
  mapPlannerStepsToPipelineSteps,
  validateSalvagedPlannerToolPlan,
  buildPlannerMessages,
  buildPlannerStructuredOutputRequest,
  buildPlannerExecutionContext,
  buildPlannerVerificationRequirementsFailureMessage,
  buildPlannerVerificationRequirementsRefinementHint,
  validatePlannerGraph,
  validatePlannerVerificationRequirements,
  validatePlannerStepContracts,
  extractPlannerVerificationCommandRequirements,
  extractPlannerVerificationRequirements,
  extractExplicitDeterministicToolRequirements,
  extractExplicitSubagentOrchestrationRequirements,
  validateExplicitDeterministicToolRequirements,
  validateExplicitSubagentOrchestrationRequirements,
  extractPlannerDecompositionDiagnostics,
  extractPlannerStructuralDiagnostics,
  buildExplicitDeterministicToolRefinementHint,
  buildExplicitDeterministicToolFailureMessage,
  buildPlannerParseRefinementHint,
  buildPlannerStructuralRefinementHint,
  buildPlannerValidationFailureMessage,
  buildPipelineDecompositionRefinementHint,
  buildPipelineFailureRepairRefinementHint,
  buildPlannerStepContractRefinementHint,
  buildSalvagedPlannerToolCallRefinementHint,
  buildExplicitSubagentOrchestrationRefinementHint,
  buildExplicitSubagentOrchestrationFailureMessage,
  extractRecoverablePlannerParseDiagnostics,
  isHighRiskSubagentPlan,
  safeStepStringArray,
  extractPlannerArtifactTargets,
  plannerRequestImplementsFromArtifact,
  pipelineResultToToolCalls,
  buildPlannerWorkflowContract,
  buildPlannerWorkflowStepContract,
} from "./chat-executor-planner.js";
import { normalizePlannerResponse } from "./chat-executor-planner-normalization.js";
import {
  executePlannerPipelineWithVerifierLoop,
  runSubagentVerifierRound,
} from "./chat-executor-planner-verifier-loop.js";
import {
  buildPlannerVerifierAdmission,
  buildPlannerWorkflowAdmission,
} from "./chat-executor-verifier.js";
import {
  deriveDelegationContextClusterId,
  type DelegationBanditPolicyTuner,
} from "./delegation-learning.js";
import {
  DEFAULT_PLANNER_MAX_REFINEMENT_ATTEMPTS,
  DEFAULT_PLANNER_MAX_STEP_CONTRACT_RETRIES,
  DEFAULT_PLANNER_MAX_RUNTIME_REPAIR_RETRIES,
} from "./chat-executor-constants.js";
import type {
  ToolCallRecord,
  ExecutionContext,
  PlannerDiagnostic,
  PlannerPlan,
  PlannerDeterministicToolStepIntent,
  PlannerSubAgentTaskStepIntent,
  ResolvedSubagentVerifierConfig,
  ChatCallUsageRecord,
} from "./chat-executor-types.js";
import {
  isRuntimeLimitExceeded,
} from "./runtime-limit-policy.js";
import type { LLMPipelineStopReason } from "./policy.js";
import type { LLMResponse } from "./types.js";
import { createExecutionEnvelope } from "../workflow/execution-envelope.js";
import { resolveRequiredSubagentVerificationStepNames } from "../workflow/subagent-orchestration-requirements.js";
import {
  summarizeToolCalls,
  generateFallbackContent,
  truncateText,
} from "./chat-executor-text.js";
import { classifyLLMFailure } from "./errors.js";

const DOC_ONLY_ARTIFACT_RE = /\.(?:md|mdx|txt|rst|adoc)$/i;
const DOC_ONLY_BASENAME_RE =
  /(?:^|\/)(?:README|CHANGELOG|CONTRIBUTING|LICENSE|COPYING|NOTES|AGENTS|AGENC|PLAN|TASK_BREAKDOWN)(?:\.[^/]+)?$/i;
const PLANNER_SYNTHESIS_TOOL_BLOCK_RE = /```tool:\s*([^\s`]+)[\s\S]*?```/gi;

// ============================================================================
// Dependencies interface
// ============================================================================

export interface PlannerExecutionConfig {
  readonly plannerMaxTokens: number;
  readonly delegationNestingDepth: number;
  readonly delegationDecisionConfig: ResolvedDelegationDecisionConfig;
  readonly subagentVerifierConfig: ResolvedSubagentVerifierConfig;
  readonly delegationDefaultStrategyArmId: string;
  readonly allowedTools: Set<string> | null;
  readonly delegationBanditTuner?: DelegationBanditPolicyTuner;
  readonly resolveHostToolingProfile?: () => HostToolingProfile | null;
  readonly resolveHostWorkspaceRoot?: () => string | null;
}

export interface PlannerExecutionCallbacks {
  emitPlannerTrace(
    ctx: ExecutionContext,
    type:
      | "planner_path_finished"
      | "planner_pipeline_finished"
      | "planner_synthesis_fallback_applied"
      | "planner_pipeline_started"
      | "planner_plan_parsed"
      | "planner_refinement_requested"
      | "planner_verifier_retry_scheduled"
      | "planner_verifier_round_finished",
    payload: Record<string, unknown>,
  ): void;
  setStopReason(
    ctx: ExecutionContext,
    reason: LLMPipelineStopReason,
    detail?: string,
  ): void;
  checkRequestTimeout(ctx: ExecutionContext, stage: string): boolean;
  callModelForPhase(
    ctx: ExecutionContext,
    input: {
      phase: ChatCallUsageRecord["phase"];
      callMessages: readonly import("./types.js").LLMMessage[];
      callSections?: readonly PromptBudgetSection[];
      onStreamChunk?: import("./types.js").StreamProgressCallback;
      statefulSessionId?: string;
      statefulResumeAnchor?: import("./types.js").LLMStatefulResumeAnchor;
      statefulHistoryCompacted?: boolean;
      routedToolNames?: readonly string[];
      persistRoutedToolNames?: boolean;
      toolChoice?: import("./types.js").LLMToolChoice;
      structuredOutput?: import("./types.js").LLMStructuredOutputRequest;
      preparationDiagnostics?: Record<string, unknown>;
      allowRecallBudgetBypass?: boolean;
      budgetReason: string;
    },
  ): Promise<LLMResponse | undefined>;
  appendToolRecord(ctx: ExecutionContext, record: ToolCallRecord): void;
  runPipelineWithTimeout(
    ctx: ExecutionContext,
    pipeline: Pipeline,
  ): Promise<PipelineResult | undefined>;
  timeoutDetail(
    stage: string,
    requestTimeoutMs: number,
  ): string;
}

function isDocOnlyPlannerArtifact(path: string): boolean {
  return DOC_ONLY_ARTIFACT_RE.test(path) || DOC_ONLY_BASENAME_RE.test(path);
}

function extractClaimedToolBlockNames(content: string): readonly string[] {
  const claimedNames = new Set<string>();
  for (const match of content.matchAll(PLANNER_SYNTHESIS_TOOL_BLOCK_RE)) {
    const toolName = match[1]?.trim();
    if (toolName) {
      claimedNames.add(toolName);
    }
  }
  return [...claimedNames];
}

function resolvePlannerSynthesisToolMarkupMismatch(input: {
  readonly content: string;
  readonly toolCalls: readonly ToolCallRecord[];
}): readonly string[] {
  const claimedToolNames = extractClaimedToolBlockNames(input.content);
  if (claimedToolNames.length === 0) {
    return [];
  }
  const executedToolNames = new Set(
    input.toolCalls
      .filter((toolCall) => !toolCall.isError)
      .map((toolCall) => toolCall.name.trim())
      .filter((toolName) => toolName.length > 0),
  );
  return claimedToolNames.filter((toolName) => !executedToolNames.has(toolName));
}

function resolvePlannerWorkspaceRoot(
  ctx: ExecutionContext,
  config: PlannerExecutionConfig,
): string | undefined {
  if (
    typeof ctx.runtimeWorkspaceRoot === "string" &&
    ctx.runtimeWorkspaceRoot.trim().length > 0
  ) {
    return ctx.runtimeWorkspaceRoot.trim();
  }
  const hostWorkspaceRoot = config.resolveHostWorkspaceRoot?.();
  return typeof hostWorkspaceRoot === "string" &&
      hostWorkspaceRoot.trim().length > 0
    ? hostWorkspaceRoot
    : undefined;
}

function shouldBlockPlannerImplementationFallback(
  subagentSteps: readonly PlannerSubAgentTaskStepIntent[],
  deterministicSteps: readonly PlannerDeterministicToolStepIntent[],
): boolean {
  const subagentImplementationStepDetected = subagentSteps.some((step) => {
    const executionContext = step.executionContext;
    const artifactPaths = [
      ...(executionContext?.targetArtifacts ?? []),
      ...(executionContext?.requiredSourceArtifacts ?? []),
      ...(executionContext?.inputArtifacts ?? []),
    ].filter((path) => path.trim().length > 0);
    const docOnlyArtifacts =
      artifactPaths.length > 0 &&
      artifactPaths.every((path) => isDocOnlyPlannerArtifact(path));
    const childOwnsDocArtifactWrite =
      docOnlyArtifacts && stepOwnsWriteArtifacts(step);
    if (docOnlyArtifacts && !childOwnsDocArtifactWrite) {
      return false;
    }

    const requiredCapabilities = safeStepStringArray(step.requiredToolCapabilities).map((capability) =>
      capability.trim().toLowerCase(),
    );
    if (
      requiredCapabilities.some((capability) =>
        capability.includes("write") ||
        capability.includes("append") ||
        capability.includes("delete") ||
        capability.includes("move") ||
        capability.includes("mkdir") ||
        capability.includes("text_editor")
      )
    ) {
      return true;
    }

    if (
      requiredCapabilities.some((capability) => capability.includes("bash")) &&
      /\b(?:build|compile|typecheck|lint|test|install|implement|scaffold|write|edit|create|fix|refactor|migrate)\b/i.test(
        [
          step.objective,
          step.inputContract,
          ...safeStepStringArray(step.acceptanceCriteria),
        ].join(" "),
      )
    ) {
      return true;
    }

    return (
      stepOwnsWriteArtifacts(step) ||
      step.workflowStep?.role === "validator" ||
      executionContext?.verificationMode === "mutation_required" ||
      executionContext?.verificationMode === "deterministic_followup" ||
      executionContext?.stepKind === "delegated_write" ||
      executionContext?.stepKind === "delegated_scaffold" ||
      executionContext?.stepKind === "delegated_validation" ||
      executionContext?.effectClass === "filesystem_write" ||
      executionContext?.effectClass === "filesystem_scaffold" ||
      executionContext?.effectClass === "shell" ||
      executionContext?.effectClass === "mixed" ||
      Boolean(executionContext?.completionContract)
    );
  });
  if (subagentImplementationStepDetected) {
    return true;
  }

  return deterministicSteps.some((step) => {
    if (step.tool !== "system.bash" && step.tool !== "desktop.bash") {
      return false;
    }
    const command =
      typeof step.args.command === "string"
        ? step.args.command
        : "";
    const argv = Array.isArray(step.args.args)
      ? step.args.args.filter((value): value is string => typeof value === "string")
      : [];
    const joined = [command, ...argv].join(" ").trim();
    return /\b(?:build|compile|typecheck|lint|test|install|implement|scaffold|write|edit|create|fix|refactor|migrate)\b/i.test(
      joined,
    );
  });
}

function buildPlannerImplementationFallbackBlockedDetail(
  reason: string,
): string {
  return (
    "Planner produced an implementation-scoped delegated plan, " +
    `but runtime delegation admission rejected it (${reason}). ` +
    "Inline legacy fallback is disabled for this task class; re-plan the work with a single-owner execution contract or provide an explicit workflow verification contract."
  );
}

function canRefinePlannerDelegationVeto(reason: string): boolean {
  switch (reason) {
    case "shared_artifact_writer_inline":
    case "fanout_exceeded":
    case "depth_exceeded":
    case "missing_execution_envelope":
    case "parallel_gain_insufficient":
    case "dependency_coupling_high":
    case "tool_overlap_high":
    case "retry_cost_high":
    case "negative_economics":
    case "no_safe_delegation_shape":
    case "score_below_threshold":
      return true;
    default:
      return false;
  }
}

function buildPlannerDelegationVetoRefinementHint(reason: string): string {
  if (reason === "shared_artifact_writer_inline") {
    return (
      "The previous plan gave multiple delegated steps mutable ownership of the same artifact scope. " +
      "Re-emit a relation-aware execution contract: optional bounded read-only reviewers or grounding steps may share the source artifact, but exactly one delegated step may hold `write_owner` authority for a given artifact scope unless a later delegated step owns disjoint artifacts."
    );
  }
  if (reason === "score_below_threshold") {
    return (
      "The previous delegated plan was not strong enough to justify multiple child owners. " +
      "Re-emit a smaller plan with one `write_owner` implementation step and deterministic verification around it."
    );
  }
  return (
    `Runtime delegation admission rejected the previous implementation plan (${reason}). ` +
    "Re-emit a valid relation-aware execution contract with explicit artifact ownership and deterministic verification around the implementation owner."
  );
}

// ============================================================================
// Helper (local to planner execution)
// ============================================================================

function mergeExplicitRequirementToolNames(
  primaryToolNames: readonly string[],
  secondaryToolNames: readonly string[],
  fallbackToolNames: readonly string[],
): readonly string[] {
  const merged = Array.from(
    new Set([
      ...primaryToolNames,
      ...secondaryToolNames,
    ]),
  );
  if (merged.length > 0) {
    return merged;
  }
  return Array.from(new Set(fallbackToolNames));
}

function buildPlannerDiagnosticSignature(
  diagnostics: readonly PlannerDiagnostic[],
): string {
  return diagnostics
    .map((diagnostic) => {
      const stepName =
        typeof diagnostic.details?.stepName === "string"
          ? diagnostic.details.stepName
          : "";
      const installSteps =
        typeof diagnostic.details?.installSteps === "string"
          ? diagnostic.details.installSteps
          : "";
      const phases =
        typeof diagnostic.details?.phases === "string"
          ? diagnostic.details.phases
          : "";
      return [
        diagnostic.category,
        diagnostic.code,
        stepName,
        installSteps,
        phases,
        diagnostic.message,
      ].join("::");
    })
    .sort()
    .join("||");
}

function buildPipelineFailureSignature(result: PipelineResult): string {
  const normalizedError =
    typeof result.error === "string"
      ? truncateText(result.error.replace(/\s+/g, " ").trim(), 320)
      : "";
  return [
    result.status,
    result.stopReasonHint ?? "",
    String(result.completedSteps),
    String(result.totalSteps),
    normalizedError,
  ].join("::");
}

const EXPLICIT_FILE_WRITE_TARGET_RE =
  /\b(?:write|create|draft|generate|produce|make|save|update|overwrite)\b[\s\S]{0,160}?(?:to|into|as)?\s*[`'"]?((?:\/|\.\/|\.\.\/)?[A-Za-z0-9._/\-]+)[`'"]?/gi;

function looksLikeExplicitFileTarget(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (!trimmed) return false;
  const normalized = trimmed.replace(/[),.;:]+$/g, "");
  if (!normalized) return false;
  const segments = normalized.split("/").filter(Boolean);
  const base = segments.length > 0 ? segments[segments.length - 1]! : normalized;
  if (base === "." || base === "..") return false;
  return (
    normalized.startsWith("/") ||
    normalized.startsWith("./") ||
    normalized.startsWith("../") ||
    base.startsWith(".") ||
    base.includes(".") ||
    /^(?:README|AGENC|AGENTS|Makefile|Dockerfile)$/i.test(base)
  );
}

export function inferExplicitFileWriteTarget(messageText: string): string | undefined {
  EXPLICIT_FILE_WRITE_TARGET_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EXPLICIT_FILE_WRITE_TARGET_RE.exec(messageText)) !== null) {
    const candidate = (match[1] ?? "").trim();
    if (!looksLikeExplicitFileTarget(candidate)) continue;
    return candidate.replace(/[),.;:]+$/g, "");
  }
  return undefined;
}

function plannerAlreadyMutatesFiles(plannerPlan: PlannerPlan): boolean {
  return plannerPlan.steps.some(
    (step) =>
      step.stepType === "deterministic_tool" &&
      (step.tool === "system.writeFile" || step.tool === "system.appendFile"),
  );
}

function extractPlannerReadDependencyArtifacts(
  plannerPlan: PlannerPlan,
): readonly string[] {
  const artifacts = new Set<string>();
  for (const step of plannerPlan.steps) {
    if (
      step.stepType === "deterministic_tool" &&
      step.tool === "system.readFile" &&
      typeof step.args.path === "string" &&
      step.args.path.trim().length > 0
    ) {
      artifacts.add(step.args.path.trim());
    }
  }
  return [...artifacts];
}

function canRuntimeRepairImplementFromArtifactPlan(params: {
  readonly plannerPlan: PlannerPlan;
  readonly diagnostics: readonly PlannerDiagnostic[];
  readonly messageText: string;
  readonly workspaceRoot: string | undefined;
}): boolean {
  if (!plannerRequestImplementsFromArtifact(params.messageText)) {
    return false;
  }
  if (!params.workspaceRoot) {
    return false;
  }
  if (params.diagnostics.length === 0) {
    return false;
  }
  if (
    !params.diagnostics.every((diagnostic) =>
      diagnostic.code === "planner_implementation_missing_mutation_path"
    )
  ) {
    return false;
  }
  if (params.plannerPlan.steps.some((step) => step.stepType === "subagent_task")) {
    return false;
  }
  if (plannerAlreadyMutatesFiles(params.plannerPlan)) {
    return false;
  }
  return params.plannerPlan.steps.every((step) => {
    if (step.stepType !== "deterministic_tool") {
      return false;
    }
    return (
      step.tool === "system.readFile" ||
      step.tool === "system.listDir" ||
      step.tool === "system.stat"
    );
  });
}

function buildSingleOwnerImplementFromArtifactPlan(params: {
  readonly messageText: string;
  readonly workspaceRoot: string;
  readonly reason: string;
  readonly requiredSourceArtifacts: readonly string[];
  readonly readStepNames?: readonly string[];
  readonly confidence?: number;
}): PlannerPlan | undefined {
  const requiredSourceArtifacts =
    params.requiredSourceArtifacts.length > 0
      ? [...new Set(params.requiredSourceArtifacts)]
      : ["PLAN.md"];
  const executionContext = createExecutionEnvelope({
    workspaceRoot: params.workspaceRoot,
    allowedReadRoots: [params.workspaceRoot],
    allowedWriteRoots: [params.workspaceRoot],
    allowedTools: [
      "system.readFile",
      "system.writeFile",
      "system.bash",
    ],
    requiredSourceArtifacts,
    targetArtifacts: [params.workspaceRoot],
    effectClass: "filesystem_write",
    verificationMode: "mutation_required",
    stepKind: "delegated_write",
    role: "writer",
    artifactRelations: [
      ...requiredSourceArtifacts.map((artifactPath) => ({
        relationType: "read_dependency" as const,
        artifactPath,
      })),
      {
        relationType: "write_owner" as const,
        artifactPath: params.workspaceRoot,
      },
    ],
    fallbackPolicy: "fail_request",
    resumePolicy: "stateless_retry",
    approvalProfile: "filesystem_write",
  });
  if (!executionContext) {
    return undefined;
  }
  const objectiveSource = truncateText(params.messageText.trim(), 240);
  const writerBaseStep: PlannerSubAgentTaskStepIntent = {
    name: "implement_owner",
    stepType: "subagent_task",
    objective:
      objectiveSource.length > 0
        ? `Execute this implementation request inside the workspace: ${objectiveSource}`
        : "Implement the requested planning-artifact phases inside the workspace and verify the result before finishing.",
    inputContract:
      "Use the planning artifact plus the current workspace to perform the requested implementation end to end. Do not stop at analysis only.",
    acceptanceCriteria: [
      "Workspace files are updated to satisfy the requested implementation phases.",
      "Grounded verification runs before completion, and passing or failing commands are reported concretely.",
      "If a blocker prevents completion, report the concrete blocker with evidence instead of returning an analysis-only summary.",
    ],
    requiredToolCapabilities: [
      "system.readFile",
      "system.writeFile",
      "system.bash",
    ],
    contextRequirements:
      (params.readStepNames?.length ?? 0) > 0
        ? params.readStepNames!
        : requiredSourceArtifacts.length > 0
          ? ["planning_artifact_context"]
          : ["workspace_context"],
    executionContext,
    maxBudgetHint: "30m",
    canRunParallel: false,
    ...((params.readStepNames?.length ?? 0) > 0
      ? { dependsOn: params.readStepNames }
      : {}),
  };
  const writerStep: PlannerSubAgentTaskStepIntent = {
    ...writerBaseStep,
    workflowStep: buildPlannerWorkflowStepContract(writerBaseStep),
  };
  return {
    reason: params.reason,
    requiresSynthesis: false,
    confidence: params.confidence,
    steps: [writerStep],
    edges: [],
    workflowContract: buildPlannerWorkflowContract({
      steps: [writerStep],
    }),
  };
}

function buildRuntimeRepairedImplementFromArtifactPlan(params: {
  readonly plannerPlan: PlannerPlan;
  readonly messageText: string;
  readonly workspaceRoot: string;
}): PlannerPlan | undefined {
  const requestedArtifacts = extractPlannerArtifactTargets(params.messageText);
  const readDependencyArtifacts = extractPlannerReadDependencyArtifacts(
    params.plannerPlan,
  );
  const requiredSourceArtifacts = [
    ...new Set([...requestedArtifacts, ...readDependencyArtifacts]),
  ];
  const readStepNames = params.plannerPlan.steps
    .filter(
      (step): step is PlannerDeterministicToolStepIntent =>
        step.stepType === "deterministic_tool" && step.tool === "system.readFile",
    )
    .map((step) => step.name);
  const repairedPlan = buildSingleOwnerImplementFromArtifactPlan({
    messageText: params.messageText,
    workspaceRoot: params.workspaceRoot,
    reason: "runtime_repaired_single_owner_plan_artifact_execution",
    requiredSourceArtifacts,
    readStepNames,
    confidence: params.plannerPlan.confidence,
  });
  if (!repairedPlan) {
    return undefined;
  }
  return {
    ...repairedPlan,
    steps: [
      ...params.plannerPlan.steps.filter((step) => step.stepType !== "synthesis"),
      ...repairedPlan.steps,
    ],
    edges: [
      ...params.plannerPlan.edges,
      ...readStepNames.map((stepName) => ({
        from: stepName,
        to: repairedPlan.steps[0]!.name,
      })),
    ].filter(
      (edge, index, edges) =>
        edges.findIndex((candidate) =>
          candidate.from === edge.from && candidate.to === edge.to
        ) === index,
    ),
  };
}

function canRuntimeRepairPlannerProviderFailure(params: {
  readonly messageText: string;
  readonly workspaceRoot: string | undefined;
  readonly failureClass: ReturnType<typeof classifyLLMFailure>;
}): boolean {
  if (!params.workspaceRoot) {
    return false;
  }
  if (!plannerRequestImplementsFromArtifact(params.messageText)) {
    return false;
  }
  return (
    params.failureClass === "provider_error" ||
    params.failureClass === "timeout" ||
    params.failureClass === "rate_limited"
  );
}

function buildRuntimeRepairedPlannerProviderFailurePlan(params: {
  readonly messageText: string;
  readonly workspaceRoot: string;
}): PlannerPlan | undefined {
  return buildSingleOwnerImplementFromArtifactPlan({
    messageText: params.messageText,
    workspaceRoot: params.workspaceRoot,
    reason: "runtime_repaired_single_owner_planner_unavailable_execution",
    requiredSourceArtifacts: extractPlannerArtifactTargets(params.messageText),
    confidence: 0.25,
  });
}

function stepWriteOwnerTargets(
  step: PlannerSubAgentTaskStepIntent,
): readonly string[] {
  const typedTargets = (step.workflowStep?.artifactRelations ?? [])
    .filter((relation) => relation.relationType === "write_owner")
    .map((relation) => relation.artifactPath);
  if (typedTargets.length > 0) {
    return typedTargets;
  }
  return step.executionContext?.targetArtifacts ?? [];
}

function stepOwnsWriteArtifacts(
  step: PlannerSubAgentTaskStepIntent,
): boolean {
  if (step.workflowStep?.role === "writer") {
    return stepWriteOwnerTargets(step).length > 0;
  }
  if (
    (step.workflowStep?.artifactRelations ?? []).some((relation) =>
      relation.relationType === "write_owner"
    )
  ) {
    return true;
  }
  const executionContext = step.executionContext;
  return (
    executionContext?.verificationMode === "mutation_required" ||
    executionContext?.stepKind === "delegated_write" ||
    executionContext?.stepKind === "delegated_scaffold" ||
    executionContext?.effectClass === "filesystem_write" ||
    executionContext?.effectClass === "filesystem_scaffold"
  ) && (executionContext?.targetArtifacts?.length ?? 0) > 0;
}

function plannerHasChildOwnedWriteTarget(
  plannerPlan: PlannerPlan,
  requestedWriteTarget: string | undefined,
): boolean {
  if (!requestedWriteTarget) {
    return plannerPlan.steps.some(
      (step) =>
        step.stepType === "subagent_task" &&
        stepOwnsWriteArtifacts(step),
    );
  }
  const normalizedTarget = normalizeToolCallTargetPath(requestedWriteTarget);
  const normalizedRequestedSuffix = requestedWriteTarget
    .trim()
    .replace(/\\/g, "/")
    .replace(/^[.][/\\]/, "");
  const requestedBasename = pathBasename(normalizedRequestedSuffix);
  return plannerPlan.steps.some((step) => {
    if (
      step.stepType !== "subagent_task" ||
      !stepOwnsWriteArtifacts(step)
    ) {
      return false;
    }
    return stepWriteOwnerTargets(step).some((artifact) =>
      matchesRequestedArtifactTarget(
        normalizedTarget,
        normalizedRequestedSuffix,
        requestedBasename,
        artifact,
      )
    );
  });
}

function matchesRequestedArtifactTarget(
  normalizedTarget: string | undefined,
  normalizedRequestedSuffix: string,
  requestedBasename: string,
  artifact: string,
): boolean {
  const normalizedArtifact = normalizeToolCallTargetPath(artifact);
  if (normalizedTarget && normalizedArtifact === normalizedTarget) {
    return true;
  }
  const artifactText = artifact.trim().replace(/\\/g, "/");
  if (
    normalizedRequestedSuffix.length > 0 &&
    (
      artifactText === normalizedRequestedSuffix ||
      artifactText.endsWith(`/${normalizedRequestedSuffix}`)
    )
  ) {
    return true;
  }
  return requestedBasename.length > 0 &&
    pathBasename(artifactText) === requestedBasename;
}

function normalizeToolCallTargetPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  try {
    return resolvePath(value.trim());
  } catch {
    return undefined;
  }
}

function resolveTypedRequiredSubagentOutputStepNames(params: {
  readonly plannerPlan: PlannerPlan;
  readonly requirements: ReturnType<
    typeof extractExplicitSubagentOrchestrationRequirements
  >;
  readonly candidates: readonly PlannerSubAgentTaskStepIntent[];
}): readonly string[] {
  const requiredChildren = params.plannerPlan.workflowContract?.requiredChildren;
  if (!requiredChildren) {
    return resolveRequiredSubagentVerificationStepNames({
      requirements: params.requirements,
      candidates: params.candidates,
    });
  }
  if ((requiredChildren.exactNames?.length ?? 0) > 0) {
    return requiredChildren.exactNames!;
  }
  const typedReviewerNames = params.plannerPlan.workflowContract?.steps
    .filter((step) => step.role === "reviewer")
    .map((step) => step.name) ?? [];
  if (typedReviewerNames.length > 0) {
    return typedReviewerNames.slice(0, requiredChildren.cardinality);
  }
  return resolveRequiredSubagentVerificationStepNames({
    requirements: params.requirements,
    candidates: params.candidates,
  });
}

function evaluatePlannerValidationState(params: {
  readonly plannerPlan: PlannerPlan;
  readonly messageText: string;
  readonly workspaceRoot?: string;
  readonly delegationConfig: PlannerExecutionConfig["delegationDecisionConfig"];
  readonly explicitOrchestrationRequirements: ReturnType<
    typeof extractExplicitSubagentOrchestrationRequirements
  >;
  readonly explicitDeterministicToolRequirements:
    | ReturnType<typeof extractExplicitDeterministicToolRequirements>
    | undefined;
  readonly explicitVerificationRequirements: ReturnType<
    typeof extractPlannerVerificationRequirements
  >;
  readonly explicitVerificationCommandRequirements: ReturnType<
    typeof extractPlannerVerificationCommandRequirements
  >;
}): {
  readonly graphDiagnostics: readonly PlannerDiagnostic[];
  readonly plannerStepContractDiagnostics: readonly PlannerDiagnostic[];
  readonly verificationRequirementDiagnostics: readonly PlannerDiagnostic[];
  readonly structuralGraphDiagnostics: readonly PlannerDiagnostic[];
  readonly decompositionGraphDiagnostics: readonly PlannerDiagnostic[];
  readonly requiredOrchestrationDiagnostics: readonly PlannerDiagnostic[];
  readonly explicitToolDiagnostics: readonly PlannerDiagnostic[];
  readonly hasStructuralDiagnostics: boolean;
  readonly currentValidationDiagnostics: readonly PlannerDiagnostic[];
  readonly hasOnlyStepContractDiagnostics: boolean;
  readonly structuralDiagnosticSignature: string;
} {
  const graphDiagnostics = validatePlannerGraph(
    params.plannerPlan,
    {
      maxSubagentFanout: params.delegationConfig.maxFanoutPerTurn,
      maxSubagentDepth: params.delegationConfig.maxDepth,
      workspaceRoot: params.workspaceRoot,
    },
    params.explicitOrchestrationRequirements,
  );
  const plannerStepContractDiagnostics = validatePlannerStepContracts(
    params.plannerPlan,
    params.messageText,
  );
  const verificationRequirementDiagnostics =
    params.explicitVerificationRequirements.length > 0 ||
    params.explicitVerificationCommandRequirements.length > 0
      ? validatePlannerVerificationRequirements(
          params.plannerPlan,
          params.explicitVerificationRequirements,
          params.explicitVerificationCommandRequirements,
        )
      : [];
  const structuralGraphDiagnostics = extractPlannerStructuralDiagnostics(
    [
      ...graphDiagnostics,
      ...verificationRequirementDiagnostics,
    ],
  );
  const decompositionGraphDiagnostics =
    extractPlannerDecompositionDiagnostics(structuralGraphDiagnostics);
  const requiredOrchestrationDiagnostics =
    params.explicitOrchestrationRequirements
      ? validateExplicitSubagentOrchestrationRequirements(
          params.plannerPlan,
          params.explicitOrchestrationRequirements,
        )
      : [];
  const explicitToolDiagnostics =
    params.explicitDeterministicToolRequirements
      ? validateExplicitDeterministicToolRequirements(
          params.plannerPlan,
          params.explicitDeterministicToolRequirements,
        )
      : [];
  const hasStructuralDiagnostics =
    structuralGraphDiagnostics.length > 0 ||
    requiredOrchestrationDiagnostics.length > 0 ||
    explicitToolDiagnostics.length > 0;
  const currentValidationDiagnostics = [
    ...graphDiagnostics,
    ...plannerStepContractDiagnostics,
    ...verificationRequirementDiagnostics,
    ...requiredOrchestrationDiagnostics,
    ...explicitToolDiagnostics,
  ];
  const hasOnlyStepContractDiagnostics =
    !hasStructuralDiagnostics &&
    plannerStepContractDiagnostics.length > 0;
  const structuralDiagnosticSignature =
    hasStructuralDiagnostics
      ? buildPlannerDiagnosticSignature([
          ...structuralGraphDiagnostics,
          ...requiredOrchestrationDiagnostics,
          ...explicitToolDiagnostics,
        ])
      : "";
  return {
    graphDiagnostics,
    plannerStepContractDiagnostics,
    verificationRequirementDiagnostics,
    structuralGraphDiagnostics,
    decompositionGraphDiagnostics,
    requiredOrchestrationDiagnostics,
    explicitToolDiagnostics,
    hasStructuralDiagnostics,
    currentValidationDiagnostics,
    hasOnlyStepContractDiagnostics,
    structuralDiagnosticSignature,
  };
}

// ============================================================================
// executePlannerPath (standalone)
// ============================================================================

/**
 * Execute the planner path for high-complexity turns.
 */
export async function executePlannerPath(
  ctx: ExecutionContext,
  config: PlannerExecutionConfig,
  callbacks: PlannerExecutionCallbacks,
): Promise<void> {
  ctx.plannerSummaryState.used = true;
  const plannerSections: PromptBudgetSection[] = [
    "system_anchor",
    "history",
    "user",
  ];
  const explicitOrchestrationRequirements =
    extractExplicitSubagentOrchestrationRequirements(ctx.messageText);
  const explicitDeterministicToolRequirements =
    explicitOrchestrationRequirements
      ? undefined
      : extractExplicitDeterministicToolRequirements(
          ctx.messageText,
          mergeExplicitRequirementToolNames(
            ctx.activeRoutedToolNames,
            ctx.expandedRoutedToolNames,
            config.allowedTools ? [...config.allowedTools] : [],
          ),
        );
  const explicitVerificationRequirements =
    extractPlannerVerificationRequirements(ctx.messageText);
  const explicitVerificationCommandRequirements =
    extractPlannerVerificationCommandRequirements(ctx.messageText);
  const explicitPlannerToolNames =
    explicitDeterministicToolRequirements?.orderedToolNames;
  let refinementHint: string | undefined;
  const maxStructuralPlannerRetries = Math.max(
    0,
    DEFAULT_PLANNER_MAX_REFINEMENT_ATTEMPTS - 1,
  );
  const maxPlannerStepContractRetries = Math.max(
    0,
    DEFAULT_PLANNER_MAX_STEP_CONTRACT_RETRIES,
  );
  const maxRuntimeRepairRetries =
    DEFAULT_PLANNER_MAX_RUNTIME_REPAIR_RETRIES;
  const maxPlannerDecompositionRetries = 2;
  const maxPlannerAttempts =
    1 +
    maxStructuralPlannerRetries +
    maxPlannerStepContractRetries +
    maxRuntimeRepairRetries +
    maxPlannerDecompositionRetries;
  let structuralPlannerRetriesUsed = 0;
  let plannerStepContractRetriesUsed = 0;
  let decompositionPlannerRetriesUsed = 0;
  const seenStructuralDiagnosticSignatures = new Set<string>();
  const seenRuntimeRepairFailureSignatures = new Set<string>();
  let latestPlannerValidationDiagnostics: readonly PlannerDiagnostic[] = [];
  // Cap total sub-agent spawns across all planner attempts.  Without this,
  // the planner can spawn dozens of sub-agents across refinement/retry
  // loops — each one burning 2-5 minutes.  The cap ensures the turn
  // finishes in bounded time even when every sub-agent fails validation.
  const MAX_CUMULATIVE_SUBAGENT_SPAWNS = 6;
  let cumulativeSubagentSpawns = 0;

  for (
    let plannerAttempt = 1;
    plannerAttempt <= maxPlannerAttempts;
    plannerAttempt++
  ) {
    const plannerWorkspaceRoot = resolvePlannerWorkspaceRoot(ctx, config);
    const plannerMessages = buildPlannerMessages(
      ctx.messageText,
      ctx.history,
      config.plannerMaxTokens,
      explicitDeterministicToolRequirements,
      refinementHint,
      config.resolveHostToolingProfile?.(),
      {
        maxSubagentFanout: config.delegationDecisionConfig.maxFanoutPerTurn,
        currentDelegationDepth: config.delegationNestingDepth,
        maxDelegationDepth: config.delegationDecisionConfig.maxDepth,
        childCanDelegate: config.delegationNestingDepth + 1 < config.delegationDecisionConfig.maxDepth,
      },
      plannerWorkspaceRoot,
    );
    let plannerResponse: LLMResponse | undefined;
    let plannerParseDiagnostics: readonly PlannerDiagnostic[] = [];
    let plannerPlan: PlannerPlan | undefined;
    try {
      plannerResponse = await callbacks.callModelForPhase(ctx, {
        phase: "planner",
        callMessages: plannerMessages,
        callSections: plannerSections,
        ...(explicitPlannerToolNames
          ? { routedToolNames: explicitPlannerToolNames }
          : {}),
        structuredOutput: buildPlannerStructuredOutputRequest(),
        budgetReason:
          "Planner pass blocked by max model recalls per request budget",
      });
      if (!plannerResponse) return;

      const plannerParse = normalizePlannerResponse({
        content: plannerResponse.content,
        toolCalls: plannerResponse.toolCalls,
        structuredOutput: plannerResponse.structuredOutput,
        repairRequirements: explicitOrchestrationRequirements,
        plannerWorkspaceRoot,
      });
      plannerParseDiagnostics = plannerParse.diagnostics;
      plannerPlan = plannerParse.plan;
    } catch (error) {
      const failureClass = classifyLLMFailure(error);
      if (
        canRuntimeRepairPlannerProviderFailure({
          messageText: ctx.messageText,
          workspaceRoot: plannerWorkspaceRoot,
          failureClass,
        })
      ) {
        plannerPlan = buildRuntimeRepairedPlannerProviderFailurePlan({
          messageText: ctx.messageText,
          workspaceRoot: plannerWorkspaceRoot!,
        });
        if (!plannerPlan) {
          throw error;
        }
        ctx.stopReason = "completed";
        ctx.completionState = "completed";
        ctx.stopReasonDetail = undefined;
        ctx.validationCode = undefined;
        plannerParseDiagnostics = [
          {
            category: "policy",
            code: "planner_runtime_repair_provider_unavailable",
            message:
              "Planner model was transiently unavailable; runtime promoted the request to a canonical single-owner implementation contract",
            details: {
              attempt: plannerAttempt,
              failureClass,
              providerError:
                error instanceof Error
                  ? truncateText(error.message, 240)
                  : String(error),
            },
          },
        ];
      } else {
        throw error;
      }
    }

    ctx.plannerSummaryState.plannerCalls = plannerAttempt;
    ctx.plannerSummaryState.delegationDecision = undefined;
    ctx.plannedSubagentSteps = 0;
    ctx.plannedDeterministicSteps = 0;
    ctx.plannedSynthesisSteps = 0;
    ctx.plannedFanout = 0;
    ctx.plannedDependencyDepth = 0;
    ctx.plannerSummaryState.diagnostics.push(...plannerParseDiagnostics);
    if (!plannerPlan) {
      if (explicitOrchestrationRequirements) {
        if (
          plannerAttempt < maxPlannerAttempts &&
          structuralPlannerRetriesUsed < maxStructuralPlannerRetries
        ) {
          structuralPlannerRetriesUsed++;
          refinementHint = buildExplicitSubagentOrchestrationRefinementHint(
            explicitOrchestrationRequirements,
            plannerParseDiagnostics,
          );
          ctx.plannerSummaryState.diagnostics.push({
            category: "policy",
            code: "planner_required_orchestration_retry",
            message:
              "Planner failed to emit the user-required sub-agent orchestration plan; requesting a refined plan",
            details: {
              attempt: plannerAttempt,
              nextAttempt: plannerAttempt + 1,
              maxAttempts: maxPlannerAttempts,
            },
          });
          callbacks.emitPlannerTrace(ctx, "planner_refinement_requested", {
            attempt: plannerAttempt,
            nextAttempt: plannerAttempt + 1,
            reason: "planner_required_orchestration_retry",
            routeReason: "planner_required_orchestration_unmet",
            diagnostics: plannerParseDiagnostics,
          });
          continue;
        }
        ctx.plannerSummaryState.routeReason =
          "planner_required_orchestration_unmet";
        callbacks.setStopReason(
          ctx,
          "validation_error",
          "Planner could not produce the required sub-agent orchestration plan",
        );
        ctx.finalContent = buildExplicitSubagentOrchestrationFailureMessage(
          explicitOrchestrationRequirements,
          plannerParseDiagnostics,
        );
        callbacks.emitPlannerTrace(ctx, "planner_path_finished", {
          plannerCalls: plannerAttempt,
          routeReason: ctx.plannerSummaryState.routeReason,
          stopReason: ctx.stopReason,
          stopReasonDetail: ctx.stopReasonDetail,
          diagnostics: ctx.plannerSummaryState.diagnostics,
          handled: true,
        });
        ctx.plannerHandled = true;
        return;
      }
      if (explicitDeterministicToolRequirements) {
        if (
          plannerAttempt < maxPlannerAttempts &&
          structuralPlannerRetriesUsed < maxStructuralPlannerRetries
        ) {
          structuralPlannerRetriesUsed++;
          refinementHint = buildExplicitDeterministicToolRefinementHint(
            explicitDeterministicToolRequirements,
            plannerParseDiagnostics,
          );
          ctx.plannerSummaryState.diagnostics.push({
            category: "policy",
            code: "planner_explicit_tool_parse_retry",
            message:
              "Planner failed to emit the user-required deterministic tool plan; requesting a refined plan",
            details: {
              attempt: plannerAttempt,
              nextAttempt: plannerAttempt + 1,
              maxAttempts: maxPlannerAttempts,
            },
          });
          callbacks.emitPlannerTrace(ctx, "planner_refinement_requested", {
            attempt: plannerAttempt,
            nextAttempt: plannerAttempt + 1,
            reason: "planner_explicit_tool_parse_retry",
            routeReason: "planner_explicit_tool_requirements_unmet",
            diagnostics: plannerParseDiagnostics,
          });
          continue;
        }
        ctx.plannerSummaryState.routeReason =
          "planner_explicit_tool_requirements_unmet";
        callbacks.setStopReason(
          ctx,
          "validation_error",
          "Planner could not produce the required deterministic tool plan",
        );
        ctx.finalContent = buildExplicitDeterministicToolFailureMessage(
          explicitDeterministicToolRequirements,
          plannerParseDiagnostics,
        );
        callbacks.emitPlannerTrace(ctx, "planner_path_finished", {
          plannerCalls: plannerAttempt,
          routeReason: ctx.plannerSummaryState.routeReason,
          stopReason: ctx.stopReason,
          stopReasonDetail: ctx.stopReasonDetail,
          diagnostics: ctx.plannerSummaryState.diagnostics,
          handled: true,
        });
        ctx.plannerHandled = true;
        return;
      }
      const recoverablePlannerParseDiagnostics =
        extractRecoverablePlannerParseDiagnostics(
          plannerParseDiagnostics,
        );
      if (
        recoverablePlannerParseDiagnostics.length > 0 &&
        recoverablePlannerParseDiagnostics.length ===
          plannerParseDiagnostics.length &&
        plannerAttempt < maxPlannerAttempts &&
        plannerStepContractRetriesUsed < maxPlannerStepContractRetries
      ) {
        plannerStepContractRetriesUsed++;
        refinementHint = buildPlannerParseRefinementHint(
          recoverablePlannerParseDiagnostics,
        );
        ctx.plannerSummaryState.diagnostics.push({
          category: "policy",
          code: "planner_parse_contract_retry",
          message:
            "Planner emitted recoverable parse issues; requesting a refined plan",
          details: {
            attempt: plannerAttempt,
            nextAttempt: plannerAttempt + 1,
            maxAttempts: maxPlannerAttempts,
          },
        });
        callbacks.emitPlannerTrace(ctx, "planner_refinement_requested", {
          attempt: plannerAttempt,
          nextAttempt: plannerAttempt + 1,
          reason: "planner_parse_contract_retry",
          routeReason: "planner_parse_failed",
          diagnostics: recoverablePlannerParseDiagnostics,
        });
        continue;
      }
      ctx.plannerSummaryState.routeReason = "planner_parse_failed";
      callbacks.emitPlannerTrace(ctx, "planner_path_finished", {
        plannerCalls: plannerAttempt,
        routeReason: ctx.plannerSummaryState.routeReason,
        stopReason: ctx.stopReason,
        stopReasonDetail: ctx.stopReasonDetail,
        diagnostics: ctx.plannerSummaryState.diagnostics,
        handled: false,
      });
      return;
    }

    const salvagedToolPlanDiagnostics = validateSalvagedPlannerToolPlan({
      plannerPlan,
      messageText: ctx.messageText,
      history: ctx.history,
      explicitDeterministicRequirements: explicitDeterministicToolRequirements,
    });
    if (salvagedToolPlanDiagnostics.length > 0) {
      ctx.plannerSummaryState.diagnostics.push(...salvagedToolPlanDiagnostics);
      if (
        plannerAttempt < maxPlannerAttempts &&
        structuralPlannerRetriesUsed < maxStructuralPlannerRetries
      ) {
        structuralPlannerRetriesUsed++;
        refinementHint = buildSalvagedPlannerToolCallRefinementHint(
          salvagedToolPlanDiagnostics,
        );
        ctx.plannerSummaryState.diagnostics.push({
          category: "policy",
          code: "planner_salvaged_tool_call_retry",
          message:
            "Planner emitted raw tool calls that under-decomposed the request; requesting a refined JSON plan",
          details: {
            attempt: plannerAttempt,
            nextAttempt: plannerAttempt + 1,
            maxAttempts: maxPlannerAttempts,
          },
        });
        callbacks.emitPlannerTrace(ctx, "planner_refinement_requested", {
          attempt: plannerAttempt,
          nextAttempt: plannerAttempt + 1,
          reason: "planner_salvaged_tool_call_retry",
          routeReason: "planner_parse_failed",
          diagnostics: salvagedToolPlanDiagnostics,
        });
        continue;
      }
      ctx.plannerSummaryState.routeReason = "planner_parse_failed";
      callbacks.emitPlannerTrace(ctx, "planner_path_finished", {
        plannerCalls: plannerAttempt,
        routeReason: ctx.plannerSummaryState.routeReason,
        stopReason: ctx.stopReason,
        stopReasonDetail: ctx.stopReasonDetail,
        diagnostics: ctx.plannerSummaryState.diagnostics,
        handled: false,
      });
      return;
    }

    let validationState = evaluatePlannerValidationState({
      plannerPlan,
      messageText: ctx.messageText,
      workspaceRoot: plannerWorkspaceRoot,
      delegationConfig: config.delegationDecisionConfig,
      explicitOrchestrationRequirements,
      explicitDeterministicToolRequirements,
      explicitVerificationRequirements,
      explicitVerificationCommandRequirements,
    });
    latestPlannerValidationDiagnostics =
      validationState.currentValidationDiagnostics;
    const canUseProgressStructuralRetry =
      validationState.hasStructuralDiagnostics &&
      structuralPlannerRetriesUsed >= maxStructuralPlannerRetries &&
      plannerAttempt < maxPlannerAttempts &&
      validationState.structuralDiagnosticSignature.length > 0 &&
      !seenStructuralDiagnosticSignatures.has(
        validationState.structuralDiagnosticSignature,
      );
    const hasOnlyDecompositionStructuralDiagnostics =
      validationState.decompositionGraphDiagnostics.length > 0 &&
      validationState.decompositionGraphDiagnostics.length ===
        validationState.structuralGraphDiagnostics.length &&
      validationState.plannerStepContractDiagnostics.length === 0 &&
      validationState.verificationRequirementDiagnostics.length === 0 &&
      validationState.requiredOrchestrationDiagnostics.length === 0 &&
      validationState.explicitToolDiagnostics.length === 0;
    const canUseDecompositionRetry =
      hasOnlyDecompositionStructuralDiagnostics &&
      decompositionPlannerRetriesUsed < maxPlannerDecompositionRetries &&
      plannerAttempt < maxPlannerAttempts;
    const shouldRefinePlan =
      (
        validationState.structuralGraphDiagnostics.length > 0 ||
        validationState.plannerStepContractDiagnostics.length > 0 ||
        validationState.verificationRequirementDiagnostics.length > 0 ||
        validationState.requiredOrchestrationDiagnostics.length > 0 ||
        validationState.explicitToolDiagnostics.length > 0
      ) &&
      plannerAttempt < maxPlannerAttempts &&
      (
        (
          validationState.hasOnlyStepContractDiagnostics &&
          plannerStepContractRetriesUsed < maxPlannerStepContractRetries
        ) ||
        structuralPlannerRetriesUsed < maxStructuralPlannerRetries ||
        canUseProgressStructuralRetry ||
        canUseDecompositionRetry
      );
    if (
      validationState.graphDiagnostics.length > 0 ||
      validationState.plannerStepContractDiagnostics.length > 0 ||
      validationState.verificationRequirementDiagnostics.length > 0 ||
      validationState.requiredOrchestrationDiagnostics.length > 0 ||
      validationState.explicitToolDiagnostics.length > 0
    ) {
      ctx.plannerSummaryState.diagnostics.push(...validationState.graphDiagnostics);
      ctx.plannerSummaryState.diagnostics.push(
        ...validationState.plannerStepContractDiagnostics,
      );
      ctx.plannerSummaryState.diagnostics.push(
        ...validationState.verificationRequirementDiagnostics,
      );
      ctx.plannerSummaryState.diagnostics.push(
        ...validationState.requiredOrchestrationDiagnostics,
      );
      ctx.plannerSummaryState.diagnostics.push(
        ...validationState.explicitToolDiagnostics,
      );
      if (shouldRefinePlan) {
        if (
          validationState.hasOnlyStepContractDiagnostics &&
          plannerStepContractRetriesUsed < maxPlannerStepContractRetries
        ) {
          plannerStepContractRetriesUsed++;
        } else if (structuralPlannerRetriesUsed < maxStructuralPlannerRetries) {
          structuralPlannerRetriesUsed++;
        } else if (canUseDecompositionRetry) {
          decompositionPlannerRetriesUsed++;
        }
        if (validationState.structuralDiagnosticSignature.length > 0) {
          seenStructuralDiagnosticSignatures.add(
            validationState.structuralDiagnosticSignature,
          );
        }
        const refinementHints: string[] = [];
        if (validationState.structuralGraphDiagnostics.length > 0) {
          refinementHints.push(
            buildPlannerStructuralRefinementHint(
              validationState.structuralGraphDiagnostics,
            ),
          );
        }
        if (validationState.plannerStepContractDiagnostics.length > 0) {
          refinementHints.push(
            buildPlannerStepContractRefinementHint(
              validationState.plannerStepContractDiagnostics,
            ),
          );
        }
        if (validationState.verificationRequirementDiagnostics.length > 0) {
          refinementHints.push(
            buildPlannerVerificationRequirementsRefinementHint(
              explicitVerificationRequirements,
              validationState.verificationRequirementDiagnostics,
            ),
          );
        }
        if (validationState.requiredOrchestrationDiagnostics.length > 0) {
          refinementHints.push(
            buildExplicitSubagentOrchestrationRefinementHint(
              explicitOrchestrationRequirements!,
              validationState.requiredOrchestrationDiagnostics,
            ),
          );
        }
        if (validationState.explicitToolDiagnostics.length > 0) {
          refinementHints.push(
            buildExplicitDeterministicToolRefinementHint(
              explicitDeterministicToolRequirements!,
              validationState.explicitToolDiagnostics,
            ),
          );
        }
        refinementHint = refinementHints.join(" ");
        const plannerRetryCode =
          validationState.requiredOrchestrationDiagnostics.length > 0
            ? "planner_required_orchestration_retry"
            : validationState.explicitToolDiagnostics.length > 0
              ? "planner_explicit_tool_retry"
              : validationState.verificationRequirementDiagnostics.length > 0
                ? "planner_verification_requirements_retry"
              : validationState.plannerStepContractDiagnostics.length > 0
                ? "planner_step_contract_retry"
              : "planner_refinement_retry";
        const plannerRetryMessage =
          validationState.requiredOrchestrationDiagnostics.length > 0
            ? "Planner did not satisfy the user-required sub-agent orchestration plan; requesting a refined plan"
            : validationState.explicitToolDiagnostics.length > 0
              ? "Planner drifted outside the explicitly requested deterministic tool contract; requesting a refined plan"
              : validationState.verificationRequirementDiagnostics.length > 0
                ? "Planner dropped one or more user-requested verification modes; requesting a refined plan"
              : validationState.plannerStepContractDiagnostics.length > 0
                ? "Planner emitted steps that violate runtime tool contracts; requesting a refined plan"
              : "Planner emitted structural delegation violations; requesting a refined plan";
        ctx.plannerSummaryState.diagnostics.push({
          category: "policy",
          code: plannerRetryCode,
          message: plannerRetryMessage,
          details: {
            attempt: plannerAttempt,
            nextAttempt: plannerAttempt + 1,
              maxAttempts: maxPlannerAttempts,
              progressRetry: canUseProgressStructuralRetry ? "true" : "false",
              decompositionRetry: canUseDecompositionRetry ? "true" : "false",
            },
          });
        callbacks.emitPlannerTrace(ctx, "planner_refinement_requested", {
          attempt: plannerAttempt,
          nextAttempt: plannerAttempt + 1,
          reason: plannerRetryCode,
          graphDiagnostics: validationState.graphDiagnostics,
          decompositionGraphDiagnostics:
            validationState.decompositionGraphDiagnostics,
          plannerStepContractDiagnostics:
            validationState.plannerStepContractDiagnostics,
          verificationRequirementDiagnostics:
            validationState.verificationRequirementDiagnostics,
          requestedVerificationCategories: explicitVerificationRequirements,
          requestedVerificationCommands: explicitVerificationCommandRequirements,
          requiredOrchestrationDiagnostics:
            validationState.requiredOrchestrationDiagnostics,
          explicitToolDiagnostics: validationState.explicitToolDiagnostics,
          decompositionRetry: canUseDecompositionRetry,
        });
        continue;
      }
      const repairedPlannerPlan = canRuntimeRepairImplementFromArtifactPlan({
        plannerPlan,
        diagnostics: validationState.currentValidationDiagnostics,
        messageText: ctx.messageText,
        workspaceRoot: plannerWorkspaceRoot,
      })
        ? buildRuntimeRepairedImplementFromArtifactPlan({
            plannerPlan,
            messageText: ctx.messageText,
            workspaceRoot: plannerWorkspaceRoot!,
          })
        : undefined;
      if (repairedPlannerPlan) {
        const repairedFromStepCount = plannerPlan.steps.length;
        plannerPlan = repairedPlannerPlan;
        ctx.plannerSummaryState.diagnostics.push({
          category: "policy",
          code: "planner_runtime_repair_single_owner_contract",
          message:
            "Planner collapsed an implement-from-artifact request into read-only inspection; runtime promoted it to a canonical single-owner implementation contract",
          details: {
            attempt: plannerAttempt,
            repairedFromStepCount,
            repairedToStepCount: repairedPlannerPlan.steps.length,
            ...(plannerWorkspaceRoot
              ? { workspaceRoot: plannerWorkspaceRoot }
              : {}),
          },
        });
        validationState = evaluatePlannerValidationState({
          plannerPlan,
          messageText: ctx.messageText,
          workspaceRoot: plannerWorkspaceRoot,
          delegationConfig: config.delegationDecisionConfig,
          explicitOrchestrationRequirements,
          explicitDeterministicToolRequirements,
          explicitVerificationRequirements,
          explicitVerificationCommandRequirements,
        });
        latestPlannerValidationDiagnostics =
          validationState.currentValidationDiagnostics;
        if (
          validationState.currentValidationDiagnostics.length === 0 &&
          plannerPlan.reason
        ) {
          ctx.plannerSummaryState.routeReason = plannerPlan.reason;
        }
      }
      if (validationState.currentValidationDiagnostics.length === 0) {
        latestPlannerValidationDiagnostics = [];
      } else if (validationState.requiredOrchestrationDiagnostics.length > 0) {
        ctx.plannerSummaryState.routeReason =
          "planner_required_orchestration_unmet";
        callbacks.setStopReason(
          ctx,
          "validation_error",
          "Planner did not satisfy the user-required sub-agent orchestration plan",
        );
        ctx.finalContent = buildExplicitSubagentOrchestrationFailureMessage(
          explicitOrchestrationRequirements!,
          validationState.requiredOrchestrationDiagnostics,
        );
        callbacks.emitPlannerTrace(ctx, "planner_path_finished", {
          plannerCalls: plannerAttempt,
          routeReason: ctx.plannerSummaryState.routeReason,
          stopReason: ctx.stopReason,
          stopReasonDetail: ctx.stopReasonDetail,
          diagnostics: ctx.plannerSummaryState.diagnostics,
          handled: true,
        });
        ctx.plannerHandled = true;
        return;
      } else if (validationState.verificationRequirementDiagnostics.length > 0) {
        ctx.plannerSummaryState.routeReason =
          "planner_verification_requirements_unmet";
        callbacks.setStopReason(
          ctx,
          "validation_error",
          "Planner did not preserve the user-requested verification coverage",
        );
        ctx.finalContent =
          buildPlannerVerificationRequirementsFailureMessage(
            explicitVerificationRequirements,
            validationState.verificationRequirementDiagnostics,
          );
        callbacks.emitPlannerTrace(ctx, "planner_path_finished", {
          plannerCalls: plannerAttempt,
          routeReason: ctx.plannerSummaryState.routeReason,
          stopReason: ctx.stopReason,
          stopReasonDetail: ctx.stopReasonDetail,
          diagnostics: ctx.plannerSummaryState.diagnostics,
          handled: true,
        });
        ctx.plannerHandled = true;
        return;
      } else if (validationState.explicitToolDiagnostics.length > 0) {
        ctx.plannerSummaryState.routeReason =
          "planner_explicit_tool_requirements_unmet";
        callbacks.setStopReason(
          ctx,
          "validation_error",
          "Planner did not satisfy the user-required deterministic tool plan",
        );
        ctx.finalContent = buildExplicitDeterministicToolFailureMessage(
          explicitDeterministicToolRequirements!,
          validationState.explicitToolDiagnostics,
        );
        callbacks.emitPlannerTrace(ctx, "planner_path_finished", {
          plannerCalls: plannerAttempt,
          routeReason: ctx.plannerSummaryState.routeReason,
          stopReason: ctx.stopReason,
          stopReasonDetail: ctx.stopReasonDetail,
          diagnostics: ctx.plannerSummaryState.diagnostics,
          handled: true,
        });
        ctx.plannerHandled = true;
        return;
      } else {
        ctx.plannerSummaryState.routeReason =
          validationState.explicitToolDiagnostics.length > 0
            ? "planner_explicit_tool_requirements_unmet"
            : "planner_validation_failed";
      }
    } else if (plannerPlan.reason) {
      ctx.plannerSummaryState.routeReason = plannerPlan.reason;
    }

    callbacks.emitPlannerTrace(ctx, "planner_plan_parsed", {
      attempt: plannerAttempt,
      routeReason: ctx.plannerSummaryState.routeReason,
      requiresSynthesis: plannerPlan.requiresSynthesis === true,
      totalSteps: plannerPlan.steps.length,
      deterministicSteps: plannerPlan.steps.filter((step) =>
        step.stepType === "deterministic_tool"
      ).length,
      subagentSteps: plannerPlan.steps.filter((step) =>
        step.stepType === "subagent_task"
      ).length,
      synthesisSteps: plannerPlan.steps.filter((step) =>
        step.stepType === "synthesis"
      ).length,
      graphDiagnostics: validationState.graphDiagnostics,
      plannerStepContractDiagnostics:
        validationState.plannerStepContractDiagnostics,
      verificationRequirementDiagnostics:
        validationState.verificationRequirementDiagnostics,
      requestedVerificationCategories: explicitVerificationRequirements,
      requiredOrchestrationDiagnostics:
        validationState.requiredOrchestrationDiagnostics,
      explicitToolDiagnostics: validationState.explicitToolDiagnostics,
      steps: plannerPlan.steps.map((step) => ({ ...step })),
      edges: plannerPlan.edges.map((edge) => ({ ...edge })),
    });

    ctx.plannerSummaryState.plannedSteps = plannerPlan.steps.length;
    ctx.plannedSubagentSteps = plannerPlan.steps.filter(
      (step) => step.stepType === "subagent_task",
    ).length;
    ctx.plannedDeterministicSteps = plannerPlan.steps.filter(
      (step) => step.stepType === "deterministic_tool",
    ).length;
    ctx.plannedSynthesisSteps = plannerPlan.steps.filter(
      (step) => step.stepType === "synthesis",
    ).length;
    ctx.plannedFanout = ctx.plannedSubagentSteps;
    ctx.plannedDependencyDepth = computePlannerGraphDepth(
      plannerPlan.steps.map((step) => step.name),
      plannerPlan.edges,
    ).maxDepth;

    const subagentSteps = plannerPlan.steps.filter(
      (step): step is PlannerSubAgentTaskStepIntent =>
        step.stepType === "subagent_task",
    );
    const requiredSubagentOutputStepNames =
      resolveTypedRequiredSubagentOutputStepNames({
        plannerPlan,
        requirements: explicitOrchestrationRequirements,
        candidates: subagentSteps,
      });
    let delegationDecision: ReturnType<
      typeof assessAndRecordDelegationDecision
    > | undefined;
    if (subagentSteps.length > 0) {
      const highRiskPlan = isHighRiskSubagentPlan(subagentSteps);
      ctx.trajectoryContextClusterId = deriveDelegationContextClusterId({
        complexityScore: ctx.plannerDecision.score,
        subagentStepCount: subagentSteps.length,
        hasHistory: ctx.hasHistory,
        highRiskPlan,
      });

      const banditResult = resolveDelegationBanditArm(
        config.delegationBanditTuner,
        ctx.trajectoryContextClusterId,
        config.delegationDefaultStrategyArmId,
        ctx.baseDelegationThreshold,
      );
      ctx.selectedBanditArm = banditResult.selectedArm;
      ctx.tunedDelegationThreshold = banditResult.tunedThreshold;
      ctx.plannerSummaryState.delegationPolicyTuning = banditResult.policyTuning;

      delegationDecision = assessAndRecordDelegationDecision(
        {
          messageText: ctx.messageText,
          plannerPlan,
          subagentSteps,
          complexityScore: ctx.plannerDecision.score,
          tunedThreshold: ctx.tunedDelegationThreshold,
          budgetSnapshot: ctx.delegationBudgetSnapshot,
          delegationConfig: config.delegationDecisionConfig,
        },
        ctx.plannerSummaryState,
      );
      if (
        explicitOrchestrationRequirements &&
        delegationDecision &&
        !delegationDecision.shouldDelegate
      ) {
        delegationDecision = {
          ...delegationDecision,
          shouldDelegate: true,
          reason: "approved",
        };
        ctx.plannerSummaryState.diagnostics.push({
          category: "policy",
          code: "delegation_required_by_user",
          message:
            "User explicitly required sub-agent orchestration; bypassing delegation utility veto",
          details: {
            requiredSteps:
              explicitOrchestrationRequirements.stepNames.join(","),
          },
        });
      }
    }
    const deterministicSteps = plannerPlan.steps.filter(
      (step): step is PlannerDeterministicToolStepIntent =>
        step.stepType === "deterministic_tool",
    );
    const hasSynthesisStep = plannerPlan.steps.some(
      (step) => step.stepType === "synthesis",
    );
    const plannerPipelineSteps = mapPlannerStepsToPipelineSteps(
      plannerPlan.steps,
    );
    const plannerExecutionContext = buildPlannerExecutionContext(
      ctx.messageText,
      ctx.history,
      ctx.messages,
      ctx.messageSections,
      ctx.stateful?.artifactContext?.artifactRefs,
      plannerWorkspaceRoot,
      ctx.expandedRoutedToolNames.length > 0
        ? ctx.expandedRoutedToolNames
        : ctx.activeRoutedToolNames.length > 0
        ? ctx.activeRoutedToolNames
        : (config.allowedTools ? [...config.allowedTools] : undefined),
    );
    const plannerImplementationFallbackBlocked =
      subagentSteps.length > 0 &&
      shouldBlockPlannerImplementationFallback(
        subagentSteps,
        deterministicSteps,
      );
    ctx.plannerImplementationFallbackBlocked =
      plannerImplementationFallbackBlocked;
    const planArtifactExecutionRequest = plannerRequestImplementsFromArtifact(
      ctx.messageText,
    );
    const delegationVetoReason = delegationDecision?.reason;
    const shouldRefineDelegationVeto =
      planArtifactExecutionRequest &&
      subagentSteps.length > 0 &&
      plannerImplementationFallbackBlocked &&
      delegationDecision?.shouldDelegate === false &&
      plannerAttempt < maxPlannerAttempts &&
      typeof delegationVetoReason === "string" &&
      canRefinePlannerDelegationVeto(delegationVetoReason);
    if (shouldRefineDelegationVeto && delegationVetoReason) {
      refinementHint = buildPlannerDelegationVetoRefinementHint(
        delegationVetoReason,
      );
      ctx.plannerSummaryState.diagnostics.push({
        category: "policy",
        code: "planner_delegation_veto_retry",
        message:
          "Runtime delegation admission rejected the previous implementation plan; requesting a refined single-owner plan",
        details: {
          attempt: plannerAttempt,
          nextAttempt: plannerAttempt + 1,
          reason: delegationVetoReason,
        },
      });
      callbacks.emitPlannerTrace(ctx, "planner_refinement_requested", {
        attempt: plannerAttempt,
        nextAttempt: plannerAttempt + 1,
        reason: "planner_delegation_veto_retry",
        delegationDecision,
        plannerImplementationFallbackBlocked: true,
      });
      continue;
    }
    const hasExecutablePlannerSteps =
      (
        deterministicSteps.length > 0 &&
        (
          subagentSteps.length === 0 ||
          delegationDecision?.shouldDelegate === true
        )
      ) ||
      (
        subagentSteps.length > 0 &&
        delegationDecision?.shouldDelegate === true
      );

    if (
      hasExecutablePlannerSteps &&
      ctx.plannerSummaryState.routeReason !== "planner_validation_failed" &&
      ctx.plannerSummaryState.routeReason !==
        "planner_explicit_tool_requirements_unmet"
    ) {
      if (isRuntimeLimitExceeded(deterministicSteps.length, ctx.effectiveToolBudget)) {
        callbacks.setStopReason(
          ctx,
          "budget_exceeded",
          `Planner produced ${deterministicSteps.length} deterministic steps but tool budget is ${ctx.effectiveToolBudget}`,
        );
        ctx.finalContent =
          `Planned ${deterministicSteps.length} deterministic steps, ` +
          `but request tool budget is ${ctx.effectiveToolBudget}.`;
        callbacks.emitPlannerTrace(ctx, "planner_path_finished", {
          plannerCalls: plannerAttempt,
          routeReason: ctx.plannerSummaryState.routeReason,
          stopReason: ctx.stopReason,
          stopReasonDetail: ctx.stopReasonDetail,
          diagnostics: ctx.plannerSummaryState.diagnostics,
          handled: true,
        });
        ctx.plannerHandled = true;
        return;
      }

      const pipeline: Pipeline = {
        id: `planner:${ctx.sessionId}:${Date.now()}`,
        requestTreeBudgetKey: `planner:${ctx.sessionId}:${ctx.startTime}`,
        createdAt: Date.now(),
        context: { results: {} },
        steps: deterministicSteps.map((step) => ({
          name: step.name,
          tool: step.tool,
          args: step.args,
          onError: step.onError,
          maxRetries: step.maxRetries,
        })),
        plannerSteps: plannerPipelineSteps,
        edges: plannerPlan.edges,
        maxParallelism: config.delegationDecisionConfig.maxFanoutPerTurn,
        plannerContext: plannerExecutionContext,
      };

      callbacks.emitPlannerTrace(ctx, "planner_pipeline_started", {
        attempt: plannerAttempt,
        pipelineId: pipeline.id,
        requestTreeBudgetKey: pipeline.requestTreeBudgetKey,
        routeReason: ctx.plannerSummaryState.routeReason,
        deterministicSteps: deterministicSteps.map((step) => ({
          name: step.name,
          tool: step.tool,
          onError: step.onError ?? "abort",
          maxRetries: step.maxRetries ?? 0,
        })),
        delegatedSteps: subagentSteps.map((step) => step.name),
      });

      const plannerWorkflowAdmission = buildPlannerWorkflowAdmission({
        subagentSteps,
        deterministicSteps,
        workflowContract: plannerPlan.workflowContract,
        workspaceRoot: plannerExecutionContext?.workspaceRoot,
        verificationContract: ctx.requiredToolEvidence?.verificationContract,
        completionContract: ctx.requiredToolEvidence?.completionContract,
        includeSubagentOutputVerification:
          config.subagentVerifierConfig.enabled ||
          config.subagentVerifierConfig.force,
        requiredSubagentOutputStepNames,
      });
      ctx.plannerWorkflowTaskClassification =
        plannerWorkflowAdmission.taskClassification;
      ctx.plannerVerificationContract =
        plannerWorkflowAdmission.verificationContract;
      ctx.plannerCompletionContract =
        plannerWorkflowAdmission.completionContract;
      if (plannerWorkflowAdmission.taskClassification === "invalid") {
        callbacks.setStopReason(
          ctx,
          "validation_error",
          plannerWorkflowAdmission.invalidReason ??
            "Planner could not materialize a runtime-owned workflow contract for implementation-class work.",
        );
        ctx.finalContent =
          plannerWorkflowAdmission.invalidReason ??
          "Planner could not materialize a runtime-owned workflow contract for implementation-class work.";
        callbacks.emitPlannerTrace(ctx, "planner_path_finished", {
          plannerCalls: plannerAttempt,
          routeReason: ctx.plannerSummaryState.routeReason,
          stopReason: ctx.stopReason,
          stopReasonDetail: ctx.stopReasonDetail,
          diagnostics: ctx.plannerSummaryState.diagnostics,
          handled: true,
          taskClassification: plannerWorkflowAdmission.taskClassification,
        });
        ctx.plannerHandled = true;
        return;
      }
      const plannerVerifierAdmission = buildPlannerVerifierAdmission({
        subagentSteps,
        deterministicSteps,
        workflowContract: plannerPlan.workflowContract,
        workspaceRoot: plannerExecutionContext?.workspaceRoot,
        verificationContract: plannerWorkflowAdmission.verificationContract,
        completionContract: plannerWorkflowAdmission.completionContract,
        includeSubagentOutputVerification:
          config.subagentVerifierConfig.enabled ||
          config.subagentVerifierConfig.force,
        requiredSubagentOutputStepNames,
      });
      const shouldRunPlannerVerifier =
        plannerVerifierAdmission.verifierWorkItems.length > 0 &&
        (
          (
            plannerVerifierAdmission.requiresMandatoryImplementationVerification ||
            (
              subagentSteps.length > 0 &&
              delegationDecision?.shouldDelegate === true
            )
          ) &&
          (
            config.subagentVerifierConfig.enabled ||
            config.subagentVerifierConfig.force
          )
        );
      const {
        verifierRounds,
        verificationDecision,
        pipelineResult,
      } = await executePlannerPipelineWithVerifierLoop({
        pipeline,
        plannerPlan,
        verifierWorkItems: plannerVerifierAdmission.verifierWorkItems,
        deterministicSteps,
        plannerExecutionContext,
        shouldRunPlannerVerifier,
        requiresMandatoryImplementationVerification:
          plannerVerifierAdmission.requiresMandatoryImplementationVerification,
        requiresMandatorySubagentOutputVerification:
          plannerVerifierAdmission.requiresMandatorySubagentOutputVerification,
        verifierConfig: config.subagentVerifierConfig,
        plannerSummaryState: ctx.plannerSummaryState,
        checkRequestTimeout: (stage: string) => callbacks.checkRequestTimeout(ctx, stage),
        runPipelineWithGlobalTimeout: (p: Pipeline) => callbacks.runPipelineWithTimeout(ctx, p),
        runPlannerVerifierRound: (input) =>
          runSubagentVerifierRound({
            systemPrompt: ctx.systemPrompt,
            messageText: ctx.messageText,
            sessionId: ctx.sessionId,
            stateful: ctx.stateful,
            plannerDiagnostics: ctx.plannerSummaryState.diagnostics,
            plannerPlan: input.plannerPlan,
            verifierWorkItems: input.verifierWorkItems,
            pipelineResult: input.pipelineResult,
            plannerToolCalls: input.plannerToolCalls,
            plannerContext: input.plannerContext,
            round: input.round,
            requiresMandatoryImplementationVerification:
              input.requiresMandatoryImplementationVerification,
            callModelForPhase: (phaseInput) => callbacks.callModelForPhase(ctx, phaseInput),
          }),
        onVerifierRoundFinished: (payload) =>
          callbacks.emitPlannerTrace(
            ctx,
            "planner_verifier_round_finished",
            payload,
          ),
        onVerifierRetryScheduled: (payload) =>
          callbacks.emitPlannerTrace(
            ctx,
            "planner_verifier_retry_scheduled",
            payload,
          ),
        appendToolRecord: (record: ToolCallRecord) => callbacks.appendToolRecord(ctx, record),
        setStopReason: (reason: LLMPipelineStopReason, detail?: string) => callbacks.setStopReason(ctx, reason, detail),
      });

      // Track cumulative sub-agent spawns across all planner attempts.
      cumulativeSubagentSpawns += pipelineResult?.totalSteps ?? 0;
      if (
        cumulativeSubagentSpawns >= MAX_CUMULATIVE_SUBAGENT_SPAWNS &&
        pipelineResult?.status !== "completed"
      ) {
        ctx.plannerSummaryState.diagnostics.push({
          category: "policy",
          code: "planner_cumulative_spawn_cap_reached",
          message:
            `Planner exhausted the cumulative sub-agent spawn cap (${MAX_CUMULATIVE_SUBAGENT_SPAWNS}) without completing all steps. ` +
            "Returning the best partial result instead of re-planning.",
          details: {
            cumulativeSpawns: cumulativeSubagentSpawns,
            cap: MAX_CUMULATIVE_SUBAGENT_SPAWNS,
            plannerAttempt,
          },
        });
        callbacks.emitPlannerTrace(ctx, "planner_pipeline_finished", {
          attempt: plannerAttempt,
          pipelineId: pipeline.id,
          status: pipelineResult?.status ?? "failed",
          completionState: pipelineResult?.completionState,
          completedSteps: pipelineResult?.completedSteps ?? 0,
          totalSteps: pipelineResult?.totalSteps ?? 0,
          cumulativeSubagentSpawns,
          capReached: true,
        });
        break;
      }

      if (
        shouldRunPlannerVerifier &&
        verifierRounds === 0 &&
        !ctx.plannerSummaryState.subagentVerification.performed
      ) {
        ctx.plannerSummaryState.subagentVerification = {
          enabled: true,
          performed: false,
          rounds: 0,
          overall: "skipped",
          confidence: 1,
          unresolvedItems: [],
        };
      }

      if (
        pipelineResult?.decomposition &&
        plannerAttempt < maxPlannerAttempts &&
        structuralPlannerRetriesUsed < maxStructuralPlannerRetries
      ) {
        structuralPlannerRetriesUsed++;
        refinementHint = buildPipelineDecompositionRefinementHint(
          pipelineResult.decomposition,
        );
        ctx.plannerSummaryState.diagnostics.push({
          category: "policy",
          code: "planner_runtime_refinement_retry",
          message:
            "Delegated execution requested parent-side decomposition; replanning with smaller steps",
          details: {
            attempt: plannerAttempt,
            nextAttempt: plannerAttempt + 1,
            maxAttempts: maxPlannerAttempts,
          },
        });
        callbacks.emitPlannerTrace(ctx, "planner_pipeline_finished", {
          attempt: plannerAttempt,
          pipelineId: pipeline.id,
          status: pipelineResult.status,
          completionState: pipelineResult.completionState,
          completedSteps: pipelineResult.completedSteps,
          totalSteps: pipelineResult.totalSteps,
          decomposition: pipelineResult.decomposition,
          verificationDecision,
        });
        callbacks.emitPlannerTrace(ctx, "planner_refinement_requested", {
          attempt: plannerAttempt,
          nextAttempt: plannerAttempt + 1,
          reason: "planner_runtime_refinement_retry",
          decomposition: pipelineResult.decomposition,
        });
        continue;
      }

      const runtimeRepairFailureSignature = pipelineResult
        ? buildPipelineFailureSignature(pipelineResult)
        : undefined;
      const runtimeRepairSignatureSeen =
        runtimeRepairFailureSignature !== undefined &&
        seenRuntimeRepairFailureSignatures.has(runtimeRepairFailureSignature);
      const shouldRetryFailedPipelineWithRepairPlan =
        pipelineResult?.status === "failed" &&
        plannerAttempt < maxPlannerAttempts &&
        pipelineResult.completedSteps > 0 &&
        !runtimeRepairSignatureSeen &&
        (
          pipelineResult.stopReasonHint === "tool_error" ||
          pipelineResult.stopReasonHint === "validation_error" ||
          pipelineResult.stopReasonHint === "no_progress" ||
          pipelineResult.stopReasonHint === undefined
        );

      if (
        pipelineResult &&
        shouldRetryFailedPipelineWithRepairPlan
      ) {
        if (runtimeRepairFailureSignature) {
          seenRuntimeRepairFailureSignatures.add(runtimeRepairFailureSignature);
        }
        const plannerToolCalls = pipelineResultToToolCalls(
          plannerPlan.steps,
          pipelineResult,
        );
        refinementHint = buildPipelineFailureRepairRefinementHint({
          pipelineResult,
          plannerPlan,
          plannerToolCalls,
        });
        ctx.plannerSummaryState.diagnostics.push({
          category: "policy",
          code: "planner_runtime_repair_retry",
          message:
            "Deterministic verification failed after partial planner execution; requesting a repair-focused replan",
          details: {
            attempt: plannerAttempt,
            nextAttempt: plannerAttempt + 1,
            maxAttempts: maxPlannerAttempts,
            completedSteps: pipelineResult.completedSteps,
            totalSteps: pipelineResult.totalSteps,
            stopReasonHint: pipelineResult.stopReasonHint ?? "tool_error",
          },
        });
        callbacks.emitPlannerTrace(ctx, "planner_pipeline_finished", {
          attempt: plannerAttempt,
          pipelineId: pipeline.id,
          status: pipelineResult.status,
          completionState: pipelineResult.completionState,
          completedSteps: pipelineResult.completedSteps,
          totalSteps: pipelineResult.totalSteps,
          error: pipelineResult.error,
          stopReasonHint: pipelineResult.stopReasonHint,
          decomposition: pipelineResult.decomposition,
          verificationDecision,
        });
        callbacks.emitPlannerTrace(ctx, "planner_refinement_requested", {
          attempt: plannerAttempt,
          nextAttempt: plannerAttempt + 1,
          reason: "planner_runtime_repair_retry",
          stopReasonHint: pipelineResult.stopReasonHint,
          error: pipelineResult.error,
          completedSteps: pipelineResult.completedSteps,
          totalSteps: pipelineResult.totalSteps,
        });
        continue;
      }

      if (pipelineResult && runtimeRepairSignatureSeen) {
        ctx.plannerSummaryState.diagnostics.push({
          category: "policy",
          code: "planner_runtime_repair_stalled",
          message:
            "Deterministic verification repeated the same failure signature after a repair-focused replan; stopping additional repair retries",
          details: {
            attempt: plannerAttempt,
            completedSteps: pipelineResult.completedSteps,
            totalSteps: pipelineResult.totalSteps,
            stopReasonHint: pipelineResult.stopReasonHint ?? "tool_error",
          },
        });
      }

      if (pipelineResult) {
        callbacks.emitPlannerTrace(ctx, "planner_pipeline_finished", {
          attempt: plannerAttempt,
          pipelineId: pipeline.id,
          status: pipelineResult.status,
          completionState: pipelineResult.completionState,
          completedSteps: pipelineResult.completedSteps,
          totalSteps: pipelineResult.totalSteps,
          error: pipelineResult.error,
          stopReasonHint: pipelineResult.stopReasonHint,
          decomposition: pipelineResult.decomposition,
          verificationDecision,
        });
      } else {
        callbacks.emitPlannerTrace(ctx, "planner_pipeline_finished", {
          attempt: plannerAttempt,
          pipelineId: pipeline.id,
          status: "timeout",
          stopReason: ctx.stopReason,
          stopReasonDetail: ctx.stopReasonDetail,
          verificationDecision,
        });
      }

      if (pipelineResult) {
        ctx.completedRequestMilestoneIds = Object.keys(
          pipelineResult.context.results,
        );
        if (pipelineResult.status === "failed") {
          const hintedStopReason = isPipelineStopReasonHint(
            pipelineResult.stopReasonHint,
          )
            ? pipelineResult.stopReasonHint
            : "tool_error";
          callbacks.setStopReason(
            ctx,
            hintedStopReason,
            pipelineResult.error ??
              "Deterministic pipeline execution failed",
          );
        } else if (pipelineResult.status === "halted") {
          callbacks.setStopReason(
            ctx,
            "tool_calls",
            `Deterministic pipeline halted at step ${
              (pipelineResult.resumeFrom ?? 0) + 1
            } awaiting approval`,
          );
        }
      } else if (ctx.stopReason === "completed") {
        callbacks.setStopReason(
          ctx,
          "timeout",
          callbacks.timeoutDetail("planner pipeline execution", ctx.effectiveRequestTimeoutMs),
        );
      }

      if (isRuntimeLimitExceeded(ctx.failedToolCalls, ctx.effectiveFailureBudget)) {
        callbacks.setStopReason(
          ctx,
          "tool_error",
          `Failure budget exceeded (${ctx.failedToolCalls}/${ctx.effectiveFailureBudget}) during deterministic pipeline execution`,
        );
      }

      let plannerFinalizationStrategy: string | undefined;
      if (
        pipelineResult &&
        !pipelineResult.decomposition &&
        ctx.stopReason === "completed" &&
        explicitDeterministicToolRequirements?.exactResponseLiteral
      ) {
        ctx.finalContent =
          explicitDeterministicToolRequirements.exactResponseLiteral;
        plannerFinalizationStrategy = "exact_response_literal";
        ctx.plannerSummaryState.diagnostics.push({
          category: "policy",
          code: "planner_exact_response_literal_applied",
          message:
            "Completed deterministic plan satisfied the explicit exact-response contract without planner synthesis",
          details: {
            literal:
              explicitDeterministicToolRequirements.exactResponseLiteral,
          },
        });
      }

      if (
        pipelineResult &&
        !pipelineResult.decomposition &&
        !ctx.finalContent &&
        (
          plannerPlan.requiresSynthesis ||
          hasSynthesisStep ||
          explicitOrchestrationRequirements?.requiresSynthesis === true ||
          ctx.stopReason !== "completed"
        )
      ) {
        const requestedWriteTarget = inferExplicitFileWriteTarget(ctx.messageText);
        const childOwnedWriteTarget = plannerHasChildOwnedWriteTarget(
          plannerPlan,
          requestedWriteTarget,
        );
        if (
          childOwnedWriteTarget &&
          pipelineResult.status !== "completed" &&
          ctx.stopReason !== "completed"
        ) {
          ctx.plannerSummaryState.diagnostics.push({
            category: "runtime",
            code: "planner_synthesis_skipped_child_owned_artifact_failure",
            message:
              "Planner synthesis was skipped because a child-owned artifact write failed and inline materialization is not authoritative for that target",
            details: {
              ...(requestedWriteTarget
                ? { targetPath: requestedWriteTarget }
                : {}),
              pipelineStatus: pipelineResult.status,
              stopReason: ctx.stopReason,
            },
          });
          ctx.finalContent = buildPlannerSynthesisFallbackContent(
            plannerPlan,
            pipelineResult,
            verificationDecision,
            verifierRounds,
            "Child-owned artifact write failed verification; inline planner synthesis is disabled for that target.",
          );
          callbacks.emitPlannerTrace(ctx, "planner_synthesis_fallback_applied", {
            failureDetail:
              "Child-owned artifact write failed verification; inline planner synthesis is disabled for that target.",
            completedSteps: pipelineResult.completedSteps,
            totalSteps: pipelineResult.totalSteps,
          });
          callbacks.emitPlannerTrace(ctx, "planner_path_finished", {
            plannerCalls: plannerAttempt,
            routeReason: ctx.plannerSummaryState.routeReason,
            stopReason: ctx.stopReason,
            stopReasonDetail: ctx.stopReasonDetail,
            diagnostics: ctx.plannerSummaryState.diagnostics,
            handled: true,
            deterministicStepsExecuted:
              ctx.plannerSummaryState.deterministicStepsExecuted,
          });
          ctx.plannerHandled = true;
          return;
        }
        const synthesisWriteTarget =
          requestedWriteTarget &&
          !plannerHasChildOwnedWriteTarget(plannerPlan, requestedWriteTarget) &&
          !plannerAlreadyMutatesFiles(plannerPlan) &&
          (
            plannerPlan.requiresSynthesis ||
            hasSynthesisStep
          )
            ? requestedWriteTarget
            : undefined;
        let synthesisMessages = buildPlannerSynthesisMessages(
          ctx.systemPrompt,
          ctx.messageText,
          plannerPlan,
          pipelineResult,
          verificationDecision,
        );
        if (synthesisWriteTarget) {
          synthesisMessages = [
            synthesisMessages[0]!,
            synthesisMessages[1]!,
            {
              role: "system",
              content:
                `The original request requires materializing a file, not just describing it. ` +
                `Use \`system.writeFile\` with the exact target path \`${synthesisWriteTarget}\` before finishing. ` +
                "Do not inline the full file content as a plain chat answer without writing it.",
            },
            ...synthesisMessages.slice(2),
          ];
        }
        const synthesisSections: PromptBudgetSection[] = [
          "system_anchor",
          "system_runtime",
          "user",
        ];
        const stopReasonBeforeSynthesis = ctx.stopReason;
        const stopReasonDetailBeforeSynthesis = ctx.stopReasonDetail;
        try {
          const toolCallCountBeforeSynthesis = ctx.allToolCalls.length;
          const synthesisResponse = await callbacks.callModelForPhase(ctx, {
            phase: "planner_synthesis",
            callMessages: synthesisMessages,
            callSections: synthesisSections,
            onStreamChunk: ctx.activeStreamCallback,
            statefulSessionId: ctx.sessionId,
            statefulResumeAnchor: ctx.stateful?.resumeAnchor,
            statefulHistoryCompacted: ctx.stateful?.historyCompacted,
            routedToolNames: synthesisWriteTarget ? ["system.writeFile"] : [],
            toolChoice: synthesisWriteTarget ? "auto" : "none",
            budgetReason:
              "Planner synthesis blocked by max model recalls per request budget",
          });
          if (synthesisWriteTarget) {
            const normalizedTarget = normalizeToolCallTargetPath(
              synthesisWriteTarget,
            );
            const wroteRequestedTarget = ctx.allToolCalls
              .slice(toolCallCountBeforeSynthesis)
              .some((call) => {
                if (call.isError || call.name !== "system.writeFile") {
                  return false;
                }
                const callPath = normalizeToolCallTargetPath(
                  (call.args as { path?: unknown } | undefined)?.path,
                );
                return normalizedTarget !== undefined && callPath === normalizedTarget;
              });
            if (!wroteRequestedTarget) {
              callbacks.setStopReason(
                ctx,
                "validation_error",
                `Required synthesis write target was not materialized: ${synthesisWriteTarget}`,
              );
              ctx.finalContent =
                `Required file target was not written: ${synthesisWriteTarget}. ` +
                "The model returned synthesis output without materializing the artifact.";
              ctx.plannerSummaryState.diagnostics.push({
                category: "runtime",
                code: "planner_synthesis_missing_materialized_artifact",
                message:
                  "Planner synthesis returned without writing the explicit requested artifact target",
                details: {
                  targetPath: synthesisWriteTarget,
                },
              });
              callbacks.emitPlannerTrace(ctx, "planner_path_finished", {
                plannerCalls: plannerAttempt,
                routeReason: ctx.plannerSummaryState.routeReason,
                stopReason: ctx.stopReason,
                stopReasonDetail: ctx.stopReasonDetail,
                diagnostics: ctx.plannerSummaryState.diagnostics,
                handled: true,
                deterministicStepsExecuted:
                  ctx.plannerSummaryState.deterministicStepsExecuted,
              });
              ctx.plannerHandled = true;
              return;
            }
          }
          if (synthesisResponse) {
            const postSynthesisToolCalls = ctx.allToolCalls.slice(
              toolCallCountBeforeSynthesis,
            );
            const claimedButUnexecutedToolNames =
              resolvePlannerSynthesisToolMarkupMismatch({
                content: synthesisResponse.content,
                toolCalls: postSynthesisToolCalls,
              });
            if (claimedButUnexecutedToolNames.length > 0) {
              callbacks.setStopReason(
                ctx,
                "validation_error",
                "Planner synthesis emitted tool-call markup that was not executed. " +
                  "Synthesis must summarize the authoritative execution ledger instead of inventing tool invocations.",
              );
              ctx.finalContent =
                "Planner synthesis emitted tool-call markup that was not executed. " +
                `Missing executed tool calls: ${claimedButUnexecutedToolNames.join(", ")}.`;
              ctx.plannerSummaryState.diagnostics.push({
                category: "runtime",
                code: "planner_synthesis_unexecuted_tool_markup",
                message:
                  "Planner synthesis emitted fenced tool-call markup for tool invocations that do not exist in the authoritative execution ledger",
                details: {
                  claimedToolNames:
                    claimedButUnexecutedToolNames.join(", "),
                },
              });
              callbacks.emitPlannerTrace(ctx, "planner_path_finished", {
                plannerCalls: plannerAttempt,
                routeReason: ctx.plannerSummaryState.routeReason,
                stopReason: ctx.stopReason,
                stopReasonDetail: ctx.stopReasonDetail,
                diagnostics: ctx.plannerSummaryState.diagnostics,
                handled: true,
                deterministicStepsExecuted:
                  ctx.plannerSummaryState.deterministicStepsExecuted,
              });
              ctx.plannerHandled = true;
              return;
            }
            ctx.response = synthesisResponse;
            ctx.finalContent = ensureSubagentProvenanceCitations(
              synthesisResponse.content,
              plannerPlan,
              pipelineResult,
            );
          }
        } catch (error) {
          if (pipelineResult.status === "completed") {
            const failureDetail =
              typeof (error as { stopReasonDetail?: unknown })?.stopReasonDetail === "string"
                ? String((error as { stopReasonDetail: string }).stopReasonDetail)
                : error instanceof Error
                  ? error.message
                  : String(error);
            ctx.stopReason = stopReasonBeforeSynthesis;
            ctx.stopReasonDetail = stopReasonDetailBeforeSynthesis;
            ctx.plannerSummaryState.diagnostics.push({
              category: "runtime",
              code: "planner_synthesis_fallback_applied",
              message:
                "Planner synthesis failed after the pipeline completed; returning a deterministic fallback summary",
              details: {
                failureDetail,
              },
            });
            callbacks.emitPlannerTrace(ctx, "planner_synthesis_fallback_applied", {
              failureDetail,
              completedSteps: pipelineResult.completedSteps,
              totalSteps: pipelineResult.totalSteps,
            });
            ctx.finalContent = buildPlannerSynthesisFallbackContent(
              plannerPlan,
              pipelineResult,
              verificationDecision,
              verifierRounds,
              failureDetail,
            );
          } else {
            throw error;
          }
        }
      } else if (pipelineResult?.decomposition && !ctx.finalContent) {
        ctx.finalContent =
          pipelineResult.error ??
          pipelineResult.decomposition.reason;
      }

      if (!ctx.finalContent) {
        ctx.finalContent =
          generateFallbackContent(ctx.allToolCalls) ??
          summarizeToolCalls(
            ctx.allToolCalls.filter((call) => !call.isError),
          );
      }
      callbacks.emitPlannerTrace(ctx, "planner_path_finished", {
        plannerCalls: plannerAttempt,
        routeReason: ctx.plannerSummaryState.routeReason,
        stopReason: ctx.stopReason,
        stopReasonDetail: ctx.stopReasonDetail,
        diagnostics: ctx.plannerSummaryState.diagnostics,
        handled: true,
        ...(plannerFinalizationStrategy
          ? { finalizationStrategy: plannerFinalizationStrategy }
          : {}),
        deterministicStepsExecuted:
          ctx.plannerSummaryState.deterministicStepsExecuted,
      });
      ctx.plannerHandled = true;
      return;
    }

    if (
      !delegationDecision ||
      delegationDecision.shouldDelegate
    ) {
      if (
        ctx.plannerSummaryState.routeReason !== "planner_validation_failed" &&
        ctx.plannerSummaryState.routeReason !==
          "planner_explicit_tool_requirements_unmet"
      ) {
        ctx.plannerSummaryState.routeReason = "planner_no_deterministic_steps";
      }
    }
    if (ctx.plannerSummaryState.routeReason === "planner_validation_failed") {
      callbacks.setStopReason(
        ctx,
        "validation_error",
        "Planner emitted a structured plan that failed local validation",
      );
      ctx.finalContent = buildPlannerValidationFailureMessage(
        latestPlannerValidationDiagnostics.length > 0
          ? latestPlannerValidationDiagnostics
          : ctx.plannerSummaryState.diagnostics,
      );
      callbacks.emitPlannerTrace(ctx, "planner_path_finished", {
        plannerCalls: plannerAttempt,
        routeReason: ctx.plannerSummaryState.routeReason,
        stopReason: ctx.stopReason,
        stopReasonDetail: ctx.stopReasonDetail,
        diagnostics: ctx.plannerSummaryState.diagnostics,
        latestDiagnostics: latestPlannerValidationDiagnostics,
        handled: true,
      });
      ctx.plannerHandled = true;
      return;
    }
    if (
      subagentSteps.length > 0 &&
      delegationDecision?.shouldDelegate === false &&
      plannerImplementationFallbackBlocked
    ) {
      callbacks.setStopReason(
        ctx,
        "validation_error",
        "Planner produced an implementation-scoped delegated plan, but runtime delegation admission rejected it. Inline legacy fallback is disabled for this task class.",
      );
      ctx.finalContent = buildPlannerImplementationFallbackBlockedDetail(
        delegationDecision.reason,
      );
      callbacks.emitPlannerTrace(ctx, "planner_path_finished", {
        plannerCalls: plannerAttempt,
        routeReason: ctx.plannerSummaryState.routeReason,
        stopReason: ctx.stopReason,
        stopReasonDetail: ctx.stopReasonDetail,
        diagnostics: ctx.plannerSummaryState.diagnostics,
        handled: true,
      });
      ctx.plannerHandled = true;
      return;
    }
    if (plannerImplementationFallbackBlocked) {
      callbacks.setStopReason(
        ctx,
        "validation_error",
        "Planner produced an implementation-scoped delegated plan, but runtime delegation admission rejected it. Inline legacy fallback is disabled for this task class.",
      );
      ctx.finalContent = buildPlannerImplementationFallbackBlockedDetail(
        delegationDecision?.reason ?? "delegation_veto",
      );
      ctx.plannerHandled = true;
    }
    callbacks.emitPlannerTrace(ctx, "planner_path_finished", {
      plannerCalls: plannerAttempt,
      routeReason: ctx.plannerSummaryState.routeReason,
      stopReason: ctx.stopReason,
      stopReasonDetail: ctx.stopReasonDetail,
      diagnostics: ctx.plannerSummaryState.diagnostics,
      handled: plannerImplementationFallbackBlocked ? true : false,
    });
    return;
  }
}
