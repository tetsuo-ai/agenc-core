/**
 * Incremental-request bookkeeping for the Grok compatible
 * Responses API) adapter.
 *
 * Checks whether the current request is an incremental extension of
 * the previous request. We only reuse an incremental input delta when
 * non-input request fields are unchanged and `input` is a strict
 * extension of the previous known input. Server-returned output items
 * are treated as part of the baseline so we do not resend them, and the
 * trailing instructions the stored chain already holds are sent again
 * only when they change.
 *
 * Invariants covered here:
 *   I-2  (no `previous_response_id` across compaction): compaction replaces
 *        the history, so the next request no longer extends the recorded
 *        baseline and `decide()` returns a full request, which can't
 *        reference a server-side state that covered compacted-away turns.
 *   I-14 (`previous_response_id` server-side expiration retry):
 *        the Grok adapter transport catches the "previous_response_id expired"
 *        server error; recovery reads/writes this tracker to fall back
 *        to a full-history request without the `previous_response_id`
 *        hint.
 *
 * The Grok adapter consults this tracker before building a request of the
 * conversation and records its completed response IDs after successful
 * responses. Side calls on the same provider never touch it.
 *
 * @module
 */

import type { LLMMessage } from "../../types.js";

/**
 * Snapshot of the request properties that must match byte-for-byte
 * (excluding the `input` array) for an incremental extension to be
 * reused. This is the request minus the `input` field, which is the
 * variable part.
 */
export interface IncrementalRequestShape {
  readonly model: string;
  readonly instructions?: string;
  readonly tools?: unknown;
  readonly parallelToolCalls: boolean;
  /** Any other non-input knobs that must match previous request. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * Cached state for the last-completed response. Tracks both the
 * `previous_response_id` (for server-side state reuse) and the items the server added to output
 * (so we don't re-send them on the next incremental call).
 */
export interface LastResponseSnapshot {
  readonly previousResponseId: string;
  readonly itemsAdded: ReadonlyArray<LLMMessage>;
  /**
   * Trailing instructions (the system message a request ends with) in
   * effect for the request that produced this response, whether that
   * request sent them or an earlier request of its chain did. The stored
   * chain holds them from there on.
   */
  readonly trailingInstructions?: string;
  /** Monotonic clock (ms) when this snapshot was recorded — used for
   *  opportunistic TTL enforcement against provider-side expiration. */
  readonly recordedAtMs: number;
}

/**
 * Result of a delta-computation attempt:
 *   reuse  → incremental OK, send only the delta
 *   full   → full resend required
 */
export type IncrementalDecision =
  | { readonly kind: "reuse"; readonly delta: LLMMessage[] }
  | { readonly kind: "full"; readonly reason: string };

function shapesEqual(
  a: IncrementalRequestShape,
  b: IncrementalRequestShape,
): boolean {
  return (
    a.model === b.model &&
    (a.instructions ?? "") === (b.instructions ?? "") &&
    a.parallelToolCalls === b.parallelToolCalls &&
    JSON.stringify(a.tools ?? null) === JSON.stringify(b.tools ?? null) &&
    JSON.stringify(a.extra ?? null) === JSON.stringify(b.extra ?? null)
  );
}

function messagesDeepEqual(a: LLMMessage, b: LLMMessage): boolean {
  if (a.role !== b.role) return false;
  if (a.toolCallId !== b.toolCallId) return false;
  if (a.toolName !== b.toolName) return false;
  const aContent = typeof a.content === "string" ? a.content : JSON.stringify(a.content);
  const bContent = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
  if (aContent !== bContent) return false;
  if ((a.toolCalls?.length ?? 0) !== (b.toolCalls?.length ?? 0)) return false;
  if (a.toolCalls && b.toolCalls) {
    for (let i = 0; i < a.toolCalls.length; i += 1) {
      const ac = a.toolCalls[i];
      const bc = b.toolCalls[i];
      if (!ac || !bc) return false;
      if (ac.id !== bc.id || ac.name !== bc.name || ac.arguments !== bc.arguments) {
        return false;
      }
    }
  }
  return true;
}

function baselineIsPrefix(
  baseline: ReadonlyArray<LLMMessage>,
  current: ReadonlyArray<LLMMessage>,
): boolean {
  if (baseline.length > current.length) return false;
  for (let i = 0; i < baseline.length; i += 1) {
    const b = baseline[i];
    const c = current[i];
    if (!b || !c || !messagesDeepEqual(b, c)) return false;
  }
  return true;
}

/**
 * IncrementalTracker — owns the `LastResponse` slot and computes the
 * per-request delta decision. A Grok adapter instance holds one of
 * these for its conversation. The adapter must call `recordRequest()`
 * on every outbound request of the conversation and `recordResponse()`
 * on every completed response for the tracker to stay in sync.
 *
 * The adapter consults `decide()` before constructing the HTTP body.
 */
export class IncrementalTracker {
  private lastRequestShape: IncrementalRequestShape | null = null;
  private lastRequestInput: ReadonlyArray<LLMMessage> = [];
  private lastResponse: LastResponseSnapshot | null = null;

  /**
   * Decide whether to send a full or incremental payload.
   *
   * Control flow:
   *   1. Compare non-input request shape → full on mismatch
   *   2. Full when the stored chain holds trailing instructions and the
   *      current request has none: a stored item cannot be taken back
   *   3. Build baseline = previous input + last-response items
   *   4. Current input must start with baseline
   *   5. If `allowEmptyDelta=false`, require baseline.len < current.len
   *   6. Return current[baseline_len..] on success, without the trailing
   *      instructions when the chain holds them unchanged
   */
  decide(opts: {
    readonly currentShape: IncrementalRequestShape;
    readonly currentInput: ReadonlyArray<LLMMessage>;
    /**
     * Content of the system message `currentInput` ends with, when the
     * request ends with trailing instructions.
     */
    readonly trailingInstructions?: string;
    readonly allowEmptyDelta?: boolean;
  }): IncrementalDecision {
    if (!this.lastRequestShape) {
      return { kind: "full", reason: "no_previous_request" };
    }
    if (!shapesEqual(this.lastRequestShape, opts.currentShape)) {
      return { kind: "full", reason: "request_shape_mismatch" };
    }
    const heldInstructions = this.lastResponse?.trailingInstructions;
    if (heldInstructions !== undefined && opts.trailingInstructions === undefined) {
      return { kind: "full", reason: "trailing_instructions_removed" };
    }
    const baseline: LLMMessage[] = [...this.lastRequestInput];
    if (this.lastResponse) {
      baseline.push(...this.lastResponse.itemsAdded);
    }
    if (!baselineIsPrefix(baseline, opts.currentInput)) {
      return { kind: "full", reason: "baseline_not_prefix" };
    }
    const allowEmpty = opts.allowEmptyDelta === true;
    if (!allowEmpty && baseline.length >= opts.currentInput.length) {
      return { kind: "full", reason: "empty_delta_not_allowed" };
    }
    const delta = opts.currentInput.slice(baseline.length);
    // Unchanged instructions are already stored with the chain; another copy
    // would stay in every later request's context. Changed ones are sent and
    // become the chain's newest system item. A delta of the instructions
    // alone keeps them, so the input is never empty.
    if (
      heldInstructions !== undefined &&
      heldInstructions === opts.trailingInstructions &&
      delta.length > 1
    ) {
      return { kind: "reuse", delta: delta.slice(0, -1) };
    }
    return { kind: "reuse", delta };
  }

  /**
   * Record the outbound request so the next call's decide() has a
   * baseline to compare against.
   */
  recordRequest(shape: IncrementalRequestShape, input: ReadonlyArray<LLMMessage>): void {
    this.lastRequestShape = shape;
    this.lastRequestInput = [...input];
  }

  /**
   * Record the inbound response. `itemsAdded` are the server-side
   * output items (assistant messages, tool results, etc.) that should
   * NOT be re-sent on the next request's baseline extension.
   */
  recordResponse(snapshot: LastResponseSnapshot): void {
    this.lastResponse = snapshot;
  }

  /**
   * Current cached `previous_response_id` (undefined before first
   * response arrives or after `clearResponseId()` clears it).
   */
  previousResponseId(): string | undefined {
    return this.lastResponse?.previousResponseId;
  }

  /**
   * Drops the stored response once it can no longer be continued (xAI
   * refused to store it, or rejected its id as expired). Wipes
   * `lastResponse` so the next request omits `previous_response_id`.
   *
   * Does NOT touch `lastRequestShape` / `lastRequestInput` — the
   * request-shape baseline is independent of the server-side state
   * id and stays valid for the incremental-input delta check.
   *
   * Synchronous + idempotent.
   */
  clearResponseId(): void {
    this.lastResponse = null;
  }

  /**
   * Full reset — used on session shutdown + on provider switch (I-13).
   * Wipes both sides of the tracker.
   */
  reset(): void {
    this.lastRequestShape = null;
    this.lastRequestInput = [];
    this.lastResponse = null;
  }
}
