/**
 * Run inspection reads its answer from the snapshot it proved authority on.
 *
 * run.status, run.replay, run.result and run.evidence proved a run's
 * admission authority on one read of its project database, then refreshed
 * the projection again and read the answer in a new connection. Anything
 * written between the two (a line the projection imported, a row another
 * writer committed) reached the answer without the proof having seen it: an
 * admission event that no journal holds was served as the run's own record.
 * Each method now proves authority and reads its answer in one read
 * transaction of every database it reads.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import type BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgenCDaemonRunInspectionService } from "../../src/app-server/run-inspection.js";
import type { ExecutionAdmissionClient } from "../../src/budget/admission-client.js";
import type { AdmissionJournalEvent } from "../../src/budget/admission-types.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { serializeRolloutItem } from "../../src/session/rollout-item.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { upsertAgentRun } from "../../src/state/agent-runs.js";
import { discoverStateDatabasePaths } from "../../src/state/database-paths.js";
import * as sqliteEngine from "../../src/state/sqlite-engine.js";
import * as journalRecovery from "../../src/state/startup-run-journal-recovery.js";
import { openStateDatabasePaths, openStateDatabases, type StateDatabasePaths } from "../../src/state/sqlite-driver.js";
import { recoverCanonicalRunJournalForRun } from "../../src/state/startup-run-journal-recovery.js";
import { VERSION } from "../../src/version.js";
import { canonicalTmpdir } from "../helpers/canonical-temp-dir.js";

const RUN_ID = "conv-snapshot";
const OBJECTIVE = "Interactive session";
const FORGED = "admission-written-after-the-proof";
/** The statement with which run inspection reads the run's admission records for its proof. */
const AUTHORITY_READ = "json_extract(payload_json, '$.msg.type') = 'execution_admission'";

let root = "";
let home = "";
let workspace = "";
let rolloutPath = "";
let lastSequence = 0;
let template: AdmissionJournalEvent;

beforeEach(async () => {
  root = mkdtempSync(join(canonicalTmpdir(), "agenc-inspection-snapshot-"));
  home = join(root, "agenc-home");
  workspace = join(root, "project");
  mkdirSync(join(workspace, ".git"), { recursive: true });
  // A finished chat: two admitted model calls in its rollout, its daemon run
  // row and its terminal, all in its project's database.
  const kernel = new ExecutionAdmissionKernel({ agencHome: home, ownerId: "snapshot-test", ownerPid: process.pid });
  const store = new RolloutStore({ cwd: workspace, sessionId: RUN_ID, agencVersion: VERSION, agencHome: home,
    sessionTempRoot: join(root, "session-tmp"), autoStartScheduler: false });
  try {
    const chat = kernel.bindClient({ cwd: workspace, scope: { runId: RUN_ID, sessionId: RUN_ID, autonomous: false },
      budget: { runMaxCostUsd: 1 } });
    store.open({ sessionId: RUN_ID, timestamp: new Date().toISOString(), cwd: workspace, originator: "agenc-cli",
      source: "interactive-root", agencVersion: VERSION, model: "base-model", modelProvider: "grok" });
    rolloutPath = store.rolloutPath;
    lastSequence = 0;
    for (const stepId of ["model:1", "model:2"]) {
      for (const event of await admit(chat, stepId)) {
        lastSequence += 1;
        store.append({ id: event.eventId, eventId: event.eventId, seq: lastSequence,
          msg: { type: "execution_admission", payload: event } }, { durable: true });
        template = event;
      }
    }
    lastSequence += 1;
    store.append({ id: "chat-terminal", eventId: "chat-terminal", seq: lastSequence, msg: { type: "run_terminal", payload: {
      runId: RUN_ID, epoch: store.runEpoch, status: "completed", exitCode: 0, stopReason: "completed", finalMessage: "done",
      usage: null, lastSequenceBeforeTerminal: lastSequence - 1, finishedAt: new Date().toISOString(),
    } } }, { durable: true });
  } finally {
    store.close();
    kernel.close();
  }
  recordRun(OBJECTIVE);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

async function admit(client: ExecutionAdmissionClient, stepId: string): Promise<readonly AdmissionJournalEvent[]> {
  const before = new Set((client.replayJournal?.() ?? []).map((event) => event.eventId));
  const lease = await client.acquire({ stepId, kind: "model_turn", sessionId: RUN_ID, maxInputTokens: 100,
    maxOutputTokens: 5, maxCostUsd: 0.1 });
  client.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
  client.reconcile(lease.reservation.reservationId, { inputTokens: 40, outputTokens: 2, costUsd: 0.01 });
  return (client.replayJournal?.() ?? []).filter((event) => !before.has(event.eventId));
}

function recordRun(objective: string): void {
  const driver = openStateDatabases({ cwd: workspace, agencHome: home });
  try {
    upsertAgentRun(driver, { id: RUN_ID, objective, status: "completed", startedAt: "2026-11-20T08:00:00.000Z",
      lastActiveAt: "2026-11-20T08:05:00.000Z", currentSessionId: RUN_ID });
  } finally {
    driver.close();
  }
}

function projectPaths() {
  const [paths] = discoverStateDatabasePaths(home);
  if (paths === undefined) throw new Error("the chat has no project database");
  return paths;
}

/** Append an admission event of the run that no journal holds, and let the run's projection import it. */
function forgeAdmission(target: { readonly runId: string; readonly rolloutPath: string; readonly sequence: number;
  readonly template: AdmissionJournalEvent; readonly paths: StateDatabasePaths }): void {
  appendFileSync(target.rolloutPath, serializeRolloutItem({ type: "event_msg", payload: { id: FORGED, eventId: FORGED,
    seq: target.sequence, msg: { type: "execution_admission", payload: { ...target.template, eventId: FORGED, actualTokens: 9_999 } } } }));
  const driver = openStateDatabasePaths(target.paths);
  try {
    recoverCanonicalRunJournalForRun(driver, target.runId, { strict: { liveSourceDeferral: "skip", projectionFailure: "throw" } });
  } finally {
    driver.close();
  }
}

/**
 * What another writer does while a read is under way: a line the run's
 * projection imports (an admission event of the run that no journal holds),
 * and a new daemon run row.
 */
function writeAfterTheProof(): void {
  lastSequence += 1;
  forgeAdmission({ runId: RUN_ID, rolloutPath, sequence: lastSequence, template, paths: projectPaths() });
  recordRun("written after the proof");
}

/**
 * Make the change right after run inspection has read the run's admission
 * records for its proof, whatever it reads next. Returns whether it ran.
 */
function changeAfterTheProofRead(change: () => void): () => boolean {
  let changed = false;
  const open = sqliteEngine.openSqliteDatabase;
  vi.spyOn(sqliteEngine, "openSqliteDatabase").mockImplementation((path, options) => {
    const db = open(path, options);
    const prepare = db.prepare.bind(db) as (sql: string) => BetterSqlite3.Statement;
    db.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if (!sql.includes(AUTHORITY_READ)) return statement;
      const all = statement.all.bind(statement) as (...params: unknown[]) => unknown[];
      statement.all = ((...params: unknown[]) => {
        const rows = all(...params);
        if (!changed) {
          changed = true;
          change();
        }
        return rows;
      }) as typeof statement.all;
      return statement;
    }) as typeof db.prepare;
    return db;
  });
  return () => changed;
}

/**
 * Make the change when run inspection prepares the statement that reads the
 * run's admission records for its proof, before that statement runs.
 */
function changeBeforeTheProofRead(change: () => void): () => boolean {
  let changed = false;
  const open = sqliteEngine.openSqliteDatabase;
  vi.spyOn(sqliteEngine, "openSqliteDatabase").mockImplementation((path, options) => {
    const db = open(path, options);
    const prepare = db.prepare.bind(db) as (sql: string) => BetterSqlite3.Statement;
    db.prepare = ((sql: string) => {
      if (!changed && sql.includes(AUTHORITY_READ)) {
        changed = true;
        change();
      }
      return prepare(sql);
    }) as typeof db.prepare;
    return db;
  });
  return () => changed;
}

function inspection(): AgenCDaemonRunInspectionService {
  return new AgenCDaemonRunInspectionService({ agencHome: home, stateDatabasePaths: () => discoverStateDatabasePaths(home) });
}

/** The change reached the database: a fresh read sees the unproven event and refuses. */
function expectRefusedAfterwards(): void {
  vi.restoreAllMocks();
  expect(() => inspection().replay({ runId: RUN_ID, limit: 200 }))
    .toThrow(expect.objectContaining({ code: "RUN_ID_AMBIGUOUS", reason: "admission_owner_unproved" }));
}

describe("a change between the proof and the read", () => {
  it("does not reach run.replay", () => {
    expect(inspection().replay({ runId: RUN_ID, limit: 200 }).events.map((event) => event.eventId)).not.toContain(FORGED);
    const changed = changeAfterTheProofRead(writeAfterTheProof);
    const page = inspection().replay({ runId: RUN_ID, limit: 200 });
    expect(changed()).toBe(true);
    expect(page.events.map((event) => event.eventId)).not.toContain(FORGED);
    expect(page.events.at(-1)).toMatchObject({ eventId: "chat-terminal", kind: "run_terminal" });
    expectRefusedAfterwards();
  });

  it("does not reach run.evidence", () => {
    const changed = changeAfterTheProofRead(writeAfterTheProof);
    const evidence = inspection().evidence({ runId: RUN_ID, limit: 200 });
    expect(changed()).toBe(true);
    expect(evidence.events.map((event) => event.eventId)).not.toContain(FORGED);
    expect(evidence.hashes.eventHashes.map((hash) => hash.eventId)).not.toContain(FORGED);
    expect(evidence.source).toMatchObject({ completeness: "complete" });
    expectRefusedAfterwards();
  });

  it("does not reach run.status", () => {
    const changed = changeAfterTheProofRead(writeAfterTheProof);
    const status = inspection().status({ runId: RUN_ID });
    expect(changed()).toBe(true);
    expect(status).toMatchObject({ status: "completed", terminal: true, durableRun: { objective: OBJECTIVE },
      admission: { reservationCount: 2, actualTokens: 2 * 42 } });
    expectRefusedAfterwards();
  });

  it("cannot hide a projection row from the proof once the answer's snapshot holds it", () => {
    // The unproven event is in the projection when the read starts; it is
    // dropped just before the proof reads the admission records (as a
    // rebuild of the projection would drop it). The proof reads the same
    // snapshot as the answer, so it sees the event and refuses; a proof
    // read anywhere else would pass while the answer served the event.
    lastSequence += 1;
    forgeAdmission({ runId: RUN_ID, rolloutPath, sequence: lastSequence, template, paths: projectPaths() });
    const changed = changeBeforeTheProofRead(() => {
      const driver = openStateDatabasePaths(projectPaths());
      try {
        driver.state.prepare("DELETE FROM thread_rollout_items WHERE thread_id = ? AND event_id = ?").run(RUN_ID, FORGED);
      } finally {
        driver.close();
      }
    });
    for (const read of [
      () => inspection().replay({ runId: RUN_ID, limit: 200 }),
      () => inspection().evidence({ runId: RUN_ID, limit: 200 }),
    ]) {
      expect(read).toThrow(expect.objectContaining({ code: "RUN_ID_AMBIGUOUS", reason: "admission_owner_unproved" }));
      expect(changed()).toBe(true);
      vi.restoreAllMocks();
      // The next read imports the line again; drop it again on the next read's proof.
      changeBeforeTheProofRead(() => {
        const driver = openStateDatabasePaths(projectPaths());
        try {
          driver.state.prepare("DELETE FROM thread_rollout_items WHERE thread_id = ? AND event_id = ?").run(RUN_ID, FORGED);
        } finally {
          driver.close();
        }
      });
    }
  });

  it("reads the daemon's run row from the snapshot, not from the lookup before it", () => {
    // The run row goes (as terminal-run retention prunes it) after run
    // inspection found the run and before it opened its snapshot.
    const refresh = journalRecovery.recoverCanonicalRunJournalForRun;
    vi.spyOn(journalRecovery, "recoverCanonicalRunJournalForRun").mockImplementation((driver, runId, options) => {
      const result = refresh(driver, runId, options);
      driver.state.prepare("DELETE FROM agent_runs WHERE id = ?").run(RUN_ID);
      return result;
    });
    const status = inspection().status({ runId: RUN_ID });
    expect(status).toMatchObject({ status: "completed", terminal: true, statusSource: "run_terminal_result" });
    expect(status.durableRun).toBeUndefined();
    vi.restoreAllMocks();
    recordRun(OBJECTIVE);
    vi.spyOn(journalRecovery, "recoverCanonicalRunJournalForRun").mockImplementation((driver, runId, options) => {
      const result = refresh(driver, runId, options);
      driver.state.prepare("DELETE FROM agent_runs WHERE id = ?").run(RUN_ID);
      return result;
    });
    const result = inspection().result({ runId: RUN_ID });
    expect(result).toMatchObject({ status: "completed", terminal: true, output: { available: true, finalMessage: "done" } });
    expect(result.durableRun).toBeUndefined();
  });

  it("does not reach run.result", () => {
    const changed = changeAfterTheProofRead(writeAfterTheProof);
    const result = inspection().result({ runId: RUN_ID });
    expect(changed()).toBe(true);
    expect(result).toMatchObject({ status: "completed", terminal: true, durableRun: { objective: OBJECTIVE },
      output: { available: true, finalMessage: "done" } });
    expectRefusedAfterwards();
  });
});

/**
 * A child run in a worktree project whose admission is journaled in its
 * parent's project, as session/child-run-journal.ts declares it.
 */
async function worktreeChild() {
  const child = "worktree-child";
  const parentCwd = join(root, "parent");
  const worktreeCwd = join(root, "worktree");
  mkdirSync(join(parentCwd, ".git"), { recursive: true });
  mkdirSync(join(worktreeCwd, ".git"), { recursive: true });
  const parent = openStateDatabases({ cwd: parentCwd, agencHome: home });
  const worktree = openStateDatabases({ cwd: worktreeCwd, agencHome: home });
  const kernel = new ExecutionAdmissionKernel({ agencHome: home, ownerId: "snapshot-child-test", ownerPid: process.pid });
  const store = new RolloutStore({ cwd: worktreeCwd, sessionId: child, agencVersion: VERSION, agencHome: home,
    sessionTempRoot: join(root, "session-tmp"), autoStartScheduler: false });
  let sequence = 0;
  let last: AdmissionJournalEvent | undefined;
  try {
    const client = kernel.bindClient({ cwd: parentCwd, scope: { runId: "parent-run", sessionId: "parent-run", autonomous: false },
      budget: { runMaxCostUsd: 1 } }).forSession({ runId: child, sessionId: child });
    const lease = await client.acquire({ stepId: "model:1", kind: "model_turn", maxInputTokens: 10, maxOutputTokens: 5, maxCostUsd: 0.1 });
    client.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
    client.reconcile(lease.reservation.reservationId, { inputTokens: 4, outputTokens: 2, costUsd: 0.03 });
    store.open({ sessionId: child, cwd: worktreeCwd, timestamp: new Date().toISOString(), originator: "agenc-subagent",
      agencVersion: VERSION, admissionOwner: { workspaceId: parent.projectDir, runId: child, parentRunId: "parent-run" } });
    for (const event of client.replayJournal?.() ?? []) {
      sequence += 1;
      store.append({ id: event.eventId, eventId: event.eventId, seq: sequence, msg: { type: "execution_admission", payload: event } },
        { durable: true });
      last = event;
    }
  } finally {
    store.close();
    kernel.close();
  }
  const paths = { projectDir: worktree.projectDir, stateDbPath: worktree.stateDbPath, logsDbPath: worktree.logsDbPath };
  return {
    child, parent, worktree,
    forge: () => forgeAdmission({ runId: child, rolloutPath: store.rolloutPath, sequence: sequence + 1, template: last!, paths }),
    inspection: () => new AgenCDaemonRunInspectionService({ agencHome: home, stateDatabasePaths: () => [parent, worktree] }),
    close: () => {
      parent.close();
      worktree.close();
    },
  };
}

describe("a change between the proof and the read of a worktree child", () => {
  it("does not reach run.replay when the admission owner is another project", async () => {
    const run = await worktreeChild();
    try {
      expect(run.inspection().status({ runId: run.child }).source).toMatchObject({ projectDir: run.worktree.projectDir,
        admissionProjectDir: run.parent.projectDir });
      const changed = changeAfterTheProofRead(run.forge);
      const page = run.inspection().replay({ runId: run.child, limit: 200 });
      expect(changed()).toBe(true);
      expect(page.events.map((event) => event.eventId)).not.toContain(FORGED);
      expect(page.events).toHaveLength(4);
      vi.restoreAllMocks();
      expect(() => run.inspection().replay({ runId: run.child, limit: 200 }))
        .toThrow(expect.objectContaining({ code: "RUN_ID_AMBIGUOUS", reason: "admission_owner_unproved" }));
    } finally {
      run.close();
    }
  });
});

describe("closing the snapshot", () => {
  it("closes every connection and keeps the refusal when one connection fails to close", async () => {
    const run = await worktreeChild();
    try {
      run.forge();
      // The snapshot's connections: the child's database, then its admission
      // owner's. The first one's close fails (and leaves it open).
      const snapshots: BetterSqlite3.Database[] = [];
      const closers = new Map<BetterSqlite3.Database, () => unknown>();
      const open = sqliteEngine.openSqliteDatabase;
      vi.spyOn(sqliteEngine, "openSqliteDatabase").mockImplementation((path, options) => {
        const db = open(path, options);
        const exec = db.exec.bind(db);
        db.exec = ((sql: string) => {
          if (sql === "BEGIN") snapshots.push(db);
          return exec(sql);
        }) as typeof db.exec;
        const close = db.close.bind(db);
        closers.set(db, close);
        db.close = (() => {
          if (snapshots[0] === db) throw new Error("close failed on purpose");
          return close();
        }) as typeof db.close;
        return db;
      });
      expect(() => run.inspection().replay({ runId: run.child, limit: 200 }))
        .toThrow(expect.objectContaining({ code: "RUN_ID_AMBIGUOUS", reason: "admission_owner_unproved" }));
      expect(snapshots).toHaveLength(2);
      expect(snapshots[0]!.open).toBe(true);
      expect(snapshots[1]!.open).toBe(false);
      vi.restoreAllMocks();
      closers.get(snapshots[0]!)!();
    } finally {
      run.close();
    }
  });
});
