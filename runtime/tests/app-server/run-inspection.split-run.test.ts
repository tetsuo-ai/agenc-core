/**
 * A chat whose run was split across two project databases stays readable.
 *
 * Core 0.19.38 opened a resumed chat's state database from the chat's folder.
 * When a root marker (here `package.json`) appeared above the folder between
 * two daemon runs, the folder named another project: the resume wrote a new
 * epoch, a journal binding and admission records into that project's
 * database, while it kept appending to the rollout in the first one. From then
 * on run.status, run.replay and run.evidence refused the run with
 * RUN_ID_AMBIGUOUS, and Desktop's actions card failed for that chat. Resumes
 * no longer split a run; a run split before stays split, so inspection reads
 * the project that holds its rollout and says the answer is partial.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgenCDaemonRunInspectionService } from "../../src/app-server/run-inspection.js";
import type { RunJournalEvent } from "../../src/app-server/protocol/index.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { upsertAgentRun } from "../../src/state/agent-runs.js";
import { discoverStateDatabasePaths } from "../../src/state/database-paths.js";
import { StateRunDurabilityRepository } from "../../src/state/run-durability.js";
import * as sqliteDriver from "../../src/state/sqlite-driver.js";
import { StateThreadRepository } from "../../src/state/threads.js";
import { VERSION } from "../../src/version.js";
import { canonicalTmpdir } from "../helpers/canonical-temp-dir.js";

const RUN_ID = "conv-split-run";
const OWN_RUN_TABLES = [
  "agent_runs", "run_lifecycle_epochs", "run_journal_bindings", "run_terminal_results", "run_effects",
  "execution_admission_journal", "execution_admission_reservations",
] as const;

let root = "";
let home = "";
let workspace = "";
let rolloutPath = "";
let sequence = 0;
let firstProject = "";
let folderProject = "";

beforeEach(() => {
  root = mkdtempSync(join(canonicalTmpdir(), "agenc-split-run-"));
  home = join(root, "agenc-home");
  // The chat's folder sits in a site folder with no root marker yet.
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

/** One admitted model call, recorded where `cwd` resolves and mirrored into the rollout like a session does. */
async function admittedModelCall(store: RolloutStore, inputTokens: number): Promise<void> {
  const kernel = new ExecutionAdmissionKernel({ agencHome: home, ownerId: "split-run-test", ownerPid: process.pid });
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

/** The daemon's own row for the chat, routed by the chat's folder. */
function recordDaemonRun(status: string, sessionId: string): void {
  const driver = sqliteDriver.openStateDatabases({ cwd: workspace, agencHome: home });
  try {
    const now = new Date().toISOString();
    upsertAgentRun(driver, { id: RUN_ID, objective: "Interactive session", status, startedAt: now, lastActiveAt: now,
      currentSessionId: sessionId });
  } finally {
    driver.close();
  }
}

/** The thread row the resumed chat's thread store wrote where its folder resolves: the rollout, no folder. */
function recordThreadRow(threadRolloutPath: string): void {
  const driver = sqliteDriver.openStateDatabases({ cwd: workspace, agencHome: home });
  try {
    const now = new Date().toISOString();
    new StateThreadRepository(driver).upsertThread({ threadId: RUN_ID, createdAt: now, updatedAt: now, rolloutPath: threadRolloutPath });
  } finally {
    driver.close();
  }
}

/**
 * Turn 1 before the marker, then `npm init` above the folder, then a daemon
 * restart and a resume the way Core 0.19.38 did it: its rollout store opened
 * the database of the project found again from the folder. `stopped`: turn 1
 * ended the run, so the resume reopened it into a new epoch.
 */
async function splitTheRun(options: { readonly stopped?: boolean } = {}): Promise<void> {
  firstProject = sqliteDriver.resolveStateDatabasePaths({ cwd: workspace, agencHome: home }).projectDir;
  const first = new RolloutStore(storeOptions());
  first.open(openMeta());
  rolloutPath = first.rolloutPath;
  recordDaemonRun("running", "session-1");
  await admittedModelCall(first, 10);
  if (options.stopped === true) {
    sequence += 1;
    first.append({ id: "turn-1-terminal", eventId: "turn-1-terminal", seq: sequence, msg: { type: "run_terminal", payload: {
      runId: RUN_ID, epoch: first.runEpoch, status: "completed", exitCode: 0, stopReason: "completed",
      finalMessage: "done", usage: null, lastSequenceBeforeTerminal: sequence - 1, finishedAt: new Date().toISOString(),
    } } }, { durable: true });
  }
  first.close();
  recordDaemonRun("completed", "session-1");

  writeFileSync(join(root, "site", "package.json"), "{\"name\":\"site\"}\n");
  const folderPaths = sqliteDriver.resolveStateDatabasePaths({ cwd: workspace, agencHome: home });
  folderProject = folderPaths.projectDir;
  expect(folderProject).not.toBe(firstProject);

  // Before agenc-core #3609 the resumed store opened `openStateDatabases({ cwd })`.
  const opened = vi.spyOn(sqliteDriver, "stateDatabasePathsForProjectDir").mockImplementationOnce(() => folderPaths);
  const resumed = new RolloutStore({ ...storeOptions(), resume: true, resumeRolloutPath: rolloutPath,
    ...(options.stopped === true ? { reopenTerminalRun: true } : {}) });
  expect(opened).toHaveBeenCalledTimes(1);
  resumed.open(openMeta());
  expect(resumed.rolloutPath).toBe(rolloutPath);
  sequence = Math.max(sequence, ...resumed.readAll().flatMap((item) =>
    item.type === "event_msg" && typeof (item.payload as { seq?: unknown }).seq === "number" ? [(item.payload as { seq: number }).seq] : []));
  recordThreadRow(rolloutPath);
  recordDaemonRun("running", "session-2");
  await admittedModelCall(resumed, 20);
  resumed.close();
  recordDaemonRun("completed", "session-2");
}

function inspection(): AgenCDaemonRunInspectionService {
  return new AgenCDaemonRunInspectionService({ agencHome: home, stateDatabasePaths: () => discoverStateDatabasePaths(home) });
}

function replayAll(service: AgenCDaemonRunInspectionService) {
  const events: RunJournalEvent[] = [];
  let after = 0;
  for (;;) {
    const page = service.replay({ runId: RUN_ID, afterSequence: after, limit: 200 });
    expect(page.gap).toBeNull();
    events.push(...page.events);
    if (!page.hasMore) return { events, source: page.source };
    after = page.nextAfterSequence;
  }
}

/** Every row of the run in one project's state database, keyed by table, read without writing. */
function rowsOf(projectDir: string): Record<string, unknown[]> {
  const db = new Database(sqliteDriver.stateDatabasePathsForProjectDir(projectDir).stateDbPath,
    { readonly: true, fileMustExist: true });
  try {
    return Object.fromEntries(OWN_RUN_TABLES.map((table) => [table, db.prepare(
      `SELECT * FROM ${table} WHERE ${table === "agent_runs" ? "id" : "run_id"} = ? ORDER BY rowid`,
    ).all(RUN_ID)]));
  } finally {
    db.close();
  }
}

function projectsHoldingTheRun(): string[] {
  return discoverStateDatabasePaths(home).map((paths) => paths.projectDir)
    .filter((projectDir) => Object.values(rowsOf(projectDir)).some((rows) => rows.length > 0)).sort();
}

describe("a run split across two project databases by an earlier resume", () => {
  it("reads from the project that holds its rollout and says the answer is partial", async () => {
    await splitTheRun();
    expect(projectsHoldingTheRun()).toEqual([firstProject, folderProject].sort());
    const firstBefore = rowsOf(firstProject);
    const strayBefore = rowsOf(folderProject);
    expect(strayBefore.run_lifecycle_epochs).toHaveLength(1);
    expect(strayBefore.run_journal_bindings).toMatchObject([{ source_path: rolloutPath }]);
    expect(strayBefore.execution_admission_reservations).toHaveLength(1);

    const service = inspection();
    const partial = { reason: "split_run", omittedProjectDirs: [folderProject] };
    // The replay reads the rollout, so it holds both periods' records.
    const replay = replayAll(service);
    expect(replay.source).toEqual({ kind: "run_journal", available: true, sequenceScope: "run",
      canonical: "rollout_jsonl", projection: "thread_rollout_items", projectDir: firstProject, partial });
    const admitted = replay.events.filter((event) => event.kind === "execution_admission");
    expect(admitted.map((event) => event.eventId)).toEqual([
      ...(firstBefore.execution_admission_journal as { event_id: string }[]).map((row) => row.event_id),
      ...(strayBefore.execution_admission_journal as { event_id: string }[]).map((row) => row.event_id),
    ]);
    // The admission summary counts the first project only.
    const status = service.status({ runId: RUN_ID });
    expect(status.source).toEqual({ kind: "existing_state_database", projectDir: firstProject, readonly: true, partial });
    expect(status.admission).toMatchObject({ reservationCount: 1, actualTokens: 11 });
    // The daemon's run row is the first project's too.
    expect(status.durableRun?.currentSessionId).toBe("session-1");
    const evidence = service.evidence({ runId: RUN_ID });
    expect(evidence.source).toMatchObject({ kind: "canonical_run_journal", projectDir: firstProject,
      completeness: "partial", partial });
    expect(evidence.events.length).toBeGreaterThan(0);

    // Reading moves and deletes nothing.
    expect(rowsOf(folderProject)).toEqual(strayBefore);
    const firstAfter = rowsOf(firstProject);
    for (const table of ["run_lifecycle_epochs", "run_journal_bindings", "execution_admission_journal",
      "execution_admission_reservations"] as const) {
      expect(firstAfter[table]).toEqual(firstBefore[table]);
    }
  });

  it("reads a split whose resume reopened a stopped chat into a new epoch", async () => {
    await splitTheRun({ stopped: true });
    // The reopen added epoch 2 in the second project; the rollout is bound once, at epoch 1.
    const stray = rowsOf(folderProject);
    expect((stray.run_lifecycle_epochs as { epoch: number }[]).map((row) => row.epoch)).toEqual([1, 2]);
    expect(stray.run_journal_bindings).toMatchObject([{ epoch: 1, source_path: rolloutPath }]);
    const service = inspection();
    const replay = replayAll(service);
    expect(replay.source).toMatchObject({ projectDir: firstProject, partial: { reason: "split_run", omittedProjectDirs: [folderProject] } });
    expect(replay.events.map((event) => event.kind)).toEqual(expect.arrayContaining(["run_terminal", "run_reopened"]));
    expect(service.status({ runId: RUN_ID })).toMatchObject({ terminal: false, source: { projectDir: firstProject } });
    expect(rowsOf(folderProject)).toEqual(stray);
  });

  it("still refuses when the other project's thread row names another rollout", async () => {
    await splitTheRun();
    expect(() => replayAll(inspection())).not.toThrow();
    recordThreadRow(join(folderProject, "sessions", RUN_ID, "rollout-elsewhere.jsonl"));
    expect(() => inspection().replay({ runId: RUN_ID })).toThrow(expect.objectContaining({ code: "RUN_ID_AMBIGUOUS" }));
  });

  it("still refuses a second rollout of the same run id in another project", async () => {
    await splitTheRun();
    expect(() => replayAll(inspection())).not.toThrow();
    // A different chat journal with the same run id: its own rollout in its own project.
    const other = join(root, "other");
    mkdirSync(join(other, ".git"), { recursive: true });
    const distinct = new RolloutStore({ ...storeOptions(), cwd: other });
    distinct.open({ ...openMeta(), cwd: other });
    distinct.close();
    expect(projectsHoldingTheRun()).toHaveLength(3);
    const service = inspection();
    for (const read of [
      () => service.replay({ runId: RUN_ID }),
      () => service.status({ runId: RUN_ID }),
      () => service.evidence({ runId: RUN_ID }),
    ]) {
      expect(read).toThrow(expect.objectContaining({ code: "RUN_ID_AMBIGUOUS" }));
    }
  });

  it("still refuses when another project holds an epoch of the run that no binding names", async () => {
    await splitTheRun();
    expect(() => replayAll(inspection())).not.toThrow();
    const other = join(root, "other");
    mkdirSync(join(other, ".git"), { recursive: true });
    const driver = sqliteDriver.openStateDatabases({ cwd: other, agencHome: home });
    try {
      new StateRunDurabilityRepository(driver).ensureInitialEpoch({ runId: RUN_ID, openedAt: new Date().toISOString() });
    } finally {
      driver.close();
    }
    expect(projectsHoldingTheRun()).toHaveLength(3);
    expect(() => inspection().status({ runId: RUN_ID })).toThrow(expect.objectContaining({ code: "RUN_ID_AMBIGUOUS" }));
    expect(() => inspection().replay({ runId: RUN_ID })).toThrow(expect.objectContaining({ code: "RUN_ID_AMBIGUOUS" }));
  });
});
