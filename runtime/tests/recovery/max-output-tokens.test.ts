import { describe, expect, test } from "vitest";
import { EventLog } from "../session/event-log.js";
import { findToolTurnValidationIssue } from "../llm/tool-turn-validator.js";
import type { Session } from "../session/session.js";
import type { TurnState } from "../session/turn-state.js";
import {
  MAX_OUTPUT_TOKENS_ESCALATED,
  MAX_OUTPUT_TOKENS_RECOVERY_LIMIT,
  runMaxOutputTokensRecovery,
} from "./max-output-tokens.js";

interface FakeExecutor {
  discardCount: number;
  lastReason?: string;
  discard(reason?: string): void;
}

interface FakeCompletedExecutor extends FakeExecutor {
  getCompletedResults(): Iterable<{
    readonly toolCall: {
      readonly id: string;
      readonly name: string;
      readonly arguments: string;
    };
    readonly result: {
      readonly content: string;
      readonly isError?: boolean;
      readonly metadata?: unknown;
    };
  }>;
  getToolStates(): ReadonlyArray<{
    readonly id: string;
    readonly status: string;
    readonly toolName: string;
    readonly toolCall: {
      readonly id: string;
      readonly name: string;
      readonly arguments: string;
    };
  }>;
}

function mkExecutor(): FakeExecutor {
  return {
    discardCount: 0,
    discard(reason?: string) {
      this.discardCount += 1;
      this.lastReason = reason;
    },
  };
}

function mkCompletedExecutor(): FakeCompletedExecutor {
  let yielded = false;
  return {
    ...mkExecutor(),
    *getCompletedResults() {
      if (yielded) return;
      yielded = true;
      yield {
        toolCall: {
          id: "tc-complete",
          name: "stream_read",
          arguments: "{}",
        },
        result: { content: "read-ok", isError: false },
      };
    },
    getToolStates() {
      return [
        {
          id: "tc-complete",
          status: "yielded",
          toolName: "stream_read",
          toolCall: {
            id: "tc-complete",
            name: "stream_read",
            arguments: "{}",
          },
        },
      ];
    },
  };
}

function mkExecutingExecutor(): FakeCompletedExecutor {
  return {
    ...mkExecutor(),
    *getCompletedResults() {
      return;
    },
    getToolStates() {
      return [
        {
          id: "tc-executing",
          status: "executing",
          toolName: "stream_write",
          toolCall: {
            id: "tc-executing",
            name: "stream_write",
            arguments: "{}",
          },
        },
      ];
    },
  };
}

function mkSession(log: EventLog): Session {
  let i = 0;
  return {
    eventLog: log,
    nextInternalSubId: () => `s-${++i}`,
    emit: (event) => {
      log.emit(event);
    },
  } as unknown as Session;
}

function mkState(opts: Partial<TurnState> = {}): TurnState {
  return {
    messages: [],
    messagesForQuery: [],
    autoCompactTracking: undefined,
    taskBudgetRemaining: undefined,
    snipTokensFreed: 0,
    pendingMemoryPrefetch: undefined,
    pendingSkillPrefetch: undefined,
    contentReplacementState: undefined,
    assistantMessages: [],
    toolUseBlocks: [],
    needsFollowUp: false,
    completedToolResults: [],
    toolResults: [],
    hasAttemptedReactiveCompact: false,
    maxOutputTokensOverride: undefined,
    maxOutputTokensRecoveryCount: 0,
    recoveryReentryCount: 0,
    continuationNudgeCount: 0,
    streamingToolExecutor: null,
    pendingToolUseSummary: undefined,
    preventContinuation: false,
    pendingBudgetDecision: undefined,
    lastResponseUsage: undefined,
    turnCount: 1,
    transition: undefined,
    stopHookActive: undefined,
    stopHookBlockingCount: 0,
    ...opts,
  };
}

describe("runMaxOutputTokensRecovery — T8 hardening", () => {
  test("escalate path: discards pending executor + nulls slot", () => {
    const log = new EventLog();
    const session = mkSession(log);
    const executor = mkExecutor();
    const queryMessages = [{ role: "user" as const, content: "rewrite parser" }];
    const state = mkState({
      messages: [
        ...queryMessages,
        {
          role: "assistant",
          content: "partial Write call",
          toolCalls: [{ id: "tc-1", name: "system.bash", arguments: "{}" }],
        },
      ],
      messagesForQuery: queryMessages,
      streamingToolExecutor: executor,
      assistantMessages: [
        {
          uuid: "a1",
          role: "assistant",
          text: "partial",
          toolCalls: [{ id: "tc-1", name: "system.bash", arguments: "{}" }],
        },
      ],
      toolUseBlocks: [{ type: "tool_use", id: "tc-1", name: "system.bash", input: {} }],
    });

    const outcome = runMaxOutputTokensRecovery({ session, state });

    expect(outcome.kind).toBe("escalate");
    expect(state.maxOutputTokensOverride).toBe(MAX_OUTPUT_TOKENS_ESCALATED);
    expect(executor.discardCount).toBe(1);
    expect(executor.lastReason).toBe("max_output_tokens");
    expect(state.streamingToolExecutor).toBeNull();
    expect(state.messages).toEqual(queryMessages);
    expect(state.assistantMessages).toEqual([]);
    expect(state.toolUseBlocks).toEqual([]);
    expect(state.toolResults).toEqual([]);
    expect(state.needsFollowUp).toBe(false);
  });

  test("escalate path: emits executor_discarded warning with cause max_output_tokens", () => {
    const log = new EventLog();
    const session = mkSession(log);
    const executor = mkExecutor();
    const state = mkState({ streamingToolExecutor: executor });

    const warnings: Array<{ cause: string; message: string }> = [];
    log.subscribe((e) => {
      const p = e.msg.payload as { cause?: string; message?: string };
      if (e.msg.type === "warning" && p.cause && p.message !== undefined) {
        warnings.push({ cause: p.cause, message: p.message });
      }
    });

    runMaxOutputTokensRecovery({ session, state });

    const discarded = warnings.find((w) => w.cause === "executor_discarded");
    expect(discarded).toBeDefined();
    expect(discarded?.message).toBe("max_output_tokens");
  });

  test("continuation path: discards pending executor + nulls slot", () => {
    const log = new EventLog();
    const session = mkSession(log);
    const executor = mkExecutor();
    const state = mkState({
      streamingToolExecutor: executor,
      maxOutputTokensOverride: MAX_OUTPUT_TOKENS_ESCALATED,
    });

    const outcome = runMaxOutputTokensRecovery({ session, state });

    expect(outcome.kind).toBe("continuation");
    expect(state.maxOutputTokensRecoveryCount).toBe(1);
    expect(executor.discardCount).toBe(1);
    expect(executor.lastReason).toBe("max_output_tokens");
    expect(state.streamingToolExecutor).toBeNull();
  });

  test("continuation path preserves completed executor results in model history", () => {
    const log = new EventLog();
    const session = mkSession(log);
    const executor = mkCompletedExecutor();
    const state = mkState({
      streamingToolExecutor: executor,
      maxOutputTokensOverride: MAX_OUTPUT_TOKENS_ESCALATED,
    });

    const outcome = runMaxOutputTokensRecovery({ session, state });

    expect(outcome.kind).toBe("continuation");
    expect(
      state.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.toolCalls?.some((call) => call.id === "tc-complete") === true,
      ),
    ).toBe(true);
    expect(
      state.messages.some(
        (message) =>
          message.role === "tool" &&
          message.toolCallId === "tc-complete" &&
          typeof message.content === "string" &&
          message.content.includes("untrusted workspace data") &&
          message.content.includes("read-ok"),
      ),
    ).toBe(true);
    expect(state.toolResults).toContainEqual(
      expect.objectContaining({
        role: "user",
        toolCallId: "tc-complete",
        toolName: "stream_read",
        content: expect.stringContaining("read-ok"),
      }),
    );
  });

  test("continuation path preserves terminal executor closures in model history", () => {
    const log = new EventLog();
    const session = mkSession(log);
    const executor = mkExecutingExecutor();
    const state = mkState({
      streamingToolExecutor: executor,
      maxOutputTokensOverride: MAX_OUTPUT_TOKENS_ESCALATED,
    });

    const outcome = runMaxOutputTokensRecovery({ session, state });

    expect(outcome.kind).toBe("continuation");
    expect(state.messages.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "user",
    ]);
    expect(state.messages[0]).toMatchObject({
      role: "assistant",
      toolCalls: [
        {
          id: "tc-executing",
          name: "stream_write",
          arguments: "{}",
        },
      ],
    });
    expect(state.messages[1]).toMatchObject({
      role: "tool",
      toolCallId: "tc-executing",
      toolName: "stream_write",
      content: expect.stringContaining("untrusted workspace data"),
    });
    expect(state.toolResults).toContainEqual(
      expect.objectContaining({
        role: "user",
        toolCallId: "tc-executing",
        toolName: "stream_write",
      }),
    );
    expect(findToolTurnValidationIssue(state.messages)).toBeNull();
  });

  test("preserves already-completed executor results before discard", () => {
    const log = new EventLog();
    const session = mkSession(log);
    const executor = mkCompletedExecutor();
    const state = mkState({ streamingToolExecutor: executor });
    const completions: Array<{
      readonly callId: string;
      readonly result: string;
      readonly isError: boolean;
      readonly metadata?: unknown;
    }> = [];
    log.subscribe((event) => {
      if (event.msg.type === "tool_call_completed") {
        completions.push(event.msg.payload);
      }
    });

    const outcome = runMaxOutputTokensRecovery({ session, state });

    expect(outcome.kind).toBe("escalate");
    expect(state.completedToolResults).toEqual([
      {
        callId: "tc-complete",
        toolName: "stream_read",
        arguments: "{}",
        content: "read-ok",
        isError: false,
      },
    ]);
    expect(completions).toEqual([
      {
        callId: "tc-complete",
        result: "read-ok",
        isError: false,
      },
    ]);
    expect(state.toolResults).toEqual([]);
    expect(
      state.messages.some(
        (message) =>
          message.role === "tool" && message.toolCallId === "tc-complete",
      ),
    ).toBe(false);
    expect(executor.discardCount).toBe(1);
    expect(executor.lastReason).toBe("max_output_tokens");
  });

  test("no executor → escalate still works + emits warning", () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState({ streamingToolExecutor: null });

    const warnings: string[] = [];
    log.subscribe((e) => {
      const p = e.msg.payload as { cause?: string };
      if (e.msg.type === "warning" && p.cause) warnings.push(p.cause);
    });

    const outcome = runMaxOutputTokensRecovery({ session, state });

    expect(outcome.kind).toBe("escalate");
    expect(warnings).toContain("executor_discarded");
    expect(state.streamingToolExecutor).toBeNull();
  });

  test("escalateAllowed=false → jumps directly to continuation + discards executor", () => {
    const log = new EventLog();
    const session = mkSession(log);
    const executor = mkExecutor();
    const state = mkState({ streamingToolExecutor: executor });

    const outcome = runMaxOutputTokensRecovery({
      session,
      state,
      escalateAllowed: false,
    });

    expect(outcome.kind).toBe("continuation");
    expect(executor.discardCount).toBe(1);
    expect(state.streamingToolExecutor).toBeNull();
  });

  test("escalate path honors model upper limit", () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState();

    const outcome = runMaxOutputTokensRecovery({
      session,
      state,
      escalatedMaxOutputTokens: 32_768,
    });

    expect(outcome.kind).toBe("escalate");
    expect(state.maxOutputTokensOverride).toBe(32_768);
  });

  test("exhausted path: no executor discard (no state mutation to recover)", () => {
    const log = new EventLog();
    const session = mkSession(log);
    const executor = mkExecutor();
    const state = mkState({
      streamingToolExecutor: executor,
      maxOutputTokensOverride: MAX_OUTPUT_TOKENS_ESCALATED,
      maxOutputTokensRecoveryCount: MAX_OUTPUT_TOKENS_RECOVERY_LIMIT,
    });

    const outcome = runMaxOutputTokensRecovery({ session, state });

    expect(outcome.kind).toBe("exhausted");
    expect(executor.discardCount).toBe(0);
    // state.streamingToolExecutor untouched on exhausted path — caller
    // surfaces the error; no recovery occurred.
    expect(state.streamingToolExecutor).toBe(executor);
  });

  test("executor.discard throwing is absorbed (I-41 re-entrance guard)", () => {
    const log = new EventLog();
    const session = mkSession(log);
    const throwingExecutor = {
      discard(_reason?: string): void {
        throw new Error("re-entrance");
      },
    };
    const state = mkState({ streamingToolExecutor: throwingExecutor });

    expect(() =>
      runMaxOutputTokensRecovery({ session, state }),
    ).not.toThrow();
    expect(state.streamingToolExecutor).toBeNull();
  });
});
