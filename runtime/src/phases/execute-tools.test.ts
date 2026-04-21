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
import { PermissionModeRegistry } from "../permissions/mode.js";
import {
  createEmptyToolPermissionContext,
  type ToolPermissionContext,
} from "../permissions/types.js";
import { freshDenialTracking } from "../permissions/denial-tracking.js";
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
  readonly permissionModeRegistry?: PermissionModeRegistry;
  readonly mcpManager?: {
    resolveMcpToolInfo?: (
      toolName: string,
    ) => { readonly serverName: string; readonly toolName: string } | undefined;
  };
  /**
   * When true, expose `session.denialTracking` mirroring the real
   * Session class so the T11 W4 wire-up picks up a shared reference.
   */
  readonly withDenialTracking?: boolean;
}

function mkSession(opts: MkSessionOpts): Session {
  let i = 0;
  const emitted: Array<{ id: string; msg: { type: string; payload?: unknown } }> = [];
  const servicesRecord: Record<string, unknown> = {
    registry: opts.registry,
    provider: { name: "stub-provider" },
    hooks: {
      preToolUseHooks: opts.preToolUseHooks ?? [],
      postToolUseHooks: opts.postToolUseHooks ?? [],
    },
  };
  if (opts.permissionModeRegistry) {
    servicesRecord["permissionModeRegistry"] = opts.permissionModeRegistry;
  }
  if (opts.mcpManager) {
    servicesRecord["mcpManager"] = opts.mcpManager;
  }
  const baseSession: Record<string, unknown> = {
    conversationId: "conv-1",
    eventLog: opts.log,
    services: servicesRecord,
    nextInternalSubId: () => `s-${++i}`,
    emit: (ev: { id: string; msg: { type: string; payload?: unknown } }) => {
      emitted.push(ev);
      return opts.log.emit(ev as never);
    },
  };
  if (opts.withDenialTracking) {
    baseSession["denialTracking"] = freshDenialTracking();
  }
  const sess = baseSession as unknown as Session;
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

  test("live path binds router MCP resolution to the session, not the namespace heuristic", async () => {
    const observedPayloadKinds: string[] = [];
    const tool: Tool = {
      name: "github.listIssues",
      description: "mcp-backed tool",
      inputSchema: { type: "object" },
      execute: async () => ({ content: "ok" }),
    };

    const preHook: PreToolUseHook = async ({ invocation }) => {
      observedPayloadKinds.push(invocation.payload.kind);
      return { kind: "continue" };
    };

    const log = new EventLog();
    const registry = mkRegistry([tool]);
    const session = mkSession({
      log,
      registry,
      preToolUseHooks: [preHook],
      mcpManager: {
        resolveMcpToolInfo: (toolName: string) =>
          toolName === "github.listIssues"
            ? { serverName: "github", toolName: "listIssues" }
            : undefined,
      },
    });

    const state = mkState({
      toolCalls: [
        {
          id: "mcp-1",
          name: "github.listIssues",
          arguments: "{}",
        },
      ],
    });

    await executeTools(state, mkCtx(), session);

    expect(observedPayloadKinds).toEqual(["mcp"]);
    expect(state.messages[0]!.content).toBe("ok");
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

  test("post-hook retry triggers runWithAutoFixRetry (not skipped)", async () => {
    let dispatchCount = 0;
    const tool: Tool = {
      name: "autofix.target",
      description: "",
      inputSchema: { type: "object" },
      execute: async () => {
        dispatchCount += 1;
        return { content: `dispatch-${dispatchCount}`, isError: true };
      },
    };

    const log = new EventLog();
    let retryEmissions = 0;
    let skipEmissions = 0;
    log.subscribe((ev) => {
      const msg = ev.msg as { type: string; payload?: { cause?: string } };
      if (msg.type === "warning") {
        if (msg.payload?.cause === "post_tool_hook_retry_skipped") {
          skipEmissions += 1;
        } else if (msg.payload?.cause === "post_tool_hook_retry_failed") {
          retryEmissions += 1;
        }
      }
    });

    // Post-hook that requests retry TWICE then continues — this exercises
    // the real runWithAutoFixRetry loop.
    let postHookCallCount = 0;
    const postHook: PostToolUseHook = async () => {
      postHookCallCount += 1;
      if (postHookCallCount < 3) {
        return { kind: "retry", args: { attempt: postHookCallCount } };
      }
      return { kind: "continue" };
    };

    const registry = mkRegistry([tool]);
    const session = mkSession({ log, registry, postToolUseHooks: [postHook] });
    const call: LLMToolCall = {
      id: "c-retry",
      name: "autofix.target",
      arguments: "{}",
    };
    const state = mkState({ toolCalls: [call] });
    await executeTools(state, mkCtx(), session);

    // dispatchCount should be >1 because retry re-dispatched.
    expect(dispatchCount).toBeGreaterThan(1);
    // The `post_tool_hook_retry_skipped` warning must NOT have fired
    // (proving the real retry path ran).
    expect(skipEmissions).toBe(0);
    // No retry error either.
    expect(retryEmissions).toBe(0);
    // Final result threaded to messages.
    expect(state.messages.length).toBe(1);
  });

  test("progress event fires on eventLog when tool calls __onProgress", async () => {
    const tool: Tool = {
      name: "bash-like",
      description: "",
      inputSchema: { type: "object" },
      execute: async (args) => {
        const onProgress = (args as { __onProgress?: (e: { chunk: string }) => void })
          .__onProgress;
        onProgress?.({ chunk: "line-1" });
        onProgress?.({ chunk: "line-2" });
        return { content: "done" };
      },
    };

    const log = new EventLog();
    const progressEvents: string[] = [];
    log.subscribe((ev) => {
      const msg = ev.msg as { type: string; payload?: { chunk?: string } };
      if (msg.type === "tool_progress" && msg.payload?.chunk) {
        progressEvents.push(msg.payload.chunk);
      }
    });

    const registry = mkRegistry([tool]);
    const session = mkSession({ log, registry });
    const call: LLMToolCall = {
      id: "c-prog",
      name: "bash-like",
      arguments: "{}",
    };
    const state = mkState({ toolCalls: [call] });
    await executeTools(state, mkCtx(), session);

    expect(progressEvents).toEqual(["line-1", "line-2"]);
  });

  // ───────────────────────────────────────────────────────────────────
  // T11 W4 (Agent A) — permission evaluator wire-up through executeTools
  // ───────────────────────────────────────────────────────────────────

  test("W4 deny rule short-circuits tool.execute() via the evaluator", async () => {
    let executed = 0;
    const tool: Tool = {
      name: "system.writeFile",
      description: "",
      inputSchema: { type: "object" },
      execute: async () => {
        executed += 1;
        return { content: "should-not-run" };
      },
    };

    const log = new EventLog();
    const errorCauses: string[] = [];
    log.subscribe((ev) => {
      const msg = ev.msg as { type: string; payload?: { cause?: string } };
      if (msg.type === "error" && msg.payload?.cause) {
        errorCauses.push(msg.payload.cause);
      }
    });

    // Default mode + a session-source deny rule for writeFile → evaluator
    // must return `deny`, and executeTools must surface an error tool
    // result instead of dispatching `tool.execute()`.
    const permCtx: ToolPermissionContext = createEmptyToolPermissionContext({
      mode: "default",
      alwaysDenyRules: { session: ["system.writeFile"] },
    });
    const registry = new PermissionModeRegistry(permCtx);

    const toolRegistry = mkRegistry([tool]);
    const session = mkSession({
      log,
      registry: toolRegistry,
      permissionModeRegistry: registry,
      withDenialTracking: true,
    });

    const call: LLMToolCall = {
      id: "c-deny",
      name: "system.writeFile",
      arguments: "{}",
    };
    const state = mkState({ toolCalls: [call] });

    await executeTools(state, mkCtx(), session);

    // tool.execute() must not have run.
    expect(executed).toBe(0);
    // An error tool result must have been threaded back into state.messages.
    expect(state.messages.length).toBe(1);
    expect(state.messages[0]!.role).toBe("tool");
    // The evaluator surfaces the deny through the error event log.
    expect(
      errorCauses.some((c) => c.startsWith("permission_denied:")),
    ).toBe(true);
  });

  test("W4 allow rule passes through to tool.execute()", async () => {
    let executed = 0;
    const tool: Tool = {
      name: "system.writeFile",
      description: "",
      inputSchema: { type: "object" },
      execute: async () => {
        executed += 1;
        return { content: "wrote-file" };
      },
    };

    const log = new EventLog();
    const permCtx: ToolPermissionContext = createEmptyToolPermissionContext({
      mode: "default",
      alwaysAllowRules: { session: ["system.writeFile"] },
    });
    const registry = new PermissionModeRegistry(permCtx);

    const toolRegistry = mkRegistry([tool]);
    const session = mkSession({
      log,
      registry: toolRegistry,
      permissionModeRegistry: registry,
      withDenialTracking: true,
    });

    const call: LLMToolCall = {
      id: "c-allow",
      name: "system.writeFile",
      arguments: "{}",
    };
    const state = mkState({ toolCalls: [call] });

    await executeTools(state, mkCtx(), session);

    expect(executed).toBe(1);
    expect(state.messages.length).toBe(1);
    expect(state.messages[0]!.role).toBe("tool");
    expect(state.messages[0]!.content).toBe("wrote-file");
  });

  test("W4 session without denialTracking still runs via evaluator fallback", async () => {
    // Fixture does NOT populate `session.denialTracking`. The executeTools
    // wire-up must fall back to a fresh per-turn DenialTracking so the
    // evaluator still sees a valid reference and no throw escapes.
    let executed = 0;
    const tool: Tool = {
      name: "system.readFile",
      description: "",
      inputSchema: { type: "object" },
      execute: async () => {
        executed += 1;
        return { content: "read-ok" };
      },
    };

    const log = new EventLog();
    const permCtx: ToolPermissionContext = createEmptyToolPermissionContext({
      mode: "default",
      alwaysAllowRules: { session: ["system.readFile"] },
    });
    const registry = new PermissionModeRegistry(permCtx);

    const toolRegistry = mkRegistry([tool]);
    // withDenialTracking=false → session.denialTracking is undefined.
    const session = mkSession({
      log,
      registry: toolRegistry,
      permissionModeRegistry: registry,
      withDenialTracking: false,
    });

    const call: LLMToolCall = {
      id: "c-default",
      name: "system.readFile",
      arguments: "{}",
    };
    const state = mkState({ toolCalls: [call] });

    // Must not throw even though session.denialTracking is absent.
    await expect(
      executeTools(state, mkCtx(), session),
    ).resolves.toBeDefined();

    expect(executed).toBe(1);
    expect(state.messages.length).toBe(1);
    expect(state.messages[0]!.content).toBe("read-ok");
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
