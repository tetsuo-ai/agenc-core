import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  clearCurrentRuntimeSession,
  getCurrentRuntimeSession,
  setCurrentRuntimeSession,
} from "./current-session.js";
import type { Session } from "./session.js";
import type { AgentMetadata } from "../agents/registry.js";
import { upsertAgentRun } from "../state/agent-runs.js";
import { createOperatorEffectReviewResolution } from "../state/effect-review.js";
import {
  openStateDatabases,
  resolveStateDatabasePaths,
} from "../state/sqlite-driver.js";
import type { Event } from "./event-log.js";
import { RolloutStore } from "./rollout-store.js";
import { getProjectDir, getSessionDir } from "./session-store.js";

const TEST_RUN_TIMESTAMP = "2026-08-03T00:00:00.000Z";

let agencHome = "";
let originalAgencHome = "";

function openStore(opts: {
  cwd: string;
  sessionId: string;
  resume?: boolean;
  reopenTerminalRun?: boolean;
  resumeSuspendedRun?: boolean;
  suspendedResumeReason?: "daemon_startup_restore" | "explicit_continue";
  sessionTempRoot?: string;
}): RolloutStore {
  const store = new RolloutStore({
    cwd: opts.cwd,
    sessionId: opts.sessionId,
    agencVersion: "0.2.0",
    sessionTempRoot:
      opts.sessionTempRoot ?? join(agencHome, "rollout-temp"),
    ...(opts.resume ? { resume: true } : {}),
    ...(opts.reopenTerminalRun ? { reopenTerminalRun: true } : {}),
    ...(opts.resumeSuspendedRun ? { resumeSuspendedRun: true } : {}),
    ...(opts.suspendedResumeReason !== undefined
      ? { suspendedResumeReason: opts.suspendedResumeReason }
      : {}),
  });
  store.open({
    sessionId: opts.sessionId,
    timestamp: new Date().toISOString(),
    cwd: opts.cwd,
    originator: "rollout-store-test",
    agencVersion: "0.2.0",
    model: "test-model",
    modelProvider: "test-provider",
  });
  return store;
}

function seedRunningAgentRun(cwd: string, runId: string): void {
  const driver = openStateDatabases({ cwd });
  try {
    upsertAgentRun(driver, {
      id: runId,
      objective: "rollout-store spawn-edge test fixture",
      status: "running",
      startedAt: TEST_RUN_TIMESTAMP,
      lastActiveAt: TEST_RUN_TIMESTAMP,
    });
  } finally {
    driver.close();
  }
}

function createAdmittedThreadSpawnEdge(
  store: RolloutStore,
  cwd: string,
  edge: Parameters<RolloutStore["createThreadSpawnEdge"]>[0],
): void {
  seedRunningAgentRun(cwd, edge.parentThreadId);
  store.createThreadSpawnEdge(edge);
}

function metadata(
  agentId: string,
  agentPath: string,
  depth: number,
): AgentMetadata {
  return {
    agentId,
    agentPath,
    agentNickname: agentPath.split("/").at(-1) ?? agentId,
    agentRole: "default",
    depth,
  };
}

function appendReviewedReopenFixture(
  store: RolloutStore,
  sessionId: string,
  reviewBeforeReopen: boolean,
): void {
  const intent: Event = {
    eventId: `effect-intent:${sessionId}`,
    id: `effect-intent:${sessionId}`,
    seq: 1,
    msg: {
      type: "effect_intent",
      payload: {
        formatVersion: 2,
        minimumReaderRuntime: "0.14.0",
        runId: sessionId,
        stepId: "step-reviewed",
        callId: "call-reviewed",
        toolName: "side-effecting-test",
        recoveryCategory: "side-effecting",
        intentDigest: "digest-reviewed",
        attempt: 1,
        recordedAt: "2026-08-19T00:00:00.000Z",
      },
    },
  };
  const unknown: Event = {
    eventId: `effect-unknown:${sessionId}`,
    id: `effect-unknown:${sessionId}`,
    seq: 2,
    msg: {
      type: "effect_unknown_outcome",
      payload: {
        formatVersion: 2,
        minimumReaderRuntime: "0.14.0",
        runId: sessionId,
        stepId: "step-reviewed",
        callId: "call-reviewed",
        toolName: "side-effecting-test",
        recoveryCategory: "side-effecting",
        intentEventSeq: 1,
        outcome: "unknown_outcome",
        reason: "acknowledgement_lost",
        requiresReview: true,
        recordedAt: "2026-08-19T00:00:01.000Z",
      },
    },
  };
  const terminal: Event = {
    eventId: `run-terminal:${sessionId}:1`,
    id: `run-terminal:${sessionId}:1`,
    seq: 3,
    msg: {
      type: "run_terminal",
      payload: {
        runId: sessionId,
        epoch: 1,
        status: "completed",
        exitCode: 0,
        stopReason: "turn_completed",
        finalMessage: "done",
        usage: null,
        lastSequenceBeforeTerminal: 2,
        finishedAt: "2026-08-19T00:00:02.000Z",
      },
    },
  };
  const review: Event = {
    eventId: `effect-review:${sessionId}`,
    id: `effect-review:${sessionId}`,
    seq: reviewBeforeReopen ? 4 : 5,
    msg: {
      type: "effect_review_resolved",
      payload: {
        runId: sessionId,
        stepId: "step-reviewed",
        callId: "call-reviewed",
        resolution: createOperatorEffectReviewResolution({
          disposition: "confirmed_committed",
          actorId: "operator-reviewed",
          evidenceRef: "operator-observation:reviewed",
          evidenceSha256: "b".repeat(64),
          reviewedAt: "2026-08-19T00:00:03.000Z",
        }),
      },
    },
  };
  const reopened: Event = {
    eventId: `run-reopened:${sessionId}:2`,
    id: `run-reopened:${sessionId}:2`,
    seq: reviewBeforeReopen ? 5 : 4,
    msg: {
      type: "run_reopened",
      payload: {
        runId: sessionId,
        previousEpoch: 1,
        epoch: 2,
        reason: "user_session_continue",
        reopenedAt: "2026-08-19T00:00:04.000Z",
      },
    },
  };
  for (const event of [
    intent,
    unknown,
    terminal,
    ...(reviewBeforeReopen ? [review, reopened] : [reopened, review]),
  ]) {
    expect(store.append(event, { durable: true })).toBe(true);
  }
}

beforeEach(() => {
  agencHome = mkdtempSync(join(tmpdir(), "agenc-rollout-store-home-"));
  originalAgencHome = process.env.AGENC_HOME ?? "";
  process.env.AGENC_HOME = agencHome;
});

afterEach(() => {
  clearCurrentRuntimeSession();
  if (originalAgencHome) process.env.AGENC_HOME = originalAgencHome;
  else delete process.env.AGENC_HOME;
  if (agencHome) rmSync(agencHome, { recursive: true, force: true });
});

describe("RolloutStore temporary authority", () => {
  it("rejects a relative session temp root", () => {
    expect(
      () =>
        new RolloutStore({
          cwd: agencHome,
          sessionId: "relative-temp-root",
          agencVersion: "0.2.0",
          sessionTempRoot: "relative-temp",
        }),
    ).toThrow(/sessionTempRoot must be absolute/u);
  });

  it("opens with its captured root while ambient session selection is ambiguous", () => {
    const cwdA = mkdtempSync(join(tmpdir(), "agenc-rollout-cwd-a-"));
    const cwdB = mkdtempSync(join(tmpdir(), "agenc-rollout-cwd-b-"));
    const rootA = join(agencHome, "session-temp-a");
    const rootB = join(agencHome, "session-temp-b");
    const sessionA = { conversationId: "ambient-a" } as Session;
    const sessionB = { conversationId: "ambient-b" } as Session;
    setCurrentRuntimeSession(sessionA);
    setCurrentRuntimeSession(sessionB);
    expect(() => getCurrentRuntimeSession()).toThrow(/Ambiguous runtime session/u);

    let storeA: RolloutStore | undefined;
    let storeB: RolloutStore | undefined;
    try {
      storeA = openStore({
        cwd: cwdA,
        sessionId: "captured-root-a",
        sessionTempRoot: rootA,
      });
      storeB = openStore({
        cwd: cwdB,
        sessionId: "captured-root-b",
        sessionTempRoot: rootB,
      });
      expect(storeA.sessionTempRoot).toBe(rootA);
      expect(storeB.sessionTempRoot).toBe(rootB);
      expect(readdirSync(rootA)).toEqual([]);
      expect(readdirSync(rootB)).toEqual([]);
    } finally {
      storeA?.close();
      storeB?.close();
      clearCurrentRuntimeSession();
      rmSync(cwdA, { recursive: true, force: true });
      rmSync(cwdB, { recursive: true, force: true });
    }
  });
});

describe("RolloutStore thread-spawn edges", () => {
  it("redacts secrets from persisted live transcript rows", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "transcript-secret";
    const store = openStore({ cwd, sessionId });
    const rawSecret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456-";
    const opaqueSecret = "opaque-value-12345";

    try {
      store.appendRollout(
        {
          type: "response_item",
          payload: {
            role: "user",
            content: `Authorization: Bearer abcdefghijklmnop= ${rawSecret}`,
          },
        },
        { durable: true },
      );
      store.appendRollout(
        {
          type: "compacted",
          payload: {
            message: `api_key=${opaqueSecret}`,
            replacementHistory: [
              {
                role: "assistant",
                content: rawSecret,
              },
            ],
          },
        },
        { durable: true },
      );
      store.appendRollout(
        {
          type: "event_msg",
          payload: {
            id: "secret-error",
            msg: {
              type: "error",
              payload: {
                cause: "provider_failed",
                message: "Authorization: Bearer abcdefghijklmnop=",
                stack: `token=${opaqueSecret}`,
              },
            },
          },
        },
        { durable: true },
      );

      const content = readFileSync(store.rolloutPath, "utf8");
      expect(content).not.toContain(rawSecret);
      expect(content).not.toContain(opaqueSecret);
      expect(content).not.toContain("abcdefghijklmnop=");
      expect(content).toContain("[REDACTED_SECRET]");
      expect(
        store
          .readAll()
          .some((item) => JSON.stringify(item).includes(rawSecret)),
      ).toBe(false);
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("persists edge metadata and status across reopen", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "thread-spawn-persist";
    const original = openStore({ cwd, sessionId });
    const childMetadata: AgentMetadata = {
      ...metadata("child-1", "/root/alpha", 1),
      agentRoleWorkspaceId: cwd,
    };

    try {
      createAdmittedThreadSpawnEdge(original, cwd, {
        parentThreadId: "root-1",
        childThreadId: "child-1",
        parentPath: "/root",
        metadata: childMetadata,
        status: "open",
      });
      original.setThreadSpawnEdgeStatus("child-1", "closed");
      (childMetadata as { agentPath?: string }).agentPath = "/root/stale";
      original.close();

      const reopened = openStore({ cwd, sessionId, resume: true });
      try {
        expect(
          reopened.listThreadSpawnChildrenWithStatus("root-1", "open"),
        ).toEqual([]);
        expect(
          reopened.listThreadSpawnChildrenWithStatus("root-1", "closed"),
        ).toEqual([
          {
            parentThreadId: "root-1",
            childThreadId: "child-1",
            parentPath: "/root",
            metadata: {
              agentId: "child-1",
              agentPath: "/root/alpha",
              agentNickname: "alpha",
              agentRole: "default",
              agentRoleWorkspaceId: cwd,
              depth: 1,
            },
            status: "closed",
          },
        ]);
      } finally {
        reopened.close();
      }
    } finally {
      original.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    ["fresh", false],
    ["resumed", true],
  ] as const)(
    "refuses a %s writer for a terminal epoch without changing canonical sources",
    (_mode, resume) => {
      const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
      const sessionId = "terminal-resume-refused";
      const original = openStore({ cwd, sessionId });
      try {
        expect(
          original.append(
            {
              eventId: `run-terminal:${sessionId}:1`,
              id: `run-terminal:${sessionId}:1`,
              seq: 1,
              msg: {
                type: "run_terminal",
                payload: {
                  runId: sessionId,
                  epoch: 1,
                  status: "completed",
                  exitCode: 0,
                  stopReason: "turn_completed",
                  finalMessage: "done",
                  usage: null,
                  lastSequenceBeforeTerminal: null,
                  finishedAt: "2026-07-18T00:00:00.000Z",
                },
              },
            },
            { durable: true },
          ),
        ).toBe(true);
        original.close();
        const terminalTail = readFileSync(original.rolloutPath, "utf8");
        const rolloutFilesBefore = readdirSync(
          original.store.sessionDir,
        ).filter(
          (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"),
        );

        expect(() => openStore({ cwd, sessionId, resume })).toThrow(
          `refusing to open terminal run ${sessionId} epoch 1; explicit reopen is required`,
        );
        expect(readFileSync(original.rolloutPath, "utf8")).toBe(terminalTail);
        expect(
          readdirSync(original.store.sessionDir).filter(
            (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"),
          ),
        ).toEqual(rolloutFilesBefore);
      } finally {
        original.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it("explicitly reopens a completed canonical run once and survives another restart", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "terminal-resume-explicit";
    const original = openStore({ cwd, sessionId });
    try {
      expect(
        original.append(
          {
            eventId: `run-terminal:${sessionId}:1`,
            id: `run-terminal:${sessionId}:1`,
            seq: 1,
            msg: {
              type: "run_terminal",
              payload: {
                runId: sessionId,
                epoch: 1,
                status: "completed",
                exitCode: 0,
                stopReason: "turn_completed",
                finalMessage: "done",
                usage: null,
                lastSequenceBeforeTerminal: null,
                finishedAt: "2026-08-19T00:00:00.000Z",
              },
            },
          },
          { durable: true },
        ),
      ).toBe(true);
      original.close();

      const resumed = openStore({
        cwd,
        sessionId,
        resume: true,
        reopenTerminalRun: true,
      });
      try {
        expect(resumed.runEpoch).toBe(2);
        expect(
          resumed
            .readAll()
            .filter(
              (item) =>
                item.type === "event_msg" &&
                item.payload.msg.type === "run_reopened",
            ),
        ).toHaveLength(1);
      } finally {
        resumed.close();
      }

      const restarted = openStore({ cwd, sessionId, resume: true });
      try {
        expect(restarted.runEpoch).toBe(2);
        expect(
          restarted
            .readAll()
            .filter(
              (item) =>
                item.type === "event_msg" &&
                item.payload.msg.type === "run_reopened",
            ),
        ).toHaveLength(1);
      } finally {
        restarted.close();
      }
    } finally {
      original.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("projects a fsynced reopen boundary after a pre-SQLite crash without duplicating it", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "terminal-resume-crash-window";
    const original = openStore({ cwd, sessionId });
    try {
      expect(
        original.append(
          {
            eventId: `run-terminal:${sessionId}:1`,
            id: `run-terminal:${sessionId}:1`,
            seq: 1,
            msg: {
              type: "run_terminal",
              payload: {
                runId: sessionId,
                epoch: 1,
                status: "completed",
                exitCode: 0,
                stopReason: "turn_completed",
                finalMessage: "done",
                usage: null,
                lastSequenceBeforeTerminal: null,
                finishedAt: "2026-08-19T00:00:00.000Z",
              },
            },
          },
          { durable: true },
        ),
      ).toBe(true);
      // Models a process death after the canonical reopen fsync but before
      // StateRunDurabilityRepository.reopenRun projected epoch 2.
      expect(
        original.append(
          {
            eventId: `run-reopened:${sessionId}:2`,
            id: `run-reopened:${sessionId}:2`,
            seq: 2,
            msg: {
              type: "run_reopened",
              payload: {
                runId: sessionId,
                previousEpoch: 1,
                epoch: 2,
                reason: "user_session_continue",
                reopenedAt: "2026-08-19T00:00:01.000Z",
              },
            },
          },
          { durable: true },
        ),
      ).toBe(true);
      original.close();

      const resumed = openStore({
        cwd,
        sessionId,
        resume: true,
        reopenTerminalRun: true,
      });
      try {
        expect(resumed.runEpoch).toBe(2);
        expect(
          resumed
            .readAll()
            .filter(
              (item) =>
                item.type === "event_msg" &&
                item.payload.msg.type === "run_reopened",
            ),
        ).toHaveLength(1);
      } finally {
        resumed.close();
      }
    } finally {
      original.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("projects a canonical effect review that precedes its reopen boundary", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "terminal-resume-reviewed-before-boundary";
    const original = openStore({ cwd, sessionId });
    try {
      appendReviewedReopenFixture(original, sessionId, true);
      original.close();

      const resumed = openStore({
        cwd,
        sessionId,
        resume: true,
        reopenTerminalRun: true,
      });
      try {
        expect(resumed.runEpoch).toBe(2);
        const driver = openStateDatabases({ cwd });
        try {
          const row = driver
            .prepareState<
              [string, string],
              { readonly review_status: string | null }
            >(
              `SELECT review_status
               FROM run_effects
               WHERE run_id = ? AND step_id = ?`,
            )
            .get(sessionId, "step-reviewed");
          expect(row?.review_status).toBe("resolved");
        } finally {
          driver.close();
        }
      } finally {
        resumed.close();
      }
    } finally {
      original.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("accepts an effect review recorded after its canonical reopen boundary", () => {
    // #1750/#1751 contract change: a settled terminal reopens with the
    // unknown-outcome review still pending, because the review itself runs
    // inside the reopened session. The late review then resolves the effect.
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "terminal-resume-reviewed-after-boundary";
    const original = openStore({ cwd, sessionId });
    try {
      appendReviewedReopenFixture(original, sessionId, false);
      original.close();

      const resumed = openStore({
        cwd,
        sessionId,
        resume: true,
        reopenTerminalRun: true,
      });
      try {
        expect(resumed.runEpoch).toBe(2);
        const driver = openStateDatabases({ cwd });
        try {
          const row = driver
            .prepareState<
              [string, string],
              { readonly review_status: string | null }
            >(
              `SELECT review_status
               FROM run_effects
               WHERE run_id = ? AND step_id = ?`,
            )
            .get(sessionId, "step-reviewed");
          expect(row?.review_status).toBe("resolved");
        } finally {
          driver.close();
        }
      } finally {
        resumed.close();
      }
    } finally {
      original.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reopens a cancelled terminal under a new epoch", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "terminal-resume-cancelled-clean";
    const original = openStore({ cwd, sessionId });
    try {
      expect(
        original.append(
          {
            eventId: `run-terminal:${sessionId}:1`,
            id: `run-terminal:${sessionId}:1`,
            seq: 1,
            msg: {
              type: "run_terminal",
              payload: {
                runId: sessionId,
                epoch: 1,
                status: "cancelled",
                exitCode: null,
                stopReason: "signal_received",
                finalMessage: null,
                usage: null,
                lastSequenceBeforeTerminal: null,
                finishedAt: "2026-08-19T00:00:00.000Z",
              },
            },
          },
          { durable: true },
        ),
      ).toBe(true);
      original.close();

      const resumed = openStore({
        cwd,
        sessionId,
        resume: true,
        reopenTerminalRun: true,
      });
      // #1750 contract change: a cancelled epoch is a settled terminal
      // outcome and reopens under a new epoch — the everyday
      // interrupt-then-continue workflow.
      try {
        expect(resumed.runEpoch).toBe(2);
      } finally {
        resumed.close();
      }
      expect(readFileSync(original.rolloutPath, "utf8")).toContain(
        '"type":"run_reopened"',
      );
    } finally {
      original.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reopens with a recovered unknown-outcome effect still pending review", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "terminal-resume-review-blocked";
    const original = openStore({ cwd, sessionId });
    const intent = {
      eventId: "effect-intent-before-terminal",
      id: "effect-intent-before-terminal",
      seq: 1,
      msg: {
        type: "effect_intent" as const,
        payload: {
          formatVersion: 2,
          minimumReaderRuntime: "0.14.0",
          runId: sessionId,
          stepId: "step-1",
          callId: "call-1",
          toolName: "side-effecting-test",
          recoveryCategory: "side-effecting" as const,
          intentDigest: "digest-1",
          attempt: 1,
          recordedAt: "2026-08-19T00:00:00.000Z",
        },
      },
    };
    try {
      expect(original.append(intent, { durable: true })).toBe(true);
      original.recordEffectEvent(intent);
      expect(
        original.append(
          {
            eventId: `run-terminal:${sessionId}:1`,
            id: `run-terminal:${sessionId}:1`,
            seq: 2,
            msg: {
              type: "run_terminal",
              payload: {
                runId: sessionId,
                epoch: 1,
                status: "completed",
                exitCode: 0,
                stopReason: "turn_completed",
                finalMessage: "done",
                usage: null,
                lastSequenceBeforeTerminal: 1,
                finishedAt: "2026-08-19T00:00:01.000Z",
              },
            },
          },
          { durable: true },
        ),
      ).toBe(true);
      original.close();

      // #1750/#1751 contract change: open-time recovery settles the dangling
      // intent as a review-pending unknown outcome, and a settled terminal
      // reopens with that review still pending — the review runs inside the
      // reopened session while the mutation gate stays armed.
      const resumed = openStore({
        cwd,
        sessionId,
        resume: true,
        reopenTerminalRun: true,
      });
      try {
        expect(resumed.runEpoch).toBe(2);
        const driver = openStateDatabases({ cwd });
        try {
          const row = driver
            .prepareState<
              [string, string],
              { readonly review_status: string | null }
            >(
              `SELECT review_status
               FROM run_effects
               WHERE run_id = ? AND step_id = ?`,
            )
            .get(sessionId, "step-1");
          expect(row?.review_status).toBe("pending");
        } finally {
          driver.close();
        }
      } finally {
        resumed.close();
      }
      const content = readFileSync(original.rolloutPath, "utf8");
      expect(content).toContain('"type":"effect_unknown_outcome"');
      expect(content).toContain('"type":"run_reopened"');
    } finally {
      original.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("resumes two clean daemon suspensions without changing the epoch", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "suspended-resume-cycles";
    const original = openStore({ cwd, sessionId });
    try {
      const firstSuspension = {
        eventId: "run-suspended-cycle-1",
        id: "run-suspended-cycle-1",
        seq: 1,
        msg: {
          type: "run_suspended" as const,
          payload: {
            runId: sessionId,
            epoch: 1,
            reason: "daemon_shutdown_idle" as const,
            suspendedAt: "2026-08-19T00:00:00.000Z",
          },
        },
      };
      expect(original.append(firstSuspension, { durable: true })).toBe(true);
      original.recordRunSuspensionEvent(firstSuspension);
      original.close();

      expect(() => openStore({ cwd, sessionId, resume: true })).toThrow(
        /explicit suspended resume is required/,
      );
      const firstResume = openStore({
        cwd,
        sessionId,
        resume: true,
        resumeSuspendedRun: true,
        suspendedResumeReason: "explicit_continue",
      });
      expect(firstResume.runEpoch).toBe(1);
      const secondSuspension = {
        eventId: "run-suspended-cycle-2",
        id: "run-suspended-cycle-2",
        seq: 3,
        msg: {
          type: "run_suspended" as const,
          payload: {
            runId: sessionId,
            epoch: 1,
            reason: "daemon_shutdown_idle" as const,
            suspendedAt: "2026-08-19T00:02:00.000Z",
          },
        },
      };
      expect(firstResume.append(secondSuspension, { durable: true })).toBe(
        true,
      );
      firstResume.recordRunSuspensionEvent(secondSuspension);
      firstResume.close();

      const secondResume = openStore({
        cwd,
        sessionId,
        resume: true,
        resumeSuspendedRun: true,
        suspendedResumeReason: "daemon_startup_restore",
      });
      try {
        expect(secondResume.runEpoch).toBe(1);
        const lifecycle = secondResume
          .readAll()
          .flatMap((item) =>
            item.type === "event_msg" &&
            (item.payload.msg.type === "run_suspended" ||
              item.payload.msg.type === "run_resumed")
              ? [item.payload.msg.type]
              : [],
          );
        expect(lifecycle).toEqual([
          "run_suspended",
          "run_resumed",
          "run_suspended",
          "run_resumed",
        ]);
      } finally {
        secondResume.close();
      }
    } finally {
      original.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("adopts a recovery-named source after the bound normal path was moved", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "suspended-rewrite-old-moved";
    const original = openStore({ cwd, sessionId });
    const suspension = {
      eventId: "run-suspended-old-moved",
      id: "run-suspended-old-moved",
      seq: 1,
      msg: {
        type: "run_suspended" as const,
        payload: {
          runId: sessionId,
          epoch: 1,
          reason: "daemon_shutdown_idle" as const,
          suspendedAt: "2026-08-19T00:00:00.000Z",
        },
      },
    };
    try {
      expect(original.append(suspension, { durable: true })).toBe(true);
      original.recordRunSuspensionEvent(suspension);
      const normalPath = original.rolloutPath;
      original.close();
      const recoveryPath = join(
        original.store.sessionDir,
        `rollout-recovery-1-crash-${sessionId}.jsonl`,
      );
      renameSync(normalPath, recoveryPath);

      const resumed = new RolloutStore({
        cwd,
        sessionId,
        agencVersion: "0.2.0",
        sessionTempRoot: join(agencHome, "rollout-temp"),
        resume: true,
        resumeRolloutPath: recoveryPath,
        resumeSuspendedRun: true,
        suspendedResumeReason: "daemon_startup_restore",
      });
      try {
        resumed.open({
          sessionId,
          timestamp: "2026-08-19T00:01:00.000Z",
          cwd,
          originator: "rollout-store-test",
          agencVersion: "0.2.0",
          model: "test-model",
          modelProvider: "test-provider",
        });
        expect(resumed.rolloutPath).toBe(recoveryPath);
        expect(resumed.runEpoch).toBe(1);
        expect(
          resumed
            .readAll()
            .flatMap((item) =>
              item.type === "event_msg" &&
              (item.payload.msg.type === "run_suspended" ||
                item.payload.msg.type === "run_resumed")
                ? [item.payload.msg.type]
                : [],
            ),
        ).toEqual(["run_suspended", "run_resumed"]);
      } finally {
        resumed.close();
      }
    } finally {
      original.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("replays a fsynced run_resumed crash window without duplicating it", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "suspended-resume-crash-window";
    const original = openStore({ cwd, sessionId });
    try {
      const suspension = {
        eventId: "run-suspended-crash-window",
        id: "run-suspended-crash-window",
        seq: 1,
        msg: {
          type: "run_suspended" as const,
          payload: {
            runId: sessionId,
            epoch: 1,
            reason: "daemon_shutdown_idle" as const,
            suspendedAt: "2026-08-19T00:00:00.000Z",
          },
        },
      };
      expect(original.append(suspension, { durable: true })).toBe(true);
      original.recordRunSuspensionEvent(suspension);
      expect(
        original.append(
          {
            eventId: "run-resumed-crash-window",
            id: "run-resumed-crash-window",
            seq: 2,
            msg: {
              type: "run_resumed",
              payload: {
                runId: sessionId,
                epoch: 1,
                suspensionEventId: suspension.eventId,
                reason: "explicit_continue",
                resumedAt: "2026-08-19T00:01:00.000Z",
              },
            },
          },
          { durable: true },
        ),
      ).toBe(true);
      original.close();

      const resumed = openStore({
        cwd,
        sessionId,
        resume: true,
        resumeSuspendedRun: true,
      });
      try {
        expect(resumed.runEpoch).toBe(1);
        expect(
          resumed
            .readAll()
            .filter(
              (item) =>
                item.type === "event_msg" &&
                item.payload.msg.type === "run_resumed",
            ),
        ).toHaveLength(1);
      } finally {
        resumed.close();
      }
    } finally {
      original.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not resume a suspension preceded by an unsettled effect intent", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "suspended-resume-effect-gate";
    const original = openStore({ cwd, sessionId });
    try {
      expect(
        original.append(
          {
            eventId: "effect-intent-before-suspension",
            id: "effect-intent-before-suspension",
            seq: 1,
            msg: {
              type: "effect_intent",
              payload: {
                formatVersion: 2,
                minimumReaderRuntime: "0.14.0",
                runId: sessionId,
                stepId: "step-before-suspension",
                callId: "call-before-suspension",
                toolName: "side-effecting-test",
                recoveryCategory: "side-effecting",
                intentDigest: "digest-before-suspension",
                attempt: 1,
                recordedAt: "2026-08-19T00:00:00.000Z",
              },
            },
          },
          { durable: true },
        ),
      ).toBe(true);
      expect(
        original.append(
          {
            eventId: "invalid-suspension-after-intent",
            id: "invalid-suspension-after-intent",
            seq: 2,
            msg: {
              type: "run_suspended",
              payload: {
                runId: sessionId,
                epoch: 1,
                reason: "daemon_shutdown_idle",
                suspendedAt: "2026-08-19T00:01:00.000Z",
              },
            },
          },
          { durable: true },
        ),
      ).toBe(true);
      original.close();

      expect(() =>
        openStore({
          cwd,
          sessionId,
          resume: true,
          resumeSuspendedRun: true,
        }),
      ).toThrow(/unsettled effect/);
      expect(readFileSync(original.rolloutPath, "utf8")).not.toContain(
        '"type":"run_resumed"',
      );
    } finally {
      original.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed instead of reopening a corrupted persisted edge status", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "thread-spawn-invalid-status";
    const original = openStore({ cwd, sessionId });
    try {
      createAdmittedThreadSpawnEdge(original, cwd, {
        parentThreadId: "root-1",
        childThreadId: "child-invalid-status",
        parentPath: "/root",
        metadata: metadata(
          "child-invalid-status",
          "/root/child_invalid_status",
          1,
        ),
        status: "open",
      });
      original.close();

      const raw = new Database(resolveStateDatabasePaths({ cwd }).stateDbPath);
      try {
        raw
          .prepare(
            `UPDATE thread_spawn_edges
           SET status = 'corrupted'
           WHERE child_thread_id = ?`,
          )
          .run("child-invalid-status");
      } finally {
        raw.close();
      }

      expect(() => openStore({ cwd, sessionId, resume: true })).toThrow(
        /invalid thread-spawn edge status: corrupted/,
      );
    } finally {
      original.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects a legacy metadata rewrite that would remove provenance", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "thread-spawn-legacy-rewrite";
    const original = openStore({ cwd, sessionId });
    try {
      createAdmittedThreadSpawnEdge(original, cwd, {
        parentThreadId: "root-1",
        childThreadId: "child-legacy",
        parentPath: "/root",
        metadata: {
          ...metadata("child-legacy", "/root/legacy", 1),
          agentRoleWorkspaceId: cwd,
        },
        status: "open",
      });
      original.close();

      const raw = new Database(resolveStateDatabasePaths({ cwd }).stateDbPath);
      try {
        expect(() =>
          raw
            .prepare(
              `UPDATE thread_spawn_edges
             SET metadata_json = ?, status = 'closed'
             WHERE child_thread_id = ?`,
            )
            .run(
              JSON.stringify(metadata("child-legacy", "/root/legacy", 1)),
              "child-legacy",
            ),
        ).toThrow(/identity is immutable/);
      } finally {
        raw.close();
      }

      const reopened = openStore({ cwd, sessionId, resume: true });
      try {
        expect(reopened.getThreadSpawnEdge("child-legacy")?.metadata).toEqual({
          ...metadata("child-legacy", "/root/legacy", 1),
          agentRoleWorkspaceId: cwd,
        });
        expect(reopened.getThreadSpawnEdge("child-legacy")?.status).toBe(
          "open",
        );
      } finally {
        reopened.close();
      }
    } finally {
      original.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps spawn identity create-only and publishes only durable status", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const otherWorkspace = join(cwd, "other-workspace");
    const sessionId = "thread-spawn-provenance-immutability";
    const store = openStore({ cwd, sessionId });
    const baseMetadata = {
      ...metadata("child-immutable", "/root/immutable", 1),
      agentRoleWorkspaceId: cwd,
      agentRoleFingerprint: "default-role-fingerprint",
    };
    try {
      createAdmittedThreadSpawnEdge(store, cwd, {
        parentThreadId: "root-1",
        childThreadId: "child-immutable",
        parentPath: "/root",
        metadata: baseMetadata,
        status: "open",
      });
      store.setThreadSpawnEdgeStatus("child-immutable", "closed");
      expect(store.getThreadSpawnEdge("child-immutable")).toMatchObject({
        status: "closed",
        metadata: {
          agentRoleWorkspaceId: cwd,
          agentRoleFingerprint: "default-role-fingerprint",
          agentRole: "default",
        },
      });

      const paths = resolveStateDatabasePaths({ cwd });
      const raw = new Database(paths.stateDbPath);
      try {
        const before = raw
          .prepare(
            `SELECT parent_thread_id, parent_path, metadata_json,
                    agent_role_workspace_id, agent_role_fingerprint, status
             FROM thread_spawn_edges
             WHERE child_thread_id = ?`,
          )
          .get("child-immutable");
        const inMemoryBefore = store.getThreadSpawnEdge("child-immutable");

        expect(() =>
          createAdmittedThreadSpawnEdge(store, cwd, {
            parentThreadId: "attacker-root",
            childThreadId: "child-immutable",
            parentPath: "/root",
            metadata: {
              ...baseMetadata,
              agentRoleWorkspaceId: otherWorkspace,
            },
            status: "open",
          }),
        ).toThrow(/agent thread id already exists/);
        expect(store.getThreadSpawnEdge("child-immutable")).toEqual(
          inMemoryBefore,
        );
        expect(
          raw
            .prepare(
              `SELECT parent_thread_id, parent_path, metadata_json,
                      agent_role_workspace_id, agent_role_fingerprint, status
               FROM thread_spawn_edges
               WHERE child_thread_id = ?`,
            )
            .get("child-immutable"),
        ).toEqual(before);

        expect(() =>
          createAdmittedThreadSpawnEdge(store, cwd, {
            parentThreadId: "root-1",
            childThreadId: "child-immutable",
            parentPath: "/root",
            metadata: {
              ...baseMetadata,
              agentRole: "runner",
              agentRoleFingerprint: "worker-role-fingerprint",
            },
            status: "open",
          }),
        ).toThrow(/agent thread id already exists/);
        expect(store.getThreadSpawnEdge("child-immutable")).toEqual(
          inMemoryBefore,
        );

        expect(() =>
          createAdmittedThreadSpawnEdge(store, cwd, {
            parentThreadId: "root-1",
            childThreadId: "child-immutable",
            parentPath: "/root",
            metadata: baseMetadata,
            status: "open",
          }),
        ).toThrow(/agent thread id already exists/);
        expect(store.getThreadSpawnEdge("child-immutable")).toEqual(
          inMemoryBefore,
        );

        expect(() =>
          createAdmittedThreadSpawnEdge(store, cwd, {
            parentThreadId: "root-1",
            childThreadId: "edge-key",
            parentPath: "/root",
            metadata: metadata("metadata-id", "/root/metadata-id", 1),
            status: "open",
          }),
        ).toThrow(/child identity/);
        expect(store.getThreadSpawnEdge("edge-key")).toBeUndefined();

        expect(() =>
          createAdmittedThreadSpawnEdge(store, cwd, {
            parentThreadId: "root-1",
            childThreadId: "invalid-status-edge",
            parentPath: "/root",
            metadata: metadata(
              "invalid-status-edge",
              "/root/invalid_status_edge",
              1,
            ),
            status: "corrupted" as "open",
          }),
        ).toThrow(/invalid thread-spawn edge record or child identity/);
        expect(store.getThreadSpawnEdge("invalid-status-edge")).toBeUndefined();
        expect(
          raw
            .prepare(
              "SELECT child_thread_id FROM thread_spawn_edges WHERE child_thread_id = ?",
            )
            .get("invalid-status-edge"),
        ).toBeUndefined();

        createAdmittedThreadSpawnEdge(store, cwd, {
          parentThreadId: "root-1",
          childThreadId: "status-failure-child",
          parentPath: "/root",
          metadata: metadata(
            "status-failure-child",
            "/root/status_failure_child",
            1,
          ),
          status: "open",
        });
        raw.exec(`
          CREATE TRIGGER reject_spawn_edge_status_update
          BEFORE UPDATE OF status ON thread_spawn_edges
          WHEN OLD.child_thread_id = 'status-failure-child'
            AND NEW.status = 'closed'
          BEGIN
            SELECT RAISE(ABORT, 'forced status persistence failure');
          END;
        `);
        expect(() =>
          store.setThreadSpawnEdgeStatus("status-failure-child", "closed"),
        ).toThrow(/forced status persistence failure/);
        expect(store.getThreadSpawnEdge("status-failure-child")?.status).toBe(
          "open",
        );
        expect(
          raw
            .prepare(
              "SELECT status FROM thread_spawn_edges WHERE child_thread_id = ?",
            )
            .get("status-failure-child"),
        ).toEqual({ status: "open" });
      } finally {
        raw.close();
      }
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("lets exactly one concurrent store create a child identity", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const first = openStore({ cwd, sessionId: "create-race-first" });
    const second = openStore({ cwd, sessionId: "create-race-second" });
    try {
      createAdmittedThreadSpawnEdge(first, cwd, {
        parentThreadId: "root-first",
        childThreadId: "race-child",
        parentPath: "/root",
        metadata: metadata("race-child", "/root/race_child", 1),
        status: "open",
      });
      const winner = first.getThreadSpawnEdge("race-child");

      expect(() =>
        createAdmittedThreadSpawnEdge(second, cwd, {
          parentThreadId: "root-second",
          childThreadId: "race-child",
          parentPath: "/root",
          metadata: metadata("race-child", "/root/attacker", 1),
          status: "closed",
        }),
      ).toThrow(/agent thread id already exists/);
      expect(second.getThreadSpawnEdge("race-child")).toEqual(winner);
      expect(first.getThreadSpawnEdge("race-child")).toEqual(winner);
    } finally {
      first.close();
      second.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("publishes a monotonic close across live stores", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const first = openStore({ cwd, sessionId: "close-coherence-first" });
    createAdmittedThreadSpawnEdge(first, cwd, {
      parentThreadId: "root-1",
      childThreadId: "close-coherence-child",
      parentPath: "/root",
      metadata: metadata(
        "close-coherence-child",
        "/root/close_coherence_child",
        1,
      ),
      status: "open",
    });
    const second = openStore({ cwd, sessionId: "close-coherence-second" });

    try {
      expect(second.getThreadSpawnEdge("close-coherence-child")?.status).toBe(
        "open",
      );

      first.setThreadSpawnEdgeStatus("close-coherence-child", "closed");

      expect(second.getThreadSpawnEdge("close-coherence-child")?.status).toBe(
        "closed",
      );
      expect(() =>
        second.setThreadSpawnEdgeStatus("close-coherence-child", "open"),
      ).toThrow(/cannot transition.*closed.*open/i);

      // A second close is a successful idempotent acknowledgement of the
      // already-durable terminal state, even from another live store.
      second.setThreadSpawnEdgeStatus("close-coherence-child", "closed");
      first.setThreadSpawnEdgeStatus("close-coherence-child", "closed");
      expect(first.getThreadSpawnEdge("close-coherence-child")?.status).toBe(
        "closed",
      );
    } finally {
      first.close();
      second.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reads current direct and descendant lists across live stores", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const first = openStore({ cwd, sessionId: "list-coherence-first" });
    createAdmittedThreadSpawnEdge(first, cwd, {
      parentThreadId: "root-1",
      childThreadId: "list-coherence-existing",
      parentPath: "/root",
      metadata: metadata(
        "list-coherence-existing",
        "/root/list_coherence_existing",
        1,
      ),
      status: "open",
    });
    const second = openStore({ cwd, sessionId: "list-coherence-second" });

    try {
      first.setThreadSpawnEdgeStatus("list-coherence-existing", "closed");
      createAdmittedThreadSpawnEdge(first, cwd, {
        parentThreadId: "root-1",
        childThreadId: "list-coherence-late",
        parentPath: "/root",
        metadata: metadata(
          "list-coherence-late",
          "/root/list_coherence_late",
          1,
        ),
        status: "open",
      });

      expect(
        second
          .listThreadSpawnChildrenWithStatus("root-1", "open")
          .map((edge) => edge.childThreadId),
      ).toEqual(["list-coherence-late"]);
      expect(
        second
          .listThreadSpawnChildrenWithStatus("root-1", "closed")
          .map((edge) => edge.childThreadId),
      ).toEqual(["list-coherence-existing"]);
      expect(
        second.listThreadSpawnDescendants("root-1").map((edge) => ({
          childThreadId: edge.childThreadId,
          status: edge.status,
        })),
      ).toEqual([
        { childThreadId: "list-coherence-existing", status: "closed" },
        { childThreadId: "list-coherence-late", status: "open" },
      ]);

      // The second store did not have this row at construction time. Closing
      // it must still reach SQLite instead of returning from a stale cache.
      second.setThreadSpawnEdgeStatus("list-coherence-late", "closed");
      expect(first.getThreadSpawnEdge("list-coherence-late")?.status).toBe(
        "closed",
      );
      expect(
        second.listThreadSpawnChildrenWithStatus("root-1", "open"),
      ).toEqual([]);
    } finally {
      first.close();
      second.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("lists status-filtered and unfiltered descendants breadth-first", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "thread-spawn-descendants";
    const store = openStore({ cwd, sessionId });

    try {
      createAdmittedThreadSpawnEdge(store, cwd, {
        parentThreadId: "root-1",
        childThreadId: "child-z",
        parentPath: "/root",
        metadata: metadata("child-z", "/root/alpha", 1),
        status: "closed",
      });
      createAdmittedThreadSpawnEdge(store, cwd, {
        parentThreadId: "root-1",
        childThreadId: "child-a",
        parentPath: "/root",
        metadata: metadata("child-a", "/root/zulu", 1),
        status: "open",
      });
      createAdmittedThreadSpawnEdge(store, cwd, {
        parentThreadId: "child-z",
        childThreadId: "grandchild-a",
        parentPath: "/root/alpha",
        metadata: metadata("grandchild-a", "/root/alpha/scout", 2),
        status: "open",
      });
      createAdmittedThreadSpawnEdge(store, cwd, {
        parentThreadId: "child-a",
        childThreadId: "grandchild-b",
        parentPath: "/root/zulu",
        metadata: metadata("grandchild-b", "/root/zulu/worker", 2),
        status: "closed",
      });

      expect(
        store
          .listThreadSpawnDescendantsWithStatus("root-1", "open")
          .map((edge) => edge.childThreadId),
      ).toEqual(["child-a"]);
      expect(
        store
          .listThreadSpawnDescendantsWithStatus("root-1", "closed")
          .map((edge) => edge.childThreadId),
      ).toEqual(["child-z"]);
      expect(
        store
          .listThreadSpawnDescendants("root-1")
          .map((edge) => edge.childThreadId),
      ).toEqual(["child-a", "child-z", "grandchild-a", "grandchild-b"]);
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("finds direct children and descendants by canonical agent path", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "thread-spawn-path";
    const store = openStore({ cwd, sessionId });

    try {
      createAdmittedThreadSpawnEdge(store, cwd, {
        parentThreadId: "root-1",
        childThreadId: "child-open",
        parentPath: "/root",
        metadata: metadata("child-open", "/root/open", 1),
        status: "open",
      });
      createAdmittedThreadSpawnEdge(store, cwd, {
        parentThreadId: "root-1",
        childThreadId: "child-closed",
        parentPath: "/root",
        metadata: metadata("child-closed", "/root/closed", 1),
        status: "closed",
      });
      createAdmittedThreadSpawnEdge(store, cwd, {
        parentThreadId: "child-closed",
        childThreadId: "grandchild-open",
        parentPath: "/root/closed",
        metadata: metadata("grandchild-open", "/root/closed/open", 2),
        status: "open",
      });

      expect(store.findThreadSpawnChildByPath("root-1", "/root/open")).toBe(
        "child-open",
      );
      expect(store.findThreadSpawnChildByPath("root-1", "/root/closed")).toBe(
        "child-closed",
      );
      expect(
        store.findThreadSpawnChildByPath("root-1", "/root/closed/open"),
      ).toBeUndefined();
      expect(
        store.findThreadSpawnDescendantByPath("root-1", "/root/closed/open"),
      ).toBe("grandchild-open");
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("throws when path lookup matches multiple spawned threads", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "thread-spawn-path-collision";
    const store = openStore({ cwd, sessionId });

    try {
      createAdmittedThreadSpawnEdge(store, cwd, {
        parentThreadId: "root-1",
        childThreadId: "child-a",
        parentPath: "/root",
        metadata: metadata("child-a", "/root/duplicate", 1),
        status: "open",
      });
      createAdmittedThreadSpawnEdge(store, cwd, {
        parentThreadId: "root-1",
        childThreadId: "child-b",
        parentPath: "/root",
        metadata: metadata("child-b", "/root/duplicate", 1),
        status: "closed",
      });

      expect(() =>
        store.findThreadSpawnChildByPath("root-1", "/root/duplicate"),
      ).toThrow(/multiple spawned threads matched agent path/);
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("imports obvious legacy snapshots with implicit open status", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "thread-spawn-legacy";
    const sessionDir = getSessionDir(cwd, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "thread-spawn-edges.json"),
      `${JSON.stringify({
        threadSpawnEdges: {
          "child-legacy": {
            parentThreadId: "root-1",
            parentPath: "/root",
            metadata: metadata("child-legacy", "/root/legacy", 1),
          },
        },
      })}\n`,
      "utf8",
    );

    const store = openStore({ cwd, sessionId, resume: true });
    try {
      expect(store.getThreadSpawnEdge("child-legacy")).toEqual({
        childThreadId: "child-legacy",
        parentThreadId: "root-1",
        parentPath: "/root",
        metadata: metadata("child-legacy", "/root/legacy", 1),
        status: "open",
      });
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("backs up corrupt snapshots and starts with an empty graph", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "thread-spawn-corrupt";
    const sessionDir = getSessionDir(cwd, sessionId);
    const snapshotPath = join(sessionDir, "thread-spawn-edges.json");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(snapshotPath, "{not-json", "utf8");

    const store = openStore({ cwd, sessionId, resume: true });
    try {
      expect(store.listThreadSpawnChildren("root-1")).toEqual([]);
      const corruptDir = join(getProjectDir(cwd), "state-corrupt");
      const backups = readdirSync(corruptDir).filter(
        (entry) =>
          entry.startsWith("thread-spawn-edges-") && entry.endsWith(".json"),
      );
      expect(backups).toHaveLength(1);
      expect(existsSync(snapshotPath)).toBe(true);

      createAdmittedThreadSpawnEdge(store, cwd, {
        parentThreadId: "root-1",
        childThreadId: "child-after-corrupt",
        parentPath: "/root",
        metadata: metadata("child-after-corrupt", "/root/recovered", 1),
        status: "open",
      });
      expect(existsSync(snapshotPath)).toBe(true);
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
