/**
 * Phase 9 pipeline-quality benchmark runner.
 *
 * @module
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { GatewayMessage } from "../gateway/message.js";
import {
  buildSessionStatefulOptions,
} from "../gateway/daemon-session-state.js";
import { SessionManager } from "../gateway/session.js";
import {
  ChatExecutor,
  type ChatExecutorConfig,
} from "../llm/chat-executor.js";
import { LLMMessageValidationError } from "../llm/errors.js";
import {
  validateToolTurnSequence,
  type LLMMessage,
  type LLMProvider,
  type LLMChatOptions,
  type LLMResponse,
  type StreamProgressCallback,
} from "../llm/index.js";
import { parseTrajectoryTrace } from "./types.js";
import { TrajectoryReplayEngine, evaluateReplayParity } from "./replay.js";
import { runPipelineHttpRepro } from "./pipeline-http-repro.js";
import { runDelegationBenchmarkSuite } from "./delegation-benchmark.js";
import { runLiveCodingSuite } from "./live-coding-runner.js";
import { runSafetySuite } from "./safety-suite.js";
import { runLongHorizonSuite } from "./long-horizon-suite.js";
import { runChaosSuite } from "./chaos-suite.js";
import { runImplementationGateSuite } from "./implementation-gate-suite.js";
import { runDelegatedWorkspaceGateSuite } from "./delegated-workspace-gate-suite.js";
import {
  ORCHESTRATION_EXPECTATION_SCHEMA_VERSION,
  ORCHESTRATION_REGRESSION_SCENARIOS,
  type OrchestrationRegressionExpectation,
} from "./orchestration-scenarios.js";
import {
  buildPipelineQualityArtifact,
  type PipelineDesktopRunArtifact,
  type PipelineOrchestrationScenarioInput,
  type PipelineOfflineReplayFixtureArtifact,
  type PipelineQualityArtifact,
} from "./pipeline-quality.js";
import {
  computeEconomicsScorecard,
  type EconomicsScenarioRecord,
} from "./economics-scorecard.js";
import { buildRuntimeEconomicsPolicy } from "../llm/run-budget.js";
// Cut 1.2: assessDelegationDecision deleted; this eval scenario was
// exercising the deleted utility-scoring path. The negative-economics
// branch is now handled by gateway/delegation-admission.ts at the
// admission layer rather than a utility-score post-check.

const DEFAULT_CONTEXT_BENCHMARK_TURNS = 24;
const DEFAULT_DESKTOP_RUNS = 1;
const DEFAULT_DESKTOP_TIMEOUT_MS = 75_000;

export interface PipelineDesktopRunnerInput {
  runIndex: number;
  timeoutMs: number;
}

export type PipelineDesktopRunner = (
  input: PipelineDesktopRunnerInput,
) => Promise<PipelineDesktopRunArtifact>;

export interface PipelineQualityRunnerConfig {
  now?: () => number;
  runId?: string;
  turns?: number;
  desktopRuns?: number;
  desktopTimeoutMs?: number;
  delegationBenchmarkK?: number;
  incidentFixtureDir?: string;
  desktopRunner?: PipelineDesktopRunner;
}

interface ContextAndTokenBenchmarkResult {
  promptTokenSeries: number[];
  completedTasks: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
}

interface ToolTurnBenchmarkResult {
  validCases: number;
  validAccepted: number;
  malformedCases: number;
  malformedRejected: number;
  malformedForwarded: number;
}

function createBenchmarkMessage(
  content: string,
  sessionId: string,
  turn: number,
): GatewayMessage {
  return {
    id: `phase9-msg-${turn}`,
    channel: "eval",
    senderId: "phase9-user",
    senderName: "Phase9",
    sessionId,
    content,
    timestamp: 1_700_000_000_000 + turn,
    scope: "dm",
  };
}

function estimateMessageChars(message: LLMMessage): number {
  const base = 48;
  if (typeof message.content === "string") {
    return base + message.content.length;
  }
  return (
    base +
    message.content.reduce((sum, part) => {
      if (part.type === "text") return sum + part.text.length;
      return sum + part.image_url.url.length;
    }, 0)
  );
}

function estimatePromptTokens(messages: readonly LLMMessage[]): number {
  const chars = messages.reduce((sum, message) => sum + estimateMessageChars(message), 0);
  return Math.max(1, Math.ceil(chars / 4));
}

function createDeterministicBenchmarkProvider(): LLMProvider {
  const chat = async (messages: LLMMessage[], _options?: LLMChatOptions) => {
    const promptTokens = estimatePromptTokens(messages);
    const completionTokens = 24;
    const response: LLMResponse = {
      content: "ack",
      toolCalls: [],
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      model: "phase9-benchmark-model",
      finishReason: "stop",
    };
    return response;
  };

  return {
    name: "phase9-benchmark",
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

function createEconomicsProvider(params: {
  readonly name: string;
  readonly responses: readonly (
    | { type: "tool_calls"; totalTokens: number }
    | { type: "content"; content: string; totalTokens: number }
    | { type: "error"; message: string }
  )[];
}): LLMProvider {
  let callIndex = 0;
  return {
    name: params.name,
    async chat() {
      const next =
        params.responses[Math.min(callIndex, params.responses.length - 1)];
      callIndex += 1;
      if (next.type === "error") {
        throw new Error(next.message);
      }
      if (next.type === "tool_calls") {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [
            { id: `${params.name}-tool-${callIndex}`, name: "tool", arguments: "{}" },
          ],
          usage: {
            promptTokens: Math.max(1, Math.floor(next.totalTokens / 2)),
            completionTokens: Math.max(1, next.totalTokens - Math.max(1, Math.floor(next.totalTokens / 2))),
            totalTokens: next.totalTokens,
          },
          model: `${params.name}-model`,
        };
      }
      return {
        content: next.content,
        finishReason: "stop",
        toolCalls: [],
        usage: {
          promptTokens: Math.max(1, Math.floor(next.totalTokens / 2)),
          completionTokens: Math.max(1, next.totalTokens - Math.max(1, Math.floor(next.totalTokens / 2))),
          totalTokens: next.totalTokens,
        },
        model: `${params.name}-model`,
      };
    },
    async chatStream(messages, onChunk, options) {
      const response = await this.chat!(messages, options);
      onChunk({ content: response.content, done: true });
      return response;
    },
    healthCheck: async () => true,
  };
}

async function runEconomicsBenchmark(): Promise<ReturnType<typeof computeEconomicsScorecard>> {
  const scenarios: EconomicsScenarioRecord[] = [];
  const tinyExecutorPolicy = {
    mode: "enforce" as const,
    budgets: {
      planner: {
        runClass: "planner" as const,
        tokenCeiling: 80,
        latencyCeilingMs: 20_000,
        spendCeilingUnits: 1,
        downgradeTokenRatio: 0.7,
        downgradeSpendRatio: 0.7,
        downgradeLatencyRatio: 0.7,
      },
      executor: {
        runClass: "executor" as const,
        tokenCeiling: 80,
        latencyCeilingMs: 20_000,
        spendCeilingUnits: 1,
        downgradeTokenRatio: 0.7,
        downgradeSpendRatio: 0.7,
        downgradeLatencyRatio: 0.7,
      },
      verifier: {
        runClass: "verifier" as const,
        tokenCeiling: 64,
        latencyCeilingMs: 10_000,
        spendCeilingUnits: 0.8,
        downgradeTokenRatio: 0.7,
        downgradeSpendRatio: 0.7,
        downgradeLatencyRatio: 0.7,
      },
      child: {
        runClass: "child" as const,
        tokenCeiling: 96,
        latencyCeilingMs: 20_000,
        spendCeilingUnits: 1.2,
        downgradeTokenRatio: 0.7,
        downgradeSpendRatio: 0.7,
        downgradeLatencyRatio: 0.7,
      },
    },
    childFanoutSoftCap: 1,
    negativeDelegationMarginUnits: 0.2,
    negativeDelegationMarginTokens: 64,
  };

  {
    const provider = createEconomicsProvider({
      name: "budgeted-primary",
      responses: [
        { type: "tool_calls", totalTokens: 140 },
        { type: "content", content: "should not be reached", totalTokens: 10 },
      ],
    });
    const executor = new ChatExecutor({
      providers: [provider],
      toolHandler: async () => '{"ok":true}',
      maxToolRounds: 3,
      economicsPolicy: tinyExecutorPolicy,
    });
    const result = await executor.execute({
      message: createBenchmarkMessage("stay within runtime budget", "economics-budget", 0),
      history: [],
      systemPrompt: "Budget test",
      sessionId: "economics-budget",
    });
    scenarios.push({
      scenarioId: "token_ceiling_enforced",
      passed: result.stopReason === "budget_exceeded",
      tokenCeilingRespected: result.stopReason === "budget_exceeded",
      latencyCeilingRespected: true,
      spendCeilingRespected: true,
      negativeEconomicsApplicable: false,
      delegationDeniedOnNegativeEconomics: true,
      degradedProviderRerouteApplicable: false,
      reroutedUnderDegradedProvider: false,
      spendUnits: result.economicsSummary?.totalSpendUnits ?? 0,
      latencyMs: 1,
    });
  }

  // Cut 1.2: negative_economics_delegation_denial scenario deleted
  // along with assessDelegationDecision. The same hard-rejection path
  // is now exercised by the delegation-admission integration test
  // (gateway/delegation-admission.test.ts).

  {
    const primary = createEconomicsProvider({
      name: "degraded-primary",
      responses: [{ type: "error", message: "timeout" }],
    });
    const fallback = createEconomicsProvider({
      name: "fallback-secondary",
      responses: [
        { type: "content", content: "fallback success", totalTokens: 40 },
        { type: "content", content: "rerouted success", totalTokens: 30 },
      ],
    });
    const executor = new ChatExecutor({
      providers: [primary, fallback],
      economicsPolicy: buildRuntimeEconomicsPolicy({
        sessionTokenBudget: 512,
        plannerMaxTokens: 64,
        requestTimeoutMs: 20_000,
        mode: "enforce",
      }),
    });
    await executor.execute({
      message: createBenchmarkMessage("trip provider cooldown", "economics-reroute", 0),
      history: [],
      systemPrompt: "Reroute test",
      sessionId: "economics-reroute",
    });
    const rerouted = await executor.execute({
      message: createBenchmarkMessage("run on healthy provider", "economics-reroute", 1),
      history: [],
      systemPrompt: "Reroute test",
      sessionId: "economics-reroute",
    });
    scenarios.push({
      scenarioId: "degraded_provider_reroute",
      passed: (rerouted.economicsSummary?.rerouteCount ?? 0) > 0,
      tokenCeilingRespected: true,
      latencyCeilingRespected: true,
      spendCeilingRespected: true,
      negativeEconomicsApplicable: false,
      delegationDeniedOnNegativeEconomics: true,
      degradedProviderRerouteApplicable: true,
      reroutedUnderDegradedProvider:
        (rerouted.economicsSummary?.rerouteCount ?? 0) > 0,
      spendUnits: rerouted.economicsSummary?.totalSpendUnits ?? 0,
      latencyMs: 1,
    });
  }

  return computeEconomicsScorecard(scenarios);
}

async function runContextAndTokenBenchmark(
  turns: number,
): Promise<ContextAndTokenBenchmarkResult> {
  const provider = createDeterministicBenchmarkProvider();
  const sessionManager = new SessionManager(
    {
      scope: "per-channel-peer",
      reset: { mode: "never" },
      maxHistoryLength: 4,
      compaction: "summarize",
    },
    {
      summarizer: async () =>
        "The benchmark is maintaining artifact-backed context for PLAN.md, tests, and repo state.",
    },
  );
  const config: ChatExecutorConfig = {
    providers: [provider],
    plannerEnabled: false,
    maxModelRecallsPerRequest: 1,
    promptBudget: {
      contextWindowTokens: 2048,
      maxOutputTokens: 384,
      safetyMarginTokens: 384,
      hardMaxPromptChars: 3_200,
    },
    requestTimeoutMs: 20_000,
  };
  const executor = new ChatExecutor(config);

  const sessionId = "phase9-context-benchmark";
  const session = sessionManager.getOrCreate({
    channel: "eval",
    senderId: "phase9-user",
    scope: "dm",
    workspaceId: "phase9-benchmark-workspace",
  });
  const systemPrompt = [
    "You are running a deterministic benchmark for prompt growth.",
    "Return concise acknowledgements only.",
  ].join(" ");

  const promptTokenSeries: number[] = [];
  let completedTasks = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokens = 0;

  for (let turn = 0; turn < turns; turn++) {
    if (
      session.history.length >= 4 &&
      !buildSessionStatefulOptions(session)?.artifactContext
    ) {
      await sessionManager.compact(session.id);
    }
    const content =
      `Phase 9 context turn ${turn}: keep PLAN.md, src/main.c, parser.test.ts, ` +
      "and the active implementation notes aligned; respond with a compact ack.";
    const result = await executor.execute({
      message: createBenchmarkMessage(content, sessionId, turn),
      history: session.history,
      systemPrompt,
      sessionId,
      maxToolRounds: 1,
      stateful: buildSessionStatefulOptions(session),
    });

    const promptTokens = result.callUsage.reduce(
      (sum, call) => sum + call.usage.promptTokens,
      0,
    );
    promptTokenSeries.push(promptTokens);

    totalPromptTokens += result.tokenUsage.promptTokens;
    totalCompletionTokens += result.tokenUsage.completionTokens;
    totalTokens += result.tokenUsage.totalTokens;
    if (result.stopReason === "completed") {
      completedTasks++;
    }

    sessionManager.appendMessage(session.id, { role: "user", content });
    sessionManager.appendMessage(session.id, {
      role: "assistant",
      content: result.content,
    });
    if (session.history.length > 4) {
      await sessionManager.compact(session.id);
    }
  }

  return {
    promptTokenSeries,
    completedTasks,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
  };
}

function runToolTurnBenchmark(): ToolTurnBenchmarkResult {
  const validSequences: LLMMessage[][] = [
    [
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_a", name: "system.bash", arguments: '{"command":"echo"}' },
          { id: "call_b", name: "system.bash", arguments: '{"command":"pwd"}' },
        ],
      },
      { role: "tool", toolCallId: "call_b", content: '{"stdout":"x"}' },
      { role: "tool", toolCallId: "call_a", content: '{"stdout":"y"}' },
      { role: "assistant", content: "done" },
    ],
    [
      { role: "user", content: "once" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_1", name: "system.bash", arguments: '{"command":"ls"}' },
        ],
      },
      { role: "tool", toolCallId: "call_1", content: '{"stdout":"ok"}' },
      { role: "assistant", content: "ok" },
    ],
  ];

  const malformedSequences: LLMMessage[][] = [
    [
      { role: "user", content: "bad" },
      { role: "assistant", content: "" },
      { role: "tool", toolCallId: "call_1", content: '{"stdout":""}' },
    ],
    [
      { role: "user", content: "bad" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_1", name: "system.bash", arguments: '{"command":"ls"}' },
        ],
      },
      { role: "tool", toolCallId: "call_x", content: '{"stdout":"x"}' },
    ],
    [
      { role: "user", content: "bad" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_1", name: "system.bash", arguments: '{"command":"ls"}' },
        ],
      },
      { role: "assistant", content: "missing tool result" },
    ],
  ];

  let validAccepted = 0;
  for (const sequence of validSequences) {
    validateToolTurnSequence(sequence);
    validAccepted++;
  }

  let malformedRejected = 0;
  let malformedForwarded = 0;
  for (const sequence of malformedSequences) {
    try {
      validateToolTurnSequence(sequence);
      malformedForwarded++;
    } catch (error) {
      if (error instanceof LLMMessageValidationError) {
        malformedRejected++;
        continue;
      }
      throw error;
    }
  }

  return {
    validCases: validSequences.length,
    validAccepted,
    malformedCases: malformedSequences.length,
    malformedRejected,
    malformedForwarded,
  };
}

function resolveDefaultIncidentFixtureDir(): string {
  const candidates = [
    path.resolve(process.cwd(), "benchmarks/v1/incidents"),
    path.resolve(process.cwd(), "runtime/benchmarks/v1/incidents"),
    path.resolve(process.cwd(), "../runtime/benchmarks/v1/incidents"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[1];
}

async function runOfflineReplayBenchmark(
  fixtureDir: string,
): Promise<PipelineOfflineReplayFixtureArtifact[]> {
  const fixtures: PipelineOfflineReplayFixtureArtifact[] = [];
  const entries = await readdir(fixtureDir, { withFileTypes: true });
  const traceFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".trace.json"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  for (const traceFile of traceFiles) {
    const fixtureId = traceFile.replace(/\.trace\.json$/, "");
    const fixturePath = path.join(fixtureDir, traceFile);

    let parsed: unknown;
    try {
      const raw = await readFile(fixturePath, "utf8");
      parsed = parseTrajectoryTrace(JSON.parse(raw) as unknown);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fixtures.push({
        fixtureId,
        ok: false,
        parseError: message,
      });
      continue;
    }

    const parity = evaluateReplayParity(parsed, { strictMode: true });

    if (parity.replayErrors > 0) {
      fixtures.push({
        fixtureId,
        ok: false,
        replayError: `replay produced ${String(parity.replayErrors)} errors`,
        deterministicMismatch: !parity.deterministic,
      });
      continue;
    }

    fixtures.push({
      fixtureId,
      ok: parity.ok,
      deterministicMismatch: !parity.deterministic,
    });
  }

  return fixtures;
}

function parseOrchestrationExpectation(
  value: unknown,
  fixtureId: string,
): OrchestrationRegressionExpectation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${fixtureId}.expected must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== ORCHESTRATION_EXPECTATION_SCHEMA_VERSION) {
    throw new Error(
      `${fixtureId}.expected schemaVersion must be ${ORCHESTRATION_EXPECTATION_SCHEMA_VERSION}`,
    );
  }
  const scenarioId = String(record.scenarioId ?? "");
  const title = String(record.title ?? "");
  const sourceTraceId = String(record.sourceTraceId ?? "");
  const sourceArtifacts = Array.isArray(record.sourceArtifacts)
    ? record.sourceArtifacts.map((entry) => String(entry))
    : [];
  const expectedReplay = record.expectedReplay as Record<string, unknown> | undefined;
  const baselineMetrics = record.baselineMetrics as Record<string, unknown> | undefined;
  if (!scenarioId || !title || !sourceTraceId || !expectedReplay || !baselineMetrics) {
    throw new Error(`${fixtureId}.expected is missing required fields`);
  }
  return {
    schemaVersion: ORCHESTRATION_EXPECTATION_SCHEMA_VERSION,
    scenarioId,
    title,
    sourceTraceId,
    sourceArtifacts,
    expectedReplay: {
      taskPda: String(expectedReplay.taskPda ?? ""),
      finalStatus: String(expectedReplay.finalStatus ?? "") as never,
      replayErrors: Number(expectedReplay.replayErrors ?? 0),
      replayWarnings: Number(expectedReplay.replayWarnings ?? 0),
      policyViolations: Number(expectedReplay.policyViolations ?? 0),
      verifierVerdicts: Number(expectedReplay.verifierVerdicts ?? 0),
    },
    baselineMetrics: {
      turns: Number(baselineMetrics.turns ?? 0),
      toolCalls: Number(baselineMetrics.toolCalls ?? 0),
      fallbackCount: Number(baselineMetrics.fallbackCount ?? 0),
      spuriousSubagentCount: Number(
        baselineMetrics.spuriousSubagentCount ?? 0,
      ),
      approvalCount: Number(baselineMetrics.approvalCount ?? 0),
      restartRecoverySuccess: Boolean(
        baselineMetrics.restartRecoverySuccess,
      ),
    },
  };
}

async function runOrchestrationBaselineBenchmark(
  fixtureDir: string,
): Promise<PipelineOrchestrationScenarioInput[]> {
  const entries = await readdir(fixtureDir, { withFileTypes: true });
  const traceFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".trace.json"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const catalogByFixture = new Map(
    ORCHESTRATION_REGRESSION_SCENARIOS.map((entry) => [
      `${entry.fixtureBaseName}.trace.json`,
      entry,
    ]),
  );

  const scenarios: PipelineOrchestrationScenarioInput[] = [];

  for (const traceFile of traceFiles) {
    const catalogEntry = catalogByFixture.get(traceFile);
    if (!catalogEntry) continue;

    const fixtureId = traceFile.replace(/\.trace\.json$/, "");
    const tracePath = path.join(fixtureDir, traceFile);
    const expectedPath = path.join(fixtureDir, `${fixtureId}.expected.json`);

    const rawTrace = await readFile(tracePath, "utf8");
    const rawExpected = await readFile(expectedPath, "utf8");
    const trace = parseTrajectoryTrace(JSON.parse(rawTrace) as unknown);
    const expected = parseOrchestrationExpectation(
      JSON.parse(rawExpected) as unknown,
      fixtureId,
    );
    const replay = new TrajectoryReplayEngine({ strictMode: true }).replay(trace);
    const task = replay.tasks[expected.expectedReplay.taskPda];
    const observedStatus = task?.status ?? "unknown";
    const mismatchReasons: string[] = [];

    if (observedStatus !== expected.expectedReplay.finalStatus) {
      mismatchReasons.push(
        `finalStatus expected ${expected.expectedReplay.finalStatus} got ${observedStatus}`,
      );
    }
    if (replay.errors.length !== expected.expectedReplay.replayErrors) {
      mismatchReasons.push(
        `replayErrors expected ${expected.expectedReplay.replayErrors} got ${replay.errors.length}`,
      );
    }
    if (replay.warnings.length !== expected.expectedReplay.replayWarnings) {
      mismatchReasons.push(
        `replayWarnings expected ${expected.expectedReplay.replayWarnings} got ${replay.warnings.length}`,
      );
    }
    if (
      (task?.policyViolations ?? 0) !== expected.expectedReplay.policyViolations
    ) {
      mismatchReasons.push(
        `policyViolations expected ${expected.expectedReplay.policyViolations} got ${task?.policyViolations ?? 0}`,
      );
    }
    if (
      (task?.verifierVerdicts ?? 0) !== expected.expectedReplay.verifierVerdicts
    ) {
      mismatchReasons.push(
        `verifierVerdicts expected ${expected.expectedReplay.verifierVerdicts} got ${task?.verifierVerdicts ?? 0}`,
      );
    }

    scenarios.push({
      scenarioId: expected.scenarioId,
      title: expected.title,
      category: catalogEntry.category,
      sourceTraceId: expected.sourceTraceId,
      passed: mismatchReasons.length === 0,
      finalStatus: observedStatus,
      replayErrors: replay.errors.length,
      replayWarnings: replay.warnings.length,
      policyViolations: task?.policyViolations ?? 0,
      verifierVerdicts: task?.verifierVerdicts ?? 0,
      turns: expected.baselineMetrics.turns,
      toolCalls: expected.baselineMetrics.toolCalls,
      fallbackCount: expected.baselineMetrics.fallbackCount,
      spuriousSubagentCount: expected.baselineMetrics.spuriousSubagentCount,
      approvalCount: expected.baselineMetrics.approvalCount,
      restartRecoverySuccess: expected.baselineMetrics.restartRecoverySuccess,
      mismatchReasons,
    });
  }

  return scenarios;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ timedOut: boolean; value?: T }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("timeout"));
        }, timeoutMs);
      }),
    ]);
    return { timedOut: false, value };
  } catch (error) {
    if (error instanceof Error && error.message === "timeout") {
      return { timedOut: true };
    }
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

const defaultDesktopRunner: PipelineDesktopRunner = async ({
  runIndex,
  timeoutMs,
}) => {
  const runId = `desktop-${runIndex + 1}`;
  const started = Date.now();
  const result = await withTimeout(runPipelineHttpRepro(), timeoutMs);

  if (result.timedOut || !result.value) {
    return {
      runId,
      ok: false,
      timedOut: true,
      durationMs: Date.now() - started,
      preview: `timeout after ${timeoutMs}ms`,
    };
  }

  const output = result.value;
  const failedStep = output.steps.find((step) => !step.ok)?.step;
  const failedPreview = output.steps.find((step) => step.step === failedStep)
    ?.preview;
  return {
    runId,
    ok: output.overall === "pass",
    timedOut: false,
    durationMs: output.durationMs,
    failedStep,
    preview: failedPreview ?? "ok",
  };
};

/**
 * Run full Phase 9 pipeline-quality benchmark suite.
 */
export async function runPipelineQualitySuite(
  config: PipelineQualityRunnerConfig = {},
): Promise<PipelineQualityArtifact> {
  const now = config.now ?? Date.now;
  const turns = Math.max(
    2,
    Math.floor(config.turns ?? DEFAULT_CONTEXT_BENCHMARK_TURNS),
  );
  const desktopRuns = Math.max(
    0,
    Math.floor(config.desktopRuns ?? DEFAULT_DESKTOP_RUNS),
  );
  const desktopTimeoutMs = Math.max(
    5_000,
    Math.floor(config.desktopTimeoutMs ?? DEFAULT_DESKTOP_TIMEOUT_MS),
  );
  const runId = config.runId ?? `pipeline-quality-${now()}`;
  const desktopRunner = config.desktopRunner ?? defaultDesktopRunner;

  const contextAndToken = await runContextAndTokenBenchmark(turns);
  const toolTurn = runToolTurnBenchmark();

  const runSummaries: PipelineDesktopRunArtifact[] = [];
  for (let runIndex = 0; runIndex < desktopRuns; runIndex++) {
    runSummaries.push(await desktopRunner({ runIndex, timeoutMs: desktopTimeoutMs }));
  }

  const incidentFixtureDir =
    config.incidentFixtureDir ?? resolveDefaultIncidentFixtureDir();
  const replayFixtures = await runOfflineReplayBenchmark(incidentFixtureDir);
  const orchestrationBaseline = await runOrchestrationBaselineBenchmark(
    incidentFixtureDir,
  );
  const delegationBenchmark = await runDelegationBenchmarkSuite({
    now,
    runId: `${runId}:delegation`,
    k: config.delegationBenchmarkK,
  });
  const delegation = delegationBenchmark.summary;
  const liveCoding = await runLiveCodingSuite({ now });
  const safety = await runSafetySuite();
  const longHorizon = await runLongHorizonSuite({ now });
  const implementationGates = await runImplementationGateSuite({
    incidentFixtureDir,
  });
  const delegatedWorkspaceGates = await runDelegatedWorkspaceGateSuite({
    incidentFixtureDir,
  });
  const chaos = await runChaosSuite();
  const economics = await runEconomicsBenchmark();

  return buildPipelineQualityArtifact({
    runId,
    generatedAtMs: now(),
    contextGrowth: {
      promptTokenSeries: contextAndToken.promptTokenSeries,
    },
    toolTurn,
    desktopStability: {
      runSummaries,
    },
    tokenEfficiency: {
      completedTasks: contextAndToken.completedTasks,
      totalPromptTokens: contextAndToken.totalPromptTokens,
      totalCompletionTokens: contextAndToken.totalCompletionTokens,
      totalTokens: contextAndToken.totalTokens,
    },
    offlineReplay: {
      fixtures: replayFixtures,
    },
    orchestrationBaseline: {
      scenarios: orchestrationBaseline,
    },
    delegation: {
      totalCases: delegation.totalCases,
      delegatedCases: delegation.delegatedCases,
      usefulDelegations: delegation.usefulDelegations,
      harmfulDelegations: delegation.harmfulDelegations,
      unnecessaryDelegations: delegation.unnecessaryDelegations,
      plannerExecutionMismatches: delegation.plannerExecutionMismatches,
      childTimeouts: delegation.childTimeouts,
      childFailures: delegation.childFailures,
      synthesisConflicts: delegation.synthesisConflicts,
      depthCapHits: delegation.depthCapHits,
      fanoutCapHits: delegation.fanoutCapHits,
      costDeltaVsBaseline: delegation.costDeltaVsBaseline,
      latencyDeltaVsBaseline: delegation.latencyDeltaVsBaseline,
      qualityDeltaVsBaseline: delegation.qualityDeltaVsBaseline,
      passAtKDeltaVsBaseline: delegation.passAtKDeltaVsBaseline,
      passCaretKDeltaVsBaseline: delegation.passCaretKDeltaVsBaseline,
      baselineScenarioId: delegation.baselineScenarioId,
      k: delegation.k,
      scenarioSummaries: delegation.scenarioSummaries,
    },
    liveCoding,
    safety,
    longHorizon,
    implementationGates,
    delegatedWorkspaceGates,
    chaos,
    economics,
  });
}
