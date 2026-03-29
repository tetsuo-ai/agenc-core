/**
 * Subagent verifier/critic functions for ChatExecutor.
 *
 * @module
 */

import type {
  PipelinePlannerContext,
  PipelineResult,
} from "../workflow/pipeline.js";
import type {
  PlannerDeterministicToolStepIntent,
  PlannerSubAgentTaskStepIntent,
  PlannerWorkflowAdmission,
  PlannerVerifierWorkItem,
  PlannerPlan,
  SubagentVerifierStepVerdict,
  SubagentVerifierStepAssessment,
  SubagentVerifierDecision,
} from "./chat-executor-types.js";
import type {
  LLMMessage,
  LLMProviderEvidence,
  LLMProviderNativeServerToolCall,
  LLMProviderServerSideToolUsageEntry,
  LLMStructuredOutputRequest,
} from "./types.js";
import type { ImplementationCompletionContract } from "../workflow/completion-contract.js";
import type {
  WorkflowRequestCompletionContract,
  WorkflowRequestMilestone,
} from "../workflow/request-completion.js";
import type { WorkflowVerificationContract } from "../workflow/verification-obligations.js";
import { isDocumentationArtifactPath } from "../workflow/artifact-paths.js";
import {
  DEFAULT_SUBAGENT_VERIFIER_MIN_CONFIDENCE,
  MAX_SUBAGENT_VERIFIER_OUTPUT_CHARS,
  MAX_SUBAGENT_VERIFIER_ARTIFACT_CHARS,
} from "./chat-executor-constants.js";
import { truncateText } from "./chat-executor-text.js";
import {
  parsePlannerRequiredString,
  parsePlannerOptionalString,
} from "./chat-executor-planner.js";
import { safeStringify } from "../tools/types.js";
import { deriveVerificationObligations } from "../workflow/verification-obligations.js";
import { validateRuntimeVerificationContract } from "../workflow/verification-contract.js";
import { canonicalizeExecutionStepKind } from "../workflow/execution-intent.js";
import {
  extractDelegationTokens,
  validateDelegatedOutputContract,
} from "../utils/delegation-validation.js";
import { parseJsonObjectFromText } from "../utils/delegated-contract-normalization.js";

const DIRECT_MUTATION_TOOL_NAMES = new Set([
  "desktop.text_editor",
  "system.appendFile",
  "system.delete",
  "system.mkdir",
  "system.move",
  "system.writeFile",
]);

const SHELL_MUTATION_RE =
  /(?:^|[;&|]\s*|\n)\s*(?:cp|mv|rm|mkdir|touch|tee|sed|perl|python|node|ruby|go|cargo|npm|pnpm|yarn|make|cmake)\b|>>?|(?:^|[;&|]\s*|\n)\s*cat\s+.+>>?/i;
const DETERMINISTIC_IMPLEMENTATION_COMMAND_RE =
  /\b(?:implement|implementation|fix|repair|refactor|migrate|write|edit|update|create|build|compile|typecheck|lint|test|install|scaffold)\b/i;
const SOURCE_LIKE_PATH_RE =
  /(?:^|\/)(?:src|lib|app|server|client|cmd|pkg|include|internal|tests?|spec)(?:\/|$)|\.(?:c|cc|cpp|cxx|h|hpp|m|mm|rs|go|py|rb|php|java|kt|swift|cs|js|jsx|ts|tsx|json|toml|yaml|yml|xml|sh|zsh|bash)$/i;

export function buildPlannerWorkflowAdmission(params: {
  readonly subagentSteps: readonly PlannerSubAgentTaskStepIntent[];
  readonly deterministicSteps: readonly PlannerDeterministicToolStepIntent[];
  readonly workspaceRoot?: string;
  readonly verificationContract?: WorkflowVerificationContract;
  readonly completionContract?: ImplementationCompletionContract;
  readonly includeSubagentOutputVerification?: boolean;
  readonly requiredSubagentOutputStepNames?: readonly string[];
}): PlannerWorkflowAdmission {
  const completionContract = resolvePlannerCompletionContract(params);
  const verificationContract = buildPlannerWorkflowVerificationContract({
    workspaceRoot: params.workspaceRoot,
    subagentSteps: params.subagentSteps,
    deterministicSteps: params.deterministicSteps,
    verificationContract: params.verificationContract,
    completionContract,
  });
  const taskClassification = classifyPlannerWorkflowAdmission({
    workspaceRoot: params.workspaceRoot,
    completionContract,
  });
  if (taskClassification === "invalid") {
    return {
      taskClassification,
      verificationContract,
      completionContract,
      verifierWorkItems: [],
      requiresMandatoryImplementationVerification: false,
      requiresMandatorySubagentOutputVerification: false,
      invalidReason:
        "Implementation-class planner work requires a runtime-owned workspace root and workflow contract before execution can begin.",
    };
  }
  const requiredSubagentOutputStepNames = new Set(
    (params.requiredSubagentOutputStepNames ?? [])
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  );
  const subagentStepsForVerification =
    params.includeSubagentOutputVerification === false
      ? params.subagentSteps.filter((step) =>
        requiredSubagentOutputStepNames.has(step.name)
      )
      : params.subagentSteps;
  const verifierWorkItems: PlannerVerifierWorkItem[] =
    subagentStepsForVerification.map((step) => ({
        name: step.name,
        verificationKind: "subagent_output",
        objective: step.objective,
        inputContract: step.inputContract,
        acceptanceCriteria: step.acceptanceCriteria,
        requiredToolCapabilities: step.requiredToolCapabilities,
        resultStepNames: [step.name],
      }));
  const requiresMandatoryImplementationVerification =
    taskClassification === "implementation_class";
  const requiresMandatorySubagentOutputVerification =
    requiredSubagentOutputStepNames.size > 0;

  if (requiresMandatoryImplementationVerification) {
    verifierWorkItems.push(
      buildDeterministicImplementationVerifierWorkItem(
        completionContract!,
        params.subagentSteps,
        params.deterministicSteps,
        verificationContract,
      ),
    );
  }

  return {
    taskClassification,
    verificationContract,
    completionContract,
    verifierWorkItems,
    requiresMandatoryImplementationVerification,
    requiresMandatorySubagentOutputVerification,
  };
}

export function buildPlannerVerifierAdmission(params: {
  readonly subagentSteps: readonly PlannerSubAgentTaskStepIntent[];
  readonly deterministicSteps: readonly PlannerDeterministicToolStepIntent[];
  readonly workspaceRoot?: string;
  readonly verificationContract?: WorkflowVerificationContract;
  readonly completionContract?: ImplementationCompletionContract;
  readonly includeSubagentOutputVerification?: boolean;
  readonly requiredSubagentOutputStepNames?: readonly string[];
}): {
  readonly verifierWorkItems: readonly PlannerVerifierWorkItem[];
  readonly requiresMandatoryImplementationVerification: boolean;
  readonly requiresMandatorySubagentOutputVerification: boolean;
} {
  const admission = buildPlannerWorkflowAdmission(params);
  return {
    verifierWorkItems: admission.verifierWorkItems,
    requiresMandatoryImplementationVerification:
      admission.requiresMandatoryImplementationVerification,
    requiresMandatorySubagentOutputVerification:
      admission.requiresMandatorySubagentOutputVerification,
  };
}

export function evaluatePlannerDeterministicChecks(
  verifierWorkItems: readonly PlannerVerifierWorkItem[],
  pipelineResult: PipelineResult,
  plannerContext: PipelinePlannerContext,
  plannerToolCalls: readonly import("./chat-executor-types.js").ToolCallRecord[],
): SubagentVerifierDecision {
  const stepAssessments: SubagentVerifierStepAssessment[] = [];
  const unresolvedItems: string[] = [];
  const artifactCorpus = collectVerifierArtifacts(
    pipelineResult,
    plannerContext,
  );
  const artifactText = artifactCorpus.join(" ").toLowerCase();

  for (const step of verifierWorkItems) {
    const raw = resolveVerifierWorkItemOutput(step, pipelineResult);
    const issues: string[] = [];
    let verdict: SubagentVerifierStepVerdict = "pass";
    let retryable = true;
    let output = "";
    let status = "unknown";
    let toolCallsCount = 0;
    let failedToolCallsCount = 0;
    let childToolCalls:
      | readonly {
        readonly name?: string;
        readonly args?: unknown;
        readonly result?: string;
        readonly isError?: boolean;
      }[]
      | undefined;
    let providerEvidence: LLMProviderEvidence | undefined;

    if (typeof raw !== "string") {
      issues.push("missing_subagent_result");
      verdict = "retry";
    } else if (step.verificationKind === "deterministic_implementation") {
      const implementationToolCalls =
        collectDeterministicImplementationToolCalls({
          pipelineResult,
          plannerToolCalls,
          resultStepNames: step.resultStepNames,
        });
      const implementationProviderEvidence =
        collectDeterministicImplementationProviderEvidence({
          pipelineResult,
          resultStepNames: step.resultStepNames,
        });
      output = raw;
      status = "completed";
      toolCallsCount = implementationToolCalls.length;
      failedToolCallsCount = implementationToolCalls.filter(
        (toolCall) => toolCall.isError === true,
      ).length;
      if (output.trim().length === 0) {
        issues.push("missing_implementation_output_evidence");
        verdict = "retry";
      } else if (step.verificationContract) {
        const hybridDecision = validateRuntimeVerificationContract({
          verificationContract: step.verificationContract,
          output: trimmedOrRawOutput(raw),
          toolCalls: implementationToolCalls,
          providerEvidence: implementationProviderEvidence,
        });
        if (hybridDecision && !hybridDecision.ok) {
          const hybridIssues = collectHybridVerifierIssues(hybridDecision);
          if (hybridIssues.length > 0) {
            issues.push(...hybridIssues);
          }
          verdict = "fail";
          retryable = false;
        }
      }
    } else {
      const parsed = parseJsonObjectFromText(raw);
      if (!parsed) {
        issues.push("malformed_subagent_result_payload");
        verdict = "retry";
        output = raw;
      } else {
        status = typeof parsed.status === "string"
          ? parsed.status.toLowerCase()
          : "unknown";
        output = typeof parsed.output === "string"
          ? parsed.output
          : safeStringify(parsed.output ?? "");
        childToolCalls = Array.isArray(parsed.toolCalls)
          ? parsed.toolCalls
              .filter(
                (entry): entry is {
                  readonly name?: string;
                  readonly args?: unknown;
                  readonly result?: string;
                  readonly isError?: boolean;
                } =>
                  typeof entry === "object" &&
                  entry !== null &&
                  !Array.isArray(entry),
              )
          : undefined;
        toolCallsCount = Array.isArray(parsed.toolCalls)
          ? parsed.toolCalls.length
          : typeof parsed.toolCalls === "number"
          ? parsed.toolCalls
          : 0;
        failedToolCallsCount = typeof parsed.failedToolCalls === "number"
          ? parsed.failedToolCalls
          : 0;
        const parsedProviderEvidence = parsed.providerEvidence;
        providerEvidence = parseStructuredProviderEvidence(parsedProviderEvidence);
        if (parsed.success === false || status === "failed") {
          issues.push("child_reported_failure");
          verdict = "retry";
        }
        if (status === "cancelled") {
          issues.push("child_cancelled");
          verdict = "fail";
          retryable = false;
        }
        if (status === "delegation_fallback") {
          issues.push("child_used_parent_fallback");
          verdict = "fail";
          retryable = false;
        }
      }
    }

    const trimmedOutput = output.trim();
    if (step.verificationKind === "subagent_output") {
      const contractValidation = validateDelegatedOutputContract({
        spec: {
          objective: step.objective,
          inputContract: step.inputContract,
          acceptanceCriteria: step.acceptanceCriteria,
          requiredToolCapabilities: step.requiredToolCapabilities,
        },
        output: trimmedOutput,
        toolCalls: childToolCalls,
        providerEvidence,
      });
      if (!contractValidation.ok) {
        if (contractValidation.code === "empty_output") {
          issues.push("empty_child_output");
        } else if (
          contractValidation.code === "expected_json_object" ||
          contractValidation.code === "empty_structured_payload"
        ) {
          issues.push("contract_violation_expected_json_output");
        } else if (contractValidation.code === "acceptance_count_mismatch") {
          issues.push("contract_violation_acceptance_criteria_count");
        } else if (contractValidation.code === "acceptance_evidence_missing") {
          issues.push("acceptance_criteria_not_evidenced");
        } else if (
          contractValidation.code === "contradictory_completion_claim"
        ) {
          issues.push("child_claimed_completion_with_unresolved_work");
        } else if (contractValidation.code === "low_signal_browser_evidence") {
          issues.push("low_signal_browser_evidence");
        } else if (contractValidation.code === "missing_successful_tool_evidence") {
          issues.push("missing_successful_tool_evidence");
        } else if (
          contractValidation.code === "missing_required_source_evidence"
        ) {
          issues.push("missing_required_source_evidence");
        } else if (
          contractValidation.code === "missing_workspace_inspection_evidence"
        ) {
          issues.push("missing_workspace_inspection_evidence");
        } else if (
          contractValidation.code === "missing_file_artifact_evidence"
        ) {
          issues.push("missing_or_unauthorized_target_artifact_evidence");
        } else {
          issues.push(`contract_violation_${contractValidation.code}`);
        }
        verdict = moreSevereVerifierVerdict(verdict, "retry");
      }
    }

    const outputLower = trimmedOutput.toLowerCase();
    const likelyEvidence =
      /(line|file|log|trace|stderr|stdout|stack|error|\d)/.test(outputLower);
    if (trimmedOutput.length > 0 && !likelyEvidence) {
      issues.push("weak_evidence_density");
    }

    if (
      trimmedOutput.length > 0 &&
      /(according to|as seen in|from the logs|based on)/.test(outputLower) &&
      artifactText.length > 0 &&
      !outputIntersectsArtifacts(outputLower, artifactText)
    ) {
      issues.push("hallucination_risk_artifact_mismatch");
      verdict = moreSevereVerifierVerdict(verdict, "retry");
    }

    if (step.requiredToolCapabilities.length > 0 && toolCallsCount === 0) {
      issues.push("missing_tool_result_consistency_signal");
    }
    if (
      step.requiredToolCapabilities.length > 0 &&
      toolCallsCount > 0 &&
      failedToolCallsCount >= toolCallsCount
    ) {
      issues.push("missing_successful_tool_evidence");
      verdict = moreSevereVerifierVerdict(verdict, "retry");
    }

    const confidence = Math.max(0, 1 - Math.min(0.9, issues.length * 0.18));
    if (verdict !== "pass" || confidence < DEFAULT_SUBAGENT_VERIFIER_MIN_CONFIDENCE) {
      unresolvedItems.push(
        `${step.name}:${issues.length > 0 ? issues.join(",") : "low_confidence"}`,
      );
    }
    stepAssessments.push({
      name: step.name,
      verdict,
      confidence,
      retryable,
      issues,
      summary:
        issues.length > 0
          ? issues.join("; ")
          : "deterministic verifier checks passed",
    });
  }

  const overall = resolveVerifierOverall(stepAssessments);
  const confidence = stepAssessments.length > 0
    ? Number(
        (
          stepAssessments.reduce((sum, step) => sum + step.confidence, 0) /
          stepAssessments.length
        ).toFixed(4),
      )
    : 1;
  return {
    overall,
    confidence,
    unresolvedItems,
    steps: stepAssessments,
    source: "deterministic",
  };
}

function collectHybridVerifierIssues(
  decision: ReturnType<typeof validateRuntimeVerificationContract>,
): readonly string[] {
  if (!decision) {
    return [];
  }
  const issues: string[] = [];
  for (const channel of decision.channels) {
    if (channel.ok) {
      continue;
    }
    issues.push(
      `${channel.channel}:${channel.diagnostic?.code ?? "verification_failed"}`,
    );
  }
  if (issues.length > 0) {
    return [...new Set(issues)];
  }
  if (decision.diagnostic?.code) {
    return [decision.diagnostic.code];
  }
  return [];
}

function trimmedOrRawOutput(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : value;
}

export function buildSubagentVerifierMessages(
  systemPrompt: string,
  messageText: string,
  plannerPlan: PlannerPlan,
  verifierWorkItems: readonly PlannerVerifierWorkItem[],
  pipelineResult: PipelineResult,
  plannerContext: PipelinePlannerContext,
  deterministicDecision: SubagentVerifierDecision,
): readonly LLMMessage[] {
  const artifactBundle = collectVerifierArtifacts(
    pipelineResult,
    plannerContext,
  );
  const verifierBundle = verifierWorkItems.map((step) => ({
    name: step.name,
    verificationKind: step.verificationKind,
    objective: step.objective,
    inputContract: step.inputContract,
    acceptanceCriteria: step.acceptanceCriteria,
    requiredToolCapabilities: step.requiredToolCapabilities,
    rawResult: truncateText(
      resolveVerifierWorkItemOutput(step, pipelineResult) ?? "missing",
      MAX_SUBAGENT_VERIFIER_OUTPUT_CHARS,
    ),
  }));
  return [
    { role: "system", content: systemPrompt },
    {
      role: "system",
      content:
        "You are a strict verifier for delegated outputs and deterministic implementation runs. " +
        "Assess contract adherence, evidence quality, hallucination risk against provided artifacts, and whether the work is actually complete enough to count as implemented. " +
        "Return JSON only with schema: " +
        '{"overall":"pass|retry|fail","confidence":0..1,"unresolved":[string],"steps":[{"name":string,"verdict":"pass|retry|fail","confidence":0..1,"retryable":boolean,"issues":[string],"summary":string}]}.',
    },
    {
      role: "user",
      content: safeStringify({
        request: messageText,
        plannerReason: plannerPlan.reason,
        deterministicVerifier: deterministicDecision,
        verifierBundle,
        artifacts: artifactBundle.map((entry) =>
          truncateText(entry, MAX_SUBAGENT_VERIFIER_ARTIFACT_CHARS)
        ),
      }),
    },
  ];
}

export function buildSubagentVerifierStructuredOutputRequest(): LLMStructuredOutputRequest {
  return {
    enabled: true,
    schema: {
      type: "json_schema",
      name: "agenc_subagent_verifier_decision",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          overall: {
            enum: ["pass", "retry", "fail"],
          },
          confidence: { type: "number" },
          unresolved: {
            type: "array",
            items: { type: "string" },
          },
          steps: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                verdict: { enum: ["pass", "retry", "fail"] },
                confidence: { type: "number" },
                retryable: { type: "boolean" },
                issues: {
                  type: "array",
                  items: { type: "string" },
                },
                summary: { type: "string" },
              },
              required: [
                "name",
                "verdict",
                "confidence",
                "retryable",
                "issues",
                "summary",
              ],
            },
          },
        },
        required: ["overall", "confidence", "unresolved", "steps"],
      },
    },
  };
}

export function parseSubagentVerifierDecision(
  content: string | Record<string, unknown>,
  verifierWorkItems: readonly PlannerVerifierWorkItem[],
): SubagentVerifierDecision | undefined {
  const parsed =
    typeof content === "string" ? parseJsonObjectFromText(content) : content;
  if (!parsed) return undefined;
  const overallRaw = parsed.overall;
  if (
    overallRaw !== "pass" &&
    overallRaw !== "retry" &&
    overallRaw !== "fail"
  ) {
    return undefined;
  }
  const confidenceRaw = parsed.confidence;
  const confidence = typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0.5;
  const unresolvedItems = Array.isArray(parsed.unresolved)
    ? parsed.unresolved
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];
  const stepsByName = new Map(verifierWorkItems.map((step) => [step.name, step]));
  const parsedSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
  const assessments: SubagentVerifierStepAssessment[] = [];
  for (const entry of parsedSteps) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry)
    ) {
      continue;
    }
    const obj = entry as Record<string, unknown>;
    const name = parsePlannerRequiredString(obj.name);
    if (!name || !stepsByName.has(name)) continue;
    const verdictRaw = obj.verdict;
    if (
      verdictRaw !== "pass" &&
      verdictRaw !== "retry" &&
      verdictRaw !== "fail"
    ) {
      continue;
    }
    const stepConfidenceRaw = obj.confidence;
    const stepConfidence =
      typeof stepConfidenceRaw === "number" && Number.isFinite(stepConfidenceRaw)
        ? Math.max(0, Math.min(1, stepConfidenceRaw))
        : confidence;
    const retryable =
      typeof obj.retryable === "boolean" ? obj.retryable : true;
    const issues = Array.isArray(obj.issues)
      ? obj.issues
          .filter((issue): issue is string => typeof issue === "string")
          .map((issue) => issue.trim())
          .filter((issue) => issue.length > 0)
      : [];
    const summary = parsePlannerOptionalString(obj.summary) ??
      (issues.length > 0 ? issues.join("; ") : "verifier assessment");
    assessments.push({
      name,
      verdict: verdictRaw,
      confidence: stepConfidence,
      retryable,
      issues,
      summary,
    });
  }
  if (assessments.length === 0) return undefined;
  return {
    overall: overallRaw,
    confidence,
    unresolvedItems,
    steps: assessments,
    source: "model",
  };
}

export function buildMandatoryPlannerVerificationFailureDecision(params: {
  readonly verifierWorkItems: readonly PlannerVerifierWorkItem[];
  readonly reason:
    | "planner_verifier_unavailable"
    | "planner_verifier_parse_failed";
}): SubagentVerifierDecision {
  const summary =
    params.reason === "planner_verifier_unavailable"
      ? "planner verifier could not run for a completion-critical implementation task"
      : "planner verifier returned malformed output for a completion-critical implementation task";
  const steps = params.verifierWorkItems.map((step) => ({
    name: step.name,
    verdict: "fail" as const,
    confidence: 0,
    retryable: false,
    issues: [params.reason],
    summary,
  }));
  return {
    overall: "fail",
    confidence: 0,
    unresolvedItems: steps.map((step) => `${step.name}:${summary}`),
    steps,
    source: "deterministic",
  };
}

export function mergeSubagentVerifierDecisions(
  deterministic: SubagentVerifierDecision,
  model: SubagentVerifierDecision,
): SubagentVerifierDecision {
  const byName = new Map<string, SubagentVerifierStepAssessment>();
  for (const step of deterministic.steps) {
    byName.set(step.name, step);
  }
  for (const step of model.steps) {
    const existing = byName.get(step.name);
    if (!existing) {
      byName.set(step.name, step);
      continue;
    }
    const mergedVerdict = moreSevereVerifierVerdict(
      existing.verdict,
      step.verdict,
    );
    const mergedIssues = [...new Set([...existing.issues, ...step.issues])];
    byName.set(step.name, {
      name: step.name,
      verdict: mergedVerdict,
      confidence: Math.min(existing.confidence, step.confidence),
      retryable: existing.retryable && step.retryable,
      issues: mergedIssues,
      summary:
        mergedIssues.length > 0
          ? mergedIssues.join("; ")
          : "merged verifier checks passed",
    });
  }
  const steps = [...byName.values()];
  const overall = resolveVerifierOverall(steps);
  const unresolvedItems = [
    ...new Set([
      ...deterministic.unresolvedItems,
      ...model.unresolvedItems,
      ...steps
        .filter((step) => step.verdict !== "pass")
        .map((step) => `${step.name}:${step.summary}`),
    ]),
  ];
  return {
    overall,
    confidence: Math.min(deterministic.confidence, model.confidence),
    unresolvedItems,
    steps,
    source: "merged",
  };
}

export function resolveVerifierOverall(
  steps: readonly SubagentVerifierStepAssessment[],
): "pass" | "retry" | "fail" {
  let overall: "pass" | "retry" | "fail" = "pass";
  for (const step of steps) {
    overall = moreSevereVerifierVerdict(overall, step.verdict);
    if (overall === "fail") return "fail";
  }
  return overall;
}

export function moreSevereVerifierVerdict(
  a: SubagentVerifierStepVerdict,
  b: SubagentVerifierStepVerdict,
): SubagentVerifierStepVerdict {
  const weight: Record<SubagentVerifierStepVerdict, number> = {
    pass: 0,
    retry: 1,
    fail: 2,
  };
  return weight[a] >= weight[b] ? a : b;
}

export function extractVerifierTokens(value: string): string[] {
  return extractDelegationTokens(value);
}

export function collectVerifierArtifacts(
  pipelineResult: PipelineResult,
  plannerContext: PipelinePlannerContext,
): readonly string[] {
  const artifacts: string[] = [];
  for (const item of plannerContext.toolOutputs ?? []) {
    artifacts.push(item.content);
  }
  for (const item of plannerContext.memory ?? []) {
    artifacts.push(item.content);
  }
  for (const item of Object.values(pipelineResult.context.results)) {
    if (typeof item !== "string") continue;
    artifacts.push(item);
  }
  return artifacts
    .map((entry) => truncateText(entry, MAX_SUBAGENT_VERIFIER_ARTIFACT_CHARS))
    .filter((entry) => entry.length > 0)
    .slice(0, 24);
}

function resolveVerifierWorkItemOutput(
  step: PlannerVerifierWorkItem,
  pipelineResult: PipelineResult,
): string | undefined {
  const resultStepNames =
    step.resultStepNames && step.resultStepNames.length > 0
      ? step.resultStepNames
      : [step.name];
  const values = resultStepNames
    .map((name) => pipelineResult.context.results[name])
    .filter((value): value is string => typeof value === "string");
  if (values.length === 0) {
    return undefined;
  }
  if (values.length === 1) {
    return values[0];
  }
  return values
    .map((value, index) => `result_${index + 1}: ${value}`)
    .join("\n");
}

function collectDeterministicImplementationToolCalls(params: {
  readonly pipelineResult: PipelineResult;
  readonly plannerToolCalls: readonly import("./chat-executor-types.js").ToolCallRecord[];
  readonly resultStepNames?: readonly string[];
}): readonly {
  readonly name?: string;
  readonly args?: unknown;
  readonly result?: string;
  readonly isError?: boolean;
}[] {
  const calls: {
    readonly name?: string;
    readonly args?: unknown;
    readonly result?: string;
    readonly isError?: boolean;
  }[] = [...params.plannerToolCalls];
  const seenSignatures = new Set(
    calls.map((toolCall) => stableVerifierToolCallSignature(toolCall)),
  );
  const resultStepNames =
    params.resultStepNames && params.resultStepNames.length > 0
      ? params.resultStepNames
      : Object.keys(params.pipelineResult.context.results);

  for (const stepName of resultStepNames) {
    const raw = params.pipelineResult.context.results[stepName];
    if (typeof raw !== "string") {
      continue;
    }
    const parsed = parseJsonObjectFromText(raw);
    const nestedToolCalls = Array.isArray(parsed?.toolCalls)
      ? parsed.toolCalls
      : [];
    for (const entry of nestedToolCalls) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        Array.isArray(entry)
      ) {
        continue;
      }
      const toolCall = entry as {
        readonly name?: string;
        readonly args?: unknown;
        readonly result?: string;
        readonly isError?: boolean;
      };
      const signature = stableVerifierToolCallSignature(toolCall);
      if (seenSignatures.has(signature)) {
        continue;
      }
      seenSignatures.add(signature);
      calls.push(toolCall);
    }
  }

  return calls;
}

function collectDeterministicImplementationProviderEvidence(params: {
  readonly pipelineResult: PipelineResult;
  readonly resultStepNames?: readonly string[];
}): LLMProviderEvidence | undefined {
  const citations = new Set<string>();
  const serverSideToolCalls = new Map<string, LLMProviderNativeServerToolCall>();
  const serverSideToolUsage = new Map<string, LLMProviderServerSideToolUsageEntry>();
  const resultStepNames =
    params.resultStepNames && params.resultStepNames.length > 0
      ? params.resultStepNames
      : Object.keys(params.pipelineResult.context.results);

  for (const stepName of resultStepNames) {
    const raw = params.pipelineResult.context.results[stepName];
    if (typeof raw !== "string") {
      continue;
    }
    const parsed = parseJsonObjectFromText(raw);
    const providerEvidence = parseStructuredProviderEvidence(parsed?.providerEvidence);
    if (!providerEvidence) {
      continue;
    }
    for (const citation of providerEvidence.citations ?? []) {
      if (typeof citation === "string" && citation.trim().length > 0) {
        citations.add(citation.trim());
      }
    }
    for (const toolCall of providerEvidence.serverSideToolCalls ?? []) {
      serverSideToolCalls.set(
        stableVerifierServerSideToolCallSignature(toolCall),
        toolCall,
      );
    }
    for (const entry of providerEvidence.serverSideToolUsage ?? []) {
      const key = `${entry.category}::${entry.toolType ?? ""}`;
      const current = serverSideToolUsage.get(key);
      serverSideToolUsage.set(key, {
        category: entry.category,
        ...(entry.toolType ? { toolType: entry.toolType } : {}),
        count: (current?.count ?? 0) + entry.count,
      });
    }
  }

  if (
    citations.size === 0 &&
    serverSideToolCalls.size === 0 &&
    serverSideToolUsage.size === 0
  ) {
    return undefined;
  }
  return {
    ...(citations.size > 0 ? { citations: [...citations] } : {}),
    ...(serverSideToolCalls.size > 0
      ? { serverSideToolCalls: [...serverSideToolCalls.values()] }
      : {}),
    ...(serverSideToolUsage.size > 0
      ? { serverSideToolUsage: [...serverSideToolUsage.values()] }
      : {}),
  };
}

function parseStructuredProviderEvidence(
  value: unknown,
): LLMProviderEvidence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const citations = Array.isArray(record.citations)
    ? record.citations
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
    : [];
  const serverSideToolCalls = Array.isArray(record.serverSideToolCalls)
    ? record.serverSideToolCalls
      .map((entry) => parseStructuredServerSideToolCall(entry))
      .filter(
        (entry): entry is LLMProviderNativeServerToolCall => entry !== undefined,
      )
    : [];
  const serverSideToolUsage = Array.isArray(record.serverSideToolUsage)
    ? record.serverSideToolUsage
      .map((entry) => parseStructuredServerSideToolUsageEntry(entry))
      .filter(
        (entry): entry is LLMProviderServerSideToolUsageEntry =>
          entry !== undefined,
      )
    : [];

  if (
    citations.length === 0 &&
    serverSideToolCalls.length === 0 &&
    serverSideToolUsage.length === 0
  ) {
    return undefined;
  }

  return {
    ...(citations.length > 0 ? { citations } : {}),
    ...(serverSideToolCalls.length > 0 ? { serverSideToolCalls } : {}),
    ...(serverSideToolUsage.length > 0 ? { serverSideToolUsage } : {}),
  };
}

function parseStructuredServerSideToolCall(
  value: unknown,
): LLMProviderNativeServerToolCall | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.type !== "string" ||
    typeof record.toolType !== "string"
  ) {
    return undefined;
  }
  const normalized: LLMProviderNativeServerToolCall = {
    type: record.type as LLMProviderNativeServerToolCall["type"],
    toolType: record.toolType as LLMProviderNativeServerToolCall["toolType"],
    ...(typeof record.id === "string" ? { id: record.id } : {}),
    ...(typeof record.functionName === "string"
      ? { functionName: record.functionName }
      : {}),
    ...(typeof record.arguments === "string"
      ? { arguments: record.arguments }
      : {}),
    ...(typeof record.status === "string" ? { status: record.status } : {}),
    ...(record.raw && typeof record.raw === "object" && !Array.isArray(record.raw)
      ? { raw: record.raw as Record<string, unknown> }
      : {}),
  };
  return normalized;
}

function parseStructuredServerSideToolUsageEntry(
  value: unknown,
): LLMProviderServerSideToolUsageEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.category !== "string" ||
    typeof record.count !== "number" ||
    !Number.isFinite(record.count) ||
    record.count <= 0
  ) {
    return undefined;
  }
  return {
    category: record.category,
    ...(typeof record.toolType === "string"
      ? { toolType: record.toolType as LLMProviderServerSideToolUsageEntry["toolType"] }
      : {}),
    count: record.count,
  };
}

function stableVerifierServerSideToolCallSignature(
  toolCall: LLMProviderNativeServerToolCall,
): string {
  return safeStringify({
    type: toolCall.type,
    toolType: toolCall.toolType,
    id: toolCall.id,
    functionName: toolCall.functionName,
    arguments: toolCall.arguments,
    status: toolCall.status,
  });
}

function stableVerifierToolCallSignature(toolCall: {
  readonly name?: string;
  readonly args?: unknown;
  readonly result?: string;
  readonly isError?: boolean;
}): string {
  return safeStringify({
    name: toolCall.name,
    args: toolCall.args,
    result: toolCall.result,
    isError: toolCall.isError === true,
  });
}

function resolvePlannerCompletionContract(params: {
  readonly subagentSteps: readonly PlannerSubAgentTaskStepIntent[];
  readonly deterministicSteps: readonly PlannerDeterministicToolStepIntent[];
  readonly verificationContract?: WorkflowVerificationContract;
  readonly completionContract?: ImplementationCompletionContract;
}): ImplementationCompletionContract | undefined {
  const obligations = deriveVerificationObligations({
    ...(params.verificationContract ?? {}),
    ...(params.completionContract
      ? { completionContract: params.completionContract }
      : {}),
  });
  if (obligations?.completionContract) {
    return obligations.completionContract;
  }
  const subagentCompletionContract = resolvePlannerSubagentCompletionContract(
    params.subagentSteps,
  );
  if (subagentCompletionContract) {
    return subagentCompletionContract;
  }
  const deterministicCompletionContract =
    resolveDeterministicImplementationCompletionContract(
      params.deterministicSteps,
    );
  if (!deterministicCompletionContract) {
    return undefined;
  }
  return deterministicCompletionContract;
}

function resolvePlannerSubagentCompletionContract(
  subagentSteps: readonly PlannerSubAgentTaskStepIntent[],
): ImplementationCompletionContract | undefined {
  let fallbackContract: ImplementationCompletionContract | undefined;
  for (const step of subagentSteps) {
    const executionContext = step.executionContext;
    const obligations = executionContext
      ? deriveVerificationObligations({
        workspaceRoot: executionContext.workspaceRoot,
        inputArtifacts: executionContext.inputArtifacts,
        requiredSourceArtifacts: executionContext.requiredSourceArtifacts,
        targetArtifacts: executionContext.targetArtifacts,
        acceptanceCriteria: step.acceptanceCriteria,
        verificationMode: executionContext.verificationMode,
        stepKind: executionContext.stepKind,
        completionContract: executionContext.completionContract,
      })
      : undefined;
    const contract = obligations?.completionContract;
    if (!contract) {
      continue;
    }
    if (
      contract.taskClass !== "scaffold_allowed" &&
      contract.taskClass !== "review_required"
    ) {
      return contract;
    }
    fallbackContract ??= contract;
  }
  return fallbackContract;
}

function buildPlannerWorkflowVerificationContract(params: {
  readonly workspaceRoot?: string;
  readonly subagentSteps: readonly PlannerSubAgentTaskStepIntent[];
  readonly deterministicSteps: readonly PlannerDeterministicToolStepIntent[];
  readonly verificationContract?: WorkflowVerificationContract;
  readonly completionContract?: ImplementationCompletionContract;
}): WorkflowVerificationContract | undefined {
  const workspaceRoot =
    typeof params.workspaceRoot === "string" &&
      params.workspaceRoot.trim().length > 0
      ? params.workspaceRoot.trim()
      : typeof params.verificationContract?.workspaceRoot === "string" &&
          params.verificationContract.workspaceRoot.trim().length > 0
        ? params.verificationContract.workspaceRoot.trim()
        : undefined;
  const acceptanceCriteria = [
    ...(params.verificationContract?.acceptanceCriteria ?? []),
    ...params.subagentSteps.flatMap((step) => step.acceptanceCriteria),
  ].filter((criterion) => criterion.trim().length > 0);
  const inputArtifacts = Array.from(
    new Set(
      params.subagentSteps.flatMap(
        (step) => step.executionContext?.inputArtifacts ?? [],
      ),
    ),
  );
  const requiredSourceArtifacts = Array.from(
    new Set(
      params.subagentSteps.flatMap(
        (step) => step.executionContext?.requiredSourceArtifacts ??
          step.executionContext?.inputArtifacts ??
          [],
      ),
    ),
  );
  const targetArtifacts = Array.from(
    new Set(
      params.subagentSteps.flatMap(
        (step) => step.executionContext?.targetArtifacts ?? [],
      ),
    ),
  );
  const verificationMode = selectPlannerVerificationMode({
    explicit: params.verificationContract?.verificationMode,
    subagentSteps: params.subagentSteps,
    deterministicSteps: params.deterministicSteps,
    completionContract: params.completionContract,
  });
  const stepKind = selectPlannerStepKind({
    explicit: params.verificationContract?.stepKind,
    subagentSteps: params.subagentSteps,
    completionContract: params.completionContract,
  });
  const requestCompletion =
    params.verificationContract?.requestCompletion ??
    (
      params.completionContract &&
        params.completionContract.taskClass !== "scaffold_allowed" &&
        params.completionContract.taskClass !== "review_required"
      ? buildPlannerRequestCompletionContract({
        subagentSteps: params.subagentSteps,
        deterministicSteps: params.deterministicSteps,
      })
      : undefined
    );
  if (
    !workspaceRoot &&
    acceptanceCriteria.length === 0 &&
    inputArtifacts.length === 0 &&
    requiredSourceArtifacts.length === 0 &&
    targetArtifacts.length === 0 &&
    !verificationMode &&
    !stepKind &&
    !params.completionContract &&
    !requestCompletion
  ) {
    return undefined;
  }
  return {
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(inputArtifacts.length > 0 ? { inputArtifacts } : {}),
    ...(requiredSourceArtifacts.length > 0 ? { requiredSourceArtifacts } : {}),
    ...(targetArtifacts.length > 0 ? { targetArtifacts } : {}),
    ...(acceptanceCriteria.length > 0
      ? { acceptanceCriteria: Array.from(new Set(acceptanceCriteria)) }
      : {}),
    ...(verificationMode ? { verificationMode } : {}),
    ...(stepKind ? { stepKind } : {}),
    ...(params.completionContract
      ? { completionContract: params.completionContract }
      : {}),
    ...(requestCompletion ? { requestCompletion } : {}),
  };
}

function buildPlannerRequestCompletionContract(params: {
  readonly subagentSteps: readonly PlannerSubAgentTaskStepIntent[];
  readonly deterministicSteps: readonly PlannerDeterministicToolStepIntent[];
}): WorkflowRequestCompletionContract | undefined {
  const milestones = [
    ...params.subagentSteps.map<WorkflowRequestMilestone>((step) => ({
      id: step.name,
      description: step.objective.trim() || `Complete ${step.name}`,
    })),
    ...params.deterministicSteps.map<WorkflowRequestMilestone>((step) => ({
      id: step.name,
      description: summarizeDeterministicPlannerStep(step),
    })),
  ].filter((milestone) => milestone.id.trim().length > 0);
  if (milestones.length <= 1) {
    return undefined;
  }
  return {
    requiredMilestones: milestones,
  };
}

function summarizeDeterministicPlannerStep(
  step: PlannerDeterministicToolStepIntent,
): string {
  if (step.tool === "system.bash" || step.tool === "desktop.bash") {
    const commandText = extractCommandText(step.args).trim();
    if (commandText.length > 0) {
      return commandText;
    }
  }
  return `${step.tool} (${step.name})`;
}

function classifyPlannerWorkflowAdmission(params: {
  readonly workspaceRoot?: string;
  readonly completionContract?: ImplementationCompletionContract;
}): PlannerWorkflowAdmission["taskClassification"] {
  const completionContract = params.completionContract;
  if (
    !completionContract ||
    completionContract.taskClass === "scaffold_allowed" ||
    completionContract.taskClass === "review_required"
  ) {
    return "docs_research_plan_only";
  }
  if (
    typeof params.workspaceRoot !== "string" ||
    params.workspaceRoot.trim().length === 0
  ) {
    return "invalid";
  }
  return "implementation_class";
}

function selectPlannerVerificationMode(params: {
  readonly explicit?: WorkflowVerificationContract["verificationMode"];
  readonly subagentSteps: readonly PlannerSubAgentTaskStepIntent[];
  readonly deterministicSteps: readonly PlannerDeterministicToolStepIntent[];
  readonly completionContract?: ImplementationCompletionContract;
}): WorkflowVerificationContract["verificationMode"] | undefined {
  if (params.explicit) {
    return params.explicit;
  }
  for (const step of params.subagentSteps) {
    if (step.executionContext?.verificationMode === "mutation_required") {
      return "mutation_required";
    }
  }
  if (
    hasDeterministicImplementationMutation(params.deterministicSteps) ||
    params.completionContract?.taskClass === "artifact_only" ||
    params.completionContract?.taskClass === "build_required" ||
    params.completionContract?.taskClass === "behavior_required"
  ) {
    return "mutation_required";
  }
  for (const step of params.subagentSteps) {
    if (step.executionContext?.verificationMode === "deterministic_followup") {
      return "deterministic_followup";
    }
  }
  for (const step of params.subagentSteps) {
    if (step.executionContext?.verificationMode === "grounded_read") {
      return "grounded_read";
    }
  }
  return undefined;
}

function selectPlannerStepKind(params: {
  readonly explicit?: WorkflowVerificationContract["stepKind"];
  readonly subagentSteps: readonly PlannerSubAgentTaskStepIntent[];
  readonly completionContract?: ImplementationCompletionContract;
}): WorkflowVerificationContract["stepKind"] | undefined {
  if (params.explicit) {
    return canonicalizeExecutionStepKind({
      stepKind: params.explicit,
      verificationMode:
        params.completionContract?.taskClass === "review_required"
          ? "grounded_read"
          : undefined,
    });
  }
  for (const step of params.subagentSteps) {
    const stepKind = canonicalizeExecutionStepKind({
      stepKind: step.executionContext?.stepKind,
      effectClass: step.executionContext?.effectClass,
      verificationMode: step.executionContext?.verificationMode,
      targetArtifacts: step.executionContext?.targetArtifacts,
    });
    if (stepKind === "delegated_write") {
      return "delegated_write";
    }
  }
  for (const step of params.subagentSteps) {
    const stepKind = canonicalizeExecutionStepKind({
      stepKind: step.executionContext?.stepKind,
      effectClass: step.executionContext?.effectClass,
      verificationMode: step.executionContext?.verificationMode,
      targetArtifacts: step.executionContext?.targetArtifacts,
    });
    if (stepKind === "delegated_validation") {
      return "delegated_validation";
    }
  }
  for (const step of params.subagentSteps) {
    const stepKind = canonicalizeExecutionStepKind({
      stepKind: step.executionContext?.stepKind,
      effectClass: step.executionContext?.effectClass,
      verificationMode: step.executionContext?.verificationMode,
      targetArtifacts: step.executionContext?.targetArtifacts,
    });
    if (stepKind === "delegated_review") {
      return "delegated_review";
    }
  }
  for (const step of params.subagentSteps) {
    const stepKind = canonicalizeExecutionStepKind({
      stepKind: step.executionContext?.stepKind,
      effectClass: step.executionContext?.effectClass,
      verificationMode: step.executionContext?.verificationMode,
      targetArtifacts: step.executionContext?.targetArtifacts,
    });
    if (stepKind === "delegated_scaffold") {
      return "delegated_scaffold";
    }
  }
  if (params.completionContract?.taskClass === "review_required") {
    return "delegated_review";
  }
  if (params.completionContract?.taskClass === "scaffold_allowed") {
    return "delegated_scaffold";
  }
  return undefined;
}

function buildDeterministicImplementationVerifierWorkItem(
  completionContract: ImplementationCompletionContract,
  subagentSteps: readonly PlannerSubAgentTaskStepIntent[],
  deterministicSteps: readonly PlannerDeterministicToolStepIntent[],
  verificationContract?: WorkflowVerificationContract,
): PlannerVerifierWorkItem {
  const acceptanceCriteria = buildImplementationAcceptanceCriteria(
    completionContract,
    verificationContract?.acceptanceCriteria,
  );
  const documentationOnly =
    completionContract.placeholderTaxonomy === "documentation";
  return {
    name: documentationOnly
      ? "documentation_completion"
      : "implementation_completion",
    verificationKind: "deterministic_implementation",
    objective:
      documentationOnly
        ? "Verify that the deterministic documentation or planning artifact rewrite is complete enough to count as finished."
        : "Verify that the deterministic implementation/fix/refactor work is complete enough to count as implemented.",
    inputContract:
      documentationOnly
        ? "Assess the deterministic tool outputs and resulting artifacts against the documentation completion contract."
        : "Assess the deterministic tool outputs and resulting artifacts against the implementation completion contract.",
    acceptanceCriteria,
    requiredToolCapabilities: [
      ...new Set([
        ...subagentSteps.flatMap((step) => step.requiredToolCapabilities),
        ...deterministicSteps.map((step) => step.tool),
      ]),
    ],
    resultStepNames: [
      ...new Set([
        ...subagentSteps.map((step) => step.name),
        ...deterministicSteps.map((step) => step.name),
      ]),
    ],
    verificationContract:
      verificationContract || acceptanceCriteria.length > 0
        ? {
          ...(verificationContract ?? {}),
          completionContract,
          acceptanceCriteria,
        }
        : {
          completionContract,
        },
  };
}

function buildImplementationAcceptanceCriteria(
  _completionContract: ImplementationCompletionContract,
  explicitCriteria?: readonly string[],
): readonly string[] {
  const explicit = explicitCriteria?.filter((criterion) => criterion.trim().length > 0) ?? [];
  if (explicit.length > 0) {
    return explicit;
  }
  return [];
}

function hasDeterministicImplementationMutation(
  deterministicSteps: readonly PlannerDeterministicToolStepIntent[],
): boolean {
  return deterministicSteps.some((step) => isImplementationMutationStep(step));
}

function hasDeterministicDocumentationMutation(
  deterministicSteps: readonly PlannerDeterministicToolStepIntent[],
): boolean {
  return deterministicSteps.some((step) => isDocumentationMutationStep(step));
}

function resolveDeterministicImplementationCompletionContract(
  deterministicSteps: readonly PlannerDeterministicToolStepIntent[],
): ImplementationCompletionContract | undefined {
  if (hasDeterministicBehaviorVerification(deterministicSteps)) {
    return {
      taskClass: "behavior_required",
      placeholdersAllowed: false,
      partialCompletionAllowed: false,
      placeholderTaxonomy: "implementation",
    };
  }
  if (hasDeterministicBuildVerification(deterministicSteps)) {
    return {
      taskClass: "build_required",
      placeholdersAllowed: false,
      partialCompletionAllowed: false,
      placeholderTaxonomy: "implementation",
    };
  }
  if (hasDeterministicImplementationMutation(deterministicSteps)) {
    return {
      taskClass: "artifact_only",
      placeholdersAllowed: false,
      partialCompletionAllowed: false,
      placeholderTaxonomy: "implementation",
    };
  }
  if (hasDeterministicDocumentationMutation(deterministicSteps)) {
    return {
      taskClass: "artifact_only",
      placeholdersAllowed: false,
      partialCompletionAllowed: false,
      placeholderTaxonomy: "documentation",
    };
  }
  return undefined;
}

function hasDeterministicBuildVerification(
  deterministicSteps: readonly PlannerDeterministicToolStepIntent[],
): boolean {
  return deterministicSteps.some((step) => {
    if (step.tool !== "system.bash" && step.tool !== "desktop.bash") {
      return false;
    }
    const commandText = extractCommandText(step.args);
    return /\b(?:build|compile|typecheck|lint|install)\b/i.test(commandText);
  });
}

function hasDeterministicBehaviorVerification(
  deterministicSteps: readonly PlannerDeterministicToolStepIntent[],
): boolean {
  return deterministicSteps.some((step) => {
    if (step.tool !== "system.bash" && step.tool !== "desktop.bash") {
      return false;
    }
    const commandText = extractCommandText(step.args);
    return /\b(?:test|tests|testing|vitest|jest|pytest|playwright|ctest|cargo test|go test|smoke|scenario|e2e|end-to-end)\b/i.test(
      commandText,
    );
  });
}

function isImplementationMutationStep(
  step: PlannerDeterministicToolStepIntent,
): boolean {
  if (DIRECT_MUTATION_TOOL_NAMES.has(step.tool.trim())) {
    const candidatePaths = extractDeterministicTargetPaths(step);
    if (candidatePaths.length === 0) {
      return true;
    }
    return candidatePaths.some((path) => !isDocumentationArtifactPath(path));
  }
  if (step.tool !== "system.bash" && step.tool !== "desktop.bash") {
    return false;
  }
  const commandText = extractCommandText(step.args);
  if (DETERMINISTIC_IMPLEMENTATION_COMMAND_RE.test(commandText)) {
    return true;
  }
  if (!SHELL_MUTATION_RE.test(commandText)) {
    return false;
  }
  const pathHints = extractDeterministicTargetPaths(step);
  if (pathHints.length === 0) {
    return /(?:^|[\\s'"])(?:src|lib|app|server|client|include|cmd|pkg)\//i.test(
      commandText,
    );
  }
  return pathHints.some((path) => SOURCE_LIKE_PATH_RE.test(path));
}

function isDocumentationMutationStep(
  step: PlannerDeterministicToolStepIntent,
): boolean {
  if (DIRECT_MUTATION_TOOL_NAMES.has(step.tool.trim())) {
    const candidatePaths = extractDeterministicTargetPaths(step);
    return (
      candidatePaths.length > 0 &&
      candidatePaths.every((path) => isDocumentationArtifactPath(path))
    );
  }
  if (step.tool !== "system.bash" && step.tool !== "desktop.bash") {
    return false;
  }
  const commandText = extractCommandText(step.args);
  if (!SHELL_MUTATION_RE.test(commandText)) {
    return false;
  }
  const pathHints = extractDeterministicTargetPaths(step);
  return (
    pathHints.length > 0 &&
    pathHints.every((path) => isDocumentationArtifactPath(path))
  );
}

function extractDeterministicTargetPaths(
  step: PlannerDeterministicToolStepIntent,
): readonly string[] {
  const args = step.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return [];
  }
  const candidateKeys = ["path", "paths", "destination", "target", "targets"];
  const values: string[] = [];
  for (const key of candidateKeys) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim().length > 0) {
      values.push(value.trim());
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string" && entry.trim().length > 0) {
          values.push(entry.trim());
        }
      }
    }
  }
  if (values.length > 0) {
    return values;
  }
  const commandText = extractCommandText(args);
  return [...commandText.matchAll(/(?:^|[\s"'`])((?:src|lib|app|server|client|cmd|pkg|include|internal|tests?|spec)[/\\][^\s"'`]+)/g)]
    .map((match) => match[1] ?? "")
    .filter((entry) => entry.length > 0);
}

function extractCommandText(args: Record<string, unknown>): string {
  const parts: string[] = [];
  const command = args.command;
  if (typeof command === "string") {
    parts.push(command);
  }
  const argv = args.args;
  if (Array.isArray(argv)) {
    for (const entry of argv) {
      if (typeof entry === "string") {
        parts.push(entry);
      }
    }
  }
  return parts.join(" ");
}

export function outputIntersectsArtifacts(
  outputLower: string,
  artifactLower: string,
): boolean {
  const tokens = extractVerifierTokens(outputLower).slice(0, 24);
  return tokens.some((token) =>
    token.length >= 5 && artifactLower.includes(token)
  );
}
