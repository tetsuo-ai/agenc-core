import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { RunSuspensionReason, RunTerminalStatus } from "../../src/contracts/run-contracts.js";
import { StateRunDurabilityRepository } from "../../src/state/run-durability.js";
import { openStateDatabases, type StateSqliteDriver } from "../../src/state/sqlite-driver.js";

let root: string;
let driver: StateSqliteDriver;
let runs: StateRunDurabilityRepository;
const RUN_ID = "goal-pause-terminal";
const OPENED_AT = "2026-09-29T00:00:00.000Z";
const SUSPENDED_AT = "2026-09-29T00:01:00.000Z";
const FINISHED_AT = "2026-09-29T00:02:00.000Z";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workflow-pause-terminal-"));
  const cwd = join(root, "repo");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  driver = openStateDatabases({ cwd, agencHome: join(root, "home") });
  runs = new StateRunDurabilityRepository(driver);
  runs.ensureInitialEpoch({ runId: RUN_ID, openedAt: OPENED_AT });
});

afterEach(() => {
  driver.close();
  rmSync(root, { recursive: true, force: true });
});

function suspend(reason: RunSuspensionReason): void {
  runs.recordRunSuspended({ runId: RUN_ID, epoch: 1, eventId: "paused",
    eventSequence: 1, reason, suspendedAt: SUSPENDED_AT });
}

function terminal(status: RunTerminalStatus) {
  return { epoch: 1, eventId: "terminal", result: {
    runId: RUN_ID, status, exitCode: status === "completed" ? 0 : 1,
    stopReason: null, finalMessage: "Goal stopped", usage: null,
    lastSequence: null, finishedAt: FINISHED_AT,
  } };
}

it("cancels a user-paused Goal without consuming its suspension or changing epochs", () => {
  suspend("workflow_user_pause");
  const paused = runs.getActiveSuspension(RUN_ID);
  expect(runs.recordTerminalResult(terminal("cancelled")).applied).toBe(true);
  expect(runs.recordTerminalResult(terminal("cancelled")).applied).toBe(false);
  expect(runs.getActiveSuspension(RUN_ID)).toEqual(paused);
  expect(runs.currentEpoch(RUN_ID)?.epoch).toBe(1);
  expect(runs.getCurrentTerminalResult(RUN_ID)?.status).toBe("cancelled");
  expect(() => runs.recordRunResumed({ runId: RUN_ID, epoch: 1,
    suspensionEventId: "paused", eventId: "late-resume", eventSequence: 2,
    reason: "workflow_user_resume", resumedAt: FINISHED_AT }))
    .toThrowError(expect.objectContaining({ code: "RUN_EPOCH_CONFLICT" }));
});

it.each(["completed", "failed", "unknown_outcome"] as const)("refuses %s while a Goal is user-paused", status => {
  suspend("workflow_user_pause");
  expect(() => runs.recordTerminalResult(terminal(status)))
    .toThrowError(expect.objectContaining({ code: "RUN_SUSPENSION_CONFLICT" }));
  expect(runs.getCurrentTerminalResult(RUN_ID)).toBeUndefined();
  expect(runs.getActiveSuspension(RUN_ID)?.eventId).toBe("paused");
});

it.each(["completed", "failed", "cancelled", "unknown_outcome"] as const)("keeps the original daemon suspension guard for %s", status => {
  suspend("daemon_shutdown_idle");
  expect(() => runs.recordTerminalResult(terminal(status)))
    .toThrowError(expect.objectContaining({ code: "RUN_SUSPENSION_CONFLICT" }));
  expect(runs.getCurrentTerminalResult(RUN_ID)).toBeUndefined();
  expect(runs.getActiveSuspension(RUN_ID)?.eventId).toBe("paused");
});
