import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventLog, type Event } from "../../src/session/event-log.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { Session } from "../../src/session/session.js";
import { openStateDatabases, type StateSqliteDriver } from "../../src/state/sqlite-driver.js";
import { StateThreadRepository } from "../../src/state/threads.js";
import { FileThreadStore } from "../../src/thread-store/store.js";

let root: string;
let rollout: RolloutStore;
let store: FileThreadStore;
let observer: StateSqliteDriver;
let threads: StateThreadRepository;
let session: Session;
let eventLog: EventLog;
const runId = "projection-publication";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agenc-projection-publication-"));
  const agencHome = join(root, "home");
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  rollout = new RolloutStore({ agencHome, cwd, sessionId: runId, agencVersion: "0.2.0",
    sessionTempRoot: root, autoStartScheduler: false });
  rollout.open({ sessionId: runId, timestamp: "2026-10-01T00:00:00.000Z",
    cwd, originator: "test", agencVersion: "0.2.0" });
  store = new FileThreadStore({ agencHome, cwd });
  store.createThread({ threadId: runId, rolloutStore: rollout });
  observer = openStateDatabases({ agencHome, cwd });
  threads = new StateThreadRepository(observer);
  eventLog = new EventLog();
  let nextId = 0;
  session = Object.assign(Object.create(Session.prototype), {
    eventLog, rolloutStore: rollout,
    txEvent: { send: () => true },
    isRolloutPersistenceSuspended: () => false,
    nextInternalSubId: () => `projection-sub-${++nextId}`,
    emittedTaskAbortTurnIds: new Set<string>(),
    stoppedByUserSinceLastPromptFlag: false,
    userStopGenerationValue: 0,
  }) as Session;
});

afterEach(() => {
  vi.restoreAllMocks();
  store?.close();
  rollout?.close();
  observer?.close();
  rmSync(root, { recursive: true, force: true });
});

function warning(id: string): Event {
  return { id, msg: { type: "warning", payload: { message: id } } };
}

function capture(event: Event) {
  const projected = observer.prepareState<[number], { event_id: string; payload_json: string }>(
    "SELECT event_id, payload_json FROM thread_rollout_items WHERE event_seq = ?",
  ).get(event.seq!);
  const receipt = threads.getBackfillFile(rollout.rolloutPath);
  return {
    id: event.id,
    seq: event.seq,
    projectedId: projected?.event_id,
    expectedId: event.eventId,
    projectedType: projected === undefined ? undefined : (JSON.parse(projected.payload_json) as Event).msg.type,
    expectedType: event.msg.type,
    receiptCoversFile: receipt?.size === statSync(rollout.rolloutPath).size,
  };
}

describe("incremental projection publication", () => {
  it("commits before listeners, reentrant events and listener-triggered cancellation", () => {
    const observations: ReturnType<typeof capture>[] = [];
    const afterNested: ReturnType<typeof capture>[] = [];
    const transport: ReturnType<typeof capture>[] = [];
    Object.assign(session, { txEvent: { send: (event: Event) => {
      transport.push(capture(event));
      return true;
    } } });
    const cancellation = new AbortController();
    eventLog.subscribe((event) => {
      observations.push(capture(event));
      if (event.id !== "outer") return;
      const nested = session.emit(warning("nested"), { durable: true });
      afterNested.push(capture(nested));
      cancellation.abort("interrupted");
      session.markStoppedByUser();
      session.emitTurnAbortedOnce("turn-1", "interrupted");
    });
    const outer = session.prepareEmit(warning("outer"), { durable: true });
    expect(observations).toEqual([]);
    expect(capture(outer.event)).toMatchObject({ receiptCoversFile: true, projectedType: "warning" });
    outer.publish();
    expect(observations.map((entry) => entry.id)).toEqual(["outer", "nested", "projection-sub-1"]);
    expect(transport.map((entry) => entry.id)).toEqual(observations.map((entry) => entry.id));
    for (const entry of [...observations, ...afterNested, ...transport]) {
      expect(entry.projectedId).toBe(entry.expectedId);
      expect(entry.projectedType).toBe(entry.expectedType);
      expect(entry.receiptCoversFile).toBe(true);
    }
    expect(cancellation.signal.aborted).toBe(true);
    expect(session.stoppedByUserSinceLastPrompt).toBe(true);
    const states = observer.prepareState<[], { payload_json: string }>(
      "SELECT payload_json FROM thread_rollout_items WHERE item_type = 'session_state' ORDER BY item_index",
    ).all();
    expect(states.map((row) => JSON.parse(row.payload_json))).toContainEqual({
      userStop: { stopped: true, generation: 1 },
    });
    // A later user prompt clears the stop state synchronously before its next
    // request can be assembled; no projection queue survives cancellation.
    session.clearUserStop();
    expect(session.stoppedByUserSinceLastPrompt).toBe(false);
    const lastState = observer.prepareState<[], { payload_json: string }>(
      "SELECT payload_json FROM thread_rollout_items WHERE item_type = 'session_state' ORDER BY item_index DESC LIMIT 1",
    ).get();
    expect(JSON.parse(lastState!.payload_json)).toEqual({ userStop: { stopped: false, generation: 1 } });
    expect(threads.getBackfillFile(rollout.rolloutPath)?.size).toBe(statSync(rollout.rolloutPath).size);
  });

  it("recovers a failed mirror callback from canonical bytes on the next append", () => {
    const before = threads.getBackfillFile(rollout.rolloutPath)!;
    const append = StateThreadRepository.prototype.appendRolloutProjection;
    vi.spyOn(StateThreadRepository.prototype, "appendRolloutProjection").mockImplementationOnce(function (this: StateThreadRepository, params) {
      append.call(this, { ...params, validateCanonical: () => { throw new Error("injected final validation failure"); } });
    });
    const first = session.emit(warning("missed"), { durable: true });
    expect(threads.getBackfillFile(rollout.rolloutPath)).toEqual(before);
    expect(readFileSync(rollout.rolloutPath, "utf8")).toContain('"id":"missed"');
    const second = session.emit(warning("recovered"), { durable: true });
    expect(capture(first)).toMatchObject({ projectedType: "warning", receiptCoversFile: true });
    expect(capture(second)).toMatchObject({ projectedType: "warning", receiptCoversFile: true });
    const rows = observer.prepareState<[], { seq: number; n: number }>(
      "SELECT event_seq AS seq, count(*) AS n FROM thread_rollout_items WHERE event_seq IS NOT NULL GROUP BY event_seq ORDER BY event_seq",
    ).all();
    expect(rows).toEqual([{ seq: first.seq, n: 1 }, { seq: second.seq, n: 1 }]);
  });
});
