import { fsyncSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir as admissionTempDir } from "node:os";
import { join as admissionPath } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Session } from "../../src/session/session.js";
import { EventLog, type Event } from "../../src/session/event-log.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { bindExecutionAdmissionJournal } from "../../src/session/execution-admission-journal.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";

let home: string;
let oldHome: string | undefined;
let rollout: RolloutStore;
let kernel: ExecutionAdmissionKernel;
let session: Session;
let syncs: number;
let published: Event[];
beforeEach(() => {
  home = mkdtempSync(admissionPath(admissionTempDir(), "admission-group-"));
  oldHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = home;
  const cwd = admissionPath(home, "workspace");
  mkdirSync(admissionPath(cwd, ".git"), { recursive: true });
  rollout = new RolloutStore({ cwd, sessionId: "group", agencVersion: "0.2.0", sessionTempRoot: admissionTempDir(), autoStartScheduler: false });
  rollout.open({ sessionId: "group", timestamp: new Date().toISOString(), cwd, originator: "test", agencVersion: "0.2.0" });
  published = [];
  const eventLog = new EventLog();
  session = Object.assign(Object.create(Session.prototype), {
    conversationId: "group", eventLog, rolloutStore: rollout,
    txEvent: { send: (event: Event) => { published.push(event); return true; } },
    isRolloutPersistenceSuspended: () => false,
  });
  kernel = new ExecutionAdmissionKernel({ agencHome: home });
  syncs = 0;
  rollout.store.setFsyncImplForTest(fd => { fsyncSync(fd); syncs += 1; });
});
afterEach(() => {
  rollout.store.setFsyncImplForTest(fsyncSync);
  kernel.close();
  rollout.close();
  if (oldHome === undefined) delete process.env.AGENC_HOME; else process.env.AGENC_HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
});
function setup() {
  const client = kernel.bindClient({ cwd: admissionPath(home, "workspace"), scope: { runId: "group", sessionId: "group", autonomous: false } });
  bindExecutionAdmissionJournal(session, client);
  syncs = 0;
  published.length = 0;
  return client;
}
const input = { stepId: "model-1", kind: "model_turn" as const, provider: "test", model: "test", maxInputTokens: 1, maxOutputTokens: 1, maxCostUsd: 0.1 };

it("commits queue, reservation and usage once before publication and dispatch", async () => {
  const client = setup();
  session.eventLog.subscribe(event => {
    expect(syncs).toBeGreaterThan(0);
    expect(readFileSync(rollout.rolloutPath, "utf8")).toContain(event.eventId);
  });
  const lease = await client.acquire(input);
  expect(syncs).toBe(1);
  expect(published.map(e => e.msg.type)).toEqual(["execution_admission", "execution_admission", "session_usage"]);
  expect(kernel.activeCount).toBe(1);
  client.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
  expect(published.some(e => e.msg.type === "execution_admission" && e.msg.payload.event === "dispatched")).toBe(true);
});

it("never grants or publishes on failed group fsync, then recovers the same durable reservation", async () => {
  const client = setup();
  rollout.store.setFsyncImplForTest(() => { throw Object.assign(new Error("failed sync"), { code: "EIO" }); });
  expect(() => client.acquire(input)).toThrow(/fsync-committed/);
  expect(kernel.activeCount).toBe(0);
  expect(published).toEqual([]);
  rollout.store.setFsyncImplForTest(fsyncSync);
  const lease = await client.acquire(input);
  expect(lease.request.step.stepId).toBe(input.stepId);
  const events = rollout.readAll().filter(row => row.type === "event_msg" && row.payload.msg.type === "execution_admission");
  expect(events).toHaveLength(2);
});

it("queues the whole group ahead of a re-entrant event", async () => {
  const client = setup();
  let injected = false;
  session.eventLog.subscribe(() => {
    if (injected) return;
    injected = true;
    session.emit({ id: "nested", msg: { type: "warning", payload: { cause: "test", message: "nested" } } });
  });
  await client.acquire(input);
  expect(published.map(e => e.seq)).toEqual([...published.map(e => e.seq)].sort((a,b) => a!-b!));
  expect(published.at(-1)?.id).toBe("nested");
});
