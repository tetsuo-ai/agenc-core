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
 * T7 gap #109 — this phase is also the integration site for the four
 * previously-dead port modules:
 *
 *   - `tools/router.ts` → `ToolRouter` + `routerFromRegistry` classify
 *     each incoming tool call and emit a `tool_routing_classified`
 *     telemetry warning so downstream observability sees the routing
 *     decision.
 *   - `tools/orchestrator.ts` → `classifyToolApproval` +
 *     `attemptWithRetry` wrap `runToolUse` with an approval-policy
 *     classification pass and one bounded retry on known-retriable
 *     failures.
 *   - `tools/orchestration.ts` → `resolveMaxToolUseConcurrency()`
 *     applies the env-capped `AGENC_MAX_TOOL_USE_CONCURRENCY`
 *     (default 10) to the per-turn batch by limiting how many tools
 *     are queued concurrently into the streaming executor.
 *   - `tools/tool-hooks.ts` → `ToolHookRegistry` + pre/post hook
 *     runners fire before/after every `runToolUse` dispatch. The
 *     registry pulls from `session.services.hooks` when it exposes
 *     `preToolUseHooks` / `postToolUseHooks`, otherwise it stays empty.
 *     Auto-fix retry via post-hook `{kind:"retry"}` is honored through
 *     the existing dispatch path.
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
import type { Tool } from "../tools/types.js";
import { runToolUse, parseToolArgsWithBigInt } from "../tools/execution.js";
import { parseToolName } from "../tools/context.js";
import { routerFromRegistry, toolCallFromLLMToolCall } from "../tools/router.js";
import {
  attemptWithRetry,
  classifyToolApproval,
  defaultToolRetryPolicy,
  isApprovalAccepted,
  isSandboxDeniedError,
  requestApproval,
  type ApprovalCtx,
  type ApprovalPolicy as OrchestratorApprovalPolicy,
  type ApprovalResolver,
  type PermissionRequestHook,
  type SandboxMode,
} from "../tools/orchestrator.js";
import { resolveMaxToolUseConcurrency } from "../tools/orchestration.js";
import {
  runWithAutoFixRetry,
  ToolHookRegistry,
  type PermissionDecisionHook,
  type PostToolUseFailureHook,
  type PostToolUseHook,
  type PreToolUseHook,
} from "../tools/tool-hooks.js";
import type { ToolDispatchResult } from "../tool-registry.js";
import {
  emitError as emitErrorEvent,
  emitWarning as emitWarningEvent,
} from "../session/event-log.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { TurnState, UserMessage } from "../session/turn-state.js";

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

export async function executeTools(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
  signal?: AbortSignal,
): Promise<TurnState> {
  const assistant = state.assistantMessages.at(-1);
  if (!assistant || assistant.toolCalls.length === 0) return state;

  // I-54: validate every tool_use block shape BEFORE dispatch. Malformed
  // blocks (missing id/name/non-string arguments) emit stream_error
  // and are removed from the batch so dispatch only sees valid calls.
  const batch = validateToolCallsForExecution(assistant.toolCalls);
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
  const filteredToolCalls = assistant.toolCalls.filter((c) =>
    validCallIds.has(c.id),
  );
  if (filteredToolCalls.length === 0) {
    // All calls malformed — nothing to dispatch. Return so post-
    // sample recovery / continuation can route via the normal
    // `needsFollowUp` flow.
    state.needsFollowUp = false;
    return state;
  }

  // T7: shared ToolCallRuntime per-executor so ConcurrencyClass
  // dispatch (RwLock + per-serverId semaphore) gates the tool calls.
  const runtime = new ToolCallRuntime();

  // T7 gap #109: build the auxiliary pipeline surfaces once per turn.
  //   - router: classification/telemetry per tool call
  //   - hookRegistry: pre/post/failure/permission hooks from session services
  const router = routerFromRegistry(session.services.registry);
  const hookRegistry = resolveHookRegistry(session);
  const preHooks = hookRegistry.getPre();
  const postHooks = hookRegistry.getPost();
  const failureHooks = hookRegistry.getFailure();
  const permissionDecisionHooks = hookRegistry.getPermission();

  // T7 (orchestrator gap): session-derived approval policy + sandbox
  // mode. Replaces the previous hardcoded `never` + `workspace_write`
  // that hid the real classifier behind a no-op.
  const orchestratorPolicy = resolveOrchestratorSessionPolicy(ctx, session);

  // Construct (or reuse) the streaming executor. T7 upgrades the
  // T5 shell to a full openclaude port with ConcurrencyClass-aware
  // parallelism + Bash-only sibling abort + I-41 re-entrance guard.
  let executor = state.streamingToolExecutor as StreamingToolExecutor | null;
  if (!executor) {
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
      // T7: route dispatch through `runToolUse` so I-9 timeout +
      // I-15 cap + I-79 BigInt reviver are applied to every tool.
      //
      // Pipeline order (T7 gap #109):
      //   1. Router classifies (telemetry only; returns spec).
      //   2. Orchestrator approval classification runs (logged on
      //      forbidden/needs_approval when no modal is wired).
      //   3. Pre-hooks fire — may mutate args, deny, or short-circuit
      //      with a synthesized result.
      //   4. `runToolUse` executes under `attemptWithRetry` so a
      //      transient failure gets one bounded retry.
      //   5. Post-hooks fire — may rewrite the result; retry decisions
      //      are logged but not re-dispatched inside the executor (the
      //      auto-fix loop belongs in a future sub-agent wrapper; the
      //      wire here honors `rewrite` which is the common path).
      runToolUseFn: async (
        toolCall: LLMToolCall,
        childSignal: AbortSignal,
      ): Promise<ToolDispatchResult> => {
        const tool = session.services.registry.tools.find(
          (t) => t.name === toolCall.name,
        ) as Tool | undefined;
        if (!tool) {
          return {
            content: JSON.stringify({ error: `unknown tool: ${toolCall.name}` }),
            isError: true,
          };
        }
        const parsed = parseToolArgsWithBigInt(toolCall.arguments ?? "");
        if (parsed === null) {
          return {
            content: JSON.stringify({
              error: `invalid JSON arguments for tool ${toolCall.name}`,
            }),
            isError: true,
          };
        }

        // Step 1: Router classification → telemetry warning.
        const routed = toolCallFromLLMToolCall(toolCall);
        const routerSpec = router.findSpec(toolCall.name);
        emitWarningEvent(
          session.eventLog,
          toolCall.id,
          "tool_routing_classified",
          JSON.stringify({
            toolName: toolCall.name,
            supportsParallel: router.toolSupportsParallel(routed),
            hasSpec: routerSpec !== undefined,
          }),
        );

        // Build the canonical invocation envelope once — it's reused
        // by the classifier (payload-variant routing), approval ctx,
        // and runToolUse.
        const invocation = {
          session,
          turn: ctx,
          tracker: {
            appendFileDiff: () => {},
            snapshot: () => [],
            clear: () => {},
          },
          callId: toolCall.id,
          toolName: parseToolName(toolCall.name),
          payload: {
            kind: "function" as const,
            arguments: toolCall.arguments ?? "",
          },
          source: "direct" as const,
        };

        // Step 2: Orchestrator approval classification. Now routed by
        // ToolPayload.kind — function/custom share the legacy logic,
        // mcp consults server-side trust, local_shell routes through
        // the fs-policy matrix, tool_search is always read-only.
        const approval = classifyToolApproval(tool, {
          approvalPolicy: orchestratorPolicy.approvalPolicy,
          sandboxMode: orchestratorPolicy.sandboxMode,
          payload: invocation.payload,
        });
        if (approval.kind === "forbidden") {
          return {
            content: JSON.stringify({
              error: `tool ${toolCall.name} forbidden: ${approval.reason}`,
            }),
            isError: true,
          };
        }
        if (approval.kind === "needs_approval") {
          const approvalCtx: ApprovalCtx = {
            invocation,
            callId: toolCall.id,
            toolName: toolCall.name,
            turnId: ctx.subId,
            ...(approval.reason !== undefined ? { retryReason: approval.reason } : {}),
          };
          const result = await requestApproval({
            ctx: approvalCtx,
            ...(orchestratorPolicy.permissionHooks !== undefined
              ? { hooks: orchestratorPolicy.permissionHooks }
              : {}),
            ...(permissionDecisionHooks.length > 0
              ? { permissionDecisionHooks, args: parsed }
              : {}),
            ...(orchestratorPolicy.approvalResolver !== undefined
              ? { resolver: orchestratorPolicy.approvalResolver }
              : {}),
            onNoResolver: () => {
              emitWarningEvent(
                session.eventLog,
                toolCall.id,
                "no_approval_resolver",
                `tool ${toolCall.name} needs approval but no resolver is registered`,
              );
            },
          });
          if (!isApprovalAccepted(result.decision)) {
            return {
              content: JSON.stringify({
                error:
                  result.source === "default_deny"
                    ? `tool ${toolCall.name} denied: no_approval_resolver`
                    : `tool ${toolCall.name} denied by approval: ${result.decision}`,
              }),
              isError: true,
            };
          }
        }

        // Step 3: Single-tool dispatch through `runToolUse`. The per-call
        // hook boundary (pre / post / failure / schema validation /
        // timeout / size cap / BigInt reviver / progress) now lives
        // INSIDE `runToolUse` so every entry path — direct, code_mode,
        // js_repl, repl — shares the exact same hook invocation order.
        const dispatchOnce = async (
          rawArgsOverride?: string,
        ): Promise<ToolDispatchResult> => {
          const output = await runToolUse(rawArgsOverride ?? toolCall.arguments ?? "", {
            ...(childSignal !== undefined ? { signal: childSignal } : {}),
            currentTurnId: ctx.subId,
            tool,
            invocation,
            eventLog: session.eventLog,
            subId: toolCall.id,
            preHooks,
            postHooks: [], // post hooks are handled by runWithAutoFixRetry
            failureHooks,
            onHookError: (phase, err, idx) => {
              emitWarningEvent(
                session.eventLog,
                toolCall.id,
                `${phase}_tool_hook_threw`,
                `${phase} hook ${idx} threw: ${err instanceof Error ? err.message : String(err)}`,
              );
            },
          });
          return { content: output.content, isError: output.isError };
        };

        // Step 4: Orchestrator retry wrap for transient + sandbox-denied
        // classes. Auto-fix retry (post-hook `retry`) is handled by
        // `runWithAutoFixRetry` below — it dispatches through the same
        // `runToolUse` surface so pre-hooks + failure hooks still fire
        // on every attempt.
        let dispatchResult: ToolDispatchResult;
        try {
          dispatchResult = await attemptWithRetry({
            dispatch: dispatchOnce,
            onFailure: defaultToolRetryPolicy,
            maxAttempts: 2,
          });
        } catch (err) {
          if (isSandboxDeniedError(err)) {
            // Two-pass sandbox escalation — request approval and retry
            // once with sandbox off. Codex orchestrator.rs:236-373.
            const escalationCtx: ApprovalCtx = {
              invocation,
              callId: toolCall.id,
              toolName: toolCall.name,
              turnId: ctx.subId,
              retryReason:
                err.message || "command failed; retry without sandbox?",
            };
            const escalation = await requestApproval({
              ctx: escalationCtx,
              ...(orchestratorPolicy.permissionHooks !== undefined
                ? { hooks: orchestratorPolicy.permissionHooks }
                : {}),
              ...(permissionDecisionHooks.length > 0
                ? { permissionDecisionHooks, args: parsed }
                : {}),
              ...(orchestratorPolicy.approvalResolver !== undefined
                ? { resolver: orchestratorPolicy.approvalResolver }
                : {}),
              onNoResolver: () => {
                emitWarningEvent(
                  session.eventLog,
                  toolCall.id,
                  "no_approval_resolver",
                  `sandbox escalation for ${toolCall.name} needs approval but no resolver is registered`,
                );
              },
            });
            if (!isApprovalAccepted(escalation.decision)) {
              return {
                content: JSON.stringify({
                  error:
                    escalation.source === "default_deny"
                      ? `sandbox escalation denied: no_approval_resolver`
                      : `sandbox escalation denied: ${escalation.decision}`,
                }),
                isError: true,
              };
            }
            try {
              dispatchResult = await dispatchOnce();
            } catch (retryErr) {
              const message =
                retryErr instanceof Error ? retryErr.message : String(retryErr);
              return {
                content: JSON.stringify({ error: message }),
                isError: true,
              };
            }
          } else {
            const message = err instanceof Error ? err.message : String(err);
            return {
              content: JSON.stringify({ error: message }),
              isError: true,
            };
          }
        }

        // Step 5: Post-hook pipeline with real auto-fix retry. `rewrite`
        // decisions replace the result; `retry` decisions trigger
        // `runWithAutoFixRetry` which bounded-dispatches again through
        // `runToolUse` so pre-hooks + schema validation + failure hooks
        // continue to fire on every attempt.
        if (postHooks.length === 0) {
          return dispatchResult;
        }
        try {
          const finalResult = await runWithAutoFixRetry({
            invocation,
            tool,
            initialArgs: parsed,
            dispatch: async (retryArgs) => {
              // The first dispatch has already happened above — runWithAutoFixRetry
              // always redispatches before running hooks. To avoid a
              // wasted first call, seed the loop by running the
              // post-hooks against `dispatchResult` via a one-shot
              // dispatch function that returns the cached result
              // on the first call, then re-dispatches with hook-supplied
              // args on subsequent attempts.
              if (retryArgs === parsed) {
                return dispatchResult;
              }
              return dispatchOnce(JSON.stringify(retryArgs));
            },
            postHooks,
            onError: (err, idx) => {
              emitWarningEvent(
                session.eventLog,
                toolCall.id,
                "post_tool_hook_threw",
                `post hook ${idx} threw: ${err instanceof Error ? err.message : String(err)}`,
              );
            },
          });
          return finalResult;
        } catch (err) {
          emitWarningEvent(
            session.eventLog,
            toolCall.id,
            "post_tool_hook_retry_failed",
            `auto-fix retry threw: ${err instanceof Error ? err.message : String(err)}`,
          );
          return dispatchResult;
        }
      },
    });
    state.streamingToolExecutor = executor;
  }

  // T7 gap #109: AGENC_MAX_TOOL_USE_CONCURRENCY env cap. The
  // StreamingToolExecutor's internal `canExecuteTool` gate is
  // ConcurrencyClass-based; it does not apply a hard numeric cap. We
  // layer the env cap on top by batching addTool calls: at most
  // `envCap` tools are queued concurrently; we drain the executor to
  // one completed result before queueing the next.
  const envCap = resolveMaxToolUseConcurrency();

  // Queue every VALID tool_use block (I-54 gate) into the executor.
  // ConcurrencyClass dispatch gates parallelism per tool.
  const queuedCalls: LLMToolCall[] = [];
  const drainCompletedIntoState = async (): Promise<void> => {
    for (const completed of executor!.getCompletedResults()) {
      const { toolCall, result } = completed;
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
      });
      state.toolResults.push(
        toolResultUserRecord(toolCall.id, toolCall.name, result),
      );
      state.messages.push(toolResultMessage(toolCall.id, result));
    }
    // Also give the microtask queue a tick so streaming executor
    // promises can settle when envCap=1 forces serialization.
    await Promise.resolve();
  };

  for (const call of filteredToolCalls) {
    const i = assistant.toolCalls.indexOf(call);
    const block = state.toolUseBlocks[i];
    if (!block) continue;
    if (signal?.aborted) break;

    // Env-cap gate: if queued-not-yielded already equals the cap, wait
    // for at least one to complete before pushing the next.
    while (
      queuedCalls.filter(
        (c) =>
          !executor!
            .getToolStates()
            .some((s) => s.id === c.id && s.status === "yielded"),
      ).length >= envCap
    ) {
      if (signal?.aborted) break;
      // Drain whatever is already completed; if none yet, await the
      // next one via the executor's async generator.
      await drainCompletedIntoState();
      const inflight = queuedCalls.filter((c) =>
        executor!
          .getToolStates()
          .some(
            (s) =>
              s.id === c.id &&
              s.status !== "yielded" &&
              s.status !== "completed",
          ),
      ).length;
      if (inflight === 0) break;
      // Poll with a microtask; the streaming executor's internal
      // signalProgress wakes on every status transition.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "tool_call_started",
        payload: {
          callId: call.id,
          toolName: call.name,
          args: call.arguments,
        },
      },
    });
    executor.addTool(block, call);
    queuedCalls.push(call);
  }

  // Signal the executor that no more tools will arrive; drain results.
  executor.close();

  for await (const { toolCall, result } of executor.getRemainingResults()) {
    if (signal?.aborted) break;
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
    });
    state.toolResults.push(
      toolResultUserRecord(toolCall.id, toolCall.name, result),
    );
    state.messages.push(toolResultMessage(toolCall.id, result));
  }

  // Clear the executor from state so commit starts a fresh one next
  // iteration. Matches openclaude query.ts's per-iteration
  // `streamingToolExecutor = new StreamingToolExecutor(...)`.
  state.streamingToolExecutor = null;

  return state;
}
