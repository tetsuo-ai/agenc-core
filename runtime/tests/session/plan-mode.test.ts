/**
 * Plan-mode streaming + reconnection wiring tests.
 *
 * Covers:
 *   - runSamplingRequest now retries via reconnectWithBackoff
 *   - runSamplingRequest uses isTransientProviderError for classification
 *   - emitStreamedAssistantTextDelta emits agent_message_delta
 *   - flushAssistantTextSegmentsAll emits full agent_message at turn end
 *   - maybeCompletePlanItemFromMessage fires plan-complete event
 *   - Plan-mode gated off: no plan-mode events when collaborationMode != plan
 *   - realtimeTextForEvent extracts displayable text
 */

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
import { createAgentRoleWorkspace } from "../agents/role.js";
import { EventLog, type Event } from "./event-log.js";
import {
  type AssistantMessageStreamParsersLike,
  createPlanModeStreamState,
  emitStreamedAssistantTextDelta,
  flushAssistantTextSegmentsAll,
  handlePlanSegments,
  isPlanMode,
  maybeCompletePlanItemFromMessage,
  realtimeTextForEvent,
} from "./plan-mode.js";
import type { Session } from "./session.js";
import type { TurnContext } from "./turn-context.js";

// ─────────────────────────────────────────────────────────────────────
// Session + ctx stubs
// ─────────────────────────────────────────────────────────────────────

const ROLE_WORKSPACE = createAgentRoleWorkspace("/tmp");

function mkSession(): { session: Session; events: Event[] } {
  const events: Event[] = [];
  const eventLog = new EventLog();
  eventLog.subscribe((e) => events.push(e));
  let subId = 0;
  const session = {
    conversationId: "conv-plan",
    roleWorkspace: ROLE_WORKSPACE,
    agentDefinitions: {
      agentRoleWorkspaceId: ROLE_WORKSPACE.id,
      activeAgents: [],
      allAgents: [],
      allowedAgentTypes: [],
    },
    eventLog,
    nextInternalSubId: () => `s-${++subId}`,
    emit: (event: Event) => {
      eventLog.emit(event);
    },
  } as unknown as Session;
  return { session, events };
}

function mkCtx(collabModel = "plan"): TurnContext {
  // The historical legacy gate consulted `collaborationMode.model === "plan"`
  // to flip plan mode. After the gate consolidation, plan mode is gated
  // exclusively on `sessionConfiguration.permissionContext.mode`. Preserve
  // the test ergonomic of `mkCtx("plan")` ⇒ plan-mode-active by routing
  // the literal "plan" through the authoritative path.
  const planModeActive = collabModel === "plan";
  return {
    subId: "turn-plan-1",
    collaborationMode: { model: collabModel },
    modelInfo: { slug: "test" },
    ...(planModeActive
      ? { sessionConfiguration: { permissionContext: { mode: "plan" } } }
      : {}),
  } as unknown as TurnContext;
}

// ─────────────────────────────────────────────────────────────────────
// isPlanMode gate
// ─────────────────────────────────────────────────────────────────────

describe("isPlanMode", () => {
  test("returns true when sessionConfiguration.permissionContext.mode === 'plan'", () => {
    const ctx = {
      subId: "t",
      collaborationMode: { model: "chat" },
      sessionConfiguration: {
        permissionContext: { mode: "plan" },
      },
    } as unknown as TurnContext;
    expect(isPlanMode(ctx)).toBe(true);
  });

  test("returns false when permissionContext.mode is anything else (or absent)", () => {
    const noCtx = {
      subId: "t",
      collaborationMode: { model: "chat" },
    } as unknown as TurnContext;
    expect(isPlanMode(noCtx)).toBe(false);

    const defaultCtx = {
      subId: "t",
      collaborationMode: { model: "chat" },
      sessionConfiguration: {
        permissionContext: { mode: "default" },
      },
    } as unknown as TurnContext;
    expect(isPlanMode(defaultCtx)).toBe(false);

    // Legacy `collaborationMode.model === "plan"` is no longer
    // consulted — the gate is permissionContext-only.
    const legacy = {
      subId: "t",
      collaborationMode: { model: "plan" },
    } as unknown as TurnContext;
    expect(isPlanMode(legacy)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// emitStreamedAssistantTextDelta
// ─────────────────────────────────────────────────────────────────────

describe("emitStreamedAssistantTextDelta", () => {
  test("emits agent_message_delta for visible text in non-plan mode", () => {
    const { session, events } = mkSession();
    const ctx = mkCtx("chat");
    emitStreamedAssistantTextDelta(session, ctx, undefined, "item-1", {
      visibleText: "hello world",
      planSegments: [],
    });
    const deltas = events.filter((e) => e.msg.type === "agent_message_delta");
    expect(deltas.length).toBe(1);
    if (deltas[0]?.msg.type === "agent_message_delta") {
      expect(deltas[0].msg.payload.delta).toBe("hello world");
    }
  });

  test("skips when parsed is empty", () => {
    const { session, events } = mkSession();
    const ctx = mkCtx("chat");
    emitStreamedAssistantTextDelta(session, ctx, undefined, "item-1", {
      visibleText: "",
      planSegments: [],
    });
    expect(events.length).toBe(0);
  });

  test("routes plan segments to plan-mode emitter when state provided", () => {
    const { session, events } = mkSession();
    const ctx = mkCtx("plan");
    const state = createPlanModeStreamState("turn-1");
    emitStreamedAssistantTextDelta(session, ctx, state, "item-1", {
      visibleText: "unused",
      planSegments: [
        { kind: "normal", delta: "Considering…" },
      ],
    });
    const deltas = events.filter((e) => e.msg.type === "agent_message_delta");
    expect(deltas.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// flushAssistantTextSegmentsAll
// ─────────────────────────────────────────────────────────────────────

function mkParsers(
  entries: ReadonlyArray<[string, { visibleText: string; planSegments: [] }]>,
): AssistantMessageStreamParsersLike {
  let drained = false;
  return {
    finishItem: () => ({ visibleText: "", planSegments: [] }),
    drainFinished: () => {
      if (drained) return [];
      drained = true;
      return entries as unknown as ReadonlyArray<
        readonly [string, { visibleText: string; planSegments: [] }]
      >;
    },
  };
}

describe("flushAssistantTextSegmentsAll", () => {
  test("emits full agent_message on turn end (non-plan mode)", () => {
    const { session, events } = mkSession();
    const ctx = mkCtx("chat");
    const parsers = mkParsers([
      ["item-a", { visibleText: "final assistant answer", planSegments: [] }],
    ]);
    flushAssistantTextSegmentsAll(session, ctx, undefined, parsers);
    const messages = events.filter((e) => e.msg.type === "agent_message");
    expect(messages.length).toBe(1);
    if (messages[0]?.msg.type === "agent_message") {
      expect(messages[0].msg.payload.message).toBe("final assistant answer");
    }
    const deltas = events.filter((e) => e.msg.type === "agent_message_delta");
    expect(deltas.length).toBe(1);
  });

  test("in plan mode, does not emit duplicate agent_message for non-plan items", () => {
    const { session, events } = mkSession();
    const ctx = mkCtx("plan");
    const state = createPlanModeStreamState("turn-1");
    const parsers = mkParsers([
      ["item-a", { visibleText: "assistant text", planSegments: [] }],
    ]);
    flushAssistantTextSegmentsAll(session, ctx, state, parsers);
    const messages = events.filter((e) => e.msg.type === "agent_message");
    expect(messages.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// maybeCompletePlanItemFromMessage
// ─────────────────────────────────────────────────────────────────────

describe("maybeCompletePlanItemFromMessage", () => {
  test("fires plan-complete event when message contains a proposed_plan block", () => {
    const { session, events } = mkSession();
    const ctx = mkCtx("plan");
    const state = createPlanModeStreamState("turn-xyz");
    // Start plan so completion flows.
    state.planItemState.started = true;

    const completed = maybeCompletePlanItemFromMessage(session, ctx, state, {
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: [
            "Here is my plan:",
            "<proposed_plan>",
            "1. Explore",
            "2. Build",
            "3. Verify",
            "</proposed_plan>",
            "ok.",
          ].join("\n"),
        },
      ],
    });

    expect(completed).toBe(true);
    expect(state.planItemState.completed).toBe(true);
    const messages = events.filter((e) => e.msg.type === "agent_message");
    expect(messages.length).toBe(1);
    if (messages[0]?.msg.type === "agent_message") {
      expect(messages[0].msg.payload.message).toMatch(/\[plan:turn-xyz-plan\]/);
      expect(messages[0].msg.payload.message).toMatch(/1\. Explore/);
    }
  });

  test("strips citations from the finalized proposed plan text", () => {
    const { session, events } = mkSession();
    const ctx = mkCtx("plan");
    const state = createPlanModeStreamState("turn-xyz");
    state.planItemState.started = true;

    const completed = maybeCompletePlanItemFromMessage(session, ctx, state, {
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: [
            "<proposed_plan>",
            "1. Explore <oai-mem-citation>doc-1</oai-mem-citation>",
            "</proposed_plan>",
          ].join("\n"),
        },
      ],
    });

    expect(completed).toBe(true);
    const planEvents = events.filter(
      (e) => e.msg.type === "plan_item_completed",
    );
    expect(planEvents.length).toBe(1);
    if (planEvents[0]?.msg.type === "plan_item_completed") {
      expect(planEvents[0].msg.payload.finalText).toBe("1. Explore \n");
    }
  });

  test("no-op when message has no proposed_plan block and no accumulated deltas", () => {
    const { session, events } = mkSession();
    const ctx = mkCtx("plan");
    const state = createPlanModeStreamState("turn-xyz");

    const completed = maybeCompletePlanItemFromMessage(session, ctx, state, {
      role: "assistant",
      content: [{ type: "output_text", text: "No plan here." }],
    });

    expect(completed).toBe(false);
    expect(state.planItemState.completed).toBe(false);
    expect(events.length).toBe(0);
  });

  test("does not complete from accumulated plan deltas when the final message lacks a proposed_plan block", () => {
    const { session, events } = mkSession();
    const ctx = mkCtx("plan");
    const state = createPlanModeStreamState("turn-xyz");
    state.planItemState.started = true;
    state.planItemState.accumulatedText = "1. Explore\n2. Build\n";

    const completed = maybeCompletePlanItemFromMessage(session, ctx, state, {
      role: "assistant",
      content: [{ type: "output_text", text: "No embedded plan block here." }],
    });

    expect(completed).toBe(false);
    expect(state.planItemState.completed).toBe(false);
    expect(events.length).toBe(0);
  });

  test("ignores non-assistant roles", () => {
    const { session, events } = mkSession();
    const ctx = mkCtx("plan");
    const state = createPlanModeStreamState("turn-xyz");

    const completed = maybeCompletePlanItemFromMessage(session, ctx, state, {
      role: "user",
      content: [{ type: "output_text", text: "<proposed_plan>\nnope\n</proposed_plan>" }],
    });

    expect(completed).toBe(false);
    expect(events.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// realtimeTextForEvent
// ─────────────────────────────────────────────────────────────────────

describe("realtimeTextForEvent", () => {
  test("returns message for agent_message", () => {
    expect(
      realtimeTextForEvent({
        type: "agent_message",
        payload: { message: "hi" },
      }),
    ).toBe("hi");
  });

  test("returns delta for agent_message_delta", () => {
    expect(
      realtimeTextForEvent({
        type: "agent_message_delta",
        payload: { delta: "chunk" },
      }),
    ).toBe("chunk");
  });

  test("returns undefined for unrelated event types", () => {
    expect(
      realtimeTextForEvent({
        type: "token_count",
        payload: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
    ).toBeUndefined();
    expect(
      realtimeTextForEvent({
        type: "warning",
        payload: { cause: "x", message: "y" },
      }),
    ).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// T12 Wave 4-C: typed plan EventMsg variants
// ─────────────────────────────────────────────────────────────────────

describe("plan EventMsg variants (T12 Wave 4-C)", () => {
  test("startPlanItem emits plan_started when session.emit is wired", () => {
    const { session, events } = mkSession();
    const ctx = mkCtx("plan");
    const state = createPlanModeStreamState("turn-t12");
    // Driving startPlanItem via the exported `handlePlanSegments` path
    // keeps the test at the public surface — the helper is internal.
    handlePlanSegments(session, ctx, state, "item-1", [
      { kind: "proposed_plan_start" },
    ]);
    const started = events.filter((e) => e.msg.type === "plan_started");
    expect(started.length).toBe(1);
    if (started[0]?.msg.type === "plan_started") {
      expect(started[0].msg.payload.planItemId).toBe("turn-t12-plan");
      expect(typeof started[0].msg.payload.timestamp).toBe("number");
    }
  });

  test("pushPlanDelta emits plan_delta", () => {
    const { session, events } = mkSession();
    const ctx = mkCtx("plan");
    const state = createPlanModeStreamState("turn-t12");
    handlePlanSegments(session, ctx, state, "item-1", [
      { kind: "proposed_plan_start" },
      { kind: "proposed_plan_delta", delta: "step one" },
      { kind: "proposed_plan_delta", delta: " step two" },
    ]);
    const deltas = events.filter((e) => e.msg.type === "plan_delta");
    expect(deltas.length).toBe(2);
    if (deltas[0]?.msg.type === "plan_delta") {
      expect(deltas[0].msg.payload.delta).toBe("step one");
      expect(deltas[0].msg.payload.planItemId).toBe("turn-t12-plan");
    }
  });

  test("completePlanItemWithText emits plan_item_completed", () => {
    const { session, events } = mkSession();
    const ctx = mkCtx("plan");
    const state = createPlanModeStreamState("turn-t12");
    state.planItemState.started = true;

    maybeCompletePlanItemFromMessage(session, ctx, state, {
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: [
            "Plan follows.",
            "<proposed_plan>",
            "1. Explore",
            "2. Build",
            "</proposed_plan>",
          ].join("\n"),
        },
      ],
    });
    const completed = events.filter(
      (e) => e.msg.type === "plan_item_completed",
    );
    expect(completed.length).toBe(1);
    if (completed[0]?.msg.type === "plan_item_completed") {
      expect(completed[0].msg.payload.planItemId).toBe("turn-t12-plan");
      expect(completed[0].msg.payload.finalText).toMatch(/1\. Explore/);
    }
  });

  test("legacy fallback: when session.emit is undefined, plan helpers do not throw and skip the legacy agent_message emits", () => {
    // Synthesize a Session stub whose `emit` is explicitly undefined so
    // the back-compat guard in `emitLegacyPlanSignal` fires.
    const eventLog = new EventLog();
    const captured: Event[] = [];
    eventLog.subscribe((e) => captured.push(e));
    let subId = 0;
    const legacySession = {
      conversationId: "conv-legacy",
      eventLog,
      nextInternalSubId: () => `s-${++subId}`,
      // NOTE: no `emit` method — forces the legacy pass-through to skip.
    } as unknown as Session;

    const ctx = mkCtx("plan");
    const state = createPlanModeStreamState("turn-legacy");

    // None of these should throw even though `session.emit` is absent.
    expect(() =>
      handlePlanSegments(legacySession, ctx, state, "item-legacy", [
        { kind: "proposed_plan_start" },
        { kind: "proposed_plan_delta", delta: "legacy delta" },
      ]),
    ).not.toThrow();

    // And no events reach the event log because the stub has no emit
    // wiring at all (both typed + legacy paths are gated on emit).
    expect(captured.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// reconnection wiring in runSamplingRequest
// ─────────────────────────────────────────────────────────────────────

describe("runSamplingRequest — reconnectWithBackoff wiring", () => {
  test("calls reconnectWithBackoff with the expected shape", async () => {
    // Import via module spies: we mock the reconnection module and
    // verify runSamplingRequest routes through it.
    const reconnectionMod = await import("../recovery/reconnection.js");
    const spy = vi
      .spyOn(reconnectionMod, "reconnectWithBackoff")
      .mockResolvedValue({
        kind: "ok",
        value: {
          needsFollowUp: false,
          assistantText: "ok",
          lastAgentMessage: "ok",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        },
        attempts: 1,
      } as never);

    const { runTurn } = await import("./run-turn.js");

    const { session, events: _events } = mkSession();
    // Wire minimal session surface needed by runTurn's outer loop.
    (session as unknown as {
      services: unknown;
      state: { unsafePeek: () => unknown };
      abortController: AbortController;
      pendingProviderSwitch: null;
      budgetTracker: null;
    }).services = {
      provider: {
        name: "stub",
        chat: async () => ({
          content: "",
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: "test",
          finishReason: "stop",
        }),
        chatStream: async () => ({
          content: "",
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: "test",
          finishReason: "stop",
        }),
        healthCheck: async () => true,
      },
      registry: { tools: [], toLLMTools: () => [] },
      hooks: { executeStop: async () => ({}) },
    };
    (session as unknown as { state: unknown }).state = {
      unsafePeek: () => ({ totalTokenUsage: 0 }),
      with: async (fn: (value: { totalTokenUsage: number; history?: unknown[] }) => void) =>
        fn({ totalTokenUsage: 0, history: [] }),
    };
    (session as unknown as { abortController: AbortController }).abortController =
      new AbortController();
    (session as unknown as { pendingProviderSwitch: null }).pendingProviderSwitch =
      null;
    (session as unknown as { budgetTracker: null }).budgetTracker = null;
    (
      session as unknown as {
        permissionModeRegistry: {
          current: () => {
            mode: "default";
            additionalWorkingDirectories: ReadonlyMap<string, never>;
            alwaysAllowRules: Record<string, never>;
            alwaysDenyRules: Record<string, never>;
            alwaysAskRules: Record<string, never>;
            isBypassPermissionsModeAvailable: false;
          };
        };
      }
    ).permissionModeRegistry = {
      current: () => ({
        mode: "default",
        additionalWorkingDirectories: new Map(),
        alwaysAllowRules: {},
        alwaysDenyRules: {},
        alwaysAskRules: {},
        isBypassPermissionsModeAvailable: false,
      }),
    };
    (
      session as unknown as {
        hasPendingInput: () => boolean;
      }
    ).hasPendingInput = () => false;
    (
      session as unknown as {
        bindProviderConversation: () => void;
      }
    ).bindProviderConversation = () => {};
    // T5 task-dispatch port: runTurnKernel now calls spawnTask at entry
    // and onTaskFinished at exit. Stub these on the test's minimal
    // session shim so the generator can drain without errors.
    (
      session as unknown as {
        spawnTask: (opts: {
          subId: string;
          kind: string;
          startedAtMs?: number;
        }) => Promise<{
          subId: string;
          kind: string;
          abortController: AbortController;
          done: Promise<void>;
          resolveDone: () => void;
          startedAtMs: number;
        }>;
      }
    ).spawnTask = async (opts) => {
      let resolveDone!: () => void;
      const done = new Promise<void>((r) => {
        resolveDone = r;
      });
      return {
        subId: opts.subId,
        kind: opts.kind,
        abortController: new AbortController(),
        done,
        resolveDone,
        startedAtMs: opts.startedAtMs ?? Date.now(),
      };
    };
    (
      session as unknown as { onTaskFinished: () => Promise<void> }
    ).onTaskFinished = async () => {};
    (
      session as unknown as {
        setProjectMemoryWarnings: (warnings: readonly string[]) => void;
      }
    ).setProjectMemoryWarnings = () => {};

    const ctx = {
      subId: "turn-1",
      cwd: "/tmp",
      config: { maxTurns: 5 },
      configSnapshot: {},
      modelInfo: {
        slug: "test",
        effectiveContextWindowPercent: 100,
        contextWindow: 1000,
        supportedReasoningLevels: [],
        defaultReasoningSummary: "auto",
        truncationPolicy: "off",
        usedFallbackModelMetadata: false,
      },
      collaborationMode: { model: "chat" },
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
      dynamicTools: [],
      depth: 0,
      toolCallGate: {
        isReady: () => true,
        signal: () => {},
        wait: async () => {},
      },
    } as unknown as TurnContext;

    // Drain.
    const gen = runTurn(session, ctx, "hello");
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of gen) {
      // drain
    }

    expect(spy).toHaveBeenCalled();
    const call = spy.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(typeof call!.attempt).toBe("function");
    expect(typeof call!.isTransient).toBe("function");
    // run-turn should rely on the reconnection helper's default
    // 10-minute budget rather than pinning the old 5-attempt policy.
    expect(call!.maxAttempts).toBeUndefined();
    spy.mockRestore();
  });

  test("isTransient classifier accepts typed LLMServerError and raw ECONNRESET", async () => {
    // Exercise the classifier fn directly by grabbing it through a
    // spy; we don't need a full runTurn drive here.
    const { isRetryableStreamError } = await import("./run-turn.js");
    const { isTransientProviderError } = await import("../recovery/api-errors.js");

    // Typed path (covers the agenc runtime 5xx branch that was previously a
    // brittle substring match).
    const { StreamModelError } = await import("../phases/stream-model.js");
    const { LLMServerError } = await import("../llm/errors.js");
    const typed = new StreamModelError(
      new LLMServerError("openai", 503, "Service Unavailable"),
    );
    expect(isRetryableStreamError(typed)).toBe(true);

    // Raw-error path caught by isTransientProviderError fallthrough.
    const raw = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    expect(isTransientProviderError(raw)).toBe(true);
  });
});
