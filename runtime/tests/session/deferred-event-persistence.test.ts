import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog, type Event, type EventMsg } from "../../src/session/event-log.js";
import { Session } from "../../src/session/session.js";
import { SessionStore } from "../../src/session/session-store.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { bindExecutionAdmissionJournal } from "../../src/session/execution-admission-journal.js";
import { openStateDatabases } from "../../src/state/sqlite-driver.js";
import { withOneShotFastMode } from "../../src/one-shot-fast-mode.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "deferred-event-"));
  roots.push(root);
  const store = new SessionStore({ cwd: root, agencHome: root, sessionId: "test", agencVersion: "0.2.0" });
  store.open({ cwd: root, sessionId: "test", agencVersion: "0.2.0", originator: "test", timestamp: "2026-10-08T00:00:00.000Z" });
  const published: Event[] = [];
  const facade = {
    writeBehind: store.writeBehind,
    rolloutStore: { append: store.append.bind(store), readAll: store.readAll.bind(store), syncCanonicalTail: store.syncCanonicalTail.bind(store) },
    conversationId: "test",
    eventLog: new EventLog(),
    canonicalJournalSealed: false,
    isRolloutPersistenceSuspended: () => false,
    txEvent: { send: (event: Event) => published.push(event) },
    prepareEmit: Session.prototype.prepareEmit,
    publishPreparedEvent: Session.prototype.publishPreparedEvent,
    emit: Session.prototype.emit,
    emitDeferred: Session.prototype.emitDeferred,
  };
  return { store, session: facade as unknown as Session, published };
}

function usage(): Extract<EventMsg, { type: "session_usage" }> {
  return { type: "session_usage", payload: {
    runId: "test", sequence: 3, costUsd: 0.25, inputTokens: 10, outputTokens: 5,
    totalTokens: 15, modelCalls: 1, hasUnknownCost: false, heldCostUsd: 0, models: [], agents: [],
  } };
}

describe("deferred event payloads", () => {
  it.each(["close", "reader", "observer", "rebind"])("retains fast admission transitions and exact usage at %s", async barrier => {
    const { store, session, published } = fixture();
    const kernel = new ExecutionAdmissionKernel({ agencHome: store.agencHome });
    const admission = kernel.bindClient({ cwd: store.cwd, scope: { runId: "test", sessionId: "test", autonomous: false } });
    const unbind = bindExecutionAdmissionJournal(session, admission);
    const reader = openStateDatabases({ cwd: store.cwd, agencHome: store.agencHome, deferLogs: true });
    const observed: string[] = [];
    const unsubscribe = barrier === "observer" ? admission.subscribe(event => {
      observed.push(published.find(item => item.eventId === event.eventId)?.eventId ?? "missing");
    }) : () => {};
    try {
      const baseline = published.length;
      await withOneShotFastMode(async () => {
        const lease = await admission.acquire({ stepId: "one", kind: "model_turn", maxInputTokens: 20, maxOutputTokens: 20, maxCostUsd: 0.5 });
        admission.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
        admission.reconcile(lease.reservation.reservationId, { inputTokens: 10, outputTokens: 5, costUsd: 0.25 });
        admission.acknowledgeCompletion(lease.reservation.reservationId);
      });
      if (barrier !== "observer") {
        expect(published).toHaveLength(baseline);
        expect(store.writeBehind.pending).toBeGreaterThan(0);
      } else {
        expect(observed.length).toBeGreaterThan(0);
        expect(observed).not.toContain("missing");
      }
      if (barrier === "rebind") {
        unbind();
        const rebound = bindExecutionAdmissionJournal(session, admission);
        rebound();
      }
      if (barrier === "close") store.close();
      else reader.prepareState("SELECT COUNT(*) FROM execution_admission_reservations").get();
      expect(store.writeBehind.pending).toBe(0);
      const events = published.filter(event => event.msg.type === "execution_admission");
      expect(events.map(event => event.eventId)).toEqual(admission.replayJournal!({ afterSequence: 0, limit: 100 }).map(event => event.eventId));
      expect(published.filter(event => event.msg.type === "session_usage").at(-1)?.msg)
        .toMatchObject({ payload: { costUsd: 0.25, inputTokens: 10, outputTokens: 5, modelCalls: 1, heldCostUsd: 0 } });
    } finally { unsubscribe(); unbind(); store.close(); reader.close(); kernel.close(); }
  });

  it("publishes canonical admission events before ordinary observers", async () => {
    const { store, session, published } = fixture();
    const kernel = new ExecutionAdmissionKernel({ agencHome: store.agencHome });
    const admission = kernel.bindClient({ cwd: store.cwd, scope: { runId: "test", sessionId: "test", autonomous: false } });
    const unbind = bindExecutionAdmissionJournal(session, admission);
    const observed: string[] = [];
    const unsubscribe = admission.subscribe(event => {
      // Collect values rather than assert in a best-effort callback.
      const canonical = published.find(item => item.eventId === event.eventId);
      observed.push(canonical?.eventId ?? "missing canonical event");
    });
    try {
      store.writeBehind.beginStep();
      const lease = await admission.acquire({ stepId: "one", kind: "model_turn", maxInputTokens: 20, maxOutputTokens: 20, maxCostUsd: 0.5 });
      admission.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
      expect(observed.length).toBeGreaterThan(0);
      expect(observed).not.toContain("missing canonical event");
      const beforeFailure = observed.length;
      store.writeBehind.defer("injected failure", () => { throw new Error("observer projection failed"); });
      expect(() => admission.recordFallback({ stepId: "one", fromModel: "a", toModel: "b", reason: "test" })).toThrow("observer projection failed");
      expect(observed).toHaveLength(beforeFailure);
      expect(() => store.close()).toThrow("observer projection failed");
    } finally { unsubscribe(); unbind(); kernel.close(); }
  });

  it("enforces budgets before send while journals and usage wait for an ordinary SQL reader", async () => {
    const { store, session, published } = fixture();
    const kernel = new ExecutionAdmissionKernel({ agencHome: store.agencHome });
    const admission = kernel.bindClient({ cwd: store.cwd, scope: { runId: "test", sessionId: "test", autonomous: false }, budget: { runMaxCostUsd: 0.75 } });
    const unbind = bindExecutionAdmissionJournal(session, admission);
    const reader = openStateDatabases({ cwd: store.cwd, agencHome: store.agencHome, deferLogs: true });
    try {
      const before = readFileSync(store.rolloutPath, "utf8");
      const publishedBefore = published.length;
      store.writeBehind.beginStep();
      const request = { kind: "model_turn" as const, model: "test", provider: "test", maxInputTokens: 20, maxOutputTokens: 20, maxCostUsd: 0.5 };
      const lease = await admission.acquire({ ...request, stepId: "one" });
      admission.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
      await expect(admission.acquire({ ...request, stepId: "over-budget" })).rejects.toThrow("budget");
      expect(store.writeBehind.pending).toBeGreaterThan(0);
      expect(published.length).toBe(publishedBefore);
      expect(readFileSync(store.rolloutPath, "utf8")).toBe(before);
      admission.reconcile(lease.reservation.reservationId, { inputTokens: 10, outputTokens: 5, costUsd: 0.25 });
      expect(readFileSync(store.rolloutPath, "utf8")).toBe(before);
      // The public SQL connection retains its barrier even for admission
      // tables; only the kernel's synchronous authority has the narrow path.
      reader.prepareState("SELECT COUNT(*) FROM execution_admission_reservations").get();
      expect(store.writeBehind.pending).toBe(0);
      const events = store.readAll().filter(item => item.type === "event_msg").map(item => item.payload);
      expect(events).toEqual(published);
      const summaries = events.filter(event => event.msg.type === "session_usage");
      expect(summaries.at(-1)!.msg).toMatchObject({ payload: { costUsd: 0.25, modelCalls: 1, heldCostUsd: 0 } });
    } finally { unbind(); store.close(); reader.close(); kernel.close(); }
  });

  it("materializes at the reserved position and publishes the same persisted sequence", () => {
    const { store, session, published } = fixture();
    try {
      const before = readFileSync(store.rolloutPath, "utf8");
      let built = false;
      store.writeBehind.beginStep();
      session.emitDeferred({ id: "usage" }, () => { built = true; return usage(); }, { durable: true });
      session.emit({ id: "following", msg: { type: "warning", payload: { cause: "test", message: "after usage" } } }, { durable: true });
      expect(built).toBe(false);
      expect(published).toEqual([]);
      expect(readFileSync(store.rolloutPath, "utf8")).toBe(before);
      const events = store.readAll().filter(item => item.type === "event_msg").map(item => item.payload);
      expect(built).toBe(true);
      expect(events.map(event => [event.seq, event.msg.type])).toEqual([[1, "session_usage"], [2, "warning"]]);
      expect(published).toEqual(events);
    } finally { store.close(); }
  });

  it("surfaces factory failure and retains every uncommitted successor", () => {
    const { store, session, published } = fixture();
    const failure = new Error("cannot build durable snapshot");
    store.writeBehind.beginStep();
    session.emitDeferred({ id: "usage" }, () => { throw failure; });
    session.emit({ id: "following", msg: { type: "warning", payload: { cause: "test", message: "must wait" } } });
    expect(() => store.writeBehind.drain()).toThrow(failure);
    expect(published).toEqual([]);
    expect(store.writeBehind.pending).toBeGreaterThan(1);
    expect(() => store.close()).toThrow(failure);
  });

  it("rejects a sealed journal before reserving or running a factory", () => {
    const { store, session } = fixture();
    try {
      (session as unknown as { canonicalJournalSealed: boolean }).canonicalJournalSealed = true;
      store.writeBehind.beginStep();
      let built = false;
      expect(() => session.emitDeferred({ id: "usage" }, () => { built = true; return usage(); })).toThrow("sealed");
      expect(built).toBe(false);
      expect(store.writeBehind.pending).toBe(0);
    } finally { store.close(); }
  });
});
