/**
 * Phase 5 — integration tests for T7 gap #109 pipeline wiring.
 *
 * Covers the three outcomes introduced by the router / orchestrator /
 * orchestration / tool-hooks integration inside `executeTools`:
 *
 *   1. Pre-hook fires before `runToolUse` (arg mutation observable).
 *   2. Post-hook fires after `runToolUse` and can rewrite the result.
 *   3. `AGENC_MAX_TOOL_USE_CONCURRENCY=2` caps parallel dispatch.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { EventLog } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { TurnState } from "../session/turn-state.js";
import type { Tool } from "../tools/types.js";
import type { ToolRegistry, ToolDispatchResult } from "../tool-registry.js";
import type { LLMTool, LLMToolCall } from "../llm/types.js";
import type {
  PostToolUseHook,
  PreToolUseHook,
} from "../tools/tool-hooks.js";
import { executeTools } from "./execute-tools.js";

function mkCtx(): TurnContext {
  return {
    subId: "turn-1",
    cwd: "/tmp",
    depth: 0,
  } as unknown as TurnContext;
}

function mkRegistry(tools: Tool[]): ToolRegistry {
  return {
    tools,
    toLLMTools(): LLMTool[] {
      return tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    },
    dispatch: async (call: LLMToolCall): Promise<ToolDispatchResult> => {
      const tool = tools.find((t) => t.name === call.name);
      if (!tool) {
        return {
          content: JSON.stringify({ error: `unknown tool: ${call.name}` }),
          isError: true,
        };
      }
      const parsed = call.arguments ? JSON.parse(call.arguments) : {};
      const result = await tool.execute(parsed);
      return { content: result.content, isError: result.isError };
    },
  };
}

interface MkSessionOpts {
  readonly log: EventLog;
  readonly registry: ToolRegistry;
  readonly preToolUseHooks?: ReadonlyArray<PreToolUseHook>;
  readonly postToolUseHooks?: ReadonlyArray<PostToolUseHook>;
}

function mkSession(opts: MkSessionOpts): Session {
  let i = 0;
  const emitted: Array<{ id: string; msg: { type: string; payload?: unknown } }> = [];
  const sess = {
    conversationId: "conv-1",
    eventLog: opts.log,
    services: {
      registry: opts.registry,
      provider: { name: "stub-provider" },
      hooks: {
        preToolUseHooks: opts.preToolUseHooks ?? [],
        postToolUseHooks: opts.postToolUseHooks ?? [],
      },
    },
    nextInternalSubId: () => `s-${++i}`,
    emit: (ev: { id: string; msg: { type: string; payload?: unknown } }) => {
      emitted.push(ev);
      return opts.log.emit(ev as never);
    },
  } as unknown as Session;
  (sess as unknown as { _emitted: typeof emitted })._emitted = emitted;
  return sess;
}

function mkState(opts: {
  readonly toolCalls: readonly LLMToolCall[];
}): TurnState {
  const toolUseBlocks = opts.toolCalls.map((c) => ({
    type: "tool_use" as const,
    id: c.id,
    name: c.name,
    input: {},
  }));
  return {
    messages: [],
    messagesForQuery: [],
    autoCompactTracking: undefined,
    taskBudgetRemaining: undefined,
    snipTokensFreed: 0,
    pendingMemoryPrefetch: undefined,
    pendingSkillPrefetch: undefined,
    contentReplacementState: undefined,
    assistantMessages: [
      {
        uuid: "a-1",
        role: "assistant",
        text: "",
        toolCalls: opts.toolCalls,
      },
    ],
    toolUseBlocks,
    needsFollowUp: true,
    toolResults: [],
    hasAttemptedReactiveCompact: false,
    maxOutputTokensOverride: undefined,
    maxOutputTokensRecoveryCount: 0,
    recoveryReentryCount: 0,
    continuationNudgeCount: 0,
    streamingToolExecutor: null,
    pendingToolUseSummary: undefined,
    pendingBudgetDecision: undefined,
    turnCount: 1,
    transition: undefined,
    stopHookActive: undefined,
    stopHookBlockingCount: 0,
  } as unknown as TurnState;
}

const ENV_VAR = "AGENC_MAX_TOOL_USE_CONCURRENCY";
const savedEnv: { value: string | undefined } = { value: undefined };

beforeEach(() => {
  savedEnv.value = process.env[ENV_VAR];
});
afterEach(() => {
  if (savedEnv.value === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = savedEnv.value;
});

describe("executeTools — T7 gap #109 pipeline", () => {
  test("pre-hook fires before runToolUse and can mutate args", async () => {
    const observedArgs: Array<Record<string, unknown>> = [];
    const tool: Tool & { supportsParallelToolCalls?: boolean } = {
      name: "stub.observe",
      description: "records the args it gets",
      inputSchema: { type: "object" },
      supportsParallelToolCalls: false,
      execute: async (args: Record<string, unknown>) => {
        observedArgs.push(args);
        return { content: JSON.stringify(args) };
      },
    };

    const log = new EventLog();
    let preCalls = 0;
    const preHook: PreToolUseHook = async ({ args }) => {
      preCalls += 1;
      return { kind: "continue", args: { ...args, injected: true } };
    };

    const registry = mkRegistry([tool]);
    const session = mkSession({
      log,
      registry,
      preToolUseHooks: [preHook],
    });

    const call: LLMToolCall = {
      id: "c-1",
      name: "stub.observe",
      arguments: JSON.stringify({ orig: 1 }),
    };
    const state = mkState({ toolCalls: [call] });

    await executeTools(state, mkCtx(), session);

    expect(preCalls).toBe(1);
    expect(observedArgs).toHaveLength(1);
    expect(observedArgs[0]).toEqual({ orig: 1, injected: true });
    // Result threaded to state.messages as tool message
    expect(state.messages.length).toBe(1);
    expect(state.messages[0]!.role).toBe("tool");
  });

  test("post-hook fires after runToolUse and can rewrite result", async () => {
    const tool: Tool = {
      name: "stub.echo",
      description: "echoes",
      inputSchema: { type: "object" },
      execute: async () => ({ content: "original" }),
    };

    const log = new EventLog();
    let postCalls = 0;
    let sawResultContent = "";
    const postHook: PostToolUseHook = async ({ result }) => {
      postCalls += 1;
      sawResultContent = result.content;
      return { kind: "rewrite", result: { content: "rewritten" } };
    };

    const registry = mkRegistry([tool]);
    const session = mkSession({
      log,
      registry,
      postToolUseHooks: [postHook],
    });

    const call: LLMToolCall = {
      id: "c-2",
      name: "stub.echo",
      arguments: "{}",
    };
    const state = mkState({ toolCalls: [call] });

    await executeTools(state, mkCtx(), session);

    expect(postCalls).toBe(1);
    expect(sawResultContent).toBe("original");
    // state.messages[0].content should be the rewritten content
    expect(state.messages[0]!.content).toBe("rewritten");
  });

  test("AGENC_MAX_TOOL_USE_CONCURRENCY=2 limits parallel dispatch", async () => {
    let active = 0;
    let peak = 0;
    const tool: Tool & { supportsParallelToolCalls?: boolean; concurrencyClass?: unknown } = {
      name: "system.readFile",
      description: "read-only",
      inputSchema: { type: "object" },
      supportsParallelToolCalls: true,
      concurrencyClass: { kind: "shared_read" as const },
      execute: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((r) => setTimeout(r, 15));
        active -= 1;
        return { content: "ok" };
      },
    };

    process.env[ENV_VAR] = "2";

    const log = new EventLog();
    const registry = mkRegistry([tool]);
    const session = mkSession({ log, registry });

    const calls: LLMToolCall[] = Array.from({ length: 6 }, (_, idx) => ({
      id: `c-${idx}`,
      name: "system.readFile",
      arguments: "{}",
    }));
    const state = mkState({ toolCalls: calls });

    await executeTools(state, mkCtx(), session);

    // All 6 completed
    expect(state.messages.length).toBe(6);
    // Peak in-flight must not exceed 2 when env cap is 2
    expect(peak).toBeLessThanOrEqual(2);
  });

  test("router classification emits tool_routing_classified warning", async () => {
    const tool: Tool = {
      name: "stub.ping",
      description: "ping",
      inputSchema: { type: "object" },
      execute: async () => ({ content: "pong" }),
    };

    const log = new EventLog();
    const seen: Array<{ cause?: string; type: string }> = [];
    log.subscribe((ev) => {
      const msg = ev.msg as { type: string; payload?: { cause?: string } };
      seen.push({ type: msg.type, cause: msg.payload?.cause });
    });

    const registry = mkRegistry([tool]);
    const session = mkSession({ log, registry });

    const call: LLMToolCall = {
      id: "c-r",
      name: "stub.ping",
      arguments: "{}",
    };
    const state = mkState({ toolCalls: [call] });
    await executeTools(state, mkCtx(), session);

    const routed = seen.find(
      (e) => e.type === "warning" && e.cause === "tool_routing_classified",
    );
    expect(routed).toBeDefined();
  });
});
