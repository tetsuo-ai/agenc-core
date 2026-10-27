import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  truncateSync,
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
    readonly jobs: ReadonlyArray<{
      readonly id: string;
      readonly status: string;
    }>;
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
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<void> {
  const marker = join(stateDirectory, "failpoint-reached.json");
  const env = { ...cleanChildEnvironment(), ...extraEnv };
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

async function connectFreshDaemon(stateDirectory: string): Promise<{
  readonly client: AgencClient;
  readonly stop: () => Promise<void>;
}> {
  const home = join(stateDirectory, "home");
  const cwd = join(stateDirectory, "workspace");
  chmodSync(home, 0o700);
  const env = {
    ...cleanChildEnvironment(),
    AGENC_HOME: home,
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
    expectedKeys = events.map((event) => `${event.sequence}:${event.eventId}`);
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
  if (failpoint === "after_tool_spawn") {
    // The exact effect boundary is crossed after admission is durably marked
    // dispatched and immediately before the adapter starts the operation.
    // Crashing at that instruction can therefore leave no observable receipt,
    // but absence of a receipt is not authoritative no-effect evidence.
    expect(report.toolPhysicalAttempts).toBe(0);
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
  if (failpoint === "before_tool_ack_commit") {
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

// ---------------------------------------------------------------------------
// Power loss inside a turn (turn-scoped durability).
//
// A SIGKILL keeps the page cache, so the matrix above never shows what an OS
// crash or power loss does to writes that were not fsynced. These cases run
// the same operations inside a turn scope, log the journal size at every
// fsync, cut the journal back to its last synced byte (SQLite keeps every
// commit), and require recovery to reach the same boundary as a process crash:
// every record another store references must still be in the journal.
// ---------------------------------------------------------------------------

const POWER_LOSS_LOG_ENV = "AGENC_TEST_TURN_POWER_LOSS_LOG";

function readSyncLog(log: string): Array<{ path: string; size: number }> {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { path: string; size: number });
}

/** Cut each logged journal back to its last fsynced byte; returns the bytes dropped. */
function cutJournalsToLastSync(log: string): number {
  const synced = new Map<string, number>();
  for (const entry of readSyncLog(log)) {
    synced.set(entry.path, Math.max(synced.get(entry.path) ?? 0, entry.size));
  }
  let dropped = 0;
  for (const [path, size] of synced) {
    const current = statSync(path).size;
    expect(current).toBeGreaterThanOrEqual(size);
    dropped += current - size;
    truncateSync(path, size);
  }
  return dropped;
}

const TURN_STEP_FAILPOINTS = M4_DURABILITY_FAILPOINTS.filter(
  (failpoint) =>
    failpoint === "after_admission_sqlite_commit_before_canonical_append" ||
    failpoint.includes("reservation_commit") ||
    failpoint.includes("model_response_commit") ||
    failpoint.includes("tool_"),
);

describe.sequential("M4 power loss inside a turn: the journal keeps only fsynced bytes", () => {
  it.each(TURN_STEP_FAILPOINTS)(
    "%s recovers to the same boundary as a process crash",
    { timeout: 120_000 },
    async (failpoint) => {
      const stateDirectory = mkdtempSync(
        join(tmpdir(), `agenc-m4-power-${TURN_STEP_FAILPOINTS.indexOf(failpoint)}-`),
      );
      directories.push(stateDirectory);
      const log = join(stateDirectory, "synced.jsonl");
      await crashAt(failpoint, stateDirectory, { [POWER_LOSS_LOG_ENV]: log });
      expect(readSyncLog(log).length).toBeGreaterThan(0);
      cutJournalsToLastSync(log);
      const report = await recoverAfter(failpoint, stateDirectory);
      verifyBoundary(failpoint, report);
    },
  );
});

interface StepsRecoveryReport {
  readonly canonicalEventCounts: Readonly<Record<string, number>>;
  readonly duplicateEventIds: number;
  readonly sequencesIncrease: boolean;
  readonly effects: ReadonlyArray<{
    readonly stepId: string;
    readonly outcome: string | null;
    readonly reviewStatus: string | null;
  }>;
  readonly effectsWithoutJournalIntent: number;
  readonly pendingEffectReviews: number;
  readonly unsettledIntents: number;
  readonly toolPhysicalAttempts: number;
  readonly reservations: Readonly<Record<string, number>>;
  readonly secondRecovery: {
    readonly requeuedJobIds: readonly string[];
    readonly heldUnknownReservationIds: readonly string[];
    readonly cancelledExpiredJobIds: readonly string[];
    readonly detachedQueuedJobIds: readonly string[];
  };
  /** Present when the recovery child compared the rollout's SQLite mirror. */
  readonly mirror?: {
    readonly before: MirrorComparison;
    readonly after: MirrorComparison;
  };
}

interface MirrorComparison {
  readonly journalRows: number;
  readonly mirrorRows: number;
  readonly missing: number;
  readonly extra: number;
  readonly equal: boolean;
}

async function runStepsChild(
  stateDirectory: string,
  log: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<void> {
  const child = spawn(
    process.execPath,
    ["--loader", NODE_TEST_LOADER, "--import", TSX_IMPORT, FIXTURE, "steps", "after_tool_ack_commit", stateDirectory],
    {
      cwd: dirname(dirname(dirname(dirname(FIXTURE)))),
      env: { ...cleanChildEnvironment(), [POWER_LOSS_LOG_ENV]: log, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const result = await collectChild(child);
  expect(
    result,
    `steps child output:\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  ).toMatchObject({ code: null, signal: "SIGKILL" });
}

async function recoverStepsChild(
  stateDirectory: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<StepsRecoveryReport> {
  const child = spawn(
    process.execPath,
    ["--loader", NODE_TEST_LOADER, "--import", TSX_IMPORT, FIXTURE, "recover-steps", "after_tool_ack_commit", stateDirectory],
    {
      cwd: dirname(dirname(dirname(dirname(FIXTURE)))),
      env: { ...cleanChildEnvironment(), ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const result = await collectChild(child);
  expect(
    result,
    `steps recovery output:\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  ).toMatchObject({ code: 0, signal: null });
  const lines = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as StepsRecoveryReport;
}

/** Put an image back in place: recovery state holds absolute journal paths. */
function restoreImage(stateDirectory: string, image: string): void {
  for (const name of ["home", "workspace", "physical"]) {
    rmSync(join(stateDirectory, name), { recursive: true, force: true });
    const source = join(image, name);
    if (existsSync(source)) cpSync(source, join(stateDirectory, name), { recursive: true });
  }
}

function expectConsistentRecovery(report: StepsRecoveryReport): void {
  expect(report.duplicateEventIds).toBe(0);
  expect(report.sequencesIncrease).toBe(true);
  // SQLite never holds an effect the journal lost.
  expect(report.effectsWithoutJournalIntent).toBe(0);
  expect(report.unsettledIntents).toBe(0);
  expect(report.secondRecovery).toMatchObject({
    requeuedJobIds: [],
    heldUnknownReservationIds: [],
    cancelledExpiredJobIds: [],
    detachedQueuedJobIds: [],
  });
}

describe.sequential("M4 kernel-panic images of a multi-step turn", () => {
  it(
    "recovers every image cut to its last fsynced byte to a consistent point",
    { timeout: 240_000 },
    async () => {
      const stateDirectory = mkdtempSync(join(tmpdir(), "agenc-m4-steps-"));
      directories.push(stateDirectory);
      const log = join(stateDirectory, "synced.jsonl");
      await runStepsChild(stateDirectory, log);
      // F: the daemon died inside step 4's side effect. Save that state as an
      // image too (restoreImage copies its second argument into its first).
      const finalImage = join(stateDirectory, "images", "F");
      restoreImage(finalImage, stateDirectory);
      const journal = JSON.parse(
        readFileSync(join(stateDirectory, "journal.json"), "utf8"),
      ) as { rolloutPath: string };
      const finalSynced = readSyncLog(log)
        .filter((entry) => entry.path === journal.rolloutPath)
        .reduce((max, entry) => Math.max(max, entry.size), 0);

      // Between steps (P1..P3): every effect so far committed, nothing to review.
      for (const step of [1, 2, 3]) {
        const image = join(stateDirectory, "images", `P${step}`);
        const meta = JSON.parse(readFileSync(join(image, "journal.json"), "utf8")) as {
          rolloutPath: string;
          syncedSize: number;
          size: number;
        };
        restoreImage(stateDirectory, image);
        expect(meta.size).toBeGreaterThanOrEqual(meta.syncedSize);
        truncateSync(meta.rolloutPath, meta.syncedSize);
        const report = await recoverStepsChild(stateDirectory);
        expectConsistentRecovery(report);
        expect(report.effects).toHaveLength(step);
        expect(report.effects.every((effect) => effect.outcome === "committed")).toBe(true);
        expect(report.pendingEffectReviews).toBe(0);
      }

      // F after a process crash (control) and after a power loss: the side
      // effect in flight is uncertain and waits for review; it is never re-run.
      for (const cut of [false, true]) {
        restoreImage(stateDirectory, finalImage);
        if (cut) {
          expect(statSync(journal.rolloutPath).size).toBeGreaterThan(finalSynced);
          truncateSync(journal.rolloutPath, finalSynced);
        }
        const report = await recoverStepsChild(stateDirectory);
        expectConsistentRecovery(report);
        expect(report.effects).toHaveLength(4);
        expect(report.effects.filter((effect) => effect.outcome === "committed")).toHaveLength(3);
        expect(report.effects.filter((effect) => effect.outcome === "unknown_outcome")).toHaveLength(1);
        expect(report.pendingEffectReviews).toBe(1);
        expect(report.toolPhysicalAttempts).toBe(4);
      }
    },
  );
});


// ---------------------------------------------------------------------------
// Power loss after rebuildable mirror commits.
//
// The rollout's SQLite mirror (`thread_rollout_items`, kept current after
// every rollout commit as FileThreadStore does for a live recorder) commits
// at synchronous=NORMAL. Its commits reach the disk with the next FULL commit
// on the database, so a power loss can drop every mirror commit after the
// last FULL one, and nothing else: WAL recovery keeps a prefix of the commit
// sequence. These images cut the WAL back to the end of the last FULL commit
// and the journal either to its last fsynced byte (nothing flushed since) or
// not at all (its deferred fsync landed, the WAL's did not). Recovery must
// reach the same boundary as before, and the mirror must equal a fresh
// projection of the recovered journal.
// ---------------------------------------------------------------------------

const MIRROR_WAL_LOG_ENV = "AGENC_TEST_MIRROR_WAL_LOG";
const MIRROR_RECOVERY_ENV = "AGENC_TEST_MIRROR_RECOVERY";

interface WalMark {
  readonly before: number;
  readonly after: number;
  readonly saltBefore: string;
  readonly salt: string;
}

function readWalMarks(log: string): WalMark[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as WalMark);
}

function walHeader(stateDbPath: string): { readonly bytes: number; readonly salt: string } {
  const fd = openSync(`${stateDbPath}-wal`, "r");
  try {
    const salt = Buffer.alloc(8);
    expect(readSync(fd, salt, 0, 8, 16)).toBe(8);
    return { bytes: statSync(`${stateDbPath}-wal`).size, salt: salt.toString("hex") };
  } finally {
    closeSync(fd);
  }
}

/**
 * The WAL bytes a power loss keeps: the end of the last FULL commit. Every
 * logged mark is a NORMAL mirror commit; any other WAL growth is a FULL
 * commit, which fsyncs the WAL up to its end. So if the WAL grew after the
 * last mark, everything is durable; otherwise the durable end is the start of
 * the trailing run of back-to-back mirror commits.
 */
function durableWalBytes(marks: readonly WalMark[], wal: { readonly bytes: number; readonly salt: string }): number {
  // The WAL never restarted during the run, so its byte offsets are comparable.
  for (const mark of marks) {
    expect(mark.saltBefore).toBe(wal.salt);
    expect(mark.salt).toBe(wal.salt);
  }
  const last = marks.at(-1);
  if (last === undefined) return wal.bytes;
  expect(wal.bytes).toBeGreaterThanOrEqual(last.after);
  if (wal.bytes > last.after) return wal.bytes;
  let first = marks.length - 1;
  while (first > 0 && marks[first - 1]!.after === marks[first]!.before) first -= 1;
  return marks[first]!.before;
}

/** Cut the WAL to `bytes`; the shared-memory index is rebuilt from it, as after a reboot. */
function cutWal(stateDbPath: string, bytes: number): number {
  const dropped = statSync(`${stateDbPath}-wal`).size - bytes;
  truncateSync(`${stateDbPath}-wal`, bytes);
  rmSync(`${stateDbPath}-shm`, { force: true });
  return dropped;
}

describe.sequential("M4 power loss after rebuildable mirror commits", () => {
  it(
    "recovers every image with the WAL cut to its last FULL commit, and the mirror equals the journal",
    { timeout: 300_000 },
    async () => {
      const stateDirectory = mkdtempSync(join(tmpdir(), "agenc-m4-mirror-"));
      directories.push(stateDirectory);
      const log = join(stateDirectory, "synced.jsonl");
      const walLog = join(stateDirectory, "wal.jsonl");
      await runStepsChild(stateDirectory, log, { [MIRROR_WAL_LOG_ENV]: walLog });
      const marks = readWalMarks(walLog);
      expect(marks.length).toBeGreaterThan(0);
      const finalImage = join(stateDirectory, "images", "F");
      restoreImage(finalImage, stateDirectory);
      const final = JSON.parse(readFileSync(join(stateDirectory, "journal.json"), "utf8")) as {
        rolloutPath: string;
        stateDbPath: string;
      };
      const finalSynced = readSyncLog(log)
        .filter((entry) => entry.path === final.rolloutPath)
        .reduce((max, entry) => Math.max(max, entry.size), 0);

      let walBytesDropped = 0;
      let mirrorRowsReprojected = 0;
      for (const name of ["P1", "P2", "P3", "F"]) {
        const image = join(stateDirectory, "images", name);
        const meta = name === "F"
          ? { ...final, syncedSize: finalSynced, walLogEntries: marks.length }
          : (JSON.parse(readFileSync(join(image, "journal.json"), "utf8")) as {
              rolloutPath: string;
              stateDbPath: string;
              syncedSize: number;
              walLogEntries: number;
            });
        for (const journalCut of [true, false]) {
          restoreImage(stateDirectory, image);
          const durable = durableWalBytes(marks.slice(0, meta.walLogEntries), walHeader(meta.stateDbPath));
          walBytesDropped += cutWal(meta.stateDbPath, durable);
          if (journalCut) truncateSync(meta.rolloutPath, meta.syncedSize);
          const report = await recoverStepsChild(stateDirectory, { [MIRROR_RECOVERY_ENV]: "1" });
          const label = `${name} journal ${journalCut ? "cut" : "whole"}`;
          expectConsistentRecovery(report);
          if (name === "F") {
            expect(report.effects, label).toHaveLength(4);
            expect(report.effects.filter((effect) => effect.outcome === "committed"), label).toHaveLength(3);
            expect(report.effects.filter((effect) => effect.outcome === "unknown_outcome"), label).toHaveLength(1);
            expect(report.pendingEffectReviews, label).toBe(1);
            expect(report.toolPhysicalAttempts, label).toBe(4);
          } else {
            const step = Number(name.slice(1));
            expect(report.effects, label).toHaveLength(step);
            expect(report.effects.every((effect) => effect.outcome === "committed"), label).toBe(true);
            expect(report.pendingEffectReviews, label).toBe(0);
          }
          expect(report.mirror?.after, label).toMatchObject({ equal: true, missing: 0, extra: 0 });
          expect(report.mirror!.after.mirrorRows, label).toBeGreaterThan(0);
          mirrorRowsReprojected += report.mirror!.before.missing;
        }
      }
      // The cuts dropped mirror commits, and recovery re-projected rows the
      // journal kept but the mirror had lost.
      expect(walBytesDropped).toBeGreaterThan(0);
      expect(mirrorRowsReprojected).toBeGreaterThan(0);
    },
  );
});
