/**
 * A chat split by an earlier resume is listed once per kind of row, from the
 * database that holds its rollout.
 *
 * Core before agenc-core #3609 could split a chat across two project
 * databases (run-inspection.split-run.test.ts makes such a split the same
 * way). After a daemon restart session.list then named the chat four times:
 * the saved session and the thread row of each database. The second
 * database's two rows are the newest and name no folder, so a client that
 * kept one could not reopen the chat ("has no recorded workspace"). They are
 * the rows run inspection leaves out of a split run; the listing now leaves
 * them out by the same rule.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { discoverAgenCDaemonStartupState, type AgenCDaemonSavedSessionListing } from "../../src/app-server/daemon-cli.js";
import { AgenCDaemonRunInspectionService } from "../../src/app-server/run-inspection.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { upsertAgentRun } from "../../src/state/agent-runs.js";
import { discoverStateDatabasePaths } from "../../src/state/database-paths.js";
import * as sqliteDriver from "../../src/state/sqlite-driver.js";
import { StateThreadRepository } from "../../src/state/threads.js";
import { MultiProjectFileThreadStore } from "../../src/thread-store/multi-project-store.js";
import { VERSION } from "../../src/version.js";
import { canonicalTmpdir } from "../helpers/canonical-temp-dir.js";

const RUN_ID = "conv-split-listed";

let root = "";
let home = "";
let workspace = "";
let sequence = 0;
let firstProject = "";
let folderProject = "";
let rolloutPath = "";

beforeEach(() => {
  root = mkdtempSync(join(canonicalTmpdir(), "agenc-split-list-"));
  home = join(root, "agenc-home");
  workspace = join(root, "site", "app");
  mkdirSync(workspace, { recursive: true });
  sequence = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function storeOptions() {
  return { cwd: workspace, sessionId: RUN_ID, agencVersion: VERSION, agencHome: home,
    sessionTempRoot: join(root, "session-tmp"), autoStartScheduler: false };
}

function openMeta() {
  return { sessionId: RUN_ID, timestamp: new Date().toISOString(), cwd: workspace, originator: "agenc-cli",
    source: "interactive-root" as const, agencVersion: VERSION, model: "base-model", modelProvider: "grok" };
}

async function admittedModelCall(store: RolloutStore, inputTokens: number): Promise<void> {
  const kernel = new ExecutionAdmissionKernel({ agencHome: home, ownerId: "split-list-test", ownerPid: process.pid });
  try {
    const client = kernel.bindClient({ cwd: workspace, scope: { runId: RUN_ID, sessionId: RUN_ID, autonomous: false },
      budget: { runMaxCostUsd: 1 } });
    const lease = await client.acquire({ stepId: `model:${inputTokens}`, kind: "model_turn", maxInputTokens: 100,
      maxOutputTokens: 5, maxCostUsd: 0.1 });
    client.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
    client.reconcile(lease.reservation.reservationId, { inputTokens, outputTokens: 1, costUsd: 0.01 });
    for (const event of client.replayJournal?.() ?? []) {
      sequence += 1;
      store.append({ id: event.eventId, eventId: event.eventId, seq: sequence,
        msg: { type: "execution_admission", payload: event } }, { durable: true });
    }
  } finally {
    kernel.close();
  }
}

/** The daemon's run row and the thread store's row, written where the chat's folder resolves. */
function recordRows(sessionId: string, thread: { readonly cwd?: string }): void {
  const driver = sqliteDriver.openStateDatabases({ cwd: workspace, agencHome: home });
  try {
    const now = new Date().toISOString();
    upsertAgentRun(driver, { id: RUN_ID, objective: "Interactive session", status: "suspended", startedAt: now,
      lastActiveAt: now, currentSessionId: sessionId });
    new StateThreadRepository(driver).upsertThread({ threadId: RUN_ID, createdAt: now, updatedAt: now, rolloutPath,
      model: "base-model", modelProvider: "grok", ...thread });
  } finally {
    driver.close();
  }
}

/** Turn 1, a `package.json` above the folder, and a resume as Core 0.19.38 did it, then turn 2. */
async function splitTheChat(): Promise<void> {
  firstProject = sqliteDriver.resolveStateDatabasePaths({ cwd: workspace, agencHome: home }).projectDir;
  const first = new RolloutStore(storeOptions());
  first.open(openMeta());
  rolloutPath = first.rolloutPath;
  recordRows("session-1", { cwd: workspace });
  await admittedModelCall(first, 10);
  first.close();

  writeFileSync(join(root, "site", "package.json"), "{\"name\":\"site\"}\n");
  const folderPaths = sqliteDriver.resolveStateDatabasePaths({ cwd: workspace, agencHome: home });
  folderProject = folderPaths.projectDir;
  expect(folderProject).not.toBe(firstProject);
  // Before agenc-core #3609 the resumed store opened `openStateDatabases({ cwd })`.
  vi.spyOn(sqliteDriver, "stateDatabasePathsForProjectDir").mockImplementationOnce(() => folderPaths);
  const resumed = new RolloutStore({ ...storeOptions(), resume: true, resumeRolloutPath: rolloutPath });
  resumed.open(openMeta());
  vi.restoreAllMocks();
  sequence = Math.max(sequence, ...resumed.readAll().flatMap((item) =>
    item.type === "event_msg" && typeof (item.payload as { seq?: unknown }).seq === "number" ? [(item.payload as { seq: number }).seq] : []));
  // The resumed chat's thread store wrote its row where the folder resolves: the rollout, no folder.
  recordRows("session-2", {});
  await admittedModelCall(resumed, 20);
  resumed.close();
}

describe("session.list of a chat an earlier resume split", () => {
  it("leaves out the second database's saved session, and keeps both as restore targets", async () => {
    await splitTheChat();
    // Run inspection reads the chat partial, leaving the folder's database out.
    expect(new AgenCDaemonRunInspectionService({ agencHome: home, stateDatabasePaths: () => discoverStateDatabasePaths(home) })
      .status({ runId: RUN_ID }).source.partial).toEqual({ reason: "split_run", omittedProjectDirs: [folderProject] });

    const listings = new Map<string, AgenCDaemonSavedSessionListing>();
    const report = discoverAgenCDaemonStartupState(home, workspace, listings);
    expect(report.recoveredRuns.filter((run) => run.id === RUN_ID).map((run) => [run.projectDir, run.currentSessionId]).sort())
      .toEqual([[firstProject, "session-1"], [folderProject, "session-2"]].sort());
    const byProject = new Map([...listings].map(([key, listing]) => [key.split("\0")[0], listing]));
    expect(byProject.get(firstProject)).toEqual({ cwd: workspace, model: "base-model", modelProvider: "grok" });
    expect(byProject.get(folderProject)).toEqual({ model: "base-model", modelProvider: "grok", splitRunStray: true });
  });

  it("lists the chat's thread row from the database that holds its rollout only", async () => {
    await splitTheChat();
    const store = new MultiProjectFileThreadStore({ primaryCwd: join(root, "elsewhere"), agencHome: home, deferPrimary: true });
    try {
      // The bounded page session.list reads, and the filtered listing.
      for (const params of [
        { pageSize: 50, archived: false, useStateDbOnly: true },
        { pageSize: 50, archived: false, useStateDbOnly: true, searchTerm: "" },
      ] as const) {
        const rows = store.listThreads(params).items.filter((item) => item.threadId === RUN_ID);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ cwd: workspace, rolloutPath });
      }
    } finally {
      store.close();
    }
  });

  it("keeps listing both databases' rows when the split is one the reader refuses", async () => {
    await splitTheChat();
    // The second database's thread row now names another rollout: not a split
    // the reader accepts, so nothing is left out and inspection refuses.
    const driver = sqliteDriver.openStateDatabases({ cwd: workspace, agencHome: home });
    try {
      const now = new Date().toISOString();
      new StateThreadRepository(driver).upsertThread({ threadId: RUN_ID, createdAt: now, updatedAt: now,
        rolloutPath: join(folderProject, "sessions", RUN_ID, "rollout-elsewhere.jsonl") });
    } finally {
      driver.close();
    }
    expect(() => new AgenCDaemonRunInspectionService({ agencHome: home, stateDatabasePaths: () => discoverStateDatabasePaths(home) })
      .status({ runId: RUN_ID })).toThrow(expect.objectContaining({ code: "RUN_ID_AMBIGUOUS", reason: "project_split" }));
    const listings = new Map<string, AgenCDaemonSavedSessionListing>();
    discoverAgenCDaemonStartupState(home, workspace, listings);
    expect([...listings.values()].some((listing) => listing.splitRunStray === true)).toBe(false);
    const store = new MultiProjectFileThreadStore({ primaryCwd: join(root, "elsewhere"), agencHome: home, deferPrimary: true });
    try {
      expect(store.listThreads({ pageSize: 50, archived: false, useStateDbOnly: true }).items
        .filter((item) => item.threadId === RUN_ID)).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});
