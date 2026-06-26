/**
 * Subset port of donor runtime `core/src/tools/router.rs`.
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
 *     (donor runtime router.rs:280-290) — AgenC exposes the code-mode filter
 *     through `dispatchToolCallWithCodeMode` instead; the
 *     per-turn-context gate lands with the JsRepl subsystem.
 *   - `DiscoverableTool` materialization into actual `Tool` objects
 *     beyond spec carrying.
 *
 * @module
 */

import { dirname, isAbsolute, resolve } from "node:path";
import type { LLMTool, LLMToolCall } from "../llm/types.js";
import type { ToolDispatchResult, ToolRegistry } from "../tool-registry.js";
import {
  emitError as emitErrorEvent,
  emitWarning as emitWarningEvent,
} from "../session/event-log.js";
import type { Session } from "../session/session.js";
import type { GuardianApprovalReviewer } from "../permissions/guardian/reviewer.js";
import { arbitratePermissionMode } from "../permissions/guardian/arbiter.js";
import type { Policy } from "../sandbox/execpolicy/policy.js";
import type { TurnContext } from "../session/turn-context.js";
import { modelContextWindow } from "../session/turn-context.js";
import type {
  CanUseToolFn,
  ToolEvaluatorContext,
} from "../permissions/evaluator.js";
import type { PermissionModeRegistry } from "../permissions/permission-mode.js";
import { reviewDecisionIsAllow } from "../permissions/review-decision.js";
import { isRecord } from "../utils/record.js";
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
  HookPermissionResult,
  MergedHookPermissionDecision,
  PermissionDecisionHook,
  PostToolUseFailureHook,
  PostToolUseHook,
  PreToolUseHook,
} from "./hooks.js";
import { runPreToolUseHooks } from "./hooks.js";
import {
  recordPermissionAuditEvent,
  type PermissionAuditErrorHandler,
  type PermissionAuditLogger,
} from "../permissions/permission-audit-log.js";
import {
  getPlan,
  getPlanFilePath,
  type PlanFileContext,
} from "../planning/plan-files.js";
import { markLoadedToolNamesDiscovered } from "./deferred-discovery.js";
import { canonicalModelToolName } from "./model-tool-aliases.js";
import {
  buildToolRuntimeAttemptContext,
  buildToolRuntimeCallContext,
  type ToolRuntimeAttemptContext,
} from "./runtimes/context.js";
import { withSignedAllowedRoots } from "./system/filesystem.js";

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
   *  entry (donor runtime `DiscoverableTool`). */
  readonly discoverable?: boolean;
  /** When true, the tool was injected as a runtime dynamic spec
   *  (donor runtime `DynamicToolSpec`). */
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
  readonly abortController?: AbortController;
  readonly source?: ToolCallSource;
  readonly approvalPolicy: ApprovalPolicy;
  readonly sandboxMode: SandboxMode;
  readonly execPolicy?: Policy;
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
  readonly guardianApprovalReviewer?: GuardianApprovalReviewer;
  readonly approvalResolver?: ApprovalResolver;
  readonly permissionAuditLogger?: PermissionAuditLogger;
  readonly onPermissionAuditError?: PermissionAuditErrorHandler;
  readonly toolAllowlist?: ReadonlySet<string>;
  readonly toolDenylist?: ReadonlySet<string>;
  readonly preHooks?: ReadonlyArray<PreToolUseHook>;
  readonly postHooks?: ReadonlyArray<PostToolUseHook>;
  readonly failureHooks?: ReadonlyArray<PostToolUseFailureHook>;
  readonly canUseTool?: CanUseToolFn;
  readonly permissionContext?: ToolEvaluatorContext | null;
  readonly modeChangeRegistry?: PermissionModeRegistry;
  readonly discoveredToolNames?: ReadonlySet<string>;
  readonly agencHome?: string;
  readonly onProgress?: ToolProgressCallback;
  readonly onHookError?: (
    phase: "pre" | "post" | "failure",
    err: unknown,
    idx: number,
  ) => void;
  readonly onHookAdditionalContext?: (contexts: readonly string[]) => void;
}

export interface DirectToolDispatchOptions {
  readonly approvalPolicy?: ApprovalPolicy;
  readonly sandboxMode?: SandboxMode;
  readonly execPolicy?: Policy;
  readonly granular?: GranularApprovalConfig;
  readonly permissionHooks?: ReadonlyArray<PermissionRequestHook>;
  readonly permissionDecisionHooks?: ReadonlyArray<PermissionDecisionHook>;
  readonly guardianApprovalReviewer?: GuardianApprovalReviewer;
  readonly approvalResolver?: ApprovalResolver;
  readonly canUseTool?: CanUseToolFn;
  readonly permissionContext?: ToolEvaluatorContext | null;
  readonly permissionAuditLogger?: PermissionAuditLogger;
  readonly onPermissionAuditError?: PermissionAuditErrorHandler;
  readonly toolAllowlist?: ReadonlySet<string>;
  readonly toolDenylist?: ReadonlySet<string>;
  readonly signal?: AbortSignal;
}

// ─────────────────────────────────────────────────────────────────────
// ResponseItem input union for `buildToolCall`.
//
// Mirrors the 4 donor runtime `ResponseItem` variants the router consumes.
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
   * within a batch. Mirrors donor runtime `parallel_mcp_server_names`
   * (router.rs:42). Empty by default = MCP tools serialize per server.
   * T9 wires from config.
   */
  readonly parallelMcpServerNames?: ReadonlySet<string>;
}

/**
 * donor runtime `ToolRouterParams` (router.rs:45-52). Builder-style input for
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
   * Port of donor runtime `ToolRouter::from_config` (router.rs:55-97). Merges
   * the 5 donor runtime input slots into one spec list with a consistent
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
   * collision (matches donor runtime spec-build ordering).
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
   *  (loaded on-demand via ToolSearch) to match donor runtime behavior. */
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
   * Look up a single spec. Port of donor runtime `ToolRouter::find_spec`
   * (router.rs:110-133).
   *
   * donor runtime matches by walking specs:
   *   - `ToolSpec::Function(tool)`  — only when `tool_name.namespace.is_none()`
   *     and `tool.name == tool_name.name`
   *   - `ToolSpec::Freeform(tool)`  — same
   *   - `ToolSpec::Namespace(ns)`   — only when
   *     `tool_name.namespace == Some(ns.name)` and an inner tool
   *     matches by `tool.name`
   *
   * AgenC stores both kinds in the flat `byName` map — MCP tools are
   * flagged with `serverId`. The port preserves donor runtime's exclusion:
   *
   *   1. A request with no namespace resolves only to specs whose
   *      `serverId` is not set (plain function/freeform). A dotted
   *      storage key like `"a.b"` from an MCP umbrella entry must not
   *      match a bare `{name: "a.b"}` request.
   *   2. A request with a namespace (e.g. `{namespace: "server", name: "tool"}`)
   *      resolves either by the canonical MCP flat storage form
   *      `"server.tool"` when the stored entry carries `serverId === "server"`,
   *      or by the AgenC compatibility flat dotted key lookup when no
   *      MCP-server match exists.
   *
   * Accepts either a `ToolName` struct or a string. A string is parsed
   * via `parseToolName` — which splits on the first dot, so
   * `"FileRead"` becomes `{namespace: "system", name: "readFile"}`
   * and uses the namespaced path below.
   */
  findSpec(toolName: ToolName | string): ConfiguredToolSpec | undefined {
    const parsed: ToolName =
      typeof toolName === "string" ? parseToolName(toolName) : toolName;
    const ns = parsed.namespace;
    if (ns === undefined) {
      // Plain function/freeform lookup. donor runtime router.rs:111-121 only
      // matches `ToolSpec::Function` or `ToolSpec::Freeform`, never a
      // namespace tool. AgenC flag: `serverId === undefined` means the
      // spec is not an MCP umbrella, so it's safe to return.
      const spec = this.byName.get(parsed.name);
      if (spec === undefined) return undefined;
      if (spec.serverId !== undefined) return undefined;
      return spec;
    }
    // Namespaced lookup. donor runtime router.rs:122-131 only accepts a
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
   * Port of donor runtime `tool_supports_parallel` (router.rs:142-169).
   *
   *   - MCP tools: parallel iff the owning server is in the allowlist.
   *   - Namespaced tool names (`tool_name.namespace.is_some()`): hard
   *     `false` regardless of the spec flag. Matches donor runtime
   *     `configured_tool_supports_parallel` (router.rs:142-145).
   *   - Non-Function/Freeform spec kinds: donor runtime hard-codes `false` for
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
    // Namespaced tool names can never parallelize — AgenC behavior
    // (router.rs:142-145). Checked BEFORE spec lookup so a namespace-
    // flagged call never leaks a true via the underlying spec's
    // `supportsParallelToolCalls` flag.
    if (call.toolName.namespace !== undefined) {
      return false;
    }
    const spec = this.findSpec(call.toolName);
    if (spec === undefined) return false;
    if (!spec.supportsParallelToolCalls) return false;
    // Hard-false list — spec variants donor runtime forbids from parallel:
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
    opts: DirectToolDispatchOptions = {},
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
      // SECURITY: strip any `__agenc*` keys reaching this dispatch
      // boundary (e.g. code_mode js_repl helper calls). These are a
      // TRUSTED INTERNAL channel for runtime-injected filesystem scoping
      // and must never be supplied by the model; runtime values are
      // merged in later (execution.ts / withApprovedFilesystemRoot).
      let executionArgs = stripModelSuppliedAgenCInternalArgs(args);
      let forcedApprovalReason: string | undefined;
      let permissionAlreadyAllowed = false;
      if (opts.canUseTool !== undefined && opts.permissionContext !== undefined) {
        const permissionDecision = await arbitratePermissionMode({
          tool: spec.tool,
          args: executionArgs,
          canUseTool: opts.canUseTool,
          permissionContext: opts.permissionContext,
        });
        if (permissionDecision.kind === "deny") {
          return {
            content: permissionDecision.message ?? "Permission denied",
            isError: true,
          };
        }
        if (permissionDecision.kind === "ask") {
          executionArgs = permissionDecision.args;
          forcedApprovalReason =
            permissionDecision.message ?? "permission mode requested approval";
        } else if (permissionDecision.kind === "allow") {
          executionArgs = permissionDecision.args;
          permissionAlreadyAllowed = true;
        }
      }
      const effectiveApprovalPolicy = permissionAlreadyAllowed
        ? "never"
        : forcedApprovalReason !== undefined
          ? "untrusted"
          : opts.approvalPolicy ?? directDispatchApprovalPolicy(invocation);
      const requestedSandboxMode =
        opts.sandboxMode ?? directDispatchSandboxMode(invocation);
      const executionPayload = buildPayloadForArgs(invocation.payload, executionArgs);
      const executionInvocation: ToolInvocation = {
        ...invocation,
        payload: executionPayload,
      };
      const activeExecPolicy =
        opts.execPolicy ?? currentExecPolicyFromSession(executionInvocation.session);
      const executionRawArgs = stringifyToolArgsWithBigInt(executionArgs);
      const runtimeCallContext = buildToolRuntimeCallContext({
        toolCall: {
          id: invocation.callId,
          name: nameDisplay(invocation.toolName),
        },
        payload: executionPayload,
        tool: spec.tool,
        args: executionArgs,
        source: invocation.source,
        supportsParallelToolCalls: spec.supportsParallelToolCalls,
      });
      return await orchestrateToolCall({
        tool: spec.tool,
        approvalCtx: {
          invocation: executionInvocation,
          callId: invocation.callId,
          toolName: nameDisplay(invocation.toolName),
          turnId: directDispatchTurnId(invocation),
          ...networkPolicyInterfacesFromTurn(executionInvocation.turn),
          ...(forcedApprovalReason !== undefined
            ? { retryReason: forcedApprovalReason }
            : {}),
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        },
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        approvalPolicy: effectiveApprovalPolicy,
        sandboxMode: requestedSandboxMode,
        payload: executionPayload,
        ...(activeExecPolicy !== undefined ? { execPolicy: activeExecPolicy } : {}),
        approvalArgs: executionArgs,
        ...(opts.granular !== undefined ? { granular: opts.granular } : {}),
        ...(opts.permissionHooks !== undefined
          ? { permissionHooks: opts.permissionHooks }
          : {}),
        ...(opts.permissionDecisionHooks !== undefined
          ? { permissionDecisionHooks: opts.permissionDecisionHooks }
          : {}),
        ...(opts.guardianApprovalReviewer !== undefined
          ? { guardianApprovalReviewer: opts.guardianApprovalReviewer }
          : {}),
        ...(opts.approvalResolver !== undefined
          ? { approvalResolver: opts.approvalResolver }
          : {}),
        ...(opts.permissionAuditLogger !== undefined
          ? { permissionAuditLogger: opts.permissionAuditLogger }
          : {}),
        ...(opts.onPermissionAuditError !== undefined
          ? { onPermissionAuditError: opts.onPermissionAuditError }
          : {}),
        ...(opts.toolAllowlist !== undefined ? { toolAllowlist: opts.toolAllowlist } : {}),
        ...(opts.toolDenylist !== undefined ? { toolDenylist: opts.toolDenylist } : {}),
        dispatch: async (sandbox, dispatchContext) => {
          const dispatchArgs = dispatchContext.approvalResolved
            ? withApprovedFilesystemRoot(nameDisplay(invocation.toolName), executionArgs)
            : executionArgs;
          const dispatchPayload =
            dispatchArgs === executionArgs
              ? executionPayload
              : buildPayloadForArgs(invocation.payload, dispatchArgs);
          const dispatchInvocation =
            dispatchArgs === executionArgs
              ? executionInvocation
              : { ...executionInvocation, payload: dispatchPayload };
          const dispatchRawArgs =
            dispatchArgs === executionArgs
              ? executionRawArgs
              : stringifyToolArgsWithBigInt(dispatchArgs);
          const runtimeAttemptContext = buildToolRuntimeAttemptContext(
            runtimeCallContext,
            {
              approvalPolicy: effectiveApprovalPolicy,
              requestedSandboxMode,
              sandboxMode: sandbox,
              approvalResolved: dispatchContext.approvalResolved,
              ...(dispatchContext.additionalPermissions !== undefined
                ? { additionalPermissions: dispatchContext.additionalPermissions }
                : {}),
              rawArgs: dispatchRawArgs,
              invocation: dispatchInvocation,
            },
          );
          const toolAbortController = new AbortController();
          const forwardAbort = (): void => {
            if (toolAbortController.signal.aborted) return;
            try {
              toolAbortController.abort(
                (opts.signal as AbortSignal & { reason?: unknown } | undefined)
                  ?.reason,
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
          const directContextWindowTokens =
            effectiveContextWindowTokens(invocation.turn);
          try {
            return await executeToolDispatch({
              rawArgs: dispatchRawArgs,
              signal: toolAbortController.signal,
              currentTurnId: directDispatchTurnId(invocation),
              eventLog: invocation.session.eventLog,
              subId: invocation.callId,
              tool: spec.tool,
              invocation: dispatchInvocation,
              approvalAlreadyResolved: dispatchContext.approvalResolved,
              runtimeAttemptContext,
              abortController: toolAbortController,
              ...(directContextWindowTokens !== undefined
                ? { contextWindowTokens: directContextWindowTokens }
                : {}),
              ...(opts.permissionAuditLogger !== undefined
                ? { permissionAuditLogger: opts.permissionAuditLogger }
                : {}),
              ...(opts.onPermissionAuditError !== undefined
                ? { onPermissionAuditError: opts.onPermissionAuditError }
                : {}),
            });
          } finally {
            opts.signal?.removeEventListener("abort", forwardAbort);
          }
        },
      });
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
   * Port of donor runtime `dispatch_tool_call_with_code_mode_result`
   * (router.rs:266-302). When `source === "code_mode"`, restrict
   * dispatch to the JS-REPL-safe subset (`js_repl` / `js_repl_reset`);
   * anything else returns an error result the model can observe. All
   * other sources delegate to `dispatchToolCall`.
   */
  async dispatchToolCallWithCodeMode(
    invocation: ToolInvocation,
    args: Record<string, unknown>,
    source: ToolCallSource,
    opts: DirectToolDispatchOptions = {},
  ): Promise<ToolDispatchResult> {
    if (source === "code_mode" && !isCodeModeSafeTool(invocation.toolName)) {
      return {
        content: JSON.stringify({
          error:
            "direct tool calls are disabled in code_mode; use js_repl helpers instead",
        }),
        isError: true,
      };
    }
    return this.dispatchToolCall({ ...invocation, source }, args, opts);
  }

  async dispatchModelToolCall(
    toolCall: LLMToolCall,
    opts: LiveToolDispatchOptions,
  ): Promise<ToolDispatchResult> {
    const toolName = canonicalModelToolName(toolCall.name);
    const routedToolCall =
      toolName === toolCall.name ? toolCall : { ...toolCall, name: toolName };
    const routed = toolCallFromLLMToolCall(routedToolCall, {
      session: opts.session,
    });

    const spec = this.findSpec(toolName);
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
      toolName: parseToolName(toolName),
      payload: routed.payload,
      source: opts.source ?? "direct",
    };
    const rawArgs = rawPayloadArguments(routed.payload);
    const parsedArgs = parseToolArgsWithBigInt(rawArgs);
    if (parsedArgs === null) {
      // Surface the parse failure explicitly so weak local models
      // recover instead of looping on "field X required" feedback
      // from downstream tools. The previous silent-coerce to {}
      // hid the parse error and let qwen/llama re-emit the same
      // broken JSON. See run-agent.ts:formatToolArgumentsParseError
      // for the matching subagent-dispatch helper.
      const truncated = rawArgs.length > 200 ? `${rawArgs.slice(0, 200)}…` : rawArgs;
      return {
        content: [
          `tool_call arguments for ${toolCall.name} could not be parsed as a JSON object.`,
          `Received raw arguments: ${truncated}`,
          "Please re-emit the tool_call with valid JSON object arguments.",
        ].join("\n"),
        isError: true,
      };
    }
    // SECURITY: `__agenc*` keys are a TRUSTED INTERNAL channel
    // (`__agencSessionAllowedRoots`, `__agencSessionId`, …) the runtime
    // injects post-approval to scope filesystem confinement. They must
    // NEVER originate from the model. Strip every model-supplied
    // `__agenc*` key here, before any runtime-injected value is merged
    // in, so a crafted `__agencSessionAllowedRoots:["/"]` cannot widen
    // the allowed roots that reach tool.execute. (The validator-only
    // strip in execution.ts left the tool body exposed.)
    let executionArgs = stripModelSuppliedAgenCInternalArgs(parsedArgs);
    let forcedApprovalReason: string | undefined;
    let preHookPermissionDecision: MergedHookPermissionDecision | undefined;
    let hookPermissionResult: HookPermissionResult | undefined;
    let prePreventContinuation:
      | { readonly stopReason?: string }
      | undefined;
    let permissionAlreadyAllowed = false;
    const preHooks = opts.preHooks ?? [];
    if (preHooks.length > 0) {
      const preDecision = await runPreToolUseHooks(
        preHooks,
        { invocation, tool: spec.tool, args: executionArgs },
        (err, idx) => {
          opts.onHookError?.("pre", err, idx);
          emitWarningEvent(
            opts.session.eventLog,
            toolCall.id,
            "hook_error_during_execution",
            `PreToolUse:${spec.tool.name} threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        },
        undefined,
        // Drain/timeout-aware signal: lets a wedged pre-hook be cancelled
        // in place so this lock-wrapped dispatch settles and releases the
        // ToolCallRuntime guard (turning `leaked` → `reclaimed`).
        opts.signal,
        (idx) => {
          emitWarningEvent(
            opts.session.eventLog,
            toolCall.id,
            "hook_cancelled",
            `PreToolUse:${spec.tool.name}#${idx} cancelled (drain/timeout); fail-closed deny synthesized`,
          );
        },
        (idx) => {
          emitWarningEvent(
            opts.session.eventLog,
            toolCall.id,
            "hook_orphaned",
            `PreToolUse:${spec.tool.name}#${idx} ignored its cancel signal; lock reclaimed, hook task orphaned`,
          );
        },
      );
      executionArgs = preDecision.args ?? executionArgs;
      if (preDecision.hookPermissionResult) {
        hookPermissionResult = preDecision.hookPermissionResult;
        executionArgs =
          preDecision.hookPermissionResult.updatedInput ?? executionArgs;
      }
      for (const context of preDecision.additionalContexts) {
        emitWarningEvent(
          opts.session.eventLog,
          toolCall.id,
          "hook_additional_context",
          `PreToolUse:${spec.tool.name} context: ${context}`,
        );
      }
      if (preDecision.additionalContexts.length > 0) {
        opts.onHookAdditionalContext?.(preDecision.additionalContexts);
      }
      if (preDecision.preventContinuation !== undefined) {
        prePreventContinuation = preDecision.preventContinuation;
      }
      if (preDecision.kind === "deny") {
        const message = preDecision.reason ?? "denied by pre-tool-use hook";
        await recordToolPolicyAudit(opts, {
          decision: "denied",
          source: "pre-tool-use-hook",
          reasonCode: "pre_hook_denied",
          toolName: spec.tool.name,
          callId: toolCall.id,
        });
        emitErrorEvent(opts.session.eventLog, toolCall.id, {
          cause: "pre_hook_denied",
          message,
        });
        return {
          content: `<tool_use_error>${message}</tool_use_error>`,
          isError: true,
        };
      }
      if (preDecision.kind === "skip" && preDecision.synthResult) {
        return {
          content: preDecision.synthResult.content,
          isError: preDecision.synthResult.isError === true,
        };
      }
      if (preDecision.kind === "stop") {
        const message =
          preDecision.stopReason ??
          "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.";
        emitWarningEvent(
          opts.session.eventLog,
          toolCall.id,
          "hook_stopped_continuation",
          `PreToolUse:${spec.tool.name} stopped execution${preDecision.stopReason ? `: ${preDecision.stopReason}` : ""}`,
          );
        return { content: message, isError: true, preventContinuation: true };
      }
    }

    const shouldArbitratePermission =
      hookPermissionResult !== undefined ||
      (opts.canUseTool !== undefined &&
        opts.permissionContext !== null &&
        opts.permissionContext !== undefined);
    if (shouldArbitratePermission) {
      const guardianPermissionDecision = await arbitratePermissionMode({
        tool: spec.tool,
        args: executionArgs,
        ...(hookPermissionResult !== undefined ? { hookPermissionResult } : {}),
        ...(opts.canUseTool !== undefined ? { canUseTool: opts.canUseTool } : {}),
        ...(opts.permissionContext !== null && opts.permissionContext !== undefined
          ? { permissionContext: opts.permissionContext }
          : {}),
      });
      if (guardianPermissionDecision.kind !== "none") {
        executionArgs = guardianPermissionDecision.args;
        preHookPermissionDecision = guardianPermissionDecision.mergedDecision;
        if (guardianPermissionDecision.kind === "deny") {
          const merged = guardianPermissionDecision.mergedDecision;
          const message = guardianPermissionDecision.message ?? "Permission denied";
          await recordToolPolicyAudit(opts, {
            decision: "denied",
            source: guardianPermissionDecision.source,
            reasonCode: guardianPermissionDecision.reasonCode,
            toolName: spec.tool.name,
            callId: toolCall.id,
          });
          if (guardianPermissionDecision.source === "pre-tool-use-hook") {
            emitWarningEvent(
              opts.session.eventLog,
              toolCall.id,
              "hook_permission_decision",
              `${spec.tool.name} deny via ${merged?.decisionReason?.type ?? "hook"}${merged?.decisionReason?.hookName ? ` (${merged.decisionReason.hookName})` : ""}`,
            );
          }
          emitErrorEvent(opts.session.eventLog, toolCall.id, {
            cause:
              guardianPermissionDecision.source === "pre-tool-use-hook"
                ? "permission_denied:hook"
                : "permission_denied:permission_mode",
            message,
          });
          return { content: message, isError: true };
        }
        if (guardianPermissionDecision.kind === "ask") {
          const merged = guardianPermissionDecision.mergedDecision;
          forcedApprovalReason =
            guardianPermissionDecision.message ?? "permission mode requested approval";
          if (guardianPermissionDecision.source === "pre-tool-use-hook") {
            emitWarningEvent(
              opts.session.eventLog,
              toolCall.id,
              "hook_permission_decision",
              `${spec.tool.name} ask via ${merged?.decisionReason?.type ?? "hook"}${merged?.decisionReason?.hookName ? ` (${merged.decisionReason.hookName})` : ""}${guardianPermissionDecision.message ? `: ${guardianPermissionDecision.message}` : ""}`,
            );
          }
        } else if (guardianPermissionDecision.kind === "allow") {
          permissionAlreadyAllowed = true;
          const merged = guardianPermissionDecision.mergedDecision;
          if (guardianPermissionDecision.source === "pre-tool-use-hook") {
            emitWarningEvent(
              opts.session.eventLog,
              toolCall.id,
              "hook_permission_decision",
              `${spec.tool.name} allow via ${merged?.decisionReason?.type ?? "hook"}${merged?.decisionReason?.hookName ? ` (${merged.decisionReason.hookName})` : ""}`,
            );
          }
        }
      }
    }

    const executionPayload = buildPayloadForArgs(routed.payload, executionArgs);
    const executionInvocation: ToolInvocation = {
      ...invocation,
      payload: executionPayload,
    };
    const executionRawArgs =
      executionArgs === parsedArgs
        ? rawArgs
        : stringifyToolArgsWithBigInt(executionArgs);
    const approvalArgs = withPlanApprovalPreview(
      toolCall.name,
      executionArgs,
      opts,
    );
    const approvalInvocation: ToolInvocation = {
      ...invocation,
      payload: buildPayloadForArgs(routed.payload, approvalArgs),
    };
    const approvalCtx: ApprovalCtx = {
      invocation: approvalInvocation,
      callId: toolCall.id,
      toolName: toolCall.name,
      turnId: opts.turn.subId,
      ...networkPolicyInterfacesFromTurn(opts.turn),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(forcedApprovalReason !== undefined
        ? { retryReason: forcedApprovalReason }
        : {}),
    };

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

    // Rust donor runtime `tools/registry.rs:303-309` — increment the
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

    const effectiveApprovalPolicy =
      permissionAlreadyAllowed || preHookPermissionDecision?.behavior === "allow"
        ? "never"
        : forcedApprovalReason !== undefined
          ? "untrusted"
          : opts.approvalPolicy;
    const activeExecPolicy =
      opts.execPolicy ?? currentExecPolicyFromSession(opts.session);
    const runtimeCallContext = buildToolRuntimeCallContext({
      toolCall,
      payload: executionPayload,
      tool: spec.tool,
      args: executionArgs,
      source: opts.source ?? "direct",
      supportsParallelToolCalls: spec.supportsParallelToolCalls,
    });

    try {
      const result = await orchestrateToolCall({
        tool: spec.tool,
        approvalCtx,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        approvalPolicy: effectiveApprovalPolicy,
        sandboxMode: opts.sandboxMode,
        payload: executionPayload,
        ...(activeExecPolicy !== undefined ? { execPolicy: activeExecPolicy } : {}),
        approvalArgs,
        ...(opts.granular !== undefined ? { granular: opts.granular } : {}),
        ...(opts.permissionHooks !== undefined
          ? { permissionHooks: opts.permissionHooks }
          : {}),
        ...(opts.permissionDecisionHooks !== undefined
          ? { permissionDecisionHooks: opts.permissionDecisionHooks }
          : {}),
        ...(opts.guardianApprovalReviewer !== undefined
          ? { guardianApprovalReviewer: opts.guardianApprovalReviewer }
          : {}),
        ...(opts.approvalResolver !== undefined
          ? { approvalResolver: opts.approvalResolver }
          : {}),
        ...(opts.permissionAuditLogger !== undefined
          ? { permissionAuditLogger: opts.permissionAuditLogger }
          : {}),
        ...(opts.onPermissionAuditError !== undefined
          ? { onPermissionAuditError: opts.onPermissionAuditError }
          : {}),
        ...(opts.toolAllowlist !== undefined
          ? { toolAllowlist: opts.toolAllowlist }
          : {}),
        ...(opts.toolDenylist !== undefined
          ? { toolDenylist: opts.toolDenylist }
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
        dispatch: async (sandbox, dispatchContext) => {
          const dispatchArgs = dispatchContext.approvalResolved
            ? withApprovedFilesystemRoot(toolCall.name, executionArgs)
            : executionArgs;
          const dispatchPayload =
            dispatchArgs === executionArgs
              ? executionPayload
              : buildPayloadForArgs(routed.payload, dispatchArgs);
          const dispatchInvocation =
            dispatchArgs === executionArgs
              ? executionInvocation
              : { ...executionInvocation, payload: dispatchPayload };
          const dispatchRawArgs =
            dispatchArgs === executionArgs
              ? executionRawArgs
              : stringifyToolArgsWithBigInt(dispatchArgs);
          const runtimeAttemptContext = buildToolRuntimeAttemptContext(
            runtimeCallContext,
            {
              approvalPolicy: effectiveApprovalPolicy,
              requestedSandboxMode: opts.sandboxMode,
              sandboxMode: sandbox,
              approvalResolved: dispatchContext.approvalResolved,
              ...(dispatchContext.additionalPermissions !== undefined
                ? { additionalPermissions: dispatchContext.additionalPermissions }
                : {}),
              rawArgs: dispatchRawArgs,
              invocation: dispatchInvocation,
            },
          );
          return executeToolDispatch(rawDispatchOptions(dispatchRawArgs, {
            ...withoutPermissionEvaluator(opts),
            tool: spec.tool,
            invocation: dispatchInvocation,
            preHooks: [],
            ...(preHookPermissionDecision !== undefined
              ? { preHookPermissionDecision }
              : {}),
            ...(prePreventContinuation !== undefined
              ? { prePreventContinuation }
              : {}),
            approvalAlreadyResolved: dispatchContext.approvalResolved,
            abortController: toolAbortController,
            subId: toolCall.id,
            runtimeAttemptContext,
          }));
        },
      });
      markLoadedToolNamesDiscovered(
        toolCall.name,
        result,
        opts.discoveredToolNames,
      );
      return result;
    } catch (err) {
      if (
        err instanceof ApprovalRejectedError &&
        err.decision.kind === "abort" &&
        opts.abortController !== undefined &&
        !opts.abortController.signal.aborted
      ) {
        opts.abortController.abort(err.message);
      }
      return toolDispatchErrorResult(err);
    } finally {
      opts.signal?.removeEventListener("abort", forwardAbort);
    }
  }

  /**
   * Port of donor runtime `ToolRouter::create_diff_consumer` (router.rs:135).
   * Returns a consumer the tool execution flow can call to record
   * pre-hook arguments and compare post-hook arguments — used to
   * surface argument rewrites in telemetry.
   *
   * Intentionally minimal: the consumer keeps an in-memory map keyed
   * by argument-name; `.compare(name, after)` runs a line-diff against
   * the previously recorded `before`. Matches donor runtime
   * `ToolArgumentDiffConsumer` in scope (not in shape).
   */
  createDiffConsumer(toolName: ToolName | string): ToolArgumentDiffConsumer {
    return createDiffConsumer(
      typeof toolName === "string" ? toolName : nameDisplay(toolName),
    );
  }
}

function directDispatchTurnId(invocation: ToolInvocation): string {
  const turn = invocation.turn as {
    readonly subId?: unknown;
    readonly turnId?: unknown;
    readonly id?: unknown;
  };
  const value = turn.subId ?? turn.turnId ?? turn.id;
  return typeof value === "string" && value.length > 0
    ? value
    : invocation.callId;
}

function networkPolicyInterfacesFromTurn(
  turn: TurnContext,
): Partial<Pick<ApprovalCtx, "networkPolicyDecider" | "blockedRequestObserver">> {
  const network = turn.network;
  return {
    ...(network?.policyDecider !== undefined
      ? { networkPolicyDecider: network.policyDecider }
      : {}),
    ...(network?.blockedRequestObserver !== undefined
      ? { blockedRequestObserver: network.blockedRequestObserver }
      : {}),
  };
}

function directDispatchApprovalPolicy(invocation: ToolInvocation): ApprovalPolicy {
  const value = (invocation.turn as { readonly approvalPolicy?: { readonly value?: unknown } })
    .approvalPolicy?.value;
  return isApprovalPolicy(value) ? value : "never";
}

function directDispatchSandboxMode(invocation: ToolInvocation): SandboxMode {
  const value = (invocation.turn as { readonly sandboxPolicy?: { readonly value?: unknown } })
    .sandboxPolicy?.value;
  return isSandboxMode(value) ? value : "workspace_write";
}

function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
  return (
    value === "never" ||
    value === "on_failure" ||
    value === "on_request" ||
    value === "granular" ||
    value === "untrusted"
  );
}

function isSandboxMode(value: unknown): value is SandboxMode {
  return (
    value === "danger_full_access" ||
    value === "read_only" ||
    value === "workspace_write" ||
    value === "external_sandbox"
  );
}

function currentExecPolicyFromSession(
  session: Session | undefined,
): Policy | undefined {
  const current = session?.services?.execPolicy?.current?.();
  return execPolicyFromUnknown(current);
}

function execPolicyFromUnknown(value: unknown): Policy | undefined {
  if (isExecPolicy(value)) return value;
  if (isRecord(value)) {
    const policy = value["policy"] ?? value["execPolicy"];
    if (isExecPolicy(policy)) return policy;
  }
  return undefined;
}

function isExecPolicy(value: unknown): value is Policy {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly checkMultipleWithOptions?: unknown })
      .checkMultipleWithOptions === "function"
  );
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

function buildPayloadForArgs(
  payload: ToolPayload,
  args: Record<string, unknown>,
): ToolPayload {
  const serialized = stringifyToolArgsWithBigInt(args);
  switch (payload.kind) {
    case "function":
      return { kind: "function", arguments: serialized };
    case "mcp":
      return {
        kind: "mcp",
        server: payload.server,
        tool: payload.tool,
        rawArguments: serialized,
      };
    case "custom":
    case "tool_search":
    case "local_shell":
      return payload;
  }
}

function stringifyToolArgsWithBigInt(args: Record<string, unknown>): string {
  return JSON.stringify(args, (_key, value) =>
    typeof value === "bigint" ? `__bigint__${value.toString()}` : value,
  );
}

const AGENC_INTERNAL_ARG_PREFIX = "__agenc";

/**
 * Drop every `__agenc*` key from model-supplied tool-call arguments.
 *
 * `__agenc*` keys (e.g. `__agencSessionAllowedRoots`, `__agencSessionId`)
 * are a TRUSTED INTERNAL channel the runtime injects post-approval to
 * scope filesystem confinement. A model that emits them directly could
 * widen its own allowed roots (audit #1/#2/#4). We strip them at the
 * dispatch boundary so the only `__agenc*` values that ever reach
 * `tool.execute` are those the runtime itself adds afterwards. Returns
 * the input untouched when there is nothing to strip.
 */
function stripModelSuppliedAgenCInternalArgs(
  input: Record<string, unknown>,
): Record<string, unknown> {
  let needsStrip = false;
  for (const key of Object.keys(input)) {
    if (key.startsWith(AGENC_INTERNAL_ARG_PREFIX)) {
      needsStrip = true;
      break;
    }
  }
  if (!needsStrip) return input;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key.startsWith(AGENC_INTERNAL_ARG_PREFIX)) continue;
    out[key] = value;
  }
  return out;
}

const APPROVED_FILE_PATH_TOOLS = new Set([
  "FileRead",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

function approvedFilePathForTool(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  if (!APPROVED_FILE_PATH_TOOLS.has(toolName)) return null;
  const filePath = args["file_path"];
  return typeof filePath === "string" && filePath.trim().length > 0
    ? filePath
    : null;
}

function withApprovedFilesystemRoot(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const filePath = approvedFilePathForTool(toolName, args);
  if (filePath === null) return args;

  const cwd =
    typeof args["cwd"] === "string" && args["cwd"].trim().length > 0
      ? args["cwd"]
      : process.cwd();
  const resolvedPath = isAbsolute(filePath)
    ? filePath
    : resolve(cwd, filePath);
  const approvedRoot = dirname(resolvedPath);
  return withSignedAllowedRoots(args, [approvedRoot]);
}

function planFileContextForApproval(
  options: Pick<LiveToolDispatchOptions, "agencHome" | "session">,
): PlanFileContext {
  return {
    ...(options.agencHome !== undefined ? { agencHome: options.agencHome } : {}),
    ...(typeof options.session.conversationId === "string" &&
    options.session.conversationId.length > 0
      ? { sessionId: options.session.conversationId }
      : {}),
  };
}

function withPlanApprovalPreview(
  toolName: string,
  args: Record<string, unknown>,
  options: Pick<LiveToolDispatchOptions, "agencHome" | "session">,
): Record<string, unknown> {
  if (toolName !== "ExitPlanMode") return args;

  const currentPlan =
    typeof args["plan"] === "string" && args["plan"].trim().length > 0
      ? args["plan"]
      : getPlan(planFileContextForApproval(options));
  if (typeof currentPlan !== "string" || currentPlan.trim().length === 0) {
    return args;
  }

  return {
    ...args,
    plan: currentPlan,
    planFilePath: getPlanFilePath(planFileContextForApproval(options)),
  };
}

/**
 * Effective context window (tokens) for the model running this turn,
 * threaded to `runToolUse` so the I-15 per-result cap can scale to the
 * window. Returns `undefined` when the window is unknown so the cap
 * falls back to its fixed 400 KB default.
 */
function effectiveContextWindowTokens(
  turn: TurnContext,
): number | undefined {
  // Defensive: minimal turn fixtures (and any turn missing `modelInfo`)
  // must not throw here — fall back to `undefined` so the I-15 cap uses
  // its fixed 400 KB default.
  let window: number | undefined;
  try {
    window = modelContextWindow(turn);
  } catch {
    return undefined;
  }
  return window !== undefined && Number.isFinite(window) && window > 0
    ? window
    : undefined;
}

function rawDispatchOptions(
  rawArgs: string,
  opts: LiveToolDispatchOptions & {
    readonly tool: Tool;
    readonly invocation: ToolInvocation;
    readonly abortController: AbortController;
    readonly subId: string;
    readonly preHookPermissionDecision?: MergedHookPermissionDecision;
    readonly prePreventContinuation?: { readonly stopReason?: string };
    readonly approvalAlreadyResolved?: boolean;
    readonly runtimeAttemptContext?: ToolRuntimeAttemptContext;
  },
) {
  const contextWindowTokens = effectiveContextWindowTokens(opts.turn);
  return {
    rawArgs,
    signal: opts.abortController.signal,
    currentTurnId: opts.turn.subId,
    eventLog: opts.session.eventLog,
    subId: opts.subId,
    tool: opts.tool,
    invocation: opts.invocation,
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
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
    ...(opts.preHookPermissionDecision !== undefined
      ? { preHookPermissionDecision: opts.preHookPermissionDecision }
      : {}),
    ...(opts.prePreventContinuation !== undefined
      ? { prePreventContinuation: opts.prePreventContinuation }
      : {}),
    ...(opts.approvalAlreadyResolved !== undefined
      ? { approvalAlreadyResolved: opts.approvalAlreadyResolved }
      : {}),
    ...(opts.runtimeAttemptContext !== undefined
      ? { runtimeAttemptContext: opts.runtimeAttemptContext }
      : {}),
    ...(opts.permissionAuditLogger !== undefined
      ? { permissionAuditLogger: opts.permissionAuditLogger }
      : {}),
    ...(opts.onPermissionAuditError !== undefined
      ? { onPermissionAuditError: opts.onPermissionAuditError }
      : {}),
    ...(opts.onHookAdditionalContext !== undefined
      ? { onHookAdditionalContext: opts.onHookAdditionalContext }
      : {}),
    ...(opts.approvalResolver !== undefined && opts.canUseTool !== undefined
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

function withoutPermissionEvaluator(
  opts: LiveToolDispatchOptions,
): Omit<LiveToolDispatchOptions, "canUseTool" | "permissionContext"> {
  const clone: Record<string, unknown> = { ...opts };
  delete clone["canUseTool"];
  delete clone["permissionContext"];
  return clone as Omit<LiveToolDispatchOptions, "canUseTool" | "permissionContext">;
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
      ...networkPolicyInterfacesFromTurn(invocation.turn),
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

async function recordToolPolicyAudit(
  opts: LiveToolDispatchOptions,
  event: {
    readonly decision: "approved" | "denied";
    readonly source: string;
    readonly reasonCode: string;
    readonly toolName: string;
    readonly callId: string;
  },
): Promise<void> {
  await recordPermissionAuditEvent(
    opts.permissionAuditLogger,
    {
      eventKind: "policy_outcome",
      decision: event.decision,
      source: event.source,
      subjectType: "tool_execution",
      toolName: event.toolName,
      callId: event.callId,
      sessionId: readSessionId(opts.session),
      reasonCode: event.reasonCode,
    },
    opts.onPermissionAuditError,
  );
}

function readSessionId(session: Session): string | undefined {
  const value = (session as unknown as { readonly conversationId?: unknown })
    .conversationId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
 * compatibility call sites.
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
  // Compatibility fallback for callers without a session bound — keeps
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
 * Port of donor runtime `ToolRouter::build_tool_call` (router.rs:172-263).
 * Inspects `item.type` and produces the right ToolCall envelope for
 * each of the four ResponseItem variants. Returns `null` when the
 * item is not a tool call (donor runtime returns `Ok(None)`) or when the
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
// Non-parallel spec variants — donor runtime router.rs:150-158 hard-false list.
// ─────────────────────────────────────────────────────────────────────

/**
 * Tool names corresponding to donor runtime `ToolSpec` variants that donor runtime
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
 * donor runtime router.rs:281 (`matches!(tool_name.name.as_str(), "js_repl" |
 * "js_repl_reset")`). Code-mode callers go through `js_repl` and the
 * JS runner's `donor runtime.tool(...)` bridge for everything else.
 */
const CODE_MODE_SAFE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "js_repl",
  "js_repl_reset",
]);

function isCodeModeSafeTool(toolName: ToolName): boolean {
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
