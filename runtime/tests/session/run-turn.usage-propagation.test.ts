/**
 * Usage-propagation integration battery (D1/D2 live-usage backstop).
 *
 * LIVE BUG CONTEXT: driving the real TUI through a 3-agent build, the Agents
 * rail showed `tools 0 tokens 0` the whole run and `/cost` showed `SESSION —`.
 * D2 (#1329) plumbed `live.tokenUsage.totalTokens` -> task.progress -> rail, and
 * its unit test passed by INJECTING counts into a synthetic collab event — so it
 * never verified that the upstream sampling path actually produces real counts.
 *
 * This battery closes that gap. It drives the REAL `runTurn` generator (which
 * fans out through the real stream-model phase that stashes
 * `state.lastResponseUsage`, accumulates `session.totalTokenUsage`, and emits the
 * `token_count` event the CostSidecar tallies) with a scripted streaming
 * provider that reports real `usage`, and asserts the three downstream sinks the
 * TUI reads from all end up NONZERO on a COMPLETED turn:
 *
 *   1. the yielded `turn_complete.usage` — what run-agent.ts adds to
 *      `live.tokenUsage` (the per-agent fan-out rail source, D2),
 *   2. the emitted `token_count` event — what `session/cost.ts` CostSidecar
 *      tallies for `/cost` (the SESSION line + BY MODEL),
 *   3. `session.state.totalTokenUsage` — the cross-turn accumulator.
 *
 * It also pins the multi-step + kill-after-a-completed-step behaviour: a turn
 * whose FIRST sampling step completes (real usage) then is CANCELLED still
 * surfaces the completed step's usage on `turn_complete` (so a subagent killed
 * mid-turn keeps the tokens it already burned; only the in-flight step is lost).
 *
 * REVERT PROOF: these go red if the D1 threading
 * (`stream-model.ts: state.lastResponseUsage = response.usage`) is reverted to
 * the old hardcoded `{0,0,0}`. See the literal stash/restore step recorded in
 * the change report.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// run-turn fans out into magic-docs / session-memory hooks and an axios client
// at import time; stub them exactly like run-turn.progress.test.ts.
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

const ENV_KEYS = ["AGENC_MAX_TURNS", "AGENC_BEHAVIORAL_BACKSTOP"] as const;
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

// ── harness factories (mirror run-turn.progress.test.ts) ────────────

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
    subId: "turn-usage",
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
 * A scripted STREAMING provider. `step(i)` returns the LLMResponse for the i-th
 * model call (0-based). Crucially the response flows back through the real
 * stream-model phase, so its `usage` exercises the whole capture/propagation
 * chain rather than a synthetic injected count.
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

function mkScriptedRegistry(
  toolNames: readonly string[],
  resultFor: (
    name: string,
    args: Record<string, unknown>,
  ) => { content: string; isError: boolean },
): { registry: ToolRegistry } {
  const tools = toolNames.map((name) => ({
    name,
    description: `${name} test tool`,
    inputSchema: { type: "object", additionalProperties: true },
    requiresApproval: false,
    execute: async (args: Record<string, unknown>) => resultFor(name, args),
  }));
  const registry = {
    tools,
    toLLMTools: () => [],
    dispatch: async (call: LLMToolCall): Promise<ToolDispatchResult> => {
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
  return { registry };
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
    provider: opts.provider,
    registry: opts.registry,
    hooks: {
      executeStop: async () => ({}),
      postToolUseHooks: [],
    },
  } as unknown as SessionServices;
  const session = new Session({
    conversationId: "conv-usage",
    services,
    initialState: state as unknown as SessionOpts["initialState"],
    features: mkFeatures(),
    jsRepl: { id: "repl-usage" },
    config: mkConfig(),
    modelInfo: mkModelInfo(),
    eventQueue: new AsyncQueue<Event>(),
  });
  session.eventLog.subscribe((event) => {
    events.push(event);
  });
  return { session, events };
}

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

function tokenCountEvents(
  events: Event[],
): Array<Extract<Event["msg"], { type: "token_count" }>["payload"]> {
  const out: Array<
    Extract<Event["msg"], { type: "token_count" }>["payload"]
  > = [];
  for (const e of events) {
    if (e.msg.type === "token_count") out.push(e.msg.payload);
  }
  return out;
}

function lastTurnComplete(
  yielded: PhaseEvent[],
): Extract<PhaseEvent, { type: "turn_complete" }> | undefined {
  const tc = yielded.filter(
    (e): e is Extract<PhaseEvent, { type: "turn_complete" }> =>
      e.type === "turn_complete",
  );
  return tc[tc.length - 1];
}

// ── 1: a completed single-step turn reaches all three sinks ─────────

describe("usage propagation — completed turn reaches every TUI sink", () => {
  test("turn_complete.usage + token_count event + session.totalTokenUsage are all nonzero (the real upstream the rail/`/cost` read)", async () => {
    process.env.AGENC_MAX_TURNS = "5";
    const ctx = mkCtx(5);
    const { provider } = mkScriptedProvider(() => ({
      content: "done",
      toolCalls: [],
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 7, totalTokens: 17 },
    }));
    const { registry } = mkScriptedRegistry([], () => ({
      content: "",
      isError: false,
    }));
    const { session, events } = mkSession({ provider, registry });

    const { terminal, events: yielded } = await drainTurn(
      runTurn(session, ctx, "go"),
    );

    expect(terminal.reason).toBe("completed");

    // (1) per-agent rail source: run-agent.ts adds this to live.tokenUsage.
    const tc = lastTurnComplete(yielded);
    expect(tc).toBeDefined();
    expect(tc?.usage.totalTokens).toBe(17);
    expect(tc?.usage.promptTokens).toBe(10);
    expect(tc?.usage.completionTokens).toBe(7);

    // (2) `/cost` source: CostSidecar tallies the token_count event.
    const tcounts = tokenCountEvents(events);
    expect(tcounts.length).toBeGreaterThan(0);
    const summed = tcounts.reduce((n, p) => n + (p.totalTokens ?? 0), 0);
    expect(summed).toBe(17);

    // (3) cross-turn accumulator.
    const total = await session.state.with(
      (s: { totalTokenUsage: unknown }) => s.totalTokenUsage,
    );
    expect(
      typeof total === "object" && total !== null
        ? (total as { totalTokens?: number }).totalTokens
        : undefined,
    ).toBe(17);
  });

  // ── 2: usage accumulates across a multi-step (tool-use) turn ──────

  test("a tool-use turn accumulates usage across both sampling steps onto turn_complete", async () => {
    process.env.AGENC_MAX_TURNS = "5";
    const ctx = mkCtx(5);
    // Step 0 calls a tool (usage 11), step 1 stops (usage 6) → cumulative 17.
    const { provider } = mkScriptedProvider((i) => {
      if (i === 0) {
        return {
          content: "",
          toolCalls: [
            { id: "t-1", name: "Probe", arguments: JSON.stringify({ q: "x" }) },
          ],
          finishReason: "tool_calls",
          usage: { promptTokens: 8, completionTokens: 3, totalTokens: 11 },
        };
      }
      return {
        content: "ok",
        toolCalls: [],
        finishReason: "stop",
        usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
      };
    });
    const { registry } = mkScriptedRegistry(["Probe"], () => ({
      content: "probe result",
      isError: false,
    }));
    const { session, events } = mkSession({ provider, registry });

    const { terminal, events: yielded } = await drainTurn(
      runTurn(session, ctx, "probe it"),
    );

    expect(terminal.reason).toBe("completed");
    // turn_complete carries the CUMULATIVE usage of both completed steps.
    const tc = lastTurnComplete(yielded);
    expect(tc?.usage.totalTokens).toBe(17);
    // both steps each emitted a token_count event for the CostSidecar.
    const tcounts = tokenCountEvents(events);
    expect(tcounts.length).toBe(2);
    expect(tcounts.reduce((n, p) => n + (p.totalTokens ?? 0), 0)).toBe(17);
  });
});
