import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ApprovalRequest } from "../gateway/approvals.js";
import { PersistentWorkerMailbox } from "../gateway/persistent-worker-mailbox.js";
import {
  PersistentWorkerManager,
  type PreparedPersistentWorkerAssignment,
} from "../gateway/persistent-worker-manager.js";
import { SqliteBackend } from "../memory/sqlite/backend.js";
import type { LLMProvider, LLMResponse } from "../llm/types.js";
import { ChatExecutor } from "../llm/chat-executor.js";
import { executeChatToLegacyResult } from "../llm/execute-chat.js";
import { createPromptEnvelope } from "../llm/prompt-envelope.js";
import { SessionManager, type SessionLookupParams } from "../gateway/session.js";
import {
  buildSessionStatefulOptions,
  hydrateWebSessionRuntimeState,
  persistWebSessionRuntimeState,
} from "../gateway/daemon-session-state.js";
import { TaskStore, type Task } from "../tools/system/task-tracker.js";
import { runBackgroundRunQualitySuite } from "./background-run-quality-runner.js";

export type PipelineLongHorizonScenarioCategory =
  | "hundred_step"
  | "crash_resume"
  | "compact_continue"
  | "background_persistence"
  | "multi_worker_completion";

export interface PipelineLongHorizonScenarioArtifact {
  readonly scenarioId: string;
  readonly title: string;
  readonly category: PipelineLongHorizonScenarioCategory;
  readonly passed: boolean;
  readonly stepCount: number;
  readonly resumed: boolean;
  readonly compacted: boolean;
  readonly persisted: boolean;
  readonly restartRecoverySuccess: boolean;
  readonly notes?: string;
}

export interface PipelineLongHorizonArtifact {
  readonly scenarioCount: number;
  readonly passingScenarios: number;
  readonly passRate: number;
  readonly hundredStepRuns: number;
  readonly crashResumeRuns: number;
  readonly compactContinueRuns: number;
  readonly backgroundPersistenceRuns: number;
  readonly restartRecoverySuccessRate: number;
  readonly compactionContinuationRate: number;
  readonly backgroundPersistenceRate: number;
  readonly scenarios: readonly PipelineLongHorizonScenarioArtifact[];
}

export interface PipelineLongHorizonRunnerConfig {
  readonly now?: () => number;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

function createLookupParams(): SessionLookupParams {
  return {
    channel: "webchat",
    senderId: "long-horizon-user",
    scope: "dm",
    workspaceId: "long-horizon-workspace",
  };
}

function createMockProvider(): LLMProvider {
  const response: LLMResponse = {
    content: "ok",
    toolCalls: [],
    usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 },
    model: "long-horizon-benchmark-model",
    finishReason: "stop",
  };
  return {
    name: "long-horizon-benchmark",
    chat: async () => response,
    chatStream: async () => response,
    healthCheck: async () => true,
  };
}

function buildPreparedAssignment(params: {
  readonly task: string;
  readonly verifierRequired?: boolean;
}): PreparedPersistentWorkerAssignment {
  return {
    request: {
      task: params.task,
      tools: ["system.readFile"],
      executionContext: {
        allowedTools: ["system.readFile"],
        allowedReadRoots: ["/tmp/project"],
        allowedWriteRoots: ["/tmp/project"],
      },
    },
    objective: params.task,
    admittedInput: {
      task: params.task,
      tools: ["system.readFile"],
      executionContext: {
        allowedTools: ["system.readFile"],
        allowedReadRoots: ["/tmp/project"],
        allowedWriteRoots: ["/tmp/project"],
      },
      delegationAdmission: {
        isolationReason: "bounded phase ownership",
        ownedArtifacts: ["src/main.c"],
      },
    },
    allowedTools: ["system.readFile"],
    workingDirectory: "/tmp/project",
    executionContextFingerprint:
      '{"allowedReadRoots":["/tmp/project"],"allowedTools":["system.readFile"],"allowedWriteRoots":["/tmp/project"]}',
    executionEnvelopeFingerprint: `env:${params.task}`,
    ...(params.verifierRequired
      ? {
          verifierRequirement: {
            required: true,
            profiles: ["generic"],
            probeCategories: ["build"],
            mutationPolicy: "read_only_workspace" as const,
            allowTempArtifacts: false,
            bootstrapSource: "disabled" as const,
            rationale: ["long-horizon worker verification"],
          },
        }
      : {}),
  };
}

async function waitForTaskTerminal(
  store: TaskStore,
  listId: string,
  taskId: string,
): Promise<Task> {
  const task = await store.waitForTask(listId, taskId, {
    timeoutMs: 5_000,
    until: "terminal",
  });
  if (!task) {
    throw new Error(`Task ${taskId} was not found`);
  }
  if (
    task.status !== "completed" &&
    task.status !== "failed" &&
    task.status !== "cancelled"
  ) {
    throw new Error(`Task ${taskId} did not reach terminal status`);
  }
  return task;
}

async function waitForPermissionRequest(
  mailbox: PersistentWorkerMailbox,
  parentSessionId: string,
  workerId: string,
): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const message = (await mailbox.listMessages({
      parentSessionId,
      workerId,
      direction: "worker_to_parent",
    })).find(
      (entry) =>
        entry.type === "permission_request" &&
        entry.status !== "handled",
    );
    if (message) {
      return message.messageId;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for permission request for ${workerId}`);
}

async function buildCompactionScenario(params: {
  readonly category: "hundred_step" | "compact_continue";
}): Promise<PipelineLongHorizonScenarioArtifact> {
  const tempDir = await mkdtemp(path.join(tmpdir(), `agenc-${params.category}-`));
  const dbPath = path.join(tempDir, "long-horizon.sqlite");
  const backend = new SqliteBackend({ dbPath });
  try {
    const manager = new SessionManager(
      {
        scope: "per-channel-peer",
        reset: { mode: "never" },
        compaction: "summarize",
        maxHistoryLength: 50,
      },
      {
        summarizer: async () =>
          "PLAN.md remains canonical and the repo artifacts are still grounded.",
      },
    );
    const session = manager.getOrCreate(createLookupParams());
    const turns = params.category === "hundred_step" ? 120 : 72;
    for (let index = 0; index < turns; index += 1) {
      session.history.push(
        {
          role: "user",
          content: `Turn ${index}: keep PLAN.md and src/main.c aligned.`,
        },
        {
          role: "assistant",
          content: `Acknowledged turn ${index}.`,
        },
        {
          role: "tool",
          toolName: "system.readFile",
          content: `PLAN.md checkpoint ${index} for src/main.c and parser.test.ts`,
        },
      );
      if ((index + 1) % 24 === 0) {
        await manager.compact(session.id);
      }
    }
    await persistWebSessionRuntimeState(backend, "long-horizon-web-session", session);
    await backend.flush();
    manager.destroy(session.id);

    const resumed = manager.getOrCreate(createLookupParams());
    resumed.history = [...session.history];
    await hydrateWebSessionRuntimeState(
      backend,
      "long-horizon-web-session",
      resumed,
    );
    const stateful = buildSessionStatefulOptions(resumed);
    const provider = createMockProvider();
    const executor = new ChatExecutor({ providers: [provider] });
    await executeChatToLegacyResult(executor, {
      message: {
        id: "long-horizon-msg",
        channel: "webchat",
        senderId: "long-horizon-user",
        senderName: "Long Horizon",
        sessionId: "long-horizon-session",
        content: "Continue from compacted artifacts only.",
        timestamp: Date.now(),
        scope: "dm",
      },
      history: resumed.history,
      promptEnvelope: createPromptEnvelope("You are a benchmark assistant."),
      sessionId: "long-horizon-session",
      stateful,
    });
    const artifactRefs = stateful?.artifactContext?.artifactRefs.length ?? 0;
    return {
      scenarioId:
        params.category === "hundred_step"
          ? "hundred_step_artifact_compaction"
          : "compact_and_continue",
      title:
        params.category === "hundred_step"
          ? "Maintain grounded artifact context across 100+ steps"
          : "Compact a long run and continue correctly after resume",
      category: params.category,
      passed: artifactRefs > 0,
      stepCount: turns,
      resumed: true,
      compacted: true,
      persisted: true,
      restartRecoverySuccess: artifactRefs > 0,
      notes: `artifact refs=${artifactRefs}`,
    };
  } finally {
    await backend.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runMultiWorkerCompletionScenario(): Promise<PipelineLongHorizonScenarioArtifact> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "agenc-multi-worker-"));
  const dbPath = path.join(tempDir, "multi-worker.sqlite");
  const backend = new SqliteBackend({ dbPath });
  try {
    const taskStore = new TaskStore({ memoryBackend: backend });
    const mailbox = new PersistentWorkerMailbox({ memoryBackend: backend });
    const sessions = new Map<
      string,
      {
        readonly result: {
          readonly sessionId: string;
          readonly output: string;
          readonly success: boolean;
          readonly durationMs: number;
          readonly toolCalls: readonly [];
          readonly completionState: "completed";
          readonly stopReason: "completed";
          readonly verifierSnapshot?: {
            readonly performed: true;
            readonly overall: "pass";
            readonly summary: string;
          };
        };
        readonly approvalRequestId?: string;
        approved: boolean;
      }
    >();
    const pendingRequests: ApprovalRequest[] = [];
    let sessionCounter = 0;
    const fakeSubAgentManager = {
      spawn: async (config: { parentSessionId: string; task: string; verifierRequirement?: { required: boolean } }) => {
        sessionCounter += 1;
        const sessionId = `subagent:long-horizon:${sessionCounter}`;
        const requiresApproval = config.task.includes("approval");
        const requiresVerifier = config.verifierRequirement?.required === true;
        const approvalRequestId = requiresApproval
          ? `approval:${sessionCounter}`
          : undefined;
        if (approvalRequestId) {
          pendingRequests.push({
            id: approvalRequestId,
            toolName: "system.writeFile",
            args: {},
            sessionId: config.parentSessionId,
            parentSessionId: config.parentSessionId,
            subagentSessionId: sessionId,
            message: "Approve worker follow-up verification step.",
            createdAt: Date.now(),
            deadlineAt: Date.now() + 30_000,
            allowDelegatedResolution: true,
            rule: { tool: "system.writeFile" },
          });
        }
        sessions.set(sessionId, {
          approved: !requiresApproval,
          ...(approvalRequestId ? { approvalRequestId } : {}),
          result: {
            sessionId,
            output: `Completed ${config.task}.`,
            success: true,
            durationMs: 25,
            toolCalls: [],
            completionState: "completed",
            stopReason: "completed",
            ...(requiresVerifier
              ? {
                  verifierSnapshot: {
                    performed: true,
                    overall: "pass" as const,
                    summary: "Worker verifier passed.",
                  },
                }
              : {}),
          },
        });
        return sessionId;
      },
      getResult: (sessionId: string) => {
        const session = sessions.get(sessionId);
        if (!session || !session.approved) {
          return undefined;
        }
        return session.result;
      },
      getInfo: (sessionId: string) => {
        const session = sessions.get(sessionId);
        if (!session) {
          return undefined;
        }
        return {
          status: session.approved ? "completed" : "running",
        };
      },
      cancel: (sessionId: string) => {
        const session = sessions.get(sessionId);
        if (session) {
          session.approved = true;
        }
      },
    };
    const approvalEngine = {
      getPending: () => [...pendingRequests],
      resolve: async (requestId: string) => {
        const requestIndex = pendingRequests.findIndex(
          (entry) => entry.id === requestId,
        );
        if (requestIndex < 0) {
          return false;
        }
        pendingRequests.splice(requestIndex, 1);
        for (const session of sessions.values()) {
          if (session.approvalRequestId === requestId) {
            session.approved = true;
          }
        }
        return true;
      },
    };
    const workerManager = new PersistentWorkerManager({
      memoryBackend: backend,
      taskStore,
      subAgentManager: fakeSubAgentManager as any,
      mailbox,
      approvalEngine: approvalEngine as any,
    });

    const workerA = await workerManager.createWorker({
      parentSessionId: "session-multi-worker",
      workerName: "builder-a",
    });
    const workerB = await workerManager.createWorker({
      parentSessionId: "session-multi-worker",
      workerName: "builder-b",
    });

    const first = await workerManager.assignToWorker({
      parentSessionId: "session-multi-worker",
      workerId: workerA.workerId,
      assignment: buildPreparedAssignment({
        task: "implement parser cleanup",
      }),
    });
    const second = await workerManager.assignToWorker({
      parentSessionId: "session-multi-worker",
      workerId: workerB.workerId,
      assignment: buildPreparedAssignment({
        task: "run approval gated verification",
        verifierRequired: true,
      }),
    });

    await waitForTaskTerminal(taskStore, "session-multi-worker", first.task.id);
    const followUp = await workerManager.assignToWorker({
      parentSessionId: "session-multi-worker",
      workerId: workerA.workerId,
      assignment: buildPreparedAssignment({
        task: "follow up parser cleanup",
      }),
    });

    const permissionMessageId = await waitForPermissionRequest(
      mailbox,
      "session-multi-worker",
      workerB.workerId,
    );
    await workerManager.respondToPermissionRequest({
      parentSessionId: "session-multi-worker",
      messageId: permissionMessageId,
      disposition: "yes",
      approvedBy: "phase12",
    });

    await Promise.all([
      waitForTaskTerminal(taskStore, "session-multi-worker", second.task.id),
      waitForTaskTerminal(taskStore, "session-multi-worker", followUp.task.id),
    ]);

    const verifierOutput = await taskStore.readTaskOutput(
      "session-multi-worker",
      second.task.id,
      { includeEvents: true },
    );
    const followUpOutput = await taskStore.readTaskOutput(
      "session-multi-worker",
      followUp.task.id,
      { includeEvents: true },
    );
    const messages = await mailbox.listMessages({
      parentSessionId: "session-multi-worker",
    });
    const workers = await workerManager.listWorkers("session-multi-worker");

    await workerManager.stopWorker({
      parentSessionId: "session-multi-worker",
      workerIdOrSessionId: workerA.workerId,
    });
    await workerManager.stopWorker({
      parentSessionId: "session-multi-worker",
      workerIdOrSessionId: workerB.workerId,
    });

    const permissionHandled = messages.some(
      (message) =>
        message.type === "permission_request" &&
        message.messageId === permissionMessageId &&
        (message.status === "acknowledged" || message.status === "handled"),
    );
    return {
      scenarioId: "multi_worker_task_contract_completion",
      title:
        "Multi-worker completion depends on durable task output and verifier evidence",
      category: "multi_worker_completion",
      passed:
        workers.length === 2 &&
        verifierOutput?.task.status === "completed" &&
        verifierOutput.verifierVerdict?.overall === "pass" &&
        verifierOutput.runtimeResult?.completionState === "completed" &&
        followUpOutput?.task.status === "completed" &&
        permissionHandled &&
        messages.some((message) => message.type === "verifier_result"),
      stepCount: 3,
      resumed: false,
      compacted: false,
      persisted: true,
      restartRecoverySuccess:
        verifierOutput?.task.status === "completed" &&
        followUpOutput?.task.status === "completed",
      notes: `messages=${messages.length} workers=${workers.length}`,
    };
  } finally {
    await backend.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function runLongHorizonSuite(
  config: PipelineLongHorizonRunnerConfig = {},
): Promise<PipelineLongHorizonArtifact> {
  const now = config.now ?? (() => Date.now());
  const background = await runBackgroundRunQualitySuite({
    now,
    runId: `long-horizon-background-${now()}`,
  });
  const crashResume = background.scenarios.find(
    (scenario) => scenario.scenarioId === "restart_recovery",
  );
  const persistence = background.scenarios.find(
    (scenario) => scenario.scenarioId === "multi_cycle_soak",
  );
  const scenarios: PipelineLongHorizonScenarioArtifact[] = [
    await buildCompactionScenario({ category: "hundred_step" }),
    {
      scenarioId: "crash_mid_run_resume",
      title: "Crash mid-run and resume from durable background-run state",
      category: "crash_resume",
      passed: (crashResume?.ok ?? false) && (crashResume?.recoverySucceeded ?? false),
      stepCount: crashResume?.eventCount ?? 0,
      resumed: true,
      compacted: false,
      persisted: true,
      restartRecoverySuccess: crashResume?.recoverySucceeded ?? false,
      notes: crashResume?.notes,
    },
    await buildCompactionScenario({ category: "compact_continue" }),
    {
      scenarioId: "background_run_persistence",
      title: "Persist background-run state across multiple supervision cycles",
      category: "background_persistence",
      passed: persistence?.ok ?? false,
      stepCount: persistence?.eventCount ?? 0,
      resumed: false,
      compacted: false,
      persisted: true,
      restartRecoverySuccess: persistence?.recoverySucceeded ?? false,
      notes: persistence?.notes,
    },
    await runMultiWorkerCompletionScenario(),
  ];
  const passingScenarios = scenarios.filter((scenario) => scenario.passed).length;
  return {
    scenarioCount: scenarios.length,
    passingScenarios,
    passRate: ratio(passingScenarios, scenarios.length),
    hundredStepRuns: scenarios.filter((scenario) => scenario.category === "hundred_step").length,
    crashResumeRuns: scenarios.filter((scenario) => scenario.category === "crash_resume").length,
    compactContinueRuns: scenarios.filter((scenario) => scenario.category === "compact_continue").length,
    backgroundPersistenceRuns: scenarios.filter((scenario) => scenario.category === "background_persistence").length,
    restartRecoverySuccessRate: ratio(
      scenarios.filter((scenario) => scenario.restartRecoverySuccess).length,
      scenarios.length,
    ),
    compactionContinuationRate: ratio(
      scenarios.filter(
        (scenario) =>
          (scenario.category === "hundred_step" ||
            scenario.category === "compact_continue") &&
          scenario.passed,
      ).length,
      scenarios.filter(
        (scenario) =>
          scenario.category === "hundred_step" ||
          scenario.category === "compact_continue",
      ).length,
    ),
    backgroundPersistenceRate: ratio(
      scenarios.filter(
        (scenario) => scenario.category === "background_persistence" && scenario.passed,
      ).length,
      scenarios.filter(
        (scenario) => scenario.category === "background_persistence",
      ).length,
    ),
    scenarios,
  };
}
