import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AGENT_RUN_SCHEMA_VERSION } from "../gateway/agent-run-contract.js";
import { BackgroundRunStore, type PersistedBackgroundRun } from "../gateway/background-run-store.js";
import { createEffectApprovalPolicy } from "../gateway/effect-approval-policy.js";
import { SqliteBackend } from "../memory/sqlite/backend.js";
import { ChatExecutor } from "../llm/chat-executor.js";
import { executeChatToLegacyResult } from "../llm/execute-chat.js";
import { LLMTimeoutError } from "../llm/errors.js";
import type { LLMProvider, LLMResponse } from "../llm/types.js";
import { resolveWorkflowCompletionState } from "../workflow/completion-state.js";
import type { WorkflowProgressSnapshot } from "../workflow/completion-progress.js";
import type { WorkflowVerificationContract } from "../workflow/verification-obligations.js";
import { TrajectoryReplayEngine } from "./replay.js";
import { parseTrajectoryTrace } from "./types.js";

export type PipelineImplementationGateScenarioCategory =
  | "shell_stub_replay"
  | "deterministic_false_completion"
  | "live_runtime_false_completion"
  | "scaffold_placeholder"
  | "implementation_repair"
  | "wrong_artifact_verifier"
  | "resume_partial_completion"
  | "degraded_provider_retry"
  | "safety_incomplete_output";

export type PipelineImplementationGateExecutionMode =
  | "replay"
  | "temp_repo"
  | "runtime"
  | "background_run"
  | "policy";

export interface PipelineImplementationGateScenarioArtifact {
  readonly scenarioId: string;
  readonly title: string;
  readonly category: PipelineImplementationGateScenarioCategory;
  readonly mandatory: boolean;
  readonly executionMode: PipelineImplementationGateExecutionMode;
  readonly passed: boolean;
  readonly falseCompleted: boolean;
  readonly observedOutcome: string;
  readonly expectedOutcome: string;
  readonly notes?: string;
}

export interface PipelineImplementationGateArtifact {
  readonly scenarioCount: number;
  readonly mandatoryScenarioCount: number;
  readonly advisoryScenarioCount: number;
  readonly passingScenarios: number;
  readonly passRate: number;
  readonly mandatoryPassingScenarios: number;
  readonly mandatoryPassRate: number;
  readonly falseCompletedScenarios: number;
  readonly scenarios: readonly PipelineImplementationGateScenarioArtifact[];
}

export interface PipelineImplementationGateSuiteConfig {
  readonly incidentFixtureDir: string;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return numerator / denominator;
}

function createSequentialProvider(
  name: string,
  responses: readonly LLMResponse[],
): LLMProvider {
  const queue = [...responses];
  const nextResponse = async (): Promise<LLMResponse> => {
    const response = queue.shift();
    if (!response) {
      throw new Error(`No queued LLM response remained for ${name}`);
    }
    return response;
  };
  return {
    name,
    chat: async () => nextResponse(),
    chatStream: async () => nextResponse(),
    healthCheck: async () => true,
  };
}

function buildRuntimeRequiredToolEvidence(workspaceRoot: string, targetArtifacts: readonly string[]) {
  return {
    maxCorrectionAttempts: 0,
    verificationContract: {
      workspaceRoot,
      targetArtifacts,
      acceptanceCriteria: ["Grounded implementation and verification must both pass."],
      completionContract: {
        taskClass: "behavior_required" as const,
        placeholdersAllowed: false,
        partialCompletionAllowed: false,
        placeholderTaxonomy: "implementation" as const,
      },
    },
  };
}

async function runLiveRuntimeFalseCompletionScenario(): Promise<PipelineImplementationGateScenarioArtifact> {
  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), "agenc-phase12-false-completion-"),
  );
  try {
    const provider = createSequentialProvider("phase12-false-completion", [
      {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "tc-1",
            name: "system.writeFile",
            arguments: JSON.stringify({
              path: "src/lexer.c",
              content: "int lex(void) { return 1; }\n",
            }),
          },
        ],
        usage: { promptTokens: 40, completionTokens: 20, totalTokens: 60 },
        model: "phase12-model",
      },
      {
        content:
          "All requested phases are fully implemented, integrated, and production-ready.",
        toolCalls: [],
        usage: { promptTokens: 35, completionTokens: 18, totalTokens: 53 },
        model: "phase12-model",
        finishReason: "stop",
      },
    ]);
    const toolHandler = async (name: string, args: Record<string, unknown>) => {
      if (name === "system.writeFile") {
        const relativePath =
          typeof args.path === "string" ? args.path : "missing-path";
        const content = typeof args.content === "string" ? args.content : "";
        const absolutePath = path.join(workspaceRoot, relativePath);
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, content, "utf8");
      }
      return JSON.stringify({
        ok: true,
        path: args.path,
      });
    };
    const executor = new ChatExecutor({
      providers: [provider],
      toolHandler,
      runtimeContractFlags: {
        runtimeContractV2: true,
        stopHooksEnabled: true,
        asyncTasksEnabled: false,
        persistentWorkersEnabled: false,
        mailboxEnabled: false,
        verifierRuntimeRequired: false,
        verifierProjectBootstrap: false,
        workerIsolationWorktree: false,
        workerIsolationRemote: false,
      },
    });
    const targetArtifacts = [
      path.join(workspaceRoot, "src/lexer.c"),
      path.join(workspaceRoot, "src/parser.c"),
    ];
    const result = await executeChatToLegacyResult(executor, {
      message: {
        id: "phase12-false-completion",
        channel: "eval",
        senderId: "phase12",
        senderName: "Phase 12",
        sessionId: "phase12-false-completion",
        content: "Implement every remaining file without stopping early.",
        timestamp: Date.now(),
        scope: "dm",
      },
      history: [],
      systemPrompt: "You are an evaluation harness.",
      sessionId: "phase12-false-completion",
      runtimeContext: { workspaceRoot },
      requiredToolEvidence: buildRuntimeRequiredToolEvidence(
        workspaceRoot,
        targetArtifacts,
      ),
    });

    const observedOutcome = `${result.stopReason}:${result.completionState}`;
    return {
      scenarioId: "live_runtime_false_completion_gate",
      title:
        "Live runtime rejects partial writes followed by a polished completion summary",
      category: "live_runtime_false_completion",
      mandatory: true,
      executionMode: "runtime",
      passed:
        result.stopReason === "validation_error" &&
        result.completionState === "partial" &&
        observedOutcome !== "completed:completed",
      falseCompleted: result.completionState === "completed",
      observedOutcome,
      expectedOutcome: "validation_error:partial",
      notes: `writes=${result.toolCalls.filter((call) => call.name === "system.writeFile").length}`,
    };
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function runWrongArtifactVerifierScenario(): Promise<PipelineImplementationGateScenarioArtifact> {
  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), "agenc-phase12-wrong-artifact-"),
  );
  try {
    const provider = createSequentialProvider("phase12-wrong-artifact", [
      {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "tc-1",
            name: "system.writeFile",
            arguments: JSON.stringify({
              path: "src/main.c",
              content:
                "int duplicate_symbol(void) { return 1; }\nint duplicate_symbol(void) { return 2; }\n",
            }),
          },
        ],
        usage: { promptTokens: 40, completionTokens: 24, totalTokens: 64 },
        model: "phase12-model",
      },
      {
        content:
          "Implemented the requested runtime modules and verified the workspace state.",
        toolCalls: [],
        usage: { promptTokens: 36, completionTokens: 16, totalTokens: 52 },
        model: "phase12-model",
        finishReason: "stop",
      },
    ]);
    const toolHandler = async (name: string, args: Record<string, unknown>) => {
      if (name === "system.writeFile") {
        const relativePath =
          typeof args.path === "string" ? args.path : "missing-path";
        const content = typeof args.content === "string" ? args.content : "";
        const absolutePath = path.join(workspaceRoot, relativePath);
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, content, "utf8");
      }
      return JSON.stringify({
        ok: true,
        path: args.path,
      });
    };
    const executor = new ChatExecutor({
      providers: [provider],
      toolHandler,
      runtimeContractFlags: {
        runtimeContractV2: true,
        stopHooksEnabled: true,
        asyncTasksEnabled: false,
        persistentWorkersEnabled: false,
        mailboxEnabled: false,
        verifierRuntimeRequired: true,
        verifierProjectBootstrap: false,
        workerIsolationWorktree: false,
        workerIsolationRemote: false,
      },
      completionValidation: {
        topLevelVerifier: {
          subAgentManager: {
            spawn: async () => "subagent:verify-wrong-artifact",
            waitForResult: async () => ({
              sessionId: "subagent:verify-wrong-artifact",
              output: "Build fails.\nVERDICT: FAIL",
              success: false,
              durationMs: 12,
              toolCalls: [
                {
                  name: "verification.runProbe",
                  args: { probeId: "build" },
                  result:
                    "{\"ok\":false,\"__agencVerification\":{\"probeId\":\"build\",\"category\":\"build\",\"profile\":\"generic\"}}",
                  isError: false,
                  durationMs: 2,
                },
              ],
              structuredOutput: {
                type: "json_schema" as const,
                name: "agenc_top_level_verifier_decision",
                parsed: {
                  verdict: "fail",
                  summary:
                    "The artifact is non-empty, but the verifier caught duplicate symbol definitions.",
                },
              },
              completionState: "completed" as const,
              stopReason: "completed" as const,
            }),
          },
          verifierService: {
            resolveVerifierRequirement: () => ({
              required: true,
              profiles: ["generic"],
              probeCategories: ["build"],
              mutationPolicy: "read_only_workspace",
              allowTempArtifacts: false,
              bootstrapSource: "disabled",
              rationale: ["Phase 12 wrong-artifact gate"],
            }),
            shouldVerifySubAgentResult: () => true,
          },
        },
      },
    });
    const artifactPath = path.join(workspaceRoot, "src/main.c");
    const result = await executeChatToLegacyResult(executor, {
      message: {
        id: "phase12-wrong-artifact",
        channel: "eval",
        senderId: "phase12",
        senderName: "Phase 12",
        sessionId: "phase12-wrong-artifact",
        content: "Implement the requested runtime artifact and verify it.",
        timestamp: Date.now(),
        scope: "dm",
      },
      history: [],
      systemPrompt: "You are an evaluation harness.",
      sessionId: "phase12-wrong-artifact",
      runtimeContext: { workspaceRoot },
      requiredToolEvidence: buildRuntimeRequiredToolEvidence(
        workspaceRoot,
        [artifactPath],
      ),
    });
    const artifactStats = await stat(artifactPath);
    const observedOutcome = `${result.stopReason}:${result.completionState}:${result.verifierSnapshot?.overall ?? "missing"}`;
    return {
      scenarioId: "non_empty_wrong_artifact_verifier_gate",
      title:
        "Non-empty but incorrect artifacts are rejected by the runtime verifier contract",
      category: "wrong_artifact_verifier",
      mandatory: true,
      executionMode: "runtime",
      passed:
        artifactStats.size > 0 &&
        result.stopReason === "validation_error" &&
        result.completionState === "partial" &&
        result.verifierSnapshot?.overall === "fail",
      falseCompleted: result.completionState === "completed",
      observedOutcome,
      expectedOutcome: "validation_error:partial:fail",
      notes: `bytes=${artifactStats.size}`,
    };
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function runShellStubReplayScenario(
  incidentFixtureDir: string,
): Promise<PipelineImplementationGateScenarioArtifact> {
  const [rawTrace, rawExpected] = await Promise.all([
    readFile(path.join(incidentFixtureDir, "shell-stub-false-completion.trace.json"), "utf8"),
    readFile(path.join(incidentFixtureDir, "shell-stub-false-completion.expected.json"), "utf8"),
  ]);
  const trace = parseTrajectoryTrace(JSON.parse(rawTrace) as unknown);
  const expected = JSON.parse(rawExpected) as {
    expectedReplay: { taskPda: string; finalStatus: string };
  };
  const replay = new TrajectoryReplayEngine({ strictMode: true }).replay(trace);
  const task = replay.tasks[expected.expectedReplay.taskPda];
  const falseCompleted = task?.status === "completed";
  const observedOutcome = task?.status ?? "missing";
  return {
    scenarioId: "shell_stub_false_completion_replay_gate",
    title: "Shell stub incident remains non-complete under deterministic replay",
    category: "shell_stub_replay",
    mandatory: true,
    executionMode: "replay",
    passed:
      replay.errors.length === 0 &&
      replay.warnings.length === 0 &&
      observedOutcome === expected.expectedReplay.finalStatus &&
      falseCompleted === false,
    falseCompleted,
    observedOutcome,
    expectedOutcome: expected.expectedReplay.finalStatus,
    notes: `errors=${replay.errors.length} warnings=${replay.warnings.length}`,
  };
}

async function runResumeAfterPartialScenario(): Promise<PipelineImplementationGateScenarioArtifact> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "agenc-phase8-resume-"));
  const dbPath = path.join(tempDir, "background.sqlite");
  const backend = new SqliteBackend({ dbPath });
  try {
    const store = new BackgroundRunStore({ memoryBackend: backend });
    const verificationContract: WorkflowVerificationContract = {
      workspaceRoot: "/tmp/phase8-workspace",
      targetArtifacts: ["/tmp/phase8-workspace/src/main.c"],
      acceptanceCriteria: ["Behavior harness passes for the repaired implementation."],
      completionContract: {
        taskClass: "behavior_required",
        placeholdersAllowed: false,
        partialCompletionAllowed: false,
        placeholderTaxonomy: "implementation",
      },
    };
    const completionProgress: WorkflowProgressSnapshot = {
      completionState: "needs_verification",
      stopReason: "completed",
      verificationContract,
      completionContract: verificationContract.completionContract,
      requiredRequirements: ["workflow_verifier_pass", "behavior_verification"],
      satisfiedRequirements: ["build_verification"],
      remainingRequirements: ["workflow_verifier_pass", "behavior_verification"],
      reusableEvidence: [
        {
          requirement: "build_verification",
          summary: "make test",
          observedAt: 1,
        },
      ],
      updatedAt: 1,
    };
    const run: PersistedBackgroundRun = {
      version: AGENT_RUN_SCHEMA_VERSION,
      id: "phase8-resume-run",
      sessionId: "phase8-resume-session",
      objective: "Continue implementation without losing grounded progress.",
      contract: {
        domain: "generic",
        kind: "finite",
        successCriteria: ["Finish implementation truthfully."],
        completionCriteria: ["Pass verifier obligations."],
        blockedCriteria: ["Verification evidence is still missing."],
        nextCheckMs: 4_000,
        heartbeatMs: 12_000,
        requiresUserStop: false,
        managedProcessPolicy: { mode: "none" },
      },
      state: "working",
      createdAt: 1,
      updatedAt: 1,
      cycleCount: 1,
      stableWorkingCycles: 0,
      consecutiveErrorCycles: 0,
      nextCheckAt: 10,
      lastVerifiedAt: 1,
      lastWakeReason: "tool_result",
      completionProgress,
      approvalState: { status: "none" },
      budgetState: {
        runtimeStartedAt: 1,
        lastActivityAt: 1,
        lastProgressAt: 1,
        totalTokens: 0,
        lastCycleTokens: 0,
        managedProcessCount: 0,
        maxRuntimeMs: 604_800_000,
        maxCycles: 512,
        nextCheckIntervalMs: 4_000,
        heartbeatIntervalMs: 12_000,
      },
      compaction: {
        lastCompactedCycle: 0,
        refreshCount: 0,
        lastHistoryLength: 0,
        repairCount: 0,
      },
      pendingSignals: [],
      observedTargets: [],
      watchRegistrations: [],
      internalHistory: [],
      fenceToken: 1,
    };
    await store.saveRun(run);
    await backend.flush();
    await backend.close();

    const reopened = new SqliteBackend({ dbPath });
    try {
      const reopenedStore = new BackgroundRunStore({ memoryBackend: reopened });
      const loaded = await reopenedStore.loadRun(run.sessionId);
      const observedOutcome = loaded?.completionProgress?.completionState ?? "missing";
      const remaining = loaded?.completionProgress?.remainingRequirements ?? [];
      const reusedEvidence = loaded?.completionProgress?.reusableEvidence ?? [];
      return {
        scenarioId: "resume_after_partial_completion",
        title: "Restart and resume preserve partial completion state and verifier obligations",
        category: "resume_partial_completion",
        mandatory: true,
        executionMode: "background_run",
        passed:
          observedOutcome === "needs_verification" &&
          remaining.includes("behavior_verification") &&
          reusedEvidence.some((entry) => entry.requirement === "build_verification"),
        falseCompleted: observedOutcome === "completed",
        observedOutcome,
        expectedOutcome: "needs_verification",
        notes: `remaining=${remaining.join(",") || "none"}`,
      };
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runDegradedProviderRetryScenario(): Promise<PipelineImplementationGateScenarioArtifact> {
  const primary: LLMProvider = {
    name: "degraded-primary",
    chat: async () => {
      throw new LLMTimeoutError("degraded-primary", 5_000);
    },
    chatStream: async () => {
      throw new LLMTimeoutError("degraded-primary", 5_000);
    },
    healthCheck: async () => true,
  };
  const fallbackResponse: LLMResponse = {
    content: "Fallback provider reached. Implementation claim still requires verification.",
    toolCalls: [],
    usage: { promptTokens: 24, completionTokens: 9, totalTokens: 33 },
    model: "fallback-model",
    finishReason: "stop",
  };
  const fallback: LLMProvider = {
    name: "fallback-provider",
    chat: async () => fallbackResponse,
    chatStream: async () => fallbackResponse,
    healthCheck: async () => true,
  };
  const executor = new ChatExecutor({
    providers: [primary, fallback],
  });
  const result = await executeChatToLegacyResult(executor, {
    message: {
      id: "phase8-reroute-message",
      channel: "eval",
      senderId: "phase8",
      senderName: "Phase 8",
      sessionId: "phase8-reroute",
      content: "Continue the implementation after the degraded provider fails.",
      timestamp: Date.now(),
      scope: "dm",
    },
    history: [],
    systemPrompt: "You are an evaluation harness.",
    sessionId: "phase8-reroute",
  });
  const verificationContract: WorkflowVerificationContract = {
    workspaceRoot: "/tmp/phase8-reroute",
    targetArtifacts: ["/tmp/phase8-reroute/src/runner.js"],
    acceptanceCriteria: ["Behavior verification must pass before completion."],
    completionContract: {
      taskClass: "behavior_required",
      placeholdersAllowed: false,
      partialCompletionAllowed: false,
      placeholderTaxonomy: "implementation",
    },
  };
  const completionState = resolveWorkflowCompletionState({
    stopReason: "completed",
    toolCalls: [],
    verificationContract,
    verifier: { performed: false, overall: "skipped" },
  });
  return {
    scenarioId: "degraded_provider_retry_without_false_completion",
    title: "Provider reroute does not turn missing implementation verification into completed",
    category: "degraded_provider_retry",
    mandatory: false,
    executionMode: "runtime",
    passed: result.usedFallback === true && completionState !== "completed",
    falseCompleted: completionState === "completed",
    observedOutcome: completionState,
    expectedOutcome: "needs_verification",
    notes: `fallback=${String(result.usedFallback)}`,
  };
}

async function runSafetyIncompleteOutputScenario(): Promise<PipelineImplementationGateScenarioArtifact> {
  const policy = createEffectApprovalPolicy({
    mode: "safe_local_dev",
    workspaceRoot: "/tmp/agenc-phase8-safety",
  });
  const outcome = policy.evaluate({
    toolName: "system.bash",
    args: { command: "rm -rf ./src" },
    sessionId: "phase8-safety",
    effect: {
      effectId: "phase8-safety:effect",
      idempotencyKey: "phase8-safety:idempotency",
      effectClass: "shell",
      effectKind: "shell_command",
      summary: "Dangerous destructive cleanup while implementation is still incomplete.",
      targets: ["rm -rf ./src"],
    },
  });
  const verificationContract: WorkflowVerificationContract = {
    workspaceRoot: "/tmp/agenc-phase8-safety",
    targetArtifacts: ["/tmp/agenc-phase8-safety/src/main.c"],
    acceptanceCriteria: ["Behavior verification must still pass before completion."],
    completionContract: {
      taskClass: "behavior_required",
      placeholdersAllowed: false,
      partialCompletionAllowed: false,
      placeholderTaxonomy: "implementation",
    },
  };
  const completionState = resolveWorkflowCompletionState({
    stopReason: "completed",
    toolCalls: [],
    verificationContract,
    verifier: { performed: false, overall: "skipped" },
  });
  const blocked = outcome.status === "deny" || outcome.status === "require_approval";
  return {
    scenarioId: "safety_gates_risky_incomplete_output",
    title: "Risky destructive follow-up is gated while completion is still incomplete",
    category: "safety_incomplete_output",
    mandatory: false,
    executionMode: "policy",
    passed: blocked && completionState !== "completed",
    falseCompleted: completionState === "completed",
    observedOutcome: `${completionState}:${outcome.status}`,
    expectedOutcome: "needs_verification:require_approval_or_deny",
    notes: outcome.reasonCode,
  };
}

export async function runImplementationGateSuite(
  config: PipelineImplementationGateSuiteConfig,
): Promise<PipelineImplementationGateArtifact> {
  const scenarios = await Promise.all([
    runShellStubReplayScenario(config.incidentFixtureDir),
    runLiveRuntimeFalseCompletionScenario(),
    runWrongArtifactVerifierScenario(),
    runResumeAfterPartialScenario(),
    runDegradedProviderRetryScenario(),
    runSafetyIncompleteOutputScenario(),
  ]);
  const mandatoryScenarios = scenarios.filter((scenario) => scenario.mandatory);
  const passingScenarios = scenarios.filter((scenario) => scenario.passed).length;
  const mandatoryPassingScenarios = mandatoryScenarios.filter(
    (scenario) => scenario.passed,
  ).length;
  return {
    scenarioCount: scenarios.length,
    mandatoryScenarioCount: mandatoryScenarios.length,
    advisoryScenarioCount: scenarios.length - mandatoryScenarios.length,
    passingScenarios,
    passRate: ratio(passingScenarios, scenarios.length),
    mandatoryPassingScenarios,
    mandatoryPassRate: ratio(mandatoryPassingScenarios, mandatoryScenarios.length),
    falseCompletedScenarios: scenarios.filter((scenario) => scenario.falseCompleted).length,
    scenarios,
  };
}
