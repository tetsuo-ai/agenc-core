import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkCtx } from "../fixtures.js";
import { createCompactionTransactionHarness } from "../helpers/compaction-transaction-harness.js";
import { buildInitialTurnState } from "../../src/session/turn-state.js";
import { attemptContextCollapse, postSampleRecovery } from "../../src/phases/post-sample-recovery.js";
import { CompactionTransactionError } from "../../src/services/compact/transaction-types.js";
import { CompactionCleanupPendingError } from "../../src/services/compact/finalize-transaction.js";
import { LLMContextWindowExceededError } from "../../src/llm/errors.js";
import type { LLMMessage } from "../../src/llm/types.js";

const compact = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/compact/compact.js", async (original) => ({
  ...await original<typeof import("../../src/services/compact/compact.js")>(),
  compactConversation: compact,
}));

function fixture() {
  const messages: LLMMessage[] = [
    { role: "user", content: "old ".repeat(2_000) },
    { role: "assistant", content: "old answer" },
    { role: "user", content: "next task" },
    { role: "assistant", content: "next answer" },
    { role: "user", content: "continue" },
  ];
  const harness = createCompactionTransactionHarness(messages, { compactionMode: "automatic" });
  const ctx = mkCtx({ provider: harness.provider, modelInfo: harness.session.modelInfo });
  const state = buildInitialTurnState(ctx, { role: "user", content: "continue" }, { priorMessages: messages });
  state.messages = [...messages];
  state.messagesForQuery = [...messages];
  state.lastStreamError = new LLMContextWindowExceededError("zai-coding-plan", "synthetic overflow");
  return { messages, harness, ctx, state };
}

beforeEach(() => { compact.mockReset(); });

describe("independent context-collapse refusal integration", () => {
  it("catches a typed refusal thrown by compaction, not only the predicate", async () => {
    const f = fixture();
    compact.mockRejectedValue(new CompactionTransactionError("output_limit_exceeded", "synthetic node ceiling"));
    try {
      await expect(attemptContextCollapse({ state: f.state, session: f.harness.session, turnContext: f.ctx }))
        .resolves.toEqual({ kind: "limit_refused", reason: "synthetic node ceiling" });
      expect(compact).toHaveBeenCalledTimes(1);
      expect(f.state.messagesForQuery).toEqual(f.messages);
    } finally { f.harness.close(); }
  });

  it.each([
    new CompactionTransactionError("output_schema_invalid", "schema"),
    new CompactionTransactionError("provenance_invalid", "provenance"),
    new CompactionCleanupPendingError("synthetic-attempt"),
    new Error("unexpected failure"),
    "output_limit_exceeded",
  ])("preserves the original non-refusal rejection %s", async (error) => {
    const f = fixture();
    compact.mockRejectedValue(error);
    try {
      await expect(attemptContextCollapse({ state: f.state, session: f.harness.session, turnContext: f.ctx }))
        .rejects.toBe(error);
    } finally { f.harness.close(); }
  });

  it("emits the typed terminal path, preserves history, and does not collapse twice", async () => {
    const f = fixture();
    const eventSpy = vi.spyOn(f.harness.session.eventLog, "emit");
    compact.mockRejectedValue(new CompactionTransactionError("output_limit_exceeded", "synthetic node ceiling"));
    try {
      await postSampleRecovery(f.state, f.ctx, f.harness.session);
      expect(f.state.transition).toBeUndefined();
      expect(f.state.messagesForQuery).toEqual(f.messages);
      expect(eventSpy.mock.calls.some(([event]) => event.msg.type === "warning" &&
        event.msg.payload.cause === "context_collapse_limit_refused")).toBe(true);
      const errors = f.harness.store.readAll().flatMap((item) =>
        item.type === "event_msg" && item.payload.msg.type === "error" ? [item.payload.msg.payload.cause] : []);
      expect(errors).toContain("prompt_too_long_exhausted");
      expect(eventSpy.mock.calls.some(([event]) => event.msg.type === "error" &&
        event.msg.payload.cause === "recovery_trigger_threw")).toBe(false);
      expect(f.harness.store.readAll().filter((item) => item.type === "compaction_committed")).toHaveLength(0);
      await postSampleRecovery(f.state, f.ctx, f.harness.session);
      expect(compact).toHaveBeenCalledTimes(1);
    } finally { eventSpy.mockRestore(); f.harness.close(); }
  });

  it("keeps unexpected schema failures on the trigger-fault path", async () => {
    const f = fixture();
    const eventSpy = vi.spyOn(f.harness.session.eventLog, "emit");
    compact.mockRejectedValue(new CompactionTransactionError("output_schema_invalid", "schema"));
    try {
      await postSampleRecovery(f.state, f.ctx, f.harness.session);
      expect(f.state.transition).toBeUndefined();
      expect(eventSpy.mock.calls.some(([event]) => event.msg.type === "error" &&
        event.msg.payload.cause === "recovery_trigger_threw")).toBe(true);
      expect(eventSpy.mock.calls.some(([event]) => event.msg.type === "warning" &&
        event.msg.payload.cause === "context_collapse_limit_refused")).toBe(false);
    } finally { eventSpy.mockRestore(); f.harness.close(); }
  });
});
