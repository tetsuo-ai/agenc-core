/**
 * Subset port of codex `core/src/tools/router.rs`.
 *
 * Ports:
 *   - Spec registry (`ConfiguredToolSpec[]`) + `findSpec` /
 *     `modelVisibleSpecs`.
 *   - Parallel-MCP-server allowlist feeding `toolSupportsParallel`.
 *   - `buildToolCall(session, item)` over 4 ResponseItem variants
 *     (`function_call`, `tool_search_call`, `custom_tool_call`,
 *     `local_shell_call`).
 *   - `dispatchToolCallWithCodeMode(invocation, args, source)` —
 *     code-mode-aware dispatch restricted to the JS-REPL-safe subset.
 *   - `ToolRouter.fromConfig({...})` builder-style init merging
 *     `mcpTools` / `deferredMcpTools` / `unavailableCalledTools` /
 *     `discoverableTools` / `dynamicTools`.
 *   - `createDiffConsumer(toolName)` — tool-argument diff tracking
 *     with `.record(name, before)` / `.compare(name, after)`.
 *
 * MCP attribution resolves through
 * `session.services.mcpManager.resolveMcpToolInfo(toolName)` instead of
 * the previous `namespace.startsWith("mcp")` heuristic.
 *
 * Deferred (not in this port):
 *   - `TurnContext`-gated `js_repl_tools_only` direct-call blocking
 *     (codex router.rs:280-290) — AgenC exposes the code-mode filter
 *     through `dispatchToolCallWithCodeMode` instead; the
 *     per-turn-context gate lands with the JsRepl subsystem.
 *   - `DiscoverableTool` materialization into actual `Tool` objects
 *     beyond spec carrying.
 *
 * @module
 */

import type { LLMTool, LLMToolCall } from "../llm/types.js";
import type { ToolDispatchResult, ToolRegistry } from "../tool-registry.js";
import { emitWarning as emitWarningEvent } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type {
  CanUseToolFn,
  ToolEvaluatorContext,
} from "../permissions/evaluator.js";
import type { PermissionModeRegistry } from "../permissions/mode.js";
import { reviewDecisionIsAllow } from "../permissions/review-decision.js";
import type { Tool } from "./types.js";
import {
  parseToolName,
  type ToolCallSource,
  type ToolInvocation,
  type ToolName,
  type ToolPayload,
  type SharedTurnDiffTracker,
} from "./context.js";
import {
  type ApprovalResolver,
  type ApprovalPolicy,
  type PermissionRequestHook,
  type SandboxMode,
  type ApprovalCtx,
  type GranularApprovalConfig,
  orchestrateToolCall,
  ApprovalRejectedError,
} from "./orchestrator.js";
import {
  executeToolDispatch,
  type ApprovalRequestFn,
  type ModalDecision,
  parseToolArgsWithBigInt,
  type ToolProgressCallback,
} from "./execution.js";
import type {
  PermissionDecisionHook,
  PostToolUseFailureHook,
  PostToolUseHook,
  PreToolUseHook,
} from "./hooks.js";

export interface ToolCall {
  readonly toolName: ToolName;
  readonly callId: string;
  readonly payload: ToolPayload;
}

export interface ConfiguredToolSpec {
  readonly tool: Tool;
  readonly supportsParallelToolCalls: boolean;
  readonly serverId?: string;
  /** When true, the tool is unavailable for direct invocation but may
   *  still appear in the spec catalog for telemetry/tracing. */
  readonly unavailable?: boolean;
  /** When true, the tool is loaded on-demand via ToolSearch and
   *  should not be advertised in `modelVisibleSpecs()`. */
  readonly deferred?: boolean;
  /** When true, the tool was injected as a discoverable late-load
   *  entry (codex `DiscoverableTool`). */
  readonly discoverable?: boolean;
  /** When true, the tool was injected as a runtime dynamic spec
   *  (codex `DynamicToolSpec`). */
  readonly dynamic?: boolean;
}

// Duck-typed MCPManager dependency — avoids pulling the concrete
// class into the router test surface.
interface McpManagerLike {
  readonly resolveMcpToolInfo?: (
    toolName: string,
  ) => { readonly serverName: string; readonly toolName: string } | undefined;
  readonly getServerForTool?: (namespacedName: string) => string | undefined;
}

interface SessionLike {
  readonly services?: {
    readonly mcpManager?: McpManagerLike;
  };
}

export interface LiveToolDispatchOptions {
  readonly session: Session;
  readonly turn: TurnContext;
  readonly tracker: SharedTurnDiffTracker;
  readonly signal?: AbortSignal;
  readonly source?: ToolCallSource;
  readonly approvalPolicy: ApprovalPolicy;
  readonly sandboxMode: SandboxMode;
  /**
   * Optional `GranularApprovalConfig` paired with
   * `approvalPolicy === "granular"`. Piped through to
   * `orchestrateToolCall` so the fs-policy fallback honors the
   * `allows_sandbox_approval` branch and the sandbox-denial escalation
   * honors `wants_no_sandbox_approval`.
   */
  readonly granular?: GranularApprovalConfig;
  readonly permissionHooks?: ReadonlyArray<PermissionRequestHook>;
  readonly permissionDecisionHooks?: ReadonlyArray<PermissionDecisionHook>;
  readonly approvalResolver?: ApprovalResolver;
  readonly preHooks?: ReadonlyArray<PreToolUseHook>;
  readonly postHooks?: ReadonlyArray<PostToolUseHook>;
  readonly failureHooks?: ReadonlyArray<PostToolUseFailureHook>;
  readonly canUseTool?: CanUseToolFn;
  readonly permissionContext?: ToolEvaluatorContext | null;
  readonly modeChangeRegistry?: PermissionModeRegistry;
  readonly discoveredToolNames?: ReadonlySet<string>;
  readonly onProgress?: ToolProgressCallback;
  readonly onHookError?: (
    phase: "pre" | "post" | "failure",
    err: unknown,
    idx: number,
  ) => void;
}

// ─────────────────────────────────────────────────────────────────────
// ResponseItem input union for `buildToolCall`.
//
// Mirrors the 4 codex `ResponseItem` variants the router consumes.
// Types are narrow — callers only need to pass the minimum the router
// reads. Everything else is preserved upstream in the rollout store.
// ─────────────────────────────────────────────────────────────────────

export type RouterResponseItem =
  | {
      readonly type: "function_call";
      readonly callId: string;
      readonly name: string;
      readonly namespace?: string;
      readonly arguments: string;
    }
  | {
      readonly type: "tool_search_call";
      readonly callId?: string;
      readonly execution?: string;
      readonly arguments: { readonly query: string } | string;
    }
  | {
      readonly type: "custom_tool_call";
      readonly callId: string;
      readonly name: string;
      readonly input: string;
    }
  | {
      readonly type: "local_shell_call";
      readonly id?: string;
      readonly callId?: string;
      readonly action: {
        readonly type: "exec";
        readonly command: ReadonlyArray<string>;
        readonly workingDirectory?: string;
        readonly timeoutMs?: number;
      };
    };

// ─────────────────────────────────────────────────────────────────────
// ToolRouter
// ─────────────────────────────────────────────────────────────────────

export interface ToolRouterOpts {
  /**
   * Allowlist of MCP server IDs whose tools can run in parallel
   * within a batch. Mirrors codex `parallel_mcp_server_names`
   * (router.rs:42). Empty by default = MCP tools serialize per server.
   * T9 wires from config.
   */
  readonly parallelMcpServerNames?: ReadonlySet<string>;
}

/**
 * Codex `ToolRouterParams` (router.rs:45-52). Builder-style input for
 * `ToolRouter.fromConfig(...)`. AgenC accepts the subset it can
 * materialize today — `unavailableCalledTools` is retained as opaque
 * tool-name list so the registry can filter on it.
 */
export interface ToolRouterFromConfigOpts {
  readonly baseSpecs?: ReadonlyArray<ConfiguredToolSpec>;
  readonly mcpTools?: ReadonlyMap<string, Tool>;
  readonly deferredMcpTools?: ReadonlyMap<string, Tool>;
  readonly unavailableCalledTools?: ReadonlyArray<string>;
  readonly discoverableTools?: ReadonlyArray<Tool>;
  readonly dynamicTools?: ReadonlyArray<Tool>;
  readonly parallelMcpServerNames?: ReadonlySet<string>;
}

export class ToolRouter {
  private readonly specs: ConfiguredToolSpec[];
  private readonly byName = new Map<string, ConfiguredToolSpec>();
  private readonly parallelMcpServerNames: ReadonlySet<string>;

  constructor(
    specs: ReadonlyArray<ConfiguredToolSpec>,
    opts: ToolRouterOpts = {},
  ) {
    this.specs = [...specs];
    for (const spec of this.specs) this.byName.set(spec.tool.name, spec);
    this.parallelMcpServerNames = opts.parallelMcpServerNames ?? new Set();
  }

  /**
   * Port of codex `ToolRouter::from_config` (router.rs:55-97). Merges
   * the 5 codex input slots into one spec list with a consistent
   * priority:
   *
   *   1. `baseSpecs` (typically from the local tool registry)
   *   2. `mcpTools`
   *   3. `deferredMcpTools` (flagged `deferred: true`)
   *   4. `discoverableTools` (flagged `discoverable: true`)
   *   5. `dynamicTools` (flagged `dynamic: true`)
   *
   * Tools named in `unavailableCalledTools` are retained but flagged
   * `unavailable: true`. Later additions override earlier ones on name
   * collision (matches codex spec-build ordering).
   */
  static fromConfig(opts: ToolRouterFromConfigOpts): ToolRouter {
    const unavailable = new Set(opts.unavailableCalledTools ?? []);
    const merged = new Map<string, ConfiguredToolSpec>();

    const addTool = (
      tool: Tool,
      flags: Partial<ConfiguredToolSpec> = {},
    ): void => {
      const supportsParallelToolCalls =
        (tool as Tool & { supportsParallelToolCalls?: boolean })
          .supportsParallelToolCalls ?? false;
      const spec: ConfiguredToolSpec = {
        tool,
        supportsParallelToolCalls,
        ...((tool as Tool & { serverId?: string }).serverId !== undefined
          ? { serverId: (tool as Tool & { serverId?: string }).serverId }
          : {}),
        ...(tool.metadata?.deferred === true ? { deferred: true } : {}),
        ...(unavailable.has(tool.name) ? { unavailable: true } : {}),
        ...flags,
      };
      merged.set(tool.name, spec);
    };

    for (const base of opts.baseSpecs ?? []) {
      merged.set(base.tool.name, {
        ...base,
        ...(unavailable.has(base.tool.name) ? { unavailable: true } : {}),
      });
    }
    if (opts.mcpTools) {
      for (const tool of opts.mcpTools.values()) addTool(tool);
    }
    if (opts.deferredMcpTools) {
      for (const tool of opts.deferredMcpTools.values())
        addTool(tool, { deferred: true });
    }
    for (const tool of opts.discoverableTools ?? []) {
      addTool(tool, { discoverable: true });
    }
    for (const tool of opts.dynamicTools ?? []) {
      addTool(tool, { dynamic: true });
    }

    const parallelOpts: ToolRouterOpts = opts.parallelMcpServerNames
      ? { parallelMcpServerNames: opts.parallelMcpServerNames }
      : {};
    return new ToolRouter(Array.from(merged.values()), parallelOpts);
  }

  /** All registered configured-tool specs. */
  getSpecs(): ReadonlyArray<ConfiguredToolSpec> {
    return this.specs;
  }

  /** LLMTool array for provider requests. Deferred tools are hidden
   *  (loaded on-demand via ToolSearch) to match codex behavior. */
  modelVisibleSpecs(): ReadonlyArray<LLMTool> {
    return this.specs
      .filter((config) => config.deferred !== true)
      .map((config) => ({
        type: "function",
        function: {
          name: config.tool.name,
          description: config.tool.description,
          parameters: config.tool.inputSchema,
        },
      }));
  }

  /**
   * Look up a single spec. Port of codex `ToolRouter::find_spec`
   * (router.rs:110-133).
   *
   * Codex matches by walking specs:
   *   - `ToolSpec::Function(tool)`  — only when `tool_name.namespace.is_none()`
   *     and `tool.name == tool_name.name`
   *   - `ToolSpec::Freeform(tool)`  — same
   *   - `ToolSpec::Namespace(ns)`   — only when
   *     `tool_name.namespace == Some(ns.name)` and an inner tool
   *     matches by `tool.name`
   *
   * AgenC stores both kinds in the flat `byName` map — MCP tools are
   * flagged with `serverId`. The port preserves codex's exclusion:
   *
   *   1. A request with no namespace resolves only to specs whose
   *      `serverId` is not set (plain function/freeform). A dotted
   *      storage key like `"a.b"` from an MCP umbrella entry must not
   *      match a bare `{name: "a.b"}` request.
   *   2. A request with a namespace (e.g. `{namespace: "server", name: "tool"}`)
   *      resolves either by the canonical MCP flat storage form
   *      `"server.tool"` when the stored entry carries `serverId === "server"`,
   *      or by the AgenC legacy flat dotted key lookup when no
   *      MCP-server match exists.
   *
   * Accepts either a `ToolName` struct or a string. A string is parsed
   * via `parseToolName` — which splits on the first dot, so
   * `"system.readFile"` becomes `{namespace: "system", name: "readFile"}`
   * and uses the namespaced path below.
   */
  findSpec(toolName: ToolName | string): ConfiguredToolSpec | undefined {
    const parsed: ToolName =
      typeof toolName === "string" ? parseToolName(toolName) : toolName;
    const ns = parsed.namespace;
    if (ns === undefined) {
      // Plain function/freeform lookup. Codex router.rs:111-121 only
      // matches `ToolSpec::Function` or `ToolSpec::Freeform`, never a
      // namespace tool. AgenC flag: `serverId === undefined` means the
      // spec is not an MCP umbrella, so it's safe to return.
      const spec = this.byName.get(parsed.name);
      if (spec === undefined) return undefined;
      if (spec.serverId !== undefined) return undefined;
      return spec;
    }
    // Namespaced lookup. Codex router.rs:122-131 only accepts a
    // `ToolSpec::Namespace` spec with matching `namespace.name`. In
    // AgenC, MCP tools live in the flat map under `serverId.name` with
    // `serverId === namespace`. Try the dotted storage key first, then
    // fall back to a bare `name` lookup whose entry's `serverId`
    // matches the request's namespace (defensive — catches MCP tools
    // registered under the bare inner name).
    const dotted = `${ns}.${parsed.name}`;
    const dottedSpec = this.byName.get(dotted);
    if (dottedSpec !== undefined) return dottedSpec;
    const bare = this.byName.get(parsed.name);
    if (bare !== undefined && bare.serverId === ns) return bare;
    return undefined;
  }

  /**
   * Port of codex `tool_supports_parallel` (router.rs:142-169).
   *
   *   - MCP tools: parallel iff the owning server is in the allowlist.
   *   - Namespaced tool names (`tool_name.namespace.is_some()`): hard
   *     `false` regardless of the spec flag. Matches codex
   *     `configured_tool_supports_parallel` (router.rs:142-145).
   *   - Non-Function/Freeform spec kinds: codex hard-codes `false` for
   *     `ToolSpec::Namespace | ToolSpec::ToolSearch | ToolSpec::LocalShell |
   *     ToolSpec::ImageGeneration | ToolSpec::WebSearch` (router.rs:
   *     150-158). AgenC detects these by spec shape — any spec whose
   *     `tool.name` matches a forbidden built-in returns `false`.
   *   - Everything else: honor the registered spec's
   *     `supportsParallelToolCalls` flag.
   */
  toolSupportsParallel(call: ToolCall): boolean {
    if (call.payload.kind === "mcp") {
      return this.parallelMcpServerNames.has(call.payload.server);
    }
    // Namespaced tool names can never parallelize — codex parity
    // (router.rs:142-145). Checked BEFORE spec lookup so a namespace-
    // flagged call never leaks a true via the underlying spec's
    // `supportsParallelToolCalls` flag.
    if (call.toolName.namespace !== undefined) {
      return false;
    }
    const spec = this.findSpec(call.toolName);
    if (spec === undefined) return false;
    if (!spec.supportsParallelToolCalls) return false;
    // Hard-false list — spec variants codex forbids from parallel:
    // Namespace / ToolSearch / LocalShell / ImageGeneration / WebSearch
    // (router.rs:150-158). AgenC carries these as plain tool entries
    // rather than a ToolSpec union, so guard by the canonical name.
    if (isNonParallelSpecTool(spec.tool.name)) return false;
    return true;
  }

  /**
   * Dispatch a ToolCall. Returns the raw ToolDispatchResult from the
   * underlying Tool's `execute` method. Higher-level timeout / size-cap
   * / hook wrapping lives in `tools/execution.ts`.
   */
  async dispatchToolCall(
    invocation: ToolInvocation,
    args: Record<string, unknown>,
  ): Promise<ToolDispatchResult> {
    const spec = this.findSpec(invocation.toolName);
    if (!spec) {
      return {
        content: JSON.stringify({
          error: `unknown tool: ${
            invocation.toolName.namespace
              ? `${invocation.toolName.namespace}.${invocation.toolName.name}`
              : invocation.toolName.name
          }`,
        }),
        isError: true,
      };
    }
    try {
      const result = await spec.tool.execute(args);
      return { content: result.content, isError: result.isError };
    } catch (err) {
      return {
        content: JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
        isError: true,
      };
    }
  }

  /**
   * Port of codex `dispatch_tool_call_with_code_mode_result`
   * (router.rs:266-302). When `source === "code_mode"`, restrict
   * dispatch to the JS-REPL-safe subset (`js_repl` / `js_repl_reset`);
   * anything else returns an error result the model can observe. All
   * other sources delegate to `dispatchToolCall`.
   */
  async dispatchToolCallWithCodeMode(
    invocation: ToolInvocation,
    args: Record<string, unknown>,
    source: ToolCallSource,
  ): Promise<ToolDispatchResult> {
    if (source === "code_mode" && !isCodeModeSafeTool(invocation.toolName)) {
      return {
        content: JSON.stringify({
          error:
            "direct tool calls are disabled in code_mode; use js_repl and codex.tool(...) instead",
        }),
        isError: true,
      };
    }
    return this.dispatchToolCall(invocation, args);
  }

  async dispatchModelToolCall(
    toolCall: LLMToolCall,
    opts: LiveToolDispatchOptions,
  ): Promise<ToolDispatchResult> {
    const routed = toolCallFromLLMToolCall(toolCall, { session: opts.session });

    const spec = this.findSpec(toolCall.name);
    if (!spec) {
      return {
        content: JSON.stringify({ error: `unknown tool: ${toolCall.name}` }),
        isError: true,
      };
    }

    const invocation: ToolInvocation = {
      session: opts.session,
      turn: opts.turn,
      tracker: opts.tracker,
      callId: toolCall.id,
      toolName: parseToolName(toolCall.name),
      payload: routed.payload,
      source: opts.source ?? "direct",
    };
    const approvalCtx: ApprovalCtx = {
      invocation,
      callId: toolCall.id,
      toolName: toolCall.name,
      turnId: opts.turn.subId,
    };
    const rawArgs = rawPayloadArguments(routed.payload);
    const parsedArgs = parseToolArgsWithBigInt(rawArgs) ?? {};

    const toolAbortController = new AbortController();
    const forwardAbort = (): void => {
      if (toolAbortController.signal.aborted) return;
      try {
        toolAbortController.abort(
          (opts.signal as AbortSignal & { reason?: unknown } | undefined)?.reason,
        );
      } catch {
        // already aborted
      }
    };
    if (opts.signal?.aborted) {
      forwardAbort();
    } else if (opts.signal) {
      opts.signal.addEventListener("abort", forwardAbort, { once: true });
    }

    // Upstream codex `tools/registry.rs:303-309` — increment the
    // per-turn `tool_calls` counter under the `ActiveTurnState` lock
    // before dispatching the handler. Saturating-add semantics (caps
    // at Number.MAX_SAFE_INTEGER) mirror upstream `saturating_add(1)`.
    // Duck-typed call: router tests pass a mock `session` without the
    // ActiveTurnState lock plumbing; treat the absence of the helper
    // as a no-op so test fixtures keep working.
    const withActiveTurnState = (
      opts.session as unknown as {
        withActiveTurnState?: (
          fn: (state: { toolCalls: number }) => void,
        ) => Promise<unknown>;
      }
    ).withActiveTurnState;
    if (typeof withActiveTurnState === "function") {
      await withActiveTurnState.call(opts.session, (state) => {
        const next = state.toolCalls + 1;
        state.toolCalls = Number.isSafeInteger(next)
          ? next
          : Number.MAX_SAFE_INTEGER;
      });
    }

    try {
      return await orchestrateToolCall({
        tool: spec.tool,
        approvalCtx,
        approvalPolicy: opts.approvalPolicy,
        sandboxMode: opts.sandboxMode,
        payload: routed.payload,
        approvalArgs: parsedArgs,
        ...(opts.granular !== undefined ? { granular: opts.granular } : {}),
        ...(opts.permissionHooks !== undefined
          ? { permissionHooks: opts.permissionHooks }
          : {}),
        ...(opts.permissionDecisionHooks !== undefined
          ? { permissionDecisionHooks: opts.permissionDecisionHooks }
          : {}),
        ...(opts.approvalResolver !== undefined
          ? { approvalResolver: opts.approvalResolver }
          : {}),
        onNoApprovalResolver: (ctx) => {
          emitWarningEvent(
            opts.session.eventLog,
            toolCall.id,
            "no_approval_resolver",
            `tool ${toolCall.name} needs approval but no resolver is registered`,
          );
          void ctx;
        },
        dispatch: async () =>
          executeToolDispatch(rawDispatchOptions(rawArgs, {
            ...opts,
            tool: spec.tool,
            invocation,
            abortController: toolAbortController,
            subId: toolCall.id,
          })),
      });
    } catch (err) {
      return toolDispatchErrorResult(err);
    } finally {
      opts.signal?.removeEventListener("abort", forwardAbort);
    }
  }

  /**
   * Port of codex `ToolRouter::create_diff_consumer` (router.rs:135).
   * Returns a consumer the tool execution flow can call to record
   * pre-hook arguments and compare post-hook arguments — used to
   * surface argument rewrites in telemetry.
   *
   * Intentionally minimal: the consumer keeps an in-memory map keyed
   * by argument-name; `.compare(name, after)` runs a line-diff against
   * the previously recorded `before`. Matches codex
   * `ToolArgumentDiffConsumer` in scope (not in shape).
   */
  createDiffConsumer(toolName: ToolName | string): ToolArgumentDiffConsumer {
    return createDiffConsumer(
      typeof toolName === "string" ? toolName : nameDisplay(toolName),
    );
  }
}

function rawPayloadArguments(payload: ToolPayload): string {
  switch (payload.kind) {
    case "function":
      return payload.arguments;
    case "custom":
      return payload.input;
    case "tool_search":
      return JSON.stringify(payload.arguments);
    case "local_shell":
      return JSON.stringify(payload.params);
    case "mcp":
      return payload.rawArguments;
  }
}

function rawDispatchOptions(
  rawArgs: string,
  opts: LiveToolDispatchOptions & {
    readonly tool: Tool;
    readonly invocation: ToolInvocation;
    readonly abortController: AbortController;
    readonly subId: string;
  },
) {
  return {
    rawArgs,
    signal: opts.abortController.signal,
    currentTurnId: opts.turn.subId,
    eventLog: opts.session.eventLog,
    subId: opts.subId,
    tool: opts.tool,
    invocation: opts.invocation,
    ...(opts.preHooks !== undefined ? { preHooks: opts.preHooks } : {}),
    ...(opts.postHooks !== undefined ? { postHooks: opts.postHooks } : {}),
    ...(opts.failureHooks !== undefined ? { failureHooks: opts.failureHooks } : {}),
    ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
    ...(opts.canUseTool !== undefined ? { canUseTool: opts.canUseTool } : {}),
    ...(opts.permissionContext !== null &&
    opts.permissionContext !== undefined
      ? { permissionContext: opts.permissionContext }
      : {}),
    ...(opts.modeChangeRegistry !== undefined
      ? { modeChangeRegistry: opts.modeChangeRegistry }
      : {}),
    ...(opts.discoveredToolNames !== undefined
      ? { discoveredToolNames: opts.discoveredToolNames }
      : {}),
    ...(opts.approvalResolver !== undefined
      ? {
          requestApproval: approvalRequestFromResolver(
            opts.invocation,
            opts.approvalResolver,
          ),
        }
      : {}),
    abortController: opts.abortController,
    ...(opts.onHookError !== undefined ? { onHookError: opts.onHookError } : {}),
  };
}

function approvalRequestFromResolver(
  invocation: ToolInvocation,
  resolver: ApprovalResolver,
): ApprovalRequestFn {
  return async ({
    currentTurnId,
    signal,
  }): Promise<ModalDecision> => {
    const reviewDecision = await resolver.request({
      invocation,
      callId: invocation.callId,
      toolName: nameDisplay(invocation.toolName),
      turnId: currentTurnId,
      signal,
    });
    return {
      behavior: reviewDecisionIsAllow(reviewDecision)
        ? "allow"
        : reviewDecision.kind === "abort"
          ? "abort"
          : "deny",
      decisionAtTurnId: currentTurnId,
      reviewDecision,
    };
  };
}

function toolDispatchErrorResult(err: unknown): ToolDispatchResult {
  if (err instanceof ApprovalRejectedError) {
    return {
      content: JSON.stringify({ error: err.message }),
      isError: true,
    };
  }
  return {
    content: JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    }),
    isError: true,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Convenience: build a ToolRouter from an existing ToolRegistry.
// ─────────────────────────────────────────────────────────────────────

/**
 * Bridges the existing `ToolRegistry` (tool-registry.ts) into a
 * `ToolRouter` — the router subsumes the registry's dispatch surface
 * and adds parallel-support classification. T7-C updates the
 * registry to tag each tool with the flag.
 */
export function routerFromRegistry(
  registry: ToolRegistry,
  opts: ToolRouterOpts = {},
): ToolRouter {
  const specs: ConfiguredToolSpec[] = registry.tools.map((tool) => ({
    tool,
    supportsParallelToolCalls:
      (tool as Tool & { supportsParallelToolCalls?: boolean })
        .supportsParallelToolCalls ?? false,
    ...((tool as Tool & { serverId?: string }).serverId !== undefined
      ? { serverId: (tool as Tool & { serverId?: string }).serverId }
      : {}),
  }));
  return new ToolRouter(specs, opts);
}

// ─────────────────────────────────────────────────────────────────────
// Helpers: build a ToolCall envelope.
// ─────────────────────────────────────────────────────────────────────

/**
 * Convert an incoming LLMToolCall into the ToolCall envelope the
 * router expects. MCP routing flows through
 * `session.services.mcpManager.resolveMcpToolInfo(toolName)` when a
 * session is provided; the previous `namespace.startsWith("mcp")`
 * heuristic is retained only as a no-session fallback for tests and
 * legacy call sites.
 */
export function toolCallFromLLMToolCall(
  llmCall: LLMToolCall,
  opts: { readonly source?: ToolCallSource; readonly session?: SessionLike } = {},
): ToolCall {
  const args = llmCall.arguments ?? "";
  const mcpInfo = opts.session?.services?.mcpManager?.resolveMcpToolInfo?.(
    llmCall.name,
  );
  if (mcpInfo) {
    return {
      toolName: { namespace: mcpInfo.serverName, name: mcpInfo.toolName },
      callId: llmCall.id,
      payload: {
        kind: "mcp",
        server: mcpInfo.serverName,
        tool: mcpInfo.toolName,
        rawArguments: args,
      },
    };
  }
  const toolName = parseToolName(llmCall.name);
  // Legacy fallback for callers without a session bound — keeps
  // existing tests happy until every call site passes `session`.
  const payload: ToolPayload =
    opts.session === undefined && toolName.namespace?.startsWith("mcp")
      ? {
          kind: "mcp",
          server: toolName.namespace ?? "",
          tool: toolName.name,
          rawArguments: args,
        }
      : { kind: "function", arguments: args };
  return {
    toolName,
    callId: llmCall.id,
    payload,
  };
}

/**
 * Port of codex `ToolRouter::build_tool_call` (router.rs:172-263).
 * Inspects `item.type` and produces the right ToolCall envelope for
 * each of the four ResponseItem variants. Returns `null` when the
 * item is not a tool call (codex returns `Ok(None)`) or when the
 * tool_search_call was not client-executed.
 *
 * MCP attribution is resolved through
 * `session.services.mcpManager.resolveMcpToolInfo(...)` — free of the
 * `namespace.startsWith("mcp")` heuristic.
 */
export async function buildToolCall(
  session: SessionLike | undefined,
  item: RouterResponseItem,
): Promise<ToolCall | null> {
  switch (item.type) {
    case "function_call": {
      const fullName = item.namespace
        ? `${item.namespace}.${item.name}`
        : item.name;
      const mcpInfo = session?.services?.mcpManager?.resolveMcpToolInfo?.(
        fullName,
      );
      if (mcpInfo) {
        return {
          toolName: { namespace: mcpInfo.serverName, name: mcpInfo.toolName },
          callId: item.callId,
          payload: {
            kind: "mcp",
            server: mcpInfo.serverName,
            tool: mcpInfo.toolName,
            rawArguments: item.arguments,
          },
        };
      }
      return {
        toolName: item.namespace
          ? { namespace: item.namespace, name: item.name }
          : { name: item.name },
        callId: item.callId,
        payload: { kind: "function", arguments: item.arguments },
      };
    }
    case "tool_search_call": {
      if (item.callId === undefined) return null;
      if (item.execution !== undefined && item.execution !== "client") {
        return null;
      }
      const parsed = parseToolSearchArguments(item.arguments);
      if (!parsed) return null;
      return {
        toolName: { name: "tool_search" },
        callId: item.callId,
        payload: { kind: "tool_search", arguments: parsed },
      };
    }
    case "custom_tool_call":
      return {
        toolName: { name: item.name },
        callId: item.callId,
        payload: { kind: "custom", input: item.input },
      };
    case "local_shell_call": {
      const callId = item.callId ?? item.id;
      if (callId === undefined) return null;
      if (item.action.type !== "exec") return null;
      const params: Extract<ToolPayload, { kind: "local_shell" }>["params"] = {
        command: item.action.command,
        ...(item.action.workingDirectory !== undefined
          ? { cwd: item.action.workingDirectory }
          : {}),
        ...(item.action.timeoutMs !== undefined
          ? { timeoutMs: item.action.timeoutMs }
          : {}),
      };
      return {
        toolName: { name: "local_shell" },
        callId,
        payload: { kind: "local_shell", params },
      };
    }
  }
}

function parseToolSearchArguments(
  raw: { readonly query: string } | string,
): { readonly query: string } | null {
  if (typeof raw === "object" && raw && typeof raw.query === "string") {
    return { query: raw.query };
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as { query?: unknown };
      if (parsed && typeof parsed.query === "string") {
        return { query: parsed.query };
      }
    } catch {
      // fallthrough
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Non-parallel spec variants — codex router.rs:150-158 hard-false list.
// ─────────────────────────────────────────────────────────────────────

/**
 * Tool names corresponding to codex `ToolSpec` variants that codex
 * hard-codes as non-parallel in `configured_tool_supports_parallel`:
 *
 *   - `ToolSpec::Namespace(_)`        — MCP umbrella (handled by name/
 *     serverId above; listed here for spec-registry entries that carry
 *     the umbrella tool-name directly)
 *   - `ToolSpec::ToolSearch { .. }`   — `tool_search`
 *   - `ToolSpec::LocalShell {}`       — `local_shell`
 *   - `ToolSpec::ImageGeneration`     — `image_generation`
 *   - `ToolSpec::WebSearch`           — `web_search`
 *
 * Any tool registered under one of these names returns `false` from
 * `toolSupportsParallel` regardless of its own
 * `supportsParallelToolCalls` flag.
 */
const NON_PARALLEL_SPEC_TOOL_NAMES: ReadonlySet<string> = new Set([
  "tool_search",
  "local_shell",
  "image_generation",
  "web_search",
]);

function isNonParallelSpecTool(toolName: string): boolean {
  return NON_PARALLEL_SPEC_TOOL_NAMES.has(toolName);
}

// ─────────────────────────────────────────────────────────────────────
// code_mode safety — restricted-tool set
// ─────────────────────────────────────────────────────────────────────

/**
 * Direct tool set permitted when `source === "code_mode"`. Matches
 * codex router.rs:281 (`matches!(tool_name.name.as_str(), "js_repl" |
 * "js_repl_reset")`). Code-mode callers go through `js_repl` and the
 * JS runner's `codex.tool(...)` bridge for everything else.
 */
const CODE_MODE_SAFE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "js_repl",
  "js_repl_reset",
]);

export function isCodeModeSafeTool(toolName: ToolName): boolean {
  if (toolName.namespace !== undefined) return false;
  return CODE_MODE_SAFE_TOOL_NAMES.has(toolName.name);
}

// ─────────────────────────────────────────────────────────────────────
// Tool-argument diff consumer
// ─────────────────────────────────────────────────────────────────────

export interface ToolArgumentDiffConsumer {
  readonly toolName: string;
  record(name: string, before: string): void;
  compare(name: string, after: string): string | null;
  snapshot(): ReadonlyArray<{
    readonly name: string;
    readonly before: string;
    readonly after: string;
    readonly diff: string;
  }>;
}

function createDiffConsumer(toolName: string): ToolArgumentDiffConsumer {
  const pending = new Map<string, string>();
  const entries: Array<{
    name: string;
    before: string;
    after: string;
    diff: string;
  }> = [];

  return {
    toolName,
    record(name, before) {
      pending.set(name, before);
    },
    compare(name, after) {
      const before = pending.get(name);
      if (before === undefined) return null;
      pending.delete(name);
      if (before === after) return "";
      const diff = computeLineDiff(before, after);
      entries.push({ name, before, after, diff });
      return diff;
    },
    snapshot() {
      return [...entries];
    },
  };
}

/**
 * Free-function export of `createDiffConsumer` so callers outside the
 * router (tool execution pipeline) can instantiate one per
 * invocation. Shape matches `ToolRouter.createDiffConsumer`.
 */
export { createDiffConsumer };

/**
 * Minimal unified line-diff. One `-` line per removed line, one `+`
 * line per added line. Lines that appear in both keep a leading space.
 * The implementation is O(n*m) LCS which is fine for short argument
 * strings — the point is to have the seam live, not to compete with
 * `diff` libraries.
 */
function computeLineDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) {
        lcs[i]![j] = (lcs[i + 1]?.[j + 1] ?? 0) + 1;
      } else {
        lcs[i]![j] = Math.max(
          lcs[i + 1]?.[j] ?? 0,
          lcs[i]?.[j + 1] ?? 0,
        );
      }
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i += 1;
      j += 1;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      out.push(`-${a[i]}`);
      i += 1;
    } else {
      out.push(`+${b[j]}`);
      j += 1;
    }
  }
  while (i < n) {
    out.push(`-${a[i]}`);
    i += 1;
  }
  while (j < m) {
    out.push(`+${b[j]}`);
    j += 1;
  }
  return out.join("\n");
}

function nameDisplay(name: ToolName): string {
  return name.namespace ? `${name.namespace}.${name.name}` : name.name;
}
