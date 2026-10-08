import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog, type Event, type EventMsg } from "../../src/session/event-log.js";
import { Session } from "../../src/session/session.js";
import { SessionStore } from "../../src/session/session-store.js";

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
    rolloutStore: { append: store.append.bind(store) },
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
