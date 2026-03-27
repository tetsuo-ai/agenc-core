/**
 * Contract-guidance and required-evidence helpers for ChatExecutor.
 *
 * @module
 */

import type {
  DelegationContractSpec,
  DelegationOutputValidationCode,
  DelegationOutputValidationResult,
} from "../utils/delegation-validation.js";
import {
  getMissingSuccessfulToolEvidenceMessage,
  specRequiresFileMutationEvidence,
  specRequiresMeaningfulBrowserEvidence,
  validateDelegatedOutputContract,
} from "../utils/delegation-validation.js";
import { validateRuntimeVerificationContract } from "../workflow/index.js";
import type { ImplementationCompletionContract } from "../workflow/completion-contract.js";
import {
  isPathWithinRoot,
  normalizeEnvelopePath,
  normalizeWorkspaceRoot,
} from "../workflow/path-normalization.js";
import type { WorkflowVerificationContract } from "../workflow/verification-obligations.js";
import { buildBrowserEvidenceRetryGuidance } from "../utils/browser-tool-taxonomy.js";
import type { ExecutionContext, ToolCallRecord } from "./chat-executor-types.js";
import type { LLMProviderEvidence } from "./types.js";
import {
  type ToolContractGuidance,
  type ToolContractGuidancePhase,
  resolveToolContractGuidance,
} from "./chat-executor-contract-guidance.js";
import {
  getAllowedToolNamesForContractGuidance,
  getAllowedToolNamesForEvidence,
} from "./chat-executor-routing-state.js";
import { didToolCallFail } from "./chat-executor-tool-utils.js";
import {
  plannerRequestNeedsPlanArtifactExecution,
  requestRequiresToolGroundedExecution,
} from "./chat-executor-planner.js";
import {
  PROVIDER_NATIVE_GROUNDED_INFORMATION_TOOL_NAMES,
} from "./provider-native-search.js";

type ToolNameCollection = Iterable<string> | readonly string[];

type ContractFlowContext =
  Pick<
    ExecutionContext,
    | "messageText"
    | "allToolCalls"
    | "activeRoutedToolNames"
    | "initialRoutedToolNames"
    | "expandedRoutedToolNames"
    | "requiredToolEvidence"
    | "providerEvidence"
    | "response"
    | "plannerSummaryState"
  > &
  Partial<
    Pick<
      ExecutionContext,
      | "runtimeWorkspaceRoot"
      | "plannerVerificationContract"
      | "plannerCompletionContract"
    >
  >;

export type LegacyCompletionCompatibilityClass =
  | "docs"
  | "research"
  | "plan_only";

export interface LegacyCompletionCompatibilityDecision {
  readonly allowed: boolean;
  readonly compatibilityClass: LegacyCompletionCompatibilityClass;
  readonly reason: string;
}

export interface RuntimeWorkflowContextResolution {
  readonly verificationContract?: WorkflowVerificationContract;
  readonly completionContract?: ImplementationCompletionContract;
  readonly ownershipSource?:
    | "planner_owned"
    | "required_tool_evidence"
    | "direct_deterministic_implementation";
}

const DIRECT_MUTATION_TOOL_NAMES = new Set([
  "desktop.text_editor",
  "system.appendFile",
  "system.delete",
  "system.mkdir",
  "system.move",
  "system.writeFile",
]);
const BROWSER_TOOL_PREFIX = "mcp.browser.";
const RESEARCH_TOOL_NAMES: ReadonlySet<string> = new Set(
  PROVIDER_NATIVE_GROUNDED_INFORMATION_TOOL_NAMES,
);
const DOC_ONLY_PATH_RE = /\.(?:md|mdx|txt|rst|adoc)$/i;
const DOC_BASENAME_RE =
  /(?:^|\/)(?:README|CHANGELOG|CONTRIBUTING|LICENSE|COPYING|NOTES|AGENTS|AGENC)(?:\.[^/]+)?$/i;
const SOURCE_LIKE_PATH_RE =
  /(?:^|\/)(?:src|lib|app|server|client|cmd|pkg|include|internal|tests?|spec)(?:\/|$)|\.(?:c|cc|cpp|cxx|h|hpp|m|mm|rs|go|py|rb|php|java|kt|swift|cs|js|jsx|ts|tsx|json|toml|yaml|yml|xml|sh|zsh|bash)$/i;
const BUILD_OR_BEHAVIOR_COMMAND_RE =
  /\b(?:build|compile|typecheck|lint|test|tests|testing|vitest|jest|pytest|playwright|ctest|cargo test|go test|smoke|scenario|e2e|end-to-end)\b/i;
const LIKELY_IMPLEMENTATION_REQUEST_RE =
  /\b(?:implement|implementation|fix|repair|refactor|build|compile|typecheck|lint|test|write|edit|update|create)\b/i;
const BEHAVIOR_REQUIREMENT_RE =
  /\b(?:behavior|behaviour|scenario|smoke|integration|e2e|end-to-end|playtest|job control)\b/i;
const BUILD_REQUIREMENT_RE =
  /\b(?:build|compile|typecheck|lint|test|tests|testing|vitest|jest|pytest|playwright|ctest|cargo test|go test)\b/i;

interface EncodedEffectTarget {
  readonly path?: string;
}

interface EncodedEffectMetadata {
  readonly targets?: readonly EncodedEffectTarget[];
}

interface EncodedVerificationMetadata {
  readonly category?: "build" | "behavior" | "review";
  readonly command?: string;
}

export function resolveExecutionToolContractGuidance(input: {
  readonly ctx: ContractFlowContext;
  readonly allowedTools?: ToolNameCollection;
  readonly phase?: ToolContractGuidancePhase;
  readonly allowedToolNames?: readonly string[];
  readonly validationCode?: DelegationOutputValidationCode;
}): ToolContractGuidance | undefined {
  return resolveToolContractGuidance({
    phase: input.phase ?? "tool_followup",
    messageText: input.ctx.messageText,
    toolCalls: input.ctx.allToolCalls,
    allowedToolNames: getAllowedToolNamesForContractGuidance({
      override: input.allowedToolNames,
      activeRoutedToolNames: input.ctx.activeRoutedToolNames,
      initialRoutedToolNames: input.ctx.initialRoutedToolNames,
      expandedRoutedToolNames: input.ctx.expandedRoutedToolNames,
      allowedTools: input.allowedTools,
    }),
    requiredToolEvidence: input.ctx.requiredToolEvidence,
    validationCode: input.validationCode,
  });
}

export function resolveRuntimeWorkflowContext(input: {
  readonly ctx: ContractFlowContext;
}): RuntimeWorkflowContextResolution {
  const plannerContext = mergeWorkflowVerificationContext({
    verificationContract: input.ctx.plannerVerificationContract,
    completionContract: input.ctx.plannerCompletionContract,
  });
  if (plannerContext.verificationContract || plannerContext.completionContract) {
    return {
      ...plannerContext,
      ownershipSource: "planner_owned",
    };
  }

  const explicitContext = mergeWorkflowVerificationContext({
    verificationContract: input.ctx.requiredToolEvidence?.verificationContract,
    completionContract: input.ctx.requiredToolEvidence?.completionContract,
  });
  if (explicitContext.verificationContract || explicitContext.completionContract) {
    return {
      ...explicitContext,
      ownershipSource: "required_tool_evidence",
    };
  }

  const directImplementationContext =
    synthesizeDirectImplementationWorkflowContext(input.ctx);
  if (directImplementationContext) {
    return {
      ...directImplementationContext,
      ownershipSource: "direct_deterministic_implementation",
    };
  }

  return {};
}

export function resolveLegacyCompletionCompatibility(input: {
  readonly ctx: ContractFlowContext;
}): LegacyCompletionCompatibilityDecision {
  const analysis = analyzeLegacyCompletionTurn(input.ctx);
  const plannerRouteReason = input.ctx.plannerSummaryState.routeReason;
  if (
    plannerRouteReason === "exact_response_turn" ||
    plannerRouteReason === "dialogue_memory_turn"
  ) {
    return {
      allowed: true,
      compatibilityClass: "plan_only",
      reason:
        "Legacy completion remains allowed for exact-response and dialogue-memory turns.",
    };
  }

  if (
    analysis.hasMutationProgress &&
    analysis.mutatedArtifacts.every((artifact) => isDocOnlyArtifactPath(artifact))
  ) {
    return {
      allowed: true,
      compatibilityClass: "docs",
      reason:
        "Legacy completion remains allowed for documentation-only artifact updates.",
    };
  }

  if (
    !analysis.hasMutationProgress &&
    analysis.hasResearchEvidence &&
    !analysis.hasBuildOrBehaviorEvidence
  ) {
    return {
      allowed: true,
      compatibilityClass: "research",
      reason:
        "Legacy completion remains allowed for grounded research-only turns without implementation mutations.",
    };
  }

  if (
    !analysis.hasMutationProgress &&
    !requestRequiresToolGroundedExecution(input.ctx.messageText)
  ) {
    return {
      allowed: true,
      compatibilityClass: "plan_only",
      reason:
        "Legacy completion remains allowed for non-execution turns that do not request environment changes.",
    };
  }

  if (!analysis.implementationLikeTurn) {
    return {
      allowed: true,
      compatibilityClass: "plan_only",
      reason:
        "Legacy completion remains allowed for non-implementation turns outside the implementation verifier scope.",
    };
  }
  throw new Error(
    "resolveLegacyCompletionCompatibility received implementation-class work. " +
      "Implementation completion must be handled by workflow-owned truth before compatibility.",
  );
}

export function requiresWorkflowOwnedImplementationCompletion(input: {
  readonly ctx: ContractFlowContext;
}): boolean {
  return analyzeLegacyCompletionTurn(input.ctx).implementationLikeTurn;
}

export function validateRequiredToolEvidence(input: {
  readonly ctx: ContractFlowContext;
}): {
  readonly contractValidation?: DelegationOutputValidationResult;
  readonly missingEvidenceMessage?: string;
} {
  const requiredToolEvidence = input.ctx.requiredToolEvidence;
  if (!requiredToolEvidence) {
    return {};
  }
  const workflowVerificationContract = resolveWorkflowVerificationContract(
    requiredToolEvidence,
  );
  const contractValidation: DelegationOutputValidationResult | undefined =
    typeof input.ctx.response?.content === "string"
      ? requiredToolEvidence.delegationSpec
        ? validateDelegatedOutputContract({
          spec: requiredToolEvidence.delegationSpec,
          output: input.ctx.response.content,
          toolCalls: input.ctx.allToolCalls,
          providerEvidence: input.ctx.providerEvidence,
          unsafeBenchmarkMode: requiredToolEvidence.unsafeBenchmarkMode,
        })
        : workflowVerificationContract
          ? workflowDecisionToValidationResult(
            validateRuntimeVerificationContract({
              verificationContract: workflowVerificationContract,
              output: input.ctx.response.content,
              toolCalls: input.ctx.allToolCalls,
              providerEvidence: input.ctx.providerEvidence,
            }),
          )
          : undefined
      : undefined;
  const missingEvidenceMessage = getMissingSuccessfulToolEvidenceMessage(
    input.ctx.allToolCalls,
    requiredToolEvidence.delegationSpec,
    input.ctx.providerEvidence,
  );
  return {
    contractValidation,
    missingEvidenceMessage:
      contractValidation?.error ?? missingEvidenceMessage ?? undefined,
  };
}

function resolveWorkflowVerificationContract(
  requiredToolEvidence: NonNullable<ContractFlowContext["requiredToolEvidence"]>,
) {
  if (
    !requiredToolEvidence.verificationContract &&
    !requiredToolEvidence.completionContract
  ) {
    return undefined;
  }
  return {
    ...(requiredToolEvidence.verificationContract ?? {}),
    ...(requiredToolEvidence.completionContract
      ? { completionContract: requiredToolEvidence.completionContract }
      : {}),
  };
}

function workflowDecisionToValidationResult(
  decision: ReturnType<typeof validateRuntimeVerificationContract>,
): DelegationOutputValidationResult | undefined {
  if (!decision?.diagnostic) {
    return undefined;
  }
  return {
    ok: false,
    code: decision.diagnostic.code,
    error: decision.diagnostic.message,
  };
}

export function resolveCorrectionAllowedToolNames(
  activeRoutedToolNames: readonly string[],
  allowedTools?: ToolNameCollection,
): readonly string[] {
  if (allowedTools) {
    return [...allowedTools];
  }
  return getAllowedToolNamesForEvidence(
    activeRoutedToolNames,
    allowedTools,
  );
}

export function buildRequiredToolEvidenceRetryInstruction(input: {
  readonly missingEvidenceMessage: string;
  readonly validationCode?: DelegationOutputValidationCode;
  readonly allowedToolNames: readonly string[];
  readonly requiresAdditionalToolCalls?: boolean;
}): string {
  const requiresAdditionalToolCalls =
    input.requiresAdditionalToolCalls !== false;
  const allowedToolSummary = requiresAdditionalToolCalls &&
    input.allowedToolNames.length > 0
    ? ` Allowed tools: ${input.allowedToolNames.join(", ")}.`
    : "";
  const correctionLines = requiresAdditionalToolCalls
    ? [
      "Tool-grounded evidence is required for this delegated task.",
      "Before answering, call one or more allowed tools and base the answer on those results.",
      "Do not answer from memory or restate the plan.",
    ]
    : [
      "The required tool-grounded evidence is already present in this turn.",
      "Do not call additional tools for this retry.",
      "Re-emit the final answer only, grounded in the tools already executed.",
    ];
  if (
    input.validationCode === "low_signal_browser_evidence" ||
    /browser-grounded evidence/i.test(input.missingEvidenceMessage)
  ) {
    correctionLines.push(
      ...buildBrowserEvidenceRetryGuidance(input.allowedToolNames),
    );
  }
  if (
    input.validationCode === "expected_json_object" ||
    input.validationCode === "empty_structured_payload"
  ) {
    correctionLines.push(
      "Your final answer must be a single JSON object only, with no markdown fences or prose around it.",
    );
  }
  if (
    input.validationCode === "missing_file_mutation_evidence" ||
    /file creation\/edit evidence|file mutation tools/i.test(
      input.missingEvidenceMessage,
    )
  ) {
    correctionLines.push(
      "Create or edit the required files with the allowed file-mutation tools before answering, and name those files in the final output.",
    );
  }
  if (input.validationCode === "missing_behavior_harness") {
    correctionLines.push(
      "Behavior verification is required for this task, and no runnable behavior harness was executed.",
    );
    correctionLines.push(
      "First prefer existing repo-local test, smoke, scenario, or validation commands before inventing a new harness.",
    );
    correctionLines.push(
      "If you add a new test or scenario harness, run it before the implementation to capture failure and again after the change when feasible.",
    );
    correctionLines.push(
      "If no runnable harness exists in this environment, do not claim completion; report that behavior verification still needs to run.",
    );
  }
  if (input.validationCode === "missing_required_source_evidence") {
    correctionLines.push(
      "Inspect the named source files from the delegated input contract or context requirements before writing again.",
    );
    correctionLines.push(
      "If those sources describe intended or planned structure, keep that distinction explicit instead of presenting planned files as already present.",
    );
  }
  if (input.validationCode === "forbidden_phase_action") {
    correctionLines.push(
      "This phase explicitly forbids one or more actions such as install/build/test/typecheck/lint execution or banned dependency specifiers. Do not repeat them.",
    );
    correctionLines.push(
      "Limit the retry to the file-authoring or inspection work that belongs to this phase, and leave verification for the later step.",
    );
  }
  if (input.validationCode === "blocked_phase_output") {
    correctionLines.push(
      "Do not return a success-path answer that says the phase is blocked or cannot be completed.",
    );
    correctionLines.push(
      "Either fix the blocking issue with the allowed tools and verify the result, or let the failure surface instead of presenting a completed phase.",
    );
  }
  if (input.validationCode === "contradictory_completion_claim") {
    correctionLines.push(
      "Do not claim the phase is complete while also mentioning unresolved mismatches, placeholders, or needed follow-up.",
    );
    correctionLines.push(
      "If the latest allowed-tool evidence fixes the issue, re-emit a completion-only answer grounded in that evidence.",
    );
    correctionLines.push(
      "Report the phase as blocked only when the blocking issue still remains after the allowed tool work.",
    );
  }
  return (
    "Delegated output validation failed. " +
    `${input.missingEvidenceMessage}. ` +
    correctionLines.join(" ") +
    allowedToolSummary
  );
}

function mergeWorkflowVerificationContext(input: {
  readonly verificationContract?: WorkflowVerificationContract;
  readonly completionContract?: ImplementationCompletionContract;
}): RuntimeWorkflowContextResolution {
  if (!input.verificationContract && !input.completionContract) {
    return {};
  }
  return {
    verificationContract: {
      ...(input.verificationContract ?? {}),
      ...(input.completionContract
        ? { completionContract: input.completionContract }
        : {}),
    },
    completionContract:
      input.completionContract ?? input.verificationContract?.completionContract,
  };
}

function synthesizeDirectImplementationWorkflowContext(
  ctx: ContractFlowContext,
): RuntimeWorkflowContextResolution | undefined {
  if (plannerRequestNeedsPlanArtifactExecution(ctx.messageText)) {
    return undefined;
  }
  const workspaceRoot = normalizeWorkspaceRoot(ctx.runtimeWorkspaceRoot);
  if (!workspaceRoot) {
    return undefined;
  }

  const successfulToolCalls = ctx.allToolCalls.filter(
    (toolCall) => !didToolCallFail(toolCall.isError, toolCall.result),
  );
  if (successfulToolCalls.length === 0) {
    return undefined;
  }

  const mutatedArtifacts = collectLegacyMutatedArtifacts(successfulToolCalls)
    .map((artifact) => normalizeEnvelopePath(artifact, workspaceRoot))
    .filter((artifact) => isPathWithinRoot(artifact, workspaceRoot));
  const uniqueMutatedArtifacts = [...new Set(mutatedArtifacts)];
  const docOnlyMutations =
    uniqueMutatedArtifacts.length > 0 &&
    uniqueMutatedArtifacts.every((artifact) => isDocOnlyArtifactPath(artifact));
  if (docOnlyMutations) {
    return undefined;
  }

  const hasMutationProgress = uniqueMutatedArtifacts.length > 0;
  const mutatesSourceLikeArtifacts = uniqueMutatedArtifacts.some((artifact) =>
    SOURCE_LIKE_PATH_RE.test(artifact),
  );
  const buildOrBehaviorSignals = successfulToolCalls.map((toolCall) => {
    const verification = parseEncodedVerificationMetadata(toolCall.result);
    return {
      verificationCategory: verification?.category,
      command: verification?.command ?? resolveCommandText(toolCall),
    };
  });
  const hasBehaviorRequirement =
    BEHAVIOR_REQUIREMENT_RE.test(ctx.messageText) ||
    buildOrBehaviorSignals.some(({ verificationCategory, command }) =>
      verificationCategory === "behavior" || BEHAVIOR_REQUIREMENT_RE.test(command)
    );
  const hasBuildRequirement =
    hasBehaviorRequirement ||
    BUILD_REQUIREMENT_RE.test(ctx.messageText) ||
    buildOrBehaviorSignals.some(({ verificationCategory, command }) =>
      verificationCategory === "build" || BUILD_REQUIREMENT_RE.test(command)
    );
  const likelyImplementationRequest =
    LIKELY_IMPLEMENTATION_REQUEST_RE.test(ctx.messageText) &&
    requestRequiresToolGroundedExecution(ctx.messageText);
  const implementationLikeTurn =
    hasMutationProgress &&
    (mutatesSourceLikeArtifacts || likelyImplementationRequest || hasBuildRequirement);
  if (!implementationLikeTurn) {
    return undefined;
  }

  const completionContract: ImplementationCompletionContract = hasBehaviorRequirement
    ? {
      taskClass: "behavior_required",
      placeholdersAllowed: false,
      partialCompletionAllowed: false,
      placeholderTaxonomy: "implementation",
    }
    : hasBuildRequirement
      ? {
        taskClass: "build_required",
        placeholdersAllowed: false,
        partialCompletionAllowed: false,
        placeholderTaxonomy: "implementation",
      }
      : {
        taskClass: "artifact_only",
        placeholdersAllowed: false,
        partialCompletionAllowed: false,
        placeholderTaxonomy: "implementation",
      };

  return {
    verificationContract: {
      workspaceRoot,
      targetArtifacts: uniqueMutatedArtifacts,
      verificationMode: "mutation_required",
      completionContract,
    },
    completionContract,
  };
}

interface LegacyCompletionTurnAnalysis {
  readonly successfulToolCalls: readonly ToolCallRecord[];
  readonly mutatedArtifacts: readonly string[];
  readonly hasMutationProgress: boolean;
  readonly hasResearchEvidence: boolean;
  readonly hasBuildOrBehaviorEvidence: boolean;
  readonly implementationLikeTurn: boolean;
}

function analyzeLegacyCompletionTurn(
  ctx: ContractFlowContext,
): LegacyCompletionTurnAnalysis {
  const successfulToolCalls = ctx.allToolCalls.filter(
    (toolCall) => !didToolCallFail(toolCall.isError, toolCall.result),
  );
  const mutatedArtifacts = collectLegacyMutatedArtifacts(successfulToolCalls);
  const hasMutationProgress = mutatedArtifacts.length > 0;
  const hasResearchEvidence =
    (ctx.providerEvidence?.citations?.length ?? 0) > 0 ||
    (ctx.providerEvidence?.serverSideToolCalls?.length ?? 0) > 0 ||
    (ctx.providerEvidence?.serverSideToolUsage?.length ?? 0) > 0 ||
    successfulToolCalls.some((toolCall) =>
      toolCall.name.startsWith(BROWSER_TOOL_PREFIX) ||
      RESEARCH_TOOL_NAMES.has(toolCall.name),
    );
  const hasBuildOrBehaviorEvidence = successfulToolCalls.some((toolCall) => {
    const verification = parseEncodedVerificationMetadata(toolCall.result);
    if (
      verification?.category === "build" ||
      verification?.category === "behavior"
    ) {
      return true;
    }
    const command =
      verification?.command ??
      resolveCommandText(toolCall);
    return BUILD_OR_BEHAVIOR_COMMAND_RE.test(command);
  });
  const mutatesSourceLikeArtifacts = mutatedArtifacts.some((artifact) =>
    SOURCE_LIKE_PATH_RE.test(artifact),
  );
  const likelyImplementationRequest =
    LIKELY_IMPLEMENTATION_REQUEST_RE.test(ctx.messageText) &&
    requestRequiresToolGroundedExecution(ctx.messageText);
  return {
    successfulToolCalls,
    mutatedArtifacts,
    hasMutationProgress,
    hasResearchEvidence,
    hasBuildOrBehaviorEvidence,
    implementationLikeTurn:
      mutatesSourceLikeArtifacts ||
      hasBuildOrBehaviorEvidence ||
      (successfulToolCalls.length === 0 && likelyImplementationRequest),
  };
}

function collectLegacyMutatedArtifacts(
  toolCalls: ExecutionContext["allToolCalls"],
): readonly string[] {
  const artifacts = new Set<string>();
  for (const toolCall of toolCalls) {
    const normalizedName = toolCall.name.trim();
    if (DIRECT_MUTATION_TOOL_NAMES.has(normalizedName)) {
      for (const path of extractDirectMutationPaths(toolCall)) {
        artifacts.add(path);
      }
    }
    if (normalizedName === "system.bash" || normalizedName === "desktop.bash") {
      const effect = parseEncodedEffectMetadata(toolCall.result);
      for (const target of effect?.targets ?? []) {
        if (typeof target.path === "string" && target.path.trim().length > 0) {
          artifacts.add(target.path.trim());
        }
      }
    }
  }
  return [...artifacts];
}

function extractDirectMutationPaths(
  toolCall: ExecutionContext["allToolCalls"][number],
): readonly string[] {
  if (!toolCall.args || typeof toolCall.args !== "object" || Array.isArray(toolCall.args)) {
    return [];
  }
  const args = toolCall.args as Record<string, unknown>;
  switch (toolCall.name.trim()) {
    case "desktop.text_editor":
    case "system.appendFile":
    case "system.delete":
    case "system.mkdir":
    case "system.writeFile":
      return normalizeStringPaths(args.path);
    case "system.move":
      return [
        ...normalizeStringPaths(args.source),
        ...normalizeStringPaths(args.destination),
      ];
    default:
      return [];
  }
}

function normalizeStringPaths(value: unknown): readonly string[] {
  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
}

function isDocOnlyArtifactPath(value: string): boolean {
  return DOC_ONLY_PATH_RE.test(value) || DOC_BASENAME_RE.test(value);
}

function parseEncodedEffectMetadata(
  result: string | undefined,
): EncodedEffectMetadata | undefined {
  const parsed = parseResultObject(result);
  const raw = parsed?.__agencEffect;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  return raw as EncodedEffectMetadata;
}

function parseEncodedVerificationMetadata(
  result: string | undefined,
): EncodedVerificationMetadata | undefined {
  const parsed = parseResultObject(result);
  const raw = parsed?.__agencVerification;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  return raw as EncodedVerificationMetadata;
}

function parseResultObject(
  result: string | undefined,
): Record<string, unknown> | undefined {
  if (typeof result !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(result) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function resolveCommandText(
  toolCall: ExecutionContext["allToolCalls"][number],
): string {
  if (!toolCall.args || typeof toolCall.args !== "object" || Array.isArray(toolCall.args)) {
    return "";
  }
  const command = (toolCall.args as Record<string, unknown>).command;
  return typeof command === "string" ? command : "";
}

export function canRetryDelegatedOutputWithoutAdditionalToolCalls(input: {
  readonly validationCode?: DelegationOutputValidationCode;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly delegationSpec?: DelegationContractSpec;
  readonly providerEvidence?: LLMProviderEvidence;
}): boolean {
  if (
    input.validationCode !== "expected_json_object" &&
    input.validationCode !== "empty_structured_payload" &&
    input.validationCode !== "blocked_phase_output"
  ) {
    return false;
  }

  if (
    input.validationCode === "blocked_phase_output" &&
    input.delegationSpec &&
    (
      specRequiresFileMutationEvidence(input.delegationSpec) ||
      specRequiresMeaningfulBrowserEvidence(input.delegationSpec)
    )
  ) {
    return false;
  }

  return !getMissingSuccessfulToolEvidenceMessage(
    input.toolCalls,
    input.delegationSpec,
    input.providerEvidence,
  );
}
