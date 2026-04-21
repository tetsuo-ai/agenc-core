import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPostCompactMessages } from "../../../src/services/compact/compact.js";
import { calculateMessagesToKeepIndex } from "../../../src/services/compact/sessionMemoryCompact.js";
import { freshDenialTracking } from "../../../src/permissions/denial-tracking.js";
import {
  attachContextDefaults,
  hasPermissionsToUseTool,
  type AppStateSnapshot,
  type ToolEvaluatorContext,
  type ToolLike,
} from "../../../src/permissions/evaluator.js";
import { createEmptyToolPermissionContext } from "../../../src/permissions/types.js";
import {
  EventLog,
  type Event,
} from "../../../src/session/event-log.js";
import { reconstructFromRollout } from "../../../src/session/rollout-reconstruction.js";
import type { RolloutItem } from "../../../src/session/rollout-item.js";
import {
  createBashExecObserverForSession,
  createMCPCallObserverForSession,
  type ObserverSessionSink,
} from "../../../src/session/observer-wiring.js";
import { createToolBridge } from "../../../src/mcp-client/tool-bridge.js";

const BENCHMARK_LANE_ID = "runtime-replacement";
const BENCHMARK_ARTIFACT_SCHEMA_VERSION = 1;

const benchmarkDir = fileURLToPath(new URL("./", import.meta.url));
const runtimeRoot = fileURLToPath(new URL("../../../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

export const benchmarkManifestPath = join(benchmarkDir, "manifest.json");

export type AcceptancePolicy =
  | { readonly type: "max_multiplier"; readonly value: number }
  | { readonly type: "max_delta_ms"; readonly value: number };

export interface BenchmarkFixtureDefinition {
  readonly id: string;
  readonly title: string;
  readonly workload: string;
  readonly kind:
    | "session_replay"
    | "history_compact"
    | "tool_event_burst"
    | "approval_concurrency";
  readonly sourceSeams: ReadonlyArray<string>;
  readonly artifact: string;
  readonly metric: {
    readonly name: "median_ms";
    readonly unit: "milliseconds";
    readonly acceptance: AcceptancePolicy;
  };
  readonly capture: {
    readonly warmupIterations: number;
    readonly measurementIterations: number;
  };
  readonly notes?: string;
}

export interface BenchmarkManifest {
  readonly schemaVersion: number;
  readonly laneId: string;
  readonly artifactSchemaVersion: number;
  readonly fixtureDirectory: string;
  readonly artifactDirectory: string;
  readonly captureEnv: string;
  readonly verifyEnv: string;
  readonly fixtures: ReadonlyArray<BenchmarkFixtureDefinition>;
}

export interface BenchmarkStats {
  readonly minMs: number;
  readonly maxMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
}

export interface BenchmarkMeasurement {
  readonly fixtureId: string;
  readonly fixtureTitle: string;
  readonly warmupIterations: number;
  readonly sampleCount: number;
  readonly samplesMs: ReadonlyArray<number>;
  readonly stats: BenchmarkStats;
}

export interface BenchmarkArtifact {
  readonly schemaVersion: number;
  readonly laneId: string;
  readonly capturedAt: string;
  readonly runtimeRoot: string;
  readonly environment: {
    readonly nodeVersion: string;
    readonly platform: string;
    readonly arch: string;
  };
  readonly git: {
    readonly commit: string | null;
    readonly branch: string | null;
  };
  readonly fixture: {
    readonly id: string;
    readonly title: string;
    readonly kind: BenchmarkFixtureDefinition["kind"];
    readonly workloadPath: string;
    readonly sourceSeams: ReadonlyArray<string>;
    readonly metric: BenchmarkFixtureDefinition["metric"];
    readonly capture: BenchmarkFixtureDefinition["capture"];
    readonly notes?: string;
  };
  readonly measurement: {
    readonly sampleCount: number;
    readonly warmupIterations: number;
    readonly samplesMs: ReadonlyArray<number>;
    readonly stats: BenchmarkStats;
  };
}

type SessionReplayWorkload = {
  readonly schemaVersion: number;
  readonly fixtureId: "runtime-large-session-replay";
  readonly turns: number;
  readonly compactEveryTurns: number;
  readonly assistantTextBytes: number;
  readonly toolResultBytes: number;
};

type HistoryCompactWorkload = {
  readonly schemaVersion: number;
  readonly fixtureId: "runtime-large-history-compact";
  readonly messagePairs: number;
  readonly compactBoundaryEveryPairs: number;
  readonly lastSummarizedPairCount: number;
  readonly userTextBytes: number;
  readonly toolPayloadBytes: number;
};

type ToolEventBurstWorkload = {
  readonly schemaVersion: number;
  readonly fixtureId: "runtime-tool-event-burst-1000";
  readonly mcpCalls: number;
  readonly bashExecutions: number;
  readonly mcpResultBytes: number;
  readonly bashStdoutBytes: number;
  readonly listenerCount: number;
};

type ApprovalConcurrencyWorkload = {
  readonly schemaVersion: number;
  readonly fixtureId: "runtime-approval-concurrency";
  readonly concurrentRequests: number;
  readonly commandBytes: number;
};

type KnownWorkload =
  | SessionReplayWorkload
  | HistoryCompactWorkload
  | ToolEventBurstWorkload
  | ApprovalConcurrencyWorkload;

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function loadBenchmarkManifest(): BenchmarkManifest {
  return readJsonFile<BenchmarkManifest>(benchmarkManifestPath);
}

export function resolveWorkloadPath(
  manifest: BenchmarkManifest,
  fixture: BenchmarkFixtureDefinition,
): string {
  return join(runtimeRoot, "benchmarks", "v1", BENCHMARK_LANE_ID, fixture.workload);
}

export function resolveArtifactPath(
  manifest: BenchmarkManifest,
  fixture: BenchmarkFixtureDefinition,
): string {
  return join(runtimeRoot, "benchmarks", "artifacts", BENCHMARK_LANE_ID, fixture.artifact);
}

export function readFixtureWorkload(
  manifest: BenchmarkManifest,
  fixture: BenchmarkFixtureDefinition,
): KnownWorkload {
  return readJsonFile<KnownWorkload>(resolveWorkloadPath(manifest, fixture));
}

export function validateBenchmarkManifest(manifest: BenchmarkManifest): void {
  if (manifest.laneId !== BENCHMARK_LANE_ID) {
    throw new Error(
      `Expected laneId "${BENCHMARK_LANE_ID}", got "${manifest.laneId}"`,
    );
  }
  if (manifest.artifactSchemaVersion !== BENCHMARK_ARTIFACT_SCHEMA_VERSION) {
    throw new Error(
      `Expected artifactSchemaVersion ${BENCHMARK_ARTIFACT_SCHEMA_VERSION}, got ${manifest.artifactSchemaVersion}`,
    );
  }
  const seenFixtureIds = new Set<string>();
  for (const fixture of manifest.fixtures) {
    if (seenFixtureIds.has(fixture.id)) {
      throw new Error(`Duplicate benchmark fixture id "${fixture.id}"`);
    }
    seenFixtureIds.add(fixture.id);
    if (fixture.capture.warmupIterations < 0) {
      throw new Error(`Fixture "${fixture.id}" has negative warmup iterations`);
    }
    if (fixture.capture.measurementIterations <= 0) {
      throw new Error(`Fixture "${fixture.id}" must measure at least once`);
    }
    const workload = readFixtureWorkload(manifest, fixture);
    if (workload.fixtureId !== fixture.id) {
      throw new Error(
        `Fixture "${fixture.id}" workload id mismatch: got "${workload.fixtureId}"`,
      );
    }
  }
}

export async function runFixtureMeasurement(
  manifest: BenchmarkManifest,
  fixture: BenchmarkFixtureDefinition,
): Promise<BenchmarkMeasurement> {
  const workload = readFixtureWorkload(manifest, fixture);
  const operation = await createOperation(fixture, workload);

  for (let index = 0; index < fixture.capture.warmupIterations; index += 1) {
    await operation();
  }

  const samples: number[] = [];
  for (let index = 0; index < fixture.capture.measurementIterations; index += 1) {
    const startedAt = performance.now();
    await operation();
    samples.push(Number((performance.now() - startedAt).toFixed(3)));
  }

  return {
    fixtureId: fixture.id,
    fixtureTitle: fixture.title,
    warmupIterations: fixture.capture.warmupIterations,
    sampleCount: samples.length,
    samplesMs: samples,
    stats: computeStats(samples),
  };
}

export function writeBaselineArtifact(
  manifest: BenchmarkManifest,
  fixture: BenchmarkFixtureDefinition,
  measurement: BenchmarkMeasurement,
): BenchmarkArtifact {
  const artifactPath = resolveArtifactPath(manifest, fixture);
  const workloadPath = resolveWorkloadPath(manifest, fixture);
  const artifact: BenchmarkArtifact = {
    schemaVersion: BENCHMARK_ARTIFACT_SCHEMA_VERSION,
    laneId: manifest.laneId,
    capturedAt: new Date().toISOString(),
    runtimeRoot: relative(repoRoot, runtimeRoot),
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    git: readGitMetadata(),
    fixture: {
      id: fixture.id,
      title: fixture.title,
      kind: fixture.kind,
      workloadPath: relative(repoRoot, workloadPath),
      sourceSeams: fixture.sourceSeams,
      metric: fixture.metric,
      capture: fixture.capture,
      ...(fixture.notes ? { notes: fixture.notes } : {}),
    },
    measurement: {
      sampleCount: measurement.sampleCount,
      warmupIterations: measurement.warmupIterations,
      samplesMs: measurement.samplesMs,
      stats: measurement.stats,
    },
  };

  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(`${artifactPath}`, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return artifact;
}

export function readBaselineArtifact(
  manifest: BenchmarkManifest,
  fixture: BenchmarkFixtureDefinition,
): BenchmarkArtifact {
  const artifact = readJsonFile<BenchmarkArtifact>(resolveArtifactPath(manifest, fixture));
  if (artifact.schemaVersion !== BENCHMARK_ARTIFACT_SCHEMA_VERSION) {
    throw new Error(
      `Fixture "${fixture.id}" artifact schema mismatch: got ${artifact.schemaVersion}`,
    );
  }
  if (artifact.fixture.id !== fixture.id) {
    throw new Error(
      `Fixture artifact mismatch: expected "${fixture.id}", got "${artifact.fixture.id}"`,
    );
  }
  return artifact;
}

export function assertMeasurementWithinBaseline(
  fixture: BenchmarkFixtureDefinition,
  measurement: BenchmarkMeasurement,
  baseline: BenchmarkArtifact,
): void {
  const current = measurement.stats.medianMs;
  const baselineMedian = baseline.measurement.stats.medianMs;
  const acceptance = fixture.metric.acceptance;

  if (acceptance.type === "max_multiplier") {
    const ceiling = baselineMedian * acceptance.value;
    if (current > ceiling) {
      throw new Error(
        `Fixture "${fixture.id}" median ${current.toFixed(3)}ms exceeded ${acceptance.value}x baseline (${baselineMedian.toFixed(3)}ms -> ${ceiling.toFixed(3)}ms)`,
      );
    }
    return;
  }

  const ceiling = baselineMedian + acceptance.value;
  if (current > ceiling) {
    throw new Error(
      `Fixture "${fixture.id}" median ${current.toFixed(3)}ms exceeded baseline delta ceiling (${baselineMedian.toFixed(3)}ms + ${acceptance.value}ms = ${ceiling.toFixed(3)}ms)`,
    );
  }
}

async function createOperation(
  fixture: BenchmarkFixtureDefinition,
  workload: KnownWorkload,
): Promise<() => Promise<void>> {
  switch (fixture.kind) {
    case "session_replay":
      return createSessionReplayOperation(workload as SessionReplayWorkload);
    case "history_compact":
      return createHistoryCompactOperation(workload as HistoryCompactWorkload);
    case "tool_event_burst":
      return createToolEventBurstOperation(workload as ToolEventBurstWorkload);
    case "approval_concurrency":
      return createApprovalConcurrencyOperation(
        workload as ApprovalConcurrencyWorkload,
      );
  }
}

function createSessionReplayOperation(
  workload: SessionReplayWorkload,
): () => Promise<void> {
  const rollout = buildSyntheticRollout(workload);
  return async () => {
    void reconstructFromRollout(rollout);
  };
}

function buildSyntheticRollout(
  workload: SessionReplayWorkload,
): RolloutItem[] {
  const items: RolloutItem[] = [];
  let seq = 0;
  for (let turnIndex = 0; turnIndex < workload.turns; turnIndex += 1) {
    const turnId = `turn-${turnIndex}`;
    items.push({
      type: "event_msg",
      payload: {
        id: `started-${turnId}`,
        seq: ++seq,
        msg: { type: "turn_started", payload: { turnId } },
      },
    });
    items.push({
      type: "turn_context",
      payload: {
        turnId,
        cwd: "/workspace",
        approvalPolicy: "never",
        sandboxPolicy: "workspace-write",
        model: "gpt-5.4",
      },
    });
    items.push({
      type: "response_item",
      payload: {
        role: "user",
        content: `user-${turnIndex}-${repeatText("u", workload.assistantTextBytes)}`,
      },
    });
    items.push({
      type: "response_item",
      payload: {
        role: "assistant",
        content: `assistant-${turnIndex}-${repeatText("a", workload.assistantTextBytes)}`,
      },
    });
    items.push({
      type: "response_item",
      payload: {
        role: "tool",
        toolCallId: `tool-${turnId}`,
        toolName: "Bash",
        content: repeatText("r", workload.toolResultBytes),
      },
    });
    items.push({
      type: "event_msg",
      payload: {
        id: `completed-${turnId}`,
        seq: ++seq,
        msg: { type: "turn_complete", payload: { turnId } },
      },
    });

    if ((turnIndex + 1) % workload.compactEveryTurns === 0) {
      items.push({
        type: "compacted",
        payload: {
          message: `summary-${turnIndex}`,
          replacementHistory: [
            { role: "user", content: `summary-user-${turnIndex}` },
            { role: "assistant", content: `summary-assistant-${turnIndex}` },
          ],
        },
      });
    }
  }
  return items;
}

function createHistoryCompactOperation(
  workload: HistoryCompactWorkload,
): () => Promise<void> {
  const messages = buildSyntheticCompactHistory(workload);
  const lastSummarizedIndex = Math.max(
    -1,
    Math.min(
      messages.length - 1,
      workload.lastSummarizedPairCount * 2 - 1,
    ),
  );

  return async () => {
    const startIndex = calculateMessagesToKeepIndex(messages, lastSummarizedIndex);
    const messagesToKeep = messages.slice(startIndex);
    void buildPostCompactMessages({
      boundaryMarker: {
        uuid: "compact-boundary",
        type: "system",
        message: { content: "compact-boundary" },
        compactMetadata: {},
      },
      summaryMessages: [
        {
          uuid: "compact-summary",
          type: "user",
          message: {
            content: [{ type: "text", text: repeatText("s", workload.userTextBytes) }],
          },
        },
      ],
      attachments: [],
      hookResults: [],
      messagesToKeep,
    });
  };
}

function buildSyntheticCompactHistory(
  workload: HistoryCompactWorkload,
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  for (let pairIndex = 0; pairIndex < workload.messagePairs; pairIndex += 1) {
    if (
      pairIndex > 0 &&
      pairIndex % workload.compactBoundaryEveryPairs === 0
    ) {
      messages.push({
        uuid: `boundary-${pairIndex}`,
        type: "system",
        message: { content: "compact boundary" },
        compactMetadata: {},
      });
    }

    const toolId = `tool-${pairIndex}`;
    messages.push({
      uuid: `assistant-${pairIndex}`,
      type: "assistant",
      message: {
        content: [
          { type: "text", text: repeatText("a", workload.userTextBytes) },
          { type: "tool_use", id: toolId, name: "Bash", input: { pairIndex } },
        ],
      },
    });
    messages.push({
      uuid: `user-${pairIndex}`,
      type: "user",
      message: {
        content: [
          { type: "text", text: repeatText("u", workload.userTextBytes) },
          {
            type: "tool_result",
            tool_use_id: toolId,
            content: repeatText("t", workload.toolPayloadBytes),
          },
        ],
      },
    });
  }
  return messages;
}

async function createToolEventBurstOperation(
  workload: ToolEventBurstWorkload,
): Promise<() => Promise<void>> {
  const session = createObserverSession(workload.listenerCount);
  const mcpObserver = createMCPCallObserverForSession(session);
  const bashObserver = createBashExecObserverForSession(session);
  const bridge = await createToolBridge(
    {
      async listTools() {
        return {
          tools: [
            {
              name: "burst",
              description: "synthetic burst benchmark",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        };
      },
      async callTool() {
        return {
          content: [{ type: "text", text: repeatText("m", workload.mcpResultBytes) }],
          isError: false,
        };
      },
      async close() {},
    },
    "benchmark",
    undefined,
    { callObserver: mcpObserver },
  );

  const tool = bridge.tools[0];
  if (!tool) {
    throw new Error("Synthetic MCP bridge did not expose a tool");
  }

  return async () => {
    session.reset();

    for (let index = 0; index < workload.mcpCalls; index += 1) {
      await tool.execute({ index });
    }

    for (let index = 0; index < workload.bashExecutions; index += 1) {
      bashObserver.onBegin?.({
        callId: `bash-${index}`,
        command: `echo ${index}`,
        cwd: "/workspace",
      });
      bashObserver.onEnd?.({
        callId: `bash-${index}`,
        exitCode: 0,
        stdout: repeatText("o", workload.bashStdoutBytes),
        stderr: "",
        durationMs: 1,
      });
    }
  };
}

function createObserverSession(listenerCount: number): ObserverSessionSink & {
  readonly log: EventLog;
  reset(): void;
} {
  const log = new EventLog();
  for (let index = 0; index < listenerCount; index += 1) {
    log.subscribe((_event: Event) => {});
  }
  let nextId = 0;
  return {
    log,
    reset() {
      nextId = 0;
    },
    nextInternalSubId() {
      nextId += 1;
      return `sub-${nextId}`;
    },
    emit(event: Event) {
      log.emit(event);
    },
  };
}

function createApprovalConcurrencyOperation(
  workload: ApprovalConcurrencyWorkload,
): () => Promise<void> {
  const tool = createApprovalBenchmarkTool(workload.commandBytes);
  return async () => {
    await Promise.all(
      Array.from({ length: workload.concurrentRequests }, (_, index) =>
        createApprovalDecision(tool, {
          command: `cmd-${index}-${repeatText("x", workload.commandBytes)}`,
        }),
      ),
    );
  };
}

function createApprovalBenchmarkTool(commandBytes: number): ToolLike {
  return {
    name: "Bash",
    checkPermissions(input) {
      return {
        behavior: "ask" as const,
        message: `Permission required for ${String(
          (input as { command?: string }).command ?? "",
        ).slice(0, commandBytes)}`,
      };
    },
  };
}

async function createApprovalDecision(
  tool: ToolLike,
  input: Record<string, unknown>,
): Promise<void> {
  const appState: AppStateSnapshot = {
    toolPermissionContext: createEmptyToolPermissionContext(),
    denialTracking: freshDenialTracking(),
    autoModeActive: false,
  };
  const context = attachContextDefaults({
    getAppState() {
      return appState;
    },
    session: {} as ToolEvaluatorContext["session"],
  } as ToolEvaluatorContext);
  void (await hasPermissionsToUseTool(tool, input, context));
}

function computeStats(samples: ReadonlyArray<number>): BenchmarkStats {
  if (samples.length === 0) {
    throw new Error("Cannot compute stats for an empty sample set");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    minMs: sorted[0]!,
    maxMs: sorted[sorted.length - 1]!,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

function percentile(sorted: ReadonlyArray<number>, quantile: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  );
  return sorted[index]!;
}

function repeatText(character: string, size: number): string {
  return character.repeat(Math.max(1, size));
}

function readGitMetadata(): { commit: string | null; branch: string | null } {
  return {
    commit: readGitValue(["rev-parse", "HEAD"]),
    branch: readGitValue(["rev-parse", "--abbrev-ref", "HEAD"]),
  };
}

function readGitValue(args: ReadonlyArray<string>): string | null {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
