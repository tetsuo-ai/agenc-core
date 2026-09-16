import { describe, expect, test } from "vitest";
import { buildInitialTurnState } from "../session/turn-state.js";
import {
  attemptContextCollapse,
  isCompactionLimitRefusal,
  postSampleRecovery,
  runContextCollapseOverflowRecovery,
} from "./post-sample-recovery.js";
import { CompactionTransactionError } from "../services/compact/transaction-types.js";
import { findToolTurnValidationIssue } from "../llm/tool-turn-validator.js";
import { mkCtx, mkSession } from "../../tests/fixtures.js";
import type { LLMMessage } from "../llm/types.js";
import type { TurnContext } from "../session/turn-context.js";
import { createCompactionTransactionHarness } from "../helpers/compaction-transaction-harness.js";
import { createToolResultIntegrity } from "../session/tool-result-integrity.js";
import type { RuntimeMessage } from "../services/compact/types.js";
import { LLMContextWindowExceededError } from "../llm/errors.js";

function seedMessages(): LLMMessage[] {
  return [
    { role: "user", content: "start" },
    { role: "assistant", content: "answer 1" },
    { role: "user", content: "more context" },
    { role: "assistant", content: "answer 2" },
    { role: "user", content: "latest" },
  ];
}

// A transcript long enough to collapse, on the real compaction transaction harness. `refuse` records the provider
// refusal Terminal-Bench 4.0 hit on 2026-09-14: a typed context overflow thrown as a stream error, which never reached
// the bounded 413 collapse.
function overflowRecoveryFixture() {
  const messages = seedMessages().map((message, index) => ({
    ...message,
    content: index === 0 ? `start ${"x".repeat(8_000)}` : message.content,
  }));
  const harness = createCompactionTransactionHarness(
    messages as RuntimeMessage[],
    { compactionMode: "automatic" },
  );
  const ctx = {
    ...mkCtx(),
    provider: harness.provider,
    modelInfo: {
      ...mkCtx().modelInfo,
      slug: "grok-4.5",
      contextWindow: 64_000,
    },
  } as TurnContext;
  const state = buildInitialTurnState(
    ctx,
    { role: "user", content: "continue" },
    { priorMessages: messages },
  );
  state.messages = [...messages];
  state.messagesForQuery = [...messages];
  const refuse = () => Object.assign(state, {
    lastStreamError: new LLMContextWindowExceededError(
      "deepseek",
      "This model's maximum context length is 1048576 tokens. However, you requested 1056296 tokens (672296 in the messages, 384000 in the completion).",
    ),
  });
  return { messages, harness, ctx, state, refuse };
}

describe("post-sample context-collapse recovery contract", () => {
  test("Editor interactions bypass collapse and clear resampling decisions", async () => {
    const ctx = {
      ...mkCtx(),
      editorInteraction: {
        interactionId: "editor-no-recovery",
        kind: "explain",
        policy: "read_only",
        editorInstanceId: "editor-1",
        bufferHandle: 7,
        path: "src/value.ts",
        changedtick: 11,
        contentSha256: "a".repeat(64),
        range: {
          start: { line: 1, column: 0 },
          end: { line: 1, column: 5 },
        },
      },
    } as TurnContext;
    const { session, events } = mkSession();
    const messages = seedMessages();
    const state = buildInitialTurnState(
      ctx,
      { role: "user", content: "continue" },
      { priorMessages: messages },
    );
    state.messages = [...messages];
    state.messagesForQuery = [...messages];
    state.assistantMessages = [
      {
        uuid: "editor-asst-413",
        role: "assistant",
        text: "Prompt is too long: 200000 tokens > 128000",
        apiError: "context_window_exceeded",
        toolCalls: [],
      },
    ];
    state.pendingBudgetDecision = {
      kind: "stop",
      reason: "continue spending tokens",
    };
    state.transition = { reason: "collapse_drain_retry" };

    await postSampleRecovery(state, ctx, session);

    expect(state.messages).toEqual(messages);
    expect(state.messagesForQuery).toEqual(messages);
    expect(state.pendingBudgetDecision).toBeUndefined();
    expect(state.transition).toBeUndefined();
    expect(
      events.some(
        (event) =>
          event.msg.type === "error" || event.msg.type === "context_compacted",
      ),
    ).toBe(false);
  });

  test("withheld prompt-too-long routes through collapse once and then surfaces", async () => {
    const { harness, ctx, state } = overflowRecoveryFixture();
    const session = harness.session;
    state.assistantMessages = [
      {
        uuid: "asst-413",
        role: "assistant",
        text: "Prompt is too long: 200000 tokens > 128000",
        apiError: "context_window_exceeded",
        toolCalls: [],
      },
    ];

    await postSampleRecovery(state, ctx, session);

    expect(state.transition).toEqual({ reason: "collapse_drain_retry" });
    expect(state.messagesForQuery[0]?.runtimeOnly?.compactionHistory?.kind)
      .toBe("boundary");
    expect(state.messages[1]?.runtimeOnly?.compactionHistory?.kind)
      .toBe("summary");

    state.transition = undefined;
    await postSampleRecovery(state, ctx, session);

    expect(state.transition).toBeUndefined();
    expect(harness.store.readAll().some((item) =>
      item.type === "event_msg" &&
      item.payload.msg.type === "error" &&
      item.payload.msg.payload.cause === "prompt_too_long_exhausted"
    )).toBe(true);
    harness.close();
  });

  test("413 collapse preserves assistant tool calls paired with kept tool results", async () => {
    const ctx = mkCtx();
    const state = buildInitialTurnState(ctx, {
      role: "user",
      content: "continue",
    });
    const sessionId = "overflow-tool-pair";
    const toolIntegrity = createToolResultIntegrity({
      runId: sessionId,
      toolCallId: "tc-collapse",
      content: "ok",
    });
    state.messagesForQuery = [
      { role: "user", content: `old ${"x".repeat(8_000)}` },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "read file" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tc-collapse", name: "Read", arguments: "{}" }],
      },
      {
        role: "tool",
        toolCallId: "tc-collapse",
        toolName: "Read",
        content: "ok",
        runtimeOnly: {
          toolResultIntegrity: toolIntegrity,
        },
      },
    ];
    const harness = createCompactionTransactionHarness(
      state.messagesForQuery as RuntimeMessage[],
      { sessionId, compactionMode: "automatic" },
    );

    const recovered = await runContextCollapseOverflowRecovery({
      state,
      session: harness.session,
    });

    expect(recovered).toEqual({ kind: "applied", reason: "context_collapse" });
    expect(findToolTurnValidationIssue(state.messagesForQuery)).toBeNull();
    const commit = harness.store.readAll().findLast(
      (item) => item.type === "compaction_committed",
    );
    expect(commit).toMatchObject({
      type: "compaction_committed",
      payload: {
        summary: {
          body: {
            tool_pairs: [{
              tool_call_id: "tc-collapse",
              result_sha256: toolIntegrity.original.digest.replace(
                /^sha256:/u,
                "",
              ),
            }],
          },
        },
      },
    });
    harness.close();
  });

  test("413 collapse preserves assistant call when kept tail starts with tool result", async () => {
    const ctx = mkCtx();
    const state = buildInitialTurnState(ctx, {
      role: "user",
      content: "continue",
    });
    const sessionId = "overflow-tool-edge";
    state.messagesForQuery = [
      { role: "user", content: `old ${"x".repeat(8_000)}` },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tc-edge", name: "Read", arguments: "{}" }],
      },
      {
        role: "tool",
        toolCallId: "tc-edge",
        toolName: "Read",
        content: "ok",
        runtimeOnly: {
          toolResultIntegrity: createToolResultIntegrity({
            runId: sessionId,
            toolCallId: "tc-edge",
            content: "ok",
          }),
        },
      },
      { role: "user", content: "latest" },
      { role: "assistant", content: "latest answer" },
    ];
    const harness = createCompactionTransactionHarness(
      state.messagesForQuery as RuntimeMessage[],
      { sessionId, compactionMode: "automatic" },
    );

    const recovered = await runContextCollapseOverflowRecovery({
      state,
      session: harness.session,
    });

    expect(recovered).toEqual({ kind: "applied", reason: "context_collapse" });
    expect(findToolTurnValidationIssue(state.messagesForQuery)).toBeNull();
    harness.close();
  });

  test("a context overflow thrown by the provider routes through collapse once and then surfaces", async () => {
    const { harness, ctx, state, refuse } = overflowRecoveryFixture();
    refuse();

    await postSampleRecovery(state, ctx, harness.session);

    expect(state.transition).toEqual({ reason: "collapse_drain_retry" });
    expect(state.messagesForQuery[0]?.runtimeOnly?.compactionHistory?.kind)
      .toBe("boundary");

    // The resampled request is refused again: the latch holds, so the turn surfaces instead of collapsing twice.
    state.transition = undefined;
    refuse();
    await postSampleRecovery(state, ctx, harness.session);

    expect(state.transition).toBeUndefined();
    expect(harness.store.readAll().filter((item) => item.type === "compaction_committed"))
      .toHaveLength(1);
    expect(harness.store.readAll().some((item) =>
      item.type === "event_msg" &&
      item.payload.msg.type === "error" &&
      item.payload.msg.payload.cause === "prompt_too_long_exhausted"
    )).toBe(true);
    harness.close();
  });

  test("a context overflow after a streamed tool call is left to end the turn", async () => {
    const { messages, harness, ctx, state, refuse } = overflowRecoveryFixture();
    state.toolUseBlocks = [{ type: "tool_use", id: "tc-streamed", name: "Write", input: {} }];
    refuse();

    await postSampleRecovery(state, ctx, harness.session);

    expect(state.transition).toBeUndefined();
    expect(state.messagesForQuery).toEqual(messages);
    expect(harness.store.readAll().some((item) => item.type === "compaction_committed"))
      .toBe(false);
    harness.close();
  });
});

// #2520: compaction can refuse to plan a history inside its own resource bounds
// before any provider call. That refusal used to escape 413 recovery as an
// untyped throw, which the ladder turned into `trigger_threw`, ending the turn
// without the typed prompt_too_long_exhausted record.
describe("compaction resource refusals are separated from faults", () => {
  test("a bounded planner refusal is classified as a refusal", () => {
    expect(
      isCompactionLimitRefusal(
        new CompactionTransactionError(
          "output_limit_exceeded",
          "provider output exceeds its node limit",
        ),
      ),
    ).toBe(true);
  });

  test("schema and provenance failures are never refusals, so they still propagate", () => {
    expect(
      isCompactionLimitRefusal(
        new CompactionTransactionError("output_schema_invalid", "bad schema"),
      ),
    ).toBe(false);
    expect(
      isCompactionLimitRefusal(
        new CompactionTransactionError("provenance_invalid", "bad provenance"),
      ),
    ).toBe(false);
  });

  test("an unrelated error is never a refusal", () => {
    expect(isCompactionLimitRefusal(new Error("boom"))).toBe(false);
    expect(isCompactionLimitRefusal(undefined)).toBe(false);
    expect(isCompactionLimitRefusal("output_limit_exceeded")).toBe(false);
  });

  test("attemptContextCollapse passes through when there is nothing to collapse", async () => {
    const ctx = mkCtx();
    const state = buildInitialTurnState(ctx, {
      role: "user",
      content: "continue",
    });
    await expect(attemptContextCollapse({ state })).resolves.toEqual({
      kind: "pass",
    });
  });
});
