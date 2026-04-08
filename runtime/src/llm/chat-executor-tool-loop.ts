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
} from "./chat-executor-tool-utils.js";
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
import {
  applyToolResultBudget,
  type ContentReplacementState,
  type ToolBudgetConfig,
} from "./tool-result-budget.js";
import {
  applyPerIterationCompaction,
  DEFAULT_AUTOCOMPACT_THRESHOLD_TOKENS,
} from "./compact/index.js";
import { applyReactiveCompact } from "./compact/reactive-compact.js";
import { LLMContextWindowExceededError } from "./errors.js";
import {
  appendToolRecord,
  checkRequestTimeout,
  emitExecutionTrace,
  maybePushRuntimeInstruction,
  pushMessage,
  replaceRuntimeRecoveryHintMessages,
  serializeRemainingRequestMs,
  setStopReason,
} from "./chat-executor-ctx-helpers.js";

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
  /**
   * Cut 5.3: tool result budget config. When set, oversized tool
   * results are persisted to disk and replaced in the message
   * history with a `<persisted-output>` placeholder that includes
   * the file path + a 2 KB preview. The state is stored on the
   * caller-supplied Map<sessionId, ContentReplacementState> so it
   * persists across rounds in the same session.
   */
  readonly toolResultBudget?: ToolBudgetConfig;
  readonly toolResultBudgetState?: Map<string, ContentReplacementState>;
  /**
   * Phase N wire-up: optional memory consolidation hook passed to
   * `applyPerIterationCompaction`. When set, the per-iteration
   * compaction chain invokes this hook after the autocompact
   * decision layer. Callers typically wire
   * `memory/consolidation.ts:consolidateEpisodicSlice` here to
   * get deterministic in-memory slice consolidation. Off by
   * default — the feature is explicitly opt-in.
   */
  readonly consolidationHook?: (
    messages: readonly import("./types.js").LLMMessage[],
  ) => {
    readonly action: "noop" | "consolidated";
    readonly summaryMessage?: import("./types.js").LLMMessage;
  };
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
  return "processed";
}

// ============================================================================
// executeToolCallLoop (standalone)
// ============================================================================

/**
 * Run the snip → microcompact → autocompact chain on the current
 * conversation history before handing it to the provider. Mutates
 * `ctx.messages` in place if any layer prunes, updates
 * `ctx.perIterationCompaction`, and emits a trace event per layer
 * that fired. Safe to call before every provider call — layers noop
 * when their conditions are not met.
 *
 * This is the live wire-up referenced by Phase A of the 16-phase
 * refactor in TODO.MD. Prior to this wiring, the compact skeleton at
 * `runtime/src/llm/compact/*.ts` was a disconnected port — the
 * functions existed but nothing in the live loop called them. Every
 * provider call in this file is now preceded by this helper, so the
 * chain actually runs.
 */
async function runPerIterationCompactionBeforeModelCall(
  ctx: ExecutionContext,
  config: ToolLoopConfig,
  callbacks: ToolLoopCallbacks,
  phase: ChatCallUsageRecord["phase"],
): Promise<void> {
  const result = applyPerIterationCompaction({
    messages: ctx.messages,
    state: ctx.perIterationCompaction,
    nowMs: Date.now(),
    autocompactThresholdTokens: DEFAULT_AUTOCOMPACT_THRESHOLD_TOKENS,
    lastResponseUsage: ctx.response?.usage,
    ...(config.consolidationHook
      ? { consolidationHook: config.consolidationHook }
      : {}),
  });

  ctx.perIterationCompaction = result.state;

  if (result.action === "noop") return;

  // Phase H: dispatch PreCompact for each layer that fired, with the
  // registry-supplied matcher allowed to veto. Mirrors
  // `claude_code/services/compact/compact.ts:executePreCompactHooks`.
  if (config.hookRegistry) {
    for (const boundary of result.boundaries) {
      const content =
        typeof boundary.content === "string" ? boundary.content : "";
      const layer = extractCompactionLayerTag(content) as
        | "snip"
        | "microcompact"
        | "autocompact"
        | "reactive-compact";
      await dispatchHooks({
        registry: config.hookRegistry,
        event: "PreCompact",
        matchKey: layer,
        executor: defaultHookExecutor,
        context: {
          event: "PreCompact",
          sessionId: ctx.sessionId,
          layer,
        },
      });
    }
  }

  // Snip and microcompact actually prune messages; autocompact is
  // decision-only and hands the pruned view back unchanged.
  if (result.messages.length !== ctx.messages.length) {
    // The compaction chain returns a readonly slice. We need a mutable
    // array on ctx.messages so the rest of the loop can push to it.
    // Preserve section alignment by trimming messageSections to match.
    const droppedCount = ctx.messages.length - result.messages.length;
    ctx.messages = [...result.messages];
    if (ctx.messageSections.length >= droppedCount) {
      ctx.messageSections.splice(0, droppedCount);
    }
  }

  for (const boundary of result.boundaries) {
    const content =
      typeof boundary.content === "string" ? boundary.content : "";
    callbacks.emitExecutionTrace(ctx, {
      type: "compaction_triggered",
      phase,
      callIndex: ctx.callIndex,
      payload: {
        layer: extractCompactionLayerTag(content),
        boundary: content,
        messagesAfter: ctx.messages.length,
      },
    });
  }

  // Phase H: dispatch PostCompact for each layer that fired, AFTER
  // ctx.messages has been updated so hooks observe the new state.
  if (config.hookRegistry) {
    for (const boundary of result.boundaries) {
      const content =
        typeof boundary.content === "string" ? boundary.content : "";
      const layer = extractCompactionLayerTag(content) as
        | "snip"
        | "microcompact"
        | "autocompact"
        | "reactive-compact";
      await dispatchHooks({
        registry: config.hookRegistry,
        event: "PostCompact",
        matchKey: layer,
        executor: defaultHookExecutor,
        context: {
          event: "PostCompact",
          sessionId: ctx.sessionId,
          layer,
        },
      });
    }
  }
}

/**
 * Extract the `[layer]` tag from a compaction boundary message's
 * content. Returns `"unknown"` if no tag is found. The layers write
 * their tag as the first bracketed token in the boundary content
 * (e.g. `[snip] dropped 12 oldest messages after 610s idle`).
 */
function extractCompactionLayerTag(content: string): string {
  const match = /^\[([a-z_-]+)\]/.exec(content);
  return match?.[1] ?? "unknown";
}

/**
 * Phase I wire-up: wrap a provider call with reactive compaction.
 *
 * When the provider returns a `LLMContextWindowExceededError` (HTTP
 * 413 or provider-specific prompt-too-long error), invoke
 * `applyReactiveCompact` on `ctx.messages` to drop the oldest
 * messages, update the state, and retry the call. Repeat up to the
 * reactive-compact layer's internal limit (3 attempts by default;
 * `applyReactiveCompact` returns `"exhausted"` after that).
 *
 * Mirrors `claude_code/query.ts` reactive compaction recovery.
 */
async function callModelWithReactiveCompact(
  ctx: ExecutionContext,
  callbacks: ToolLoopCallbacks,
  phase: ChatCallUsageRecord["phase"],
  buildInput: () => Parameters<ToolLoopCallbacks["callModelForPhase"]>[1],
): Promise<LLMResponse | undefined> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await callbacks.callModelForPhase(ctx, buildInput());
    } catch (err) {
      if (!(err instanceof LLMContextWindowExceededError)) {
        throw err;
      }
      const reactiveState =
        ctx.perIterationCompaction.reactiveCompact ?? {
          attemptIndex: 0,
          lastTriggerMs: null,
        };
      const result = applyReactiveCompact({
        messages: ctx.messages,
        state: reactiveState,
        nowMs: Date.now(),
      });
      if (result.action === "exhausted" || result.action === "noop") {
        // Give up and bubble the original 413 — the caller's error
        // handling decides what to surface to the user.
        throw err;
      }
      ctx.messages = [...result.messages];
      ctx.perIterationCompaction = {
        ...ctx.perIterationCompaction,
        reactiveCompact: result.state,
      };
      if (result.boundary && typeof result.boundary.content === "string") {
        callbacks.emitExecutionTrace(ctx, {
          type: "compaction_triggered",
          phase,
          callIndex: ctx.callIndex,
          payload: {
            layer: "reactive-compact",
            boundary: result.boundary.content,
            messagesAfter: ctx.messages.length,
            attempt: result.state.attemptIndex,
          },
        });
      }
      // Loop back and retry with trimmed history.
    }
  }
}

export async function executeToolCallLoop(
  ctx: ExecutionContext,
  config: ToolLoopConfig,
  callbacks: ToolLoopCallbacks,
): Promise<void> {
  // Phase A wire-up: run the layered compaction chain before the
  // initial provider call. This is the top-of-iteration insertion
  // point mirrored from claude_code/query.ts:395-426. Phase H added
  // PreCompact / PostCompact hook dispatch inside the helper.
  await runPerIterationCompactionBeforeModelCall(
    ctx,
    config,
    callbacks,
    "initial",
  );
  // Phase I wire-up: wrap the provider call in reactive compaction
  // recovery so a 413 response triggers a retry with trimmed
  // history before bubbling the error.
  ctx.response = await callModelWithReactiveCompact(
    ctx,
    callbacks,
    "initial",
    () => ({
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
    }),
  );

  let rounds = 0;
  let effectiveMaxToolRounds = ctx.effectiveMaxToolRounds;
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

    // Phase B (U2): partition this round's tool calls into
    // concurrency-safe batches. A run of consecutive read-only tool
    // calls becomes one parallel batch dispatched via Promise.all;
    // every other call runs serially as its own batch of length 1.
    // When the caller does not supply `isConcurrencySafe`, every
    // call falls into its own serial batch (identical to the old
    // for-loop).
    const dispatchBatches = partitionToolCalls(
      ctx.response.toolCalls,
      config.isConcurrencySafe ?? (() => false),
    );
    const parallelBatchCount = dispatchBatches.filter(
      (batch) => batch.isConcurrencySafe && batch.toolCalls.length > 1,
    ).length;
    if (config.isConcurrencySafe) {
      callbacks.emitExecutionTrace(ctx, {
        type: "tool_dispatch_started",
        phase: "tool_followup",
        callIndex: ctx.callIndex,
        payload: {
          tool: "__round_partition__",
          args: {},
          argumentDiagnostics: {
            batchCount: dispatchBatches.length,
            parallelBatchCount,
            concurrencySafeToolNames: dispatchBatches
              .filter((batch) => batch.isConcurrencySafe)
              .flatMap((batch) => batch.toolCalls.map((call) => call.name)),
          },
        },
      });
    }

    let abortRound = false;
    let breakRound = false;
    for (const batch of dispatchBatches) {
      if (batch.toolCalls.length === 0) continue;
      if (batch.isConcurrencySafe && batch.toolCalls.length > 1) {
        // Phase B wire-up: concurrency-safe batches dispatch via
        // Promise.all. The concurrency guarantee is: JS is
        // single-threaded, so per-call mutations on ctx (messages,
        // allToolCalls, etc.) are atomic between await points. The
        // tool_result protocol does NOT require results to appear in
        // the same order as the originating tool_calls — each
        // tool_result carries its own tool_call_id that the provider
        // matches against the prior assistant message. Completion
        // order is therefore acceptable.
        //
        // Image-char budget mutations (loopState.remainingToolImageChars)
        // can be race-prone across interleaved parallel calls, but
        // tools in the concurrency-safe allowlist are read-only
        // (system.readFile, system.listDir, agenc.* queries) and do
        // not return images, so the budget drift is bounded to zero
        // for this code path in practice.
        const results = await Promise.all(
          batch.toolCalls.map((call) =>
            executeSingleToolCall(ctx, call, loopState, config, callbacks),
          ),
        );
        for (const action of results) {
          if (action === "end_round") {
            breakRound = true;
          }
          if (action === "abort_loop" || action === "abort_round") {
            abortRound = true;
          }
        }
      } else {
        for (const toolCall of batch.toolCalls) {
          const action = await executeSingleToolCall(
            ctx,
            toolCall,
            loopState,
            config,
            callbacks,
          );
          if (action === "end_round") {
            breakRound = true;
            break;
          }
          if (action === "abort_loop" || action === "abort_round") {
            abortRound = true;
            break;
          }
        }
      }
      if (abortRound || breakRound) break;
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

    // Phase A wire-up: run the layered compaction chain before the
    // follow-up provider call. Phase I wire-up: wrap the call in
    // reactive compaction recovery so a 413 triggers a retry with
    // trimmed history. Phase H added PreCompact / PostCompact hook
    // dispatch inside the helper.
    await runPerIterationCompactionBeforeModelCall(
      ctx,
      config,
      callbacks,
      "tool_followup",
    );
    // Re-call LLM.
    const nextResponse = await callModelWithReactiveCompact(
      ctx,
      callbacks,
      "tool_followup",
      () => ({
        phase: "tool_followup",
        callMessages: ctx.messages,
        callSections: ctx.messageSections,
        onStreamChunk: ctx.activeStreamCallback,
        statefulSessionId: ctx.sessionId,
        statefulResumeAnchor: ctx.stateful?.resumeAnchor,
        statefulHistoryCompacted: ctx.stateful?.historyCompacted,
        budgetReason:
          "Max model recalls exceeded while following up after tool calls",
      }),
    );
    if (!nextResponse) break;
    ctx.response = nextResponse;
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

// ============================================================================
// Callback wiring — Phase F PR-5 extraction
// ============================================================================

/**
 * Dependencies for `buildToolLoopCallbacks` that aren't already pure
 * ctx helpers. Only two values need to come from the owning
 * `ChatExecutor` instance: the per-request max runtime system hint
 * cap (a construction-time config) and the `callModelForPhase`
 * orchestration entrypoint (still class state until PR-7 extracts E5).
 */
export interface ToolLoopCallbacksDependencies {
  readonly maxRuntimeSystemHints: number;
  readonly callModelForPhase: ToolLoopCallbacks["callModelForPhase"];
}

/**
 * Build the callback struct consumed by `executeToolCallLoop`. All
 * callback entries route to pure free helpers in
 * `chat-executor-ctx-helpers.ts` except `callModelForPhase`, which is
 * passed through from the caller so the tool loop does not need any
 * import on `chat-executor.ts`.
 *
 * Phase F extraction (PR-5). Previously
 * `ChatExecutor.buildToolLoopCallbacks`.
 */
export function buildToolLoopCallbacks(
  deps: ToolLoopCallbacksDependencies,
): ToolLoopCallbacks {
  const { maxRuntimeSystemHints, callModelForPhase } = deps;
  return {
    pushMessage,
    setStopReason,
    checkRequestTimeout,
    appendToolRecord,
    emitExecutionTrace,
    replaceRuntimeRecoveryHintMessages,
    maybePushRuntimeInstruction: (ctx, content) =>
      maybePushRuntimeInstruction(ctx, content, maxRuntimeSystemHints),
    callModelForPhase,
    serializeRemainingRequestMs,
  };
}

/**
 * Find the index where the "tail" section of a message array begins,
 * defined as the slice after the last user message. Used by in-flight
 * compaction (PR-6 extraction target E1) to preserve the trailing
 * turn unchanged when compacting the conversation history replay.
 *
 * Phase F extraction (PR-5). Previously
 * `ChatExecutor.findInFlightCompactionTailStartIndex`. Extracted here
 * so PR-6's `chat-executor-in-flight-compaction.ts` can import it
 * without depending on `chat-executor.ts`.
 */
export function findInFlightCompactionTailStartIndex(
  messages: readonly import("./types.js").LLMMessage[],
  sections?: readonly PromptBudgetSection[],
): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (
      sections?.[index] === "user" ||
      messages[index]?.role === "user"
    ) {
      return index + 1;
    }
  }
  return messages.length;
}
