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
const CONTINUATION_COMPLETION_THRESHOLD = 0.9;

const SUCCESSFUL_MUTATION_TOOL_NAMES = new Set([
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

export interface TurnContinuationBudgetState {
  continuationCount: number;
  lastDeltaTokens: number;
  lastGlobalOutputTokens: number;
  readonly startedAt: number;
}

export interface TurnContinuationBudgetCompletionEvent {
  readonly continuationCount: number;
  readonly pct: number;
  readonly turnTokens: number;
  readonly budget: number;
  readonly diminishingReturns: boolean;
  readonly durationMs: number;
}

export type TurnContinuationBudgetDecision =
  | {
      readonly action: "continue";
      readonly nudgeMessage: string;
      readonly continuationCount: number;
      readonly pct: number;
      readonly turnTokens: number;
      readonly budget: number;
    }
  | {
      readonly action: "stop";
      readonly completionEvent: TurnContinuationBudgetCompletionEvent | null;
    };

export interface TurnContinuationState {
  /**
   * Recovery continuation attempts only. Token-budget continuation keeps its own
   * separate tracker so low-budget nudges do not poison validator recovery caps.
   */
  continuationCount: number;
  /**
   * Recovery continuation low-progress streak only. Token-budget continuation
   * uses its own diminishing-returns tracker.
   */
  consecutiveLowProgressStalls: number;
  lastContinuationReason?: string;
  active?: TurnContinuationActiveState;
  readonly history: TurnContinuationCycleSummary[];
  readonly budget: TurnContinuationBudgetState;
}

export function createTurnContinuationState(): TurnContinuationState {
  return {
    continuationCount: 0,
    consecutiveLowProgressStalls: 0,
    history: [],
    budget: createTurnContinuationBudgetState(),
  };
}

export function createTurnContinuationBudgetState(): TurnContinuationBudgetState {
  return {
    continuationCount: 0,
    lastDeltaTokens: 0,
    lastGlobalOutputTokens: 0,
    startedAt: Date.now(),
  };
}

export function startTurnContinuation(params: {
  readonly state: TurnContinuationState;
  readonly ctx: ExecutionContext;
  readonly reason: string;
  readonly validatorId?: CompletionValidatorId;
  readonly tighterCap?: number;
}): TurnContinuationActiveState {
  const attempt =
    params.reason === "token_budget"
      ? params.state.budget.continuationCount
      : params.state.continuationCount + 1;
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
  if (params.reason !== "token_budget") {
    params.state.continuationCount = attempt;
  }
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
  if (active.reason !== "token_budget") {
    params.state.consecutiveLowProgressStalls = lowProgressStall
      ? params.state.consecutiveLowProgressStalls + 1
      : 0;
  }
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

export function countTurnCompletionTokens(
  callUsage: readonly ChatCallUsageRecord[],
): number {
  return countCompletionTokensSince(callUsage, 0);
}

export function checkTurnContinuationBudget(params: {
  readonly state: TurnContinuationState;
  readonly budget: number | null;
  readonly globalTurnTokens: number;
  readonly eligible: boolean;
}): TurnContinuationBudgetDecision {
  if (!params.eligible || params.budget === null || params.budget <= 0) {
    return { action: "stop", completionEvent: null };
  }

  const tracker = params.state.budget;
  const turnTokens = params.globalTurnTokens;
  const pct = Math.round((turnTokens / params.budget) * 100);
  const deltaSinceLastCheck =
    params.globalTurnTokens - tracker.lastGlobalOutputTokens;
  const isDiminishing =
    tracker.continuationCount >= MIN_DIMINISHING_RETURNS_CONTINUATIONS &&
    deltaSinceLastCheck < LOW_PROGRESS_TOKEN_DELTA &&
    tracker.lastDeltaTokens < LOW_PROGRESS_TOKEN_DELTA;

  if (!isDiminishing && turnTokens < params.budget * CONTINUATION_COMPLETION_THRESHOLD) {
    tracker.continuationCount += 1;
    tracker.lastDeltaTokens = deltaSinceLastCheck;
    tracker.lastGlobalOutputTokens = params.globalTurnTokens;
    return {
      action: "continue",
      nudgeMessage: buildTurnContinuationBudgetMessage(
        pct,
        turnTokens,
        params.budget,
      ),
      continuationCount: tracker.continuationCount,
      pct,
      turnTokens,
      budget: params.budget,
    };
  }

  if (isDiminishing || tracker.continuationCount > 0) {
    return {
      action: "stop",
      completionEvent: {
        continuationCount: tracker.continuationCount,
        pct,
        turnTokens,
        budget: params.budget,
        diminishingReturns: isDiminishing,
        durationMs: Date.now() - tracker.startedAt,
      },
    };
  }

  return { action: "stop", completionEvent: null };
}

export function buildTurnContinuationBudgetMessage(
  pct: number,
  turnTokens: number,
  budget: number,
): string {
  const format = (value: number): string =>
    new Intl.NumberFormat("en-US").format(value);
  return `Stopped at ${pct}% of token target (${format(turnTokens)} / ${format(
    budget,
  )}). Keep working - do not summarize.`;
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
