/**
 * Integration tests: guardian-rejection circuit breaker wired into the
 * turn kernel.
 *
 * Covers the two responsibilities the kernel owns on behalf of the
 * breaker (upstream agenc runtime `guardian/review.rs` + `session::run_turn`):
 *
 *   1. `clearTurn(turnId)` at the top of each new turn so a leftover
 *      interrupt flag from a previous turn sharing the same sub-id
 *      does not spuriously abort this turn.
 *   2. `isOpen(turnId)` check at the top of every phase-loop
 *      iteration. When an external detection-site (guardian review)
 *      has recorded enough denials that the breaker flipped to
 *      interrupt, the next iteration aborts cleanly with a
 *      `turn_aborted` event and a `cancelled` terminal instead of
 *      issuing another sampling request.
 *
 * The guardian reviewer owns detection and denial recording. These
 * tests drive the breaker state directly so the kernel contract stays
 * focused on turn-loop interruption rather than reviewer prompt
 * behavior.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
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
} from "../llm/types.js";
import type { ToolRegistry } from "../tool-registry.js";
import {
  GuardianRejectionCircuitBreaker,
  MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN,
  MAX_TOTAL_GUARDIAN_DENIALS_PER_TURN,
  createGuardianRejectionCircuitBreaker,
} from "../permissions/guardian/rejection-circuit-breaker.js";

// ---------------------------------------------------------------------------
// Test harness — mirrors run-turn.test.ts's session builder shape but keeps
// the breaker slot plumbable so tests can drive the detection side directly.
// ---------------------------------------------------------------------------

function mkCtx(subId = "turn-abc"): TurnContext {
  return {
    subId,
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

function mkProvider(response: Partial<LLMResponse> = {}): LLMProvider {
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
  readonly provider?: LLMProvider;
  readonly breaker?: GuardianRejectionCircuitBreaker;
}): {
  session: Session;
  events: Event[];
  breaker: GuardianRejectionCircuitBreaker;
} {
  const events: Event[] = [];
  const breaker = opts.breaker ?? createGuardianRejectionCircuitBreaker();
  const state: {
    sessionConfiguration: SessionConfiguration;
    history: unknown[];
    totalTokenUsage: number;
  } = {
    sessionConfiguration: mkSessionConfiguration(),
    history: [],
    totalTokenUsage: 0,
  };
  const services: SessionServices = {
    admissionRequired: false,
    mcpConnectionManager: {
      setApprovalPolicy: () => {},
      setSandboxPolicy: () => {},
      requiredStartupFailures: async () => [],
    },
    mcpStartupCancellationToken: {
      cancel: () => {},
      isCancelled: () => false,
    },
    provider: opts.provider ?? mkProvider({ content: "ok" }),
    registry: mkRegistry(),
    hooks: {
      executeStop: async () => ({}),
    },
    guardianRejectionCircuitBreaker: breaker,
  } as unknown as SessionServices;
  const session = new Session({
    conversationId: "conv-guardian-breaker",
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
  return { session, events, breaker };
}

async function drain(
  gen: AsyncGenerator<unknown, unknown>,
): Promise<unknown> {
  let terminal: unknown;
  while (true) {
    const next = await gen.next();
    if (next.done) {
      terminal = next.value;
      break;
    }
  }
  return terminal;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Kernel wiring tests
// ---------------------------------------------------------------------------

describe("runTurnKernel — guardian circuit breaker wiring", () => {
  test("clearTurn fires at turn start (leftover interrupt does not bleed into a fresh run)", async () => {
    // Pre-seed the breaker with a tripped state for the turn id this
    // turn will use. If the kernel did NOT call clearTurn at the top,
    // the fresh turn would immediately see isOpen=true and abort.
    const breaker = createGuardianRejectionCircuitBreaker();
    for (let i = 0; i < MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN; i += 1) {
      breaker.recordDenial("turn-abc");
    }
    expect(breaker.isOpen("turn-abc")).toBe(true);

    const { session, events } = mkSession({
      provider: mkProvider({ content: "fresh turn reply" }),
      breaker,
    });

    await drain(session.runTurn("hello", { ctx: mkCtx("turn-abc") }));

    // After clearTurn, the breaker's per-turn row is dropped, so
    // isOpen reports false again.
    expect(breaker.isOpen("turn-abc")).toBe(false);
    // The kernel completed normally — no turn_aborted event fired.
    const types = events.map((e) => e.msg.type);
    expect(types).toContain("turn_started");
    expect(types).toContain("turn_complete");
    expect(types).not.toContain("turn_aborted");
  });

  test("isOpen check at iteration boundary aborts the turn with turn_aborted(guardian_breaker_open)", async () => {
    // The kernel wipes the breaker at turn start (clearTurn), so we
    // can't pre-arm it before runTurn. Instead, arm it from INSIDE the
    // phase loop: record denials during chatStream so by the time the
    // kernel loops back for another iteration, isOpen(turnId) returns
    // true. We need the turn to loop back at least once, which means
    // the first response must request a tool call (needsFollowUp=true).
    // Upstream's detection-site call (`record_guardian_denial` in
    // `guardian/review.rs`) runs during tool-approval evaluation, which
    // in AgenC is after the model response — so the "next iteration
    // top-of-loop isOpen" check is the exact gut analog for that
    // upstream `abort_turn_if_active` handoff.
    const breaker = createGuardianRejectionCircuitBreaker();
    let chatCall = 0;
    const { session, events } = mkSession({
      provider: {
        name: "tripping-provider",
        chat: async () => ({
          content: "irrelevant",
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: "test-model",
          finishReason: "stop",
        }),
        chatStream: async (
          _msgs: LLMMessage[],
          _onChunk: StreamProgressCallback,
          _options,
        ): Promise<LLMResponse> => {
          chatCall += 1;
          // Trip the breaker on the FIRST model call (stand-in for an
          // external guardian-review verdict recorded during tool
          // approval). The kernel's next top-of-loop isOpen check must
          // observe the tripped flag and abort before chatStream runs
          // a second time.
          for (let i = 0; i < MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN; i += 1) {
            breaker.recordDenial("turn-abc");
          }
          // Return a response with a tool call to force the kernel to
          // loop back (needsFollowUp=true). We return a reference to a
          // tool the registry does not have, so dispatch surfaces a
          // synthetic "no such tool" result — the tool failure itself
          // is not what's under test; we just need the loop to
          // continue so the top-of-loop isOpen check fires.
          return {
            content: "",
            toolCalls: [
              {
                id: "call-1",
                name: "unknown.tool",
                arguments: "{}",
              },
            ],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: "test-model",
            finishReason: "tool_calls",
          };
        },
        healthCheck: async () => true,
      },
      breaker,
    });

    await drain(session.runTurn("hello", { ctx: mkCtx("turn-abc") }));

    // chatStream must have fired exactly once: the breaker tripped
    // during the first call, and the kernel's next-iteration isOpen
    // check aborted BEFORE a second model call could be issued.
    expect(chatCall).toBe(1);

    // The breaker's interrupt flag is one-shot per turn and stays
    // sticky until clearTurn — this turn ended without a subsequent
    // clearTurn, so isOpen must still report true.
    expect(breaker.isOpen("turn-abc")).toBe(true);

    // The kernel must have observed isOpen and emitted turn_aborted
    // with the documented reason string. Note: the kernel's other
    // cancellation branch (top-of-loop signal.aborted) also emits
    // only turn_aborted and yields a `turn_complete` PhaseEvent via
    // the generator stream; both surfaces follow the same shape so
    // rollout-reducing consumers see a closed boundary either way.
    const aborted = events.filter((e) => e.msg.type === "turn_aborted");
    expect(aborted.length).toBe(1);
    const first = aborted[0];
    if (first?.msg.type === "turn_aborted") {
      expect(first.msg.payload.reason).toBe("guardian_breaker_open");
      expect(first.msg.payload.turnId).toBe("turn-abc");
    }
  });

  test("generator yields a cancelled turn_complete PhaseEvent and returns Terminal{reason:'cancelled'}", async () => {
    // Separately verify the generator-stream contract: the kernel's
    // guardian-break-open branch yields `turn_complete` as a PhaseEvent
    // (not a session emit) with stopReason=cancelled, and the
    // generator's return value is `{reason:'cancelled'}`. This matches
    // the existing top-of-loop signal.aborted branch shape.
    const breaker = createGuardianRejectionCircuitBreaker();
    const { session } = mkSession({
      provider: {
        name: "tripping-provider-2",
        chat: async () => ({
          content: "irrelevant",
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: "test-model",
          finishReason: "stop",
        }),
        chatStream: async (): Promise<LLMResponse> => {
          for (let i = 0; i < MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN; i += 1) {
            breaker.recordDenial("turn-abc");
          }
          return {
            content: "",
            toolCalls: [
              {
                id: "call-x",
                name: "unknown.tool",
                arguments: "{}",
              },
            ],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: "test-model",
            finishReason: "tool_calls",
          };
        },
        healthCheck: async () => true,
      },
      breaker,
    });

    const phaseEvents: unknown[] = [];
    const gen = session.runTurn("hello", { ctx: mkCtx("turn-abc") });
    let terminal: unknown;
    while (true) {
      const next = await gen.next();
      if (next.done) {
        terminal = next.value;
        break;
      }
      phaseEvents.push(next.value);
    }

    expect(terminal).toEqual({ reason: "cancelled" });
    const turnCompletePhase = phaseEvents.find(
      (e): e is { type: "turn_complete"; stopReason: string } =>
        typeof e === "object" &&
        e !== null &&
        (e as { type?: string }).type === "turn_complete",
    );
    expect(turnCompletePhase).toBeDefined();
    expect(turnCompletePhase?.stopReason).toBe("cancelled");
  });

  test("breaker only trips when interrupt threshold is crossed (below-threshold denials do not abort the turn)", async () => {
    // Record (threshold - 1) denials during the stream. The breaker
    // stays closed, so the kernel completes the turn normally.
    const breaker = createGuardianRejectionCircuitBreaker();
    const { session, events } = mkSession({
      provider: {
        name: "sub-threshold-provider",
        chat: async () => ({
          content: "",
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: "test-model",
          finishReason: "stop",
        }),
        chatStream: async (): Promise<LLMResponse> => {
          for (let i = 0; i < MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN - 1; i += 1) {
            breaker.recordDenial("turn-abc");
          }
          return {
            content: "completed normally",
            toolCalls: [],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            model: "test-model",
            finishReason: "stop",
          };
        },
        healthCheck: async () => true,
      },
      breaker,
    });

    await drain(session.runTurn("hello", { ctx: mkCtx("turn-abc") }));

    expect(breaker.isOpen("turn-abc")).toBe(false);
    const types = events.map((e) => e.msg.type);
    expect(types).not.toContain("turn_aborted");
    expect(types).toContain("turn_complete");
  });

  test("breaker absent from services is a no-op (older bootstrap shape stays compatible)", async () => {
    // The SessionServices slot is documented as optional so existing
    // test fixtures and partial bootstrap shapes keep working. The
    // kernel must not throw when the slot is undefined.
    const events: Event[] = [];
    const state = {
      sessionConfiguration: mkSessionConfiguration(),
      history: [],
      totalTokenUsage: 0,
    };
    const services: SessionServices = {
      admissionRequired: false,
      mcpConnectionManager: {
        setApprovalPolicy: () => {},
        setSandboxPolicy: () => {},
        requiredStartupFailures: async () => [],
      },
      mcpStartupCancellationToken: {
        cancel: () => {},
        isCancelled: () => false,
      },
      provider: mkProvider({ content: "no breaker" }),
      registry: mkRegistry(),
      hooks: {
        executeStop: async () => ({}),
      },
      // guardianRejectionCircuitBreaker intentionally omitted.
    } as unknown as SessionServices;
    const session = new Session({
      conversationId: "conv-no-breaker",
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

    await drain(session.runTurn("hello", { ctx: mkCtx("turn-abc") }));

    const types = events.map((e) => e.msg.type);
    expect(types).toContain("turn_complete");
    expect(types).not.toContain("turn_aborted");
  });
});

// ---------------------------------------------------------------------------
// Detection-layer scenarios (breaker-only, without kernel) — matches the
// patterns upstream agenc runtime tests exercise in agenc-rs/core/src/guardian/tests.rs
// but extended to cover the detection surface contract: interleaved
// non-denial calls, total-threshold precedence, turn-boundary clear.
// ---------------------------------------------------------------------------

describe("GuardianRejectionCircuitBreaker — detection-layer scenarios", () => {
  test("tripping on N consecutive denials in one turn and observing isOpen=true (detection-path contract)", () => {
    const breaker = new GuardianRejectionCircuitBreaker();
    const turnId = "turn-detection-consec";
    // Three consecutive denials: first two return continue, third
    // returns interrupt_turn. The interrupt flag sticks so isOpen
    // reports true from that point until clearTurn.
    expect(breaker.recordDenial(turnId).kind).toBe("continue");
    expect(breaker.recordDenial(turnId).kind).toBe("continue");
    const third = breaker.recordDenial(turnId);
    expect(third).toEqual({
      kind: "interrupt_turn",
      consecutiveDenials: MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN,
      totalDenials: MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN,
    });
    expect(breaker.isOpen(turnId)).toBe(true);
  });

  test("total threshold crosses even with non-denials interleaved (no 3-streak required)", () => {
    const breaker = new GuardianRejectionCircuitBreaker();
    const turnId = "turn-detection-total";
    // 9 deny/non-deny pairs keep consecutive at 1 (reset every pair)
    // while total climbs to 9. The 10th denial pushes total to 10,
    // crossing MAX_TOTAL_GUARDIAN_DENIALS_PER_TURN (agenc-rs `ten`).
    for (let i = 0; i < MAX_TOTAL_GUARDIAN_DENIALS_PER_TURN - 1; i += 1) {
      expect(breaker.recordDenial(turnId).kind).toBe("continue");
      breaker.recordNonDenial(turnId);
    }
    const tenth = breaker.recordDenial(turnId);
    expect(tenth).toEqual({
      kind: "interrupt_turn",
      consecutiveDenials: 1,
      totalDenials: MAX_TOTAL_GUARDIAN_DENIALS_PER_TURN,
    });
    expect(breaker.isOpen(turnId)).toBe(true);
  });

  test("clearTurn between turns arms the breaker fresh for the new turn id", () => {
    const breaker = new GuardianRejectionCircuitBreaker();

    // Trip turn A.
    for (let i = 0; i < MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN; i += 1) {
      breaker.recordDenial("turn-A");
    }
    expect(breaker.isOpen("turn-A")).toBe(true);

    // Simulate turn A finishing + turn B starting. The kernel's
    // clearTurn fires at the top of the new turn; we verify the new
    // turn B still starts fresh.
    breaker.clearTurn("turn-B");
    expect(breaker.isOpen("turn-B")).toBe(false);
    expect(breaker.recordDenial("turn-B").kind).toBe("continue");
    expect(breaker.recordDenial("turn-B").kind).toBe("continue");
    // Third denial on turn B trips it, independently of turn A.
    expect(breaker.recordDenial("turn-B").kind).toBe("interrupt_turn");
    expect(breaker.isOpen("turn-B")).toBe(true);
    // Turn A remains tripped until its own clearTurn.
    expect(breaker.isOpen("turn-A")).toBe(true);
  });

  test("interrupt is one-shot: further denials on the tripped turn keep reporting isOpen but return continue", () => {
    const breaker = new GuardianRejectionCircuitBreaker();
    const turnId = "turn-oneshot";
    breaker.recordDenial(turnId);
    breaker.recordDenial(turnId);
    const tripping = breaker.recordDenial(turnId);
    expect(tripping.kind).toBe("interrupt_turn");
    // Subsequent denials after the flag flips — upstream semantics
    // say Continue, not another InterruptTurn.
    expect(breaker.recordDenial(turnId).kind).toBe("continue");
    expect(breaker.recordDenial(turnId).kind).toBe("continue");
    // isOpen stays true.
    expect(breaker.isOpen(turnId)).toBe(true);
  });
});
