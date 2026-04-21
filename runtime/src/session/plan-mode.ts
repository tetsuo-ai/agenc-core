/**
 * Plan-mode streaming helpers.
 *
 * Port of codex `core/src/session/turn.rs:1537-1793` (plan-mode streaming
 * pipeline). Plan mode splits a streaming assistant response into two
 * logical streams: ordinary assistant text that becomes
 * `agent_message_delta` + `agent_message` events, and proposed-plan
 * content that becomes `plan_delta` + `plan_item_completed` events.
 *
 * T11 Wave 2 (Agent C): `isPlanMode` now consults the real
 * `PermissionMode` via `turnContext.sessionConfiguration?.permissionContext`
 * first, falling back to the legacy `collaborationMode.model === "plan"`
 * gate so existing callers keep working.
 *
 * NOTE: The `[plan]` prefix hack emitted by `startPlanItem` / `pushPlanDelta`
 * / `completePlanItemWithText` is deliberately kept — extending the
 * `EventMsg` union with dedicated `plan_delta` and `plan_item_completed`
 * variants is deferred to T12 (TUI realtime) to avoid scope creep in T11.
 * TODO(T12): replace `[plan:...]` prefixes with first-class EventMsg
 * variants once the TUI realtime surface lands.
 *
 * Mapping (codex → AgenC):
 *   turn.rs:1537 handle_plan_segments                → handlePlanSegments
 *   turn.rs:1600 emit_streamed_assistant_text_delta  → emitStreamedAssistantTextDelta
 *   turn.rs:1635 flush_assistant_text_segments_for_item → flushAssistantTextSegmentsForItem
 *   turn.rs:1647 flush_assistant_text_segments_all   → flushAssistantTextSegmentsAll
 *   turn.rs:1666 maybe_complete_plan_item_from_message → maybeCompletePlanItemFromMessage
 *   turn.rs:1695 emit_agent_message_in_plan_mode     → emitAgentMessageInPlanMode
 *   turn.rs:1738 emit_turn_item_in_plan_mode         → emitTurnItemInPlanMode
 *   turn.rs:1759 handle_assistant_item_done_in_plan_mode → handleAssistantItemDoneInPlanMode
 *   turn.rs:1445 realtime_text_for_event             → realtimeTextForEvent
 *   turn.rs:666  track_turn_resolved_config_analytics → trackTurnResolvedConfigAnalytics (STUB)
 *
 * Plan mode is gated on `turnContext.collaborationMode.model === "plan"`
 * today as a simple structural check; T11 (modes + slash commands)
 * replaces the gate with the real `PlanMode` collaboration-mode kind.
 *
 * The event surface intentionally re-uses AgenC's existing 18-variant
 * EventMsg union: plan deltas/items are modeled as
 * `agent_message_delta`/`agent_message` with an inline `[plan]`
 * prefix until T11 extends the union with dedicated `plan_delta` /
 * `plan_item_completed` variants. This keeps the ported control flow
 * intact without requiring a speculative schema change.
 *
 * @module
 */

import type { Session } from "./session.js";
import type { TurnContext } from "./turn-context.js";
import type { EventMsg } from "./event-log.js";

// ─────────────────────────────────────────────────────────────────────
// Minimal types (T11 replaces with protocol-authoritative shapes)
// ─────────────────────────────────────────────────────────────────────

/** Discriminated plan segment, mirroring codex `ProposedPlanSegment`. */
export type PlanSegment =
  | { readonly kind: "normal"; readonly delta: string }
  | { readonly kind: "proposed_plan_start" }
  | { readonly kind: "proposed_plan_delta"; readonly delta: string }
  | { readonly kind: "proposed_plan_end" };

/** Minimal plan item, mirroring codex `PlanItem`. */
export interface PlanItem {
  readonly id: string;
  readonly text: string;
}

/** Minimal turn item discriminator, mirroring codex `TurnItem`. */
export type PlanTurnItem =
  | {
      readonly kind: "agent_message";
      readonly id: string;
      readonly text: string;
    }
  | { readonly kind: "plan"; readonly item: PlanItem }
  | { readonly kind: "other"; readonly id?: string };

/** Minimal response item, mirroring codex `ResponseItem`. */
export interface PlanResponseItem {
  readonly role?: string;
  readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
}

/**
 * Bookkeeping for the lifecycle of a single plan item within a turn.
 * Port of codex `ProposedPlanItemState`.
 */
export interface PlanItemState {
  readonly itemId: string;
  started: boolean;
  completed: boolean;
  /** Accumulated plan text delta buffer (for completion messages). */
  accumulatedText: string;
}

export function createPlanItemState(turnId: string): PlanItemState {
  return {
    itemId: `${turnId}-plan`,
    started: false,
    completed: false,
    accumulatedText: "",
  };
}

/**
 * Port of codex `PlanModeStreamState` (turn.rs:1287). Holds per-item
 * bookkeeping for a single plan-mode streaming turn.
 */
export interface PlanModeStreamState {
  /** Items the model started but whose agent_message_start is deferred. */
  readonly pendingAgentMessageItems: Map<string, PlanTurnItem>;
  /** Items whose agent_message_start has already been emitted. */
  readonly startedAgentMessageItems: Set<string>;
  /** Leading whitespace buffer per-item (flushed on first non-ws delta). */
  readonly leadingWhitespaceByItem: Map<string, string>;
  /** Lifecycle tracker for the turn's plan item. */
  planItemState: PlanItemState;
}

export function createPlanModeStreamState(turnId: string): PlanModeStreamState {
  return {
    pendingAgentMessageItems: new Map(),
    startedAgentMessageItems: new Set(),
    leadingWhitespaceByItem: new Map(),
    planItemState: createPlanItemState(turnId),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Plan-mode gate
// ─────────────────────────────────────────────────────────────────────

/**
 * Is plan mode currently active for this turn context?
 *
 * T11 Wave 2: consult the real `PermissionMode` first (the authoritative
 * source set by `PermissionModeRegistry` + the `EnterPlanMode` /
 * `ExitPlanMode` tools + the `/plan` slash command). Falls back to the
 * legacy structural check against `collaborationMode.kind|model === "plan"`
 * so existing streaming call sites keep working before W3 wires
 * sessionConfiguration through turn contexts.
 */
export function isPlanMode(ctx: TurnContext): boolean {
  const withPermission = ctx as unknown as {
    sessionConfiguration?: {
      permissionContext?: { mode?: string };
    };
  };
  const permissionMode =
    withPermission.sessionConfiguration?.permissionContext?.mode;
  if (permissionMode === "plan") return true;

  // Legacy gate fallback — pre-T11 collaborationMode structural check.
  const mode = ctx.collaborationMode as unknown as {
    kind?: string;
    model?: string;
  };
  if (mode.kind === "plan") return true;
  return mode.model === "plan";
}

// ─────────────────────────────────────────────────────────────────────
// Parsed delta shape (mirrors codex `ParsedAssistantTextDelta`)
// ─────────────────────────────────────────────────────────────────────

export interface ParsedAssistantTextDelta {
  readonly visibleText: string;
  readonly planSegments: ReadonlyArray<PlanSegment>;
  readonly citations?: ReadonlyArray<unknown>;
}

export function isEmptyParsed(parsed: ParsedAssistantTextDelta): boolean {
  return (
    parsed.visibleText.length === 0 &&
    parsed.planSegments.length === 0
  );
}

// ─────────────────────────────────────────────────────────────────────
// Emit helpers (structural; reuse existing EventMsg variants)
// ─────────────────────────────────────────────────────────────────────

function emit(session: Session, msg: EventMsg): void {
  session.emit({ id: session.nextInternalSubId(), msg });
}

function emitAgentMessageDelta(session: Session, delta: string): void {
  if (delta.length === 0) return;
  emit(session, {
    type: "agent_message_delta",
    payload: { delta },
  });
}

function emitAgentMessage(session: Session, message: string): void {
  emit(session, {
    type: "agent_message",
    payload: { message },
  });
}

/**
 * Ensure the deferred agent_message_start has been announced for this
 * item_id. Port of codex `maybe_emit_pending_agent_message_start`
 * (turn.rs:1418).
 */
function maybeEmitPendingAgentMessageStart(
  _session: Session,
  _ctx: TurnContext,
  state: PlanModeStreamState,
  itemId: string,
): void {
  if (state.startedAgentMessageItems.has(itemId)) return;
  state.startedAgentMessageItems.add(itemId);
  state.pendingAgentMessageItems.delete(itemId);
  // No dedicated `item_started` event variant today; T11 adds it. The
  // first `agent_message_delta` serves as the visible-stream start.
}

// ─────────────────────────────────────────────────────────────────────
// handle_plan_segments (codex turn.rs:1537)
// ─────────────────────────────────────────────────────────────────────

/**
 * Interpret a batch of `PlanSegment`s produced by the stream parser,
 * routing `Normal` segments to assistant deltas and `ProposedPlan*`
 * segments to the plan-item lifecycle.
 */
export function handlePlanSegments(
  session: Session,
  ctx: TurnContext,
  state: PlanModeStreamState,
  itemId: string,
  segments: ReadonlyArray<PlanSegment>,
): void {
  for (const segment of segments) {
    switch (segment.kind) {
      case "normal": {
        const delta = segment.delta;
        if (delta.length === 0) break;
        const hasNonWhitespace = /\S/.test(delta);
        if (!hasNonWhitespace && !state.startedAgentMessageItems.has(itemId)) {
          const prior = state.leadingWhitespaceByItem.get(itemId) ?? "";
          state.leadingWhitespaceByItem.set(itemId, prior + delta);
          break;
        }
        let emitDelta = delta;
        if (!state.startedAgentMessageItems.has(itemId)) {
          const prefix = state.leadingWhitespaceByItem.get(itemId);
          if (prefix !== undefined) {
            state.leadingWhitespaceByItem.delete(itemId);
            emitDelta = `${prefix}${delta}`;
          }
        }
        maybeEmitPendingAgentMessageStart(session, ctx, state, itemId);
        emitAgentMessageDelta(session, emitDelta);
        break;
      }
      case "proposed_plan_start": {
        if (!state.planItemState.completed) {
          startPlanItem(session, ctx, state);
        }
        break;
      }
      case "proposed_plan_delta": {
        if (!state.planItemState.completed) {
          if (!state.planItemState.started) {
            startPlanItem(session, ctx, state);
          }
          pushPlanDelta(session, ctx, state, segment.delta);
        }
        break;
      }
      case "proposed_plan_end": {
        // Codex leaves the state transition to completion-from-message.
        break;
      }
    }
  }
}

function startPlanItem(
  session: Session,
  _ctx: TurnContext,
  state: PlanModeStreamState,
): void {
  if (state.planItemState.started || state.planItemState.completed) return;
  state.planItemState.started = true;
  // TODO T12: replace this `[plan:…]` prefix hack with a dedicated
  // `plan_item_started` (or `plan_delta`) EventMsg variant once the TUI
  // realtime surface lands. Kept here so rollouts still see the stream
  // boundary without forcing a speculative schema change.
  emit(session, {
    type: "agent_message_delta",
    payload: { delta: `[plan:${state.planItemState.itemId}]` },
  });
}

function pushPlanDelta(
  session: Session,
  _ctx: TurnContext,
  state: PlanModeStreamState,
  delta: string,
): void {
  if (state.planItemState.completed || delta.length === 0) return;
  state.planItemState.accumulatedText += delta;
  // TODO T12: add a dedicated `plan_delta` EventMsg variant. Until then,
  // fan the delta out as an `agent_message_delta` so rollouts still see
  // the streamed plan text.
  emit(session, {
    type: "agent_message_delta",
    payload: { delta },
  });
}

function completePlanItemWithText(
  session: Session,
  _ctx: TurnContext,
  state: PlanModeStreamState,
  text: string,
): void {
  if (state.planItemState.completed || !state.planItemState.started) return;
  state.planItemState.completed = true;
  // TODO T12: add a dedicated `plan_item_completed` EventMsg variant. Until
  // then, emit the completion as an `agent_message` with a `[plan:…]`
  // prefix so the stream is still observable without a speculative
  // schema change.
  emit(session, {
    type: "agent_message",
    payload: { message: `[plan:${state.planItemState.itemId}] ${text}` },
  });
}

// ─────────────────────────────────────────────────────────────────────
// emit_streamed_assistant_text_delta (codex turn.rs:1600)
// ─────────────────────────────────────────────────────────────────────

/**
 * Emit a parsed assistant-text delta. When plan-mode state is present,
 * route plan segments through `handlePlanSegments` and skip the plain
 * visible-text emit (plan parser fan-out already handled normals).
 */
export function emitStreamedAssistantTextDelta(
  session: Session,
  ctx: TurnContext,
  planModeState: PlanModeStreamState | undefined,
  itemId: string,
  parsed: ParsedAssistantTextDelta,
): void {
  if (isEmptyParsed(parsed)) return;

  if (planModeState) {
    if (parsed.planSegments.length > 0) {
      handlePlanSegments(session, ctx, planModeState, itemId, parsed.planSegments);
    }
    return;
  }

  if (parsed.visibleText.length === 0) return;
  emitAgentMessageDelta(session, parsed.visibleText);
}

// ─────────────────────────────────────────────────────────────────────
// Flush helpers (codex turn.rs:1635 / 1647)
// ─────────────────────────────────────────────────────────────────────

/**
 * Minimal assistant-text parser handle used by flush helpers. Codex's
 * `AssistantMessageStreamParsers` holds per-item stream-parser state; we
 * model just the flush surface here so T11 can slot in the real parser
 * without further churn to the helpers that consume it.
 */
export interface AssistantMessageStreamParsersLike {
  finishItem(itemId: string): ParsedAssistantTextDelta;
  drainFinished(): ReadonlyArray<readonly [string, ParsedAssistantTextDelta]>;
}

export function flushAssistantTextSegmentsForItem(
  session: Session,
  ctx: TurnContext,
  planModeState: PlanModeStreamState | undefined,
  parsers: AssistantMessageStreamParsersLike,
  itemId: string,
): void {
  const parsed = parsers.finishItem(itemId);
  emitStreamedAssistantTextDelta(session, ctx, planModeState, itemId, parsed);
}

/**
 * Flush all remaining per-item parser state at response completion.
 * Emits one `agent_message` per item carrying the fully accumulated
 * visible text, mirroring codex's "turn end → drain" contract.
 */
export function flushAssistantTextSegmentsAll(
  session: Session,
  ctx: TurnContext,
  planModeState: PlanModeStreamState | undefined,
  parsers: AssistantMessageStreamParsersLike,
): void {
  for (const [itemId, parsed] of parsers.drainFinished()) {
    emitStreamedAssistantTextDelta(session, ctx, planModeState, itemId, parsed);
    if (!planModeState && parsed.visibleText.length > 0) {
      emitAgentMessage(session, parsed.visibleText);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// maybe_complete_plan_item_from_message (codex turn.rs:1666)
// ─────────────────────────────────────────────────────────────────────

/**
 * If `item` is an assistant message that contains a proposed-plan block,
 * finalize the plan item from its text.
 *
 * Codex calls `extract_proposed_plan_text` from the stream parser. We
 * mirror that with a minimal regex that matches `<plan>…</plan>` or the
 * sentinel that the parser emits. T11 swaps in the real extractor.
 */
export function maybeCompletePlanItemFromMessage(
  session: Session,
  ctx: TurnContext,
  state: PlanModeStreamState,
  item: PlanResponseItem,
): boolean {
  if (item.role !== "assistant") return false;
  const content = item.content ?? [];
  let text = "";
  for (const entry of content) {
    if (entry.type === "output_text" && typeof entry.text === "string") {
      text += entry.text;
    } else if (
      entry.type === undefined &&
      typeof entry.text === "string"
    ) {
      text += entry.text;
    }
  }
  const planText = extractProposedPlanText(text);
  if (planText === undefined) {
    // Fall back: if the stream already buffered plan deltas, close with
    // the accumulated text so downstream sees a single `plan_item_done`.
    if (state.planItemState.started && !state.planItemState.completed) {
      completePlanItemWithText(
        session,
        ctx,
        state,
        state.planItemState.accumulatedText,
      );
      return true;
    }
    return false;
  }
  if (!state.planItemState.started) {
    startPlanItem(session, ctx, state);
  }
  completePlanItemWithText(session, ctx, state, planText);
  return true;
}

/** Minimal stand-in for codex `extract_proposed_plan_text`. */
function extractProposedPlanText(text: string): string | undefined {
  const match = text.match(/<plan>([\s\S]*?)<\/plan>/i);
  if (!match) return undefined;
  return match[1]!.trim();
}

// ─────────────────────────────────────────────────────────────────────
// emit_agent_message_in_plan_mode (codex turn.rs:1695)
// ─────────────────────────────────────────────────────────────────────

/**
 * Emit a completed agent message while respecting plan-mode's deferred
 * start contract: if the message text is entirely whitespace, suppress
 * the event so plan-only outputs don't surface as empty messages.
 */
export function emitAgentMessageInPlanMode(
  session: Session,
  ctx: TurnContext,
  agentMessage: { readonly id: string; readonly text: string },
  state: PlanModeStreamState,
): void {
  const { id, text } = agentMessage;
  if (text.trim().length === 0) {
    state.pendingAgentMessageItems.delete(id);
    state.startedAgentMessageItems.delete(id);
    return;
  }

  maybeEmitPendingAgentMessageStart(session, ctx, state, id);

  if (!state.startedAgentMessageItems.has(id)) {
    state.startedAgentMessageItems.add(id);
    state.pendingAgentMessageItems.delete(id);
  }
  emitAgentMessage(session, text);
  state.startedAgentMessageItems.delete(id);
}

// ─────────────────────────────────────────────────────────────────────
// emit_turn_item_in_plan_mode (codex turn.rs:1738)
// ─────────────────────────────────────────────────────────────────────

export function emitTurnItemInPlanMode(
  session: Session,
  ctx: TurnContext,
  turnItem: PlanTurnItem,
  previouslyActiveItem: PlanTurnItem | undefined,
  state: PlanModeStreamState,
): void {
  if (turnItem.kind === "agent_message") {
    emitAgentMessageInPlanMode(
      session,
      ctx,
      { id: turnItem.id, text: turnItem.text },
      state,
    );
    return;
  }
  if (previouslyActiveItem === undefined) {
    // Codex emits `emit_turn_item_started` here; no AgenC event variant
    // for that yet (T11). Downstream still sees the completion emit.
  }
  // For non-assistant items, route the completion through the plan
  // accumulator if it's a plan item.
  if (turnItem.kind === "plan") {
    completePlanItemWithText(session, ctx, state, turnItem.item.text);
  }
}

// ─────────────────────────────────────────────────────────────────────
// handle_assistant_item_done_in_plan_mode (codex turn.rs:1759)
// ─────────────────────────────────────────────────────────────────────

/**
 * Handle a completed assistant response item in plan mode. Returns true
 * if the item was an assistant message (codex short-circuits the caller
 * when this is true).
 */
export function handleAssistantItemDoneInPlanMode(
  session: Session,
  ctx: TurnContext,
  item: PlanResponseItem,
  state: PlanModeStreamState,
  previouslyActiveItem: PlanTurnItem | undefined,
  lastAgentMessage: { value: string | undefined },
): boolean {
  if (item.role !== "assistant") return false;
  maybeCompletePlanItemFromMessage(session, ctx, state, item);

  const agentText = (item.content ?? [])
    .filter((c) => typeof c.text === "string")
    .map((c) => c.text!)
    .join("");
  if (agentText.length > 0) {
    emitTurnItemInPlanMode(
      session,
      ctx,
      { kind: "agent_message", id: state.planItemState.itemId, text: agentText },
      previouslyActiveItem,
      state,
    );
    lastAgentMessage.value = agentText;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────
// realtime_text_for_event (codex turn.rs:1445)
// ─────────────────────────────────────────────────────────────────────

/**
 * Convert an `EventMsg` into plain text for realtime TUI mirroring.
 * Returns `undefined` for events that have no displayable text.
 *
 * T12 (realtime TUI) consumes this; until then it's a pure helper.
 */
export function realtimeTextForEvent(msg: EventMsg): string | undefined {
  switch (msg.type) {
    case "agent_message":
      return msg.payload.message;
    case "agent_message_delta":
      return msg.payload.delta;
    case "user_message":
      return msg.payload.message;
    default:
      return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────
// track_turn_resolved_config_analytics (codex turn.rs:666) — STUB
// ─────────────────────────────────────────────────────────────────────

/**
 * Stub for codex `track_turn_resolved_config_analytics`. Analytics is
 * out of scope today; the hook exists so run-turn can call it at the
 * right boundary once the analytics subsystem lands.
 *
 * TODO(T6+analytics): wire the real event emitter here.
 */
export function trackTurnResolvedConfigAnalytics(
  _session: Session,
  _ctx: TurnContext,
  _input: ReadonlyArray<unknown>,
): void {
  // no-op
}
