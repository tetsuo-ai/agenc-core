/**
 * Phase 5 — Execute Tools.
 *
 * Dispatches tool calls produced by the stream phase through the
 * StreamingToolExecutor, collects results, and appends `tool` messages
 * to `state.messages` so the next iteration provides them to the
 * model.
 *
 * Mirrors AgenC `query.ts:1467-1635`. The executor accepts tool
 * calls mid-stream (AgenC query.ts:572 starts the executor
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

import type {
  LLMContentPart,
  LLMMessage,
  LLMToolCall,
} from "../llm/types.js";
import { validateToolCallsForExecution } from "../llm/stream-parser.js";
import {
  StreamingToolExecutor,
  ToolCallRuntime,
  ToolHookRegistry,
  routerFromRegistry,
  type PermissionDecisionHook,
  type PostToolUseFailureHook,
  type PostToolUseHook,
  type PreToolUseHook,
} from "./_deps/tool-runtime.js";
import {
  type ApprovalPolicy as OrchestratorApprovalPolicy,
  type ApprovalResolver,
  type PermissionRequestHook,
  type SandboxMode,
} from "./_deps/orchestrator-types.js";
import { resolveMaxToolUseConcurrency } from "./_deps/orchestration.js";
import type { ToolDispatchResult } from "./_deps/tool-registry.js";
import { emitError as emitErrorEvent } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import type { GuardianApprovalReviewer } from "../session/guardian-approval-review.js";
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
    content: toolResultContent(result),
  };
}

function toolResultContent(result: ToolDispatchResult): LLMMessage["content"] {
  if (!result.contentItems || result.contentItems.length === 0) {
    return result.content;
  }
  const parts: LLMContentPart[] = [];
  for (const item of result.contentItems) {
    if (
      typeof item === "object" &&
      item !== null &&
      (item as { type?: unknown }).type === "input_text"
    ) {
      parts.push({
        type: "text",
        text: String((item as { text?: unknown }).text ?? ""),
      });
      continue;
    }
    if (
      typeof item === "object" &&
      item !== null &&
      (item as { type?: unknown }).type === "input_image"
    ) {
      parts.push({
        type: "image_url",
        image_url: {
          url: String((item as { image_url?: unknown }).image_url ?? ""),
        },
      });
    }
  }
  return parts.length > 0 ? parts : result.content;
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
    content: toolResultContent(result),
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

function emitMalformedToolCallFailures(
  session: Session,
  failures: ReadonlyArray<{ readonly cause: string }>,
): void {
  for (const failure of failures) {
    emitErrorEvent(session.eventLog, session.nextInternalSubId(), {
      cause: "malformed_tool_call",
      message: `provider returned malformed tool_use (${failure.cause})`,
      streamError: true,
      provider: session.services.provider.name,
    });
  }
}

export function validateToolCallsForDispatch(
  raw: ReadonlyArray<unknown>,
  session: Session,
) {
  const batch = validateToolCallsForExecution(raw);
  if (batch.failures.length > 0) {
    emitMalformedToolCallFailures(session, batch.failures);
  }
  return batch;
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
  readonly guardianApprovalReviewer: GuardianApprovalReviewer | undefined;
  readonly approvalResolver: ApprovalResolver | undefined;
} {
  const ctxApproval = ctx.approvalPolicy?.value;
  const ctxSandbox = ctx.sandboxPolicy?.value;
  const services = session.services as
    | (typeof session.services & {
        readonly permissionRequestHooks?: ReadonlyArray<PermissionRequestHook>;
        readonly guardianApprovalReviewer?: GuardianApprovalReviewer;
        readonly approvalResolver?: ApprovalResolver;
      })
    | undefined;
  return {
    approvalPolicy: (ctxApproval ?? "never") as OrchestratorApprovalPolicy,
    sandboxMode: (ctxSandbox ?? "workspace_write") as SandboxMode,
    permissionHooks: services?.permissionRequestHooks,
    guardianApprovalReviewer: services?.guardianApprovalReviewer,
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
  const discoveredToolNames =
    session.services.registry.getDiscoveredToolNames?.();
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
        ...(orchestratorPolicy.guardianApprovalReviewer !== undefined
          ? {
              guardianApprovalReviewer:
                orchestratorPolicy.guardianApprovalReviewer,
            }
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
        ...(discoveredToolNames !== undefined ? { discoveredToolNames } : {}),
        onHookError: (phase: string, err: unknown, idx: number) => {
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
        ...(result.metadata !== undefined ? { metadata: result.metadata } : {}),
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
  const batch = validateToolCallsForDispatch(assistantToolCalls, session);
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

  // T7 gap #109: AGENC_MAX_TOOL_USE_CONCURRENCY env cap. We layer the
  // env cap on top of the executor by gating queue + dispatch: at
  // most `envCap` tools are in-flight concurrently. After each queued
  // call we kick off `dispatchPending()` so workers run in parallel,
  // then pause queuing if `inflightCount` already equals the cap.
  const envCap = resolveMaxToolUseConcurrency();
  const toolBlocksById = new Map(
    state.toolUseBlocks.map((block) => [block.id, block] as const),
  );

  for (const call of filteredToolCalls) {
    const block = toolBlocksById.get(call.id);
    if (!block) continue;

    // Env-cap gate: if in-flight already equals the cap, wait for at
    // least one to complete before queueing the next.
    while (executor.inflightCount() >= envCap) {
      await drainCompletedToolResults(state, ctx, session, executor);
      if (executor.inflightCount() < envCap) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }

    queueStreamingToolCall(executor, block, call, session);
    // Kick off any newly-queued workers so they can run in parallel
    // with subsequent queueing iterations.
    executor.dispatchPending();
  }

  // Signal the executor that no more tools will arrive; drain results.
  executor.close();

  for await (const { toolCall, result } of executor.getRemainingResults()) {
    recordCompletedToolCall(state, ctx, session, toolCall, result);
  }

  // Clear the executor from state so commit starts a fresh one next
  // iteration. Matches AgenC query.ts's per-iteration
  // `streamingToolExecutor = new StreamingToolExecutor(...)`.
  state.streamingToolExecutor = null;

  return state;
}
