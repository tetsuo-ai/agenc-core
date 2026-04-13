import type {
  CompletionValidatorId,
} from "../runtime-contract/types.js";
import type {
  ChatCallUsageRecord,
  ExecutionContext,
} from "./chat-executor-types.js";
import {
  didToolCallFail,
  extractToolFailureText,
} from "./chat-executor-tool-utils.js";

const LOW_PROGRESS_TOKEN_DELTA = 500;
const MIN_DIMINISHING_RETURNS_CONTINUATIONS = 3;

const SUCCESSFUL_MUTATION_TOOL_NAMES = new Set([
  "system.applyPatch",
  "system.appendFile",
  "system.editFile",
  "system.mkdir",
  "system.move",
  "system.writeFile",
  "desktop.text_editor",
]);

export interface TurnContinuationActiveState {
  readonly reason: string;
  readonly validatorId?: CompletionValidatorId;
  readonly startedAt: number;
  readonly attempt: number;
  readonly tighterCap?: number;
  readonly baselineCallUsageIndex: number;
  readonly baselineToolCallIndex: number;
  readonly baselineDiagnosticFingerprint: string;
}

export interface TurnContinuationCycleSummary {
  readonly reason: string;
  readonly validatorId?: CompletionValidatorId;
  readonly attempt: number;
  readonly outputTokenDelta: number;
  readonly toolCallsIssued: boolean;
  readonly successfulWorkspaceMutation: boolean;
  readonly diagnosticFingerprintChanged: boolean;
  readonly materiallyIncreasedOutput: boolean;
  readonly productive: boolean;
  readonly lowProgressStall: boolean;
}

export interface TurnContinuationState {
  continuationCount: number;
  consecutiveLowProgressStalls: number;
  lastContinuationReason?: string;
  active?: TurnContinuationActiveState;
  readonly history: TurnContinuationCycleSummary[];
}

export function createTurnContinuationState(): TurnContinuationState {
  return {
    continuationCount: 0,
    consecutiveLowProgressStalls: 0,
    history: [],
  };
}

export function startTurnContinuation(params: {
  readonly state: TurnContinuationState;
  readonly ctx: ExecutionContext;
  readonly reason: string;
  readonly validatorId?: CompletionValidatorId;
  readonly tighterCap?: number;
}): TurnContinuationActiveState {
  const attempt = params.state.continuationCount + 1;
  const active: TurnContinuationActiveState = {
    reason: params.reason,
    validatorId: params.validatorId,
    startedAt: Date.now(),
    attempt,
    tighterCap: params.tighterCap,
    baselineCallUsageIndex: params.ctx.callUsage.length,
    baselineToolCallIndex: params.ctx.allToolCalls.length,
    baselineDiagnosticFingerprint: buildDiagnosticFingerprint(params.ctx),
  };
  params.state.continuationCount = attempt;
  params.state.lastContinuationReason = params.reason;
  params.state.active = active;
  return active;
}

export function finishTurnContinuation(params: {
  readonly state: TurnContinuationState;
  readonly ctx: ExecutionContext;
}): TurnContinuationCycleSummary | undefined {
  const active = params.state.active;
  if (!active) {
    return undefined;
  }
  const outputTokenDelta = countCompletionTokensSince(
    params.ctx.callUsage,
    active.baselineCallUsageIndex,
  );
  const continuationToolCalls = params.ctx.allToolCalls.slice(
    active.baselineToolCallIndex,
  );
  const toolCallsIssued = continuationToolCalls.length > 0;
  const successfulWorkspaceMutation = continuationToolCalls.some(
    (call) =>
      SUCCESSFUL_MUTATION_TOOL_NAMES.has(call.name) &&
      !didToolCallFail(call.isError, call.result),
  );
  const nextDiagnosticFingerprint = buildDiagnosticFingerprint(params.ctx);
  const diagnosticFingerprintChanged =
    nextDiagnosticFingerprint !== active.baselineDiagnosticFingerprint;
  const materiallyIncreasedOutput = outputTokenDelta >= LOW_PROGRESS_TOKEN_DELTA;
  const productive =
    toolCallsIssued ||
    successfulWorkspaceMutation ||
    diagnosticFingerprintChanged ||
    materiallyIncreasedOutput;
  const lowProgressStall =
    !toolCallsIssued &&
    !successfulWorkspaceMutation &&
    !diagnosticFingerprintChanged &&
    outputTokenDelta < LOW_PROGRESS_TOKEN_DELTA;
  const summary: TurnContinuationCycleSummary = {
    reason: active.reason,
    validatorId: active.validatorId,
    attempt: active.attempt,
    outputTokenDelta,
    toolCallsIssued,
    successfulWorkspaceMutation,
    diagnosticFingerprintChanged,
    materiallyIncreasedOutput,
    productive,
    lowProgressStall,
  };
  params.state.history.push(summary);
  params.state.consecutiveLowProgressStalls = lowProgressStall
    ? params.state.consecutiveLowProgressStalls + 1
    : 0;
  params.state.active = undefined;
  return summary;
}

export function shouldStopForDiminishingReturns(
  state: TurnContinuationState,
): boolean {
  return (
    state.continuationCount >= MIN_DIMINISHING_RETURNS_CONTINUATIONS &&
    state.consecutiveLowProgressStalls >= 2
  );
}

export function buildDiagnosticFingerprint(ctx: ExecutionContext): string {
  const failures = ctx.allToolCalls
    .filter((call) => didToolCallFail(call.isError, call.result))
    .slice(-12)
    .map((call) => {
      const text = extractToolFailureText(call)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
      return `${call.name}:${text}`;
    });
  return failures.join("\n");
}

function countCompletionTokensSince(
  callUsage: readonly ChatCallUsageRecord[],
  baselineIndex: number,
): number {
  let total = 0;
  for (const entry of callUsage.slice(baselineIndex)) {
    total += entry.usage.completionTokens;
  }
  return total;
}
