import { tmpdir } from "node:os";

import type { ChatExecutorResult } from "../llm/chat-executor-types.js";
import { type PlannerVerificationSnapshot } from "../workflow/completion-state.js";
import { createExecutionEnvelope } from "../workflow/execution-envelope.js";
import { areDocumentationOnlyArtifacts } from "../workflow/artifact-paths.js";
import {
  normalizeArtifactPaths,
  normalizeWorkspaceRoot,
} from "../workflow/path-normalization.js";
import type { Logger } from "../utils/logger.js";
import type { AgentDefinition } from "./agent-loader.js";
import type { DelegationVerifierService } from "./delegation-runtime.js";
import { isSubAgentSessionId } from "./delegation-runtime.js";
import {
  extractVerificationProbeCoverage,
  type VerifierRequirement,
} from "./verifier-probes.js";
import type { TurnExecutionContract } from "../llm/turn-execution-contract-types.js";
import type {
  SubAgentConfig,
  SubAgentManager,
  SubAgentResult,
} from "./sub-agent.js";
import type { LLMStructuredOutputRequest } from "../llm/types.js";
import type { RuntimeVerifierVerdict } from "../runtime-contract/types.js";
import type { SystemRemoteJobManager } from "../tools/system/remote-job.js";
import type { TaskStore } from "../tools/system/task-tracker.js";
import { createPromptEnvelope } from "../llm/prompt-envelope.js";
import {
  reportManagedRemoteJob,
  startManagedRemoteJob,
} from "./remote-execution-handles.js";

const DEFAULT_VERIFY_TOOLS = [
  "system.readFile",
  "system.readFileRange",
  "system.listDir",
  "system.stat",
  "system.searchFiles",
  "system.grep",
  "system.bash",
  "system.httpGet",
  "system.httpPost",
  "system.httpFetch",
  "system.browse",
  "system.extractLinks",
  "system.htmlToMarkdown",
  "system.browserAction",
  "system.browserSessionStart",
  "system.browserSessionStatus",
  "system.browserSessionResume",
  "system.browserSessionStop",
  "system.browserSessionArtifacts",
  "system.browserSessionTransfers",
  "system.browserTransferStatus",
  "system.browserTransferCancel",
  "mcp.browser.browser_navigate",
  "mcp.browser.browser_snapshot",
  "playwright.browser_navigate",
  "playwright.browser_snapshot",
  "playwright.browser_click",
  "playwright.browser_type",
  "verification.listProbes",
  "verification.runProbe",
] as const;

const DEFAULT_VERIFY_SYSTEM_PROMPT =
  "You are a verification agent. Your job is to try to break the claimed implementation with real checks. " +
  "Do not intentionally modify project files. You may use temp artifacts outside the workspace when needed for verification harnesses, " +
  "and you may run normal repo-local build/test commands when required to verify the implementation. " +
  "Read the repo instructions first, inspect the declared artifacts directly, and run repo-local verification commands when possible, " +
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

interface TopLevelVerifierParams {
  readonly sessionId: string;
  readonly userRequest: string;
  readonly result: Pick<
    ChatExecutorResult,
    | "content"
    | "stopReason"
    | "completionState"
    | "turnExecutionContract"
    | "toolCalls"
    | "stopReasonDetail"
    | "validationCode"
    | "completionProgress"
    | "runtimeContractSnapshot"
  >;
  readonly subAgentManager: Pick<SubAgentManager, "spawn" | "waitForResult"> | null;
  readonly verifierService: Pick<
    DelegationVerifierService,
    "resolveVerifierRequirement" | "shouldVerifySubAgentResult"
  > | null;
  readonly taskStore?: TaskStore | null;
  readonly remoteJobManager?: Pick<
    SystemRemoteJobManager,
    "start" | "handleWebhook"
  > | null;
  readonly agentDefinitions?: readonly AgentDefinition[];
  readonly logger?: Logger;
  readonly onTraceEvent?: (
    event: TopLevelVerifierTraceEvent,
  ) => void | Promise<void>;
}

export interface TopLevelVerifierValidationResult {
  readonly outcome:
    | "pass"
    | "retry_with_blocking_message"
    | "fail_closed"
    | "skipped";
  readonly verifier: PlannerVerificationSnapshot;
  readonly runtimeVerifier: RuntimeVerifierVerdict;
  readonly summary: string;
  readonly blockingMessage?: string;
  readonly exhaustedDetail?: string;
  readonly taskId?: string;
  readonly verifierRequirement?: VerifierRequirement;
  readonly launcherKind?: "subagent" | "remote_job";
}

export interface TopLevelVerifierTraceEvent {
  readonly type: "spawned" | "skipped" | "unavailable" | "verdict";
  readonly sessionId: string;
  readonly taskId?: string;
  readonly launcherKind?: "subagent" | "remote_job";
  readonly summary?: string;
  readonly verdict?: RuntimeVerifierVerdict["overall"];
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export function isExplicitTopLevelVerifierRequiredForTurn(params: {
  readonly turnExecutionContract:
    | Pick<
        TurnExecutionContract,
        | "turnClass"
        | "completionContract"
        | "verificationContract"
        | "targetArtifacts"
      >
    | undefined;
}): boolean {
  if (params.turnExecutionContract?.turnClass !== "workflow_implementation") {
    return false;
  }
  const targetArtifacts = params.turnExecutionContract?.targetArtifacts ?? [];
  if (targetArtifacts.length === 0) {
    return false;
  }
  if (areDocumentationOnlyArtifacts(targetArtifacts)) {
    return false;
  }
  return true;
}

function selectVerifyDefinition(
  definitions: readonly AgentDefinition[] | undefined,
): {
  readonly tools: readonly string[];
  readonly promptEnvelope: ReturnType<typeof createPromptEnvelope>;
} {
  const match = definitions?.find((definition) => definition.name === "verify");
  const tools = match?.tools?.length
    ? [...new Set(match.tools.map((toolName) => toolName.trim()).filter(Boolean))]
    : [...DEFAULT_VERIFY_TOOLS];
  return {
    tools,
    promptEnvelope: createPromptEnvelope(
      match?.body.trim().length
        ? match.body.trim()
        : DEFAULT_VERIFY_SYSTEM_PROMPT,
    ),
  };
}

function buildVerifierPrompt(params: {
  readonly userRequest: string;
  readonly workspaceRoot?: string;
  readonly sourceArtifacts: readonly string[];
  readonly targetArtifacts: readonly string[];
  readonly assistantContent: string;
  readonly verifierRequirement: VerifierRequirement;
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
  if (params.verifierRequirement.profiles.length > 0) {
    lines.push("");
    lines.push(
      `Required verifier profiles: ${params.verifierRequirement.profiles.join(", ")}`,
    );
  }
  if (params.verifierRequirement.probeCategories.length > 0) {
    lines.push(
      `Required probe categories before PASS: ${params.verifierRequirement.probeCategories.join(", ")}`,
    );
  }
  lines.push("");
  lines.push(
    "Read the repo instructions first, inspect the target artifacts directly, use the attached shell/http/browser/probe tools for concrete verification, and report whether the implementation actually holds up.",
  );
  return lines.join("\n");
}

function buildVerifierBlockingMessage(params: {
  readonly summary: string;
  readonly verdict: RuntimeVerifierVerdict["overall"];
}): string {
  const verdictLabel =
    params.verdict === "retry" ? "RETRY" : params.verdict.toUpperCase();
  return [
    `Runtime verification blocked completion because the verifier returned ${verdictLabel}.`,
    "",
    "Verifier summary:",
    params.summary,
    "",
    "Use tools to fix the implementation until verification passes. Do not restate completion while verifier failures remain.",
  ].join("\n");
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
  const verdict =
    typeof object.verdict === "string"
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

function toRuntimeVerifierVerdict(params: {
  readonly snapshot: PlannerVerificationSnapshot;
  readonly summary: string;
}): RuntimeVerifierVerdict {
  return {
    attempted: params.snapshot.performed,
    overall: params.snapshot.overall,
    ...(params.summary.trim().length > 0 ? { summary: params.summary } : {}),
  };
}

function shouldRunTopLevelVerifier(params: TopLevelVerifierParams): boolean {
  if (isSubAgentSessionId(params.sessionId)) return false;
  if (params.result.stopReason !== "completed") return false;
  if (params.result.completionState !== "completed") return false;
  if (
    !isExplicitTopLevelVerifierRequiredForTurn({
      turnExecutionContract: params.result.turnExecutionContract,
    })
  ) {
    return false;
  }
  if (!params.verifierService) return true;
  return params.verifierService.resolveVerifierRequirement({
    requested: true,
    runtimeRequired: true,
    projectBootstrap:
      params.result.runtimeContractSnapshot?.flags.verifierProjectBootstrap,
    workspaceRoot: params.result.turnExecutionContract.workspaceRoot,
  }).required;
}

function resolveTopLevelVerifierRequirement(
  params: TopLevelVerifierParams,
): VerifierRequirement | null {
  const explicitVerifierRequired = isExplicitTopLevelVerifierRequiredForTurn({
    turnExecutionContract: params.result.turnExecutionContract,
  });
  if (!explicitVerifierRequired) {
    return null;
  }
  if (!params.verifierService) {
    return explicitVerifierRequired
      ? {
          required: true,
          bootstrapSource: "fallback",
          profiles: ["generic"],
          probeCategories: [],
          mutationPolicy: "read_only_workspace",
          allowTempArtifacts: true,
          rationale: ["runtime verifier required"],
        }
      : null;
  }
  return params.verifierService.resolveVerifierRequirement({
    requested: true,
    runtimeRequired: true,
    projectBootstrap:
      params.result.runtimeContractSnapshot?.flags.verifierProjectBootstrap,
    workspaceRoot: params.result.turnExecutionContract.workspaceRoot,
  });
}

function getTopLevelVerifierSkipReason(
  params: TopLevelVerifierParams,
): string | undefined {
  if (isSubAgentSessionId(params.sessionId)) return "subagent_session";
  if (params.result.stopReason !== "completed") return "stop_reason_not_completed";
  if (params.result.completionState !== "completed") {
    return "completion_state_not_completed";
  }
  if (params.result.turnExecutionContract.turnClass !== "workflow_implementation") {
    return "turn_class_not_workflow_implementation";
  }
  const targetArtifacts = params.result.turnExecutionContract.targetArtifacts ?? [];
  if (targetArtifacts.length === 0) return "missing_target_artifacts";
  if (areDocumentationOnlyArtifacts(targetArtifacts)) {
    return "documentation_only_artifacts";
  }
  return undefined;
}

function buildTopLevelVerifierSkipBlockingMessage(reason: string): string {
  const detail =
    reason === "subagent_session"
      ? "the verifier cannot run from a subagent session"
      : reason === "stop_reason_not_completed"
        ? "the turn has not reached a completed stop reason yet"
        : reason === "completion_state_not_completed"
        ? "the workflow completion state is not completed yet"
        : reason === "turn_class_not_workflow_implementation"
          ? "the turn is not classified as workflow_implementation"
            : reason === "documentation_only_artifacts"
              ? "the declared target artifacts are documentation-only"
            : "no target artifacts were declared for verification";
  return [
    "Runtime verification is required before completion can be accepted.",
    "",
    `Verifier launch is currently blocked because ${detail}.`,
    "Continue with tool calls until the implementation is in a verifiable completed state and target artifacts are declared.",
  ].join("\n");
}

export async function runTopLevelVerifierValidation(
  params: TopLevelVerifierParams,
): Promise<TopLevelVerifierValidationResult> {
  const emitTraceEvent = async (
    event: Omit<TopLevelVerifierTraceEvent, "sessionId">,
  ): Promise<void> => {
    try {
      await params.onTraceEvent?.({
        sessionId: params.sessionId,
        ...event,
      });
    } catch (error) {
      params.logger?.debug?.("Top-level verifier trace listener failed", {
        sessionId: params.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const verifierRequirement = resolveTopLevelVerifierRequirement(params);
  const verifierRequired = verifierRequirement?.required === true;
  const skipReason = getTopLevelVerifierSkipReason(params);
  if (skipReason) {
    if (verifierRequired) {
      const summary = `Top-level verifier is required but cannot run yet (${skipReason}).`;
      await emitTraceEvent({
        type: "skipped",
        summary,
      });
      return {
        outcome: "retry_with_blocking_message",
        verifier: { performed: false, overall: "retry" },
        runtimeVerifier: {
          attempted: false,
          overall: "retry",
          summary,
        },
        summary,
        blockingMessage: buildTopLevelVerifierSkipBlockingMessage(skipReason),
        exhaustedDetail: summary,
        verifierRequirement:
          verifierRequirement ?? {
            required: true,
            bootstrapSource: "fallback",
            profiles: ["generic"],
            probeCategories: [],
            mutationPolicy: "read_only_workspace",
            allowTempArtifacts: true,
            rationale: ["runtime verifier required"],
          },
      };
    }
    await emitTraceEvent({
      type: "skipped",
      summary: "Top-level verifier skipped.",
    });
    return {
      outcome: "skipped",
      verifier: { performed: false, overall: "skipped" },
      runtimeVerifier: { attempted: false, overall: "skipped" },
      summary: "Top-level verifier skipped.",
    };
  }
  if (!shouldRunTopLevelVerifier(params)) {
    await emitTraceEvent({
      type: "skipped",
      summary: "Top-level verifier skipped.",
    });
    return {
      outcome: "skipped",
      verifier: { performed: false, overall: "skipped" },
      runtimeVerifier: { attempted: false, overall: "skipped" },
      summary: "Top-level verifier skipped.",
    };
  }
  if (!params.verifierService) {
    await emitTraceEvent({
      type: "unavailable",
      summary: "Top-level verifier runtime is unavailable.",
    });
    return {
      outcome: "fail_closed",
      verifier: { performed: false, overall: "retry" },
      runtimeVerifier: {
        attempted: false,
        overall: "retry",
        summary: "Top-level verifier runtime is unavailable.",
      },
      summary: "Top-level verifier runtime is unavailable.",
      exhaustedDetail: "Top-level verifier runtime is unavailable.",
    };
  }
  const subAgentManager = params.subAgentManager;
  if (!subAgentManager) {
    await emitTraceEvent({
      type: "unavailable",
      summary: "Top-level verifier worker is unavailable.",
    });
    return {
      outcome: "fail_closed",
      verifier: { performed: false, overall: "retry" },
      runtimeVerifier: {
        attempted: false,
        overall: "retry",
        summary: "Top-level verifier worker is unavailable.",
      },
      summary: "Top-level verifier worker is unavailable.",
      exhaustedDetail: "Top-level verifier worker is unavailable.",
    };
  }

  const workspaceRoot = normalizeWorkspaceRoot(
    params.result.turnExecutionContract.workspaceRoot,
  );
  const effectiveVerifierRequirement =
    verifierRequirement ??
    params.verifierService.resolveVerifierRequirement({
      requested: true,
      runtimeRequired:
        params.result.runtimeContractSnapshot?.flags.verifierRuntimeRequired,
      projectBootstrap:
        params.result.runtimeContractSnapshot?.flags.verifierProjectBootstrap,
      workspaceRoot,
    });
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
    allowedWriteRoots: workspaceRoot ? [workspaceRoot, tmpdir()] : [tmpdir()],
    allowedTools: definition.tools,
    inputArtifacts: inspectionArtifacts,
    requiredSourceArtifacts: inspectionArtifacts,
    targetArtifacts,
    effectClass: "shell",
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
      verifierRequirement: effectiveVerifierRequirement,
    }),
    promptEnvelope: definition.promptEnvelope,
    tools: definition.tools,
    structuredOutput: VERIFY_STRUCTURED_OUTPUT,
    ...(workspaceRoot ? { workingDirectory: workspaceRoot } : {}),
    requiredToolEvidence: {
      maxCorrectionAttempts: 1,
      executionEnvelope: executionEnvelope!,
    },
  };

  const useRemoteJob =
    params.result.runtimeContractSnapshot?.flags.workerIsolationRemote === true;
  if (useRemoteJob && !params.remoteJobManager) {
    await emitTraceEvent({
      type: "unavailable",
      launcherKind: "remote_job",
      summary: "Remote verifier isolation is enabled but unavailable.",
    });
    return {
      outcome: "fail_closed",
      verifier: { performed: false, overall: "retry" },
      runtimeVerifier: {
        attempted: false,
        overall: "retry",
        summary: "Remote verifier isolation is enabled but unavailable.",
      },
      summary: "Remote verifier isolation is enabled but unavailable.",
      exhaustedDetail: "Remote verifier isolation is enabled but unavailable.",
      verifierRequirement: effectiveVerifierRequirement,
      launcherKind: "remote_job",
    };
  }
  const localExecutionLocation = {
    mode: "local" as const,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(workspaceRoot ? { workingDirectory: workspaceRoot } : {}),
  };
  let remoteJobHandle:
    | Awaited<ReturnType<typeof startManagedRemoteJob>>
    | undefined;
  if (useRemoteJob && params.remoteJobManager) {
    try {
      remoteJobHandle = await startManagedRemoteJob({
        manager: params.remoteJobManager,
        sessionId: params.sessionId,
        workspaceRoot,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await emitTraceEvent({
        type: "unavailable",
        launcherKind: "remote_job",
        summary: `Remote verifier handle could not be started: ${message}`,
      });
      return {
        outcome: "fail_closed",
        verifier: { performed: false, overall: "retry" },
        runtimeVerifier: {
          attempted: false,
          overall: "retry",
          summary: `Remote verifier handle could not be started: ${message}`,
        },
        summary: `Remote verifier handle could not be started: ${message}`,
        exhaustedDetail: `Remote verifier handle could not be started: ${message}`,
        verifierRequirement: effectiveVerifierRequirement,
        launcherKind: "remote_job",
      };
    }
  }

  let verifierTaskId: string | undefined;
  if (params.taskStore) {
    try {
      const verifierTask = await params.taskStore.createRuntimeTask({
        listId: params.sessionId,
        kind: "verifier",
        subject: "Run runtime verification",
        description: "Verify the completed implementation with concrete checks.",
        activeForm: "Running runtime verification",
        metadata: {
          _runtime: {
            verification: true,
            verifierProfiles: effectiveVerifierRequirement.profiles,
            verifierProbeCategories: effectiveVerifierRequirement.probeCategories,
          },
        },
        summary: "Runtime verifier started.",
        workingDirectory: workspaceRoot,
        executionLocation:
          remoteJobHandle?.executionLocation ?? localExecutionLocation,
      });
      verifierTaskId = verifierTask.id;
    } catch (error) {
      params.logger?.debug?.("Failed to create verifier task record", {
        sessionId: params.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let childSessionId: string;
  try {
    childSessionId = await subAgentManager.spawn(spawnConfig);
    if (params.taskStore && verifierTaskId) {
      await params.taskStore.attachExternalRef(
        params.sessionId,
        verifierTaskId,
        remoteJobHandle
          ? {
              kind: "remote_job",
              id: remoteJobHandle.handleId,
            }
          : {
              kind: "verifier",
              id: childSessionId,
              sessionId: childSessionId,
            },
        "Runtime verifier worker started.",
      );
    }
  } catch (error) {
    if (remoteJobHandle && params.remoteJobManager) {
      await reportManagedRemoteJob({
        manager: params.remoteJobManager,
        handleId: remoteJobHandle.handleId,
        callbackToken: remoteJobHandle.callbackToken,
        state: "failed",
        summary: "Top-level verifier worker could not be started.",
      }).catch(() => undefined);
    }
    if (params.taskStore && verifierTaskId) {
      await params.taskStore.finalizeRuntimeTask({
        listId: params.sessionId,
        taskId: verifierTaskId,
        status: "failed",
        summary: "Top-level verifier worker could not be started.",
        workingDirectory: workspaceRoot,
        executionLocation:
          remoteJobHandle?.executionLocation ?? localExecutionLocation,
        ...(remoteJobHandle
          ? {
              externalRef: {
                kind: "remote_job" as const,
                id: remoteJobHandle.handleId,
              },
            }
          : {}),
        eventData: {
          stage: "spawn",
        },
      });
    }
    params.logger?.warn(
      "Failed to spawn top-level verifier worker",
      {
        sessionId: params.sessionId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    await emitTraceEvent({
      type: "unavailable",
      ...(verifierTaskId ? { taskId: verifierTaskId } : {}),
      launcherKind: remoteJobHandle ? "remote_job" : "subagent",
      summary: "Top-level verifier worker could not be started.",
    });
    return {
      outcome: "fail_closed",
      verifier: { performed: false, overall: "retry" },
      runtimeVerifier: {
        attempted: false,
        overall: "retry",
        summary: "Top-level verifier worker could not be started.",
      },
      summary: "Top-level verifier worker could not be started.",
      exhaustedDetail: "Top-level verifier worker could not be started.",
      verifierRequirement: effectiveVerifierRequirement,
      launcherKind: remoteJobHandle ? "remote_job" : "subagent",
      ...(verifierTaskId ? { taskId: verifierTaskId } : {}),
    };
  }
  await emitTraceEvent({
    type: "spawned",
    ...(verifierTaskId ? { taskId: verifierTaskId } : {}),
    launcherKind: remoteJobHandle ? "remote_job" : "subagent",
    summary: "Runtime verifier is running.",
  });

  if (remoteJobHandle && params.remoteJobManager) {
    await reportManagedRemoteJob({
      manager: params.remoteJobManager,
      handleId: remoteJobHandle.handleId,
      callbackToken: remoteJobHandle.callbackToken,
      state: "running",
      summary: "Runtime verifier is running.",
      artifacts: targetArtifacts,
    });
  }

  const verifierResult = await subAgentManager.waitForResult(childSessionId);
  const coverage = extractVerificationProbeCoverage(verifierResult?.toolCalls ?? []);
  const effectiveParsed = parseVerifierSnapshot(verifierResult);
  const runtimeVerifier = toRuntimeVerifierVerdict(effectiveParsed);
  await emitTraceEvent({
    type: "verdict",
    ...(verifierTaskId ? { taskId: verifierTaskId } : {}),
    launcherKind: remoteJobHandle ? "remote_job" : "subagent",
    summary: effectiveParsed.summary,
    verdict: runtimeVerifier.overall,
  });
  if (params.taskStore && verifierTaskId) {
    await params.taskStore.finalizeRuntimeTask({
      listId: params.sessionId,
      taskId: verifierTaskId,
      status: effectiveParsed.snapshot.overall === "pass" ? "completed" : "failed",
      summary: effectiveParsed.summary,
      output: verifierResult?.output,
      structuredOutput: verifierResult?.structuredOutput?.parsed,
      usage:
        verifierResult?.tokenUsage as unknown as Record<string, unknown> | undefined,
      verifierVerdict: runtimeVerifier,
      ownedArtifacts: targetArtifacts,
      workingDirectory: workspaceRoot,
      executionLocation:
        remoteJobHandle?.executionLocation ?? localExecutionLocation,
      externalRef: remoteJobHandle
        ? {
            kind: "remote_job",
            id: remoteJobHandle.handleId,
          }
        : {
            kind: "verifier",
            id: childSessionId,
            sessionId: childSessionId,
          },
      eventData: {
        verifierSessionId: childSessionId,
        verdict: runtimeVerifier.overall,
        probeIds: coverage.probeIds,
        profiles: coverage.profiles,
        categories: coverage.categories,
      },
    });
  }
  if (remoteJobHandle && params.remoteJobManager) {
    await reportManagedRemoteJob({
      manager: params.remoteJobManager,
      handleId: remoteJobHandle.handleId,
      callbackToken: remoteJobHandle.callbackToken,
      state:
        effectiveParsed.snapshot.overall === "pass"
          ? "completed"
          : "failed",
      summary: effectiveParsed.summary,
      artifacts: targetArtifacts,
    });
  }
  if (effectiveParsed.snapshot.overall !== "pass") {
    params.logger?.warn(
      "Top-level verifier did not pass",
      {
        sessionId: params.sessionId,
        verifierSessionId: childSessionId,
        verdict: effectiveParsed.snapshot.overall,
      },
    );
  }
  if (!effectiveParsed.snapshot.performed) {
    return {
      outcome: "fail_closed",
      verifier: effectiveParsed.snapshot,
      runtimeVerifier,
      summary: effectiveParsed.summary,
      exhaustedDetail: `Top-level verifier retry: ${effectiveParsed.summary}`,
      verifierRequirement: effectiveVerifierRequirement,
      launcherKind: remoteJobHandle ? "remote_job" : "subagent",
      ...(verifierTaskId ? { taskId: verifierTaskId } : {}),
    };
  }
  if (effectiveParsed.snapshot.overall === "pass") {
    return {
      outcome: "pass",
      verifier: effectiveParsed.snapshot,
      runtimeVerifier,
      summary: effectiveParsed.summary,
      verifierRequirement: effectiveVerifierRequirement,
      launcherKind: remoteJobHandle ? "remote_job" : "subagent",
      ...(verifierTaskId ? { taskId: verifierTaskId } : {}),
    };
  }
  return {
    outcome: "retry_with_blocking_message",
    verifier: effectiveParsed.snapshot,
    runtimeVerifier,
    summary: effectiveParsed.summary,
    blockingMessage: buildVerifierBlockingMessage({
      summary: effectiveParsed.summary,
      verdict: runtimeVerifier.overall,
    }),
    exhaustedDetail:
      `Top-level verifier ${effectiveParsed.snapshot.overall}: ${effectiveParsed.summary}`,
    verifierRequirement: effectiveVerifierRequirement,
    launcherKind: remoteJobHandle ? "remote_job" : "subagent",
    ...(verifierTaskId ? { taskId: verifierTaskId } : {}),
  };
}
