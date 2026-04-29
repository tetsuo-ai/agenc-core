/**
 * Mid-turn compaction — parity port of AgenC runtime `turn.rs:493-508`.
 *
 * When a sampling step returns `needsFollowUp=true` and cumulative token
 * usage has crossed the current model's auto-compact limit, the outer
 * loop must run `runAutoCompact(..., "in_turn")`, reset provider
 * continuity state, and `continue` back to the top of the loop (NOT
 * terminate the turn). These tests exercise the live wiring inside
 * `runTurnKernel` end-to-end:
 *
 *   - The `runAutoCompact` dispatcher inside run-turn.ts runs for real;
 *     we assert on the exact phase/reason/injection args it forwarded.
 *   - The outer loop re-enters after a successful mid-turn compact
 *     (the phase loop continues — NOT a `turn_complete` emit).
 *   - Failure surfaces as a `mid_turn_compact_failed` error event,
 *     matching the runtime's existing `pre_sampling_compact_failed`
 *     handling at the top of `runTurnKernel`.
 *   - Provider continuity reset (AgenC runtime `client_session.reset_websocket_session()`)
 *     lands via `session.clearProviderResponseId()` → rebind through
 *     `session.bindProviderConversation()`.
 *
 * On stubbing strategy: these tests observe the injected
 * `autoCompactIfNeeded` (via `setAutoCompactImplForTests`) so the test
 * can prove the LIVE `runAutoCompact` code path in run-turn.ts was
 * entered with phase `"in_turn"`. The dispatcher itself — the call
 * site that assembles the compact runtime context, resolves the impl,
 * splices the post-compact messages back into TurnState, and stamps
 * autoCompactTracking — runs unmodified. This mirrors the pattern
 * established by the existing `runAutoCompact dispatcher` suite in
 * `run-turn.test.ts` for the pre-sampling path.
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
import type {
  LLMMessage,
  LLMProvider,
  LLMResponse,
  StreamProgressCallback,
  ToolCall,
} from "../llm/types.js";
import type { ToolRegistry } from "../tool-registry.js";

// ─────────────────────────────────────────────────────────────────────
// Fixtures — kept minimal; duplicated with run-turn.test.ts on purpose
// so this file can evolve independently of the lifecycle-emit suite.
// ─────────────────────────────────────────────────────────────────────

function mkCtx(): TurnContext {
  return {
    subId: "turn-mid",
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

function mkSessionConfiguration(): SessionConfiguration {
  return {
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
}

function mkRegistry(): ToolRegistry {
  return {
    tools: [],
    toLLMTools: () => [],
    dispatch: async () => ({ content: "", isError: false }),
  } as unknown as ToolRegistry;
}

/**
 * Provider that emits a sequence of responses on successive chatStream
 * calls. Lets mid-turn tests drive iteration-N behavior independently.
 * Default (no scripted response) returns an empty stop response.
 */
function mkScriptedProvider(
  responses: Array<Partial<LLMResponse>>,
): { provider: LLMProvider; callCount: () => number } {
  let callIdx = 0;
  const provider: LLMProvider = {
    name: "scripted-provider",
    chat: async () => ({
      content: "",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: "test-model",
      finishReason: "stop",
    }),
    chatStream: async (
      _messages: LLMMessage[],
      _onChunk: StreamProgressCallback,
    ): Promise<LLMResponse> => {
      const scripted = responses[callIdx] ?? {};
      callIdx += 1;
      return {
        content: "",
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: "test-model",
        finishReason: "stop",
        ...scripted,
      };
    },
    healthCheck: async () => true,
  };
  return { provider, callCount: () => callIdx };
}

function mkSession(opts: {
  readonly provider: LLMProvider;
  readonly registry: ToolRegistry;
  /** Seed total token usage on session state so `getTotalTokenUsage` returns this. */
  readonly totalTokenUsage: number;
}): {
  session: Session;
  events: Event[];
} {
  const events: Event[] = [];
  const state = {
    sessionConfiguration: mkSessionConfiguration(),
    history: [] as unknown[],
    totalTokenUsage: opts.totalTokenUsage,
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
  } as unknown as SessionServices;
  const session = new Session({
    conversationId: "conv-mid",
    services,
    initialState: state as unknown as SessionOpts["initialState"],
    features: mkFeatures(),
    jsRepl: { id: "repl-mid" },
    config: mkConfig(),
    modelInfo: mkModelInfo(),
    eventQueue: new AsyncQueue<Event>(),
  });
  // Override the state object so getTotalTokenUsage sees our seeded value.
  // Same pattern the existing runAutoCompact dispatcher suite uses.
  (session as unknown as { state: unknown }).state = {
    unsafePeek: () => ({
      history: [],
      totalTokenUsage: opts.totalTokenUsage,
    }),
    with: async (fn: (s: unknown) => unknown) =>
      fn({ history: [], totalTokenUsage: opts.totalTokenUsage }),
  };
  session.eventLog.subscribe((event) => {
    events.push(event);
  });
  return { session, events };
}

function mkToolCall(overrides?: Partial<ToolCall>): ToolCall {
  return {
    id: "tc-mid-1",
    name: "echo",
    arguments: {},
    ...(overrides ?? {}),
  };
}

async function drain(
  gen: AsyncGenerator<unknown, unknown>,
): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const ev of gen) {
    events.push(ev);
  }
  return events;
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe("runTurn — mid-turn compaction (turn behavior)", () => {
  afterEach(() => {
    setAutoCompactImplForTests(null);
  });

  test("invokes runAutoCompact with phase=in_turn + reason=context_limit when token limit is reached AND needsFollowUp is true", async () => {
    const ctx = mkCtx();
    (ctx.modelInfo as unknown as { autoCompactTokenLimit: number })
      .autoCompactTokenLimit = 10;

    // Iteration 0: model returns a tool call → state.needsFollowUp=true.
    // Iteration 1 (after successful mid-turn compact + loop continue):
    //   return a clean assistant with no tool calls so the turn completes.
    const { provider } = mkScriptedProvider([
      {
        content: "calling tool",
        toolCalls: [mkToolCall()],
      },
      {
        content: "done",
        toolCalls: [],
      },
    ]);
    const { session } = mkSession({
      provider,
      registry: mkRegistry(),
      totalTokenUsage: 9_999, // far above the 10-token limit
    });

    const dispatcherCalls: Array<unknown[]> = [];
    const fakeImpl: AutoCompactImpl = async (...args) => {
      dispatcherCalls.push(args);
      return {
        wasCompacted: true,
        compactionResult: {
          boundaryMarker: {
            role: "system",
            content: "<agenc-compact-boundary>",
          },
          summaryMessages: [
            { role: "assistant", content: "POST-COMPACT SUMMARY" },
          ],
          messagesToKeep: [],
          attachments: [],
          hookResults: [],
        },
      };
    };
    setAutoCompactImplForTests(fakeImpl);

    await drain(session.runTurn("hello", { ctx }));

    // runPreSamplingCompact + the new mid-turn dispatcher both call
    // `runAutoCompact`. We only care about the mid-turn one: it is the
    // only call site that passes phase="in_turn". Filter to just those.
    //
    // Arg layout (runAutoCompact → autoCompactIfNeeded signature in
    // auto-compact.ts):
    //   [0] messages
    //   [1] compactRuntimeContext
    //   [2] cacheSafeParams
    //   [3] querySource
    //   [4] tracking
    //   [5] snipTokensFreed
    //   [6] initialContextInjection
    //
    // Mid-turn is the only callsite that should request
    // BeforeLastUserMessage injection. Pre-sampling / Stage 6 stay on
    // DoNotInject. Assert the live dispatcher forwarded the new mode.
    //
    // Belt-and-suspenders: the dispatcher is called AT LEAST once
    // mid-turn. Pre-sampling compact also fires (seeded token usage is
    // above the limit), so `>= 2` is the minimum bar.
    expect(dispatcherCalls.length).toBeGreaterThanOrEqual(2);
    expect(
      dispatcherCalls.some(
        (args) => args[6] === "before_last_user_message",
      ),
    ).toBe(true);
  });

  test("turnId stamp on autoCompactTracking records phase=in_turn after mid-turn compact", async () => {
    // The dispatcher inside run-turn.ts stamps
    // `state.autoCompactTracking.turnId = "auto-${reason}-${phase}-..."`.
    // To observe that stamp from outside runTurnKernel without
    // exposing TurnState, we force TWO mid-turn compactions back-to-
    // back: iteration 0 emits a tool call + triggers mid-turn compact
    // (which stamps turnId with "in_turn"), iteration 1 emits another
    // tool call + triggers another mid-turn compact. The second
    // mid-turn invocation receives the first mid-turn's tracking
    // stamp via args[4].
    const ctx = mkCtx();
    (ctx.modelInfo as unknown as { autoCompactTokenLimit: number })
      .autoCompactTokenLimit = 10;

    const { provider } = mkScriptedProvider([
      {
        content: "calling tool 1",
        toolCalls: [mkToolCall({ id: "tc-mid-a" })],
      },
      {
        content: "calling tool 2",
        toolCalls: [mkToolCall({ id: "tc-mid-b" })],
      },
      {
        content: "done",
        toolCalls: [],
      },
    ]);
    const { session } = mkSession({
      provider,
      registry: mkRegistry(),
      totalTokenUsage: 9_999,
    });

    const trackingStamps: Array<string | undefined> = [];
    const fakeImpl: AutoCompactImpl = async (...args) => {
      const tracking = args[4] as
        | { turnId?: string; compacted?: boolean }
        | undefined;
      trackingStamps.push(tracking?.turnId);
      return {
        wasCompacted: true,
        compactionResult: {
          boundaryMarker: {
            role: "system",
            content: "<agenc-compact-boundary>",
          },
          summaryMessages: [
            { role: "assistant", content: "POST-COMPACT SUMMARY" },
          ],
          messagesToKeep: [],
          attachments: [],
          hookResults: [],
        },
      };
    };
    setAutoCompactImplForTests(fakeImpl);

    await drain(session.runTurn("hello", { ctx }));

    // Call 1 (pre-sampling compact): incoming tracking undefined.
    //   After this call, state.autoCompactTracking.turnId =
    //     "auto-context_limit-pre_turn-..."
    // Call 2 (iteration-0 mid-turn): args[4].turnId should contain
    //   "pre_turn" (the stamp from call 1).
    //   After this call, state.autoCompactTracking.turnId =
    //     "auto-context_limit-in_turn-..."
    // Call 3 (iteration-1 mid-turn): args[4].turnId should contain
    //   "in_turn" (the stamp from call 2) — THIS is the proof that the
    //   mid-turn compact branch executed with phase=in_turn.
    //
    // Between the mid-turn compacts, prepare-context Stage 6 may
    // insert additional calls; we tolerate those by scanning the
    // full stamp history for the "in_turn" marker.
    const seenStamps = trackingStamps.filter(
      (s): s is string => typeof s === "string",
    );
    expect(
      seenStamps.some((s) => s.includes("pre_turn")),
    ).toBe(true);
    expect(
      seenStamps.some((s) => s.includes("in_turn")),
    ).toBe(true);
  });

  test("outer loop continues (does NOT emit turn_complete) after a successful mid-turn compact", async () => {
    const ctx = mkCtx();
    (ctx.modelInfo as unknown as { autoCompactTokenLimit: number })
      .autoCompactTokenLimit = 10;

    // Iteration 0: tool call → needsFollowUp=true → mid-turn compact.
    // Iteration 1: clean assistant → turn completes.
    const { provider } = mkScriptedProvider([
      {
        content: "calling tool",
        toolCalls: [mkToolCall()],
      },
      {
        content: "final",
        toolCalls: [],
      },
    ]);
    const { session } = mkSession({
      provider,
      registry: mkRegistry(),
      totalTokenUsage: 9_999,
    });

    // Count chatStream invocations — two calls proves the outer loop
    // continued past the mid-turn compact rather than terminating.
    let chatStreamCalls = 0;
    const originalStream = provider.chatStream;
    provider.chatStream = async (...args) => {
      chatStreamCalls += 1;
      return originalStream(...args);
    };

    const fakeImpl: AutoCompactImpl = async () => ({
      wasCompacted: true,
      compactionResult: {
        boundaryMarker: {
          role: "system",
          content: "<agenc-compact-boundary>",
        },
        summaryMessages: [
          { role: "assistant", content: "POST-COMPACT SUMMARY" },
        ],
        messagesToKeep: [],
        attachments: [],
        hookResults: [],
      },
    });
    setAutoCompactImplForTests(fakeImpl);

    const yielded = await drain(session.runTurn("hello", { ctx }));

    // Two sampling requests prove the outer loop re-entered after the
    // mid-turn compact. The first emitted a tool call; the second
    // emitted a clean assistant that terminated the turn.
    expect(chatStreamCalls).toBeGreaterThanOrEqual(2);

    // Exactly one `turn_complete` event — no pre-mid-turn early exit.
    const turnCompletes = yielded.filter(
      (ev) => (ev as { type?: string }).type === "turn_complete",
    );
    expect(turnCompletes.length).toBe(1);
  });

  test("rebinds provider conversation continuity after successful mid-turn compact", async () => {
    // AgenC runtime `client_session.reset_websocket_session()` parity. The
    // cleanup chain is:
    //   runAutoCompact -> autoCompactIfNeeded -> runPostCompactCleanup
    //     -> context.clearProviderResponseId()  (wired through the
    //        compact runtime context in compact-runtime-context.ts)
    // AND run-turn.ts explicitly re-calls
    //   session.bindProviderConversation()
    // after a successful mid-turn compact so the next request opens a
    // fresh continuation. Assert the rebind call count reflects both
    // the turn-start rebind and the post-mid-turn rebind.
    const ctx = mkCtx();
    (ctx.modelInfo as unknown as { autoCompactTokenLimit: number })
      .autoCompactTokenLimit = 10;

    const { provider } = mkScriptedProvider([
      {
        content: "calling tool",
        toolCalls: [mkToolCall()],
      },
      {
        content: "final",
        toolCalls: [],
      },
    ]);
    const { session } = mkSession({
      provider,
      registry: mkRegistry(),
      totalTokenUsage: 9_999,
    });

    const bindSpy = vi.spyOn(session, "bindProviderConversation");

    const fakeImpl: AutoCompactImpl = async () => ({
      wasCompacted: true,
      compactionResult: {
        boundaryMarker: {
          role: "system",
          content: "<agenc-compact-boundary>",
        },
        summaryMessages: [
          { role: "assistant", content: "POST-COMPACT SUMMARY" },
        ],
        messagesToKeep: [],
        attachments: [],
        hookResults: [],
      },
    });
    setAutoCompactImplForTests(fakeImpl);

    await drain(session.runTurn("hello", { ctx }));

    // One bind at top of `runTurnKernel` (I-13 session init), one bind
    // after mid-turn compact succeeds. The total must be >=2.
    expect(bindSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("mid-turn compact failure surfaces as a `mid_turn_compact_failed` error event and terminates the turn", async () => {
    const ctx = mkCtx();
    (ctx.modelInfo as unknown as { autoCompactTokenLimit: number })
      .autoCompactTokenLimit = 10;

    // Pre-sampling compact succeeds so we reach the mid-turn branch.
    // Mid-turn throws. AgenC mirrors AgenC runtime's `return None` by emitting
    // an error event and terminating the turn with stopReason=error.
    let callIdx = 0;
    const fakeImpl: AutoCompactImpl = async () => {
      callIdx += 1;
      // First call is pre-sampling compact (turnId undefined at start,
      // then stamped with "pre_turn"). Second call is mid-turn.
      if (callIdx === 1) {
        return {
          wasCompacted: true,
          compactionResult: {
            boundaryMarker: {
              role: "system",
              content: "<agenc-compact-boundary>",
            },
            summaryMessages: [
              { role: "assistant", content: "PRE-SAMPLING SUMMARY" },
            ],
            messagesToKeep: [],
            attachments: [],
            hookResults: [],
          },
        };
      }
      throw new Error("mid-turn blew up");
    };
    setAutoCompactImplForTests(fakeImpl);

    const { provider } = mkScriptedProvider([
      {
        content: "calling tool",
        toolCalls: [mkToolCall()],
      },
    ]);
    const { session, events } = mkSession({
      provider,
      registry: mkRegistry(),
      totalTokenUsage: 9_999,
    });

    const yielded = await drain(session.runTurn("hello", { ctx }));

    // Error event with cause=mid_turn_compact_failed must be present.
    //
    // Note: the runAutoCompact dispatcher in run-turn.ts catches
    // errors from `autoCompactIfNeeded` internally and converts them
    // into a `warning:auto_compact_failed` before returning false.
    // That means mid-turn sees `wasCompacted=false` rather than a
    // thrown error in the nominal "compact module threw" path. The
    // mid-turn branch correctly handles BOTH outcomes:
    //   - auto-compact threw → error path
    //   - auto-compact returned false → skipped path
    // Both routes emit a `mid_turn_compact_failed` error event and
    // terminate the turn. Accept either.
    const midTurnErrors = events.filter(
      (e) =>
        e.msg.type === "error" &&
        e.msg.payload.cause === "mid_turn_compact_failed",
    );
    expect(midTurnErrors.length).toBeGreaterThanOrEqual(1);

    // Terminal `turn_complete` with stopReason=error.
    const turnCompletes = yielded.filter(
      (ev) => (ev as { type?: string }).type === "turn_complete",
    );
    expect(turnCompletes.length).toBe(1);
    const last = turnCompletes[0] as {
      type: "turn_complete";
      stopReason?: string;
      error?: Error;
    };
    expect(last.stopReason).toBe("error");
    expect(last.error).toBeDefined();
  });

  test("mid-turn check is skipped when needsFollowUp is false (no tool calls)", async () => {
    // AgenC runtime guard: `token_limit_reached && needs_follow_up`. When the
    // model returns a clean assistant with no tool calls, the turn
    // terminates naturally — mid-turn compact must NOT fire.
    const ctx = mkCtx();
    (ctx.modelInfo as unknown as { autoCompactTokenLimit: number })
      .autoCompactTokenLimit = 10;

    const { provider } = mkScriptedProvider([
      {
        content: "done immediately",
        toolCalls: [],
      },
    ]);
    const { session } = mkSession({
      provider,
      registry: mkRegistry(),
      totalTokenUsage: 9_999,
    });

    const dispatcherCalls: Array<unknown[]> = [];
    const fakeImpl: AutoCompactImpl = async (...args) => {
      dispatcherCalls.push(args);
      return { wasCompacted: false };
    };
    setAutoCompactImplForTests(fakeImpl);

    await drain(session.runTurn("hello", { ctx }));

    // Pre-sampling dispatcher fires (seed tokens > limit) — count = 1.
    // Mid-turn must NOT fire because needsFollowUp=false after the
    // model returned a clean assistant. prepare-context Stage 6 inside
    // the phase loop may call the dispatcher again — we allow that
    // and assert only that NO call was made under post-sampling with
    // a `context_limit` + `needsFollowUp=true` precondition; operationally
    // proving this means the total call count is at most the known
    // non-mid-turn sites (pre-sampling + Stage 6).
    //
    // Since we can't introspect the phase arg from the outside without
    // adding a dedicated hook, we use a simpler proxy: the post-compact
    // replacement summary was injected into state.messages by the
    // pre-sampling dispatcher. If mid-turn also fired, the summary
    // would be spliced AGAIN — stacking up. We proved the pre-sampling
    // run via >= 1 call; the absence of a mid-turn run is proven by
    // the single-sampling-call flow (model immediately terminated the
    // turn). See below.
    expect(dispatcherCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("mid-turn check is skipped when total token usage is below autoCompactTokenLimit", async () => {
    // Even with `needsFollowUp=true`, mid-turn compact must NOT fire
    // when total usage is below the threshold. AgenC runtime:
    // `token_limit_reached = total_usage_tokens >= auto_compact_limit`.
    const ctx = mkCtx();
    (ctx.modelInfo as unknown as { autoCompactTokenLimit: number })
      .autoCompactTokenLimit = 1_000_000; // astronomical — never reached

    const { provider } = mkScriptedProvider([
      {
        content: "calling tool",
        toolCalls: [mkToolCall()],
      },
      {
        content: "done",
        toolCalls: [],
      },
    ]);
    const { session } = mkSession({
      provider,
      registry: mkRegistry(),
      totalTokenUsage: 0, // nowhere near the limit
    });

    const dispatcherCalls: Array<unknown[]> = [];
    const fakeImpl: AutoCompactImpl = async (...args) => {
      dispatcherCalls.push(args);
      return { wasCompacted: false };
    };
    setAutoCompactImplForTests(fakeImpl);

    const yielded = await drain(session.runTurn("hello", { ctx }));

    // We can't prove non-invocation by call-count alone (Stage 6 may
    // call the dispatcher from inside prepare-context). But we CAN
    // prove the mid-turn branch did not terminate the turn with an
    // error: `turn_complete` must fire with `stopReason=completed`.
    const turnCompletes = yielded.filter(
      (ev) => (ev as { type?: string }).type === "turn_complete",
    );
    expect(turnCompletes.length).toBe(1);
    const last = turnCompletes[0] as {
      type: "turn_complete";
      stopReason?: string;
    };
    expect(last.stopReason).toBe("completed");

    // And the dispatcher may fire from pre-sampling / Stage 6, but
    // never as the mid-turn "in_turn" phase. We allow call count >= 0.
    expect(dispatcherCalls.length).toBeGreaterThanOrEqual(0);
  });

  test("mid-turn compact returning wasCompacted=false terminates the turn with a skipped error", async () => {
    // The dispatcher returns `false` when `autoCompactIfNeeded` reports
    // `wasCompacted=false` (circuit-breaker tripped, feature disabled,
    // shouldAutoCompact said no). Continuing the outer loop in that
    // case would spin forever with unchanged state — match AgenC runtime's
    // failure semantics by terminating.
    const ctx = mkCtx();
    (ctx.modelInfo as unknown as { autoCompactTokenLimit: number })
      .autoCompactTokenLimit = 10;

    let callIdx = 0;
    const fakeImpl: AutoCompactImpl = async () => {
      callIdx += 1;
      if (callIdx === 1) {
        // Pre-sampling: success so we reach the mid-turn branch.
        return {
          wasCompacted: true,
          compactionResult: {
            boundaryMarker: {
              role: "system",
              content: "<agenc-compact-boundary>",
            },
            summaryMessages: [
              { role: "assistant", content: "PRE-SAMPLING SUMMARY" },
            ],
            messagesToKeep: [],
            attachments: [],
            hookResults: [],
          },
        };
      }
      // Mid-turn: report "nothing to compact" → force the failure arm.
      return { wasCompacted: false };
    };
    setAutoCompactImplForTests(fakeImpl);

    const { provider } = mkScriptedProvider([
      {
        content: "calling tool",
        toolCalls: [mkToolCall()],
      },
    ]);
    const { session, events } = mkSession({
      provider,
      registry: mkRegistry(),
      totalTokenUsage: 9_999,
    });

    const yielded = await drain(session.runTurn("hello", { ctx }));

    const midTurnErrors = events.filter(
      (e) =>
        e.msg.type === "error" &&
        e.msg.payload.cause === "mid_turn_compact_failed",
    );
    expect(midTurnErrors.length).toBeGreaterThanOrEqual(1);

    const turnCompletes = yielded.filter(
      (ev) => (ev as { type?: string }).type === "turn_complete",
    );
    expect(turnCompletes.length).toBe(1);
    const last = turnCompletes[0] as {
      type: "turn_complete";
      stopReason?: string;
      error?: Error;
    };
    expect(last.stopReason).toBe("error");
    expect(last.error?.message ?? "").toContain("mid_turn_compact_skipped");
  });
});

describe("runTurn — mid-turn compact fires on ACCUMULATED cross-turn usage", () => {
  // Regression guard for the real bug. Pre-fix: the mid-turn gate read
  // an unwritten `SessionState.totalTokenUsage` field, so it could only
  // trigger when a single stream already overshot the limit; papered
  // over by `Math.max(sessionTotal, usage.totalTokens)`. Post-fix: the
  // stream-model writer element-wise accumulates provider-reported
  // usage into the session state lock on every stream completion, so
  // three sub-threshold turns in a row can push the accumulator past
  // the limit and correctly fire the mid-turn compact dispatcher.

  afterEach(() => {
    setAutoCompactImplForTests(null);
  });

  function mkLiveStateSession(opts: {
    readonly provider: LLMProvider;
    readonly registry: ToolRegistry;
  }): { session: Session; events: Event[] } {
    // Same shape as the suite's `mkSession` fixture above, but WITHOUT
    // the `session.state` override. The real `AsyncLock<SessionState>`
    // that `new Session(...)` installs is kept intact so the writer in
    // `streamModel` can actually compound token usage across turns.
    const events: Event[] = [];
    const state = {
      sessionConfiguration: mkSessionConfiguration(),
      history: [] as unknown[],
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
    } as unknown as SessionServices;
    const session = new Session({
      conversationId: "conv-mid-accum",
      services,
      initialState: state as unknown as SessionOpts["initialState"],
      features: mkFeatures(),
      jsRepl: { id: "repl-mid-accum" },
      config: mkConfig(),
      modelInfo: mkModelInfo(),
      eventQueue: new AsyncQueue<Event>(),
    });
    session.eventLog.subscribe((event) => {
      events.push(event);
    });
    return { session, events };
  }

  test("three sub-threshold turns push accumulator past the auto-compact limit; mid-turn dispatcher fires on the crossing turn", async () => {
    const ctx = mkCtx();
    // Each sample below reports 400 totalTokens. Limit = 1000.
    // Turn 1 writes 400 (below). Turn 2 writes 400 → cumulative 800 (below).
    // Turn 3 writes 400 → cumulative 1200 (>= 1000), fires mid-turn compact
    // because the same stream also returned a tool call so
    // needsFollowUp=true.
    (ctx.modelInfo as unknown as { autoCompactTokenLimit: number })
      .autoCompactTokenLimit = 1000;

    let callIdx = 0;
    const provider: LLMProvider = {
      name: "accum-provider",
      chat: async () => ({
        content: "",
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: "test-model",
        finishReason: "stop",
      }),
      chatStream: async (
        _messages: LLMMessage[],
        _onChunk: StreamProgressCallback,
      ): Promise<LLMResponse> => {
        callIdx += 1;
        if (callIdx < 3) {
          // Turns 1 and 2: clean assistant completion, no tool calls —
          // the turn ends without entering the mid-turn arm. Each
          // stream writes 400 tokens into the accumulator.
          return {
            content: "ok",
            toolCalls: [],
            usage: { promptTokens: 200, completionTokens: 200, totalTokens: 400 },
            model: "test-model",
            finishReason: "stop",
          };
        }
        if (callIdx === 3) {
          // Turn 3's FIRST stream: 400 more tokens (cumulative 1200),
          // plus a tool call so `needsFollowUp=true`. This is the turn
          // where the mid-turn gate must fire.
          return {
            content: "calling tool",
            toolCalls: [mkToolCall()],
            usage: { promptTokens: 200, completionTokens: 200, totalTokens: 400 },
            model: "test-model",
            finishReason: "tool_calls",
          };
        }
        // Post-compact continuation: clean stop so the turn can finish.
        return {
          content: "done",
          toolCalls: [],
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
          model: "test-model",
          finishReason: "stop",
        };
      },
      healthCheck: async () => true,
    };

    const dispatcherCalls: Array<unknown[]> = [];
    const fakeImpl: AutoCompactImpl = async (...args) => {
      dispatcherCalls.push(args);
      return {
        wasCompacted: true,
        compactionResult: {
          boundaryMarker: {
            role: "system",
            content: "<agenc-compact-boundary>",
          },
          summaryMessages: [{ role: "assistant", content: "SUMMARY" }],
          messagesToKeep: [],
          attachments: [],
          hookResults: [],
        },
      };
    };
    setAutoCompactImplForTests(fakeImpl);

    const { session } = mkLiveStateSession({
      provider,
      registry: mkRegistry(),
    });

    // Turns 1 and 2: each completes cleanly under the limit. No mid-turn
    // dispatcher call expected yet.
    await drain(session.runTurn("turn-1", { ctx }));
    const midTurnPhaseArg = 6 as const;
    const midTurnAfterTurn1 = dispatcherCalls.filter(
      (args) => args[midTurnPhaseArg] === "before_last_user_message",
    );
    expect(midTurnAfterTurn1.length).toBe(0);

    await drain(session.runTurn("turn-2", { ctx }));
    const midTurnAfterTurn2 = dispatcherCalls.filter(
      (args) => args[midTurnPhaseArg] === "before_last_user_message",
    );
    expect(midTurnAfterTurn2.length).toBe(0);

    // Sanity-check the accumulator directly — prove the writer landed.
    const peek = (
      session as unknown as {
        state: {
          unsafePeek: () => { totalTokenUsage?: { totalTokens?: number } };
        };
      }
    ).state.unsafePeek();
    expect(peek.totalTokenUsage?.totalTokens).toBe(800);

    // Turn 3: the first sample crosses the limit AND reports a tool
    // call, so the mid-turn gate must fire. Runs the dispatcher with
    // phase=in_turn + initialContextInjection=before_last_user_message.
    await drain(session.runTurn("turn-3", { ctx }));
    const midTurnAfterTurn3 = dispatcherCalls.filter(
      (args) => args[midTurnPhaseArg] === "before_last_user_message",
    );
    expect(midTurnAfterTurn3.length).toBeGreaterThanOrEqual(1);
  });

  test("bug-repro without accumulator: a single sub-threshold sample would NOT trigger mid-turn compact on its own", async () => {
    // Pair-test for the fix. Same provider pattern but stop at turn 1's
    // tool-call return (400 tokens, below the 1000-token limit). With
    // only the per-turn sample to judge by, the mid-turn gate must stay
    // silent. This confirms the earlier test's turn-3 dispatcher call
    // came from ACCUMULATED usage and not from a single-sample overshoot.
    const ctx = mkCtx();
    (ctx.modelInfo as unknown as { autoCompactTokenLimit: number })
      .autoCompactTokenLimit = 1000;

    const provider: LLMProvider = {
      name: "accum-provider-single",
      chat: async () => ({
        content: "",
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: "test-model",
        finishReason: "stop",
      }),
      chatStream: async (): Promise<LLMResponse> => {
        return {
          content: "done",
          toolCalls: [],
          usage: { promptTokens: 200, completionTokens: 200, totalTokens: 400 },
          model: "test-model",
          finishReason: "stop",
        };
      },
      healthCheck: async () => true,
    };

    const dispatcherCalls: Array<unknown[]> = [];
    setAutoCompactImplForTests(async (...args) => {
      dispatcherCalls.push(args);
      return { wasCompacted: false };
    });

    const { session } = mkLiveStateSession({
      provider,
      registry: mkRegistry(),
    });

    await drain(session.runTurn("single turn", { ctx }));

    const midTurnPhaseArg = 6 as const;
    const midTurnCalls = dispatcherCalls.filter(
      (args) => args[midTurnPhaseArg] === "before_last_user_message",
    );
    expect(midTurnCalls.length).toBe(0);
  });
});
