/**
 * Phase 5 — Execute Tools.
 *
 * Dispatches tool calls produced by the stream phase through the
 * StreamingToolExecutor, collects results, and appends `tool` messages
 * to `state.messages` so the next iteration provides them to the
 * model.
 *
 * Mirrors agenc `query.ts:1467-1635`. The executor accepts tool
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

import type { LLMContentPart, LLMMessage, LLMToolCall } from "../llm/types.js";
import { validateToolCallsForExecution } from "../llm/stream-parser.js";
import { StreamingToolExecutor } from "../tools/streaming-executor.js";
import { createToolExecutionRuntime } from "../tools/runtimes/parallel.js";
import {
  ToolHookRegistry,
  type PermissionDecisionHook,
  type PostToolUseFailureHook,
  type PostToolUseHook,
  type PreToolUseHook,
} from "../tools/hooks.js";
import { routerFromRegistry } from "../tools/router.js";
import {
  type ApprovalPolicy as OrchestratorApprovalPolicy,
  type ApprovalResolver,
  type PermissionRequestHook,
  type SandboxMode,
} from "../tools/orchestrator.js";
import { resolveMaxToolUseConcurrency } from "../tools/orchestration.js";
import type { ToolDispatchResult } from "../tool-registry.js";
import { emitError as emitErrorEvent } from "../session/event-log.js";
import { emitWarning as emitWarningEvent } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import type { GuardianApprovalReviewer } from "../permissions/guardian/reviewer.js";
import type { PermissionAuditEventInput } from "../permissions/permission-audit-log.js";
import type { TurnContext } from "../session/turn-context.js";
import type {
  CompletedToolResultRecord,
  ToolUseBlock,
  ToolUseSummaryMessage,
  TurnState,
  UserMessage,
} from "../session/turn-state.js";
import {
  attachContextDefaults,
  hasPermissionsToUseTool,
  type AppStateSnapshot,
  type ToolEvaluatorContext,
} from "../permissions/evaluator.js";
import { freshDenialTracking } from "../permissions/denial-tracking.js";
import { recoverableFailureKind } from "../tools/result-metadata.js";
import { markLoadedToolNamesDiscovered } from "../tools/deferred-discovery.js";
import { isEnvTruthy } from "../utils/envUtils.js";
import { createToolUseSummaryMessage } from "../utils/messages.js";
import {
  generateToolUseSummary,
  type ToolUseSummaryToolInfo,
} from "../services/toolUseSummary/toolUseSummaryGenerator.js";
import {
  classifyUntrustedToolResult,
  frameUntrustedToolResultContent,
  type UntrustedToolResultKind,
} from "../tools/untrusted-tool-result-framing.js";
import { renderHookAdditionalContextSection } from "../prompts/hook-context-framing.js";

function toolResultMessage(
  callId: string,
  toolName: string,
  result: ToolDispatchResult,
  untrustedKind: UntrustedToolResultKind,
): LLMMessage {
  const message: LLMMessage = {
    role: "tool",
    toolCallId: callId,
    toolName,
    content: modelFacingToolResultContent(toolName, result, untrustedKind),
  };
  const failureKind = recoverableFailureKind(result.metadata);
  if (failureKind !== null) {
    message.runtimeOnly = {
      recoverableToolFailure: {
        hiddenFromTranscript: true,
        kind: failureKind,
      },
    };
  }
  return message;
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

function modelFacingToolResultContent(
  toolName: string,
  result: ToolDispatchResult,
  untrustedKind: UntrustedToolResultKind,
): LLMMessage["content"] {
  const content = toolResultContent(result);
  return frameUntrustedToolResultContent(toolName, content, untrustedKind);
}

function toolResultUserRecord(
  callId: string,
  toolName: string,
  result: ToolDispatchResult,
  untrustedKind: UntrustedToolResultKind,
): UserMessage {
  return {
    uuid: crypto.randomUUID(),
    role: "user",
    toolCallId: callId,
    toolName,
    content: modelFacingToolResultContent(toolName, result, untrustedKind),
  };
}

function appendHookAdditionalContexts(
  state: TurnState,
  session: Session,
  contexts: ReadonlyArray<string>,
): void {
  for (const context of contexts) {
    const modelFacingContext =
      renderHookAdditionalContextSection([
        {
          hookName: "ToolUse",
          hookEvent: "PreToolUse/PostToolUse",
          content: context,
        },
      ]) ?? context;
    emitWarningEvent(
      session.eventLog,
      session.nextInternalSubId(),
      "hook_additional_context",
      context,
    );
    state.toolResults.push({
      uuid: crypto.randomUUID(),
      role: "user",
      kind: "attachment",
      content: modelFacingContext,
    });
    state.messages.push({
      role: "user",
      content: modelFacingContext,
      runtimeOnly: { mergeBoundary: "user_context" },
    });
  }
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

/**
 * Last-resort recovery for the `toolBlocksById.get(call.id)` miss path
 * inside `executeTools`. Returns a freshly-synthesized `ToolUseBlock`
 * built from the call's own id/name/arguments so the dispatch can
 * proceed with the existing pre/post-hook machinery, the
 * unknown-tool short-circuit in `StreamingToolExecutor.addTool`, and
 * the result-emission contract that pairs every `tool_call_started`
 * with a `tool_call_completed`.
 *
 * Returns `null` only when the call itself is unrecognizable (no id),
 * which the caller must treat the same as the prior silent-drop
 * (there's no `tool_call_started` to pair anyway).
 */
function parseToolUseBlocksForSyntheticRecovery(
  call: LLMToolCall,
): ToolUseBlock | null {
  const id = call.id?.trim();
  if (!id) return null;
  let input: unknown;
  try {
    input = call.arguments ? JSON.parse(call.arguments) : undefined;
  } catch {
    input = call.arguments;
  }
  return {
    type: "tool_use" as const,
    id,
    name: call.name,
    input,
  };
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
 * the compatibility hardcoded behavior — so existing test fixtures without a
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
    // Fail closed when TurnContext omitted approval (todo-131): default
    // on_request rather than never.
    approvalPolicy: (ctxApproval ?? "on_request") as OrchestratorApprovalPolicy,
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
  if (executor) {
    executor.attachAbortSignal(signal);
    return executor;
  }

  const runtime = createToolExecutionRuntime();
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
    maxConcurrency: resolveMaxToolUseConcurrency(),
    abortSignal: signal,
    parentAbortController: session.abortController,
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
        ...(session.services.permissionAuditLogger !== undefined
          ? { permissionAuditLogger: session.services.permissionAuditLogger }
          : {}),
        onPermissionAuditError: (
          error: unknown,
          event: PermissionAuditEventInput,
        ) => {
          try {
            session.services.onPermissionAuditError?.(error, event);
          } catch (handlerError) {
            session.emit({
              id: session.nextInternalSubId(),
              msg: {
                type: "warning",
                payload: {
                  cause: "permission_audit_error_handler_failed",
                  message: `permission audit error handler failed:${handlerError instanceof Error ? handlerError.message : String(handlerError)}`,
                },
              },
            });
          }
          session.emit({
            id: session.nextInternalSubId(),
            msg: {
              type: "warning",
              payload: {
                cause: "permission_audit_log_failed",
                message: `permission audit log failed for ${event.eventKind}:${error instanceof Error ? error.message : String(error)}`,
              },
            },
          });
        },
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
): CompletedToolResultRecord {
  const registryTool = session.services.registry.tools.find(
    (tool) => tool.name === toolCall.name,
  );
  const untrustedKind = classifyUntrustedToolResult(
    toolCall.name,
    registryTool,
  );
  markLoadedToolNamesDiscovered(
    toolCall.name,
    result,
    session.services.registry.getDiscoveredToolNames?.(),
  );
  const toolResultBytes = Buffer.byteLength(result.content, "utf8");
  session.emit(
    {
      id: session.nextInternalSubId(),
      msg: {
        type: "tool_call_completed",
        payload: {
          callId: toolCall.id,
          result: result.content,
          isError: result.isError === true,
          ...(result.metadata !== undefined
            ? { metadata: result.metadata }
            : {}),
        },
      },
    },
    {
      turnId: ctx.subId,
      toolResultBytes,
    },
  );
  const completed: CompletedToolResultRecord = {
    callId: toolCall.id,
    toolName: toolCall.name,
    arguments: toolCall.arguments,
    content: result.content,
    isError: result.isError === true,
    ...(result.metadata !== undefined ? { metadata: result.metadata } : {}),
  };
  state.completedToolResults.push(completed);
  state.toolResults.push(
    toolResultUserRecord(toolCall.id, toolCall.name, result, untrustedKind),
  );
  state.messages.push(
    toolResultMessage(toolCall.id, toolCall.name, result, untrustedKind),
  );
  return completed;
}

function isSubagentSummaryTurn(ctx: TurnContext, session: Session): boolean {
  if (ctx.depth > 0) return true;
  if (ctx.sessionSource === "cli_subagent") return true;
  if (
    typeof ctx.sessionSource === "object" &&
    ctx.sessionSource?.kind === "subagent"
  ) {
    return true;
  }
  const querySource = session.services.querySource;
  return typeof querySource === "string" && querySource.startsWith("agent:");
}

function startToolUseSummaryGeneration(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
  completedThisPass: ReadonlyMap<string, CompletedToolResultRecord>,
  signal?: AbortSignal,
): void {
  if (!isEnvTruthy(process.env.AGENC_EMIT_TOOL_USE_SUMMARIES)) return;
  if (state.toolUseBlocks.length === 0) return;
  if (signal?.aborted) return;
  if (isSubagentSummaryTurn(ctx, session)) return;

  const summarySignal =
    signal ?? session.abortController?.signal ?? new AbortController().signal;
  const toolUseIds = state.toolUseBlocks.map((block) => block.id);
  const tools: ToolUseSummaryToolInfo[] = state.toolUseBlocks.map((block) => {
    const result = completedThisPass.get(block.id);
    return {
      name: block.name,
      input: block.input,
      output: result?.content ?? null,
    };
  });
  const lastAssistantText = state.assistantMessages.at(-1)?.text;

  state.pendingToolUseSummary = generateToolUseSummary({
    tools,
    signal: summarySignal,
    isNonInteractiveSession: false,
    provider: session.services.provider,
    ...(lastAssistantText !== undefined ? { lastAssistantText } : {}),
  })
    .then((summary): ToolUseSummaryMessage | null => {
      if (!summary) return null;
      return createToolUseSummaryMessage(
        summary,
        toolUseIds,
      ) as ToolUseSummaryMessage;
    })
    .catch(() => null);
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
  const normalizedToolCalls = batch.valid.filter((c) => validCallIds.has(c.id));
  if (
    normalizedToolCalls.length === 0 &&
    state.streamingToolExecutor === null
  ) {
    // All calls malformed — nothing to dispatch. Return so post-
    // sample recovery / continuation can route via the normal
    // `needsFollowUp` flow.
    state.needsFollowUp = false;
    return state;
  }

  const executor = ensureStreamingToolExecutor(state, ctx, session, signal);
  const additionalContexts: string[] = [];
  const completedThisPass = new Map<string, CompletedToolResultRecord>();
  let preventContinuation = false;

  const toolBlocksById = new Map(
    state.toolUseBlocks.map((block) => [block.id, block] as const),
  );

  for (const call of normalizedToolCalls) {
    let block = toolBlocksById.get(call.id);
    if (!block) {
      // Recover by synthesizing the missing block from the call itself.
      // This is the documented bug from the pwd-storm investigation:
      // when `state.toolUseBlocks` and `assistant.toolCalls` drift
      // (different ID sets after validation, or empty toolUseBlocks
      // for openai-compat providers that don't emit chunk.toolCalls
      // mid-stream), the prior `if (!block) continue` silently dropped
      // the dispatch. The tool_call event already fired upstream in
      // run-turn.ts so the TUI showed the call line; missing the
      // queue here meant no tool_result event ever followed, the
      // model saw silence on the next iteration, and re-emitted the
      // same call until it gave up. The synthetic block keeps the
      // dispatch path index-aligned so every tool_call_started event
      // pairs with a tool_call_completed event.
      const synthetic = parseToolUseBlocksForSyntheticRecovery(call);
      if (synthetic === null) continue;
      block = synthetic;
    }

    queueStreamingToolCall(executor, block, call, session);
    // Kick off any newly-queued workers so they can run in parallel
    // with subsequent queueing iterations. The executor owns the env
    // concurrency cap and wakes queued work as running calls complete.
    executor.dispatchPending();
  }

  // Signal the executor that no more tools will arrive; drain results.
  executor.close();

  for await (const {
    toolCall,
    result,
    additionalContexts: contexts,
  } of executor.getRemainingResults()) {
    const completed = recordCompletedToolCall(
      state,
      ctx,
      session,
      toolCall,
      result,
    );
    completedThisPass.set(completed.callId, completed);
    additionalContexts.push(...(contexts ?? []));
    if (result.preventContinuation === true) {
      preventContinuation = true;
    }
  }
  appendHookAdditionalContexts(state, session, additionalContexts);
  if (preventContinuation) {
    state.needsFollowUp = false;
    state.preventContinuation = true;
  }
  startToolUseSummaryGeneration(state, ctx, session, completedThisPass, signal);

  // Clear the executor from state so commit starts a fresh one next
  // iteration. Matches AgenC query.ts's per-iteration
  // `streamingToolExecutor = new StreamingToolExecutor(...)`.
  state.streamingToolExecutor = null;

  return state;
}
