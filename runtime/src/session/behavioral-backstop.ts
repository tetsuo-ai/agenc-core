/**
 * Behavioral backstop for semantic non-termination (goal item #3).
 *
 * A two-tier, result-aware, NON-BLOCKING watchdog over the agentic turn
 * loop. It is the *second* whole-turn backstop, distinct from the
 * #1318–#1321 per-tool dispatch drain (which catches a tool whose
 * dispatch wedges). This one catches a *semantic runaway*: every tool
 * call settles cleanly, every dispatch returns, but the loop spins
 * making no real progress (the local model was observed thrashing
 * ~65k tokens/turn). It finalizes the turn cleanly with an honest typed
 * terminal (`no_progress`) and never false-positives on legitimate
 * repetition (status polling, progressing retries).
 *
 * The whole module is PURE synchronous — no `await`, no timers, no I/O.
 * The detector logic is therefore unit-testable in isolation and, when
 * called from the turn loop, structurally cannot stall the loop it
 * polices (see §2.5 of the design doc).
 *
 * Tiers:
 *   - Tier 0 — absolute per-turn deadline (steps / tokens / wall-clock).
 *     The guarantee. Depends on nothing the model says. Ships OFF by
 *     default (all three caps default 0 = disabled); ops opt them in.
 *   - Tier 1 — cheap, always-on, result-aware per-step detectors
 *     (repetition ladder, ABAB/period cycle, low-gain streak). Every
 *     repetition/cycle/low-gain trip requires an UNCHANGED resultHash —
 *     this single invariant is the entire false-positive defense, so the
 *     tier is on by default because it structurally cannot fire on
 *     genuine progress.
 *   - Tier 2 — optional non-blocking observer (warn/log only). Off by
 *     default; wired at the un-awaited `launch*PostSampling` seam,
 *     polled never awaited.
 *
 * @module
 */

import { canonicalJsonKey } from "../permissions/approval-cache.js";
import type { LLMUsage } from "../llm/types.js";
import type {
  AssistantMessage,
  CompletedToolResultRecord,
  ToolUseBlock,
  TurnState,
} from "./turn-state.js";

export interface StepRecord {
  /** Normalized action signature (structure, not tokens). */
  readonly sig: string;
  /** Normalized result hash (content + isError). */
  readonly resultHash: string;
  /** `state.turnCount` when recorded. */
  readonly iteration: number;
  /** Produced no novelty this step. */
  readonly lowGain: boolean;
}

export type ProgressTripKind = "repetition" | "abab" | "low_gain" | "deadline";

export interface ProgressTrip {
  readonly kind: ProgressTripKind;
  /** Human + observability diagnostic (sig, run length, which cap). */
  readonly detail: string;
  /** Honest, model+user-visible explanation pushed to the transcript. */
  readonly userMessage: string;
}

export type ProgressDecision =
  | { readonly kind: "none" }
  | {
      readonly kind: "warn";
      readonly detail: string;
      readonly nudgeText?: string;
      readonly injectNudge: boolean;
    }
  | { readonly kind: "terminate"; readonly trip: ProgressTrip };

export interface BehavioralConfig {
  /** Master switch. */
  readonly enabled: boolean;
  /** Wink >=3 warn threshold. */
  readonly repeatSoft: number;
  /** Hard-terminate run length. */
  readonly repeatHard: number;
  /** Full stable cycles to trip the ABAB/period detector. */
  readonly ababCycles: number;
  /** Gated low-gain streak to trip. */
  readonly lowGainStreak: number;
  /** Ring-buffer length. */
  readonly window: number;
  /** 0 = disabled (off-by-default). */
  readonly maxTurnMs: number;
  /** 0 = disabled (off-by-default). */
  readonly maxTurnTokens: number;
  /** 0 = disabled (off-by-default); tighter than max_turns. */
  readonly maxTurnSteps: number;
  /** Tier-2 fire-and-forget observer (off by default). */
  readonly observerEnabled: boolean;
  /** Wink k=5 observer cadence. */
  readonly observerEveryK: number;
  /** Tools excluded from the repetition window. */
  readonly ignoreTools: ReadonlySet<string>;
  /** Bounded-prefix hashing of huge tool outputs (P1 graft). */
  readonly resultHashPrefixBytes: number;
  /** Strip timestamps/UUIDs/hex before hashing (off by default — new FP surface). */
  readonly normalizeVolatile: boolean;
}

const SEP = " ";
const JOIN = "";

/** Stable non-crypto string hash (djb2). */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // matches parseToolUseBlocks fallback
  }
}

/** Conservative, OPT-IN volatile stripping (default OFF — see §6 risk). */
function normalizeVolatile(s: string, enabled: boolean): string {
  if (!enabled) return s;
  return s
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, "<ts>") // ISO timestamps
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      "<uuid>",
    ) // UUIDs
    .replace(/\b0x[0-9a-f]{6,}\b/gi, "<hex>"); // long hex
}

/**
 * Normalized action signature for the whole step (a multi-tool step is
 * ONE action). `canonicalJsonKey` sorts object keys (so semantically
 * identical args collide) but the step join preserves call order (so a
 * reordered set of the same N calls yields a *different* sig — a safe
 * under-detection, never a false positive).
 */
export function stepActionSignature(
  lastAssistant: AssistantMessage,
  toolUseBlocks: readonly ToolUseBlock[],
): string {
  if (lastAssistant.toolCalls.length === 0) {
    return `text${SEP}${(lastAssistant.text ?? "").trim().replace(/\s+/g, " ")}`;
  }
  return lastAssistant.toolCalls
    .map((call, i) => {
      // Prefer the already-parsed block input; fall back to parsing raw
      // arguments; fall back to the raw string on parse failure.
      const parsed = toolUseBlocks[i]?.input ?? safeParse(call.arguments);
      return `${call.name}${SEP}${canonicalJsonKey(parsed)}`;
    })
    .join(JOIN);
}

/**
 * Normalized result hash (content + isError), bounded-prefix to keep
 * recording O(window)-ish even on huge tool outputs.
 */
export function stepResultHash(
  lastAssistant: AssistantMessage,
  completedByCallId: ReadonlyMap<string, CompletedToolResultRecord>,
  cfg: BehavioralConfig,
): string {
  if (lastAssistant.toolCalls.length === 0) return "text";
  return lastAssistant.toolCalls
    .map((call) => {
      const rec = completedByCallId.get(call.id);
      const raw = (rec?.content ?? "").slice(0, cfg.resultHashPrefixBytes);
      const content = normalizeVolatile(raw, cfg.normalizeVolatile);
      return `${rec?.isError ? "E" : "ok"}${SEP}${djb2(content)}`;
    })
    .join(JOIN);
}

export function resolveBehavioralConfig(ctx: {
  readonly config?: Record<string, unknown>;
}): BehavioralConfig {
  // precedence (mirrors resolveMaxTurns): ctx.config.* > env > default
  const num = (cfgKey: string, env: string, def: number): number => {
    const c = ctx.config?.[cfgKey];
    if (typeof c === "number" && Number.isFinite(c)) return c;
    const e = process.env[env];
    if (e !== undefined && e !== "") {
      const n = Number(e);
      if (Number.isFinite(n)) return n;
    }
    return def;
  };
  const bool = (cfgKey: string, env: string, def: boolean): boolean => {
    const c = ctx.config?.[cfgKey];
    if (typeof c === "boolean") return c;
    const e = process.env[env];
    if (e !== undefined)
      return !["0", "false", "no", "off"].includes(e.trim().toLowerCase());
    return def;
  };
  const tools = (process.env.AGENC_NOPROGRESS_IGNORE_TOOLS ?? "Sleep")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return {
    enabled: bool("behavioralBackstop", "AGENC_BEHAVIORAL_BACKSTOP", true),
    repeatSoft: num("progressRepeatSoft", "AGENC_NOPROGRESS_WARN", 3),
    repeatHard: num("progressRepeatHard", "AGENC_NOPROGRESS_TERMINATE", 8),
    ababCycles: num("progressAbabCycles", "AGENC_ABAB_TERMINATE", 3),
    lowGainStreak: num("progressLowGainStreak", "AGENC_LOWGAIN_TERMINATE", 6),
    window: num("progressWindow", "AGENC_PROGRESS_WINDOW", 16),
    maxTurnMs: num("progressMaxTurnMs", "AGENC_TURN_DEADLINE_MS", 0), // OFF by default
    maxTurnTokens: num("progressMaxTurnTokens", "AGENC_TURN_TOKEN_CAP", 0), // OFF by default
    maxTurnSteps: num("progressMaxTurnSteps", "AGENC_TURN_STEP_CAP", 0), // OFF by default
    observerEnabled: bool("progressObserver", "AGENC_BEHAVIORAL_OBSERVER", false),
    observerEveryK: num("progressObserverEvery", "AGENC_BEHAVIORAL_OBSERVER_K", 5),
    ignoreTools: new Set(tools),
    resultHashPrefixBytes: num(
      "progressResultPrefix",
      "AGENC_PROGRESS_RESULT_PREFIX",
      64 * 1024,
    ),
    normalizeVolatile: bool(
      "progressNormalizeVolatile",
      "AGENC_PROGRESS_NORMALIZE_VOLATILE",
      false,
    ), // OFF
  };
}

/**
 * Record one real model-action step. Synchronous; mutates TurnState
 * fields. No await, no timer, no lock, no I/O.
 */
export function recordBehavioralStep(
  state: TurnState,
  lastAssistant: AssistantMessage,
  completedByCallId: ReadonlyMap<string, CompletedToolResultRecord>,
  cfg: BehavioralConfig,
): void {
  if (!cfg.enabled) return;
  // Exclude designated poll/sleep tools: if EVERY call in the step is an
  // ignored tool, skip recording (a deliberate poll-sleep cadence is
  // legitimate by design).
  const calls = lastAssistant.toolCalls;
  const allIgnored =
    calls.length > 0 && calls.every((c) => cfg.ignoreTools.has(c.name));
  if (allIgnored) return;

  const sig = stepActionSignature(lastAssistant, state.toolUseBlocks);
  const resultHash = stepResultHash(lastAssistant, completedByCallId, cfg);

  // Novelty: a new tool name OR a new (sig,resultHash) pair for this step.
  const seenSigResult = state.behavioralStepHistory.some(
    (r) => r.sig === sig && r.resultHash === resultHash,
  );
  const newToolName = calls.some(
    (c) => !state.behavioralSeenToolNames.has(c.name),
  );
  const lowGain = !newToolName && seenSigResult;
  for (const c of calls) state.behavioralSeenToolNames.add(c.name);

  state.behavioralStepHistory.push({
    sig,
    resultHash,
    iteration: state.turnCount,
    lowGain,
  });
  if (state.behavioralStepHistory.length > cfg.window) {
    state.behavioralStepHistory.shift();
  }

  // low-gain streak
  state.behavioralLowGainStreak = lowGain
    ? state.behavioralLowGainStreak + 1
    : 0;
}

/**
 * Evaluate trip conditions. Synchronous read of already-collected state
 * + integer comparisons + a bounded ring scan. Never awaits the model
 * or a tool, so it structurally cannot stall the loop it polices.
 */
export function evaluateBehavioralBackstop(
  state: TurnState,
  usage: LLMUsage,
  turnStartedAt: number,
  cfg: BehavioralConfig,
): ProgressDecision {
  if (!cfg.enabled) return { kind: "none" };
  const hist = state.behavioralStepHistory;

  // ── Tier 0: absolute deadline (depends on nothing the model says) ──
  if (cfg.maxTurnSteps > 0 && state.turnCount > cfg.maxTurnSteps) {
    return terminate("deadline", `step cap ${cfg.maxTurnSteps} exceeded`, state.turnCount);
  }
  if (cfg.maxTurnTokens > 0 && (usage.totalTokens ?? 0) > cfg.maxTurnTokens) {
    return terminate(
      "deadline",
      `token cap ${cfg.maxTurnTokens} exceeded (used ${usage.totalTokens})`,
      state.turnCount,
    );
  }
  if (cfg.maxTurnMs > 0 && Date.now() - turnStartedAt > cfg.maxTurnMs) {
    return terminate("deadline", `wall-clock cap ${cfg.maxTurnMs}ms exceeded`, state.turnCount);
  }

  // ── Tier 1: result-aware semantic detectors ──
  // 1. No-progress repetition: longest run of identical (sig,resultHash)
  //    ending at the latest record.
  const run = trailingIdenticalRun(hist);
  if (run >= cfg.repeatHard) {
    return terminate(
      "repetition",
      `identical (sig,resultHash) repeated ${run}x with no new information`,
      run,
    );
  }

  // 2. ABAB / small-period cycle (period p in 2..4), every sig's
  //    resultHash stable across cycles.
  const abab = detectStableCycle(hist, cfg.ababCycles);
  if (abab) {
    return terminate(
      "abab",
      `stable period-${abab.period} cycle repeated ${abab.cycles}x with no new information`,
      abab.cycles,
    );
  }

  // 3. Low-information-gain streak, gated by at least one repeated
  //    signature in the window.
  if (
    state.behavioralLowGainStreak >= cfg.lowGainStreak &&
    hasRepeatedSignature(hist)
  ) {
    return terminate(
      "low_gain",
      `low-information-gain streak ${state.behavioralLowGainStreak} with repeated signatures`,
      state.behavioralLowGainStreak,
    );
  }

  // Soft-nudge tier (Wink >=3): warn, do not finalize.
  if (
    run >= cfg.repeatSoft &&
    run < cfg.repeatHard &&
    !state.behavioralNudgeIssued
  ) {
    return {
      kind: "warn",
      detail: `identical action repeated ${run}x with no new result`,
      injectNudge: true,
      nudgeText:
        "You have repeated the same action with the same result " +
        `${run} times with no new information. Change your approach or stop; ` +
        "repeating it again will not make progress.",
    };
  }

  return { kind: "none" };
}

function terminate(
  kind: ProgressTripKind,
  why: string,
  count: number,
): ProgressDecision {
  const userMessage =
    kind === "deadline"
      ? `Turn stopped by the no-progress backstop: ${why}. The turn was halted, not completed.`
      : `Turn stopped by the no-progress backstop: ${why} (count=${count}). ` +
        "No further progress was being made. No task was completed.";
  return {
    kind: "terminate",
    trip: { kind, detail: `${kind}: ${why} (count=${count})`, userMessage },
  };
}

function trailingIdenticalRun(hist: readonly StepRecord[]): number {
  if (hist.length === 0) return 0;
  const last = hist[hist.length - 1];
  if (last === undefined) return 0;
  let run = 1;
  for (let i = hist.length - 2; i >= 0; i--) {
    const rec = hist[i];
    if (rec !== undefined && rec.sig === last.sig && rec.resultHash === last.resultHash) {
      run++;
    } else break;
  }
  return run;
}

function hasRepeatedSignature(hist: readonly StepRecord[]): boolean {
  const seen = new Set<string>();
  for (const r of hist) {
    if (seen.has(r.sig)) return true;
    seen.add(r.sig);
  }
  return false;
}

/**
 * Detect a stable period-p cycle (p in 2..4) repeated >= minCycles full
 * cycles at the tail, where every position's resultHash is unchanged
 * across cycles (the result-aware guard). Requires the period to
 * actually alternate (>= 2 distinct sigs) so a period-1 run cannot
 * masquerade as a cycle.
 */
function detectStableCycle(
  hist: readonly StepRecord[],
  minCycles: number,
): { period: number; cycles: number } | undefined {
  for (let p = 2; p <= 4; p++) {
    if (hist.length < p * minCycles) continue;
    let cycles = 1;
    // compare tail blocks of length p
    for (let c = 1; c < Math.floor(hist.length / p); c++) {
      let blockMatch = true;
      for (let j = 0; j < p; j++) {
        const a = hist[hist.length - 1 - j];
        const b = hist[hist.length - 1 - j - p * c];
        if (
          a === undefined ||
          b === undefined ||
          a.sig !== b.sig ||
          a.resultHash !== b.resultHash
        ) {
          blockMatch = false;
          break;
        }
      }
      if (blockMatch) cycles++;
      else break;
    }
    // require the period to actually alternate (not period-1 masquerading)
    const distinct = new Set(
      hist.slice(hist.length - p).map((r) => r.sig),
    ).size;
    if (cycles >= minCycles && distinct >= 2) return { period: p, cycles };
  }
  return undefined;
}
