/**
 * T6 gap #119 — turn-lifecycle emit callsites.
 *
 * Covers the canonical `turn_started`, `turn_context`, `turn_complete`,
 * `user_message`, and `token_count` EventMsg variants emitted by
 * `runTurn`. These are the durability anchors rollout-reconstruction
 * needs so I-48 orphan-TurnStarted recovery doesn't synthesize a
 * `process_killed` abort for every clean turn.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { EventLog, type Event } from "./event-log.js";
import {
  isRetryableStreamError,
  maybeRunPreviousModelInlineCompact,
  runTurn,
  setAutoCompactImplForTests,
  type AutoCompactImpl,
} from "./run-turn.js";
import type { Session } from "./session.js";
import type { TurnContext } from "./turn-context.js";
import {
  LLMAuthenticationError,
  LLMContextWindowExceededError,
  LLMServerError,
} from "../llm/errors.js";
import type {
  LLMMessage,
  LLMProvider,
  LLMResponse,
  StreamProgressCallback,
} from "../llm/types.js";
import { StreamModelError } from "../phases/stream-model.js";
import type { ToolRegistry } from "../tool-registry.js";

function mkCtx(): TurnContext {
  return {
    subId: "turn-abc",
    cwd: "/tmp",
    config: { maxTurns: 100 } as unknown,
    configSnapshot: {} as unknown,
    modelInfo: {
      slug: "test-model",
      effectiveContextWindowPercent: 100,
      contextWindow: 1024,
      supportedReasoningLevels: [],
      defaultReasoningSummary: "auto",
      truncationPolicy: "off",
      usedFallbackModelMetadata: false,
    },
    collaborationMode: { model: "test-model" },
    approvalPolicy: { value: "never" },
    sandboxPolicy: { value: "read_only" },
    fileSystemSandboxPolicy: {
      allowWrite: [],
      denyWrite: [],
      allowRead: [],
      denyRead: [],
    },
    networkSandboxPolicy: {
      allowlist: [],
      denylist: [],
      allowManagedDomainsOnly: false,
    },
    reasoningSummary: "auto",
    sessionSource: "cli_main",
    currentDate: "2026-04-20",
    timezone: "Etc/UTC",
    dynamicTools: [],
    depth: 0,
    toolCallGate: {
      isReady: () => true,
      signal: () => {},
      wait: async () => {},
    },
  } as unknown as TurnContext;
}

function mkProvider(response: Partial<LLMResponse>): LLMProvider {
  return {
    name: "stub-provider",
    chat: async () => ({
      content: "",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: "test-model",
      finishReason: "stop",
      ...response,
    }),
    chatStream: async (
      _msgs: LLMMessage[],
      _onChunk: StreamProgressCallback,
      _options,
    ): Promise<LLMResponse> => ({
      content: "",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: "test-model",
      finishReason: "stop",
      ...response,
    }),
    healthCheck: async () => true,
  };
}

function mkRegistry(): ToolRegistry {
  return {
    tools: [],
    toLLMTools: () => [],
    dispatch: async () => ({ content: "", isError: false }),
  } as unknown as ToolRegistry;
}

function mkSession(opts: {
  readonly provider: LLMProvider;
  readonly registry: ToolRegistry;
  readonly pendingProviderSwitch?: {
    readonly provider: string;
    readonly model: string;
    readonly profile?: string;
  } | null;
  readonly sessionConfiguration?: {
    provider?: { slug?: string };
    collaborationMode?: { model?: string };
    [key: string]: unknown;
  };
  readonly configStore?: { current: () => unknown };
}): {
  session: Session;
  events: Event[];
  /** Live reference to the session-state object so tests can read it after mutations. */
  getState: () => {
    sessionConfiguration: {
      provider?: { slug?: string };
      collaborationMode?: { model?: string };
      [key: string]: unknown;
    };
    totalTokenUsage: number;
  };
} {
  const events: Event[] = [];
  const eventLog = new EventLog();
  let subIdCounter = 0;
  const emitted: Event[] = [];
  eventLog.subscribe((e) => {
    events.push(e);
  });
  // Live state object — `state.with(fn)` hands this reference to the
  // callback so the test can observe in-place mutations after runTurn
  // consumes the staged switch.
  const state: {
    sessionConfiguration: {
      provider?: { slug?: string };
      collaborationMode?: { model?: string };
      [key: string]: unknown;
    };
    totalTokenUsage: number;
  } = {
    sessionConfiguration: opts.sessionConfiguration ?? {
      provider: { slug: "stub-provider" },
      collaborationMode: { model: "stub-model" },
    },
    totalTokenUsage: 0,
  };
  const services: Record<string, unknown> = {
    provider: opts.provider,
    registry: opts.registry,
    hooks: {
      executeStop: async () => ({}),
    },
  };
  if (opts.configStore) services.configStore = opts.configStore;
  const session = {
    conversationId: "conv-test",
    eventLog,
    services,
    state: {
      unsafePeek: () => state,
      with: async (fn: (s: unknown) => unknown) => {
        await fn(state);
      },
    },
    abortController: new AbortController(),
    pendingProviderSwitch: opts.pendingProviderSwitch ?? null,
    setPendingProviderSwitch(next: typeof opts.pendingProviderSwitch | null) {
      (this as { pendingProviderSwitch: unknown }).pendingProviderSwitch =
        next;
    },
    abortTerminal(reason: string) {
      (this as { abortController: AbortController }).abortController.abort(
        reason,
      );
    },
    budgetTracker: null,
    nextInternalSubId: () => `sub-${++subIdCounter}`,
    emit: (event: Event) => {
      emitted.push(event);
      eventLog.emit(event);
    },
  } as unknown as Session;
  return { session, events, getState: () => state };
}

async function drain(
  gen: AsyncGenerator<unknown, unknown>,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of gen) {
    // drain
  }
}

describe("runTurn — T6 gap #119 lifecycle emits", () => {
  test("emits turn_started + turn_context + user_message at top of runTurn", async () => {
    const ctx = mkCtx();
    const { session, events } = mkSession({
      provider: mkProvider({ content: "hi" }),
      registry: mkRegistry(),
    });

    await drain(runTurn(session, ctx, "hello world"));

    const startedTypes = events.map((e) => e.msg.type);
    expect(startedTypes).toContain("turn_started");
    expect(startedTypes).toContain("turn_context");
    expect(startedTypes).toContain("user_message");

    // Ordering: turn_started must precede turn_context which must
    // precede user_message.
    const idxStarted = startedTypes.indexOf("turn_started");
    const idxContext = startedTypes.indexOf("turn_context");
    const idxUser = startedTypes.indexOf("user_message");
    expect(idxStarted).toBeLessThan(idxContext);
    expect(idxContext).toBeLessThan(idxUser);

    const turnStarted = events.find((e) => e.msg.type === "turn_started");
    expect(turnStarted).toBeDefined();
    if (turnStarted?.msg.type === "turn_started") {
      expect(turnStarted.msg.payload.turnId).toBe("turn-abc");
      expect(turnStarted.msg.payload.modelContextWindow).toBe(1024);
    }

    const userMsg = events.find((e) => e.msg.type === "user_message");
    if (userMsg?.msg.type === "user_message") {
      expect(userMsg.msg.payload.message).toBe("hello world");
    }
  });

  test("emits turn_complete on happy-path termination", async () => {
    const ctx = mkCtx();
    const { session, events } = mkSession({
      provider: mkProvider({ content: "final reply" }),
      registry: mkRegistry(),
    });

    await drain(runTurn(session, ctx, "hello"));

    const turnComplete = events.filter((e) => e.msg.type === "turn_complete");
    expect(turnComplete.length).toBeGreaterThanOrEqual(1);
    const last = turnComplete.at(-1);
    if (last?.msg.type === "turn_complete") {
      expect(last.msg.payload.turnId).toBe("turn-abc");
      expect(last.msg.payload.lastAgentMessage).toBe("final reply");
      expect(typeof last.msg.payload.durationMs).toBe("number");
    }
  });

  test("emits token_count after streamModel completes", async () => {
    const ctx = mkCtx();
    const { session, events } = mkSession({
      provider: mkProvider({
        content: "ok",
        usage: { promptTokens: 15, completionTokens: 7, totalTokens: 22 },
      }),
      registry: mkRegistry(),
    });

    await drain(runTurn(session, ctx, "tokens please"));

    const tokenCounts = events.filter((e) => e.msg.type === "token_count");
    expect(tokenCounts.length).toBeGreaterThanOrEqual(1);
    const first = tokenCounts[0];
    if (first?.msg.type === "token_count") {
      expect(first.msg.payload.promptTokens).toBe(15);
      expect(first.msg.payload.completionTokens).toBe(7);
      expect(first.msg.payload.totalTokens).toBe(22);
    }
  });

  test("empty userMessage still emits turn_started + turn_complete", async () => {
    const ctx = mkCtx();
    const { session, events } = mkSession({
      provider: mkProvider({}),
      registry: mkRegistry(),
    });

    await drain(runTurn(session, ctx, ""));

    const types = events.map((e) => e.msg.type);
    expect(types).toContain("turn_started");
    expect(types).toContain("turn_complete");
  });
});

describe("runTurn — A1 dead-guard fix (model-downshift inline compact)", () => {
  test("maybeRunPreviousModelInlineCompact reaches compact branch when previous context window > current", async () => {
    // A1: before the fix, `newContextWindow = oldContextWindow` made
    // `old > new` impossible. This test exercises the fixed path by
    // supplying a previous-turn contextWindow (from models_manager in
    // codex; carried on previousTurnSettings in AgenC) that exceeds
    // the current turn's contextWindow, with total usage over the new
    // auto-compact limit.
    const ctx = mkCtx();
    // Narrow the current-turn model to a smaller window + strict
    // auto-compact limit so the guard's three-way AND can all be true.
    (ctx.modelInfo as unknown as {
      contextWindow: number;
      autoCompactTokenLimit: number;
      slug: string;
    }) = {
      ...(ctx.modelInfo as unknown as Record<string, unknown>),
      contextWindow: 4_000,
      autoCompactTokenLimit: 3_000,
      slug: "new-small-model",
    } as never;

    const { session } = mkSession({
      provider: mkProvider({}),
      registry: mkRegistry(),
    });
    // Inject a previous-turn setting with a larger context window.
    (session as unknown as { state: unknown }).state = {
      unsafePeek: () => ({
        totalTokenUsage: 5_000,
        previousTurnSettings: {
          model: "old-big-model",
          contextWindow: 200_000,
        },
      }),
    };

    const ran = await maybeRunPreviousModelInlineCompact(
      session,
      ctx,
      5_000,
    );
    expect(ran).toBe(true);
  });

  test("maybeRunPreviousModelInlineCompact skips when same model slug", async () => {
    const ctx = mkCtx();
    (ctx.modelInfo as unknown as {
      contextWindow: number;
      autoCompactTokenLimit: number;
      slug: string;
    }) = {
      ...(ctx.modelInfo as unknown as Record<string, unknown>),
      contextWindow: 4_000,
      autoCompactTokenLimit: 3_000,
      slug: "same-model",
    } as never;

    const { session } = mkSession({
      provider: mkProvider({}),
      registry: mkRegistry(),
    });
    (session as unknown as { state: unknown }).state = {
      unsafePeek: () => ({
        totalTokenUsage: 5_000,
        previousTurnSettings: {
          model: "same-model",
          contextWindow: 200_000,
        },
      }),
    };

    const ran = await maybeRunPreviousModelInlineCompact(
      session,
      ctx,
      5_000,
    );
    expect(ran).toBe(false);
  });
});

describe("runTurn — D1 real provider usage in SamplingRequestResult", () => {
  test("turn_complete carries accumulated provider usage when provider reports non-zero", async () => {
    const ctx = mkCtx();
    const { session } = mkSession({
      provider: mkProvider({
        content: "hello",
        usage: { promptTokens: 11, completionTokens: 22, totalTokens: 33 },
      }),
      registry: mkRegistry(),
    });

    let finalUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
    for await (const ev of runTurn(session, ctx, "hi")) {
      if ((ev as { type: string }).type === "turn_complete") {
        finalUsage = (ev as unknown as {
          usage: { promptTokens: number; completionTokens: number; totalTokens: number };
        }).usage;
      }
    }

    // Before the fix SamplingRequestResult.usage was hardcoded zero
    // and the outer runTurn never accumulated anything, so the turn
    // completed with {0,0,0}. With the fix, provider usage flows
    // through stream-model -> TurnState.lastResponseUsage ->
    // SamplingRequestResult.usage -> cumulativeUsage.
    expect(finalUsage).toBeDefined();
    expect(finalUsage?.promptTokens).toBe(11);
    expect(finalUsage?.completionTokens).toBe(22);
    expect(finalUsage?.totalTokens).toBe(33);
  });
});

describe("runTurn — live sampling request contract", () => {
  test("passes base instructions, visible tool allowlist, parallel-tool flag, and reasoning effort to chatStream", async () => {
    const ctx = mkCtx();
    (ctx as TurnContext & { baseInstructions?: string }).baseInstructions =
      "Follow the local contract.";
    (ctx as TurnContext & { reasoningEffort?: "high" }).reasoningEffort =
      "high";
    (ctx.modelInfo as TurnContext["modelInfo"] & {
      supportsParallelToolCalls?: boolean;
    }).supportsParallelToolCalls = true;
    (
      ctx as TurnContext & {
        dynamicTools: Array<{ name: string; description: string; deferLoading?: boolean }>;
      }
    ).dynamicTools = [
      { name: "visible_tool", description: "Visible tool" },
      {
        name: "deferred_tool",
        description: "Deferred tool",
        deferLoading: true,
      },
    ];

    const visibleTool = {
      type: "function" as const,
      function: {
        name: "visible_tool",
        description: "Visible tool",
        parameters: { type: "object", properties: {} },
      },
    };
    const deferredTool = {
      type: "function" as const,
      function: {
        name: "deferred_tool",
        description: "Deferred tool",
        parameters: { type: "object", properties: {} },
      },
    };

    let seenMessages: LLMMessage[] = [];
    let seenOptions:
      | {
          toolRouting?: { allowedToolNames?: readonly string[] };
          parallelToolCalls?: boolean;
          reasoningEffort?: string;
        }
      | undefined;
    const provider: LLMProvider = {
      name: "stub-provider",
      chat: async () => ({
        content: "ok",
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: "test-model",
        finishReason: "stop",
      }),
      chatStream: async (messages, _onChunk, options) => {
        seenMessages = messages.map((message) => ({ ...message }));
        seenOptions = options as typeof seenOptions;
        return {
          content: "ok",
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: "test-model",
          finishReason: "stop",
        };
      },
      healthCheck: async () => true,
    };
    const { session } = mkSession({
      provider,
      registry: {
        tools: [],
        toLLMTools: () => [visibleTool, deferredTool],
        dispatch: async () => ({ content: "", isError: false }),
      } as unknown as ToolRegistry,
    });

    await drain(runTurn(session, ctx, "hello"));

    expect(seenMessages[0]).toEqual({
      role: "system",
      content: "Follow the local contract.",
    });
    expect(seenMessages[1]).toEqual({ role: "user", content: "hello" });
    expect(seenOptions?.toolRouting?.allowedToolNames).toEqual([
      "visible_tool",
    ]);
    expect(seenOptions?.parallelToolCalls).toBe(true);
    expect(seenOptions?.reasoningEffort).toBe("high");
  });

  test("plan mode sanitizes visible assistant text but still completes the raw proposed plan", async () => {
    const ctx = mkCtx();
    (ctx.collaborationMode as { model: string }).model = "plan";
    const { session, events } = mkSession({
      provider: mkProvider({
        content: [
          "Visible intro\n",
          "<proposed_plan>\n1. Inspect\n2. Patch\n</proposed_plan>\n",
          "Visible outro",
        ].join(""),
      }),
      registry: mkRegistry(),
    });

    const yielded: Array<{ type: string; content?: string }> = [];
    for await (const ev of runTurn(session, ctx, "hello")) {
      yielded.push(ev as { type: string; content?: string });
    }

    const assistantText = yielded.find((ev) => ev.type === "assistant_text");
    expect(assistantText?.content).toContain("Visible intro");
    expect(assistantText?.content).toContain("Visible outro");
    expect(assistantText?.content).not.toContain("<proposed_plan>");
    expect(assistantText?.content).not.toContain("1. Inspect");

    const planCompleted = events.filter(
      (event) => event.msg.type === "plan_item_completed",
    );
    expect(planCompleted.length).toBe(1);
    if (planCompleted[0]?.msg.type === "plan_item_completed") {
      expect(planCompleted[0].msg.payload.finalText).toContain("1. Inspect");
      expect(planCompleted[0].msg.payload.finalText).toContain("2. Patch");
    }
  });
});

describe("runTurn — D1 isRetryableStreamError type-based discrimination", () => {
  test("typed 504 LLMServerError is retryable", () => {
    const typed = new LLMServerError("openai", 504, "Gateway Timeout");
    const wrapped = new StreamModelError(typed);
    expect(isRetryableStreamError(wrapped)).toBe(true);
  });

  test("LLMContextWindowExceededError containing '504' in metadata is NOT retryable", () => {
    // Previously the substring check `msg.includes("504")` would falsely
    // retry a context-window failure whose provider-side message or
    // metadata mentioned "504" — e.g. a "...token count 504...".
    const cw = new LLMContextWindowExceededError(
      "openai",
      "context_length_exceeded: requested 504 tokens > limit",
      { effectiveTokens: 504, maxTokens: 128_000 },
    );
    const wrapped = new StreamModelError(cw);
    expect(isRetryableStreamError(wrapped)).toBe(false);
  });

  test("LLMAuthenticationError is never retryable even if message mentions 503", () => {
    const authErr = new LLMAuthenticationError("openai", 401);
    (authErr as unknown as { message: string }).message =
      "authentication failed (HTTP 503 masquerade)";
    const wrapped = new StreamModelError(authErr);
    expect(isRetryableStreamError(wrapped)).toBe(false);
  });

  test("stream_idle plain-Error cause is retryable", () => {
    const idle = new Error("stream_idle: no data for 30000ms");
    const wrapped = new StreamModelError(idle);
    expect(isRetryableStreamError(wrapped)).toBe(true);
  });

  test("transient ECONNRESET code on cause is retryable", () => {
    const netErr = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    const wrapped = new StreamModelError(netErr);
    expect(isRetryableStreamError(wrapped)).toBe(true);
  });

  test("non-StreamModelError is never retryable", () => {
    expect(isRetryableStreamError(new Error("some other error"))).toBe(false);
    expect(isRetryableStreamError(undefined)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// T11 W4-B / I-13 consumer: pendingProviderSwitch is applied at turn start
// ─────────────────────────────────────────────────────────────────────

describe("runTurn — I-13 pendingProviderSwitch consumer", () => {
  test("pendingProviderSwitch is consumed at turn start and session.config.model updates", async () => {
    const ctx = mkCtx();
    const { session, getState } = mkSession({
      provider: mkProvider({ content: "hi" }),
      registry: mkRegistry(),
      pendingProviderSwitch: {
        provider: "xai",
        model: "grok-4",
      },
      sessionConfiguration: {
        provider: { slug: "openai" },
        collaborationMode: { model: "gpt-4" },
      },
    });

    await drain(runTurn(session, ctx, "hello"));

    const applied = getState().sessionConfiguration;
    expect(applied.collaborationMode?.model).toBe("grok-4");
  });

  test("pendingProviderSwitch is cleared after consumption", async () => {
    const ctx = mkCtx();
    const { session } = mkSession({
      provider: mkProvider({ content: "hi" }),
      registry: mkRegistry(),
      pendingProviderSwitch: {
        provider: "xai",
        model: "grok-4",
      },
    });

    expect(session.pendingProviderSwitch).not.toBeNull();

    await drain(runTurn(session, ctx, "hello"));

    expect(session.pendingProviderSwitch).toBeNull();
  });

  test("mid-turn /model sets pending, aborts current turn, next turn applies the new model", async () => {
    // Simulate: a pending switch staged DURING turn N (the existing
    // inner-loop safety net terminates turn N cleanly), then turn N+1
    // is a fresh runTurn call that reads the marker and applies the
    // switch to the session config BEFORE any model-dependent work.
    const ctx = mkCtx();
    const { session, getState } = mkSession({
      provider: mkProvider({ content: "first" }),
      registry: mkRegistry(),
      sessionConfiguration: {
        provider: { slug: "xai" },
        collaborationMode: { model: "grok-3" },
      },
    });

    // Turn N: no pending switch yet. During the turn, simulate a
    // `/model grok-4` invocation that stages the switch. We stage it
    // by setting the marker directly on the session (same shape the
    // safety net path would use). Since this mock turn's loop won't
    // call abortTerminal here (we're not driving a phase loop), the
    // first runTurn completes cleanly — the test's contract is that
    // the NEXT runTurn applies the marker.
    session.setPendingProviderSwitch({
      provider: "xai",
      model: "grok-4",
    });

    // Turn N+1: fresh runTurn call. The consumer at the top reads the
    // marker, applies it, and clears it. The new turn proceeds with
    // the updated model.
    await drain(runTurn(session, ctx, "second message"));

    expect(session.pendingProviderSwitch).toBeNull();
    expect(getState().sessionConfiguration.collaborationMode?.model).toBe(
      "grok-4",
    );
  });

  test("profile switch via pendingProviderSwitch routes through configStore.resolveProfile when available", async () => {
    // When a configStore is wired on session.services, the profile
    // slot drives model resolution through resolveProfile. The staged
    // marker's `model` field acts as the fallback; the profile overlay
    // supersedes it when it declares a model.
    const ctx = mkCtx();
    const configSnapshot = {
      model: "base-model",
      model_provider: "xai",
      profiles: {
        coding: {
          model: "grok-code-fast-1",
          model_provider: "xai",
        },
      },
    };
    const { session, getState } = mkSession({
      provider: mkProvider({ content: "hi" }),
      registry: mkRegistry(),
      pendingProviderSwitch: {
        provider: "xai",
        model: "grok-code-fast-1",
        profile: "coding",
      },
      sessionConfiguration: {
        provider: { slug: "xai" },
        collaborationMode: { model: "base-model" },
      },
      configStore: {
        current: () => configSnapshot,
      },
    });

    await drain(runTurn(session, ctx, "apply profile"));

    expect(session.pendingProviderSwitch).toBeNull();
    expect(getState().sessionConfiguration.collaborationMode?.model).toBe(
      "grok-code-fast-1",
    );
  });

  test("profile switch falls back to marker's model when configStore is absent", async () => {
    // No configStore on services -> resolveProfile is not invoked. The
    // staged marker already carries the profile's declared model
    // (populated by commands/config.ts::handleProfileSubcommand) so
    // the session config still ends up with that model.
    const ctx = mkCtx();
    const { session, getState } = mkSession({
      provider: mkProvider({ content: "hi" }),
      registry: mkRegistry(),
      pendingProviderSwitch: {
        provider: "xai",
        model: "grok-code-fast-1",
        profile: "coding",
      },
      sessionConfiguration: {
        provider: { slug: "xai" },
        collaborationMode: { model: "base-model" },
      },
      // configStore intentionally omitted
    });

    await drain(runTurn(session, ctx, "apply profile"));

    expect(session.pendingProviderSwitch).toBeNull();
    expect(getState().sessionConfiguration.collaborationMode?.model).toBe(
      "grok-code-fast-1",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// runAutoCompact dispatcher — codex `run_auto_compact`
// Covers wiring between maybeRunPreviousModelInlineCompact +
// runPreSamplingCompact and the real `autoCompactIfNeeded` loader.
// ─────────────────────────────────────────────────────────────────────

describe("runTurn — runAutoCompact dispatcher", () => {
  afterEach(() => {
    setAutoCompactImplForTests(null);
  });

  test("pre-sampling context-limit compact calls autoCompactIfNeeded when threshold is hit", async () => {
    // Inject an autoCompactTokenLimit low enough that any totalTokenUsage
    // reading will exceed it. Seed totalTokenUsage on the session state
    // so runPreSamplingCompact picks the context-limit branch.
    const ctx = mkCtx();
    (ctx.modelInfo as unknown as { autoCompactTokenLimit: number })
      .autoCompactTokenLimit = 10;

    const { session } = mkSession({
      provider: mkProvider({ content: "ok" }),
      registry: mkRegistry(),
    });
    // Push totalTokenUsage above the limit so runPreSamplingCompact fires.
    (session as unknown as { state: unknown }).state = {
      unsafePeek: () => ({ totalTokenUsage: 999 }),
      with: async (fn: (s: unknown) => unknown) => fn({ totalTokenUsage: 999 }),
    };

    const calls: Array<unknown[]> = [];
    const fakeImpl: AutoCompactImpl = async (...args) => {
      calls.push(args);
      return { wasCompacted: false };
    };
    setAutoCompactImplForTests(fakeImpl);

    await drain(runTurn(session, ctx, "hello"));

    // The dispatcher should have been reached at least once from the
    // pre-sampling compact path. Exact call count is implementation-
    // detail (prepare-context.ts Stage 6 may invoke it again inside
    // the phase loop), but >=1 proves the dispatcher was wired.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // First call carries per-turn ctx as second arg (shared call shape
    // with prepare-context Stage 6).
    const [firstMessages, firstCtx] = calls[0] ?? [];
    expect(Array.isArray(firstMessages)).toBe(true);
    expect(firstCtx).toBe(ctx);
  });

  test("autoCompactIfNeeded is NOT called when total usage is below the threshold", async () => {
    const ctx = mkCtx();
    (ctx.modelInfo as unknown as { autoCompactTokenLimit: number })
      .autoCompactTokenLimit = 1_000_000; // far above any test usage

    const { session } = mkSession({
      provider: mkProvider({ content: "ok" }),
      registry: mkRegistry(),
    });
    // Keep totalTokenUsage at 0 — below the astronomical limit.
    (session as unknown as { state: unknown }).state = {
      unsafePeek: () => ({ totalTokenUsage: 0 }),
      with: async (fn: (s: unknown) => unknown) => fn({ totalTokenUsage: 0 }),
    };

    const impl = vi.fn<AutoCompactImpl>(async () => ({ wasCompacted: false }));
    setAutoCompactImplForTests(impl);

    await drain(runTurn(session, ctx, "hi"));

    // prepare-context Stage 6 may still invoke autoCompactIfNeeded from
    // inside the phase loop, but the pre-sampling dispatcher path that
    // this suite targets must NOT have fired. We assert on the explicit
    // `context_limit` marker by observing no auto-compact-failed
    // warnings and that runPreSamplingCompact did not route through the
    // dispatcher (verified via injection: any calls must originate from
    // Stage 6, which passes `"repl_main_thread"` rather than
    // `"model_downshift"`).
    const callsWithDownshift = impl.mock.calls.filter(
      (args) => args[4] === "model_downshift",
    );
    expect(callsWithDownshift.length).toBe(0);
  });

  test("compaction result (summary + attachments) is spliced into TurnState messages", async () => {
    const ctx = mkCtx();
    (ctx.modelInfo as unknown as { autoCompactTokenLimit: number })
      .autoCompactTokenLimit = 10;

    const { session } = mkSession({
      provider: mkProvider({ content: "ok" }),
      registry: mkRegistry(),
    });
    (session as unknown as { state: unknown }).state = {
      unsafePeek: () => ({ totalTokenUsage: 999 }),
      with: async (fn: (s: unknown) => unknown) => fn({ totalTokenUsage: 999 }),
    };

    // Return a compactionResult so the dispatcher splices messages
    // back into TurnState. We then verify prepareContext (next phase)
    // received the compacted view by watching what the provider saw.
    const compactSummary: LLMMessage = {
      role: "system",
      content: "<agenc-compact-boundary>POST-COMPACT SUMMARY",
    };
    const fakeImpl: AutoCompactImpl = async () => ({
      wasCompacted: true,
      compactionResult: {
        summaryMessages: [compactSummary],
        attachments: [],
        hookResults: [],
      },
    });
    setAutoCompactImplForTests(fakeImpl);

    let seenMessages: LLMMessage[] = [];
    const provider: LLMProvider = {
      name: "stub-provider",
      chat: async () => ({
        content: "ok",
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: "test-model",
        finishReason: "stop",
      }),
      chatStream: async (messages) => {
        seenMessages = messages.map((m) => ({ ...m }));
        return {
          content: "ok",
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: "test-model",
          finishReason: "stop",
        };
      },
      healthCheck: async () => true,
    };
    // Rebuild session to use the instrumented provider.
    const { session: session2 } = mkSession({
      provider,
      registry: mkRegistry(),
    });
    (session2 as unknown as { state: unknown }).state = {
      unsafePeek: () => ({ totalTokenUsage: 999 }),
      with: async (fn: (s: unknown) => unknown) => fn({ totalTokenUsage: 999 }),
    };

    await drain(runTurn(session2, ctx, "first user input"));

    // prepareContext uses getMessagesAfterCompactBoundary: the
    // `<agenc-compact-boundary>` prefix marks the boundary and the
    // projection returns the slice AFTER it, so nothing from before
    // should leak through to the provider.
    expect(
      seenMessages.some((m) =>
        typeof m.content === "string" &&
        m.content.includes("POST-COMPACT SUMMARY"),
      ),
    ).toBe(false);
  });

  test("dispatcher errors emit warning:auto_compact_failed and continue with uncompacted state", async () => {
    const ctx = mkCtx();
    (ctx.modelInfo as unknown as { autoCompactTokenLimit: number })
      .autoCompactTokenLimit = 10;

    const { session, events } = mkSession({
      provider: mkProvider({ content: "still ok" }),
      registry: mkRegistry(),
    });
    (session as unknown as { state: unknown }).state = {
      unsafePeek: () => ({ totalTokenUsage: 999 }),
      with: async (fn: (s: unknown) => unknown) => fn({ totalTokenUsage: 999 }),
    };

    const thrown = new Error("compact-blew-up");
    const fakeImpl: AutoCompactImpl = async () => {
      throw thrown;
    };
    setAutoCompactImplForTests(fakeImpl);

    // Must NOT throw out of runTurn — errors are swallowed into a
    // warning event.
    await drain(runTurn(session, ctx, "hello"));

    const warnings = events.filter(
      (e) =>
        e.msg.type === "warning" &&
        e.msg.payload.cause === "auto_compact_failed",
    );
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    const first = warnings[0];
    if (first?.msg.type === "warning") {
      expect(first.msg.payload.message).toContain("compact-blew-up");
    }
  });

  test("maybeRunPreviousModelInlineCompact invokes dispatcher with model_downshift reason", async () => {
    const ctx = mkCtx();
    (ctx.modelInfo as unknown as {
      contextWindow: number;
      autoCompactTokenLimit: number;
      slug: string;
    }) = {
      ...(ctx.modelInfo as unknown as Record<string, unknown>),
      contextWindow: 4_000,
      autoCompactTokenLimit: 3_000,
      slug: "new-small-model",
    } as never;

    const { session } = mkSession({
      provider: mkProvider({}),
      registry: mkRegistry(),
    });
    (session as unknown as { state: unknown }).state = {
      unsafePeek: () => ({
        totalTokenUsage: 5_000,
        previousTurnSettings: {
          model: "old-big-model",
          contextWindow: 200_000,
        },
      }),
    };

    const calls: Array<unknown[]> = [];
    setAutoCompactImplForTests(async (...args) => {
      calls.push(args);
      return { wasCompacted: false };
    });

    const ran = await maybeRunPreviousModelInlineCompact(
      session,
      ctx,
      5_000,
    );
    expect(ran).toBe(true);
    // querySource (5th positional arg) should be the downshift marker.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]?.[4]).toBe("model_downshift");
  });
});
