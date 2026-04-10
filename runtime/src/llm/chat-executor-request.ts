/**
 * Top-level request orchestration extracted from `ChatExecutor`
 * (Phase F PR-8 E0 of the plan in TODO.MD).
 *
 * `executeRequest` composes the init + tool loop + Phase H hook
 * dispatch + terminal state derivation into a single pipeline.
 * After PR-1 through PR-7 did the heavy lifting, this function is
 * mostly plumbing: every downstream step is already a free helper,
 * and this module just threads deps + helpers through to them.
 *
 * Threaded as a pure free function that takes the params, a full
 * dependency bundle, and a helper bag carrying the callbacks that
 * still need to route back to the class's public API
 * (resetSessionTokens, the tool-loop entry point, and the hook
 * registry access).
 *
 * @module
 */

import {
  checkRequestTimeout,
} from "./chat-executor-ctx-helpers.js";
import {
  initializeExecutionContext,
  type InitializeExecutionContextDependencies,
  type InitializeExecutionContextHelpers,
} from "./chat-executor-init.js";
import { sanitizeFinalContent } from "./chat-executor-text.js";
import { summarizeStateful } from "./chat-executor-recovery.js";
import { dispatchHooks, defaultHookExecutor } from "./hooks/index.js";
import { resolveWorkflowCompletionState } from "../workflow/completion-state.js";
import { deriveWorkflowProgressSnapshot } from "../workflow/completion-progress.js";
import { buildRuntimeEconomicsSummary } from "./run-budget.js";
import { deriveActiveTaskContext } from "./turn-execution-contract.js";
import { resolveWorkflowEvidenceFromRequiredToolEvidence } from "./turn-execution-contract.js";
import type {
  ChatExecuteParams,
  ChatExecutorResult,
  ChatPlannerSummary,
  ExecutionContext,
} from "./chat-executor-types.js";
import type { HookRegistry } from "./hooks/index.js";
import type { RuntimeEconomicsPolicy } from "./run-budget.js";

/**
 * Dependency struct for `executeRequest`. Extends the init deps
 * with the hook registry (if any) and the economics policy handle
 * needed for the final economics summary. The rest of the
 * orchestration pipeline routes through the helpers bag below.
 */
export interface ExecuteRequestDependencies
  extends InitializeExecutionContextDependencies {
  readonly economicsPolicy: RuntimeEconomicsPolicy;
  readonly hookRegistry: HookRegistry | undefined;
}

/**
 * Helper callbacks for `executeRequest`. `resetSessionTokens`
 * forwards to the init helpers. `executeToolCallLoop` stays on the
 * class because PR-5's tool-loop callback struct still captures
 * the class instance via `this.callModelForPhase`; PR-8b will delete
 * that binding. `sessionTokens` is passed in so SessionStart hook
 * dispatch can check whether this is a first-touch session.
 */
export interface ExecuteRequestHelpers extends InitializeExecutionContextHelpers {
  readonly executeToolCallLoop: (ctx: ExecutionContext) => Promise<void>;
  readonly sessionTokens: ReadonlyMap<string, number>;
}

/**
 * Run a full chat execute() request: initialize the ctx, dispatch
 * SessionStart (Phase H), run the tool call loop, dispatch Stop /
 * StopFailure (Phase H), and assemble the terminal result.
 *
 * Phase F extraction (PR-8, E0). Previously
 * `ChatExecutor.executeRequest`.
 */
export async function executeRequest(
  params: ChatExecuteParams,
  deps: ExecuteRequestDependencies,
  helpers: ExecuteRequestHelpers,
): Promise<ChatExecutorResult> {
  const initHelpers: InitializeExecutionContextHelpers = {
    resetSessionTokens: helpers.resetSessionTokens,
  };
  const ctx = await initializeExecutionContext(params, deps, initHelpers);

  // Phase H: dispatch SessionStart the first time a session is
  // observed. `sessionTokens` is a per-session Map the executor
  // initializes lazily — absence of an entry means this is the
  // first execute() call for this session id. Mirrors
  // `claude_code/utils/sessionStart.ts:executeSessionStartHooks`.
  if (deps.hookRegistry && !helpers.sessionTokens.has(ctx.sessionId)) {
    await dispatchHooks({
      registry: deps.hookRegistry,
      event: "SessionStart",
      matchKey: ctx.sessionId,
      executor: defaultHookExecutor,
      context: {
        event: "SessionStart",
        sessionId: ctx.sessionId,
        messages: ctx.messages,
      },
    });
  }

  await helpers.executeToolCallLoop(ctx);

  checkRequestTimeout(ctx, "finalization");

  // Derive the final completion state from stop reason + tool calls.
  const workflowEvidence = resolveWorkflowEvidenceFromRequiredToolEvidence({
    requiredToolEvidence: ctx.requiredToolEvidence,
    runtimeContext: {
      workspaceRoot: ctx.runtimeWorkspaceRoot,
      activeTaskContext: deriveActiveTaskContext(ctx.turnExecutionContract),
    },
  });
  ctx.completionState = resolveWorkflowCompletionState({
    stopReason: ctx.stopReason,
    toolCalls: ctx.allToolCalls,
    verificationContract: workflowEvidence.verificationContract,
    completionContract: workflowEvidence.completionContract,
    completedRequestMilestoneIds: ctx.completedRequestMilestoneIds,
    validationCode: ctx.validationCode,
  });

  const durationMs = Date.now() - ctx.startTime;
  const plannerSummary: ChatPlannerSummary = ctx.plannerSummaryState;

  ctx.finalContent = sanitizeFinalContent(ctx.finalContent);
  const completionProgress = deriveWorkflowProgressSnapshot({
    stopReason: ctx.stopReason,
    completionState: ctx.completionState,
    stopReasonDetail: ctx.stopReasonDetail,
    validationCode: ctx.validationCode,
    toolCalls: ctx.allToolCalls,
    verificationContract: workflowEvidence.verificationContract,
    completionContract: workflowEvidence.completionContract,
    completedRequestMilestoneIds: ctx.completedRequestMilestoneIds,
    updatedAt: Date.now(),
    contractFingerprint: ctx.turnExecutionContract.contractFingerprint,
  });

  // Phase H: dispatch Stop / StopFailure at the terminal path.
  // Stop fires on completed state; StopFailure on any non-
  // completed state (budget_exceeded, no_progress, cancelled,
  // provider_error, timeout, etc.). Mirrors
  // `claude_code/query/stopHooks.ts:executeStopHooks`.
  if (deps.hookRegistry) {
    const stopEvent: "Stop" | "StopFailure" =
      ctx.stopReason === "completed" || ctx.stopReason === "tool_calls"
        ? "Stop"
        : "StopFailure";
    await dispatchHooks({
      registry: deps.hookRegistry,
      event: stopEvent,
      matchKey: ctx.sessionId,
      executor: defaultHookExecutor,
      context: {
        event: stopEvent,
        sessionId: ctx.sessionId,
        messages: ctx.messages,
      },
    });
  }

  return {
    content: ctx.finalContent,
    provider: ctx.providerName,
    model: ctx.responseModel,
    usedFallback: ctx.usedFallback,
    toolCalls: ctx.allToolCalls,
    providerEvidence: ctx.providerEvidence,
    tokenUsage: ctx.cumulativeUsage,
    callUsage: ctx.callUsage,
    durationMs,
    compacted: ctx.compacted,
    statefulSummary: summarizeStateful(ctx.callUsage),
    toolRoutingSummary: ctx.toolRouting
      ? {
        enabled: true,
        initialToolCount: ctx.initialRoutedToolNames.length,
        finalToolCount: ctx.activeRoutedToolNames.length,
        routeMisses: ctx.routedToolMisses,
        expanded: ctx.routedToolsExpanded,
      }
      : undefined,
    plannerSummary,
    economicsSummary: buildRuntimeEconomicsSummary(
      deps.economicsPolicy,
      ctx.economicsState,
    ),
    stopReason: ctx.stopReason,
    completionState: ctx.completionState,
    completionProgress,
    turnExecutionContract: ctx.turnExecutionContract,
    activeTaskContext: deriveActiveTaskContext(ctx.turnExecutionContract),
    stopReasonDetail: ctx.stopReasonDetail,
    validationCode: ctx.validationCode,
  };
}
