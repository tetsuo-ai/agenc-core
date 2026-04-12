/**
 * Executable chaos / fault-injection suite for runtime hardening gates.
 *
 * @module
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatExecutorResult } from "../llm/chat-executor-types.js";
import { callWithFallback } from "../llm/chat-executor-fallback.js";
import { DEFAULT_LLM_RETRY_POLICY_MATRIX } from "../llm/policy.js";
import { createSyntheticDialogueTurnExecutionContract } from "../llm/turn-execution-contract.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  StreamProgressCallback,
  ToolHandler,
} from "../llm/types.js";
import { InMemoryBackend } from "../memory/in-memory/backend.js";
import { SqliteBackend } from "../memory/sqlite/backend.js";
import type { ApprovalRule } from "../gateway/approvals.js";
import { ApprovalEngine } from "../gateway/approvals.js";
import {
  BackgroundRunSupervisor,
} from "../gateway/background-run-supervisor.js";
import { BackgroundRunStore } from "../gateway/background-run-store.js";
import { createSessionToolHandler } from "../gateway/tool-handler-factory.js";
import type { ControlResponse } from "../gateway/types.js";
import { RuntimeFaultInjector } from "./fault-injection.js";
import { RuntimeIncidentDiagnostics } from "../telemetry/incident-diagnostics.js";

export type ChaosScenarioCategory =
  | "provider_timeout"
  | "tool_timeout"
  | "persistence_failure"
  | "approval_store_failure"
  | "child_run_crash"
  | "daemon_restart";

export interface ChaosScenarioArtifact {
  readonly scenarioId: string;
  readonly title: string;
  readonly category: ChaosScenarioCategory;
  readonly passed: boolean;
  readonly runtimeMode: "healthy" | "degraded" | "safe_mode";
  readonly incidentCodes: readonly string[];
  readonly resumed: boolean;
  readonly safeModeEngaged: boolean;
  readonly notes?: string;
}

export interface ChaosSuiteArtifact {
  readonly scenarioCount: number;
  readonly passingScenarios: number;
  readonly passRate: number;
  readonly providerTimeoutRecoveryRate: number;
  readonly toolTimeoutContainmentRate: number;
  readonly persistenceSafeModeRate: number;
  readonly approvalStoreSafeModeRate: number;
  readonly childRunCrashContainmentRate: number;
  readonly daemonRestartRecoveryRate: number;
  readonly scenarios: readonly ChaosScenarioArtifact[];
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function makeProvider(
  name: string,
  responseText = "ok",
): LLMProvider {
  const chat = async (
    _messages: LLMMessage[],
    _options?: LLMChatOptions,
  ) => ({
    content: responseText,
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    model: `${name}-model`,
    finishReason: "stop" as const,
  });
  return {
    name,
    chat,
    chatStream: async (
      messages: LLMMessage[],
      onChunk: StreamProgressCallback,
      options?: LLMChatOptions,
    ) => {
      const response = await chat(messages, options);
      onChunk({ content: response.content, done: true });
      return response;
    },
    healthCheck: async () => true,
  };
}

function makeChatExecutor(
  resultFactory: () => Promise<ChatExecutorResult>,
) {
  return {
    execute: resultFactory,
  } as unknown as import("../llm/chat-executor.js").ChatExecutor;
}

function makeChatResult(
  overrides: Partial<ChatExecutorResult> = {},
): ChatExecutorResult {
  return {
    content: "working",
    provider: "chaos-provider",
    model: "chaos-model",
    usedFallback: false,
    toolCalls: [],
    tokenUsage: { promptTokens: 5, completionTokens: 4, totalTokens: 9 },
    callUsage: [],
    durationMs: 10,
    compacted: false,
    stopReason: "completed",
    completionState: "completed",
    turnExecutionContract: createSyntheticDialogueTurnExecutionContract(),
    ...overrides,
  };
}

function makeContract() {
  return {
    domain: "generic" as const,
    kind: "finite" as const,
    successCriteria: ["Collect deterministic evidence."],
    completionCriteria: ["Observed terminal evidence."],
    blockedCriteria: ["Runtime prerequisites are missing."],
    nextCheckMs: 1_000,
    heartbeatMs: 5_000,
    requiresUserStop: false,
    managedProcessPolicy: { mode: "none" as const },
  };
}

function makeSupervisor(params: {
  incidentDiagnostics: RuntimeIncidentDiagnostics;
  faultInjector?: RuntimeFaultInjector;
  store?: BackgroundRunStore;
  sqlitePath?: string;
  actorResult?: () => Promise<ChatExecutorResult>;
}) {
  const memoryBackend =
    params.sqlitePath
      ? new SqliteBackend({ dbPath: params.sqlitePath })
      : new InMemoryBackend();
  const runStore =
    params.store ??
    new BackgroundRunStore({
      memoryBackend,
    });
  const supervisor = new BackgroundRunSupervisor({
    chatExecutor: makeChatExecutor(
      params.actorResult ??
        (async () => makeChatResult({ stopReason: "completed" })),
    ),
    supervisorLlm: makeProvider("chaos-supervisor", "supervisor"),
    getSystemPrompt: () => "chaos test",
    createToolHandler: () =>
      (async () => JSON.stringify({ ok: true })) as ToolHandler,
    publishUpdate: async () => {},
    runStore,
    incidentDiagnostics: params.incidentDiagnostics,
    faultInjector: params.faultInjector,
  });
  return { supervisor, runStore, memoryBackend };
}

async function runProviderTimeoutScenario(): Promise<ChaosScenarioArtifact> {
  const diagnostics = new RuntimeIncidentDiagnostics();
  const injector = new RuntimeFaultInjector({
    enabled: true,
    rules: [
      {
        point: "provider_timeout",
        provider: "primary",
        triggerAt: 1,
        maxTriggers: 10,
      },
    ],
  });
  const result = await callWithFallback(
    {
      providers: [makeProvider("primary"), makeProvider("secondary", "fallback")],
      cooldowns: new Map(),
      promptBudget: {
        contextWindowTokens: 1024,
        maxOutputTokens: 256,
        safetyMarginTokens: 128,
        hardMaxPromptChars: 2_048,
      },
      retryPolicyMatrix: DEFAULT_LLM_RETRY_POLICY_MATRIX,
      cooldownMs: 100,
      maxCooldownMs: 1_000,
    },
    [{ role: "user", content: "recover" }],
    undefined,
    undefined,
    { faultInjector: injector },
  );
  diagnostics.report({
    domain: "provider",
    mode: "degraded",
    severity: "warn",
    code: "provider_timeout",
    message: "Injected provider timeout was recovered through fallback.",
  });
  return {
    scenarioId: "provider-timeout-recovery",
    title: "provider timeout falls back cleanly",
    category: "provider_timeout",
    passed: result.providerName === "secondary",
    runtimeMode: diagnostics.getSnapshot().runtimeMode,
    incidentCodes: diagnostics.getSnapshot().recentIncidents.map((entry) => entry.code),
    resumed: result.usedFallback,
    safeModeEngaged: false,
    notes: `provider=${result.providerName}`,
  };
}

async function runToolTimeoutScenario(): Promise<ChaosScenarioArtifact> {
  const diagnostics = new RuntimeIncidentDiagnostics();
  const injector = new RuntimeFaultInjector({
    enabled: true,
    rules: [
      {
        point: "tool_timeout",
        operation: "system.bash",
      },
    ],
  });
  const handler = createSessionToolHandler({
    sessionId: "chaos-tool-timeout",
    routerId: "chaos-tool-timeout",
    baseHandler: (async () => JSON.stringify({ ok: true })) as ToolHandler,
    send: (_msg: ControlResponse) => {},
    incidentDiagnostics: diagnostics,
    faultInjector: injector,
  });

  let threw = false;
  try {
    await handler("system.bash", { command: "echo ok" });
  } catch {
    threw = true;
  }
  const snapshot = diagnostics.getSnapshot();
  return {
    scenarioId: "tool-timeout-containment",
    title: "tool timeout is contained and diagnosed",
    category: "tool_timeout",
    passed:
      threw &&
      snapshot.runtimeMode === "degraded" &&
      snapshot.recentIncidents.some((entry) => entry.code === "tool_timeout"),
    runtimeMode: snapshot.runtimeMode,
    incidentCodes: snapshot.recentIncidents.map((entry) => entry.code),
    resumed: false,
    safeModeEngaged: false,
  };
}

async function runApprovalStoreFailureScenario(): Promise<ChaosScenarioArtifact> {
  const diagnostics = new RuntimeIncidentDiagnostics();
  const injector = new RuntimeFaultInjector({
    enabled: true,
    rules: [
      {
        point: "approval_store_failure",
        operation: "create_request",
      },
    ],
  });
  const approvalRule: ApprovalRule = {
    tool: "system.delete",
    description: "delete requires approval",
  };
  const handler = createSessionToolHandler({
    sessionId: "chaos-approval-store",
    routerId: "chaos-approval-store",
    baseHandler: (async () => JSON.stringify({ ok: true })) as ToolHandler,
    send: (_msg: ControlResponse) => {},
    approvalEngine: new ApprovalEngine({ rules: [approvalRule] }),
    incidentDiagnostics: diagnostics,
    faultInjector: injector,
  });
  const result = await handler("system.delete", { path: "tmp.txt" });
  const snapshot = diagnostics.getSnapshot();
  return {
    scenarioId: "approval-store-failure",
    title: "approval-store failure fails closed into safe mode",
    category: "approval_store_failure",
    passed:
      result.includes("Approval subsystem is unavailable") &&
      snapshot.runtimeMode === "safe_mode",
    runtimeMode: snapshot.runtimeMode,
    incidentCodes: snapshot.recentIncidents.map((entry) => entry.code),
    resumed: false,
    safeModeEngaged: snapshot.runtimeMode === "safe_mode",
  };
}

async function runPersistenceFailureScenario(): Promise<ChaosScenarioArtifact> {
  const diagnostics = new RuntimeIncidentDiagnostics();
  const { supervisor, memoryBackend } = makeSupervisor({
    incidentDiagnostics: diagnostics,
    faultInjector: new RuntimeFaultInjector({
      enabled: true,
      rules: [{ point: "persistence_failure", operation: "persist_run" }],
    }),
  });
  try {
    let failed = false;
    try {
      await supervisor.startRun({
        sessionId: "chaos-persistence",
        objective: "persist safely",
        options: { silent: true, contract: makeContract() },
      });
    } catch {
      failed = true;
    }
    const snapshot = diagnostics.getSnapshot();
    return {
      scenarioId: "persistence-failure-safe-mode",
      title: "persistence failure enters safe mode",
      category: "persistence_failure",
      passed:
        failed &&
        snapshot.runtimeMode === "safe_mode" &&
        snapshot.recentIncidents.some((entry) => entry.code === "persistence_failure"),
      runtimeMode: snapshot.runtimeMode,
      incidentCodes: snapshot.recentIncidents.map((entry) => entry.code),
      resumed: false,
      safeModeEngaged: snapshot.runtimeMode === "safe_mode",
    };
  } finally {
    await supervisor.shutdown();
    await memoryBackend.close();
  }
}

async function runChildRunCrashScenario(): Promise<ChaosScenarioArtifact> {
  const diagnostics = new RuntimeIncidentDiagnostics();
  const { supervisor, runStore, memoryBackend } = makeSupervisor({
    incidentDiagnostics: diagnostics,
    faultInjector: new RuntimeFaultInjector({
      enabled: true,
      rules: [{ point: "child_run_crash", operation: "execute_cycle" }],
    }),
  });
  try {
    await (supervisor as unknown as { heartbeatWorker(): Promise<void> }).heartbeatWorker();
    await supervisor.startRun({
      sessionId: "chaos-child-crash",
      objective: "recover child crash",
      options: { silent: true, contract: makeContract() },
    });
    const claim = await runStore.claimDispatchForWorker({
      workerId: (supervisor as unknown as { instanceId: string }).instanceId,
      pools: ["generic"],
      now: Date.now(),
    });
    if (claim.claimed && claim.item) {
      await (supervisor as unknown as {
        handleClaimedDispatch(item: unknown): Promise<void>;
      }).handleClaimedDispatch(claim.item);
    }
    const snapshot = diagnostics.getSnapshot();
    return {
      scenarioId: "child-run-crash-contained",
      title: "child run crash is contained and diagnosed",
      category: "child_run_crash",
      passed:
        snapshot.runtimeMode === "degraded" &&
        snapshot.recentIncidents.some((entry) => entry.code === "child_run_failure"),
      runtimeMode: snapshot.runtimeMode,
      incidentCodes: snapshot.recentIncidents.map((entry) => entry.code),
      resumed: false,
      safeModeEngaged: false,
    };
  } finally {
    await supervisor.shutdown();
    await memoryBackend.close();
  }
}

async function runDaemonRestartScenario(): Promise<ChaosScenarioArtifact> {
  const diagnostics = new RuntimeIncidentDiagnostics();
  const tempRoot = await mkdtemp(join(tmpdir(), "agenc-chaos-"));
  const sqlitePath = join(tempRoot, "runtime.db");
  let supervisor:
    | BackgroundRunSupervisor
    | undefined;
  let primaryBackend:
    | InMemoryBackend
    | SqliteBackend
    | undefined;
  let recovering:
    | BackgroundRunSupervisor
    | undefined;
  let recoveringBackend:
    | InMemoryBackend
    | SqliteBackend
    | undefined;
  try {
    const primary = makeSupervisor({
      incidentDiagnostics: diagnostics,
      sqlitePath,
      actorResult: async () => makeChatResult({ stopReason: "completed" }),
    });
    supervisor = primary.supervisor;
    primaryBackend = primary.memoryBackend;
    await supervisor.startRun({
      sessionId: "chaos-restart",
      objective: "survive restart",
      options: { silent: true, contract: makeContract() },
    });
    const recoveringBundle = makeSupervisor({
      incidentDiagnostics: diagnostics,
      sqlitePath,
      faultInjector: new RuntimeFaultInjector({
        enabled: true,
        rules: [{ point: "daemon_restart", operation: "recover_runs" }],
      }),
    });
    recovering = recoveringBundle.supervisor;
    recoveringBackend = recoveringBundle.memoryBackend;
    let failed = false;
    try {
      await recovering.recoverRuns();
    } catch {
      failed = true;
    }
    const snapshot = diagnostics.getSnapshot();
    return {
      scenarioId: "daemon-restart-diagnostics",
      title: "daemon restart failure is diagnosed cleanly",
      category: "daemon_restart",
      passed:
        failed &&
        snapshot.runtimeMode === "degraded" &&
        snapshot.recentIncidents.some((entry) => entry.code === "daemon_restart_failure"),
      runtimeMode: snapshot.runtimeMode,
      incidentCodes: snapshot.recentIncidents.map((entry) => entry.code),
      resumed: false,
      safeModeEngaged: false,
    };
  } finally {
    await recovering?.shutdown();
    await recoveringBackend?.close();
    await supervisor?.shutdown();
    await primaryBackend?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function runChaosSuite(): Promise<ChaosSuiteArtifact> {
  const scenarios = [
    await runProviderTimeoutScenario(),
    await runToolTimeoutScenario(),
    await runPersistenceFailureScenario(),
    await runApprovalStoreFailureScenario(),
    await runChildRunCrashScenario(),
    await runDaemonRestartScenario(),
  ] as const;
  const passingScenarios = scenarios.filter((entry) => entry.passed).length;
  return {
    scenarioCount: scenarios.length,
    passingScenarios,
    passRate: safeRatio(passingScenarios, scenarios.length),
    providerTimeoutRecoveryRate: safeRatio(
      scenarios.filter(
        (entry) => entry.category === "provider_timeout" && entry.passed,
      ).length,
      scenarios.filter((entry) => entry.category === "provider_timeout").length,
    ),
    toolTimeoutContainmentRate: safeRatio(
      scenarios.filter(
        (entry) => entry.category === "tool_timeout" && entry.passed,
      ).length,
      scenarios.filter((entry) => entry.category === "tool_timeout").length,
    ),
    persistenceSafeModeRate: safeRatio(
      scenarios.filter(
        (entry) => entry.category === "persistence_failure" && entry.safeModeEngaged,
      ).length,
      scenarios.filter((entry) => entry.category === "persistence_failure").length,
    ),
    approvalStoreSafeModeRate: safeRatio(
      scenarios.filter(
        (entry) => entry.category === "approval_store_failure" && entry.safeModeEngaged,
      ).length,
      scenarios.filter((entry) => entry.category === "approval_store_failure").length,
    ),
    childRunCrashContainmentRate: safeRatio(
      scenarios.filter(
        (entry) => entry.category === "child_run_crash" && entry.passed,
      ).length,
      scenarios.filter((entry) => entry.category === "child_run_crash").length,
    ),
    daemonRestartRecoveryRate: safeRatio(
      scenarios.filter(
        (entry) => entry.category === "daemon_restart" && entry.passed,
      ).length,
      scenarios.filter((entry) => entry.category === "daemon_restart").length,
    ),
    scenarios,
  };
}
