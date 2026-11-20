/**
 * RUN_ID_AMBIGUOUS says why for a chat an earlier resume split across two
 * project databases, and for a second chat journal of the same run id.
 *
 * A resumed chat opens its state database from the chat's folder. When a root
 * marker (here `package.json`) appears above the folder between two daemon
 * runs, the folder names another project: the resume writes a new epoch, a
 * journal binding and admission records into that project's database, while
 * it keeps appending to the rollout in the first one. Run inspection refuses
 * such a run; the reason tells that split from two chats with one id.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgenCDaemonRunInspectionService } from "../../src/app-server/run-inspection.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { discoverStateDatabasePaths } from "../../src/state/database-paths.js";
import { resolveStateDatabasePaths } from "../../src/state/sqlite-driver.js";
import { VERSION } from "../../src/version.js";
import { canonicalTmpdir } from "../helpers/canonical-temp-dir.js";

const RUN_ID = "conv-split-reason";
const OWN_RUN_TABLES = ["run_lifecycle_epochs", "run_journal_bindings", "execution_admission_journal"] as const;

let root = "";
let home = "";
let workspace = "";
let sequence = 0;

beforeEach(() => {
  root = mkdtempSync(join(canonicalTmpdir(), "agenc-split-reason-"));
  home = join(root, "agenc-home");
  // The chat's folder sits in a site folder with no root marker yet.
  workspace = join(root, "site", "app");
  mkdirSync(workspace, { recursive: true });
  sequence = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function storeOptions(cwd = workspace) {
  return { cwd, sessionId: RUN_ID, agencVersion: VERSION, agencHome: home,
    sessionTempRoot: join(root, "session-tmp"), autoStartScheduler: false };
}

function openMeta(cwd = workspace) {
  return { sessionId: RUN_ID, timestamp: new Date().toISOString(), cwd, originator: "agenc-cli",
    source: "interactive-root" as const, agencVersion: VERSION, model: "base-model", modelProvider: "grok" };
}

/** One admitted model call, recorded where the chat's folder resolves and mirrored into the rollout. */
async function admittedModelCall(store: RolloutStore, inputTokens: number): Promise<void> {
  const kernel = new ExecutionAdmissionKernel({ agencHome: home, ownerId: "split-reason-test", ownerPid: process.pid });
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

/** Turn 1, then `npm init` above the folder, then a daemon restart and a resume of the chat. */
async function splitTheRun(): Promise<{ readonly firstProject: string; readonly folderProject: string }> {
  const firstProject = resolveStateDatabasePaths({ cwd: workspace, agencHome: home }).projectDir;
  const first = new RolloutStore(storeOptions());
  first.open(openMeta());
  const rolloutPath = first.rolloutPath;
  await admittedModelCall(first, 10);
  first.close();

  writeFileSync(join(root, "site", "package.json"), "{\"name\":\"site\"}\n");
  const folderProject = resolveStateDatabasePaths({ cwd: workspace, agencHome: home }).projectDir;
  expect(folderProject).not.toBe(firstProject);

  const resumed = new RolloutStore({ ...storeOptions(), resume: true, resumeRolloutPath: rolloutPath });
  resumed.open(openMeta());
  expect(resumed.rolloutPath).toBe(rolloutPath);
  sequence = Math.max(sequence, ...resumed.readAll().flatMap((item) =>
    item.type === "event_msg" && typeof (item.payload as { seq?: unknown }).seq === "number" ? [(item.payload as { seq: number }).seq] : []));
  await admittedModelCall(resumed, 20);
  resumed.close();
  return { firstProject, folderProject };
}

/** The projects whose state database holds journal or admission rows of the run, read without writing. */
function projectsHoldingTheRun(): string[] {
  return discoverStateDatabasePaths(home).filter((paths) => {
    const db = new Database(paths.stateDbPath, { readonly: true, fileMustExist: true });
    try {
      return OWN_RUN_TABLES.some((table) =>
        db.prepare(`SELECT 1 FROM ${table} WHERE run_id = ? LIMIT 1`).get(RUN_ID) !== undefined);
    } finally {
      db.close();
    }
  }).map((paths) => paths.projectDir).sort();
}

function inspection(): AgenCDaemonRunInspectionService {
  return new AgenCDaemonRunInspectionService({ agencHome: home, stateDatabasePaths: () => discoverStateDatabasePaths(home) });
}

function readsOf(service: AgenCDaemonRunInspectionService): (() => unknown)[] {
  return [
    () => service.replay({ runId: RUN_ID }),
    () => service.status({ runId: RUN_ID }),
    () => service.evidence({ runId: RUN_ID }),
  ];
}

describe("the reason of RUN_ID_AMBIGUOUS for a run in two project databases", () => {
  it("names a project split for a chat an earlier resume split", async () => {
    const { firstProject, folderProject } = await splitTheRun();
    expect(projectsHoldingTheRun()).toEqual([firstProject, folderProject].sort());
    for (const read of readsOf(inspection())) {
      expect(read).toThrow(expect.objectContaining({ code: "RUN_ID_AMBIGUOUS", reason: "project_split",
        message: `run id ${RUN_ID} has conflicting or unproved journal/admission owners: its records are split across project databases` }));
    }
  });

  it("names a duplicate run id when another project holds its own chat journal of the id", async () => {
    await splitTheRun();
    // A different chat journal with the same run id: its own rollout in its own project.
    const other = join(root, "other");
    mkdirSync(join(other, ".git"), { recursive: true });
    const distinct = new RolloutStore(storeOptions(other));
    distinct.open(openMeta(other));
    distinct.close();
    expect(projectsHoldingTheRun()).toHaveLength(3);
    for (const read of readsOf(inspection())) {
      expect(read).toThrow(expect.objectContaining({ code: "RUN_ID_AMBIGUOUS", reason: "duplicate_run_id" }));
    }
  });
});
