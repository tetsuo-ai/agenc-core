import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compactConversation } from "../../../src/services/compact/compact.js";
import { COMPACTION_SOURCE_DIGEST_DOMAIN } from "../../../src/services/compact/transaction-types.js";
import type { RuntimeMessage } from "../../../src/services/compact/types.js";
import { CanonicalRolloutScanner, scanCanonicalRollout } from "../../../src/session/canonical-rollout-scanner.js";
import type { EventMsg } from "../../../src/session/event-log.js";
import { reconstructFromRollout } from "../../../src/session/rollout-reconstruction.js";
import { RolloutStore } from "../../../src/session/rollout-store.js";
import { createCompactionTransactionHarness, createProvider, type CompactionTransactionHarness } from "../../helpers/compaction-transaction-harness.js";

function sourceMessages(): readonly RuntimeMessage[] {
  return Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: `source-${index}:${"x".repeat(4_000)}`,
  }));
}

function status(fixture: CompactionTransactionHarness, value: "running" | "idle" = "running"): Extract<EventMsg, { type: "collab_agent_status" }> {
  return { type: "collab_agent_status", payload: {
    callId: "child-call", senderThreadId: fixture.store.sessionId,
    threadId: "child-thread", status: value,
  } };
}

function emit(fixture: CompactionTransactionHarness, id: string, msg: EventMsg): void {
  // Native status updates use a sub-call id distinct from the canonical event id.
  fixture.session.emit({ id: `sub-${id}`, eventId: id, msg }, { durable: true });
}

function scanOptions(fixture: CompactionTransactionHarness) {
  return {
    sessionTempRoot: join(process.env.AGENC_HOME!, "observer-scans"),
    expectedRunId: fixture.store.sessionId, expectedEpoch: 1,
    compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
  };
}

describe("child status observations during compaction admission", () => {
  it("commits across concurrent running/idle statuses and reconstructs the same history on restart", async () => {
    const source = sourceMessages();
    const provider = createProvider();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fixture = createCompactionTransactionHarness(source, {
      chat: async (messages) => {
        entered.resolve();
        await release.promise;
        return provider.chat(messages);
      },
    });
    const scanner = new CanonicalRolloutScanner();
    const pending = compactConversation(source, fixture.context);
    try {
      await entered.promise;
      const options = scanOptions(fixture);
      const before = scanner.scan(fixture.store.rolloutPath, options);
      const attemptId = [...before.attempts.keys()][0]!;
      expect(before.attempts.get(attemptId)?.admissionValid).toBe(false);
      emit(fixture, "status-running-a", status(fixture));
      emit(fixture, "status-running-b", { ...status(fixture), payload: { ...status(fixture).payload, callId: "second-call", threadId: "second-child" } });
      emit(fixture, "status-idle", status(fixture, "idle"));
      // Observations cannot make an unreconciled provider admission complete.
      expect(scanner.scan(fixture.store.rolloutPath, options).attempts.get(attemptId)?.admissionValid).toBe(false);
      const interrupted = scanCanonicalRollout(fixture.store.rolloutPath, { ...options, captureActiveHistory: true });
      expect(interrupted.attempts.get(attemptId)?.admissionValid).toBe(false);
      expect(interrupted.activeHistory?.messages).toEqual(source);
      release.resolve();
      const result = await pending;
      expect(result.transaction?.attempt_id).toBe(attemptId);
      for (const scan of [scanner.scan(fixture.store.rolloutPath, options), scanCanonicalRollout(fixture.store.rolloutPath, options)]) {
        expect(scan.attempts.get(attemptId)?.admissionValid).toBe(true);
      }
      const rows = fixture.store.readAll();
      expect(rows.filter((item) => item.type === "event_msg" && item.payload.msg.type === "collab_agent_status")).toHaveLength(3);
      const replacement = result.transaction!.committed.replacement_history;
      expect(reconstructFromRollout(rows).history).toEqual(replacement);
      const cwd = fixture.store.store.cwd;
      fixture.store.close();
      const reopened = new RolloutStore({ cwd, sessionId: fixture.store.sessionId, agencVersion: "0.13.0", sessionTempRoot: options.sessionTempRoot, autoStartScheduler: false, resume: true });
      try {
        reopened.open({ sessionId: fixture.store.sessionId, timestamp: new Date().toISOString(), cwd, originator: "child-status-test", agencVersion: "0.13.0", model: "grok-4.5", modelProvider: "grok" });
        // A restart must still require projection recovery after durable commit.
        expect(() => reopened.assertCompactionProjectionReady()).toThrow(/reconstruction is required/);
        expect(reconstructFromRollout(reopened.readAll()).history).toEqual(replacement);
        reopened.markProjectionComplete(attemptId);
        expect(() => reopened.assertCompactionProjectionReady()).not.toThrow();
      } finally {
        reopened.close();
      }
    } finally {
      release.resolve();
      await pending.catch(() => {});
      scanner.close();
      fixture.close();
    }
  });

  it.each(["foreign-sender", "empty-call", "empty-child", "root-as-child", "unrelated-event", "response-history", "history-cleared", "foreign-admission"] as const)("keeps %s outside the status exception", async (kind) => {
    const source = sourceMessages();
    const provider = createProvider();
    let fixture: CompactionTransactionHarness;
    fixture = createCompactionTransactionHarness(source, {
      chat: async (messages) => {
        emit(fixture, "valid-child-status", status(fixture));
        let child = status(fixture);
        switch (kind) {
          case "foreign-sender": child = { ...child, payload: { ...child.payload, senderThreadId: "foreign-session" } }; break;
          case "empty-call": child = { ...child, payload: { ...child.payload, callId: "" } }; break;
          case "empty-child": child = { ...child, payload: { ...child.payload, threadId: "" } }; break;
          case "root-as-child": child = { ...child, payload: { ...child.payload, threadId: fixture.store.sessionId } }; break;
          case "unrelated-event":
            emit(fixture, "unrelated-event", { type: "warning", payload: { message: "unrelated", cause: "unrelated" } });
            return provider.chat(messages);
          case "response-history":
            fixture.store.appendRollout({ type: "response_item", payload: { role: "user", content: "new conversation work" } }, { durable: true });
            return provider.chat(messages);
          case "history-cleared":
            emit(fixture, "history-cleared", { type: "history_cleared", payload: { timestamp: Date.now() } });
            return provider.chat(messages);
          case "foreign-admission": {
            const latest = fixture.store.readAll().findLast((item) => item.type === "event_msg" && item.payload.msg.type === "execution_admission");
            if (latest?.type !== "event_msg" || latest.payload.msg.type !== "execution_admission") throw new Error("Missing dispatched admission");
            const eventId = "foreign-admission";
            fixture.session.emit({ id: eventId, eventId, msg: { type: "execution_admission", payload: {
              ...latest.payload.msg.payload, eventId, sequence: latest.payload.msg.payload.sequence + 1, runId: "foreign-compaction",
            } } }, { durable: true });
            return provider.chat(messages);
          }
        }
        emit(fixture, "invalid-child-status", child);
        return provider.chat(messages);
      },
    });
    try {
      await expect(compactConversation(source, fixture.context)).rejects.toThrow(/outside the compaction admission journal/);
      const rows = fixture.store.readAll();
      expect(rows.some((item) => item.type === "compaction_committed")).toBe(false);
      expect(rows.findLast((item) => item.type === "compaction_failed")?.payload).toMatchObject({ reason: "commit_failed" });
    } finally {
      fixture.close();
    }
  });

  it.each(["malformed-status", "duplicate-event-id", "duplicate-admission"] as const)("still rejects canonical %s with valid child observations present", async (kind) => {
    const source = sourceMessages();
    const provider = createProvider();
    let fixture: CompactionTransactionHarness;
    fixture = createCompactionTransactionHarness(source, {
      chat: async (messages) => {
        emit(fixture, "valid-child-status", status(fixture));
        if (kind === "malformed-status") {
          emit(fixture, "bad-status", { ...status(fixture), payload: { ...status(fixture).payload, status: "invented" } } as unknown as EventMsg);
        } else if (kind === "duplicate-event-id") {
          emit(fixture, "valid-child-status", status(fixture, "idle"));
        } else {
          const latest = fixture.store.readAll().findLast((item) => item.type === "event_msg" && item.payload.msg.type === "execution_admission");
          if (latest?.type !== "event_msg" || latest.payload.msg.type !== "execution_admission") throw new Error("Missing dispatched admission");
          const eventId = "duplicate-admission";
          fixture.session.emit({ id: eventId, eventId, msg: { ...latest.payload.msg, payload: { ...latest.payload.msg.payload, eventId } } }, { durable: true });
        }
        return provider.chat(messages);
      },
    });
    try {
      await expect(compactConversation(source, fixture.context)).rejects.toThrow();
      // The writer must never append a successful terminal after a refused scan.
      expect(fixture.store.readAll().some((item) => item.type === "compaction_committed")).toBe(false);
    } finally {
      fixture.close();
    }
  });

  it("keeps child status after commit as an existing reviewed-rollback boundary", async () => {
    const source = sourceMessages();
    const fixture = createCompactionTransactionHarness(source);
    try {
      const result = await compactConversation(source, fixture.context);
      emit(fixture, "later-child-status", status(fixture));
      expect(() => fixture.store.rollbackCompaction({ attemptId: result.transaction!.attempt_id, nowMs: Date.now() }))
        .toThrow(/reviewed branch target/);
    } finally {
      fixture.close();
    }
  });
});
