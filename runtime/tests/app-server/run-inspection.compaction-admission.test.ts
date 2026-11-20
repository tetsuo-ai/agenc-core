/**
 * A chat's actions stay readable after Core compacts it.
 *
 * Core admits each compaction call under the attempt's own run id,
 * `compact-<uuid>`, one step per summarizer call (`compact:<attempt>:<n>`), as
 * a child of the chat's run, and writes those admission events into the
 * chat's rollout. run.status, run.replay and run.evidence refused any
 * admission event of another run in the bound rollout, so from the first
 * compaction on every read of the chat answered RUN_ID_AMBIGUOUS, and
 * Desktop's actions card failed for that chat. The reader now accepts the
 * session's own compaction attempts, each proven against the admission
 * journal, and refuses every other foreign admission event as before.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgenCDaemonRunInspectionService } from "../../src/app-server/run-inspection.js";
import type { RunJournalEvent } from "../../src/app-server/protocol/index.js";
import type { ExecutionAdmissionClient } from "../../src/budget/admission-client.js";
import type { AdmissionJournalEvent } from "../../src/budget/admission-types.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { compactConversation } from "../../src/services/compact/compact.js";
import type { RuntimeMessage } from "../../src/services/compact/types.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { SessionStore } from "../../src/session/session-store.js";
import { discoverStateDatabasePaths } from "../../src/state/database-paths.js";
import { VERSION } from "../../src/version.js";
import { canonicalTmpdir } from "../helpers/canonical-temp-dir.js";
import { bindCompactionTransactionHarness } from "../helpers/compaction-transaction-harness.js";

const RUN_ID = "conv-compacted";

function inspection(home: string): AgenCDaemonRunInspectionService {
  return new AgenCDaemonRunInspectionService({ agencHome: home, stateDatabasePaths: () => discoverStateDatabasePaths(home) });
}

function replayAll(service: AgenCDaemonRunInspectionService, runId = RUN_ID) {
  const events: RunJournalEvent[] = [];
  let after = 0;
  for (;;) {
    const page = service.replay({ runId, afterSequence: after, limit: 200 });
    expect(page.gap).toBeNull();
    events.push(...page.events);
    if (!page.hasMore) return events;
    after = page.nextAfterSequence;
  }
}

const refused = expect.objectContaining({ code: "RUN_ID_AMBIGUOUS" });

function expectRefused(service: AgenCDaemonRunInspectionService, runId = RUN_ID): void {
  for (const read of [
    () => service.replay({ runId }),
    () => service.status({ runId }),
    () => service.evidence({ runId }),
  ]) {
    expect(read).toThrow(refused);
  }
}

const admittedRunIds = (events: readonly RunJournalEvent[]): string[] => events
  .filter((event) => event.kind === "execution_admission")
  .map((event) => String((event.payload as { runId?: unknown }).runId));

describe("a chat that Core compacted", () => {
  let root = "";
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(canonicalTmpdir(), "agenc-compacted-chat-"));
    previousHome = process.env.AGENC_HOME;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.AGENC_HOME;
    else process.env.AGENC_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });

  it("reads after a real compaction transaction wrote the attempt's admission into the rollout", async () => {
    // A long conversation in its own project, then a real automatic
    // compaction (compactConversation) admitted through the session's own
    // execution-admission client, with the rollout and the admission journal
    // in that project's database, as in a daemon chat.
    const home = join(root, "agenc-home");
    const cwd = join(root, "project");
    mkdirSync(join(cwd, ".git"), { recursive: true });
    process.env.AGENC_HOME = home;
    const messages: RuntimeMessage[] = Array.from({ length: 40 }, (_, index): RuntimeMessage => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: index % 2 === 0 ? `step ${index}` : `work-${index}:${"x".repeat(3_000)}`,
    }));
    const storeOptions = { cwd, sessionId: RUN_ID, agencVersion: VERSION, agencHome: home,
      sessionTempRoot: join(root, "session-tmp"), autoStartScheduler: false };
    const meta = { sessionId: RUN_ID, timestamp: new Date().toISOString(), cwd, originator: "agenc-cli",
      agencVersion: VERSION, model: "grok-4.5", modelProvider: "grok" };
    const seed = new SessionStore(storeOptions);
    seed.open(meta);
    for (const message of messages) seed.appendRollout({ type: "response_item", payload: { role: message.role, content: message.content } });
    expect(seed.flushBatch(true)).toBe(true);
    seed.close();
    const store = new RolloutStore({ ...storeOptions, resume: true });
    store.open(meta);
    const harness = bindCompactionTransactionHarness(store, { contextWindowTokens: 200_000 });
    try {
      const result = await compactConversation(messages, { ...harness.context, compactionMode: "automatic" }, "");
      expect(result.transaction).toBeDefined();
    } finally {
      harness.close();
      store.close();
    }

    const service = inspection(home);
    const events = replayAll(service);
    const attempts = [...new Set(admittedRunIds(events))];
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatch(/^compact-[0-9a-f-]{36}$/u);
    for (const event of events.filter((candidate) => candidate.kind === "execution_admission")) {
      expect(event.stepId).toMatch(new RegExp(`^compact:${attempts[0]}:[1-9][0-9]*$`, "u"));
    }
    const status = service.status({ runId: RUN_ID });
    expect(status.source).toMatchObject({ kind: "existing_state_database", readonly: true });
    // The attempt is an admission child of the chat's run, so the chat's
    // admission totals still count the summarizer's call.
    expect(status.admission).toMatchObject({ reservationCount: 1, actualTokens: 256 });
    expect(service.evidence({ runId: RUN_ID }).source).toMatchObject({ completeness: "complete" });
  });
});

describe("compaction admission in a chat's rollout, proven against the admission journal", () => {
  let root = "";
  let home = "";
  let workspace = "";
  const sequences = new Map<RolloutStore, number>();
  let kernel: ExecutionAdmissionKernel;
  let chat: ExecutionAdmissionClient;
  let store: RolloutStore;

  beforeEach(() => {
    root = mkdtempSync(join(canonicalTmpdir(), "agenc-compaction-admission-"));
    home = join(root, "agenc-home");
    workspace = join(root, "project");
    mkdirSync(join(workspace, ".git"), { recursive: true });
    sequences.clear();
    kernel = new ExecutionAdmissionKernel({ agencHome: home, ownerId: "compaction-admission-test", ownerPid: process.pid });
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

  function mirror(into: RolloutStore, events: readonly AdmissionJournalEvent[]): void {
    for (const event of events) {
      const sequence = (sequences.get(into) ?? 0) + 1;
      sequences.set(into, sequence);
      into.append({ id: event.eventId, eventId: event.eventId, seq: sequence,
        msg: { type: "execution_admission", payload: event } }, { durable: true });
    }
  }

  /** One admitted model call: queued, allowed, dispatched, reconciled. */
  async function admit(client: ExecutionAdmissionClient, stepId: string, sessionId: string): Promise<readonly AdmissionJournalEvent[]> {
    const before = new Set((client.replayJournal?.() ?? []).map((event) => event.eventId));
    const lease = await client.acquire({ stepId, kind: "model_turn", sessionId, maxInputTokens: 100, maxOutputTokens: 5, maxCostUsd: 0.1 });
    client.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
    client.reconcile(lease.reservation.reservationId, { inputTokens: 40, outputTokens: 2, costUsd: 0.01 });
    return (client.replayJournal?.() ?? []).filter((event) => !before.has(event.eventId));
  }

  /** What services/compact/transaction.ts does for one attempt of `session`. */
  async function compaction(session: ExecutionAdmissionClient, sessionId: string, calls = 1) {
    const attemptId = `compact-${randomUUID()}`;
    const attempt = session.forSession({ runId: attemptId, sessionId, parentRunId: session.scope.runId });
    const events: AdmissionJournalEvent[] = [];
    for (let call = 1; call <= calls; call += 1) events.push(...await admit(attempt, `compact:${attemptId}:${call}`, sessionId));
    attempt.release?.();
    return { attemptId, events };
  }

  it("accepts the session's own compaction attempts and keeps them out of its own admission events", async () => {
    mirror(store, await admit(chat, "model:1", RUN_ID));
    const first = await compaction(chat, RUN_ID, 2);
    mirror(store, first.events);
    mirror(store, await admit(chat, "model:2", RUN_ID));
    const second = await compaction(chat, RUN_ID);
    mirror(store, second.events);
    store.close();

    const service = inspection(home);
    const events = replayAll(service);
    expect(admittedRunIds(events)).toEqual([
      ...Array(4).fill(RUN_ID), ...Array(8).fill(first.attemptId), ...Array(4).fill(RUN_ID), ...Array(4).fill(second.attemptId),
    ]);
    const status = service.status({ runId: RUN_ID });
    // The chat's own two calls and the attempts' three, as admission children.
    expect(status.admission).toMatchObject({ reservationCount: 5, actualTokens: 5 * 42 });
    expect(status.source).toEqual({ kind: "existing_state_database", projectDir: status.source.projectDir, readonly: true });
    expect(service.evidence({ runId: RUN_ID }).source).toMatchObject({ completeness: "complete" });
  });

  it("refuses a compaction event no admission journal holds", async () => {
    mirror(store, (await compaction(chat, RUN_ID)).events);
    const forgedRun = `compact-${randomUUID()}`;
    const forged = { ...(await compaction(chat, RUN_ID)).events[0]!, eventId: randomUUID(), runId: forgedRun, stepId: `compact:${forgedRun}:1` };
    mirror(store, [forged]);
    store.close();
    expectRefused(inspection(home));
  });

  it("refuses a compaction event that differs from its journal row", async () => {
    const attempt = await compaction(chat, RUN_ID);
    mirror(store, [...attempt.events.slice(0, -1), { ...attempt.events.at(-1)!, actualTokens: 1 }]);
    store.close();
    expectRefused(inspection(home));
  });

  it("refuses a journaled child of the chat whose step is not a compaction call", async () => {
    // Admitted under a compact-* run id as a child of the chat, but as an ordinary step.
    const attemptId = `compact-${randomUUID()}`;
    const attempt = chat.forSession({ runId: attemptId, sessionId: RUN_ID, parentRunId: RUN_ID });
    mirror(store, await admit(attempt, "model:1", RUN_ID));
    store.close();
    expectRefused(inspection(home));
  });

  it("refuses a compaction step of another attempt", async () => {
    const attemptId = `compact-${randomUUID()}`;
    const attempt = chat.forSession({ runId: attemptId, sessionId: RUN_ID, parentRunId: RUN_ID });
    mirror(store, await admit(attempt, `compact:compact-${randomUUID()}:1`, RUN_ID));
    store.close();
    expectRefused(inspection(home));
  });

  it("refuses another session's compaction attempt", async () => {
    const other = kernel.bindClient({ cwd: workspace, scope: { runId: "conv-other", sessionId: "conv-other", autonomous: false }, budget: { runMaxCostUsd: 1 } });
    const otherStore = openChat("conv-other");
    const theirs = await compaction(other, "conv-other");
    mirror(otherStore, theirs.events);
    otherStore.close();
    // The other chat itself reads.
    expect(() => replayAll(inspection(home), "conv-other")).not.toThrow();
    mirror(store, theirs.events);
    store.close();
    expectRefused(inspection(home));
  });

  it("refuses a compaction attempt the chat ran for another session", async () => {
    // A child of this run, but admitted for another session id.
    const theirs = await compaction(chat, "conv-other");
    mirror(store, theirs.events);
    store.close();
    expectRefused(inspection(home));
  });

  it("still refuses another run's own admission events", async () => {
    const child = chat.forSession({ runId: "conv-child", sessionId: "conv-child" });
    mirror(store, await admit(child, "model:1", "conv-child"));
    store.close();
    expectRefused(inspection(home));
  });
});
