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
  LLMStructuredOutputRequest,
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
  ToolLoopTerminalResult,
  ToolLoopState,
  ToolCallAction,
  RecoveryHint,
} from "./chat-executor-types.js";
import {
  MAX_TOOL_IMAGE_CHARS_BUDGET,
} from "./chat-executor-constants.js";
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
  didToolCallFail,
  summarizeToolArgumentChanges,
  buildToolLoopRecoveryMessages,
  buildRoutingExpansionMessage,
} from "./chat-executor-tool-utils.js";
import {
  applyActiveRoutedToolNames,
  buildActiveRoutedToolSet,
} from "./chat-executor-routing-state.js";
import {
  buildRecoveryHints,
  preflightStaleCopiedCmakeHarnessInvocation,
} from "./chat-executor-recovery.js";
import {
  ANTI_FABRICATION_HARNESS_OVERWRITE_REASON,
  evaluateWriteOverFailedVerification,
} from "./verification-target-guard.js";
import { buildTurnEndStopGateSnapshot } from "./chat-executor-stop-gate.js";
import {
  checkTurnContinuationBudget,
  countTurnCompletionTokens,
  finishTurnContinuation,
  shouldStopForDiminishingReturns,
  startTurnContinuation,
} from "./chat-executor-continuation.js";
import { evaluateShellWorkspaceWritePolicy } from "./shell-write-policy.js";
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
import {
  BUILTIN_ARTIFACT_EVIDENCE_HOOK_ID,
  BUILTIN_TURN_END_STOP_GATE_ID,
  runStopHookPhase,
} from "./hooks/stop-hooks.js";
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
  computeAutocompactThreshold,
} from "./compact/index.js";
import { applyReactiveCompact } from "./compact/reactive-compact.js";
import { tryProjectedContextCollapse } from "./chat-executor-history-compaction.js";
import { LLMContextWindowExceededError } from "./errors.js";
import {
  appendToolRecord,
  checkRequestTimeout,
  clearRuntimeInstructionKey,
  emitExecutionTrace,
  getRemainingRequestMs,
  hasModelRecallBudget,
  maybePushRuntimeInstruction,
  maybePushKeyedRuntimeInstruction,
  pushMessage,
  replaceRuntimeRecoveryHintMessages,
  serializeRemainingRequestMs,
  setStopReason,
} from "./chat-executor-ctx-helpers.js";
import {
  DELEGATION_OUTPUT_VALIDATION_CODES,
  type DelegationOutputValidationCode,
} from "../utils/delegation-validation.js";
import {
  type CompletionValidatorId,
  updateRuntimeContractValidatorSnapshot,
  updateRuntimeContractToolProtocolSnapshot,
  updateRuntimeContractVerifierStage,
  updateRuntimeContractVerifierVerdict,
} from "../runtime-contract/types.js";
import {
  getPendingToolProtocolCalls,
  hasPendingToolProtocol,
  noteToolProtocolRepair,
  noteToolProtocolViolation,
  openToolProtocolTurn,
  recordToolProtocolResult,
  responseHasMalformedToolFinish,
  responseHasToolCalls,
  type ToolProtocolRepairReason,
} from "./tool-protocol-state.js";
import {
  type RequestTaskObservationResult,
} from "./request-task-progress.js";
import {
  hasTopLevelVerifierArtifacts,
  resolveTopLevelVerifierArtifacts,
  runTopLevelVerifierValidation,
} from "../gateway/top-level-verifier.js";

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
  appendToolRecord(
    ctx: ExecutionContext,
    record: ToolCallRecord,
  ): RequestTaskObservationResult | undefined;
  emitExecutionTrace(
    ctx: ExecutionContext,
    event: ChatExecutionTraceEvent,
  ): void;
  replaceRuntimeRecoveryHintMessages(
    ctx: ExecutionContext,
    recoveryHints: readonly RecoveryHint[],
  ): void;
  maybePushRuntimeInstruction(ctx: ExecutionContext, content: string): void;
  maybePushKeyedRuntimeInstruction(
    ctx: ExecutionContext,
    params: {
      readonly key: string;
      readonly content: string;
    },
  ): void;
  clearRuntimeInstructionKey(ctx: ExecutionContext, key: string): void;
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
      structuredOutput?: LLMStructuredOutputRequest;
      preparationDiagnostics?: Record<string, unknown>;
      allowRecallBudgetBypass?: boolean;
      budgetReason: string;
    },
  ): Promise<LLMResponse | undefined>;
  serializeRemainingRequestMs(remainingRequestMs: number): number | null;
}

const TOOL_PROTOCOL_REPAIR_ERROR = "tool_protocol_repair";
const FAILED_TOOL_RECOVERY_STREAK = 3;
const TERMINAL_MUTATION_TOOL_NAMES = new Set([
  "system.applyPatch",
  "system.appendFile",
  "system.delete",
  "system.editFile",
  "system.mkdir",
  "system.move",
  "system.writeFile",
  "desktop.text_editor",
]);

function detectSuccessfulWorkspaceMutation(
  toolCalls: readonly ToolCallRecord[],
): boolean {
  return toolCalls.some(
    (call) =>
      TERMINAL_MUTATION_TOOL_NAMES.has(call.name) &&
      !didToolCallFail(call.isError, call.result),
  );
}

function buildToolLoopTerminalResult(
  ctx: ExecutionContext,
): ToolLoopTerminalResult {
  return {
    content: ctx.finalContent,
    stopReason: ctx.stopReason,
    ...(ctx.stopReasonDetail ? { stopReasonDetail: ctx.stopReasonDetail } : {}),
    ...(ctx.validationCode ? { validationCode: ctx.validationCode } : {}),
    ...(ctx.verifierSnapshot ? { verifierSnapshot: ctx.verifierSnapshot } : {}),
    runtimeContractSnapshot: ctx.runtimeContractSnapshot,
    mutationDetected: detectSuccessfulWorkspaceMutation(ctx.allToolCalls),
  };
}

function summarizeToolFailureForRecovery(call: ToolCallRecord): string {
  try {
    const parsed = JSON.parse(call.result) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
      return parsed.error.trim().replace(/\s+/g, " ");
    }
  } catch {
    // Fall back to plain text below.
  }
  const compact = call.result
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 140);
  return compact.length > 0 ? compact : "tool call failed";
}

function buildFailedToolRecoveryHint(
  failedCalls: readonly ToolCallRecord[],
): RecoveryHint | undefined {
  if (failedCalls.length < FAILED_TOOL_RECOVERY_STREAK) {
    return undefined;
  }
  const summary = failedCalls
    .slice(-FAILED_TOOL_RECOVERY_STREAK)
    .map((call) => `${call.name}: ${summarizeToolFailureForRecovery(call)}`)
    .join(" | ");
  return {
    key: "failed_tool_streak",
    message:
      `Recent tool failures: ${summary}. Stop repeating the same failing tool pattern. Reassess the errors and continue without tools unless a materially different tool action is clearly justified.`,
  };
}

function stableToolFailureValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableToolFailureValue(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${stableToolFailureValue(entryValue)}`,
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function toolFailureSignature(
  name: string,
  args: Record<string, unknown>,
): string {
  return `${name}:${stableToolFailureValue(args)}`;
}

function toolCallSignature(toolCall: LLMToolCall): string | undefined {
  try {
    const parsed = JSON.parse(toolCall.arguments) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return toolFailureSignature(
      toolCall.name,
      parsed as Record<string, unknown>,
    );
  } catch {
    return undefined;
  }
}

function isRepeatedSameFailedToolPattern(
  failedCalls: readonly ToolCallRecord[],
): boolean {
  const recentFailures = failedCalls.slice(-FAILED_TOOL_RECOVERY_STREAK);
  if (recentFailures.length < FAILED_TOOL_RECOVERY_STREAK) {
    return false;
  }
  const [first, ...rest] = recentFailures.map((call) =>
    toolFailureSignature(call.name, call.args),
  );
  return rest.every((signature) => signature === first);
}

function responseRepeatsFailedToolPattern(params: {
  readonly response: LLMResponse;
  readonly failedCalls: readonly ToolCallRecord[];
}): boolean {
  if (!isRepeatedSameFailedToolPattern(params.failedCalls)) {
    return false;
  }
  const repeatedFailure = params.failedCalls[params.failedCalls.length - 1];
  if (!repeatedFailure) {
    return false;
  }
  const repeatedSignature = toolFailureSignature(
    repeatedFailure.name,
    repeatedFailure.args,
  );
  return params.response.toolCalls.every(
    (toolCall) => toolCallSignature(toolCall) === repeatedSignature,
  );
}

function collectRecentConsecutiveFailedToolCalls(
  toolCalls: readonly ToolCallRecord[],
): readonly ToolCallRecord[] {
  const collected: ToolCallRecord[] = [];
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const call = toolCalls[index];
    if (call.failureBudgetExempt === true) {
      continue;
    }
    if (!didToolCallFail(call.isError, call.result)) {
      break;
    }
    collected.unshift(call);
  }
  return collected;
}

function updateFailedToolStreak(
  currentStreak: number,
  roundCalls: readonly ToolCallRecord[],
): number {
  let nextStreak = currentStreak;
  for (const call of roundCalls) {
    if (call.failureBudgetExempt === true) {
      continue;
    }
    if (didToolCallFail(call.isError, call.result)) {
      nextStreak += 1;
      continue;
    }
    nextStreak = 0;
  }
  return nextStreak;
}

function mergeRecoveryHints(
  recoveryHints: readonly RecoveryHint[],
  extraHint: RecoveryHint | undefined,
): readonly RecoveryHint[] {
  if (!extraHint) return recoveryHints;
  const filtered = recoveryHints.filter((hint) => hint.key !== extraHint.key);
  return [...filtered, extraHint];
}

function syncToolProtocolSnapshot(ctx: ExecutionContext): void {
  ctx.runtimeContractSnapshot = updateRuntimeContractToolProtocolSnapshot({
    snapshot: ctx.runtimeContractSnapshot,
    open: hasPendingToolProtocol(ctx.toolProtocolState),
    pendingToolCallIds: getPendingToolProtocolCalls(ctx.toolProtocolState).map(
      (toolCall) => toolCall.id,
    ),
    repairCount: ctx.toolProtocolState.repairCount,
    lastRepairReason: ctx.toolProtocolState.lastRepairReason,
    violationCount: ctx.toolProtocolState.violationCount,
    lastViolation: ctx.toolProtocolState.lastViolation,
  });
}

function emitToolProtocolViolation(
  ctx: ExecutionContext,
  callbacks: ToolLoopCallbacks,
  reason: string,
  payload: Record<string, unknown> = {},
): void {
  noteToolProtocolViolation(ctx.toolProtocolState, reason);
  syncToolProtocolSnapshot(ctx);
  callbacks.emitExecutionTrace(ctx, {
    type: "tool_protocol_violation",
    phase: "tool_followup",
    callIndex: ctx.callIndex,
    payload: {
      reason,
      ...payload,
    },
  });
}

function pushToolResultMessage(params: {
  readonly ctx: ExecutionContext;
  readonly callbacks: ToolLoopCallbacks;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: string;
  readonly args: Record<string, unknown>;
  readonly isError: boolean;
  readonly durationMs: number;
  readonly synthetic?: boolean;
  readonly protocolRepairReason?: ToolProtocolRepairReason;
  readonly failureBudgetExempt?: boolean;
}): void {
  const {
    ctx,
    callbacks,
    toolCallId,
    toolName,
    content,
    args,
    isError,
    durationMs,
    synthetic,
    protocolRepairReason,
  } = params;
  callbacks.pushMessage(
    ctx,
    {
      role: "tool",
      content,
      toolCallId,
      toolName,
    },
    "tools",
  );
  callbacks.appendToolRecord(ctx, {
    name: toolName,
    args,
    result: content,
    isError,
    durationMs,
    toolCallId,
    ...(synthetic ? { synthetic: true } : {}),
    ...(protocolRepairReason ? { protocolRepairReason } : {}),
    ...(params.failureBudgetExempt ? { failureBudgetExempt: true } : {}),
  });
  recordToolProtocolResult(ctx.toolProtocolState, toolCallId);
  syncToolProtocolSnapshot(ctx);
  callbacks.emitExecutionTrace(ctx, {
    type: "tool_protocol_result_recorded",
    phase: "tool_followup",
    callIndex: ctx.callIndex,
    payload: {
      toolCallId,
      tool: toolName,
      synthetic: synthetic === true,
      pendingToolCallIds: getPendingToolProtocolCalls(ctx.toolProtocolState).map(
        (toolCall) => toolCall.id,
      ),
      ...(protocolRepairReason ? { protocolRepairReason } : {}),
    },
  });
}

function materializeResponseToolCalls(
  ctx: ExecutionContext,
  callbacks: ToolLoopCallbacks,
): readonly LLMToolCall[] {
  if (!ctx.response || !responseHasToolCalls(ctx.response)) {
    return [];
  }
  if (hasPendingToolProtocol(ctx.toolProtocolState)) {
    return ctx.response.toolCalls;
  }

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
  openToolProtocolTurn(ctx.toolProtocolState, ctx.response.toolCalls);
  syncToolProtocolSnapshot(ctx);
  callbacks.emitExecutionTrace(ctx, {
    type: "tool_protocol_opened",
    phase: "tool_followup",
    callIndex: ctx.callIndex,
    payload: {
      toolCallIds: ctx.response.toolCalls.map((toolCall) => toolCall.id),
      toolNames: ctx.response.toolCalls.map((toolCall) => toolCall.name),
      finishReason: ctx.response.finishReason,
    },
  });
  return ctx.response.toolCalls;
}

function sealPendingToolProtocol(
  ctx: ExecutionContext,
  callbacks: ToolLoopCallbacks,
  reason: ToolProtocolRepairReason,
): boolean {
  const pendingToolCalls = getPendingToolProtocolCalls(ctx.toolProtocolState);
  if (pendingToolCalls.length === 0) {
    return false;
  }

  for (const toolCall of pendingToolCalls) {
    pushToolResultMessage({
      ctx,
      callbacks,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: JSON.stringify({
        error: "Runtime closed unresolved tool call before continuation",
        code: TOOL_PROTOCOL_REPAIR_ERROR,
        reason,
      }),
      args: {},
      isError: true,
      durationMs: 0,
      synthetic: true,
      protocolRepairReason: reason,
      failureBudgetExempt: true,
    });
  }

  noteToolProtocolRepair(ctx.toolProtocolState, reason);
  if (ctx.response && responseHasToolCalls(ctx.response)) {
    ctx.response = {
      ...ctx.response,
      content: "",
    };
  }
  syncToolProtocolSnapshot(ctx);
  callbacks.emitExecutionTrace(ctx, {
    type: "tool_protocol_repaired",
    phase: "tool_followup",
    callIndex: ctx.callIndex,
    payload: {
      reason,
      repairedToolCallIds: pendingToolCalls.map((toolCall) => toolCall.id),
      repairedToolNames: pendingToolCalls.map((toolCall) => toolCall.name),
    },
  });
  return true;
}

function failClosedOnMalformedToolContinuation(
  ctx: ExecutionContext,
  callbacks: ToolLoopCallbacks,
): boolean {
  if (!responseHasMalformedToolFinish(ctx.response)) {
    return false;
  }

  const detail =
    "Provider returned finishReason \"tool_calls\" without any tool calls; refusing to continue with an invalid tool-turn state.";
  emitToolProtocolViolation(ctx, callbacks, "missing_tool_calls_for_finish_reason", {
    finishReason: ctx.response?.finishReason,
    contentPreview: (ctx.response?.content ?? "").slice(0, 240),
  });
  callbacks.setStopReason(ctx, "validation_error", detail);
  if (ctx.response) {
    ctx.response = {
      ...ctx.response,
      content: "",
    };
  }
  return true;
}

function asDelegationOutputValidationCode(
  value: unknown,
): DelegationOutputValidationCode | undefined {
  return typeof value === "string" &&
    (DELEGATION_OUTPUT_VALIDATION_CODES as readonly string[]).includes(value)
    ? (value as DelegationOutputValidationCode)
    : undefined;
}

export interface ToolLoopConfig {
  readonly maxRuntimeSystemHints: number;
  readonly toolCallTimeoutMs: number;
  readonly retryPolicyMatrix: LLMRetryPolicyMatrix;
  readonly allowedTools: Set<string> | null;
  /**
   * The model's context window in tokens. Used to compute the
   * autocompact threshold as a percentage of the window
   * (DEFAULT_AUTOCOMPACT_THRESHOLD_FRACTION = 40%). When not set,
   * falls back to DEFAULT_AUTOCOMPACT_THRESHOLD_TOKENS (120K).
   */
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
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
  readonly runtimeContractFlags: import("../runtime-contract/types.js").RuntimeContractFlags;
  readonly stopHookRuntime?: import("./hooks/stop-hooks.js").StopHookRuntime;
  readonly completionValidation?: import("./chat-executor-types.js").ChatExecutorConfig["completionValidation"];
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
// CONTRACT_MUTATION_TOOL_NAMES / SHELL_MUTATION_COMMAND_RE / isMutationLikeToolUse
// were removed alongside the no-op'd enforceTurnExecutionContractPolicy gate
// (see comment on that function below). The classifier those constants
// fed has been gone since Cut 1.2 and the gate now always returns
// undefined, so the constants are dead.

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

function enforceTurnExecutionContractPolicy(_params: {
  readonly ctx: ExecutionContext;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}): string | undefined {
  // Regression no-op (2026-04-09):
  //
  // This gate originally rejected mutation-class tool calls when the turn
  // had not been classified as `workflow_implementation` or
  // `artifact_update`. The classifier that produced those values lived in
  // the planner subsystem that was removed by Cut 1.2. With the planner
  // gone, `resolveTurnExecutionContract` is a stub that always returns
  // `turnClass: "dialogue"` (see runtime/src/llm/turn-execution-contract.ts),
  // so this gate refused 100% of mutations and made the runtime unusable
  // for any code-changing chat turn.
  //
  // Until a real classifier is reinstated (or the gate is properly removed
  // along with its plumbing), short-circuit to "no rejection". The
  // upstream anti-fabrication gate, the canUseTool seam, the policy-gate
  // hook, and the ToolPermissionEvaluator all still run normally.
  return undefined;
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
    pushToolResultMessage({
      ctx,
      callbacks,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: contractPolicyError,
      args,
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
    autocompactThresholdTokens: computeAutocompactThreshold(
      config.contextWindowTokens,
      config.maxOutputTokens,
    ),
    lastResponseUsage: ctx.response?.usage,
    collapseHook: (messages) => {
      const projected = tryProjectedContextCollapse({
        history: messages,
        sessionId: ctx.sessionId,
        existingArtifactContext: ctx.compactedArtifactContext,
        autocompactThresholdTokens: computeAutocompactThreshold(
          config.contextWindowTokens,
          config.maxOutputTokens,
        ),
      });
      if (!projected) {
        return {
          action: "noop" as const,
          messages,
        };
      }
      ctx.compacted = true;
      ctx.compactedArtifactContext = projected.artifactContext;
      return {
        action: "collapsed" as const,
        messages: projected.history,
        boundary: projected.boundary,
      };
    },
    ...(config.consolidationHook
      ? { consolidationHook: config.consolidationHook }
      : {}),
  });

  ctx.perIterationCompaction = result.state;

  if (result.action === "noop") return;

  // Phase H: dispatch PreCompact for each layer that fired, with the
  // registry-supplied matcher allowed to veto.
  if (config.hookRegistry) {
    for (const boundary of result.boundaries) {
      const content =
        typeof boundary.content === "string" ? boundary.content : "";
      const layer = extractCompactionLayerTag(content) as
        | "snip"
        | "microcompact"
        | "context-collapse"
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
        | "context-collapse"
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
 * Mirrors the runtime's reactive compaction recovery path.
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
      sealPendingToolProtocol(ctx, callbacks, "reactive_compact_retry");
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
): Promise<ToolLoopTerminalResult> {
  // Phase A wire-up: run the layered compaction chain before the
  // initial provider call. This is the top-of-iteration insertion
  // point for the layered compaction runtime. Phase H added
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
      structuredOutput: ctx.structuredOutput,
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
  failClosedOnMalformedToolContinuation(ctx, callbacks);

  let rounds = 0;
  let effectiveMaxToolRounds = ctx.effectiveMaxToolRounds;
  const loopState: ToolLoopState = {
    remainingToolImageChars: MAX_TOOL_IMAGE_CHARS_BUDGET,
    activeRoutedToolSet: null,
    expandAfterRound: false,
  };
  let consecutiveFailedToolCalls = 0;
  let forcedFailureRecoveryUsed = false;

  // Turn-end completion validation now shares one turn-local
  // continuation controller instead of per-validator attempt maps.
  // Continuations keep going while request/model/tool budgets allow and
  // the last continuation cycle was still productive. Explicit
  // per-validator caps remain supported only as tighter ceilings.
  let shouldContinueAfterStopGate = false;
  const emitContinuationEvaluation = (): ReturnType<
    typeof finishTurnContinuation
  > => {
    const summary = finishTurnContinuation({
      state: ctx.continuationState,
      ctx,
    });
    if (!summary) {
      return undefined;
    }
    callbacks.emitExecutionTrace(ctx, {
      type: "continuation_evaluated",
      phase: "tool_followup",
      callIndex: ctx.callIndex,
      payload: {
        reason: summary.reason,
        validatorId: summary.validatorId,
        attempt: summary.attempt,
        outputTokenDelta: summary.outputTokenDelta,
        toolCallsIssued: summary.toolCallsIssued,
        successfulWorkspaceMutation: summary.successfulWorkspaceMutation,
        diagnosticFingerprintChanged: summary.diagnosticFingerprintChanged,
        materiallyIncreasedOutput: summary.materiallyIncreasedOutput,
        productive: summary.productive,
        lowProgressStall: summary.lowProgressStall,
        consecutiveLowProgressStalls:
          ctx.continuationState.consecutiveLowProgressStalls,
      },
    });
    return summary;
  };
  const resolveTurnOutputTokenBudget = (): number | null => {
    return ctx.turnOutputTokenBudget;
  };
  const shouldAllowBudgetContinuation = (): boolean => {
    const structuredOutputActive =
      ctx.structuredOutput?.schema !== undefined &&
      ctx.structuredOutput.enabled !== false;
    if (structuredOutputActive) {
      return false;
    }
    if (ctx.sessionId.startsWith("subagent:")) {
      return false;
    }
    return true;
  };
  const attemptCompletionRecovery = async (params: {
    readonly reason: string;
    readonly blockingMessage?: string;
    readonly evidence?: unknown;
    readonly maxAttempts?: number;
    readonly budgetReason: string;
    readonly exhaustedDetail: string;
    readonly validationCode?: DelegationOutputValidationCode;
    readonly validatorId?: CompletionValidatorId;
    readonly stopHookResult?: import("./hooks/stop-hooks.js").StopHookPhaseResult;
    readonly continuationSummary?: ReturnType<typeof finishTurnContinuation>;
  }): Promise<boolean> => {
    const continuationCap =
      params.maxAttempts !== undefined
        ? Math.max(0, params.maxAttempts)
        : undefined;
    const shouldExhaustForDiminishingReturns =
      shouldStopForDiminishingReturns(ctx.continuationState);
    if (
      !params.blockingMessage ||
      (continuationCap !== undefined &&
        ctx.continuationState.continuationCount >= continuationCap) ||
      shouldExhaustForDiminishingReturns
    ) {
      if (params.stopHookResult) {
        callbacks.emitExecutionTrace(ctx, {
          type: "stop_hook_exhausted",
          phase: "tool_followup",
          callIndex: ctx.callIndex,
          payload: {
            validatorId: params.validatorId ?? params.reason,
            stopHookPhase: params.stopHookResult.phase,
            outcome: params.stopHookResult.outcome,
            reason: params.stopHookResult.reason,
            stopReason: params.stopHookResult.stopReason,
            exhaustedDetail: params.exhaustedDetail,
            validationCode: params.validationCode,
            attempts: ctx.continuationState.continuationCount,
            maxAttempts: continuationCap,
            diminishingReturns: shouldExhaustForDiminishingReturns,
          },
        });
      }
      callbacks.emitExecutionTrace(ctx, {
        type: "continuation_stopped",
        phase: "tool_followup",
        callIndex: ctx.callIndex,
        payload: {
          reason: params.reason,
          validatorId: params.validatorId,
          attempt: ctx.continuationState.continuationCount,
          maxAttempts: continuationCap,
          exhaustedDetail: params.exhaustedDetail,
          continuationSummary: params.continuationSummary,
          stopCause: shouldExhaustForDiminishingReturns
            ? "diminishing_returns"
            : continuationCap !== undefined &&
                ctx.continuationState.continuationCount >= continuationCap
              ? "continuation_cap"
              : "blocking_message_unavailable",
        },
      });
      callbacks.setStopReason(
        ctx,
        "validation_error",
        shouldExhaustForDiminishingReturns
          ? `${params.exhaustedDetail} Runtime continuation controller stopped after repeated low-progress recoveries.`
          : params.exhaustedDetail,
      );
      if (params.validationCode) {
        ctx.validationCode = params.validationCode;
      }
      if (ctx.response) {
        ctx.response = {
          ...ctx.response,
          content: "",
        };
      }
      return false;
    }

    sealPendingToolProtocol(ctx, callbacks, "validation_recovery");
    const activeContinuation = startTurnContinuation({
      state: ctx.continuationState,
      ctx,
      reason: params.reason,
      validatorId: params.validatorId,
      tighterCap: continuationCap,
    });
    if (params.stopHookResult) {
      callbacks.emitExecutionTrace(ctx, {
        type: "stop_hook_retry_requested",
        phase: "tool_followup",
        callIndex: ctx.callIndex,
        payload: {
          validatorId: params.validatorId ?? params.reason,
          stopHookPhase: params.stopHookResult.phase,
          outcome: params.stopHookResult.outcome,
          reason: params.stopHookResult.reason,
          stopReason: params.stopHookResult.stopReason,
          attempt: activeContinuation.attempt,
          maxAttempts: continuationCap,
          validationCode: params.validationCode,
        },
      });
    }
    callbacks.emitExecutionTrace(ctx, {
      type: "continuation_started",
      phase: "tool_followup",
      callIndex: ctx.callIndex,
      payload: {
        reason: params.reason,
        validatorId: params.validatorId,
        attempt: activeContinuation.attempt,
        maxAttempts: continuationCap,
      },
    });
    callbacks.emitExecutionTrace(ctx, {
      type: "stop_gate_intervention",
      phase: "tool_followup",
      callIndex: ctx.callIndex,
      payload: {
        reason: params.reason,
        attempt: activeContinuation.attempt,
        maxAttempts: continuationCap,
        finalContentPreview: (ctx.response?.content ?? "").slice(0, 240),
        ...(params.evidence !== undefined ? { evidence: params.evidence } : {}),
      },
    });
    callbacks.pushMessage(
      ctx,
      {
        role: "user",
        content: params.blockingMessage,
      },
      "system_runtime",
    );
    await runPerIterationCompactionBeforeModelCall(
      ctx,
      config,
      callbacks,
      "tool_followup",
    );
    const shouldRequireRecoveryTool =
      params.validationCode === "missing_file_mutation_evidence" ||
      params.validationCode === "missing_file_artifact_evidence" ||
      (params.stopHookResult !== undefined && ctx.requiredToolEvidence !== undefined);
    const recoveryToolChoice = shouldRequireRecoveryTool
      ? "required"
      : undefined;
    const recoveryResponse = await callModelWithReactiveCompact(
      ctx,
      callbacks,
      "tool_followup",
      () => ({
        phase: "tool_followup",
        callMessages: ctx.messages,
        callSections: ctx.messageSections,
        onStreamChunk: ctx.activeStreamCallback,
        structuredOutput: ctx.structuredOutput,
        statefulSessionId: ctx.sessionId,
        statefulResumeAnchor: ctx.stateful?.resumeAnchor,
        statefulHistoryCompacted: ctx.stateful?.historyCompacted,
        toolChoice: recoveryToolChoice,
        budgetReason: params.budgetReason,
      }),
    );
    if (!recoveryResponse) {
      ctx.continuationState.active = undefined;
      if (params.stopHookResult) {
        callbacks.emitExecutionTrace(ctx, {
          type: "stop_hook_exhausted",
          phase: "tool_followup",
          callIndex: ctx.callIndex,
          payload: {
            validatorId: params.validatorId ?? params.reason,
            stopHookPhase: params.stopHookResult.phase,
            outcome: params.stopHookResult.outcome,
            reason: params.stopHookResult.reason,
            stopReason: params.stopHookResult.stopReason,
            exhaustedDetail: params.exhaustedDetail,
            validationCode: params.validationCode,
            attempt: activeContinuation.attempt,
            maxAttempts: continuationCap,
          },
        });
      }
      if (ctx.stopReason === "completed") {
        callbacks.setStopReason(ctx, "validation_error", params.exhaustedDetail);
        if (params.validationCode) {
          ctx.validationCode = params.validationCode;
        }
      }
      return false;
    }
    if (
      (params.validationCode === "missing_file_mutation_evidence" ||
        params.validationCode === "missing_file_artifact_evidence") &&
      !responseHasToolCalls(recoveryResponse)
    ) {
      ctx.continuationState.active = undefined;
      callbacks.emitExecutionTrace(ctx, {
        type: "continuation_stopped",
        phase: "tool_followup",
        callIndex: ctx.callIndex,
        payload: {
          reason: params.reason,
          validatorId: params.validatorId,
          attempt: activeContinuation.attempt,
          maxAttempts: continuationCap,
          exhaustedDetail: params.exhaustedDetail,
          validationCode: params.validationCode,
          stopCause: "missing_required_recovery_tool_calls",
        },
      });
      callbacks.setStopReason(ctx, "validation_error", params.exhaustedDetail);
      ctx.validationCode = params.validationCode;
      ctx.response = { ...recoveryResponse, content: "" };
      return false;
    }
    ctx.response = recoveryResponse;
    failClosedOnMalformedToolContinuation(ctx, callbacks);
    shouldContinueAfterStopGate = true;
    return true;
  };
  const attemptTokenBudgetContinuation = async (params: {
    readonly continuationSummary?: ReturnType<typeof finishTurnContinuation>;
  }): Promise<boolean> => {
    const decision = checkTurnContinuationBudget({
      state: ctx.continuationState,
      budget: resolveTurnOutputTokenBudget(),
      globalTurnTokens: countTurnCompletionTokens(ctx.callUsage),
      eligible: shouldAllowBudgetContinuation(),
    });
    if (decision.action === "stop") {
      if (decision.completionEvent) {
        callbacks.emitExecutionTrace(ctx, {
          type: "continuation_stopped",
          phase: "tool_followup",
          callIndex: ctx.callIndex,
          payload: {
            reason: "token_budget",
            continuationSummary: params.continuationSummary,
            completionEvent: decision.completionEvent,
            stopCause: decision.completionEvent.diminishingReturns
              ? "diminishing_returns"
              : "token_budget_completed",
          },
        });
      }
      return false;
    }
    if (!hasModelRecallBudget(ctx) || getRemainingRequestMs(ctx) <= 0) {
      callbacks.emitExecutionTrace(ctx, {
        type: "continuation_stopped",
        phase: "tool_followup",
        callIndex: ctx.callIndex,
        payload: {
          reason: "token_budget",
          continuationSummary: params.continuationSummary,
          stopCause: !hasModelRecallBudget(ctx)
            ? "model_recall_budget_exhausted"
            : "request_timeout_exhausted",
          turnTokens: decision.turnTokens,
          budget: decision.budget,
          pct: decision.pct,
          continuationCount: decision.continuationCount,
        },
      });
      return false;
    }
    sealPendingToolProtocol(ctx, callbacks, "validation_recovery");
    const activeContinuation = startTurnContinuation({
      state: ctx.continuationState,
      ctx,
      reason: "token_budget",
    });
    callbacks.emitExecutionTrace(ctx, {
      type: "continuation_started",
      phase: "tool_followup",
      callIndex: ctx.callIndex,
      payload: {
        reason: "token_budget",
        attempt: activeContinuation.attempt,
        continuationCount: decision.continuationCount,
        turnTokens: decision.turnTokens,
        budget: decision.budget,
        pct: decision.pct,
      },
    });
    callbacks.pushMessage(
      ctx,
      {
        role: "user",
        content: decision.nudgeMessage,
      },
      "system_runtime",
    );
    await runPerIterationCompactionBeforeModelCall(
      ctx,
      config,
      callbacks,
      "tool_followup",
    );
    const continuationResponse = await callModelWithReactiveCompact(
      ctx,
      callbacks,
      "tool_followup",
      () => ({
        phase: "tool_followup",
        callMessages: ctx.messages,
        callSections: ctx.messageSections,
        onStreamChunk: ctx.activeStreamCallback,
        structuredOutput: ctx.structuredOutput,
        statefulSessionId: ctx.sessionId,
        statefulResumeAnchor: ctx.stateful?.resumeAnchor,
        statefulHistoryCompacted: ctx.stateful?.historyCompacted,
        budgetReason:
          "Max model recalls exceeded during token-budget continuation",
      }),
    );
    if (!continuationResponse) {
      ctx.continuationState.active = undefined;
      return false;
    }
    ctx.response = continuationResponse;
    failClosedOnMalformedToolContinuation(ctx, callbacks);
    shouldContinueAfterStopGate = true;
    return true;
  };
  do {
    shouldContinueAfterStopGate = false;
  while (
    ctx.response &&
    responseHasToolCalls(ctx.response)
  ) {
    if (ctx.signal?.aborted) {
      materializeResponseToolCalls(ctx, callbacks);
      sealPendingToolProtocol(ctx, callbacks, "request_cancelled");
      callbacks.setStopReason(ctx, "cancelled", "Execution cancelled by caller");
      break;
    }
    if (callbacks.checkRequestTimeout(ctx, "tool loop")) {
      materializeResponseToolCalls(ctx, callbacks);
      sealPendingToolProtocol(ctx, callbacks, "request_timeout");
      break;
    }
    if (isRuntimeLimitReached(rounds, effectiveMaxToolRounds)) {
      materializeResponseToolCalls(ctx, callbacks);
      sealPendingToolProtocol(ctx, callbacks, "max_tool_rounds");
      callbacks.setStopReason(
        ctx,
        "tool_calls",
        `Reached max tool rounds (${effectiveMaxToolRounds})`,
      );
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
    const roundToolCalls = materializeResponseToolCalls(ctx, callbacks);
    if (!ctx.activeToolHandler) {
      sealPendingToolProtocol(ctx, callbacks, "missing_tool_handler");
      callbacks.setStopReason(
        ctx,
        "tool_error",
        "Model requested tools but no tool handler is available for this turn.",
      );
      break;
    }

    // Phase B (U2): partition this round's tool calls into
    // concurrency-safe batches. A run of consecutive read-only tool
    // calls becomes one parallel batch dispatched via Promise.all;
    // every other call runs serially as its own batch of length 1.
    // When the caller does not supply `isConcurrencySafe`, every
    // call falls into its own serial batch (identical to the old
    // for-loop).
    const dispatchBatches = partitionToolCalls(
      roundToolCalls,
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
      sealPendingToolProtocol(ctx, callbacks, "request_cancelled");
      callbacks.setStopReason(ctx, "cancelled", "Execution cancelled by caller");
      break;
    }
    if (callbacks.checkRequestTimeout(ctx, "tool follow-up")) {
      sealPendingToolProtocol(ctx, callbacks, "request_timeout");
      break;
    }

    const roundCalls = ctx.allToolCalls.slice(roundToolCallStart);
    if (abortRound) {
      sealPendingToolProtocol(ctx, callbacks, "round_aborted");
      break;
    }
    consecutiveFailedToolCalls = updateFailedToolStreak(
      consecutiveFailedToolCalls,
      roundCalls,
    );
    const recentConsecutiveFailedToolCalls = collectRecentConsecutiveFailedToolCalls(
      ctx.allToolCalls,
    );
    const failedToolRecoveryHint = buildFailedToolRecoveryHint(
      recentConsecutiveFailedToolCalls,
    );
    const shouldForceFailureRecovery =
      ctx.effectiveFailureBudget > 0 &&
      !forcedFailureRecoveryUsed &&
      consecutiveFailedToolCalls >= FAILED_TOOL_RECOVERY_STREAK;

    // Recovery hints.
    const recoveryHistoryWindow = ctx.allToolCalls.slice(
      Math.max(0, ctx.allToolCalls.length - 48),
    );
    const recoveryHints = mergeRecoveryHints(
      buildRecoveryHints(
        roundCalls,
        new Set<string>(),
        recoveryHistoryWindow,
      ),
      shouldForceFailureRecovery ? failedToolRecoveryHint : undefined,
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
        structuredOutput: ctx.structuredOutput,
        statefulSessionId: ctx.sessionId,
        statefulResumeAnchor: ctx.stateful?.resumeAnchor,
        statefulHistoryCompacted: ctx.stateful?.historyCompacted,
        ...(shouldForceFailureRecovery ? { toolChoice: "none" as const } : {}),
        budgetReason:
          "Max model recalls exceeded while following up after tool calls",
      }),
    );
    if (!nextResponse) break;
    if (shouldForceFailureRecovery) {
      forcedFailureRecoveryUsed = true;
      if (
        responseHasToolCalls(nextResponse) &&
        !responseRepeatsFailedToolPattern({
          response: nextResponse,
          failedCalls: recentConsecutiveFailedToolCalls,
        })
      ) {
        emitToolProtocolViolation(
          ctx,
          callbacks,
          "tool_choice_none_ignored_after_failed_tool_recovery",
          {
            toolNames: nextResponse.toolCalls.map((toolCall) => toolCall.name),
            finishReason: nextResponse.finishReason,
          },
        );
        callbacks.setStopReason(
          ctx,
          "validation_error",
          "Provider emitted tool calls after the runtime requested a no-tool recovery turn.",
        );
        ctx.response = { ...nextResponse, content: "" };
        break;
      }
    }
    ctx.response = nextResponse;
    failClosedOnMalformedToolContinuation(ctx, callbacks);
  }

  // Turn-end stop gate evaluation. Runs only when the inner tool loop
  // exited cleanly (model stopped requesting tools, no abort, no
  // budget/timeout failure). Fires at most once per turn.
  if (
    !ctx.signal?.aborted &&
    ctx.response &&
    !responseHasToolCalls(ctx.response) &&
    !hasPendingToolProtocol(ctx.toolProtocolState) &&
    ctx.stopReason === "completed"
  ) {
    const continuationSummary = ctx.continuationState.active
      ? emitContinuationEvaluation()
      : undefined;
    const stopHookValidators = [
      {
        hookId: BUILTIN_TURN_END_STOP_GATE_ID,
        validatorId: "turn_end_stop_gate" as CompletionValidatorId,
      },
      {
        hookId: BUILTIN_ARTIFACT_EVIDENCE_HOOK_ID,
        validatorId: "artifact_evidence" as CompletionValidatorId,
      },
    ] as const;

    callbacks.emitExecutionTrace(ctx, {
      type: "completion_validation_started",
      phase: "tool_followup",
      callIndex: ctx.callIndex,
      payload: {
        validatorOrder: stopHookValidators.map((entry) => entry.validatorId),
        runtimeContract: ctx.runtimeContractSnapshot,
      },
    });

    let completionValidationStatus = "passed";
    const verifierArtifacts = resolveTopLevelVerifierArtifacts({
      turnExecutionContract: ctx.turnExecutionContract,
      allToolCalls: ctx.allToolCalls,
      workspaceRoot: ctx.runtimeWorkspaceRoot,
    });
    const runtimeVerifierRequired =
      (
        ctx.runtimeContractFlags.verifierRuntimeRequired === true ||
        config.completionValidation?.topLevelVerifier !== undefined
      ) &&
      hasTopLevelVerifierArtifacts({
        turnExecutionContract: ctx.turnExecutionContract,
        allToolCalls: ctx.allToolCalls,
        workspaceRoot: verifierArtifacts.workspaceRoot,
      });
    ctx.runtimeContractSnapshot = updateRuntimeContractVerifierStage({
      snapshot: ctx.runtimeContractSnapshot,
      verifierStages: {
        ...ctx.runtimeContractSnapshot.verifierStages,
        runtimeRequired: runtimeVerifierRequired,
        launcherKind: runtimeVerifierRequired ? "subagent" : "none",
        stageStatus: runtimeVerifierRequired ? "pending" : "inactive",
        ...(runtimeVerifierRequired
          ? { skipReason: undefined }
          : { skipReason: "runtime_not_required" }),
      },
    });
    const stopHooksEnabled =
      config.runtimeContractFlags.stopHooksEnabled &&
      config.stopHookRuntime !== undefined;

    for (const entry of stopHookValidators) {
      callbacks.emitExecutionTrace(ctx, {
        type: "completion_validator_started",
        phase: "tool_followup",
        callIndex: ctx.callIndex,
        payload: {
          validatorId: entry.validatorId,
          enabled: stopHooksEnabled,
          runtimeContract: ctx.runtimeContractSnapshot,
        },
      });
    }
    if (!stopHooksEnabled) {
      for (const entry of stopHookValidators) {
        ctx.runtimeContractSnapshot = updateRuntimeContractValidatorSnapshot({
          snapshot: ctx.runtimeContractSnapshot,
          id: entry.validatorId,
          enabled: false,
          executed: false,
          outcome: "skipped",
        });
        callbacks.emitExecutionTrace(ctx, {
          type: "completion_validator_finished",
          phase: "tool_followup",
          callIndex: ctx.callIndex,
          payload: {
            validatorId: entry.validatorId,
            enabled: false,
            outcome: "skipped",
            runtimeContract: ctx.runtimeContractSnapshot,
          },
        });
      }
    } else {
      const hookResult = await runStopHookPhase({
        runtime: config.stopHookRuntime,
        phase: "Stop",
        matchKey: ctx.sessionId,
        context: {
          phase: "Stop",
          sessionId: ctx.sessionId,
          runtimeWorkspaceRoot: ctx.runtimeWorkspaceRoot,
          finalContent: ctx.response?.content ?? "",
          allToolCalls: ctx.allToolCalls,
          turnEndSnapshot: buildTurnEndStopGateSnapshot(ctx.allToolCalls),
          runtimeChecks: {
            requiredToolEvidence: ctx.requiredToolEvidence,
            targetArtifacts: ctx.turnExecutionContract.targetArtifacts,
            activeToolHandler: ctx.activeToolHandler,
            appendProbeRuns: (runs) => {
              for (const run of runs) {
                callbacks.appendToolRecord(ctx, run);
              }
            },
          },
        },
      });
      callbacks.emitExecutionTrace(ctx, {
        type: "stop_hook_execution_finished",
        phase: "tool_followup",
        callIndex: ctx.callIndex,
        payload: {
          validatorId: "turn_end_stop_gate",
          stopHookPhase: hookResult.phase,
          outcome: hookResult.outcome,
          reason: hookResult.reason,
          stopReason: hookResult.stopReason,
          hookIds: hookResult.hookOutcomes.map((outcome) => outcome.hookId),
          progressMessages: hookResult.progressMessages,
          evidence: hookResult.evidence,
        },
      });

      const hookOutcomes = new Map(
        hookResult.hookOutcomes.map((outcome) => [outcome.hookId, outcome]),
      );
      for (const entry of stopHookValidators) {
        const outcome = hookOutcomes.get(entry.hookId);
        const snapshotOutcome =
          !outcome
            ? "skipped"
            : outcome.preventContinuation
              ? "fail_closed"
              : outcome.blockingError
                ? "retry_with_blocking_message"
                : "pass";
        const reason =
          outcome?.stopReason ??
          outcome?.blockingError?.hookId ??
          outcome?.hookId;
        ctx.runtimeContractSnapshot = updateRuntimeContractValidatorSnapshot({
          snapshot: ctx.runtimeContractSnapshot,
          id: entry.validatorId,
          enabled: true,
          executed: outcome !== undefined,
          outcome: snapshotOutcome,
          reason,
        });
        callbacks.emitExecutionTrace(ctx, {
          type: "completion_validator_finished",
          phase: "tool_followup",
          callIndex: ctx.callIndex,
          payload: {
            validatorId: entry.validatorId,
            enabled: true,
            outcome: snapshotOutcome,
            reason,
            runtimeContract: ctx.runtimeContractSnapshot,
          },
        });
      }

      if (hookResult.outcome !== "pass") {
        callbacks.emitExecutionTrace(ctx, {
          type: "stop_hook_blocked",
          phase: "tool_followup",
          callIndex: ctx.callIndex,
          payload: {
            validatorId: "turn_end_stop_gate",
            stopHookPhase: hookResult.phase,
            outcome: hookResult.outcome,
            reason: hookResult.reason,
            stopReason: hookResult.stopReason,
          },
        });
      }

      if (hookResult.outcome === "prevent_continuation") {
        completionValidationStatus = "fail_closed";
        callbacks.setStopReason(
          ctx,
          "validation_error",
          hookResult.stopReason ?? "Stop-hook chain prevented completion.",
        );
        ctx.validationCode = asDelegationOutputValidationCode(
          hookResult.stopReason ?? hookResult.reason,
        );
        if (ctx.response) {
          ctx.response = {
            ...ctx.response,
            content: "",
          };
        }
      } else if (hookResult.outcome === "retry_with_blocking_message") {
        const hookValidationCode = asDelegationOutputValidationCode(
          hookResult.stopReason ?? hookResult.reason,
        );
        const stopHookRecovery = await attemptCompletionRecovery({
          reason: hookResult.reason ?? "turn_end_stop_gate",
          blockingMessage: hookResult.blockingMessage,
          evidence: hookResult.evidence,
          maxAttempts:
            config.stopHookRuntime?.maxAttemptsExplicit === true
              ? config.stopHookRuntime.maxAttempts
              : ctx.requiredToolEvidence?.maxCorrectionAttemptsExplicit === true
                ? ctx.requiredToolEvidence.maxCorrectionAttempts
                : undefined,
          budgetReason:
            hookValidationCode === "missing_file_mutation_evidence" ||
            hookValidationCode === "missing_file_artifact_evidence"
              ? "Max model recalls exceeded during artifact-evidence recovery turn"
              : "Max model recalls exceeded during stop-hook recovery turn",
          exhaustedDetail:
            hookResult.reason === "narrated_future_tool_work"
              ? "Stop-gate recovery exhausted: the model kept narrating future work instead of calling tools."
              : (hookValidationCode === "missing_file_mutation_evidence" ||
                    hookValidationCode === "missing_file_artifact_evidence") &&
                  hookResult.blockingMessage
                ? hookResult.blockingMessage
                : "Stop-gate recovery exhausted after the model continued to emit an invalid completion summary.",
          validationCode: hookValidationCode,
          validatorId: "turn_end_stop_gate",
          stopHookResult: hookResult,
          continuationSummary,
        });
        completionValidationStatus = stopHookRecovery
          ? "recovery_requested"
          : "recovery_exhausted";
        callbacks.emitExecutionTrace(ctx, {
          type: "completion_validation_finished",
          phase: "tool_followup",
          callIndex: ctx.callIndex,
          payload: {
            status: completionValidationStatus,
            stopReason: ctx.stopReason,
            validationCode: ctx.validationCode,
            runtimeContract: ctx.runtimeContractSnapshot,
          },
        });
        if (stopHookRecovery) {
          continue;
        }
      }
    }

    if (ctx.stopReason === "completed" && runtimeVerifierRequired) {
      ctx.runtimeContractSnapshot = updateRuntimeContractVerifierStage({
        snapshot: ctx.runtimeContractSnapshot,
        verifierStages: {
          ...ctx.runtimeContractSnapshot.verifierStages,
          runtimeRequired: true,
          launcherKind: "subagent",
          stageStatus: "running",
          skipReason: undefined,
        },
      });
      if (ctx.stopReason === "completed") {
        const validation = await runTopLevelVerifierValidation({
          sessionId: ctx.sessionId,
          userRequest: ctx.messageText,
          result: {
            content: ctx.response?.content ?? "",
            stopReason: ctx.stopReason,
            completionState: ctx.completionState,
            runtimeWorkspaceRoot: ctx.runtimeWorkspaceRoot,
            turnExecutionContract: ctx.turnExecutionContract,
            toolCalls: ctx.allToolCalls,
            stopReasonDetail: ctx.stopReasonDetail,
            validationCode: ctx.validationCode,
            completionProgress: undefined,
            runtimeContractSnapshot: ctx.runtimeContractSnapshot,
          },
          subAgentManager:
            config.completionValidation?.topLevelVerifier?.subAgentManager ?? null,
          verifierService:
            config.completionValidation?.topLevelVerifier?.verifierService ?? null,
          taskStore: config.completionValidation?.topLevelVerifier?.taskStore ?? null,
          remoteJobManager:
            config.completionValidation?.topLevelVerifier?.remoteJobManager ?? null,
          agentDefinitions:
            config.completionValidation?.topLevelVerifier?.agentDefinitions,
          availableToolNames:
            config.completionValidation?.topLevelVerifier?.availableToolNames,
          parentAllowedTools: config.allowedTools
            ? [...config.allowedTools]
            : undefined,
          continuationSessionId:
            ctx.runtimeVerifierContinuationSessionId ??
            ctx.runtimeContractSnapshot.verifierStages.taskId,
          logger: config.completionValidation?.topLevelVerifier?.logger,
          onTraceEvent:
            config.completionValidation?.topLevelVerifier?.onTraceEvent,
        });
        ctx.verifierSnapshot = validation.verifier;
        ctx.runtimeContractSnapshot = updateRuntimeContractVerifierVerdict({
          snapshot: ctx.runtimeContractSnapshot,
          verifier: validation.runtimeVerifier,
        });
        ctx.runtimeContractSnapshot = updateRuntimeContractVerifierStage({
          snapshot: ctx.runtimeContractSnapshot,
          verifierStages: {
            ...ctx.runtimeContractSnapshot.verifierStages,
            runtimeRequired: true,
            launcherKind:
              validation.launcherKind ??
              (ctx.runtimeContractSnapshot.verifierStages.launcherKind === "none"
                ? "subagent"
                : ctx.runtimeContractSnapshot.verifierStages.launcherKind),
            stageStatus:
              validation.outcome === "pass"
                ? "passed"
                : validation.outcome === "skipped"
                  ? "skipped"
                  : validation.runtimeVerifier.overall === "fail"
                    ? "failed"
                    : "retry",
            ...(validation.taskId ? { taskId: validation.taskId } : {}),
            ...(validation.verifierRequirement
              ? {
                  bootstrapSource: validation.verifierRequirement.bootstrapSource,
                  profiles: validation.verifierRequirement.profiles,
                  probeCategories: validation.verifierRequirement.probeCategories,
                }
              : {}),
          },
        });

        if (validation.outcome === "fail_closed") {
          completionValidationStatus = "fail_closed";
          callbacks.setStopReason(
            ctx,
            "validation_error",
            validation.exhaustedDetail ?? validation.summary,
          );
          if (ctx.response) {
            ctx.response = {
              ...ctx.response,
              content: "",
            };
          }
        } else if (validation.outcome === "retry_with_blocking_message") {
          const runtimeVerifierRecovery = await attemptCompletionRecovery({
            reason: "runtime_verifier",
            blockingMessage: validation.blockingMessage,
            evidence: { verifier: validation.runtimeVerifier },
            maxAttempts:
              ctx.requiredToolEvidence?.maxCorrectionAttemptsExplicit === true
                ? ctx.requiredToolEvidence.maxCorrectionAttempts
                : 1,
            budgetReason:
              "Max model recalls exceeded during runtime verifier recovery turn",
            exhaustedDetail:
              validation.exhaustedDetail ??
              `Runtime verifier ${validation.runtimeVerifier.overall}: ${validation.summary}`,
            continuationSummary,
          });
          completionValidationStatus = runtimeVerifierRecovery
            ? "recovery_requested"
            : "recovery_exhausted";
          callbacks.emitExecutionTrace(ctx, {
            type: "completion_validation_finished",
            phase: "tool_followup",
            callIndex: ctx.callIndex,
            payload: {
              status: completionValidationStatus,
              stopReason: ctx.stopReason,
              validationCode: ctx.validationCode,
              runtimeContract: ctx.runtimeContractSnapshot,
            },
          });
          if (runtimeVerifierRecovery) {
            continue;
          }
        }
      }
    }

    callbacks.emitExecutionTrace(ctx, {
      type: "completion_validation_finished",
      phase: "tool_followup",
      callIndex: ctx.callIndex,
      payload: {
        status: completionValidationStatus,
        stopReason: ctx.stopReason,
        validationCode: ctx.validationCode,
        runtimeContract: ctx.runtimeContractSnapshot,
      },
    });
    if (shouldContinueAfterStopGate) {
      continue;
    }
    const requestedBudgetContinuation = await attemptTokenBudgetContinuation({
      continuationSummary,
    });
    if (requestedBudgetContinuation) {
      continue;
    }
  }
  } while (shouldContinueAfterStopGate);

  if (hasPendingToolProtocol(ctx.toolProtocolState)) {
    emitToolProtocolViolation(
      ctx,
      callbacks,
      "finalization_with_unresolved_tool_calls",
      {
        pendingToolCallIds: getPendingToolProtocolCalls(ctx.toolProtocolState).map(
          (toolCall) => toolCall.id,
        ),
      },
    );
    sealPendingToolProtocol(ctx, callbacks, "finalization_guard");
    callbacks.setStopReason(
      ctx,
      "validation_error",
      "Runtime detected unresolved tool calls at finalization and closed the turn instead of surfacing a clean completion.",
    );
    if (ctx.response) {
      ctx.response = {
        ...ctx.response,
        content: "",
      };
    }
  }

  if (ctx.signal?.aborted) {
    callbacks.setStopReason(ctx, "cancelled", "Execution cancelled by caller");
  }

  ctx.finalContent = ctx.response?.content ?? "";
  const missingFinalToolFollowupAnswer =
    !ctx.finalContent &&
    ctx.allToolCalls.length > 0 &&
    ctx.stopReason === "completed";
  if (missingFinalToolFollowupAnswer) {
    callbacks.setStopReason(
      ctx,
      "no_progress",
      "Model returned empty content after tool follow-up; refusing to surface raw tool output as the final answer.",
    );
  }
  const shouldSummarizeToolFallback =
    !missingFinalToolFollowupAnswer &&
    !ctx.finalContent &&
    ctx.allToolCalls.length > 0 &&
    ctx.stopReason === "tool_calls" &&
    ctx.toolProtocolState.repairCount === 0;
  if (shouldSummarizeToolFallback) {
    ctx.finalContent =
      generateFallbackContent(ctx.allToolCalls) ?? ctx.finalContent;
  }
  if (!ctx.finalContent && ctx.stopReason !== "completed" && ctx.stopReasonDetail) {
    ctx.finalContent = ctx.stopReasonDetail;
  }

  return buildToolLoopTerminalResult(ctx);
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
    maybePushKeyedRuntimeInstruction: (ctx, params) =>
      maybePushKeyedRuntimeInstruction(ctx, params, maxRuntimeSystemHints),
    clearRuntimeInstructionKey,
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
