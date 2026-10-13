/**
 * Journal-succeeded / SQLite-failed terminal retry through the real
 * controller and the real rollout journal.
 *
 * The first resume writes `run_terminal` and then both SQLite projections
 * fail. The second resume must project that same journal event: same
 * eventId, id, epoch, sequence, and payload. It must not mint another
 * journal event and must not record a detached terminal.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createWorkflowSessionSeams } from "../../src/app-server/workflow/session-adapters.js";
import { VerifiedChangeWorkflowController } from "../../src/app-server/workflow/verified-change-controller.js";
import type { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { sha256Digest } from "../../src/eval-contract/canonical-json.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import type { ToolPermissionContext } from "../../src/permissions/types.js";
import { EventLog, type Event, type EventMsg } from "../../src/session/event-log.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import {
  StateRunDurabilityRepository,
} from "../../src/state/run-durability.js";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";

const RUN_ID = "wf-terminal-projection-retry";

describe("journal terminal projection retry", () => {
  let home: string;
  let cwd: string;
  let driver: StateSqliteDriver;
  let rollout: RolloutStore | undefined;

  afterEach(() => {
    rollout?.close();
    rollout = undefined;
    driver?.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("projects the original journal terminal after SQLite fails", async () => {
    home = mkdtempSync(join(tmpdir(), "agenc-terminal-retry-home-"));
    cwd = mkdtempSync(join(tmpdir(), "agenc-terminal-retry-cwd-"));
    mkdirSync(join(cwd, ".git"));
    driver = openStateDatabases({ cwd, agencHome: home });
    const repo = new StateRunDurabilityRepository(driver);
    const openedAt = "2026-08-19T00:00:00.000Z";
    repo.ensureInitialEpoch({ runId: RUN_ID, openedAt });
    const intentDigest = sha256Digest("terminal-projection-retry");
    repo.beginEffect({
      runId: RUN_ID,
      epoch: 1,
      stepId: "workflow.intake",
      sessionId: RUN_ID,
      callId: "workflow.intake",
      toolName: "workflow.intake",
      recoveryCategory: "idempotent",
      idempotencyKey: intentDigest,
      intentDigest,
      eventId: "intake-intent",
      eventSequence: 1,
      intentAt: openedAt,
    });

    rollout = new RolloutStore({
      cwd,
      agencHome: home,
      sessionId: RUN_ID,
      agencVersion: "0.2.0",
      sessionTempRoot: join(home, "rollout-temp"),
    });
    const warnings: string[] = [];
    const eventLog = new EventLog();
    // The seeded intake already owns sequence 1. The journal's next event
    // must take a later sequence or SQLite rejects the projection.
    eventLog.seedLastSeq(1);
    let opened = false;
    const registry = new PermissionModeRegistry(baseContext("default"));
    const abortController = new AbortController();
    const session = {
      conversationId: RUN_ID,
      permissionModeRegistry: registry,
      abortController,
      get isShuttingDown() {
        return false;
      },
      emit(
        event: { readonly id: string; readonly msg: EventMsg },
        _opts?: { readonly durable?: boolean },
      ): Event {
        const stamped = eventLog.stamp(event as Event);
        const committed = rollout!.append(stamped, { durable: true });
        if (!committed) {
          throw new Error(
            `durable event ${stamped.msg.type} sequence ${stamped.seq ?? "unassigned"} was not fsync-committed`,
          );
        }
        return stamped;
      },
      services: {},
    };
    const seams = createWorkflowSessionSeams({
      agencHome: home,
      env: {},
      argv: ["node", "agenc"],
      kernel: {} as ExecutionAdmissionKernel,
      durability: () => repo,
      resolveRunRepoPath: () => cwd,
      resolveRunPolicy: () => undefined,
      fallbackCwd: cwd,
      warn: (message) => {
        warnings.push(message);
      },
      bootstrap: async () => {
        if (!opened) {
          rollout!.open({
            sessionId: RUN_ID,
            timestamp: openedAt,
            cwd,
            originator: "terminal-projection-retry",
            agencVersion: "0.2.0",
            model: "test-model",
            modelProvider: "test-provider",
          });
          opened = true;
        }
        return {
          session,
          rolloutStore: rollout,
          shutdown: async () => {},
        } as never;
      },
    });

    const recordTerminalResult = repo.recordTerminalResult.bind(repo);
    let projections = 0;
    repo.recordTerminalResult = (params) => {
      projections += 1;
      if (projections <= 2) throw new Error("sqlite is unavailable");
      return recordTerminalResult(params);
    };

    let clock = 0;
    const controller = new VerifiedChangeWorkflowController({
      durability: () => repo,
      journal: seams.journal,
      admission: () => {
        throw new Error("admission unused");
      },
      worktrees: {} as never,
      commands: {} as never,
      spawner: {} as never,
      reviewer: {} as never,
      evidenceLedger: async () => {
        throw new Error("ledger unused");
      },
      warn: (message) => {
        warnings.push(message);
      },
      now: () => new Date(Date.UTC(2026, 7, 19, 0, 0, clock++)),
    });

    const resumed = await controller.resumeOpenWorkflows();
    expect(resumed, warnings.join("\n") || "no warning").toEqual([RUN_ID]);
    expect(repo.getCurrentTerminalResult(RUN_ID)).toBeUndefined();
    const journalAfterFailure = readFileSync(rollout.rolloutPath);
    const journalHash = sha256(journalAfterFailure);
    const original = journalTerminal(journalAfterFailure);
    expect(original.msg.payload.finalMessage).toBe(
      "The Goal stopped before its instructions were saved. Start it again.",
    );

    expect(await controller.resumeOpenWorkflows()).toEqual([RUN_ID]);
    const journalAfterRetry = readFileSync(rollout.rolloutPath);
    expect(sha256(journalAfterRetry)).toBe(journalHash);
    expect(journalAfterRetry).toEqual(journalAfterFailure);
    const retained = journalTerminal(journalAfterRetry);
    expect(retained).toEqual(original);

    const row = repo.getCurrentTerminalResult(RUN_ID);
    expect(row).toMatchObject({
      eventId: original.eventId,
      epoch: original.msg.payload.epoch,
      lastSequence: original.seq,
      status: original.msg.payload.status,
      exitCode: original.msg.payload.exitCode,
      stopReason: original.msg.payload.stopReason,
      finalMessage: original.msg.payload.finalMessage,
      usage: original.msg.payload.usage,
      finishedAt: original.msg.payload.finishedAt,
    });
    expect(row?.eventId).toBe(original.eventId);
    expect(original.id).not.toMatch(/^workflow-detached-terminal:/);
    expect(row?.eventId).not.toMatch(/^workflow-detached-terminal:/);
    expect(countTerminals(journalAfterRetry)).toBe(1);
    await seams.close();
  });
});

function journalTerminal(bytes: Buffer): Event & {
  msg: Extract<EventMsg, { type: "run_terminal" }>;
} {
  const lines = bytes
    .toString("utf8")
    .split("\n")
    .filter((line) => line.includes('"type":"run_terminal"'));
  expect(lines).toHaveLength(1);
  const item = JSON.parse(lines[0]!) as { payload: Event };
  const event = item.payload;
  if (event.msg.type !== "run_terminal") {
    throw new Error("journal line is not run_terminal");
  }
  return event as Event & { msg: Extract<EventMsg, { type: "run_terminal" }> };
}

function countTerminals(bytes: Buffer): number {
  return bytes.toString("utf8").split('"type":"run_terminal"').length - 1;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function baseContext(mode: ToolPermissionContext["mode"]): ToolPermissionContext {
  return {
    mode,
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: true,
  };
}
