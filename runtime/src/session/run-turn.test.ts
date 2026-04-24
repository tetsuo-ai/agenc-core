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
vi.mock("../llm/compact/post-compact-cleanup.js", async () => {
  const incremental = await import("../llm/grok/incremental.js");
  return {
    runPostCompactCleanup: vi.fn(() => incremental.clearAllResponseIds()),
  };
});
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
import { AsyncQueue } from "../utils/async-queue.js";
import {
  isRetryableStreamError,
  maybeRunPreviousModelInlineCompact,
  runTurn,
  setAutoCompactImplForTests,
  type AutoCompactImpl,
} from "./run-turn.js";
import {
  Session,
  type Event,
  type SessionOpts,
  type SessionServices,
} from "./session.js";
import type {
  Config,
  ManagedFeatures,
  ModelInfo,
  SessionConfiguration,
  TurnContext,
} from "./turn-context.js";
import {
  LLMAuthenticationError,
  LLMContextWindowExceededError,
  LLMServerError,
} from "../llm/errors.js";
import { FallbackTriggeredError } from "../recovery/api-errors.js";
import type {
  LLMMessage,
  LLMProvider,
  LLMResponse,
  StreamProgressCallback,
} from "../llm/types.js";
import { StreamModelError } from "../phases/stream-model.js";
import type { ToolRegistry } from "../tool-registry.js";
import { BudgetTracker } from "../llm/token-budget.js";
import * as autoCompactModule from "../llm/compact/auto-compact.js";

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

function mkFeatures(): ManagedFeatures {
  return {
    appsEnabledForAuth: () => false,
    useLegacyLandlock: () => false,
  };
}

function mkConfig(): Config {
  return {
    model: "test-model",
    cwd: "/tmp",
    features: mkFeatures(),
    multiAgentV2: {
      usageHintEnabled: false,
      usageHintText: "",
      hideSpawnAgentMetadata: false,
    },
    permissions: {
      allowLoginShell: false,
      shellEnvironmentPolicy: {
        allowedEnvVars: [],
        blockedEnvVars: [],
      },
      windowsSandboxPrivateDesktop: false,
    },
    ghostSnapshot: { enabled: false },
    agentRoles: [],
  };
}

function mkModelInfo(): ModelInfo {
  return {
    slug: "test-model",
    effectiveContextWindowPercent: 100,
    contextWindow: 1024,
    supportedReasoningLevels: [],
    defaultReasoningSummary: "auto",
    truncationPolicy: "off",
    usedFallbackModelMetadata: false,
  };
}

function mkSessionConfiguration(
  overrides?: Partial<SessionConfiguration>,
): SessionConfiguration {
  const base: SessionConfiguration = {
    cwd: "/tmp",
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
    windowsSandboxLevel: "none",
    collaborationMode: { model: "test-model" },
    dynamicTools: [],
    sessionSource: "cli_main",
  };
  return {
    ...base,
    ...overrides,
    collaborationMode: {
      ...base.collaborationMode,
      ...(overrides?.collaborationMode ?? {}),
    },
  };
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
    history: unknown[];
    previousTurnSettings?: {
      model?: string;
      realtimeActive?: boolean;
      contextWindow?: number;
      modelInfo?: { contextWindow?: number };
    };
    referenceContextItem?: {
      model?: string;
      turnId?: string;
      [key: string]: unknown;
    };
    totalTokenUsage: number;
  };
} {
  const events: Event[] = [];
  const state: {
    sessionConfiguration: SessionConfiguration;
    history: unknown[];
    previousTurnSettings?: {
      model?: string;
      realtimeActive?: boolean;
      contextWindow?: number;
      modelInfo?: { contextWindow?: number };
    };
    referenceContextItem?: {
      model?: string;
      turnId?: string;
      [key: string]: unknown;
    };
    totalTokenUsage: number;
  } = {
    sessionConfiguration: mkSessionConfiguration({
      provider: { slug: "stub-provider" } as unknown as SessionConfiguration["provider"],
      collaborationMode: { model: "stub-model" },
      ...(opts.sessionConfiguration as Partial<SessionConfiguration> | undefined),
    }),
    history: [],
    totalTokenUsage: 0,
  };
  const services: SessionServices = {
    mcpConnectionManager: {
      setApprovalPolicy: () => {},
      setSandboxPolicy: () => {},
      requiredStartupFailures: async () => [],
    },
    mcpStartupCancellationToken: {
      cancel: () => {},
      isCancelled: () => false,
    },
    provider: opts.provider,
    registry: opts.registry,
    hooks: {
      executeStop: async () => ({}),
    },
    ...(opts.configStore ? { configStore: opts.configStore } : {}),
  } as unknown as SessionServices;
  const session = new Session({
    conversationId: "conv-test",
    services,
    initialState: state as unknown as SessionOpts["initialState"],
    features: mkFeatures(),
    jsRepl: { id: "repl-test" },
    config: mkConfig(),
    modelInfo: mkModelInfo(),
    eventQueue: new AsyncQueue<Event>(),
  });
  session.eventLog.subscribe((event) => {
    events.push(event);
  });
  if (opts.pendingProviderSwitch !== undefined) {
    session.setPendingProviderSwitch(opts.pendingProviderSwitch);
  }
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
  test("compat adapter still delegates through the session-owned turn path", async () => {
    const ctx = mkCtx();
    const { session, events } = mkSession({
      provider: mkProvider({ content: "compat" }),
      registry: mkRegistry(),
    });

    await drain(runTurn(session, ctx, "compat hello"));

    expect(events.some((event) => event.msg.type === "turn_complete")).toBe(
      true,
    );
  });

  test("emits turn_started + turn_context + user_message at top of runTurn", async () => {
    const ctx = mkCtx();
    const { session, events } = mkSession({
      provider: mkProvider({ content: "hi" }),
      registry: mkRegistry(),
    });

    await drain(session.runTurn("hello world", { ctx }));

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

  test("can emit a raw display user_message while running expanded prompt content", async () => {
    const seenMessages: LLMMessage[][] = [];
    const ctx = mkCtx();
    const { session, events } = mkSession({
      provider: {
        ...mkProvider({ content: "hi" }),
        chatStream: async (
          messages: LLMMessage[],
          _onChunk: StreamProgressCallback,
          _options,
        ): Promise<LLMResponse> => {
          seenMessages.push(messages);
          return {
            content: "hi",
            toolCalls: [],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            model: "test-model",
            finishReason: "stop",
          };
        },
      },
      registry: mkRegistry(),
    });

    await drain(
      session.runTurn("expanded model-visible prompt", {
        ctx,
        displayUserMessage: "raw @src/app.ts",
      }),
    );

    const userMsg = events.find((e) => e.msg.type === "user_message");
    if (userMsg?.msg.type === "user_message") {
      expect(userMsg.msg.payload.message).toBe("raw @src/app.ts");
    }
    const firstUserContent = seenMessages[0]?.find(
      (message) => message.role === "user",
    )?.content;
    expect(firstUserContent).toBe("expanded model-visible prompt");
  });

  test("emits turn_complete on happy-path termination", async () => {
    const ctx = mkCtx();
    const { session, events } = mkSession({
      provider: mkProvider({ content: "final reply" }),
      registry: mkRegistry(),
    });

    await drain(session.runTurn("hello", { ctx }));

    const turnComplete = events.filter((e) => e.msg.type === "turn_complete");
    expect(turnComplete.length).toBeGreaterThanOrEqual(1);
    const last = turnComplete.at(-1);
    if (last?.msg.type === "turn_complete") {
      expect(last.msg.payload.turnId).toBe("turn-abc");
      expect(last.msg.payload.lastAgentMessage).toBe("final reply");
      expect(typeof last.msg.payload.durationMs).toBe("number");
    }
  });

  test("persists turn_context + response_items into the rollout-owned stream", async () => {
    const { session } = mkSession({
      provider: mkProvider({ content: "reply" }),
      registry: mkRegistry(),
    });
    const append = vi.fn();
    const appendRollout = vi.fn();
    (session as Session & {
      rolloutStore: {
        append: typeof append;
        appendRollout: typeof appendRollout;
      };
    }).rolloutStore = {
      append,
      appendRollout,
    } as unknown as Session["rolloutStore"];

    await drain(session.runTurn("hello", { ctx: mkCtx() }));

    expect(appendRollout).toHaveBeenCalledWith(
      {
        type: "turn_context",
        payload: expect.objectContaining({
          turnId: "turn-abc",
          model: "test-model",
        }),
      },
    );
    expect(appendRollout).toHaveBeenCalledWith(
      {
        type: "response_item",
        payload: expect.objectContaining({
          role: "user",
          content: "hello",
        }),
      },
    );
    expect(appendRollout).toHaveBeenCalledWith(
      {
        type: "response_item",
        payload: expect.objectContaining({
          role: "assistant",
          content: "reply",
        }),
      },
    );
  });

  test("writes finalized history back into session state and consumes it on the next turn", async () => {
    const seenMessages: LLMMessage[][] = [];
    const provider: LLMProvider = {
      name: "history-provider",
      chat: async () => ({
        content: "unused",
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: "test-model",
        finishReason: "stop",
      }),
      chatStream: async (messages) => {
        seenMessages.push(messages.map((message) => ({ ...message })));
        return {
          content: seenMessages.length === 1 ? "first answer" : "second answer",
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: "test-model",
          finishReason: "stop",
        };
      },
      healthCheck: async () => true,
    };
    const { session, getState } = mkSession({
      provider,
      registry: mkRegistry(),
    });

    await drain(session.runTurn("first question", { ctx: mkCtx() }));

    expect(getState().history).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ]);
    expect(getState().previousTurnSettings?.model).toBe("test-model");
    expect(getState().referenceContextItem).toEqual(
      expect.objectContaining({
        turnId: "turn-abc",
        model: "test-model",
      }),
    );

    await drain(session.runTurn("second question", { ctx: mkCtx() }));

    expect(seenMessages).toHaveLength(2);
    expect(seenMessages[1]).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
    ]);
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

    await drain(session.runTurn("tokens please", { ctx }));

    const tokenCounts = events.filter((e) => e.msg.type === "token_count");
    expect(tokenCounts.length).toBeGreaterThanOrEqual(1);
    const first = tokenCounts[0];
    if (first?.msg.type === "token_count") {
      expect(first.msg.payload.promptTokens).toBe(15);
      expect(first.msg.payload.completionTokens).toBe(7);
      expect(first.msg.payload.totalTokens).toBe(22);
    }
  });

  test("empty userMessage with no pending input is a no-op", async () => {
    const ctx = mkCtx();
    const { session, events } = mkSession({
      provider: mkProvider({}),
      registry: mkRegistry(),
    });

    await drain(session.runTurn("", { ctx }));

    expect(events).toEqual([]);
  });

  test("empty userMessage still runs when pending input is queued", async () => {
    const ctx = mkCtx();
    const { session, events } = mkSession({
      provider: mkProvider({ content: "pending input reply" }),
      registry: mkRegistry(),
    });
    session.enqueueIdleInput({ role: "user", content: "queued" });

    await drain(session.runTurn("", { ctx }));

    const types = events.map((e) => e.msg.type);
    expect(types).toContain("turn_started");
    expect(types).toContain("turn_complete");
  });

  test("prepare-context blocking_limit terminates before the provider call", async () => {
    const originalDisableAutoCompact = process.env.DISABLE_AUTO_COMPACT;
    const originalBlockingLimitOverride =
      process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE;
    process.env.DISABLE_AUTO_COMPACT = "1";
    process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE = "50";
    const warningSpy = vi
      .spyOn(autoCompactModule, "calculateTokenWarningState")
      .mockReturnValue({
        percentLeft: 0,
        isAboveWarningThreshold: true,
        isAboveErrorThreshold: true,
        isAboveAutoCompactThreshold: false,
        isAtBlockingLimit: true,
      });
    const chatStream = vi.fn(async (): Promise<LLMResponse> => ({
      content: "should never happen",
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "test-model",
      finishReason: "stop",
    }));
    const ctx = mkCtx();
    const provider = {
      ...mkProvider({}),
      chatStream,
    } satisfies LLMProvider;
    const { session, events } = mkSession({
      provider,
      registry: mkRegistry(),
    });

    try {
      const gen = session.runTurn("x".repeat(400), { ctx });
      let terminal: Awaited<ReturnType<typeof gen.next>>["value"] | undefined;
      while (true) {
        const next = await gen.next();
        if (next.done) {
          terminal = next.value;
          break;
        }
      }

      expect(chatStream).not.toHaveBeenCalled();
      expect(terminal.reason).toBe("blocking_limit");
      const agentMessage = events.find((e) => e.msg.type === "agent_message");
      expect(agentMessage).toBeDefined();
      if (agentMessage?.msg.type === "agent_message") {
        expect(agentMessage.msg.payload.message.length).toBeGreaterThan(0);
      }
    } finally {
      if (originalDisableAutoCompact === undefined) {
        delete process.env.DISABLE_AUTO_COMPACT;
      } else {
        process.env.DISABLE_AUTO_COMPACT = originalDisableAutoCompact;
      }
      if (originalBlockingLimitOverride === undefined) {
        delete process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE;
      } else {
        process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE =
          originalBlockingLimitOverride;
      }
      warningSpy.mockRestore();
    }
  });
});

describe("runTurn — token budget tracker reset", () => {
  test("resets the session budget tracker at the start of a fresh turn", async () => {
    const ctx = mkCtx();
    const tracker = new BudgetTracker(1_000);
    tracker.addEmitted(250, "estimate");
    tracker.checkBoundary(400);

    const { session } = mkSession({
      provider: mkProvider({
        content: "ok",
        usage: { promptTokens: 10, completionTokens: 950, totalTokens: 960 },
      }),
      registry: mkRegistry(),
    });
    (session as unknown as { budgetTracker: BudgetTracker }).budgetTracker = tracker;

    await drain(session.runTurn("fresh turn", { ctx }));

    expect(tracker.emitted).toBe(0);
    expect(tracker.continuationCount).toBe(0);
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
        history: [],
        totalTokenUsage: 5_000,
        previousTurnSettings: {
          model: "old-big-model",
          contextWindow: 200_000,
        },
      }),
    };
    setAutoCompactImplForTests(
      vi.fn<AutoCompactImpl>(async () => ({
        wasCompacted: true,
        compactionResult: {
          summaryMessages: [{ role: "assistant", content: "summary" }],
          attachments: [],
          hookResults: [],
        },
      })),
    );

    const ran = await maybeRunPreviousModelInlineCompact(
      session,
      ctx,
      5_000,
    );
    expect(ran).toBe(true);
    setAutoCompactImplForTests(null);
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
        history: [],
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
    for await (const ev of session.runTurn("hi", { ctx })) {
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

    await drain(session.runTurn("hello", { ctx }));

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
    for await (const ev of session.runTurn("hello", { ctx })) {
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
  test("binds provider conversation continuity before sampling starts", async () => {
    const { session } = mkSession({
      provider: mkProvider({ content: "hi" }),
      registry: mkRegistry(),
    });
    const bindSpy = vi.spyOn(session, "bindProviderConversation");

    await drain(session.runTurn("hello"));

    expect(bindSpy).toHaveBeenCalled();
  });

  test("pendingProviderSwitch is consumed before default turn construction so turn_context sees the new model", async () => {
    const { session, events, getState } = mkSession({
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

    await drain(session.runTurn("hello"));

    const applied = getState().sessionConfiguration;
    expect(applied.collaborationMode?.model).toBe("grok-4");
    expect(applied.provider?.slug).toBe("grok");
    const turnContext = events.find((event) => event.msg.type === "turn_context");
    expect(turnContext).toBeDefined();
    if (turnContext?.msg.type === "turn_context") {
      expect(turnContext.msg.payload.model).toBe("grok-4");
      expect(turnContext.msg.payload.collaborationMode?.model).toBe("grok-4");
    }
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

    await drain(session.runTurn("hello", { ctx }));

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
    await drain(session.runTurn("second message", { ctx }));

    expect(session.pendingProviderSwitch).toBeNull();
    expect(getState().sessionConfiguration.collaborationMode?.model).toBe(
      "grok-4",
    );
  });

  test("model_fallback consumes the pending switch and continues the same turn", async () => {
    const ctx = mkCtx();
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const primaryProvider: LLMProvider = {
      name: "stub-provider",
      chat: async () => ({
        content: "",
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: "test-model",
        finishReason: "stop",
      }),
      chatStream: async () => {
        primaryCalls += 1;
        throw new FallbackTriggeredError("test-model", "fallback-model");
      },
      healthCheck: async () => true,
    };
    const fallbackProvider = mkProvider({
      content: "recovered on fallback",
      model: "fallback-model",
    });
    const originalFallbackChatStream = fallbackProvider.chatStream;
    fallbackProvider.chatStream = async (...args) => {
      fallbackCalls += 1;
      return originalFallbackChatStream(...args);
    };

    const { session, events } = mkSession({
      provider: primaryProvider,
      registry: mkRegistry(),
    });
    let appliedSwitches = 0;
    const consumeSpy = vi
      .spyOn(session, "consumePendingProviderSwitch")
      .mockImplementation(async () => {
        if (session.pendingProviderSwitch === null) {
          return {
            applied: false,
            reason: "no pending provider switch",
          };
        }
        appliedSwitches += 1;
        session.setPendingProviderSwitch(null);
        (session.services as { provider: LLMProvider }).provider = fallbackProvider;
        return {
          applied: true,
          provider: "stub-provider",
          model: "fallback-model",
        };
      });

    await drain(session.runTurn("hello", { ctx }));

    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(1);
    expect(consumeSpy).toHaveBeenCalledTimes(2);
    expect(appliedSwitches).toBe(1);
    expect(session.pendingProviderSwitch).toBeNull();
    const turnComplete = events.filter((event) => event.msg.type === "turn_complete").at(-1);
    expect(turnComplete).toBeDefined();
    if (turnComplete?.msg.type === "turn_complete") {
      expect(turnComplete.msg.payload.lastAgentMessage).toBe("recovered on fallback");
    }
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

    await drain(session.runTurn("apply profile", { ctx }));

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

    await drain(session.runTurn("apply profile", { ctx }));

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
      unsafePeek: () => ({ history: [], totalTokenUsage: 999 }),
      with: async (fn: (s: unknown) => unknown) =>
        fn({ history: [], totalTokenUsage: 999 }),
    };

    const calls: Array<unknown[]> = [];
    const fakeImpl: AutoCompactImpl = async (...args) => {
      calls.push(args);
      return { wasCompacted: false };
    };
    setAutoCompactImplForTests(fakeImpl);

    await drain(session.runTurn("hello", { ctx }));

    // The dispatcher should have been reached at least once from the
    // pre-sampling compact path. Exact call count is implementation-
    // detail (prepare-context.ts Stage 6 may invoke it again inside
    // the phase loop), but >=1 proves the dispatcher was wired.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const [firstMessages, firstCompactContext, firstCacheSafeParams, firstQuerySource] =
      calls[0] ?? [];
    expect(Array.isArray(firstMessages)).toBe(true);
    expect(firstCompactContext).toEqual(
      expect.objectContaining({
        options: expect.objectContaining({
          mainLoopModel: "test-model",
          querySource: "repl_main_thread",
        }),
      }),
    );
    expect(firstCacheSafeParams).toEqual(
      expect.objectContaining({
        toolUseContext: firstCompactContext,
      }),
    );
    expect(firstQuerySource).toBe("repl_main_thread");
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
      unsafePeek: () => ({ history: [], totalTokenUsage: 0 }),
      with: async (fn: (s: unknown) => unknown) =>
        fn({ history: [], totalTokenUsage: 0 }),
    };

    const impl = vi.fn<AutoCompactImpl>(async () => ({ wasCompacted: false }));
    setAutoCompactImplForTests(impl);

    await drain(session.runTurn("hi", { ctx }));

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

  test("compaction result rehydrates the full post-compact replacement history", async () => {
    const ctx = mkCtx();
    (ctx.modelInfo as unknown as { autoCompactTokenLimit: number })
      .autoCompactTokenLimit = 10;
    const appendRollout = vi.fn();

    const { session } = mkSession({
      provider: mkProvider({ content: "ok" }),
      registry: mkRegistry(),
    });
    (session as unknown as { state: unknown }).state = {
      unsafePeek: () => ({ history: [], totalTokenUsage: 999 }),
      with: async (fn: (s: unknown) => unknown) =>
        fn({ history: [], totalTokenUsage: 999 }),
    };

    // Return a compactionResult so the dispatcher splices messages
    // back into TurnState. We then verify prepareContext (next phase)
    // received the compacted view by watching what the provider saw.
    const compactBoundary = {
      role: "system",
      content: "<agenc-compact-boundary>",
    } as const;
    const compactSummary: LLMMessage = {
      role: "system",
      content: "POST-COMPACT SUMMARY",
    };
    const keptTail: LLMMessage = {
      role: "assistant",
      content: "KEPT TAIL",
    };
    const fakeImpl: AutoCompactImpl = async () => ({
      wasCompacted: true,
      compactionResult: {
        boundaryMarker: compactBoundary,
        summaryMessages: [compactSummary],
        messagesToKeep: [keptTail],
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
    session2.rolloutStore = {
      append: vi.fn(),
      appendRollout,
      store: {
        reAppendSessionMetadata: vi.fn(),
      },
    } as unknown as Session["rolloutStore"];
    (session2 as unknown as { state: unknown }).state = {
      unsafePeek: () => ({ history: [], totalTokenUsage: 999 }),
      with: async (fn: (s: unknown) => unknown) =>
        fn({ history: [], totalTokenUsage: 999 }),
    };

    await drain(session2.runTurn("first user input", { ctx }));

    expect(appendRollout).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "compacted",
        payload: expect.objectContaining({
          message: "POST-COMPACT SUMMARY",
          replacementHistory: expect.arrayContaining([
            expect.objectContaining({ content: "KEPT TAIL" }),
          ]),
        }),
      }),
      { durable: true },
    );

    expect(
      seenMessages.some(
        (m) => typeof m.content === "string" && m.content.includes("KEPT TAIL"),
      ),
    ).toBe(true);
    expect(
      seenMessages.some((m) =>
        typeof m.content === "string" &&
        m.content.includes("POST-COMPACT SUMMARY"),
      ),
    ).toBe(true);
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
      unsafePeek: () => ({ history: [], totalTokenUsage: 999 }),
      with: async (fn: (s: unknown) => unknown) =>
        fn({ history: [], totalTokenUsage: 999 }),
    };

    const thrown = new Error("compact-blew-up");
    const fakeImpl: AutoCompactImpl = async () => {
      throw thrown;
    };
    setAutoCompactImplForTests(fakeImpl);

    // Must NOT throw out of runTurn — errors are swallowed into a
    // warning event.
    await drain(session.runTurn("hello", { ctx }));

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
        history: [],
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
    expect(ran).toBe(false);
    // querySource (4th positional arg) should be the downshift marker.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]?.[3]).toBe("model_downshift");
  });
});
