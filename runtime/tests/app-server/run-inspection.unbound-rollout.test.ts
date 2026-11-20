/**
 * The admission events a replay serves from a rollout with no journal binding
 * are proven too.
 *
 * With no journal binding of the run, run.replay and run.evidence read the
 * thread's own rollout from the projection (run-journal-replay.ts). The proof
 * of the run's admission read only bound rollouts, so on that path it read
 * nothing, and an admission event of the run that no journal holds was served
 * as the run's own record. The proof now reads the same rollout items the
 * replay reads.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgenCDaemonRunInspectionService } from "../../src/app-server/run-inspection.js";
import type { AdmissionJournalEvent } from "../../src/budget/admission-types.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { discoverStateDatabasePaths } from "../../src/state/database-paths.js";
import { openStateDatabases, type StateSqliteDriver } from "../../src/state/sqlite-driver.js";
import { StateThreadRepository } from "../../src/state/threads.js";
import { canonicalTmpdir } from "../helpers/canonical-temp-dir.js";

const RUN_ID = "conv-unbound";

let root = "";
let home = "";
let workspace = "";
let driver: StateSqliteDriver;
let rolloutPath = "";
let journal: readonly AdmissionJournalEvent[] = [];

beforeEach(async () => {
  root = mkdtempSync(join(canonicalTmpdir(), "agenc-unbound-rollout-"));
  home = join(root, "agenc-home");
  workspace = join(root, "project");
  mkdirSync(join(workspace, ".git"), { recursive: true });
  // One admitted model call of the run, journaled in its project's database.
  const kernel = new ExecutionAdmissionKernel({ agencHome: home, ownerId: "unbound-rollout-test", ownerPid: process.pid });
  try {
    const client = kernel.bindClient({ cwd: workspace, scope: { runId: RUN_ID, sessionId: RUN_ID, autonomous: false },
      budget: { runMaxCostUsd: 1 } });
    const lease = await client.acquire({ stepId: "model:1", kind: "model_turn", sessionId: RUN_ID, maxInputTokens: 100,
      maxOutputTokens: 5, maxCostUsd: 0.1 });
    client.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
    client.reconcile(lease.reservation.reservationId, { inputTokens: 40, outputTokens: 2, costUsd: 0.01 });
    journal = client.replayJournal?.() ?? [];
  } finally {
    kernel.close();
  }
  // The thread's rollout in the projection, as the thread store imports it,
  // and no journal binding of the run.
  driver = openStateDatabases({ cwd: workspace, agencHome: home });
  rolloutPath = join(driver.projectDir, "sessions", RUN_ID, `rollout-${RUN_ID}.jsonl`);
  const now = new Date().toISOString();
  new StateThreadRepository(driver).upsertThread({ threadId: RUN_ID, createdAt: now, updatedAt: now, rolloutPath });
});

afterEach(() => {
  driver.close();
  rmSync(root, { recursive: true, force: true });
});

/** Project event_msg items of the thread's rollout, one per line. */
function project(events: readonly { readonly eventId: string; readonly payload: unknown }[]): void {
  const insert = driver.state.prepare(
    `INSERT INTO thread_rollout_items (thread_id, source_path, line_number, byte_offset, item_index, item_type,
       event_version, event_id, event_seq, payload_json, line_hash)
     VALUES (?, ?, ?, ?, ?, 'event_msg', 1, ?, ?, ?, ?)`,
  );
  events.forEach((event, index) => {
    const payload = JSON.stringify({ id: event.eventId, eventId: event.eventId, seq: index + 1,
      msg: { type: "execution_admission", payload: event.payload } });
    insert.run(RUN_ID, rolloutPath, index + 1, index * 1_000, index, event.eventId, index + 1, payload,
      createHash("sha256").update(payload).digest("hex"));
  });
}

function inspection(): AgenCDaemonRunInspectionService {
  return new AgenCDaemonRunInspectionService({ agencHome: home, stateDatabasePaths: () => discoverStateDatabasePaths(home) });
}

describe("admission events in a rollout with no journal binding", () => {
  it("reads when every event is its journal row", () => {
    project(journal.map((event) => ({ eventId: event.eventId, payload: event })));
    const service = inspection();
    const replay = service.replay({ runId: RUN_ID, limit: 200 });
    expect(replay.source).toMatchObject({ kind: "run_journal", available: true });
    expect(replay.events.map((event) => event.eventId)).toEqual(journal.map((event) => event.eventId));
    expect(service.evidence({ runId: RUN_ID, limit: 200 }).events).toHaveLength(journal.length);
    expect(service.status({ runId: RUN_ID }).admission).toMatchObject({ reservationCount: 1, actualTokens: 42 });
  });

  it("refuses an admission event of the run that no journal holds", () => {
    const forged = { ...journal.at(-1)!, eventId: "forged-unbound-admission", actualTokens: 9_999 };
    project([...journal, forged].map((event) => ({ eventId: event.eventId, payload: event })));
    const service = inspection();
    for (const read of [
      () => service.replay({ runId: RUN_ID, limit: 200 }),
      () => service.evidence({ runId: RUN_ID, limit: 200 }),
      () => service.status({ runId: RUN_ID }),
    ]) {
      expect(read).toThrow(expect.objectContaining({ code: "RUN_ID_AMBIGUOUS", reason: "admission_owner_unproved" }));
    }
  });

  it("refuses another run's admission event", () => {
    const theirs = { ...journal.at(-1)!, eventId: "another-runs-admission", runId: "conv-another" };
    project([...journal, theirs].map((event) => ({ eventId: event.eventId, payload: event })));
    expect(() => inspection().replay({ runId: RUN_ID, limit: 200 }))
      .toThrow(expect.objectContaining({ code: "RUN_ID_AMBIGUOUS", reason: "admission_owner_unproved" }));
  });
});
