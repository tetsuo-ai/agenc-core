import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  AgencRunReplayGapError,
  connect,
  type AgencClient,
} from "../../../packages/agenc-sdk/src/index";

import {
  M4_DURABILITY_FAILPOINTS,
  type M4DurabilityFailpoint,
} from "../../src/durability/failpoints.js";

const FIXTURE = fileURLToPath(
  new URL("./fixtures/m4-failure-matrix-child.ts", import.meta.url),
);
const NODE_TEST_LOADER = fileURLToPath(
  new URL("./fixtures/node-test-loader.mjs", import.meta.url),
);
const DAEMON_FIXTURE = fileURLToPath(
  new URL("./fixtures/daemon-main-child.ts", import.meta.url),
);
const TSX_IMPORT = fileURLToPath(import.meta.resolve("tsx"));
const FAILPOINT_TOKEN = "m4-durability-child";

interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface RecoveryReport {
  readonly failpoint: M4DurabilityFailpoint;
  readonly canonicalEventCounts: Readonly<Record<string, number>>;
  readonly modelPhysicalAttempts: number;
  readonly toolPhysicalAttempts: number;
  readonly admission?: {
    readonly effect?: {
      readonly outcome?: string;
      readonly reviewStatus?: string;
    };
    readonly effectRecovery: string;
    readonly pendingEffectReviews: number;
    readonly jobs: ReadonlyArray<{ readonly id: string; readonly status: string }>;
    readonly reservations: ReadonlyArray<{
      readonly id: string;
      readonly status: string;
    }>;
    readonly journalCounts: Readonly<Record<string, number>>;
    readonly secondRecovery: {
      readonly requeuedJobIds: readonly string[];
      readonly heldUnknownReservationIds: readonly string[];
      readonly cancelledExpiredJobIds: readonly string[];
      readonly detachedQueuedJobIds: readonly string[];
    };
  };
  readonly artifact?: {
    readonly targetState: "missing" | "complete";
    readonly bytes?: string;
    readonly visibleTargets: number;
    readonly orphanTemps: number;
    readonly intentSequences: readonly number[];
    readonly committedOutcomes: readonly string[];
    readonly committedIntentSequences: readonly number[];
    readonly recoveryDecisions: readonly string[];
    readonly recoveryEvidenceSequences: readonly number[];
  };
  readonly publication?: {
    readonly canonicalCount: number;
    readonly canonicalCoordinates: ReadonlyArray<{
      readonly eventId: string;
      readonly sequence: number;
    }>;
    readonly liveObservations: ReadonlyArray<{
      readonly surface: string;
      readonly eventId: string;
      readonly sequence: number;
    }>;
    readonly reconnectUniqueDeliveries: number;
  };
  readonly terminal?: {
    readonly canonicalCount: number;
    readonly firstProjectionApplied: boolean;
    readonly secondProjectionApplied: boolean;
    readonly history: ReadonlyArray<{
      readonly status: string;
      readonly finalMessage: string | null;
      readonly eventId: string;
    }>;
  };
}

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function cleanChildEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AGENC_TEST_DURABILITY_FAILPOINT;
  delete env.AGENC_TEST_DURABILITY_FAILPOINT_TOKEN;
  delete env.AGENC_TEST_DURABILITY_FAILPOINT_ACTION;
  delete env.AGENC_TEST_DURABILITY_FAILPOINT_MARKER;
  return env;
}

function collectChild(child: ChildProcess): Promise<ChildExit> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function waitForMarker(
  marker: string,
  child: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!existsSync(marker)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `crash child exited before reaching failpoint marker: code=${child.exitCode} signal=${child.signalCode}`,
      );
    }
    if (Date.now() >= deadline) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      throw new Error(`timed out waiting for failpoint marker: ${marker}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function crashAt(
  failpoint: M4DurabilityFailpoint,
  stateDirectory: string,
): Promise<void> {
  const marker = join(stateDirectory, "failpoint-reached.json");
  const env = cleanChildEnvironment();
  env.AGENC_TEST_DURABILITY_FAILPOINT = failpoint;
  env.AGENC_TEST_DURABILITY_FAILPOINT_TOKEN = FAILPOINT_TOKEN;
  env.AGENC_TEST_DURABILITY_FAILPOINT_MARKER = marker;
  const child = spawn(
    process.execPath,
    [
      "--loader",
      NODE_TEST_LOADER,
      "--import",
      TSX_IMPORT,
      FIXTURE,
      "crash",
      failpoint,
      stateDirectory,
    ],
    {
      cwd: dirname(dirname(dirname(dirname(FIXTURE)))),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exitPromise = collectChild(child);
  try {
    await waitForMarker(marker, child);
  } catch (error) {
    const result = await exitPromise;
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        `stdout=${result.stdout}\nstderr=${result.stderr}`,
    );
  }
  const result = await exitPromise;
  expect(
    result,
    `crash child output:\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  ).toMatchObject({ code: null, signal: "SIGKILL" });
  expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({
    failpoint,
  });
}

async function recoverAfter(
  failpoint: M4DurabilityFailpoint,
  stateDirectory: string,
): Promise<RecoveryReport> {
  const child = spawn(
    process.execPath,
    [
      "--loader",
      NODE_TEST_LOADER,
      "--import",
      TSX_IMPORT,
      FIXTURE,
      "recover",
      failpoint,
      stateDirectory,
    ],
    {
      cwd: dirname(dirname(dirname(dirname(FIXTURE)))),
      env: cleanChildEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const result = await collectChild(child);
  expect(
    result,
    `recovery child output:\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  ).toMatchObject({ code: 0, signal: null });
  const lines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as RecoveryReport;
}

async function connectFreshDaemon(
  stateDirectory: string,
): Promise<{
  readonly client: AgencClient;
  readonly stop: () => Promise<void>;
}> {
  const home = join(stateDirectory, "home");
  const cwd = join(stateDirectory, "workspace");
  const env = {
    ...cleanChildEnvironment(),
    AGENC_HOME: home,
    AGENC_CONFIG_DIR: home,
    HOME: home,
  };
  const daemon = spawn(
    process.execPath,
    [
      "--loader",
      NODE_TEST_LOADER,
      "--import",
      TSX_IMPORT,
      DAEMON_FIXTURE,
      "daemon",
      "start",
      "--foreground",
    ],
    { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const exit = collectChild(daemon);
  const deadline = Date.now() + 20_000;
  let lastError: unknown;
  let client: AgencClient | undefined;
  while (Date.now() < deadline && daemon.exitCode === null) {
    try {
      client = await connect({
        env,
        autostart: false,
        readyTimeoutMs: 250,
        requestTimeoutMs: 5_000,
        clientId: `m4-sdk-${process.pid}`,
      });
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (client === undefined) {
    if (daemon.exitCode === null) daemon.kill("SIGKILL");
    const result = await exit;
    throw new Error(
      `fresh daemon did not become SDK-ready: ${String(lastError)}\n` +
        `stdout=${result.stdout}\nstderr=${result.stderr}`,
    );
  }
  return {
    client,
    stop: async () => {
      await client!.close();
      if (daemon.exitCode === null && daemon.signalCode === null) {
        daemon.kill("SIGTERM");
      }
      const stopped = await Promise.race([
        exit,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
      ]);
      if (stopped === null) {
        daemon.kill("SIGKILL");
        await exit;
      }
    },
  };
}

async function verifyFreshDaemonSdk(
  failpoint: M4DurabilityFailpoint,
  stateDirectory: string,
): Promise<void> {
  const first = await connectFreshDaemon(stateDirectory);
  let cursor = 0;
  let midpoint = 0;
  let expectedKeys: string[] = [];
  try {
    const attachment = first.client.reattachRun({
      runId: "m4-failure-matrix-run",
      afterSequence: 0,
    });
    const events = [];
    for await (const event of attachment) events.push(event);
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: events.length }, (_, index) => index + 1),
    );
    expectedKeys = events.map(
      (event) => `${event.sequence}:${event.eventId}`,
    );
    expect(new Set(expectedKeys).size).toBe(expectedKeys.length);
    cursor = attachment.cursor().afterSequence;
    expect(cursor).toBe(events.at(-1)?.sequence);
    midpoint = events[Math.floor((events.length - 1) / 2)]!.sequence;
    if (failpoint.includes("event_publish")) {
      expect(events).toContainEqual(
        expect.objectContaining({ eventId: "publish-event-1" }),
      );
    }
    if (failpoint.includes("terminal_commit")) {
      expect(events).toContainEqual(
        expect.objectContaining({ eventId: "run-terminal-1" }),
      );
      await expect(attachment.result()).resolves.toMatchObject({
        terminal: true,
        output: {
          available: true,
          finalMessage: "finished once",
          lastSequence: 1,
        },
      });
    }

    const wrongCursor = first.client.reattachRun({
      runId: "m4-failure-matrix-run",
      afterSequence: cursor + 99,
    });
    await expect(async () => {
      for await (const _event of wrongCursor) void _event;
    }).rejects.toMatchObject({
      name: AgencRunReplayGapError.name,
      gap: { kind: "cursor_ahead" },
    });
    expect(wrongCursor.cursor()).toEqual({
      runId: "m4-failure-matrix-run",
      afterSequence: cursor + 99,
    });
  } finally {
    await first.stop();
  }

  const second = await connectFreshDaemon(stateDirectory);
  try {
    const replayedFromStart = second.client.reattachRun({
      runId: "m4-failure-matrix-run",
      afterSequence: 0,
    });
    const replayedKeys = [];
    for await (const event of replayedFromStart) {
      replayedKeys.push(`${event.sequence}:${event.eventId}`);
    }
    expect(replayedKeys).toEqual(expectedKeys);

    const resumedFromMidpoint = second.client.reattachRun({
      runId: "m4-failure-matrix-run",
      afterSequence: midpoint,
    });
    const suffixKeys = [];
    for await (const event of resumedFromMidpoint) {
      suffixKeys.push(`${event.sequence}:${event.eventId}`);
    }
    expect(suffixKeys).toEqual(
      expectedKeys.filter(
        (key) => Number(key.slice(0, key.indexOf(":"))) > midpoint,
      ),
    );

    const resumedAtTail = second.client.reattachRun({
      runId: "m4-failure-matrix-run",
      afterSequence: cursor,
    });
    const redelivered = [];
    for await (const event of resumedAtTail) redelivered.push(event);
    expect(redelivered).toEqual([]);
    expect(resumedAtTail.cursor()).toEqual({
      runId: "m4-failure-matrix-run",
      afterSequence: cursor,
    });
  } finally {
    await second.stop();
  }
}

function expectIdempotentSecondRecovery(report: RecoveryReport): void {
  expect(report.admission?.secondRecovery).toMatchObject({
    requeuedJobIds: [],
    heldUnknownReservationIds: [],
    cancelledExpiredJobIds: [],
    detachedQueuedJobIds: [],
  });
}

function verifyBoundary(
  failpoint: M4DurabilityFailpoint,
  report: RecoveryReport,
): void {
  expect(report.failpoint).toBe(failpoint);

  if (
    failpoint === "after_admission_sqlite_commit_before_canonical_append" ||
    failpoint === "before_reservation_commit"
  ) {
    expect(report.admission?.reservations).toEqual([]);
    expect(report.admission?.jobs).toHaveLength(1);
    expect(report.admission?.jobs[0]?.status).toBe("queued");
    expect(report.admission?.journalCounts.allowed ?? 0).toBe(0);
    expect(report.admission?.journalCounts.queued).toBe(1);
    expect(report.admission?.journalCounts.recovered).toBe(1);
    expectIdempotentSecondRecovery(report);
    return;
  }
  if (failpoint === "after_reservation_commit") {
    expect(report.admission?.reservations).toHaveLength(1);
    expect(report.admission?.reservations[0]?.status).toBe("voided");
    expect(report.admission?.journalCounts.allowed).toBe(1);
    expect(report.admission?.journalCounts.voided).toBe(1);
    expectIdempotentSecondRecovery(report);
    return;
  }
  if (failpoint === "before_model_response_commit") {
    expect(report.modelPhysicalAttempts).toBe(1);
    expect(report.admission?.reservations[0]?.status).toBe("held_unknown");
    expect(report.admission?.journalCounts.allowed).toBe(1);
    expect(report.admission?.journalCounts.dispatched).toBe(1);
    expect(report.admission?.journalCounts.held_unknown).toBe(1);
    expectIdempotentSecondRecovery(report);
    return;
  }
  if (failpoint === "after_model_response_commit") {
    expect(report.modelPhysicalAttempts).toBe(1);
    expect(report.admission?.reservations[0]?.status).toBe("reconciled");
    expect(report.admission?.journalCounts.allowed).toBe(1);
    expect(report.admission?.journalCounts.dispatched).toBe(1);
    expect(report.admission?.journalCounts.reconciled).toBe(1);
    expectIdempotentSecondRecovery(report);
    return;
  }
  if (failpoint === "before_tool_spawn") {
    expect(report.toolPhysicalAttempts).toBe(0);
    expect(report.admission?.reservations[0]?.status).toBe("voided");
    expect(report.admission?.effect).toMatchObject({
      outcome: "cancelled",
      reviewStatus: "none",
    });
    expect(report.admission?.effectRecovery).toBe("cancelled_before_dispatch");
    expect(report.admission?.pendingEffectReviews).toBe(0);
    expect(report.canonicalEventCounts.effect_intent).toBe(1);
    expect(report.canonicalEventCounts.effect_result).toBe(1);
    expect(report.canonicalEventCounts.effect_unknown_outcome ?? 0).toBe(0);
    expectIdempotentSecondRecovery(report);
    return;
  }
  if (
    failpoint === "after_tool_spawn" ||
    failpoint === "before_tool_ack_commit"
  ) {
    expect(report.toolPhysicalAttempts).toBe(1);
    expect(report.admission?.reservations[0]?.status).toBe("held_unknown");
    expect(report.admission?.effect).toMatchObject({
      outcome: "unknown_outcome",
      reviewStatus: "pending",
    });
    expect(report.admission?.effectRecovery).toBe(
      "review_locked_unknown_outcome",
    );
    expect(report.admission?.pendingEffectReviews).toBe(1);
    expect(report.canonicalEventCounts.effect_intent).toBe(1);
    expect(report.canonicalEventCounts.effect_result ?? 0).toBe(0);
    expect(report.canonicalEventCounts.effect_unknown_outcome).toBe(1);
    expectIdempotentSecondRecovery(report);
    return;
  }
  if (failpoint === "after_tool_ack_commit") {
    expect(report.toolPhysicalAttempts).toBe(1);
    expect(report.admission?.reservations[0]?.status).toBe("reconciled");
    expect(report.admission?.effect).toMatchObject({
      outcome: "committed",
      reviewStatus: "none",
    });
    expect(report.admission?.effectRecovery).toBe(
      "acknowledged_from_durable_result",
    );
    expect(report.admission?.pendingEffectReviews).toBe(0);
    expect(report.canonicalEventCounts.effect_intent).toBe(1);
    expect(report.canonicalEventCounts.effect_result).toBe(1);
    expect(report.canonicalEventCounts.effect_unknown_outcome ?? 0).toBe(0);
    expectIdempotentSecondRecovery(report);
    return;
  }
  if (failpoint === "before_artifact_commit") {
    expect(report.artifact).toMatchObject({
      targetState: "missing",
      visibleTargets: 0,
      orphanTemps: 0,
      intentSequences: [1],
      committedOutcomes: [],
      committedIntentSequences: [],
      recoveryDecisions: ["artifact_retry_safe_deferred"],
      recoveryEvidenceSequences: [1],
    });
    expect(report.canonicalEventCounts.artifact_intent).toBe(1);
    expect(report.canonicalEventCounts.artifact_committed ?? 0).toBe(0);
    expect(report.canonicalEventCounts.recovery_decision).toBe(1);
    return;
  }
  if (failpoint === "after_artifact_commit") {
    expect(report.artifact).toMatchObject({
      targetState: "complete",
      bytes: "complete artifact bytes",
      visibleTargets: 1,
      orphanTemps: 0,
      intentSequences: [1],
      committedOutcomes: ["recovered"],
      committedIntentSequences: [1],
      recoveryDecisions: [],
      recoveryEvidenceSequences: [],
    });
    expect(report.canonicalEventCounts.artifact_intent).toBe(1);
    expect(report.canonicalEventCounts.artifact_committed).toBe(1);
    expect(report.canonicalEventCounts.recovery_decision ?? 0).toBe(0);
    return;
  }
  if (
    failpoint === "before_event_publish" ||
    failpoint === "after_event_publish"
  ) {
    expect(report.publication).toMatchObject({
      canonicalCount: 1,
      reconnectUniqueDeliveries: 1,
      canonicalCoordinates: [{ eventId: "publish-event-1", sequence: 1 }],
    });
    const live = report.publication?.liveObservations ?? [];
    expect(live).toHaveLength(failpoint === "before_event_publish" ? 0 : 2);
    expect(new Set(live.map((observation) => observation.surface))).toEqual(
      failpoint === "before_event_publish"
        ? new Set()
        : new Set(["event_log", "tx_event"]),
    );
    return;
  }
  if (
    failpoint === "before_terminal_commit" ||
    failpoint === "after_terminal_commit"
  ) {
    expect(report.terminal).toMatchObject({
      canonicalCount: 1,
      firstProjectionApplied: failpoint === "before_terminal_commit",
      secondProjectionApplied: false,
      history: [
        {
          status: "completed",
          finalMessage: "finished once",
          eventId: "run-terminal-1",
        },
      ],
    });
  }
}

describe.sequential("M4 SIGKILL crash/restart acceptance matrix", () => {
  it.each(M4_DURABILITY_FAILPOINTS)(
    "%s leaves an explainable, replay-safe durable state",
    { timeout: 120_000 },
    async (failpoint) => {
      const stateDirectory = mkdtempSync(
        join(
          tmpdir(),
          `agenc-m4-${M4_DURABILITY_FAILPOINTS.indexOf(failpoint)}-`,
        ),
      );
      directories.push(stateDirectory);
      await crashAt(failpoint, stateDirectory);
      const report = await recoverAfter(failpoint, stateDirectory);
      verifyBoundary(failpoint, report);
      await verifyFreshDaemonSdk(failpoint, stateDirectory);
    },
  );
});
