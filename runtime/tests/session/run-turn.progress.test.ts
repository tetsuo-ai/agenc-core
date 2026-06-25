/**
 * Behavioral backstop (goal #3) — loop-integration battery.
 *
 * Drives the REAL `runTurn` generator with a scripted fake LLM provider
 * + tool registry and asserts the no-progress terminal flows end-to-end:
 *
 *   - A1 repetition runaway → terminal {reason:"no_progress"}, model
 *     called <=9 times not 1000, last assistant message is the honest
 *     no-progress text (never a success string), no fabricated tool
 *     result, and a `no_progress_detected` warning emitted.
 *   - A1 REVERT proof: master switch OFF → the same repro spins to
 *     max_turns (literal call counts asserted both ways).
 *   - A5 soft-nudge-then-recover: nudge fires once at the soft threshold,
 *     the model changes approach, the turn completes normally (no trip).
 *   - B1 status-polling-that-progresses (the killer false-positive
 *     guard): same tool 12x with a CHANGING result → reason:"completed",
 *     never trips. (The guard-of-the-guard forced-constant-resultHash
 *     reddening is proven in the pure-unit suite.)
 *   - C1 non-blocking: the policing path issues zero extra provider/tool
 *     calls (call counts are unchanged by record+evaluate).
 *   - D1 wire: terminalToStopReason("no_progress") === "no_progress".
 *
 * The B6 recovery/compaction re-entry guard is structural — the record
 * site sits PAST every recovery/compaction `continue` arm, and the
 * behavioral* fields are NOT cleared in `resetIterationFields` — and is
 * exercised at the boundary by the broader run-turn compaction/recovery
 * test suites which must stay green (a turn that legitimately re-enters
 * must still complete normally with this feature ON by default).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The run-turn module fans out into magic-docs / session-memory hooks and
// an axios client at import time; stub them exactly like run-turn.test.ts.
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
vi.mock("../memory/session/sessionMemory.js", () => ({
  runSessionMemoryPostSamplingHook: async () => {},
}));

import { AsyncQueue } from "../utils/async-queue.js";
import { runTurn } from "./run-turn.js";
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
import { TurnTimingState } from "./turn-context.js";
import type {
  LLMMessage,
  LLMProvider,
  LLMResponse,
  LLMToolCall,
  StreamProgressCallback,
} from "../llm/types.js";
import type { ToolRegistry } from "../tool-registry.js";
import type { Terminal } from "./turn-state.js";
import type { ToolDispatchResult } from "../tool-registry.js";
import type { PhaseEvent } from "../phases/events.js";

// ── env isolation ───────────────────────────────────────────────────

const ENV_KEYS = [
  "AGENC_BEHAVIORAL_BACKSTOP",
  "AGENC_NOPROGRESS_WARN",
  "AGENC_NOPROGRESS_TERMINATE",
  "AGENC_ABAB_TERMINATE",
  "AGENC_LOWGAIN_TERMINATE",
  "AGENC_PROGRESS_WINDOW",
  "AGENC_MAX_TURNS",
] as const;
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

// ── harness factories (mirrors run-turn.test.ts) ────────────────────

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
      shellEnvironmentPolicy: { allowedEnvVars: [], blockedEnvVars: [] },
      windowsSandboxPrivateDesktop: false,
    },
    ghostSnapshot: { enabled: false },
    agentRoles: [],
  } as unknown as Config;
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
  } as unknown as ModelInfo;
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
    provider: { slug: "stub-provider" },
  } as unknown as SessionConfiguration;
}

function mkCtx(maxTurns: number): TurnContext {
  return {
    subId: "turn-progress",
    cwd: "/tmp",
    config: { maxTurns } as unknown,
    configSnapshot: {} as unknown,
    modelInfo: mkModelInfo(),
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
    turnTimingState: new TurnTimingState(),
  } as unknown as TurnContext;
}

/**
 * A scripted streaming provider. `step(i)` returns the LLMResponse for the
 * i-th model call (0-based). Tracks the call count.
 */
function mkScriptedProvider(
  step: (i: number) => Partial<LLMResponse>,
): { provider: LLMProvider; calls: () => number } {
  let calls = 0;
  const make = (i: number): LLMResponse => ({
    content: "",
    toolCalls: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    model: "test-model",
    finishReason: "stop",
    ...step(i),
  });
  const provider: LLMProvider = {
    name: "stub-provider",
    chat: async () => {
      const r = make(calls);
      calls += 1;
      return r;
    },
    chatStream: async (
      _msgs: LLMMessage[],
      _onChunk: StreamProgressCallback,
      _options,
    ): Promise<LLMResponse> => {
      const r = make(calls);
      calls += 1;
      return r;
    },
    healthCheck: async () => true,
  } as unknown as LLMProvider;
  return { provider, calls: () => calls };
}

/**
 * A registry whose per-tool result is computed dynamically. The actual
 * dispatch in the streaming executor flows through the router built from
 * `registry.tools`, which invokes each tool's `execute` — so the dynamic
 * content lives there, NOT on the registry-level `dispatch`. `resultFor`
 * receives the tool name and the parsed args.
 */
function mkScriptedRegistry(
  toolNames: readonly string[],
  resultFor: (
    name: string,
    args: Record<string, unknown>,
  ) => { content: string; isError: boolean },
): { registry: ToolRegistry; dispatchCalls: () => number } {
  let dispatchCalls = 0;
  const tools = toolNames.map((name) => ({
    name,
    description: `${name} test tool`,
    inputSchema: { type: "object", additionalProperties: true },
    requiresApproval: false,
    execute: async (args: Record<string, unknown>) => {
      dispatchCalls += 1;
      return resultFor(name, args);
    },
  }));
  const registry = {
    tools,
    toLLMTools: () => [],
    dispatch: async (call: LLMToolCall): Promise<ToolDispatchResult> => {
      // Not used by the streaming-executor router path, but kept for any
      // direct-dispatch fallback. Mirrors the per-tool execute result.
      const args = ((): Record<string, unknown> => {
        try {
          return JSON.parse(call.arguments) as Record<string, unknown>;
        } catch {
          return {};
        }
      })();
      return resultFor(call.name, args);
    },
  } as unknown as ToolRegistry;
  return { registry, dispatchCalls: () => dispatchCalls };
}

function mkSession(opts: {
  provider: LLMProvider;
  registry: ToolRegistry;
}): { session: Session; events: Event[] } {
  const events: Event[] = [];
  const state = {
    sessionConfiguration: mkSessionConfiguration(),
    history: [] as unknown[],
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
      postToolUseHooks: [],
    },
  } as unknown as SessionServices;
  const session = new Session({
    conversationId: "conv-progress",
    services,
    initialState: state as unknown as SessionOpts["initialState"],
    features: mkFeatures(),
    jsRepl: { id: "repl-progress" },
    config: mkConfig(),
    modelInfo: mkModelInfo(),
    eventQueue: new AsyncQueue<Event>(),
  });
  session.eventLog.subscribe((event) => {
    events.push(event);
  });
  return { session, events };
}

/** Drive the turn to completion, capturing the returned Terminal. */
async function drainTurn(
  gen: AsyncGenerator<PhaseEvent, Terminal>,
): Promise<{ terminal: Terminal; events: PhaseEvent[] }> {
  const yielded: PhaseEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    yielded.push(next.value);
    next = await gen.next();
  }
  return { terminal: next.value, events: yielded };
}

// A model response that calls the same tool with identical args forever.
function identicalToolCall(i: number): Partial<LLMResponse> {
  return {
    content: "",
    toolCalls: [
      {
        id: `call-${i}`,
        name: "Read",
        arguments: JSON.stringify({ file_path: "/x" }),
      },
    ],
    finishReason: "tool_calls",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
}


// ── A1 — repetition runaway trips no_progress ───────────────────────

describe("A1 — repetition runaway finalizes with no_progress", () => {
  test("trips no_progress, model called <=9 (not 1000), honest terminal, no fabricated result", async () => {
    process.env.AGENC_MAX_TURNS = "1000";
    const ctx = mkCtx(1000);
    const { provider, calls } = mkScriptedProvider((i) => identicalToolCall(i));
    const { registry } = mkScriptedRegistry(["Read"], () => ({
      content: "stable content", // IDENTICAL every step
      isError: false,
    }));
    const { session, events } = mkSession({ provider, registry });

    const { terminal, events: yielded } = await drainTurn(
      runTurn(session, ctx, "go"),
    );

    expect(terminal.reason).toBe("no_progress");
    // model called far fewer than maxTurns (≈ repeatHard/lowGain threshold)
    expect(calls()).toBeLessThanOrEqual(9);
    expect(calls()).toBeGreaterThan(1);

    // a `no_progress_detected` warning was emitted
    const warned = events.some(
      (e) =>
        e.msg.type === "warning" &&
        e.msg.payload.cause === "no_progress_detected",
    );
    expect(warned).toBe(true);

    // the yielded turn_complete carries stopReason no_progress (not completed/error)
    const tc = yielded.filter(
      (e): e is Extract<PhaseEvent, { type: "turn_complete" }> =>
        e.type === "turn_complete",
    );
    expect(tc.length).toBeGreaterThan(0);
    const lastTc = tc[tc.length - 1];
    expect(lastTc?.stopReason).toBe("no_progress");

    // the finalized content is the honest no-progress text, never a success
    // string and never a fabricated tool result.
    const honest = lastTc?.content ?? "";
    expect(honest).toMatch(/no-progress backstop/i);
    expect(honest).not.toMatch(/stable content/); // not a fabricated tool result
    expect(honest).not.toMatch(/success|task completed/i);
  });

  test("REVERT: master switch OFF → same repro spins to max_turns", async () => {
    process.env.AGENC_BEHAVIORAL_BACKSTOP = "0";
    process.env.AGENC_MAX_TURNS = "12"; // keep the revert fast
    const ctx = mkCtx(12);
    const { provider, calls } = mkScriptedProvider((i) => identicalToolCall(i));
    const { registry } = mkScriptedRegistry(["Read"], () => ({
      content: "stable content",
      isError: false,
    }));
    const { session } = mkSession({ provider, registry });

    const { terminal } = await drainTurn(runTurn(session, ctx, "go"));

    expect(terminal.reason).toBe("max_turns");
    // ran to the cap, NOT bounded at ~8
    expect(calls()).toBeGreaterThanOrEqual(12);
  });
});

// ── A5 — soft-nudge then recover ────────────────────────────────────

describe("A5 — soft-nudge-then-recover completes normally", () => {
  test("nudge fires once at the soft threshold, model changes, no trip", async () => {
    process.env.AGENC_MAX_TURNS = "50";
    // Repeat identically until the soft warn fires (3), then on the 4th
    // model call produce a final assistant message (no tool calls) to end.
    const ctx = mkCtx(50);
    const { provider } = mkScriptedProvider((i) => {
      if (i < 3) return identicalToolCall(i);
      return { content: "Done — changed approach.", toolCalls: [], finishReason: "stop" };
    });
    const { registry } = mkScriptedRegistry(["Read"], () => ({
      content: "stable content",
      isError: false,
    }));
    const { session, events } = mkSession({ provider, registry });

    const { terminal } = await drainTurn(runTurn(session, ctx, "go"));

    expect(terminal.reason).toBe("completed");
    // a warn was emitted exactly once (one-shot nudge latch), and its
    // detail describes the repetition — proving the soft-nudge fired.
    const warns = events.filter(
      (e) =>
        e.msg.type === "warning" &&
        e.msg.payload.cause === "no_progress_warning",
    );
    expect(warns.length).toBe(1);
    const warnMsg =
      warns[0]?.msg.type === "warning"
        ? (warns[0].msg.payload as { message?: string }).message ?? ""
        : "";
    expect(warnMsg).toMatch(/repeated/i);
    // NO terminate warning fired — the model changed approach and finished.
    const terminated = events.some(
      (e) =>
        e.msg.type === "warning" &&
        e.msg.payload.cause === "no_progress_detected",
    );
    expect(terminated).toBe(false);
  });
});

// ── B1 — status polling that progresses must NOT trip ───────────────

describe("B1 — status polling that progresses never trips (killer test)", () => {
  test("same tool 12x with CHANGING result → reason:completed, no trip", async () => {
    process.env.AGENC_MAX_TURNS = "50";
    const ctx = mkCtx(50);
    // 12 identical GetStatus calls, then a final stop.
    const { provider } = mkScriptedProvider((i) => {
      if (i < 12) {
        return {
          content: "",
          toolCalls: [
            { id: `poll-${i}`, name: "GetStatus", arguments: "{}" },
          ],
          finishReason: "tool_calls",
        };
      }
      return { content: "All done.", toolCalls: [], finishReason: "stop" };
    });
    // The result CHANGES each step → resultHash differs → never trips.
    let pollIndex = 0;
    const { registry } = mkScriptedRegistry(["GetStatus"], () => {
      const content = pollIndex < 11 ? `pending ${pollIndex}/11` : "done";
      pollIndex += 1;
      return { content, isError: false };
    });
    const { session, events } = mkSession({ provider, registry });

    const { terminal } = await drainTurn(runTurn(session, ctx, "poll"));

    expect(terminal.reason).toBe("completed");
    // never tripped
    const tripped = events.some(
      (e) =>
        e.msg.type === "warning" &&
        e.msg.payload.cause === "no_progress_detected",
    );
    expect(tripped).toBe(false);
  });
});

// ── C1 — non-blocking: policing path adds no provider/tool calls ────

describe("C1 — the policing path is non-blocking (no extra calls)", () => {
  test("a healthy 2-step tool turn yields exactly the expected call counts", async () => {
    process.env.AGENC_MAX_TURNS = "50";
    const ctx = mkCtx(50);
    // 1 tool call then stop → provider called twice, tool dispatched once.
    const { provider, calls } = mkScriptedProvider((i) => {
      if (i === 0) {
        return {
          content: "",
          toolCalls: [
            { id: "t-1", name: "Probe", arguments: JSON.stringify({ q: "x" }) },
          ],
          finishReason: "tool_calls",
        };
      }
      return { content: "ok", toolCalls: [], finishReason: "stop" };
    });
    const { registry, dispatchCalls } = mkScriptedRegistry(["Probe"], () => ({
      content: "probe result",
      isError: false,
    }));
    const { session } = mkSession({ provider, registry });

    const { terminal } = await drainTurn(runTurn(session, ctx, "probe it"));

    expect(terminal.reason).toBe("completed");
    // The policing path (record + evaluate) issued NO extra provider/tool
    // calls — counts are exactly what a healthy turn produces (the model
    // was called exactly twice: tool-call turn + final stop turn, NOT
    // inflated by the synchronous record/evaluate policing).
    expect(calls()).toBe(2);
    expect(dispatchCalls()).toBe(1);
  });
});

// ── D1 — wire mapping ───────────────────────────────────────────────

describe("D1 — terminalToStopReason maps no_progress honestly", () => {
  test("no_progress maps to no_progress (NOT error)", async () => {
    // Indirect proof through the running loop: A1's turn_complete event
    // carries stopReason "no_progress", which can only happen if the
    // mapper's `case "no_progress"` arm (not default→"error") is present.
    process.env.AGENC_MAX_TURNS = "1000";
    const ctx = mkCtx(1000);
    const { provider } = mkScriptedProvider((i) => identicalToolCall(i));
    const { registry } = mkScriptedRegistry(["Read"], () => ({
      content: "stable content",
      isError: false,
    }));
    const { session } = mkSession({ provider, registry });
    const { terminal, events: yielded } = await drainTurn(
      runTurn(session, ctx, "go"),
    );
    expect(terminal.reason).toBe("no_progress");
    const tc = yielded.find(
      (e): e is Extract<PhaseEvent, { type: "turn_complete" }> =>
        e.type === "turn_complete" && e.stopReason === "no_progress",
    );
    // The mapped stopReason is "no_progress", NOT "error" — proves the
    // terminalToStopReason `case "no_progress"` arm is present.
    expect(tc).toBeDefined();
    expect(tc?.stopReason).toBe("no_progress");
    expect(tc?.stopReason).not.toBe("error");
  });
});
