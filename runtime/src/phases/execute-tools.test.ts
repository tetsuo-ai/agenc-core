/**
 * Phase 5 — integration tests for T7 gap #109 pipeline wiring.
 *
 * Covers the three outcomes introduced by the router / orchestrator /
 * orchestration / hooks integration inside `executeTools`:
 *
 *   1. Pre-hook fires before `runToolUse` (arg mutation observable).
 *   2. Post-hook fires after `runToolUse` and can rewrite the result.
 *   3. `AGENC_MAX_TOOL_USE_CONCURRENCY=2` caps parallel dispatch.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
} from "../tools/hooks.js";
import { PermissionModeRegistry } from "../permissions/mode.js";
import {
  createEmptyToolPermissionContext,
  type ToolPermissionContext,
} from "../permissions/types.js";
import { freshDenialTracking } from "../permissions/denial-tracking.js";
import {
  clearAllPlanSlugs,
  getPlanFilePath,
  setPlanSlug,
  writePlanSync,
} from "../planning/plan-files.js";
import { createFileWriteTool } from "../tools/system/file-write.js";
import {
  ensureStreamingToolExecutor,
  executeTools,
  queueStreamingToolCall,
} from "./execute-tools.js";

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
  readonly approvalResolver?: {
    request(ctx: {
      readonly invocation: {
        readonly payload: unknown;
      };
      readonly callId: string;
      readonly toolName: string;
      readonly turnId: string;
    }): Promise<
      | { readonly kind: "approved" }
      | { readonly kind: "approved_for_session" }
      | { readonly kind: "denied" }
      | { readonly kind: "abort" }
    >;
  };
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
  if (opts.approvalResolver) {
    servicesRecord["approvalResolver"] = opts.approvalResolver;
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
const savedEnv: {
  value: string | undefined;
  agencHome: string | undefined;
} = { value: undefined, agencHome: undefined };
const tempDirs: string[] = [];

beforeEach(() => {
  savedEnv.value = process.env[ENV_VAR];
  savedEnv.agencHome = process.env.AGENC_HOME;
});
afterEach(() => {
  if (savedEnv.value === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = savedEnv.value;
  if (savedEnv.agencHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = savedEnv.agencHome;
  clearAllPlanSlugs();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
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
      name: "FileRead",
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
      name: "FileRead",
      arguments: "{}",
    }));
    const state = mkState({ toolCalls: calls });

    await executeTools(state, mkCtx(), session);

    // All 6 completed
    expect(state.messages.length).toBe(6);
    // Peak in-flight must not exceed 2 when env cap is 2
    expect(peak).toBeLessThanOrEqual(2);
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

  test("mid-stream queued tools are not re-dispatched and keep progress before completion", async () => {
    let executed = 0;
    const eventTypes: string[] = [];
    const tool: Tool = {
      name: "bash-like",
      description: "",
      inputSchema: { type: "object" },
      execute: async (args) => {
        executed += 1;
        const onProgress = (args as { __onProgress?: (e: { chunk: string }) => void })
          .__onProgress;
        onProgress?.({ chunk: "line-1" });
        return { content: "done" };
      },
    };

    const log = new EventLog();
    log.subscribe((ev) => {
      eventTypes.push(ev.msg.type);
    });
    const registry = mkRegistry([tool]);
    const session = mkSession({ log, registry });
    const call: LLMToolCall = {
      id: "c-mid",
      name: "bash-like",
      arguments: "{}",
    };
    const state = mkState({ toolCalls: [call] });
    const executor = ensureStreamingToolExecutor(state, mkCtx(), session);
    queueStreamingToolCall(
      executor,
      { type: "tool_use", id: call.id, name: call.name, input: {} },
      call,
      session,
    );

    await executeTools(state, mkCtx(), session);

    expect(executed).toBe(1);
    expect(eventTypes.filter((type) => type === "tool_call_started")).toHaveLength(1);
    expect(eventTypes.indexOf("tool_progress")).toBeGreaterThan(
      eventTypes.indexOf("tool_call_started"),
    );
    expect(eventTypes.indexOf("tool_call_completed")).toBeGreaterThan(
      eventTypes.indexOf("tool_progress"),
    );
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.content).toBe("done");
  });

  // ───────────────────────────────────────────────────────────────────
  // T11 W4 (Agent A) — permission evaluator wire-up through executeTools
  // ───────────────────────────────────────────────────────────────────

  test("W4 deny rule short-circuits tool.execute() via the evaluator", async () => {
    let executed = 0;
    const tool: Tool = {
      name: "Write",
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
      alwaysDenyRules: { session: ["Write"] },
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
      name: "Write",
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
      name: "Write",
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
      alwaysAllowRules: { session: ["Write"] },
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
      name: "Write",
      arguments: "{}",
    };
    const state = mkState({ toolCalls: [call] });

    await executeTools(state, mkCtx(), session);

    expect(executed).toBe(1);
    expect(state.messages.length).toBe(1);
    expect(state.messages[0]!.role).toBe("tool");
    expect(state.messages[0]!.content).toBe("wrote-file");
  });

  test("main dispatch injects session context so Write can create the active plan file", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-plan-workspace-"));
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-plan-home-"));
    tempDirs.push(workspaceRoot, agencHome);
    process.env.AGENC_HOME = agencHome;
    setPlanSlug({ agencHome, sessionId: "conv-1" }, "ivory-bridge-aaed0227");
    const planPath = getPlanFilePath({ agencHome, sessionId: "conv-1" });

    const log = new EventLog();
    const permCtx: ToolPermissionContext = createEmptyToolPermissionContext({
      mode: "default",
      alwaysAllowRules: { session: ["Write"] },
    });
    const permissionRegistry = new PermissionModeRegistry(permCtx);
    const toolRegistry = mkRegistry([
      createFileWriteTool({ allowedPaths: [workspaceRoot] }),
    ]);
    const session = mkSession({
      log,
      registry: toolRegistry,
      permissionModeRegistry: permissionRegistry,
      withDenialTracking: true,
    });
    const state = mkState({
      toolCalls: [
        {
          id: "write-plan",
          name: "Write",
          arguments: JSON.stringify({
            file_path: planPath,
            content: "# Plan\n\n- [ ] Fix plan write access\n",
          }),
        },
      ],
    });

    await executeTools(state, mkCtx(), session);

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.content).toContain("File created successfully");
    expect(readFileSync(planPath, "utf8")).toContain("Fix plan write access");
  });

  test("W4 session without denialTracking still runs via evaluator fallback", async () => {
    // Fixture does NOT populate `session.denialTracking`. The executeTools
    // wire-up must fall back to a fresh per-turn DenialTracking so the
    // evaluator still sees a valid reference and no throw escapes.
    let executed = 0;
    const tool: Tool = {
      name: "FileRead",
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
      alwaysAllowRules: { session: ["FileRead"] },
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
      name: "FileRead",
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

  test("requiresApproval tools wait for approval before dispatching", async () => {
    let executed = 0;
    const approvalSnapshots: Array<{
      readonly toolName: string;
      readonly turnId: string;
    }> = [];
    const tool: Tool = {
      name: "ExitPlanMode",
      description: "requests plan approval",
      inputSchema: { type: "object" },
      requiresApproval: true,
      execute: async () => {
        executed += 1;
        return { content: "approved plan exit" };
      },
    };

    const log = new EventLog();
    const registry = mkRegistry([tool]);
    const session = mkSession({
      log,
      registry,
      approvalResolver: {
        request: async (ctx) => {
          approvalSnapshots.push({
            toolName: ctx.toolName,
            turnId: ctx.turnId,
          });
          expect(executed).toBe(0);
          return { kind: "approved" };
        },
      },
    });

    const state = mkState({
      toolCalls: [
        {
          id: "plan-exit",
          name: "ExitPlanMode",
          arguments: "{}",
        },
      ],
    });
    await executeTools(
      state,
      {
        ...mkCtx(),
        approvalPolicy: { value: "on_request" },
        sandboxPolicy: { value: "workspace_write" },
      } as unknown as TurnContext,
      session,
    );

    expect(approvalSnapshots).toEqual([
      { toolName: "ExitPlanMode", turnId: "turn-1" },
    ]);
    expect(executed).toBe(1);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.content).toBe("approved plan exit");
  });

  test("requiresApproval tools do not dispatch when approval is denied", async () => {
    let executed = 0;
    const tool: Tool = {
      name: "ExitPlanMode",
      description: "requests plan approval",
      inputSchema: { type: "object" },
      requiresApproval: true,
      execute: async () => {
        executed += 1;
        return { content: "should-not-run" };
      },
    };

    const log = new EventLog();
    const registry = mkRegistry([tool]);
    const session = mkSession({
      log,
      registry,
      approvalResolver: {
        request: async () => ({ kind: "denied" }),
      },
    });
    const state = mkState({
      toolCalls: [
        {
          id: "plan-deny",
          name: "ExitPlanMode",
          arguments: "{}",
        },
      ],
    });

    await executeTools(
      state,
      {
        ...mkCtx(),
        approvalPolicy: { value: "on_request" },
        sandboxPolicy: { value: "workspace_write" },
      } as unknown as TurnContext,
      session,
    );

    expect(executed).toBe(0);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.content).toContain("rejected by user");
  });

  test("ExitPlanMode approval payload includes the current AgenC plan", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-exit-plan-"));
    tempDirs.push(agencHome);
    process.env.AGENC_HOME = agencHome;
    writePlanSync(
      { agencHome, sessionId: "conv-1" },
      "# AgenC Plan\n\n## Steps\n\n- [ ] Wire approval gate\n",
    );

    let approvalInput: Record<string, unknown> | null = null;
    const tool: Tool = {
      name: "ExitPlanMode",
      description: "requests plan approval",
      inputSchema: { type: "object" },
      requiresApproval: true,
      execute: async () => ({ content: "approved" }),
    };

    const log = new EventLog();
    const registry = mkRegistry([tool]);
    const session = mkSession({
      log,
      registry,
      approvalResolver: {
        request: async (ctx) => {
          const payload = ctx.invocation.payload as {
            readonly kind?: string;
            readonly arguments?: string;
          };
          approvalInput =
            payload.kind === "function" && typeof payload.arguments === "string"
              ? JSON.parse(payload.arguments)
              : {};
          return { kind: "approved" };
        },
      },
    });
    const state = mkState({
      toolCalls: [
        {
          id: "plan-preview",
          name: "ExitPlanMode",
          arguments: "{}",
        },
      ],
    });

    await executeTools(
      state,
      {
        ...mkCtx(),
        approvalPolicy: { value: "on_request" },
        sandboxPolicy: { value: "workspace_write" },
      } as unknown as TurnContext,
      session,
    );

    expect(approvalInput?.["plan"]).toContain("Wire approval gate");
    expect(approvalInput?.["planFilePath"]).toEqual(
      expect.stringContaining(join(agencHome, "plans")),
    );
  });

  test("router classification does not leak tool_routing_classified warnings", async () => {
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
    expect(routed).toBeUndefined();
  });

  test("aborted signals still drain terminal tool results for queued calls", async () => {
    let executed = 0;
    const tool: Tool = {
      name: "Write",
      description: "write tool",
      inputSchema: { type: "object" },
      execute: async () => {
        executed += 1;
        return { content: "wrote" };
      },
    };

    const log = new EventLog();
    const registry = mkRegistry([tool]);
    const session = mkSession({ log, registry });
    const state = mkState({
      toolCalls: [
        {
          id: "c-abort",
          name: "Write",
          arguments: "{}",
        },
      ],
    });
    const abortCtl = new AbortController();
    abortCtl.abort("mode_changed");

    await executeTools(state, mkCtx(), session, abortCtl.signal);

    expect(executed).toBe(0);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      role: "tool",
      toolCallId: "c-abort",
    });
    expect(String(state.messages[0]?.content)).toContain(
      "permission mode changed mid-execution",
    );
  });
});
