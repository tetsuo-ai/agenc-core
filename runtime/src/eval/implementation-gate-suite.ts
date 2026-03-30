import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AGENT_RUN_SCHEMA_VERSION } from "../gateway/agent-run-contract.js";
import { BackgroundRunStore, type PersistedBackgroundRun } from "../gateway/background-run-store.js";
import { createEffectApprovalPolicy } from "../gateway/effect-approval-policy.js";
import { SqliteBackend } from "../memory/sqlite/backend.js";
import { ChatExecutor } from "../llm/chat-executor.js";
import { LLMTimeoutError } from "../llm/errors.js";
import type { LLMProvider, LLMResponse } from "../llm/types.js";
import { runCommand } from "../utils/process.js";
import type { DelegationValidationToolCall } from "../utils/delegation-validation.js";
import {
  resolveWorkflowCompletionState,
  resolveWorkflowDependencyState,
  type WorkflowCompletionState,
} from "../workflow/completion-state.js";
import type { WorkflowProgressSnapshot } from "../workflow/completion-progress.js";
import type { WorkflowVerificationContract } from "../workflow/verification-obligations.js";
import { validateRuntimeVerificationContract } from "../workflow/verification-contract.js";
import { TrajectoryReplayEngine } from "./replay.js";
import { parseTrajectoryTrace } from "./types.js";

export type PipelineImplementationGateScenarioCategory =
  | "shell_stub_replay"
  | "deterministic_false_completion"
  | "scaffold_placeholder"
  | "implementation_repair"
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

function stableJson(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function createWriteToolCall(targetPath: string, content: string): DelegationValidationToolCall {
  return {
    name: "system.writeFile",
    args: {
      path: targetPath,
      content,
    },
    result: stableJson({
      path: targetPath,
      ok: true,
    }),
    isError: false,
  };
}

function createReadToolCall(targetPath: string, content: string): DelegationValidationToolCall {
  return {
    name: "system.readFile",
    args: { path: targetPath },
    result: stableJson({
      path: targetPath,
      content,
    }),
    isError: false,
  };
}

async function createVerificationToolCall(params: {
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly category: "build" | "behavior";
}): Promise<DelegationValidationToolCall> {
  const execution = await runCommand(params.command, [...params.args], {
    cwd: params.cwd,
  });
  const commandText = [params.command, ...params.args].join(" ");
  const successPrefix =
    params.category === "behavior"
      ? "behavior test passed"
      : "build verification passed";
  const failurePrefix =
    params.category === "behavior"
      ? "behavior test failed"
      : "build verification failed";
  return {
    name: "system.bash",
    args: {
      command: commandText,
      cwd: params.cwd,
    },
    result: stableJson({
      stdout:
        execution.exitCode === 0
          ? [
              successPrefix,
              execution.stdout,
            ]
              .filter(Boolean)
              .join("\n")
          : [
              failurePrefix,
              execution.stdout,
            ]
              .filter(Boolean)
              .join("\n"),
      stderr: execution.stderr || "",
      exitCode: execution.exitCode,
      __agencVerification: {
        category: params.category,
        repoLocal: true,
        command: commandText,
        cwd: params.cwd,
      },
    }),
    isError: execution.exitCode !== 0,
  };
}

function resolveVerifiedCompletionState(params: {
  readonly toolCalls: readonly DelegationValidationToolCall[];
  readonly verificationContract: WorkflowVerificationContract;
  readonly verifierPerformed: boolean;
  readonly verifierPassed: boolean;
}): string {
  return resolveWorkflowCompletionState({
    stopReason: "completed",
    toolCalls: params.toolCalls.map((toolCall) => ({
      name: toolCall.name ?? "",
      args:
        toolCall.args && typeof toolCall.args === "object" && !Array.isArray(toolCall.args)
          ? (toolCall.args as Record<string, unknown>)
          : {},
      result: typeof toolCall.result === "string" ? toolCall.result : "",
      isError: toolCall.isError === true,
    })),
    verificationContract: params.verificationContract,
    verifier: {
      performed: params.verifierPerformed,
      overall: params.verifierPerformed
        ? params.verifierPassed
          ? "pass"
          : "fail"
        : "skipped",
    },
  });
}

function isSatisfiedTerminalCompletion(
  completionState: string,
): boolean {
  return resolveWorkflowDependencyState({
    completionState: completionState as WorkflowCompletionState,
  }).kind === "satisfied_terminal";
}

async function withTempRepo<T>(
  label: string,
  fn: (repoDir: string) => Promise<T>,
): Promise<T> {
  const repoDir = await mkdtemp(path.join(tmpdir(), `agenc-phase8-${label}-`));
  try {
    return await fn(repoDir);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
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
    expectedReplay: {
      taskPda: string;
      completionState?: string;
    };
  };
  const replay = new TrajectoryReplayEngine({ strictMode: true }).replay(trace);
  const task = replay.tasks[expected.expectedReplay.taskPda];
  const falseCompleted = task?.dependencyStateKind === "satisfied_terminal";
  const observedOutcome = task?.completionState ?? "missing";
  return {
    scenarioId: "shell_stub_false_completion_replay_gate",
    title: "Shell stub incident remains non-complete under deterministic replay",
    category: "shell_stub_replay",
    mandatory: true,
    executionMode: "replay",
    passed:
      replay.errors.length === 0 &&
      replay.warnings.length === 0 &&
      observedOutcome === (expected.expectedReplay.completionState ?? "blocked") &&
      falseCompleted === false,
    falseCompleted,
    observedOutcome,
    expectedOutcome: expected.expectedReplay.completionState ?? "blocked",
    notes: `errors=${replay.errors.length} warnings=${replay.warnings.length}`,
  };
}

async function runDeterministicImplementationScenario(): Promise<PipelineImplementationGateScenarioArtifact> {
  return withTempRepo("deterministic-false-completion", async (repoDir) => {
    await mkdir(path.join(repoDir, "src"), { recursive: true });
    await writeFile(path.join(repoDir, "package.json"), '{"type":"module"}\n', "utf8");
    const targetPath = path.join(repoDir, "src", "runner.js");
    const stubContent = [
      "export function runPipeline(input) {",
      "  // placeholder stub",
      "  return input;",
      "}",
      "",
    ].join("\n");
    await writeFile(targetPath, stubContent, "utf8");
    const toolCalls: DelegationValidationToolCall[] = [
      createWriteToolCall(targetPath, stubContent),
      await createVerificationToolCall({
        cwd: repoDir,
        command: process.execPath,
        args: ["--check", targetPath],
        category: "build",
      }),
    ];
    const verificationContract: WorkflowVerificationContract = {
      workspaceRoot: repoDir,
      targetArtifacts: [targetPath],
      acceptanceCriteria: [
        "Build succeeds cleanly.",
        "Runtime behavior works for real scenario inputs.",
      ],
      completionContract: {
        taskClass: "behavior_required",
        placeholdersAllowed: false,
        partialCompletionAllowed: false,
        placeholderTaxonomy: "implementation",
      },
    };
    const decision = validateRuntimeVerificationContract({
      verificationContract,
      output: "**Implemented** All shell runtime paths are done.",
      toolCalls,
    });
    const completionState = resolveVerifiedCompletionState({
      toolCalls,
      verificationContract,
      verifierPerformed: true,
      verifierPassed: decision?.ok === true,
    });
    return {
      scenarioId: "deterministic_impl_behavior_gap",
      title: "Deterministic implementation cannot complete on build-only success with behavioral gaps",
      category: "deterministic_false_completion",
      mandatory: true,
      executionMode: "temp_repo",
      passed: decision?.ok === false && !isSatisfiedTerminalCompletion(completionState),
      falseCompleted: isSatisfiedTerminalCompletion(completionState),
      observedOutcome: completionState,
      expectedOutcome: "partial",
      notes: decision?.diagnostic?.code ?? "missing_decision",
    };
  });
}

async function runValidScaffoldScenario(): Promise<PipelineImplementationGateScenarioArtifact> {
  return withTempRepo("valid-scaffold", async (repoDir) => {
    await mkdir(path.join(repoDir, "src"), { recursive: true });
    const targetPath = path.join(repoDir, "src", "feature.ts");
    const scaffoldContent = [
      "export interface FeatureConfig {",
      "  // scaffold placeholder",
      "}",
      "",
    ].join("\n");
    await writeFile(targetPath, scaffoldContent, "utf8");
    const toolCalls: DelegationValidationToolCall[] = [
      createWriteToolCall(targetPath, scaffoldContent),
    ];
    const verificationContract: WorkflowVerificationContract = {
      workspaceRoot: repoDir,
      targetArtifacts: [targetPath],
      acceptanceCriteria: ["Scaffold the module shape and leave clear placeholders."],
      completionContract: {
        taskClass: "scaffold_allowed",
        placeholdersAllowed: true,
        partialCompletionAllowed: true,
        placeholderTaxonomy: "scaffold",
      },
    };
    const decision = validateRuntimeVerificationContract({
      verificationContract,
      output: "Scaffolded the module with placeholders as requested.",
      toolCalls,
    });
    const completionState = resolveVerifiedCompletionState({
      toolCalls,
      verificationContract,
      verifierPerformed: true,
      verifierPassed: decision?.ok === true,
    });
    return {
      scenarioId: "valid_scaffold_placeholders",
      title: "Scaffold tasks may keep explicit placeholders when the contract allows them",
      category: "scaffold_placeholder",
      mandatory: true,
      executionMode: "temp_repo",
      passed: decision?.ok === true && isSatisfiedTerminalCompletion(completionState),
      falseCompleted: false,
      observedOutcome: completionState,
      expectedOutcome: "completed",
      notes: decision?.channels[1]?.message,
    };
  });
}

async function runImplementationRepairScenario(): Promise<PipelineImplementationGateScenarioArtifact> {
  return withTempRepo("implementation-repair", async (repoDir) => {
    await mkdir(path.join(repoDir, "src"), { recursive: true });
    const targetPath = path.join(repoDir, "src", "greeter.js");
    const scaffoldContent = "export const greet = () => 'TODO placeholder';\n";
    const finalContent = "export const greet = (name) => `hello ${name}`;\n";
    await writeFile(targetPath, scaffoldContent, "utf8");
    const toolCalls: DelegationValidationToolCall[] = [
      createReadToolCall(targetPath, scaffoldContent),
      createWriteToolCall(targetPath, finalContent),
      await createVerificationToolCall({
        cwd: repoDir,
        command: process.execPath,
        args: ["--check", targetPath],
        category: "build",
      }),
    ];
    const verificationContract: WorkflowVerificationContract = {
      workspaceRoot: repoDir,
      requiredSourceArtifacts: [targetPath],
      targetArtifacts: [targetPath],
      acceptanceCriteria: ["Build succeeds cleanly after replacing the scaffold placeholder."],
      completionContract: {
        taskClass: "build_required",
        placeholdersAllowed: false,
        partialCompletionAllowed: false,
        placeholderTaxonomy: "repair",
      },
    };
    const decision = validateRuntimeVerificationContract({
      verificationContract,
      output: "Implemented the real behavior and removed the scaffold placeholder.",
      toolCalls,
    });
    const completionState = resolveVerifiedCompletionState({
      toolCalls,
      verificationContract,
      verifierPerformed: true,
      verifierPassed: decision?.ok === true,
    });
    return {
      scenarioId: "implementation_replaces_scaffold",
      title: "Implementation repair replaces scaffold placeholders and remains executable",
      category: "implementation_repair",
      mandatory: true,
      executionMode: "temp_repo",
      passed: decision?.ok === true && isSatisfiedTerminalCompletion(completionState),
      falseCompleted: false,
      observedOutcome: completionState,
      expectedOutcome: "completed",
      notes: decision?.channels.find((channel) => channel.channel === "executable_outcome")?.message,
    };
  });
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
        falseCompleted: isSatisfiedTerminalCompletion(observedOutcome),
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
  const result = await executor.execute({
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
  const completionState = resolveVerifiedCompletionState({
    toolCalls: [],
    verificationContract,
    verifierPerformed: false,
    verifierPassed: false,
  });
  return {
    scenarioId: "degraded_provider_retry_without_false_completion",
    title: "Provider reroute does not turn missing implementation verification into completed",
    category: "degraded_provider_retry",
    mandatory: false,
    executionMode: "runtime",
    passed:
      result.usedFallback === true &&
      !isSatisfiedTerminalCompletion(completionState),
    falseCompleted: isSatisfiedTerminalCompletion(completionState),
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
  const completionState = resolveVerifiedCompletionState({
    toolCalls: [],
    verificationContract,
    verifierPerformed: false,
    verifierPassed: false,
  });
  const blocked = outcome.status === "deny" || outcome.status === "require_approval";
  return {
    scenarioId: "safety_gates_risky_incomplete_output",
    title: "Risky destructive follow-up is gated while completion is still incomplete",
    category: "safety_incomplete_output",
    mandatory: false,
    executionMode: "policy",
    passed: blocked && !isSatisfiedTerminalCompletion(completionState),
    falseCompleted: isSatisfiedTerminalCompletion(completionState),
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
    runDeterministicImplementationScenario(),
    runValidScaffoldScenario(),
    runImplementationRepairScenario(),
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
