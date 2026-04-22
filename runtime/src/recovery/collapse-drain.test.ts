import { describe, expect, test } from "vitest";
import {
  NOOP_COLLAPSE_DRIVER,
  hasAttemptedCollapseDrain,
  resetCollapseDrainAttempted,
  runCollapseDrain,
  type CollapseDrainDriver,
} from "./collapse-drain.js";
import { EventLog } from "../session/event-log.js";
import {
  IncrementalTracker,
  registerIncrementalTracker,
} from "../llm/grok/incremental.js";
import { ProviderHttpClient } from "../llm/client.js";
import type { Session } from "../session/session.js";
import type { TurnState } from "../session/turn-state.js";
import type { LLMMessage } from "../llm/types.js";

function mkState(messages: LLMMessage[] = []): TurnState {
  return {
    messages: [],
    messagesForQuery: messages,
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

interface StubSessionOptions {
  readonly extra?: Record<string, unknown>;
  readonly httpClient?: ProviderHttpClient;
}

function mkSession(opts: StubSessionOptions = {}): Session {
  let subId = 0;
  const eventLog = new EventLog();
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
  };
  return {
    eventLog,
    nextInternalSubId: () => `sub-${++subId}`,
    emit,
    clearProviderResponseId,
    ...(opts.extra ?? {}),
  } as unknown as Session;
}

function mkSeededHttpClient(): ProviderHttpClient {
  const client = new ProviderHttpClient({
    providerName: "test",
    baseURL: "https://example.invalid",
    defaultHeaders: {},
  });
  client.bindConversationId("conv-test");
  const state = (
    client as unknown as {
      responsesContinuationState: {
        lastResponseId?: string;
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

describe("collapse-drain", () => {
  test("one-shot guard — already-drained state returns skipped_guard", async () => {
    const state = mkState();
    (
      state as TurnState & {
        collapseDrainAttempted?: boolean;
      }
    ).collapseDrainAttempted = true;
    const out = await runCollapseDrain(state, { session: mkSession() });
    expect(out.kind).toBe("skipped_guard");
  });

  test("no-op driver returns noop", async () => {
    const state = mkState();
    const out = await runCollapseDrain(state, {
      session: mkSession(),
      driver: NOOP_COLLAPSE_DRIVER,
    });
    expect(out.kind).toBe("noop");
  });

  test("drained driver mutates messagesForQuery + sets transition", async () => {
    const orig: LLMMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ];
    const collapsed: LLMMessage[] = [{ role: "user", content: "[collapsed]" }];
    const state = mkState(orig);
    const driver: CollapseDrainDriver = {
      isEnabled: () => true,
      async recoverFromOverflow() {
        return { committed: 1, messages: collapsed };
      },
    };
    const out = await runCollapseDrain(state, {
      session: mkSession(),
      driver,
    });
    expect(out.kind).toBe("drained");
    if (out.kind === "drained") expect(out.committed).toBe(1);
    expect(state.messagesForQuery).toEqual(collapsed);
    expect(state.transition?.reason).toBe("collapse_drain_retry");
  });

  test("drain attempt stays one-shot even after run-turn clears transition", async () => {
    const state = mkState([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
    const driver: CollapseDrainDriver = {
      isEnabled: () => true,
      async recoverFromOverflow() {
        return {
          committed: 1,
          messages: [{ role: "user", content: "[collapsed]" }],
        };
      },
    };

    await runCollapseDrain(state, {
      session: mkSession(),
      driver,
    });
    expect(hasAttemptedCollapseDrain(state)).toBe(true);

    state.transition = undefined;

    const next = await runCollapseDrain(state, {
      session: mkSession(),
      driver,
    });
    expect(next.kind).toBe("skipped_guard");

    resetCollapseDrainAttempted(state);
    expect(hasAttemptedCollapseDrain(state)).toBe(false);
  });

  test("default driver resolves session.services.contextCollapse and clears response ids (grok tracker)", async () => {
    const tracker = new IncrementalTracker();
    tracker.recordRequest(
      { model: "grok-test", parallelToolCalls: false },
      [],
    );
    tracker.recordResponse({
      previousResponseId: "resp-collapse",
      itemsAdded: [],
      recordedAtMs: Date.now(),
    });
    const unregister = registerIncrementalTracker(tracker);
    try {
      const state = mkState([
        { role: "user", content: "before" },
        { role: "assistant", content: "after" },
      ]);
      const session = mkSession({
        extra: {
          services: {
            querySource: "repl_main_thread",
            contextCollapse: {
              isContextCollapseEnabled: () => true,
              recoverFromOverflow(messages: ReadonlyArray<LLMMessage>) {
                expect(messages).toEqual(state.messagesForQuery);
                return {
                  committed: 2,
                  messages: [{ role: "user", content: "[collapsed]" }],
                };
              },
            },
          },
        },
      });

      const out = await runCollapseDrain(state, { session });

      expect(out.kind).toBe("drained");
      expect(state.messagesForQuery).toEqual([
        { role: "user", content: "[collapsed]" },
      ]);
      expect(tracker.previousResponseId()).toBeUndefined();
    } finally {
      unregister();
    }
  });

  test("LIVE-PATH I-2: drained path clears ProviderHttpClient.responsesContinuationState.lastResponseId without mocking cleanup", async () => {
    // Does NOT mock runPostCompactCleanup. Asserts the exact wire-state
    // bug from the Worker 2 brief: the live
    // `ProviderHttpClient.responsesContinuationState.lastResponseId`
    // must be cleared after collapse-drain commits, not just the grok
    // IncrementalTracker registry.
    const httpClient = mkSeededHttpClient();
    expect(readLastResponseId(httpClient)).toBe("resp-seeded");

    const state = mkState([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
    const session = mkSession({ httpClient });

    const contextCompactedEvents: string[] = [];
    (session as unknown as { eventLog: EventLog }).eventLog.subscribe((e) => {
      if (e.msg.type === "context_compacted") {
        contextCompactedEvents.push(e.msg.type);
      }
    });

    const driver: CollapseDrainDriver = {
      isEnabled: () => true,
      async recoverFromOverflow() {
        return {
          committed: 1,
          messages: [{ role: "user", content: "[collapsed]" }],
        };
      },
    };

    const out = await runCollapseDrain(state, { session, driver });
    expect(out.kind).toBe("drained");

    // I-2 wire-state assertion — the real bug we're fixing.
    expect(readLastResponseId(httpClient)).toBeUndefined();
    // context_compacted reached the session-level listener.
    expect(contextCompactedEvents).toContain("context_compacted");
  });

  test("no-commit drain leaves state untouched and does not emit context_compacted", async () => {
    const httpClient = mkSeededHttpClient();
    const state = mkState([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
    const session = mkSession({ httpClient });
    const events: string[] = [];
    (session as unknown as { eventLog: EventLog }).eventLog.subscribe((e) => {
      events.push(e.msg.type);
    });

    const driver: CollapseDrainDriver = {
      isEnabled: () => true,
      async recoverFromOverflow(messages) {
        return { committed: 0, messages };
      },
    };

    const out = await runCollapseDrain(state, { session, driver });
    expect(out.kind).toBe("noop");
    expect(readLastResponseId(httpClient)).toBe("resp-seeded");
    expect(events).not.toContain("context_compacted");
  });
});
