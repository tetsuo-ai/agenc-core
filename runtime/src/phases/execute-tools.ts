/**
 * Phase 5 — Execute Tools.
 *
 * Dispatches tool calls produced by the stream phase through the
 * StreamingToolExecutor, collects results, and appends `tool` messages
 * to `state.messages` so the next iteration provides them to the
 * model.
 *
 * Mirrors openclaude `query.ts:1467-1635`. The executor accepts tool
 * calls mid-stream (openclaude query.ts:572 starts the executor
 * BEFORE streamModel returns and feeds tool_use blocks as they
 * arrive). T5's stream-model captures the complete tool-use block
 * list at stream end and hands them to the executor here; T7 rewires
 * the mid-stream `addTool()` path.
 *
 * Live ownership is the single tool stack:
 *
 *   `execute-tools` → `streaming-executor` → `router` →
 *   `orchestrator` → `execution` → `tool.execute`
 *
 * This phase now only validates the batch, wires the executor with the
 * session/turn policy seams, queues tool calls, and records completed
 * tool results back into turn state.
 *
 * Invariants touched:
 *   I-8  (every error site emits a typed event) — tool errors emit
 *        `tool_call_completed{isError}` events.
 *   I-21 (approval modal ⊥ abort race) — T7 wires the modal race via
 *        the executor's sibling-abort hook.
 *
 * @module
 */

import type { LLMMessage, LLMToolCall } from "../llm/types.js";
import { validateToolCallsForExecution } from "../llm/stream-parser.js";
import { StreamingToolExecutor } from "../tools/streaming-executor.js";
import { ToolCallRuntime } from "../tools/concurrency.js";
import { routerFromRegistry } from "../tools/router.js";
import {
  type ApprovalPolicy as OrchestratorApprovalPolicy,
  type ApprovalResolver,
  type PermissionRequestHook,
  type SandboxMode,
} from "../tools/orchestrator.js";
import { resolveMaxToolUseConcurrency } from "../tools/orchestration.js";
import {
  ToolHookRegistry,
  type PermissionDecisionHook,
  type PostToolUseFailureHook,
  type PostToolUseHook,
  type PreToolUseHook,
} from "../tools/tool-hooks.js";
import type { ToolDispatchResult } from "../tool-registry.js";
import { emitError as emitErrorEvent } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { ToolUseBlock, TurnState, UserMessage } from "../session/turn-state.js";
import {
  attachContextDefaults,
  hasPermissionsToUseTool,
  type AppStateSnapshot,
  type ToolEvaluatorContext,
} from "../permissions/evaluator.js";
import { freshDenialTracking } from "../permissions/denial-tracking.js";

function toolResultMessage(
  callId: string,
  result: ToolDispatchResult,
): LLMMessage {
  return {
    role: "tool",
    toolCallId: callId,
    content: result.content,
  };
}

function toolResultUserRecord(
  callId: string,
  toolName: string,
  result: ToolDispatchResult,
): UserMessage {
  return {
    uuid: crypto.randomUUID(),
    role: "user",
    toolCallId: callId,
    toolName,
    content: result.content,
  };
}

function createNoopTracker() {
  return {
    appendFileDiff: () => {},
    snapshot: () => [],
    clear: () => {},
  };
}

function toolCallStartedEvent(call: LLMToolCall) {
  return {
    type: "tool_call_started" as const,
    payload: {
      callId: call.id,
      toolName: call.name,
      args: call.arguments,
    },
  };
}

/**
 * Pull pre/post tool-use hooks from the session services if they expose
 * them. Falls back to an empty registry so the pipeline always runs.
 *
 * The current `SessionServices.hooks` surface (session.ts) only
 * defines lifecycle hooks (stop, compact, startup). When a downstream
 * config wires per-tool pre/post hooks under `preToolUseHooks` /
 * `postToolUseHooks` on the services layer, this helper picks them up
 * without forcing every call site to update its fixture. Missing
 * surfaces = empty registry = pre/post pass-through.
 */
function resolveHookRegistry(session: Session): ToolHookRegistry {
  const registry = new ToolHookRegistry();
  const hooks = session.services.hooks as
    | {
        readonly preToolUseHooks?: ReadonlyArray<PreToolUseHook>;
        readonly postToolUseHooks?: ReadonlyArray<PostToolUseHook>;
        readonly failureToolUseHooks?: ReadonlyArray<PostToolUseFailureHook>;
        readonly permissionDecisionHooks?: ReadonlyArray<PermissionDecisionHook>;
      }
    | undefined;
  if (hooks?.preToolUseHooks) {
    for (const h of hooks.preToolUseHooks) registry.addPre(h);
  }
  if (hooks?.postToolUseHooks) {
    for (const h of hooks.postToolUseHooks) registry.addPost(h);
  }
  if (hooks?.failureToolUseHooks) {
    for (const h of hooks.failureToolUseHooks) registry.addFailure(h);
  }
  if (hooks?.permissionDecisionHooks) {
    for (const h of hooks.permissionDecisionHooks) registry.addPermission(h);
  }
  return registry;
}

/**
 * Derive the orchestrator's session-level knobs from the TurnContext
 * and SessionServices. Falls back to safe defaults (`never` +
 * `workspace_write`) when the context/service fields are undefined —
 * the legacy hardcoded behavior — so existing test fixtures without a
 * full TurnContext shape continue to work.
 */
function resolveOrchestratorSessionPolicy(
  ctx: TurnContext,
  session: Session,
): {
  readonly approvalPolicy: OrchestratorApprovalPolicy;
  readonly sandboxMode: SandboxMode;
  readonly permissionHooks: ReadonlyArray<PermissionRequestHook> | undefined;
  readonly approvalResolver: ApprovalResolver | undefined;
} {
  const ctxApproval = ctx.approvalPolicy?.value;
  const ctxSandbox = ctx.sandboxPolicy?.value;
  const services = session.services as
    | (typeof session.services & {
        readonly permissionRequestHooks?: ReadonlyArray<PermissionRequestHook>;
        readonly approvalResolver?: ApprovalResolver;
      })
    | undefined;
  return {
    approvalPolicy: (ctxApproval ?? "never") as OrchestratorApprovalPolicy,
    sandboxMode: (ctxSandbox ?? "workspace_write") as SandboxMode,
    permissionHooks: services?.permissionRequestHooks,
    approvalResolver: services?.approvalResolver,
  };
}

export function ensureStreamingToolExecutor(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
  signal?: AbortSignal,
): StreamingToolExecutor {
  let executor = state.streamingToolExecutor as StreamingToolExecutor | null;
  if (executor) return executor;

  const runtime = new ToolCallRuntime();
  const router = routerFromRegistry(session.services.registry);
  const hookRegistry = resolveHookRegistry(session);
  const preHooks = hookRegistry.getPre();
  const postHooks = hookRegistry.getPost();
  const failureHooks = hookRegistry.getFailure();
  const permissionDecisionHooks = hookRegistry.getPermission();
  const orchestratorPolicy = resolveOrchestratorSessionPolicy(ctx, session);

  const resolvedDenialTracking =
    session.denialTracking ?? freshDenialTracking();
  const resolvedExecutionSurface: "cli" | "headless" =
    process.stdin && process.stdin.isTTY === false ? "headless" : "cli";
  const permissionModeRegistry = session.services.permissionModeRegistry;
  const permissionContext: ToolEvaluatorContext | null = permissionModeRegistry
    ? attachContextDefaults({
        session,
        denialTracking: resolvedDenialTracking,
        executionSurface: resolvedExecutionSurface,
        getAppState: (): AppStateSnapshot => {
          const current = permissionModeRegistry.current();
          return {
            toolPermissionContext: current,
            denialTracking: resolvedDenialTracking,
            autoModeActive: current.autoModeActive === true,
          };
        },
      })
    : null;

  executor = new StreamingToolExecutor({
    registry: session.services.registry,
    abortSignal: signal,
    runtime,
    onSiblingAbort: (reason) => {
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "warning",
          payload: {
            cause: "sibling_tool_abort",
            message: `sibling tools cancelled: ${reason}`,
          },
        },
      });
    },
    liveToolDispatch: {
      router,
      options: {
        session,
        turn: ctx,
        tracker: createNoopTracker(),
        approvalPolicy: orchestratorPolicy.approvalPolicy,
        sandboxMode: orchestratorPolicy.sandboxMode,
        ...(orchestratorPolicy.permissionHooks !== undefined
          ? { permissionHooks: orchestratorPolicy.permissionHooks }
          : {}),
        ...(orchestratorPolicy.approvalResolver !== undefined
          ? { approvalResolver: orchestratorPolicy.approvalResolver }
          : {}),
        ...(preHooks.length > 0 ? { preHooks } : {}),
        ...(postHooks.length > 0 ? { postHooks } : {}),
        ...(failureHooks.length > 0 ? { failureHooks } : {}),
        ...(permissionDecisionHooks.length > 0
          ? { permissionDecisionHooks }
          : {}),
        ...(permissionContext !== null
          ? {
              canUseTool: hasPermissionsToUseTool,
              permissionContext,
              modeChangeRegistry: permissionModeRegistry,
            }
          : {}),
        onHookError: (phase, err, idx) => {
          session.emit({
            id: session.nextInternalSubId(),
            msg: {
              type: "warning",
              payload: {
                cause: `${phase}_tool_hook_threw`,
                message: `${phase} hook ${idx} threw: ${err instanceof Error ? err.message : String(err)}`,
              },
            },
          });
        },
      },
    },
  });
  state.streamingToolExecutor = executor;
  return executor;
}

export function queueStreamingToolCall(
  executor: StreamingToolExecutor,
  block: ToolUseBlock,
  call: LLMToolCall,
  session: Session,
): boolean {
  const alreadyQueued = executor
    .getToolStates()
    .some((state) => state.id === call.id);
  if (alreadyQueued) return false;
  session.emit({
    id: session.nextInternalSubId(),
    msg: toolCallStartedEvent(call),
  });
  executor.addTool(block, call);
  return true;
}

function recordCompletedToolCall(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
  toolCall: LLMToolCall,
  result: ToolDispatchResult,
): void {
  const toolResultBytes = Buffer.byteLength(result.content, "utf8");
  session.emit({
    id: session.nextInternalSubId(),
    msg: {
      type: "tool_call_completed",
      payload: {
        callId: toolCall.id,
        result: result.content,
        isError: result.isError === true,
      },
    },
  }, {
    turnId: ctx.subId,
    toolResultBytes,
  });
  state.toolResults.push(
    toolResultUserRecord(toolCall.id, toolCall.name, result),
  );
  state.messages.push(toolResultMessage(toolCall.id, result));
}

async function drainCompletedToolResults(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
  executor: StreamingToolExecutor,
): Promise<void> {
  for (const completed of executor.getCompletedResults()) {
    recordCompletedToolCall(
      state,
      ctx,
      session,
      completed.toolCall,
      completed.result,
    );
  }
  await Promise.resolve();
}

export async function executeTools(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
  signal?: AbortSignal,
): Promise<TurnState> {
  const assistant = state.assistantMessages.at(-1);
  if (
    (!assistant || assistant.toolCalls.length === 0) &&
    state.streamingToolExecutor === null
  ) {
    return state;
  }

  // I-54: validate every tool_use block shape BEFORE dispatch. Malformed
  // blocks (missing id/name/non-string arguments) emit stream_error
  // and are removed from the batch so dispatch only sees valid calls.
  const assistantToolCalls = assistant?.toolCalls ?? [];
  const batch = validateToolCallsForExecution(assistantToolCalls);
  if (batch.failures.length > 0) {
    for (const failure of batch.failures) {
      emitErrorEvent(session.eventLog, session.nextInternalSubId(), {
        cause: "malformed_tool_call",
        message: `provider returned malformed tool_use (${failure.cause})`,
        streamError: true,
        provider: session.services.provider.name,
      });
    }
  }
  const validCallIds = new Set(batch.valid.map((c) => c.id));
  const filteredToolCalls = assistantToolCalls.filter((c) =>
    validCallIds.has(c.id),
  );
  if (filteredToolCalls.length === 0 && state.streamingToolExecutor === null) {
    // All calls malformed — nothing to dispatch. Return so post-
    // sample recovery / continuation can route via the normal
    // `needsFollowUp` flow.
    state.needsFollowUp = false;
    return state;
  }

  const executor = ensureStreamingToolExecutor(state, ctx, session, signal);

  // T7 gap #109: AGENC_MAX_TOOL_USE_CONCURRENCY env cap. The
  // StreamingToolExecutor's internal `canExecuteTool` gate is
  // ConcurrencyClass-based; it does not apply a hard numeric cap. We
  // layer the env cap on top by batching addTool calls: at most
  // `envCap` tools are queued concurrently; we drain the executor to
  // one completed result before queueing the next.
  const envCap = resolveMaxToolUseConcurrency();
  const toolBlocksById = new Map(
    state.toolUseBlocks.map((block) => [block.id, block] as const),
  );
  const queuedNotYieldedCount = (): number =>
    executor
      .getToolStates()
      .filter((tool) => tool.status !== "yielded").length;

  for (const call of filteredToolCalls) {
    const block = toolBlocksById.get(call.id);
    if (!block) continue;
    if (signal?.aborted) break;

    // Env-cap gate: if queued-not-yielded already equals the cap, wait
    // for at least one to complete before pushing the next.
    while (queuedNotYieldedCount() >= envCap) {
      if (signal?.aborted) break;
      // Drain whatever is already completed; if none yet, await the
      // next one via the executor's async generator.
      await drainCompletedToolResults(state, ctx, session, executor);
      if (queuedNotYieldedCount() < envCap) break;
      // Poll with a microtask; the streaming executor's internal
      // signalProgress wakes on every status transition.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    queueStreamingToolCall(executor, block, call, session);
  }

  // Signal the executor that no more tools will arrive; drain results.
  executor.close();

  for await (const { toolCall, result } of executor.getRemainingResults()) {
    if (signal?.aborted) break;
    recordCompletedToolCall(state, ctx, session, toolCall, result);
  }

  // Clear the executor from state so commit starts a fresh one next
  // iteration. Matches openclaude query.ts's per-iteration
  // `streamingToolExecutor = new StreamingToolExecutor(...)`.
  state.streamingToolExecutor = null;

  return state;
}
