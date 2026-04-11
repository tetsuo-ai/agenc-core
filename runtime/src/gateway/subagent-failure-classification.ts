/**
 * Sub-agent failure classification, retry logic, and working-directory
 * resolution for delegated planner steps.
 *
 * Extracted from SubAgentOrchestrator — these helpers classify spawn/runtime
 * failures into retryable categories, resolve delegated working directories,
 * and manage retry budget tracking.
 *
 * @module
 */

import type { PipelinePlannerSubagentStep } from "../workflow/pipeline.js";
import type { Pipeline } from "../workflow/pipeline.js";
import type { SubAgentResult } from "./sub-agent.js";
import type { DelegatedWorkingDirectoryResolution } from "./delegation-tool.js";
import {
  isLegacyDelegatedScopeRequirement,
  sanitizeDelegationContextRequirements,
} from "../utils/delegation-execution-context.js";
import {
  resolveDelegationBudgetHintMs,
} from "./delegation-timeout.js";
import type { SubagentFailureClass, SubagentRetryRule } from "./subagent-orchestrator-types.js";
import {
  DEFAULT_TOOL_BUDGET_PER_REQUEST,
} from "../llm/chat-executor-constants.js";
import { normalizeRuntimeLimit } from "../llm/runtime-limit-policy.js";
import {
  isConcreteExecutableEnvelopeRoot,
  normalizeWorkspaceRoot,
} from "../workflow/path-normalization.js";
import { safeStepStringArray } from "../llm/chat-executor-step-utils.js";

type DelegatedScopeTrustSignal =
  | "trusted_runtime_envelope_mismatch"
  | "model_authored_invalid_root_attempt"
  | "informational_untrusted_cwd_mention"
  | "none";

const TRUSTED_RUNTIME_ENVELOPE_MISMATCH_RE =
  /\bdelegated workspace root\b.*\bdoes not match the child working directory\b|\bdelegated (?:read|write) root\b.*\boutside the canonical workspace root\b|\b(?:required source|target) artifact\b.*\boutside the canonical workspace root\b|\bdelegated workspace root\b.*\bdoes not exist\b/i;
const MODEL_AUTHORED_INVALID_ROOT_ATTEMPT_RE =
  /\brequested delegated (?:workspace root|read root|write root|required source artifact|input artifact|target artifact)\b.*\boutside the trusted parent workspace (?:root|authority)\b/i;

/* ------------------------------------------------------------------ */
/*  Budget & tool budget constants                                     */
/* ------------------------------------------------------------------ */

const DEFAULT_PLANNED_SUBAGENT_TOOL_BUDGET = DEFAULT_TOOL_BUDGET_PER_REQUEST;
const PLANNED_SUBAGENT_TOOL_BUDGET_MS_PER_CALL = 7_500;
const BUDGET_EXCEEDED_RETRY_TOOL_BUDGET_MULTIPLIER = 1.5;
const CONTRACT_CLAUSE_SPLIT_RE = /\bthen\b|;|\n|,(?=\s*(?:and\b|[A-Za-z0-9_`"'/-]))/iu;
const OBSERVATION_CAPABILITY_RE =
  /\b(?:bash|browse|command|execute|find|grep|inspect|list|read|search|shell|stat|trace)\b/i;
const MUTATION_CAPABILITY_RE =
  /\b(?:append|delete|edit|mkdir|modify|patch|save|scaffold|write)\b/i;

/* ------------------------------------------------------------------ */
/*  Budget hint & tool budget resolution                               */
/* ------------------------------------------------------------------ */

export function parseBudgetHintMs(
  hint: string,
  defaultSubagentTimeoutMs: number,
): number {
  return resolveDelegationBudgetHintMs(
    hint,
    defaultSubagentTimeoutMs,
  );
}

export function resolveSubagentToolBudgetPerRequest(params: {
  readonly timeoutMs: number;
  readonly priorFailureClass?: SubagentFailureClass;
  readonly step?: PipelinePlannerSubagentStep;
}): number {
  if (DEFAULT_PLANNED_SUBAGENT_TOOL_BUDGET <= 0) {
    return DEFAULT_PLANNED_SUBAGENT_TOOL_BUDGET;
  }
  if (params.timeoutMs <= 0) {
    return DEFAULT_TOOL_BUDGET_PER_REQUEST;
  }
  const baseBudget = Math.max(
    DEFAULT_PLANNED_SUBAGENT_TOOL_BUDGET,
    Math.ceil(params.timeoutMs / PLANNED_SUBAGENT_TOOL_BUDGET_MS_PER_CALL),
  );
  const boostedBudget =
    params.priorFailureClass === "budget_exceeded"
      ? Math.ceil(
          baseBudget * BUDGET_EXCEEDED_RETRY_TOOL_BUDGET_MULTIPLIER,
        )
      : baseBudget;
  const contractFloor =
    params.step
      ? estimateContractShapedToolBudgetFloor(params.step)
      : DEFAULT_TOOL_BUDGET_PER_REQUEST;
  return normalizeRuntimeLimit(
    Math.max(boostedBudget, contractFloor),
    DEFAULT_TOOL_BUDGET_PER_REQUEST,
  );
}

function collectUniqueExecutionArtifacts(
  step: PipelinePlannerSubagentStep,
): readonly string[] {
  const context = step.executionContext;
  return [
    ...(context?.requiredSourceArtifacts ?? []),
    ...(context?.inputArtifacts ?? []),
    ...(context?.targetArtifacts ?? []),
  ].filter((artifact, index, artifacts) => artifacts.indexOf(artifact) === index);
}

function countContractClauses(step: PipelinePlannerSubagentStep): number {
  const segments = [
    step.objective,
    step.inputContract,
    ...safeStepStringArray(step.acceptanceCriteria),
  ]
    .flatMap((value) => value.split(CONTRACT_CLAUSE_SPLIT_RE))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return segments.length;
}

export function estimateContractShapedToolBudgetFloor(
  step: PipelinePlannerSubagentStep,
): number {
  const capabilities = safeStepStringArray(step.requiredToolCapabilities).map((capability) =>
    capability.trim().toLowerCase()
  );
  const hasObservationCapability = capabilities.some((capability) =>
    OBSERVATION_CAPABILITY_RE.test(capability)
  );
  const hasMutationCapability = capabilities.some((capability) =>
    MUTATION_CAPABILITY_RE.test(capability)
  );
  const artifacts = collectUniqueExecutionArtifacts(step);
  const verificationMode = step.executionContext?.verificationMode;
  const clauseCount = countContractClauses(step);
  let budgetFloor = 1;

  if (artifacts.length > 0) {
    budgetFloor = Math.max(
      budgetFloor,
      Math.min(8, artifacts.length),
    );
  }
  const safeAcceptanceCriteria = safeStepStringArray(step.acceptanceCriteria);
  if (safeAcceptanceCriteria.length > 0) {
    budgetFloor = Math.max(
      budgetFloor,
      Math.min(8, safeAcceptanceCriteria.length),
    );
  }
  if (clauseCount > 0) {
    budgetFloor = Math.max(
      budgetFloor,
      Math.min(8, clauseCount),
    );
  }
  if (verificationMode === "deterministic_followup") {
    budgetFloor += 1;
  }
  if (
    hasMutationCapability &&
    (step.executionContext?.targetArtifacts?.length ?? 0) > 0
  ) {
    budgetFloor += 1;
  }
  if (hasObservationCapability && !hasMutationCapability) {
    budgetFloor = Math.max(budgetFloor, Math.min(6, Math.max(2, clauseCount)));
  }

  return Math.min(12, Math.max(1, budgetFloor));
}

/* ------------------------------------------------------------------ */
/*  Retry attempt tracking                                             */
/* ------------------------------------------------------------------ */

export function createRetryAttemptTracker(): Record<SubagentFailureClass, number> {
  return {
    timeout: 0,
    budget_exceeded: 0,
    tool_misuse: 0,
    malformed_result_contract: 0,
    needs_decomposition: 0,
    invalid_input: 0,
    transient_provider_error: 0,
    cancelled: 0,
    spawn_error: 0,
    unknown: 0,
  };
}

export function computeRetryDelayMs(
  rule: SubagentRetryRule,
  retryAttempt: number,
): number {
  if (rule.maxRetries <= 0 || rule.baseDelayMs <= 0) return 0;
  const scaled = rule.baseDelayMs * Math.max(1, retryAttempt);
  return Math.max(0, Math.min(rule.maxDelayMs, scaled));
}

/* ------------------------------------------------------------------ */
/*  Failure classification                                             */
/* ------------------------------------------------------------------ */

export function classifySpawnFailure(message: string): SubagentFailureClass {
  const lower = message.toLowerCase();
  if (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("deadline exceeded")
  ) {
    return "timeout";
  }
  if (
    lower.includes("temporarily unavailable") ||
    lower.includes("resource temporarily unavailable") ||
    lower.includes("connection reset") ||
    lower.includes("econnreset") ||
    lower.includes("429") ||
    lower.includes("rate limit")
  ) {
    return "transient_provider_error";
  }
  return "spawn_error";
}

function classifySubagentFailureMessage(message: string): SubagentFailureClass {
  const lower = message.toLowerCase();
  if (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("deadline exceeded")
  ) {
    return "timeout";
  }
  if (lower.includes("cancelled") || lower.includes("canceled")) {
    return "cancelled";
  }
  if (
    lower.includes("provider error") ||
    lower.includes("fetch failed") ||
    lower.includes("temporarily unavailable") ||
    lower.includes("connection reset") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("rate limit") ||
    lower.includes("429")
  ) {
    return "transient_provider_error";
  }
  if (
    lower.includes("missing required argument") ||
    lower.includes("invalid argument") ||
    lower.includes("unknown tool") ||
    lower.includes("tool call validation") ||
    lower.includes("command must be one executable token/path") ||
    lower.includes("shell snippets")
  ) {
    return "tool_misuse";
  }
  if (
    lower.includes("malformed result contract") ||
    lower.includes("expected json object")
  ) {
    return "malformed_result_contract";
  }
  return "unknown";
}

export function classifySubagentFailureResult(
  result: Pick<SubAgentResult, "output" | "stopReason" | "stopReasonDetail">,
): SubagentFailureClass {
  if (result.stopReason === "timeout") return "timeout";
  if (result.stopReason === "budget_exceeded") return "budget_exceeded";
  if (result.stopReason === "cancelled") return "cancelled";
  if (
    result.stopReason === "provider_error" ||
    result.stopReason === "authentication_error" ||
    result.stopReason === "rate_limited"
  ) {
    return "transient_provider_error";
  }
  const message =
    typeof result.stopReasonDetail === "string" &&
      result.stopReasonDetail.trim().length > 0
      ? result.stopReasonDetail
      : (typeof result.output === "string" ? result.output : "");
  return classifySubagentFailureMessage(message);
}

/* ------------------------------------------------------------------ */
/*  Delegated working directory resolution                             */
/* ------------------------------------------------------------------ */

export function isAnchoredDelegatedWorkingDirectory(path: string): boolean {
  const normalized = path.trim();
  if (normalized.length === 0) return false;
  if (normalized.startsWith("/")) return true;
  if (/^[a-zA-Z]:[\\/]/.test(normalized)) return true;
  if (normalized.startsWith("~")) return true;
  return false;
}

export function stepRequiresStructuredDelegatedFilesystemScope(
  step: PipelinePlannerSubagentStep,
): boolean {
  return Boolean(
    step.executionContext?.workspaceRoot?.trim().length ||
      step.executionContext?.allowedReadRoots?.length ||
      step.executionContext?.allowedWriteRoots?.length ||
      step.executionContext?.requiredSourceArtifacts?.length ||
      step.executionContext?.targetArtifacts?.length,
  );
}

export function resolvePlannerStepWorkingDirectory(
  step: PipelinePlannerSubagentStep,
  pipeline: Pipeline,
  hostWorkspaceRoot?: string | null,
): {
  readonly path: string;
  readonly anchored: boolean;
  readonly source?: DelegatedWorkingDirectoryResolution["source"];
} | undefined {
  void pipeline;
  void hostWorkspaceRoot;
  const rawWorkspaceRoot = step.executionContext?.workspaceRoot;
  if (isConcreteExecutableEnvelopeRoot(rawWorkspaceRoot)) {
    const workspaceRoot = normalizeWorkspaceRoot(rawWorkspaceRoot);
    if (!workspaceRoot) {
      return undefined;
    }
    return {
      path: workspaceRoot,
      anchored: isAnchoredDelegatedWorkingDirectory(
        workspaceRoot,
      ),
      source: "execution_envelope",
    };
  }

  return undefined;
}

export function buildEffectiveContextRequirements(
  step: PipelinePlannerSubagentStep,
): readonly string[] {
  return sanitizeDelegationContextRequirements(step.contextRequirements);
}

export function classifyDelegatedScopeTrustSignal(input: {
  readonly message?: string | null;
  readonly contextRequirements?: readonly (string | undefined | null)[];
}): DelegatedScopeTrustSignal {
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (message.length > 0) {
    if (MODEL_AUTHORED_INVALID_ROOT_ATTEMPT_RE.test(message)) {
      return "model_authored_invalid_root_attempt";
    }
    if (TRUSTED_RUNTIME_ENVELOPE_MISMATCH_RE.test(message)) {
      return "trusted_runtime_envelope_mismatch";
    }
  }

  if (
    (input.contextRequirements ?? []).some((value) =>
      isLegacyDelegatedScopeRequirement(value)
    )
  ) {
    return "informational_untrusted_cwd_mention";
  }

  return "none";
}

/* ------------------------------------------------------------------ */
/*  High risk capabilities check                                       */
/* ------------------------------------------------------------------ */

export function hasHighRiskCapabilities(capabilities: readonly string[]): boolean {
  for (const capability of capabilities) {
    const normalized = capability.trim().toLowerCase();
    if (!normalized) continue;
    if (
      normalized.startsWith("wallet.") ||
      normalized.startsWith("solana.") ||
      normalized.startsWith("agenc.") ||
      normalized.startsWith("desktop.") ||
      normalized === "system.delete" ||
      normalized === "system.execute" ||
      normalized === "system.open" ||
      normalized === "system.applescript" ||
      normalized === "system.notification"
    ) {
      return true;
    }
  }
  return false;
}
