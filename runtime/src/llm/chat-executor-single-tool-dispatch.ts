/**
 * Single-tool dispatch extracted from chat-executor-tool-loop.
 *
 * This module owns {@link executeSingleToolCall} — the per-tool-call
 * dispatch path invoked by the main tool loop for both concurrent-safe
 * parallel batches and serial batches. It runs every gate the runtime
 * has between "the model emitted a tool_use" and "the tool result is
 * on the history":
 *
 * 1. Request-timeout check + per-turn tool-call budget
 * 2. Allowlist + routed-subset permission check
 * 3. Argument parsing + normalization + message-text repair +
 *    stale-cmake-harness preflight + artifact-reference
 *    canonicalization
 * 4. Execution-envelope path gate
 * 5. Stale harness rejection (second branch of the preflight)
 * 6. Shell-workspace-write-policy gate
 * 7. Anti-fabrication gate (refuse writeFile-over-failed-verification)
 * 8. canUseTool seam (Cut 5.7)
 * 9. PreToolUse hook (Cut 5.2)
 * 10. Tool execution with retry
 * 11. Tool result budget (Cut 5.3)
 * 12. Tool-call record append + discovered-tool-name routing update
 * 13. PostToolUse / PostToolUseFailure hook (Cut 5.2)
 * 14. Failure-budget check
 * 15. Prompt tool-content framing + tool-protocol result record + sync
 *
 * Returns a {@link ToolCallAction}: "skip" (reject path, already
 * surfaced a tool result), "abort_round" (fatal for the current
 * round), "abort_loop" (fatal for the whole turn), or "processed"
 * (success).
 *
 * @module
 */

import type { LLMToolCall } from "./types.js";
import type {
  ExecutionContext,
  ToolLoopState,
  ToolCallAction,
} from "./chat-executor-types.js";
import type {
  ToolLoopCallbacks,
  ToolLoopConfig,
} from "./chat-executor-tool-loop.js";
import {
  isRuntimeLimitExceeded,
  isRuntimeLimitReached,
} from "./runtime-limit-policy.js";
import {
  checkToolCallPermission,
  normalizeToolCallArguments,
  repairToolCallArgumentsFromMessageText,
  parseToolCallArguments,
  executeToolWithRetry,
  summarizeToolArgumentChanges,
} from "./chat-executor-tool-utils.js";
import {
  applyActiveRoutedToolNames,
  buildActiveRoutedToolSet,
} from "./chat-executor-routing-state.js";
import { preflightStaleCopiedCmakeHarnessInvocation } from "./chat-executor-recovery.js";
import {
  ANTI_FABRICATION_HARNESS_OVERWRITE_REASON,
  evaluateWriteOverFailedVerification,
} from "./verification-target-guard.js";
import { evaluateShellWorkspaceWritePolicy } from "./shell-write-policy.js";
import { buildPromptToolContent } from "./chat-executor-text.js";
import { dispatchHooks, defaultHookExecutor } from "./hooks/index.js";
import { applyToolResultBudget } from "./tool-result-budget.js";
import {
  getPendingToolProtocolCalls,
  recordToolProtocolResult,
} from "./tool-protocol-state.js";
import {
  pushToolResultMessage,
  syncToolProtocolSnapshot,
} from "./chat-executor-tool-protocol-helpers.js";
import {
  canonicalizeExplicitArtifactReferenceArgs,
  enforceTopLevelExecutionEnvelope,
} from "./chat-executor-envelope-helpers.js";

/**
 * Parse a `system.searchTools` tool result for discovered tool names.
 * Returns the unique, non-empty name list when the result is the
 * expected JSON shape; an empty array otherwise (including for any
 * other tool name).
 *
 * Wired into {@link executeSingleToolCall} so tool-routing adds the
 * newly-discovered names to the active routed subset for the rest of
 * the turn.
 */
function extractDiscoveredToolNamesFromSearchResult(
  toolName: string,
  result: string,
): readonly string[] {
  if (toolName !== "system.searchTools") {
    return [];
  }
  try {
    const parsed = JSON.parse(result) as { results?: unknown };
    if (!Array.isArray(parsed.results)) {
      return [];
    }
    return Array.from(
      new Set(
        parsed.results
          .map((entry) =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as { name?: unknown }).name === "string"
              ? String((entry as { name: string }).name).trim()
              : "",
          )
          .filter((toolName) => toolName.length > 0),
      ),
    );
  } catch {
    return [];
  }
}

export async function executeSingleToolCall(
  ctx: ExecutionContext,
  toolCall: LLMToolCall,
  loopState: ToolLoopState,
  config: ToolLoopConfig,
  callbacks: ToolLoopCallbacks,
): Promise<ToolCallAction> {
  if (callbacks.checkRequestTimeout(ctx, `tool "${toolCall.name}" dispatch`)) {
    return "abort_loop";
  }
  if (isRuntimeLimitReached(ctx.allToolCalls.length, ctx.effectiveToolBudget)) {
    callbacks.setStopReason(
      ctx,
      "budget_exceeded",
      `Tool budget exceeded (${ctx.effectiveToolBudget} per request)`,
    );
    return "abort_loop";
  }

  // Permission check (allowlist, routed subset).
  const permission = checkToolCallPermission(
    toolCall,
    config.allowedTools,
    loopState.activeRoutedToolSet,
    ctx.canExpandOnRoutingMiss,
    ctx.routedToolsExpanded,
  );
  if (permission.errorResult) {
    callbacks.emitExecutionTrace(ctx, {
      type: "tool_rejected",
      phase: "tool_followup",
      callIndex: ctx.callIndex,
      payload: {
        tool: toolCall.name,
        routingMiss: permission.routingMiss === true,
        expandAfterRound: permission.expandAfterRound === true,
        activeRoutedToolNames: loopState.activeRoutedToolSet
          ? [...loopState.activeRoutedToolSet]
          : [],
        error: permission.errorResult,
      },
    });
    if (permission.routingMiss) ctx.routedToolMisses++;
    pushToolResultMessage({
      ctx,
      callbacks,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: permission.errorResult,
      args: {},
      isError: true,
      durationMs: 0,
      failureBudgetExempt: permission.routingMiss === true,
    });
    if (permission.expandAfterRound) loopState.expandAfterRound = true;
    return "skip";
  }
  // Parse arguments.
  const parseResult = parseToolCallArguments(toolCall);
  if (!parseResult.ok) {
    callbacks.emitExecutionTrace(ctx, {
      type: "tool_arguments_invalid",
      phase: "tool_followup",
      callIndex: ctx.callIndex,
      payload: {
        tool: toolCall.name,
        error: parseResult.error,
        rawArguments: toolCall.arguments,
      },
    });
    pushToolResultMessage({
      ctx,
      callbacks,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: parseResult.error,
      args: {},
      isError: true,
      durationMs: 0,
    });
    return "skip";
  }
  const rawArgs = parseResult.args;
  let args = normalizeToolCallArguments(toolCall.name, rawArgs);
  const normalizedFields = summarizeToolArgumentChanges(rawArgs, args);
  const repaired = repairToolCallArgumentsFromMessageText(
    toolCall.name,
    args,
    ctx.messageText,
  );
  args = repaired.args;
  const staleHarnessPreflight = preflightStaleCopiedCmakeHarnessInvocation(
    toolCall.name,
    args,
    ctx.runtimeWorkspaceRoot,
    ctx.allToolCalls,
  );
  args = staleHarnessPreflight.args;
  const artifactReferenceCanonicalization =
    canonicalizeExplicitArtifactReferenceArgs({
      toolName: toolCall.name,
      args,
      workspaceRoot: ctx.runtimeWorkspaceRoot,
      declaredArtifacts: [
        ...(ctx.requiredToolEvidence?.executionEnvelope?.requiredSourceArtifacts ??
          ctx.requiredToolEvidence?.executionEnvelope?.inputArtifacts ??
          []),
        ...(ctx.requiredToolEvidence?.executionEnvelope?.targetArtifacts ?? []),
      ],
    });
  args = artifactReferenceCanonicalization.args;
  const contractAdjustedFields: string[] = [];
  const argumentDiagnostics: Record<string, unknown> = {};
  if (normalizedFields.length > 0) {
    argumentDiagnostics.normalizedFields = normalizedFields;
  }
  if (repaired.repairedFields.length > 0) {
    argumentDiagnostics.repairSource = "message_text";
    argumentDiagnostics.repairedFields = repaired.repairedFields;
  }
  if (staleHarnessPreflight.repairedFields.length > 0) {
    argumentDiagnostics.workspacePreflightReason = staleHarnessPreflight.reasonKey;
    argumentDiagnostics.workspaceAdjustedFields =
      staleHarnessPreflight.repairedFields;
  }
  if (artifactReferenceCanonicalization.canonicalizedFields.length > 0) {
    argumentDiagnostics.artifactReferenceCanonicalizedFields =
      artifactReferenceCanonicalization.canonicalizedFields;
  }
  if (contractAdjustedFields.length > 0) {
    argumentDiagnostics.contractAdjustedFields = contractAdjustedFields;
  }
  if (Object.keys(argumentDiagnostics).length > 0) {
    argumentDiagnostics.rawArgs = rawArgs;
  }
  const executionEnvelopeError = enforceTopLevelExecutionEnvelope({
    toolName: toolCall.name,
    args,
    executionEnvelope: ctx.requiredToolEvidence?.executionEnvelope,
    defaultWorkingDirectory: ctx.runtimeWorkspaceRoot,
  });
  if (executionEnvelopeError) {
    callbacks.emitExecutionTrace(ctx, {
      type: "tool_rejected",
      phase: "tool_followup",
      callIndex: ctx.callIndex,
      payload: {
        tool: toolCall.name,
        args,
        originalArgs: rawArgs,
        reason: "execution_envelope",
        error: executionEnvelopeError,
      },
    });
    pushToolResultMessage({
      ctx,
      callbacks,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: executionEnvelopeError,
      args,
      isError: true,
      durationMs: 0,
    });
    return "skip";
  }
  if (staleHarnessPreflight.rejectionError) {
    callbacks.emitExecutionTrace(ctx, {
      type: "tool_rejected",
      phase: "tool_followup",
      callIndex: ctx.callIndex,
      payload: {
        tool: toolCall.name,
        args,
        originalArgs: rawArgs,
        reason: staleHarnessPreflight.reasonKey,
        error: staleHarnessPreflight.rejectionError,
      },
    });
    pushToolResultMessage({
      ctx,
      callbacks,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: staleHarnessPreflight.rejectionError,
      args,
      isError: true,
      durationMs: 0,
    });
    return "skip";
  }
  const shellWorkspaceWriteDecision = evaluateShellWorkspaceWritePolicy({
    toolName: toolCall.name,
    args,
    workspaceRoot: ctx.runtimeWorkspaceRoot,
    turnClass: ctx.turnExecutionContract.turnClass,
  });
  if (shellWorkspaceWriteDecision.blocked) {
    const rejectionMessage =
      shellWorkspaceWriteDecision.message ??
      `Tool "${toolCall.name}" blocked by shell workspace write policy.`;
    callbacks.emitExecutionTrace(ctx, {
      type: "tool_rejected",
      phase: "tool_followup",
      callIndex: ctx.callIndex,
      payload: {
        tool: toolCall.name,
        args,
        originalArgs: rawArgs,
        reason: "shell_workspace_file_write_disallowed",
        blockedTargets: shellWorkspaceWriteDecision.blockedTargets,
        observedTargets: shellWorkspaceWriteDecision.observedTargets,
        error: rejectionMessage,
      },
    });
    pushToolResultMessage({
      ctx,
      callbacks,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: rejectionMessage,
      args,
      isError: true,
      durationMs: 0,
    });
    return "skip";
  }
  // Anti-fabrication gate: structurally refuse writeFile/appendFile/
  // text_editor over a verification harness when a prior `system.bash` /
  // `desktop.bash` call in the same turn failed while referencing that
  // harness by basename. This follows the runtime's layered verification
  // contract and removes the affordance for the model to silently rewrite
  // a failing test into a fake-pass stub.
  const antiFabricationDecision = evaluateWriteOverFailedVerification({
    toolName: toolCall.name,
    args,
    priorToolCalls: ctx.allToolCalls,
  });
  if (antiFabricationDecision.refuse) {
    const refusalMessage =
      antiFabricationDecision.message ??
      `Tool "${toolCall.name}" refused by anti-fabrication gate.`;
    callbacks.emitExecutionTrace(ctx, {
      type: "tool_rejected",
      phase: "tool_followup",
      callIndex: ctx.callIndex,
      payload: {
        tool: toolCall.name,
        args,
        originalArgs: rawArgs,
        reason:
          antiFabricationDecision.reason ??
          ANTI_FABRICATION_HARNESS_OVERWRITE_REASON,
        error: refusalMessage,
        ...(antiFabricationDecision.evidence
          ? { evidence: antiFabricationDecision.evidence }
          : {}),
      },
    });
    pushToolResultMessage({
      ctx,
      callbacks,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: refusalMessage,
      args,
      isError: true,
      durationMs: 0,
    });
    return "skip";
  }
  callbacks.emitExecutionTrace(ctx, {
    type: "tool_dispatch_started",
    phase: "tool_followup",
    callIndex: ctx.callIndex,
    payload: {
      tool: toolCall.name,
      args,
      ...(Object.keys(argumentDiagnostics).length > 0
        ? { argumentDiagnostics }
        : {}),
    },
  });

  // Cut 5.7: canUseTool permission seam. When configured, this fires
  // before the hook system so the global policy decision is the first
  // gate at the dispatch boundary. With no canUseTool wired (the
  // default), the seam is skipped and behavior is unchanged.
  if (config.canUseTool) {
    const decision = await config.canUseTool(toolCall, {
      sessionId: ctx.sessionId,
    });
    if (decision.behavior === "deny" || decision.behavior === "ask") {
      const denyMessage =
        decision.behavior === "deny"
          ? decision.message
          : `Tool "${toolCall.name}" requires interactive approval: ${decision.message}`;
      pushToolResultMessage({
        ctx,
        callbacks,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: denyMessage,
        args,
        isError: true,
        durationMs: 0,
      });
      return "skip";
    }
    if (decision.updatedInput) {
      args = decision.updatedInput as typeof args;
    }
  }

  // Cut 5.2: PreToolUse hook dispatch. With no hooks registered (the
  // default) the registry returns `noop` immediately and behavior is
  // unchanged. Hooks may rewrite tool args via `updatedInput` or deny
  // the call outright.
  if (config.hookRegistry) {
    const preDispatch = await dispatchHooks({
      registry: config.hookRegistry,
      event: "PreToolUse",
      matchKey: toolCall.name,
      executor: defaultHookExecutor,
      context: {
        event: "PreToolUse",
        sessionId: ctx.sessionId,
        toolCall,
        parsedInput: args as Record<string, unknown>,
        ...(ctx.runtimeWorkspaceRoot ? { cwd: ctx.runtimeWorkspaceRoot } : {}),
      },
    });
    if (preDispatch.action === "deny") {
      const denyMessage =
        preDispatch.message ??
        `Tool "${toolCall.name}" blocked by PreToolUse hook`;
      pushToolResultMessage({
        ctx,
        callbacks,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: denyMessage,
        args,
        isError: true,
        durationMs: 0,
      });
      return "skip";
    }
    if (preDispatch.updatedInput) {
      args = preDispatch.updatedInput as typeof args;
    }
  }

  // Execute tool with retry.
  const exec = await executeToolWithRetry(
    toolCall,
    args,
    ctx.activeToolHandler!,
    {
      toolCallTimeoutMs: config.toolCallTimeoutMs,
      retryPolicyMatrix: config.retryPolicyMatrix,
      signal: ctx.signal,
      requestDeadlineAt: ctx.requestDeadlineAt,
    },
  );

  let { result } = exec;
  let abortRound = false;
  if (exec.timedOut && exec.toolFailed) {
    callbacks.setStopReason(
      ctx,
      "timeout",
      `Tool "${toolCall.name}" timed out after ${exec.finalToolTimeoutMs}ms`,
    );
    abortRound = true;
  }

  // Cut 5.3: apply per-tool result budget. When the budget config is
  // wired, oversized successful results are persisted to disk and
  // replaced with a placeholder pointing at the file path. Failed
  // results are skipped — error messages are typically small and
  // their text is needed for the model to recover.
  if (
    config.toolResultBudget &&
    config.toolResultBudgetState &&
    !exec.toolFailed
  ) {
    const currentState =
      config.toolResultBudgetState.get(ctx.sessionId) ?? {
        seenIds: new Set<string>(),
        replacements: new Map(),
      };
    const budgetResult = applyToolResultBudget({
      sessionId: ctx.sessionId,
      toolUseId: toolCall.id,
      toolName: toolCall.name,
      content: result,
      state: currentState,
      config: config.toolResultBudget,
    });
    if (budgetResult.persisted) {
      result = budgetResult.content;
      config.toolResultBudgetState.set(ctx.sessionId, budgetResult.state);
      callbacks.emitExecutionTrace(ctx, {
        type: "tool_dispatch_started",
        phase: "tool_followup",
        callIndex: ctx.callIndex,
        payload: {
          tool: "__tool_result_persisted__",
          args: {},
          argumentDiagnostics: {
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            diskPath: budgetResult.diskPath,
          },
        },
      });
    }
  }

  callbacks.appendToolRecord(ctx, {
    name: toolCall.name,
    args,
    result,
    isError: exec.toolFailed,
    durationMs: exec.durationMs,
    toolCallId: toolCall.id,
  });
  if (!exec.toolFailed && ctx.toolDiscoveryEnabled) {
    const discoveredToolNames = extractDiscoveredToolNamesFromSearchResult(
      toolCall.name,
      result,
    );
    if (discoveredToolNames.length > 0) {
      ctx.discoveredToolNames = Array.from(
        new Set([...ctx.discoveredToolNames, ...discoveredToolNames]),
      );
      applyActiveRoutedToolNames(ctx, [
        ...ctx.activeRoutedToolNames,
        ...discoveredToolNames,
      ]);
      loopState.activeRoutedToolSet = buildActiveRoutedToolSet(
        ctx.activeRoutedToolNames,
      );
    }
  }
  callbacks.emitExecutionTrace(ctx, {
    type: "tool_dispatch_finished",
    phase: "tool_followup",
    callIndex: ctx.callIndex,
    payload: {
      tool: toolCall.name,
      args,
      durationMs: exec.durationMs,
      isError: exec.toolFailed,
      timedOut: exec.timedOut,
      result,
    },
  });

  // Cut 5.2: PostToolUse / PostToolUseFailure hook dispatch.
  if (config.hookRegistry) {
    const cwdFields = ctx.runtimeWorkspaceRoot ? { cwd: ctx.runtimeWorkspaceRoot } : {};
    if (exec.toolFailed) {
      await dispatchHooks({
        registry: config.hookRegistry,
        event: "PostToolUseFailure",
        matchKey: toolCall.name,
        executor: defaultHookExecutor,
        context: {
          event: "PostToolUseFailure",
          sessionId: ctx.sessionId,
          toolCall,
          errorMessage: result,
          parsedInput: args as Record<string, unknown>,
          ...cwdFields,
        },
      });
    } else {
      await dispatchHooks({
        registry: config.hookRegistry,
        event: "PostToolUse",
        matchKey: toolCall.name,
        executor: defaultHookExecutor,
        context: {
          event: "PostToolUse",
          sessionId: ctx.sessionId,
          toolCall,
          result,
          isError: exec.toolFailed,
          parsedInput: args as Record<string, unknown>,
          ...cwdFields,
        },
      });
    }
  }

  if (isRuntimeLimitExceeded(ctx.failedToolCalls, ctx.effectiveFailureBudget)) {
    callbacks.setStopReason(
      ctx,
      "tool_error",
      `Failure budget exceeded (${ctx.failedToolCalls}/${ctx.effectiveFailureBudget})`,
    );
    abortRound = true;
  }

  const promptToolContent = buildPromptToolContent(
    result,
    loopState.remainingToolImageChars,
  );
  loopState.remainingToolImageChars = promptToolContent.remainingImageBudget;
  callbacks.pushMessage(
    ctx,
    {
      role: "tool",
      content: promptToolContent.content,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    },
    "tools",
  );
  recordToolProtocolResult(ctx.toolProtocolState, toolCall.id);
  syncToolProtocolSnapshot(ctx);
  callbacks.emitExecutionTrace(ctx, {
    type: "tool_protocol_result_recorded",
    phase: "tool_followup",
    callIndex: ctx.callIndex,
    payload: {
      toolCallId: toolCall.id,
      tool: toolCall.name,
      synthetic: false,
      pendingToolCallIds: getPendingToolProtocolCalls(ctx.toolProtocolState).map(
        (pendingToolCall) => pendingToolCall.id,
      ),
    },
  });

  if (abortRound) return "abort_round";
  return "processed";
}
