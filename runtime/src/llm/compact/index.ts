/**
 * Layered compaction (Cut 5.1).
 *
 * Replaces the legacy `prompt-budget.ts` ad-hoc compaction with an
 * ordered chain:
 *
 *     snip → microcompact → autocompact   (per-iteration)
 *     reactiveCompact                     (post-error 413 fallback)
 *
 * Each layer is a small pure function that takes `(messages, state)`
 * and returns `{ messages, state, boundary?, action }`. The chain is
 * driven from the chat-executor's iteration loop in the order above.
 *
 * The implementations here are intentionally minimal — they ship the
 * shape and the integration points so the rest of the runtime can
 * call them, with bigger heuristics moved into each layer over time.
 *
 * @module
 */

export {
  applySnip,
  createSnipState,
  type SnipState,
} from "./snip.js";
export {
  applyMicrocompact,
  createMicrocompactState,
  type MicrocompactState,
} from "./microcompact.js";
export {
  applyAutocompact,
  createAutoCompactTrackingState,
  type AutoCompactTrackingState,
} from "./autocompact.js";
export {
  applyReactiveCompact,
  createReactiveCompactState,
  type ReactiveCompactState,
} from "./reactive-compact.js";
export {
  collectPreservedAttachments,
  type PreservedAttachment,
} from "./attachments.js";
export {
  tokenCountWithEstimation,
  type TokenCountInput,
} from "./token-count.js";
export {
  ESCALATED_MAX_TOKENS,
  DEFAULT_AUTOCOMPACT_THRESHOLD_TOKENS,
  computeAutocompactThreshold,
  DEFAULT_SNIP_GAP_MS,
  DEFAULT_MICROCOMPACT_GAP_MS,
} from "./constants.js";

import type { LLMMessage, LLMUsage } from "../types.js";
import { applySnip, createSnipState, type SnipState } from "./snip.js";
import {
  applyMicrocompact,
  createMicrocompactState,
  type MicrocompactState,
} from "./microcompact.js";
import {
  applyAutocompact,
  createAutoCompactTrackingState,
  type AutoCompactTrackingState,
} from "./autocompact.js";
import {
  createReactiveCompactState,
  type ReactiveCompactState,
} from "./reactive-compact.js";
import {
  collectPreservedAttachments,
  type PreservedAttachment,
} from "./attachments.js";

/**
 * Per-iteration compaction state composed across all four layers.
 * The first three (snip, microcompact, autocompact) fire at the top
 * of every iteration; the fourth (reactiveCompact) fires only in
 * response to a `LLMContextWindowExceededError` from the provider
 * (Phase I).
 */
export interface PerIterationCompactionState {
  readonly snip: SnipState;
  readonly microcompact: MicrocompactState;
  readonly autocompact: AutoCompactTrackingState;
  readonly reactiveCompact: ReactiveCompactState;
}

export function createPerIterationCompactionState(): PerIterationCompactionState {
  return {
    snip: createSnipState(),
    microcompact: createMicrocompactState(),
    autocompact: createAutoCompactTrackingState(),
    reactiveCompact: createReactiveCompactState(),
  };
}

export interface PerIterationCompactionInput {
  readonly messages: readonly LLMMessage[];
  readonly state: PerIterationCompactionState;
  readonly nowMs: number;
  readonly autocompactThresholdTokens?: number;
  readonly lastResponseUsage?: LLMUsage;
  /**
   * Optional deterministic collapse projection that runs after
   * snip/microcompact but before autocompact. Mirrors the source loop's
   * cheaper context-collapse pass, which gets a chance to lower the view
   * before the expensive summarization fallback is considered.
   */
  readonly collapseHook?: (
    messages: readonly LLMMessage[],
  ) => {
    readonly action: "noop" | "collapsed";
    readonly messages: readonly LLMMessage[];
    readonly boundary?: LLMMessage;
  };
  /**
   * Phase N: optional memory-consolidation hook. When provided, the
   * orchestrator invokes the hook after the autocompact decision
   * layer. The hook receives the current message window and may
   * return a synthetic summary message; the orchestrator appends
   * it to the boundary list so the caller can splice it into the
   * live history. The hook is off by default — only callers that
   * explicitly wire `memory/consolidation.ts:consolidateEpisodicSlice`
   * get consolidation semantics. The feature is deliberately opt-in
   * because it changes the effective prompt shape and should only
   * activate on long conversations where the caller wants
   * semantic-noise pruning.
   */
  readonly consolidationHook?: (
    messages: readonly LLMMessage[],
  ) => { readonly action: "noop" | "consolidated"; readonly summaryMessage?: LLMMessage };
}

export interface PerIterationCompactionResult {
  readonly action: "noop" | "compacted";
  readonly messages: readonly LLMMessage[];
  readonly state: PerIterationCompactionState;
  readonly boundaries: readonly LLMMessage[];
  readonly preservedAttachments: readonly PreservedAttachment[];
}

/**
 * Orchestrator for the snip → microcompact → autocompact chain.
 * Runs at the top of each provider call:
 *
 *   1. `applySnip` — drops the oldest messages from a long-idle session
 *      without touching the ones the model still needs. Tracks how many
 *      tokens it freed so the downstream autocompact decision can skip
 *      a borderline trigger.
 *   2. `applyMicrocompact` — replaces cold tool-result bodies with a
 *      placeholder, keeping the assistant tool-call messages intact so
 *      the API still sees a well-formed sequence.
 *   3. `applyAutocompact` — decision-only layer. Observes the message
 *      token count post-snip/microcompact and flags the caller to run
 *      its full summarizer when the history still exceeds the
 *      threshold. The caller (chat-executor) owns the actual
 *      summarization model call; this layer just reports the
 *      decision.
 *
 * Each layer is pure and returns its next state. The orchestrator
 * threads state forward, accumulates any boundary messages the layers
 * produce (so callers can emit trace events / surface them to the
 * user), and reports a single combined `action` of `"noop"` or
 * `"compacted"`. Boundary messages are returned separately from the
 * pruned message list — the caller decides whether to inject them into
 * the outgoing conversation or just log them. Boundary messages are
 * observational, not model-facing.
 */
export function applyPerIterationCompaction(
  input: PerIterationCompactionInput,
): PerIterationCompactionResult {
  const nowMs = input.nowMs;
  const boundaries: LLMMessage[] = [];
  const preservedAttachments: PreservedAttachment[] = [];
  let currentMessages: readonly LLMMessage[] = input.messages;
  let snipState = input.state.snip;
  let microState = input.state.microcompact;
  let autoState = input.state.autocompact;
  let snipTokensFreed = 0;
  let anyAction = false;

  // --- Layer 1: snip ---
  const snipResult = applySnip({
    messages: currentMessages,
    state: snipState,
    nowMs,
  });
  snipState = snipResult.state;
  if (snipResult.action === "snipped") {
    anyAction = true;
    // Estimate tokens freed as a rough message-delta proxy. The
    // autocompact threshold check reads this value to short-circuit
    // a borderline trigger after a successful snip.
    const dropped = currentMessages.length - snipResult.messages.length;
    preservedAttachments.push(
      ...collectPreservedAttachments(currentMessages.slice(0, dropped)),
    );
    snipTokensFreed = Math.max(0, dropped) * APPROX_TOKENS_PER_SNIPPED_MESSAGE;
    currentMessages = snipResult.messages;
    if (snipResult.boundary) boundaries.push(snipResult.boundary);
  }

  // --- Layer 2: microcompact ---
  const microResult = applyMicrocompact({
    messages: currentMessages,
    state: microState,
    nowMs,
  });
  microState = microResult.state;
  if (microResult.action === "microcompacted") {
    anyAction = true;
    currentMessages = microResult.messages;
    if (microResult.boundary) boundaries.push(microResult.boundary);
  }

  // --- Layer 3: deterministic collapse projection ---
  if (input.collapseHook) {
    const collapseResult = input.collapseHook(currentMessages);
    if (collapseResult.action === "collapsed") {
      anyAction = true;
      currentMessages = collapseResult.messages;
      if (collapseResult.boundary) boundaries.push(collapseResult.boundary);
    }
  }

  // --- Layer 4: autocompact (decision only) ---
  const autoResult = applyAutocompact({
    messages: currentMessages,
    state: autoState,
    thresholdTokens: input.autocompactThresholdTokens,
    lastResponseUsage: input.lastResponseUsage,
    snipTokensFreed,
  });
  autoState = autoResult.state;
  if (autoResult.action === "autocompacted") {
    anyAction = true;
    // autocompact is decision-only: it does NOT mutate messages. The
    // caller observes the boundary and runs its summarizer.
    if (autoResult.boundary) boundaries.push(autoResult.boundary);
  }

  // --- Layer 5 (Phase N, optional): memory consolidation ---
  // Only fires when the caller has explicitly wired a consolidation
  // hook. Produces a synthetic summary message that joins the
  // boundary list — the caller decides whether to splice it into
  // the live history.
  if (input.consolidationHook) {
    const consolidationResult = input.consolidationHook(currentMessages);
    if (
      consolidationResult.action === "consolidated" &&
      consolidationResult.summaryMessage
    ) {
      anyAction = true;
      boundaries.push(consolidationResult.summaryMessage);
    }
  }

  return {
    action: anyAction ? "compacted" : "noop",
    messages: currentMessages,
    state: {
      snip: snipState,
      microcompact: microState,
      autocompact: autoState,
      // Reactive compaction state is threaded through separately
      // by chat-executor-tool-loop.ts on the 413 error path —
      // it is NOT advanced by the per-iteration chain itself.
      reactiveCompact: input.state.reactiveCompact,
    },
    boundaries,
    preservedAttachments,
  };
}

/**
 * Conservative token estimate per snipped message used by the
 * snip → autocompact handoff. 192 is a reasonable approximation for
 * an average assistant/user message in a tool-heavy conversation.
 * Overestimating is safer than underestimating — if snip frees more
 * tokens than we claim, autocompact might trigger unnecessarily; if
 * we overstate, we may skip a legitimate autocompact. The real
 * threshold check uses `tokenCountWithEstimation` on the resulting
 * message set, so this number only affects borderline cases.
 */
const APPROX_TOKENS_PER_SNIPPED_MESSAGE = 192;
