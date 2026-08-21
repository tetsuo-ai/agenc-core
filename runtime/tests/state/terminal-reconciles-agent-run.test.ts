/**
 * Recording a terminal result must bring the agent-runs rail row with it.
 *
 * The verdict landed in `run_terminal_results` while `agent_runs.status`
 * stayed "running" forever: dozens of long-dead runs per project database
 * still advertised themselves as live to anything reading the rail. The
 * lifecycle-epoch source was right all along — the rail simply never heard.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { upsertAgentRun } from "../../src/state/agent-runs.js";
import { cancelAgentRunTree } from "../../src/state/run-cancellation.js";
import { StateRunDurabilityRepository } from "../../src/state/run-durability.js";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";

const NOW = "2026-08-21T12:00:00.000Z";
const LATER = "2026-08-21T12:30:00.000Z";

let home: string;
let cwd: string;
let driver: StateSqliteDriver;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-terminal-rail-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-terminal-rail-cwd-"));
  driver = openStateDatabases({ cwd, agencHome: home });
});

afterEach(() => {
  driver.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function railStatus(id: string): string | undefined {
  return driver
    .prepareState<[string], { status?: string }>(
      "SELECT status FROM agent_runs WHERE id = ?",
    )
    .get(id)?.status;
}

function recordTerminal(
  repo: StateRunDurabilityRepository,
  runId: string,
  status: string,
): void {
  repo.ensureInitialEpoch({ runId, openedAt: NOW });
  repo.recordTerminalResult({
    epoch: 1,
    eventId: `terminal-${runId}`,
    result: {
      runId,
      status,
      exitCode: status === "completed" ? 0 : 1,
      stopReason: null,
      finalMessage: "done",
      usage: null,
      lastSequence: 1,
      finishedAt: LATER,
    },
  });
}

describe("terminal results and the agent-runs rail", () => {
  it("marks the rail row with the verdict, in step", () => {
    upsertAgentRun(driver, {
      id: "wf-rail-1",
      objective: "verified-change: test",
      status: "running",
      startedAt: NOW,
      lastActiveAt: NOW,
    });
    const repo = new StateRunDurabilityRepository(driver);
    recordTerminal(repo, "wf-rail-1", "completed");
    expect(railStatus("wf-rail-1")).toBe("completed");
  });

  it("a failed run stops advertising itself as running", () => {
    upsertAgentRun(driver, {
      id: "wf-rail-2",
      objective: "verified-change: test",
      status: "running",
      startedAt: NOW,
      lastActiveAt: NOW,
    });
    recordTerminal(new StateRunDurabilityRepository(driver), "wf-rail-2", "failed");
    expect(railStatus("wf-rail-2")).toBe("failed");
  });

  it("never overwrites a cancel-locked row", () => {
    upsertAgentRun(driver, {
      id: "wf-rail-3",
      objective: "verified-change: test",
      status: "running",
      startedAt: NOW,
      lastActiveAt: NOW,
    });
    cancelAgentRunTree(driver, {
      runId: "wf-rail-3",
      reason: "user",
      cancelledAt: NOW,
    });
    recordTerminal(new StateRunDurabilityRepository(driver), "wf-rail-3", "completed");
    expect(railStatus("wf-rail-3")).toBe("cancelled");
  });

  it("a child run with no rail row records its terminal untroubled", () => {
    const repo = new StateRunDurabilityRepository(driver);
    recordTerminal(repo, "wf-rail-4:plan#1", "completed");
    expect(railStatus("wf-rail-4:plan#1")).toBeUndefined();
    expect(repo.getTerminalResult("wf-rail-4:plan#1", 1)?.status).toBe(
      "completed",
    );
  });
});
