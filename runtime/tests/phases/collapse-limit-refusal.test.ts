import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkCtx } from "../fixtures.js";
import { createCompactionTransactionHarness } from "../helpers/compaction-transaction-harness.js";
import { buildInitialTurnState } from "../../src/session/turn-state.js";
import { postSampleRecovery, runContextCollapseOverflowRecovery } from "../../src/phases/post-sample-recovery.js";
import { CompactionTransactionError } from "../../src/services/compact/transaction-types.js";
import { CompactionCleanupPendingError } from "../../src/services/compact/finalize-transaction.js";
import {
  AGGRESSIVE_COMPACTION_FOCUS,
  EMERGENCY_COMPACTION_FOCUS,
} from "../../src/services/compact/ladder.js";
import { LLMContextWindowExceededError } from "../../src/llm/errors.js";
import type { LLMMessage } from "../../src/llm/types.js";
import type { TurnContext } from "../../src/session/turn-context.js";

type CompactModule = typeof import("../../src/services/compact/compact.js");

const compact = vi.hoisted(() => vi.fn());
const realCompact = vi.hoisted(() => ({
  current: undefined as CompactModule["compactConversation"] | undefined,
}));
vi.mock("../../src/services/compact/compact.js", async (original) => {
  const module = await original<CompactModule>();
  realCompact.current = module.compactConversation;
  return { ...module, compactConversation: compact };
});

const STANDARD_FOCUS = "Recover from a prompt-too-long provider response.";

function refusal(): CompactionTransactionError {
  return new CompactionTransactionError("output_limit_exceeded", "synthetic node ceiling");
}

function fixture(options: { readonly emergencyMode?: "always" | "never" } = {}) {
  const messages: LLMMessage[] = [
    // Long enough that even the model-free emergency summary clears the shrink floor.
    { role: "user", content: `start ${"x".repeat(8_000)}` },
    { role: "assistant", content: "old answer" },
    { role: "user", content: "next task" },
    { role: "assistant", content: "next answer" },
    { role: "user", content: "continue" },
  ];
  const harness = createCompactionTransactionHarness(messages, { compactionMode: "automatic" });
  const base = mkCtx({ provider: harness.provider, modelInfo: harness.session.modelInfo });
  const ctx: TurnContext = options.emergencyMode === undefined
    ? base
    : { ...base, config: { ...base.config, compaction: { emergency_mode: options.emergencyMode } } };
  const state = buildInitialTurnState(ctx, { role: "user", content: "continue" }, { priorMessages: messages });
  state.messages = [...messages];
  state.messagesForQuery = [...messages];
  state.lastStreamError = new LLMContextWindowExceededError("zai-coding-plan", "synthetic overflow");
  const warnings: { cause: string; message: string }[] = [];
  const logErrors: string[] = [];
  harness.session.eventLog.subscribe((event) => {
    if (event.msg.type === "warning") warnings.push(event.msg.payload);
    if (event.msg.type === "error") logErrors.push(event.msg.payload.cause);
  });
  const errors = () => logErrors;
  const rolloutErrors = () => harness.store.readAll().flatMap((item) =>
    item.type === "event_msg" && item.payload.msg.type === "error" ? [item.payload.msg.payload.cause] : []);
  return { messages, harness, ctx, state, warnings, errors, rolloutErrors };
}

function tiersCalled(): { focus: unknown; options: unknown }[] {
  return compact.mock.calls.map(([, , focus, options]) => ({ focus, options }));
}

beforeEach(() => { compact.mockReset(); });

// #2520: the standard 413 collapse could not commit and the turn ended although
// the compaction ladder still had `aggressive_summary` and `emergency_local`
// unused. A tier that declines leaves history unchanged, so it steps down; the
// turn only ends, on its typed path, when every allowed tier has declined.
describe("413 collapse ladder", () => {
  it("steps down after a refused standard collapse and resamples when the emergency tier commits", async () => {
    const f = fixture();
    compact.mockImplementation((messages, context, focus, options) =>
      focus === EMERGENCY_COMPACTION_FOCUS
        ? realCompact.current!(messages, context, focus, options)
        : Promise.reject(refusal()));
    try {
      await postSampleRecovery(f.state, f.ctx, f.harness.session);

      expect(tiersCalled()).toEqual([
        { focus: STANDARD_FOCUS, options: {} },
        { focus: AGGRESSIVE_COMPACTION_FOCUS, options: { keepCount: 0 } },
        { focus: EMERGENCY_COMPACTION_FOCUS, options: { keepCount: 0, summarizer: expect.any(Function) } },
      ]);
      expect(f.state.transition).toEqual({ reason: "collapse_drain_retry" });
      expect(f.state.messagesForQuery[0]?.runtimeOnly?.compactionHistory?.kind).toBe("boundary");
      expect(f.state.messages).toEqual(f.state.messagesForQuery);
      expect(f.state.compactionLadder).toBeUndefined();
      expect(f.harness.store.readAll().filter((item) => item.type === "compaction_committed")).toHaveLength(1);
      expect(f.warnings).toEqual([
        { cause: "recovery_triggered", message: expect.stringContaining("trigger=isWithheld413") },
        { cause: "auto_compact_degraded", message: "reactive_recovery/in_turn: tier=aggressive_summary attempting after output_limit_exceeded" },
        { cause: "auto_compact_degraded", message: "reactive_recovery/in_turn: tier=emergency_local attempting after output_limit_exceeded" },
        { cause: "auto_compact_degraded", message: "reactive_recovery/in_turn: tier=emergency_local compacted" },
      ]);
      expect(f.errors()).toEqual([]);
      expect(f.rolloutErrors()).toEqual([]);
    } finally { f.harness.close(); }
  });

  it("ends on the typed prompt_too_long_exhausted path when every tier refuses, never on trigger_threw", async () => {
    const f = fixture();
    compact.mockImplementation(() => Promise.reject(refusal()));
    try {
      await postSampleRecovery(f.state, f.ctx, f.harness.session);

      expect(tiersCalled().map((call) => call.focus)).toEqual([
        STANDARD_FOCUS,
        AGGRESSIVE_COMPACTION_FOCUS,
        EMERGENCY_COMPACTION_FOCUS,
      ]);
      expect(f.state.transition).toBeUndefined();
      expect(f.state.messagesForQuery).toEqual(f.messages);
      expect(f.state.compactionLadder).toEqual({ tiersAttempted: ["aggressive_summary", "emergency_local"] });
      expect(f.warnings.map((warning) => warning.cause)).toEqual([
        "recovery_triggered",
        "auto_compact_degraded",
        "auto_compact_degraded",
        "context_collapse_ladder_exhausted",
      ]);
      expect(f.warnings.at(-1)?.message).toBe(
        "compaction declined at every ladder tier: " +
        "standard=output_limit_exceeded (synthetic node ceiling); " +
        "aggressive_summary=output_limit_exceeded (synthetic node ceiling); " +
        "emergency_local=output_limit_exceeded (synthetic node ceiling)",
      );
      expect(f.rolloutErrors()).toEqual(["prompt_too_long_exhausted"]);
      expect(f.errors()).not.toContain("recovery_trigger_threw");
      expect(f.harness.store.readAll().filter((item) => item.type === "compaction_committed")).toHaveLength(0);

      // The one-collapse-per-overflow latch still holds: a second refusal does not walk the ladder again.
      await postSampleRecovery(f.state, f.ctx, f.harness.session);
      expect(compact).toHaveBeenCalledTimes(3);
    } finally { f.harness.close(); }
  });

  it("treats a rejected provider summary as a tier failure, not a trigger fault", async () => {
    const f = fixture();
    compact.mockImplementation(() =>
      Promise.reject(new CompactionTransactionError("output_schema_invalid", "schema")));
    try {
      await postSampleRecovery(f.state, f.ctx, f.harness.session);

      expect(compact).toHaveBeenCalledTimes(3);
      expect(f.state.transition).toBeUndefined();
      expect(f.rolloutErrors()).toEqual(["prompt_too_long_exhausted"]);
      expect(f.errors()).not.toContain("recovery_trigger_threw");
    } finally { f.harness.close(); }
  });

  it("skips the aggressive summary after a provider-side failure and goes straight to the model-free tier", async () => {
    const f = fixture();
    compact.mockImplementation(() =>
      Promise.reject(new CompactionTransactionError("provider_error", "summarizer 500")));
    try {
      await expect(runContextCollapseOverflowRecovery({ state: f.state, session: f.harness.session, turnContext: f.ctx }))
        .resolves.toMatchObject({
          kind: "ladder_exhausted",
          failures: [
            { tier: "standard", reason: "provider_error" },
            { tier: "emergency_local", reason: "provider_error" },
          ],
        });
      expect(tiersCalled().map((call) => call.focus)).toEqual([STANDARD_FOCUS, EMERGENCY_COMPACTION_FOCUS]);
    } finally { f.harness.close(); }
  });

  it("honours compaction.emergency_mode = never by stopping after the aggressive summary", async () => {
    const f = fixture({ emergencyMode: "never" });
    compact.mockImplementation(() => Promise.reject(refusal()));
    try {
      await expect(runContextCollapseOverflowRecovery({ state: f.state, session: f.harness.session, turnContext: f.ctx }))
        .resolves.toMatchObject({
          kind: "ladder_exhausted",
          failures: [
            { tier: "standard", reason: "output_limit_exceeded" },
            { tier: "aggressive_summary", reason: "output_limit_exceeded" },
          ],
        });
      expect(tiersCalled().map((call) => call.focus)).toEqual([STANDARD_FOCUS, AGGRESSIVE_COMPACTION_FOCUS]);
    } finally { f.harness.close(); }
  });

  it("does not retry a tier the proactive ladder already attempted in this episode", async () => {
    const f = fixture();
    f.state.compactionLadder = { tiersAttempted: ["aggressive_summary"] };
    compact.mockImplementation(() => Promise.reject(refusal()));
    try {
      await runContextCollapseOverflowRecovery({ state: f.state, session: f.harness.session, turnContext: f.ctx });
      expect(tiersCalled().map((call) => call.focus)).toEqual([STANDARD_FOCUS, EMERGENCY_COMPACTION_FOCUS]);
      expect(f.state.compactionLadder).toEqual({ tiersAttempted: ["aggressive_summary", "emergency_local"] });
    } finally { f.harness.close(); }
  });

  it.each([
    new CompactionTransactionError("commit_failed", "commit"),
    new CompactionTransactionError("intent_failed", "intent"),
    new CompactionTransactionError("recovery_interrupted", "interrupted"),
    new CompactionCleanupPendingError("synthetic-attempt"),
    new Error("unexpected failure"),
    "output_limit_exceeded",
  ])("propagates a fault that leaves history state uncertain without trying another tier: %s", async (error) => {
    const f = fixture();
    compact.mockRejectedValue(error);
    try {
      await expect(runContextCollapseOverflowRecovery({ state: f.state, session: f.harness.session, turnContext: f.ctx }))
        .rejects.toBe(error);
      expect(compact).toHaveBeenCalledTimes(1);
      expect(f.state.messagesForQuery).toEqual(f.messages);
    } finally { f.harness.close(); }
  });

  it("keeps a commit fault on the trigger-fault path", async () => {
    const f = fixture();
    compact.mockRejectedValue(new CompactionTransactionError("commit_failed", "durable compaction commit failed"));
    try {
      await postSampleRecovery(f.state, f.ctx, f.harness.session);
      expect(compact).toHaveBeenCalledTimes(1);
      expect(f.state.transition).toBeUndefined();
      expect(f.errors()).toContain("recovery_trigger_threw");
      expect(f.warnings.map((warning) => warning.cause)).not.toContain("context_collapse_ladder_exhausted");
    } finally { f.harness.close(); }
  });

  it("stops the ladder when the turn is aborted during a tier", async () => {
    const f = fixture();
    const controller = new AbortController();
    const aborted = refusal();
    compact.mockImplementation(() => { controller.abort(); return Promise.reject(aborted); });
    try {
      await expect(runContextCollapseOverflowRecovery({
        state: f.state, session: f.harness.session, turnContext: f.ctx, signal: controller.signal,
      })).rejects.toBe(aborted);
      expect(compact).toHaveBeenCalledTimes(1);
    } finally { f.harness.close(); }
  });
});
