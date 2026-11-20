/**
 * A chat's own admission events are proven against the admission journal on
 * every path.
 *
 * Run inspection reads a run's admission events from its rollout (run.replay,
 * run.evidence), and the SQLite admission journal is their authority. It
 * proved them only when the run declared an admission owner or had rows in
 * more than one project database. On the common path, one database and no
 * declared owner, it never looked at them, so an admission event of the run
 * that no journal holds, or one that differs from its journal row, was served
 * as the chat's own record.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgenCDaemonRunInspectionService } from "../../src/app-server/run-inspection.js";
import type { RunJournalEvent } from "../../src/app-server/protocol/index.js";
import type { ExecutionAdmissionClient } from "../../src/budget/admission-client.js";
import type { AdmissionJournalEvent } from "../../src/budget/admission-types.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { discoverStateDatabasePaths } from "../../src/state/database-paths.js";
import { VERSION } from "../../src/version.js";
import { canonicalTmpdir } from "../helpers/canonical-temp-dir.js";

const RUN_ID = "conv-own-admission";

let root = "";
let home = "";
let workspace = "";
let kernel: ExecutionAdmissionKernel;
let chat: ExecutionAdmissionClient;
let store: RolloutStore;
const sequences = new Map<RolloutStore, number>();

beforeEach(() => {
  root = mkdtempSync(join(canonicalTmpdir(), "agenc-own-admission-"));
  home = join(root, "agenc-home");
  workspace = join(root, "project");
  mkdirSync(join(workspace, ".git"), { recursive: true });
  sequences.clear();
  kernel = new ExecutionAdmissionKernel({ agencHome: home, ownerId: "own-admission-test", ownerPid: process.pid });
  chat = kernel.bindClient({ cwd: workspace, scope: { runId: RUN_ID, sessionId: RUN_ID, autonomous: false }, budget: { runMaxCostUsd: 1 } });
  store = openChat(RUN_ID);
});

afterEach(() => {
  try { store.close(); } catch { /* closed by the test */ }
  kernel.close();
  rmSync(root, { recursive: true, force: true });
});

function openChat(sessionId: string): RolloutStore {
  const opened = new RolloutStore({ cwd: workspace, sessionId, agencVersion: VERSION, agencHome: home,
    sessionTempRoot: join(root, "session-tmp"), autoStartScheduler: false });
  opened.open({ sessionId, timestamp: new Date().toISOString(), cwd: workspace, originator: "agenc-cli",
    source: "interactive-root", agencVersion: VERSION, model: "base-model", modelProvider: "grok" });
  return opened;
}

/** Write admission events into a rollout the way a session projects them. */
function mirror(into: RolloutStore, events: readonly AdmissionJournalEvent[]): void {
  for (const event of events) {
    const sequence = (sequences.get(into) ?? 0) + 1;
    sequences.set(into, sequence);
    into.append({ id: event.eventId, eventId: event.eventId, seq: sequence,
      msg: { type: "execution_admission", payload: event } }, { durable: true });
  }
}

/** One admitted model call: queued, allowed, dispatched, reconciled. */
async function admit(client: ExecutionAdmissionClient, stepId: string): Promise<readonly AdmissionJournalEvent[]> {
  const before = new Set((client.replayJournal?.() ?? []).map((event) => event.eventId));
  const lease = await client.acquire({ stepId, kind: "model_turn", sessionId: client.scope.sessionId,
    maxInputTokens: 100, maxOutputTokens: 5, maxCostUsd: 0.1 });
  client.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
  client.reconcile(lease.reservation.reservationId, { inputTokens: 40, outputTokens: 2, costUsd: 0.01 });
  return (client.replayJournal?.() ?? []).filter((event) => !before.has(event.eventId));
}

function inspection(): AgenCDaemonRunInspectionService {
  return new AgenCDaemonRunInspectionService({ agencHome: home, stateDatabasePaths: () => discoverStateDatabasePaths(home) });
}

function replayAll(service: AgenCDaemonRunInspectionService): RunJournalEvent[] {
  const events: RunJournalEvent[] = [];
  let after = 0;
  for (;;) {
    const page = service.replay({ runId: RUN_ID, afterSequence: after, limit: 200 });
    expect(page.gap).toBeNull();
    events.push(...page.events);
    if (!page.hasMore) return events;
    after = page.nextAfterSequence;
  }
}

const refused = expect.objectContaining({ code: "RUN_ID_AMBIGUOUS", reason: "admission_owner_unproved" });

function expectRefused(service: AgenCDaemonRunInspectionService): void {
  for (const read of [
    () => service.replay({ runId: RUN_ID }),
    () => service.status({ runId: RUN_ID }),
    () => service.evidence({ runId: RUN_ID }),
    () => service.result({ runId: RUN_ID }),
  ]) {
    expect(read).toThrow(refused);
  }
}

describe("a chat's own admission events on the common path", () => {
  it("reads a chat whose admission events are its journal rows", async () => {
    const first = await admit(chat, "model:1");
    const second = await admit(chat, "model:2");
    mirror(store, [...first, ...second]);
    store.close();

    const service = inspection();
    const admitted = replayAll(service).filter((event) => event.kind === "execution_admission");
    expect(admitted.map((event) => event.eventId)).toEqual([...first, ...second].map((event) => event.eventId));
    expect(service.status({ runId: RUN_ID }).admission).toMatchObject({ reservationCount: 2, actualTokens: 2 * 42 });
    expect(service.evidence({ runId: RUN_ID }).source).toMatchObject({ completeness: "complete" });
  });

  it("reads a chat and its reviewer child the way a Goal admits them", async () => {
    // A Goal's independent reviewer runs as a child session of the chat
    // (session/agenc-delegate.ts, session/child-run-journal.ts): admitted as a
    // child of the chat's run, with its own rollout that declares the chat's
    // workspace as its admission owner.
    const reviewerId = "review-child-of-own-admission";
    mirror(store, await admit(chat, "model:1"));
    const reviewer = chat.forSession({ runId: reviewerId, sessionId: reviewerId });
    const reviewerStore = new RolloutStore({ cwd: workspace, sessionId: reviewerId, agencVersion: VERSION, agencHome: home,
      sessionTempRoot: join(root, "session-tmp"), autoStartScheduler: false });
    reviewerStore.open({ sessionId: reviewerId, timestamp: new Date().toISOString(), cwd: workspace, originator: "agenc-subagent",
      agencVersion: VERSION, model: "base-model", modelProvider: "grok",
      admissionOwner: { workspaceId: reviewer.scope.workspaceId, runId: reviewerId, parentRunId: RUN_ID } });
    mirror(reviewerStore, await admit(reviewer, "model:review"));
    reviewerStore.close();
    reviewer.release?.();
    mirror(store, await admit(chat, "model:2"));
    store.close();

    const service = inspection();
    expect(replayAll(service).filter((event) => event.kind === "execution_admission")).toHaveLength(8);
    // The chat's totals count the reviewer as an admission child.
    expect(service.status({ runId: RUN_ID }).admission).toMatchObject({ reservationCount: 3, actualTokens: 3 * 42 });
    expect(service.evidence({ runId: RUN_ID }).source).toMatchObject({ completeness: "complete" });
    const child = service.status({ runId: reviewerId });
    expect(child.admission).toMatchObject({ reservationCount: 1, actualTokens: 42 });
    expect(service.replay({ runId: reviewerId }).events.filter((event) => event.kind === "execution_admission")).toHaveLength(4);
  });

  it("refuses an admission event of the run that no journal holds", async () => {
    const real = await admit(chat, "model:1");
    mirror(store, real);
    // A copy of a real event under an identity the journal never wrote.
    mirror(store, [{ ...real.at(-1)!, eventId: "forged-admission-event", actualTokens: 9_999 }]);
    store.close();
    expectRefused(inspection());
  });

  it("refuses an admission event of the run that differs from its journal row", async () => {
    const real = await admit(chat, "model:1");
    mirror(store, [...real.slice(0, -1), { ...real.at(-1)!, actualTokens: 1, actualCostUsd: 0 }]);
    store.close();
    expectRefused(inspection());
  });

  it("refuses an admission event of the run whose journal row is another run's", async () => {
    // Another chat in the same project, journaled in the same database.
    const other = kernel.bindClient({ cwd: workspace, scope: { runId: "conv-other", sessionId: "conv-other", autonomous: false },
      budget: { runMaxCostUsd: 1 } });
    const theirs = await admit(other, "model:1");
    mirror(store, await admit(chat, "model:1"));
    mirror(store, theirs.map((event) => ({ ...event, runId: RUN_ID })));
    store.close();
    expectRefused(inspection());
  });
});
