/**
 * Incremental-request bookkeeping for the Grok compatible
 * Responses API) adapter.
 *
 * Hand-port of agenc runtime `core/src/client.rs::get_incremental_items`
 * (lines 909-946) plus the `LastResponse`/`WebsocketSession` slots
 * that back it (lines 868-907, 948-960).
 *
 * Rationale (verbatim from agenc runtime `get_incremental_items` comment):
 *
 *   > Checks whether the current request is an incremental extension
 *   > of the previous request. We only reuse an incremental input
 *   > delta when non-input request fields are unchanged and `input`
 *   > is a strict extension of the previous known input.
 *   > Server-returned output items are treated as part of the
 *   > baseline so we do not resend them.
 *
 * Invariants covered here:
 *   I-2  (clear `previous_response_id` on compaction): `clearResponseId()`
 *        is the runtime entrypoint — AgenC post-compact cleanup calls
 *        this (via the provider abstraction) as the first cleanup step so the
 *        next request can't reference a server-side state that covered
 *        compacted-away turns. Synchronous + idempotent.
 *   I-14 (`previous_response_id` server-side expiration retry):
 *        the Grok adapter transport catches the "previous_response_id expired"
 *        server error; recovery reads/writes this tracker to fall back
 *        to a full-history request without the `previous_response_id`
 *        hint.
 *
 * The Grok adapter consults this tracker before request construction and
 * records completed response IDs after successful responses.
 *
 * @module
 */

import type { LLMMessage } from "../../types.js";

/**
 * Snapshot of the request properties that must match byte-for-byte
 * (excluding the `input` array) for an incremental extension to be
 * reused. Matches agenc runtime `ResponsesApiRequest` minus the `input`
 * field (which is the variable part agenc runtime clears on line 922).
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
 * Cached state for the last-completed response. agenc runtime's `LastResponse`
 * (client.rs:868-907) tracks both the `previous_response_id` (for
 * server-side state reuse) and the items the server added to output
 * (so we don't re-send them on the next incremental call).
 */
export interface LastResponseSnapshot {
  readonly previousResponseId: string;
  readonly itemsAdded: ReadonlyArray<LLMMessage>;
  /** Monotonic clock (ms) when this snapshot was recorded — used for
   *  opportunistic TTL enforcement against provider-side expiration. */
  readonly recordedAtMs: number;
}

/**
 * Result of a delta-computation attempt. Matches agenc runtime line 940-945:
 *   Some(delta)   → incremental OK, send only these
 *   None          → full resend required
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
 * per-request delta decision. A Grok adapter instance can hold one of
 * these per logical session. The adapter must call `recordRequest()`
 * on every outbound request and `recordResponse()` on every completed
 * response for the tracker to stay in sync.
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
   * Mirrors agenc runtime `get_incremental_items` control flow:
   *   1. Compare non-input request shape → full on mismatch
   *   2. Build baseline = previous input + last-response items
   *   3. Current input must start with baseline
   *   4. If `allowEmptyDelta=false`, require baseline.len < current.len
   *   5. Return current[baseline_len..] on success
   */
  decide(opts: {
    readonly currentShape: IncrementalRequestShape;
    readonly currentInput: ReadonlyArray<LLMMessage>;
    readonly allowEmptyDelta?: boolean;
  }): IncrementalDecision {
    if (!this.lastRequestShape) {
      return { kind: "full", reason: "no_previous_request" };
    }
    if (!shapesEqual(this.lastRequestShape, opts.currentShape)) {
      return { kind: "full", reason: "request_shape_mismatch" };
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
   * I-2 enforcement entry point. Called by AgenC post-compact cleanup on
   * every compaction event (auto, reactive, manual /compact,
   * session-memory). Wipes `lastResponse` so the next request omits
   * `previous_response_id` and the server can't carry pre-compact
   * state forward into a post-compact turn.
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

/**
 * Process-level singleton set keyed by provider-instance identity.
 * `runPostCompactCleanup()` (I-2) calls `clearAllResponseIds()` to
 * invalidate every tracker without knowing which one the current provider
 * owns. Shared ProviderHttpClient-based Responses adapters also clear their
 * per-turn continuation state through the compact runtime context.
 */
// WeakRef-backed so a tracker whose owning provider is dropped (e.g. the fresh
// grok provider the auto-mode classifier / delegate builds per call, which never
// calls dispose()) becomes GC-eligible instead of being pinned forever. The Set
// only holds tiny WeakRefs; collected entries are pruned on the next sweep.
const registered = new Set<WeakRef<IncrementalTracker>>();

export function registerIncrementalTracker(t: IncrementalTracker): () => void {
  const ref = new WeakRef(t);
  registered.add(ref);
  return () => registered.delete(ref);
}

export function clearAllResponseIds(): void {
  for (const ref of registered) {
    const t = ref.deref();
    if (t) {
      t.clearResponseId();
    } else {
      registered.delete(ref);
    }
  }
}

/** Live (non-collected) tracker count. Test-only introspection. */
export function registeredIncrementalTrackerCountForTest(): number {
  let live = 0;
  for (const ref of registered) {
    if (ref.deref()) {
      live += 1;
    } else {
      registered.delete(ref);
    }
  }
  return live;
}
