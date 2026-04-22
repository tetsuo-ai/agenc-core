import { describe, expect, test, vi } from "vitest";
vi.mock("axios", () => {
  const axiosLike = {
    create: vi.fn(() => axiosLike),
    get: vi.fn(),
    post: vi.fn(),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  };
  return {
    default: axiosLike,
    create: axiosLike.create,
    isAxiosError: () => false,
  };
});
import { EventLog } from "../session/event-log.js";
import {
  IncrementalTracker,
  registerIncrementalTracker,
} from "../llm/grok/incremental.js";
import { ProviderHttpClient } from "../llm/client.js";
import type { Session } from "../session/session.js";
import type { AssistantMessage, TurnState } from "../session/turn-state.js";
import type { LLMMessage } from "../llm/types.js";
import {
  DEFAULT_REACTIVE_COMPACT_DRIVER,
  resetHasAttemptedReactiveCompact,
  runReactiveCompact,
  type ReactiveCompactDriver,
} from "./reactive-compact.js";

/**
 * Test-only session shim. Exposes:
 *   - `eventLog` for non-mock subscribers
 *   - `emit` that mimics `Session.emit`: fans through eventLog AND
 *     triggers the `context_compacted` listener.
 *   - `clearProviderResponseId` wired to a real ProviderHttpClient,
 *     so we can assert the live I-2 wire-state clear rather than
 *     just the grok tracker registry.
 */
interface StubSessionOptions {
  readonly services?: Record<string, unknown>;
  readonly httpClient?: ProviderHttpClient;
  readonly rolloutAppend?: (event: unknown) => void;
}

function mkSession(
  eventLog: EventLog,
  opts: StubSessionOptions = {},
): Session & {
  httpClient?: ProviderHttpClient;
} {
  let subIdCounter = 0;
  const httpClient = opts.httpClient;
  const clearProviderResponseId = (): void => {
    httpClient?.clearResponsesResponseId();
  };
  const emit = (event: {
    readonly id: string;
    readonly msg: {
      readonly type: string;
      readonly payload?: Record<string, unknown>;
    };
  }): void => {
    if (event.msg.type === "context_compacted") {
      clearProviderResponseId();
    }
    eventLog.emit(event as never);
    opts.rolloutAppend?.(event);
  };
  return {
    eventLog,
    nextInternalSubId: () => `sub-${++subIdCounter}`,
    emit,
    clearProviderResponseId,
    httpClient,
    ...(opts.rolloutAppend
      ? {
          rolloutStore: {
            append: opts.rolloutAppend,
          },
        }
      : {}),
    ...(opts.services ? { services: opts.services } : {}),
  } as unknown as Session & { httpClient?: ProviderHttpClient };
}

function mkState(): TurnState {
  return {
    messages: [],
    messagesForQuery: [{ role: "user", content: "hi" }],
    autoCompactTracking: undefined,
    taskBudgetRemaining: undefined,
    snipTokensFreed: 0,
    pendingMemoryPrefetch: undefined,
    pendingSkillPrefetch: undefined,
    contentReplacementState: undefined,
    assistantMessages: [],
    toolUseBlocks: [],
    needsFollowUp: false,
    toolResults: [],
    hasAttemptedReactiveCompact: false,
    maxOutputTokensOverride: undefined,
    maxOutputTokensRecoveryCount: 0,
    recoveryReentryCount: 0,
    continuationNudgeCount: 0,
    streamingToolExecutor: null,
    pendingToolUseSummary: undefined,
    pendingBudgetDecision: undefined,
    lastResponseUsage: undefined,
    turnCount: 1,
    transition: undefined,
    stopHookActive: undefined,
    stopHookBlockingCount: 0,
  };
}

const lastMessage: AssistantMessage = {
  uuid: "a1",
  role: "assistant",
  text: "Prompt is too long",
  toolCalls: [],
};

/**
 * Build a `ProviderHttpClient` in a known state: a conversation id
 * is bound, and a `lastResponseId` is seeded. Used by the live-path
 * tests to assert that compaction cleanup clears the continuation
 * wire-state on the actual HTTP client, not just the grok tracker
 * registry.
 */
function mkSeededHttpClient(): ProviderHttpClient {
  const client = new ProviderHttpClient({
    providerName: "test",
    baseURL: "https://example.invalid",
    defaultHeaders: {},
  });
  client.bindConversationId("conv-test");
  // Directly reach into the private state shim to seed lastResponseId —
  // the only in-process way to simulate a provider that previously
  // returned a `response.id` that lives in the Responses API
  // continuation baseline. Mirrors the seam at
  // `shape-request.ts:252` (`request.previous_response_id =
  // state.lastResponseId`).
  const state = (
    client as unknown as {
      responsesContinuationState: {
        lastResponseId?: string;
        conversationId?: string;
      };
    }
  ).responsesContinuationState;
  state.lastResponseId = "resp-seeded";
  return client;
}

function readLastResponseId(client: ProviderHttpClient): string | undefined {
  return (
    client as unknown as {
      responsesContinuationState: { lastResponseId?: string };
    }
  ).responsesContinuationState.lastResponseId;
}

describe("reactive-compact (I-40 throw guard)", () => {
  test("default driver with empty history → kind='noop' (driver_returned_null)", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState();
    state.messagesForQuery = [];
    const out = await runReactiveCompact({ session, state, lastMessage });
    expect(out.kind).toBe("noop");
    if (out.kind === "noop") {
      expect(out.reason).toBe("driver_returned_null");
    }
  });

  test("default driver with stub session (no services) → kind='noop'", async () => {
    // Without a real session.state / session.services.registry, the
    // session-backed compact context cannot be built and the default
    // driver gracefully returns null.
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState();
    state.messagesForQuery = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ];
    const out = await runReactiveCompact({ session, state, lastMessage });
    expect(out.kind).toBe("noop");
    if (out.kind === "noop") {
      expect(out.reason).toBe("driver_returned_null");
    }
  });

  test("I-40: thrown error → kind='threw' + warning emitted + circuit breaker ++", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState();
    state.autoCompactTracking = {
      compacted: false,
      turnId: "t",
      turnCounter: 0,
      consecutiveFailures: 0,
    };
    const warnings: string[] = [];
    log.subscribe((e) => {
      const p = e.msg.payload as { cause?: string };
      if (e.msg.type === "warning" && p.cause === "reactive_compact_threw") {
        warnings.push(p.cause);
      }
    });
    const driver: ReactiveCompactDriver = {
      ...DEFAULT_REACTIVE_COMPACT_DRIVER,
      isReactiveCompactEnabled: () => true,
      async tryReactiveCompact() {
        throw new Error("summarization failed");
      },
    };
    const out = await runReactiveCompact({
      session,
      state,
      lastMessage,
      driver,
    });
    expect(out.kind).toBe("threw");
    expect(warnings).toContain("reactive_compact_threw");
    expect(state.hasAttemptedReactiveCompact).toBe(true);
    expect(state.autoCompactTracking?.consecutiveFailures).toBe(1);
  });

  test("success: commits compacted history for the retry path + sets transition", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState();
    state.autoCompactTracking = {
      compacted: true,
      turnId: "turn-1",
      turnCounter: 2,
      consecutiveFailures: 1,
    };
    state.maxOutputTokensOverride = 64_000;
    state.pendingToolUseSummary = Promise.resolve(null);
    state.stopHookActive = true;
    state.taskBudgetRemaining = 90;
    state.messagesForQuery = [
      { role: "user", content: "before-a" },
      { role: "assistant", content: "before-b" },
      { role: "user", content: "before-c" },
      { role: "assistant", content: "before-d" },
      { role: "user", content: "before-e" },
      { role: "assistant", content: "before-f" },
    ];
    const compacted = [{ role: "user" as const, content: "[summary]" }];
    const driver: ReactiveCompactDriver = {
      ...DEFAULT_REACTIVE_COMPACT_DRIVER,
      isReactiveCompactEnabled: () => true,
      async tryReactiveCompact() {
        return { compactedMessages: compacted, preCompactTokens: 50 };
      },
    };
    const out = await runReactiveCompact({
      session,
      state,
      lastMessage,
      driver,
      taskBudgetTotal: 200,
    });
    expect(out.kind).toBe("compacted");
    expect(state.transition?.reason).toBe("reactive_compact_retry");
    expect(state.messages).toEqual(compacted);
    expect(state.messagesForQuery).toEqual(compacted);
    expect(state.hasAttemptedReactiveCompact).toBe(true);
    expect(state.autoCompactTracking).toBeUndefined();
    expect(state.maxOutputTokensOverride).toBeUndefined();
    expect(state.pendingToolUseSummary).toBeUndefined();
    expect(state.stopHookActive).toBeUndefined();
    expect(state.taskBudgetRemaining).toBe(40);
  });

  test("success persists thread_rolled_back through session.emit/rollout path", async () => {
    const log = new EventLog();
    const append = vi.fn();
    const session = mkSession(log, { rolloutAppend: append });
    const state = mkState();
    state.messagesForQuery = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "a3" },
    ];
    const driver: ReactiveCompactDriver = {
      ...DEFAULT_REACTIVE_COMPACT_DRIVER,
      isReactiveCompactEnabled: () => true,
      async tryReactiveCompact() {
        return {
          compactedMessages: [
            { role: "user", content: "[summary]" },
            { role: "assistant", content: "tail" },
          ],
        };
      },
    };

    const out = await runReactiveCompact({
      session,
      state,
      lastMessage,
      driver,
    });

    expect(out.kind).toBe("compacted");
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: expect.objectContaining({
          type: "thread_rolled_back",
          payload: expect.objectContaining({ numTurns: 2 }),
        }),
      }),
    );
  });

  test("success path clears registered response ids synchronously", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState();
    state.messagesForQuery = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
      { role: "user", content: "e" },
      { role: "assistant", content: "f" },
    ];

    const tracker = new IncrementalTracker();
    tracker.recordRequest(
      { model: "grok-test", parallelToolCalls: false },
      [],
    );
    tracker.recordResponse({
      previousResponseId: "resp-reactive",
      itemsAdded: [],
      recordedAtMs: Date.now(),
    });
    const unregister = registerIncrementalTracker(tracker);
    try {
      expect(tracker.previousResponseId()).toBe("resp-reactive");

      const driver: ReactiveCompactDriver = {
        ...DEFAULT_REACTIVE_COMPACT_DRIVER,
        isReactiveCompactEnabled: () => true,
        async tryReactiveCompact() {
          return { compactedMessages: [{ role: "user", content: "[summary]" }] };
        },
      };
      const out = await runReactiveCompact({
        session,
        state,
        lastMessage,
        driver,
      });
      expect(out.kind).toBe("compacted");
      expect(tracker.previousResponseId()).toBeUndefined();
    } finally {
      unregister();
    }
  });

  test("LIVE-PATH I-2: success clears ProviderHttpClient.responsesContinuationState.lastResponseId without mocking cleanup", async () => {
    // This test deliberately does NOT mock runPostCompactCleanup and
    // does NOT mock compactConversation (the driver substitutes a
    // precomputed CompactionResult-equivalent, but the cleanup seam
    // runs the real post-compact path). It asserts the exact bug
    // described in the Worker 2 brief: that the ProviderHttpClient
    // `responsesContinuationState.lastResponseId` is cleared after
    // reactive-compact returns.
    const log = new EventLog();
    const httpClient = mkSeededHttpClient();
    expect(readLastResponseId(httpClient)).toBe("resp-seeded");

    const session = mkSession(log, { httpClient });
    const state = mkState();
    state.messagesForQuery = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
      { role: "user", content: "e" },
      { role: "assistant", content: "f" },
    ];

    const driver: ReactiveCompactDriver = {
      ...DEFAULT_REACTIVE_COMPACT_DRIVER,
      isReactiveCompactEnabled: () => true,
      async tryReactiveCompact() {
        return {
          compactedMessages: [{ role: "user", content: "[summary]" }],
          summary: "reactive compact test",
        };
      },
    };
    const contextCompactedEvents: string[] = [];
    log.subscribe((e) => {
      if (e.msg.type === "context_compacted") {
        contextCompactedEvents.push(e.msg.type);
      }
    });

    const out = await runReactiveCompact({
      session,
      state,
      lastMessage,
      driver,
    });

    expect(out.kind).toBe("compacted");
    // I-2 wire-state assertion — the real bug we're fixing.
    expect(readLastResponseId(httpClient)).toBeUndefined();
    // context_compacted reached the session-level listener too.
    expect(contextCompactedEvents).toContain("context_compacted");
  });

  test("resetHasAttemptedReactiveCompact helper", () => {
    const s = mkState();
    s.hasAttemptedReactiveCompact = true;
    resetHasAttemptedReactiveCompact(s);
    expect(s.hasAttemptedReactiveCompact).toBe(false);
  });

  test("already-attempted branch returns noop without calling driver", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState();
    state.hasAttemptedReactiveCompact = true;
    let called = false;
    const driver: ReactiveCompactDriver = {
      ...DEFAULT_REACTIVE_COMPACT_DRIVER,
      isReactiveCompactEnabled: () => true,
      async tryReactiveCompact() {
        called = true;
        return null;
      },
    };
    const out = await runReactiveCompact({
      session,
      state,
      lastMessage,
      driver,
    });
    expect(out.kind).toBe("noop");
    expect(called).toBe(false);
  });

  test("unsupported last message returns noop before invoking the driver", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState();
    let called = false;
    const driver: ReactiveCompactDriver = {
      ...DEFAULT_REACTIVE_COMPACT_DRIVER,
      async tryReactiveCompact() {
        called = true;
        return null;
      },
    };
    const out = await runReactiveCompact({
      session,
      state,
      lastMessage: {
        uuid: "a2",
        role: "assistant",
        text: "ordinary reply",
        toolCalls: [],
      },
      driver,
    });
    expect(out.kind).toBe("noop");
    if (out.kind === "noop") {
      expect(out.reason).toBe("unsupported_last_message");
    }
    expect(called).toBe(false);
  });

  test("non-shrinking driver result trips the I-18 throw guard", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState();
    state.messagesForQuery = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
      { role: "user", content: "e" },
      { role: "assistant", content: "f" },
    ];
    const driver: ReactiveCompactDriver = {
      ...DEFAULT_REACTIVE_COMPACT_DRIVER,
      async tryReactiveCompact({ hasAttempted }) {
        expect(hasAttempted).toBe(false);
        return { compactedMessages: [...state.messagesForQuery] };
      },
    };

    const out = await runReactiveCompact({
      session,
      state,
      lastMessage,
      driver,
    });

    expect(out.kind).toBe("threw");
    expect(state.hasAttemptedReactiveCompact).toBe(true);
  });

  test("uses a session-provided reactiveCompact driver when no explicit driver is passed", async () => {
    const log = new EventLog();
    const sessionDriver: ReactiveCompactDriver = {
      ...DEFAULT_REACTIVE_COMPACT_DRIVER,
      async tryReactiveCompact() {
        return { compactedMessages: [{ role: "user", content: "[session]" }] };
      },
    };
    const session = mkSession(log, {
      services: { reactiveCompact: sessionDriver },
    });
    const state = mkState();
    state.messagesForQuery = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
      { role: "user", content: "e" },
      { role: "assistant", content: "f" },
    ];

    const out = await runReactiveCompact({
      session,
      state,
      lastMessage,
    });

    expect(out.kind).toBe("compacted");
    expect(state.messagesForQuery).toEqual([
      { role: "user", content: "[session]" },
    ]);
  });
});

describe("default reactive-compact driver", () => {
  test("isReactiveCompactEnabled is true by default (gate lives in tryReactiveCompact)", () => {
    expect(DEFAULT_REACTIVE_COMPACT_DRIVER.isReactiveCompactEnabled()).toBe(
      true,
    );
  });

  test("isWithheldPromptTooLong delegates to api-errors classifier", () => {
    const ptl: AssistantMessage = {
      uuid: "p1",
      role: "assistant",
      text: "Prompt is too long",
      toolCalls: [],
    };
    const ok: AssistantMessage = {
      uuid: "p2",
      role: "assistant",
      text: "ordinary reply",
      toolCalls: [],
    };
    expect(DEFAULT_REACTIVE_COMPACT_DRIVER.isWithheldPromptTooLong(ptl)).toBe(
      true,
    );
    expect(DEFAULT_REACTIVE_COMPACT_DRIVER.isWithheldPromptTooLong(ok)).toBe(
      false,
    );
  });

  test("returns null on an empty message array without reaching compactConversation", async () => {
    // Exercises the live default driver: empty input is the guard that
    // short-circuits before the full compact pipeline runs. This is the
    // only default-driver branch we can exercise without the heavy
    // session bootstrap needed by compactConversation itself.
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState();
    const result = await DEFAULT_REACTIVE_COMPACT_DRIVER.tryReactiveCompact({
      hasAttempted: false,
      messages: [] as ReadonlyArray<LLMMessage>,
      lastMessage,
      session,
      state,
    });
    expect(result).toBeNull();
  });

  test("returns null when session cannot back a compact runtime context", async () => {
    // mkSession builds a stub without session.state / services.registry,
    // so createSessionBackedCompactContext throws. The default driver
    // swallows that and reports noop, matching the openclaude behavior
    // of "insufficient infrastructure ⇒ skip reactive compact".
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState();
    const result = await DEFAULT_REACTIVE_COMPACT_DRIVER.tryReactiveCompact({
      hasAttempted: false,
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ],
      lastMessage,
      session,
      state,
    });
    expect(result).toBeNull();
  });

  test("no longer fabricates a synthetic summary stub", () => {
    // Regression guard for the Worker 2 brief: the old driver manufactured
    // a user message with the literal text "summary of N earlier messages,
    // elided for context pressure". That string must no longer appear in
    // the compiled module's driver function body.
    const moduleText = String(
      DEFAULT_REACTIVE_COMPACT_DRIVER.tryReactiveCompact,
    );
    expect(moduleText).not.toContain("elided for context pressure");
  });
});
