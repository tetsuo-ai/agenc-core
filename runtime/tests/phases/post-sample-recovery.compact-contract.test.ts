import { describe, expect, test } from "vitest";
import { buildInitialTurnState } from "../session/turn-state.js";
import {
  postSampleRecovery,
  runContextCollapseOverflowRecovery,
} from "./post-sample-recovery.js";
import { findToolTurnValidationIssue } from "../llm/tool-turn-validator.js";
import { mkCtx, mkSession } from "../../tests/fixtures.js";
import type { LLMMessage } from "../llm/types.js";
import type { TurnContext } from "../session/turn-context.js";
import { createCompactionTransactionHarness } from "../helpers/compaction-transaction-harness.js";
import { createToolResultIntegrity } from "../session/tool-result-integrity.js";
import type { RuntimeMessage } from "../services/compact/types.js";

function seedMessages(): LLMMessage[] {
  return [
    { role: "user", content: "start" },
    { role: "assistant", content: "answer 1" },
    { role: "user", content: "more context" },
    { role: "assistant", content: "answer 2" },
    { role: "user", content: "latest" },
  ];
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
    const session = harness.session;
    const state = buildInitialTurnState(
      ctx,
      { role: "user", content: "continue" },
      { priorMessages: messages },
    );
    state.messages = [...messages];
    state.messagesForQuery = [...messages];
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
    // The kept suffix reaches back to the user's last message ("read file"),
    // so the whole tool exchange stays verbatim and paired in the live
    // context; the summary covers only the older turn and pins no pairs.
    const keptCall = state.messagesForQuery.find(
      (message) =>
        message.role === "assistant" &&
        message.toolCalls?.some((call) => call.id === "tc-collapse"),
    );
    const keptResult = state.messagesForQuery.find(
      (message) => message.role === "tool" && message.toolCallId === "tc-collapse",
    );
    expect(keptCall).toBeDefined();
    expect(keptResult).toBeDefined();
    expect(keptResult?.runtimeOnly?.toolResultIntegrity).toEqual(toolIntegrity);
    const commit = harness.store.readAll().findLast(
      (item) => item.type === "compaction_committed",
    );
    expect(commit).toMatchObject({
      type: "compaction_committed",
      payload: { summary: { body: { tool_pairs: [] } } },
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
});
