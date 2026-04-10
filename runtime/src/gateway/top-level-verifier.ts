import type { ChatExecutorResult } from "../llm/chat-executor.js";
import {
  deriveActiveTaskContext,
  mergeTurnExecutionRequiredToolEvidence,
  resolveWorkflowEvidenceFromRequiredToolEvidence,
} from "../llm/turn-execution-contract.js";
import {
  deriveWorkflowProgressSnapshot,
  mergeWorkflowProgressSnapshots,
} from "../workflow/completion-progress.js";
import {
  resolveWorkflowCompletionState,
  type PlannerVerificationSnapshot,
} from "../workflow/completion-state.js";
import { createExecutionEnvelope } from "../workflow/execution-envelope.js";
import { normalizeArtifactPaths, normalizeWorkspaceRoot } from "../workflow/path-normalization.js";
import type { Logger } from "../utils/logger.js";
import type { AgentDefinition } from "./agent-loader.js";
import type { DelegationVerifierService } from "./delegation-runtime.js";
import { isSubAgentSessionId } from "./delegation-runtime.js";
import type { SubAgentConfig, SubAgentManager, SubAgentResult } from "./sub-agent.js";
import type { LLMStructuredOutputRequest } from "../llm/types.js";

const DEFAULT_VERIFY_TOOLS = [
  "system.readFile",
  "system.listDir",
  "system.stat",
  "system.bash",
] as const;

const DEFAULT_VERIFY_SYSTEM_PROMPT =
  "You are a verification agent. Your job is to try to break the claimed implementation with real checks. " +
  "Stay read-only, inspect the declared artifacts directly, run repo-local verification commands when possible, " +
  "and finish with exactly one line: VERDICT: PASS, VERDICT: FAIL, or VERDICT: PARTIAL.";
const VERIFY_STRUCTURED_OUTPUT: LLMStructuredOutputRequest = {
  enabled: true,
  schema: {
    type: "json_schema",
    name: "agenc_top_level_verifier_decision",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["verdict", "summary"],
      properties: {
        verdict: {
          type: "string",
          enum: ["pass", "fail", "retry"],
        },
        summary: {
          type: "string",
          minLength: 1,
        },
        checks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "result"],
            properties: {
              name: { type: "string", minLength: 1 },
              result: {
                type: "string",
                enum: ["pass", "fail", "retry"],
              },
              detail: { type: "string" },
            },
          },
        },
      },
    },
  },
};

interface MaybeRunTopLevelVerifierParams {
  readonly sessionId: string;
  readonly userRequest: string;
  readonly result: ChatExecutorResult;
  readonly subAgentManager: Pick<SubAgentManager, "spawn" | "waitForResult"> | null;
  readonly verifierService: Pick<DelegationVerifierService, "shouldVerifySubAgentResult"> | null;
  readonly agentDefinitions?: readonly AgentDefinition[];
  readonly logger?: Logger;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function selectVerifyDefinition(
  definitions: readonly AgentDefinition[] | undefined,
): {
  readonly tools: readonly string[];
  readonly systemPrompt: string;
} {
  const match = definitions?.find((definition) => definition.name === "verify");
  return {
    tools: match?.tools?.length ? match.tools : DEFAULT_VERIFY_TOOLS,
    systemPrompt:
      match?.body.trim().length
        ? match.body.trim()
        : DEFAULT_VERIFY_SYSTEM_PROMPT,
  };
}

function buildVerifierPrompt(params: {
  readonly userRequest: string;
  readonly workspaceRoot?: string;
  readonly sourceArtifacts: readonly string[];
  readonly targetArtifacts: readonly string[];
  readonly assistantContent: string;
}): string {
  const lines = [
    "Verify the implementation result for this parent request.",
    "",
    `Parent request: ${params.userRequest.trim() || "(missing request text)"}`,
  ];
  if (params.workspaceRoot) {
    lines.push(`Workspace root: ${params.workspaceRoot}`);
  }
  if (params.targetArtifacts.length > 0) {
    lines.push("");
    lines.push("Target artifacts:");
    for (const artifact of params.targetArtifacts) {
      lines.push(`- ${artifact}`);
    }
  }
  if (params.sourceArtifacts.length > 0) {
    lines.push("");
    lines.push("Source artifacts:");
    for (const artifact of params.sourceArtifacts) {
      lines.push(`- ${artifact}`);
    }
  }
  if (params.assistantContent.trim().length > 0) {
    lines.push("");
    lines.push("Parent completion summary:");
    lines.push(truncate(params.assistantContent.trim(), 1200));
  }
  lines.push("");
  lines.push(
    "Run concrete checks, inspect the target artifacts directly, and report whether the implementation actually holds up.",
  );
  return lines.join("\n");
}

function parseStructuredVerifierSnapshot(result: SubAgentResult | null): {
  readonly snapshot: PlannerVerificationSnapshot;
  readonly summary: string;
} | null {
  const parsed = result?.structuredOutput?.parsed;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const object = parsed as Record<string, unknown>;
  const verdict = typeof object.verdict === "string"
    ? object.verdict.trim().toLowerCase()
    : "";
  const summary =
    typeof object.summary === "string" && object.summary.trim().length > 0
      ? truncate(object.summary.trim(), 2000)
      : undefined;
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "retry") {
    return null;
  }
  return {
    snapshot:
      verdict === "pass"
        ? { performed: true, overall: "pass" }
        : verdict === "fail"
          ? { performed: true, overall: "fail" }
          : { performed: true, overall: "retry" },
    summary:
      summary ??
      "Top-level verifier returned a structured verdict without a usable summary.",
  };
}

function parseVerifierSnapshot(result: SubAgentResult | null): {
  readonly snapshot: PlannerVerificationSnapshot;
  readonly summary: string;
} {
  const structured = parseStructuredVerifierSnapshot(result);
  if (structured) {
    return structured;
  }
  if (!result) {
    return {
      snapshot: { performed: false, overall: "retry" },
      summary: "Top-level verifier did not return a result.",
    };
  }

  const content = result.output.trim();
  const verdictMatch = content.match(/^VERDICT:\s*(PASS|FAIL|PARTIAL)\s*$/im);
  const verdict = verdictMatch?.[1]?.toUpperCase();
  const snapshot: PlannerVerificationSnapshot =
    verdict === "PASS"
      ? { performed: true, overall: "pass" }
      : verdict === "FAIL"
        ? { performed: true, overall: "fail" }
        : verdict === "PARTIAL"
          ? { performed: true, overall: "retry" }
          : result.completionState === "completed"
            ? { performed: true, overall: "retry" }
            : { performed: false, overall: "retry" };

  const summary =
    content.length > 0
      ? truncate(content, 2000)
      : result.stopReasonDetail?.trim().length
        ? truncate(result.stopReasonDetail.trim(), 2000)
        : "Top-level verifier returned no usable output.";

  return { snapshot, summary };
}

function buildVerifierAdjustedResult(params: {
  readonly result: ChatExecutorResult;
  readonly verifier: PlannerVerificationSnapshot;
  readonly verifierSummary: string;
}): ChatExecutorResult {
  const requiredToolEvidence = mergeTurnExecutionRequiredToolEvidence({
    turnExecutionContract: params.result.turnExecutionContract,
  });
  const workflowEvidence = resolveWorkflowEvidenceFromRequiredToolEvidence({
    requiredToolEvidence,
    runtimeContext: {
      workspaceRoot: params.result.turnExecutionContract.workspaceRoot,
      activeTaskContext: deriveActiveTaskContext(params.result.turnExecutionContract),
    },
  });
  const completionState = resolveWorkflowCompletionState({
    stopReason: params.result.stopReason,
    toolCalls: params.result.toolCalls,
    verificationContract: workflowEvidence.verificationContract,
    completionContract: workflowEvidence.completionContract,
    validationCode: params.result.validationCode,
    verifier: params.verifier,
  });
  const nextProgress = deriveWorkflowProgressSnapshot({
    stopReason: params.result.stopReason,
    completionState,
    stopReasonDetail:
      params.verifier.overall === "pass"
        ? params.result.stopReasonDetail
        : `Top-level verifier ${params.verifier.overall}: ${params.verifierSummary}`,
    validationCode: params.result.validationCode,
    toolCalls: params.result.toolCalls,
    verificationContract: workflowEvidence.verificationContract,
    completionContract: workflowEvidence.completionContract,
    updatedAt: Date.now(),
    contractFingerprint: params.result.turnExecutionContract.contractFingerprint,
    verifier: params.verifier,
  });
  const completionProgress = mergeWorkflowProgressSnapshots({
    previous: params.result.completionProgress,
    next: nextProgress,
  });

  if (params.verifier.overall === "pass") {
    return {
      ...params.result,
      completionState,
      ...(completionProgress ? { completionProgress } : {}),
    };
  }

  const content = params.result.content.trim().length > 0
    ? `${params.result.content.trim()}\n\nVerification did not pass.\n${params.verifierSummary}`
    : `Verification did not pass.\n${params.verifierSummary}`;

  return {
    ...params.result,
    content,
    completionState,
    ...(completionProgress ? { completionProgress } : {}),
    stopReasonDetail: `Top-level verifier ${params.verifier.overall}: ${params.verifierSummary}`,
  };
}

function shouldRunTopLevelVerifier(params: MaybeRunTopLevelVerifierParams): boolean {
  if (!params.subAgentManager || !params.verifierService) return false;
  if (isSubAgentSessionId(params.sessionId)) return false;
  if (params.result.stopReason !== "completed") return false;
  if (params.result.completionState !== "completed") return false;
  if (params.result.turnExecutionContract.turnClass !== "workflow_implementation") {
    return false;
  }
  const targetArtifacts = params.result.turnExecutionContract.targetArtifacts ?? [];
  if (targetArtifacts.length === 0) return false;
  return params.verifierService.shouldVerifySubAgentResult(true);
}

export async function maybeRunTopLevelVerifier(
  params: MaybeRunTopLevelVerifierParams,
): Promise<ChatExecutorResult> {
  if (!shouldRunTopLevelVerifier(params)) {
    return params.result;
  }
  const subAgentManager = params.subAgentManager;
  if (!subAgentManager) {
    return params.result;
  }

  const workspaceRoot = normalizeWorkspaceRoot(
    params.result.turnExecutionContract.workspaceRoot,
  );
  const sourceArtifacts = normalizeArtifactPaths(
    params.result.turnExecutionContract.sourceArtifacts ?? [],
    workspaceRoot,
  );
  const targetArtifacts = normalizeArtifactPaths(
    params.result.turnExecutionContract.targetArtifacts ?? [],
    workspaceRoot,
  );
  const definition = selectVerifyDefinition(params.agentDefinitions);
  const inspectionArtifacts = [...new Set([...sourceArtifacts, ...targetArtifacts])];
  const executionEnvelope = createExecutionEnvelope({
    workspaceRoot,
    allowedReadRoots: workspaceRoot ? [workspaceRoot] : [],
    allowedWriteRoots: [],
    allowedTools: definition.tools,
    inputArtifacts: inspectionArtifacts,
    requiredSourceArtifacts: inspectionArtifacts,
    targetArtifacts,
    effectClass: "read_only",
    verificationMode: "grounded_read",
    stepKind: "delegated_validation",
    role: "validator",
    completionContract: {
      taskClass: "artifact_only",
      placeholdersAllowed: false,
      partialCompletionAllowed: false,
    },
  });

  const spawnConfig: SubAgentConfig = {
    parentSessionId: params.sessionId,
    task: "Verify the completed implementation",
    prompt: buildVerifierPrompt({
      userRequest: params.userRequest,
      workspaceRoot,
      sourceArtifacts,
      targetArtifacts,
      assistantContent: params.result.content,
    }),
    systemPrompt: definition.systemPrompt,
    tools: definition.tools,
    structuredOutput: VERIFY_STRUCTURED_OUTPUT,
    ...(workspaceRoot ? { workingDirectory: workspaceRoot } : {}),
    requiredToolEvidence: {
      maxCorrectionAttempts: 1,
      executionEnvelope,
    },
  };

  let childSessionId: string;
  try {
    childSessionId = await subAgentManager.spawn(spawnConfig);
  } catch (error) {
    params.logger?.warn(
      "Failed to spawn top-level verifier worker",
      { sessionId: params.sessionId, error: error instanceof Error ? error.message : String(error) },
    );
    return buildVerifierAdjustedResult({
      result: params.result,
      verifier: { performed: false, overall: "retry" },
      verifierSummary: "Top-level verifier worker could not be started.",
    });
  }

  const verifierResult = await subAgentManager.waitForResult(childSessionId);
  const parsed = parseVerifierSnapshot(verifierResult);
  if (parsed.snapshot.overall !== "pass") {
    params.logger?.warn(
      "Top-level verifier did not pass",
      {
        sessionId: params.sessionId,
        verifierSessionId: childSessionId,
        verdict: parsed.snapshot.overall,
      },
    );
  }

  return buildVerifierAdjustedResult({
    result: params.result,
    verifier: parsed.snapshot,
    verifierSummary: parsed.summary,
  });
}
