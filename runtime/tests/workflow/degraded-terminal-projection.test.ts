/**
 * ENOSPC while journaling run_terminal queues the event on the degraded
 * ring and Session.emit throws. The controller catch must not record a
 * detached SQLite identity for that epoch. After the disk accepts writes
 * again and the queued line is drained, the SQLite row is that journal
 * terminal.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeSync } from "node:fs";
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
import { StateRunDurabilityRepository } from "../../src/state/run-durability.js";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";

const RUN_ID = "wf-degraded-terminal-projection";

describe("degraded terminal projection", () => {
  let home: string;
  let cwd: string;
  let driver: StateSqliteDriver;
  let rollout: RolloutStore | undefined;

  afterEach(() => {
    try {
      rollout?.close();
    } catch {
      // The controller drain may already have closed the store.
    }
    rollout = undefined;
    driver?.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("does not record a detached row when the terminal write is queued after ENOSPC", async () => {
    home = mkdtempSync(join(tmpdir(), "agenc-degraded-terminal-home-"));
    cwd = mkdtempSync(join(tmpdir(), "agenc-degraded-terminal-cwd-"));
    mkdirSync(join(cwd, ".git"));
    driver = openStateDatabases({ cwd, agencHome: home });
    const repo = new StateRunDurabilityRepository(driver);
    const openedAt = "2026-08-19T00:00:00.000Z";
    repo.ensureInitialEpoch({ runId: RUN_ID, openedAt });
    const intentDigest = sha256Digest("degraded-terminal-projection");
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
    const rolloutPath = () => rollout!.rolloutPath;
    const warnings: string[] = [];
    const recordedEventIds: string[] = [];
    const recordTerminalResult = repo.recordTerminalResult.bind(repo);
    repo.recordTerminalResult = (params) => {
      recordedEventIds.push(params.eventId);
      return recordTerminalResult(params);
    };
    const eventLog = new EventLog();
    eventLog.seedLastSeq(1);
    let opened = false;
    let terminalWrites = 0;
    const registry = new PermissionModeRegistry(baseContext("default"));
    const abortController = new AbortController();
    let caughtTerminal: ReturnType<typeof repo.getCurrentTerminalResult> | "unset" = "unset";
    let releaseClose = (): void => {};
    let markCloseEntered = (): void => {};
    const closeEntered = new Promise<void>((resolve) => {
      markCloseEntered = resolve;
    });
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
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
            originator: "degraded-terminal-projection",
            agencVersion: "0.2.0",
            model: "test-model",
            modelProvider: "test-provider",
          });
          opened = true;
          rollout!.store.setWriteImplForTest((fd, buffer, offset, length) => {
            const text = Buffer.from(buffer).toString("utf8");
            if (text.includes('"type":"run_terminal"')) {
              terminalWrites += 1;
              if (terminalWrites === 1) {
                throw Object.assign(new Error("no space left on device"), {
                  code: "ENOSPC",
                });
              }
            }
            return writeSync(fd, buffer, offset, length);
          });
        }
        return {
          session,
          rolloutStore: rollout,
          shutdown: async () => {
            caughtTerminal = repo.getCurrentTerminalResult(RUN_ID);
            markCloseEntered();
            await closeGate;
            rollout!.store.setWriteImplForTest(writeSync);
            rollout!.close();
          },
        } as never;
      },
    });

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
      now: () => new Date("2026-08-19T00:00:02.000Z"),
    });

    const resumePromise = controller.resumeOpenWorkflows();
    let assertionError: unknown;
    try {
      const outcome = await Promise.race([
        closeEntered.then(() => "entered" as const),
        resumePromise.then(
          () => "done" as const,
          () => "failed" as const,
        ),
      ]);
      expect(outcome, warnings.join("\n")).toBe("entered");
      expect(caughtTerminal).toBeUndefined();
      expect(recordedEventIds).toEqual([]);
      expect(countTerminals(readFileSync(rolloutPath()))).toBe(0);
    } catch (error) {
      assertionError = error;
    } finally {
      releaseClose();
    }
    const resumed = await resumePromise;
    if (assertionError !== undefined) throw assertionError;

    expect(resumed, warnings.join("\n")).toEqual([RUN_ID]);
    const bytes = readFileSync(rolloutPath());
    expect(countTerminals(bytes)).toBe(1);
    const journal = journalTerminal(bytes);
    const row = repo.getCurrentTerminalResult(RUN_ID);
    expect(row).toMatchObject({
      eventId: journal.eventId,
      epoch: journal.msg.payload.epoch,
      lastSequence: journal.seq,
      status: journal.msg.payload.status,
      exitCode: journal.msg.payload.exitCode,
      stopReason: journal.msg.payload.stopReason,
      finalMessage: journal.msg.payload.finalMessage,
      usage: journal.msg.payload.usage,
      finishedAt: journal.msg.payload.finishedAt,
    });
    expect(row?.eventId).toBe(journal.eventId);
    expect(journal.id).not.toMatch(/^workflow-detached-terminal:/);
    expect(row?.eventId).not.toMatch(/^workflow-detached-terminal:/);
    expect(recordedEventIds).toEqual([journal.eventId]);
    expect(bytes.toString("utf8").match(/"type":"run_terminal"/g)).toHaveLength(1);
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
