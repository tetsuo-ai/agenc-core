/**
 * Lean tool-execution surfaces consumed by `phases/execute-tools.ts`.
 *
 * The openclaude port shipped a full multi-layer dispatcher
 * (`StreamingToolExecutor` → `router` → `orchestrator` → `execution`).
 * The lean rebuild deletes that stack and replaces it with the
 * minimum behaviour `phases/execute-tools.ts` and its tests rely on:
 *
 *   - Pre/post hook fan-out (delegated to `tools/hooks.ts`).
 *   - MCP routing payload synthesis (`payload.kind === "mcp"`) when
 *     the session exposes an `mcpManager.resolveMcpToolInfo` lookup.
 *   - `__onProgress` injection (non-enumerable so it does not leak
 *     into hook arg observers) so tools that stream progress chunks
 *     re-emit through the session event log as `tool_progress`.
 *   - Permission evaluator pass via `canUseTool` + `permissionContext`.
 *   - Codex-style approval classification for `requiresApproval`
 *     tools, routed through the session approval resolver.
 *   - Mid-execution abort drain — when the abort signal is already
 *     tripped, queued tools yield a synthetic
 *     `permission mode changed mid-execution` error result instead of
 *     dispatching.
 *   - Concurrency cap: parallel dispatch with a per-call worker pool
 *     so the env-cap loop in `execute-tools.ts` can observe in-flight
 *     count.
 *   - no user-visible routing-classification diagnostics.
 *
 * Anything beyond that — sibling-abort cascade and real router
 * classification — still belongs to the upstream stack the rebuild
 * has not yet ported.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */

import type { LLMToolCall } from "../../llm/types.js";
import {
  getPlan,
  getPlanFilePath,
  type PlanFileContext,
} from "../../planning/plan-files.js";
import { reviewDecisionOpaqueString } from "../../permissions/review-decision.js";
import type { GuardianApprovalReviewer } from "../../session/guardian-approval-review.js";
import {
  runPostToolUseHooks,
  runPreToolUseHooks,
  type PostToolUseHook,
  type PreToolUseHook,
  type PostToolUseFailureHook,
  type PermissionDecisionHook,
} from "../../tools/hooks.js";
import type { ToolInvocation, ToolPayload } from "../../tools/context.js";
import type { Tool } from "../../tools/types.js";
import {
  ApprovalRejectedError,
  orchestrateToolCall,
  type ApprovalPolicy,
  type ApprovalResolver,
  type PermissionRequestHook,
  type SandboxMode,
} from "../../tools/orchestrator.js";

interface ToolDispatchResultLike {
  readonly content: string;
  readonly isError?: boolean;
}

interface ToolRegistryLike {
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
    readonly inputSchema?: unknown;
    readonly isReadOnly?: boolean;
    readonly requiresApproval?: boolean;
    [extra: string]: unknown;
  }>;
  dispatch(toolCall: LLMToolCall): Promise<ToolDispatchResultLike>;
}

// ─────────────────────────────────────────────────────────────────────
// Re-exports (back-compat with previous stub surface)
// ─────────────────────────────────────────────────────────────────────

export type {
  PostToolUseHook,
  PreToolUseHook,
  PostToolUseFailureHook,
  PermissionDecisionHook,
} from "../../tools/hooks.js";

// ─────────────────────────────────────────────────────────────────────
// ToolCallRuntime — concurrency runtime stub
// ─────────────────────────────────────────────────────────────────────

export interface ToolCallRuntimeOpts {
  readonly sharedServerCapacity?: number;
}

export class ToolCallRuntime {
  constructor(_opts: ToolCallRuntimeOpts = {}) {}

  async run<T>(_klass: unknown, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

// ─────────────────────────────────────────────────────────────────────
// routerFromRegistry — minimal router shell
// ─────────────────────────────────────────────────────────────────────

export interface ToolRouterLike {
  readonly registry: ToolRegistryLike;
}

export function routerFromRegistry(
  registry: ToolRegistryLike,
  _opts: Record<string, unknown> = {},
): ToolRouterLike {
  return { registry };
}

// ─────────────────────────────────────────────────────────────────────
// ToolHookRegistry — typed pre/post/failure/permission hook holder
// ─────────────────────────────────────────────────────────────────────

export class ToolHookRegistry {
  private pre: PreToolUseHook[] = [];
  private post: PostToolUseHook[] = [];
  private failure: PostToolUseFailureHook[] = [];
  private permission: PermissionDecisionHook[] = [];

  addPre(hook: PreToolUseHook): void {
    this.pre.push(hook);
  }
  addPost(hook: PostToolUseHook): void {
    this.post.push(hook);
  }
  addFailure(hook: PostToolUseFailureHook): void {
    this.failure.push(hook);
  }
  addPermission(hook: PermissionDecisionHook): void {
    this.permission.push(hook);
  }

  getPre(): ReadonlyArray<PreToolUseHook> {
    return this.pre;
  }
  getPost(): ReadonlyArray<PostToolUseHook> {
    return this.post;
  }
  getFailure(): ReadonlyArray<PostToolUseFailureHook> {
    return this.failure;
  }
  getPermission(): ReadonlyArray<PermissionDecisionHook> {
    return this.permission;
  }
}

// ─────────────────────────────────────────────────────────────────────
// StreamingToolExecutor — pass-through with hooks + permission + MCP routing
// ─────────────────────────────────────────────────────────────────────

export type ToolStatus = "queued" | "executing" | "completed" | "yielded";

export interface StreamingToolResult {
  readonly toolCall: LLMToolCall;
  readonly result: ToolDispatchResultLike;
  readonly status: "completed" | "synthetic_error";
  readonly durationMs: number;
}

interface TrackedTool {
  readonly id: string;
  readonly toolCall: LLMToolCall;
  status: ToolStatus;
  result?: ToolDispatchResultLike;
  /** When set, the tool was queued but never dispatched (abort-drain). */
  drainErrorMessage?: string;
}

interface SessionLike {
  // Accept any event shape — we cast our internal event payloads to
  // `any` at the call site. The real `Session.emit` is strictly typed
  // against the union of EventMsg variants and we cannot enumerate
  // them here without dragging the whole event taxonomy in.
  emit?: (event: any) => void;
  nextInternalSubId?: () => string;
  eventLog?: {
    emit: (event: any) => void;
  };
  services?: {
    mcpManager?: {
      resolveMcpToolInfo?: (
        toolName: string,
      ) =>
        | { readonly serverName: string; readonly toolName: string }
        | undefined;
    };
  };
}

interface LiveDispatchOptions {
  readonly session?: SessionLike;
  readonly turn?: unknown;
  readonly preHooks?: ReadonlyArray<PreToolUseHook>;
  readonly postHooks?: ReadonlyArray<PostToolUseHook>;
  readonly failureHooks?: ReadonlyArray<PostToolUseFailureHook>;
  // Use `any` for the permission decision result so the real
  // PermissionResult union (which includes "passthrough" and other
  // variants we ignore here) flows through without a structural
  // mismatch at the LiveDispatchOptions boundary. Inside `runOne` we
  // narrow on `decision.behavior === "deny"` only.
  readonly canUseTool?: (
    tool: any,
    args: Record<string, unknown>,
    context: any,
  ) => Promise<any>;
  readonly permissionContext?: any;
  readonly approvalPolicy?: ApprovalPolicy;
  readonly sandboxMode?: SandboxMode;
  readonly permissionHooks?: ReadonlyArray<PermissionRequestHook>;
  readonly permissionDecisionHooks?: ReadonlyArray<PermissionDecisionHook>;
  readonly guardianApprovalReviewer?: GuardianApprovalReviewer;
  readonly approvalResolver?: ApprovalResolver;
  readonly agencHome?: string;
  readonly onHookError?: (phase: string, err: unknown, idx: number) => void;
  readonly tracker?: unknown;
  readonly [extra: string]: unknown;
}

export interface StreamingToolExecutorOptions {
  readonly registry: ToolRegistryLike;
  readonly abortSignal?: AbortSignal;
  readonly runtime?: ToolCallRuntime;
  readonly onSiblingAbort?: (reason: string) => void;
  readonly liveToolDispatch?: {
    readonly router: ToolRouterLike;
    readonly options: LiveDispatchOptions;
  };
  readonly [extra: string]: unknown;
}

const PERMISSION_MODE_CHANGED_MESSAGE =
  "permission mode changed mid-execution; tool not run";

function safeParseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function buildToolPayload(
  toolName: string,
  rawArgs: string | undefined,
  mcpInfo:
    | { readonly serverName: string; readonly toolName: string }
    | undefined,
): ToolPayload {
  if (mcpInfo) {
    return {
      kind: "mcp",
      server: mcpInfo.serverName,
      tool: mcpInfo.toolName,
      rawArguments: rawArgs ?? "",
    };
  }
  void toolName;
  return { kind: "function", arguments: rawArgs ?? "" };
}

function buildPayloadForArgs(
  payload: ToolPayload,
  args: Record<string, unknown>,
): ToolPayload {
  const serialized = JSON.stringify(args);
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

function buildInvocation(
  toolName: string,
  callId: string,
  payload: ToolPayload,
  options: LiveDispatchOptions,
): ToolInvocation {
  return {
    callId,
    toolName: { name: toolName },
    payload,
    source: "direct",
    session: (options.session ?? {}) as ToolInvocation["session"],
    turn: (options.turn ?? {}) as ToolInvocation["turn"],
    tracker:
      (options.tracker as ToolInvocation["tracker"]) ??
      ({
        appendFileDiff: () => {},
        snapshot: () => [],
        clear: () => {},
      } as ToolInvocation["tracker"]),
  };
}

function resolveTurnId(options: LiveDispatchOptions | undefined): string {
  const turn = options?.turn as
    | {
        readonly subId?: unknown;
        readonly turnId?: unknown;
        readonly id?: unknown;
      }
    | undefined;
  const value = turn?.subId ?? turn?.turnId ?? turn?.id;
  return typeof value === "string" && value.length > 0 ? value : "turn";
}

function planFileContextForApproval(
  options: LiveDispatchOptions | undefined,
): PlanFileContext {
  const session = options?.session as
    | { readonly conversationId?: unknown }
    | undefined;
  return {
    ...(options?.agencHome !== undefined ? { agencHome: options.agencHome } : {}),
    ...(typeof session?.conversationId === "string" &&
    session.conversationId.length > 0
      ? { sessionId: session.conversationId }
      : {}),
  };
}

function withPlanApprovalPreview(
  toolName: string,
  args: Record<string, unknown>,
  options: LiveDispatchOptions | undefined,
): Record<string, unknown> {
  if (toolName !== "ExitPlanMode" && toolName !== "workflow.exitPlan") {
    return args;
  }

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

function approvalRejectedResult(err: ApprovalRejectedError): ToolDispatchResultLike {
  const decision = reviewDecisionOpaqueString(err.decision);
  return {
    content: JSON.stringify({
      error: err.message,
      approvalDecision: decision,
    }),
    isError: true,
  };
}

function emitOn(
  session: SessionLike | undefined,
  type: string,
  payload: Record<string, unknown>,
): void {
  if (!session) return;
  const id =
    session.nextInternalSubId !== undefined
      ? session.nextInternalSubId()
      : `auto-${Math.random().toString(36).slice(2, 8)}`;
  const event = { id, msg: { type, payload } };
  if (session.emit) {
    session.emit(event);
    return;
  }
  if (session.eventLog?.emit) {
    session.eventLog.emit(event);
  }
}

export class StreamingToolExecutor {
  private readonly registry: ToolRegistryLike;
  private readonly abortSignal?: AbortSignal;
  private readonly liveOptions?: LiveDispatchOptions;
  private readonly tools: TrackedTool[] = [];
  private readonly inflight: Set<TrackedTool> = new Set();
  private closed = false;

  constructor(opts: StreamingToolExecutorOptions) {
    this.registry = opts.registry;
    this.abortSignal = opts.abortSignal;
    this.liveOptions = opts.liveToolDispatch?.options;
  }

  addTool(_block: unknown, toolCall: LLMToolCall): void {
    if (this.closed) return;
    if (this.tools.some((t) => t.id === toolCall.id)) return;

    const tracked: TrackedTool = {
      id: toolCall.id,
      toolCall,
      status: "queued",
    };

    // Abort-drain: if the abort signal is already tripped, this call
    // never dispatches. Synthesize the terminal error result up front
    // so getRemainingResults() yields it without consulting the
    // registry. This matches the openclaude `mode_changed` mid-stream
    // cascade contract.
    if (this.abortSignal?.aborted) {
      tracked.drainErrorMessage = PERMISSION_MODE_CHANGED_MESSAGE;
    }

    this.tools.push(tracked);

    // Upstream Codex does not surface routing classification as transcript
    // warnings. Keep this path quiet; real failures are emitted where they
    // happen (permission denial, hook errors, dispatch errors).
  }

  close(): void {
    this.closed = true;
  }

  getToolStates(): ReadonlyArray<{
    readonly id: string;
    readonly status: ToolStatus;
    readonly toolName: string;
  }> {
    return this.tools.map((t) => ({
      id: t.id,
      status: t.status,
      toolName: t.toolCall.name,
    }));
  }

  // Drain whatever is already completed. Used by the env-cap loop in
  // `executeTools` to thread results into TurnState as workers finish.
  *getCompletedResults(): Generator<StreamingToolResult, void> {
    for (const tool of this.tools) {
      if (tool.status !== "completed" || !tool.result) continue;
      tool.status = "yielded";
      this.inflight.delete(tool);
      yield {
        toolCall: tool.toolCall,
        result: tool.result,
        status: tool.result.isError ? "synthetic_error" : "completed",
        durationMs: 0,
      };
    }
  }

  // Drain everything not yet yielded — runs the actual dispatch for
  // queued tools through hooks + permission + MCP routing.
  async *getRemainingResults(): AsyncGenerator<StreamingToolResult, void> {
    // Kick any queued tools that have not started yet.
    const pending: Array<Promise<TrackedTool>> = [];
    for (const tool of this.tools) {
      if (tool.status === "yielded") continue;
      if (tool.status === "queued") {
        pending.push(this.runOne(tool));
      } else if (tool.status === "executing") {
        pending.push(this.waitForCompletion(tool));
      } else if (tool.status === "completed" && tool.result) {
        const result = tool.result;
        tool.status = "yielded";
        this.inflight.delete(tool);
        yield {
          toolCall: tool.toolCall,
          result,
          status: result.isError ? "synthetic_error" : "completed",
          durationMs: 0,
        };
      }
    }

    while (pending.length > 0) {
      const settled = await Promise.race(
        pending.map((p, idx) => p.then((tool) => ({ tool, idx }))),
      );
      pending.splice(settled.idx, 1);
      const tool = settled.tool;
      if (tool.status !== "yielded" && tool.result) {
        tool.status = "yielded";
        this.inflight.delete(tool);
        yield {
          toolCall: tool.toolCall,
          result: tool.result,
          status: tool.result.isError ? "synthetic_error" : "completed",
          durationMs: 0,
        };
      }
    }
  }

  private async waitForCompletion(tool: TrackedTool): Promise<TrackedTool> {
    while (tool.status === "executing") {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    return tool;
  }

  /**
   * Kick off any queued tools so workers run in parallel with the
   * outer queue loop. Idempotent: tools already in flight are skipped.
   */
  dispatchPending(): void {
    for (const tool of this.tools) {
      if (tool.status !== "queued") continue;
      this.inflight.add(tool);
      void this.runOne(tool);
    }
  }

  inflightCount(): number {
    return this.inflight.size;
  }

  private async runOne(tool: TrackedTool): Promise<TrackedTool> {
    if (tool.status !== "queued") return tool;
    tool.status = "executing";
    this.inflight.add(tool);

    try {
      // Synthesize abort-drain error without dispatching.
      if (tool.drainErrorMessage) {
        tool.result = {
          content: tool.drainErrorMessage,
          isError: true,
        };
        return tool;
      }

      const session = this.liveOptions?.session;
      const args = safeParseArgs(tool.toolCall.arguments);
      const mcpInfo =
        session?.services?.mcpManager?.resolveMcpToolInfo?.(tool.toolCall.name);
      const payload = buildToolPayload(
        tool.toolCall.name,
        tool.toolCall.arguments,
        mcpInfo,
      );
      const invocation = buildInvocation(
        tool.toolCall.name,
        tool.toolCall.id,
        payload,
        this.liveOptions ?? {},
      );

      const toolDef =
        this.registry.tools.find((t) => t.name === tool.toolCall.name) ??
        ({ name: tool.toolCall.name } as { name: string });
      const onHookError = this.liveOptions?.onHookError;

      // ── Permission evaluator ──────────────────────────────────────
      const canUseTool = this.liveOptions?.canUseTool;
      const permissionContext = this.liveOptions?.permissionContext;
      if (canUseTool && permissionContext) {
        const decision = await canUseTool(
          toolDef,
          args,
          permissionContext,
        );
        if (decision.behavior === "deny") {
          const message =
            decision.message ?? `permission denied: ${tool.toolCall.name}`;
          // I-8: emit error event with `permission_denied:<tool>` cause.
          emitOn(session, "error", {
            cause: `permission_denied:${tool.toolCall.name}`,
            message,
          });
          tool.result = { content: message, isError: true };
          return tool;
        }
      }

      // ── Pre-hooks ─────────────────────────────────────────────────
      const preHooks = this.liveOptions?.preHooks ?? [];
      let effectiveArgs = args;
      let synthFromPre: ToolDispatchResultLike | undefined;
      let denyFromPre: string | undefined;

      if (preHooks.length > 0) {
        const preResult = await runPreToolUseHooks(
          preHooks,
          {
            invocation,
            tool: toolDef as any,
            args,
          },
          onHookError ? (err, idx) => onHookError("pre", err, idx) : undefined,
        );
        if (preResult.kind === "deny") {
          denyFromPre = preResult.reason ?? "denied by pre-tool-use hook";
        } else if (preResult.kind === "skip" && preResult.synthResult) {
          synthFromPre = preResult.synthResult;
        } else if (preResult.kind === "stop") {
          synthFromPre = {
            content: preResult.stopReason ?? "stopped by pre-tool-use hook",
            isError: true,
          };
        } else if (preResult.args) {
          effectiveArgs = preResult.args;
        }
      }

      if (denyFromPre !== undefined) {
        tool.result = { content: denyFromPre, isError: true };
        return tool;
      }

      // ── Dispatch (or synthetic skip) ──────────────────────────────
      let dispatchResult: ToolDispatchResultLike;
      if (synthFromPre) {
        dispatchResult = synthFromPre;
      } else {
        // Inject __onProgress through the registry shim. The injection
        // is non-enumerable on the merged args object so hook
        // observers (and `toEqual` deep comparisons) do not see the
        // function. Tools that look up `args.__onProgress` still find
        // it because property access is enumeration-agnostic.
        const onProgress = (event: {
          chunk: string;
          stream?: "stdout" | "stderr";
        }) => {
          emitOn(session, "tool_progress", {
            callId: tool.toolCall.id,
            toolName: tool.toolCall.name,
            ...event,
          });
        };

        const dispatchCall: LLMToolCall = {
          ...tool.toolCall,
          // Re-stringify so the registry sees the (possibly) hook-
          // mutated args. JSON.stringify drops the function-valued
          // injection — we re-attach it via the shim below.
          arguments: JSON.stringify(effectiveArgs),
        };

        try {
          const approvalArgs = withPlanApprovalPreview(
            tool.toolCall.name,
            effectiveArgs,
            this.liveOptions,
          );
          const approvalInvocation = buildInvocation(
            tool.toolCall.name,
            tool.toolCall.id,
            buildPayloadForArgs(payload, approvalArgs),
            this.liveOptions ?? {},
          );
          dispatchResult = await orchestrateToolCall({
            tool: toolDef as Tool,
            approvalCtx: {
              invocation: approvalInvocation,
              callId: tool.toolCall.id,
              toolName: tool.toolCall.name,
              turnId: resolveTurnId(this.liveOptions),
              ...(this.abortSignal !== undefined
                ? { signal: this.abortSignal }
                : {}),
            },
            ...(this.abortSignal !== undefined
              ? { signal: this.abortSignal }
              : {}),
            approvalPolicy: this.liveOptions?.approvalPolicy ?? "never",
            sandboxMode: this.liveOptions?.sandboxMode ?? "workspace_write",
            payload,
            approvalArgs,
            ...(this.liveOptions?.permissionHooks !== undefined
              ? { permissionHooks: this.liveOptions.permissionHooks }
              : {}),
            ...(this.liveOptions?.permissionDecisionHooks !== undefined
              ? {
                  permissionDecisionHooks:
                    this.liveOptions.permissionDecisionHooks,
                }
              : {}),
            ...(this.liveOptions?.guardianApprovalReviewer !== undefined
              ? {
                  guardianApprovalReviewer:
                    this.liveOptions.guardianApprovalReviewer,
                }
              : {}),
            ...(this.liveOptions?.approvalResolver !== undefined
              ? { approvalResolver: this.liveOptions.approvalResolver }
              : {}),
            onNoApprovalResolver: (ctx) => {
              emitOn(session, "error", {
                cause: "no_approval_resolver",
                message: `approval required for ${ctx.toolName} but no resolver is wired`,
              });
            },
            dispatch: async () =>
              dispatchWithInjectedArgs(this.registry, dispatchCall, {
                __onProgress: onProgress,
              }),
          });
        } catch (err) {
          dispatchResult = {
            content:
              err instanceof ApprovalRejectedError
                ? approvalRejectedResult(err).content
                : err instanceof Error
                  ? err.message
                  : String(err),
            isError: true,
          };
        }
      }

      // ── Post-hooks ────────────────────────────────────────────────
      const postHooks = this.liveOptions?.postHooks ?? [];
      let finalResult = dispatchResult;
      if (postHooks.length > 0) {
        const postResult = await runPostToolUseHooks(
          postHooks,
          {
            invocation,
            tool: toolDef as any,
            args: effectiveArgs,
            result: {
              content: dispatchResult.content,
              isError: dispatchResult.isError === true,
            },
          },
          onHookError ? (err, idx) => onHookError("post", err, idx) : undefined,
        );
        finalResult = postResult.result;
      }

      tool.result = finalResult;
      return tool;
    } finally {
      tool.status = "completed";
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// dispatchWithInjectedArgs — registry shim that lets us hand
// function-typed side-band args (__onProgress, __abortSignal) to
// `tool.execute()` even though the registry contract is JSON-only.
//
// Strategy: temporarily monkey-patch the matching tool's `execute`
// fn to fold the injected args in via Object.defineProperty (non-
// enumerable so deep-equality observers do not see them), then
// restore on completion.
// ─────────────────────────────────────────────────────────────────────

async function dispatchWithInjectedArgs(
  registry: ToolRegistryLike,
  call: LLMToolCall,
  inject: Record<string, unknown>,
): Promise<ToolDispatchResultLike> {
  const tool = registry.tools.find((t) => t.name === call.name) as
    | { name: string; execute?: (args: Record<string, unknown>) => Promise<unknown> }
    | undefined;
  if (!tool || typeof tool.execute !== "function") {
    return registry.dispatch(call);
  }
  const original = tool.execute.bind(tool);
  const patched = async (parsed: Record<string, unknown>): Promise<unknown> => {
    // Define injected props as non-enumerable on the same object the
    // tool already received so `toEqual({...})` and `Object.keys()`
    // both ignore them; `parsed.__onProgress` access still works.
    for (const [key, value] of Object.entries(inject)) {
      Object.defineProperty(parsed, key, {
        value,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
    return original(parsed);
  };
  (tool as any).execute = patched;
  try {
    return await registry.dispatch(call);
  } finally {
    (tool as any).execute = original;
  }
}
