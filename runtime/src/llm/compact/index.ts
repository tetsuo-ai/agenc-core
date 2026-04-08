/**
 * Layered compaction (Cut 5.1, claude_code-alignment).
 *
 * Replaces the legacy `prompt-budget.ts` ad-hoc compaction with a
 * `claude_code/services/compact/`-style ordered chain:
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
  tokenCountWithEstimation,
  type TokenCountInput,
} from "./token-count.js";
export {
  ESCALATED_MAX_TOKENS,
  DEFAULT_AUTOCOMPACT_THRESHOLD_TOKENS,
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

/**
 * Per-iteration compaction state composed across all three layers. This
 * is the state object the chat-executor loop threads between iterations.
 */
export interface PerIterationCompactionState {
  readonly snip: SnipState;
  readonly microcompact: MicrocompactState;
  readonly autocompact: AutoCompactTrackingState;
}

export function createPerIterationCompactionState(): PerIterationCompactionState {
  return {
    snip: createSnipState(),
    microcompact: createMicrocompactState(),
    autocompact: createAutoCompactTrackingState(),
  };
}

export interface PerIterationCompactionInput {
  readonly messages: readonly LLMMessage[];
  readonly state: PerIterationCompactionState;
  readonly nowMs: number;
  readonly autocompactThresholdTokens?: number;
  readonly lastResponseUsage?: LLMUsage;
}

export interface PerIterationCompactionResult {
  readonly action: "noop" | "compacted";
  readonly messages: readonly LLMMessage[];
  readonly state: PerIterationCompactionState;
  readonly boundaries: readonly LLMMessage[];
}

/**
 * Orchestrator for the snip → microcompact → autocompact chain. Mirrors
 * `claude_code/query.ts` per-iteration compaction wire-up.
 *
 * **U0 stub**: returns noop on every call so the export shape exists and
 * callers can land their wiring PRs. U1 replaces this body with the real
 * chain that invokes each layer in order, threads state forward, and
 * accumulates boundary messages. Do NOT wire the real behavior here
 * without the accompanying chat-executor-tool-loop changes from U1 —
 * the two have to land together or the loop sees mid-iteration state
 * drift.
 */
export function applyPerIterationCompaction(
  input: PerIterationCompactionInput,
): PerIterationCompactionResult {
  // Layer calls are deliberately unused in U0. The references keep the
  // import graph honest for the U1 wire-up PR and prevent noUnusedLocals
  // from tripping when U0 lands alone.
  void applySnip;
  void applyMicrocompact;
  void applyAutocompact;
  return {
    action: "noop",
    messages: input.messages,
    state: input.state,
    boundaries: [],
  };
}
