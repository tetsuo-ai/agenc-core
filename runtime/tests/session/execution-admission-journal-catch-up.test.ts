/**
 * Binding a session to admission replays the run's whole admission journal
 * into its rollout. On a resumed session every event is already there; the
 * bind must prove the canonical tail durable once, not fsync once per event,
 * and that proof must come before anything new is appended after it.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { EventLog, type Event } from "../../src/session/event-log.js";
import { bindExecutionAdmissionJournal } from "../../src/session/execution-admission-journal.js";
import { Session } from "../../src/session/session.js";
import { SessionStore } from "../../src/session/session-store.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "admission-catch-up-"));
  roots.push(root);
  const store = new SessionStore({ cwd: root, agencHome: root, sessionId: "run", agencVersion: "0.2.0" });
  store.open({ cwd: root, sessionId: "run", agencVersion: "0.2.0", originator: "test", timestamp: "2026-10-20T00:00:00.000Z" });
  let tailSyncs = 0;
  const published: Event[] = [];
  // Proofs and admission appends in order, with the rollout size at each.
  const trace: string[] = [];
  const size = () => statSync(store.rolloutPath).size;
  const facade = {
    writeBehind: store.writeBehind,
    rolloutStore: {
      append: store.append.bind(store),
      readAll: store.readAll.bind(store),
      syncCanonicalTail: () => { tailSyncs += 1; trace.push(`sync@${size()}`); store.syncCanonicalTail(); },
    },
    conversationId: "run",
    eventLog: new EventLog(),
    canonicalJournalSealed: false,
    isRolloutPersistenceSuspended: () => false,
    txEvent: {
      send: (event: Event) => {
        published.push(event);
        if (event.msg.type === "execution_admission") trace.push(`append:${event.eventId}`);
      },
    },
    prepareEmit: Session.prototype.prepareEmit,
    publishPreparedEvent: Session.prototype.publishPreparedEvent,
    emit: Session.prototype.emit,
    emitDeferred: Session.prototype.emitDeferred,
  };
  return { store, session: facade as unknown as Session, published, trace, size, tailSyncs: () => tailSyncs };
}

describe("admission journal catch-up on bind", () => {
  it("accepts every event already in the rollout with one tail fsync", async () => {
    const { store, session, tailSyncs } = fixture();
    const kernel = new ExecutionAdmissionKernel({ agencHome: store.agencHome });
    const admission = kernel.bindClient({ cwd: store.cwd, scope: { runId: "run", sessionId: "run", autonomous: false } });
    try {
      const unbind = bindExecutionAdmissionJournal(session, admission);
      for (let step = 0; step < 25; step += 1) {
        const lease = await admission.acquire({ stepId: `step-${step}`, kind: "model_turn", maxInputTokens: 20, maxOutputTokens: 20, maxCostUsd: 0.5 });
        admission.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
        admission.reconcile(lease.reservation.reservationId, { inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
        admission.acknowledgeCompletion(lease.reservation.reservationId);
      }
      unbind();
      const journal = admission.replayJournal!({ afterSequence: 0, limit: 1_000 });
      expect(journal.length).toBeGreaterThanOrEqual(75);
      const before = readFileSync(store.rolloutPath, "utf8");
      const syncsBefore = tailSyncs();

      // A resumed session binds again: the whole journal is replayed.
      const rebound = bindExecutionAdmissionJournal(session, admission);
      rebound();
      expect(tailSyncs() - syncsBefore).toBe(1);
      // Nothing was appended twice; the usage observation may follow.
      const after = readFileSync(store.rolloutPath, "utf8");
      expect(after.startsWith(before)).toBe(true);
      const admissionEvents = after.split("\n").filter(Boolean).map((line) => JSON.parse(line))
        .filter((item) => item.type === "event_msg" && item.payload.msg.type === "execution_admission");
      expect(admissionEvents.map((item) => item.payload.eventId)).toEqual(journal.map((event) => event.eventId));
    } finally { store.close(); kernel.close(); }
  });

  it("proves the evidence already present before appending what committed while detached", async () => {
    const { store, session, trace, size } = fixture();
    const kernel = new ExecutionAdmissionKernel({ agencHome: store.agencHome });
    const admission = kernel.bindClient({ cwd: store.cwd, scope: { runId: "run", sessionId: "run", autonomous: false } });
    try {
      // History committed before the first bind, then live while bound.
      const lease = await admission.acquire({ stepId: "one", kind: "model_turn", maxInputTokens: 20, maxOutputTokens: 20, maxCostUsd: 0.5 });
      const unbind = bindExecutionAdmissionJournal(session, admission);
      admission.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
      unbind();
      const present = admission.replayJournal!({ afterSequence: 0, limit: 1_000 }).map((event) => event.eventId);
      // History committed while no session is attached.
      admission.reconcile(lease.reservation.reservationId, { inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
      admission.acknowledgeCompletion(lease.reservation.reservationId);
      const journal = admission.replayJournal!({ afterSequence: 0, limit: 1_000 }).map((event) => event.eventId);
      const detached = journal.filter((eventId) => !present.includes(eventId));
      expect(present.length).toBeGreaterThanOrEqual(3);
      expect(detached.length).toBeGreaterThanOrEqual(1);
      const before = size();
      trace.length = 0;

      const rebound = bindExecutionAdmissionJournal(session, admission);
      rebound();

      // One fsync of the whole file proves every present event, over exactly
      // the bytes that were there, before the first detached append.
      expect(trace).toEqual([`sync@${before}`, ...detached.map((eventId) => `append:${eventId}`)]);
      const admissionEvents = readFileSync(store.rolloutPath, "utf8").split("\n").filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((item) => item.type === "event_msg" && item.payload.msg.type === "execution_admission");
      expect(admissionEvents.map((item) => item.payload.eventId)).toEqual(journal);
    } finally { store.close(); kernel.close(); }
  });

  it("still refuses conflicting evidence already in the rollout", async () => {
    const { store, session, tailSyncs } = fixture();
    const kernel = new ExecutionAdmissionKernel({ agencHome: store.agencHome });
    const admission = kernel.bindClient({ cwd: store.cwd, scope: { runId: "run", sessionId: "run", autonomous: false } });
    try {
      const unbind = bindExecutionAdmissionJournal(session, admission);
      const lease = await admission.acquire({ stepId: "one", kind: "model_turn", maxInputTokens: 20, maxOutputTokens: 20, maxCostUsd: 0.5 });
      admission.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
      unbind();
      const journal = admission.replayJournal!({ afterSequence: 0, limit: 1_000 });
      const replay = admission.replayJournal!.bind(admission);
      // The rollout holds different evidence for the last event's identity.
      (admission as { replayJournal?: typeof replay }).replayJournal = (options) =>
        replay(options).map((event) => event.eventId === journal.at(-1)!.eventId ? { ...event, reason: "rewritten" } : event);
      const syncsBefore = tailSyncs();
      expect(() => bindExecutionAdmissionJournal(session, admission)).toThrow("conflicting canonical evidence");
      expect(tailSyncs() - syncsBefore).toBeLessThanOrEqual(1);
    } finally { store.close(); kernel.close(); }
  });
});
