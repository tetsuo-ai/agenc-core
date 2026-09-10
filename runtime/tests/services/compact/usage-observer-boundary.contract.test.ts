import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import type { AdmissionUsageSummary } from "../../../src/budget/admission-types.js";
import { compactConversation } from "../../../src/services/compact/compact.js";
import { COMPACTION_SOURCE_DIGEST_DOMAIN } from "../../../src/services/compact/transaction-types.js";
import type { RuntimeMessage } from "../../../src/services/compact/types.js";
import { scanCanonicalRollout } from "../../../src/session/canonical-rollout-scanner.js";
import type { EventMsg } from "../../../src/session/event-log.js";
import { createCompactionTransactionHarness, createProvider, type CompactionTransactionHarness } from "../../helpers/compaction-transaction-harness.js";

function sourceMessages(): readonly RuntimeMessage[] {
  return Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: `source-${index}:${"x".repeat(4_000)}`,
  }));
}

function usage(runId: string): AdmissionUsageSummary {
  return {
    runId, sequence: 10, costUsd: 0.1, heldCostUsd: 0,
    inputTokens: 10, outputTokens: 2, totalTokens: 12,
    modelCalls: 1, hasUnknownCost: false, models: [], agents: [],
  };
}

function emit(fixture: CompactionTransactionHarness, identity: string, msg: EventMsg): void {
  fixture.session.emit({ id: identity, eventId: identity, msg }, { durable: true });
}

describe("observational usage inside compaction bookkeeping", () => {
  it("keeps admission valid when usage is emitted during a real provider transaction", async () => {
    const source = sourceMessages();
    const provider = createProvider();
    let fixture: CompactionTransactionHarness;
    fixture = createCompactionTransactionHarness(source, {
      chat: async (messages) => {
        emit(fixture, "provider-usage", { type: "session_usage", payload: usage(fixture.store.sessionId) });
        return provider.chat(messages);
      },
    });
    try {
      const result = await compactConversation(source, fixture.context);
      expect(result.transaction).toBeDefined();
      const scan = scanCanonicalRollout(fixture.store.rolloutPath, {
        sessionTempRoot: tmpdir(), expectedRunId: fixture.store.sessionId, expectedEpoch: 1,
        compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
      });
      expect(scan.attempts.get(result.transaction!.attempt_id)?.admissionValid).toBe(true);
    } finally {
      fixture.close();
    }
  });

  it("preserves same-session rollback across snapshots around all automatic bookkeeping boundaries", async () => {
    const source = sourceMessages();
    const fixture = createCompactionTransactionHarness(source, { compactionMode: "automatic" });
    try {
      const result = await compactConversation(source, fixture.context);
      const attemptId = result.transaction!.attempt_id;
      emit(fixture, "usage-before-context", { type: "session_usage", payload: usage(fixture.store.sessionId) });
      emit(fixture, "context-boundary", { type: "context_compacted", payload: { summary: "auto-compact boundary (turnId=usage-test)" } });
      emit(fixture, "usage-before-meta", { type: "session_usage", payload: usage(fixture.store.sessionId) });
      const meta = fixture.store.readAll().find((item) => item.type === "session_meta");
      if (meta === undefined) throw new Error("Missing session metadata");
      fixture.store.appendRollout(meta, { durable: true });
      emit(fixture, "usage-after-meta", { type: "session_usage", payload: usage(fixture.store.sessionId) });
      const rollback = fixture.store.rollbackCompaction({ attemptId, nowMs: Date.now() });
      expect(rollback.rollback_mode).toBe("same_session");
      expect(rollback.source_history).toEqual(source);
    } finally {
      fixture.close();
    }
  });

  it("still treats real conversation work after a snapshot as a rollback boundary", async () => {
    const source = sourceMessages();
    const fixture = createCompactionTransactionHarness(source);
    try {
      const result = await compactConversation(source, fixture.context);
      emit(fixture, "usage-only", { type: "session_usage", payload: usage(fixture.store.sessionId) });
      fixture.store.appendRollout({ type: "response_item", payload: { role: "user", content: "New work" } }, { durable: true });
      expect(() => fixture.store.rollbackCompaction({ attemptId: result.transaction!.attempt_id, nowMs: Date.now() }))
        .toThrow(/reviewed branch target/);
    } finally {
      fixture.close();
    }
  });

  it("rejects malformed usage rather than treating it as harmless bookkeeping", () => {
    const fixture = createCompactionTransactionHarness(sourceMessages());
    try {
      emit(fixture, "invalid-usage", {
        type: "session_usage", payload: { ...usage(fixture.store.sessionId), heldCostUsd: -1 },
      });
      expect(() => scanCanonicalRollout(fixture.store.rolloutPath, {
        sessionTempRoot: tmpdir(), expectedRunId: fixture.store.sessionId, expectedEpoch: 1,
        compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
      })).toThrow(/payload does not match the runtime schema/);
    } finally {
      fixture.close();
    }
  });
});
