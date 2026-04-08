import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SqliteBackend } from "../memory/sqlite/backend.js";
import type { LLMProvider, LLMResponse } from "../llm/types.js";
import { ChatExecutor } from "../llm/chat-executor.js";
import { executeChatToLegacyResult } from "../llm/execute-chat.js";
import { SessionManager, type SessionLookupParams } from "../gateway/session.js";
import {
  buildSessionStatefulOptions,
  hydrateWebSessionRuntimeState,
  persistWebSessionRuntimeState,
} from "../gateway/daemon-session-state.js";
import { runBackgroundRunQualitySuite } from "./background-run-quality-runner.js";

export type PipelineLongHorizonScenarioCategory =
  | "hundred_step"
  | "crash_resume"
  | "compact_continue"
  | "background_persistence";

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
      systemPrompt: "You are a benchmark assistant.",
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
