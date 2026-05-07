/**
 * Context-size budgeting for prompt assembly and turn continuation.
 *
 * Source provenance lives in `runtime/src/conversation/PARITY.md` and
 * `parity/PR-05-parity.json`; this runtime module stays AgenC-branded.
 *
 * @module
 */

const COMPLETION_THRESHOLD = 0.9;
const DIMINISHING_THRESHOLD = 500;
export const DEFAULT_TOKEN_BUDGET_CHECK_INTERVAL = 1_000;

// Shorthand (+500k) anchored to start/end to avoid false positives in natural
// language. Verbose (use/spend 2M tokens) matches anywhere.
const SHORTHAND_START_RE = /^\s*\+(\d+(?:\.\d+)?)\s*(k|m|b)\b/i;
const SHORTHAND_END_RE = /\s\+(\d+(?:\.\d+)?)\s*(k|m|b)\s*[.!?]?\s*$/i;
const VERBOSE_RE = /\b(?:use|spend)\s+(\d+(?:\.\d+)?)\s*(k|m|b)\s*tokens?\b/i;
const VERBOSE_RE_G = new RegExp(VERBOSE_RE.source, "gi");

const MULTIPLIERS: Readonly<Record<string, number>> = {
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
};

function parseBudgetMatch(value: string, suffix: string): number {
  return Number.parseFloat(value) * MULTIPLIERS[suffix.toLowerCase()]!;
}

export function parseTokenBudget(text: string): number | null {
  const startMatch = text.match(SHORTHAND_START_RE);
  if (startMatch) return parseBudgetMatch(startMatch[1]!, startMatch[2]!);
  const endMatch = text.match(SHORTHAND_END_RE);
  if (endMatch) return parseBudgetMatch(endMatch[1]!, endMatch[2]!);
  const verboseMatch = text.match(VERBOSE_RE);
  if (verboseMatch) return parseBudgetMatch(verboseMatch[1]!, verboseMatch[2]!);
  return null;
}

export function findTokenBudgetPositions(
  text: string,
): Array<{ start: number; end: number }> {
  const positions: Array<{ start: number; end: number }> = [];
  const startMatch = text.match(SHORTHAND_START_RE);
  if (startMatch) {
    const offset =
      startMatch.index! +
      startMatch[0].length -
      startMatch[0].trimStart().length;
    positions.push({
      start: offset,
      end: startMatch.index! + startMatch[0].length,
    });
  }

  const endMatch = text.match(SHORTHAND_END_RE);
  if (endMatch) {
    const endStart = endMatch.index! + 1;
    const alreadyCovered = positions.some(
      (p) => endStart >= p.start && endStart < p.end,
    );
    if (!alreadyCovered) {
      positions.push({
        start: endStart,
        end: endMatch.index! + endMatch[0].length,
      });
    }
  }

  for (const match of text.matchAll(VERBOSE_RE_G)) {
    positions.push({ start: match.index, end: match.index + match[0].length });
  }
  return positions;
}

export function getBudgetContinuationMessage(
  pct: number,
  turnTokens: number,
  budget: number,
): string {
  const fmt = (n: number): string => new Intl.NumberFormat("en-US").format(n);
  return `Stopped at ${pct}% of token target (${fmt(turnTokens)} / ${fmt(
    budget,
  )}). Keep working — do not summarize.`;
}

export function getTokenBudgetPromptSection(): string {
  return [
    'When the user specifies a token target (e.g., "+500k", "spend 2M tokens", "use 1B tokens"), your output token count will be shown each turn.',
    "Keep working until you approach the target — plan your work to fill it productively.",
    "The target is a hard minimum, not a suggestion.",
    "If you stop early, the system will automatically continue you.",
  ].join(" ");
}

export type TokenBudgetDecision =
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
      readonly completionEvent: {
        readonly continuationCount: number;
        readonly pct: number;
        readonly turnTokens: number;
        readonly budget: number;
        readonly diminishingReturns: boolean;
        readonly durationMs: number;
      } | null;
    };

export interface MidStreamBudgetSample {
  readonly thresholdReached: boolean;
  readonly estimatedTurnTokens: number;
  readonly budget: number | null;
}

export class BudgetTracker {
  private readonly totalBudget: number | null;
  private readonly checkInterval: number;
  private confirmedOutputTokens = 0;
  private estimatedInFlightTokens = 0;
  private lastCheckedEstimatedTurnTokens = 0;
  continuationCount = 0;
  lastDeltaTokens = 0;
  lastGlobalTurnTokens = 0;
  startedAt = Date.now();

  constructor(totalBudget: number | null = null, checkInterval?: number) {
    this.totalBudget = totalBudget;
    this.checkInterval = checkInterval ?? resolveTokenBudgetCheckInterval();
  }

  get emitted(): number {
    return this.confirmedOutputTokens + this.estimatedInFlightTokens;
  }

  get remaining(): number | null {
    if (this.totalBudget === null) return null;
    return Math.max(0, this.totalBudget - this.emitted);
  }

  get budget(): number | null {
    return this.totalBudget;
  }

  get confirmedTokens(): number {
    return this.confirmedOutputTokens;
  }

  addEmitted(
    n: number,
    source: "confirmed" | "estimate" = "confirmed",
  ): void {
    if (!Number.isFinite(n) || n <= 0) return;
    if (source === "estimate") {
      this.estimatedInFlightTokens += n;
      return;
    }
    this.confirmedOutputTokens += n;
    this.estimatedInFlightTokens = 0;
    this.lastCheckedEstimatedTurnTokens = this.confirmedOutputTokens;
  }

  sampleMidStream(): MidStreamBudgetSample {
    const estimatedTurnTokens =
      this.confirmedOutputTokens + this.estimatedInFlightTokens;
    const elapsedSinceLastCheck =
      estimatedTurnTokens - this.lastCheckedEstimatedTurnTokens;
    if (elapsedSinceLastCheck < this.checkInterval) {
      return {
        thresholdReached: false,
        estimatedTurnTokens,
        budget: this.totalBudget,
      };
    }
    this.lastCheckedEstimatedTurnTokens = estimatedTurnTokens;
    return {
      thresholdReached:
        this.totalBudget !== null &&
        estimatedTurnTokens >= this.totalBudget * COMPLETION_THRESHOLD,
      estimatedTurnTokens,
      budget: this.totalBudget,
    };
  }

  resolveBoundaryTokens(currentIterationOutputTokens: number): number {
    const bounded =
      Number.isFinite(currentIterationOutputTokens) &&
      currentIterationOutputTokens > 0
        ? currentIterationOutputTokens
        : 0;
    this.estimatedInFlightTokens = 0;
    this.lastCheckedEstimatedTurnTokens = this.confirmedOutputTokens;
    return this.confirmedOutputTokens + bounded;
  }

  checkBoundary(globalTurnTokens: number): TokenBudgetDecision {
    return checkTrackerBudget(
      this,
      undefined,
      this.totalBudget,
      globalTurnTokens,
    );
  }

  resetSamplingGate(): void {
    this.estimatedInFlightTokens = 0;
    this.lastCheckedEstimatedTurnTokens = this.confirmedOutputTokens;
  }

  resetForTurn(): void {
    this.confirmedOutputTokens = 0;
    this.estimatedInFlightTokens = 0;
    this.lastCheckedEstimatedTurnTokens = 0;
    this.continuationCount = 0;
    this.lastDeltaTokens = 0;
    this.lastGlobalTurnTokens = 0;
    this.startedAt = Date.now();
  }
}

export function resolveTokenBudgetCheckInterval(): number {
  const raw = process.env.AGENC_TOKEN_BUDGET_CHECK_INTERVAL;
  if (!raw) return DEFAULT_TOKEN_BUDGET_CHECK_INTERVAL;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TOKEN_BUDGET_CHECK_INTERVAL;
  return n;
}

export function createBudgetTracker(): BudgetTracker;
export function createBudgetTracker(
  totalBudget: number | null,
): BudgetTracker | null;
export function createBudgetTracker(
  totalBudget?: number | null,
): BudgetTracker | null {
  if (totalBudget === undefined) return new BudgetTracker(null);
  if (totalBudget === null) return null;
  if (!Number.isFinite(totalBudget) || totalBudget <= 0) return null;
  return new BudgetTracker(totalBudget);
}

function checkTrackerBudget(
  tracker: BudgetTracker,
  agentId: string | undefined,
  budget: number | null,
  globalTurnTokens: number,
): TokenBudgetDecision {
  if (agentId || budget === null || budget <= 0) {
    return { action: "stop", completionEvent: null };
  }

  const turnTokens = Math.max(0, globalTurnTokens);
  const pct = Math.round((turnTokens / budget) * 100);
  const deltaSinceLastCheck = turnTokens - tracker.lastGlobalTurnTokens;

  const isDiminishing =
    tracker.continuationCount >= 3 &&
    deltaSinceLastCheck < DIMINISHING_THRESHOLD &&
    tracker.lastDeltaTokens < DIMINISHING_THRESHOLD;

  if (!isDiminishing && turnTokens < budget * COMPLETION_THRESHOLD) {
    tracker.continuationCount += 1;
    tracker.lastDeltaTokens = deltaSinceLastCheck;
    tracker.lastGlobalTurnTokens = turnTokens;
    return {
      action: "continue",
      nudgeMessage: getBudgetContinuationMessage(pct, turnTokens, budget),
      continuationCount: tracker.continuationCount,
      pct,
      turnTokens,
      budget,
    };
  }

  if (isDiminishing || tracker.continuationCount > 0) {
    return {
      action: "stop",
      completionEvent: {
        continuationCount: tracker.continuationCount,
        pct,
        turnTokens,
        budget,
        diminishingReturns: isDiminishing,
        durationMs: Date.now() - tracker.startedAt,
      },
    };
  }

  return { action: "stop", completionEvent: null };
}

export function checkTokenBudget(
  tracker: BudgetTracker,
  agentId: string | undefined,
  budget: number | null,
  globalTurnTokens: number,
): TokenBudgetDecision {
  return checkTrackerBudget(tracker, agentId, budget, globalTurnTokens);
}
