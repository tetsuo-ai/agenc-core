/**
 * Tool call loop and single tool dispatch extracted from ChatExecutor.
 *
 * @module
 */

import type {
  LLMToolCall,
  LLMResponse,
  StreamProgressCallback,
  LLMStatefulResumeAnchor,
  LLMToolChoice,
} from "./types.js";
import type { PromptBudgetSection } from "./prompt-budget.js";
import type { LLMRetryPolicyMatrix, LLMPipelineStopReason } from "./policy.js";
import { type ArtifactAccessMode } from "../workflow/artifact-contract.js";
import type { ExecutionEnvelope } from "../workflow/execution-envelope.js";
import {
  isPathWithinAnyRoot,
  normalizeEnvelopePath,
  normalizeEnvelopeRoots,
  normalizeWorkspaceRoot,
  resolveExplicitArtifactReferencePath,
} from "../workflow/path-normalization.js";
import type {
  ToolCallRecord,
  ChatExecutionTraceEvent,
  ChatCallUsageRecord,
  ExecutionContext,
  ToolLoopState,
  ToolCallAction,
  RecoveryHint,
} from "./chat-executor-types.js";
import type {
  RoundStuckState,
  ToolRoundProgressSummary,
} from "./chat-executor-tool-utils.js";
import type { ToolRoundBudgetExtensionResult } from "./chat-executor-budget-extension.js";
import type { ToolFailureCircuitBreaker } from "./tool-failure-circuit-breaker.js";
import {
  MAX_TOOL_IMAGE_CHARS_BUDGET,
} from "./chat-executor-constants.js";
import {
  hasRuntimeLimit,
  isRuntimeLimitExceeded,
  isRuntimeLimitReached,
} from "./runtime-limit-policy.js";
import {
  didToolCallFail,
  checkToolCallPermission,
  normalizeToolCallArguments,
  repairToolCallArgumentsFromMessageText,
  parseToolCallArguments,
  executeToolWithRetry,
  summarizeToolArgumentChanges,
  trackToolCallFailureState,
  checkToolLoopStuckDetection,
  buildToolLoopRecoveryMessages,
  buildRoutingExpansionMessage,
  summarizeToolRoundProgress,
  enrichToolResultMetadata,
} from "./chat-executor-tool-utils.js";
import {
  applyActiveRoutedToolNames,
  buildActiveRoutedToolSet,
} from "./chat-executor-routing-state.js";
import {
  buildSemanticToolCallKey,
  buildRecoveryHints,
  preflightStaleCopiedCmakeHarnessInvocation,
} from "./chat-executor-recovery.js";
import {
  sanitizeToolCallsForReplay,
  generateFallbackContent,
  buildPromptToolContent,
} from "./chat-executor-text.js";
import {
  HookRegistry,
  dispatchHooks,
  defaultHookExecutor,
} from "./hooks/index.js";
import type { CanUseToolFn } from "./can-use-tool.js";
import {
  partitionToolCalls,
  type IsConcurrencySafeFn,
} from "./tool-orchestration.js";

// ============================================================================
// Callback interfaces
// ============================================================================

export interface ToolLoopCallbacks {
  pushMessage(
    ctx: ExecutionContext,
    message: import("./types.js").LLMMessage,
    section: PromptBudgetSection,
    reconciliationMessage?: import("./types.js").LLMMessage,
  ): void;
  setStopReason(
    ctx: ExecutionContext,
    reason: LLMPipelineStopReason,
    detail?: string,
  ): void;
  checkRequestTimeout(ctx: ExecutionContext, stage: string): boolean;
  appendToolRecord(ctx: ExecutionContext, record: ToolCallRecord): void;
  emitExecutionTrace(
    ctx: ExecutionContext,
    event: ChatExecutionTraceEvent,
  ): void;
  replaceRuntimeRecoveryHintMessages(
    ctx: ExecutionContext,
    recoveryHints: readonly RecoveryHint[],
  ): void;
  maybePushRuntimeInstruction(ctx: ExecutionContext, content: string): void;
  callModelForPhase(
    ctx: ExecutionContext,
    input: {
      phase: ChatCallUsageRecord["phase"];
      callMessages: readonly import("./types.js").LLMMessage[];
      callSections?: readonly PromptBudgetSection[];
      onStreamChunk?: StreamProgressCallback;
      statefulSessionId?: string;
      statefulResumeAnchor?: LLMStatefulResumeAnchor;
      statefulHistoryCompacted?: boolean;
      routedToolNames?: readonly string[];
      persistRoutedToolNames?: boolean;
      toolChoice?: LLMToolChoice;
      preparationDiagnostics?: Record<string, unknown>;
      allowRecallBudgetBypass?: boolean;
      budgetReason: string;
    },
  ): Promise<LLMResponse | undefined>;
  evaluateToolRoundBudgetExtension(params: {
    readonly ctx: ExecutionContext;
    readonly currentLimit: number;
    readonly recentRounds: readonly ToolRoundProgressSummary[];
  }): ToolRoundBudgetExtensionResult;
  serializeRemainingRequestMs(remainingRequestMs: number): number | null;
}

export interface ToolLoopConfig {
  readonly maxRuntimeSystemHints: number;
  readonly toolCallTimeoutMs: number;
  readonly retryPolicyMatrix: LLMRetryPolicyMatrix;
  readonly allowedTools: Set<string> | null;
  readonly toolFailureBreaker: ToolFailureCircuitBreaker;
  /** Cut 5.2: hook registry for PreToolUse / PostToolUse / PostToolUseFailure. */
  readonly hookRegistry?: HookRegistry;
  /**
   * Cut 5.7: canUseTool permission seam. When set, the tool dispatch
   * loop calls this before each tool to check whether the call is
   * allowed. Returning `deny` short-circuits the call with the hook's
   * message. Returning `ask` is currently treated as a soft deny at
   * this layer (interactive approval is the gateway's responsibility).
   * Returning `allow` with `updatedInput` rewrites the tool args
   * before dispatch.
   */
  readonly canUseTool?: CanUseToolFn;
  /**
   * Cut 5.5: concurrency-safe tool predicate. When set, the tool loop
   * partitions each round's tool calls into consecutive-concurrency-safe
   * batches and emits a telemetry trace describing the partition shape.
   * The dispatch itself remains serial (stateful mutation through the
   * loop callbacks is order-sensitive); this wiring lets callers
   * inventory which rounds would benefit from parallel dispatch.
   */
  readonly isConcurrencySafe?: IsConcurrencySafeFn;
}

// ============================================================================
// executeSingleToolCall (standalone)
// ============================================================================

const READ_ONLY_ENVELOPE_TOOL_NAMES = new Set([
  "system.readFile",
  "system.listDir",
  "system.stat",
]);
const WRITE_ENVELOPE_TOOL_MODES: Readonly<Record<string, ArtifactAccessMode>> = {
  "desktop.text_editor": "write",
  "system.writeFile": "write",
  "system.appendFile": "write",
  "system.delete": "write",
  "system.mkdir": "write",
  "system.move": "write",
};
const ENVELOPE_TOOL_PATH_ARG_KEYS: Readonly<Record<string, readonly string[]>> = {
  "desktop.text_editor": ["path"],
  "system.readFile": ["path"],
  "system.writeFile": ["path"],
  "system.appendFile": ["path"],
  "system.listDir": ["path"],
  "system.stat": ["path"],
  "system.mkdir": ["path"],
  "system.delete": ["path"],
  "system.move": ["source", "destination"],
};
const CONTRACT_MUTATION_TOOL_NAMES = new Set([
  "desktop.text_editor",
  "system.appendFile",
  "system.delete",
  "system.mkdir",
  "system.move",
  "system.writeFile",
]);
const SHELL_MUTATION_COMMAND_RE =
  /\b(?:mkdir|touch|rm|mv|cp|install|chmod|chown|tee|cmake|ninja|make|gcc|g\+\+|clang|clang\+\+|cargo\s+(?:build|test|fmt|clippy|add)|go\s+(?:build|test)|npm\s+(?:install|test|run\s+(?:build|typecheck|lint))|pnpm\s+(?:install|add|test|build|typecheck|lint)|yarn\s+(?:install|add|test|build|typecheck|lint)|bun\s+(?:install|add|test|run(?:\s+(?:build|typecheck|lint))?))\b|(?:^|\s)(?:cat|echo|printf)\b[^\n]*>/i;

function getExecutionEnvelopeFilesystemAccessMode(
  toolName: string,
): ArtifactAccessMode | undefined {
  if (READ_ONLY_ENVELOPE_TOOL_NAMES.has(toolName)) {
    return "read";
  }
  return WRITE_ENVELOPE_TOOL_MODES[toolName];
}

function canonicalizeExplicitArtifactReferenceArgs(params: {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly workspaceRoot?: string;
  readonly declaredArtifacts?: readonly string[];
}): { readonly args: Record<string, unknown>; readonly canonicalizedFields: readonly string[] } {
  const pathKeys = ENVELOPE_TOOL_PATH_ARG_KEYS[params.toolName] ?? [];
  if (pathKeys.length === 0) {
    return { args: params.args, canonicalizedFields: [] };
  }

  let nextArgs = params.args;
  const canonicalizedFields: string[] = [];
  for (const key of pathKeys) {
    const rawValue = nextArgs[key];
    if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
      continue;
    }
    const canonicalPath = resolveExplicitArtifactReferencePath({
      rawPath: rawValue,
      workspaceRoot: params.workspaceRoot,
      declaredArtifacts: params.declaredArtifacts,
    });
    if (!canonicalPath || canonicalPath === rawValue) {
      continue;
    }
    if (nextArgs === params.args) {
      nextArgs = { ...params.args };
    }
    nextArgs[key] = canonicalPath;
    canonicalizedFields.push(`${key}:artifact_ref`);
  }

  return { args: nextArgs, canonicalizedFields };
}

function isMutationLikeToolUse(toolName: string, args: Record<string, unknown>): boolean {
  if (CONTRACT_MUTATION_TOOL_NAMES.has(toolName)) {
    return true;
  }
  if (toolName !== "system.bash" && toolName !== "desktop.bash") {
    return false;
  }
  const command = typeof args.command === "string" ? args.command.trim() : "";
  return command.length > 0 && SHELL_MUTATION_COMMAND_RE.test(command);
}

function enforceTurnExecutionContractPolicy(params: {
  readonly ctx: ExecutionContext;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}): string | undefined {
  if (!isMutationLikeToolUse(params.toolName, params.args)) {
    return undefined;
  }
  if (
    params.ctx.turnExecutionContract.turnClass === "workflow_implementation" ||
    params.ctx.turnExecutionContract.turnClass === "artifact_update"
  ) {
    return undefined;
  }
  return `Tool ${params.toolName} can mutate workspace state, but this turn is classified as ${params.ctx.turnExecutionContract.turnClass}. Mutation requires a workflow_implementation or artifact_update execution contract.`;
}

function enforceTopLevelExecutionEnvelope(params: {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly executionEnvelope?: ExecutionEnvelope;
  readonly defaultWorkingDirectory?: string;
}): string | undefined {
  const envelope = params.executionEnvelope;
  if (!envelope) return undefined;

  if (
    envelope.allowedTools?.length &&
    !envelope.allowedTools.includes(params.toolName)
  ) {
    return `Tool ${params.toolName} is outside the execution envelope for this turn`;
  }

  const mode = getExecutionEnvelopeFilesystemAccessMode(params.toolName);
  if (!mode) {
    return undefined;
  }

  const pathKeys = ENVELOPE_TOOL_PATH_ARG_KEYS[params.toolName] ?? [];
  if (pathKeys.length === 0) {
    return undefined;
  }

  // Audit S1.6: normalize the envelope workspace root so it matches the
  // root the verifier and child execution paths see, instead of just
  // trimming whitespace.
  const workspaceRoot =
    normalizeWorkspaceRoot(envelope.workspaceRoot) ?? params.defaultWorkingDirectory;
  const allowedRoots = normalizeEnvelopeRoots(
    mode === "read" ? envelope.allowedReadRoots ?? [] : envelope.allowedWriteRoots ?? [],
    workspaceRoot,
  );
  for (const key of pathKeys) {
    const rawValue = params.args[key];
    if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
      continue;
    }
    const normalizedPath = normalizeEnvelopePath(rawValue, workspaceRoot);
    if (allowedRoots.length > 0 && !isPathWithinAnyRoot(normalizedPath, allowedRoots)) {
      return `Path ${normalizedPath} is outside the execution envelope roots for this turn`;
    }
  }

  return undefined;
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
    callbacks.pushMessage(
      ctx,
      {
        role: "tool",
        content: permission.errorResult,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      },
      "tools",
    );
    callbacks.appendToolRecord(ctx, {
      name: toolCall.name,
      args: {},
      result: permission.errorResult,
      isError: true,
      durationMs: 0,
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
    callbacks.pushMessage(
      ctx,
      {
        role: "tool",
        content: parseResult.error,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      },
      "tools",
    );
    callbacks.appendToolRecord(ctx, {
      name: toolCall.name,
      args: {},
      result: parseResult.error,
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
  const contractPolicyError = enforceTurnExecutionContractPolicy({
    ctx,
    toolName: toolCall.name,
    args,
  });
  if (contractPolicyError) {
    callbacks.emitExecutionTrace(ctx, {
      type: "tool_rejected",
      phase: "tool_followup",
      callIndex: ctx.callIndex,
      payload: {
        tool: toolCall.name,
        args,
        originalArgs: rawArgs,
        reason: "turn_execution_contract",
        error: contractPolicyError,
      },
    });
    callbacks.pushMessage(
      ctx,
      {
        role: "tool",
        content: contractPolicyError,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      },
      "tools",
    );
    callbacks.appendToolRecord(ctx, {
      name: toolCall.name,
      args,
      result: contractPolicyError,
      isError: true,
      durationMs: 0,
    });
    return "skip";
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
    callbacks.pushMessage(
      ctx,
      {
        role: "tool",
        content: executionEnvelopeError,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      },
      "tools",
    );
    callbacks.appendToolRecord(ctx, {
      name: toolCall.name,
      args,
      result: executionEnvelopeError,
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
    callbacks.pushMessage(
      ctx,
      {
        role: "tool",
        content: staleHarnessPreflight.rejectionError,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      },
      "tools",
    );
    callbacks.appendToolRecord(ctx, {
      name: toolCall.name,
      args,
      result: staleHarnessPreflight.rejectionError,
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
      callbacks.pushMessage(
        ctx,
        {
          role: "tool",
          content: denyMessage,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        },
        "tools",
      );
      callbacks.appendToolRecord(ctx, {
        name: toolCall.name,
        args,
        result: denyMessage,
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
      },
    });
    if (preDispatch.action === "deny") {
      const denyMessage =
        preDispatch.message ??
        `Tool "${toolCall.name}" blocked by PreToolUse hook`;
      callbacks.pushMessage(
        ctx,
        {
          role: "tool",
          content: denyMessage,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        },
        "tools",
      );
      callbacks.appendToolRecord(ctx, {
        name: toolCall.name,
        args,
        result: denyMessage,
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

  if (exec.toolFailed) {
    const failKey = buildSemanticToolCallKey(toolCall.name, args);
    const circuitReason = config.toolFailureBreaker.recordFailure(
      ctx.sessionId,
      failKey,
      toolCall.name,
    );
    if (circuitReason) {
      callbacks.setStopReason(ctx, "no_progress", circuitReason);
      abortRound = true;
      result = enrichToolResultMetadata(result, {
        circuitBreaker: "open",
        circuitBreakerReason: circuitReason,
      });
    }
  }

  callbacks.appendToolRecord(ctx, {
    name: toolCall.name,
    args,
    result,
    isError: exec.toolFailed,
    durationMs: exec.durationMs,
  });
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

  // Track consecutive semantic failures to detect stuck loops.
  const semanticToolKey = buildSemanticToolCallKey(toolCall.name, args);
  if (!exec.toolFailed) {
    config.toolFailureBreaker.clearPattern(ctx.sessionId, semanticToolKey);
  }
  trackToolCallFailureState(exec.toolFailed, semanticToolKey, loopState);

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

  if (abortRound) return "abort_round";
  // Cut 4: mcp.doom.start_game end-round shortcut removed.
  return "processed";
}

// ============================================================================
// executeToolCallLoop (standalone)
// ============================================================================

export async function executeToolCallLoop(
  ctx: ExecutionContext,
  config: ToolLoopConfig,
  callbacks: ToolLoopCallbacks,
): Promise<void> {
  ctx.response = await callbacks.callModelForPhase(ctx, {
    phase: "initial",
    callMessages: ctx.messages,
    callSections: ctx.messageSections,
    onStreamChunk: ctx.activeStreamCallback,
    statefulSessionId: ctx.sessionId,
    statefulResumeAnchor: ctx.stateful?.resumeAnchor,
    statefulHistoryCompacted: ctx.stateful?.historyCompacted,
    preparationDiagnostics: {
      plannerReason: ctx.plannerDecision.reason,
      plannerShouldPlan: ctx.plannerDecision.shouldPlan,
    },
    budgetReason:
      "Initial completion blocked by max model recalls per request budget",
  });

  let rounds = 0;
  let effectiveMaxToolRounds = ctx.effectiveMaxToolRounds;
  const successfulSemanticToolKeys = new Set<string>();
  const verificationFailureDiagnosticKeys = new Set<string>();
  const recentRoundProgress: ToolRoundProgressSummary[] = [];
  const stuckState: RoundStuckState = {
    consecutiveAllFailedRounds: 0,
    lastRoundSemanticKey: "",
    consecutiveSemanticDuplicateRounds: 0,
  };
  const loopState: ToolLoopState = {
    remainingToolImageChars: MAX_TOOL_IMAGE_CHARS_BUDGET,
    activeRoutedToolSet: null,
    expandAfterRound: false,
    lastFailKey: "",
    consecutiveFailCount: 0,
  };

  while (
    ctx.response &&
    ctx.response.finishReason === "tool_calls" &&
    ctx.response.toolCalls.length > 0 &&
    ctx.activeToolHandler &&
    (
      !hasRuntimeLimit(effectiveMaxToolRounds) ||
      rounds < effectiveMaxToolRounds
    )
  ) {
    if (ctx.signal?.aborted) {
      callbacks.setStopReason(ctx, "cancelled", "Execution cancelled by caller");
      break;
    }
    if (callbacks.checkRequestTimeout(ctx, "tool loop")) break;
    const activeCircuit = config.toolFailureBreaker.getActiveCircuit(ctx.sessionId);
    if (activeCircuit) {
      callbacks.setStopReason(ctx, "no_progress", activeCircuit.reason);
      break;
    }

    rounds++;
    const roundToolCallStart = ctx.allToolCalls.length;
    const roundStartedAt = Date.now();
    const roundRoutedToolNames =
      ctx.transientRoutedToolNames ?? ctx.activeRoutedToolNames;
    loopState.activeRoutedToolSet = buildActiveRoutedToolSet(
      roundRoutedToolNames,
    );
    ctx.transientRoutedToolNames = undefined;
    loopState.expandAfterRound = false;

    callbacks.pushMessage(
      ctx,
      {
        role: "assistant",
        content: ctx.response.content,
        phase: "commentary",
        toolCalls: sanitizeToolCallsForReplay(ctx.response.toolCalls),
      },
      "assistant_runtime",
    );

    // Cut 5.5: emit a partitioning trace showing which subset of this
    // round's tool calls are concurrency-safe. When callers wire a
    // real `isConcurrencySafe` predicate, the trace records how many
    // parallel batches the round would have produced. Dispatch remains
    // serial because the loop callbacks mutate ctx in order-sensitive
    // ways.
    if (config.isConcurrencySafe) {
      const batches = partitionToolCalls(
        ctx.response.toolCalls,
        config.isConcurrencySafe,
      );
      callbacks.emitExecutionTrace(ctx, {
        type: "tool_dispatch_started",
        phase: "tool_followup",
        callIndex: ctx.callIndex,
        payload: {
          tool: "__round_partition__",
          args: {},
          argumentDiagnostics: {
            batchCount: batches.length,
            parallelBatchCount: batches.filter((batch) => batch.isConcurrencySafe)
              .length,
            concurrencySafeToolNames: batches
              .filter((batch) => batch.isConcurrencySafe)
              .flatMap((batch) => batch.toolCalls.map((call) => call.name)),
          },
        },
      });
    }

    let abortRound = false;
    for (const toolCall of ctx.response.toolCalls) {
      const action = await executeSingleToolCall(ctx, toolCall, loopState, config, callbacks);
      if (action === "end_round") {
        break;
      }
      if (action === "abort_loop" || action === "abort_round") {
        abortRound = true;
        break;
      }
    }

    if (ctx.signal?.aborted) {
      callbacks.setStopReason(ctx, "cancelled", "Execution cancelled by caller");
      break;
    }
    if (callbacks.checkRequestTimeout(ctx, "tool follow-up")) break;

    const roundCalls = ctx.allToolCalls.slice(roundToolCallStart);
    if (abortRound) break;

    // Stuck-loop detection (consecutive failures, semantic duplicates).
    const stuckResult = checkToolLoopStuckDetection(roundCalls, loopState, stuckState);
    if (stuckResult.shouldBreak) {
      const roundFailures = roundCalls.filter((call) =>
        didToolCallFail(call.isError, call.result)
      ).length;
      callbacks.emitExecutionTrace(ctx, {
        type: "tool_loop_stuck_detected",
        phase: "tool_followup",
        callIndex: ctx.callIndex,
        payload: {
          reason: stuckResult.reason,
          roundToolCallCount: roundCalls.length,
          roundFailureCount: roundFailures,
          consecutiveFailCount: loopState.consecutiveFailCount,
          consecutiveAllFailedRounds: stuckState.consecutiveAllFailedRounds,
          consecutiveSemanticDuplicateRounds:
            stuckState.consecutiveSemanticDuplicateRounds,
        },
      });
      callbacks.setStopReason(ctx, "no_progress", stuckResult.reason);
      break;
    }

    // Recovery hints.
    const recoveryHistoryWindow = ctx.allToolCalls.slice(
      Math.max(0, ctx.allToolCalls.length - 48),
    );
    const recoveryHints = buildRecoveryHints(
      roundCalls,
      new Set<string>(),
      recoveryHistoryWindow,
    );
    callbacks.replaceRuntimeRecoveryHintMessages(ctx, recoveryHints);
    if (recoveryHints.length > 0) {
      callbacks.emitExecutionTrace(ctx, {
        type: "recovery_hints_injected",
        phase: "tool_followup",
        callIndex: ctx.callIndex + 1,
        payload: {
          count: recoveryHints.length,
          hints: recoveryHints.map((hint) => ({
            key: hint.key,
            message: hint.message,
          })),
        },
      });
    }
    const runtimeHintCount = ctx.messageSections.filter(
      (s) => s === "system_runtime",
    ).length;
    for (const msg of buildToolLoopRecoveryMessages(
      recoveryHints,
      config.maxRuntimeSystemHints,
      runtimeHintCount,
    )) {
      callbacks.pushMessage(ctx, msg, "system_runtime");
    }

    // Routing expansion on miss.
    if (loopState.expandAfterRound && ctx.expandedRoutedToolNames.length > 0) {
      const previousRoutedToolNames = [...ctx.activeRoutedToolNames];
      ctx.routedToolsExpanded = true;
      applyActiveRoutedToolNames(ctx, ctx.expandedRoutedToolNames);
      callbacks.emitExecutionTrace(ctx, {
        type: "route_expanded",
        phase: "tool_followup",
        callIndex: ctx.callIndex + 1,
        payload: {
          previousRoutedToolNames,
          nextRoutedToolNames: ctx.activeRoutedToolNames,
          routedToolMisses: ctx.routedToolMisses,
        },
      });
      const updatedHintCount = ctx.messageSections.filter(
        (s) => s === "system_runtime",
      ).length;
      const expansionMsg = buildRoutingExpansionMessage(
        config.maxRuntimeSystemHints,
        updatedHintCount,
      );
      if (expansionMsg) {
        callbacks.pushMessage(ctx, expansionMsg, "system_runtime");
      }
    }

    // Re-call LLM.
    const nextResponse = await callbacks.callModelForPhase(ctx, {
      phase: "tool_followup",
      callMessages: ctx.messages,
      callSections: ctx.messageSections,
      onStreamChunk: ctx.activeStreamCallback,
      statefulSessionId: ctx.sessionId,
      statefulResumeAnchor: ctx.stateful?.resumeAnchor,
      statefulHistoryCompacted: ctx.stateful?.historyCompacted,
      budgetReason:
        "Max model recalls exceeded while following up after tool calls",
    });
    if (!nextResponse) break;
    ctx.response = nextResponse;

    const roundProgress = summarizeToolRoundProgress(
      roundCalls,
      Date.now() - roundStartedAt,
      successfulSemanticToolKeys,
      verificationFailureDiagnosticKeys,
    );
    recentRoundProgress.push(roundProgress);
    if (recentRoundProgress.length > 3) {
      recentRoundProgress.shift();
    }

    if (
      ctx.response.finishReason === "tool_calls" &&
      isRuntimeLimitReached(rounds, effectiveMaxToolRounds)
    ) {
      const extension = callbacks.evaluateToolRoundBudgetExtension({
        ctx,
        currentLimit: effectiveMaxToolRounds,
        recentRounds: recentRoundProgress,
      });
      callbacks.emitExecutionTrace(ctx, {
        type: "tool_round_budget_extension_evaluated",
        phase: "tool_followup",
        callIndex: ctx.callIndex + 1,
        payload: {
          currentLimit: effectiveMaxToolRounds,
          decision: extension.decision,
          recentProgressRate: extension.recentProgressRate,
          recentTotalNewSuccessfulSemanticKeys:
            extension.recentTotalNewSuccessfulSemanticKeys,
          recentTotalNewVerificationFailureDiagnosticKeys:
            extension.recentTotalNewVerificationFailureDiagnosticKeys,
          weightedAverageNewSuccessfulSemanticKeys:
            extension.weightedAverageNewSuccessfulSemanticKeys,
          latestRoundHadMaterialProgress:
            extension.latestRoundHadMaterialProgress,
          latestRoundNewSuccessfulSemanticKeys:
            extension.latestRoundNewSuccessfulSemanticKeys,
          latestRoundNewVerificationFailureDiagnosticKeys:
            extension.latestRoundNewVerificationFailureDiagnosticKeys,
          extensionReason: extension.extensionReason,
          repairCycleOpen: extension.repairCycleOpen,
          repairCycleNeedsMutation:
            extension.repairCycleNeedsMutation,
          repairCycleNeedsVerification:
            extension.repairCycleNeedsVerification,
          effectiveToolBudget: ctx.effectiveToolBudget,
          remainingToolBudget: extension.remainingToolBudget,
          remainingRequestMs: callbacks.serializeRemainingRequestMs(
            extension.remainingRequestMs,
          ),
          recentAverageRoundMs: extension.recentAverageRoundMs,
          extensionRounds: extension.extensionRounds,
          newLimit: extension.newLimit,
        },
      });
      if (extension.decision === "extended") {
        const previousLimit = effectiveMaxToolRounds;
        effectiveMaxToolRounds = extension.newLimit;
        callbacks.emitExecutionTrace(ctx, {
          type: "tool_round_budget_extended",
          phase: "tool_followup",
          callIndex: ctx.callIndex + 1,
          payload: {
            previousLimit,
            newLimit: effectiveMaxToolRounds,
            extensionRounds: extension.extensionRounds,
            remainingRequestMs: callbacks.serializeRemainingRequestMs(
              extension.remainingRequestMs,
            ),
            recentAverageRoundMs: extension.recentAverageRoundMs,
            extensionReason: extension.extensionReason,
            latestRoundNewSuccessfulSemanticKeys:
              extension.latestRoundNewSuccessfulSemanticKeys,
            latestRoundNewVerificationFailureDiagnosticKeys:
              extension.latestRoundNewVerificationFailureDiagnosticKeys,
            effectiveToolBudget: ctx.effectiveToolBudget,
            remainingToolBudget: extension.remainingToolBudget,
            repairCycleOpen: extension.repairCycleOpen,
            repairCycleNeedsMutation:
              extension.repairCycleNeedsMutation,
            repairCycleNeedsVerification:
              extension.repairCycleNeedsVerification,
          },
        });
      }
    }
  }

  if (ctx.signal?.aborted) {
    callbacks.setStopReason(ctx, "cancelled", "Execution cancelled by caller");
  } else if (
    ctx.response &&
    ctx.response.finishReason === "tool_calls" &&
    isRuntimeLimitReached(rounds, effectiveMaxToolRounds)
  ) {
    callbacks.setStopReason(
      ctx,
      "tool_calls",
      `Reached max tool rounds (${effectiveMaxToolRounds})`,
    );
  }

  ctx.finalContent = ctx.response?.content ?? "";
  if (!ctx.finalContent && ctx.allToolCalls.length > 0) {
    ctx.finalContent =
      generateFallbackContent(ctx.allToolCalls) ?? ctx.finalContent;
  }
  if (!ctx.finalContent && ctx.stopReason !== "completed" && ctx.stopReasonDetail) {
    ctx.finalContent = ctx.stopReasonDetail;
  }
}
