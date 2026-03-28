/**
 * Delegated execute_with_agent orchestration extracted from the session tool
 * handler factory to keep child-session/runtime flow isolated.
 *
 * @module
 */

import type { DelegationToolCompositionResolver } from "./delegation-runtime.js";
import type { ExecuteWithAgentInput } from "./delegation-tool.js";
import {
  parseExecuteWithAgentInput,
} from "./delegation-tool.js";
import { isSubAgentSessionId } from "./delegation-runtime.js";
import { assessDelegationScope } from "./delegation-scope.js";
import { assessDirectDelegationAdmission } from "./delegation-admission.js";
import {
  resolveDelegatedChildToolScope,
  specRequiresSuccessfulToolEvidence,
} from "../utils/delegation-validation.js";
import {
  normalizeDelegatedLiteralOutputContract,
  parseJsonObjectFromText,
  sanitizeDelegatedRecallInput,
} from "../utils/delegated-contract-normalization.js";
import { annotateExecuteWithAgentResult } from "../utils/delegated-scope-trust.js";
import {
  deriveDelegatedExecutionEnvelopeFromParent,
} from "../utils/delegation-execution-context.js";
import {
  preflightDelegatedLocalFileScope,
  toolScopeRequiresStructuredExecutionContext,
} from "./delegated-scope-preflight.js";

const DELEGATION_POLL_INTERVAL_MS = 75;
const DELEGATION_PROGRESS_INTERVAL_MS = 1000;
const CHILD_MEMORY_RECALL_RE =
  /\b(?:recall|reveal|return|output|disclose|share)\b.*\b(?:memorized|stored|previous|prior|earlier|from test|child session|secret|token|value)\b|\b(?:previous|prior|earlier|from test)\b.*\b(?:memorized|stored|secret|token|value)\b/i;
const CHILD_MEMORY_STORE_DIRECTIVE_RE =
  /\b(?:memorize|store|save)\b|\bremember\s+(?:exactly|these|this|the)\b/i;
const CHILD_MEMORY_STORE_SIGNAL_RE =
  /\b(?:for\s+(?:later\s+)?recall|future|child session only|same child session|exactly these facts|memorized value|memorized token)\b/i;
const CHILD_DEFERRED_DISCLOSURE_RE =
  /\b(?:do\s+not|don't|never|must\s+not)\s+(?:reveal|return|output|disclose|share|expose)\b/i;
const DELEGATION_SESSION_ID_FIELD_RE =
  /\b(?:child|subagent|continuation)\s*session\s*id\b|\b(?:child|subagent|continuation)sessionid\b/i;

type DelegationContext = NonNullable<
  ReturnType<NonNullable<DelegationToolCompositionResolver>>
>;
type DelegationSubAgentManager = NonNullable<DelegationContext["subAgentManager"]>;
type DelegationLifecycleEmitter = DelegationContext["lifecycleEmitter"];
type DelegationVerifier = DelegationContext["verifier"];

export interface ExecuteDelegationToolParams {
  readonly toolArgs: Record<string, unknown>;
  readonly name: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly subAgentManager: DelegationSubAgentManager | null;
  readonly lifecycleEmitter: DelegationLifecycleEmitter;
  readonly verifier: DelegationVerifier;
  readonly availableToolNames?: readonly string[];
  readonly defaultWorkingDirectory?: string;
  readonly parentAllowedReadRoots?: readonly string[];
  readonly parentAllowedWriteRoots?: readonly string[];
  readonly delegationThreshold?: number;
  readonly unsafeBenchmarkMode?: boolean;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toErrorString(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseDelegationFailureReason(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return "Sub-agent execution failed";
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? trimmed;
  return firstLine.slice(0, 240);
}

function resolveChildTerminalStatus(params: {
  readonly completionState?: "completed" | "partial" | "blocked" | "needs_verification";
  readonly stopReason?: string;
  readonly reportedStatus?: string;
}): string {
  if (params.stopReason === "cancelled") {
    return "cancelled";
  }
  if (params.stopReason === "timeout") {
    return "timed_out";
  }
  if (params.completionState === "completed") {
    return "completed";
  }
  if (
    params.reportedStatus === "cancelled" ||
    params.reportedStatus === "timed_out"
  ) {
    return params.reportedStatus;
  }
  return "failed";
}

function buildNonCompletedChildReason(params: {
  readonly completionState?: "completed" | "partial" | "blocked" | "needs_verification";
  readonly completionProgress?: {
    readonly remainingRequirements?: readonly string[];
  };
  readonly stopReasonDetail?: string;
}): string | undefined {
  if (!params.completionState || params.completionState === "completed") {
    return undefined;
  }
  const remainingRequirements =
    params.completionProgress?.remainingRequirements?.filter((entry) =>
      typeof entry === "string" && entry.trim().length > 0
    ) ?? [];
  const remainingSuffix = remainingRequirements.length > 0
    ? ` Remaining requirements: ${remainingRequirements.join(", ")}.`
    : "";
  const detailSuffix =
    typeof params.stopReasonDetail === "string" &&
      params.stopReasonDetail.trim().length > 0
      ? ` ${params.stopReasonDetail.trim()}`
      : "";
  return (
    `Sub-agent did not reach a completed workflow state (${params.completionState}).` +
    remainingSuffix +
    detailSuffix
  ).trim();
}

function countFailedChildToolCalls(
  toolCalls: readonly {
    readonly isError?: boolean;
    readonly result?: string;
  }[] = [],
): number {
  // Only count tool calls that the runtime explicitly marked as errors.
  // Do NOT regex-scan tool result strings or model prose — that produces
  // false positives when the output discusses code containing words like
  // "timeout", "permission denied", etc.
  return toolCalls.reduce((count, toolCall) => {
    if (toolCall.isError) return count + 1;
    return count;
  }, 0);
}

function hasDelegationFailureSignal(_output: string): boolean {
  // Disabled — regex-scanning model prose for failure signals produces
  // too many false positives (e.g. ncurses timeout(), error handling code).
  // The structured isError flag on tool calls is the reliable signal.
  return false;
}

function isDeferredDisclosureStoreTurn(input: ExecuteWithAgentInput): boolean {
  const combined = [
    input.task,
    input.objective,
    input.inputContract,
    input.acceptanceCriteria?.join("\n"),
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");

  if (!isChildMemoryStoreTurn(input)) return false;
  return CHILD_DEFERRED_DISCLOSURE_RE.test(combined);
}

function buildDelegatedChildPrompt(
  input: ExecuteWithAgentInput,
  options: {
    continuationAuthorized?: boolean;
    workingDirectory?: string;
  } = {},
): string {
  const parts = [
    `Task: ${input.task}`,
    ...(input.objective ? [`Objective: ${input.objective}`] : []),
    ...(input.inputContract ? [`Input contract: ${input.inputContract}`] : []),
    ...(input.acceptanceCriteria?.length
      ? [
        "Acceptance criteria:\n" +
        input.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n"),
      ]
      : []),
  ];
  const basePrompt = parts.join("\n\n");
  const guidance: string[] = [];

  if (isDeferredDisclosureStoreTurn(input)) {
    guidance.push(
      "Continuation memory contract:\n" +
        "- Memorize the private value in this child session and keep it scoped here.\n" +
        "- Do not reveal it in this turn.\n" +
        "- If a later continuation request from the same parent session explicitly asks for the memorized value, that later request is authorized and should be fulfilled.",
    );
  }

  if (options.continuationAuthorized && shouldReusePriorChildSession(input)) {
    guidance.push(
      "Continuation disclosure authorization:\n" +
        "- This is a later continuation request from the same parent session.\n" +
        "- If this child session memorized a value for later recall, reveal or return it now.\n" +
        "- Follow this turn's exact output instructions.",
    );
  }

  if (options.workingDirectory) {
    guidance.push(
      "Runtime-approved workspace scope:\n" +
        `- The runtime has already pinned this child phase to \`${options.workingDirectory}\`.\n` +
        "- Filesystem tools are validated against that approved scope at execution time.\n" +
        "- Treat any free-form cwd or workspace-root text elsewhere as informational only; do not invent alternate roots.",
    );
  }

  if (input.executionContext) {
    const contractLines = [
      ...(input.executionContext.workspaceRoot
        ? [`- Canonical workspace root: \`${input.executionContext.workspaceRoot}\``]
        : []),
      ...((input.executionContext.allowedReadRoots ?? []).length > 0
        ? [
          `- Allowed read roots: ${(input.executionContext.allowedReadRoots ?? []).map((root) => `\`${root}\``).join(", ")}`,
        ]
        : []),
      ...((input.executionContext.allowedWriteRoots ?? []).length > 0
        ? [
          `- Allowed write roots: ${(input.executionContext.allowedWriteRoots ?? []).map((root) => `\`${root}\``).join(", ")}`,
        ]
        : []),
      ...(((input.executionContext.requiredSourceArtifacts ??
        input.executionContext.inputArtifacts) ?? []).length > 0
        ? [
          `- Required source artifacts: ${((input.executionContext.requiredSourceArtifacts ??
            input.executionContext.inputArtifacts) ?? []).map((artifact) => `\`${artifact}\``).join(", ")}`,
        ]
        : []),
      ...((input.executionContext.targetArtifacts ?? []).length > 0
        ? [
          `- Target artifacts for this phase: ${(input.executionContext.targetArtifacts ?? []).map((artifact) => `\`${artifact}\``).join(", ")}`,
        ]
        : []),
    ];
    if (contractLines.length > 0) {
      guidance.push(`Structured execution context:\n${contractLines.join("\n")}`);
    }
  }

  if (input.delegationAdmission) {
    const admissionLines = [
      ...(input.delegationAdmission.shape
        ? [`- Delegation shape: ${input.delegationAdmission.shape}`]
        : []),
      ...(input.delegationAdmission.isolationReason
        ? [`- Isolation reason: ${input.delegationAdmission.isolationReason}`]
        : []),
      ...((input.delegationAdmission.ownedArtifacts ?? []).length > 0
        ? [
          `- Owned artifacts: ${(input.delegationAdmission.ownedArtifacts ?? []).map((artifact) => `\`${artifact}\``).join(", ")}`,
        ]
        : []),
      ...((input.delegationAdmission.verifierObligations ?? []).length > 0
        ? [
          `- Verifier obligations: ${(input.delegationAdmission.verifierObligations ?? []).join(" | ")}`,
        ]
        : []),
    ];
    if (admissionLines.length > 0) {
      guidance.push(`Delegation admission:\n${admissionLines.join("\n")}`);
    }
  }

  guidance.push(
    "Execution contract:\n" +
      "- The phase-level allowlist may be broader than the tools attached on a specific recall.\n" +
      "- The tool JSON for the current recall is authoritative; use only tools that are actually attached right now.\n" +
      "- If the input contract or context requirements name source files or current workspace artifacts, inspect those sources before writing derived files.\n" +
      "- If a source artifact describes intended or planned structure, do not present that structure as already present unless you directly confirmed it.\n" +
      "- If this phase is complete but sibling or next-phase work remains, describe that work as out of scope instead of calling this phase blocked.",
  );

  if (guidance.length === 0) {
    return basePrompt;
  }

  return `${basePrompt}\n\n${guidance.join("\n\n")}`;
}

function shouldReusePriorChildSession(input: ExecuteWithAgentInput): boolean {
  const combined = [
    input.task,
    input.objective,
    input.inputContract,
    input.acceptanceCriteria?.join("\n"),
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");

  if (isChildMemoryStoreTurn(input)) return false;
  return Boolean(input.continuationSessionId) || CHILD_MEMORY_RECALL_RE.test(combined);
}

function isChildMemoryStoreTurn(input: ExecuteWithAgentInput): boolean {
  const combined = [
    input.task,
    input.objective,
    input.inputContract,
    input.acceptanceCriteria?.join("\n"),
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");

  return CHILD_MEMORY_STORE_DIRECTIVE_RE.test(combined) &&
    (CHILD_MEMORY_STORE_SIGNAL_RE.test(combined) ||
      CHILD_DEFERRED_DISCLOSURE_RE.test(combined));
}

function normalizeDelegatedSessionHandleOutput(params: {
  readonly childSessionId: string;
  readonly input: ExecuteWithAgentInput;
  readonly output: string;
}): string {
  const { childSessionId, input, output } = params;
  const trimmed = output.trim();
  if (trimmed.length === 0) return output;

  const parsed = parseJsonObjectFromText(trimmed);
  if (!parsed) return output;

  const combined = [
    input.task,
    input.objective,
    input.inputContract,
    input.acceptanceCriteria?.join("\n"),
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");

  const shouldExposeChildSessionId =
    Object.hasOwn(parsed, "childSessionId") ||
    DELEGATION_SESSION_ID_FIELD_RE.test(combined);
  const shouldExposeSubagentSessionId =
    Object.hasOwn(parsed, "subagentSessionId");

  if (!shouldExposeChildSessionId && !shouldExposeSubagentSessionId) {
    return output;
  }

  const normalized = { ...parsed };
  if (shouldExposeChildSessionId) {
    normalized.childSessionId = childSessionId;
  }
  if (shouldExposeSubagentSessionId) {
    normalized.subagentSessionId = childSessionId;
  }
  return JSON.stringify(normalized);
}

function resolveRecallContinuationSessionId(
  input: ExecuteWithAgentInput,
  parentSessionId: string,
  subAgentManager: DelegationSubAgentManager,
): string | undefined {
  const explicit = input.continuationSessionId?.trim();
  if (explicit && isSubAgentSessionId(explicit)) {
    const info = subAgentManager.getInfo(explicit);
    const result = subAgentManager.getResult(explicit);
    if (
      info?.parentSessionId === parentSessionId &&
      info.status === "completed" &&
      result?.success === true
    ) {
      return explicit;
    }
  }

  return subAgentManager.findLatestSuccessfulSessionId?.(parentSessionId);
}

export async function executeDelegationTool(
  params: ExecuteDelegationToolParams,
): Promise<string> {
  const {
    toolArgs,
    name,
    sessionId,
    toolCallId,
    subAgentManager,
    lifecycleEmitter,
    verifier,
    availableToolNames,
    unsafeBenchmarkMode = false,
  } = params;
  const finalizeDelegationResult = (payload: Record<string, unknown>): string =>
    annotateExecuteWithAgentResult({
      args: toolArgs,
      payload,
    });
  if (!subAgentManager) {
    return finalizeDelegationResult({
      error:
        "Delegation runtime unavailable: sub-agent manager is not initialized",
    });
  }

  const parsedInput = parseExecuteWithAgentInput(toolArgs);
  if (!parsedInput.ok) {
    lifecycleEmitter?.emit({
      type: "subagents.failed",
      timestamp: Date.now(),
      sessionId,
      parentSessionId: sessionId,
      toolName: name,
      payload: {
        stage: "validation",
        reason: parsedInput.error,
        toolCallId,
      },
    });
    return finalizeDelegationResult({ error: parsedInput.error });
  }

  const input = normalizeDelegatedLiteralOutputContract(
    shouldReusePriorChildSession(parsedInput.value)
      ? sanitizeDelegatedRecallInput(parsedInput.value)
      : parsedInput.value,
  );
  const scopeAssessment = assessDelegationScope(input);
  if (!unsafeBenchmarkMode && !scopeAssessment.ok) {
    lifecycleEmitter?.emit({
      type: "subagents.failed",
      timestamp: Date.now(),
      sessionId,
      parentSessionId: sessionId,
      toolName: name,
      payload: {
        stage: "validation",
        objective: input.objective ?? input.task,
        reason: scopeAssessment.error,
        phases: scopeAssessment.phases,
        decomposition: scopeAssessment.decomposition,
        toolCallId,
      },
    });
    return finalizeDelegationResult({
      success: false,
      status: "needs_decomposition",
      objective: input.objective ?? input.task,
      error: scopeAssessment.error,
      decomposition: scopeAssessment.decomposition,
    });
  }
  const objective = input.objective ?? input.task;
  const resolvedChildScope = resolveDelegatedChildToolScope({
    spec: input,
    requestedTools: input.tools,
    parentAllowedTools: availableToolNames,
    availableTools: availableToolNames,
    enforceParentIntersection: true,
    strictExplicitToolAllowlist: Array.isArray(input.tools) && input.tools.length > 0,
    unsafeBenchmarkMode,
  });
  const derivedExecutionEnvelope = deriveDelegatedExecutionEnvelopeFromParent({
    parentWorkspaceRoot: params.defaultWorkingDirectory,
    parentAllowedReadRoots: params.parentAllowedReadRoots,
    parentAllowedWriteRoots: params.parentAllowedWriteRoots,
    requestedExecutionContext: input.executionContext,
    requiresStructuredExecutionContext: toolScopeRequiresStructuredExecutionContext(
      resolvedChildScope.allowedTools,
    ),
    source: "direct_live_path",
  });
  if (!derivedExecutionEnvelope.ok) {
    lifecycleEmitter?.emit({
      type: "subagents.failed",
      timestamp: Date.now(),
      sessionId,
      parentSessionId: sessionId,
      toolName: name,
      payload: {
        stage: "validation",
        objective,
        reason: derivedExecutionEnvelope.error,
        issues: derivedExecutionEnvelope.issues,
        toolCallId,
      },
    });
    return finalizeDelegationResult({
      success: false,
      status: "failed",
      objective,
      error: derivedExecutionEnvelope.error,
      issues: derivedExecutionEnvelope.issues,
    });
  }
  const effectiveExecutionContext = derivedExecutionEnvelope.executionContext;
  const workingDirectory = derivedExecutionEnvelope.workingDirectory;
  const { executionContext: _requestedExecutionContext, ...inputWithoutExecutionContext } =
    input;
  const effectiveInput: ExecuteWithAgentInput = effectiveExecutionContext
    ? {
        ...inputWithoutExecutionContext,
        executionContext: effectiveExecutionContext,
      }
    : inputWithoutExecutionContext;
  const delegatedScopePreflight = preflightDelegatedLocalFileScope({
    executionContext: effectiveExecutionContext,
    workingDirectory,
    allowedTools: resolvedChildScope.allowedTools,
  });
  if (!delegatedScopePreflight.ok) {
    lifecycleEmitter?.emit({
      type: "subagents.failed",
      timestamp: Date.now(),
      sessionId,
      parentSessionId: sessionId,
      toolName: name,
      payload: {
        stage: "validation",
        objective,
        reason: delegatedScopePreflight.error,
        issues: delegatedScopePreflight.issues,
        toolCallId,
      },
    });
    return finalizeDelegationResult({
      success: false,
      status: "failed",
      objective,
      error: delegatedScopePreflight.error,
      issues: delegatedScopePreflight.issues,
    });
  }
  const admission = assessDirectDelegationAdmission({
    input: effectiveInput,
    threshold: params.delegationThreshold ?? 0.2,
  });
  if (!unsafeBenchmarkMode && !admission.allowed) {
    lifecycleEmitter?.emit({
      type: "subagents.failed",
      timestamp: Date.now(),
      sessionId,
      parentSessionId: sessionId,
      toolName: name,
      payload: {
        stage: "admission",
        objective,
        reason: admission.reason,
        shape: admission.shape,
        diagnostics: admission.diagnostics,
        toolCallId,
      },
    });
    return finalizeDelegationResult({
      success: false,
      status: "failed",
      objective,
      error: `Delegation admission rejected: ${admission.reason}`,
      shape: admission.shape,
      diagnostics: admission.diagnostics,
    });
  }
  const admittedInput: ExecuteWithAgentInput =
    admission.allowed && !effectiveInput.delegationAdmission
      ? {
        ...effectiveInput,
        delegationAdmission: admission.stepAdmissions[0]
          ? {
            ...(admission.stepAdmissions[0].shape
              ? { shape: admission.stepAdmissions[0].shape }
              : {}),
            isolationReason: admission.stepAdmissions[0].isolationReason,
            ownedArtifacts: admission.stepAdmissions[0].ownedArtifacts,
            verifierObligations:
              admission.stepAdmissions[0].verifierObligations,
          }
          : undefined,
      }
      : effectiveInput;
  if (resolvedChildScope.blockedReason) {
    lifecycleEmitter?.emit({
      type: "subagents.failed",
      timestamp: Date.now(),
      sessionId,
      parentSessionId: sessionId,
      toolName: name,
      payload: {
        stage: "validation",
        objective,
        reason: resolvedChildScope.blockedReason,
        removedLowSignalBrowserTools:
          resolvedChildScope.removedLowSignalBrowserTools,
        removedByPolicy: resolvedChildScope.removedByPolicy,
        removedAsDelegationTools: resolvedChildScope.removedAsDelegationTools,
        removedAsUnknownTools: resolvedChildScope.removedAsUnknownTools,
        semanticFallback: resolvedChildScope.semanticFallback,
        toolCallId,
      },
    });
    return finalizeDelegationResult({
      success: false,
      status: "failed",
      objective,
      error: resolvedChildScope.blockedReason,
      removedLowSignalBrowserTools:
        resolvedChildScope.removedLowSignalBrowserTools,
      removedByPolicy: resolvedChildScope.removedByPolicy,
      removedAsDelegationTools: resolvedChildScope.removedAsDelegationTools,
      removedAsUnknownTools: resolvedChildScope.removedAsUnknownTools,
      semanticFallback: resolvedChildScope.semanticFallback,
    });
  }
  let childSessionId: string;
  try {
    const continuationSessionId = shouldReusePriorChildSession(input)
      ? resolveRecallContinuationSessionId(input, sessionId, subAgentManager)
      : input.continuationSessionId;
    const childPrompt = buildDelegatedChildPrompt(admittedInput, {
      continuationAuthorized: Boolean(continuationSessionId),
      workingDirectory,
    });
    childSessionId = await subAgentManager.spawn({
      parentSessionId: sessionId,
      task: objective,
      prompt: childPrompt,
      ...(continuationSessionId
        ? { continuationSessionId }
        : {}),
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(effectiveExecutionContext?.workspaceRoot
        ? { workingDirectorySource: "execution_envelope" as const }
        : {}),
      tools: resolvedChildScope.allowedTools,
      ...(input.requiredToolCapabilities
        ? { requiredCapabilities: input.requiredToolCapabilities }
        : {}),
      requireToolCall: specRequiresSuccessfulToolEvidence(effectiveInput),
        delegationSpec: admittedInput,
        unsafeBenchmarkMode,
      });
  } catch (error) {
    const message = toErrorString(error);
    lifecycleEmitter?.emit({
      type: "subagents.failed",
      timestamp: Date.now(),
      sessionId,
      parentSessionId: sessionId,
      toolName: name,
      payload: {
        stage: "spawn",
        objective,
        reason: message,
        toolCallId,
      },
    });
    return finalizeDelegationResult({
      error: `Failed to spawn sub-agent: ${message}`,
    });
  }

  const startedAt = Date.now();
  lifecycleEmitter?.emit({
    type: "subagents.spawned",
    timestamp: startedAt,
    sessionId,
    parentSessionId: sessionId,
    subagentSessionId: childSessionId,
    toolName: name,
    payload: {
      objective,
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(effectiveExecutionContext?.workspaceRoot
        ? { workingDirectorySource: "execution_envelope" as const }
        : {}),
      tools: resolvedChildScope.allowedTools,
      ...(input.requiredToolCapabilities
        ? { requiredToolCapabilities: input.requiredToolCapabilities }
        : {}),
      ...(resolvedChildScope.removedLowSignalBrowserTools.length
        ? {
          removedLowSignalBrowserTools:
            resolvedChildScope.removedLowSignalBrowserTools,
        }
        : {}),
      ...(resolvedChildScope.removedByPolicy.length
        ? { removedByPolicy: resolvedChildScope.removedByPolicy }
        : {}),
      ...(resolvedChildScope.removedAsDelegationTools.length
        ? {
          removedAsDelegationTools:
            resolvedChildScope.removedAsDelegationTools,
        }
        : {}),
      ...(resolvedChildScope.removedAsUnknownTools.length
        ? { removedAsUnknownTools: resolvedChildScope.removedAsUnknownTools }
        : {}),
      ...(resolvedChildScope.semanticFallback.length
        ? { semanticFallback: resolvedChildScope.semanticFallback }
        : {}),
      ...(unsafeBenchmarkMode ? { unsafeBenchmarkMode: true } : {}),
      toolCallId,
    },
  });
  lifecycleEmitter?.emit({
    type: "subagents.started",
    timestamp: Date.now(),
    sessionId,
    parentSessionId: sessionId,
    subagentSessionId: childSessionId,
    toolName: name,
    payload: {
      objective,
      toolCallId,
    },
  });

  let lastProgressAt = startedAt;
  while (true) {
    const childResult = subAgentManager.getResult(childSessionId);
    if (!childResult) {
      const now = Date.now();
      if (now - lastProgressAt >= DELEGATION_PROGRESS_INTERVAL_MS) {
        lifecycleEmitter?.emit({
          type: "subagents.progress",
          timestamp: now,
          sessionId,
          parentSessionId: sessionId,
          subagentSessionId: childSessionId,
          toolName: name,
          payload: {
            objective,
            elapsedMs: now - startedAt,
            toolCallId,
          },
        });
        lastProgressAt = now;
      }
      await sleepMs(DELEGATION_POLL_INTERVAL_MS);
      continue;
    }

    const childInfo = subAgentManager.getInfo(childSessionId);
    const childCompleted = childResult.completionState === "completed";
    const finalStatus = resolveChildTerminalStatus({
      completionState: childResult.completionState,
      stopReason: childResult.stopReason,
      reportedStatus: childInfo?.status,
    });

    const failedChildToolCalls = countFailedChildToolCalls(childResult.toolCalls);
    const childCompletionStateFailure = buildNonCompletedChildReason({
      completionState: childResult.completionState,
      completionProgress: childResult.completionProgress,
      stopReasonDetail: childResult.stopReasonDetail,
    });
    const unresolvedChildFailure =
      failedChildToolCalls > 0 &&
      hasDelegationFailureSignal(childResult.output);
    const normalizedChildOutput = normalizeDelegatedSessionHandleOutput({
      childSessionId,
      input,
      output: childResult.output,
    });

    if (childCompleted && !unresolvedChildFailure) {
      lifecycleEmitter?.emit({
        type: "subagents.completed",
        timestamp: Date.now(),
        sessionId,
        parentSessionId: sessionId,
        subagentSessionId: childSessionId,
        toolName: name,
        payload: {
          objective,
          durationMs: childResult.durationMs,
          toolCalls: childResult.toolCalls.length,
          providerName: childResult.providerName,
          output: normalizedChildOutput,
          toolCallId,
          verifyRequested: verifier?.shouldVerifySubAgentResult() ?? false,
        },
      });
      return finalizeDelegationResult({
        success: true,
        status: finalStatus,
        subagentSessionId: childSessionId,
        objective,
        output: normalizedChildOutput,
        durationMs: childResult.durationMs,
        toolCalls: childResult.toolCalls.length,
        failedToolCalls: failedChildToolCalls,
        providerEvidence: childResult.providerEvidence,
        providerName: childResult.providerName,
        tokenUsage: childResult.tokenUsage,
        completionState: childResult.completionState,
        completionProgress: childResult.completionProgress,
        stopReason: childResult.stopReason,
        stopReasonDetail: childResult.stopReasonDetail,
        validationCode: childResult.validationCode,
      });
    }

    const reason = childCompletionStateFailure ??
      (unresolvedChildFailure
        ? `Sub-agent completed with unresolved tool failures (${failedChildToolCalls})`
        : parseDelegationFailureReason(childResult.output));
    const terminalType =
      finalStatus === "cancelled" ? "subagents.cancelled" : "subagents.failed";
    lifecycleEmitter?.emit({
      type: terminalType,
      timestamp: Date.now(),
      sessionId,
      parentSessionId: sessionId,
      subagentSessionId: childSessionId,
      toolName: name,
      payload: {
        objective,
        reason,
        output: childResult.output,
        durationMs: childResult.durationMs,
        toolCalls: childResult.toolCalls.length,
        failedToolCalls: failedChildToolCalls,
        toolCallId,
      },
    });
      return finalizeDelegationResult({
      success: false,
      status: finalStatus,
      subagentSessionId: childSessionId,
      objective,
      error: reason,
      output: childResult.output,
      durationMs: childResult.durationMs,
      toolCalls: childResult.toolCalls.length,
      failedToolCalls: failedChildToolCalls,
      providerName: childResult.providerName,
      tokenUsage: childResult.tokenUsage,
      completionState: childResult.completionState,
      completionProgress: childResult.completionProgress,
      stopReason: childResult.stopReason,
      stopReasonDetail: childResult.stopReasonDetail,
      validationCode: childResult.validationCode,
    });
  }
}
